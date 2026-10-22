const MANIFEST: &str = include_str!("../Cargo.toml");
const LOCK: &str = include_str!("../../Cargo.lock");
const FUTURES: &str = "futures-util = { version = \"=0.3.34\", default-features = false, features = [\"std\", \"sink\"] }";
const WEBSOCKET: &str = "tokio-tungstenite = { version = \"=0.30.0\", default-features = false, features = [\"handshake\"] }";

fn exact_stream_dependencies(manifest: &str) -> bool {
    [("futures-util", FUTURES), ("tokio-tungstenite", WEBSOCKET)]
        .into_iter()
        .all(|(name, required)| {
            let rows: Vec<_> = manifest
                .lines()
                .map(str::trim)
                .filter(|line| {
                    line.split_once('=')
                        .is_some_and(|(key, _)| key.trim() == name)
                })
                .collect();
            rows == [required]
        })
}

fn versions<'a>(lock: &'a str, name: &str) -> Vec<&'a str> {
    lock.split("[[package]]")
        .skip(1)
        .filter(|block| {
            block
                .lines()
                .any(|line| line == format!("name = \"{name}\""))
        })
        .filter_map(|block| {
            block
                .lines()
                .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
        })
        .collect()
}

#[test]
fn exact_websocket_pins_keep_handshake_only_and_no_second_tls_route() {
    assert!(exact_stream_dependencies(MANIFEST));
    for (name, version) in [
        ("tokio-tungstenite", "0.30.0"),
        ("tungstenite", "0.30.0"),
        ("futures-util", "0.3.34"),
        ("futures-sink", "0.3.34"),
        ("futures-task", "0.3.34"),
        ("slab", "0.4.12"),
        ("sha1", "0.11.0"),
        ("digest", "0.11.3"),
        ("sha2", "0.11.1"),
        ("crypto-common", "0.2.2"),
        ("block-buffer", "0.12.1"),
        ("cpufeatures", "0.3.1"),
    ] {
        assert_eq!(
            versions(LOCK, name),
            [version],
            "missing, changed or duplicated pin: {name}"
        );
    }
    for forbidden in [
        "native-tls",
        "tokio-native-tls",
        "openssl",
        "openssl-sys",
        "rustls-native-certs",
        "rustls-platform-verifier",
        "webpki-roots",
        "webpki-root-certs",
        "aws-lc-rs",
        "aws-lc-sys",
    ] {
        assert!(
            versions(LOCK, forbidden).is_empty(),
            "forbidden TLS/root route: {forbidden}"
        );
    }
}

#[test]
fn guard_refuses_pin_ranges_changed_versions_defaults_and_tls_root_features() {
    for invalid in [
        MANIFEST.replace("=0.30.0", "0.30.0"),
        MANIFEST.replace("=0.30.0", "=0.30.1"),
        MANIFEST.replace("=0.3.34", "0.3.34"),
        MANIFEST.replace("=0.3.34", "=0.3.35"),
        MANIFEST.replace(
            WEBSOCKET,
            &WEBSOCKET.replace("default-features = false", "default-features = true"),
        ),
        MANIFEST.replace(
            WEBSOCKET,
            &WEBSOCKET.replace("[\"handshake\"]", "[\"handshake\", \"native-tls\"]"),
        ),
        MANIFEST.replace(
            WEBSOCKET,
            &WEBSOCKET.replace(
                "[\"handshake\"]",
                "[\"handshake\", \"rustls-tls-webpki-roots\"]",
            ),
        ),
        MANIFEST.replace(
            FUTURES,
            &FUTURES.replace(
                "[\"std\", \"sink\"]",
                "[\"std\", \"sink\", \"async-await-macro\"]",
            ),
        ),
        format!("{MANIFEST}\n{WEBSOCKET}\n"),
    ] {
        assert!(!exact_stream_dependencies(&invalid));
    }
    let older = format!("{LOCK}\n[[package]]\nname = \"sha1\"\nversion = \"0.10.6\"\n");
    assert_ne!(versions(&older, "sha1"), ["0.11.0"]);
    let duplicate = format!("{LOCK}\n[[package]]\nname = \"digest\"\nversion = \"0.10.7\"\n");
    assert_ne!(versions(&duplicate, "digest"), ["0.11.3"]);
}
