pub mod admin;
pub mod agent_session;
pub mod common;
pub mod hub_key_rotate;
pub mod login;
pub mod pair_confirm;
pub mod send;
use crate::{
    jcs::{JCS_MAX_DEPTH, parse_strict},
    sign,
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{self, DeserializeOwned, DeserializeSeed, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Number, Value};
/// `value` as a `T` that writes it back unchanged. Serde also reads a struct from an array and an
/// enum from a one-member map, at any depth; the TypeScript schemas take only the written form.
pub(crate) fn decode<T: DeserializeOwned + Serialize>(value: &Value) -> Option<T> {
    let received = crate::jcs::bounded_value(value).ok()?;
    let decoded = serde_json::from_value::<T>(received).ok()?;
    (serde_json::to_value(&decoded).ok()? == *value).then_some(decoded)
}
/// [`decode`] over what `decoder` holds, for a `Deserialize` impl; otherwise the error `code`.
pub(crate) fn decode_from<'de, D: Deserializer<'de>, T: DeserializeOwned + Serialize>(
    decoder: D,
    code: &'static str,
) -> Result<T, D::Error> {
    let value = receive_value(decoder, code)?;
    decode(&value).ok_or_else(|| de::Error::custom(code))
}
/// Read an unchecked serde input with the same depth and duplicate-member rules as strict JSON.
/// The static type error also covers reader failures; input names and values never escape.
pub(crate) fn receive_value<'de, D: Deserializer<'de>>(
    decoder: D,
    code: &'static str,
) -> Result<Value, D::Error> {
    decoder
        .deserialize_any(Received { depth: 0 })
        .map_err(|_| de::Error::custom(code))
}
// A `Value` that refuses a member name written twice, as the derives do; serde_json's keeps the
// last one. A container nested deeper than `parse_strict` takes is refused before what it holds
// is read, so no input recurses past that depth.
#[derive(Clone, Copy)]
struct Received {
    depth: usize,
}
impl Received {
    // The seed for what a container opened at this depth holds.
    fn inside<E: de::Error>(self) -> Result<Self, E> {
        if self.depth >= JCS_MAX_DEPTH {
            return Err(E::custom("too deep"));
        }
        Ok(Self {
            depth: self.depth + 1,
        })
    }
}
impl<'de> DeserializeSeed<'de> for Received {
    type Value = Value;
    fn deserialize<D: Deserializer<'de>>(self, decoder: D) -> Result<Value, D::Error> {
        decoder.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Received {
    type Value = Value;
    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("JSON")
    }
    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("number"))
    }
    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<Value, A::Error> {
        let inside = self.inside::<A::Error>()?;
        let mut array = Vec::new();
        while let Some(item) = items.next_element_seed(inside)? {
            array.push(item);
        }
        Ok(Value::Array(array))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut members: A) -> Result<Value, A::Error> {
        let inside = self.inside::<A::Error>()?;
        let mut object = Map::new();
        while let Some(name) = members.next_key::<String>()? {
            if object.contains_key(&name) {
                return Err(de::Error::custom("duplicate member"));
            }
            let value = members.next_value_seed(inside)?;
            object.insert(name, value);
        }
        Ok(Value::Object(object))
    }
}
macro_rules! register_statements {
    ($($module:ident::$variant:ident($name:ident) => $typ:literal),* $(,)?) => {
        pub const TYPES: &[&str] = &[$($typ),*];
        #[derive(Debug, Clone, Serialize)]
        #[serde(untagged)]
        pub enum Statement { $($variant($module::$name)),* }
        impl<'de> Deserialize<'de> for Statement {
            fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
                let value = receive_value(decoder, "STATEMENT_INVALID")?;
                $(if let Some(body) = decode::<$module::$name>(&value) {
                    return Ok(Self::$variant(body));
                })*
                Err(de::Error::custom("STATEMENT_INVALID"))
            }
        }
        pub fn parse_statement(typ: &str, bytes: &[u8]) -> Option<Statement> {
            let value = parse_strict(bytes).ok()?;
            match typ { $($typ => decode(&value).map(Statement::$variant),)* _ => None }
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
    agent_session::Agent(AgentSessionStatement) => "agent-session.v1",
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
