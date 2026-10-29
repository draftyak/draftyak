//! The hub's mode, scheduler and Pause sync state, and the two scheduling routes a device reads.
//! Answers are checked against their caps as received, before strict parsing.
use crate::{
    jcs::{canonicalize, parse_strict},
    scheduled_summary::ScheduledSummary,
    statements::{common::MAX_SAFE, pair_confirm::DeviceCapability},
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

pub const SCHEDULING_STATUS_BYTES: usize = 4096;
pub const SCHEDULED_SUMMARY_BYTES: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HubMode {
    Sidecar,
    Service,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SchedulerState {
    Running,
    Unavailable,
}
/// `sync_paused` is the hub's own Pause sync state, so it survives app and hub restarts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulingStatus {
    pub mode: HubMode,
    pub scheduler: SchedulerState,
    pub sync_paused: bool,
}
/// An object with exactly these members; serde's derives would also take a sequence.
pub(crate) fn members(value: &Value, names: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.len() == names.len() && names.iter().all(|name| m.contains_key(*name)))
}
impl SchedulingStatus {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        if !members(value, &["mode", "scheduler", "syncPaused"]) {
            return None;
        }
        let mode = match value["mode"].as_str()? {
            "sidecar" => HubMode::Sidecar,
            "service" => HubMode::Service,
            _ => return None,
        };
        let scheduler = match value["scheduler"].as_str()? {
            "running" => SchedulerState::Running,
            "unavailable" => SchedulerState::Unavailable,
            _ => return None,
        };
        Some(Self {
            mode,
            scheduler,
            sync_paused: value["syncPaused"].as_bool()?,
        })
    }
}
impl<'de> Deserialize<'de> for SchedulingStatus {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        Self::from_json(&Value::deserialize(decoder)?)
            .ok_or_else(|| serde::de::Error::custom("SCHEDULING_STATUS_INVALID"))
    }
}
/// The status answer as received: at most 4 KiB, then strict JSON of the exact form.
pub fn parse_scheduling_status(bytes: &[u8]) -> Option<SchedulingStatus> {
    if bytes.len() > SCHEDULING_STATUS_BYTES {
        return None;
    }
    SchedulingStatus::from_json(&parse_strict(bytes).ok()?)
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    pub role: &'static str,
    pub capability: &'static str,
    pub confirmation: &'static str,
    pub request: &'static str,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub response: &'static str,
}
const fn read_route(
    id: &'static str,
    path: &'static str,
    response_bytes: usize,
    response: &'static str,
) -> Route {
    Route {
        id,
        method: "GET",
        path,
        role: "device",
        capability: "read",
        confirmation: "confirmed",
        request: "none",
        request_bytes: 0,
        response_bytes,
        response,
    }
}
pub const HUB_RUNTIME_ROUTES: &[Route] = &[
    read_route(
        "scheduling",
        "/device/v1/scheduling",
        SCHEDULING_STATUS_BYTES,
        "SchedulingStatus",
    ),
    read_route(
        "scheduling-outbox",
        "/device/v1/scheduling/outbox",
        SCHEDULED_SUMMARY_BYTES,
        "ScheduledSummary",
    ),
];
pub fn catalogue() -> Value {
    json!({ "routes": HUB_RUNTIME_ROUTES })
}
fn route(name: &str) -> Option<&'static Route> {
    HUB_RUNTIME_ROUTES.iter().find(|r| r.id == name)
}
pub fn check_route_length(name: &str, direction: &str, byte_length: usize) -> bool {
    route(name).is_some_and(|r| match direction {
        "request" => byte_length <= r.request_bytes,
        "response" => byte_length <= r.response_bytes,
        _ => false,
    })
}
/// Both routes take no body: any received bytes, even none at all, are refused.
pub fn check_route_request_bytes(name: &str, bytes: Option<&[u8]>) -> bool {
    route(name).is_some_and(|r| r.request == "none" && bytes.is_none())
}
fn answer(r: &Route, value: &Value) -> bool {
    match r.response {
        "SchedulingStatus" => SchedulingStatus::from_json(value).is_some(),
        "ScheduledSummary" => ScheduledSummary::from_json(value).is_some(),
        _ => false,
    }
}
pub fn check_route_response_bytes(name: &str, bytes: &[u8]) -> bool {
    route(name).is_some_and(|r| {
        bytes.len() <= r.response_bytes && parse_strict(bytes).is_ok_and(|v| answer(r, &v))
    })
}
/// A convenience for a value without its received bytes: the cap applies to its canonical JSON.
pub fn check_route_response(name: &str, value: &Value) -> bool {
    route(name).is_some_and(|r| {
        canonicalize(value).is_ok_and(|s| s.len() <= r.response_bytes) && answer(r, value)
    })
}
fn safe(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= MAX_SAFE)
}
/// The device API's peer form: a known, non-revoked device confirmed in the current epoch that
/// holds `read`.
pub fn route_allows(name: &str, peer: &Value) -> bool {
    let Some(r) = route(name) else {
        return false;
    };
    let Ok(capabilities) =
        serde_json::from_value::<Vec<DeviceCapability>>(peer["capabilities"].clone())
    else {
        return false;
    };
    members(
        peer,
        &[
            "role",
            "known",
            "revoked",
            "epoch",
            "confirmedEpoch",
            "capabilities",
            "sidecarClaim",
            "bootstrapDone",
        ],
    ) && peer["role"] == r.role
        && peer["known"] == true
        && peer["revoked"] == false
        && safe(&peer["epoch"])
        && (peer["confirmedEpoch"].is_null() || safe(&peer["confirmedEpoch"]))
        && peer["sidecarClaim"].is_boolean()
        && peer["bootstrapDone"].is_boolean()
        && capabilities
            .iter()
            .enumerate()
            .all(|(i, c)| !capabilities[..i].contains(c))
        && peer["confirmedEpoch"] == peer["epoch"]
        && peer["capabilities"]
            .as_array()
            .is_some_and(|held| held.contains(&json!(r.capability)))
}
