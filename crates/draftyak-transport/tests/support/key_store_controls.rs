#[path = "key-store-peer.rs"]
pub(super) mod peer;

use draftyak_protocol::{jcs, sign};
use draftyak_transport::{
    Error,
    key_store::{StoreError, testing::TestStore},
    websocket::{Timeouts, WebSocketConnection, WebSocketError, WebSocketMessage},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};
use zeroize::Zeroizing;

static NEXT_PROFILE: AtomicU32 = AtomicU32::new(0);

fn profile() -> String {
    format!(
        "dytest-store-{}",
        NEXT_PROFILE.fetch_add(1, Ordering::Relaxed)
    )
}

fn saved_record(backend: &TestStore, profile: &str) -> Zeroizing<Vec<u8>> {
    backend
        .record(profile)
        .unwrap()
        .expect("synthetic identity exists")
}

fn canonical_record(value: &Value) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(jcs::canonicalize(value).unwrap().into_bytes())
}

#[tokio::test]
async fn reloaded_transport_key_is_used_by_real_http_and_websocket_clients() {
    tokio::time::timeout(Duration::from_secs(35), async {
        let backend = TestStore::new();
        let profile = profile();
        let plan = peer::Plan::new();
        let pin = plan.pin();
        let store = backend.open(&profile).unwrap();
        let original = store.create_identity(pin).unwrap();
        let transport = original.transport_spki_hash();
        let signing = original.signing_public_key();
        let signing_hash: [u8; 32] = Sha256::digest(signing).into();
        assert!(
            transport != signing_hash,
            "persisted transport and signing keys are independent"
        );
        assert!(original.hub_pin() == pin, "initial hub pin is retained");
        drop(original);
        drop(store);

        let mut peer = plan.start(transport);
        let reopened = backend.clone().open(&profile).unwrap();
        let reloaded = reopened.load_identity().unwrap();
        assert!(
            reloaded.transport_spki_hash() == transport,
            "transport SPKI survives reload"
        );
        assert!(
            reloaded.signing_public_key() == signing,
            "signing SPKI survives reload"
        );
        assert!(reloaded.hub_pin() == pin, "hub pin survives reload");
        let response = reloaded
            .connect(peer.address)
            .await
            .unwrap()
            .post("/stored-http", b"{}")
            .await
            .expect("reloaded stored key reaches the preseeded HTTP peer");
        assert!(
            response.as_bytes() == b"DYTEST-STORED-HTTP",
            "HTTP body remains opaque"
        );
        assert!(peer.event("accepted")["exactStoredSpki"] == true);
        peer.event("http");
        drop(response);
        drop(reloaded);
        drop(reopened);

        let reopened = backend.clone().open(&profile).unwrap();
        let reloaded = reopened.load_identity().unwrap();
        let pinned = reloaded.connect(peer.address).await.unwrap();
        let mut websocket =
            WebSocketConnection::upgrade(pinned, "/stored-ws", None, Timeouts::default())
                .await
                .expect("reloaded stored key reaches the preseeded WebSocket peer");
        let message = websocket.receive().await.unwrap();
        assert!(
            matches!(message, Some(WebSocketMessage::Text(ref text)) if text == "DYTEST-STORED-WS"),
            "WebSocket body remains opaque"
        );
        websocket.close().await.unwrap();
        assert!(peer.event("accepted")["exactStoredSpki"] == true);
        peer.event("websocket");
        drop(reloaded);
        drop(reopened);

        let unrelated_backend = TestStore::new();
        let unrelated_store = unrelated_backend.open(&profile).unwrap();
        let unrelated = unrelated_store.create_identity(pin).unwrap();
        assert!(
            unrelated.transport_spki_hash() != transport,
            "negative client has another key"
        );
        match unrelated.connect(peer.address).await {
            Ok(connection) => {
                let result = connection.post("/stored-http", b"{}").await;
                assert!(
                    matches!(
                        result,
                        Err(Error::ConnectionFailed | Error::InvalidResponse)
                    ),
                    "unrelated client cannot send an accepted HTTP request"
                );
            }
            Err(error) => assert!(
                error == Error::ConnectionFailed,
                "unrelated TLS client is refused"
            ),
        }
        peer.event("rejected");
        match unrelated.connect(peer.address).await {
            Ok(connection) => {
                let result = WebSocketConnection::upgrade(
                    connection,
                    "/stored-ws",
                    None,
                    Timeouts::default(),
                )
                .await;
                assert!(
                    matches!(
                        result,
                        Err(WebSocketError::ConnectionFailed
                            | WebSocketError::InvalidResponse
                            | WebSocketError::Closed)
                    ),
                    "unrelated client cannot upgrade WebSocket"
                );
            }
            Err(error) => assert!(
                error == Error::ConnectionFailed,
                "unrelated TLS client is refused"
            ),
        }
        peer.event("rejected");
        let summary = peer.stop();
        assert!(
            summary.connections == 4 && summary.accepted == 2 && summary.rejected == 2,
            "only the reloaded original client key is accepted"
        );
        assert!(
            summary.http == 1 && summary.websocket == 1,
            "rejected client keys reach neither application handler"
        );

        let wrong_plan = peer::Plan::new();
        assert!(wrong_plan.pin() != pin, "negative hub has a distinct SPKI");
        let mut wrong_peer = wrong_plan.start(transport);
        let stored = backend.open(&profile).unwrap().load_identity().unwrap();
        assert!(
            matches!(
                stored.connect(wrong_peer.address).await,
                Err(Error::ConnectionFailed)
            ),
            "reloaded identity refuses a hub outside its persisted pin"
        );
        let wrong_summary = wrong_peer.stop();
        assert!(
            wrong_summary.http == 0 && wrong_summary.websocket == 0,
            "a wrong hub receives no HTTP or WebSocket application bytes"
        );
    })
    .await
    .expect("bounded persisted-key transport control");
}

#[test]
fn an_existing_identity_cannot_be_recreated_or_rebound_to_another_hub_pin() {
    let backend = TestStore::new();
    let profile = profile();
    let store = backend.open(&profile).unwrap();
    let first = store.create_identity([0x23; 32]).unwrap();
    let transport = first.transport_spki_hash();
    let signing = first.signing_public_key();
    let before = saved_record(&backend, &profile);
    drop(first);
    assert!(
        matches!(
            store.create_identity([0x42; 32]),
            Err(StoreError::AlreadyExists)
        ),
        "create refuses an existing identity"
    );
    let after = saved_record(&backend, &profile);
    assert!(
        before.as_slice() == after.as_slice(),
        "refused create leaves the entire record unchanged"
    );
    let reloaded = store.load_identity().unwrap();
    assert!(
        reloaded.hub_pin() == [0x23; 32],
        "existing pin cannot be replaced"
    );
    assert!(
        reloaded.transport_spki_hash() == transport && reloaded.signing_public_key() == signing,
        "existing keys cannot be regenerated"
    );
}

#[test]
fn missing_and_read_failed_records_never_produce_a_volatile_identity() {
    let backend = TestStore::new();
    let profile = profile();
    let store = backend.open(&profile).unwrap();
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    assert!(backend.record(&profile).unwrap().is_none());
    let identity = store.create_identity([0x23; 32]).unwrap();
    let transport = identity.transport_spki_hash();
    drop(identity);
    let before = saved_record(&backend, &profile);
    backend.fail_reads(true).unwrap();
    assert!(matches!(
        store.load_identity(),
        Err(StoreError::Unavailable)
    ));
    assert!(matches!(
        store.create_identity([0x42; 32]),
        Err(StoreError::Unavailable)
    ));
    backend.fail_reads(false).unwrap();
    assert!(
        before.as_slice() == saved_record(&backend, &profile).as_slice(),
        "read failure preserves stored bytes"
    );
    assert!(store.load_identity().unwrap().transport_spki_hash() == transport);
    backend.remove_record(&profile).unwrap();
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    assert!(
        backend.record(&profile).unwrap().is_none(),
        "missing load never creates a replacement"
    );
}

#[test]
fn failed_or_corrupted_writes_never_return_a_usable_identity() {
    let backend = TestStore::new();
    let profile = profile();
    let store = backend.open(&profile).unwrap();
    backend.fail_writes(true).unwrap();
    assert!(
        matches!(
            store.create_identity([0x23; 32]),
            Err(StoreError::WriteFailed)
        ),
        "failed persistence refuses identity creation"
    );
    backend.fail_writes(false).unwrap();
    assert!(backend.record(&profile).unwrap().is_none());
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    backend.corrupt_writes(true).unwrap();
    assert!(
        matches!(
            store.create_identity([0x23; 32]),
            Err(StoreError::WriteFailed)
        ),
        "write readback must reject corrupt persistence"
    );
    backend.corrupt_writes(false).unwrap();
    assert!(
        matches!(store.load_identity(), Err(StoreError::Corrupt)),
        "corrupted stored bytes cannot become a new identity"
    );
    backend.remove_record(&profile).unwrap();
    assert!(backend.record(&profile).unwrap().is_none());
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
}

#[test]
fn stored_record_schema_and_independent_key_binding_are_checked_on_reload() {
    let backend = TestStore::new();
    let profile = profile();
    let store = backend.open(&profile).unwrap();
    drop(store.create_identity([0x23; 32]).unwrap());
    let original = saved_record(&backend, &profile);
    let baseline: Value = jcs::parse_strict(&original).unwrap();
    let mut variants = Vec::new();
    for (field, invalid) in [
        ("v", json!("1")),
        ("v", json!(2)),
        ("transportKey", json!(7)),
        ("signingKey", Value::Null),
        ("hid", json!(false)),
        ("hid", json!("DYTEST-PRIVATE-INVALID-HUB")),
    ] {
        let mut value = baseline.clone();
        value[field] = invalid;
        variants.push(value);
    }
    let mut missing = baseline.clone();
    missing.as_object_mut().unwrap().remove("transportKey");
    variants.push(missing);
    let mut unknown = baseline.clone();
    unknown["extra"] = json!("DYTEST-PRIVATE-UNEXPECTED");
    variants.push(unknown);
    let mut same_key = baseline.clone();
    same_key["signingKey"] = baseline["transportKey"].clone();
    variants.push(same_key);
    for algorithm in [&rcgen::PKCS_ECDSA_P384_SHA384, &rcgen::PKCS_ED25519] {
        let other = rcgen::KeyPair::generate_for(algorithm).unwrap();
        let encoded = json!(sign::base64url_encode(&other.serialize_der()));
        for field in ["transportKey", "signingKey"] {
            let mut value = baseline.clone();
            value[field] = encoded.clone();
            variants.push(value);
        }
    }
    for value in variants {
        let malformed = canonical_record(&value);
        backend.replace_record(&profile, &malformed).unwrap();
        assert!(
            matches!(
                store.load_identity(),
                Err(StoreError::Corrupt | StoreError::InvalidKey)
            ),
            "malformed or nonindependent persisted identity is refused"
        );
        assert!(
            matches!(
                store.create_identity([0x42; 32]),
                Err(StoreError::Corrupt | StoreError::InvalidKey)
            ),
            "a refused record is never replaced by new keys"
        );
        assert!(
            saved_record(&backend, &profile).as_slice() == malformed.as_slice(),
            "a refused reload cannot silently replace corrupt bytes"
        );
    }
    for malformed in [
        b"".as_slice(),
        b"{\"v\":1,\"v\":1}".as_slice(),
        b"DYTEST-PRIVATE-NONJSON".as_slice(),
    ] {
        backend.replace_record(&profile, malformed).unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Corrupt)));
    }
    backend.replace_record(&profile, &original).unwrap();
    assert!(
        store.load_identity().is_ok(),
        "restoring the exact valid record restores reload"
    );
}

#[test]
fn public_formatting_is_fixed_and_never_includes_stored_material() {
    let backend = TestStore::new();
    let store = backend.open(&profile()).unwrap();
    let identity = store.create_identity([0x23; 32]).unwrap();
    assert!(format!("{identity:?}") == "StoredIdentity([redacted])");
    assert!(format!("{store:?}") == "NativeStore([redacted])");
    assert!(format!("{backend:?}") == "TestStore([redacted])");
    for (error, code, display, debug) in [
        (
            StoreError::InvalidInput,
            "STORE_INVALID_INPUT",
            "invalid native store input",
            "InvalidInput",
        ),
        (
            StoreError::Unavailable,
            "STORE_UNAVAILABLE",
            if cfg!(all(target_os = "linux", feature = "native-store")) {
                "native store unavailable; install or enable Secret Service (GNOME Keyring or KWallet), unlock it, and retry"
            } else {
                "native store unavailable"
            },
            "Unavailable",
        ),
        (
            StoreError::Missing,
            "STORE_MISSING",
            "native identity missing",
            "Missing",
        ),
        (
            StoreError::AlreadyExists,
            "STORE_ALREADY_EXISTS",
            "native identity already exists",
            "AlreadyExists",
        ),
        (
            StoreError::Corrupt,
            "STORE_CORRUPT",
            "native identity corrupt",
            "Corrupt",
        ),
        (
            StoreError::WriteFailed,
            "STORE_WRITE_FAILED",
            "native store write failed",
            "WriteFailed",
        ),
        (
            StoreError::InvalidKey,
            "STORE_INVALID_KEY",
            "native identity key invalid",
            "InvalidKey",
        ),
    ] {
        assert!(
            error.code() == code && error.to_string() == display && format!("{error:?}") == debug,
            "store errors use fixed public formatting"
        );
    }
}

#[test]
fn explicit_test_backend_obeys_the_profile_boundary() {
    let backend = TestStore::new();
    for invalid in [
        "",
        "DYTEST",
        "-dytest",
        "dytest-",
        "dytest/store",
        "dytest_store",
        "a\n",
        "a\0",
    ] {
        assert!(
            matches!(backend.open(invalid), Err(StoreError::InvalidInput)),
            "invalid profile is refused"
        );
    }
    assert!(
        backend.open(&"a".repeat(32)).is_ok(),
        "exact profile cap is valid"
    );
    assert!(matches!(
        backend.open(&"a".repeat(33)),
        Err(StoreError::InvalidInput)
    ));
}
