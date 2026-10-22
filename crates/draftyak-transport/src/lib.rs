//! Native pinned TLS and payload intake for M1b.1.
//! Native callers obtain owner consent before connecting. This crate starts no listener,
//! confirms no device and grants no capability. Claim/proof processing and SAS remain absent.
//! Erasure covers owned buffers on a best-effort basis; TLS and temporary copies prevent
//! a complete memory-erasure guarantee.

mod codec {
    //! One native payload codec; claim construction and proof/SAS processing are not part of this crate.
    use crate::Error;
    use draftyak_protocol::jcs;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum CodecError {
        InvalidInput,
        Prefix,
        Encoding,
        PayloadInvalid,
        Expired,
    }
    impl CodecError {
        pub fn code(self) -> &'static str {
            match self {
                Self::InvalidInput => "PAIR_INVALID_INPUT",
                Self::Prefix => "PAIR_PREFIX",
                Self::Encoding => "PAIR_ENCODING",
                Self::PayloadInvalid => "PAIR_PAYLOAD_INVALID",
                Self::Expired => "PAIR_EXPIRED",
            }
        }
    }
    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub enum RefusalCode {
        WindowClosed,
        ClaimInvalid,
        RoleMismatch,
        ProofInvalid,
    }
    impl RefusalCode {
        pub fn code(self) -> &'static str {
            match self {
                Self::WindowClosed => "PAIR_WINDOW_CLOSED",
                Self::ClaimInvalid => "PAIR_CLAIM_INVALID",
                Self::RoleMismatch => "PAIR_ROLE_MISMATCH",
                Self::ProofInvalid => "PAIR_PROOF_INVALID",
            }
        }

        pub(crate) fn read(bytes: &[u8]) -> Result<Self, Error> {
            let value = jcs::parse_strict(bytes).map_err(|_| Error::InvalidResponse)?;
            let object = value.as_object().ok_or(Error::InvalidResponse)?;
            if object.len() != 1 {
                return Err(Error::InvalidResponse);
            }
            match object.get("code").and_then(serde_json::Value::as_str) {
                Some("PAIR_WINDOW_CLOSED") => Ok(Self::WindowClosed),
                Some("PAIR_CLAIM_INVALID") => Ok(Self::ClaimInvalid),
                Some("PAIR_ROLE_MISMATCH") => Ok(Self::RoleMismatch),
                Some("PAIR_PROOF_INVALID") => Ok(Self::ProofInvalid),
                _ => Err(Error::InvalidResponse),
            }
        }
    }

    pub(crate) fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    pub(crate) fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
        if text.len() != N * 2
            || !text
                .bytes()
                .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
        {
            return None;
        }
        let mut bytes = [0; N];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(bytes)
    }

    pub(crate) fn display_name(name: &str) -> bool {
        let blank = |c: char| {
            matches!(
                c as u32,
                0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x202f | 0x205f | 0x2800 | 0x3000
            )
        };
        let joiner = |c: char| {
            matches!(c as u32,
                0x180b..=0x180d | 0x180f | 0x200c..=0x200d | 0xfe00..=0xfe0f |
                0xe0100..=0xe01ef)
        };
        name.chars().count() <= 64
            && !name.chars().next().is_some_and(blank)
            && !name.chars().next_back().is_some_and(blank)
            && name.chars().any(|c| !blank(c) && !joiner(c))
            && !name.chars().any(|c| {
                matches!(c as u32,
                0..=0x1f | 0x7f..=0x9f | 0xad | 0x34f | 0x61c | 0x115f..=0x1160 |
                0x17b4..=0x17b5 | 0x180e |
                0x200b | 0x200e..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f |
                0x3164 | 0xfeff | 0xffa0 | 0xfff0..=0xfffb | 0x1bca0..=0x1bca3 |
                0x1d173..=0x1d17a | 0xe0000..=0xe00ff | 0xe01f0..=0xe0fff)
            })
    }
}
pub mod payload;
pub mod tls;
pub mod websocket;
pub use codec::{CodecError, RefusalCode};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    InvalidInput,
    InvalidKey,
    ConnectionFailed,
    TimedOut,
    InvalidResponse,
    Refused(RefusalCode),
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidInput => "invalid transport input",
            Self::InvalidKey => "invalid transport key",
            Self::ConnectionFailed => "pinned connection failed",
            Self::TimedOut => "transport deadline exceeded",
            Self::InvalidResponse => "invalid transport response",
            Self::Refused(code) => code.code(),
        })
    }
}
impl std::error::Error for Error {}
