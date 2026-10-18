//! S10: M1b's transport crate set wired together, so every crate compiles for each target and the
//! calls survive linking into the mobile app. Pairing and statement formats follow plan §7.

use std::fmt;
use std::io;
use std::sync::Arc;

use hmac::{KeyInit, Mac};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use rcgen::PublicKeyData;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{CertificateError, DigitallySignedStruct, DistinguishedName, SignatureScheme};
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

#[cfg(all(feature = "ring", feature = "aws-lc-rs"))]
compile_error!("enable one crypto provider feature: ring or aws-lc-rs");
#[cfg(not(any(feature = "ring", feature = "aws-lc-rs")))]
compile_error!("enable one crypto provider feature: ring or aws-lc-rs");

pub type Error = Box<dyn std::error::Error + Send + Sync>;

pub const EKM_LABEL: &[u8] = b"EXPERIMENTAL-draftyak-pair-v1";
pub const HUB_NAME: &str = "hub.draftyak.invalid";
pub const DEVICE_NAME: &str = "device.draftyak.invalid";
pub const PROVIDER: &str = if cfg!(feature = "ring") { "ring" } else { "aws-lc-rs" };
pub const SEND_TIME_MS: i64 = 1_792_000_000_000;
pub const SEND_TIME_TEXT: &str = "Wed 14 Oct, 12:46 CDT (UTC-05:00)";

/// The rustls provider this build was compiled with; nothing relies on a process default.
pub fn provider() -> Arc<CryptoProvider> {
    #[cfg(feature = "ring")]
    let provider = rustls::crypto::ring::default_provider();
    #[cfg(feature = "aws-lc-rs")]
    let provider = rustls::crypto::aws_lc_rs::default_provider();
    Arc::new(provider)
}

pub fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut bytes = [0u8; N];
    provider().secure_random.fill(&mut bytes).map_err(|_| "the provider's random failed")?;
    Ok(bytes)
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part);
    }
    hash.finalize().into()
}

pub fn spki_sha256(cert: &CertificateDer<'_>) -> Result<[u8; 32], rustls::Error> {
    let parsed = ParsedCertificate::try_from(cert)?;
    Ok(sha256(&[parsed.subject_public_key_info().as_ref()]))
}

/// `DYK-XXXX-XXXX-XXXX-XXXX` from the hub's SPKI hash.
pub fn hub_id(spki_sha256: &[u8; 32]) -> String {
    let hex: String = spki_sha256[..8].iter().map(|b| format!("{b:02X}")).collect();
    format!("DYK-{}-{}-{}-{}", &hex[0..4], &hex[4..8], &hex[8..12], &hex[12..16])
}

/// A self-signed P-256 certificate (rcgen) with its PKCS#8 key and SPKI hash.
pub struct Identity {
    pub cert: CertificateDer<'static>,
    pub key: PrivatePkcs8KeyDer<'static>,
    pub spki_sha256: [u8; 32],
}

pub fn new_identity(name: &str) -> Result<Identity, Error> {
    let certified = rcgen::generate_simple_self_signed(vec![name.to_owned()])?;
    let spki_sha256 = sha256(&[&certified.signing_key.subject_public_key_info()]);
    let key = PrivatePkcs8KeyDer::from(certified.signing_key.serialize_der());
    Ok(Identity { cert: certified.cert.der().clone(), key, spki_sha256 })
}

/// Accepts exactly one SPKI; signatures are still checked with the provider's algorithms.
#[derive(Debug)]
pub struct SpkiPin {
    spki_sha256: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl SpkiPin {
    pub fn new(spki_sha256: [u8; 32]) -> Self {
        Self { spki_sha256, provider: provider() }
    }

    fn check(&self, cert: &CertificateDer<'_>) -> Result<(), rustls::Error> {
        if spki_sha256(cert)? == self.spki_sha256 {
            Ok(())
        } else {
            Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure))
        }
    }
}

type Signed = Result<HandshakeSignatureValid, rustls::Error>;

// The handshake-signature methods both verifier traits share (the TLS 1.2 one is never reached:
// TLS 1.2 isn't compiled in).
macro_rules! provider_signatures {
    () => {
        fn verify_tls12_signature(
            &self,
            m: &[u8],
            c: &CertificateDer,
            d: &DigitallySignedStruct,
        ) -> Signed {
            verify_tls12_signature(m, c, d, &self.provider.signature_verification_algorithms)
        }

        fn verify_tls13_signature(
            &self,
            m: &[u8],
            c: &CertificateDer,
            d: &DigitallySignedStruct,
        ) -> Signed {
            verify_tls13_signature(m, c, d, &self.provider.signature_verification_algorithms)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.provider.signature_verification_algorithms.supported_schemes()
        }
    };
}

impl ServerCertVerifier for SpkiPin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.check(end_entity).map(|()| ServerCertVerified::assertion())
    }

    provider_signatures!();
}

impl ClientCertVerifier for SpkiPin {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.check(end_entity).map(|()| ClientCertVerified::assertion())
    }

    provider_signatures!();
}

/// The device side of L2: TLS 1.3 only, the hub's SPKI pinned, the device's client certificate.
pub fn client_config(hub_spki: [u8; 32], device: &Identity) -> Result<rustls::ClientConfig, Error> {
    let key = PrivateKeyDer::Pkcs8(device.key.clone_key());
    Ok(rustls::ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(SpkiPin::new(hub_spki)))
        .with_client_auth_cert(vec![device.cert.clone()], key)?)
}

/// A stand-in hub for the in-memory checks: mTLS against one device SPKI, no session tickets.
pub fn hub_config(device_spki: [u8; 32], hub: &Identity) -> Result<rustls::ServerConfig, Error> {
    let key = PrivateKeyDer::Pkcs8(hub.key.clone_key());
    let mut config = rustls::ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(Arc::new(SpkiPin::new(device_spki)))
        .with_single_cert(vec![hub.cert.clone()], key)?;
    config.send_tls13_tickets = 0;
    Ok(config)
}

pub async fn connect_tls<S>(
    io: S,
    config: Arc<rustls::ClientConfig>,
    name: &str,
) -> io::Result<tokio_rustls::client::TlsStream<S>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let server_name = ServerName::try_from(name.to_owned()).map_err(io::Error::other)?;
    tokio_rustls::TlsConnector::from(config).connect(server_name, io).await
}

pub async fn dial(
    addr: &str,
    config: Arc<rustls::ClientConfig>,
    name: &str,
) -> io::Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    tcp.set_nodelay(true)?;
    connect_tls(tcp, config, name).await
}

/// `Exporter("EXPERIMENTAL-draftyak-pair-v1", pid, 32)` on the live connection.
pub fn ekm<D>(conn: &rustls::ConnectionCommon<D>, pid: &[u8]) -> Result<[u8; 32], rustls::Error> {
    conn.export_keying_material([0u8; 32], EKM_LABEL, Some(pid))
}

/// `HMAC(sec, "draftyak/pair/v1" ‖ ekm ‖ pubs)`.
pub fn pair_proof(sec: &[u8], ekm: &[u8; 32], pubs: &[u8]) -> Result<[u8; 32], Error> {
    let mut mac = hmac::Hmac::<Sha256>::new_from_slice(sec)?;
    mac.update(b"draftyak/pair/v1");
    mac.update(ekm);
    mac.update(pubs);
    Ok(mac.finalize().into_bytes().into())
}

pub fn verify_pair_proof(sec: &[u8], ekm: &[u8; 32], pubs: &[u8], proof: &[u8]) -> bool {
    hmac::Hmac::<Sha256>::new_from_slice(sec).is_ok_and(|mut mac| {
        mac.update(b"draftyak/pair/v1");
        mac.update(ekm);
        mac.update(pubs);
        mac.verify_slice(proof).is_ok()
    })
}

/// The 6-digit code both screens show.
pub fn sas(ekm: &[u8; 32]) -> u32 {
    let hash = sha256(&[b"draftyak/sas/v1", ekm]);
    u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]) % 1_000_000
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

/// The device's claim body: `hex(pubs).hex(proof)`, where `pubs = transport_pub ‖ approval_pub`
/// (its client certificate's SPKI hash and its SEC1 approval key) and the proof covers its EKM.
pub fn claim_body(
    sec: &[u8],
    ekm: &[u8; 32],
    transport_pub: &[u8; 32],
    approval: &VerifyingKey,
) -> Result<String, Error> {
    let mut pubs = transport_pub.to_vec();
    pubs.extend_from_slice(&approval.to_sec1_bytes());
    Ok(format!("{}.{}", hex(&pubs), hex(&pair_proof(sec, ekm, &pubs)?)))
}

/// Plan §7 step 6 on the hub: `transport_pub` must be the client certificate's SPKI on this
/// connection, and the proof must hold for the hub's own EKM of it.
pub fn verify_claim(sec: &[u8], hub_ekm: &[u8; 32], client_spki: &[u8; 32], body: &str) -> bool {
    let Some((pubs, proof)) = body.split_once('.') else {
        return false;
    };
    let (Some(pubs), Some(proof)) = (unhex(pubs), unhex(proof)) else {
        return false;
    };
    pubs.len() == 32 + 65
        && pubs[..32] == client_spki[..]
        && verify_pair_proof(sec, hub_ekm, &pubs, &proof)
}

pub fn new_approval_key() -> Result<SigningKey, Error> {
    loop {
        if let Ok(key) = SigningKey::from_slice(&random::<32>()?) {
            return Ok(key);
        }
    }
}

/// A JSON value whose objects have unique keys at every depth. serde_json keeps the last of two
/// equal keys, and serde_json_canonicalizer's `pipe()` parses with it.
struct UniqueKeys(serde_json::Value);

impl<'de> Deserialize<'de> for UniqueKeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(UniqueKeysVisitor).map(UniqueKeys)
    }
}

struct UniqueKeysVisitor;

impl<'de> Visitor<'de> for UniqueKeysVisitor {
    type Value = serde_json::Value;

    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, v: bool) -> Result<Self::Value, E> {
        Ok(v.into())
    }

    fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
        Ok(v.into())
    }

    fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
        Ok(v.into())
    }

    fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
        serde_json::Number::from_f64(v)
            .map(Into::into)
            .ok_or_else(|| E::custom("not a JSON number"))
    }

    fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
        Ok(v.into())
    }

    fn visit_string<E: de::Error>(self, v: String) -> Result<Self::Value, E> {
        Ok(v.into())
    }

    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
        Ok(serde_json::Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(UniqueKeys(item)) = seq.next_element()? {
            items.push(item);
        }
        Ok(items.into())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut object = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if object.contains_key(&key) {
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            let UniqueKeys(value) = map.next_value()?;
            object.insert(key, value);
        }
        Ok(object.into())
    }
}

/// `"draftyak/v1/<typ>\n" ‖ JCS(stmt)`. A statement that repeats a key anywhere is refused while
/// parsing, before JCS, so two parsers that keep different duplicates never see two statements.
pub fn statement_message(typ: &str, stmt_json: &str) -> Result<Vec<u8>, Error> {
    let UniqueKeys(stmt) = serde_json::from_str(stmt_json)?;
    let mut message = format!("draftyak/v1/{typ}\n").into_bytes();
    message.extend(serde_json_canonicalizer::to_vec(&stmt)?);
    Ok(message)
}

pub fn sign_statement(key: &SigningKey, typ: &str, stmt_json: &str) -> Result<Signature, Error> {
    Ok(key.sign(&statement_message(typ, stmt_json)?))
}

pub fn verify_statement(
    key: &VerifyingKey,
    typ: &str,
    stmt_json: &str,
    signature: &Signature,
) -> Result<(), Error> {
    Ok(key.verify(&statement_message(typ, stmt_json)?, signature)?)
}

/// Send time as the approval window shows it, from jiff's bundled tz database.
pub fn render_send_time(unix_ms: i64, zone: &str) -> Result<String, Error> {
    let tz = jiff::tz::TimeZoneDatabase::bundled().get(zone)?;
    let zoned = jiff::Timestamp::from_millisecond(unix_ms)?.to_zoned(tz);
    Ok(zoned.strftime("%a %-d %b, %H:%M %Z (UTC%:z)").to_string())
}

/// keyring 4's stores through keyring-core, as its docs advise for apps that pick their stores:
/// Android SharedPreferences sealed by the Keystore, the iOS protected-data keychain.
pub fn use_platform_store() -> Result<(), Error> {
    keyring_core::set_default_store(platform_store()?);
    Ok(())
}

#[cfg(target_os = "android")]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, Error> {
    Ok(android_native_keyring_store::Store::new()?)
}

#[cfg(target_os = "ios")]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, Error> {
    Ok(apple_native_keyring_store::protected::Store::new()?)
}

// keyring-core's in-memory store, only in the tests' builds (plan §7: a mock store is e2e-only).
#[cfg(all(not(any(target_os = "android", target_os = "ios")), feature = "mock-store"))]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, Error> {
    Ok(keyring_core::mock::Store::new()?)
}

#[cfg(not(any(target_os = "android", target_os = "ios", feature = "mock-store")))]
fn platform_store() -> Result<Arc<keyring_core::CredentialStore>, Error> {
    Err("no keyring store: desktop stores are S5's (M0.21), and only tests get the mock".into())
}

pub fn keyring_round_trip(service: &str, user: &str, secret: &[u8]) -> Result<bool, Error> {
    if keyring_core::get_default_store().is_none() {
        use_platform_store()?;
    }
    let entry = keyring_core::Entry::new(service, user)?;
    entry.set_secret(secret)?;
    let same = entry.get_secret()? == secret;
    entry.delete_credential()?;
    Ok(same)
}

/// One HTTP/1.1 POST over an established stream (hyper's client connection).
pub async fn http_post<S>(stream: S, host: &str, path: &str, body: String) -> Result<u16, Error>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let io = hyper_util::rt::TokioIo::new(stream);
    let (mut sender, connection) = hyper::client::conn::http1::handshake(io).await?;
    tokio::spawn(connection);
    let request = hyper::Request::post(path).header(hyper::header::HOST, host).body(body)?;
    Ok(sender.send_request(request).await?.status().as_u16())
}

/// A WebSocket over an established stream (tokio-tungstenite's client handshake).
pub async fn ws_open<S>(
    stream: S,
    url: &str,
) -> Result<tokio_tungstenite::WebSocketStream<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    Ok(tokio_tungstenite::client_async(url, stream).await?.0)
}

// The stand-in hub has no HTTP server stack: one request's head and body, read by hand.
async fn read_body<S: AsyncRead + Unpin>(stream: &mut S) -> io::Result<String> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 || stream.read(&mut byte).await? == 0 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    let length = head.lines().find_map(|line| line.strip_prefix("content-length:"));
    let length = length.map_or(Ok(0), |value| value.trim().parse::<usize>());
    let length = length.ok().filter(|length| *length <= 4096).ok_or(io::ErrorKind::InvalidData)?;
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await?;
    String::from_utf8(body).map_err(io::Error::other)
}

/// The hub's side of `POST /pair/v1/claim` on an accepted connection: its EKM, and whether the
/// claim verified (204) or not (403).
pub async fn accept_claim<S>(
    mut tls: tokio_rustls::server::TlsStream<S>,
    sec: &[u8],
    pid: &[u8],
) -> Result<([u8; 32], bool), Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let (_, conn) = tls.get_ref();
    let hub_ekm = ekm(conn, pid)?;
    let client = conn.peer_certificates().and_then(<[_]>::first).ok_or("no client certificate")?;
    let client_spki = spki_sha256(client)?;
    let body = read_body(&mut tls).await?;
    let claimed = verify_claim(sec, &hub_ekm, &client_spki, &body);
    let status = if claimed { "204 No Content" } else { "403 Forbidden" };
    tls.write_all(format!("HTTP/1.1 {status}\r\ncontent-length: 0\r\n\r\n").as_bytes()).await?;
    tls.flush().await?;
    Ok((hub_ekm, claimed))
}

/// Over in-memory pipes, TLS 1.3 with mTLS and both pins, then the pairing claim over HTTP on the
/// live connection, then a WebSocket on a second one.
async fn transport_checks(
    hub: Arc<Identity>,
    device: Arc<Identity>,
    approval: VerifyingKey,
) -> Result<u32, Error> {
    let client = Arc::new(client_config(hub.spki_sha256, &device)?);
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(hub_config(device.spki_sha256, &hub)?));
    let (sec, pid) = (random::<16>()?, random::<16>()?);
    let mut bits = 0;

    let (near, far) = tokio::io::duplex(64 * 1024);
    let hub_side = tokio::spawn({
        let acceptor = acceptor.clone();
        async move { accept_claim(acceptor.accept(far).await?, &sec, &pid).await }
    });
    let tls = connect_tls(near, client.clone(), HUB_NAME).await?;
    let device_ekm = ekm(tls.get_ref().1, &pid)?;
    let body = claim_body(&sec, &device_ekm, &device.spki_sha256, &approval)?;
    let status = http_post(tls, HUB_NAME, "/pair/v1/claim", body).await?;
    let (hub_ekm, claimed) = hub_side.await??;
    if hub_ekm == device_ekm {
        bits |= CHECK_EKM;
    }
    if status == 204 || status == 403 {
        bits |= CHECK_HTTP;
    }
    if claimed && status == 204 && sas(&hub_ekm) == sas(&device_ekm) {
        bits |= CHECK_PAIR_PROOF;
    }

    let (near, far) = tokio::io::duplex(64 * 1024);
    let hub_side = tokio::spawn(async move {
        let mut ws = tokio_tungstenite::accept_async(acceptor.accept(far).await?).await?;
        ws.close(None).await.ok();
        Ok::<_, Error>(())
    });
    let tls = connect_tls(near, client, HUB_NAME).await?;
    let mut ws = ws_open(tls, &format!("wss://{HUB_NAME}/v1/events")).await?;
    ws.close(None).await.ok();
    hub_side.await??;
    Ok(bits | CHECK_WEBSOCKET)
}

/// Signs and verifies one statement; the same signature under another type, and a statement
/// with a repeated key, must both be refused.
fn statements_hold(key: &SigningKey) -> Result<bool, Error> {
    let stmt = r#"{"v":1,"typ":"approval.send.v1","hub":"DYK-0000-0000-0000-0000","iat":1}"#;
    let signature = sign_statement(key, "approval.send.v1", stmt)?;
    verify_statement(key.verifying_key(), "approval.send.v1", stmt, &signature)?;
    let retyped = verify_statement(key.verifying_key(), "admin.v1", stmt, &signature);
    let repeated = statement_message("approval.send.v1", r#"{"v":1,"v":2}"#);
    Ok(retyped.is_err() && repeated.is_err())
}

pub const CHECK_IDENTITY: u32 = 1;
pub const CHECK_STATEMENT: u32 = 1 << 1;
pub const CHECK_PAIR_PROOF: u32 = 1 << 2;
pub const CHECK_SEND_TIME: u32 = 1 << 3;
pub const CHECK_KEYRING: u32 = 1 << 4;
pub const CHECK_EKM: u32 = 1 << 5;
pub const CHECK_HTTP: u32 = 1 << 6;
pub const CHECK_WEBSOCKET: u32 = 1 << 7;
pub const CHECK_ALL: u32 = (1 << 8) - 1;

/// Runs each call once and returns the bits of those that worked (`CHECK_ALL` when all did).
pub fn run_check() -> u32 {
    let mut bits = 0;
    let (Ok(hub), Ok(device), Ok(approval)) =
        (new_identity(HUB_NAME), new_identity(DEVICE_NAME), new_approval_key())
    else {
        return bits;
    };
    if spki_sha256(&hub.cert).is_ok_and(|spki| hub_id(&spki) == hub_id(&hub.spki_sha256)) {
        bits |= CHECK_IDENTITY;
    }
    if statements_hold(&approval).unwrap_or(false) {
        bits |= CHECK_STATEMENT;
    }
    if render_send_time(SEND_TIME_MS, "America/Chicago").is_ok_and(|text| text == SEND_TIME_TEXT) {
        bits |= CHECK_SEND_TIME;
    }
    if keyring_round_trip("com.draftyak.client", "s10-check", b"s10").unwrap_or(false) {
        bits |= CHECK_KEYRING;
    }
    let runtime = tokio::runtime::Builder::new_current_thread().build();
    if let Ok(runtime) = runtime {
        let checks = transport_checks(Arc::new(hub), Arc::new(device), *approval.verifying_key());
        bits |= runtime.block_on(checks).unwrap_or(0);
    }
    bits
}

/// The exported root that keeps every call above in a linked library.
#[unsafe(no_mangle)]
pub extern "C" fn draftyak_transport_check() -> u32 {
    run_check()
}
