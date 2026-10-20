use draftyak_protocol::statements::pair_confirm::{
    ConfirmationPreset, DeviceCapability, can_confirm,
};
use serde_json::Value;

#[test]
fn shared_confirmation_presets_and_policy() {
    let document: Value = serde_json::from_str(include_str!(
        "../../../spec/vectors/pairing/confirmation-presets.json"
    ))
    .unwrap();
    for (name, capabilities) in document["presets"].as_object().unwrap() {
        let preset: ConfirmationPreset =
            serde_json::from_value(Value::String(name.clone())).unwrap();
        assert_eq!(
            serde_json::to_value(preset.capabilities()).unwrap(),
            *capabilities
        );
    }
    for case in document["cases"].as_array().unwrap() {
        let preset = serde_json::from_value::<ConfirmationPreset>(case["preset"].clone());
        let capabilities =
            serde_json::from_value::<Vec<DeviceCapability>>(case["capabilities"].clone());
        let valid = match (preset, capabilities) {
            (Ok(preset), Ok(capabilities)) => can_confirm(&capabilities, preset),
            _ => false,
        };
        assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}", case["id"]);
    }
}
