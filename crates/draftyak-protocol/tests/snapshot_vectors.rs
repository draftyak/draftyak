use draftyak_protocol::{
    jcs::canonicalize,
    snapshot::{content_hash, fingerprint, parse_snapshot, send_window},
};
use serde_json::{Value, json};
#[test]
fn shared_snapshot_vectors() {
    let document: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/snapshot/snapshots.json"
    ))
    .unwrap();
    assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
    for case in document["cases"].as_array().unwrap() {
        let parsed = parse_snapshot(serde_json::to_string(&case["snapshot"]).unwrap().as_bytes());
        if case.get("error").is_some() {
            assert!(parsed.is_err(), "{}", case["id"]);
            continue;
        }
        let snapshot = parsed.unwrap_or_else(|error| panic!("{}: {error}", case["id"]));
        assert_eq!(content_hash(&snapshot).unwrap(), case["contentHash"]);
        assert_eq!(fingerprint(&snapshot).unwrap(), case["fingerprint"]);
        assert_eq!(
            serde_json::to_value(send_window(&snapshot, case["iat"].as_u64().unwrap()).unwrap())
                .unwrap(),
            case["window"]
        );
        let canonical = canonicalize(&snapshot).unwrap();
        let hex: String = canonical
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        assert_eq!(json!(hex), case["canonicalHex"]);
    }
}

#[test]
fn body_and_window_boundaries() {
    use draftyak_protocol::snapshot::{SnapshotError, check_body_text};
    assert!(check_body_text("x\u{200b}y\n"));
    assert!(!check_body_text("cafe\u{301}"));
    assert!(!check_body_text("a\r\nb"));
    let document: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/snapshot/snapshots.json"
    ))
    .unwrap();
    let snapshot = parse_snapshot(
        serde_json::to_string(&document["cases"][0]["snapshot"])
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    assert_eq!(
        send_window(&snapshot, 9_007_199_254_740_991),
        Err(SnapshotError::WindowOverflow)
    );
    assert_eq!(
        send_window(&snapshot, 9_007_199_254_740_992),
        Err(SnapshotError::Invalid)
    );
}
