//! Answers the scheduling ADR's DST questions from jiff's bundled IANA database (jiff-tzdb), never
//! the system's, with one JSON line per request line on stdin:
//! `info`, `transitions <zone> <fromMs> <toMs>`, `resolve <zone> <wall>`, `render <zone> <epochMs>`.

use std::error::Error;
use std::io::{self, BufRead, Write};

use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::fmt::strtime;
use jiff::tz::{AmbiguousOffset, Offset, TimeZone, TimeZoneDatabase};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn main() -> Result<()> {
    let db = TimeZoneDatabase::bundled();
    let mut out = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let line = line?;
        let reply = answer(&db, &line)
            .unwrap_or_else(|error| object(&[("error", string(&error.to_string()))]));
        writeln!(out, "{reply}")?;
    }
    Ok(())
}

fn answer(db: &TimeZoneDatabase, line: &str) -> Result<String> {
    let words: Vec<&str> = line.split_whitespace().collect();
    match words.as_slice() {
        ["info"] => Ok(info()),
        ["transitions", zone, from, to] => transitions(&db.get(zone)?, from.parse()?, to.parse()?),
        ["resolve", zone, wall] => resolve(&db.get(zone)?, wall.parse()?),
        ["render", zone, epoch_ms] => render(&db.get(zone)?, epoch_ms.parse()?),
        _ => Err(format!("unknown request: {line}").into()),
    }
}

// The bundled data's version, and which database jiff's global `tz::db()` picked on this host:
// with default features it reads the system's zoneinfo first on Unix.
fn info() -> String {
    let default = format!("{:?}", jiff::tz::db());
    let kind = ["Bundled", "ZoneInfo", "Concatenated"]
        .into_iter()
        .find(|name| default.contains(name))
        .unwrap_or("unavailable");
    object(&[
        (
            "tzdbVersion",
            jiff_tzdb::VERSION.map_or_else(|| "null".into(), string),
        ),
        ("defaultDatabase", string(&kind.to_lowercase())),
    ])
}

fn transitions(tz: &TimeZone, from_ms: i64, to_ms: i64) -> Result<String> {
    let mut found = Vec::new();
    for transition in tz.following(Timestamp::from_millisecond(from_ms)?) {
        let at = transition.timestamp();
        if at.as_millisecond() >= to_ms {
            break;
        }
        let before = tz.to_offset(Timestamp::from_nanosecond(at.as_nanosecond() - 1)?);
        found.push(object(&[
            ("epochMs", at.as_millisecond().to_string()),
            ("offsetBefore", string(&offset(before))),
            ("offsetAfter", string(&offset(transition.offset()))),
        ]));
    }
    Ok(object(&[("transitions", format!("[{}]", found.join(",")))]))
}

// Temporal's four disambiguations; `reject` is null where Temporal throws.
fn resolve(tz: &TimeZone, wall: DateTime) -> Result<String> {
    let ambiguous = tz.to_ambiguous_timestamp(wall);
    let kind = match ambiguous.offset() {
        AmbiguousOffset::Unambiguous { .. } => "unique",
        AmbiguousOffset::Gap { .. } => "gap",
        AmbiguousOffset::Fold { .. } => "fold",
    };
    let reject = ambiguous
        .unambiguous()
        .map_or_else(|_| "null".into(), |at| at.as_millisecond().to_string());
    Ok(object(&[
        ("kind", string(kind)),
        (
            "compatible",
            ambiguous.compatible()?.as_millisecond().to_string(),
        ),
        ("earlier", ambiguous.earlier()?.as_millisecond().to_string()),
        ("later", ambiguous.later()?.as_millisecond().to_string()),
        ("reject", reject),
    ]))
}

// The snapshot's `localWallTime` (YYYY-MM-DDTHH:mm±HH:MM, plan section 9.3) for an instant.
fn render(tz: &TimeZone, epoch_ms: i64) -> Result<String> {
    let zoned = Timestamp::from_millisecond(epoch_ms)?.to_zoned(tz.clone());
    Ok(object(&[
        (
            "localWallTime",
            string(&strtime::format("%Y-%m-%dT%H:%M%:z", &zoned)?),
        ),
        ("offset", string(&offset(zoned.offset()))),
    ]))
}

// Temporal's offset form: ±HH:MM, with :SS only when non-zero.
fn offset(offset: Offset) -> String {
    let total = offset.seconds();
    let sign = if total < 0 { '-' } else { '+' };
    let (hours, rest) = (total.unsigned_abs() / 3600, total.unsigned_abs() % 3600);
    let (minutes, seconds) = (rest / 60, rest % 60);
    if seconds == 0 {
        format!("{sign}{hours:02}:{minutes:02}")
    } else {
        format!("{sign}{hours:02}:{minutes:02}:{seconds:02}")
    }
}

fn string(text: &str) -> String {
    let mut quoted = String::from('"');
    for c in text.chars() {
        match c {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            c if u32::from(c) < 0x20 => quoted.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

fn object(fields: &[(&str, String)]) -> String {
    let body: Vec<String> = fields
        .iter()
        .map(|(key, value)| format!("{}:{value}", string(key)))
        .collect();
    format!("{{{}}}", body.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> TimeZone {
        TimeZoneDatabase::bundled().get(name).expect("bundled zone")
    }

    fn shift(tz: &TimeZone, wall: &str) -> (&'static str, i32) {
        match tz
            .to_ambiguous_timestamp(wall.parse().expect("wall time"))
            .offset()
        {
            AmbiguousOffset::Unambiguous { .. } => ("unique", 0),
            AmbiguousOffset::Gap { before, after } => ("gap", after.seconds() - before.seconds()),
            AmbiguousOffset::Fold { before, after } => ("fold", after.seconds() - before.seconds()),
        }
    }

    #[test]
    fn bundles_a_versioned_database() {
        let version = jiff_tzdb::VERSION.expect("a tzdata version");
        assert!(version.len() == 5 && version[..4].bytes().all(|b| b.is_ascii_digit()));
    }

    #[test]
    fn finds_the_gaps_and_folds_of_all_three_zones() {
        let new_york = zone("America/New_York");
        assert_eq!(shift(&new_york, "2026-03-08T02:30"), ("gap", 3600));
        assert_eq!(shift(&new_york, "2026-11-01T01:30"), ("fold", -3600));
        assert_eq!(shift(&new_york, "2026-07-01T12:00"), ("unique", 0));
        let london = zone("Europe/London");
        assert_eq!(shift(&london, "2026-03-29T01:30"), ("gap", 3600));
        assert_eq!(shift(&london, "2026-10-25T01:30"), ("fold", -3600));
        let lord_howe = zone("Australia/Lord_Howe");
        assert_eq!(shift(&lord_howe, "2026-10-04T02:15"), ("gap", 1800));
        assert_eq!(shift(&lord_howe, "2026-04-05T01:45"), ("fold", -1800));
        assert_eq!(shift(&lord_howe, "2026-10-04T02:30"), ("unique", 0));
    }

    #[test]
    fn rejects_both_kinds_and_resolves_the_others_as_temporal_does() {
        let db = TimeZoneDatabase::bundled();
        // 02:30 in the New York gap: earlier is 01:30 EST, later and compatible 03:30 EDT.
        assert_eq!(
            answer(&db, "resolve America/New_York 2026-03-08T02:30").expect("answer"),
            r#"{"kind":"gap","compatible":1772955000000,"earlier":1772951400000,"later":1772955000000,"reject":null}"#
        );
        assert_eq!(
            answer(&db, "render Australia/Lord_Howe 1791041400000").expect("answer"),
            r#"{"localWallTime":"2026-10-04T02:30+11:00","offset":"+11:00"}"#
        );
        assert!(answer(&db, "resolve Not/A_Zone 2026-03-08T02:30").is_err());
        assert!(answer(&db, "render").is_err());
    }
}
