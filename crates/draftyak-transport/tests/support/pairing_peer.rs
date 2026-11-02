#[cfg(feature = "mock-store")]
use draftyak_protocol::jcs;
use draftyak_protocol::sign;
#[cfg(feature = "mock-store")]
use draftyak_transport::payload::Payload;
use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
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
use zeroize::{Zeroize, Zeroizing};

#[cfg(feature = "mock-store")]
pub const NOW_MS: u64 = 1000;
const PID: [u8; 16] = [9; 16];
const SEC: [u8; 16] = [7; 16];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event: String,
    pub port: Option<u16>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    pub connection: Option<u64>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    #[serde(rename = "clientPin")]
    pub client_pin: Option<String>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    pub certificate: Option<String>,
    pub ekm: Option<String>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    pub version: Option<String>,
    #[serde(rename = "proofValid")]
    pub proof_valid: Option<bool>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    #[serde(rename = "clientMatches")]
    pub client_matches: Option<bool>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    pub code: Option<String>,
    #[cfg_attr(not(feature = "mock-store"), allow(dead_code))]
    pub active: Option<bool>,
    pub requests: Option<u64>,
    #[serde(rename = "tcpConnections")]
    pub tcp_connections: Option<u64>,
    #[serde(rename = "tlsConnections")]
    pub tls_connections: Option<u64>,
    body: Option<String>,
    reference: Option<String>,
}
impl Event {
    pub fn body(&self) -> Zeroizing<Vec<u8>> {
        let encoded = self.body.as_deref().expect("owned fixture body is present");
        Zeroizing::new(sign::base64url_decode(encoded).expect("owned fixture body encoding"))
    }
    #[cfg(feature = "mock-store")]
    pub fn reference(&self) -> Zeroizing<Vec<u8>> {
        let encoded = self
            .reference
            .as_deref()
            .expect("owned Node claim is present");
        Zeroizing::new(sign::base64url_decode(encoded).expect("owned Node claim encoding"))
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        if let Some(value) = &mut self.ekm {
            value.zeroize();
        }
        if let Some(value) = &mut self.body {
            value.zeroize();
        }
        if let Some(value) = &mut self.reference {
            value.zeroize();
        }
    }
}

pub struct Peer {
    child: Child,
    output: Receiver<Result<Event, ()>>,
    reader: Option<JoinHandle<()>>,
    stopped: bool,
    pub address: SocketAddr,
    pub pin: [u8; 32],
}

#[derive(Clone, Copy)]
pub enum ReplyMode {
    Normal,
    #[cfg(feature = "mock-store")]
    DuplicateEpoch,
    #[cfg(feature = "mock-store")]
    OversizedJson,
    #[cfg(feature = "mock-store")]
    DelayedValid,
}
impl ReplyMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            #[cfg(feature = "mock-store")]
            Self::DuplicateEpoch => "duplicate-epoch",
            #[cfg(feature = "mock-store")]
            Self::OversizedJson => "oversized-json",
            #[cfg(feature = "mock-store")]
            Self::DelayedValid => "delayed-valid",
        }
    }
}
pub struct StopSummary {
    pub requests: u64,
    pub tcp_connections: u64,
    pub tls_connections: u64,
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
    #[serde(rename = "replyMode")]
    reply_mode: &'static str,
}

impl Peer {
    pub fn start() -> Self {
        Self::start_with_reply(ReplyMode::Normal)
    }

    pub fn start_with_reply(reply_mode: ReplyMode) -> Self {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("fixture server key");
        let cert = CertificateParams::new(vec!["hub.draftyak.invalid".to_owned()])
            .expect("fixture server certificate parameters")
            .self_signed(&key)
            .expect("fixture server certificate");
        let pin =
            draftyak_transport::tls::certificate_spki_hash(cert.der()).expect("fixture server pin");
        let mut command = Command::new(node_executable());
        command.env_clear();
        #[cfg(windows)]
        if let Some(root) = env::var_os("SystemRoot") {
            command.env("SystemRoot", root);
        }
        command
            .args(["--disable-sigusr1", "--max-old-space-size=128"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pairing-peer.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("owned pairing fixture starts");
        let stdout = child.stdout.take().expect("owned pairing fixture stdout");
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
            address: "127.0.0.1:1".parse().expect("fixture address"),
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
            reply_mode: reply_mode.as_str(),
        });
        let ready = peer.next_kind("ready");
        peer.address.set_port(ready.port.expect("fixture port"));
        peer
    }

    fn send(&mut self, value: &impl Serialize) {
        let mut encoded = Zeroizing::new(serde_json::to_vec(value).expect("fixture command JSON"));
        encoded.push(b'\n');
        assert!(encoded.len() <= 32768, "fixture command byte bound");
        self.child
            .stdin
            .as_mut()
            .expect("owned fixture stdin")
            .write_all(&encoded)
            .expect("bounded owned fixture command");
    }

    #[cfg(feature = "mock-store")]
    pub fn payload(&self) -> Payload {
        self.payload_at(self.address.to_string(), 1000)
    }

    #[cfg(feature = "mock-store")]
    pub fn payload_with_remaining(&self, remaining_ms: u64) -> Payload {
        self.payload_at(self.address.to_string(), remaining_ms)
    }

    #[cfg(feature = "mock-store")]
    pub fn localhost_payload(&self) -> Payload {
        self.payload_at(format!("localhost:{}", self.address.port()), 1000)
    }

    #[cfg(feature = "mock-store")]
    fn payload_at(&self, address: String, remaining_ms: u64) -> Payload {
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
            addr: [address],
            pid: sign::base64url_encode(&PID),
            sec: &sec,
            exp: NOW_MS
                .checked_add(remaining_ms)
                .expect("bounded fixture expiry"),
            name: "Fixture hub",
            role: "device",
        };
        let canonical = Zeroizing::new(jcs::canonicalize(&wire).expect("native fixture payload"));
        let code = Zeroizing::new(format!(
            "{}{}",
            draftyak_transport::payload::PREFIX,
            sign::base64url_encode(canonical.as_bytes())
        ));
        Payload::decode(&code, NOW_MS).expect("native fixture payload decodes")
    }

    pub fn next_kind(&self, expected: &str) -> Event {
        for _ in 0..16 {
            let row = self
                .output
                .recv_timeout(Duration::from_secs(15))
                .expect("bounded owned fixture output")
                .expect("bounded valid owned fixture JSON");
            if row.event == expected {
                return row;
            }
            assert!(
                row.event == "socket-closed" || row.event == "tls-closed",
                "expected owned fixture event"
            );
        }
        panic!("owned fixture event bound");
    }

    pub fn oracle(
        &mut self,
        connection: Option<u64>,
        transport_spki: &[u8; 32],
        signing_spki: &[u8],
    ) -> Event {
        #[derive(Serialize)]
        struct Oracle {
            op: &'static str,
            connection: Option<u64>,
            name: &'static str,
            #[serde(rename = "transportSpkiSha256")]
            transport_spki: String,
            #[serde(rename = "signingKey")]
            signing_key: String,
        }
        self.send(&Oracle {
            op: if connection.is_some() {
                "forge"
            } else {
                "contract"
            },
            connection,
            name: "Stored pairing device",
            transport_spki: hex(transport_spki),
            signing_key: sign::base64url_encode(signing_spki),
        });
        self.next_kind("oracle")
    }

    #[cfg(feature = "mock-store")]
    pub fn wait_for_socket_close(&self) {
        let _ = self.next_kind("socket-closed");
    }

    #[cfg(feature = "mock-store")]
    pub async fn connection_is_active(&mut self, connection: u64) -> bool {
        #[derive(Serialize)]
        struct State {
            op: &'static str,
            connection: u64,
        }
        self.send(&State {
            op: "connection-state",
            connection,
        });
        let receipt = self.next_matching("connection-state", connection).await;
        assert!(
            receipt.connection == Some(connection),
            "receipt names the original TLS connection"
        );
        receipt
            .active
            .expect("fixture reports actual connection state")
    }

    #[cfg(feature = "mock-store")]
    pub async fn wait_for_tls_close(&self, connection: u64) {
        let _ = self.next_matching("tls-closed", connection).await;
    }

    #[cfg(feature = "mock-store")]
    async fn next_matching(&self, expected: &str, connection: u64) -> Event {
        use std::sync::mpsc::TryRecvError;
        let deadline = Instant::now() + Duration::from_secs(15);
        for _ in 0..16 {
            let row = loop {
                match self.output.try_recv() {
                    Ok(value) => break value.expect("bounded valid owned fixture JSON"),
                    Err(TryRecvError::Disconnected) => panic!("owned fixture output closed"),
                    Err(TryRecvError::Empty) => {
                        assert!(
                            Instant::now() < deadline,
                            "owned fixture connection receipt deadline"
                        );
                        // Yield the native runtime so an aborted HTTP driver
                        // can drop its socket while this receipt is awaited.
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }
            };
            if row.event == expected && row.connection == Some(connection) {
                return row;
            }
            assert!(
                row.event == "socket-closed" || row.event == "tls-closed",
                "expected owned fixture connection receipt"
            );
        }
        panic!("owned fixture connection receipt count bound");
    }

    pub fn stop(&mut self) -> StopSummary {
        #[derive(Serialize)]
        struct Stop {
            op: &'static str,
        }
        self.send(&Stop { op: "stop" });
        let stopped = self.next_kind("stopped");
        let summary = StopSummary {
            requests: stopped.requests.expect("fixture request count"),
            tcp_connections: stopped
                .tcp_connections
                .expect("fixture TCP connection count"),
            tls_connections: stopped
                .tls_connections
                .expect("fixture TLS connection count"),
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

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
