//! Admin review subjects: the immutable pending record that `admin.v1` binds through its digest.
//! Each subject is checked member by member on the JSON value, so the array and one-member map
//! forms that a serde derive would also take are refused, as TypeScript refuses them.
use super::{display_name, is_text, safe, shape, text};
use crate::{
    snapshot::{address, provider},
    statements::{
        common::{MAX_SAFE, id, key, sha},
        pair_confirm::DeviceCapability,
    },
};
use serde_json::Value;

/// The admin kinds that have a review subject; every other admin kind fails closed at review
/// and challenge until its contract adds a subject here.
pub const ADMIN_REVIEW_KINDS: &[&str] = &[
    "plugin.install",
    "plugin.upgrade",
    "account.connect",
    "account.disconnect",
    "account.mode-full",
    "security.device-capabilities",
    "data.backup",
];

/// The fewest and most ids an operation request of `kind` names. A reviewed kind names the
/// registry and candidate version, the account or device its subject describes, or nothing to
/// back up; every other admin kind keeps up to 100 until its contract adds a subject.
pub(super) fn request_ids(kind: &str) -> (usize, usize) {
    match kind {
        "plugin.install" | "plugin.upgrade" => (2, 2),
        "account.connect"
        | "account.disconnect"
        | "account.mode-full"
        | "security.device-capabilities" => (1, 1),
        "data.backup" => (0, 0),
        _ => (0, 100),
    }
}

// These subjects are DATA. Parsing never establishes candidate provenance, current selection,
// surface validation or accepted-operation authority.
fn plugin_integer(value: &Value, min: u64, max: u64) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return (min..=max).contains(&number).then_some(number);
    }
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number >= min as f64 && number <= max as f64)
        .then_some(number as u64)
}

fn plugin_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes
}

fn plugin_current_selection(value: &Value, states: &[&str]) -> bool {
    shape(
        value,
        &["versionId", "version", "registryGeneration", "state"],
    ) && is_text(value, "versionId", id)
        && is_text(value, "version", |version| plugin_text(version, 128))
        && plugin_integer(&value["registryGeneration"], 1, MAX_SAFE - 1).is_some()
        && states.contains(&text(value, "state"))
}

fn plugin_candidate_selection(value: &Value) -> bool {
    shape(
        value,
        &[
            "versionId",
            "version",
            "registryGeneration",
            "appVersion",
            "inventoryDigest",
            "manifestDigest",
            "egressDigest",
            "sendDigest",
            "surfaceDigest",
        ],
    ) && is_text(value, "versionId", id)
        && is_text(value, "version", |version| plugin_text(version, 128))
        && plugin_integer(&value["registryGeneration"], 1, MAX_SAFE).is_some()
        && is_text(value, "appVersion", |version| plugin_text(version, 128))
        && is_text(value, "inventoryDigest", sha)
        && is_text(value, "manifestDigest", sha)
        && is_text(value, "egressDigest", sha)
        && (value["sendDigest"].is_null() || is_text(value, "sendDigest", sha))
        && is_text(value, "surfaceDigest", sha)
}

fn plugin_subject(value: &Value) -> bool {
    shape(
        value,
        &[
            "v",
            "intent",
            "registryId",
            "pluginId",
            "ownerUserId",
            "epoch",
            "from",
            "to",
        ],
    ) && plugin_integer(&value["v"], 1, 1).is_some()
        && is_text(value, "registryId", id)
        && is_text(value, "pluginId", |plugin| plugin_text(plugin, 64))
        && is_text(value, "ownerUserId", id)
        && plugin_integer(&value["epoch"], 0, MAX_SAFE).is_some()
        && plugin_candidate_selection(&value["to"])
        && value["registryId"] != value["to"]["versionId"]
}

fn plugin_selected_transition(value: &Value, states: &[&str], upgrade: bool) -> bool {
    let (from, to) = (&value["from"], &value["to"]);
    let versions_match = if upgrade {
        to["versionId"] != from["versionId"] && to["version"] != from["version"]
    } else {
        to["versionId"] == from["versionId"] && to["version"] == from["version"]
    };
    plugin_current_selection(from, states)
        && versions_match
        && plugin_integer(&from["registryGeneration"], 1, MAX_SAFE - 1)
            .zip(plugin_integer(&to["registryGeneration"], 1, MAX_SAFE))
            .is_some_and(|(from, to)| to == from + 1)
}

pub(super) fn plugin_install_subject(value: &Value) -> bool {
    plugin_subject(value)
        && match text(value, "intent") {
            "install" if value["from"].is_null() => {
                plugin_integer(&value["to"]["registryGeneration"], 1, 1).is_some()
            }
            "install" => plugin_selected_transition(value, &["staged"], false),
            "re-enable" => plugin_selected_transition(value, &["disabled", "quarantined"], false),
            _ => false,
        }
}

pub(super) fn plugin_upgrade_subject(value: &Value) -> bool {
    plugin_subject(value)
        && value["intent"] == "upgrade"
        && plugin_selected_transition(value, &["staged", "disabled", "quarantined"], true)
}

fn alias(s: &str) -> bool {
    let bytes = s.as_bytes();
    (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

// A connection review is proposed account DATA, not an existing account or an enrollment grant.
pub(super) fn account_connect_subject(value: &Value) -> bool {
    plugin_integer(&value["v"], 1, 1).is_some()
        && is_text(value, "account", id)
        && is_text(value, "ownerUserId", id)
        && is_text(value, "alias", alias)
        && ["full", "read_only"].contains(&text(value, "mode"))
        && plugin_integer(&value["historyLimitDays"], 1, 365).is_some()
        && plugin_integer(&value["disclosureVersion"], 1, MAX_SAFE).is_some()
        && is_text(value, "pluginInstanceId", id)
        && match text(value, "channel") {
            "email" => {
                shape(
                    value,
                    &[
                        "v",
                        "channel",
                        "account",
                        "ownerUserId",
                        "alias",
                        "mode",
                        "historyLimitDays",
                        "disclosureVersion",
                        "pluginInstanceId",
                        "address",
                    ],
                ) && is_text(value, "address", address)
            }
            "chat" => {
                shape(
                    value,
                    &[
                        "v",
                        "channel",
                        "account",
                        "ownerUserId",
                        "alias",
                        "mode",
                        "historyLimitDays",
                        "disclosureVersion",
                        "pluginInstanceId",
                        "teamId",
                        "selfUserId",
                    ],
                ) && (value["teamId"].is_null() || is_text(value, "teamId", provider))
                    && is_text(value, "selfUserId", provider)
            }
            _ => false,
        }
}

// Only the values this contract defines: a later capability stays refused until its own
// contract decides how a grant treats it.
fn capability(s: &str) -> Option<DeviceCapability> {
    match s {
        "read" => Some(DeviceCapability::Read),
        "draft" => Some(DeviceCapability::Draft),
        "organize" => Some(DeviceCapability::Organize),
        "approve" => Some(DeviceCapability::Approve),
        "admin" => Some(DeviceCapability::Admin),
        _ => None,
    }
}

fn capability_list(value: &Value) -> Option<Vec<DeviceCapability>> {
    let list = value
        .as_array()?
        .iter()
        .map(|item| item.as_str().and_then(capability))
        .collect::<Option<Vec<_>>>()?;
    (!list.is_empty() && list.windows(2).all(|pair| pair[0] < pair[1])).then_some(list)
}

pub(super) fn account_subject(value: &Value) -> bool {
    is_text(value, "account", id)
        && is_text(value, "alias", alias)
        && safe(&value["createdAt"])
        && match text(value, "channel") {
            "email" => {
                shape(
                    value,
                    &["channel", "account", "alias", "address", "createdAt"],
                ) && is_text(value, "address", address)
            }
            "chat" => {
                shape(
                    value,
                    &[
                        "channel",
                        "account",
                        "alias",
                        "teamId",
                        "selfUserId",
                        "createdAt",
                    ],
                ) && (value["teamId"].is_null() || is_text(value, "teamId", provider))
                    && is_text(value, "selfUserId", provider)
            }
            _ => false,
        }
}

pub(super) fn device_capabilities_subject(value: &Value) -> bool {
    let (Some(current), Some(new)) = (
        capability_list(&value["current"]),
        capability_list(&value["capabilities"]),
    ) else {
        return false;
    };
    let added =
        |capability: DeviceCapability| new.contains(&capability) && !current.contains(&capability);
    new.len() > current.len()
        && current.iter().all(|capability| new.contains(capability))
        && !added(DeviceCapability::Approve)
        && (!added(DeviceCapability::Admin) || current.contains(&DeviceCapability::Approve))
        && shape(
            value,
            &[
                "device",
                "name",
                "transportSpkiSha256",
                "signingKey",
                "pairedAt",
                "current",
                "capabilities",
            ],
        )
        && is_text(value, "device", id)
        && is_text(value, "name", display_name)
        && is_text(value, "transportSpkiSha256", sha)
        && is_text(value, "signingKey", key)
        && safe(&value["pairedAt"])
}

pub(super) fn data_backup_subject(value: &Value) -> bool {
    shape(value, &["scope"]) && value["scope"] == "backup"
}

/// The signer holds admin and every capability the target will hold, so no grant exceeds it.
pub fn can_grant(held: &[DeviceCapability], subject: &Value) -> bool {
    device_capabilities_subject(subject)
        && held
            .iter()
            .enumerate()
            .all(|(index, capability)| !held[..index].contains(capability))
        && held.contains(&DeviceCapability::Admin)
        && capability_list(&subject["capabilities"])
            .is_some_and(|new| new.iter().all(|capability| held.contains(capability)))
}
