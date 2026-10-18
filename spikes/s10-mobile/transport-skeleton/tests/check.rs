use std::sync::Arc;

use rustls::ProtocolVersion;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use transport_skeleton::*;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().build().unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn every_call_in_the_check_works() {
    let bits = run_check();
    assert_eq!(bits, CHECK_ALL, "missing check bits: {:#010b}", CHECK_ALL & !bits);
    assert_eq!(draftyak_transport_check(), CHECK_ALL);
    let default = rustls::crypto::CryptoProvider::get_default();
    assert!(default.is_none(), "a process-default provider was installed");
}

#[test]
fn l2_is_tls13_only_without_session_tickets_on_the_compiled_provider() {
    let versions = rustls::ALL_VERSIONS.iter().map(|v| v.version).collect::<Vec<_>>();
    assert_eq!(versions, [ProtocolVersion::TLSv1_3], "TLS 1.2 is compiled in");
    let hub = new_identity(HUB_NAME).unwrap();
    let device = new_identity(DEVICE_NAME).unwrap();
    let client = Arc::new(client_config(hub.spki_sha256, &device).unwrap());
    let server = Arc::new(hub_config(device.spki_sha256, &hub).unwrap());
    runtime().block_on(async move {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let acceptor = tokio_rustls::TlsAcceptor::from(server);
        let hub_side = tokio::spawn(async move {
            let mut tls = acceptor.accept(far).await.unwrap();
            tls.write_all(b"hi").await.unwrap();
            tls.flush().await.unwrap();
            tls.get_ref().1.protocol_version()
        });
        let mut tls = connect_tls(near, client, HUB_NAME).await.unwrap();
        // A ticket would arrive before the hub's first bytes.
        let mut hi = [0u8; 2];
        tls.read_exact(&mut hi).await.unwrap();
        assert_eq!(hub_side.await.unwrap(), Some(ProtocolVersion::TLSv1_3));
        let conn = tls.get_ref().1;
        assert_eq!(conn.protocol_version(), Some(ProtocolVersion::TLSv1_3));
        assert_eq!(conn.tls13_tickets_received(), 0, "the hub sent session tickets");
        let suite = conn.negotiated_cipher_suite().and_then(|s| s.tls13()).unwrap();
        let compiled =
            provider().cipher_suites.iter().filter_map(|s| s.tls13()).collect::<Vec<_>>();
        assert!(compiled.iter().any(|s| std::ptr::eq(*s, suite)), "a suite not from {PROVIDER}");
    });
}

#[test]
fn a_hub_with_another_spki_is_refused() {
    let hub = new_identity(HUB_NAME).unwrap();
    let impostor = new_identity(HUB_NAME).unwrap();
    let device = new_identity(DEVICE_NAME).unwrap();
    let client = Arc::new(client_config(hub.spki_sha256, &device).unwrap());
    let server = Arc::new(hub_config(device.spki_sha256, &impostor).unwrap());
    runtime().block_on(async move {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let acceptor = tokio_rustls::TlsAcceptor::from(server);
        let hub_side = tokio::spawn(async move { acceptor.accept(far).await.is_ok() });
        assert!(connect_tls(near, client, HUB_NAME).await.is_err());
        assert!(!hub_side.await.unwrap());
    });
}

#[test]
fn a_device_with_another_spki_is_refused() {
    let hub = new_identity(HUB_NAME).unwrap();
    let device = new_identity(DEVICE_NAME).unwrap();
    let other = new_identity(DEVICE_NAME).unwrap();
    let client = Arc::new(client_config(hub.spki_sha256, &other).unwrap());
    let server = Arc::new(hub_config(device.spki_sha256, &hub).unwrap());
    runtime().block_on(async move {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let acceptor = tokio_rustls::TlsAcceptor::from(server);
        let hub_side = tokio::spawn(async move { acceptor.accept(far).await.is_ok() });
        let device_side = connect_tls(near, client, HUB_NAME).await;
        assert!(!hub_side.await.unwrap());
        if let Ok(mut tls) = device_side {
            let _ = tls.write_all(b"GET / HTTP/1.1\r\n\r\n").await;
            let mut buf = [0u8; 1];
            assert!(!matches!(tls.read(&mut buf).await, Ok(1)));
        }
    });
}

type Body = Box<dyn FnOnce(&[u8; 32], &[u8; 16], &[u8; 32]) -> String + Send>;

// One pairing claim on a fresh connection: `body` gets the device's SPKI hash, the window's
// secret and the device's EKM. Returns the hub's status and verdict.
fn claim(body: Body) -> (u16, bool) {
    let hub = new_identity(HUB_NAME).unwrap();
    let device = new_identity(DEVICE_NAME).unwrap();
    let client = Arc::new(client_config(hub.spki_sha256, &device).unwrap());
    let server = Arc::new(hub_config(device.spki_sha256, &hub).unwrap());
    let (sec, pid) = (random::<16>().unwrap(), random::<16>().unwrap());
    runtime().block_on(async move {
        let (near, far) = tokio::io::duplex(64 * 1024);
        let acceptor = tokio_rustls::TlsAcceptor::from(server);
        let hub_side = tokio::spawn(async move {
            accept_claim(acceptor.accept(far).await.unwrap(), &sec, &pid).await.unwrap()
        });
        let tls = connect_tls(near, client, HUB_NAME).await.unwrap();
        let device_ekm = ekm(tls.get_ref().1, &pid).unwrap();
        let text = body(&device.spki_sha256, &sec, &device_ekm);
        let status = http_post(tls, HUB_NAME, "/pair/v1/claim", text).await.unwrap();
        let (hub_ekm, claimed) = hub_side.await.unwrap();
        assert_eq!(hub_ekm, device_ekm);
        (status, claimed)
    })
}

#[test]
fn the_hub_accepts_a_claim_only_over_this_connection_for_its_certificate() {
    let approval = *new_approval_key().unwrap().verifying_key();
    let other = new_identity(DEVICE_NAME).unwrap().spki_sha256;
    let honest =
        claim(Box::new(move |spki, sec, ekm| claim_body(sec, ekm, spki, &approval).unwrap()));
    assert_eq!(honest, (204, true));
    let elsewhere: Body = Box::new(move |spki, sec, _| {
        claim_body(sec, &random::<32>().unwrap(), spki, &approval).unwrap()
    });
    assert_eq!(claim(elsewhere), (403, false), "an EKM from another connection");
    let impostor: Body =
        Box::new(move |_, sec, ekm| claim_body(sec, ekm, &other, &approval).unwrap());
    assert_eq!(claim(impostor), (403, false), "a transport key this certificate doesn't hold");
    let stale: Body = Box::new(move |spki, _, ekm| {
        claim_body(&random::<16>().unwrap(), ekm, spki, &approval).unwrap()
    });
    assert_eq!(claim(stale), (403, false), "another window's secret");
    assert_eq!(claim(Box::new(|_, _, _| "00.00".into())), (403, false), "a malformed claim");
}

#[test]
fn the_pairing_proof_and_sas_match_their_vectors() {
    let proof = pair_proof(&[1; 16], &[2; 32], b"pubs").unwrap();
    assert_eq!(hex(&proof), "d9351b28b88772134dcbcaa57c493ae1cafff501908e530a1c9f4fe700a850f1");
    assert!(verify_pair_proof(&[1; 16], &[2; 32], b"pubs", &proof));
    assert!(!verify_pair_proof(&[1; 16], &[3; 32], b"pubs", &proof));
    assert!(!verify_pair_proof(&[1; 16], &[2; 32], b"pubz", &proof));
    assert!(!verify_pair_proof(&[9; 16], &[2; 32], b"pubs", &proof));
    assert_eq!(sas(&[0; 32]), 982_166);
    assert_eq!(sas(&[0xff; 32]), 6_520);
}

#[test]
fn statements_sign_the_jcs_form() {
    let key = new_approval_key().unwrap();
    let signature = sign_statement(&key, "consent.v1", r#"{"b":2,"a":1}"#).unwrap();
    verify_statement(key.verifying_key(), "consent.v1", r#"{"a":1,"b":2}"#, &signature).unwrap();
    assert!(
        verify_statement(key.verifying_key(), "admin.v1", r#"{"a":1,"b":2}"#, &signature).is_err()
    );
    assert_eq!(
        statement_message("login.v1", r#"{"b":[1.0,"x"],"a":true}"#).unwrap(),
        b"draftyak/v1/login.v1\n{\"a\":true,\"b\":[1,\"x\"]}"
    );
    assert_eq!(
        statement_message("login.v1", r#"{"c":[{"b":2},{"b":3}],"a":{"b":1}}"#).unwrap(),
        b"draftyak/v1/login.v1\n{\"a\":{\"b\":1},\"c\":[{\"b\":2},{\"b\":3}]}"
    );
}

struct TwoKeys;

impl serde::Serialize for TwoKeys {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("a", &1)?;
        map.serialize_entry("a", &2)?;
        map.end()
    }
}

// serde_json_canonicalizer 0.4.1 refuses duplicate keys only while serializing: pipe() parses with
// serde_json, which keeps the last value. Statements are refused while parsing instead.
#[test]
fn jcs_refuses_duplicate_keys_only_when_serializing() {
    assert!(serde_json_canonicalizer::to_vec(&TwoKeys).is_err());
    assert_eq!(serde_json_canonicalizer::pipe(r#"{"a":1,"a":2}"#).unwrap(), r#"{"a":2}"#);
}

// The second key is "a" written as a JSON unicode escape.
const ESCAPED_REPEAT: &str = concat!(r#"[{"a":1,""#, "\\", r#"u0061":2}]"#);

#[test]
fn statements_that_repeat_a_key_are_refused_while_parsing() {
    assert_eq!(ESCAPED_REPEAT.len(), 20);
    for stmt in [r#"{"a":1,"a":2}"#, r#"{"a":{"b":1,"b":2}}"#, ESCAPED_REPEAT] {
        assert!(statement_message("login.v1", stmt).is_err(), "{stmt}");
    }
    let key = new_approval_key().unwrap();
    let signature = sign_statement(&key, "login.v1", r#"{"a":2}"#).unwrap();
    let repeated =
        verify_statement(key.verifying_key(), "login.v1", r#"{"a":1,"a":2}"#, &signature);
    assert!(repeated.is_err());
    assert!(sign_statement(&key, "login.v1", r#"{"a":1,"a":2}"#).is_err());
}

#[test]
fn send_times_render_from_the_bundled_tz_database() {
    assert_eq!(render_send_time(1_792_000_000_000, "America/Chicago").unwrap(), SEND_TIME_TEXT);
    assert_eq!(SEND_TIME_TEXT, "Wed 14 Oct, 12:46 CDT (UTC-05:00)");
    assert!(render_send_time(0, "Not/AZone").is_err());
}

#[test]
fn hub_ids_come_from_the_spki_hash() {
    assert_eq!(hub_id(&[0xAB; 32]), "DYK-ABAB-ABAB-ABAB-ABAB");
    let hub = new_identity(HUB_NAME).unwrap();
    assert_eq!(spki_sha256(&hub.cert).unwrap(), hub.spki_sha256);
}
