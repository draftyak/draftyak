use draftyak_protocol::{
    jcs::canonicalize,
    snapshot::{
        check_current_send_snapshot, content_hash, fingerprint, parse_snapshot, send_window,
    },
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
fn legacy_sharing_is_preserved_but_current_send_requires_the_fact() {
    let document: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/snapshot/snapshots.json"
    ))
    .unwrap();
    let case = document["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["id"] == "chat-thread")
        .unwrap();
    let legacy =
        parse_snapshot(serde_json::to_string(&case["snapshot"]).unwrap().as_bytes()).unwrap();
    assert!(!check_current_send_snapshot(&legacy));
    assert!(
        serde_json::to_value(&legacy).unwrap()["chat"]
            .get("shared")
            .is_none()
    );
    assert_eq!(
        content_hash(&legacy).unwrap(),
        "7d57a2eb96a3a3b2b6aed834dcd1e5888ef677a29673abf147885294e1690b0e"
    );
    assert_eq!(fingerprint(&legacy).unwrap(), "7D57A2EB");
    let canonical = canonicalize(&legacy).unwrap();
    let hex: String = canonical
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    assert_eq!(json!(hex), case["canonicalHex"]);
    assert_eq!(
        serde_json::to_value(send_window(&legacy, case["iat"].as_u64().unwrap()).unwrap()).unwrap(),
        case["window"]
    );

    let mut hashes = vec![content_hash(&legacy).unwrap()];
    let mut fingerprints = vec![fingerprint(&legacy).unwrap()];
    for shared in [false, true] {
        let mut value = case["snapshot"].clone();
        value["chat"]["shared"] = json!(shared);
        let current = parse_snapshot(serde_json::to_string(&value).unwrap().as_bytes()).unwrap();
        assert!(check_current_send_snapshot(&current));
        assert_eq!(
            serde_json::to_value(&current).unwrap()["chat"]["shared"],
            json!(shared)
        );
        hashes.push(content_hash(&current).unwrap());
        fingerprints.push(fingerprint(&current).unwrap());
    }
    hashes.sort();
    hashes.dedup();
    fingerprints.sort();
    fingerprints.dedup();
    assert_eq!(hashes.len(), 3);
    assert_eq!(fingerprints.len(), 3);
    for shared in [Value::Null, json!("false"), json!(0), json!([]), json!({})] {
        let mut value = case["snapshot"].clone();
        value["chat"]["shared"] = shared;
        assert!(parse_snapshot(serde_json::to_string(&value).unwrap().as_bytes()).is_err());
    }
    let email = parse_snapshot(
        serde_json::to_string(&document["cases"][0]["snapshot"])
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    assert!(check_current_send_snapshot(&email));
    assert_eq!(
        content_hash(&email).unwrap(),
        document["cases"][0]["contentHash"]
    );
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
