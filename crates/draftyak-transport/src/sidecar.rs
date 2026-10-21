//! Fixed sidecar-window derivation from the supervisor's bootstrap secret.
//!
//! The caller supplies the genuine bootstrap secret and retains responsibility for its
//! provenance and borrowed storage. Deriving these bytes opens no window, confirms no
//! device and grants no capability. Owned input copies, raw outputs and encoded outputs
//! use zeroizing buffers. Erasure is best effort: borrowed input, HKDF/hash internals,
//! library temporaries and compiler copies are outside that ownership guarantee.

use std::fmt;

use draftyak_protocol::sign;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const SECRET_LENGTH: usize = 16;
const PID_INFO: &[u8] = b"draftyak/pair/v1/sidecar-pid";
const SEC_INFO: &[u8] = b"draftyak/pair/v1/sidecar-sec";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidecarError {
    InvalidBootstrapLength,
    DerivationFailed,
}

impl SidecarError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidBootstrapLength => "SIDECAR_BOOTSTRAP_LENGTH",
            Self::DerivationFailed => "SIDECAR_DERIVATION_FAILED",
        }
    }
}

impl fmt::Display for SidecarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidBootstrapLength => "invalid sidecar bootstrap length",
            Self::DerivationFailed => "sidecar derivation failed",
        })
    }
}

impl std::error::Error for SidecarError {}

/// Native-only canonical base64url material for one derived sidecar window.
///
/// This value is neither a renderer model nor an authorization handle. It is not
/// cloneable or serializable. Explicit zeroization invalidates both accessors' material;
/// dropping the value also zeroizes its owned strings.
#[must_use]
pub struct SidecarWindowSecrets {
    pid: Zeroizing<String>,
    sec: Zeroizing<String>,
}

impl SidecarWindowSecrets {
    /// The native window identifier, before explicit zeroization.
    pub fn pid(&self) -> &str {
        self.pid.as_str()
    }

    /// The native proof secret, before explicit zeroization. Never log this value.
    pub fn sec(&self) -> &str {
        self.sec.as_str()
    }
}

impl fmt::Debug for SidecarWindowSecrets {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SidecarWindowSecrets([redacted])")
    }
}

impl Zeroize for SidecarWindowSecrets {
    fn zeroize(&mut self) {
        self.pid.zeroize();
        self.sec.zeroize();
    }
}

impl ZeroizeOnDrop for SidecarWindowSecrets {}

/// Derive the two fixed 16-byte outputs with HKDF-SHA-256 and an empty salt.
///
/// The caller cannot choose the algorithm, salt, labels or output lengths. The input
/// is borrowed and unchanged; the caller must erase its own secret when no longer needed.
pub fn derive_window_secrets(
    bootstrap_secret: &[u8],
) -> Result<SidecarWindowSecrets, SidecarError> {
    if bootstrap_secret.len() != SECRET_LENGTH {
        return Err(SidecarError::InvalidBootstrapLength);
    }

    let mut owned_input = Zeroizing::new([0u8; SECRET_LENGTH]);
    owned_input.copy_from_slice(bootstrap_secret);
    let hkdf = Hkdf::<Sha256>::new(Some(&[]), &*owned_input);
    let mut pid = Zeroizing::new([0u8; SECRET_LENGTH]);
    let mut sec = Zeroizing::new([0u8; SECRET_LENGTH]);
    hkdf.expand(PID_INFO, &mut *pid)
        .map_err(|_| SidecarError::DerivationFailed)?;
    hkdf.expand(SEC_INFO, &mut *sec)
        .map_err(|_| SidecarError::DerivationFailed)?;

    Ok(SidecarWindowSecrets {
        pid: Zeroizing::new(sign::base64url_encode(&*pid)),
        sec: Zeroizing::new(sign::base64url_encode(&*sec)),
    })
}
