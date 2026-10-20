use draftyak_protocol::statements::{
    admin::AdminStatement, login::LoginStatement, pair_confirm::PairConfirmStatement,
    send::SendStatement,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::fmt::Debug;

const SEND: &str = include_str!("../../../spec/vectors/statements/approval.send.v1.json");
const PAIR: &str = include_str!("../../../spec/vectors/statements/pair-confirm.v1.json");
const LOGIN: &str = include_str!("../../../spec/vectors/statements/login.v1.json");
const ADMIN: &str = include_str!("../../../spec/vectors/statements/admin.v1.json");

fn recorded(document: &str) -> Value {
    let document: Value = serde_json::from_str(document).unwrap();
    document["cases"][0]["statement"].clone()
}

fn roundtrip<T: DeserializeOwned + Serialize>(document: &str) {
    let original = recorded(document);
    let decoded: T = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), original);
}

fn private_error<T: DeserializeOwned + Debug>(value: Value) {
    let error = serde_json::from_value::<T>(value).unwrap_err();
    assert_eq!(error.to_string(), "STATEMENT_INVALID");
    assert!(!format!("{error:?}").contains("PRIVATE_CANARY"));
}

fn unknown(document: &str) -> Value {
    let mut value = recorded(document);
    value["PRIVATE_CANARY"] = json!(true);
    value
}

#[test]
fn existing_device_statement_values_roundtrip_without_wire_changes() {
    roundtrip::<SendStatement>(SEND);
    roundtrip::<PairConfirmStatement>(PAIR);
    roundtrip::<LoginStatement>(LOGIN);
    roundtrip::<AdminStatement>(ADMIN);
}

#[test]
fn send_unknown_field_is_a_fixed_private_error() {
    private_error::<SendStatement>(unknown(SEND));
}

#[test]
fn pair_confirm_unknown_field_is_a_fixed_private_error() {
    private_error::<PairConfirmStatement>(unknown(PAIR));
}

#[test]
fn login_unknown_field_is_a_fixed_private_error() {
    private_error::<LoginStatement>(unknown(LOGIN));
}

#[test]
fn admin_unknown_field_is_a_fixed_private_error() {
    private_error::<AdminStatement>(unknown(ADMIN));
}

#[test]
fn nested_pair_capability_enum_never_echoes_an_unknown_value() {
    let mut value = recorded(PAIR);
    value["capabilities"] = json!(["PRIVATE_CANARY"]);
    private_error::<PairConfirmStatement>(value);
}

#[test]
fn wrong_typed_numeric_field_never_echoes_caller_text() {
    let mut value = recorded(SEND);
    value["epoch"] = json!("PRIVATE_CANARY");
    private_error::<SendStatement>(value);
}

#[test]
fn direct_json_decoding_preserves_generic_error_without_caller_fields() {
    let text = serde_json::to_string(&unknown(ADMIN)).unwrap();
    let error = serde_json::from_str::<AdminStatement>(&text).unwrap_err();
    // A JSON deserializer may append source line/column coordinates, never the supplied field.
    assert!(error.to_string().starts_with("STATEMENT_INVALID"));
    assert!(!error.to_string().contains("PRIVATE_CANARY"));
    assert!(!format!("{error:?}").contains("PRIVATE_CANARY"));
}
