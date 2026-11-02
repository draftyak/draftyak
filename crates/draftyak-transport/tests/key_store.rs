use draftyak_transport::key_store::StoreError;

#[cfg(not(feature = "native-store"))]
#[test]
fn feature_off_is_a_typed_failure_without_mock_or_volatile_fallback() {
    use draftyak_transport::key_store::NativeStore;
    assert!(matches!(
        NativeStore::open("dytest-store-default"),
        Err(StoreError::Unavailable)
    ));
    assert!(matches!(
        NativeStore::open("../other-app"),
        Err(StoreError::InvalidInput)
    ));
    let profile = "dytest-private-guidance";
    let error = NativeStore::open(profile).expect_err("feature-off store must refuse");
    assert_eq!(error.code(), "STORE_UNAVAILABLE");
    assert_eq!(
        error.to_string(),
        "native store unavailable",
        "a build without the store gives no Secret Service guidance"
    );
    assert!(!format!("{error:?}").contains(profile));
}

#[cfg(all(target_os = "linux", feature = "native-store"))]
#[test]
fn linux_unavailability_gives_fixed_install_unlock_and_retry_guidance() {
    let error = StoreError::Unavailable;
    assert_eq!(error.code(), "STORE_UNAVAILABLE");
    assert_eq!(format!("{error:?}"), "Unavailable");
    assert_eq!(
        error.to_string(),
        "native store unavailable; install or enable Secret Service (GNOME Keyring or KWallet), unlock it, and retry"
    );
}

#[cfg(not(all(target_os = "linux", feature = "native-store")))]
#[test]
fn builds_without_the_linux_store_keep_the_plain_unavailable_diagnostic() {
    let error = StoreError::Unavailable;
    assert_eq!(error.code(), "STORE_UNAVAILABLE");
    assert_eq!(format!("{error:?}"), "Unavailable");
    assert_eq!(error.to_string(), "native store unavailable");
}

#[test]
fn other_typed_errors_keep_fixed_content_free_public_diagnostics() {
    for (error, code, display, debug) in [
        (
            StoreError::InvalidInput,
            "STORE_INVALID_INPUT",
            "invalid native store input",
            "InvalidInput",
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
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), display);
        assert_eq!(format!("{error:?}"), debug);
    }
    for error in [
        StoreError::InvalidInput,
        StoreError::Unavailable,
        StoreError::Missing,
        StoreError::AlreadyExists,
        StoreError::Corrupt,
        StoreError::WriteFailed,
        StoreError::InvalidKey,
    ] {
        let display = error.to_string();
        assert!(display.is_ascii() && display.len() <= 160);
        assert!(!display.chars().any(char::is_control));
    }
}

#[cfg(feature = "mock-store")]
mod mock_cases {
    use super::*;
    use draftyak_transport::key_store::testing::TestStore;
    use sha2::{Digest, Sha256};

    #[test]
    fn explicit_store_reloads_two_independent_keys_and_the_unchanged_pin() {
        let backend = TestStore::new();
        let (transport, signing) = {
            let store = backend.open("dytest-store-basic").unwrap();
            let identity = store.create_identity([7; 32]).unwrap();
            let transport = identity.transport_spki_hash();
            let signing = identity.signing_public_key();
            assert!(
                transport != <[u8; 32]>::from(Sha256::digest(signing)),
                "independent keys required"
            );
            assert_eq!(identity.hub_pin(), [7; 32]);
            assert!(
                format!("{identity:?}") == "StoredIdentity([redacted])",
                "identity diagnostics are redacted"
            );
            (transport, signing)
        };
        let reloaded = backend
            .open("dytest-store-basic")
            .unwrap()
            .load_identity()
            .unwrap();
        assert!(
            transport == reloaded.transport_spki_hash(),
            "stored transport identity changed"
        );
        assert!(
            signing == reloaded.signing_public_key(),
            "stored signing identity changed"
        );
        assert_eq!(reloaded.hub_pin(), [7; 32]);
        assert!(matches!(
            backend
                .open("dytest-store-basic")
                .unwrap()
                .create_identity([8; 32]),
            Err(StoreError::AlreadyExists)
        ));
        assert_eq!(
            backend
                .open("dytest-store-basic")
                .unwrap()
                .load_identity()
                .unwrap()
                .hub_pin(),
            [7; 32]
        );
        backend.remove_record("dytest-store-basic").unwrap();
        assert!(matches!(
            backend.open("dytest-store-basic").unwrap().load_identity(),
            Err(StoreError::Missing)
        ));
    }

    #[test]
    fn corrupt_or_partial_records_are_never_replaced_by_new_keys() {
        let valid = {
            let source = TestStore::new();
            drop(
                source
                    .open("dytest-store-source")
                    .unwrap()
                    .create_identity([3; 32])
                    .unwrap(),
            );
            String::from_utf8(
                source
                    .record("dytest-store-source")
                    .unwrap()
                    .unwrap()
                    .to_vec(),
            )
            .unwrap()
        };
        let reordered = format!(
            "{{\"v\":1,{}}}",
            valid
                .strip_prefix('{')
                .and_then(|rest| rest.strip_suffix(",\"v\":1}"))
                .expect("canonical record ends with its version")
        );
        let backend = TestStore::new();
        for bytes in [
            b"not-json".as_slice(),
            b"{}",
            b"{\"v\":1}",
            b"{\"v\":1,\"v\":1}",
            format!("{valid}\n").as_bytes(),
            format!(" {valid}").as_bytes(),
            reordered.as_bytes(),
        ] {
            backend
                .replace_record("dytest-store-corrupt", bytes)
                .unwrap();
            let store = backend.open("dytest-store-corrupt").unwrap();
            assert!(matches!(store.load_identity(), Err(StoreError::Corrupt)));
            assert!(matches!(
                store.create_identity([3; 32]),
                Err(StoreError::Corrupt)
            ));
            assert!(
                backend
                    .record("dytest-store-corrupt")
                    .unwrap()
                    .unwrap()
                    .as_slice()
                    == bytes,
                "corrupt record was overwritten"
            );
        }
        let oversize = format!("{valid}{}", " ".repeat(2049 - valid.len()));
        backend
            .replace_record("dytest-store-oversize", oversize.as_bytes())
            .unwrap();
        let store = backend.open("dytest-store-oversize").unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Corrupt)));
        assert!(matches!(
            store.create_identity([3; 32]),
            Err(StoreError::Corrupt)
        ));
        assert!(
            matches!(
                backend.record("dytest-store-oversize"),
                Err(StoreError::Corrupt)
            ),
            "an oversize record is refused and never replaced"
        );
    }

    #[test]
    fn read_write_and_readback_failure_stay_typed_without_fallback() {
        let backend = TestStore::new();
        let store = backend.open("dytest-store-failure").unwrap();
        backend.fail_reads(true).unwrap();
        assert!(matches!(
            store.load_identity(),
            Err(StoreError::Unavailable)
        ));
        assert!(matches!(
            store.create_identity([1; 32]),
            Err(StoreError::Unavailable)
        ));
        backend.fail_reads(false).unwrap();
        backend.fail_writes(true).unwrap();
        assert!(matches!(
            store.create_identity([1; 32]),
            Err(StoreError::WriteFailed)
        ));
        assert!(backend.record("dytest-store-failure").unwrap().is_none());
        backend.fail_writes(false).unwrap();
        backend.corrupt_writes(true).unwrap();
        assert!(matches!(
            store.create_identity([1; 32]),
            Err(StoreError::WriteFailed)
        ));
        assert!(matches!(store.load_identity(), Err(StoreError::Corrupt)));
    }

    #[test]
    fn store_and_errors_have_fixed_diagnostics() {
        let backend = TestStore::new();
        let store = backend.open("dytest-store-diagnostic").unwrap();
        assert_eq!(format!("{backend:?}"), "TestStore([redacted])");
        assert_eq!(format!("{store:?}"), "NativeStore([redacted])");
        for error in [
            StoreError::InvalidInput,
            StoreError::Unavailable,
            StoreError::Missing,
            StoreError::AlreadyExists,
            StoreError::Corrupt,
            StoreError::WriteFailed,
            StoreError::InvalidKey,
        ] {
            assert!(error.code().starts_with("STORE_"));
            assert!(!error.to_string().contains("dytest"));
            assert!(!format!("{error:?}").contains("dytest"));
        }
    }

    #[test]
    fn forget_identity_is_profile_scoped_and_idempotent_after_reopen() {
        let backend = TestStore::new();
        let store = backend.open("dytest-forget-selected").unwrap();
        store.forget_identity().unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
        drop(store.create_identity([0x31; 32]).unwrap());
        let (transport, signing) = {
            let identity = backend
                .open("dytest-forget-other")
                .unwrap()
                .create_identity([0x32; 32])
                .unwrap();
            (
                identity.transport_spki_hash(),
                identity.signing_public_key(),
            )
        };

        store.forget_identity().unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
        let reopened = backend.open("dytest-forget-selected").unwrap();
        assert!(matches!(reopened.load_identity(), Err(StoreError::Missing)));
        reopened.forget_identity().unwrap();
        assert!(backend.record("dytest-forget-selected").unwrap().is_none());
        assert!(matches!(
            backend
                .open("dytest-forget-selected")
                .unwrap()
                .load_identity(),
            Err(StoreError::Missing)
        ));

        let other = backend
            .open("dytest-forget-other")
            .unwrap()
            .load_identity()
            .unwrap();
        assert!(
            other.transport_spki_hash() == transport,
            "other transport changed"
        );
        assert!(
            other.signing_public_key() == signing,
            "other signing key changed"
        );
        assert!(other.hub_pin() == [0x32; 32], "other hub pin changed");
    }

    #[test]
    fn forget_delete_failure_preserves_identity_and_fixed_diagnostics() {
        let backend = TestStore::new();
        let store = backend.open("dytest-forget-delete-failure").unwrap();
        let (transport, signing) = {
            let identity = store.create_identity([0x43; 32]).unwrap();
            (
                identity.transport_spki_hash(),
                identity.signing_public_key(),
            )
        };
        backend.fail_writes(true).unwrap();
        let error = store.forget_identity().unwrap_err();
        assert!(
            error == StoreError::WriteFailed,
            "delete failure must stay typed"
        );
        assert!(
            error.code() == "STORE_WRITE_FAILED",
            "delete error code changed"
        );
        assert!(
            error.to_string() == "native store write failed",
            "delete error is not fixed"
        );
        assert!(
            format!("{error:?}") == "WriteFailed",
            "delete error debug is not fixed"
        );
        assert!(
            format!("{store:?}") == "NativeStore([redacted])",
            "store is not redacted"
        );
        assert!(
            format!("{backend:?}") == "TestStore([redacted])",
            "backend is not redacted"
        );
        let unchanged = backend
            .open("dytest-forget-delete-failure")
            .unwrap()
            .load_identity()
            .unwrap();
        assert!(
            unchanged.transport_spki_hash() == transport,
            "failed delete changed transport"
        );
        assert!(
            unchanged.signing_public_key() == signing,
            "failed delete changed signing key"
        );
        assert!(
            unchanged.hub_pin() == [0x43; 32],
            "failed delete changed pin"
        );
        drop(unchanged);
        backend.fail_writes(false).unwrap();
        store.forget_identity().unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    }

    #[test]
    fn forget_refuses_a_successful_delete_that_left_the_record_behind() {
        let backend = TestStore::new();
        let store = backend.open("dytest-forget-ignored-delete").unwrap();
        drop(store.create_identity([0x54; 32]).unwrap());
        let original = backend
            .record("dytest-forget-ignored-delete")
            .unwrap()
            .unwrap();
        backend.ignore_removes(true).unwrap();
        assert!(matches!(
            store.forget_identity(),
            Err(StoreError::WriteFailed)
        ));
        assert!(
            backend
                .record("dytest-forget-ignored-delete")
                .unwrap()
                .unwrap()
                .as_slice()
                == original.as_slice(),
            "ignored delete changed the stored record"
        );
        backend.ignore_removes(false).unwrap();
        store.forget_identity().unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    }

    #[test]
    fn forget_does_not_treat_a_corrupt_remaining_record_as_absence() {
        let backend = TestStore::new();
        let bytes = b"DYTEST corrupt identity record";
        backend
            .replace_record("dytest-forget-corrupt", bytes)
            .unwrap();
        let store = backend.open("dytest-forget-corrupt").unwrap();
        assert!(matches!(store.load_identity(), Err(StoreError::Corrupt)));
        backend.ignore_removes(true).unwrap();
        assert!(matches!(
            store.forget_identity(),
            Err(StoreError::WriteFailed)
        ));
        assert!(
            backend
                .record("dytest-forget-corrupt")
                .unwrap()
                .unwrap()
                .as_slice()
                == bytes,
            "corrupt remaining record changed"
        );
        backend.ignore_removes(false).unwrap();
        store.forget_identity().unwrap();
        assert!(matches!(
            backend
                .open("dytest-forget-corrupt")
                .unwrap()
                .load_identity(),
            Err(StoreError::Missing)
        ));
    }

    #[test]
    fn forget_readback_failure_reports_unavailable_without_recreating_identity() {
        let backend = TestStore::new();
        let store = backend.open("dytest-forget-readback-failure").unwrap();
        drop(store.create_identity([0x65; 32]).unwrap());
        backend.fail_reads(true).unwrap();
        assert!(matches!(
            store.forget_identity(),
            Err(StoreError::Unavailable)
        ));
        backend.fail_reads(false).unwrap();
        assert!(
            backend
                .record("dytest-forget-readback-failure")
                .unwrap()
                .is_none()
        );
        assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
        let reopened = backend.open("dytest-forget-readback-failure").unwrap();
        assert!(matches!(reopened.load_identity(), Err(StoreError::Missing)));
        reopened.forget_identity().unwrap();
        assert!(matches!(reopened.load_identity(), Err(StoreError::Missing)));
    }
}

#[cfg(feature = "mock-store")]
#[path = "support/key_store_controls.rs"]
mod controls;

#[cfg(all(feature = "native-store", feature = "mock-store"))]
use controls::peer as native_peer;

#[cfg(all(feature = "native-store", feature = "mock-store"))]
#[tokio::test]
#[ignore = "explicit isolated native-store wrapper only"]
async fn native_store_roundtrip() {
    use draftyak_transport::{
        Error,
        key_store::testing::NativeTestStore,
        tls::Identity,
        websocket::{Timeouts, WebSocketConnection, WebSocketMessage},
    };
    use std::time::Duration;

    let expected = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "secret-service"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        panic!("native store target is not selected")
    };
    assert!(
        std::env::var("DRAFTYAK_NATIVE_STORE_TEST").as_deref() == Ok(expected),
        "explicit native store selection is required"
    );
    tokio::time::timeout(Duration::from_secs(35), async {
        let mut scope = NativeTestStore::new().expect("isolated native store scope");
        let plan = native_peer::Plan::new();
        let pin = plan.pin();
        let (transport, signing) = {
            let store = scope.open().unwrap();
            assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
            let identity = store.create_identity(pin).unwrap();
            (
                identity.transport_spki_hash(),
                identity.signing_public_key(),
            )
        };
        let mut peer = plan.start(transport);
        {
            let store = scope.open().unwrap();
            let identity = store.load_identity().unwrap();
            assert!(identity.transport_spki_hash() == transport);
            assert!(identity.signing_public_key() == signing);
            assert!(identity.hub_pin() == pin);
            assert!(matches!(
                store.create_identity([0x4a; 32]),
                Err(StoreError::AlreadyExists)
            ));
            let response = identity
                .connect(peer.address)
                .await
                .unwrap()
                .post("/stored-http", b"{}")
                .await
                .unwrap();
            assert!(response.as_bytes() == b"DYTEST-STORED-HTTP");
            assert!(peer.event("accepted")["exactStoredSpki"] == true);
            peer.event("http");
        }
        {
            let identity = scope.open().unwrap().load_identity().unwrap();
            let pinned = identity.connect(peer.address).await.unwrap();
            let mut websocket =
                WebSocketConnection::upgrade(pinned, "/stored-ws", None, Timeouts::default())
                    .await
                    .unwrap();
            assert!(matches!(websocket.receive().await.unwrap(),
                Some(WebSocketMessage::Text(ref value)) if value == "DYTEST-STORED-WS"));
            websocket.close().await.unwrap();
            assert!(peer.event("accepted")["exactStoredSpki"] == true);
            peer.event("websocket");
        }
        let unrelated = Identity::generate().unwrap();
        match draftyak_transport::tls::PinnedConnection::connect(peer.address, &unrelated, pin)
            .await
        {
            Ok(connection) => assert!(connection.post("/stored-http", b"{}").await.is_err()),
            Err(error) => assert!(error == Error::ConnectionFailed),
        }
        peer.event("rejected");
        let summary = peer.stop();
        assert!(summary.connections == 3 && summary.accepted == 2 && summary.rejected == 1);
        assert!(summary.http == 1 && summary.websocket == 1);
        scope
            .cleanup()
            .expect("owned native credential removed and absence verified");
    })
    .await
    .expect("native store roundtrip deadline");
}
