//! Synthetic record deletion controls. No operating-system store is opened.

use super::{NativeStore, RecordStore, StoreError, testing::TestStore};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use zeroize::Zeroizing;

#[derive(Clone, Copy)]
enum Removal {
    Delete,
    LeavePresent,
    Refuse,
}

struct Record {
    value: Mutex<Option<Zeroizing<Vec<u8>>>>,
    removal: Removal,
    read_error: bool,
    reads: AtomicUsize,
    removals: AtomicUsize,
}

impl RecordStore for Record {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.read_error {
            return Err(StoreError::Unavailable);
        }
        Ok(self.value.lock().unwrap().clone())
    }

    fn write(&self, _: &[u8]) -> Result<(), StoreError> {
        panic!("forget must not write a replacement identity")
    }

    fn remove(&self) -> Result<(), StoreError> {
        self.removals.fetch_add(1, Ordering::SeqCst);
        match self.removal {
            Removal::Delete => {
                self.value.lock().unwrap().take();
                Ok(())
            }
            Removal::LeavePresent => Ok(()),
            Removal::Refuse => Err(StoreError::WriteFailed),
        }
    }
}

fn record(removal: Removal, read_error: bool) -> (NativeStore, Arc<Record>) {
    let record = Arc::new(Record {
        value: Mutex::new(Some(Zeroizing::new(b"DYTEST-corrupt-record".to_vec()))),
        removal,
        read_error,
        reads: AtomicUsize::new(0),
        removals: AtomicUsize::new(0),
    });
    (
        NativeStore {
            record: record.clone(),
        },
        record,
    )
}

#[test]
fn forget_deletes_the_exact_record_and_then_verifies_absence() {
    let (store, record) = record(Removal::Delete, false);
    assert_eq!(store.forget_identity(), Ok(()));
    assert!(record.value.lock().unwrap().is_none());
    assert_eq!(record.removals.load(Ordering::SeqCst), 1);
    assert_eq!(record.reads.load(Ordering::SeqCst), 1);
    assert!(matches!(store.load_identity(), Err(StoreError::Missing)));
}

#[test]
fn forgetting_one_profile_keeps_another_persisted_identity() {
    let records = TestStore::new();
    let first = records.open("first").unwrap();
    let second = records.open("second").unwrap();
    first.create_identity([0x41; 32]).unwrap();
    second.create_identity([0x42; 32]).unwrap();
    assert_eq!(first.forget_identity(), Ok(()));
    assert!(matches!(first.load_identity(), Err(StoreError::Missing)));
    assert_eq!(second.load_identity().unwrap().hub_pin(), [0x42; 32]);
}

#[test]
fn a_successful_delete_without_actual_absence_is_refused() {
    let (store, record) = record(Removal::LeavePresent, false);
    assert_eq!(store.forget_identity(), Err(StoreError::WriteFailed));
    assert!(record.value.lock().unwrap().is_some());
    assert_eq!(record.removals.load(Ordering::SeqCst), 1);
    assert_eq!(record.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn removal_failure_preserves_the_record_without_a_readback_or_retry() {
    let (store, record) = record(Removal::Refuse, false);
    assert_eq!(store.forget_identity(), Err(StoreError::WriteFailed));
    assert!(record.value.lock().unwrap().is_some());
    assert_eq!(record.removals.load(Ordering::SeqCst), 1);
    assert_eq!(record.reads.load(Ordering::SeqCst), 0);
}

#[test]
fn unreadable_post_delete_state_cannot_claim_success() {
    let (store, record) = record(Removal::Delete, true);
    assert_eq!(store.forget_identity(), Err(StoreError::Unavailable));
    assert_eq!(record.removals.load(Ordering::SeqCst), 1);
    assert_eq!(record.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn oversized_corrupt_records_can_be_forgotten_without_decoding_them() {
    let (store, record) = record(Removal::Delete, false);
    *record.value.lock().unwrap() = Some(Zeroizing::new(vec![0x58; super::MAX_RECORD_BYTES + 1]));
    assert_eq!(store.forget_identity(), Ok(()));
    assert_eq!(record.removals.load(Ordering::SeqCst), 1);
    assert_eq!(record.reads.load(Ordering::SeqCst), 1);
}

#[test]
fn already_absent_records_remain_absent_on_repeated_forget() {
    let (store, record) = record(Removal::Delete, false);
    *record.value.lock().unwrap() = None;
    assert_eq!(store.forget_identity(), Ok(()));
    assert_eq!(store.forget_identity(), Ok(()));
    assert!(record.value.lock().unwrap().is_none());
    assert_eq!(record.removals.load(Ordering::SeqCst), 2);
    assert_eq!(record.reads.load(Ordering::SeqCst), 2);
}
