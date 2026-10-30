//! Persisted native device keys and unchanged hub pin. No pairing or authorization authority.

use std::{
    fmt,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use draftyak_protocol::{jcs, sign};
use p256::{ecdsa::SigningKey, pkcs8::DecodePrivateKey};
use rcgen::{KeyPair, PKCS_ECDSA_P256_SHA256};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    codec,
    tls::{Identity, PinnedConnection},
};

#[cfg(all(test, feature = "native-store", not(feature = "mock-store")))]
mod linux_environment;
#[cfg(feature = "native-store")]
mod platform;
#[cfg(any(test, feature = "mock-store"))]
pub mod testing;

const SERVICE: &str = "com.draftyak.transport.device.v1";
const MAX_RECORD_BYTES: usize = 2048;
// The backing stores offer no cross-process compare-and-set. Initial creation
// requires exclusive trusted initialization in addition to this process lock.
static OPERATIONS: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreError {
    InvalidInput,
    Unavailable,
    Missing,
    AlreadyExists,
    Corrupt,
    WriteFailed,
    InvalidKey,
}
impl StoreError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "STORE_INVALID_INPUT",
            Self::Unavailable => "STORE_UNAVAILABLE",
            Self::Missing => "STORE_MISSING",
            Self::AlreadyExists => "STORE_ALREADY_EXISTS",
            Self::Corrupt => "STORE_CORRUPT",
            Self::WriteFailed => "STORE_WRITE_FAILED",
            Self::InvalidKey => "STORE_INVALID_KEY",
        }
    }
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidInput => "invalid native store input",
            Self::Unavailable if cfg!(all(target_os = "linux", feature = "native-store")) => {
                "native store unavailable; install or enable Secret Service (GNOME Keyring or KWallet), unlock it, and retry"
            }
            Self::Unavailable => "native store unavailable",
            Self::Missing => "native identity missing",
            Self::AlreadyExists => "native identity already exists",
            Self::Corrupt => "native identity corrupt",
            Self::WriteFailed => "native store write failed",
            Self::InvalidKey => "native identity key invalid",
        })
    }
}
impl std::error::Error for StoreError {}

pub struct StoredIdentity {
    transport: Identity,
    signing: SigningKey,
    hid: [u8; 32],
}
impl fmt::Debug for StoredIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("StoredIdentity([redacted])")
    }
}
impl StoredIdentity {
    pub fn transport_spki_hash(&self) -> [u8; 32] {
        self.transport.spki_hash()
    }
    pub fn signing_public_key(&self) -> [u8; 91] {
        sign::spki_der(self.signing_handle().verifying_key())
    }
    pub fn hub_pin(&self) -> [u8; 32] {
        self.hid
    }
    pub(crate) fn signing_handle(&self) -> &SigningKey {
        &self.signing
    }
    pub async fn connect(&self, address: SocketAddr) -> Result<PinnedConnection, crate::Error> {
        PinnedConnection::connect(address, &self.transport, self.hid).await
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireIdentity {
    v: u8,
    transport_key: String,
    signing_key: String,
    hid: String,
}
impl Drop for WireIdentity {
    fn drop(&mut self) {
        self.transport_key.zeroize();
        self.signing_key.zeroize();
    }
}
fn decode(bytes: &[u8]) -> Result<StoredIdentity, StoreError> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(StoreError::Corrupt);
    }
    let wire: WireIdentity =
        serde_json::from_value(jcs::parse_strict(bytes).map_err(|_| StoreError::Corrupt)?)
            .map_err(|_| StoreError::Corrupt)?;
    let canonical = Zeroizing::new(
        jcs::canonicalize(&wire)
            .map_err(|_| StoreError::Corrupt)?
            .into_bytes(),
    );
    if wire.v != 1 || canonical.as_slice() != bytes {
        return Err(StoreError::Corrupt);
    }
    let hid = codec::unhex::<32>(&wire.hid).ok_or(StoreError::Corrupt)?;
    let transport_key =
        Zeroizing::new(sign::base64url_decode(&wire.transport_key).ok_or(StoreError::Corrupt)?);
    let signing_key =
        Zeroizing::new(sign::base64url_decode(&wire.signing_key).ok_or(StoreError::Corrupt)?);
    let transport = Identity::from_pkcs8(&transport_key).map_err(|_| StoreError::Corrupt)?;
    let signing = SigningKey::from_pkcs8_der(&signing_key).map_err(|_| StoreError::Corrupt)?;
    let signing_spki = sign::spki_der(signing.verifying_key());
    use sha2::{Digest, Sha256};
    if transport.spki_hash() == <[u8; 32]>::from(Sha256::digest(signing_spki)) {
        return Err(StoreError::Corrupt);
    }
    Ok(StoredIdentity {
        transport,
        signing,
        hid,
    })
}
fn generated(hid: [u8; 32]) -> Result<Zeroizing<Vec<u8>>, StoreError> {
    let transport =
        KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|_| StoreError::InvalidKey)?;
    let signing =
        KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(|_| StoreError::InvalidKey)?;
    let transport_bytes = Zeroizing::new(transport.serialize_der());
    let signing_bytes = Zeroizing::new(signing.serialize_der());
    let wire = WireIdentity {
        v: 1,
        transport_key: sign::base64url_encode(&transport_bytes),
        signing_key: sign::base64url_encode(&signing_bytes),
        hid: codec::hex(&hid),
    };
    let encoded = Zeroizing::new(
        jcs::canonicalize(&wire)
            .map_err(|_| StoreError::InvalidKey)?
            .into_bytes(),
    );
    if encoded.len() > MAX_RECORD_BYTES {
        return Err(StoreError::InvalidKey);
    }
    Ok(encoded)
}
fn profile(value: &str) -> Result<(), StoreError> {
    if value.is_empty()
        || value.len() > 32
        || !value.as_bytes()[0].is_ascii_lowercase()
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
trait RecordStore: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError>;
    fn write(&self, bytes: &[u8]) -> Result<(), StoreError>;
    #[cfg(any(test, feature = "mock-store"))]
    fn remove(&self) -> Result<(), StoreError>;
}

pub struct NativeStore {
    record: Arc<dyn RecordStore>,
}
impl fmt::Debug for NativeStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("NativeStore([redacted])")
    }
}
impl NativeStore {
    pub fn open(name: &str) -> Result<Self, StoreError> {
        profile(name)?;
        #[cfg(feature = "native-store")]
        {
            Ok(Self {
                record: platform::open(SERVICE, name)?,
            })
        }
        #[cfg(not(feature = "native-store"))]
        {
            let _ = SERVICE;
            Err(StoreError::Unavailable)
        }
    }
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        let bytes = self.record.read()?;
        if bytes
            .as_ref()
            .is_some_and(|value| value.len() > MAX_RECORD_BYTES)
        {
            return Err(StoreError::Corrupt);
        }
        Ok(bytes)
    }
    pub fn load_identity(&self) -> Result<StoredIdentity, StoreError> {
        let _guard = OPERATIONS.lock().map_err(|_| StoreError::Unavailable)?;
        decode(&self.read()?.ok_or(StoreError::Missing)?)
    }
    fn require_missing(&self) -> Result<(), StoreError> {
        if let Some(bytes) = self.read()? {
            decode(&bytes)?;
            return Err(StoreError::AlreadyExists);
        }
        Ok(())
    }
    /// Caller owns exclusive trusted first initialization. No backend CAS or OS lease is implied.
    pub fn create_identity(&self, hid: [u8; 32]) -> Result<StoredIdentity, StoreError> {
        let _guard = OPERATIONS.lock().map_err(|_| StoreError::Unavailable)?;
        self.require_missing()?;
        let bytes = generated(hid)?;
        let identity = decode(&bytes)?;
        // Refuse an entry observed during generation instead of overwriting it.
        self.require_missing()?;
        self.record.write(&bytes)?;
        // A record that does not read back is refused and left for recovery: without
        // compare-and-set, removing it could delete another writer's record.
        if self
            .read()?
            .is_none_or(|stored| stored.as_slice() != bytes.as_slice())
        {
            return Err(StoreError::WriteFailed);
        }
        Ok(identity)
    }
    #[cfg(any(test, feature = "mock-store"))]
    fn remove_for_test(&self) -> Result<(), StoreError> {
        let _guard = OPERATIONS.lock().map_err(|_| StoreError::Unavailable)?;
        self.record.remove()?;
        if self.read()?.is_some() {
            return Err(StoreError::WriteFailed);
        }
        Ok(())
    }
}
