use std::collections::BTreeMap;

const OWNED_PINS: &[(&str, &str)] = &[
    ("base64ct", "1.8.3"),
    ("ecdsa", "0.17.0"),
    ("p256", "0.14.0"),
    ("serde", "1.0.229"),
    ("serde_json", "1.0.154"),
    ("serde_json_canonicalizer", "0.4.1"),
    ("sha2", "0.11.1"),
    ("thiserror", "2.0.21"),
    ("unicode-normalization", "0.1.25"),
    ("proptest", "1.12.0"),
    ("http-body-util", "0.1.3"),
    ("hyper", "1.12.0"),
    ("hyper-util", "0.1.21"),
    ("rcgen", "0.14.10"),
    ("rustls", "0.23.46"),
    ("tokio", "1.53.3"),
    ("tokio-rustls", "0.26.6"),
    ("zeroize", "1.9.1"),
    ("jiff", "0.2.38"),
    ("jiff-tzdb", "0.1.9"),
    ("ring", "0.17.14"),
    ("untrusted", "0.9.0"),
    ("rustls-webpki", "0.103.16"),
];
const RUST_CRYPTO: &[(&str, &str)] = &[
    ("base16ct", "1.0.0"),
    ("block-buffer", "0.12.1"),
    ("const-oid", "0.10.2"),
    ("cpufeatures", "0.3.1"),
    ("crypto-bigint", "0.7.5"),
    ("crypto-common", "0.2.2"),
    ("der", "0.8.2"),
    ("digest", "0.11.3"),
    ("ecdsa", "0.17.0"),
    ("elliptic-curve", "0.14.1"),
    ("ff", "0.14.0"),
    ("group", "0.14.0"),
    ("hmac", "0.13.0"),
    ("hybrid-array", "0.4.15"),
    ("p256", "0.14.0"),
    ("pkcs8", "0.11.0"),
    ("primeorder", "0.14.0"),
    ("rand_core", "0.10.1"),
    ("rfc6979", "0.6.0"),
    ("sec1", "0.8.1"),
    ("sha2", "0.11.1"),
    ("signature", "3.0.0"),
    ("spki", "0.8.1"),
    ("subtle", "2.6.1"),
];
const DUPLICATES: &[(&str, &[&str])] = &[
    ("bitflags", &["1.3.2", "2.13.2"]),
    ("getrandom", &["0.2.17", "0.4.3"]),
    ("syn", &["2.0.119", "3.0.9"]),
    ("windows-sys", &["0.52.0", "0.61.2"]),
];
const SKIPS: &[(&str, &str)] = &[("getrandom", "0.2.17"), ("windows-sys", "0.52.0")];
const BANNED: &[&str] = &[
    "reqwest",
    "native-tls",
    "tokio-native-tls",
    "openssl",
    "openssl-sys",
    "aws-lc-rs",
    "aws-lc-sys",
    "rustls-native-certs",
    "webpki-roots",
    "rustls-platform-verifier",
    "webpki-root-certs",
];
#[derive(Clone)]
struct Locked {
    name: String,
    version: String,
}
fn quoted(text: &str) -> Option<&str> {
    text.trim()
        .strip_prefix('"')?
        .split_once('"')
        .map(|(s, _)| s)
}
fn packages(lock: &str) -> Vec<Locked> {
    lock.split("[[package]]")
        .skip(1)
        .map(|block| {
            let field = |key: &str| {
                block
                    .lines()
                    .find_map(|line| line.trim().strip_prefix(key).and_then(quoted))
                    .unwrap()
            };
            Locked {
                name: field("name = ").into(),
                version: field("version = ").into(),
            }
        })
        .collect()
}
fn versions<'a>(packages: &'a [Locked], name: &str) -> Vec<&'a str> {
    let mut found: Vec<_> = packages
        .iter()
        .filter(|p| p.name == name)
        .map(|p| p.version.as_str())
        .collect();
    found.sort_unstable();
    found
}
fn inventory(packages: &[Locked]) -> BTreeMap<&str, Vec<&str>> {
    let mut all = BTreeMap::<_, Vec<_>>::new();
    for p in packages {
        all.entry(p.name.as_str())
            .or_default()
            .push(p.version.as_str());
    }
    all.retain(|_, v| v.len() > 1);
    for v in all.values_mut() {
        v.sort_unstable();
    }
    all
}
fn pins_match(packages: &[Locked], pins: &[(&str, &str)]) -> bool {
    pins.iter()
        .all(|(name, version)| versions(packages, name) == [*version])
}
fn manifest_pins_match(manifest: &str) -> bool {
    let mut dependencies = false;
    let mut count = 0;
    for line in manifest
        .lines()
        .map(str::trim)
        .filter(|s| !s.starts_with('#'))
    {
        if line.starts_with('[') {
            if line.contains("dependencies.") {
                return false;
            }
            dependencies = line.ends_with("dependencies]");
            continue;
        }
        if !dependencies || line.is_empty() {
            continue;
        }
        let Some((name, spec)) = line.split_once('=') else {
            return false;
        };
        if name.trim() == "draftyak-protocol"
            && spec.trim() == "{ path = \"../draftyak-protocol\" }"
        {
            continue;
        }
        let version =
            quoted(spec).or_else(|| spec.split_once("version = ").and_then(|(_, v)| quoted(v)));
        if !OWNED_PINS
            .iter()
            .any(|(n, v)| *n == name.trim() && version == Some(format!("={v}").as_str()))
        {
            return false;
        }
        count += 1;
    }
    count > 0
}
#[test]
fn every_owned_registry_pin_is_exact_and_locked_once() {
    let packages = packages(include_str!("../../Cargo.lock"));
    for manifest in [
        include_str!("../Cargo.toml"),
        include_str!("../../draftyak-protocol/Cargo.toml"),
    ] {
        assert!(
            manifest_pins_match(manifest),
            "registry dependencies must use exact owned pins"
        );
    }
    assert!(
        pins_match(&packages, OWNED_PINS),
        "an owned pin is missing, changed or duplicated"
    );
}
#[test]
fn one_rustcrypto_generation_and_only_the_recorded_duplicate_versions() {
    let packages = packages(include_str!("../../Cargo.lock"));
    assert!(
        pins_match(&packages, RUST_CRYPTO),
        "RustCrypto must remain one pinned generation"
    );
    let expected: BTreeMap<_, _> = DUPLICATES.iter().map(|(n, v)| (*n, v.to_vec())).collect();
    assert_eq!(
        inventory(&packages),
        expected,
        "unreviewed duplicate inventory change"
    );
}
#[test]
fn pin_predicates_reject_widening_changed_versions_and_added_generations() {
    let manifest = include_str!("../Cargo.toml");
    assert!(!manifest_pins_match(
        &manifest.replace("=0.23.46", "0.23.46")
    ));
    assert!(!manifest_pins_match(
        &manifest.replace("=0.23.46", "=0.23.47")
    ));
    assert!(!manifest_pins_match(&format!(
        "{manifest}\n[dependencies.hidden]\nversion=\"*\"\n"
    )));
    assert!(!manifest_pins_match(&manifest.replace(
        "http-body-util = \"=0.1.3\"",
        "http-body-util = \"*\" # path = \"hidden\""
    )));
    let mut locked = packages(include_str!("../../Cargo.lock"));
    locked.push(Locked {
        name: "sha2".into(),
        version: "0.10.9".into(),
    });
    assert!(!pins_match(&locked, RUST_CRYPTO));
    let expected: BTreeMap<_, _> = DUPLICATES.iter().map(|(n, v)| (*n, v.to_vec())).collect();
    assert_ne!(inventory(&locked), expected);
}
#[test]
fn transport_features_keep_the_explicit_ring_tls13_graph_and_test_only_features() {
    let manifest = include_str!("../Cargo.toml");
    for pin in [
        "rustls = { version = \"=0.23.46\", default-features = false, features = [\"std\", \"ring\"] }",
        "tokio-rustls = { version = \"=0.26.6\", default-features = false, features = [\"ring\"] }",
        "jiff = { version = \"=0.2.38\", features = [\"tzdb-bundle-always\"] }",
    ] {
        assert!(
            manifest.contains(pin),
            "required transport features changed"
        );
    }
    let normal = manifest.split("[dev-dependencies]").next().unwrap();
    assert!(
        !normal.contains("\"pem\"") && !normal.contains("\"macros\"") && !normal.contains("p256 =")
    );
    assert!(!manifest.contains("\"tls12\"") && !manifest.contains("\"aws_lc_rs\""));
    let lock = include_str!("../../Cargo.lock");
    let policy = include_str!("../../deny.toml");
    assert!(policy.contains("multiple-versions = \"deny\""));
    assert!(policy.contains("multiple-versions-include-dev = true"));
    assert!(!policy.contains("skip-tree") && !policy.contains("multiple-versions = \"allow\""));
    for banned in BANNED {
        assert!(
            !lock.contains(&format!("name = \"{banned}\"")),
            "forbidden transport dependency in lock"
        );
        assert!(
            policy.contains(&format!("{{ name = \"{banned}\" }}")),
            "forbidden transport dependency lacks deny policy"
        );
    }
}
#[test]
fn policy_skips_are_only_exact_reasoned_inventory_entries_and_isc_is_scoped() {
    let policy = include_str!("../../deny.toml");
    let skips = policy
        .split_once("skip = [")
        .unwrap()
        .1
        .split_once(']')
        .unwrap()
        .0;
    let entries: Vec<_> = skips
        .lines()
        .map(str::trim)
        .filter(|s| s.starts_with('{'))
        .collect();
    assert_eq!(entries.len(), SKIPS.len());
    for (name, version) in SKIPS {
        let prefix = format!("{{ name = \"{name}\", version = \"={version}\", reason = \"");
        assert!(
            entries
                .iter()
                .any(|line| line.starts_with(&prefix) && line.len() > prefix.len() + 20),
            "skip must name the exact version and explain its parents"
        );
    }
    let licenses = policy
        .split_once("[licenses]")
        .unwrap()
        .1
        .split_once("[bans]")
        .unwrap()
        .0;
    let global = licenses
        .split_once("allow = [")
        .unwrap()
        .1
        .split_once(']')
        .unwrap()
        .0;
    assert!(
        !global.contains("\"ISC\""),
        "ISC is never a global permission"
    );
    let exceptions = licenses.split_once("exceptions = [").unwrap().1;
    assert_eq!(
        exceptions
            .lines()
            .filter(|line| line.trim().starts_with('{'))
            .count(),
        3
    );
    for row in [
        "{ name = \"ring\", version = \"=0.17.14\", allow = [\"Apache-2.0\", \"ISC\"] }",
        "{ name = \"untrusted\", version = \"=0.9.0\", allow = [\"ISC\"] }",
        "{ name = \"rustls-webpki\", version = \"=0.103.16\", allow = [\"ISC\"] }",
    ] {
        assert!(exceptions.contains(row), "ISC exception widened or changed");
    }
}
