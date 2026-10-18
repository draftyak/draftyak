//! SHA-256 as lower-case hex, of bytes, of a value's JCS and of a header list (D6).

use crate::jcs::{JcsError, canonicalize};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write;

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        })
}

pub fn jcs_sha256<T: Serialize + ?Sized>(value: &T) -> Result<String, JcsError> {
    canonicalize(value).map(|text| sha256_hex(text.as_bytes()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum HeadersError {
    #[error("HEADERS_INVALID_NAME: a header name isn't an RFC 9110 token")]
    InvalidName,
    #[error("HEADERS_INVALID_VALUE: a header value isn't visible ASCII")]
    InvalidValue,
}

impl HeadersError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidName => "HEADERS_INVALID_NAME",
            Self::InvalidValue => "HEADERS_INVALID_VALUE",
        }
    }
}

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}

// Visible ASCII, with spaces or tabs only between visible characters.
fn is_field_value(value: &str) -> bool {
    let visible = |byte: &u8| (b'!'..=b'~').contains(byte);
    let bytes = value.as_bytes();
    bytes.first().is_none_or(visible)
        && bytes.last().is_none_or(visible)
        && bytes
            .iter()
            .all(|byte| visible(byte) || *byte == b' ' || *byte == b'\t')
}

/// The SHA-256 of the JCS of `[[name, value], …]`, names lower-cased, sorted by name and then
/// value, so the order and case of the headers don't matter but every byte does. Names and values
/// are ASCII, so byte order is the UTF-16 order JCS sorts by.
pub fn headers_sha256<N: AsRef<str>, V: AsRef<str>>(
    headers: &[(N, V)],
) -> Result<String, HeadersError> {
    let mut pairs = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let (name, value) = (name.as_ref(), value.as_ref());
        if !is_token(name) {
            return Err(HeadersError::InvalidName);
        }
        if !is_field_value(value) {
            return Err(HeadersError::InvalidValue);
        }
        pairs.push([name.to_ascii_lowercase(), value.to_owned()]);
    }
    pairs.sort_unstable();
    Ok(jcs_sha256(&pairs).expect("pairs of strings always have a JSON form"))
}
