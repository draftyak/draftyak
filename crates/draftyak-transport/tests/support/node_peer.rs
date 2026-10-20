use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde_json::{Value, json};
use std::{
    env,
    io::{BufReader, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const CONTEXT: [u8; 16] = [9; 16];
pub struct StopSummary {
    pub requests: u64,
    pub application_bytes: u64,
}
pub struct Peer {
    child: Child,
    output: Receiver<Result<Value, ()>>,
    reader: Option<JoinHandle<()>>,
    stopped: bool,
    pub address: SocketAddr,
    pub pin: [u8; 32],
}
fn node_executable() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    env::split_paths(&env::var_os("PATH").expect("Node PATH is required"))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
        .expect("Native Node is required")
}
fn minimal_environment(command: &mut Command) {
    command.env_clear();
    #[cfg(windows)]
    if let Some(root) = env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
}
impl Peer {
    pub fn start(mode: &str, status: u16, body: &[u8]) -> Self {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let cert = CertificateParams::new(vec!["hub.draftyak.invalid".to_owned()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let pin = draftyak_transport::tls::certificate_spki_hash(cert.der()).unwrap();
        let mut command = Command::new(node_executable());
        minimal_environment(&mut command);
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tls-peer.mjs");
        command
            .args(["--disable-sigusr1", "--max-old-space-size=128"])
            .arg(fixture)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("TLS peer starts");
        let stdout = child.stdout.take().expect("TLS peer stdout");
        let (send, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut input = BufReader::new(stdout);
            for _ in 0..64 {
                let mut line = Vec::new();
                loop {
                    let mut byte = [0];
                    match input.read(&mut byte) {
                        Ok(0) => return,
                        Ok(_) if byte[0] == b'\n' => break,
                        Ok(_) if line.len() < 16384 => line.push(byte[0]),
                        _ => {
                            let _ = send.send(Err(()));
                            return;
                        }
                    }
                }
                let value = serde_json::from_slice(&line).map_err(|_| ());
                if send.send(value).is_err() {
                    return;
                }
            }
            let _ = send.send(Err(()));
        });
        let mut peer = Self {
            child,
            output,
            reader: Some(reader),
            stopped: false,
            address: "127.0.0.1:1".parse().unwrap(),
            pin,
        };
        let config = json!({"mode":mode,"cert":cert.pem(),"key":key.serialize_pem(),
            "pid":draftyak_protocol::sign::base64url_encode(&CONTEXT),"status":status,
            "body":draftyak_protocol::sign::base64url_encode(body)});
        let mut encoded = serde_json::to_vec(&config).unwrap();
        encoded.push(b'\n');
        assert!(encoded.len() <= 32768);
        peer.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&encoded)
            .expect("bounded fixture configuration");
        let ready = peer.next();
        assert_eq!(ready["event"], "ready");
        let port = ready["port"]
            .as_u64()
            .and_then(|value| u16::try_from(value).ok())
            .unwrap();
        peer.address.set_port(port);
        peer
    }
    pub fn next(&self) -> Value {
        self.output
            .recv_timeout(Duration::from_secs(15))
            .expect("bounded TLS fixture output")
            .expect("bounded valid TLS fixture JSON")
    }
    pub fn wait_for_connection_close(&self) {
        for _ in 0..8 {
            if self.next()["event"] == "socket-closed" {
                return;
            }
        }
        panic!("actual native socket close was not observed");
    }
    pub fn stop(&mut self) -> u64 {
        self.stop_summary().requests
    }
    pub fn stop_summary(&mut self) -> StopSummary {
        self.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stop\n")
            .expect("stop owned TLS peer");
        let mut summary = None;
        for _ in 0..8 {
            let row = self.next();
            if row["event"] == "stopped" {
                summary = Some(StopSummary {
                    requests: row["requests"].as_u64().expect("bounded request count"),
                    application_bytes: row["applicationBytes"]
                        .as_u64()
                        .filter(|bytes| *bytes <= 32768)
                        .expect("bounded application-byte count"),
                });
                break;
            }
        }
        let summary = summary.expect("owned TLS peer stop summary");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().expect("TLS peer wait") {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "owned TLS peer close deadline");
            thread::sleep(Duration::from_millis(10));
        }
        self.stopped = true;
        if let Some(reader) = self.reader.take() {
            reader.join().expect("TLS peer reader closed");
        }
        summary
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        if !self.stopped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
