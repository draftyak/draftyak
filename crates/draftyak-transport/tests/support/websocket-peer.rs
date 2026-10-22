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

pub struct Peer {
    child: Child,
    output: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    stopped: bool,
    pub address: SocketAddr,
    pub pin: [u8; 32],
}

impl Peer {
    pub fn start(mut config: Value) -> Self {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let cert = CertificateParams::new(vec!["hub.draftyak.invalid".to_owned()])
            .unwrap()
            .self_signed(&key)
            .unwrap();
        let pin = draftyak_transport::tls::certificate_spki_hash(cert.der()).unwrap();
        config["cert"] = json!(cert.pem());
        config["key"] = json!(key.serialize_pem());
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let node = env::split_paths(&env::var_os("PATH").expect("Node PATH is required"))
            .map(|path| path.join(name))
            .find(|path| path.is_file())
            .and_then(|path| path.canonicalize().ok())
            .expect("native Node is required");
        let mut command = Command::new(node);
        command.env_clear();
        #[cfg(windows)]
        if let Some(root) = env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/websocket-peer.mjs");
        command
            .args(["--disable-sigusr1", "--max-old-space-size=128"])
            .arg(fixture)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("owned WebSocket peer starts");
        let stdout = child.stdout.take().unwrap();
        let (send, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut input = BufReader::new(stdout);
            for _ in 0..256 {
                let mut line = Vec::new();
                loop {
                    let mut byte = [0];
                    match input.read(&mut byte) {
                        Ok(0) => return,
                        Ok(_) if byte[0] == b'\n' => break,
                        Ok(_) if line.len() < 4096 => line.push(byte[0]),
                        _ => return,
                    }
                }
                let value = serde_json::from_slice(&line).expect("bounded peer JSON");
                if send.send(value).is_err() {
                    return;
                }
            }
        });
        let mut peer = Self {
            child,
            output,
            reader: Some(reader),
            stopped: false,
            address: "127.0.0.1:1".parse().unwrap(),
            pin,
        };
        let mut encoded = serde_json::to_vec(&config).unwrap();
        encoded.push(b'\n');
        assert!(encoded.len() <= 32768);
        peer.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(&encoded)
            .unwrap();
        let ready = peer.event("ready");
        peer.address
            .set_port(u16::try_from(ready["port"].as_u64().unwrap()).unwrap());
        peer
    }

    pub fn event(&self, expected: &str) -> Value {
        for _ in 0..32 {
            let value = self
                .output
                .recv_timeout(Duration::from_secs(15))
                .expect("bounded WebSocket peer observation");
            if value["event"] == expected {
                return value;
            }
        }
        panic!("missing bounded peer event {expected}");
    }

    pub fn observe(&self, expected: &str) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_secs(1);
        for _ in 0..32 {
            let value = self
                .output
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .ok()?;
            if value["event"] == expected {
                return Some(value);
            }
        }
        None
    }

    pub fn stop(&mut self) -> Value {
        self.child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stop\n")
            .unwrap();
        let summary = self.event("stopped");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline, "owned peer shutdown deadline");
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
