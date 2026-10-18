//! JCS fuzzing and the API's edges that the shared vectors don't reach.

use draftyak_protocol::hash;
use draftyak_protocol::jcs::{self, JCS_MAX_DEPTH, JcsError};
use draftyak_protocol::sign::{self, SignError, base64url_decode, base64url_encode, spki_der};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use proptest::prelude::*;
use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn json_value() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(Value::from),
        any::<u64>().prop_map(Value::from),
        any::<f64>()
            .prop_filter("finite", |double| double.is_finite())
            .prop_map(Value::from),
        any::<String>().prop_map(Value::String),
    ];
    leaf.prop_recursive(8, 96, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::btree_map(any::<String>(), inner, 0..6)
                .prop_map(|members| Value::Object(members.into_iter().collect())),
        ]
    })
}

// Bytes drawn from JSON's own alphabet, plus bytes that break UTF-8, to reach every refusal.
fn json_like_bytes() -> impl Strategy<Value = Vec<u8>> {
    let alphabet = b"{}[]\":,\\/ \t\n-+.0123456789eEtrufalsn\"ud8c0A\x0b".to_vec();
    let byte = prop_oneof![
        8 => prop::sample::select(alphabet),
        1 => prop::sample::select(vec![0xc3, 0xa9, 0xed, 0xa0, 0x80, 0xff, 0xef, 0xbb, 0xbf]),
    ];
    prop::collection::vec(byte, 0..40)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1000))]

    #[test]
    fn canonical_text_is_a_fixed_point(value in json_value()) {
        let canonical = jcs::canonicalize(&value).expect("a JSON value has a canonical form");
        let parsed = jcs::parse_strict(canonical.as_bytes()).expect("canonical text parses");
        prop_assert_eq!(jcs::canonicalize(&parsed), Ok(canonical.clone()));
        prop_assert!(jcs::is_canonical(canonical.as_bytes()));
        let pretty = serde_json::to_vec_pretty(&value).expect("JSON");
        let reparsed = jcs::parse_strict(&pretty).expect("pretty JSON parses");
        prop_assert_eq!(jcs::canonicalize(&reparsed), Ok(canonical));
    }

    #[test]
    fn the_parser_refuses_cleanly(bytes in json_like_bytes()) {
        match jcs::parse_strict(&bytes) {
            Ok(value) => {
                let canonical = jcs::canonicalize(&value).expect("parsed values canonicalize");
                prop_assert_eq!(jcs::is_canonical(&bytes), canonical.as_bytes() == bytes.as_slice());
            }
            Err(_) => prop_assert!(!jcs::is_canonical(&bytes)),
        }
    }

    #[test]
    fn signatures_cover_every_byte(value in json_value(), flip in any::<prop::sample::Index>()) {
        let key = SigningKey::from_slice(&[9; 32]).expect("a P-256 scalar");
        let statement = json!({"v": 1, "x": value});
        match sign::sign(&key, "test-statement.v1", &statement) {
            Ok(signature) => {
                // RFC 6979 exactly, with S as computed: about half of these have a high S.
                let input = sign::signing_input("test-statement.v1", &statement).expect("an input");
                let rfc6979: [u8; 64] = Signer::<Signature>::sign(&key, &input).to_bytes().into();
                prop_assert_eq!(signature, rfc6979);
                let mut received = jcs::canonicalize(&statement).expect("JCS").into_bytes();
                let spki = spki_der(key.verifying_key());
                let opened = sign::verify("test-statement.v1", &received, &signature, &spki);
                prop_assert!(matches!(opened, Ok(Some(_))));
                let at = flip.index(received.len());
                received[at] ^= 1;
                let tampered = sign::verify("test-statement.v1", &received, &signature, &spki);
                prop_assert_eq!(tampered, Ok(None));
            }
            Err(error) => prop_assert_eq!(error, SignError::UnsafeNumber),
        }
    }
}

// Writes the member "a" twice, as a careless Serialize implementation could.
struct Repeated;

impl Serialize for Repeated {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("a", &1)?;
        map.serialize_entry("a", &2)?;
        map.end()
    }
}

fn nested(depth: usize) -> Value {
    (0..depth).fold(Value::Null, |inner, _| Value::Array(vec![inner]))
}

#[test]
fn canonicalize_refuses_what_has_no_canonical_form() {
    assert_eq!(
        jcs::canonicalize(&f64::INFINITY),
        Err(JcsError::NumberRange)
    );
    assert_eq!(jcs::canonicalize(&Repeated), Err(JcsError::DuplicateKey));
    let tuple_keys = BTreeMap::from([((1, 2), 3)]);
    assert_eq!(
        jcs::canonicalize(&tuple_keys),
        Err(JcsError::UnsupportedValue)
    );
    assert!(jcs::canonicalize(&nested(JCS_MAX_DEPTH)).is_ok());
    assert_eq!(
        jcs::canonicalize(&nested(JCS_MAX_DEPTH + 1)),
        Err(JcsError::TooDeep)
    );
    assert_eq!(
        jcs::canonicalize(&json!({"a]": "[{\"}"})).as_deref(),
        Ok(r#"{"a]":"[{\"}"}"#)
    );
    let big = json!([u64::MAX, i64::MIN, 9_007_199_254_740_993_u64]);
    assert_eq!(
        jcs::canonicalize(&big).as_deref(),
        Ok("[18446744073709552000,-9223372036854776000,9007199254740992]")
    );
}

#[derive(Serialize)]
struct Reading {
    at: u64,
    level: f64,
    spread: Option<f32>,
    marks: Vec<f64>,
}

#[test]
fn non_finite_floats_are_refused_at_any_depth() {
    let reading = |level, spread, marks| Reading {
        at: 1_792_000_000_000,
        level,
        spread,
        marks,
    };
    assert_eq!(
        jcs::canonicalize(&reading(0.5, None, vec![-0.0, 1e21])).as_deref(),
        Ok(r#"{"at":1792000000000,"level":0.5,"marks":[0,1e+21],"spread":null}"#)
    );
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let in_field = reading(bad, None, vec![]);
        let in_option = reading(0.5, Some(bad as f32), vec![]);
        let in_vec = reading(0.5, None, vec![1.0, bad]);
        for value in [&in_field, &in_option, &in_vec] {
            let refused = Err(JcsError::NumberRange);
            assert_eq!(jcs::canonicalize(value), refused);
            assert_eq!(hash::jcs_sha256(value), refused);
            let input = sign::signing_input("a.v1", value);
            assert_eq!(input, Err(SignError::Jcs(JcsError::NumberRange)));
        }
        let in_map = BTreeMap::from([("x", [Some(bad)])]);
        assert_eq!(jcs::canonicalize(&in_map), Err(JcsError::NumberRange));
    }
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
enum Side {
    Left,
    Right,
}

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct Name(&'static str);

// What serialize_bytes, a 128-bit integer or a failing Serialize gives.
struct Odd(u8);

impl Serialize for Odd {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            0 => serializer.serialize_bytes(b"ab"),
            1 => serializer.serialize_i128(1),
            _ => Err(serde::ser::Error::custom("no JSON form")),
        }
    }
}

#[test]
fn map_keys_are_strings_and_odd_values_are_refused() {
    let unsupported = Err(JcsError::UnsupportedValue);
    assert_eq!(
        jcs::canonicalize(&BTreeMap::from([(1_u32, "a")])),
        unsupported
    );
    let above = BTreeMap::from([(9_007_199_254_740_993_u64, "x")]);
    assert_eq!(jcs::canonicalize(&above), unsupported);
    assert_eq!(jcs::canonicalize(&BTreeMap::from([(true, 1)])), unsupported);
    assert_eq!(
        jcs::canonicalize(&BTreeMap::from([(None::<&str>, 1)])),
        unsupported
    );
    for odd in 0..3 {
        assert_eq!(jcs::canonicalize(&[Odd(odd)]), unsupported, "{odd}");
    }
    let keys = [
        jcs::canonicalize(&BTreeMap::from([('\u{e9}', 1), ('a', 2)])),
        jcs::canonicalize(&BTreeMap::from([(Side::Right, 1), (Side::Left, 2)])),
        jcs::canonicalize(&BTreeMap::from([(Name("b"), 1), (Name("a"), 2)])),
    ];
    let texts: Vec<_> = keys.iter().map(|text| text.as_deref()).collect();
    assert_eq!(
        texts,
        [
            Ok("{\"a\":2,\"\u{e9}\":1}"),
            Ok(r#"{"Left":2,"Right":1}"#),
            Ok(r#"{"a":2,"b":1}"#)
        ]
    );
}

#[derive(Serialize)]
enum Tree {
    Leaf,
    Node(Box<Tree>),
    Pair(Box<Tree>, u8),
    Named { inner: Box<Tree> },
}

#[test]
fn enum_variants_are_written_and_nested_as_serde_json_writes_them() {
    let node = |inner| Tree::Node(Box::new(inner));
    let pair = |inner| Tree::Pair(Box::new(inner), 7);
    let named = |inner| Tree::Named {
        inner: Box::new(inner),
    };
    let text = jcs::canonicalize(&named(pair(node(Tree::Leaf))));
    assert_eq!(
        text.as_deref(),
        Ok(r#"{"Named":{"inner":{"Pair":[{"Node":"Leaf"},7]}}}"#)
    );
    // A Node adds one level, a Pair or a Named two.
    let nodes = |count| (0..count).fold(Tree::Leaf, |tree, _| node(tree));
    assert!(jcs::canonicalize(&nodes(64)).is_ok());
    assert_eq!(jcs::canonicalize(&nodes(65)), Err(JcsError::TooDeep));
    for wrap in [&pair as &dyn Fn(Tree) -> Tree, &named] {
        let wrapped = |inner| (0..32).fold(inner, |tree, _| wrap(tree));
        assert!(jcs::canonicalize(&wrapped(nodes(0))).is_ok());
        assert_eq!(
            jcs::canonicalize(&wrapped(nodes(1))),
            Err(JcsError::TooDeep)
        );
    }
}

#[test]
fn parse_strict_keeps_integral_numbers_as_integers() {
    let value = jcs::parse_strict(b"[1792000000000,-1,1e3,0.5,-0,1e19,1e20,1e21]").expect("JSON");
    let numbers: Vec<_> = value.as_array().expect("an array").iter().collect();
    assert_eq!(numbers[0].as_u64(), Some(1_792_000_000_000));
    assert_eq!(numbers[1].as_i64(), Some(-1));
    assert_eq!(numbers[2].as_u64(), Some(1000));
    assert_eq!(numbers[3].as_f64(), Some(0.5));
    assert_eq!(numbers[4].as_u64(), Some(0));
    assert_eq!(numbers[5].as_u64(), Some(10_000_000_000_000_000_000));
    assert!(numbers[6].is_f64() && numbers[7].is_f64());
    let canonical =
        "[1792000000000,-1,1000,0.5,0,10000000000000000000,100000000000000000000,1e+21]";
    assert_eq!(jcs::canonicalize(&value).as_deref(), Ok(canonical));
}

#[test]
fn signing_input_checks_typ_first_then_the_statement() {
    assert_eq!(
        sign::signing_input("Bad", &json!([])),
        Err(SignError::InvalidTyp)
    );
    assert_eq!(
        sign::signing_input("a.v1", &json!([])),
        Err(SignError::NotObject)
    );
    assert_eq!(
        sign::signing_input("a.v1", &json!({"x": [0.5]})),
        Err(SignError::UnsafeNumber)
    );
    assert_eq!(
        sign::signing_input("a.v1", &json!({"x": 9_007_199_254_740_992_u64})),
        Err(SignError::UnsafeNumber)
    );
    assert_eq!(
        sign::signing_input("a.v1", &f64::NAN),
        Err(SignError::Jcs(JcsError::NumberRange))
    );
    let input = sign::signing_input(
        "a.b-c.v12",
        &json!({"b": -9_007_199_254_740_991_i64, "a": 2.0}),
    );
    assert_eq!(
        input.as_deref(),
        Ok(&b"draftyak/v1/a.b-c.v12\n{\"a\":2,\"b\":-9007199254740991}"[..])
    );
    for typ in [
        "",
        "v1",
        ".v1",
        "a.v",
        "a..v1",
        "a.v1\n",
        "a-.V1",
        "\u{e9}.v1",
        "a.v1.",
        "1a.v1",
    ] {
        assert_eq!(
            sign::signing_input(typ, &json!({})),
            Err(SignError::InvalidTyp),
            "{typ:?}"
        );
    }
}

// RFC 6979 A.2.5 (P-256, SHA-256), which pins the nonce the shared vectors' RFC 6979 signatures use.
#[test]
fn signatures_follow_rfc6979_appendix_a25() {
    let key = SigningKey::from_slice(&unhex(
        "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721",
    ))
    .expect("x");
    let expected = [
        (
            "sample",
            "efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8",
        ),
        (
            "test",
            "f1abb023518351cd71d881567b1ea663ed3efcf6c5132b354f28d3b0b7d38367019f4113742a2b14bd25926b49c649155f267e60d3814b4c0cc84250e46f0083",
        ),
    ];
    for (message, signature) in expected {
        let signed: Signature = key.sign(message.as_bytes());
        assert_eq!(signed.to_bytes().to_vec(), unhex(signature), "{message}");
    }
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn keys_and_base64url_have_one_encoding() {
    let key = SigningKey::from_slice(&[5; 32]).expect("a P-256 scalar");
    let spki = spki_der(key.verifying_key());
    let mut longer = spki.to_vec();
    longer.push(0);
    assert_eq!(
        sign::verifying_key_from_spki(&longer).err(),
        Some(SignError::InvalidKey)
    );
    let point = key.verifying_key().to_sec1_point(true);
    let compressed = [
        &[0x30, 0x39, 0x30, 0x13][..],
        &spki[4..23],
        &[0x03, 0x22, 0x00],
        point.as_bytes(),
    ]
    .concat();
    assert_eq!(compressed.len(), 59);
    // p256 reads the compressed point, so the crate checks the form itself.
    assert!(VerifyingKey::from_public_key_der(&compressed).is_ok());
    assert_eq!(
        sign::verifying_key_from_spki(&compressed).err(),
        Some(SignError::InvalidKey)
    );
    assert_eq!(base64url_encode(&[0xfb, 0xff]), "-_8");
    assert_eq!(base64url_decode("-_8"), Some(vec![0xfb, 0xff]));
    for loose in ["-_9", "-_8=", "-_+", "A", "AAAAA", "AA AA", "AAA\n"] {
        assert_eq!(base64url_decode(loose), None, "{loose:?}");
    }
    assert_eq!(base64url_decode(""), Some(vec![]));
}
