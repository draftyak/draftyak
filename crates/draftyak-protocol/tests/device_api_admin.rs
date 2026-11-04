use draftyak_protocol::{
    device_api::{self as api, admin},
    hash::jcs_sha256,
    jcs::canonicalize,
    sign::{base64url_decode, base64url_encode},
    statements::{admin::ADMIN_KINDS, pair_confirm::DeviceCapability},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

const ORDER: [&str; 5] = ["read", "draft", "organize", "approve", "admin"];
const OTHER_ID: &str = "01JAZ3W3B6Q8M2V0G5T9K4X7RF";

fn vectors() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/device-api/admin.json");
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn case(vectors: &Value, id: &str) -> Value {
    vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == id)
        .unwrap_or_else(|| panic!("missing vector {id}"))
        .clone()
}
fn set(mask: u32) -> Vec<&'static str> {
    ORDER
        .iter()
        .enumerate()
        .filter(|(bit, _)| mask & (1 << bit) != 0)
        .map(|(_, capability)| *capability)
        .collect()
}
fn held(value: &Value) -> Option<Vec<DeviceCapability>> {
    serde_json::from_value(value.clone()).ok()
}
fn review(kind: &str, subject: &Value) -> Value {
    json!({"id":"01JAZ3W3B6Q8M2V0G5T9K4X7RJ","kind":kind,"digest":jcs_sha256(subject).unwrap(),
        "subject":subject,"expiresAt":1_760_806_920_000_u64,"remainingMs":120000})
}
fn statement(case: &Value) -> Value {
    let text = case["challenge"]["statement"].as_str().unwrap();
    serde_json::from_slice(&base64url_decode(text).unwrap()).unwrap()
}
fn with_statement(case: &Value, statement: &Value) -> Value {
    let mut changed = case.clone();
    changed["challenge"]["statement"] = json!(base64url_encode(
        canonicalize(statement).unwrap().as_bytes()
    ));
    changed
}
fn matches(case: &Value) -> bool {
    api::check_challenge(
        &case["challenge"],
        &case["review"],
        &case["request"],
        &case["context"],
    )
}

// Invented review DATA only: no candidate, process or accepted-context provenance.
fn plugin_upgrade_data() -> Value {
    json!({
        "v": 1,
        "intent": "upgrade",
        "registryId": "01JAZ3W3B6Q8M2V0G5T9K4X7RA",
        "pluginId": "channel-gmail",
        "ownerUserId": "01JAZ3W3B6Q8M2V0G5T9K4X7RD",
        "epoch": 1,
        "from": {
            "versionId": "01JAZ3W3B6Q8M2V0G5T9K4X7RB",
            "version": "1.0.0",
            "registryGeneration": 7,
            "state": "disabled"
        },
        "to": {
            "versionId": "01JAZ3W3B6Q8M2V0G5T9K4X7RC",
            "version": "2.0.0",
            "registryGeneration": 8,
            "appVersion": "0.0.0",
            "inventoryDigest": "a".repeat(64),
            "manifestDigest": "b".repeat(64),
            "egressDigest": "c".repeat(64),
            "sendDigest": null,
            "surfaceDigest": "d".repeat(64)
        }
    })
}

#[test]
fn plugin_review_data_preserves_absent_staged_and_reenable_transitions() {
    let upgrade = plugin_upgrade_data();
    assert!(api::check_schema("AdminPluginUpgradeSubject", &upgrade));
    assert!(!api::check_schema("AdminPluginInstallSubject", &upgrade));
    for state in ["staged", "disabled", "quarantined"] {
        let mut changed = upgrade.clone();
        changed["from"]["state"] = json!(state);
        assert!(api::check_schema("AdminPluginUpgradeSubject", &changed));
    }
    let mut install = upgrade.clone();
    install["intent"] = json!("install");
    install["from"] = Value::Null;
    install["to"]["registryGeneration"] = json!(1);
    assert!(api::check_schema("AdminPluginInstallSubject", &install));
    assert!(!api::check_schema("AdminPluginUpgradeSubject", &install));
    let mut staged = upgrade.clone();
    staged["intent"] = json!("install");
    staged["from"]["state"] = json!("staged");
    staged["to"]["versionId"] = staged["from"]["versionId"].clone();
    staged["to"]["version"] = staged["from"]["version"].clone();
    assert!(api::check_schema("AdminPluginInstallSubject", &staged));
    for state in ["disabled", "quarantined"] {
        let mut changed = staged.clone();
        changed["from"]["state"] = json!(state);
        assert!(!api::check_schema("AdminPluginInstallSubject", &changed));
        changed["intent"] = json!("re-enable");
        assert!(api::check_schema("AdminPluginInstallSubject", &changed));
    }
    let mut changed = install.clone();
    changed["intent"] = json!("re-enable");
    assert!(!api::check_schema("AdminPluginInstallSubject", &changed));
    changed = staged.clone();
    changed["intent"] = json!("re-enable");
    assert!(!api::check_schema("AdminPluginInstallSubject", &changed));
    for kind in ["plugin.install", "plugin.upgrade"] {
        let subject = if kind == "plugin.install" {
            &install
        } else {
            &upgrade
        };
        assert!(api::check_schema("OperationReview", &review(kind, subject)));
        assert!(!api::check_schema(
            "OperationReview",
            &review("plugin.enable", subject)
        ));
    }
}

#[test]
fn plugin_subject_objects_are_closed_and_every_member_is_required() {
    let original = plugin_upgrade_data();
    for scope in ["", "from", "to"] {
        let object = if scope.is_empty() {
            &original
        } else {
            &original[scope]
        };
        for key in object.as_object().unwrap().keys() {
            let mut changed = original.clone();
            let target = if scope.is_empty() {
                &mut changed
            } else {
                &mut changed[scope]
            };
            target.as_object_mut().unwrap().remove(key);
            assert!(
                !api::check_schema("AdminPluginUpgradeSubject", &changed),
                "missing {scope}.{key}"
            );
        }
        let mut changed = original.clone();
        let target = if scope.is_empty() {
            &mut changed
        } else {
            &mut changed[scope]
        };
        target["unknown"] = json!(true);
        assert!(!api::check_schema("AdminPluginUpgradeSubject", &changed));
        let mut changed = original.clone();
        if scope.is_empty() {
            changed = json!([original.clone()]);
        } else {
            changed[scope] = json!([original[scope].clone()]);
        }
        assert!(!api::check_schema("AdminPluginUpgradeSubject", &changed));
    }
    assert!(!api::check_schema(
        "AdminPluginUpgradeSubject",
        &json!({"plugin.upgrade": original})
    ));
}

#[test]
fn plugin_scalar_and_relation_refusals_preserve_the_exact_data_contract() {
    let original = plugin_upgrade_data();
    let invalid = [
        ("", "v", json!(2)),
        ("", "intent", json!("install")),
        ("", "registryId", json!("invalid")),
        ("", "registryId", original["to"]["versionId"].clone()),
        ("", "ownerUserId", Value::Null),
        ("", "pluginId", json!("")),
        ("", "pluginId", json!("a".repeat(65))),
        ("", "epoch", json!(-1)),
        ("", "epoch", json!(1.5)),
        ("", "epoch", json!(9_007_199_254_740_992_u64)),
        ("from", "versionId", json!("invalid")),
        ("from", "version", json!("")),
        ("from", "version", json!("v".repeat(129))),
        ("from", "state", json!("active")),
        ("from", "registryGeneration", json!(0)),
        (
            "from",
            "registryGeneration",
            json!(9_007_199_254_740_991_u64),
        ),
        ("to", "versionId", original["from"]["versionId"].clone()),
        ("to", "version", original["from"]["version"].clone()),
        ("to", "version", json!("v".repeat(129))),
        ("to", "registryGeneration", json!(7)),
        ("to", "registryGeneration", json!(9_007_199_254_740_992_u64)),
        ("to", "appVersion", json!("")),
        ("to", "appVersion", json!("v".repeat(129))),
        ("to", "sendDigest", json!(true)),
        ("to", "surfaceDigest", Value::Null),
    ];
    for (scope, key, value) in invalid {
        let mut changed = original.clone();
        if scope.is_empty() {
            changed[key] = value;
        } else {
            changed[scope][key] = value;
        }
        assert!(
            !api::check_schema("AdminPluginUpgradeSubject", &changed),
            "{scope}.{key}"
        );
    }
    for field in [
        "inventoryDigest",
        "manifestDigest",
        "egressDigest",
        "sendDigest",
        "surfaceDigest",
    ] {
        for digest in ["f".repeat(63), "A".repeat(64)] {
            let mut changed = original.clone();
            changed["to"][field] = json!(digest);
            assert!(
                !api::check_schema("AdminPluginUpgradeSubject", &changed),
                "{field}"
            );
        }
    }
    let mut changed = original;
    changed["to"]["sendDigest"] = json!("e".repeat(64));
    assert!(api::check_schema("AdminPluginUpgradeSubject", &changed));
}

#[test]
fn plugin_utf8_byte_bounds_and_safe_integer_edges_match_the_wire() {
    let mut value = plugin_upgrade_data();
    value["pluginId"] = json!("😀".repeat(16));
    value["from"]["version"] = json!("😀".repeat(32));
    value["to"]["version"] = json!("𝄞".repeat(32));
    value["to"]["appVersion"] = json!("😀".repeat(32));
    value["epoch"] = json!(9_007_199_254_740_991_u64);
    value["from"]["registryGeneration"] = json!(9_007_199_254_740_990_u64);
    value["to"]["registryGeneration"] = json!(9_007_199_254_740_991_u64);
    assert!(api::check_schema("AdminPluginUpgradeSubject", &value));
    let mut changed = value.clone();
    changed["pluginId"] = json!(format!("{}a", value["pluginId"].as_str().unwrap()));
    assert!(!api::check_schema("AdminPluginUpgradeSubject", &changed));
    for (scope, field) in [("from", "version"), ("to", "version"), ("to", "appVersion")] {
        let mut changed = value.clone();
        changed[scope][field] = json!(format!("{}a", value[scope][field].as_str().unwrap()));
        assert!(!api::check_schema("AdminPluginUpgradeSubject", &changed));
    }
    let mut integral = plugin_upgrade_data();
    integral["v"] = json!(1.0);
    integral["epoch"] = json!(1.0);
    integral["from"]["registryGeneration"] = json!(7.0);
    integral["to"]["registryGeneration"] = json!(8.0);
    assert!(api::check_schema("AdminPluginUpgradeSubject", &integral));
}

#[test]
fn plugin_operation_requests_require_two_distinct_ulids() {
    let data = plugin_upgrade_data();
    let registry = data["registryId"].clone();
    let candidate = data["to"]["versionId"].clone();
    for kind in ["plugin.install", "plugin.upgrade"] {
        assert!(api::check_schema(
            "OperationRequest",
            &json!({"kind":kind,"ids":[registry,candidate]})
        ));
        for ids in [
            json!([]),
            json!([registry]),
            json!([registry, candidate, OTHER_ID]),
            json!([registry, registry]),
            json!([registry, "invalid"]),
        ] {
            assert!(!api::check_schema(
                "OperationRequest",
                &json!({"kind":kind,"ids":ids})
            ));
        }
    }
}

#[test]
fn plugin_admin_challenge_binds_every_current_and_candidate_data_member() {
    let vectors = vectors();
    let mut original = case(&vectors, "admin-challenge-account.disconnect-email");
    let subject = plugin_upgrade_data();
    original["review"]["kind"] = json!("plugin.upgrade");
    original["review"]["subject"] = subject.clone();
    original["review"]["digest"] = json!(jcs_sha256(&subject).unwrap());
    let mut signed = statement(&original);
    signed["kind"] = json!("plugin.upgrade");
    signed["digest"] = original["review"]["digest"].clone();
    signed["epoch"] = subject["epoch"].clone();
    let original = with_statement(&original, &signed);
    assert!(matches(&original));
    let mut other_epoch = signed.clone();
    other_epoch["epoch"] = json!(2);
    let other_epoch = with_statement(&original, &other_epoch);
    assert!(api::check_schema("Challenge", &other_epoch["challenge"]));
    assert!(api::check_schema("OperationReview", &other_epoch["review"]));
    assert!(
        !matches(&other_epoch),
        "the same digest never substitutes for the reviewed epoch"
    );
    let changes = [
        ("", "registryId", json!(OTHER_ID)),
        ("", "pluginId", json!("channel-slack")),
        ("", "ownerUserId", json!(OTHER_ID)),
        ("", "epoch", json!(2)),
        ("from", "versionId", json!(OTHER_ID)),
        ("from", "version", json!("1.0.1")),
        ("from", "state", json!("staged")),
        ("to", "versionId", json!(OTHER_ID)),
        ("to", "version", json!("2.0.1")),
        ("to", "appVersion", json!("0.0.1")),
        ("to", "inventoryDigest", json!("e".repeat(64))),
        ("to", "manifestDigest", json!("e".repeat(64))),
        ("to", "egressDigest", json!("e".repeat(64))),
        ("to", "sendDigest", json!("e".repeat(64))),
        ("to", "surfaceDigest", json!("e".repeat(64))),
    ];
    for (scope, field, value) in changes {
        let mut changed = original.clone();
        if scope.is_empty() {
            changed["review"]["subject"][field] = value;
        } else {
            changed["review"]["subject"][scope][field] = value;
        }
        let subject = &changed["review"]["subject"];
        assert!(
            api::check_schema("AdminPluginUpgradeSubject", subject),
            "{scope}.{field}"
        );
        changed["review"]["digest"] = json!(jcs_sha256(subject).unwrap());
        assert!(api::check_schema("OperationReview", &changed["review"]));
        assert!(!matches(&changed), "old statement: {scope}.{field}");
    }
    let mut changed = original;
    changed["review"]["subject"]["from"]["registryGeneration"] = json!(8);
    changed["review"]["subject"]["to"]["registryGeneration"] = json!(9);
    changed["review"]["digest"] = json!(jcs_sha256(&changed["review"]["subject"]).unwrap());
    assert!(api::check_schema("OperationReview", &changed["review"]));
    assert!(!matches(&changed));
}

#[test]
fn review_kinds_are_exactly_the_admin_kinds_with_a_review_member() {
    let vectors = vectors();
    assert_eq!(json!(admin::ADMIN_REVIEW_KINDS), vectors["reviewKinds"]);
    let ordered: Vec<&str> = ADMIN_KINDS
        .iter()
        .copied()
        .filter(|kind| admin::ADMIN_REVIEW_KINDS.contains(kind))
        .collect();
    assert_eq!(ordered, admin::ADMIN_REVIEW_KINDS);
    let subjects: Vec<Value> = [
        "plugin-install",
        "plugin-upgrade",
        "email",
        "chat",
        "device",
        "backup",
    ]
    .iter()
    .map(|name| case(&vectors, &format!("admin-subject-{name}"))["value"].clone())
    .collect();
    let reviewed: Vec<&str> = ADMIN_KINDS
        .iter()
        .copied()
        .chain(["plugin.enable", "pair-confirm", "agent-session"])
        .filter(|kind| {
            subjects
                .iter()
                .any(|subject| api::check_schema("OperationReview", &review(kind, subject)))
        })
        .collect();
    assert_eq!(reviewed, admin::ADMIN_REVIEW_KINDS);
}

#[test]
fn device_subjects_widen_strictly_without_approve_and_grants_stay_within_the_signer() {
    let vectors = vectors();
    for grant in vectors["grants"].as_array().unwrap() {
        let allowed =
            held(&grant["held"]).is_some_and(|held| admin::can_grant(&held, &grant["subject"]));
        assert_eq!(
            allowed,
            grant["valid"].as_bool().unwrap(),
            "{}",
            grant["id"]
        );
    }
    let base = case(&vectors, "admin-subject-device")["value"].clone();
    let (approve, admin_bit) = (8, 16);
    let (mut subjects, mut grants) = (0_u64, 0_u64);
    for current in 0..32 {
        for next in 0..32 {
            let mut subject = base.clone();
            subject["current"] = json!(set(current));
            subject["capabilities"] = json!(set(next));
            let valid = api::check_schema("AdminDeviceCapabilitiesSubject", &subject);
            let added = next & !current;
            let expected = current != 0
                && next & current == current
                && added != 0
                && added & approve == 0
                && (added & admin_bit == 0 || current & approve != 0);
            assert_eq!(valid, expected, "{current:05b} -> {next:05b}");
            subjects += u64::from(valid);
            for mask in 1..32 {
                let signer = held(&json!(set(mask))).unwrap();
                let allowed = admin::can_grant(&signer, &subject);
                assert_eq!(
                    allowed,
                    valid && mask & admin_bit != 0 && mask & next == next,
                    "{mask:05b} grants {current:05b} -> {next:05b}"
                );
                grants += u64::from(allowed);
            }
        }
    }
    assert_eq!(json!(subjects), vectors["subjectPairs"]);
    assert_eq!(json!(grants), vectors["grantPairs"]);
    let duplicate = [
        DeviceCapability::Admin,
        DeviceCapability::Read,
        DeviceCapability::Draft,
        DeviceCapability::Organize,
        DeviceCapability::Admin,
    ];
    assert!(!admin::can_grant(&duplicate, &base));
    assert!(admin::can_grant(&duplicate[..4], &base));
    assert!(!admin::can_grant(&duplicate[..4], &json!(null)));
}

#[test]
fn admin_statement_binds_op_kind_digest_and_identity_for_every_reviewable_kind() {
    let vectors = vectors();
    for kind in admin::ADMIN_REVIEW_KINDS {
        let name = match *kind {
            "plugin.install" => "plugin-install",
            "plugin.upgrade" => "plugin-upgrade",
            "security.device-capabilities" => "device",
            "data.backup" => "backup",
            _ => "email",
        };
        let original = case(&vectors, &format!("admin-challenge-{kind}-{name}"));
        assert!(matches(&original), "{kind}");
        let signed = statement(&original);
        let mut changes = vec![
            ("op", json!(OTHER_ID)),
            ("digest", json!("f".repeat(64))),
            ("hub", json!("b".repeat(64))),
            ("device", json!(OTHER_ID)),
        ];
        changes.extend(
            ADMIN_KINDS
                .iter()
                .filter(|other| *other != kind)
                .map(|other| ("kind", json!(other))),
        );
        for (field, value) in changes {
            let mut changed = signed.clone();
            changed[field] = value.clone();
            let changed = with_statement(&original, &changed);
            assert!(api::check_schema("Challenge", &changed["challenge"]));
            assert!(!matches(&changed), "{kind}: {field} = {value}");
        }
        for (part, field) in [
            ("context", "hub"),
            ("context", "device"),
            ("request", "id"),
            ("review", "id"),
            ("challenge", "id"),
        ] {
            let mut changed = original.clone();
            changed[part][field] = if field == "hub" {
                json!("f".repeat(64))
            } else {
                json!(OTHER_ID)
            };
            assert!(!matches(&changed), "{kind}: {part}.{field}");
        }
    }
    let mut own = case(
        &vectors,
        "admin-challenge-security.device-capabilities-device",
    );
    let signer = own["context"]["device"].clone();
    own["review"]["subject"]["device"] = signer;
    own["review"]["digest"] = json!(jcs_sha256(&own["review"]["subject"]).unwrap());
    let mut signed = statement(&own);
    signed["digest"] = own["review"]["digest"].clone();
    let own = with_statement(&own, &signed);
    assert!(api::check_schema("OperationReview", &own["review"]));
    assert!(
        !matches(&own),
        "a device never changes its own capabilities"
    );
}

#[test]
fn admin_challenge_route_needs_a_current_confirmed_admin_device() {
    let peer = json!({"role":"device","known":true,"revoked":false,"epoch":1,"confirmedEpoch":1,
        "capabilities":["admin"],"sidecarClaim":false,"bootstrapDone":false});
    let operation = json!({"kind":"admin.v1"});
    assert!(api::route_allows("challenge", &peer, Some(&operation)));
    for (field, value) in [
        (
            "capabilities",
            json!(["read", "draft", "organize", "approve"]),
        ),
        ("confirmedEpoch", json!(0)),
        ("revoked", json!(true)),
        ("role", json!("host:sms")),
    ] {
        let mut changed = peer.clone();
        changed[field] = value;
        assert!(!api::route_allows("challenge", &changed, Some(&operation)));
    }
    for kind in admin::ADMIN_REVIEW_KINDS.iter().chain(&["admin"]) {
        assert!(!api::route_allows(
            "challenge",
            &peer,
            Some(&json!({"kind":kind}))
        ));
        assert!(
            api::route_allows("operation-review", &peer, Some(&json!({"kind":kind})))
                || *kind == "admin"
        );
    }
}
