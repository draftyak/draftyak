use draftyak_protocol::sign::base64url_decode;
use draftyak_protocol::{
    flags::{flags_hash, parse_flags, required_ack_codes},
    snapshot::parse_snapshot,
    statements::{
        self, Statement,
        send::{check_flags_acked, check_send_window},
    },
};
use serde_json::{Map, Value, json};
pub const COMMANDS: &[(&str, super::Command)] = &[("statement", statement), ("flags", flags)];
fn statement(request: &Map<String, Value>) -> Result<Value, String> {
    let typ = super::field(request, "typ")?;
    let bytes = super::hex_field(request, "receivedHex")?;
    let signature = base64url_decode(super::field(request, "signature")?).unwrap_or_default();
    let key = base64url_decode(super::field(request, "publicKeySpki")?).unwrap_or_default();
    let Some(body) = statements::open_typed_statement(typ, &bytes, &signature, &key) else {
        return Ok(json!({"valid":false}));
    };
    let mut answer = json!({"valid":true,"statement":body});
    if let Statement::Send(send) = &body {
        if let Some(value) = request.get("snapshot") {
            let snapshot = parse_snapshot(serde_json::to_string(value).unwrap().as_bytes())
                .map_err(|_| "snapshot")?;
            answer["windowValid"] = json!(check_send_window(send, &snapshot));
        }
        if let Some(value) = request.get("flags") {
            let flags = parse_flags(
                serde_json::to_string(value)
                    .map_err(|_| "flags")?
                    .as_bytes(),
            )
            .map_err(|_| "flags")?;
            answer["flagsValid"] = json!(check_flags_acked(send, &flags));
        }
    }
    Ok(answer)
}
fn flags(request: &Map<String, Value>) -> Result<Value, String> {
    let Some(value) = request.get("flags") else {
        return Err("flags required".into());
    };
    let Ok(flags) = parse_flags(
        serde_json::to_string(value)
            .map_err(|_| "flags")?
            .as_bytes(),
    ) else {
        return Ok(json!({"error":"FLAGS_INVALID"}));
    };
    Ok(match flags_hash(&flags) {
        Ok(hash) => {
            json!({"hash":hash,"requiredAckCodes":required_ack_codes(&flags).map_err(|e|e.code().to_owned())?})
        }
        Err(error) => json!({"error":error.code()}),
    })
}
