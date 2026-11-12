//! Admin review subjects: the immutable pending record that `admin.v1` binds through its digest.
//! Each subject is checked member by member on the JSON value, so the array and one-member map
//! forms that a serde derive would also take are refused, as TypeScript refuses them.
use super::{display_name, is_text, safe, shape, text};
use crate::{
    snapshot::{address, provider},
    statements::{
        common::{id, key, sha},
        pair_confirm::DeviceCapability,
    },
};
use serde_json::Value;

/// The admin kinds that have a review subject; every other admin kind fails closed at review
/// and challenge until its contract adds a subject here.
pub const ADMIN_REVIEW_KINDS: &[&str] = &[
    "account.disconnect",
    "account.mode-full",
    "security.device-capabilities",
    "data.backup",
];

/// The fewest and most ids an operation request of `kind` names. A reviewed kind names the
/// account or device its subject describes, or nothing to back up; every other admin kind keeps
/// up to 100 until its contract adds a subject.
pub(super) fn request_ids(kind: &str) -> (usize, usize) {
    match kind {
        "account.disconnect" | "account.mode-full" | "security.device-capabilities" => (1, 1),
        "data.backup" => (0, 0),
        _ => (0, 100),
    }
}

fn alias(s: &str) -> bool {
    let bytes = s.as_bytes();
    (1..=32).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
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
