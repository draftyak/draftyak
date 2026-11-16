//! Synthetic credential-adapter controls. No operating-system store is opened.

use super::{PlatformRecord, StoreError};
use crate::key_store::NativeStore;
use keyring_core::{Credential, Entry, Error, api::CredentialApi};
use std::{
    any::Any,
    collections::HashMap,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[derive(Clone, Copy)]
enum Failure {
    Platform,
    Access,
    #[cfg(target_os = "macos")]
    Authentication,
    #[cfg(target_os = "macos")]
    InteractionNotAllowed,
    #[cfg(target_os = "macos")]
    AppleAbsence,
}
impl Failure {
    fn error(self, formatted: &Arc<AtomicUsize>) -> Error {
        match self {
            Self::Platform => Error::PlatformFailure(Box::new(BackendError(formatted.clone()))),
            Self::Access => Error::NoStorageAccess(Box::new(BackendError(formatted.clone()))),
            #[cfg(target_os = "macos")]
            Self::Authentication => {
                apple_native_keyring_store::keychain::decode_error((-25293_i32).into())
            }
            #[cfg(target_os = "macos")]
            Self::InteractionNotAllowed => {
                apple_native_keyring_store::keychain::decode_error((-25308_i32).into())
            }
            #[cfg(target_os = "macos")]
            Self::AppleAbsence => {
                apple_native_keyring_store::keychain::decode_error((-25300_i32).into())
            }
        }
    }
}
struct BackendError(Arc<AtomicUsize>);
impl fmt::Debug for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fetch_add(1, Ordering::SeqCst);
        f.write_str("DYTEST-backend-debug")
    }
}
impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fetch_add(1, Ordering::SeqCst);
        f.write_str("DYTEST-backend-display")
    }
}
impl std::error::Error for BackendError {}

#[derive(Clone, Copy)]
enum Read {
    Present,
    Missing,
    Failed(Failure),
}
#[derive(Default)]
struct Observed {
    reads: AtomicUsize,
    writes: AtomicUsize,
    formatted: Arc<AtomicUsize>,
}
struct ScriptedCredential {
    read: Read,
    write: Option<Failure>,
    persistence: Option<&'static str>,
    observed: Arc<Observed>,
}
impl CredentialApi for ScriptedCredential {
    fn set_secret(&self, _secret: &[u8]) -> keyring_core::Result<()> {
        self.observed.writes.fetch_add(1, Ordering::SeqCst);
        match self.write {
            Some(failure) => Err(failure.error(&self.observed.formatted)),
            None => Ok(()),
        }
    }
    fn get_secret(&self) -> keyring_core::Result<Vec<u8>> {
        self.observed.reads.fetch_add(1, Ordering::SeqCst);
        match self.read {
            Read::Present => Ok(b"DYTEST-adapter-value".to_vec()),
            Read::Missing => Err(Error::NoEntry),
            Read::Failed(failure) => Err(failure.error(&self.observed.formatted)),
        }
    }
    fn get_attributes(&self) -> keyring_core::Result<HashMap<String, String>> {
        Ok(self
            .persistence
            .map(|value| HashMap::from([("persistence".into(), value.into())]))
            .unwrap_or_default())
    }
    fn delete_credential(&self) -> keyring_core::Result<()> {
        Err(Error::NoEntry)
    }
    fn get_credential(&self) -> keyring_core::Result<Option<Arc<Credential>>> {
        Ok(None)
    }
    fn get_specifiers(&self) -> Option<(String, String)> {
        None
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn debug_fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ScriptedCredential([redacted])")
    }
}
fn scripted(read: Read, write: Option<Failure>) -> (NativeStore, Arc<Observed>) {
    scripted_with(read, write, Some("Local"))
}
fn scripted_with(
    read: Read,
    write: Option<Failure>,
    persistence: Option<&'static str>,
) -> (NativeStore, Arc<Observed>) {
    let observed = Arc::new(Observed::default());
    let entry = Entry::new_with_credential(Arc::new(ScriptedCredential {
        read,
        write,
        persistence,
        observed: observed.clone(),
    }));
    (
        NativeStore {
            record: Arc::new(PlatformRecord { entry }),
        },
        observed,
    )
}

#[test]
fn successful_platform_io_is_not_a_constant_refusal() {
    let (store, observed) = scripted(Read::Present, None);
    let value = store
        .record
        .read()
        .expect("synthetic adapter read succeeds");
    assert!(
        value.is_some_and(|value| value.as_slice() == b"DYTEST-adapter-value"),
        "synthetic adapter preserves the returned bytes"
    );
    assert!(
        store.record.write(b"DYTEST-write").is_ok(),
        "synthetic adapter forwards a successful write"
    );
    assert_eq!(observed.reads.load(Ordering::SeqCst), 1);
    assert_eq!(observed.writes.load(Ordering::SeqCst), 1);
    assert_eq!(observed.formatted.load(Ordering::SeqCst), 0);
}

#[test]
fn only_no_entry_becomes_missing() {
    let (store, observed) = scripted(Read::Missing, Some(Failure::Platform));
    assert!(matches!(store.record.read(), Ok(None)));
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    assert_eq!(observed.writes.load(Ordering::SeqCst), 0);
    assert_eq!(observed.formatted.load(Ordering::SeqCst), 0);
}

#[test]
fn platform_read_failures_never_create_or_replace_identity() {
    for failure in [Failure::Platform, Failure::Access] {
        let (store, observed) = scripted(Read::Failed(failure), Some(failure));
        assert!(matches!(store.record.read(), Err(StoreError::Unavailable)));
        assert!(matches!(
            store.load_identity(),
            Err(StoreError::Unavailable)
        ));
        assert!(matches!(
            store.create_identity([0x28; 32]),
            Err(StoreError::Unavailable)
        ));
        assert_eq!(observed.reads.load(Ordering::SeqCst), 3);
        assert_eq!(observed.writes.load(Ordering::SeqCst), 0);
        assert_eq!(observed.formatted.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn platform_write_failures_stop_before_readback() {
    for failure in [Failure::Platform, Failure::Access] {
        let (store, observed) = scripted(Read::Missing, Some(failure));
        assert!(matches!(
            store.record.write(b"DYTEST-write"),
            Err(StoreError::WriteFailed)
        ));
        assert!(matches!(
            store.create_identity([0x28; 32]),
            Err(StoreError::WriteFailed)
        ));
        assert_eq!(observed.writes.load(Ordering::SeqCst), 2);
        assert_eq!(observed.reads.load(Ordering::SeqCst), 2);
        assert_eq!(observed.formatted.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn platform_failure_diagnostics_do_not_format_backend_errors() {
    for failure in [Failure::Platform, Failure::Access] {
        let (store, observed) = scripted(Read::Failed(failure), Some(failure));
        let read_error = store.load_identity().expect_err("synthetic read fails");
        let write_error = store
            .record
            .write(b"DYTEST-write")
            .expect_err("synthetic write fails");
        assert_eq!(read_error.code(), "STORE_UNAVAILABLE");
        #[cfg(target_os = "linux")]
        assert_eq!(
            read_error.to_string(),
            "native store unavailable; install or enable Secret Service (GNOME Keyring or KWallet), unlock it, and retry"
        );
        #[cfg(not(target_os = "linux"))]
        assert_eq!(read_error.to_string(), "native store unavailable");
        assert_eq!(format!("{read_error:?}"), "Unavailable");
        assert_eq!(write_error.code(), "STORE_WRITE_FAILED");
        assert_eq!(write_error.to_string(), "native store write failed");
        assert_eq!(format!("{write_error:?}"), "WriteFailed");
        assert_eq!(format!("{store:?}"), "NativeStore([redacted])");
        assert_eq!(observed.formatted.load(Ordering::SeqCst), 0);
    }
}

#[cfg(target_os = "windows")]
#[test]
fn windows_reads_refuse_a_credential_without_local_persistence() {
    for persistence in [None, Some("Session"), Some("Enterprise"), Some("local")] {
        let (store, observed) = scripted_with(Read::Present, None, persistence);
        assert!(matches!(store.record.read(), Err(StoreError::Corrupt)));
        assert!(matches!(store.load_identity(), Err(StoreError::Corrupt)));
        assert!(matches!(
            store.create_identity([0x28; 32]),
            Err(StoreError::Corrupt)
        ));
        assert_eq!(observed.writes.load(Ordering::SeqCst), 0);
    }
}

// These construct typed errors only. They do not call Keychain or establish OS denial behavior.
#[cfg(target_os = "macos")]
#[test]
fn apple_authentication_and_interaction_statuses_remain_typed_refusals() {
    for failure in [Failure::Authentication, Failure::InteractionNotAllowed] {
        let formatted = Arc::new(AtomicUsize::new(0));
        assert!(matches!(
            failure.error(&formatted),
            Error::PlatformFailure(_)
        ));
        let (store, observed) = scripted(Read::Failed(failure), Some(failure));
        assert!(matches!(
            store.load_identity(),
            Err(StoreError::Unavailable)
        ));
        assert!(matches!(
            store.create_identity([0x28; 32]),
            Err(StoreError::Unavailable)
        ));
        assert!(matches!(
            store.record.write(b"DYTEST-write"),
            Err(StoreError::WriteFailed)
        ));
        assert_eq!(observed.writes.load(Ordering::SeqCst), 1);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn apple_item_not_found_is_absence_without_regeneration() {
    let formatted = Arc::new(AtomicUsize::new(0));
    assert!(matches!(
        Failure::AppleAbsence.error(&formatted),
        Error::NoEntry
    ));
    let (store, observed) = scripted(Read::Failed(Failure::AppleAbsence), None);
    assert!(matches!(store.record.read(), Ok(None)));
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    assert_eq!(observed.writes.load(Ordering::SeqCst), 0);
}
