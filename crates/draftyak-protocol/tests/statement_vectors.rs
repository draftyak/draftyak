use draftyak_protocol::{
    device_api,
    flags::{flags_hash, parse_flags},
    jcs::canonicalize,
    sign::{base64url_decode, base64url_encode},
    snapshot::{SendSnapshotV1, content_hash, parse_snapshot, send_window},
    statements::{
        self, Statement,
        send::{SendStatement, check_flags_acked, check_send_window},
    },
};
use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer},
    pkcs8::DecodePrivateKey,
};
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::{Value, json};
fn documents() -> Vec<String> {
    statements::TYPES
        .iter()
        .map(|typ| {
            std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../spec/vectors/statements")
                    .join(format!("{typ}.json")),
            )
            .unwrap()
        })
        .collect()
}
fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
fn case<'a>(document: &'a Value, id: &str) -> &'a Value {
    document["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == id)
        .unwrap()
}
/// The member values of the JSON object `text`, in the order `text` writes them.
fn member_values(text: &str) -> Vec<Value> {
    struct InOrder;
    impl<'de> Visitor<'de> for InOrder {
        type Value = Vec<Value>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut members: A) -> Result<Vec<Value>, A::Error> {
            let mut values = Vec::new();
            while let Some((_, value)) = members.next_entry::<String, Value>()? {
                values.push(value);
            }
            Ok(values)
        }
    }
    serde_json::Deserializer::from_str(text)
        .deserialize_map(InOrder)
        .unwrap()
}
#[test]
fn every_shared_statement_and_deterministic_signature() {
    for document in documents() {
        let document: Value = serde_json::from_str(&document).unwrap();
        let key = SigningKey::from_pkcs8_der(
            &base64url_decode(
                document["keys"]["signer"]["privateKeyPkcs8"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        for case in document["cases"].as_array().unwrap() {
            for name in ["signature", "rfc6979Signature"] {
                let Some(signature) = case[name].as_str() else {
                    continue;
                };
                let body = statements::open_typed_statement(
                    case["typ"].as_str().unwrap(),
                    &hex(case["receivedHex"].as_str().unwrap()),
                    &base64url_decode(signature).unwrap(),
                    &base64url_decode(case["publicKeySpki"].as_str().unwrap()).unwrap(),
                );
                assert_eq!(
                    body.is_some(),
                    case["valid"].as_bool().unwrap(),
                    "{} {name}",
                    case["id"]
                );
                if let Some(body) = body {
                    assert_eq!(
                        canonicalize(&body).unwrap(),
                        canonicalize(&case["statement"]).unwrap()
                    );
                    if let Statement::Send(send) = body {
                        if let Some(expected) = case["windowValid"].as_bool() {
                            let snapshot = parse_snapshot(
                                serde_json::to_string(&case["snapshot"]).unwrap().as_bytes(),
                            )
                            .unwrap();
                            assert_eq!(
                                check_send_window(&send, &snapshot),
                                expected,
                                "{}",
                                case["id"]
                            );
                        }
                        if let Some(expected) = case["flagsValid"].as_bool() {
                            let flags = parse_flags(
                                serde_json::to_string(&case["flags"]).unwrap().as_bytes(),
                            )
                            .unwrap();
                            assert_eq!(
                                check_flags_acked(&send, &flags),
                                expected,
                                "{}",
                                case["id"]
                            );
                        }
                    }
                }
            }
            if let Some(signature) = case["rfc6979Signature"].as_str() {
                let actual: Signature = key.sign(&hex(case["signingInputHex"].as_str().unwrap()));
                assert_eq!(
                    actual.to_bytes().as_slice(),
                    base64url_decode(signature).unwrap()
                );
            }
        }
    }
}
#[test]
fn flags_match_typescript_corpus() {
    let document: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/flags/flags-hash.json")).unwrap();
    for case in document["cases"].as_array().unwrap() {
        let parsed = parse_flags(serde_json::to_string(&case["flags"]).unwrap().as_bytes());
        let result = parsed
            .map_err(|_| "FLAGS_INVALID")
            .and_then(|flags| flags_hash(&flags).map_err(|e| e.code()));
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.err(), Some(error), "{}", case["id"]);
        } else {
            let hash = result.unwrap_or_else(|error| panic!("{}: {error}", case["id"]));
            assert_eq!(hash, case["flagsHash"], "{}", case["id"]);
        }
    }
}
#[test]
fn current_send_window_requires_sharing_even_with_matching_legacy_hash_and_window() {
    let snapshots: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/snapshot/snapshots.json"
    ))
    .unwrap();
    let legacy = snapshots["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "chat-thread")
        .unwrap()["snapshot"]
        .clone();
    let statements: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/statements/approval.send.v1.json"
    ))
    .unwrap();
    let email_case = statements["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "window-bound")
        .unwrap();
    for shared in [None, Some(false), Some(true)] {
        let mut value = legacy.clone();
        if let Some(shared) = shared {
            value["chat"]["shared"] = json!(shared);
        }
        let snapshot = parse_snapshot(serde_json::to_string(&value).unwrap().as_bytes()).unwrap();
        let mut statement = email_case["statement"].clone();
        let window = send_window(&snapshot, statement["iat"].as_u64().unwrap()).unwrap();
        let hash = content_hash(&snapshot).unwrap();
        statement["contentHash"] = json!(hash);
        statement["notBefore"] = json!(window.not_before);
        statement["deliverBy"] = json!(window.deliver_by);
        let statement: SendStatement = serde_json::from_value(statement).unwrap();
        assert_eq!(statement.content_hash, hash);
        assert_eq!(statement.not_before, window.not_before);
        assert_eq!(statement.deliver_by, window.deliver_by);
        assert_eq!(check_send_window(&statement, &snapshot), shared.is_some());
    }
    let email = parse_snapshot(
        serde_json::to_string(&email_case["snapshot"])
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let statement: SendStatement = serde_json::from_value(email_case["statement"].clone()).unwrap();
    assert_eq!(statement.content_hash, content_hash(&email).unwrap());
    assert!(check_send_window(&statement, &email));
}

fn matching_sharing_challenge(snapshot: &SendSnapshotV1, state: &str) -> (Value, SendStatement) {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/device-api/cases.json")).unwrap();
    let mut fixture = vectors["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "send-challenge-matching")
        .unwrap()
        .clone();
    let bytes = base64url_decode(fixture["challenge"]["statement"].as_str().unwrap()).unwrap();
    let mut statement: Value = serde_json::from_slice(&bytes).unwrap();
    let window = send_window(snapshot, statement["iat"].as_u64().unwrap()).unwrap();
    let hash = content_hash(snapshot).unwrap();
    statement["contentHash"] = json!(hash);
    statement["notBefore"] = json!(window.not_before);
    statement["deliverBy"] = json!(window.deliver_by);
    fixture["review"]["snapshot"] = serde_json::to_value(snapshot).unwrap();
    fixture["review"]["contentHash"] = json!(hash);
    fixture["review"]["state"] = json!(state);
    fixture["challenge"]["statement"] = json!(base64url_encode(
        canonicalize(&statement).unwrap().as_bytes()
    ));
    let statement: SendStatement = serde_json::from_value(statement).unwrap();
    assert_eq!(statement.content_hash, hash);
    assert_eq!(statement.not_before, window.not_before);
    assert_eq!(statement.deliver_by, window.deliver_by);
    let flags = parse_flags(
        serde_json::to_string(&fixture["review"]["flags"])
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    assert!(check_flags_acked(&statement, &flags));
    assert!(device_api::check_schema("SendReview", &fixture["review"]));
    assert!(device_api::check_route_response(
        "send-review",
        &fixture["review"]
    ));
    (fixture, statement)
}

#[test]
fn sharing_window_guard_closes_current_challenges_without_rejecting_legacy_reviews() {
    let snapshots: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/snapshot/snapshots.json"
    ))
    .unwrap();
    let legacy = snapshots["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "chat-thread")
        .unwrap()["snapshot"]
        .clone();
    assert!(legacy["chat"].get("shared").is_none());
    for shared in [None, Some(false), Some(true)] {
        let mut value = legacy.clone();
        if let Some(shared) = shared {
            value["chat"]["shared"] = json!(shared);
        }
        let snapshot = parse_snapshot(serde_json::to_string(&value).unwrap().as_bytes()).unwrap();
        let (fixture, statement) = matching_sharing_challenge(&snapshot, "PENDING_APPROVAL");
        if shared.is_some() {
            assert!(check_send_window(&statement, &snapshot));
        }
        assert_eq!(
            device_api::check_challenge(
                &fixture["challenge"],
                &fixture["review"],
                &fixture["request"],
                &fixture["context"],
            ),
            shared.is_some()
        );
        if shared.is_none() {
            assert!(!check_send_window(&statement, &snapshot));
            assert!(
                fixture["review"]["snapshot"]["chat"]
                    .get("shared")
                    .is_none()
            );
            for state in ["SENT", "NEEDS_REAPPROVAL"] {
                let (historical, statement) = matching_sharing_challenge(&snapshot, state);
                assert!(!device_api::check_challenge(
                    &historical["challenge"],
                    &historical["review"],
                    &historical["request"],
                    &historical["context"],
                ));
                assert!(!check_send_window(&statement, &snapshot));
            }
        }
    }
    let email = snapshots["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "email-reply")
        .unwrap()["snapshot"]
        .clone();
    let snapshot = parse_snapshot(serde_json::to_string(&email).unwrap().as_bytes()).unwrap();
    let (fixture, statement) = matching_sharing_challenge(&snapshot, "PENDING_APPROVAL");
    assert!(check_send_window(&statement, &snapshot));
    assert!(device_api::check_challenge(
        &fixture["challenge"],
        &fixture["review"],
        &fixture["request"],
        &fixture["context"],
    ));
}
#[test]
fn registered_types_and_freshness() {
    assert_eq!(statements::TYPES.len(), documents().len());
    for typ in [
        "unregistered-test-contract.v1",
        "another-unregistered-test.v1",
        "unregistered-test.v2",
        "__proto__",
    ] {
        assert!(statements::parse_statement(typ, b"{}").is_none());
    }
    // Signature checks refuse a positional statement before parse_statement sees it. It lists the
    // valid statement's member values in the order its type's derived Serialize writes them, the
    // type's by-position form while its wire struct declares the same order: device_statement!
    // builds both from one list, but hub_key_rotate.rs repeats the list by hand.
    let mut read = Vec::new();
    let mut not_by_position = Vec::new();
    for (typ, document) in statements::TYPES.iter().zip(documents()) {
        let document: Value = serde_json::from_str(&document).unwrap();
        let positional = &case(&document, "positional")["receivedHex"];
        let bytes = hex(positional.as_str().unwrap());
        if statements::parse_statement(typ, &bytes).is_some() {
            read.push(*typ);
        }
        let valid = &case(&document, "valid")["receivedHex"];
        let valid = statements::parse_statement(typ, &hex(valid.as_str().unwrap())).unwrap();
        let written = serde_json::to_string(&valid).unwrap();
        if serde_json::from_slice::<Vec<Value>>(&bytes).ok() != Some(member_values(&written)) {
            not_by_position.push(*typ);
        }
    }
    assert!(read.is_empty(), "{read:?}");
    assert!(not_by_position.is_empty(), "{not_by_position:?}");
    let document: Value = serde_json::from_str(&documents()[0]).unwrap();
    let body = statements::parse_statement(
        "approval.send.v1",
        canonicalize(&document["cases"][0]["statement"])
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let Statement::Send(send) = body else {
        panic!("send");
    };
    assert!(send.is_fresh(send.iat));
    assert!(send.is_fresh(send.exp));
    assert!(!send.is_fresh(send.iat - 1));
    assert!(!send.is_fresh(send.exp + 1));
}
