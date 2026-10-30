use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde_json::{Value, json};
use std::{
    env,
    io::{BufReader, Read, Write},
    net::SocketAddr,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

pub struct Plan {
    pin: [u8; 32],
    certificate: String,
    key: Zeroizing<String>,
}
pub struct Peer {
    child: Child,
    output: Receiver<Result<Value, ()>>,
    reader: Option<JoinHandle<()>>,
    stopped: bool,
    pub address: SocketAddr,
}
#[derive(Debug)]
pub struct Summary {
    pub connections: u64,
    pub rejected: u64,
    pub accepted: u64,
    pub http: u64,
    pub websocket: u64,
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn node_executable() -> std::path::PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    env::split_paths(&env::var_os("PATH").expect("Node PATH is required"))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
        .expect("native Node is required")
}
impl Plan {
    pub fn new() -> Self {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let certificate = CertificateParams::new(vec!["hub.draftyak.invalid".to_owned()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        Self {
            pin: draftyak_transport::tls::certificate_spki_hash(certificate.der()).unwrap(),
            certificate: certificate.pem(),
            key: Zeroizing::new(key.serialize_pem()),
        }
    }
    pub fn pin(&self) -> [u8; 32] {
        self.pin
    }
    pub fn start(self, allowed: [u8; 32]) -> Peer {
        let mut command = Command::new(node_executable());
        command.env_clear();
        #[cfg(windows)]
        if let Some(root) = env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command
            .args(["--disable-sigusr1", "--max-old-space-size=128"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/key-store-peer.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("owned stored-identity peer starts");
        let stdout = child.stdout.take().unwrap();
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
                        Ok(_) if line.len() < 4096 => line.push(byte[0]),
                        _ => {
                            let _ = send.send(Err(()));
                            return;
                        }
                    }
                }
                if send
                    .send(serde_json::from_slice(&line).map_err(|_| ()))
                    .is_err()
                {
                    return;
                }
            }
            let _ = send.send(Err(()));
        });
        let mut peer = Peer {
            child,
            output,
            reader: Some(reader),
            stopped: false,
            address: "127.0.0.1:1".parse().unwrap(),
        };
        let mut configuration = json!({
            "allowed": hex(&allowed),
            "cert": self.certificate,
            "key": self.key.as_str(),
        });
        let mut encoded = serde_json::to_vec(&configuration).unwrap();
        encoded.push(b'\n');
        assert!(encoded.len() <= 32768);
        peer.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&encoded)
            .unwrap();
        encoded.zeroize();
        if let Value::String(value) = &mut configuration["key"] {
            value.zeroize();
        }
        let ready = peer.event("ready");
        peer.address.set_port(
            ready["port"]
                .as_u64()
                .and_then(|value| u16::try_from(value).ok())
                .unwrap(),
        );
        peer
    }
}
impl Peer {
    pub fn event(&self, expected: &str) -> Value {
        for _ in 0..32 {
            let value = self
                .output
                .recv_timeout(Duration::from_secs(15))
                .expect("bounded stored-identity peer observation")
                .expect("bounded stored-identity peer JSON");
            if value["event"] == expected {
                return value;
            }
        }
        panic!("missing stored-identity peer event");
    }
    pub fn stop(&mut self) -> Summary {
        self.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stop\n")
            .unwrap();
        let row = self.event("stopped");
        let field = |name: &str| row[name].as_u64().filter(|value| *value <= 16).unwrap();
        let summary = Summary {
            connections: field("connections"),
            rejected: field("rejected"),
            accepted: field("accepted"),
            http: field("http"),
            websocket: field("websocket"),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "owned stored-identity peer exits cleanly");
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned stored-identity peer shutdown deadline"
            );
            thread::sleep(Duration::from_millis(10));
        }
        self.stopped = true;
        self.reader.take().unwrap().join().unwrap();
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
