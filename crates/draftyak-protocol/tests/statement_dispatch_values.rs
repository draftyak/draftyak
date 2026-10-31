use draftyak_protocol::{
    jcs::{canonicalize, parse_strict},
    statements::{Statement, TYPES, parse_statement},
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{fs, path::PathBuf};

#[derive(Debug, Deserialize, Serialize)]
struct Envelope {
    before: u8,
    statement: Statement,
    after: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct Batch {
    statements: Vec<Statement>,
}

fn vectors(typ: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/vectors/statements")
        .join(format!("{typ}.json"));
    let document: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    document["cases"].as_array().unwrap().clone()
}

fn received(case: &Value) -> Vec<u8> {
    let hex = case["receivedHex"].as_str().unwrap();
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
        .collect()
}

fn valid_statements() -> Vec<Value> {
    TYPES
        .iter()
        .map(|typ| {
            let case = vectors(typ)
                .into_iter()
                .find(|case| case["valid"] == true)
                .unwrap();
            parse_strict(&received(&case)).unwrap()
        })
        .collect()
}

fn same(actual: Statement, expected: Statement) {
    assert_eq!(
        canonicalize(&actual).unwrap(),
        canonicalize(&expected).unwrap()
    );
}

fn expected(input: &[u8]) -> Option<Statement> {
    TYPES.iter().find_map(|typ| parse_statement(typ, input))
}

#[test]
fn untagged_serde_dispatch_matches_the_typed_parser_for_all_received_vectors() {
    let mut checked = 0;
    for typ in TYPES {
        for case in vectors(typ) {
            let input = received(&case);
            let actual = serde_json::from_slice::<Statement>(&input);
            let expected = expected(&input);
            assert_eq!(actual.is_ok(), expected.is_some(), "{typ} {}", case["id"]);
            match (actual, expected) {
                (Ok(actual), Some(expected)) => same(actual, expected),
                (Err(_), None) => {}
                _ => unreachable!(),
            }
            checked += 1;
        }
    }
    assert!(checked > TYPES.len() * 5);
}

#[test]
fn borrowed_and_owned_values_choose_the_same_variant_as_received_bytes() {
    let mut checked = 0;
    for typ in TYPES {
        for case in vectors(typ) {
            let input = received(&case);
            let Ok(value) = parse_strict(&input) else {
                continue;
            };
            let written = serde_json::to_vec(&value).unwrap();
            let expected = expected(&written);
            let borrowed = Statement::deserialize(&value);
            let owned = serde_json::from_value::<Statement>(value);
            assert_eq!(borrowed.is_ok(), expected.is_some(), "{}", case["id"]);
            assert_eq!(owned.is_ok(), expected.is_some(), "{}", case["id"]);
            if let Some(expected) = expected {
                let expected = canonicalize(&expected).unwrap();
                assert_eq!(canonicalize(&borrowed.unwrap()).unwrap(), expected);
                assert_eq!(canonicalize(&owned.unwrap()).unwrap(), expected);
            } else {
                assert_eq!(borrowed.unwrap_err().to_string(), "STATEMENT_INVALID");
                assert_eq!(owned.unwrap_err().to_string(), "STATEMENT_INVALID");
            }
            checked += 1;
        }
    }
    assert!(checked > TYPES.len() * 3);
}

#[test]
fn every_registered_variant_remains_embeddable_in_the_callers_own_struct() {
    for value in valid_statements() {
        let wrapped = json!({ "before": 7, "statement": value, "after": true });
        let owned: Envelope = serde_json::from_value(wrapped.clone()).unwrap();
        let borrowed = Envelope::deserialize(&wrapped).unwrap();
        let text: Envelope =
            serde_json::from_slice(&serde_json::to_vec(&wrapped).unwrap()).unwrap();
        for decoded in [owned, borrowed, text] {
            assert_eq!(decoded.before, 7);
            assert!(decoded.after);
            assert_eq!(serde_json::to_value(decoded).unwrap(), wrapped);
        }
    }
}

#[test]
fn a_mixed_statement_batch_preserves_order_and_written_variants() {
    let values = valid_statements();
    let expected = json!({ "statements": values });
    let decoded: Batch = serde_json::from_value(expected.clone()).unwrap();
    assert_eq!(decoded.statements.len(), TYPES.len());
    assert_eq!(serde_json::to_value(decoded).unwrap(), expected);
    let reversed = json!({ "statements": values.into_iter().rev().collect::<Vec<_>>() });
    let decoded = Batch::deserialize(&reversed).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), reversed);
}

#[test]
fn dispatch_never_uses_a_rust_variant_name_as_a_wire_tag() {
    for value in valid_statements() {
        for rust_variant in ["Send", "Pair", "Login", "Admin", "Rotate", "Agent"] {
            let wrapper = Value::Object(Map::from_iter([(rust_variant.to_owned(), value.clone())]));
            assert!(serde_json::from_value::<Statement>(wrapper).is_err());
        }
    }
}

#[test]
fn a_validated_version_is_required_for_every_structural_variant() {
    for value in valid_statements() {
        for invalid in [
            Value::Null,
            json!(true),
            json!([1]),
            json!({ "1": null }),
            json!("1"),
            json!(2),
        ] {
            let mut changed = value.clone();
            changed["v"] = invalid;
            assert_eq!(
                serde_json::from_value::<Statement>(changed)
                    .unwrap_err()
                    .to_string(),
                "STATEMENT_INVALID"
            );
        }
        let mut missing = value;
        missing.as_object_mut().unwrap().remove("v");
        assert_eq!(
            Statement::deserialize(&missing).unwrap_err().to_string(),
            "STATEMENT_INVALID"
        );
    }
}

#[test]
fn fields_from_another_variant_do_not_reinterpret_an_incompatible_statement() {
    let values = valid_statements();
    let mut checked = 0;
    for value in &values {
        for other in &values {
            for (name, member) in other.as_object().unwrap() {
                if value.get(name).is_some() {
                    continue;
                }
                let mut changed = value.clone();
                changed[name] = member.clone();
                let bytes = serde_json::to_vec(&changed).unwrap();
                assert!(expected(&bytes).is_none());
                assert_eq!(
                    Statement::deserialize(&changed).unwrap_err().to_string(),
                    "STATEMENT_INVALID"
                );
                checked += 1;
            }
        }
    }
    assert!(checked > values.len());
}

#[test]
fn untagged_dispatch_refuses_positional_root_sequences() {
    for value in valid_statements() {
        let positional = Value::Array(value.as_object().unwrap().values().cloned().collect());
        assert_eq!(
            Statement::deserialize(&positional).unwrap_err().to_string(),
            "STATEMENT_INVALID"
        );
        assert_eq!(
            serde_json::from_value::<Statement>(positional)
                .unwrap_err()
                .to_string(),
            "STATEMENT_INVALID"
        );
    }
}

#[test]
fn one_invalid_statement_prevents_a_partial_batch_from_being_returned() {
    let original = valid_statements();
    for index in 0..original.len() {
        let mut values = original.clone();
        values[index]["v"] = json!(0);
        let batch = json!({ "statements": values });
        let borrowed = Batch::deserialize(&batch).unwrap_err();
        let owned = serde_json::from_value::<Batch>(batch).unwrap_err();
        assert_eq!(borrowed.to_string(), "STATEMENT_INVALID");
        assert_eq!(owned.to_string(), "STATEMENT_INVALID");
    }
}

#[test]
fn a_repeated_version_is_not_resolved_by_variant_trial_order() {
    for value in valid_statements() {
        let raw = serde_json::to_string(&value).unwrap();
        for replacement in [json!(1), json!(0), Value::Null] {
            let repeated = format!("{{\"v\":{replacement},{}", &raw[1..]);
            let error = serde_json::from_str::<Statement>(&repeated).unwrap_err();
            assert!(error.to_string().starts_with("STATEMENT_INVALID"));
        }
    }
}

#[test]
fn invalid_statement_errors_do_not_echo_unknown_member_names_or_values() {
    for mut value in valid_statements() {
        value["DYTEST-private-member"] = json!({ "nested": "DYTEST-private-value" });
        let borrowed = Statement::deserialize(&value).unwrap_err().to_string();
        let text = serde_json::from_str::<Statement>(&value.to_string())
            .unwrap_err()
            .to_string();
        assert_eq!(borrowed, "STATEMENT_INVALID");
        assert!(text.starts_with("STATEMENT_INVALID"));
        assert!(!text.contains("DYTEST-private"));
    }
}
