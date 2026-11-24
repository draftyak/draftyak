//! Explicit test-only store injection; never selected by NativeStore::open.
use super::{NativeStore, RecordStore, StoreError, profile};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;

#[derive(Default)]
struct State {
    records: BTreeMap<String, Zeroizing<Vec<u8>>>,
    fail_reads: bool,
    fail_writes: bool,
    corrupt_writes: bool,
}
#[derive(Clone)]
pub struct TestStore {
    state: Arc<Mutex<State>>,
}
impl std::fmt::Debug for TestStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TestStore([redacted])")
    }
}
impl Default for TestStore {
    fn default() -> Self {
        Self::new()
    }
}
impl TestStore {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
        }
    }
    pub fn open(&self, name: &str) -> Result<NativeStore, StoreError> {
        profile(name)?;
        Ok(NativeStore {
            record: Arc::new(TestRecord {
                state: self.state.clone(),
                name: name.to_owned(),
            }),
        })
    }
    pub fn record(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        self.open(name)?.read()
    }
    pub fn replace_record(&self, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
        profile(name)?;
        if bytes.len() > 64 * 1024 {
            return Err(StoreError::InvalidInput);
        }
        self.state
            .lock()
            .map_err(|_| StoreError::Unavailable)?
            .records
            .insert(name.to_owned(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
    pub fn remove_record(&self, name: &str) -> Result<(), StoreError> {
        self.open(name)?.remove_for_test()
    }
    pub fn fail_reads(&self, enabled: bool) -> Result<(), StoreError> {
        self.state
            .lock()
            .map_err(|_| StoreError::Unavailable)?
            .fail_reads = enabled;
        Ok(())
    }
    pub fn fail_writes(&self, enabled: bool) -> Result<(), StoreError> {
        self.state
            .lock()
            .map_err(|_| StoreError::Unavailable)?
            .fail_writes = enabled;
        Ok(())
    }
    pub fn corrupt_writes(&self, enabled: bool) -> Result<(), StoreError> {
        self.state
            .lock()
            .map_err(|_| StoreError::Unavailable)?
            .corrupt_writes = enabled;
        Ok(())
    }
}
struct TestRecord {
    state: Arc<Mutex<State>>,
    name: String,
}
impl RecordStore for TestRecord {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        let state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        if state.fail_reads {
            return Err(StoreError::Unavailable);
        }
        Ok(state
            .records
            .get(&self.name)
            .map(|bytes| Zeroizing::new(bytes.to_vec())))
    }
    fn write(&self, bytes: &[u8]) -> Result<(), StoreError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        if state.fail_writes {
            return Err(StoreError::WriteFailed);
        }
        let bytes = if state.corrupt_writes {
            b"synthetic-corrupt-write".as_slice()
        } else {
            bytes
        };
        state
            .records
            .insert(self.name.clone(), Zeroizing::new(bytes.to_vec()));
        Ok(())
    }
    fn remove(&self) -> Result<(), StoreError> {
        let mut state = self.state.lock().map_err(|_| StoreError::Unavailable)?;
        if state.fail_writes {
            return Err(StoreError::WriteFailed);
        }
        state.records.remove(&self.name);
        Ok(())
    }
}

/// An independently generated, test-only native credential namespace.
/// Cleanup is bounded to its one credential; abrupt process termination can leave it behind.
#[cfg(feature = "native-store")]
pub struct NativeTestStore {
    service: String,
    cleaned: bool,
}
#[cfg(feature = "native-store")]
impl std::fmt::Debug for NativeTestStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NativeTestStore([redacted])")
    }
}
#[cfg(feature = "native-store")]
impl NativeTestStore {
    pub fn new() -> Result<Self, StoreError> {
        let mut random = [0_u8; 16];
        rustls::crypto::ring::default_provider()
            .secure_random
            .fill(&mut random)
            .map_err(|_| StoreError::Unavailable)?;
        let service = format!(
            "org.draftyak.transport-test.m1b3.{}",
            crate::codec::hex(&random)
        );
        let store = NativeStore {
            record: super::platform::open(&service, "device-identity-v1")?,
        };
        if store.read()?.is_some() {
            return Err(StoreError::AlreadyExists);
        }
        Ok(Self {
            service,
            cleaned: false,
        })
    }
    pub fn open(&self) -> Result<NativeStore, StoreError> {
        if self.cleaned {
            return Err(StoreError::InvalidInput);
        }
        Ok(NativeStore {
            record: super::platform::open(&self.service, "device-identity-v1")?,
        })
    }
    pub fn cleanup(&mut self) -> Result<(), StoreError> {
        if !self.cleaned {
            self.open()?.remove_for_test()?;
            self.cleaned = true;
        }
        Ok(())
    }
}
#[cfg(feature = "native-store")]
impl Drop for NativeTestStore {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}
