//! Minute-precision schedule display from the explicitly bundled time-zone database.
use jiff::{Timestamp, tz::TimeZoneDatabase};

pub const MAX_SCHEDULE_UTC_MS: u64 = 253_402_207_200_999;
pub const JIFF_VERSION: &str = "0.2.38";
pub const JIFF_TZDB_VERSION: &str = "0.1.9";

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ScheduleError {
    #[error("INVALID_INPUT")]
    InvalidInput,
}
impl ScheduleError {
    pub fn code(self) -> &'static str {
        "INVALID_INPUT"
    }
}
fn zone_valid(zone: &str) -> bool {
    if zone.is_empty() || zone.len() > 64 || !zone.is_ascii() {
        return false;
    }
    let mut parts = zone.split('/');
    let first = parts.next().unwrap_or_default();
    let component = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
    };
    first
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && component(first)
        && parts.all(component)
}

pub fn bundled_tzdata_version() -> Option<&'static str> {
    jiff_tzdb::VERSION
}

pub fn render_local_wall_time(not_before: u64, zone: &str) -> Result<String, ScheduleError> {
    let invalid = || ScheduleError::InvalidInput;
    if not_before > MAX_SCHEDULE_UTC_MS || !zone_valid(zone) || zone.eq_ignore_ascii_case("Factory")
    {
        return Err(invalid());
    }
    // Jiff's millisecond constructor excludes the fractional tail of its last second.
    // Its seconds/nanoseconds constructor represents that tail without rounding it away.
    let timestamp = Timestamp::new(
        (not_before / 1000) as i64,
        ((not_before % 1000) * 1_000_000) as i32,
    )
    .map_err(|_| invalid())?;
    // tzdb-bundle-always alone does not stop a global database from preferring system zoneinfo.
    let tz = TimeZoneDatabase::bundled()
        .get(zone)
        .map_err(|_| invalid())?;
    if tz.is_unknown() {
        return Err(invalid());
    }
    let value = timestamp.to_zoned(tz);
    let seconds = value.offset().seconds();
    if !(0..=9999).contains(&value.year()) || seconds % 60 != 0 {
        return Err(invalid());
    }
    let minutes = seconds.unsigned_abs() / 60;
    let sign = if seconds < 0 { '-' } else { '+' };
    Ok(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}{sign}{:02}:{:02}",
        value.year(),
        value.month(),
        value.day(),
        value.hour(),
        value.minute(),
        minutes / 60,
        minutes % 60
    ))
}

/// A mismatch is a warning fact. This helper grants no approval or scheduling authority.
pub fn check_local_wall_time(
    not_before: u64,
    zone: &str,
    local_wall_time: &str,
) -> Result<bool, ScheduleError> {
    Ok(render_local_wall_time(not_before, zone)? == local_wall_time)
}
