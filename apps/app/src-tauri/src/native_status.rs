//! One native GET-status probe over an original, already-pinned connection.
//!
//! The native caller obtains consent and selects the persisted identity/address before
//! constructing this owner. Status is protocol DATA, never a capability or confirmation
//! grant. This component exposes no renderer URL, Host, header, credential or signing input.
//! App registration, the single SPA and trusted-window admission remain separate work.

use std::{fmt, time::Duration};

use draftyak_protocol::{device_api, jcs};
use draftyak_transport::tls::PinnedConnection;
use http_body_util::{BodyExt, Empty, Limited};
use hyper::{Request, body::Bytes};
use tokio::task::JoinHandle;

const STATUS_TARGET: &str = "/device/v1/status";
const STATUS_BYTES: usize = 1_024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The validated status returned by this request. It conveys no local authorization.
#[derive(Clone, Eq, PartialEq)]
pub struct DeviceStatusData {
    pub device_id: String,
    pub epoch: u64,
    pub confirmed: bool,
    pub capabilities: Vec<String>,
    pub test_upstreams: bool,
}

impl fmt::Debug for DeviceStatusData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceStatusData([redacted])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeStatusError {
    AlreadyUsed,
    Closed,
    Cancelled,
    TimedOut,
    Transport,
    TooLarge,
    InvalidResponse,
    DriverFailed,
    /// Both values are admitted by the original M1 error/status catalogue.
    Api {
        status: u16,
        code: &'static str,
    },
}

impl fmt::Display for NativeStatusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::AlreadyUsed => "NATIVE_STATUS_ALREADY_USED",
            Self::Closed => "NATIVE_STATUS_CLOSED",
            Self::Cancelled => "NATIVE_STATUS_CANCELLED",
            Self::TimedOut => "NATIVE_STATUS_TIMED_OUT",
            Self::Transport => "NATIVE_STATUS_TRANSPORT",
            Self::TooLarge => "NATIVE_STATUS_TOO_LARGE",
            Self::InvalidResponse => "NATIVE_STATUS_INVALID_RESPONSE",
            Self::DriverFailed => "NATIVE_STATUS_DRIVER_FAILED",
            Self::Api { code, .. } => code,
        })
    }
}

impl std::error::Error for NativeStatusError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProbeState {
    Ready,
    Running,
    Finished,
    Closing,
    Closed,
}

/// Counts this owner's connection/task custody only, not OS-wide or peer closure.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeStatusResources {
    pub state: ProbeState,
    pub retained_connection: bool,
    /// A finished task still counts until its original handle has been joined.
    pub pending_driver: bool,
    pub operation_completed: bool,
    pub error: Option<NativeStatusError>,
    pub driver_failed: bool,
}

#[derive(Default)]
struct Driver {
    task: Option<JoinHandle<bool>>,
    failed: bool,
}

impl Driver {
    async fn close(&mut self) -> Result<(), NativeStatusError> {
        if let Some(task) = self.task.as_mut() {
            task.abort();
            // Keep the original handle in this owner across await. If this close
            // future is cancelled, another close still joins that same handle.
            let joined = task.await;
            self.task = None;
            match joined {
                Ok(true) => {}
                Err(error) if error.is_cancelled() => {}
                Ok(false) | Err(_) => self.failed = true,
            }
        }
        if self.failed {
            Err(NativeStatusError::DriverFailed)
        } else {
            Ok(())
        }
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        if let Some(task) = self.task.as_ref() {
            task.abort();
        }
        // Drop cannot join asynchronously. Explicit close is required for joined
        // completion; this fallback does not produce a successful closure receipt.
    }
}

/// Single-use, native-owned probe. Retain it if the probe future is cancelled,
/// then await close. No HTTP operation is spawned before probe is polled.
pub struct NativeStatusProbe {
    connection: Option<PinnedConnection>,
    driver: Driver,
    state: ProbeState,
    operation_completed: bool,
    error: Option<NativeStatusError>,
}

impl NativeStatusProbe {
    pub fn new(connection: PinnedConnection) -> Self {
        Self {
            connection: Some(connection),
            driver: Driver::default(),
            state: ProbeState::Ready,
            operation_completed: false,
            error: None,
        }
    }

    pub fn resource_status(&self) -> NativeStatusResources {
        NativeStatusResources {
            state: self.state,
            retained_connection: self.connection.is_some(),
            pending_driver: self.driver.task.is_some(),
            operation_completed: self.operation_completed,
            error: self.error,
            driver_failed: self.driver.failed,
        }
    }

    pub async fn probe(&mut self) -> Result<DeviceStatusData, NativeStatusError> {
        match self.state {
            ProbeState::Ready => {}
            ProbeState::Closing | ProbeState::Closed => return Err(NativeStatusError::Closed),
            ProbeState::Running | ProbeState::Finished => {
                return Err(NativeStatusError::AlreadyUsed);
            }
        }
        let connection = self
            .connection
            .take()
            .ok_or(NativeStatusError::AlreadyUsed)?;
        self.state = ProbeState::Running;
        let result = tokio::time::timeout(REQUEST_TIMEOUT, self.request_once(connection))
            .await
            .unwrap_or(Err(NativeStatusError::TimedOut));
        if let Err(error) = result.as_ref() {
            self.error = Some(*error);
        }
        let joined = self.driver.close().await;
        self.state = ProbeState::Finished;
        self.operation_completed = true;
        match result {
            Err(error) => Err(error),
            Ok(status) => match joined {
                Ok(()) => Ok(status),
                Err(error) => {
                    self.error = Some(error);
                    Err(error)
                }
            },
        }
    }

    async fn request_once(
        &mut self,
        connection: PinnedConnection,
    ) -> Result<DeviceStatusData, NativeStatusError> {
        let (stream, authority) = connection.into_stream();
        let request = status_request(&authority)?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream))
                .await
                .map_err(|_| NativeStatusError::Transport)?;
        self.driver.task = Some(tokio::spawn(async move { connection.await.is_ok() }));
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| NativeStatusError::Transport)?;
        let status = response.status().as_u16();
        // Enforce received bytes before the original strict JSON/schema parser.
        let body = Limited::new(response.into_body(), STATUS_BYTES)
            .collect()
            .await
            .map_err(|_| NativeStatusError::InvalidResponse)?
            .to_bytes();
        parse_response(status, &body)
    }

    /// Stops new work, drops an unused connection and aborts/joins the original
    /// HTTP driver. Resource cleanup never changes an earlier request failure.
    pub async fn close(&mut self) -> Result<(), NativeStatusError> {
        if self.state == ProbeState::Running && self.error.is_none() {
            self.error = Some(NativeStatusError::Cancelled);
        }
        self.state = ProbeState::Closing;
        self.connection = None;
        let result = self.driver.close().await;
        if self.error.is_none() {
            self.error = result.as_ref().err().copied();
        }
        self.state = ProbeState::Closed;
        result
    }
}

fn status_request(authority: &str) -> Result<Request<Empty<Bytes>>, NativeStatusError> {
    if !device_api::check_route_request_bytes("status", None) {
        return Err(NativeStatusError::InvalidResponse);
    }
    Request::get(STATUS_TARGET)
        .header("host", authority)
        .body(Empty::new())
        .map_err(|_| NativeStatusError::Transport)
}

fn parse_response(status: u16, bytes: &[u8]) -> Result<DeviceStatusData, NativeStatusError> {
    if bytes.len() > STATUS_BYTES {
        return Err(NativeStatusError::TooLarge);
    }
    if status != 200 {
        if !device_api::check_api_error_bytes(bytes, status) {
            return Err(NativeStatusError::InvalidResponse);
        }
        let value = jcs::parse_strict(bytes).map_err(|_| NativeStatusError::InvalidResponse)?;
        let code = value["code"]
            .as_str()
            .ok_or(NativeStatusError::InvalidResponse)?;
        let &(code, _) = device_api::DEVICE_API_ERRORS
            .iter()
            .find(|(known, expected)| *known == code && *expected == status)
            .ok_or(NativeStatusError::InvalidResponse)?;
        return Err(NativeStatusError::Api { status, code });
    }
    if !device_api::check_route_response_bytes("status", bytes) {
        return Err(NativeStatusError::InvalidResponse);
    }
    let value = jcs::parse_strict(bytes).map_err(|_| NativeStatusError::InvalidResponse)?;
    Ok(DeviceStatusData {
        device_id: value["deviceId"]
            .as_str()
            .ok_or(NativeStatusError::InvalidResponse)?
            .to_owned(),
        epoch: value["epoch"]
            .as_u64()
            .ok_or(NativeStatusError::InvalidResponse)?,
        confirmed: value["confirmed"]
            .as_bool()
            .ok_or(NativeStatusError::InvalidResponse)?,
        capabilities: value["capabilities"]
            .as_array()
            .ok_or(NativeStatusError::InvalidResponse)?
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or(NativeStatusError::InvalidResponse)
            })
            .collect::<Result<_, _>>()?,
        test_upstreams: value["testUpstreams"]
            .as_bool()
            .ok_or(NativeStatusError::InvalidResponse)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{Future, pending, poll_fn},
        io::ErrorKind,
        net::SocketAddr,
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        task::{Context, Poll, Waker},
    };

    use draftyak_transport::tls::{Identity, certificate_spki_hash};
    use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    const VALID: &[u8] = br#"{"deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":1,"confirmed":true,"capabilities":["read"],"testUpstreams":false}"#;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime")
    }

    #[test]
    fn fixed_request_has_no_renderer_authority_or_body_input() {
        let request = status_request("127.0.0.1:31415").expect("native request");
        assert_eq!(request.method(), "GET");
        assert_eq!(request.uri(), STATUS_TARGET);
        assert_eq!(request.headers().len(), 1);
        assert_eq!(request.headers()["host"], "127.0.0.1:31415");
        assert!(device_api::check_route_request_bytes("status", None));
        assert!(!device_api::check_route_request_bytes("status", Some(b"")));
        assert!(status_request("127.0.0.1:31415\r\nAuthorization: injected").is_err());
    }

    #[test]
    fn actual_received_cap_accepts_1024_and_refuses_the_same_payload_at_1025() {
        let mut bytes = VALID.to_vec();
        bytes.resize(STATUS_BYTES, b' ');
        let status = parse_response(200, &bytes).expect("bounded status");
        assert_eq!(status.device_id, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(status.epoch, 1);
        assert!(status.confirmed);
        assert_eq!(status.capabilities, ["read"]);
        assert!(!status.test_upstreams);
        bytes.push(b' ');
        assert_eq!(
            parse_response(200, &bytes),
            Err(NativeStatusError::TooLarge)
        );
        assert!(device_api::check_route_length("status", "response", 1_024));
        assert!(!device_api::check_route_length("status", "response", 1_025));
    }

    #[test]
    fn strict_status_refuses_duplicate_unknown_and_invalid_utf8_fields() {
        let text = std::str::from_utf8(VALID).expect("synthetic JSON");
        let duplicate = text.replace("\"epoch\":1", "\"epoch\":1,\"epoch\":2");
        let unknown = text.replace("\"epoch\":1", "\"epoch\":1,\"extra\":true");
        for invalid in [
            duplicate.as_bytes(),
            unknown.as_bytes(),
            b"{\"code\":\"FORBIDDEN\"}",
        ] {
            assert_eq!(
                parse_response(200, invalid),
                Err(NativeStatusError::InvalidResponse)
            );
        }
        let mut invalid_utf8 = VALID.to_vec();
        invalid_utf8.push(0xff);
        assert_eq!(
            parse_response(200, &invalid_utf8),
            Err(NativeStatusError::InvalidResponse)
        );
    }

    #[test]
    fn pending_status_is_data_and_never_requires_confirmation() {
        let text = std::str::from_utf8(VALID).expect("synthetic JSON");
        let invalid = text.replace("\"confirmed\":true", "\"confirmed\":false");
        assert_eq!(
            parse_response(200, invalid.as_bytes()),
            Err(NativeStatusError::InvalidResponse)
        );
        let pending = invalid.replace("[\"read\"]", "[]");
        let data = parse_response(200, pending.as_bytes()).expect("pending status");
        assert!(!data.confirmed);
        assert!(data.capabilities.is_empty());
    }

    #[test]
    fn errors_preserve_the_original_http_status_and_closed_code_mapping() {
        assert_eq!(
            parse_response(403, br#"{"code":"FORBIDDEN"}"#),
            Err(NativeStatusError::Api {
                status: 403,
                code: "FORBIDDEN"
            })
        );
        for (status, bytes) in [
            (400, br#"{"code":"FORBIDDEN"}"#.as_slice()),
            (403, br#"{"code":"UNKNOWN"}"#.as_slice()),
            (403, br#"{"code":"FORBIDDEN","extra":true}"#.as_slice()),
            (503, VALID),
        ] {
            assert_eq!(
                parse_response(status, bytes),
                Err(NativeStatusError::InvalidResponse)
            );
        }
    }

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn cancelling_close_retains_the_original_task_until_a_later_join() {
        runtime().block_on(async {
            let started = Arc::new(AtomicBool::new(false));
            let dropped = Arc::new(AtomicBool::new(false));
            let task_started = started.clone();
            let task_dropped = dropped.clone();
            let mut driver = Driver {
                task: Some(tokio::spawn(async move {
                    let _guard = DropFlag(task_dropped);
                    task_started.store(true, Ordering::SeqCst);
                    pending::<()>().await;
                    true
                })),
                failed: false,
            };
            tokio::time::timeout(Duration::from_secs(2), async {
                while !started.load(Ordering::SeqCst) {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("original task started");
            let ticket = driver.task.as_ref().expect("original handle").id();
            let mut closing = Box::pin(driver.close());
            let mut context = Context::from_waker(Waker::noop());
            assert!(closing.as_mut().poll(&mut context).is_pending());
            drop(closing);
            assert_eq!(driver.task.as_ref().expect("retained handle").id(), ticket);
            assert!(!dropped.load(Ordering::SeqCst));
            driver.close().await.expect("original task joined");
            assert!(dropped.load(Ordering::SeqCst));
            assert!(driver.task.is_none());
            driver.close().await.expect("repeated close");
        });
    }

    #[test]
    fn a_settled_driver_failure_remains_visible_after_cleanup() {
        runtime().block_on(async {
            let task = tokio::spawn(async { false });
            tokio::time::timeout(Duration::from_secs(2), async {
                while !task.is_finished() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("driver actually settled");
            let mut driver = Driver {
                task: Some(task),
                failed: false,
            };
            assert_eq!(driver.close().await, Err(NativeStatusError::DriverFailed));
            assert!(driver.task.is_none());
            assert_eq!(driver.close().await, Err(NativeStatusError::DriverFailed));
        });
    }

    enum Reply {
        Body { status: u16, bytes: Vec<u8> },
        PartialOversizedStatus,
        Stall,
    }

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum TcpTermination {
        Eof,
        ConnectionReset,
    }

    struct PeerObservation {
        head: Vec<u8>,
        termination: TcpTermination,
    }

    struct Peer {
        address: SocketAddr,
        pin: [u8; 32],
        request_seen: Arc<AtomicBool>,
        task: JoinHandle<Option<PeerObservation>>,
    }

    /// A fresh real TLS peer, not a substitute PinnedConnection or authority.
    async fn peer(reply: Reply) -> Peer {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("test peer key");
        let certificate = CertificateParams::new(vec!["127.0.0.1".to_owned()])
            .expect("test certificate parameters")
            .self_signed(&key)
            .expect("test peer certificate");
        let pin = certificate_spki_hash(certificate.der()).expect("actual certificate pin");
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .expect("TLS13")
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .expect("test TLS configuration");
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener");
        let address = listener.local_addr().expect("native peer address");
        let request_seen = Arc::new(AtomicBool::new(false));
        let seen = request_seen.clone();
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("one native connection");
            let Ok(mut tls) = tokio_rustls::TlsAcceptor::from(Arc::new(config))
                .accept(tcp)
                .await
            else {
                return None;
            };
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                assert!(head.len() < 4_096, "bounded test request head");
                let mut byte = [0];
                if tls.read(&mut byte).await.expect("native HTTP head") == 0 {
                    return None;
                }
                head.push(byte[0]);
            }
            seen.store(true, Ordering::SeqCst);
            let reply = match reply {
                Reply::Body { status, bytes } => Some((status, bytes.len(), bytes)),
                Reply::PartialOversizedStatus => {
                    let mut bytes = VALID.to_vec();
                    bytes.resize(1_025, b' ');
                    Some((200, 1_048_576, bytes))
                }
                Reply::Stall => None,
            };
            if let Some((status, declared_bytes, bytes)) = reply {
                let header = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    declared_bytes
                );
                tls.write_all(header.as_bytes())
                    .await
                    .expect("response head");
                tls.write_all(&bytes).await.expect("response body");
                tls.flush().await.expect("response flush");
            }
            // Observe termination on the actual original TCP peer after cleanup.
            // An aborted joined driver may produce EOF or a Windows TCP reset;
            // neither outcome claims a graceful TLS close-notify exchange.
            // TLS close-notify bytes, if any, remain opaque and are not decoded.
            let mut tail = [0; 4_096];
            let mut tail_bytes = 0;
            let termination = loop {
                match tls.get_mut().0.read(&mut tail).await {
                    Ok(0) => break TcpTermination::Eof,
                    Ok(n) => {
                        tail_bytes += n;
                        assert!(tail_bytes <= 16_384, "bounded opaque shutdown bytes");
                    }
                    Err(error) if error.kind() == ErrorKind::ConnectionReset => {
                        break TcpTermination::ConnectionReset;
                    }
                    Err(error) => panic!("peer TCP termination failed: {:?}", error.kind()),
                }
            };
            Some(PeerObservation { head, termination })
        });
        Peer {
            address,
            pin,
            request_seen,
            task,
        }
    }

    async fn peer_terminal(
        mut task: JoinHandle<Option<PeerObservation>>,
    ) -> Option<PeerObservation> {
        match tokio::time::timeout(Duration::from_secs(2), &mut task).await {
            Ok(result) => {
                let observation = result.expect("original peer joined");
                if let Some(observation) = observation.as_ref() {
                    assert!(matches!(
                        observation.termination,
                        TcpTermination::Eof | TcpTermination::ConnectionReset
                    ));
                }
                observation
            }
            Err(_) => {
                task.abort();
                let _ = task.await;
                panic!("peer did not observe terminal connection");
            }
        }
    }

    #[test]
    fn real_pinned_tls_status_uses_one_fixed_get_and_joins_before_success() {
        runtime().block_on(async {
            let peer = peer(Reply::Body {
                status: 200,
                bytes: VALID.to_vec(),
            })
            .await;
            let identity = Identity::generate().expect("fresh native test identity");
            let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
                .await
                .expect("real pinned connection");
            let mut probe = NativeStatusProbe::new(connection);
            assert!(probe.probe().await.expect("real native status").confirmed);
            let resources = probe.resource_status();
            assert!(resources.operation_completed);
            assert!(!resources.pending_driver);
            assert_eq!(resources.error, None);
            probe.close().await.expect("explicit owner close");
            assert_eq!(probe.probe().await, Err(NativeStatusError::Closed));
            probe.close().await.expect("idempotent close");
            let observation = peer_terminal(peer.task).await.expect("actual HTTP request");
            let expected = format!(
                "GET {STATUS_TARGET} HTTP/1.1\r\nhost: {}\r\n\r\n",
                peer.address
            );
            assert_eq!(observation.head, expected.as_bytes());
        });
    }

    #[test]
    fn wrong_actual_tls_pin_never_dispatches_http() {
        runtime().block_on(async {
            let peer = peer(Reply::Stall).await;
            let identity = Identity::generate().expect("fresh native test identity");
            let mut wrong = peer.pin;
            wrong[0] ^= 1;
            assert!(
                PinnedConnection::connect(peer.address, &identity, wrong)
                    .await
                    .is_err()
            );
            assert!(!peer.request_seen.load(Ordering::SeqCst));
            assert!(peer_terminal(peer.task).await.is_none());
        });
    }

    #[test]
    fn actual_http_refusal_survives_successful_resource_cleanup() {
        runtime().block_on(async {
            let peer = peer(Reply::Body {
                status: 403,
                bytes: br#"{"code":"FORBIDDEN"}"#.to_vec(),
            })
            .await;
            let identity = Identity::generate().expect("fresh native test identity");
            let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
                .await
                .expect("real pinned connection");
            let mut probe = NativeStatusProbe::new(connection);
            let refusal = NativeStatusError::Api {
                status: 403,
                code: "FORBIDDEN",
            };
            assert_eq!(probe.probe().await, Err(refusal));
            probe.close().await.expect("resource cleanup only");
            assert_eq!(probe.resource_status().error, Some(refusal));
            assert!(!probe.resource_status().pending_driver);
            assert!(peer_terminal(peer.task).await.is_some());
        });
    }

    #[test]
    fn actual_oversized_body_refuses_before_peer_termination_and_joins() {
        runtime().block_on(async {
            let mut bytes = VALID.to_vec();
            bytes.resize(1_025, b' ');
            let peer = peer(Reply::Body { status: 200, bytes }).await;
            let identity = Identity::generate().expect("fresh native test identity");
            let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
                .await
                .expect("real pinned connection");
            let mut probe = NativeStatusProbe::new(connection);
            assert_eq!(probe.probe().await, Err(NativeStatusError::InvalidResponse));
            probe.close().await.expect("resource cleanup");
            assert_eq!(
                probe.resource_status().error,
                Some(NativeStatusError::InvalidResponse)
            );
            assert!(!probe.resource_status().pending_driver);
            assert!(peer_terminal(peer.task).await.is_some());
        });
    }

    #[test]
    fn received_byte_limit_refuses_a_partial_large_body_before_deadline_after_joined_cleanup() {
        runtime().block_on(async {
            let identity = Identity::generate().expect("fresh native test identity");
            let peer = peer(Reply::PartialOversizedStatus).await;
            let connection =
                match PinnedConnection::connect(peer.address, &identity, peer.pin).await {
                    Ok(connection) => connection,
                    Err(_) => {
                        let _ = peer_terminal(peer.task).await;
                        panic!("real pinned test connection failed");
                    }
                };
            let mut probe = NativeStatusProbe::new(connection);
            // The peer sends 1,025 bytes, advertises 1 MiB, and withholds EOF.
            // Without the streaming Limited guard, collection waits for the rest.
            let result = tokio::time::timeout(Duration::from_secs(2), probe.probe()).await;
            let closed = probe.close().await;
            let observation = peer_terminal(peer.task).await;
            // Cleanup and both original joins precede every outcome assertion.
            assert_eq!(closed, Ok(()));
            assert!(observation.is_some());
            assert!(matches!(
                result,
                Ok(Err(NativeStatusError::InvalidResponse))
            ));
        });
    }

    #[test]
    fn external_probe_cancellation_retains_owner_until_close_and_actual_peer_termination() {
        runtime().block_on(async {
            let peer = peer(Reply::Stall).await;
            let identity = Identity::generate().expect("fresh native test identity");
            let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
                .await
                .expect("real pinned connection");
            let mut probe = NativeStatusProbe::new(connection);
            let mut operation = Box::pin(probe.probe());
            tokio::time::timeout(Duration::from_secs(2), async {
                while !peer.request_seen.load(Ordering::SeqCst) {
                    poll_fn(|context| {
                        assert!(operation.as_mut().poll(context).is_pending());
                        Poll::Ready(())
                    })
                    .await;
                    tokio::task::yield_now().await;
                }
            })
            .await
            .expect("original request reached peer");
            drop(operation);
            assert!(probe.resource_status().pending_driver);
            assert!(!probe.resource_status().operation_completed);
            probe.close().await.expect("join cancelled request driver");
            assert!(!probe.resource_status().pending_driver);
            assert!(!probe.resource_status().operation_completed);
            assert_eq!(
                probe.resource_status().error,
                Some(NativeStatusError::Cancelled)
            );
            assert!(peer_terminal(peer.task).await.is_some());
        });
    }
}
