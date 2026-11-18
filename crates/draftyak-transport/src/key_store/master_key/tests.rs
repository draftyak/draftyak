use super::{NativeHubMasterKey, NativeHubMasterKeyStore};
use crate::key_store::{NativeProfileScope, RecordStore, StoreError};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
};
use zeroize::{Zeroize, Zeroizing};

type Namespace = (String, String);

enum ReadStep {
    Stored,
    Missing,
    Failure(StoreError),
}

#[derive(Clone)]
enum WriteMode {
    Normal,
    Refuse,
    StoreThenFail,
    ReplaceWith(Vec<u8>),
    Ignore,
}

struct Memory {
    records: BTreeMap<Namespace, Vec<u8>>,
    reads: VecDeque<ReadStep>,
    write_mode: WriteMode,
    read_calls: usize,
    writes: Vec<(Namespace, Vec<u8>)>,
    removes: usize,
}

impl Default for Memory {
    fn default() -> Self {
        Self {
            records: BTreeMap::new(),
            reads: VecDeque::new(),
            write_mode: WriteMode::Normal,
            read_calls: 0,
            writes: Vec::new(),
            removes: 0,
        }
    }
}

#[derive(Clone, Default)]
struct Backend(Arc<Mutex<Memory>>);

struct Record {
    backend: Backend,
    namespace: Namespace,
}

impl Backend {
    fn record(&self, service: &str, account: &str) -> Arc<dyn RecordStore> {
        Arc::new(Record {
            backend: self.clone(),
            namespace: (service.to_owned(), account.to_owned()),
        })
    }

    fn seed(&self, service: &str, account: &str, bytes: &[u8]) {
        self.0
            .lock()
            .expect("synthetic backend state")
            .records
            .insert((service.to_owned(), account.to_owned()), bytes.to_vec());
    }

    fn stored(&self, service: &str, account: &str) -> Option<Vec<u8>> {
        self.0
            .lock()
            .expect("synthetic backend state")
            .records
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
    }

    fn reads(&self, steps: impl IntoIterator<Item = ReadStep>) {
        self.0
            .lock()
            .expect("synthetic backend state")
            .reads
            .extend(steps);
    }

    fn write_mode(&self, mode: WriteMode) {
        self.0.lock().expect("synthetic backend state").write_mode = mode;
    }

    fn assert_no_mutation(&self) {
        let state = self.0.lock().expect("synthetic backend state");
        assert!(state.writes.is_empty());
        assert_eq!(state.removes, 0);
    }
}

impl RecordStore for Record {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        let mut state = self.state();
        state.read_calls += 1;
        match state.reads.pop_front().unwrap_or(ReadStep::Stored) {
            ReadStep::Stored => Ok(state
                .records
                .get(&self.namespace)
                .map(|bytes| Zeroizing::new(bytes.clone()))),
            ReadStep::Missing => Ok(None),
            ReadStep::Failure(error) => Err(error),
        }
    }

    fn write(&self, bytes: &[u8]) -> Result<(), StoreError> {
        let mut state = self.state();
        state.writes.push((self.namespace.clone(), bytes.to_vec()));
        let mode = state.write_mode.clone();
        match mode {
            WriteMode::Refuse => Err(StoreError::WriteFailed),
            WriteMode::Ignore => Ok(()),
            WriteMode::ReplaceWith(replacement) => {
                state.records.insert(self.namespace.clone(), replacement);
                Ok(())
            }
            WriteMode::Normal => {
                state.records.insert(self.namespace.clone(), bytes.to_vec());
                Ok(())
            }
            WriteMode::StoreThenFail => {
                state.records.insert(self.namespace.clone(), bytes.to_vec());
                Err(StoreError::WriteFailed)
            }
        }
    }

    fn remove(&self) -> Result<(), StoreError> {
        let mut state = self.state();
        state.removes += 1;
        state.records.remove(&self.namespace);
        Ok(())
    }
}

impl Record {
    fn state(&self) -> std::sync::MutexGuard<'_, Memory> {
        self.backend.0.lock().expect("synthetic backend state")
    }
}

fn open(backend: &Backend, scope: &NativeProfileScope) -> (NativeHubMasterKeyStore, Namespace) {
    let mut selected = None;
    let store =
        NativeHubMasterKeyStore::open_with_record_factory_for_test(scope, |service, record| {
            selected = Some((service.to_owned(), record.to_owned()));
            Ok(backend.record(service, record))
        })
        .expect("synthetic record factory");
    (store, selected.expect("the real namespace was selected"))
}

fn default_store(backend: &Backend) -> (NativeHubMasterKeyStore, Namespace) {
    open(backend, &NativeProfileScope::default_profile())
}

fn create(store: &NativeHubMasterKeyStore, byte: u8) -> Result<NativeHubMasterKey, StoreError> {
    store.create_with_random_for_test(|output| {
        output.fill(byte);
        Ok(())
    })
}

fn error<T>(result: Result<T, StoreError>, expected: StoreError) {
    match result {
        Err(actual) => assert_eq!(actual, expected),
        Ok(_) => panic!("expected the fixed native store refusal"),
    }
}

#[test]
fn opening_the_injected_record_does_not_read_or_create_a_key() {
    let backend = Backend::default();
    let (_store, _) = default_store(&backend);
    assert_eq!(
        backend
            .0
            .lock()
            .expect("synthetic backend state")
            .read_calls,
        0
    );
    backend.assert_no_mutation();
}

#[test]
fn record_factory_failure_is_not_a_missing_record_or_a_fallback_store() {
    error(
        NativeHubMasterKeyStore::open_with_record_factory_for_test(
            &NativeProfileScope::default_profile(),
            |_, _| Err(StoreError::Unavailable),
        ),
        StoreError::Unavailable,
    );
}

#[test]
fn load_returns_exact_owned_32_byte_material_including_zero_bytes() {
    for expected in [[0_u8; 32], std::array::from_fn(|index| index as u8)] {
        let backend = Backend::default();
        let (store, namespace) = default_store(&backend);
        backend.seed(&namespace.0, &namespace.1, &expected);
        let actual = store
            .load()
            .expect("stored canonical key")
            .into_native_owned_material();
        assert_eq!(*actual, expected);
        backend.assert_no_mutation();
    }
}

#[test]
fn missing_load_refuses_without_initialization_or_cleanup() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    error(store.load(), StoreError::Missing);
    assert_eq!(backend.stored(&namespace.0, &namespace.1), None);
    backend.assert_no_mutation();
}

#[test]
fn non_32_byte_records_are_corrupt_and_preserved_exactly() {
    for length in [0, 1, 31, 33, 2049] {
        let backend = Backend::default();
        let (store, namespace) = default_store(&backend);
        let original = vec![0x71; length];
        backend.seed(&namespace.0, &namespace.1, &original);
        error(store.load(), StoreError::Corrupt);
        assert_eq!(backend.stored(&namespace.0, &namespace.1), Some(original));
        backend.assert_no_mutation();
    }
}

#[test]
fn backend_read_errors_are_not_missing_keys_or_auto_creation() {
    for failure in [StoreError::Corrupt, StoreError::Unavailable] {
        let backend = Backend::default();
        let (store, _) = default_store(&backend);
        backend.reads([ReadStep::Failure(failure)]);
        error(store.load(), failure);
        backend.assert_no_mutation();
    }
}

#[test]
fn explicit_create_writes_and_reads_back_the_same_key_for_later_load() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    let created = create(&store, 0x42).expect("explicit synthetic initialization");
    assert_eq!(*created.into_native_owned_material(), [0x42; 32]);
    assert_eq!(
        backend.stored(&namespace.0, &namespace.1),
        Some(vec![0x42; 32])
    );
    assert_eq!(
        *store
            .load()
            .expect("reload stored key")
            .into_native_owned_material(),
        [0x42; 32]
    );
    let state = backend.0.lock().expect("synthetic backend state");
    assert_eq!(state.writes, vec![(namespace, vec![0x42; 32])]);
    assert_eq!(state.removes, 0);
}

#[test]
fn existing_key_is_preserved_before_randomness_or_write() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    backend.seed(&namespace.0, &namespace.1, &[0x19; 32]);
    let mut random_calls = 0;
    error(
        store.create_with_random_for_test(|_| {
            random_calls += 1;
            Ok(())
        }),
        StoreError::AlreadyExists,
    );
    assert_eq!(random_calls, 0);
    assert_eq!(
        backend.stored(&namespace.0, &namespace.1),
        Some(vec![0x19; 32])
    );
    backend.assert_no_mutation();
}

#[test]
fn corrupt_existing_key_is_not_overwritten_or_replaced() {
    for length in [31, 33] {
        let backend = Backend::default();
        let (store, namespace) = default_store(&backend);
        let original = vec![0x29; length];
        backend.seed(&namespace.0, &namespace.1, &original);
        let mut random_calls = 0;
        error(
            store.create_with_random_for_test(|_| {
                random_calls += 1;
                Err(StoreError::Unavailable)
            }),
            StoreError::Corrupt,
        );
        assert_eq!(random_calls, 0);
        assert_eq!(backend.stored(&namespace.0, &namespace.1), Some(original));
        backend.assert_no_mutation();
    }
}

#[test]
fn unavailable_initial_read_refuses_before_randomness() {
    let backend = Backend::default();
    let (store, _) = default_store(&backend);
    backend.reads([ReadStep::Failure(StoreError::Unavailable)]);
    let mut random_calls = 0;
    error(
        store.create_with_random_for_test(|_| {
            random_calls += 1;
            Err(StoreError::Unavailable)
        }),
        StoreError::Unavailable,
    );
    assert_eq!(random_calls, 0);
    backend.assert_no_mutation();
}

#[test]
fn random_failure_never_writes_partial_material() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    error(
        store.create_with_random_for_test(|output| {
            output[..11].fill(0x77);
            Err(StoreError::Unavailable)
        }),
        StoreError::Unavailable,
    );
    assert_eq!(backend.stored(&namespace.0, &namespace.1), None);
    backend.assert_no_mutation();
}

#[test]
fn a_record_that_appears_during_random_generation_is_not_overwritten() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    error(
        store.create_with_random_for_test(|output| {
            backend.seed(&namespace.0, &namespace.1, &[0x13; 32]);
            output.fill(0x24);
            Ok(())
        }),
        StoreError::AlreadyExists,
    );
    assert_eq!(
        backend.stored(&namespace.0, &namespace.1),
        Some(vec![0x13; 32])
    );
    backend.assert_no_mutation();
}

#[test]
fn a_corrupt_record_that_appears_before_write_is_not_repaired() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    error(
        store.create_with_random_for_test(|output| {
            backend.seed(&namespace.0, &namespace.1, &[0x13; 31]);
            output.fill(0x24);
            Ok(())
        }),
        StoreError::Corrupt,
    );
    assert_eq!(
        backend.stored(&namespace.0, &namespace.1),
        Some(vec![0x13; 31])
    );
    backend.assert_no_mutation();
}

#[test]
fn write_refusal_does_not_remove_or_retry_the_record() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    backend.write_mode(WriteMode::Refuse);
    error(create(&store, 0x61), StoreError::WriteFailed);
    assert_eq!(backend.stored(&namespace.0, &namespace.1), None);
    let state = backend.0.lock().expect("synthetic backend state");
    assert_eq!(state.writes.len(), 1);
    assert_eq!(state.removes, 0);
}

#[test]
fn an_effectful_failed_write_is_preserved_for_recovery() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    backend.write_mode(WriteMode::StoreThenFail);
    error(create(&store, 0x62), StoreError::WriteFailed);
    assert_eq!(
        backend.stored(&namespace.0, &namespace.1),
        Some(vec![0x62; 32])
    );
    assert_eq!(
        *store
            .load()
            .expect("actual remaining bytes")
            .into_native_owned_material(),
        [0x62; 32]
    );
    let state = backend.0.lock().expect("synthetic backend state");
    assert_eq!(state.writes.len(), 1);
    assert_eq!(state.removes, 0);
}

#[test]
fn successful_write_without_readback_is_not_successful_initialization() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    backend.write_mode(WriteMode::Ignore);
    error(create(&store, 0x63), StoreError::WriteFailed);
    assert_eq!(backend.stored(&namespace.0, &namespace.1), None);
    let state = backend.0.lock().expect("synthetic backend state");
    assert_eq!(state.writes.len(), 1);
    assert_eq!(state.removes, 0);
}

#[test]
fn readback_requires_all_32_exact_bytes_and_preserves_mismatches() {
    for replacement in [vec![0x64; 31], vec![0x64; 32], vec![0x64; 33]] {
        let backend = Backend::default();
        let (store, namespace) = default_store(&backend);
        backend.write_mode(WriteMode::ReplaceWith(replacement.clone()));
        error(create(&store, 0x65), StoreError::WriteFailed);
        assert_eq!(
            backend.stored(&namespace.0, &namespace.1),
            Some(replacement)
        );
        let state = backend.0.lock().expect("synthetic backend state");
        assert_eq!(state.writes.len(), 1);
        assert_eq!(state.removes, 0);
    }
}

#[test]
fn readback_errors_leave_the_actual_written_record_untouched() {
    for failure in [StoreError::Unavailable, StoreError::Corrupt] {
        let backend = Backend::default();
        let (store, namespace) = default_store(&backend);
        backend.reads([
            ReadStep::Missing,
            ReadStep::Missing,
            ReadStep::Failure(failure),
        ]);
        error(create(&store, 0x66), failure);
        assert_eq!(
            backend.stored(&namespace.0, &namespace.1),
            Some(vec![0x66; 32])
        );
        let state = backend.0.lock().expect("synthetic backend state");
        assert_eq!(state.writes.len(), 1);
        assert_eq!(state.removes, 0);
    }
}

#[test]
fn load_owns_its_bytes_and_explicit_transfer_erasure_does_not_change_storage() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    backend.seed(&namespace.0, &namespace.1, &[0x41; 32]);
    let key = store.load().expect("first actual record");
    backend.seed(&namespace.0, &namespace.1, &[0x42; 32]);
    let mut material = key.into_native_owned_material();
    assert_eq!(*material, [0x41; 32]);
    material.zeroize();
    assert_eq!(*material, [0; 32]);
    assert_eq!(
        backend.stored(&namespace.0, &namespace.1),
        Some(vec![0x42; 32])
    );
    assert_eq!(
        *store
            .load()
            .expect("new actual record")
            .into_native_owned_material(),
        [0x42; 32]
    );
    backend.assert_no_mutation();
}

#[test]
fn key_and_store_debug_do_not_expose_material_or_profile_names() {
    let backend = Backend::default();
    let scope =
        NativeProfileScope::named_profile("sensitive-profile-name").expect("canonical profile");
    let (store, namespace) = open(&backend, &scope);
    backend.seed(&namespace.0, &namespace.1, &[b'S'; 32]);
    let key = store.load().expect("synthetic key");
    assert_eq!(format!("{key:?}"), "NativeHubMasterKey([redacted])");
    assert_eq!(format!("{key:#?}"), "NativeHubMasterKey([redacted])");
    assert_eq!(format!("{store:?}"), "NativeHubMasterKeyStore([redacted])");
    assert_eq!(format!("{store:#?}"), "NativeHubMasterKeyStore([redacted])");
}

#[test]
fn every_profile_length_uses_the_exact_distinct_hub_service_and_record() {
    let backend = Backend::default();
    let device_records = [
        ("com.draftyak.transport.device.v1", "default"),
        (
            "com.draftyak.transport.device.v1",
            "desktop-profile-identity-namespace-v1--default",
        ),
        (
            "com.draftyak.transport.device.v1.desktop-profile.default",
            "desktop-profile-identity-namespace-v1--default",
        ),
    ];
    for (service, record) in device_records {
        backend.seed(service, record, b"unchanged-device-record");
    }
    let mut profiles = vec![(NativeProfileScope::default_profile(), "default".to_owned())];
    profiles.push((
        NativeProfileScope::named_profile("default").expect("named default"),
        "named-default".to_owned(),
    ));
    for length in 1..=32 {
        let name = "a".repeat(length);
        profiles.push((
            NativeProfileScope::named_profile(&name).expect("canonical profile"),
            format!("named-{name}"),
        ));
    }
    let mut retained = Vec::new();
    let mut namespaces = std::collections::BTreeSet::new();
    for (index, (scope, suffix)) in profiles.iter().enumerate() {
        let (store, namespace) = open(&backend, scope);
        let expected_service = match suffix.strip_prefix("named-") {
            Some(name) => {
                format!("com.draftyak.transport.hub-master-key.v1.desktop-profile.named.{name}")
            }
            None => "com.draftyak.transport.hub-master-key.v1.desktop-profile.default".to_owned(),
        };
        assert_eq!(namespace.0, expected_service);
        assert_eq!(
            namespace.1,
            format!("desktop-profile-hub-master-key-namespace-v1--{suffix}")
        );
        assert!(namespace.0.is_ascii() && namespace.0.len() <= 128);
        assert!(namespace.1.is_ascii() && namespace.1.len() <= 128);
        assert!(namespaces.insert(namespace));
        let expected = [index as u8 + 1; 32];
        assert_eq!(
            *create(&store, expected[0])
                .expect("separate explicit initialization")
                .into_native_owned_material(),
            expected
        );
        retained.push((store, expected));
    }
    assert_eq!(namespaces.len(), 34);
    for (store, expected) in retained {
        assert_eq!(
            *store
                .load()
                .expect("same original profile key")
                .into_native_owned_material(),
            expected
        );
    }
    for (service, record) in device_records {
        assert_eq!(
            backend.stored(service, record),
            Some(b"unchanged-device-record".to_vec())
        );
    }
    let state = backend.0.lock().expect("synthetic backend state");
    assert_eq!(state.records.len(), 37);
    assert_eq!(state.removes, 0);
}

struct GateRecord {
    record: Arc<dyn RecordStore>,
    observations: Arc<Mutex<Vec<bool>>>,
}

impl GateRecord {
    fn observe(&self) {
        let held = matches!(
            crate::key_store::OPERATIONS.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        );
        self.observations
            .lock()
            .expect("synthetic gate observations")
            .push(held);
    }
}

impl RecordStore for GateRecord {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        self.observe();
        self.record.read()
    }

    fn write(&self, bytes: &[u8]) -> Result<(), StoreError> {
        self.observe();
        self.record.write(bytes)
    }

    fn remove(&self) -> Result<(), StoreError> {
        self.observe();
        self.record.remove()
    }
}

#[test]
fn key_operations_hold_the_actual_global_device_operation_gate() {
    let backend = Backend::default();
    let observations = Arc::new(Mutex::new(Vec::new()));
    let store = NativeHubMasterKeyStore::open_with_record_factory_for_test(
        &NativeProfileScope::default_profile(),
        |service, record| {
            Ok(Arc::new(GateRecord {
                record: backend.record(service, record),
                observations: observations.clone(),
            }))
        },
    )
    .expect("synthetic record factory");
    let mut random_was_locked = false;
    let key = store
        .create_with_random_for_test(|output| {
            random_was_locked = matches!(
                crate::key_store::OPERATIONS.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
            output.fill(0x73);
            Ok(())
        })
        .expect("synthetic initialization under the original gate");
    assert!(random_was_locked);
    assert_eq!(*key.into_native_owned_material(), [0x73; 32]);
    assert_eq!(
        *store
            .load()
            .expect("serialized load")
            .into_native_owned_material(),
        [0x73; 32]
    );
    let observed = observations.lock().expect("synthetic gate observations");
    assert!(!observed.is_empty());
    assert!(observed.iter().all(|held| *held));
}

#[test]
fn forgetting_a_device_record_does_not_delete_the_hub_key() {
    let backend = Backend::default();
    let (store, namespace) = default_store(&backend);
    let scope = NativeProfileScope::default_profile();
    backend.seed(
        scope.backend_service_name(),
        scope.backend_record_name(),
        b"synthetic device record",
    );
    let device = crate::key_store::NativeStore {
        record: backend.record(scope.backend_service_name(), scope.backend_record_name()),
    };
    let key = create(&store, 0x74).expect("separate hub record");
    device
        .forget_identity()
        .expect("forget synthetic device record");
    assert_eq!(
        backend.stored(scope.backend_service_name(), scope.backend_record_name()),
        None
    );
    assert_eq!(*key.into_native_owned_material(), [0x74; 32]);
    assert_eq!(
        *store
            .load()
            .expect("unchanged hub key")
            .into_native_owned_material(),
        [0x74; 32]
    );
    let state = backend.0.lock().expect("synthetic backend state");
    assert_eq!(state.removes, 1);
    assert_eq!(state.records.len(), 1);
    assert_eq!(state.records.get(&namespace), Some(&vec![0x74; 32]));
}

#[cfg(not(feature = "native-store"))]
#[test]
fn native_backend_disabled_does_not_open_a_synthetic_fallback() {
    error(
        NativeHubMasterKeyStore::open_profile(&NativeProfileScope::default_profile()),
        StoreError::Unavailable,
    );
}
