use draftyak_protocol::device_api as api;
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

fn send_fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/device-api/cases.json");
    let vectors: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "send-challenge-matching")
        .unwrap()
        .clone()
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
fn accepted_kind_is_bound_to_each_signed_route_in_value_and_received_forms() {
    for (route, kind) in [
        ("send-approval", "approval.send.v1"),
        ("pair-confirmation", "pair-confirm.v1"),
        ("login", "login.v1"),
        ("consent", "consent.v1"),
        ("agent-session", "agent-session.v1"),
        ("admin", "admin.v1"),
    ] {
        let good = json!({"kind":kind,"id":ID});
        let wrong = json!({
            "kind":if kind == "approval.send.v1" { "pair-confirm.v1" } else { "approval.send.v1" },
            "id":ID
        });
        assert!(api::check_schema("Accepted", &wrong));
        assert!(api::check_route_response(route, &good));
        assert!(api::check_route_response_bytes(
            route,
            &serde_json::to_vec(&good).unwrap()
        ));
        assert!(!api::check_route_response(route, &wrong));
        assert!(!api::check_route_response_bytes(
            route,
            &serde_json::to_vec(&wrong).unwrap()
        ));
    }
}

#[test]
fn signed_outbox_is_bound_to_jointly_substituted_pending_and_request_ids() {
    let original = send_fixture();
    assert!(matches(&original));
    let mut changed = original.clone();
    assert_ne!(changed["request"]["id"], json!(OTHER_ID));
    for field in ["challenge", "review", "request"] {
        changed[field]["id"] = json!(OTHER_ID);
    }
    assert_eq!(
        changed["challenge"]["statement"],
        original["challenge"]["statement"]
    );
    assert_eq!(
        changed["review"]["snapshot"],
        original["review"]["snapshot"]
    );
    assert!(api::check_schema("Challenge", &changed["challenge"]));
    assert!(api::check_schema("ChallengeRequest", &changed["request"]));
    assert!(api::check_schema("SendReview", &changed["review"]));
    assert!(!matches(&changed));
}

#[test]
fn signed_acknowledgements_equal_the_valid_requested_selection() {
    let original = send_fixture();
    assert!(matches(&original));
    let extra = "REPLY_TO_REDIRECT";
    let mut superset: Vec<&str> = original["request"]["flagsAcked"]
        .as_array()
        .unwrap()
        .iter()
        .map(|code| code.as_str().unwrap())
        .collect();
    assert!(!superset.is_empty() && !superset.contains(&extra));
    // A strict superset still covers every required acknowledgement; only equality refuses it.
    superset.push(extra);
    superset.sort_unstable();
    for selection in [json!([]), json!(superset)] {
        let mut changed = original.clone();
        changed["request"]["flagsAcked"] = selection;
        assert_eq!(
            changed["challenge"]["statement"],
            original["challenge"]["statement"]
        );
        assert!(api::check_schema("ChallengeRequest", &changed["request"]));
        assert!(api::check_schema("Challenge", &changed["challenge"]));
        assert!(!matches(&changed));
    }
}

#[test]
fn received_response_json_is_strict_and_preserves_valid_raw_number_forms() {
    assert!(api::check_route_response_bytes(
        "sync-pause",
        br#"{"paused":true}"#
    ));
    for duplicate in [
        br#"{"paused":true,"paused":false}"#.as_slice(),
        br#"{"paused":false,"paused":false}"#,
    ] {
        assert!(!api::check_route_response_bytes("sync-pause", duplicate));
    }
    for (number, valid) in [
        ("-0", true),
        ("-0.0", true),
        ("0e999", true),
        ("1.0", true),
        ("1e0", true),
        ("9007199254740991", true),
        ("9007199254740992", false),
        ("1e-999", true),
        ("-1e-999", true),
    ] {
        let bytes = format!(
            r#"{{"deviceId":"{ID}","epoch":{number},"confirmed":false,"capabilities":[],"testUpstreams":false}}"#
        );
        assert_eq!(
            api::check_route_response_bytes("status", bytes.as_bytes()),
            valid,
            "raw epoch {number}"
        );
    }
}

#[test]
fn received_error_json_refuses_duplicate_code_members() {
    let good = br#"{"code":"FORBIDDEN"}"#;
    assert!(api::check_api_error_bytes(good, 403));
    for duplicate in [
        br#"{"code":"FORBIDDEN","code":"FORBIDDEN"}"#.as_slice(),
        br#"{"code":"INVALID_REQUEST","code":"FORBIDDEN"}"#,
    ] {
        assert!(!api::check_api_error_bytes(duplicate, 403));
    }
    let mut exact = good.to_vec();
    exact.resize(1024, b' ');
    assert!(api::check_api_error_bytes(&exact, 403));
    exact.push(b' ');
    assert!(!api::check_api_error_bytes(&exact, 403));
}
