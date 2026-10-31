//! RFC 8785 canonical JSON, and a strict parser that refuses exactly what `@draftyak/protocol`'s
//! `parseStrict` refuses, so both languages accept the same documents.

mod strict;

use serde::Serialize;
use serde_json::{Map, Number, Value};

/// Containers may nest this deep and no deeper, in documents and in values alike.
pub const JCS_MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JcsError {
    #[error("JCS_SYNTAX: not RFC 8259 JSON")]
    Syntax,
    #[error("JCS_INVALID_UTF8: the bytes aren't valid UTF-8")]
    InvalidUtf8,
    #[error("JCS_LONE_SURROGATE: a string holds a lone surrogate")]
    LoneSurrogate,
    #[error("JCS_DUPLICATE_KEY: a member name repeats")]
    DuplicateKey,
    #[error("JCS_NUMBER_RANGE: a number beyond the double range")]
    NumberRange,
    #[error("JCS_TOO_DEEP: containers nest deeper than 64")]
    TooDeep,
    #[error("JCS_UNSUPPORTED_VALUE: a value with no JSON form")]
    UnsupportedValue,
}

impl JcsError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Syntax => "JCS_SYNTAX",
            Self::InvalidUtf8 => "JCS_INVALID_UTF8",
            Self::LoneSurrogate => "JCS_LONE_SURROGATE",
            Self::DuplicateKey => "JCS_DUPLICATE_KEY",
            Self::NumberRange => "JCS_NUMBER_RANGE",
            Self::TooDeep => "JCS_TOO_DEEP",
            Self::UnsupportedValue => "JCS_UNSUPPORTED_VALUE",
        }
    }
}

/// The JCS of `value`, every number written as the double it is, as JavaScript writes it. Refused
/// at any depth, as `canonicalize` refuses in TS: a NaN or infinite float (JCS_NUMBER_RANGE); a
/// map key that isn't a string, such as a number or a bool, raw bytes, a 128-bit integer or a
/// failing `Serialize` (JCS_UNSUPPORTED_VALUE); a member name written twice (JCS_DUPLICATE_KEY);
/// nesting deeper than [`JCS_MAX_DEPTH`] (JCS_TOO_DEEP).
pub fn canonicalize<T: Serialize + ?Sized>(value: &T) -> Result<String, JcsError> {
    let value = strict::value(value)?;
    serde_json_canonicalizer::to_string(&value).map_err(|_| JcsError::UnsupportedValue)
}

/// A bounded JSON copy for typed decoders receiving a caller's value rather than JSON bytes.
/// In particular, never clone an unchecked `Value`: its recursive clone precedes typed checks.
pub(crate) fn bounded_value(value: &Value) -> Result<Value, JcsError> {
    strict::value(value)
}

/// RFC 8259 JSON as UTF-8, with duplicate member names, lone surrogates, numbers beyond the double
/// range and nesting deeper than [`JCS_MAX_DEPTH`] refused. Numbers become doubles, as RFC 8785
/// reads them; an integral one is kept as an integer, so typed fields can take it.
pub fn parse_strict(input: &[u8]) -> Result<Value, JcsError> {
    let text = std::str::from_utf8(input).map_err(|_| JcsError::InvalidUtf8)?;
    let mut parser = Parser { text, at: 0 };
    let document = parser.value(0)?;
    parser.space();
    if parser.at < text.len() {
        return Err(JcsError::Syntax);
    }
    Ok(document)
}

/// True when the input is exactly the canonical form of what it holds.
pub fn is_canonical(input: &[u8]) -> bool {
    parse_strict(input)
        .and_then(|value| canonicalize(&value))
        .is_ok_and(|canonical| canonical.as_bytes() == input)
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

const LITERALS: [(&str, Value); 3] = [
    ("true", Value::Bool(true)),
    ("false", Value::Bool(false)),
    ("null", Value::Null),
];

fn digit_at(bytes: &[u8], at: usize) -> bool {
    bytes.get(at).is_some_and(u8::is_ascii_digit)
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    // JSON's whitespace is space, tab, line feed and carriage return only.
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, JcsError> {
        self.space();
        match self.peek() {
            Some(open @ (b'{' | b'[')) => {
                if depth >= JCS_MAX_DEPTH {
                    return Err(JcsError::TooDeep);
                }
                self.at += 1;
                if open == b'{' {
                    self.object(depth + 1)
                } else {
                    self.array(depth + 1)
                }
            }
            Some(b'"') => self.string().map(Value::String),
            _ => {
                for (word, literal) in LITERALS {
                    if self.text[self.at..].starts_with(word) {
                        self.at += word.len();
                        return Ok(literal);
                    }
                }
                self.number()
            }
        }
    }

    // -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?, as long as it matches, read as the nearest
    // double by core's correctly rounding parser.
    fn number(&mut self) -> Result<Value, JcsError> {
        let bytes = self.text.as_bytes();
        let mut end = self.at + usize::from(bytes.get(self.at) == Some(&b'-'));
        match bytes.get(end) {
            Some(b'0') => end += 1,
            Some(b'1'..=b'9') => {
                end += 1;
                while digit_at(bytes, end) {
                    end += 1;
                }
            }
            _ => return Err(JcsError::Syntax),
        }
        if bytes.get(end) == Some(&b'.') && digit_at(bytes, end + 1) {
            end += 2;
            while digit_at(bytes, end) {
                end += 1;
            }
        }
        if matches!(bytes.get(end), Some(b'e' | b'E')) {
            let digits = end + 1 + usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
            if digit_at(bytes, digits) {
                end = digits + 1;
                while digit_at(bytes, end) {
                    end += 1;
                }
            }
        }
        let number: f64 = self.text[self.at..end]
            .parse()
            .map_err(|_| JcsError::Syntax)?;
        if !number.is_finite() {
            return Err(JcsError::NumberRange);
        }
        self.at = end;
        Ok(Value::Number(number_value(number)?))
    }

    fn string(&mut self) -> Result<String, JcsError> {
        self.at += 1;
        let mut start = self.at;
        // UTF-16 code units once an escape appears, so \uXXXX pairs join as JavaScript joins them.
        let mut units: Option<Vec<u16>> = None;
        loop {
            match self.peek() {
                Some(b'"') => {
                    let tail = &self.text[start..self.at];
                    self.at += 1;
                    return match units {
                        None => Ok(tail.to_owned()),
                        Some(mut units) => {
                            units.extend(tail.encode_utf16());
                            String::from_utf16(&units).map_err(|_| JcsError::LoneSurrogate)
                        }
                    };
                }
                Some(b'\\') => {
                    let units = units.get_or_insert_with(Vec::new);
                    units.extend(self.text[start..self.at].encode_utf16());
                    let unit = match self.text.as_bytes().get(self.at + 1) {
                        Some(b'u') => {
                            let hex = self.text.get(self.at + 2..self.at + 6);
                            let unit = hex
                                .filter(|hex| hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
                                .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                                .ok_or(JcsError::Syntax)?;
                            self.at += 4;
                            unit
                        }
                        Some(b'"') => 0x22,
                        Some(b'\\') => 0x5c,
                        Some(b'/') => 0x2f,
                        Some(b'b') => 0x08,
                        Some(b'f') => 0x0c,
                        Some(b'n') => 0x0a,
                        Some(b'r') => 0x0d,
                        Some(b't') => 0x09,
                        _ => return Err(JcsError::Syntax),
                    };
                    units.push(unit);
                    self.at += 2;
                    start = self.at;
                }
                None => return Err(JcsError::Syntax),
                Some(byte) if byte < 0x20 => return Err(JcsError::Syntax),
                Some(_) => self.at += 1,
            }
        }
    }

    // After an item: true at the closing bracket, false after a comma.
    fn next(&mut self, close: u8) -> Result<bool, JcsError> {
        self.space();
        let found = self.peek();
        if found == Some(close) || found == Some(b',') {
            self.at += 1;
            return Ok(found == Some(close));
        }
        Err(JcsError::Syntax)
    }

    fn array(&mut self, depth: usize) -> Result<Value, JcsError> {
        let mut items = Vec::new();
        self.space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value(depth)?);
            if self.next(b']')? {
                return Ok(Value::Array(items));
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, JcsError> {
        let mut members = Map::new();
        self.space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Value::Object(members));
        }
        loop {
            self.space();
            if self.peek() != Some(b'"') {
                return Err(JcsError::Syntax);
            }
            let name = self.string()?;
            if members.contains_key(&name) {
                return Err(JcsError::DuplicateKey);
            }
            self.space();
            if self.peek() != Some(b':') {
                return Err(JcsError::Syntax);
            }
            self.at += 1;
            members.insert(name, self.value(depth)?);
            if self.next(b'}')? {
                return Ok(Value::Object(members));
            }
        }
    }
}

const TWO_POW_63: f64 = 9_223_372_036_854_775_808.0;

// An integral double inside the 64-bit range as an integer, which JCS writes as the same double.
fn number_value(number: f64) -> Result<Number, JcsError> {
    if number.fract() == 0.0 {
        if (0.0..2.0 * TWO_POW_63).contains(&number) {
            return Ok(Number::from(number as u64));
        }
        if (-TWO_POW_63..0.0).contains(&number) {
            return Ok(Number::from(number as i64));
        }
    }
    Number::from_f64(number).ok_or(JcsError::NumberRange)
}
