use draftyak_protocol::{
    jcs::canonicalize,
    snapshot::{content_hash, fingerprint, parse_snapshot, send_window},
};
use serde_json::{Map, Value, json};
pub const COMMANDS: &[(&str, super::Command)] = &[("snapshot", check_snapshot)];
fn check_snapshot(request: &Map<String, Value>) -> Result<Value, String> {
    let bytes = super::field(request, "snapshotJson")?;
    let iat = request
        .get("iat")
        .and_then(Value::as_u64)
        .ok_or("iat is a nonnegative integer")?;
    let snapshot = match parse_snapshot(bytes.as_bytes()) {
        Ok(value) => value,
        Err(error) => return Ok(json!({"error":error.code()})),
    };
    let window = match send_window(&snapshot, iat) {
        Ok(value) => value,
        Err(error) => return Ok(json!({"error":error.code()})),
    };
    let canonical = canonicalize(&snapshot).map_err(|_| "canonical snapshot".to_owned())?;
    let version = unicode_normalization::UNICODE_VERSION;
    Ok(
        json!({"canonicalHex":super::hex(canonical.as_bytes()),"contentHash":content_hash(&snapshot).map_err(|e|e.to_string())?,"fingerprint":fingerprint(&snapshot).map_err(|e|e.to_string())?,"window":window,"unicodeVersion":format!("{}.{}",version.0,version.1)}),
    )
}
