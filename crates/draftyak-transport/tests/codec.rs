use draftyak_transport::{
    CodecError,
    payload::{Payload, hub_id},
};
use serde_json::Value;

#[test]
fn every_merged_payload_vector_checks_error_precedence_and_native_round_trip() {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/pairing/payloads.json")).unwrap();
    let now = vectors["now"].as_u64().unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        match Payload::decode(text, now) {
            Ok(payload) => {
                assert!(
                    case.get("error").is_none(),
                    "unexpected accepted payload vector"
                );
                assert_eq!(payload.encode_native(), text);
                assert_eq!(payload.preview().hub_id, case["hubId"].as_str().unwrap());
                assert_eq!(
                    payload.preview().name,
                    case["payload"]["name"].as_str().unwrap()
                );
                assert_eq!(
                    payload.expires_at_ms(),
                    case["payload"]["exp"].as_u64().unwrap()
                );
                assert_eq!(format!("{payload:?}"), "Payload([redacted])");
            }
            Err(error) => assert_eq!(
                Some(error.code()),
                case["error"].as_str(),
                "payload error precedence"
            ),
        }
    }
}
#[test]
fn both_merged_public_hub_id_vectors_use_the_full_pin_prefix() {
    let vectors: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/pairing/proofs.json")).unwrap();
    for case in vectors["hubIds"].as_array().unwrap() {
        let text = case["hid"].as_str().unwrap();
        let pin: Vec<u8> = text
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        assert_eq!(
            hub_id(&pin.try_into().unwrap()),
            case["display"].as_str().unwrap()
        );
    }
}
#[test]
fn invalid_clock_input_and_static_diagnostics_never_include_payload_text() {
    assert!(matches!(
        Payload::decode("PRIVATE_SYNTHETIC_CODE", 1 << 53),
        Err(CodecError::InvalidInput)
    ));
    assert_eq!(CodecError::InvalidInput.code(), "PAIR_INVALID_INPUT");
    assert_eq!(CodecError::Expired.code(), "PAIR_EXPIRED");
}
