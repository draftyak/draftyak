//! Test-only mock-feature-off controls. Native cases require a disposable isolated environment.

use super::{NativeStore, RecordStore, StoreError};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FailureState {
    NoBus,
    NoService,
    NoCollection,
    Locked,
}
fn selected_state(backend: &str, state: &str) -> Option<FailureState> {
    if backend != "secret-service" {
        return None;
    }
    match state {
        "no-bus" => Some(FailureState::NoBus),
        "no-service" => Some(FailureState::NoService),
        "no-collection" => Some(FailureState::NoCollection),
        "locked" => Some(FailureState::Locked),
        _ => None,
    }
}

#[test]
fn isolated_failure_setup_has_a_closed_selector() {
    for state in ["no-bus", "no-service", "no-collection", "locked"] {
        assert!(selected_state("secret-service", state).is_some());
        assert!(selected_state("windows", state).is_none());
    }
    for state in ["", "unlocked", "Locked", "locked\n", "no-service ", "other"] {
        assert!(selected_state("secret-service", state).is_none());
    }
}

// Synthetic boundary only: no operating-system store is constructed or called.
struct FailingRecord {
    fail_read: bool,
    fail_write: bool,
    writes: Arc<AtomicUsize>,
}
impl RecordStore for FailingRecord {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        if self.fail_read {
            Err(StoreError::Unavailable)
        } else {
            Ok(None)
        }
    }
    fn write(&self, _bytes: &[u8]) -> Result<(), StoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if self.fail_write {
            Err(StoreError::WriteFailed)
        } else {
            Ok(())
        }
    }
    fn remove(&self) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
}

#[test]
fn synthetic_read_failure_stays_typed_without_any_write_or_identity() {
    let writes = Arc::new(AtomicUsize::new(0));
    let store = NativeStore {
        record: Arc::new(FailingRecord {
            fail_read: true,
            fail_write: true,
            writes: writes.clone(),
        }),
    };
    assert!(matches!(
        store.load_identity(),
        Err(StoreError::Unavailable)
    ));
    assert!(matches!(
        store.create_identity([0x23; 32]),
        Err(StoreError::Unavailable)
    ));
    assert_eq!(writes.load(Ordering::SeqCst), 0);
}

#[test]
fn synthetic_first_write_failure_stays_typed_without_an_identity() {
    let writes = Arc::new(AtomicUsize::new(0));
    let failures = Arc::new(AtomicUsize::new(0));
    let store = NativeStore {
        record: Arc::new(ObservedWrite {
            inner: Arc::new(FailingRecord {
                fail_read: false,
                fail_write: true,
                writes: Arc::new(AtomicUsize::new(0)),
            }),
            writes: writes.clone(),
            failures: failures.clone(),
        }),
    };
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
    assert!(matches!(
        store.create_identity([0x23; 32]),
        Err(StoreError::WriteFailed)
    ));
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(failures.load(Ordering::SeqCst), 1);
}

struct ObservedWrite {
    inner: Arc<dyn RecordStore>,
    writes: Arc<AtomicUsize>,
    failures: Arc<AtomicUsize>,
}
impl RecordStore for ObservedWrite {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        self.inner.read()
    }
    fn write(&self, bytes: &[u8]) -> Result<(), StoreError> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let result = self.inner.write(bytes);
        if result.is_err() {
            self.failures.fetch_add(1, Ordering::SeqCst);
        }
        result
    }
    fn remove(&self) -> Result<(), StoreError> {
        self.inner.remove()
    }
}

#[test]
fn a_readback_mismatch_after_one_successful_native_write_is_refused() {
    let writes = Arc::new(AtomicUsize::new(0));
    let failures = Arc::new(AtomicUsize::new(0));
    let store = NativeStore {
        record: Arc::new(ObservedWrite {
            inner: Arc::new(FailingRecord {
                fail_read: false,
                fail_write: false,
                writes: Arc::new(AtomicUsize::new(0)),
            }),
            writes: writes.clone(),
            failures: failures.clone(),
        }),
    };
    assert!(matches!(
        store.create_identity([0x23; 32]),
        Err(StoreError::WriteFailed)
    ));
    assert_eq!(writes.load(Ordering::SeqCst), 1);
    assert_eq!(failures.load(Ordering::SeqCst), 0);
}

#[cfg(target_os = "linux")]
#[test]
#[ignore = "explicit disposable Secret Service failure environment only"]
fn native_store_unavailable_has_no_fallback() {
    use super::testing::NativeTestStore;

    let backend = std::env::var("DRAFTYAK_NATIVE_STORE_TEST").unwrap_or_default();
    let state = std::env::var("DRAFTYAK_NATIVE_STORE_FAILURE_STATE").unwrap_or_default();
    let state = selected_state(&backend, &state).expect("invalid isolated native failure setup");
    // The outer environment must establish and verify the selected bus/collection state.
    // A timeout or failed setup is not a passing native refusal.
    match NativeTestStore::new() {
        Err(StoreError::Unavailable) => {}
        Ok(mut scope) => {
            match scope.open() {
                Err(StoreError::Unavailable) => {}
                Ok(store) => {
                    let loaded = store.load_identity();
                    let missing = matches!(loaded, Err(StoreError::Missing));
                    assert!(
                        matches!(loaded, Err(StoreError::Missing | StoreError::Unavailable)),
                        "unusable native store cannot load an identity"
                    );
                    let writes = Arc::new(AtomicUsize::new(0));
                    let failures = Arc::new(AtomicUsize::new(0));
                    let observed = NativeStore {
                        record: Arc::new(ObservedWrite {
                            inner: store.record,
                            writes: writes.clone(),
                            failures: failures.clone(),
                        }),
                    };
                    let created = observed.create_identity([0x23; 32]);
                    assert!(
                        matches!(
                            created,
                            Err(StoreError::Unavailable | StoreError::WriteFailed)
                        ),
                        "unusable native store cannot return a fallback identity"
                    );
                    if missing && matches!(state, FailureState::NoCollection | FailureState::Locked)
                    {
                        assert!(
                            matches!(created, Err(StoreError::WriteFailed)),
                            "unusable collection refuses the first native write"
                        );
                        assert_eq!(
                            writes.load(Ordering::SeqCst),
                            1,
                            "collection failure reached exactly one native write"
                        );
                        assert_eq!(
                            failures.load(Ordering::SeqCst),
                            1,
                            "native write itself failed before readback"
                        );
                    }
                }
                Err(_) => panic!("unexpected isolated native open failure class"),
            }
            // A successful cleanup verifies absence. Unavailable cleanup remains unverified;
            // disposal of the independently owned container removes its private keyring.
            assert!(
                matches!(
                    scope.cleanup(),
                    Ok(()) | Err(StoreError::Unavailable | StoreError::WriteFailed)
                ),
                "isolated native cleanup has a fixed failure class"
            );
        }
        Err(_) => panic!("unexpected isolated native setup failure class"),
    }
}
