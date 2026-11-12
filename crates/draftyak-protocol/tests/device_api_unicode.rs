use draftyak_protocol::device_api as api;
use serde_json::json;

#[test]
fn supplementary_pairing_code_uses_code_points_and_preserves_received_cap() {
    for count in [491, 492] {
        let code = format!("draftyak-pair:v1:{}", "😀".repeat(count));
        let value = json!({ "pairingCode": code });
        let bytes = serde_json::to_vec(&value).unwrap();
        assert!(api::check_schema("PairingWindow", &value));
        assert!(api::check_route_response("pairing-window", &value));
        assert!(api::check_route_response_bytes("pairing-window", &bytes));
        if count == 492 {
            assert_eq!(value["pairingCode"].as_str().unwrap().chars().count(), 509);
            assert_eq!(
                value["pairingCode"]
                    .as_str()
                    .unwrap()
                    .encode_utf16()
                    .count(),
                1001
            );
            assert_eq!(bytes.len(), 2003);
            let mut exact = bytes;
            exact.resize(2048, b' ');
            assert!(api::check_route_response_bytes("pairing-window", &exact));
            exact.push(b' ');
            assert!(!api::check_route_response_bytes("pairing-window", &exact));
        }
    }
}

#[test]
fn schema_point_limit_and_route_byte_limit_are_independent() {
    let exact = json!({ "pairingCode": format!("draftyak-pair:v1:{}", "😀".repeat(983)) });
    let over = json!({ "pairingCode": format!("draftyak-pair:v1:{}", "😀".repeat(984)) });
    assert!(api::check_schema("PairingWindow", &exact));
    assert!(!api::check_schema("PairingWindow", &over));
    for value in [exact, over] {
        assert!(!api::check_route_response("pairing-window", &value));
        assert!(!api::check_route_response_bytes(
            "pairing-window",
            &serde_json::to_vec(&value).unwrap()
        ));
    }
}
