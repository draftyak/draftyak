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
    let subjects: Vec<Value> = ["email", "chat", "device", "backup"]
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
