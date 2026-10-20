//! Strict native pairing-code intake. The public preview contains no secret or address.
use std::{
    collections::HashSet,
    fmt,
    net::{Ipv4Addr, Ipv6Addr},
};

use draftyak_protocol::{jcs, sign};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::codec::{CodecError, display_name, unhex};

pub const PREFIX: &str = "draftyak-pair:v1:";
pub const MAX_PAYLOAD_LENGTH: usize = 1000;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WirePayload {
    hid: String,
    addr: Vec<String>,
    pid: String,
    sec: String,
    exp: u64,
    name: String,
    role: String,
}

impl Drop for WirePayload {
    fn drop(&mut self) {
        self.sec.zeroize();
    }
}

pub struct Payload(WirePayload);
impl fmt::Debug for Payload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Payload([redacted])")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Preview {
    pub name: String,
    pub hub_id: String,
    pub expires_at_ms: u64,
}

/// Public, non-secret fingerprint used by the trusted pairing preview.
pub fn hub_id(pin: &[u8; 32]) -> String {
    let upper = crate::codec::hex(&pin[..8]).to_ascii_uppercase();
    format!(
        "DYK-{}-{}-{}-{}",
        &upper[..4],
        &upper[4..8],
        &upper[8..12],
        &upper[12..]
    )
}

impl Payload {
    pub fn decode(text: &str, now_ms: u64) -> Result<Self, CodecError> {
        if now_ms > MAX_SAFE_INTEGER {
            return Err(CodecError::InvalidInput);
        }
        let encoded = text.strip_prefix(PREFIX).ok_or(CodecError::Prefix)?;
        if text.len() > MAX_PAYLOAD_LENGTH {
            return Err(CodecError::Encoding);
        }
        let bytes = sign::base64url_decode(encoded).ok_or(CodecError::Encoding)?;
        if !jcs::is_canonical(&bytes) {
            return Err(CodecError::Encoding);
        }
        let value = jcs::parse_strict(&bytes).map_err(|_| CodecError::Encoding)?;
        let payload: WirePayload =
            serde_json::from_value(value).map_err(|_| CodecError::PayloadInvalid)?;
        let fixed16 = |text: &str| sign::base64url_decode(text).is_some_and(|v| v.len() == 16);
        if unhex::<32>(&payload.hid).is_none()
            || !fixed16(&payload.pid)
            || !fixed16(&payload.sec)
            || payload.exp > MAX_SAFE_INTEGER
            || !display_name(&payload.name)
            || payload.role != "device"
            || payload.addr.is_empty()
            || payload.addr.len() > 8
            || !payload.addr.iter().all(|v| address(v))
            || payload.addr.iter().collect::<HashSet<_>>().len() != payload.addr.len()
        {
            return Err(CodecError::PayloadInvalid);
        }
        if payload.exp < now_ms {
            return Err(CodecError::Expired);
        }
        Ok(Self(payload))
    }

    /// Native QR/dialog round-trip only. This value is never a renderer model.
    pub fn encode_native(&self) -> String {
        format!(
            "{PREFIX}{}",
            sign::base64url_encode(
                jcs::canonicalize(&self.0)
                    .expect("validated payload")
                    .as_bytes()
            )
        )
    }

    pub fn preview(&self) -> Preview {
        Preview {
            name: self.0.name.clone(),
            hub_id: hub_id(&self.hub_pin()),
            expires_at_ms: self.0.exp,
        }
    }

    pub fn hub_pin(&self) -> [u8; 32] {
        unhex(&self.0.hid).expect("validated pin")
    }
    pub fn native_addresses(&self) -> &[String] {
        &self.0.addr
    }
    pub fn expires_at_ms(&self) -> u64 {
        self.0.exp
    }
    /// Native exporter context; never a confirmation or authorization handle.
    pub fn exporter_context(&self) -> [u8; 16] {
        sign::base64url_decode(&self.0.pid)
            .expect("validated pid")
            .try_into()
            .expect("16 bytes")
    }
}

pub(crate) fn address(text: &str) -> bool {
    let Some((host, port)) = text.rsplit_once(':') else {
        return false;
    };
    if port.starts_with('0')
        || !port.bytes().all(|b| b.is_ascii_digit())
        || port.parse::<u16>().is_err()
    {
        return false;
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return (1..=223).contains(&ip.octets()[0]);
    }
    if let Some(ip) = host.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        return !ip.contains('.')
            && !ip.contains('%')
            && !ip.bytes().any(|b| b.is_ascii_uppercase())
            && ip
                .parse::<Ipv6Addr>()
                .is_ok_and(|ip| !ip.is_unspecified() && !ip.is_multicast());
    }
    let last = host.rsplit('.').next().unwrap_or("");
    host.len() <= 253
        && !last.bytes().all(|b| b.is_ascii_digit())
        && !last
            .strip_prefix("0x")
            .is_some_and(|digits| digits.bytes().all(|b| b.is_ascii_hexdigit()))
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}
