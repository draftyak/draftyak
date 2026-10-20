use super::common::{device_statement, id, key, sha};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceCapability {
    Read,
    Draft,
    Organize,
    Approve,
    Admin,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PairingRole {
    Device,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfirmationPreset {
    Desktop,
    Mobile,
    Cli,
}

impl ConfirmationPreset {
    pub fn capabilities(self) -> &'static [DeviceCapability] {
        use DeviceCapability::*;
        match self {
            Self::Desktop => &[Read, Draft, Organize, Approve, Admin],
            Self::Mobile => &[Read, Draft, Organize],
            Self::Cli => &[Read, Draft],
        }
    }
}

pub fn can_confirm(capabilities: &[DeviceCapability], preset: ConfirmationPreset) -> bool {
    capabilities.contains(&DeviceCapability::Approve)
        && capabilities
            .iter()
            .enumerate()
            .all(|(index, cap)| !capabilities[..index].contains(cap))
        && preset
            .capabilities()
            .iter()
            .all(|cap| capabilities.contains(cap))
}

device_statement!(PairConfirmStatement,Wire,{candidate:String,role:PairingRole,transport_spki_sha256:String,signing_key:String,capabilities:Vec<DeviceCapability>},|s:&PairConfirmStatement|id(&s.candidate)&&s.device!=s.candidate&&sha(&s.transport_spki_sha256)&&key(&s.signing_key)&&!s.capabilities.is_empty()&&s.capabilities.windows(2).all(|pair|pair[0]<pair[1]));
