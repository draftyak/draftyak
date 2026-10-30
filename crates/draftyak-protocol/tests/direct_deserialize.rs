//! The validated types read directly through serde, from JSON text and from a parsed value, on
//! their own and as a field of a caller's struct, take what the shared vectors take: never a
//! struct written as an array, an enum written as a one-member map or a member written twice.
//! Snapshots and flags read directly refuse with their bare codes.
use draftyak_protocol::{
    flags::Flag,
    jcs::parse_strict,
    snapshot::SendSnapshotV1,
    statements::{
        admin::AdminStatement,
        agent_session::{AgentSessionReviewSubject, AgentSessionStatement},
        hub_key_rotate::HubKeyRotateStatement,
        login::LoginStatement,
        pair_confirm::PairConfirmStatement,
        parse_statement,
        send::SendStatement,
    },
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::fmt::Debug;

fn vectors(file: &str) -> Vec<Value> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/vectors")
        .join(file);
    let document: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    document["cases"].as_array().unwrap().clone()
}
fn schema_cases(schema: &str) -> Vec<Value> {
    vectors("device-api/cases.json")
        .into_iter()
        .filter(|case| case["action"] == "schema" && case["schema"] == schema)
        .collect()
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
/// The shared vectors that write a struct as an array ("positional") or an enum as a one-member
/// map ("object-form") name the part they change.
fn form(id: &Value, part: &str) -> bool {
    let id = id.as_str().unwrap();
    (id.contains("positional") || id.contains("object-form")) && id.contains(part)
}
/// A caller's own struct with a `T` field.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Field<T> {
    value: T,
}
/// Whether `T` takes `input` read directly: from the text and, when it parses, from its strict
/// value, each on its own and as a field of a caller's struct, which must all agree. A value
/// taken writes back as it was received and is refused when any of its objects writes a member
/// twice.
fn direct<T: DeserializeOwned + Serialize>(id: &Value, input: &[u8]) -> bool {
    let from_text = serde_json::from_slice::<T>(input).is_ok();
    let field = [br#"{"value":"#.as_slice(), input, b"}"].concat();
    let field_text = serde_json::from_slice::<Field<T>>(&field).is_ok();
    assert_eq!(field_text, from_text, "{id}: as a field of the text");
    if let Ok(value) = parse_strict(input) {
        let field = serde_json::from_value::<Field<T>>(json!({ "value": value }));
        for (way, decoded) in [
            ("a value", serde_json::from_value::<T>(value.clone())),
            ("a field of a value", field.map(|field| field.value)),
        ] {
            match decoded {
                Ok(decoded) => {
                    assert!(from_text, "{id}: taken only as {way}");
                    assert_eq!(serde_json::to_value(decoded).unwrap(), value, "{id}: {way}");
                }
                Err(_) => assert!(!from_text, "{id}: taken as text, not as {way}"),
            }
        }
        if from_text {
            for (n, repeated) in repeats(&value).iter().enumerate() {
                let loose: Value = serde_json::from_slice(repeated).unwrap();
                assert_eq!(loose, value, "{id}: object {n}");
                assert!(!direct::<T>(id, repeated), "{id}: repeat in object {n}");
            }
        }
    }
    from_text
}
/// `value` written once for each of its objects with members, with that object's first member
/// written twice.
fn repeats(value: &Value) -> Vec<Vec<u8>> {
    (0..)
        .map_while(|object| {
            let mut left = Some(object);
            let text = written(value, &mut left);
            left.is_none().then_some(text.into_bytes())
        })
        .collect()
}
/// `value` as text, with the first member of the object `left` counts down to, in document
/// order, written twice.
fn written(value: &Value, left: &mut Option<usize>) -> String {
    match value {
        Value::Array(items) => {
            let items: Vec<_> = items.iter().map(|item| written(item, left)).collect();
            format!("[{}]", items.join(","))
        }
        Value::Object(members) if !members.is_empty() => {
            let twice = *left == Some(0);
            *left = left.and_then(|object| object.checked_sub(1));
            let mut members: Vec<_> = members
                .iter()
                .map(|(name, member)| format!("{}:{}", json!(name), written(member, left)))
                .collect();
            if twice {
                members.insert(0, members[0].clone());
            }
            format!("{{{}}}", members.join(","))
        }
        _ => value.to_string(),
    }
}

#[test]
fn snapshots_read_directly_take_exactly_the_shared_vectors() {
    for case in vectors("snapshot/snapshots.json") {
        let taken = direct::<SendSnapshotV1>(&case["id"], &bytes(&case["snapshot"]));
        assert_eq!(taken, case.get("error").is_none(), "{}", case["id"]);
    }
    for case in vectors("statements/approval.send.v1.json") {
        if case.get("snapshot").is_some() {
            let taken = direct::<SendSnapshotV1>(&case["id"], &bytes(&case["snapshot"]));
            assert!(taken, "{}", case["id"]);
        }
    }
    let reviews = schema_cases("SendReview");
    assert!(reviews.iter().any(|case| form(&case["id"], "snapshot")));
    for case in reviews {
        let taken = direct::<SendSnapshotV1>(&case["id"], &bytes(&case["value"]["snapshot"]));
        assert_eq!(taken, !form(&case["id"], "snapshot"), "{}", case["id"]);
    }
}

#[test]
fn flags_read_directly_take_exactly_the_shared_vectors() {
    for case in vectors("flags/flags-hash.json") {
        let listed = case["error"] != "FLAGS_INVALID";
        let taken = direct::<Vec<Flag>>(&case["id"], &bytes(&case["flags"]));
        assert_eq!(taken, listed, "{}", case["id"]);
        if listed {
            for flag in case["flags"].as_array().unwrap() {
                assert!(direct::<Flag>(&case["id"], &bytes(flag)), "{}", case["id"]);
            }
        }
    }
    for case in vectors("statements/approval.send.v1.json") {
        if case.get("flags").is_some() {
            let taken = direct::<Vec<Flag>>(&case["id"], &bytes(&case["flags"]));
            assert!(taken, "{}", case["id"]);
        }
    }
    let reviews = schema_cases("SendReview");
    assert!(reviews.iter().any(|case| form(&case["id"], "flag")));
    for case in reviews {
        let taken = !form(&case["id"], "flag");
        let flags = &case["value"]["flags"];
        assert_eq!(direct::<Vec<Flag>>(&case["id"], &bytes(flags)), taken);
        for flag in flags.as_array().unwrap() {
            assert_eq!(direct::<Flag>(&case["id"], &bytes(flag)), taken);
        }
    }
}

fn statements<T: DeserializeOwned + Serialize>(typ: &str) {
    let cases = vectors(&format!("statements/{typ}.json"));
    assert!(cases.iter().any(|case| form(&case["id"], "")), "{typ}");
    for case in cases {
        let received = hex(case["receivedHex"].as_str().unwrap());
        let taken = direct::<T>(&case["id"], &received);
        let parsed = parse_statement(typ, &received).is_some();
        assert_eq!(taken, parsed, "{typ} {}", case["id"]);
        assert!(taken || case["valid"] == false, "{typ} {}", case["id"]);
        assert!(!taken || !form(&case["id"], ""), "{typ} {}", case["id"]);
    }
}

#[test]
fn device_statements_read_directly_take_what_parse_statement_takes() {
    statements::<SendStatement>("approval.send.v1");
    statements::<PairConfirmStatement>("pair-confirm.v1");
    statements::<LoginStatement>("login.v1");
    statements::<AdminStatement>("admin.v1");
    statements::<AgentSessionStatement>("agent-session.v1");
}

#[test]
fn hub_key_rotations_read_directly_take_what_parse_statement_takes() {
    statements::<HubKeyRotateStatement>("hub-key-rotate.v1");
}

#[test]
fn review_subjects_read_directly_take_exactly_the_shared_vectors() {
    let cases = schema_cases("AgentSessionReviewSubject");
    assert!(cases.iter().any(|case| form(&case["id"], "")));
    for case in cases {
        let taken = direct::<AgentSessionReviewSubject>(&case["id"], &bytes(&case["value"]));
        assert_eq!(taken, case["valid"] == true, "{}", case["id"]);
    }
    for case in schema_cases("OperationReview") {
        if case["valid"] == true && case["value"]["kind"] == "agent-session" {
            let subject = &case["value"]["subject"];
            let taken = direct::<AgentSessionReviewSubject>(&case["id"], &bytes(subject));
            assert!(taken, "{}", case["id"]);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Review {
    snapshot: SendSnapshotV1,
    flags: Vec<Flag>,
}

#[test]
fn a_caller_struct_holds_its_snapshot_and_flags_fields_to_the_same_shapes() {
    for case in schema_cases("SendReview") {
        let value = &case["value"];
        let review = json!({"snapshot": value["snapshot"], "flags": value["flags"]});
        let taken = !form(&case["id"], "snapshot") && !form(&case["id"], "flag");
        for decoded in [
            serde_json::from_slice::<Review>(&bytes(&review)),
            serde_json::from_value::<Review>(review.clone()),
        ] {
            assert_eq!(decoded.is_ok(), taken, "{}", case["id"]);
            if let Ok(decoded) = decoded {
                assert_eq!(json!(decoded.snapshot), value["snapshot"]);
                assert_eq!(json!(decoded.flags), value["flags"]);
            }
        }
    }
}

/// `valid` with each change refused read directly, from text and from a value, with the bare
/// `code`, never serde's message, which names the caller's member or value.
fn private_errors<T: DeserializeOwned + Debug>(
    code: &str,
    valid: &Value,
    changes: [(&str, Value); 3],
) {
    serde_json::from_value::<T>(valid.clone()).unwrap();
    for (member, value) in changes {
        let mut changed = valid.clone();
        changed[member] = value;
        let text = serde_json::to_string(&changed).unwrap();
        let from_text = serde_json::from_str::<T>(&text).unwrap_err();
        let from_value = serde_json::from_value::<T>(changed).unwrap_err();
        // A JSON deserializer may append source line/column coordinates, never the supplied field.
        assert!(from_text.to_string().starts_with(code), "{member}");
        assert_eq!(from_value.to_string(), code, "{member}");
        for error in [from_text, from_value] {
            let shown = format!("{error} {error:?}");
            assert!(!shown.contains("PRIVATE_CANARY"), "{member}");
        }
    }
}

#[test]
fn snapshots_and_flags_read_directly_refuse_with_their_bare_codes() {
    let snapshot = vectors("snapshot/snapshots.json")
        .into_iter()
        .find(|case| case.get("error").is_none())
        .unwrap();
    private_errors::<SendSnapshotV1>(
        "SNAPSHOT_INVALID",
        &snapshot["snapshot"],
        [
            ("PRIVATE_CANARY", json!(true)),
            ("kind", json!("PRIVATE_CANARY")),
            ("epoch", json!("PRIVATE_CANARY")),
        ],
    );
    let flags = vectors("flags/flags-hash.json")
        .into_iter()
        .find(|case| case.get("error").is_none() && case["flags"].get(0).is_some())
        .unwrap();
    private_errors::<Flag>(
        "FLAGS_INVALID",
        &flags["flags"][0],
        [
            ("PRIVATE_CANARY", json!(true)),
            ("code", json!("PRIVATE_CANARY")),
            ("severity", json!("PRIVATE_CANARY")),
        ],
    );
}
