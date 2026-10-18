use draftyak_protocol::{
    flags::{flags_hash, parse_flags},
    jcs::canonicalize,
    sign::base64url_decode,
    snapshot::parse_snapshot,
    statements::{
        self, Statement,
        send::{check_flags_acked, check_send_window},
    },
};
use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer},
    pkcs8::DecodePrivateKey,
};
use serde_json::Value;
fn documents() -> Vec<String> {
    statements::TYPES
        .iter()
        .map(|typ| {
            std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../spec/vectors/statements")
                    .join(format!("{typ}.json")),
            )
            .unwrap()
        })
        .collect()
}
fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}
#[test]
fn every_shared_statement_and_deterministic_signature() {
    for document in documents() {
        let document: Value = serde_json::from_str(&document).unwrap();
        let key = SigningKey::from_pkcs8_der(
            &base64url_decode(
                document["keys"]["signer"]["privateKeyPkcs8"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        for case in document["cases"].as_array().unwrap() {
            for name in ["signature", "rfc6979Signature"] {
                let Some(signature) = case[name].as_str() else {
                    continue;
                };
                let body = statements::open_typed_statement(
                    case["typ"].as_str().unwrap(),
                    &hex(case["receivedHex"].as_str().unwrap()),
                    &base64url_decode(signature).unwrap(),
                    &base64url_decode(case["publicKeySpki"].as_str().unwrap()).unwrap(),
                );
                assert_eq!(
                    body.is_some(),
                    case["valid"].as_bool().unwrap(),
                    "{} {name}",
                    case["id"]
                );
                if let Some(body) = body {
                    assert_eq!(
                        canonicalize(&body).unwrap(),
                        canonicalize(&case["statement"]).unwrap()
                    );
                    if let Statement::Send(send) = body {
                        if let Some(expected) = case["windowValid"].as_bool() {
                            let snapshot = parse_snapshot(
                                serde_json::to_string(&case["snapshot"]).unwrap().as_bytes(),
                            )
                            .unwrap();
                            assert_eq!(
                                check_send_window(&send, &snapshot),
                                expected,
                                "{}",
                                case["id"]
                            );
                        }
                        if let Some(expected) = case["flagsValid"].as_bool() {
                            let flags = parse_flags(
                                serde_json::to_string(&case["flags"]).unwrap().as_bytes(),
                            )
                            .unwrap();
                            assert_eq!(
                                check_flags_acked(&send, &flags),
                                expected,
                                "{}",
                                case["id"]
                            );
                        }
                    }
                }
            }
            if let Some(signature) = case["rfc6979Signature"].as_str() {
                let actual: Signature = key.sign(&hex(case["signingInputHex"].as_str().unwrap()));
                assert_eq!(
                    actual.to_bytes().as_slice(),
                    base64url_decode(signature).unwrap()
                );
            }
        }
    }
}
#[test]
fn flags_match_typescript_corpus() {
    let document: Value =
        serde_json::from_str(include_str!("../../../spec/vectors/flags/flags-hash.json")).unwrap();
    for case in document["cases"].as_array().unwrap() {
        let parsed = parse_flags(serde_json::to_string(&case["flags"]).unwrap().as_bytes());
        let result = parsed
            .map_err(|_| "FLAGS_INVALID")
            .and_then(|flags| flags_hash(&flags).map_err(|e| e.code()));
        if let Some(error) = case["error"].as_str() {
            assert_eq!(result.unwrap_err(), error, "{}", case["id"]);
        } else {
            assert_eq!(result.unwrap(), case["flagsHash"], "{}", case["id"]);
        }
    }
}
#[test]
fn registered_types_and_freshness() {
    assert_eq!(statements::TYPES.len(), documents().len());
    for typ in [
        "unregistered-test-contract.v1",
        "another-unregistered-test.v1",
        "unregistered-test.v2",
        "__proto__",
    ] {
        assert!(statements::parse_statement(typ, b"{}").is_none());
    }
    let document: Value = serde_json::from_str(&documents()[0]).unwrap();
    let body = statements::parse_statement(
        "approval.send.v1",
        canonicalize(&document["cases"][0]["statement"])
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    let Statement::Send(send) = body else {
        panic!("send");
    };
    assert!(send.is_fresh(send.iat));
    assert!(send.is_fresh(send.exp));
    assert!(!send.is_fresh(send.iat - 1));
    assert!(!send.is_fresh(send.exp + 1));
}
