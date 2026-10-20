use std::{fmt, net::SocketAddr, sync::Arc, time::Duration};

use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, Uri, body::Bytes};
use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256, PublicKeyData};
use rustls::client::{
    Resumption,
    danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use zeroize::Zeroizing;

use crate::{Error, RefusalCode};

const IO_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Identity {
    certificate: CertificateDer<'static>,
    key: Zeroizing<Vec<u8>>,
    spki_hash: [u8; 32],
}

impl fmt::Debug for Identity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Identity([redacted])")
    }
}

impl Identity {
    pub fn generate() -> Result<Self, Error> {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|_| Error::InvalidKey)?;
        let params = CertificateParams::new(vec!["device.draftyak.invalid".to_owned()])
            .map_err(|_| Error::InvalidKey)?;
        let cert = params.self_signed(&key).map_err(|_| Error::InvalidKey)?;
        Ok(Self {
            certificate: cert.der().clone(),
            key: Zeroizing::new(key.serialize_der()),
            spki_hash: Sha256::digest(key.subject_public_key_info()).into(),
        })
    }

    pub fn certificate(&self) -> &[u8] {
        self.certificate.as_ref()
    }
    pub fn spki_hash(&self) -> [u8; 32] {
        self.spki_hash
    }

    pub fn client_config(&self, hub_pin: [u8; 32]) -> Result<rustls::ClientConfig, Error> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = Arc::new(PinnedServer {
            pin: hub_pin,
            provider: provider.clone(),
        });
        let mut config = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| Error::InvalidKey)?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_client_auth_cert(
                vec![self.certificate.clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.to_vec())),
            )
            .map_err(|_| Error::InvalidKey)?;
        config.resumption = Resumption::disabled();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(config)
    }
}

pub fn certificate_spki_hash(certificate: &CertificateDer<'_>) -> Result<[u8; 32], Error> {
    let parsed = ParsedCertificate::try_from(certificate).map_err(|_| Error::InvalidKey)?;
    let spki = parsed.subject_public_key_info();
    draftyak_protocol::sign::verifying_key_from_spki(spki.as_ref())
        .map_err(|_| Error::InvalidKey)?;
    Ok(Sha256::digest(spki.as_ref()).into())
}

#[derive(Debug)]
struct PinnedServer {
    pin: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedServer {
    fn verify_server_cert(
        &self,
        certificate: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if certificate_spki_hash(certificate).is_ok_and(|hash| hash == self.pin) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

pub struct PinnedConnection {
    stream: TlsStream<TcpStream>,
    authority: String,
}

impl fmt::Debug for PinnedConnection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PinnedConnection([redacted])")
    }
}

impl PinnedConnection {
    /// Called only after native owner consent. No HTTP bytes leave before the pin holds.
    pub async fn connect(
        address: SocketAddr,
        identity: &Identity,
        hub_pin: [u8; 32],
    ) -> Result<Self, Error> {
        Self::connect_address(&address.to_string(), identity, hub_pin).await
    }

    /// A native-decoded address only; the caller must have collected explicit pairing consent.
    pub async fn connect_for_pairing(
        payload: &crate::payload::Payload,
        address_index: usize,
        identity: &Identity,
    ) -> Result<Self, Error> {
        let address = payload
            .native_addresses()
            .get(address_index)
            .ok_or(Error::InvalidInput)?;
        Self::connect_address(address, identity, payload.hub_pin()).await
    }

    async fn connect_address(
        address: &str,
        identity: &Identity,
        hub_pin: [u8; 32],
    ) -> Result<Self, Error> {
        if !crate::payload::address(address) {
            return Err(Error::InvalidInput);
        }
        let host = address
            .rsplit_once(':')
            .ok_or(Error::InvalidInput)?
            .0
            .trim_start_matches('[')
            .trim_end_matches(']');
        let name = ServerName::try_from(host.to_owned()).map_err(|_| Error::InvalidInput)?;
        let config = identity.client_config(hub_pin)?;
        let connect = async {
            let tcp = TcpStream::connect(address)
                .await
                .map_err(|_| Error::ConnectionFailed)?;
            tcp.set_nodelay(true).map_err(|_| Error::ConnectionFailed)?;
            let stream = tokio_rustls::TlsConnector::from(Arc::new(config))
                .connect(name, tcp)
                .await
                .map_err(|_| Error::ConnectionFailed)?;
            Ok(Self {
                stream,
                authority: address.to_string(),
            })
        };
        tokio::time::timeout(IO_TIMEOUT, connect)
            .await
            .map_err(|_| Error::TimedOut)?
    }

    /// Consumes this connection for a later native protocol layer, retaining its pin result.
    /// The caller obtained owner consent before connect; this grants no device authority.
    /// The returned authority belongs to this already-connected stream, never a new dial.
    pub fn into_stream(self) -> (TlsStream<TcpStream>, String) {
        (self.stream, self.authority)
    }

    /// Exports the merged M1.21 contract's raw keying material on this pinned stream.
    /// No SAS, claim or proof is computed here.
    pub fn pairing_ekm(&self, context: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>, Error> {
        let mut result = Zeroizing::new([0; 32]);
        self.stream
            .get_ref()
            .1
            .export_keying_material(&mut *result, EKM_LABEL, Some(context))
            .map_err(|_| Error::ConnectionFailed)?;
        Ok(result)
    }

    /// Performs one bounded native HTTP/1.1 request on this already-pinned connection.
    /// A 200 body remains opaque: later protocol layers own its interpretation.
    pub async fn post(self, target: &str, body: &[u8]) -> Result<ResponseBody, Error> {
        if target.len() > 2048
            || !target.starts_with('/')
            || target.starts_with("//")
            || target.contains('#')
            || body.len() > MAX_HTTP_BODY_BYTES
        {
            return Err(Error::InvalidInput);
        }
        let uri: Uri = target.parse().map_err(|_| Error::InvalidInput)?;
        if uri.scheme().is_some() || uri.authority().is_some() {
            return Err(Error::InvalidInput);
        }
        let request = Request::post(uri)
            .header("host", self.authority)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::copy_from_slice(body)))
            .map_err(|_| Error::InvalidInput)?;
        let mut driver = Driver(None);
        let result = tokio::time::timeout(IO_TIMEOUT, async {
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(self.stream))
                    .await
                    .map_err(|_| Error::ConnectionFailed)?;
            driver.0 = Some(tokio::spawn(async move {
                let _ = connection.await;
            }));
            let response = sender
                .send_request(request)
                .await
                .map_err(|_| Error::ConnectionFailed)?;
            let status = response.status().as_u16();
            let bytes = Limited::new(response.into_body(), MAX_HTTP_BODY_BYTES)
                .collect()
                .await
                .map_err(|_| Error::InvalidResponse)?
                .to_bytes();
            match status {
                200 => Ok(ResponseBody(Zeroizing::new(bytes.to_vec()))),
                403 => Err(Error::Refused(RefusalCode::read(&bytes)?)),
                _ => Err(Error::InvalidResponse),
            }
        })
        .await
        .map_err(|_| Error::TimedOut)
        .and_then(|value| value);
        driver.close().await;
        result
    }
}

pub const EKM_LABEL: &[u8] = b"EXPERIMENTAL-draftyak-pair-v1";
pub const EKM_LENGTH: usize = 32;
pub const MAX_HTTP_BODY_BYTES: usize = 4096;

pub struct ResponseBody(Zeroizing<Vec<u8>>);
impl ResponseBody {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}
impl fmt::Debug for ResponseBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ResponseBody([redacted])")
    }
}
struct Driver(Option<tokio::task::JoinHandle<()>>);
impl Driver {
    async fn close(&mut self) {
        if let Some(task) = self.0.take() {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        if let Some(task) = &self.0 {
            task.abort();
        }
    }
}
