use draftyak_transport::{
    Error, RefusalCode,
    tls::{Identity, MAX_HTTP_BODY_BYTES, PinnedConnection},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[path = "support/node_peer.rs"]
mod node_peer;
use node_peer::{CONTEXT, Peer};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
#[tokio::test]
async fn successful_http_body_remains_opaque_even_when_it_is_not_utf8_or_json() {
    let body = [0, 0xff, b'{', b']'];
    let mut peer = Peer::start("normal", 200, &body);
    let identity = Identity::generate().unwrap();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    let response = connection.post("/native-test", b"{}").await.unwrap();
    assert_eq!(response.as_bytes(), body);
    assert_eq!(format!("{response:?}"), "ResponseBody([redacted])");
    peer.wait_for_connection_close();
    assert_eq!(peer.stop(), 1);
}

#[tokio::test]
async fn actual_node_observes_client_spki_and_the_same_merged_exporter_before_opaque_http() {
    let mut peer = Peer::start("normal", 200, b"PRIVATE_SYNTHETIC_RESPONSE");
    let identity = Identity::generate().unwrap();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    let ekm = connection.pairing_ekm(&CONTEXT).unwrap();
    let tls = peer.next();
    assert_eq!(tls["event"], "tls");
    let client_pin = hex(&identity.spki_hash());
    let exporter = hex(&*ekm);
    assert!(tls["clientPin"].as_str() == Some(client_pin.as_str()));
    assert!(tls["ekm"].as_str() == Some(exporter.as_str()));
    assert_eq!(tls["version"], "TLSv1.3");
    let response = connection.post("/native-test", b"{}").await.unwrap();
    assert!(response.as_bytes() == b"PRIVATE_SYNTHETIC_RESPONSE");
    assert_eq!(format!("{response:?}"), "ResponseBody([redacted])");
    assert_eq!(format!("{identity:?}"), "Identity([redacted])");
    peer.wait_for_connection_close();
    let summary = peer.stop_summary();
    assert_eq!(summary.requests, 1);
    assert!(summary.application_bytes > 0);
}
#[tokio::test]
async fn wrong_full_spki_refuses_before_any_http_request_byte() {
    let mut peer = Peer::start("normal", 200, b"ok");
    let identity = Identity::generate().unwrap();
    let mut wrong = peer.pin;
    wrong[31] ^= 1;
    assert!(matches!(
        PinnedConnection::connect(peer.address, &identity, wrong).await,
        Err(Error::ConnectionFailed)
    ));
    peer.wait_for_connection_close();
    let summary = peer.stop_summary();
    assert_eq!(summary.requests, 0);
    assert_eq!(summary.application_bytes, 0);
}
#[tokio::test]
async fn consuming_handoff_contains_the_actual_pinned_stream_without_sending_http() {
    let mut peer = Peer::start("normal", 200, b"ok");
    let identity = Identity::generate().unwrap();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    let (stream, authority) = connection.into_stream();
    assert_eq!(authority, peer.address.to_string());
    assert_eq!(
        stream.get_ref().1.protocol_version(),
        Some(rustls::ProtocolVersion::TLSv1_3)
    );
    assert_eq!(peer.next()["event"], "tls");
    drop(stream);
    peer.wait_for_connection_close();
    assert_eq!(peer.stop(), 0);
}
#[tokio::test]
async fn tls12_is_rejected_and_a_silent_handshake_reaches_the_native_deadline() {
    let mut old = Peer::start("tls12", 200, b"ok");
    let identity = Identity::generate().unwrap();
    assert!(matches!(
        PinnedConnection::connect(old.address, &identity, old.pin).await,
        Err(Error::ConnectionFailed)
    ));
    assert_eq!(old.stop(), 0);
    let mut silent = Peer::start("silent-tls", 200, b"");
    let began = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        PinnedConnection::connect(silent.address, &identity, silent.pin),
    )
    .await
    .expect("connect has an outer deadline");
    assert!(matches!(result, Err(Error::TimedOut)));
    assert!(began.elapsed() >= Duration::from_secs(9));
    assert_eq!(silent.stop(), 0);
}
#[tokio::test]
async fn invalid_targets_and_over_cap_request_bodies_fail_before_any_http_byte() {
    for target in [
        "https://other.invalid/",
        "//other.invalid/",
        "relative",
        "/bad#fragment",
    ] {
        let mut peer = Peer::start("normal", 200, b"ok");
        let identity = Identity::generate().unwrap();
        let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
            .await
            .unwrap();
        assert!(matches!(
            connection.post(target, b"{}").await,
            Err(Error::InvalidInput)
        ));
        peer.wait_for_connection_close();
        let summary = peer.stop_summary();
        assert_eq!(summary.requests, 0);
        assert_eq!(summary.application_bytes, 0);
    }
    let mut peer = Peer::start("normal", 200, b"ok");
    let identity = Identity::generate().unwrap();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    assert!(matches!(
        connection
            .post("/native-test", &vec![0; MAX_HTTP_BODY_BYTES + 1])
            .await,
        Err(Error::InvalidInput)
    ));
    peer.wait_for_connection_close();
    let summary = peer.stop_summary();
    assert_eq!(summary.requests, 0);
    assert_eq!(summary.application_bytes, 0);
}
#[tokio::test]
async fn http_target_byte_cap_accepts_2048_and_refuses_2049_before_application_bytes() {
    let identity = Identity::generate().unwrap();
    let exact = format!("/{}", "x".repeat(2047));
    assert_eq!(exact.len(), 2048);
    let mut peer = Peer::start("normal", 200, b"ok");
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    assert!(connection.post(&exact, b"{}").await.unwrap().as_bytes() == b"ok");
    peer.wait_for_connection_close();
    let summary = peer.stop_summary();
    assert_eq!(summary.requests, 1);
    assert!(summary.application_bytes > 0);
    let over = format!("/{}", "x".repeat(2048));
    assert_eq!(over.len(), 2049);
    let mut peer = Peer::start("normal", 200, b"ok");
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    assert!(matches!(
        connection.post(&over, b"{}").await,
        Err(Error::InvalidInput)
    ));
    peer.wait_for_connection_close();
    let summary = peer.stop_summary();
    assert_eq!(summary.requests, 0);
    assert_eq!(summary.application_bytes, 0);
}
#[tokio::test]
async fn http_request_and_response_byte_caps_accept_the_exact_neighbor_and_refuse_one_more() {
    let mut peer = Peer::start("normal", 200, &vec![b'x'; MAX_HTTP_BODY_BYTES]);
    let identity = Identity::generate().unwrap();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    let response = connection
        .post("/native-test", &vec![b'x'; MAX_HTTP_BODY_BYTES])
        .await
        .unwrap();
    assert_eq!(response.as_bytes().len(), MAX_HTTP_BODY_BYTES);
    assert_eq!(peer.stop(), 1);
    let mut peer = Peer::start("normal", 200, &vec![b'x'; MAX_HTTP_BODY_BYTES + 1]);
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    assert!(matches!(
        connection.post("/native-test", b"{}").await,
        Err(Error::InvalidResponse)
    ));
    assert_eq!(peer.stop(), 1);
}
#[tokio::test]
async fn all_four_refusals_remain_typed_and_malformed_or_other_status_bodies_are_fixed_errors() {
    for code in [
        RefusalCode::WindowClosed,
        RefusalCode::ClaimInvalid,
        RefusalCode::RoleMismatch,
        RefusalCode::ProofInvalid,
    ] {
        let body = serde_json::to_vec(&serde_json::json!({"code":code.code()})).unwrap();
        let mut peer = Peer::start("normal", 403, &body);
        let identity = Identity::generate().unwrap();
        let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
            .await
            .unwrap();
        assert!(
            matches!(connection.post("/native-test", b"{}").await, Err(Error::Refused(actual)) if actual == code)
        );
        assert_eq!(peer.stop(), 1);
    }
    for (status, body) in [
        (
            403,
            b"{\"code\":\"PAIR_WINDOW_CLOSED\",\"code\":\"PAIR_WINDOW_CLOSED\"}".as_slice(),
        ),
        (
            403,
            b"{\"code\":\"PAIR_WINDOW_CLOSED\",\"extra\":1}".as_slice(),
        ),
        (403, b"{\"code\":\"PRIVATE_SYNTHETIC_RESPONSE\"}".as_slice()),
        (403, b"{\"code\":7}".as_slice()),
        (403, &[0xff]),
        (403, b"[]".as_slice()),
        (500, b"PRIVATE_SYNTHETIC_RESPONSE".as_slice()),
    ] {
        let mut peer = Peer::start("normal", status, body);
        let identity = Identity::generate().unwrap();
        let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
            .await
            .unwrap();
        let error = connection.post("/native-test", b"{}").await.unwrap_err();
        assert_eq!(error, Error::InvalidResponse);
        assert_eq!(error.to_string(), "invalid transport response");
        assert_eq!(peer.stop(), 1);
    }
}
#[tokio::test]
async fn silent_http_response_reaches_the_native_deadline_and_closes_the_owned_driver() {
    let mut peer = Peer::start("silent-http", 200, b"");
    let identity = Identity::generate().unwrap();
    let connection = PinnedConnection::connect(peer.address, &identity, peer.pin)
        .await
        .unwrap();
    let began = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        connection.post("/native-test", b"{}"),
    )
    .await
    .expect("HTTP has an outer deadline");
    assert!(matches!(result, Err(Error::TimedOut)));
    assert!(began.elapsed() >= Duration::from_secs(9));
    peer.wait_for_connection_close();
    assert_eq!(peer.stop(), 1);
}
#[test]
fn exporter_metadata_is_only_the_unheld_merged_ekm_block() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../spec/vectors/pairing/proofs.json")).unwrap();
    assert_eq!(
        vectors["ekm"]["label"],
        std::str::from_utf8(draftyak_transport::tls::EKM_LABEL).unwrap()
    );
    assert_eq!(
        vectors["ekm"]["length"],
        draftyak_transport::tls::EKM_LENGTH
    );
    assert_eq!(vectors["ekm"]["contextBytes"], CONTEXT.len());
}
#[tokio::test]
async fn tls_features_provider_and_shared_config_never_resume_even_with_tickets() {
    use rcgen::{CertificateParams, KeyPair, PKCS_ECDSA_P256_SHA256};
    use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
    use rustls::{HandshakeKind, ProtocolVersion, ServerConfig};
    assert_eq!(
        rustls::ALL_VERSIONS
            .iter()
            .map(|v| v.version)
            .collect::<Vec<_>>(),
        [ProtocolVersion::TLSv1_3]
    );
    assert!(rustls::crypto::CryptoProvider::get_default().is_none());
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let certificate = CertificateParams::new(vec!["hub.draftyak.invalid".to_owned()])
        .unwrap()
        .self_signed(&key)
        .unwrap();
    let pin = draftyak_transport::tls::certificate_spki_hash(certificate.der()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut server = ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
    server.send_tls13_tickets = 2;
    let server = Arc::new(server);
    let client = Arc::new(Identity::generate().unwrap().client_config(pin).unwrap());
    tokio::time::timeout(Duration::from_secs(10), async {
        for _ in 0..2 {
            let (near, far) = tokio::io::duplex(64 * 1024);
            let acceptor = tokio_rustls::TlsAcceptor::from(server.clone());
            let hub = tokio::spawn(async move {
                let mut stream = acceptor.accept(far).await.unwrap();
                stream.write_all(b"ok").await.unwrap();
                stream.flush().await.unwrap();
            });
            let mut stream = tokio_rustls::TlsConnector::from(client.clone())
                .connect(ServerName::try_from("hub.draftyak.invalid").unwrap(), near)
                .await
                .unwrap();
            let mut reply = [0; 2];
            stream.read_exact(&mut reply).await.unwrap();
            assert_eq!(&reply, b"ok");
            let connection = stream.get_ref().1;
            assert_eq!(
                connection.protocol_version(),
                Some(ProtocolVersion::TLSv1_3)
            );
            assert_eq!(connection.handshake_kind(), Some(HandshakeKind::Full));
            assert!(
                connection.tls13_tickets_received() > 0,
                "the test hub must actually issue tickets"
            );
            let suite = connection.negotiated_cipher_suite().unwrap();
            assert!(
                provider
                    .cipher_suites
                    .iter()
                    .any(|candidate| candidate.tls13().is_some()
                        && candidate.suite() == suite.suite())
            );
            hub.await.unwrap();
        }
    })
    .await
    .unwrap();
    assert!(rustls::crypto::CryptoProvider::get_default().is_none());
}

#[tokio::test]
async fn canonical_native_payload_selects_the_real_pinned_address_and_refuses_an_invalid_index() {
    let mut peer = Peer::start("normal", 200, b"opaque");
    let identity = Identity::generate().unwrap();
    let value = serde_json::json!({"hid":hex(&peer.pin),"addr":[peer.address.to_string()],
        "pid":draftyak_protocol::sign::base64url_encode(&CONTEXT),"sec":draftyak_protocol::sign::base64url_encode(&[0;16]),
        "exp":1000,"name":"Synthetic hub","role":"device"});
    let canonical = draftyak_protocol::jcs::canonicalize(&value).unwrap();
    let text = format!(
        "draftyak-pair:v1:{}",
        draftyak_protocol::sign::base64url_encode(canonical.as_bytes())
    );
    let payload = draftyak_transport::payload::Payload::decode(&text, 1000).unwrap();
    assert_eq!(payload.exporter_context(), CONTEXT);
    assert!(matches!(
        PinnedConnection::connect_for_pairing(&payload, 1, &identity).await,
        Err(Error::InvalidInput)
    ));
    let connection = PinnedConnection::connect_for_pairing(&payload, 0, &identity)
        .await
        .unwrap();
    assert!(
        connection
            .post("/native-test", b"{}")
            .await
            .unwrap()
            .as_bytes()
            == b"opaque"
    );
    peer.wait_for_connection_close();
    assert_eq!(peer.stop(), 1);
    assert!(matches!(
        draftyak_transport::payload::Payload::decode(&text, 1001),
        Err(draftyak_transport::CodecError::Expired)
    ));
}
