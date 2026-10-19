use super::common::{device_statement, id, key, sha};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
device_statement!(PairConfirmStatement,Wire,{candidate:String,role:PairingRole,transport_spki_sha256:String,signing_key:String,capabilities:Vec<DeviceCapability>},|s:&PairConfirmStatement|id(&s.candidate)&&s.device!=s.candidate&&sha(&s.transport_spki_sha256)&&key(&s.signing_key)&&!s.capabilities.is_empty()&&s.capabilities.iter().enumerate().all(|(index,cap)|!s.capabilities[..index].contains(cap)));
