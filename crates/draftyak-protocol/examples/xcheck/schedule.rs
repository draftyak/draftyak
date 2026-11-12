use draftyak_protocol::schedule::{
    JIFF_TZDB_VERSION, JIFF_VERSION, MAX_SCHEDULE_UTC_MS, bundled_tzdata_version,
    check_local_wall_time, render_local_wall_time,
};
use jiff::{
    Timestamp,
    civil::DateTime,
    tz::{AmbiguousOffset, TimeZoneDatabase},
};
use serde_json::{Map, Value, json};

pub const COMMANDS: &[(&str, super::Command)] = &[
    ("schedule", query_schedule),
    ("scheduleResolve", query_resolution),
    ("scheduleTransitions", query_transitions),
];

const MAX_TRANSITION_WINDOW_MS: u64 = 3 * 366 * 86_400_000;
const MAX_TRANSITIONS: usize = 32;

fn invalid_input() -> Value {
    json!({"error": "INVALID_INPUT"})
}

fn versioned(mut answer: Value) -> Value {
    answer["tzdataVersion"] = json!(bundled_tzdata_version());
    answer["jiffVersion"] = json!(JIFF_VERSION);
    answer["jiffTzdbVersion"] = json!(JIFF_TZDB_VERSION);
    answer
}

fn integer_field(request: &Map<String, Value>, name: &str) -> Result<u64, String> {
    request
        .get(name)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{name} is a nonnegative integer"))
}

fn checked_instant(timestamp: Timestamp, zone: &str) -> Option<u64> {
    let instant = u64::try_from(timestamp.as_millisecond()).ok()?;
    render_local_wall_time(instant, zone).ok()?;
    Some(instant)
}

fn query_resolution(request: &Map<String, Value>) -> Result<Value, String> {
    let wall = super::field(request, "wall")?;
    let zone = super::field(request, "zone")?;
    let bytes = wall.as_bytes();
    if bytes.len() != 16
        || !bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 => *byte == b':',
            _ => byte.is_ascii_digit(),
        })
    {
        return Ok(invalid_input());
    }
    let Ok(civil) = wall.parse::<DateTime>() else {
        return Ok(invalid_input());
    };
    let Ok(tz) = TimeZoneDatabase::bundled().get(zone) else {
        return Ok(invalid_input());
    };
    let choice = tz.to_ambiguous_timestamp(civil);
    let kind = match choice.offset() {
        AmbiguousOffset::Unambiguous { .. } => "unique",
        AmbiguousOffset::Gap { .. } => "gap",
        AmbiguousOffset::Fold { .. } => "fold",
    };
    let selected = (choice.compatible(), choice.earlier(), choice.later());
    let (Ok(compatible), Ok(earlier), Ok(later)) = selected else {
        return Ok(invalid_input());
    };
    let selected = (
        checked_instant(compatible, zone),
        checked_instant(earlier, zone),
        checked_instant(later, zone),
    );
    let (Some(compatible), Some(earlier), Some(later)) = selected else {
        return Ok(invalid_input());
    };
    let reject = choice
        .unambiguous()
        .ok()
        .and_then(|instant| checked_instant(instant, zone));
    Ok(versioned(json!({
        "kind": kind,
        "compatible": compatible,
        "earlier": earlier,
        "later": later,
        "reject": reject,
    })))
}

fn query_transitions(request: &Map<String, Value>) -> Result<Value, String> {
    transitions_with_limit(request, MAX_TRANSITIONS)
}

fn transitions_with_limit(request: &Map<String, Value>, limit: usize) -> Result<Value, String> {
    let zone = super::field(request, "zone")?;
    let from = integer_field(request, "from")?;
    let to = integer_field(request, "to")?;
    if from >= to
        || to > MAX_SCHEDULE_UTC_MS
        || to - from > MAX_TRANSITION_WINDOW_MS
        || render_local_wall_time(from, zone).is_err()
        || render_local_wall_time(to, zone).is_err()
    {
        return Ok(invalid_input());
    }
    let Ok(tz) = TimeZoneDatabase::bundled().get(zone) else {
        return Ok(invalid_input());
    };
    let Ok(start) = Timestamp::new((from / 1000) as i64, ((from % 1000) * 1_000_000) as i32) else {
        return Ok(invalid_input());
    };
    let mut transitions = Vec::new();
    // Jiff's iterator supplies transitions strictly after start; the end is also excluded.
    for transition in tz.following(start) {
        let at = transition.timestamp();
        if at.as_millisecond() >= to as i64 {
            break;
        }
        if transitions.len() == limit {
            return Ok(invalid_input());
        }
        let Some(epoch_ms) = checked_instant(at, zone) else {
            return Ok(invalid_input());
        };
        let Ok(before) = Timestamp::from_nanosecond(at.as_nanosecond() - 1) else {
            return Ok(invalid_input());
        };
        transitions.push(json!({
            "epochMs": epoch_ms,
            "offsetBeforeSeconds": tz.to_offset(before).seconds(),
            "offsetAfterSeconds": transition.offset().seconds(),
        }));
    }
    Ok(versioned(json!({"transitions": transitions})))
}

fn query_schedule(request: &Map<String, Value>) -> Result<Value, String> {
    let not_before = request
        .get("notBefore")
        .and_then(Value::as_u64)
        .ok_or("notBefore is a nonnegative integer")?;
    let zone = super::field(request, "zone")?;
    let claimed = request
        .get("localWallTime")
        .map(|value| value.as_str().ok_or("localWallTime is a string"))
        .transpose()?;
    let rendered = match render_local_wall_time(not_before, zone) {
        Ok(value) => value,
        Err(error) => return Ok(json!({"error": error.code()})),
    };
    let mut answer = json!({
        "localWallTime": rendered,
        "tzdataVersion": bundled_tzdata_version(),
        "jiffVersion": JIFF_VERSION,
        "jiffTzdbVersion": JIFF_TZDB_VERSION,
    });
    if let Some(wall) = claimed {
        let matches = match check_local_wall_time(not_before, zone, wall) {
            Ok(value) => value,
            Err(error) => return Ok(json!({"error": error.code()})),
        };
        answer["matches"] = json!(matches);
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use draftyak_protocol::schedule::MAX_SCHEDULE_UTC_MS;

    fn query(request: Value) -> Result<Value, String> {
        query_schedule(request.as_object().unwrap())
    }

    fn resolve(request: Value) -> Result<Value, String> {
        query_resolution(request.as_object().unwrap())
    }

    fn transitions(request: Value) -> Result<Value, String> {
        query_transitions(request.as_object().unwrap())
    }

    fn assert_versions(answer: &Value) {
        assert_eq!(answer["tzdataVersion"], json!(bundled_tzdata_version()));
        assert_eq!(answer["jiffVersion"], JIFF_VERSION);
        assert_eq!(answer["jiffTzdbVersion"], JIFF_TZDB_VERSION);
    }

    #[test]
    fn inverse_facts_cover_the_existing_resolution_vectors_without_approval_authority() {
        let document: Value =
            serde_json::from_str(include_str!("../../../../spec/vectors/schedule/dst.json"))
                .unwrap();
        let cases = document["resolutionCases"].as_array().unwrap();
        assert_eq!(cases.len(), 49);
        for case in cases {
            let answer = resolve(json!({"wall": case["wall"], "zone": case["zone"]})).unwrap();
            match case["error"].as_str() {
                Some("INVALID_INPUT") => assert_eq!(answer, invalid_input(), "{}", case["id"]),
                Some(error @ ("NONEXISTENT_LOCAL_TIME" | "AMBIGUOUS_LOCAL_TIME")) => {
                    assert_versions(&answer);
                    let gap = error == "NONEXISTENT_LOCAL_TIME";
                    assert_eq!(answer["kind"], if gap { "gap" } else { "fold" });
                    assert_eq!(answer["reject"], Value::Null);
                    let earlier = answer["earlier"].as_u64().unwrap();
                    let later = answer["later"].as_u64().unwrap();
                    assert!(earlier < later, "{}", case["id"]);
                    assert_eq!(answer["compatible"], if gap { later } else { earlier });
                    assert!(answer.get("canApprove").is_none());
                }
                None => {
                    assert_versions(&answer);
                    assert_eq!(answer["kind"], "unique");
                    for field in ["compatible", "earlier", "later", "reject"] {
                        assert_eq!(answer[field], case["notBefore"], "{}", case["id"]);
                    }
                }
                Some(_) => panic!("unexpected resolution vector error"),
            }
        }
    }

    #[test]
    fn inverse_refuses_malformed_fields_dates_zones_and_unrepresentable_choices() {
        for request in [json!({"zone": "UTC"}), json!({"wall": null, "zone": "UTC"})] {
            assert_eq!(resolve(request).unwrap_err(), "wall is a string");
        }
        assert_eq!(
            resolve(json!({"wall": "2026-01-01T00:00"})).unwrap_err(),
            "zone is a string"
        );
        for (wall, zone) in [
            ("2026-01-01T00:00:00", "UTC"),
            ("2026-01-01t00:00", "UTC"),
            ("2026-02-30T00:00", "UTC"),
            ("2026-01-01T24:00", "UTC"),
            ("1969-12-31T23:59", "UTC"),
            ("9999-12-31T23:59", "UTC"),
            ("2026-01-01T00:00", "Factory"),
            ("2026-01-01T00:00", "/UTC"),
            ("2026-01-01T00:00", "Invalid/CANARY_PRIVATE_ZONE"),
            ("1970-01-01T00:00", "Africa/Monrovia"),
        ] {
            assert_eq!(
                resolve(json!({"wall": wall, "zone": zone})).unwrap(),
                invalid_input()
            );
        }
        assert_eq!(
            resolve(json!({"wall": "1970-01-01T00:00", "zone": "UTC"})).unwrap()["reject"],
            0
        );
    }

    #[test]
    fn transitions_are_native_facts_with_strict_interval_edges_and_versions() {
        let from = 1_772_953_199_999_u64;
        let at = from + 1;
        let expected =
            json!({"epochMs": at, "offsetBeforeSeconds": -18000, "offsetAfterSeconds": -14400});
        let answer =
            transitions(json!({"zone": "America/New_York", "from": from, "to": at + 1})).unwrap();
        assert_versions(&answer);
        assert_eq!(answer["transitions"], json!([expected]));
        for (from, to) in [(at - 1, at), (at, at + 1)] {
            assert_eq!(
                transitions(json!({"zone": "America/New_York", "from": from, "to": to})).unwrap()["transitions"],
                json!([])
            );
        }
        assert_eq!(
            transitions(json!({"zone": "UTC", "from": 0, "to": MAX_TRANSITION_WINDOW_MS})).unwrap()
                ["transitions"],
            json!([])
        );
    }

    #[test]
    fn transitions_bound_the_window_and_output_independently() {
        for (from, to) in [
            (0, 0),
            (1, 0),
            (0, MAX_TRANSITION_WINDOW_MS + 1),
            (MAX_SCHEDULE_UTC_MS, MAX_SCHEDULE_UTC_MS + 1),
            (0, u64::MAX),
        ] {
            assert_eq!(
                transitions(json!({"zone": "UTC", "from": from, "to": to})).unwrap(),
                invalid_input()
            );
        }
        let request = json!({"zone": "America/New_York", "from": 1_767_225_600_000_u64, "to": 1_798_761_600_000_u64});
        assert_eq!(
            transitions_with_limit(request.as_object().unwrap(), 1).unwrap(),
            invalid_input()
        );
        assert_eq!(
            transitions_with_limit(request.as_object().unwrap(), 2).unwrap()["transitions"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for zone in ["Factory", "UTC\n", "Invalid/CANARY_PRIVATE_ZONE"] {
            assert_eq!(
                transitions(json!({"zone": zone, "from": 0, "to": 1})).unwrap(),
                invalid_input()
            );
        }
    }

    #[test]
    fn transition_structural_faults_are_fixed() {
        assert_eq!(
            transitions(json!({"from": 0, "to": 1})).unwrap_err(),
            "zone is a string"
        );
        for value in [Value::Null, json!(-1), json!(0.5), json!("0")] {
            assert_eq!(
                transitions(json!({"zone": "UTC", "from": value, "to": 1})).unwrap_err(),
                "from is a nonnegative integer"
            );
            assert_eq!(
                transitions(json!({"zone": "UTC", "from": 0, "to": value})).unwrap_err(),
                "to is a nonnegative integer"
            );
        }
    }

    #[test]
    fn renders_without_a_claim_and_checks_both_claim_outcomes() {
        let rendered = query(json!({"notBefore": 0, "zone": "UTC"})).unwrap();
        assert_eq!(rendered["localWallTime"], "1970-01-01T00:00+00:00");
        assert!(rendered.get("matches").is_none());
        assert_eq!(rendered["jiffVersion"], JIFF_VERSION);
        assert_eq!(rendered["jiffTzdbVersion"], JIFF_TZDB_VERSION);
        assert_eq!(rendered["tzdataVersion"], json!(bundled_tzdata_version()));
        for (wall, expected) in [
            ("1970-01-01T00:00+00:00", true),
            ("wrong", false),
            ("", false),
        ] {
            let answer =
                query(json!({"notBefore": 0, "zone": "UTC", "localWallTime": wall})).unwrap();
            assert_eq!(answer["matches"], expected);
            assert_eq!(answer["localWallTime"], rendered["localWallTime"]);
        }
    }

    #[test]
    fn domain_refusals_are_fixed_and_do_not_echo_input() {
        for request in [
            json!({"notBefore": MAX_SCHEDULE_UTC_MS + 1, "zone": "UTC"}),
            json!({"notBefore": 0, "zone": "Invalid/CANARY_PRIVATE_ZONE"}),
            json!({"notBefore": 0, "zone": "Factory", "localWallTime": "wrong"}),
        ] {
            assert_eq!(query(request).unwrap(), json!({"error": "INVALID_INPUT"}));
        }
        assert!(
            query(json!({"notBefore": MAX_SCHEDULE_UTC_MS, "zone": "UTC"}))
                .unwrap()
                .get("localWallTime")
                .is_some()
        );
    }

    #[test]
    fn malformed_fields_use_the_existing_fault_contract() {
        for request in [
            json!({"zone": "UTC"}),
            json!({"notBefore": -1, "zone": "UTC"}),
            json!({"notBefore": 0.5, "zone": "UTC"}),
            json!({"notBefore": "0", "zone": "UTC"}),
        ] {
            assert_eq!(
                query(request).unwrap_err(),
                "notBefore is a nonnegative integer"
            );
        }
        assert_eq!(
            query(json!({"notBefore": 0})).unwrap_err(),
            "zone is a string"
        );
        assert_eq!(
            query(json!({"notBefore": 0, "zone": null})).unwrap_err(),
            "zone is a string"
        );
        for wall in [Value::Null, json!(true), json!(0), json!([])] {
            assert_eq!(
                query(json!({"notBefore": 0, "zone": "UTC", "localWallTime": wall})).unwrap_err(),
                "localWallTime is a string"
            );
        }
    }
}
