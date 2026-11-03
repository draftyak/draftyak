use draftyak_protocol::{jcs, sign};
use rcgen::{KeyPair, PKCS_ECDSA_P256_SHA256, PublicKeyData};
use serde_json::Value;

#[path = "support/pairing_peer.rs"]
mod pairing_peer;
use pairing_peer::{Peer, hex};

fn assert_stopped(peer: &mut Peer, requests: u64, tcp: u64, tls: u64) {
    let summary = peer.stop();
    assert!(
        summary.requests == requests,
        "fixture observes the expected claim request count"
    );
    assert!(
        summary.tcp_connections == tcp,
        "fixture directly counts actual TCP connections"
    );
    assert!(
        summary.tls_connections == tls,
        "fixture directly counts completed TLS connections"
    );
}

fn native_claim(body: &[u8], transport: &[u8; 32], signing: &[u8]) -> Value {
    assert!(body.len() <= 4096, "claim received-byte bound");
    let value = jcs::parse_strict(body).expect("actual Node/native wire is strict JSON");
    let object = value.as_object().expect("claim is an object");
    assert!(object.len() == 7, "claim has exactly the merged members");
    for key in [
        "pid",
        "role",
        "name",
        "transportSpkiSha256",
        "signingKey",
        "c",
        "proof",
    ] {
        assert!(
            object.contains_key(key),
            "claim contains each merged member"
        );
    }
    assert!(value["role"] == "device", "claim has the device role");
    assert!(
        value["name"] == "Stored pairing device",
        "claim name survives both implementations"
    );
    assert!(
        value["transportSpkiSha256"] == hex(transport),
        "claim names the stored transport key"
    );
    assert!(
        value["signingKey"] == sign::base64url_encode(signing),
        "claim names the stored signing key"
    );
    assert!(
        sign::verifying_key_from_spki(signing).is_ok(),
        "native protocol accepts the signing SPKI"
    );
    for key in ["c", "proof"] {
        let text = value[key]
            .as_str()
            .expect("merged claim hexadecimal member");
        assert!(
            text.len() == 64
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "claim uses canonical SHA-256 hexadecimal"
        );
    }
    let canonical = jcs::canonicalize(&value).expect("native claim canonicalization");
    let reloaded = jcs::parse_strict(canonical.as_bytes()).expect("native canonical claim parses");
    assert!(
        value == reloaded,
        "Node wire survives the native canonical round trip"
    );
    value
}

#[test]
fn native_strict_json_consumes_actual_node_constructor_wire() {
    let mut peer = Peer::start();
    let signing = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).expect("fixture signing key");
    let pin = peer.pin;
    let oracle = peer.oracle(None, &pin, &signing.subject_public_key_info());
    assert!(
        oracle.proof_valid == Some(true),
        "actual Node constructor supplies a valid proof"
    );
    let body = oracle.body();
    native_claim(&body, &pin, &signing.subject_public_key_info());
    assert_stopped(&mut peer, 0, 0, 0);
}

#[cfg(not(feature = "native-store"))]
#[test]
fn default_store_refuses_without_a_volatile_pairing_identity() {
    assert!(
        matches!(
            draftyak_transport::key_store::NativeStore::open("dytest-pairing-unavailable"),
            Err(draftyak_transport::key_store::StoreError::Unavailable)
        ),
        "pairing has no feature-off store fallback"
    );
}

#[cfg(feature = "mock-store")]
mod stored_identity {
    use super::*;
    use draftyak_transport::{
        Error, RefusalCode,
        key_store::{StoredIdentity, testing::TestStore},
        pairing::PairingAttempt,
    };
    use pairing_peer::{NOW_MS, ReplyMode};
    use std::time::{Duration, Instant};
    use zeroize::Zeroizing;

    const PROFILE: &str = "dytest-pairing-claim";

    fn reloaded_identity(peer: &Peer) -> (TestStore, StoredIdentity) {
        reloaded_identity_with_pin(peer.pin)
    }

    fn reloaded_identity_with_pin(pin: [u8; 32]) -> (TestStore, StoredIdentity) {
        let backend = TestStore::new();
        let (transport, signing) = {
            let store = backend.open(PROFILE).expect("explicit test-only store");
            let identity = store
                .create_identity(pin)
                .expect("persisted fixture identity");
            (
                identity.transport_spki_hash(),
                identity.signing_public_key(),
            )
        };
        // Both the creation handle and the original identity have been dropped.
        let identity = backend
            .open(PROFILE)
            .expect("reopened test-only store")
            .load_identity()
            .expect("reload persisted fixture identity");
        assert!(
            identity.transport_spki_hash() == transport,
            "transport key survives reload"
        );
        assert!(
            identity.signing_public_key() == signing,
            "signing key survives reload"
        );
        assert!(identity.hub_pin() == pin, "stored hub pin survives reload");
        (backend, identity)
    }

    #[tokio::test]
    async fn node_accepts_reloaded_identity_then_refuses_same_certificate_proof_replay() {
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload();
        let attempt =
            PairingAttempt::connect(&identity, &payload, 0, "Stored pairing device", NOW_MS)
                .await
                .expect("native attempt connects to the pinned fixture");
        let first_tls = peer.next_kind("tls");
        assert!(
            first_tls.version.as_deref() == Some("TLSv1.3"),
            "actual TLS 1.3 connection"
        );
        assert!(
            first_tls.client_pin.as_deref() == Some(hex(&identity.transport_spki_hash()).as_str()),
            "actual client certificate uses the reloaded transport key"
        );
        let accepted = attempt
            .claim()
            .await
            .expect("actual Node verifier accepts native claim");
        assert!(
            accepted.device_id() == "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "native result reads the device id"
        );
        assert!(accepted.epoch() == 7, "native result reads the epoch");
        let first_claim = peer.next_kind("claim");
        assert!(
            first_claim.code.as_deref() == Some("accepted")
                && first_claim.proof_valid == Some(true)
                && first_claim.client_matches == Some(true),
            "merged Node reader and verifier accept the stored native claim"
        );
        let first_connection = first_tls
            .connection
            .expect("original fixture TLS connection id");
        assert!(
            peer.connection_is_active(first_connection).await,
            "accepted claim retains its original live TLS channel"
        );
        let body = first_claim.body();
        let rust = native_claim(
            &body,
            &identity.transport_spki_hash(),
            &identity.signing_public_key(),
        );
        let reference = first_claim.reference();
        let node = native_claim(
            &reference,
            &identity.transport_spki_hash(),
            &identity.signing_public_key(),
        );
        for key in ["pid", "role", "name", "transportSpkiSha256", "signingKey"] {
            assert!(
                rust[key] == node[key],
                "Node/native claims agree on public identity and window fields"
            );
        }

        let replay_connection = identity
            .connect(peer.address)
            .await
            .expect("second pinned connection");
        let second_ekm = replay_connection
            .pairing_ekm(&payload.exporter_context())
            .expect("second connection native exporter");
        let second_tls = peer.next_kind("tls");
        let second_ekm_hex = Zeroizing::new(hex(&*second_ekm));
        assert!(
            second_tls.ekm.as_deref() == Some(second_ekm_hex.as_str()),
            "Node/native exporters agree"
        );
        assert!(
            first_tls.certificate.is_some() && first_tls.certificate == second_tls.certificate,
            "replay presents exactly the same client certificate"
        );
        assert!(
            first_tls.client_pin == second_tls.client_pin,
            "replay retains the client SPKI"
        );
        assert!(
            first_tls.ekm.is_some() && first_tls.ekm != second_tls.ekm,
            "only a fresh TLS exporter changes the proof binding"
        );
        assert!(
            matches!(
                replay_connection.post("/pair/v1/claim", &body).await,
                Err(Error::Refused(RefusalCode::ProofInvalid))
            ),
            "same-certificate replay gets PAIR_PROOF_INVALID"
        );
        let replay = peer.next_kind("claim");
        assert!(
            replay.code.as_deref() == Some("PAIR_PROOF_INVALID")
                && replay.client_matches == Some(true)
                && replay.proof_valid == Some(false),
            "replay fails the EKM proof while the certificate still matches"
        );
        drop(accepted);
        peer.wait_for_tls_close(first_connection).await;
        assert_stopped(&mut peer, 2, 2, 2);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn node_refuses_wrong_declared_transport_key_with_an_independently_valid_proof() {
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload();
        let connection = identity
            .connect(peer.address)
            .await
            .expect("actual stored-certificate connection");
        let ekm = connection
            .pairing_ekm(&payload.exporter_context())
            .expect("actual native exporter");
        let tls = peer.next_kind("tls");
        let native_ekm_hex = Zeroizing::new(hex(&*ekm));
        assert!(
            tls.ekm.as_deref() == Some(native_ekm_hex.as_str()),
            "Node/native exporters agree"
        );
        assert!(
            tls.client_pin.as_deref() == Some(hex(&identity.transport_spki_hash()).as_str()),
            "fixture observes the stored client certificate"
        );
        let mut other_transport = identity.transport_spki_hash();
        other_transport[0] ^= 1;
        let oracle = peer.oracle(
            Some(tls.connection.expect("actual fixture connection id")),
            &other_transport,
            &identity.signing_public_key(),
        );
        assert!(
            oracle.proof_valid == Some(true) && oracle.client_matches == Some(false),
            "actual Node factory signs the mismatched declaration with this connection EKM"
        );
        let body = oracle.body();
        native_claim(&body, &other_transport, &identity.signing_public_key());
        assert!(
            matches!(
                connection.post("/pair/v1/claim", &body).await,
                Err(Error::Refused(RefusalCode::ProofInvalid))
            ),
            "transport mismatch gets PAIR_PROOF_INVALID"
        );
        let refused = peer.next_kind("claim");
        assert!(
            refused.code.as_deref() == Some("PAIR_PROOF_INVALID")
                && refused.proof_valid == Some(true)
                && refused.client_matches == Some(false),
            "certificate mismatch is refused independently of a valid proof"
        );
        assert_stopped(&mut peer, 1, 1, 1);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn stored_identity_connector_refuses_wrong_persisted_pin_before_any_tls() {
        let mut peer = Peer::start();
        let mut wrong_pin = peer.pin;
        wrong_pin[0] ^= 1;
        let (backend, identity) = reloaded_identity_with_pin(wrong_pin);
        let payload = peer.payload();
        assert!(
            matches!(
                identity.connect_for_pairing(&payload, 0).await,
                Err(Error::InvalidInput)
            ),
            "stored identity wrapper itself refuses a different payload pin"
        );
        assert_stopped(&mut peer, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn stored_identity_connector_delegates_invalid_address_index_without_tls() {
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload();
        assert!(
            matches!(
                identity.connect_for_pairing(&payload, 1).await,
                Err(Error::InvalidInput)
            ),
            "real connector refuses an index outside the decoded payload"
        );
        assert_stopped(&mut peer, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn stored_identity_connector_preserves_a_valid_localhost_payload_address() {
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.localhost_payload();
        let connection = identity
            .connect_for_pairing(&payload, 0)
            .await
            .expect("stored connector uses the decoded localhost address");
        let ekm = connection
            .pairing_ekm(&payload.exporter_context())
            .expect("actual DNS connection exporter");
        let tls = peer.next_kind("tls");
        let native_ekm_hex = Zeroizing::new(hex(&*ekm));
        assert!(
            tls.ekm.as_deref() == Some(native_ekm_hex.as_str()),
            "localhost TLS exporters agree"
        );
        assert!(
            tls.client_pin.as_deref() == Some(hex(&identity.transport_spki_hash()).as_str()),
            "localhost connection presents the persisted client certificate"
        );
        drop(connection);
        peer.wait_for_socket_close();
        assert_stopped(&mut peer, 0, 1, 1);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn invalid_device_name_is_refused_by_the_attempt_before_any_tls() {
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload();
        assert!(
            matches!(
                PairingAttempt::connect(&identity, &payload, 0, " leading blank", NOW_MS).await,
                Err(Error::InvalidInput)
            ),
            "invalid device name is refused before connecting"
        );
        assert_stopped(&mut peer, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn duplicate_epoch_and_oversized_valid_json_answers_refuse_and_close_the_actual_socket() {
        for mode in [ReplyMode::DuplicateEpoch, ReplyMode::OversizedJson] {
            let mut peer = Peer::start_with_reply(mode);
            let (backend, identity) = reloaded_identity(&peer);
            let payload = peer.payload();
            let attempt =
                PairingAttempt::connect(&identity, &payload, 0, "Stored pairing device", NOW_MS)
                    .await
                    .expect("bad-answer fixture connects with the stored identity");
            let tls = peer.next_kind("tls");
            assert!(
                tls.version.as_deref() == Some("TLSv1.3"),
                "bad answer follows a real TLS connection"
            );
            assert!(
                matches!(attempt.claim().await, Err(Error::InvalidResponse)),
                "duplicate or over-cap answer is refused as an invalid response"
            );
            let claim = peer.next_kind("claim");
            assert!(
                claim.code.as_deref() == Some("accepted") && claim.proof_valid == Some(true),
                "answer refusal follows an otherwise valid actual claim"
            );
            // Observe native cleanup before stopping the server; fixture stop
            // must not create the close event that proves error-path cleanup.
            peer.wait_for_socket_close();
            assert_stopped(&mut peer, 1, 1, 1);
            backend
                .remove_record(PROFILE)
                .expect("remove only the test-only identity");
        }
    }

    #[tokio::test]
    async fn already_expired_payload_refuses_before_any_tcp_or_tls_connection() {
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload_with_remaining(3000);
        let expired_now = payload.expires_at_ms() + 1;
        assert!(
            matches!(
                PairingAttempt::connect(
                    &identity,
                    &payload,
                    0,
                    "Stored pairing device",
                    expired_now
                )
                .await,
                Err(Error::InvalidInput)
            ),
            "already expired native payload refuses before connecting"
        );
        assert_stopped(&mut peer, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn held_attempt_expires_before_sending_any_http_and_closes_its_tls_connection() {
        const WINDOW_MS: u64 = 3000;
        let mut peer = Peer::start();
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload_with_remaining(WINDOW_MS);
        let setup_started = Instant::now();
        let attempt =
            PairingAttempt::connect(&identity, &payload, 0, "Stored pairing device", NOW_MS)
                .await
                .expect("held attempt establishes actual pinned TLS");
        let tls = peer.next_kind("tls");
        assert!(
            setup_started.elapsed() < Duration::from_millis(1000),
            "fixture setup leaves measured headroom in the explicit expiry window"
        );
        let held = Instant::now();
        // The production attempt starts its monotonic clock before connect.
        // Waiting this full duration after connect leaves an explicit margin.
        tokio::time::sleep(Duration::from_millis(WINDOW_MS + 500)).await;
        assert!(
            held.elapsed() >= Duration::from_millis(WINDOW_MS + 400),
            "held attempt is measured beyond its expiry margin"
        );
        assert!(
            matches!(attempt.claim().await, Err(Error::InvalidInput)),
            "expired held attempt refuses before sending its claim"
        );
        peer.wait_for_tls_close(tls.connection.expect("held attempt TLS connection id"))
            .await;
        assert_stopped(&mut peer, 0, 1, 1);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }

    #[tokio::test]
    async fn otherwise_valid_answer_arriving_after_expiry_refuses_and_closes_its_tls_connection() {
        const WINDOW_MS: u64 = 3000;
        let mut peer = Peer::start_with_reply(ReplyMode::DelayedValid);
        let (backend, identity) = reloaded_identity(&peer);
        let payload = peer.payload_with_remaining(WINDOW_MS);
        let setup_started = Instant::now();
        let attempt =
            PairingAttempt::connect(&identity, &payload, 0, "Stored pairing device", NOW_MS)
                .await
                .expect("delayed answer establishes actual pinned TLS");
        let tls = peer.next_kind("tls");
        assert!(
            setup_started.elapsed() < Duration::from_millis(1000),
            "fixture setup leaves measured headroom before sending the claim"
        );
        let sent = Instant::now();
        assert!(
            matches!(attempt.claim().await, Err(Error::InvalidInput)),
            "otherwise valid answer arriving after expiry is refused"
        );
        assert!(
            sent.elapsed() >= Duration::from_millis(WINDOW_MS + 1000),
            "answer receipt crosses the explicit expiry margin"
        );
        let claim = peer.next_kind("claim");
        assert!(
            claim.code.as_deref() == Some("accepted") && claim.proof_valid == Some(true),
            "actual Node verifier accepted the claim before delaying its valid answer"
        );
        peer.wait_for_tls_close(tls.connection.expect("delayed answer TLS connection id"))
            .await;
        assert_stopped(&mut peer, 1, 1, 1);
        backend
            .remove_record(PROFILE)
            .expect("remove only the test-only identity");
    }
}
