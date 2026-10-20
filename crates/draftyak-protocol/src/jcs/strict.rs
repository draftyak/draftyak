//! The JSON value a Rust value means, built for `canonicalize` with what has no canonical form
//! refused. serde_json's own serializers would write a NaN or infinite float as null, and a number
//! or bool map key as a string.

use super::{JCS_MAX_DEPTH, JcsError};
use serde::ser::{self, Serialize, Serializer};
use serde_json::{Map, Number, Value};
use std::fmt::Display;

pub(super) fn value<T: Serialize + ?Sized>(value: &T) -> Result<Value, JcsError> {
    value.serialize(Strict { depth: 0 })
}

// A `Serialize` implementation that fails, or a value serde has no JSON form for.
impl ser::Error for JcsError {
    fn custom<T: Display>(_: T) -> Self {
        Self::UnsupportedValue
    }
}

type Built = Result<Value, JcsError>;

#[derive(Clone, Copy)]
struct Strict {
    depth: usize,
}

impl Strict {
    // The serializer for what a container opened at this depth holds.
    fn inside(self) -> Result<Self, JcsError> {
        if self.depth >= JCS_MAX_DEPTH {
            return Err(JcsError::TooDeep);
        }
        Ok(Self {
            depth: self.depth + 1,
        })
    }
}

impl Serializer for Strict {
    type Ok = Value;
    type Error = JcsError;
    type SerializeSeq = Items;
    type SerializeTuple = Items;
    type SerializeTupleStruct = Items;
    type SerializeTupleVariant = Items;
    type SerializeMap = Members;
    type SerializeStruct = Members;
    type SerializeStructVariant = Members;

    fn serialize_bool(self, value: bool) -> Built {
        Ok(Value::Bool(value))
    }

    fn serialize_i8(self, value: i8) -> Built {
        self.serialize_i64(value.into())
    }

    fn serialize_i16(self, value: i16) -> Built {
        self.serialize_i64(value.into())
    }

    fn serialize_i32(self, value: i32) -> Built {
        self.serialize_i64(value.into())
    }

    fn serialize_i64(self, value: i64) -> Built {
        Ok(Value::from(value))
    }

    fn serialize_u8(self, value: u8) -> Built {
        self.serialize_u64(value.into())
    }

    fn serialize_u16(self, value: u16) -> Built {
        self.serialize_u64(value.into())
    }

    fn serialize_u32(self, value: u32) -> Built {
        self.serialize_u64(value.into())
    }

    fn serialize_u64(self, value: u64) -> Built {
        Ok(Value::from(value))
    }

    fn serialize_f32(self, value: f32) -> Built {
        self.serialize_f64(value.into())
    }

    fn serialize_f64(self, value: f64) -> Built {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or(JcsError::NumberRange)
    }

    fn serialize_char(self, value: char) -> Built {
        Ok(Value::String(value.into()))
    }

    fn serialize_str(self, value: &str) -> Built {
        Ok(Value::String(value.into()))
    }

    fn serialize_bytes(self, _: &[u8]) -> Built {
        Err(JcsError::UnsupportedValue)
    }

    fn serialize_none(self) -> Built {
        Ok(Value::Null)
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Built {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Built {
        Ok(Value::Null)
    }

    fn serialize_unit_struct(self, _: &'static str) -> Built {
        Ok(Value::Null)
    }

    fn serialize_unit_variant(self, _: &'static str, _: u32, variant: &'static str) -> Built {
        Ok(Value::String(variant.into()))
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(self, _: &'static str, value: &T) -> Built {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        value: &T,
    ) -> Built {
        Ok(tagged(Some(variant), value.serialize(self.inside()?)?))
    }

    fn serialize_seq(self, _: Option<usize>) -> Result<Items, JcsError> {
        let strict = self.inside()?;
        Ok(Items {
            strict,
            items: Vec::new(),
            variant: None,
        })
    }

    fn serialize_tuple(self, len: usize) -> Result<Items, JcsError> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_struct(self, _: &'static str, len: usize) -> Result<Items, JcsError> {
        self.serialize_seq(Some(len))
    }

    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Items, JcsError> {
        let items = self.inside()?.serialize_seq(Some(len))?;
        Ok(Items {
            variant: Some(variant),
            ..items
        })
    }

    fn serialize_map(self, _: Option<usize>) -> Result<Members, JcsError> {
        let strict = self.inside()?;
        Ok(Members {
            strict,
            members: Map::new(),
            key: None,
            variant: None,
        })
    }

    fn serialize_struct(self, _: &'static str, len: usize) -> Result<Members, JcsError> {
        self.serialize_map(Some(len))
    }

    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<Members, JcsError> {
        let members = self.inside()?.serialize_map(Some(len))?;
        Ok(Members {
            variant: Some(variant),
            ..members
        })
    }
}

// An enum variant's content inside {"<variant>": …}, as serde_json writes it.
fn tagged(variant: Option<&'static str>, content: Value) -> Value {
    match variant {
        Some(variant) => Value::Object(Map::from_iter([(variant.into(), content)])),
        None => content,
    }
}

struct Items {
    strict: Strict,
    items: Vec<Value>,
    variant: Option<&'static str>,
}

impl ser::SerializeSeq for Items {
    type Ok = Value;
    type Error = JcsError;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JcsError> {
        self.items.push(value.serialize(self.strict)?);
        Ok(())
    }

    fn end(self) -> Built {
        Ok(tagged(self.variant, Value::Array(self.items)))
    }
}

impl ser::SerializeTuple for Items {
    type Ok = Value;
    type Error = JcsError;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JcsError> {
        ser::SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Built {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for Items {
    type Ok = Value;
    type Error = JcsError;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JcsError> {
        ser::SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Built {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleVariant for Items {
    type Ok = Value;
    type Error = JcsError;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JcsError> {
        ser::SerializeSeq::serialize_element(self, value)
    }

    fn end(self) -> Built {
        ser::SerializeSeq::end(self)
    }
}

struct Members {
    strict: Strict,
    members: Map<String, Value>,
    key: Option<String>,
    variant: Option<&'static str>,
}

impl ser::SerializeMap for Members {
    type Ok = Value;
    type Error = JcsError;

    // A member name is a string, never a number or a bool written as one.
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), JcsError> {
        let Value::String(name) = key.serialize(self.strict)? else {
            return Err(JcsError::UnsupportedValue);
        };
        self.key = Some(name);
        Ok(())
    }

    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), JcsError> {
        let name = self.key.take().ok_or(JcsError::UnsupportedValue)?;
        let value = value.serialize(self.strict)?;
        match self.members.insert(name, value) {
            Some(_) => Err(JcsError::DuplicateKey),
            None => Ok(()),
        }
    }

    fn end(self) -> Built {
        Ok(tagged(self.variant, Value::Object(self.members)))
    }
}

impl ser::SerializeStruct for Members {
    type Ok = Value;
    type Error = JcsError;

    fn serialize_field<T>(&mut self, name: &'static str, value: &T) -> Result<(), JcsError>
    where
        T: Serialize + ?Sized,
    {
        ser::SerializeMap::serialize_entry(self, name, value)
    }

    fn end(self) -> Built {
        ser::SerializeMap::end(self)
    }
}

impl ser::SerializeStructVariant for Members {
    type Ok = Value;
    type Error = JcsError;

    fn serialize_field<T>(&mut self, name: &'static str, value: &T) -> Result<(), JcsError>
    where
        T: Serialize + ?Sized,
    {
        ser::SerializeMap::serialize_entry(self, name, value)
    }

    fn end(self) -> Built {
        ser::SerializeMap::end(self)
    }
}
