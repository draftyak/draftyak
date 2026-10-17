//! TLS 1.3 peers that export the pairing keying material of plan section 7, pairing step 6:
//! `Exporter("EXPERIMENTAL-draftyak-pair-v1", pid, 32)`, on rustls with `ring`, or with aws-lc-rs
//! in the trial build.

use std::sync::Arc;

use rustls::client::Resumption;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{
    CertificateError, ClientConfig, ConnectionCommon, DigitallySignedStruct, Error, ServerConfig,
    SignatureScheme,
};

#[cfg(not(any(feature = "ring", feature = "aws-lc-rs")))]
compile_error!("build with the ring (default) or the aws-lc-rs feature");

#[cfg(feature = "aws-lc-rs")]
use {aws_lc_rs::digest, rustls::crypto::aws_lc_rs::default_provider};
#[cfg(not(feature = "aws-lc-rs"))]
use {ring::digest, rustls::crypto::ring::default_provider};

pub const LABEL: &[u8] = b"EXPERIMENTAL-draftyak-pair-v1";
pub const EKM_LEN: usize = 32;
pub const PID_LEN: usize = 16;
pub const PROVIDER: &str = if cfg!(feature = "aws-lc-rs") {
    "aws-lc-rs"
} else {
    "ring"
};

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(default_provider())
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    out.copy_from_slice(digest::digest(&digest::SHA256, bytes).as_ref());
    out
}

/// SHA-256 of the certificate's SubjectPublicKeyInfo, which a device pins as the hub ID.
pub fn spki_sha256(cert: &CertificateDer<'_>) -> Result<[u8; 32], Error> {
    let parsed = ParsedCertificate::try_from(cert)?;
    Ok(sha256(parsed.subject_public_key_info().as_ref()))
}

/// Trusts exactly one server key, by its SPKI hash, as a paired device trusts its hub.
#[derive(Debug)]
struct PinnedServer {
    spki_sha256: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if spki_sha256(end_entity)? == self.spki_sha256 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        let algorithms = &self.provider.signature_verification_algorithms;
        verify_tls12_signature(message, cert, dss, algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        let algorithms = &self.provider.signature_verification_algorithms;
        verify_tls13_signature(message, cert, dss, algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// The device side: TLS 1.3 only, the hub pinned by SPKI, a client certificate, no resumption.
pub fn client_config(
    server_spki_sha256: [u8; 32],
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<ClientConfig, Error> {
    let provider = provider();
    let verifier = Arc::new(PinnedServer {
        spki_sha256: server_spki_sha256,
        provider: provider.clone(),
    });
    let mut config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(chain, key)?;
    config.resumption = Resumption::disabled();
    Ok(config)
}

/// A TLS 1.3 server that sends no session tickets, as plan section 7 sets for L2.
pub fn server_config(
    chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<ServerConfig, Error> {
    let mut config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(chain, key)?;
    config.send_tls13_tickets = 0;
    Ok(config)
}

pub fn load_chain(path: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    CertificateDer::pem_file_iter(path)
        .and_then(|certs| certs.collect())
        .map_err(|error| format!("{path}: {error}"))
}

pub fn load_key(path: &str) -> Result<PrivateKeyDer<'static>, String> {
    PrivateKeyDer::from_pem_file(path).map_err(|error| format!("{path}: {error}"))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn unhex<const N: usize>(text: &str) -> Result<[u8; N], String> {
    let mut out = [0; N];
    if text.len() != 2 * N || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("expected {} hex digits", 2 * N));
    }
    for (at, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * at..2 * at + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// One side's view of a finished handshake: the pairing EKM and, for comparison, the exporter
/// without a context.
pub struct Exported {
    pub protocol: String,
    pub cipher_suite: String,
    pub group: String,
    pub peer_spki_sha256: Option<[u8; 32]>,
    pub ekm: [u8; EKM_LEN],
    pub ekm_no_context: [u8; EKM_LEN],
}

pub fn export<D>(conn: &ConnectionCommon<D>, pid: &[u8; PID_LEN]) -> Result<Exported, Error> {
    let named = |name: Option<String>| name.unwrap_or_else(|| "none".to_string());
    let peer_spki_sha256 = match conn.peer_certificates() {
        Some([leaf, ..]) => Some(spki_sha256(leaf)?),
        _ => None,
    };
    Ok(Exported {
        protocol: named(conn.protocol_version().map(|v| format!("{v:?}"))),
        cipher_suite: named(
            conn.negotiated_cipher_suite()
                .map(|s| format!("{:?}", s.suite())),
        ),
        group: named(
            conn.negotiated_key_exchange_group()
                .map(|g| format!("{:?}", g.name())),
        ),
        peer_spki_sha256,
        ekm: conn.export_keying_material([0; EKM_LEN], LABEL, Some(pid))?,
        ekm_no_context: conn.export_keying_material([0; EKM_LEN], LABEL, None)?,
    })
}

impl Exported {
    /// One JSON line; every string is an enum name or hex, so nothing needs escaping.
    pub fn to_json(&self, role: &str) -> String {
        let peer = self
            .peer_spki_sha256
            .map_or_else(|| "null".to_string(), |hash| format!("\"{}\"", hex(&hash)));
        format!(
            "{{\"role\":\"{role}\",\"provider\":\"{PROVIDER}\",\"protocol\":\"{}\",\
             \"cipherSuite\":\"{}\",\"group\":\"{}\",\"peerSpkiSha256\":{peer},\
             \"ekm\":\"{}\",\"ekmNoContext\":\"{}\"}}",
            self.protocol,
            self.cipher_suite,
            self.group,
            hex(&self.ekm),
            hex(&self.ekm_no_context),
        )
    }
}
