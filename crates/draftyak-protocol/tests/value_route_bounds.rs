use draftyak_protocol::{device_api as api, hub_runtime as runtime, jcs::JCS_MAX_DEPTH};
use serde_json::{Map, Value, json};
use std::{fs, mem::ManuallyDrop, path::PathBuf, process::Command};

const ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHILD_ENV: &str = "DRAFTYAK_PROTOCOL_VALUE_DEPTH_CHILD";
const CHILD_COMPLETE: &str = "DYTEST-ROUTE-DEPTH-COMPLETE";

fn peer() -> Value {
    json!({
        "role": "device",
        "known": true,
        "revoked": false,
        "epoch": 1,
        "confirmedEpoch": 1,
        "capabilities": ["read", "draft", "organize", "approve", "admin"],
        "sidecarClaim": false,
        "bootstrapDone": false,
    })
}

fn schema_fixture(schema: &str) -> Value {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/device-api/cases.json");
    let document: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    document["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| {
            case["action"] == "schema" && case["schema"] == schema && case["valid"] == true
        })
        .unwrap_or_else(|| panic!("missing valid {schema}"))["value"]
        .clone()
}

fn nested(levels: usize, objects: bool) -> Value {
    (0..levels).fold(Value::Null, |inside, _| {
        if objects {
            Value::Object(Map::from_iter([("nested".to_owned(), inside)]))
        } else {
            Value::Array(vec![inside])
        }
    })
}

#[derive(Clone, Copy, Debug)]
enum Entry {
    SchedulingAccess,
    DeviceAccess,
    DeviceCapabilities,
    ConfirmationPreset,
    FlagAcknowledgements,
    AgentReview,
    SendSnapshot,
}

const ENTRIES: [Entry; 7] = [
    Entry::SchedulingAccess,
    Entry::DeviceAccess,
    Entry::DeviceCapabilities,
    Entry::ConfirmationPreset,
    Entry::FlagAcknowledgements,
    Entry::AgentReview,
    Entry::SendSnapshot,
];

impl Entry {
    fn with(self, nested: Value) -> Value {
        match self {
            Self::SchedulingAccess | Self::DeviceAccess => {
                let mut value = peer();
                value["capabilities"] = nested;
                value
            }
            Self::DeviceCapabilities => {
                let mut value = json!({
                    "deviceId": ID,
                    "epoch": 1,
                    "confirmed": true,
                    "capabilities": null,
                    "testUpstreams": false,
                });
                value["capabilities"] = nested;
                value
            }
            Self::ConfirmationPreset => {
                let mut value = json!({ "kind": "pair-confirm", "ids": [ID], "preset": null });
                value["preset"] = nested;
                value
            }
            Self::FlagAcknowledgements => {
                let mut value = json!({ "kind": "approval.send.v1", "id": ID, "flagsAcked": null });
                value["flagsAcked"] = nested;
                value
            }
            Self::AgentReview => {
                let mut value = schema_fixture("AgentSessionReviewSubject");
                value["nested"] = nested;
                value
            }
            Self::SendSnapshot => {
                let mut value = schema_fixture("SendReview");
                value["snapshot"]["nested"] = nested;
                value
            }
        }
    }

    fn allows(self, value: &Value) -> bool {
        match self {
            Self::SchedulingAccess => runtime::route_allows("scheduling", value),
            Self::DeviceAccess => api::route_allows("status", value, None),
            Self::DeviceCapabilities => api::check_schema("DeviceStatus", value),
            Self::ConfirmationPreset => api::check_schema("OperationRequest", value),
            Self::FlagAcknowledgements => api::check_schema("ChallengeRequest", value),
            Self::AgentReview => api::check_schema("AgentSessionReviewSubject", value),
            Self::SendSnapshot => api::check_schema("SendReview", value),
        }
    }
}

#[test]
fn deep_values_do_not_overflow_before_the_typed_decoder_can_refuse_them() {
    // An aborted small-stack child is a failing regression, not an abort of this whole test run.
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "deep_value_child", "--nocapture"])
        .env(CHILD_ENV, "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "bounded decoding failed in its isolated child: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("running 1 test"), "{stdout}");
    assert!(
        stdout.contains(CHILD_COMPLETE),
        "the depth body did not run: {stdout}"
    );
}

#[test]
fn deep_value_child() {
    if std::env::var(CHILD_ENV).as_deref() != Ok("1") {
        return;
    }
    std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(|| {
            for entry in ENTRIES {
                for objects in [false, true] {
                    for levels in [4095, 100_000] {
                        // Keep ownership outside the checked operation: recursively dropping the
                        // caller's 100000-level fixture is intentionally a separate concern.
                        let value = ManuallyDrop::new(entry.with(nested(levels, objects)));
                        assert!(!entry.allows(&value), "{entry:?} {objects} {levels}");
                    }
                }
            }
        })
        .unwrap()
        .join()
        .unwrap();
    println!("{CHILD_COMPLETE}");
}

#[test]
fn nearby_depths_refuse_wrongly_typed_members_without_changing_the_input() {
    for entry in ENTRIES {
        for objects in [false, true] {
            for levels in [0, 1, JCS_MAX_DEPTH - 1, JCS_MAX_DEPTH, JCS_MAX_DEPTH + 1] {
                let value = entry.with(nested(levels, objects));
                let before = serde_json::to_vec(&value).unwrap();
                assert!(!entry.allows(&value), "{entry:?} {objects} {levels}");
                assert_eq!(serde_json::to_vec(&value).unwrap(), before);
            }
        }
    }
}

#[test]
fn confirmed_peer_access_stays_bound_to_the_original_capability_policy() {
    let valid = peer();
    assert!(runtime::route_allows("scheduling", &valid));
    assert!(runtime::route_allows("scheduling-outbox", &valid));
    assert!(api::route_allows("status", &valid, None));
    assert!(api::route_allows("send-review", &valid, None));
    for caps in [
        json!(["read", { "draft": null }]),
        json!([{ "read": null }]),
        json!(["read", "read"]),
        json!(["read", "unrecognized"]),
        json!([null, "read"]),
        json!([["read"]]),
    ] {
        let mut changed = valid.clone();
        changed["capabilities"] = caps;
        for route in ["scheduling", "scheduling-outbox"] {
            assert!(!runtime::route_allows(route, &changed));
        }
        for route in ["status", "send-review"] {
            assert!(!api::route_allows(route, &changed, None));
        }
    }
}

#[test]
fn bounding_the_copy_does_not_grant_an_unconfirmed_or_revoked_peer_access() {
    for (name, replacement) in [
        ("role", json!("host:sms")),
        ("known", json!(false)),
        ("revoked", json!(true)),
        ("confirmedEpoch", Value::Null),
        ("confirmedEpoch", json!(0)),
        ("epoch", json!(-1)),
        ("epoch", json!(9_007_199_254_740_992_u64)),
    ] {
        let mut changed = peer();
        changed[name] = replacement;
        assert!(!runtime::route_allows("scheduling", &changed), "{name}");
        assert!(!api::route_allows("send-review", &changed, None), "{name}");
    }
}

#[test]
fn a_schema_checked_capability_list_keeps_its_written_string_form() {
    let mut value = json!({
        "deviceId": ID,
        "epoch": 1,
        "confirmed": true,
        "capabilities": ["read"],
        "testUpstreams": false,
    });
    assert!(api::check_schema("DeviceStatus", &value));
    for invalid in [
        json!([{ "read": null }]),
        json!([["read"]]),
        json!(["read", "read"]),
    ] {
        value["capabilities"] = invalid;
        assert!(!api::check_schema("DeviceStatus", &value));
    }
    value["capabilities"] = json!(["read"]);
    assert!(api::check_schema("DeviceStatus", &value));
}

#[test]
fn ordinary_preset_and_acknowledgement_shapes_remain_strict() {
    let mut operation = json!({ "kind": "pair-confirm", "ids": [ID], "preset": "desktop" });
    assert!(api::check_schema("OperationRequest", &operation));
    for invalid in [json!({ "desktop": null }), json!(["desktop"]), Value::Null] {
        operation["preset"] = invalid;
        assert!(!api::check_schema("OperationRequest", &operation));
    }
    let mut challenge = json!({ "kind": "approval.send.v1", "id": ID, "flagsAcked": [] });
    assert!(api::check_schema("ChallengeRequest", &challenge));
    for invalid in [
        json!([{ "NEW_RECIPIENT": null }]),
        json!([["NEW_RECIPIENT"]]),
        json!(["NEW_RECIPIENT", "NEW_RECIPIENT"]),
    ] {
        challenge["flagsAcked"] = invalid;
        assert!(!api::check_schema("ChallengeRequest", &challenge));
    }
}

#[test]
fn bounded_value_admission_keeps_every_existing_valid_device_schema_vector() {
    let file =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/device-api/cases.json");
    let document: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    let mut checked = 0;
    for case in document["cases"].as_array().unwrap() {
        if case["action"] != "schema" || case["valid"] != true {
            continue;
        }
        let schema = case["schema"].as_str().unwrap();
        assert!(api::check_schema(schema, &case["value"]), "{}", case["id"]);
        checked += 1;
    }
    assert!(checked > 20);
}
