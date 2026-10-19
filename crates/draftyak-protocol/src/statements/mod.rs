pub mod admin;
pub mod common;
pub mod hub_key_rotate;
pub mod login;
pub mod pair_confirm;
pub mod send;
use crate::{jcs::parse_strict, sign};
use serde::{Deserialize, Serialize};
use serde_json::Value;
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Option<T> {
    serde_json::from_value(value).ok()
}
macro_rules! register_statements {
    ($($module:ident::$variant:ident($name:ident) => $typ:literal),* $(,)?) => {
        pub const TYPES: &[&str] = &[$($typ),*];
        #[derive(Debug, Clone, Serialize, Deserialize)]
        #[serde(untagged)]
        pub enum Statement { $($variant($module::$name)),* }
        pub fn parse_statement(typ: &str, bytes: &[u8]) -> Option<Statement> {
            let value = parse_strict(bytes).ok()?;
            match typ { $($typ => decode(value).map(Statement::$variant),)* _ => None }
        }
    }
}
// One plain module declaration and one registration line supply each type and dispatch arm.
register_statements! {
    send::Send(SendStatement) => "approval.send.v1",
    pair_confirm::Pair(PairConfirmStatement) => "pair-confirm.v1",
    login::Login(LoginStatement) => "login.v1",
    admin::Admin(AdminStatement) => "admin.v1",
    hub_key_rotate::Rotate(HubKeyRotateStatement) => "hub-key-rotate.v1",
}
pub fn open_typed_statement(
    typ: &str,
    bytes: &[u8],
    signature: &[u8],
    key: &[u8],
) -> Option<Statement> {
    sign::verify(typ, bytes, signature, key).ok()??;
    parse_statement(typ, bytes)
}
