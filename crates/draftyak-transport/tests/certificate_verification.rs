use draftyak_transport::{
    Error,
    tls::{Identity, PinnedConnection, certificate_spki_hash},
};
use rcgen::{
    CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256, PKCS_ECDSA_P384_SHA384, PublicKeyData,
};
use rustls::{
    AlertDescription, ServerConfig, SignatureAlgorithm, SignatureScheme,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    server::{ClientHello, ResolvesServerCert},
    sign::{CertifiedKey, Signer, SigningKey},
};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::timeout,
};

const DEADLINE: Duration = Duration::from_secs(15);

#[derive(Debug)]
struct ObservedSigningKey {
    key: Arc<dyn SigningKey>,
    signatures: Arc<AtomicUsize>,
}
impl SigningKey for ObservedSigningKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        self.key.choose_scheme(offered).map(|signer| {
            Box::new(ObservedSigner {
                signer,
                signatures: self.signatures.clone(),
            }) as Box<dyn Signer>
        })
    }
    fn algorithm(&self) -> SignatureAlgorithm {
        self.key.algorithm()
    }
}
#[derive(Debug)]
struct ObservedSigner {
    signer: Box<dyn Signer>,
    signatures: Arc<AtomicUsize>,
}
impl Signer for ObservedSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, rustls::Error> {
        self.signatures.fetch_add(1, Ordering::SeqCst);
        self.signer.sign(message)
    }
    fn scheme(&self) -> SignatureScheme {
        self.signer.scheme()
    }
}
#[derive(Debug)]
struct Resolver(Arc<CertifiedKey>);
impl ResolvesServerCert for Resolver {
    fn resolve(&self, _: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}
struct AbortOnDrop<T>(JoinHandle<T>);
impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}
#[derive(Debug)]
struct Observation {
    tls_accepted: bool,
    application_bytes: usize,
    alert: Option<AlertDescription>,
}

async fn exchange(
    certificate: CertificateDer<'static>,
    signing_key: Vec<u8>,
    pin: [u8; 32],
) -> (Result<Vec<u8>, Error>, Observation, usize) {
    let key = rustls::crypto::ring::sign::any_supported_type(&PrivateKeyDer::Pkcs8(
        PrivatePkcs8KeyDer::from(signing_key),
    ))
    .unwrap();
    let signatures = Arc::new(AtomicUsize::new(0));
    // A resolver deliberately permits a certificate/key mismatch for the hostile peer.
    let certified = CertifiedKey::new(
        vec![certificate],
        Arc::new(ObservedSigningKey {
            key,
            signatures: signatures.clone(),
        }),
    );
    let mut config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(Resolver(Arc::new(certified))));
    config.send_tls13_tickets = 0;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let mut peer = AbortOnDrop(tokio::spawn(async move {
        timeout(DEADLINE, async move {
            let (stream, _) = listener.accept().await.unwrap();
            match tokio_rustls::TlsAcceptor::from(Arc::new(config))
                .accept(stream)
                .await
            {
                Ok(mut tls) => {
                    let mut bytes = [0; 4096];
                    let application_bytes = tls.read(&mut bytes).await.unwrap();
                    if application_bytes > 0 {
                        tls.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                            .await
                            .unwrap();
                        tls.flush().await.unwrap();
                    }
                    tls.shutdown().await.unwrap();
                    Observation {
                        tls_accepted: true,
                        application_bytes,
                        alert: None,
                    }
                }
                Err(error) => Observation {
                    tls_accepted: false,
                    application_bytes: 0,
                    alert: error
                        .get_ref()
                        .and_then(|error| error.downcast_ref::<rustls::Error>())
                        .and_then(|error| match error {
                            rustls::Error::AlertReceived(alert) => Some(*alert),
                            _ => None,
                        }),
                },
            }
        })
        .await
        .expect("peer handshake and shutdown deadline")
    }));
    let identity = Identity::generate().unwrap();
    let result = timeout(DEADLINE, async {
        let connection = PinnedConnection::connect(address, &identity, pin).await?;
        connection
            .post("/synthetic", b"{}")
            .await
            .map(|body| body.as_bytes().to_vec())
    })
    .await
    .expect("native handshake and HTTP deadline");
    let observation = timeout(DEADLINE, &mut peer.0)
        .await
        .expect("peer join deadline")
        .expect("peer task");
    (result, observation, signatures.load(Ordering::SeqCst))
}

#[tokio::test]
async fn matching_p384_spki_pin_is_refused_before_application_bytes() {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P384_SHA384).unwrap();
    let certificate = CertificateParams::new(vec!["synthetic.invalid".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let actual_pin = Sha256::digest(key.subject_public_key_info()).into();
    let (result, observed, _) =
        exchange(certificate.der().clone(), key.serialize_der(), actual_pin).await;
    assert_eq!(result, Err(Error::ConnectionFailed));
    assert!(!observed.tls_accepted);
    assert_eq!(observed.application_bytes, 0);
}

#[tokio::test]
async fn matching_p256_certificate_requires_its_own_certificate_verify_key() {
    let certificate_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let unrelated_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let certificate = CertificateParams::new(vec!["synthetic.invalid".into()])
        .unwrap()
        .self_signed(&certificate_key)
        .unwrap();
    let pin = certificate_spki_hash(certificate.der()).unwrap();
    assert_eq!(
        pin,
        <[u8; 32]>::from(Sha256::digest(certificate_key.subject_public_key_info()))
    );
    assert_ne!(
        pin,
        <[u8; 32]>::from(Sha256::digest(unrelated_key.subject_public_key_info()))
    );
    let (result, observed, signatures) = exchange(
        certificate.der().clone(),
        unrelated_key.serialize_der(),
        pin,
    )
    .await;
    assert_eq!(signatures, 1, "peer generated CertificateVerify");
    assert_eq!(
        observed.alert,
        Some(AlertDescription::DecryptError),
        "the correctly pinned certificate reached handshake signature rejection"
    );
    assert_eq!(result, Err(Error::ConnectionFailed));
    assert!(!observed.tls_accepted);
    assert_eq!(observed.application_bytes, 0);
}

#[tokio::test]
async fn matching_p256_certificate_and_signature_allow_application_bytes() {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let certificate = CertificateParams::new(vec!["synthetic.invalid".into()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let pin = certificate_spki_hash(certificate.der()).unwrap();
    let (result, observed, signatures) =
        exchange(certificate.der().clone(), key.serialize_der(), pin).await;
    assert_eq!(result, Ok(b"ok".to_vec()));
    assert_eq!(signatures, 1);
    assert!(observed.tls_accepted);
    assert!(observed.application_bytes > 0);
    assert_eq!(observed.alert, None);
}
