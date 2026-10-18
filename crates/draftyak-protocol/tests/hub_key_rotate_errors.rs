use draftyak_protocol::statements::hub_key_rotate::HubKeyRotateStatement;
use serde_json::{Value, json};

const ROTATE: &str = include_str!("../../../spec/vectors/statements/hub-key-rotate.v1.json");

fn recorded() -> Value {
    let document: Value = serde_json::from_str(ROTATE).unwrap();
    document["cases"][0]["statement"].clone()
}

fn private_error(value: Value) {
    let error = serde_json::from_value::<HubKeyRotateStatement>(value).unwrap_err();
    assert_eq!(error.to_string(), "STATEMENT_INVALID");
    assert!(!format!("{error:?}").contains("PRIVATE_CANARY"));
}

#[test]
fn existing_rotation_value_roundtrips_without_wire_changes() {
    let original = recorded();
    let decoded: HubKeyRotateStatement = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), original);
}

#[test]
fn rotation_unknown_field_never_echoes_caller_names() {
    let mut value = recorded();
    value["PRIVATE_CANARY"] = json!(true);
    private_error(value);
}

#[test]
fn rotation_wrong_typed_epoch_never_echoes_caller_values() {
    let mut value = recorded();
    value["epoch"] = json!("PRIVATE_CANARY");
    private_error(value);
}

#[test]
fn direct_rotation_json_error_preserves_only_generic_code_and_coordinates() {
    let mut value = recorded();
    value["PRIVATE_CANARY"] = json!(true);
    let text = serde_json::to_string(&value).unwrap();
    let error = serde_json::from_str::<HubKeyRotateStatement>(&text).unwrap_err();
    assert!(error.to_string().starts_with("STATEMENT_INVALID"));
    assert!(!error.to_string().contains("PRIVATE_CANARY"));
    assert!(!format!("{error:?}").contains("PRIVATE_CANARY"));
}
