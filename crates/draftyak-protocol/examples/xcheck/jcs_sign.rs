//! jcs, sha256, sign and verify: the crate's JCS, hashes and ES256 against @draftyak/protocol's.

use super::{Command, field, hex, hex_field};
use draftyak_protocol::sign::{base64url_decode, base64url_encode, spki_der};
use draftyak_protocol::{hash, jcs, sign};
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::pkcs8::DecodePrivateKey;
use serde_json::{Map, Value, json};

pub const COMMANDS: &[(&str, Command)] = &[
    ("jcs", run_jcs),
    ("sha256", run_sha256),
    ("sign", run_sign),
    ("verify", run_verify),
];

// {inputHex} → {canonicalHex, sha256, isCanonical} or {error, isCanonical: false}
fn run_jcs(request: &Map<String, Value>) -> Result<Value, String> {
    let input = hex_field(request, "inputHex")?;
    Ok(
        match jcs::parse_strict(&input).and_then(|value| jcs::canonicalize(&value)) {
            Ok(canonical) => json!({
                "canonicalHex": hex(canonical.as_bytes()),
                "sha256": hash::sha256_hex(canonical.as_bytes()),
                "isCanonical": jcs::is_canonical(&input),
            }),
            Err(error) => json!({"error": error.code(), "isCanonical": false}),
        },
    )
}

// {dataHex} → {sha256}; {headers: [[name, value], …]} → {sha256} or {error}
fn run_sha256(request: &Map<String, Value>) -> Result<Value, String> {
    if request.contains_key("dataHex") {
        return Ok(json!({"sha256": hash::sha256_hex(&hex_field(request, "dataHex")?)}));
    }
    let pair = |pair: &Value| match pair.as_array().map(Vec::as_slice) {
        Some([Value::String(name), Value::String(value)]) => Some((name.clone(), value.clone())),
        _ => None,
    };
    let headers: Vec<(String, String)> = request
        .get("headers")
        .and_then(Value::as_array)
        .and_then(|headers| headers.iter().map(pair).collect())
        .ok_or("sha256 takes dataHex or headers, a list of [name, value]")?;
    Ok(match hash::headers_sha256(&headers) {
        Ok(sha256) => json!({"sha256": sha256}),
        Err(error) => json!({"error": error.code()}),
    })
}

// {privateKeyPkcs8, typ, statement} → {signature, signingInputHex, publicKeySpki} or {error};
// {privateKeyPkcs8, inputHex} → {signature} over exactly those bytes, for vectors that break a rule.
fn run_sign(request: &Map<String, Value>) -> Result<Value, String> {
    let der = base64url_decode(field(request, "privateKeyPkcs8")?).unwrap_or_default();
    let key = SigningKey::from_pkcs8_der(&der).map_err(|_| "privateKeyPkcs8 is a P-256 key")?;
    if request.contains_key("inputHex") {
        let signature: Signature = key.sign(&hex_field(request, "inputHex")?);
        return Ok(json!({"signature": base64url_encode(&signature.to_bytes())}));
    }
    let typ = field(request, "typ")?;
    let statement = request
        .get("statement")
        .ok_or("sign takes a statement or inputHex")?;
    let signed = sign::signing_input(typ, statement)
        .and_then(|input| Ok((input, sign::sign(&key, typ, statement)?)));
    Ok(match signed {
        Ok((input, signature)) => json!({
            "signature": base64url_encode(&signature),
            "signingInputHex": hex(&input),
            "publicKeySpki": base64url_encode(&spki_der(key.verifying_key())),
        }),
        Err(error) => json!({"error": error.code()}),
    })
}

// {typ, receivedHex, signature, publicKeySpki} → {valid, statement?} or {error}
fn run_verify(request: &Map<String, Value>) -> Result<Value, String> {
    let typ = field(request, "typ")?;
    let received = hex_field(request, "receivedHex")?;
    // Bytes that aren't canonical base64url never verify.
    let signature = base64url_decode(field(request, "signature")?).unwrap_or_default();
    let key = base64url_decode(field(request, "publicKeySpki")?).unwrap_or_default();
    Ok(match sign::verify(typ, &received, &signature, &key) {
        Ok(Some(statement)) => json!({"valid": true, "statement": statement}),
        Ok(None) => json!({"valid": false}),
        Err(error) => json!({"error": error.code()}),
    })
}
