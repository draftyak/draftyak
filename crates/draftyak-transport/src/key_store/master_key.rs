//! Native hub encryption-key material, separate from device identity and admission.

use std::{fmt, sync::Arc};

use zeroize::Zeroizing;

use super::{NativeProfileScope, OPERATIONS, RecordStore, StoreError};

const KEY_BYTES: usize = 32;

/// Owned key material only; not a profile lease, consent or connection grant.
/// The owned buffer is erased on drop on a best-effort basis.
pub struct NativeHubMasterKey {
    material: Zeroizing<[u8; KEY_BYTES]>,
}

impl fmt::Debug for NativeHubMasterKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeHubMasterKey([redacted])")
    }
}

impl NativeHubMasterKey {
    fn from_record(bytes: &[u8]) -> Result<Self, StoreError> {
        if bytes.len() != KEY_BYTES {
            return Err(StoreError::Corrupt);
        }
        let mut material = Zeroizing::new([0_u8; KEY_BYTES]);
        material.copy_from_slice(bytes);
        Ok(Self { material })
    }

    /// Moves the original material into native-owned child-input work.
    /// Erase this transient buffer after the genuine consumer has copied it.
    /// This transfer supplies no native admission or authority.
    pub fn into_native_owned_material(self) -> Zeroizing<[u8; KEY_BYTES]> {
        self.material
    }
}

/// Uses the same native record backend and process operation lock as identities.
/// Callers retain and revalidate their original exclusive profile owner around
/// native key work; this store provides no cross-process compare-and-set.
pub struct NativeHubMasterKeyStore {
    record: Arc<dyn RecordStore>,
}

impl fmt::Debug for NativeHubMasterKeyStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("NativeHubMasterKeyStore([redacted])")
    }
}

impl NativeHubMasterKeyStore {
    fn profile_names(scope: &NativeProfileScope) -> (&str, &str) {
        (
            scope.backend_master_key_service_name(),
            scope.backend_master_key_record_name(),
        )
    }

    /// Opens only the selected profile's distinct hub master-key service/record.
    /// Missing native support refuses rather than selecting another backend.
    pub fn open_profile(scope: &NativeProfileScope) -> Result<Self, StoreError> {
        let (service, account) = Self::profile_names(scope);
        #[cfg(feature = "native-store")]
        {
            Ok(Self {
                record: super::platform::open(service, account)?,
            })
        }
        #[cfg(not(feature = "native-store"))]
        {
            let _ = (service, account);
            Err(StoreError::Unavailable)
        }
    }

    /// Loads an existing exact 32-byte key without creating or repairing it.
    pub fn load(&self) -> Result<NativeHubMasterKey, StoreError> {
        let _guard = OPERATIONS.lock().map_err(|_| StoreError::Unavailable)?;
        let bytes = self.record.read()?.ok_or(StoreError::Missing)?;
        NativeHubMasterKey::from_record(&bytes)
    }

    fn require_missing(&self) -> Result<(), StoreError> {
        if let Some(bytes) = self.record.read()? {
            if bytes.len() != KEY_BYTES {
                return Err(StoreError::Corrupt);
            }
            return Err(StoreError::AlreadyExists);
        }
        Ok(())
    }

    /// Caller owns exclusive trusted first initialization before this call and
    /// revalidates that same owner afterward. Never use this as a load fallback.
    pub fn create_for_owned_first_initialization(&self) -> Result<NativeHubMasterKey, StoreError> {
        self.create_with_random(secure_random)
    }

    fn create_with_random(
        &self,
        fill: impl FnOnce(&mut [u8; KEY_BYTES]) -> Result<(), StoreError>,
    ) -> Result<NativeHubMasterKey, StoreError> {
        let _guard = OPERATIONS.lock().map_err(|_| StoreError::Unavailable)?;
        self.require_missing()?;
        let mut material = Zeroizing::new([0_u8; KEY_BYTES]);
        fill(&mut material)?;
        // Refuse a record that appeared during generation. The process lock is
        // not an OS lease or compare-and-set against another process.
        self.require_missing()?;
        self.record.write(material.as_slice())?;
        // Preserve any uncertain write for recovery. Never delete or overwrite
        // a mismatching/missing record as cleanup, and never return that key.
        if self
            .record
            .read()?
            .is_none_or(|stored| stored.as_slice() != material.as_slice())
        {
            return Err(StoreError::WriteFailed);
        }
        Ok(NativeHubMasterKey { material })
    }

    #[cfg(test)]
    fn open_with_record_factory_for_test(
        scope: &NativeProfileScope,
        factory: impl FnOnce(&str, &str) -> Result<Arc<dyn RecordStore>, StoreError>,
    ) -> Result<Self, StoreError> {
        let (service, account) = Self::profile_names(scope);
        Ok(Self {
            record: factory(service, account)?,
        })
    }

    #[cfg(test)]
    fn create_with_random_for_test(
        &self,
        fill: impl FnOnce(&mut [u8; KEY_BYTES]) -> Result<(), StoreError>,
    ) -> Result<NativeHubMasterKey, StoreError> {
        self.create_with_random(fill)
    }
}

fn secure_random(bytes: &mut [u8; KEY_BYTES]) -> Result<(), StoreError> {
    rustls::crypto::ring::default_provider()
        .secure_random
        .fill(bytes)
        .map_err(|_| StoreError::InvalidKey)
}

#[cfg(test)]
mod tests;
