use draftyak_protocol::{jcs, sign};
use draftyak_transport::payload::{Payload, hub_id};
use serde::Serialize;
use zeroize::Zeroizing;

#[cfg(feature = "mock-store")]
#[path = "support/sas_peer.rs"]
mod sas_peer;

#[test]
fn decoded_hub_preview_contains_only_bounded_public_display_values() {
    #[derive(Serialize)]
    struct Wire<'a> {
        hid: String,
        addr: [&'static str; 1],
        pid: String,
        sec: &'a str,
        exp: u64,
        name: &'static str,
        role: &'static str,
    }
    let pin = [8_u8; 32];
    let sec = Zeroizing::new(sign::base64url_encode(&[7; 16]));
    let wire = Wire {
        hid: pin.iter().map(|byte| format!("{byte:02x}")).collect(),
        addr: ["127.0.0.1:1"],
        pid: sign::base64url_encode(&[9; 16]),
        sec: &sec,
        exp: 10000,
        name: "Fixture hub",
        role: "device",
    };
    let json = Zeroizing::new(jcs::canonicalize(&wire).expect("native preview fixture JSON"));
    let code = Zeroizing::new(format!(
        "{}{}",
        draftyak_transport::payload::PREFIX,
        sign::base64url_encode(json.as_bytes())
    ));
    let payload = Payload::decode(&code, 1000).expect("actual native pairing payload codec");
    let preview = payload.preview();
    assert!(
        preview.name == "Fixture hub",
        "public preview retains the bounded hub name"
    );
    assert!(
        preview.hub_id == hub_id(&pin),
        "public preview exposes the display fingerprint"
    );
    assert!(
        preview.expires_at_ms == 10000,
        "public preview exposes expiry without protocol secrets"
    );
}

#[cfg(feature = "mock-store")]
mod native_exchange {
    use super::*;
    use draftyak_transport::{
        Error, RefusalCode,
        key_store::{StoredIdentity, testing::TestStore},
        pairing::{AcceptedClaim, PairingAttempt},
        websocket::{Timeouts, WebSocketConnection, WebSocketMessage},
    };
    use sas_peer::{Counts, Event, Mode, NOW_MS, Peer, hex};
    use std::time::{Duration, Instant};

    const PROFILE: &str = "dytest-sas-exchange";
    const DEVICE: &str = "Stored SAS device";

    fn identity(backend: &TestStore, peer: &Peer) -> StoredIdentity {
        {
            let store = backend
                .open(PROFILE)
                .expect("explicit test-only identity store");
            let created = store
                .create_identity(peer.pin)
                .expect("persist synthetic native identity");
            assert!(
                created.hub_pin() == peer.pin,
                "stored fixture pin is unchanged"
            );
        }
        backend
            .open(PROFILE)
            .expect("reopened test-only store")
            .load_identity()
            .expect("reload persisted fixture identity")
    }

    fn observed_identity(row: &Event, identity: &StoredIdentity) {
        assert!(
            row.version.as_deref() == Some("TLSv1.3"),
            "actual native TLS 1.3 connection"
        );
        assert!(
            row.client_pin.as_deref() == Some(hex(&identity.transport_spki_hash()).as_str()),
            "actual client certificate uses the persisted transport SPKI"
        );
    }

    async fn accepted(
        peer: &Peer,
        identity: &StoredIdentity,
        payload: &Payload,
    ) -> (AcceptedClaim, u64) {
        let attempt = PairingAttempt::connect(identity, payload, 0, DEVICE, NOW_MS)
            .await
            .expect("actual pinned native pairing attempt");
        let tls = peer.next("tls").await;
        observed_identity(&tls, identity);
        let claim = attempt
            .claim()
            .await
            .expect("actual Node verifier accepts the stored identity claim");
        let held = peer.next("claim").await;
        assert!(
            held.id() == tls.id() && held.code.as_deref() == Some("accepted"),
            "claim holds on its original actual TLS connection"
        );
        (claim, tls.id())
    }

    fn counts(
        peer: &mut Peer,
        tcp: u64,
        claims: u64,
        reveals: u64,
        http: u64,
        ws: u64,
        frames: u64,
    ) {
        let actual: Counts = peer.stop();
        assert!(
            actual.tcp == tcp && actual.tls == tcp,
            "fixture directly counts actual TCP and TLS connections"
        );
        assert!(
            actual.claims == claims && actual.reveals == reveals,
            "fixture counts exactly the claim and reveal requests"
        );
        assert!(
            actual.http == http && actual.websockets == ws,
            "fixture observes actual HTTP and WS reconnects"
        );
        assert!(
            actual.frames == frames,
            "fixture observes the bounded WS data and close frames"
        );
    }

    #[tokio::test]
    async fn actual_claim_reveal_sas_then_discard_reload_and_mtls_http_websocket_reconnect() {
        let mut peer = Peer::start(Mode::Normal);
        let backend = TestStore::new();
        let (transport_pin, signing_spki) = {
            let identity = identity(&backend, &peer);
            let payload = peer.payload(20000);
            let expected_preview = payload.preview();
            let (claim, connection) = accepted(&peer, &identity, &payload).await;
            let preview = claim
                .reveal()
                .await
                .expect("actual Node verifier accepts native reveal");
            let reveal = peer.next("reveal").await;
            assert!(
                reveal.id() == connection
                    && reveal.code.as_deref() == Some("accepted")
                    && reveal.original_valid == Some(true)
                    && reveal.changed_nonce == Some(false),
                "one reveal opens the held commitment on its original connection"
            );
            assert!(
                preview.sas() == reveal.expected_sas(),
                "native SAS equals the private actual Node reference"
            );
            assert!(
                preview.sas().len() == 6 && preview.sas().bytes().all(|byte| byte.is_ascii_digit()),
                "native SAS has six decimal digits"
            );
            assert!(
                preview.preview() == &expected_preview,
                "SAS API returns only the decoded public hub preview"
            );
            assert!(
                preview.device_id() == "01ARZ3NDEKTSV4RRFFQ69G5FAV" && preview.epoch() == 7,
                "SAS result identifies a pending candidate only"
            );
            let debug = Zeroizing::new(format!("{preview:?}"));
            assert!(
                debug.as_str() == "SasPreview([redacted])",
                "native SAS debug output is fixed and redacted"
            );
            peer.wait_for_close(connection).await;
            (
                identity.transport_spki_hash(),
                identity.signing_public_key(),
            )
        };
        // All prior identity, attempt, accepted result, SAS, payload and private
        // reference values have left scope. Only persisted keys and public pins remain.
        let reloaded = backend
            .open(PROFILE)
            .expect("fresh native store handle")
            .load_identity()
            .expect("reload after the completed exchange is discarded");
        assert!(
            reloaded.transport_spki_hash() == transport_pin
                && reloaded.signing_public_key() == signing_spki,
            "both persisted keys survive complete in-memory identity discard"
        );
        assert!(
            reloaded.hub_pin() == peer.pin,
            "reloaded identity retains the original hub pin"
        );
        let http_connection = reloaded
            .connect(peer.address)
            .await
            .expect("stored identity HTTP reconnect");
        let http_tls = peer.next("tls").await;
        observed_identity(&http_tls, &reloaded);
        let response = http_connection
            .post("/native/reconnect", b"{}")
            .await
            .expect("actual native mTLS HTTP reconnect");
        assert!(
            response.as_bytes() == b"{}",
            "HTTP reconnect returns only opaque fixture bytes"
        );
        let http = peer.next("http").await;
        assert!(
            http.id() == http_tls.id(),
            "HTTP reconnect uses the reloaded certificate connection"
        );
        drop(response);
        peer.wait_for_close(http_tls.id()).await;
        let ws_connection = reloaded
            .connect(peer.address)
            .await
            .expect("stored identity WebSocket reconnect");
        let ws_tls = peer.next("tls").await;
        observed_identity(&ws_tls, &reloaded);
        let mut websocket = WebSocketConnection::upgrade(
            ws_connection,
            "/native/reconnect-ws",
            None,
            Timeouts {
                upgrade: Duration::from_secs(3),
                read: Duration::from_secs(3),
                write: Duration::from_secs(3),
                close: Duration::from_secs(1),
            },
        )
        .await
        .expect("actual native mTLS WebSocket upgrade");
        let upgraded = peer.next("websocket").await;
        assert!(
            upgraded.id() == ws_tls.id(),
            "WebSocket upgrade uses the reloaded certificate connection"
        );
        websocket
            .send_text("native reconnect")
            .await
            .expect("actual WebSocket fixture data send");
        let message = websocket
            .receive()
            .await
            .expect("actual WebSocket fixture data receive");
        assert!(
            matches!(message, Some(WebSocketMessage::Text(value)) if value == "native reconnect"),
            "mTLS WebSocket reconnect exchanges the bounded opaque fixture message"
        );
        websocket
            .close()
            .await
            .expect("actual WebSocket close handshake");
        peer.wait_for_close(ws_tls.id()).await;
        drop(reloaded);
        counts(&mut peer, 3, 1, 1, 1, 1, 2);
        backend
            .remove_record(PROFILE)
            .expect("remove only the explicit test-only identity");
    }

    #[tokio::test]
    async fn explicit_zero_content_length_is_an_empty_successful_reveal() {
        let mut peer = Peer::start(Mode::EmptyLength);
        let backend = TestStore::new();
        let identity = identity(&backend, &peer);
        let payload = peer.payload(20000);
        let (claim, connection) = accepted(&peer, &identity, &payload).await;
        let preview = claim
            .reveal()
            .await
            .expect("204 with explicit zero content length is empty");
        let reveal = peer.next("reveal").await;
        assert!(
            preview.sas() == reveal.expected_sas(),
            "explicit empty response retains local SAS computation"
        );
        peer.wait_for_close(connection).await;
        drop(preview);
        counts(&mut peer, 1, 1, 1, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the explicit test-only identity");
    }

    #[tokio::test]
    async fn a_different_nonce_fails_commitment_independently_of_claim_proof_and_certificate() {
        let mut peer = Peer::start(Mode::WrongNonce);
        let backend = TestStore::new();
        let identity = identity(&backend, &peer);
        let payload = peer.payload(20000);
        let (claim, connection) = accepted(&peer, &identity, &payload).await;
        assert!(
            matches!(
                claim.reveal().await,
                Err(Error::Refused(RefusalCode::CommitmentMismatch))
            ),
            "a reveal that does not open the held commitment is refused"
        );
        let reveal = peer.next("reveal").await;
        assert!(
            reveal.id() == connection
                && reveal.original_valid == Some(true)
                && reveal.changed_nonce == Some(true)
                && reveal.code.as_deref() == Some("PAIR_COMMITMENT_MISMATCH"),
            "actual Node verifier isolates the changed nonce after an otherwise valid claim"
        );
        peer.wait_for_close(connection).await;
        counts(&mut peer, 1, 1, 1, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the explicit test-only identity");
    }

    #[tokio::test]
    async fn malformed_reveal_answers_never_return_a_sas_and_close_the_actual_connection() {
        for mode in [
            Mode::InvalidStatus,
            Mode::DuplicateRefusal,
            Mode::OversizedRefusal,
            Mode::ClaimRefusal,
            Mode::SasRefusal,
        ] {
            let mut peer = Peer::start(mode);
            let backend = TestStore::new();
            let identity = identity(&backend, &peer);
            let payload = peer.payload(20000);
            let (claim, connection) = accepted(&peer, &identity, &payload).await;
            assert!(
                matches!(claim.reveal().await, Err(Error::InvalidResponse)),
                "malformed, over-cap, wrong-phase or extra-SAS answer cannot return a SAS"
            );
            let reveal = peer.next("reveal").await;
            assert!(
                reveal.id() == connection && reveal.code.as_deref() == Some("accepted"),
                "wire answer refusal follows an actually valid reveal"
            );
            peer.wait_for_close(connection).await;
            counts(&mut peer, 1, 1, 1, 0, 0, 0);
            backend
                .remove_record(PROFILE)
                .expect("remove only the explicit test-only identity");
        }
    }

    #[tokio::test]
    async fn declared_nonempty_or_transfer_encoded_204_never_becomes_a_successful_sas() {
        for mode in [Mode::Nonempty204, Mode::Transfer204] {
            let mut peer = Peer::start(mode);
            let backend = TestStore::new();
            let identity = identity(&backend, &peer);
            let payload = peer.payload(20000);
            let (claim, connection) = accepted(&peer, &identity, &payload).await;
            assert!(
                matches!(
                    claim.reveal().await,
                    Err(Error::InvalidResponse | Error::ConnectionFailed)
                ),
                "invalid 204 framing refuses without returning a SAS"
            );
            let reveal = peer.next("reveal").await;
            assert!(
                reveal.code.as_deref() == Some("accepted"),
                "framing fault follows a valid reveal"
            );
            peer.wait_for_close(connection).await;
            counts(&mut peer, 1, 1, 1, 0, 0, 0);
            backend
                .remove_record(PROFILE)
                .expect("remove only the explicit test-only identity");
        }
    }

    #[tokio::test]
    async fn reveal_refusals_remain_typed_but_are_invalid_during_the_claim_phase() {
        for (mode, expected) in [
            (Mode::WindowClosed, RefusalCode::WindowClosed),
            (Mode::RevealInvalid, RefusalCode::RevealInvalid),
        ] {
            let mut peer = Peer::start(mode);
            let backend = TestStore::new();
            let identity = identity(&backend, &peer);
            let payload = peer.payload(20000);
            let (claim, connection) = accepted(&peer, &identity, &payload).await;
            assert!(
                matches!(claim.reveal().await, Err(Error::Refused(code)) if code == expected),
                "valid reveal refusal code remains a typed failure without a SAS"
            );
            let _ = peer.next("reveal").await;
            peer.wait_for_close(connection).await;
            counts(&mut peer, 1, 1, 1, 0, 0, 0);
            backend
                .remove_record(PROFILE)
                .expect("remove only the explicit test-only identity");
        }
        let mut peer = Peer::start(Mode::ClaimRevealRefusal);
        let backend = TestStore::new();
        let identity = identity(&backend, &peer);
        let payload = peer.payload(20000);
        let attempt = PairingAttempt::connect(&identity, &payload, 0, DEVICE, NOW_MS)
            .await
            .expect("claim refusal fixture establishes pinned TLS");
        let tls = peer.next("tls").await;
        assert!(
            matches!(attempt.claim().await, Err(Error::InvalidResponse)),
            "widened shared decoder does not admit reveal-only refusal during claim"
        );
        let _ = peer.next("claim").await;
        peer.wait_for_close(tls.id()).await;
        counts(&mut peer, 1, 1, 0, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the explicit test-only identity");
    }

    #[tokio::test]
    async fn original_claim_deadline_expires_before_reveal_without_a_new_request() {
        const WINDOW_MS: u64 = 5000;
        const CLAIM_DELAY_LOWER_MS: u64 = 2900;
        let mut peer = Peer::start(Mode::DelayedClaim);
        let backend = TestStore::new();
        let identity = identity(&backend, &peer);
        let payload = peer.payload(WINDOW_MS);
        let attempt_started = Instant::now();
        let (claim, connection) = accepted(&peer, &identity, &payload).await;
        let answer = peer.next("claim-answer").await;
        assert!(
            answer.id() == connection
                && answer
                    .claim_delay_ms
                    .is_some_and(|delay| delay >= CLAIM_DELAY_LOWER_MS),
            "actual claim answer consumed the measured first part of the original window"
        );
        let held = Instant::now();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let held_for = held.elapsed();
        let total = attempt_started.elapsed();
        assert!(
            held_for >= Duration::from_millis(2400) && held_for < Duration::from_millis(WINDOW_MS),
            "accepted state is held for less than a fresh complete pairing window"
        );
        assert!(
            total > Duration::from_millis(WINDOW_MS),
            "actual claim delay plus accepted hold exceeds the original window"
        );
        // A reset could occur only after the measured claim delay. This upper
        // bound ensures such a reset would still have time left, so it cannot
        // accidentally satisfy the expected original-clock refusal.
        assert!(
            total < Duration::from_millis(CLAIM_DELAY_LOWER_MS + WINDOW_MS),
            "a reset-at-acceptance clock would still be inside its fresh window"
        );
        assert!(
            matches!(claim.reveal().await, Err(Error::InvalidInput)),
            "reveal retains the original claim deadline instead of starting a new window"
        );
        peer.wait_for_close(connection).await;
        counts(&mut peer, 1, 1, 0, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the explicit test-only identity");
    }

    #[tokio::test]
    async fn valid_reveal_answer_after_original_deadline_refuses_without_a_sas() {
        let mut peer = Peer::start(Mode::DelayedValid);
        let backend = TestStore::new();
        let identity = identity(&backend, &peer);
        let payload = peer.payload(3000);
        let (claim, connection) = accepted(&peer, &identity, &payload).await;
        let sent = Instant::now();
        assert!(
            matches!(claim.reveal().await, Err(Error::InvalidInput)),
            "valid reveal answer arriving after the original deadline returns no SAS"
        );
        assert!(
            sent.elapsed() >= Duration::from_millis(4000),
            "valid answer crossed the original expiry margin"
        );
        let reveal = peer.next("reveal").await;
        assert!(
            reveal.id() == connection && reveal.code.as_deref() == Some("accepted"),
            "actual reveal was accepted before its valid answer was delayed"
        );
        peer.wait_for_close(connection).await;
        counts(&mut peer, 1, 1, 1, 0, 0, 0);
        backend
            .remove_record(PROFILE)
            .expect("remove only the explicit test-only identity");
    }
}
