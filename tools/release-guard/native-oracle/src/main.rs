use draftyak_protocol::snapshot::Schedule;
use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::{AmbiguousOffset, TimeZoneDatabase};
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, Read};

// The build driver supplies an unchanged copy of the product's native module.
mod schedule;

fn offset(value: jiff::tz::Offset) -> String {
    let seconds = value.seconds();
    let sign = if seconds < 0 { '-' } else { '+' };
    let absolute = seconds.unsigned_abs();
    if absolute % 60 == 0 {
        format!("{sign}{:02}:{:02}", absolute / 3600, absolute % 3600 / 60)
    } else {
        format!(
            "{sign}{:02}:{:02}:{:02}",
            absolute / 3600,
            absolute % 3600 / 60,
            absolute % 60
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wall {
    zone: String,
    wall: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Instant {
    zone: String,
    epoch_ms: i64,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    #[serde(default)]
    zones: Vec<String>,
    #[serde(default)]
    from_ms: i64,
    #[serde(default)]
    to_ms: i64,
    #[serde(default)]
    walls: Vec<Wall>,
    #[serde(default)]
    instants: Vec<Instant>,
    #[serde(default)]
    schedules: Vec<Schedule>,
}

fn answer(request: Request) -> Result<Value, Box<dyn std::error::Error>> {
    if request.zones.len() > 8
        || request.walls.len() > 256
        || request.instants.len() > 256
        || request.schedules.len() > 512
        || (!request.zones.is_empty()
            && (request.to_ms <= request.from_ms
                || request.to_ms - request.from_ms > 3 * 366 * 86_400_000))
    {
        return Err("request exceeds schedule-oracle bounds".into());
    }
    let db = TimeZoneDatabase::bundled();
    let mut transitions = Vec::new();
    for zone in request.zones {
        let tz = db.get(&zone)?;
        for transition in tz.following(Timestamp::from_millisecond(request.from_ms)?) {
            let at = transition.timestamp();
            if at.as_millisecond() >= request.to_ms {
                break;
            }
            let before = Timestamp::from_nanosecond(at.as_nanosecond() - 1)?;
            transitions.push(json!({
                "zone": zone,
                "epochMs": at.as_millisecond(),
                "offsetBefore": offset(tz.to_offset(before)),
                "offsetAfter": offset(transition.offset()),
            }));
            if transitions.len() > 32 {
                return Err("too many time-zone transitions".into());
            }
        }
    }
    let mut walls = Vec::new();
    for input in request.walls {
        let local: DateTime = input.wall.parse()?;
        let ambiguous = db.get(&input.zone)?.to_ambiguous_timestamp(local);
        let kind = match ambiguous.offset() {
            AmbiguousOffset::Unambiguous { .. } => "unique",
            AmbiguousOffset::Gap { .. } => "gap",
            AmbiguousOffset::Fold { .. } => "fold",
        };
        walls.push(json!({
            "zone": input.zone,
            "wall": input.wall,
            "kind": kind,
            "compatible": ambiguous.compatible()?.as_millisecond(),
            "earlier": ambiguous.earlier()?.as_millisecond(),
            "later": ambiguous.later()?.as_millisecond(),
            "reject": ambiguous.unambiguous().ok().map(|at| at.as_millisecond()),
        }));
    }
    let mut instants = Vec::new();
    for input in request.instants {
        let zoned = Timestamp::from_millisecond(input.epoch_ms)?.to_zoned(db.get(&input.zone)?);
        instants.push(json!({
            "zone": input.zone,
            "epochMs": input.epoch_ms,
            "localWallTime": zoned.strftime("%Y-%m-%dT%H:%M%:z").to_string(),
            "offset": offset(zoned.offset()),
        }));
    }
    let schedules: Vec<_> = request
        .schedules
        .into_iter()
        .map(|input| {
            let accepted = schedule::validate(&input).is_ok();
            let view = schedule::view(&input, 0);
            json!({
                "accepted": accepted,
                "canApprove": view.can_approve,
                "warning": view.warning.is_some(),
                "text": view.text,
            })
        })
        .collect();
    Ok(json!({
        "schemaVersion": 1,
        "sourceSha256": env!("DRAFTYAK_SCHEDULE_SOURCE_SHA256"),
        "protocolSha256": env!("DRAFTYAK_SCHEDULE_PROTOCOL_SHA256"),
        "lockSha256": env!("DRAFTYAK_SCHEDULE_LOCK_SHA256"),
        "oracleSha256": env!("DRAFTYAK_SCHEDULE_ORACLE_SHA256"),
        "jiffVersion": "0.2.38",
        "jiffTzdbVersion": "0.1.9",
        "tzdbVersion": jiff_tzdb::VERSION,
        "database": "bundled",
        "transitions": transitions,
        "walls": walls,
        "instants": instants,
        "schedules": schedules,
    }))
}

fn main() {
    let result = (|| {
        let mut input = String::new();
        io::stdin().take(1_048_577).read_to_string(&mut input)?;
        if input.len() > 1_048_576 {
            return Err("request too large".into());
        }
        answer(serde_json::from_str(&input)?)
    })();
    match result {
        Ok(output) => println!("{output}"),
        Err(_) => {
            eprintln!("schedule oracle refused its bounded input");
            std::process::exit(1);
        }
    }
}
