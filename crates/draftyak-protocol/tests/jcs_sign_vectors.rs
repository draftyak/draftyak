//! Every case in spec/vectors/{jcs,hash,sign}/, which @draftyak/protocol generates and checks too.

use draftyak_protocol::sign::{base64url_decode, base64url_encode, spki_der};
use draftyak_protocol::{hash, jcs, sign};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePrivateKey;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fs;
use std::path::Path;

fn vector_files<T: DeserializeOwned>(area: &str) -> Vec<(String, T)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../spec/vectors")
        .join(area);
    let mut files: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .map(|entry| entry.expect("a directory entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect();
    files.sort();
    files
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .expect("a file name")
                .to_string_lossy()
                .into_owned();
            let text = fs::read(&path).expect("a readable vector file");
            let content = serde_json::from_slice(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            (name, content)
        })
        .collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).expect("hex"))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Deserialize)]
struct Cases<T> {
    format: String,
    cases: Vec<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JcsCase {
    id: String,
    input: Option<String>,
    input_hex: Option<String>,
    ieee754: Option<String>,
    canonical: Option<String>,
    canonical_hex: Option<String>,
    sha256: Option<String>,
    error: Option<String>,
}

#[test]
fn jcs_vectors() {
    let files = vector_files::<Cases<JcsCase>>("jcs");
    let names: Vec<_> = files.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["edges.json", "refusals.json", "rfc8785.json"]);
    let mut refused_duplicates = 0;
    for (name, file) in &files {
        assert_eq!(file.format, "draftyak.vectors.jcs.v1", "{name}");
        for case in &file.cases {
            let id = format!("{name}: {}", case.id);
            if let Some(bits) = &case.ieee754 {
                let double = f64::from_bits(u64::from_str_radix(bits, 16).expect("ieee754 hex"));
                let result = jcs::canonicalize(&double).map_err(|error| error.code());
                match &case.error {
                    Some(error) => assert_eq!(result, Err(error.as_str()), "{id}"),
                    None => assert_eq!(result.as_deref(), Ok(case.canonical.as_deref().unwrap())),
                }
                continue;
            }
            let input = match (&case.input, &case.input_hex) {
                (Some(text), None) => text.as_bytes().to_vec(),
                (None, Some(bytes)) => unhex(bytes),
                _ => panic!("{id}: needs input or inputHex"),
            };
            if let Some(error) = &case.error {
                let code = jcs::parse_strict(&input)
                    .map(drop)
                    .map_err(|error| error.code());
                assert_eq!(code, Err(error.as_str()), "{id}");
                assert!(!jcs::is_canonical(&input), "{id}");
                refused_duplicates += usize::from(error == "JCS_DUPLICATE_KEY");
                continue;
            }
            let value = jcs::parse_strict(&input).unwrap_or_else(|error| panic!("{id}: {error}"));
            let canonical = jcs::canonicalize(&value).expect("a canonical form");
            assert_eq!(Some(&canonical), case.canonical.as_ref(), "{id}");
            assert_eq!(Some(hex(canonical.as_bytes())), case.canonical_hex, "{id}");
            assert_eq!(
                Some(hash::sha256_hex(canonical.as_bytes())),
                case.sha256,
                "{id}"
            );
            assert!(jcs::is_canonical(canonical.as_bytes()), "{id}");
            assert_eq!(
                jcs::is_canonical(&input),
                input == canonical.as_bytes(),
                "{id}"
            );
        }
    }
    assert!(
        refused_duplicates >= 4,
        "the duplicate-key refusals are missing"
    );
}

#[derive(Deserialize)]
struct HeadersCase {
    id: String,
    headers: Vec<(String, String)>,
    canonical: Option<String>,
    sha256: Option<String>,
    error: Option<String>,
}

#[test]
fn hash_vectors() {
    let files = vector_files::<Cases<HeadersCase>>("hash");
    assert_eq!(files.len(), 1);
    for (name, file) in &files {
        assert_eq!(file.format, "draftyak.vectors.hash.v1", "{name}");
        for case in &file.cases {
            let result = hash::headers_sha256(&case.headers).map_err(|error| error.code());
            match (&case.error, &case.canonical, &case.sha256) {
                (Some(error), None, None) => assert_eq!(result, Err(error.as_str()), "{}", case.id),
                (None, Some(canonical), Some(sha256)) => {
                    assert_eq!(result.as_ref(), Ok(sha256), "{}", case.id);
                    assert_eq!(
                        &hash::sha256_hex(canonical.as_bytes()),
                        sha256,
                        "{}",
                        case.id
                    );
                }
                _ => panic!(
                    "{}: a case has an error or a canonical form and hash",
                    case.id
                ),
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedKey {
    test_only: bool,
    private_key_pkcs8: String,
    public_key_spki: String,
}

#[derive(Deserialize)]
struct Keys {
    signer: RecordedKey,
    other: RecordedKey,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignCase {
    id: String,
    typ: String,
    statement: Option<Value>,
    received_hex: Option<String>,
    public_key_spki: String,
    signature: String,
    rfc6979_signature: Option<String>,
    s: Option<String>,
    jcs: Option<String>,
    signing_input_hex: String,
    error: Option<String>,
    valid: bool,
}

#[derive(Deserialize)]
struct SignVectors {
    format: String,
    keys: Keys,
    cases: Vec<SignCase>,
}

fn signing_key(recorded: &RecordedKey) -> SigningKey {
    assert!(recorded.test_only);
    let der = base64url_decode(&recorded.private_key_pkcs8).expect("base64url PKCS #8");
    let key = SigningKey::from_pkcs8_der(&der).expect("a P-256 PKCS #8 key");
    assert_eq!(
        base64url_encode(&spki_der(key.verifying_key())),
        recorded.public_key_spki
    );
    key
}

// What verify says for a case: whether it opens the statement, or the error code.
fn verdict(typ: &str, received: &[u8], signature: &str, spki: &str) -> Result<bool, &'static str> {
    let signature = base64url_decode(signature).unwrap_or_default();
    let spki = base64url_decode(spki).unwrap_or_default();
    sign::verify(typ, received, &signature, &spki)
        .map(|statement| statement.is_some())
        .map_err(|error| error.code())
}

// The order of the P-256 group, halved: an S above it is high.
const HALF_ORDER: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xde, 0x73, 0x7d, 0x56, 0xd3, 0x8b, 0xcf, 0x42, 0x79, 0xdc, 0xe5, 0x61, 0x7e, 0x31, 0x92, 0xa8,
];

#[test]
fn sign_vectors() {
    let files = vector_files::<SignVectors>("sign");
    assert_eq!(files.len(), 1);
    let vectors = &files[0].1;
    assert_eq!(vectors.format, "draftyak.vectors.sign.v1");
    let signer = signing_key(&vectors.keys.signer);
    signing_key(&vectors.keys.other);
    let (mut rfc6979, mut made, mut high_s) = (0, 0, false);
    for case in &vectors.cases {
        let id = case.id.as_str();
        let input = unhex(&case.signing_input_hex);
        let received = match (&case.statement, &case.received_hex, &case.jcs) {
            (Some(statement), None, Some(jcs)) => {
                assert_eq!(&jcs::canonicalize(statement).expect("JCS"), jcs, "{id}");
                let built = sign::signing_input(&case.typ, statement);
                match &case.error {
                    Some(error) => assert_eq!(built.map_err(|e| e.code()), Err(error.as_str())),
                    None => assert_eq!(
                        built.map(|input| hex(&input)).as_ref(),
                        Ok(&case.signing_input_hex)
                    ),
                }
                jcs.as_bytes().to_vec()
            }
            (None, Some(received), None) => unhex(received),
            _ => panic!("{id}: a case has a statement with its jcs, or receivedHex"),
        };
        let prefix = format!("draftyak/v1/{}\n", case.typ);
        assert_eq!(input, [prefix.as_bytes(), &received].concat(), "{id}");
        let expected = match case.error.as_deref() {
            Some("SIGN_INVALID_TYP") => Err("SIGN_INVALID_TYP"),
            _ => Ok(case.valid),
        };
        let spki = &case.public_key_spki;
        assert_eq!(
            verdict(&case.typ, &received, &case.signature, spki),
            expected,
            "{id}"
        );
        if case.error.is_some() || case.received_hex.is_some() {
            // The signature is correct over these bytes; only the rule refuses it.
            let raw = Signature::from_slice(&base64url_decode(&case.signature).expect("sig"))
                .and_then(|signature| signer.verifying_key().verify(&input, &signature));
            assert!(raw.is_ok(), "{id}");
        }
        if let Some(recorded) = &case.rfc6979_signature {
            let signature: Signature = signer.sign(&input);
            assert_eq!(
                &base64url_encode(&signature.to_bytes()),
                recorded,
                "{id}: RFC 6979"
            );
            // The crate's own sign makes exactly these bytes, S as computed.
            if let (Some(statement), None) = (&case.statement, &case.error) {
                let signed = sign::sign(&signer, &case.typ, statement).expect("a signature");
                assert_eq!(&base64url_encode(&signed), recorded, "{id}: sign::sign");
                made += 1;
            }
            assert_eq!(
                verdict(&case.typ, &received, recorded, spki),
                expected,
                "{id}"
            );
            rfc6979 += 1;
        }
        if let Some(half) = &case.s {
            let bytes = base64url_decode(&case.signature).expect("a signature");
            let high = bytes[32..] > HALF_ORDER[..];
            assert_eq!(half, if high { "high" } else { "low" }, "{id}");
            assert_eq!(expected, Ok(true), "{id}: either half of S verifies");
            high_s |= high;
        }
    }
    assert!(rfc6979 >= 14, "RFC 6979 signatures are missing");
    assert!(
        made >= 2,
        "sign::sign is checked against no recorded signature"
    );
    assert!(high_s, "no case pins a signature with a high S");
}

#[test]
fn sign_round_trips_with_rfc6979() {
    let key = SigningKey::from_slice(&[7; 32]).expect("a P-256 scalar");
    let statement = serde_json::json!({"v": 1, "note": "\u{e9}", "iat": 1_792_000_000_000_u64});
    let first = sign::sign(&key, "login.v1", &statement).expect("a signature");
    assert_eq!(
        first,
        sign::sign(&key, "login.v1", &statement).expect("the same signature")
    );
    let received = jcs::canonicalize(&statement).expect("JCS");
    let spki = spki_der(key.verifying_key());
    let opened = sign::verify("login.v1", received.as_bytes(), &first, &spki).expect("a typ");
    assert_eq!(opened.map(Value::Object), Some(statement));
    assert_eq!(
        sign::verify("admin.v1", received.as_bytes(), &first, &spki),
        Ok(None)
    );
    let parsed = sign::verifying_key_from_spki(&spki).expect("the uncompressed SPKI");
    assert_eq!(&parsed, key.verifying_key());
    let point = VerifyingKey::from_sec1_bytes(&spki[26..]).ok();
    assert_eq!(point.as_ref(), Some(key.verifying_key()));
}
