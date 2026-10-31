use draftyak_protocol::{
    hub_runtime::SchedulingStatus,
    jcs::{JCS_MAX_DEPTH, JcsError, parse_strict},
    scheduled_summary::{ScheduledItem, ScheduledSummary},
    statements::{Statement, TYPES},
};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{
        DeserializeOwned, IntoDeserializer, Visitor, value::MapDeserializer, value::SeqDeserializer,
    },
    forward_to_deserialize_any,
};
use serde_json::{Map, Value, json};
use std::{cell::Cell, fmt::Debug, fs, mem::ManuallyDrop, path::PathBuf};

const OWNED_CHILD: &str = "DRAFTYAK_PROTOCOL_OWNED_DEPTH_CHILD";
const OWNED_COMPLETE: &str = "DYTEST-OWNED-DEPTH-COMPLETE";

#[derive(Debug, Deserialize)]
struct Field<T> {
    value: T,
}

#[derive(Debug, Deserialize)]
struct List<T> {
    values: Vec<T>,
}

fn vector_cases(relative: &str) -> Vec<Value> {
    let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/vectors")
        .join(relative);
    let document: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
    document["cases"].as_array().unwrap().clone()
}

fn summary_case(name: &str) -> Value {
    vector_cases("scheduled-summary/cases.json")
        .into_iter()
        .find(|case| case["id"] == name)
        .unwrap()["value"]
        .clone()
}

fn status() -> Value {
    json!({ "mode": "sidecar", "scheduler": "running", "syncPaused": false })
}

fn statement() -> Value {
    statement_values().into_iter().next().unwrap().1
}

fn statement_values() -> Vec<(String, Value)> {
    TYPES
        .iter()
        .map(|typ| {
            let case = vector_cases(&format!("statements/{typ}.json"))
                .into_iter()
                .find(|case| case["valid"] == true)
                .unwrap();
            let hex = case["receivedHex"].as_str().unwrap();
            let bytes: Vec<_> = (0..hex.len())
                .step_by(2)
                .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
                .collect();
            ((*typ).to_owned(), parse_strict(&bytes).unwrap())
        })
        .collect()
}

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

fn bare_error<T: Debug>(result: Result<T, impl std::fmt::Display>, code: &str) {
    match result {
        Ok(value) => panic!("accepted an invalid value as {code}: {value:?}"),
        Err(error) => assert_eq!(error.to_string(), code),
    }
}

/// Direct values and a caller's struct or list must use the same validated type.
fn refuses<T: DeserializeOwned + Debug>(value: &Value, code: &str) {
    bare_error(T::deserialize(value), code);
    bare_error(serde_json::from_value::<T>(value.clone()), code);
    let field = json!({ "value": value });
    bare_error(
        Field::<T>::deserialize(&field).map(|field| field.value),
        code,
    );
    bare_error(
        serde_json::from_value::<Field<T>>(field).map(|field| field.value),
        code,
    );
    let list = json!({ "values": [value] });
    bare_error(List::<T>::deserialize(&list).map(|list| list.values), code);
    bare_error(
        serde_json::from_value::<List<T>>(list).map(|list| list.values),
        code,
    );
    let error = serde_json::from_slice::<T>(&bytes(value)).unwrap_err();
    assert!(error.to_string().starts_with(code), "{error}");
}

fn accepts<T: DeserializeOwned + Serialize + Debug>(value: &Value) {
    let owned: T = serde_json::from_value(value.clone()).unwrap();
    let borrowed = T::deserialize(value).unwrap();
    let text: T = serde_json::from_slice(&bytes(value)).unwrap();
    let field: Field<T> = serde_json::from_value(json!({ "value": value })).unwrap();
    let list: List<T> = serde_json::from_value(json!({ "values": [value, value] })).unwrap();
    for item in [owned, borrowed, text, field.value] {
        assert_eq!(serde_json::to_value(item).unwrap(), *value);
    }
    assert_eq!(list.values.len(), 2);
    for item in list.values {
        assert_eq!(serde_json::to_value(item).unwrap(), *value);
    }
}

fn container(inner: Value, object: bool) -> Value {
    if object {
        Value::Object(Map::from_iter([("nested".to_owned(), inner)]))
    } else {
        Value::Array(vec![inner])
    }
}

fn nested(levels: usize, object: bool) -> Value {
    (0..levels).fold(Value::Null, |inner, _| container(inner, object))
}

fn extra(value: &Value, levels: usize, object: bool) -> Value {
    let mut value = value.clone();
    value["nested"] = nested(levels, object);
    value
}

/// A deserializer that counts the values requested, without building a recursive input first.
#[derive(Clone, Copy)]
struct Counted<'a> {
    remaining: usize,
    object: bool,
    read: &'a Cell<usize>,
}

impl<'de> Deserializer<'de> for Counted<'_> {
    type Error = serde::de::value::Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        self.read.set(self.read.get() + 1);
        let Some(remaining) = self.remaining.checked_sub(1) else {
            return visitor.visit_unit();
        };
        let inside = Self { remaining, ..self };
        if self.object {
            visitor.visit_map(MapDeserializer::new(std::iter::once(("nested", inside))))
        } else {
            visitor.visit_seq(SeqDeserializer::new(std::iter::once(inside)))
        }
    }

    forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
        option unit unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier
        ignored_any
    }
}

impl<'de> IntoDeserializer<'de> for Counted<'_> {
    type Deserializer = Self;

    fn into_deserializer(self) -> Self {
        self
    }
}

fn read_count<T: DeserializeOwned + Debug>(levels: usize, object: bool, code: &str) -> usize {
    let read = Cell::new(0);
    let input = Counted {
        remaining: levels,
        object,
        read: &read,
    };
    bare_error(T::deserialize(input), code);
    let alone = read.replace(0);
    let field = MapDeserializer::new(std::iter::once(("value", input)));
    bare_error(
        Field::<T>::deserialize(field).map(|field| field.value),
        code,
    );
    assert_eq!(read.get(), alone, "field and direct reader disagree");
    alone
}

fn depth_contract<T: DeserializeOwned + Debug>(code: &str, valid: &Value) {
    for object in [false, true] {
        for levels in [0, 1, 2, JCS_MAX_DEPTH - 1, JCS_MAX_DEPTH] {
            let value = nested(levels, object);
            let expected = (levels + 1).min(JCS_MAX_DEPTH + 1);
            assert_eq!(read_count::<T>(levels, object, code), expected);
            refuses::<T>(&value, code);
        }
        // The outer valid object consumes one of the existing 64 permitted containers.
        let at = extra(valid, JCS_MAX_DEPTH - 1, object);
        let past = extra(valid, JCS_MAX_DEPTH, object);
        assert!(parse_strict(&bytes(&at)).is_ok());
        assert_eq!(parse_strict(&bytes(&past)).unwrap_err(), JcsError::TooDeep);
        refuses::<T>(&at, code);
        refuses::<T>(&past, code);
        for levels in [JCS_MAX_DEPTH + 1, 4095, 100_000] {
            assert_eq!(read_count::<T>(levels, object, code), JCS_MAX_DEPTH + 1);
        }
    }
}

fn far_borrowed<T: DeserializeOwned + Debug>(code: &str, valid: &Value) {
    for object in [false, true] {
        // Dropping a caller's own recursively built Value is not part of decoding its borrow.
        let value = ManuallyDrop::new(extra(valid, 100_000, object));
        bare_error(T::deserialize(&*value), code);
        let field = ManuallyDrop::new(Value::Object(Map::from_iter([(
            "value".to_owned(),
            extra(valid, 100_000, object),
        )])));
        bare_error(
            Field::<T>::deserialize(&*field).map(|field| field.value),
            code,
        );
    }
}

#[test]
fn scheduling_status_stops_at_the_strict_parser_depth() {
    depth_contract::<SchedulingStatus>("SCHEDULING_STATUS_INVALID", &status());
}

#[test]
fn scheduled_item_stops_at_the_strict_parser_depth() {
    depth_contract::<ScheduledItem>("SCHEDULED_ITEM_INVALID", &summary_case("item-base"));
}

#[test]
fn scheduled_summary_stops_at_the_strict_parser_depth() {
    depth_contract::<ScheduledSummary>(
        "SCHEDULED_SUMMARY_INVALID",
        &summary_case("summary-bounded-page"),
    );
}

#[test]
fn statement_dispatch_stops_before_buffering_an_untagged_value_past_the_limit() {
    depth_contract::<Statement>("STATEMENT_INVALID", &statement());
}

#[test]
fn all_direct_readers_refuse_deep_borrows_on_a_small_stack() {
    let values = [
        status(),
        summary_case("item-base"),
        summary_case("summary-bounded-page"),
        statement(),
    ];
    std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(move || {
            far_borrowed::<SchedulingStatus>("SCHEDULING_STATUS_INVALID", &values[0]);
            far_borrowed::<ScheduledItem>("SCHEDULED_ITEM_INVALID", &values[1]);
            far_borrowed::<ScheduledSummary>("SCHEDULED_SUMMARY_INVALID", &values[2]);
            far_borrowed::<Statement>("STATEMENT_INVALID", &values[3]);
        })
        .unwrap()
        .join()
        .unwrap();
}

fn far_owned<T: DeserializeOwned + Debug>(code: &str, valid: &Value) {
    // serde_json recursively destroys unconsumed owned input when any reader returns an error.
    // Deep object destruction can itself exceed this stack; borrowed cases above isolate decoding.
    for (object, levels) in [(false, 4095), (true, JCS_MAX_DEPTH + 1)] {
        let value = extra(valid, levels, object);
        bare_error(serde_json::from_value::<T>(value), code);
        let field = Value::Object(Map::from_iter([(
            "value".to_owned(),
            extra(valid, levels, object),
        )]));
        bare_error(
            serde_json::from_value::<Field<T>>(field).map(|field| field.value),
            code,
        );
    }
}

#[test]
fn owned_values_with_bounded_cleanup_are_refused_on_a_two_mebibyte_stack() {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "owned_value_depth_child", "--nocapture"])
        .env(OWNED_CHILD, "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "owned-value decoding failed in its isolated child: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("running 1 test"), "{stdout}");
    assert!(
        stdout.contains(OWNED_COMPLETE),
        "the owned-value body did not run: {stdout}"
    );
}

#[test]
fn owned_value_depth_child() {
    if std::env::var(OWNED_CHILD).as_deref() != Ok("1") {
        return;
    }
    let values = [
        status(),
        summary_case("item-base"),
        summary_case("summary-bounded-page"),
        statement(),
    ];
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            far_owned::<SchedulingStatus>("SCHEDULING_STATUS_INVALID", &values[0]);
            far_owned::<ScheduledItem>("SCHEDULED_ITEM_INVALID", &values[1]);
            far_owned::<ScheduledSummary>("SCHEDULED_SUMMARY_INVALID", &values[2]);
            far_owned::<Statement>("STATEMENT_INVALID", &values[3]);
        })
        .unwrap()
        .join()
        .unwrap();
    println!("{OWNED_COMPLETE}");
}

/// Object members are serialized independently, keeping the duplicate on the JSON wire.
fn repeated_member(value: &Value, member: &str, replacement: &Value) -> String {
    let object = value.as_object().unwrap();
    assert!(object.contains_key(member));
    let mut pairs = object
        .iter()
        .map(|(name, value)| format!("{}:{}", serde_json::to_string(name).unwrap(), value))
        .collect::<Vec<_>>();
    pairs.push(format!(
        "{}:{replacement}",
        serde_json::to_string(member).unwrap()
    ));
    format!("{{{}}}", pairs.join(","))
}

fn refuses_text<T: DeserializeOwned + Debug>(text: &str, code: &str) {
    let direct = serde_json::from_str::<T>(text).unwrap_err();
    assert!(direct.to_string().starts_with(code), "{direct}");
    let wrapped = format!("{{\"value\":{text}}}");
    let field = serde_json::from_str::<Field<T>>(&wrapped).unwrap_err();
    assert!(field.to_string().starts_with(code), "{field}");
    let wrapped = format!("{{\"values\":[{text}]}}");
    let list = serde_json::from_str::<List<T>>(&wrapped).unwrap_err();
    assert!(list.to_string().starts_with(code), "{list}");
}

fn duplicate_contract<T: DeserializeOwned + Debug>(value: &Value, code: &str) {
    for (name, member) in value.as_object().unwrap() {
        for replacement in [member.clone(), Value::Null, json!("DYTEST-private-input")] {
            let text = repeated_member(value, name, &replacement);
            assert_eq!(
                parse_strict(text.as_bytes()).unwrap_err(),
                JcsError::DuplicateKey
            );
            refuses_text::<T>(&text, code);
            // A repeated first field is refused, regardless of which occurrence was valid.
            let reversed = format!(
                "{{{}:{replacement},{}",
                serde_json::to_string(name).unwrap(),
                &serde_json::to_string(value).unwrap()[1..]
            );
            refuses_text::<T>(&reversed, code);
        }
    }
}

#[test]
fn status_serde_paths_refuse_duplicate_members_like_the_byte_parser() {
    duplicate_contract::<SchedulingStatus>(&status(), "SCHEDULING_STATUS_INVALID");
}

#[test]
fn scheduled_item_serde_paths_refuse_duplicate_members() {
    duplicate_contract::<ScheduledItem>(&summary_case("item-base"), "SCHEDULED_ITEM_INVALID");
}

#[test]
fn scheduled_summary_serde_paths_refuse_duplicate_members() {
    duplicate_contract::<ScheduledSummary>(
        &summary_case("summary-bounded-page"),
        "SCHEDULED_SUMMARY_INVALID",
    );
}

#[test]
fn statement_dispatch_refuses_repeated_members_for_every_registered_variant() {
    for (_, value) in statement_values() {
        duplicate_contract::<Statement>(&value, "STATEMENT_INVALID");
    }
}

#[test]
fn summary_cannot_hide_a_duplicate_inside_its_status() {
    let value = summary_case("summary-bounded-page");
    let replacement = repeated_member(&value["scheduling"], "syncPaused", &json!(false));
    let raw = serde_json::to_string(&value).unwrap();
    let text = raw.replace(&value["scheduling"].to_string(), &replacement);
    assert_ne!(text, raw);
    refuses_text::<ScheduledSummary>(&text, "SCHEDULED_SUMMARY_INVALID");
}

#[test]
fn summary_cannot_hide_a_duplicate_inside_an_item_schedule() {
    let value = summary_case("summary-bounded-page");
    let schedule = &value["items"][0]["schedule"];
    let replacement = repeated_member(schedule, "notBefore", &schedule["notBefore"]);
    let raw = serde_json::to_string(&value).unwrap();
    let text = raw.replacen(&schedule.to_string(), &replacement, 1);
    assert_ne!(text, raw);
    refuses_text::<ScheduledSummary>(&text, "SCHEDULED_SUMMARY_INVALID");
}

#[test]
fn item_cannot_hide_a_duplicate_inside_its_schedule() {
    let value = summary_case("item-base");
    let schedule = &value["schedule"];
    for name in schedule.as_object().unwrap().keys() {
        let replacement = repeated_member(schedule, name, &schedule[name]);
        let text = value
            .to_string()
            .replace(&schedule.to_string(), &replacement);
        refuses_text::<ScheduledItem>(&text, "SCHEDULED_ITEM_INVALID");
    }
}

#[test]
fn all_status_combinations_remain_available_through_every_serde_path() {
    for mode in ["sidecar", "service"] {
        for scheduler in ["running", "unavailable"] {
            for paused in [false, true] {
                accepts::<SchedulingStatus>(&json!({
                    "mode": mode,
                    "scheduler": scheduler,
                    "syncPaused": paused,
                }));
            }
        }
    }
}

#[test]
fn every_shared_valid_item_and_summary_still_round_trips() {
    let mut items = 0;
    let mut summaries = 0;
    for case in vector_cases("scheduled-summary/cases.json") {
        if case["valid"] != true {
            continue;
        }
        match case["schema"].as_str().unwrap() {
            "ScheduledItem" => {
                accepts::<ScheduledItem>(&case["value"]);
                items += 1;
            }
            "ScheduledSummary" => {
                accepts::<ScheduledSummary>(&case["value"]);
                summaries += 1;
            }
            unknown => panic!("unknown schema {unknown}"),
        }
    }
    assert!(items > 5);
    assert!(summaries > 5);
}

#[test]
fn every_registered_statement_still_reads_as_the_same_untagged_variant() {
    let values = statement_values();
    assert_eq!(values.len(), TYPES.len());
    for (typ, value) in values {
        assert!(draftyak_protocol::statements::parse_statement(&typ, &bytes(&value)).is_some());
        accepts::<Statement>(&value);
    }
}

#[test]
fn invalid_top_level_json_shapes_have_type_errors_without_echoing_input() {
    for text in [
        "null",
        "true",
        "7",
        "\"DYTEST-private-input\"",
        "[]",
        "{}",
        "[\"sidecar\",\"running\",false]",
    ] {
        refuses_text::<SchedulingStatus>(text, "SCHEDULING_STATUS_INVALID");
        refuses_text::<ScheduledItem>(text, "SCHEDULED_ITEM_INVALID");
        refuses_text::<ScheduledSummary>(text, "SCHEDULED_SUMMARY_INVALID");
        refuses_text::<Statement>(text, "STATEMENT_INVALID");
    }
}
