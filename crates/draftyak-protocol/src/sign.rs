//! ES256 statement signatures over `"draftyak/v1/<typ>\n" ‖ JCS(statement)` (§7), with keys as
//! SPKI DER and signatures as the 64-byte r‖s, both carried as canonical base64url (D6).

use crate::jcs::{self, JcsError};
use base64ct::{Base64UrlUnpadded, Encoding};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SignError {
    #[error("SIGN_INVALID_TYP: not a statement type")]
    InvalidTyp,
    #[error("SIGN_INVALID_KEY: not a P-256 SPKI with an uncompressed point")]
    InvalidKey,
    #[error("SIGN_NOT_OBJECT: a statement is a JSON object")]
    NotObject,
    #[error("SIGN_UNSAFE_NUMBER: a number in a statement isn't a safe integer")]
    UnsafeNumber,
    #[error(transparent)]
    Jcs(#[from] JcsError),
}

impl SignError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidTyp => "SIGN_INVALID_TYP",
            Self::InvalidKey => "SIGN_INVALID_KEY",
            Self::NotObject => "SIGN_NOT_OBJECT",
            Self::UnsafeNumber => "SIGN_UNSAFE_NUMBER",
            Self::Jcs(error) => error.code(),
        }
    }
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

// A P-256 SubjectPublicKeyInfo up to its point; the uncompressed point (0x04 ‖ x ‖ y) follows.
const SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

// Dotted segments of lower-case letters, digits and hyphens, each starting with a letter, ending in
// .v and the major version without a leading zero, such as "approval.send.v1".
fn is_typ(typ: &str) -> bool {
    let Some((name, version)) = typ.rsplit_once('.') else {
        return false;
    };
    let segment = |part: &str| {
        part.starts_with(|c: char| c.is_ascii_lowercase())
            && part
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    let major = version.strip_prefix('v').unwrap_or("");
    name.split('.').all(segment)
        && major.starts_with(|c: char| ('1'..='9').contains(&c))
        && major.bytes().all(|b| b.is_ascii_digit())
}

fn prefix(typ: &str) -> Result<Vec<u8>, SignError> {
    if !is_typ(typ) {
        return Err(SignError::InvalidTyp);
    }
    Ok(format!("draftyak/v1/{typ}\n").into_bytes())
}

// Every number in a signed form is a safe integer, so no signing input depends on how a language
// writes fractions or large numbers.
fn safe_integers(value: &Value) -> bool {
    match value {
        Value::Number(number) => {
            if let Some(unsigned) = number.as_u64() {
                unsigned <= MAX_SAFE_INTEGER
            } else if let Some(signed) = number.as_i64() {
                signed.unsigned_abs() <= MAX_SAFE_INTEGER
            } else {
                number.as_f64().is_some_and(|float| {
                    float.fract() == 0.0 && float.abs() <= MAX_SAFE_INTEGER as f64
                })
            }
        }
        Value::Array(items) => items.iter().all(safe_integers),
        Value::Object(members) => members.values().all(safe_integers),
        _ => true,
    }
}

fn check_statement(value: &Value) -> Result<(), SignError> {
    match value {
        Value::Object(_) if safe_integers(value) => Ok(()),
        Value::Object(_) => Err(SignError::UnsafeNumber),
        _ => Err(SignError::NotObject),
    }
}

/// The UTF-8 of `"draftyak/v1/<typ>\n"` followed by the statement's JCS bytes.
pub fn signing_input<T: Serialize + ?Sized>(
    typ: &str,
    statement: &T,
) -> Result<Vec<u8>, SignError> {
    let mut input = prefix(typ)?;
    let jcs = jcs::canonicalize(statement)?;
    check_statement(&jcs::parse_strict(jcs.as_bytes())?)?;
    input.extend_from_slice(jcs.as_bytes());
    Ok(input)
}

/// ES256 over the signing input with the RFC 6979 nonce, as r‖s. S is left as computed: the
/// protocol never normalizes it, and [`verify`] accepts either half. So (r, s) and (r, n − s) both
/// verify, and replay or single-use checks key on the statement's nonce, never on signature bytes.
pub fn sign<T: Serialize + ?Sized>(
    key: &SigningKey,
    typ: &str,
    statement: &T,
) -> Result<[u8; 64], SignError> {
    let signature: Signature = key.sign(&signing_input(typ, statement)?);
    Ok(signature.to_bytes().into())
}

/// The statement in `received` when those bytes are the canonical JCS of a statement and
/// `signature` (r‖s) signs exactly them under `public_key_spki`, otherwise `None`. Statements
/// from elsewhere are opened this way, never parsed first and verified as an object. Only a
/// malformed `typ` is an error.
pub fn verify(
    typ: &str,
    received: &[u8],
    signature: &[u8],
    public_key_spki: &[u8],
) -> Result<Option<Map<String, Value>>, SignError> {
    let mut input = prefix(typ)?;
    let Ok(value) = jcs::parse_strict(received) else {
        return Ok(None);
    };
    let canonical = jcs::canonicalize(&value).is_ok_and(|text| text.as_bytes() == received);
    if check_statement(&value).is_err() || !canonical {
        return Ok(None);
    }
    let (Ok(key), Ok(signature)) = (
        verifying_key_from_spki(public_key_spki),
        Signature::from_slice(signature),
    ) else {
        return Ok(None);
    };
    input.extend_from_slice(received);
    match value {
        Value::Object(statement) if key.verify(&input, &signature).is_ok() => Ok(Some(statement)),
        _ => Ok(None),
    }
}

/// The public key as SPKI DER, always the 91-byte uncompressed form.
pub fn spki_der(key: &VerifyingKey) -> [u8; 91] {
    let mut der = [0u8; 91];
    der[..26].copy_from_slice(&SPKI_PREFIX);
    der[26..].copy_from_slice(key.to_sec1_point(false).as_bytes());
    der
}

/// A P-256 public key from SPKI DER, only in the 91-byte uncompressed form [`spki_der`] writes:
/// p256's own reader also takes a compressed point.
pub fn verifying_key_from_spki(der: &[u8]) -> Result<VerifyingKey, SignError> {
    let key = VerifyingKey::from_public_key_der(der).map_err(|_| SignError::InvalidKey)?;
    if spki_der(&key) != der {
        return Err(SignError::InvalidKey);
    }
    Ok(key)
}

pub fn base64url_encode(bytes: &[u8]) -> String {
    Base64UrlUnpadded::encode_string(bytes)
}

/// Unpadded base64url in its one canonical form (the unused low bits of the last character are
/// zero), or `None`.
pub fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    Base64UrlUnpadded::decode_vec(text).ok()
}
