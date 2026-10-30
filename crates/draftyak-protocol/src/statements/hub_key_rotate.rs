use super::common::{MAX_SAFE, key, sha};
use serde::{Deserialize, Deserializer, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyUse {
    Identity,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubKeyRotateStatement {
    pub v: u8,
    pub hub: String,
    pub epoch: u64,
    pub key_use: KeyUse,
    pub new_key: String,
    pub iat: u64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Wire {
    v: u8,
    hub: String,
    epoch: u64,
    key_use: KeyUse,
    new_key: String,
    iat: u64,
}
impl<'de> Deserialize<'de> for HubKeyRotateStatement {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        let w: Wire = super::decode_from(decoder, "STATEMENT_INVALID")?;
        let s = Self {
            v: w.v,
            hub: w.hub,
            epoch: w.epoch,
            key_use: w.key_use,
            new_key: w.new_key,
            iat: w.iat,
        };
        if !s.valid() {
            return Err(serde::de::Error::custom("STATEMENT_INVALID"));
        }
        Ok(s)
    }
}
impl HubKeyRotateStatement {
    pub fn valid(&self) -> bool {
        self.v == 1
            && sha(&self.hub)
            && (0..=MAX_SAFE).contains(&self.epoch)
            && key(&self.new_key)
            && self.iat <= MAX_SAFE
    }
}
