use draftyak_protocol::{
    jcs::canonicalize,
    schedule::{
        JIFF_TZDB_VERSION, JIFF_VERSION, MAX_SCHEDULE_UTC_MS, ScheduleError,
        bundled_tzdata_version, check_local_wall_time, render_local_wall_time,
    },
    snapshot::{content_hash, fingerprint, parse_snapshot, send_window},
};
use serde_json::Value;

#[test]
fn every_millisecond_in_the_last_supported_second_remains_representable() {
    for remainder in 0..1000 {
        let instant = MAX_SCHEDULE_UTC_MS - 999 + remainder;
        assert_eq!(
            render_local_wall_time(instant, "UTC").unwrap(),
            "9999-12-30T22:00+00:00"
        );
        assert_eq!(
            render_local_wall_time(instant, "Pacific/Kiritimati").unwrap(),
            "9999-12-31T12:00+14:00"
        );
    }
}

// Test-only consumer of the strict minute input contract; the native public API remains render/check.
fn resolve_with_bundled_jiff(wall: &str, zone: &str) -> Result<(u64, String), &'static str> {
    use jiff::{
        civil::DateTime,
        tz::{AmbiguousOffset, TimeZoneDatabase},
    };
    let bytes = wall.as_bytes();
    if bytes.len() != 16
        || !bytes.iter().enumerate().all(|(at, byte)| match at {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 => *byte == b':',
            _ => byte.is_ascii_digit(),
        })
    {
        return Err("INVALID_INPUT");
    }
    let civil: DateTime = wall.parse().map_err(|_| "INVALID_INPUT")?;
    let tz = TimeZoneDatabase::bundled()
        .get(zone)
        .map_err(|_| "INVALID_INPUT")?;
    let choice = tz.to_ambiguous_timestamp(civil);
    let rejected = match choice.offset() {
        AmbiguousOffset::Gap { before, after } => Some(("NONEXISTENT_LOCAL_TIME", before, after)),
        AmbiguousOffset::Fold { before, after } => Some(("AMBIGUOUS_LOCAL_TIME", before, after)),
        AmbiguousOffset::Unambiguous { .. } => None,
    };
    if let Some((reason, before, after)) = rejected {
        assert!(choice.unambiguous().is_err());
        let earlier = choice.earlier().unwrap();
        let later = choice.later().unwrap();
        assert!(earlier < later);
        assert_eq!(
            later.as_millisecond() - earlier.as_millisecond(),
            i64::from((before.seconds() - after.seconds()).unsigned_abs()) * 1000
        );
        let first_wall = earlier.to_zoned(tz.clone()).datetime();
        let last_wall = later.to_zoned(tz).datetime();
        if reason == "AMBIGUOUS_LOCAL_TIME" {
            assert_eq!(first_wall, civil);
            assert_eq!(last_wall, civil);
        } else {
            assert_ne!(first_wall, civil);
            assert_ne!(last_wall, civil);
        }
        return Err(reason);
    }
    let timestamp = choice.unambiguous().map_err(|_| "INVALID_INPUT")?;
    let instant = u64::try_from(timestamp.as_millisecond()).map_err(|_| "INVALID_INPUT")?;
    let display = render_local_wall_time(instant, zone).map_err(|error| error.code())?;
    Ok((instant, display))
}

#[test]
fn every_shared_wall_resolution_is_checked_by_the_bundled_native_database() {
    let document: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/schedule/dst.json")).unwrap();
    let cases = document["resolutionCases"].as_array().unwrap();
    assert_eq!(cases.len(), 49);
    for case in cases {
        let actual = resolve_with_bundled_jiff(
            case["wall"].as_str().unwrap(),
            case["zone"].as_str().unwrap(),
        );
        if let Some(expected) = case["error"].as_str() {
            assert_eq!(actual.unwrap_err(), expected, "{}", case["id"]);
        } else {
            assert_eq!(
                actual.unwrap(),
                (
                    case["notBefore"].as_u64().unwrap(),
                    case["localWallTime"].as_str().unwrap().to_owned()
                ),
                "{}",
                case["id"]
            );
        }
    }
}

#[test]
fn shared_schedule_rendering_and_snapshot_vectors() {
    let document: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/schedule/dst.json")).unwrap();
    assert_eq!(document["metadata"]["rust"]["jiff"], JIFF_VERSION);
    assert_eq!(document["metadata"]["rust"]["jiffTzdb"], JIFF_TZDB_VERSION);
    if document["metadata"]["rust"]["expectedTzdata"].as_str() != bundled_tzdata_version() {
        eprintln!("Schedule vector tzdata versions differ; rendering answers must still agree");
    }
    for case in document["renderingCases"].as_array().unwrap() {
        let instant = case["notBefore"].as_u64().unwrap();
        let zone = case["zone"].as_str().unwrap();
        let rendered = render_local_wall_time(instant, zone);
        if let Some(error) = case["error"].as_str() {
            assert_eq!(rendered.unwrap_err().code(), error, "{}", case["id"]);
            continue;
        }
        let expected = case["localWallTime"].as_str().unwrap();
        assert_eq!(rendered.unwrap(), expected, "{}", case["id"]);
        assert!(check_local_wall_time(instant, zone, expected).unwrap());
        assert!(
            !check_local_wall_time(instant, zone, case["mismatchedWallTime"].as_str().unwrap())
                .unwrap()
        );
    }
    for case in document["snapshots"].as_array().unwrap() {
        let value = &case["snapshot"];
        let snapshot = parse_snapshot(serde_json::to_string(value).unwrap().as_bytes()).unwrap();
        assert_eq!(content_hash(&snapshot).unwrap(), case["contentHash"]);
        assert_eq!(fingerprint(&snapshot).unwrap(), case["fingerprint"]);
        let schedule = &value["schedule"];
        let instant = schedule["notBefore"].as_u64().unwrap();
        assert_eq!(instant - case["iat"].as_u64().unwrap(), 30 * 86_400_000);
        assert!(
            check_local_wall_time(
                instant,
                schedule["zone"].as_str().unwrap(),
                schedule["localWallTime"].as_str().unwrap()
            )
            .unwrap()
        );
        assert_eq!(
            serde_json::to_value(send_window(&snapshot, case["iat"].as_u64().unwrap()).unwrap())
                .unwrap(),
            case["window"]
        );
        let hex: String = canonicalize(&snapshot)
            .unwrap()
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(hex, case["canonicalHex"].as_str().unwrap());
    }
}

#[test]
fn native_range_and_fixed_refusals() {
    assert_eq!(
        jiff::Timestamp::MAX.as_millisecond(),
        MAX_SCHEDULE_UTC_MS as i64
    );
    assert!(render_local_wall_time(MAX_SCHEDULE_UTC_MS, "UTC").is_ok());
    assert_eq!(
        render_local_wall_time(MAX_SCHEDULE_UTC_MS + 1, "UTC"),
        Err(ScheduleError::InvalidInput)
    );
    for zone in [
        "",
        "/UTC",
        "UTC/",
        "UTC\n",
        "+01:00",
        "Etc/Unknown",
        "etc/unknown",
        "Factory",
        "factory",
        "Invalid/CANARY_PRIVATE_ZONE",
    ] {
        let error = render_local_wall_time(0, zone).unwrap_err();
        assert_eq!(error.code(), "INVALID_INPUT");
        assert_eq!(error.to_string(), "INVALID_INPUT");
        // Validate the instant/zone even when the claimed display string is already wrong.
        assert_eq!(
            check_local_wall_time(0, zone, "wrong"),
            Err(ScheduleError::InvalidInput)
        );
    }
    assert!(!check_local_wall_time(0, "UTC", "CANARY_WRONG_DISPLAY").unwrap());
    assert_eq!(
        render_local_wall_time(59_999, "UTC").unwrap(),
        "1970-01-01T00:00+00:00"
    );
    assert_eq!(
        render_local_wall_time(0, "Africa/Monrovia"),
        Err(ScheduleError::InvalidInput)
    );
}
