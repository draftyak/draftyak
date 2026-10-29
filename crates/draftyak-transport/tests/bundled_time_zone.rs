#[test]
fn kept_send_instant_resolves_from_the_bundled_database_without_the_host_zone_store() {
    let database = jiff::tz::TimeZoneDatabase::bundled();
    let zone = database.get("America/Chicago").unwrap();
    let instant = jiff::Timestamp::from_millisecond(1_792_000_000_000).unwrap();
    assert_eq!(
        instant.to_zoned(zone).to_string(),
        "2026-10-14T12:46:40-05:00[America/Chicago]"
    );
    assert!(database.get("Not/AZone").is_err());
}
