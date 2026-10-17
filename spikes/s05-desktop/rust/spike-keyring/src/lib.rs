//! The master key's stores (plan section 7, Master key): the platform credential store that
//! keyring 4.2.0 picks, or, where none is available (Linux without a Secret Service), a
//! passphrase-wrapped `mk.wrapped` file.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use keyring_core::{CredentialStore, Entry, Error};
use ring::rand::{SecureRandom, SystemRandom};

/// Unique to the spike, so no product or other credential is ever touched.
pub const SERVICE: &str = "com.draftyak.spike.s05";
pub const MK_LEN: usize = 32;

pub const STORE: &str = if cfg!(target_os = "windows") {
    "windows-native"
} else if cfg!(target_os = "macos") {
    "keychain"
} else {
    "secret-service"
};

pub fn random<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("the OS random source");
    bytes
}

pub fn error_kind(error: &Error) -> &'static str {
    match error {
        Error::PlatformFailure(_) => "PlatformFailure",
        Error::NoStorageAccess(_) => "NoStorageAccess",
        Error::NoEntry => "NoEntry",
        Error::BadEncoding(_) => "BadEncoding",
        Error::BadDataFormat(..) => "BadDataFormat",
        Error::BadStoreFormat(_) => "BadStoreFormat",
        Error::TooLong(..) => "TooLong",
        Error::Invalid(..) => "Invalid",
        Error::Ambiguous(_) => "Ambiguous",
        Error::NoDefaultStore => "NoDefaultStore",
        Error::NotSupportedByStore(_) => "NotSupportedByStore",
        _ => "Other",
    }
}

/// The store keyring's `v1` feature initializes once per process: Windows Credential Manager,
/// the macOS login keychain or the Secret Service. Err is why it isn't available.
pub fn native_store() -> Result<Arc<CredentialStore>, &'static str> {
    keyring::Entry::store_status()
        .as_ref()
        .map_err(error_kind)?;
    keyring_core::get_default_store().ok_or("NoDefaultStore")
}

/// Windows keeps the key on this machine (`Local`); the store's default, `Enterprise`, roams
/// with the user's profile.
fn modifiers() -> HashMap<&'static str, &'static str> {
    if cfg!(target_os = "windows") {
        HashMap::from([("persistence", "Local")])
    } else {
        HashMap::new()
    }
}

pub struct NativeCheck {
    pub read_back: bool,
    pub persistence: Option<String>,
    pub removed: bool,
    pub millis: u128,
}

/// The round-trip step that failed (entry, write, read, attributes or delete), and why.
#[derive(Debug)]
pub struct Failed {
    pub step: &'static str,
    pub error: Error,
}

impl Failed {
    /// A store that started but can't be used (no unlocked collection, a dismissed unlock
    /// prompt, or a broken connection), so the app falls back as if there were no store.
    pub fn unavailable(&self) -> bool {
        matches!(
            self.error,
            Error::NoStorageAccess(_) | Error::PlatformFailure(_)
        )
    }
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let kind = error_kind(&self.error);
        write!(f, "{}: {kind}: {}", self.step, self.error)
    }
}

/// Deletes the credential if a later step fails, so a failed run leaves nothing behind.
struct Created<'a>(Option<&'a Entry>);

impl Drop for Created<'_> {
    fn drop(&mut self) {
        if let Some(entry) = self.0 {
            let _ = entry.delete_credential();
        }
    }
}

/// Stores a fresh random key under a fresh user, reads it back, then deletes it.
pub fn native_round_trip(store: &CredentialStore) -> Result<NativeCheck, Failed> {
    let at = |step| move |error| Failed { step, error };
    let started = Instant::now();
    let mk: [u8; MK_LEN] = random();
    let user = format!("mk-{}", hex(&random::<8>()));
    let entry = store
        .build(SERVICE, &user, Some(&modifiers()))
        .map_err(at("entry"))?;
    entry.set_secret(&mk).map_err(at("write"))?;
    let mut created = Created(Some(&entry));
    let read_back = entry.get_secret().map_err(at("read"))? == mk;
    let persistence = entry
        .get_attributes()
        .map_err(at("attributes"))?
        .remove("persistence");
    entry.delete_credential().map_err(at("delete"))?;
    created.0 = None;
    let removed = matches!(entry.get_secret(), Err(Error::NoEntry));
    Ok(NativeCheck {
        read_back,
        persistence,
        removed,
        millis: started.elapsed().as_millis(),
    })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `mk.wrapped`: "DYMK", version 1, KDF 1 (PBKDF2-HMAC-SHA256), the iterations (u32, big-endian),
/// a 16-byte salt and a 12-byte nonce, then the key sealed with AES-256-GCM under that header as
/// associated data, so no header byte can change without the unwrap failing.
pub mod wrapped {
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::num::NonZeroU32;
    use std::path::Path;

    use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
    use ring::pbkdf2;

    use super::{MK_LEN, random};

    pub const KDF: &str = "pbkdf2-hmac-sha256";
    pub const AEAD: &str = "aes-256-gcm";
    pub const ITERATIONS: u32 = 600_000;
    const MAX_ITERATIONS: u32 = 10_000_000;
    const MAGIC: &[u8; 4] = b"DYMK";
    const SALT_LEN: usize = 16;
    const HEADER_LEN: usize = 10 + SALT_LEN + NONCE_LEN;
    pub const FILE_LEN: usize = HEADER_LEN + MK_LEN + 16;

    #[derive(Debug, PartialEq, Eq)]
    pub enum UnwrapError {
        /// Not a version 1 file, or iterations outside 1..=10,000,000.
        Format,
        /// A wrong passphrase or a changed byte: the two can't be told apart.
        Unlock,
    }

    fn key(passphrase: &[u8], salt: &[u8], iterations: NonZeroU32) -> LessSafeKey {
        let mut bytes = [0; 32];
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA256,
            iterations,
            salt,
            passphrase,
            &mut bytes,
        );
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &bytes).expect("a 32-byte key"))
    }

    pub fn wrap(mk: &[u8; MK_LEN], passphrase: &[u8], iterations: NonZeroU32) -> Vec<u8> {
        let salt: [u8; SALT_LEN] = random();
        let nonce: [u8; NONCE_LEN] = random();
        let mut file = Vec::with_capacity(FILE_LEN);
        file.extend_from_slice(MAGIC);
        file.extend_from_slice(&[1, 1]);
        file.extend_from_slice(&iterations.get().to_be_bytes());
        file.extend_from_slice(&salt);
        file.extend_from_slice(&nonce);
        let mut sealed = mk.to_vec();
        key(passphrase, &salt, iterations)
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(&file[..]),
                &mut sealed,
            )
            .expect("sealing 32 bytes");
        file.extend_from_slice(&sealed);
        file
    }

    pub fn unwrap(file: &[u8], passphrase: &[u8]) -> Result<[u8; MK_LEN], UnwrapError> {
        if file.len() != FILE_LEN || &file[..4] != MAGIC || file[4..6] != [1, 1] {
            return Err(UnwrapError::Format);
        }
        let rounds = u32::from_be_bytes([file[6], file[7], file[8], file[9]]);
        let iterations = NonZeroU32::new(rounds)
            .filter(|n| n.get() <= MAX_ITERATIONS)
            .ok_or(UnwrapError::Format)?;
        let (header, sealed) = file.split_at(HEADER_LEN);
        let nonce = Nonce::try_assume_unique_for_key(&header[10 + SALT_LEN..])
            .map_err(|_| UnwrapError::Format)?;
        let mut buffer = sealed.to_vec();
        let opened = key(passphrase, &header[10..10 + SALT_LEN], iterations)
            .open_in_place(nonce, Aad::from(header), &mut buffer)
            .map_err(|_| UnwrapError::Unlock)?;
        opened.try_into().map_err(|_| UnwrapError::Format)
    }

    /// A new file only (never replacing one), owner-only on Unix.
    pub fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }
}
