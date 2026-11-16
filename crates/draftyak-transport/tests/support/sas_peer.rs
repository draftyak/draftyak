use draftyak_protocol::{jcs, sign};
use draftyak_transport::payload::Payload;
use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{BufReader, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, TryRecvError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use zeroize::{Zeroize, Zeroizing};

pub const NOW_MS: u64 = 1000;
const PID: [u8; 16] = [9; 16];
const SEC: [u8; 16] = [7; 16];

#[derive(Clone, Copy)]
pub enum Mode {
    Normal,
    EmptyLength,
    WrongNonce,
    InvalidStatus,
    Nonempty204,
    Transfer204,
    DuplicateRefusal,
    OversizedRefusal,
    ClaimRefusal,
    SasRefusal,
    WindowClosed,
    RevealInvalid,
    DelayedValid,
    ClaimRevealRefusal,
    DelayedClaim,
}
impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::EmptyLength => "empty-length",
            Self::WrongNonce => "wrong-nonce",
            Self::InvalidStatus => "invalid-status",
            Self::Nonempty204 => "nonempty-204",
            Self::Transfer204 => "transfer-204",
            Self::DuplicateRefusal => "duplicate-refusal",
            Self::OversizedRefusal => "oversized-refusal",
            Self::ClaimRefusal => "claim-refusal",
            Self::SasRefusal => "sas-refusal",
            Self::WindowClosed => "window-closed",
            Self::RevealInvalid => "reveal-invalid",
            Self::DelayedValid => "delayed-valid",
            Self::ClaimRevealRefusal => "claim-reveal-refusal",
            Self::DelayedClaim => "delayed-claim",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub event: String,
    pub port: Option<u16>,
    pub connection: Option<u64>,
    pub client_pin: Option<String>,
    pub version: Option<String>,
    pub code: Option<String>,
    pub original_valid: Option<bool>,
    pub changed_nonce: Option<bool>,
    pub claim_delay_ms: Option<u64>,
    expected_sas: Option<String>,
    tcp: Option<u64>,
    tls: Option<u64>,
    claims: Option<u64>,
    reveals: Option<u64>,
    http: Option<u64>,
    websockets: Option<u64>,
    frames: Option<u64>,
}
impl Event {
    pub fn id(&self) -> u64 {
        self.connection.expect("owned fixture TLS connection id")
    }
    pub fn expected_sas(&self) -> &str {
        self.expected_sas
            .as_deref()
            .expect("private Node reference SAS")
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        if let Some(value) = &mut self.expected_sas {
            value.zeroize();
        }
    }
}

pub struct Counts {
    pub tcp: u64,
    pub tls: u64,
    pub claims: u64,
    pub reveals: u64,
    pub http: u64,
    pub websockets: u64,
    pub frames: u64,
}

pub struct Peer {
    child: Child,
    output: Receiver<Result<Event, ()>>,
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
        .expect("native Node is required")
}

#[derive(Serialize)]
struct Window<'a> {
    pid: &'a str,
    role: &'static str,
    sec: &'a str,
}
#[derive(Serialize)]
struct Configuration<'a> {
    cert: &'a str,
    key: &'a str,
    window: Window<'a>,
    mode: &'static str,
}

impl Peer {
    pub fn start(mode: Mode) -> Self {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("fixture hub key");
        let cert = CertificateParams::new(vec!["hub.draftyak.invalid".to_owned()])
            .expect("fixture hub certificate parameters")
            .self_signed(&key)
            .expect("fixture hub certificate");
        let pin =
            draftyak_transport::tls::certificate_spki_hash(cert.der()).expect("fixture hub pin");
        let mut command = Command::new(node_executable());
        command.env_clear();
        #[cfg(windows)]
        if let Some(root) = env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command
            .args(["--disable-sigusr1", "--max-old-space-size=128"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sas-peer.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("owned SAS fixture starts");
        let stdout = child.stdout.take().expect("owned SAS fixture stdout");
        let (send, output) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut input = BufReader::new(stdout);
            for _ in 0..64 {
                let mut line = Zeroizing::new(Vec::new());
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
                let value = serde_json::from_slice::<Event>(&line).map_err(|_| ());
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
            address: "127.0.0.1:1".parse().expect("fixture loopback address"),
            pin,
        };
        let certificate = cert.pem();
        let private_key = Zeroizing::new(key.serialize_pem());
        let pid = sign::base64url_encode(&PID);
        let sec = Zeroizing::new(sign::base64url_encode(&SEC));
        peer.send(&Configuration {
            cert: &certificate,
            key: &private_key,
            window: Window {
                pid: &pid,
                role: "device",
                sec: &sec,
            },
            mode: mode.as_str(),
        });
        let ready = peer.next_blocking("ready");
        peer.address
            .set_port(ready.port.expect("fixture loopback port"));
        peer
    }

    fn send(&mut self, value: &impl Serialize) {
        let mut encoded =
            Zeroizing::new(serde_json::to_vec(value).expect("fixture configuration JSON"));
        encoded.push(b'\n');
        assert!(encoded.len() <= 32768, "fixture private pipe input bound");
        self.child
            .stdin
            .as_mut()
            .expect("owned fixture stdin")
            .write_all(&encoded)
            .expect("bounded owned fixture command");
    }

    pub fn payload(&self, remaining_ms: u64) -> Payload {
        #[derive(Serialize)]
        struct Wire<'a> {
            hid: String,
            addr: [String; 1],
            pid: String,
            sec: &'a str,
            exp: u64,
            name: &'static str,
            role: &'static str,
        }
        let sec = Zeroizing::new(sign::base64url_encode(&SEC));
        let wire = Wire {
            hid: hex(&self.pin),
            addr: [self.address.to_string()],
            pid: sign::base64url_encode(&PID),
            sec: &sec,
            exp: NOW_MS
                .checked_add(remaining_ms)
                .expect("bounded fixture expiry"),
            name: "Fixture hub",
            role: "device",
        };
        let json = Zeroizing::new(jcs::canonicalize(&wire).expect("native fixture payload"));
        let text = Zeroizing::new(format!(
            "{}{}",
            draftyak_transport::payload::PREFIX,
            sign::base64url_encode(json.as_bytes())
        ));
        Payload::decode(&text, NOW_MS).expect("actual native payload codec")
    }

    fn next_blocking(&self, expected: &str) -> Event {
        let deadline = Instant::now() + Duration::from_secs(15);
        for _ in 0..32 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let row = self
                .output
                .recv_timeout(remaining)
                .expect("owned fixture output deadline")
                .expect("bounded valid owned fixture JSON");
            if row.event == expected {
                return row;
            }
            assert!(
                row.event == "socket-closed" || row.event == "tls-closed",
                "expected fixture event"
            );
        }
        panic!("owned fixture output event bound");
    }

    pub async fn next(&self, expected: &str) -> Event {
        self.next_matching(expected, None).await
    }

    pub async fn wait_for_close(&self, connection: u64) {
        let _ = self.next_matching("tls-closed", Some(connection)).await;
    }

    async fn next_matching(&self, expected: &str, connection: Option<u64>) -> Event {
        let deadline = Instant::now() + Duration::from_secs(15);
        for _ in 0..32 {
            let row = loop {
                match self.output.try_recv() {
                    Ok(value) => break value.expect("bounded valid owned fixture JSON"),
                    Err(TryRecvError::Disconnected) => panic!("owned fixture pipe closed"),
                    Err(TryRecvError::Empty) => {
                        assert!(Instant::now() < deadline, "owned fixture receipt deadline");
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            };
            if row.event == expected && connection.is_none_or(|id| row.connection == Some(id)) {
                return row;
            }
            assert!(
                row.event == "socket-closed" || row.event == "tls-closed",
                "expected fixture receipt"
            );
        }
        panic!("owned fixture receipt event bound");
    }

    pub fn stop(&mut self) -> Counts {
        #[derive(Serialize)]
        struct Stop {
            op: &'static str,
        }
        self.send(&Stop { op: "stop" });
        let row = self.next_blocking("stopped");
        let counts = Counts {
            tcp: row.tcp.expect("fixture TCP count"),
            tls: row.tls.expect("fixture TLS count"),
            claims: row.claims.expect("fixture claim count"),
            reveals: row.reveals.expect("fixture reveal count"),
            http: row.http.expect("fixture HTTP reconnect count"),
            websockets: row.websockets.expect("fixture WS count"),
            frames: row.frames.expect("fixture WS frame count"),
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().expect("owned fixture wait") {
                assert!(status.success(), "owned fixture exits successfully");
                break;
            }
            assert!(Instant::now() < deadline, "owned fixture exit deadline");
            thread::sleep(Duration::from_millis(10));
        }
        self.stopped = true;
        if let Some(reader) = self.reader.take() {
            reader.join().expect("owned fixture reader closes");
        }
        counts
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

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
