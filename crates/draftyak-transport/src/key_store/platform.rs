use super::{RecordStore, StoreError};
use keyring_core::{CredentialStore, Entry};
use std::{collections::HashMap, sync::Arc};
use zeroize::Zeroizing;

struct PlatformRecord {
    entry: Entry,
}
fn store() -> Result<Arc<CredentialStore>, StoreError> {
    #[cfg(target_os = "windows")]
    {
        windows_native_keyring_store::Store::new()
            .map(|value| value as Arc<CredentialStore>)
            .map_err(|_| StoreError::Unavailable)
    }
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    ))]
    {
        zbus_secret_service_keyring_store::Store::new()
            .map(|value| value as Arc<CredentialStore>)
            .map_err(|_| StoreError::Unavailable)
    }
    #[cfg(target_os = "macos")]
    {
        apple_native_keyring_store::keychain::Store::new()
            .map(|value| value as Arc<CredentialStore>)
            .map_err(|_| StoreError::Unavailable)
    }
    #[cfg(not(any(
        target_os = "windows",
        all(
            unix,
            not(any(target_os = "macos", target_os = "ios", target_os = "android"))
        ),
        target_os = "macos"
    )))]
    {
        Err(StoreError::Unavailable)
    }
}
pub(super) fn open(service: &str, account: &str) -> Result<Arc<dyn RecordStore>, StoreError> {
    let modifiers = if cfg!(target_os = "windows") {
        HashMap::from([("persistence", "Local")])
    } else {
        HashMap::new()
    };
    let entry = store()?
        .build(service, account, Some(&modifiers))
        .map_err(|_| StoreError::Unavailable)?;
    Ok(Arc::new(PlatformRecord { entry }))
}
impl RecordStore for PlatformRecord {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        match self.entry.get_secret() {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                #[cfg(target_os = "windows")]
                if self
                    .entry
                    .get_attributes()
                    .map_err(|_| StoreError::Unavailable)?
                    .get("persistence")
                    .is_none_or(|value| value != "Local")
                {
                    return Err(StoreError::Corrupt);
                }
                Ok(Some(bytes))
            }
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(StoreError::Unavailable),
        }
    }
    fn write(&self, bytes: &[u8]) -> Result<(), StoreError> {
        self.entry
            .set_secret(bytes)
            .map_err(|_| StoreError::WriteFailed)
    }
    #[cfg(any(test, feature = "mock-store"))]
    fn remove(&self) -> Result<(), StoreError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(StoreError::WriteFailed),
        }
    }
}

#[cfg(test)]
#[path = "platform_controls.rs"]
mod controls;
