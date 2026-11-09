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
    ("hkdf", "0.13.0"),
    ("hyper", "1.12.0"),
    ("hyper-util", "0.1.21"),
    ("rcgen", "0.14.10"),
    ("rustls", "0.23.46"),
    ("tokio", "1.53.3"),
    ("tokio-rustls", "0.26.6"),
    ("zeroize", "1.9.1"),
    ("keyring-core", "1.0.1"),
    ("windows-native-keyring-store", "1.1.0"),
    ("apple-native-keyring-store", "1.0.2"),
    ("zbus-secret-service-keyring-store", "1.0.1"),
    ("jiff", "0.2.38"),
    ("jiff-tzdb", "0.1.9"),
    ("ring", "0.17.14"),
    ("untrusted", "0.9.0"),
    ("rustls-webpki", "0.103.16"),
    ("futures-util", "0.3.34"),
    ("tokio-tungstenite", "0.30.0"),
];
const RUST_CRYPTO: &[(&str, &str)] = &[
    ("base16ct", "1.0.0"),
    ("block-buffer", "0.12.1"),
    ("const-oid", "0.10.2"),
    ("cpufeatures", "0.3.1"),
    ("crypto-bigint", "0.7.10"),
    ("crypto-common", "0.2.2"),
    ("der", "0.8.2"),
    ("digest", "0.11.3"),
    ("ecdsa", "0.17.0"),
    ("elliptic-curve", "0.14.1"),
    ("ff", "0.14.0"),
    ("group", "0.14.0"),
    ("hkdf", "0.13.0"),
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
    ("getrandom", &["0.2.17", "0.3.4", "0.4.3"]),
    ("syn", &["1.0.109", "2.0.119", "3.0.9"]),
    ("windows-sys", &["0.45.0", "0.52.0", "0.61.2"]),
    ("aes", &["0.8.4", "0.9.2"]),
    ("base64", &["0.21.7", "0.23.1"]),
    ("bit-vec", &["0.8.0", "0.9.1"]),
    ("block-buffer", &["0.10.4", "0.12.1"]),
    ("cipher", &["0.4.4", "0.5.2"]),
    ("cpufeatures", &["0.2.17", "0.3.1"]),
    ("crypto-common", &["0.1.7", "0.2.2"]),
    ("digest", &["0.10.7", "0.11.3"]),
    ("hashbrown", &["0.12.3", "0.17.1"]),
    ("heck", &["0.4.1", "0.5.0"]),
    ("indexmap", &["1.9.3", "2.14.2"]),
    ("inout", &["0.1.4", "0.2.5"]),
    ("jni-sys", &["0.3.1", "0.4.1"]),
    ("miniz_oxide", &["0.8.9", "0.9.1"]),
    ("proc-macro-crate", &["1.3.1", "2.0.2", "3.5.0"]),
    ("r-efi", &["5.3.0", "6.0.0"]),
    ("rand_core", &["0.10.1", "0.6.4"]),
    ("schemars", &["0.8.22", "0.9.0", "1.2.3"]),
    ("serde_spanned", &["0.6.9", "1.1.2"]),
    ("sha2", &["0.10.9", "0.11.1"]),
    ("synstructure", &["0.13.2", "0.14.0"]),
    ("thiserror", &["1.0.69", "2.0.21"]),
    ("thiserror-impl", &["1.0.69", "2.0.21"]),
    ("toml", &["0.8.2", "1.1.8+spec-1.1.0"]),
    ("toml_datetime", &["0.6.3", "1.1.2+spec-1.1.0"]),
    ("toml_edit", &["0.19.15", "0.20.2", "0.25.17+spec-1.1.0"]),
    ("windows-targets", &["0.42.2", "0.52.6"]),
    ("windows_aarch64_gnullvm", &["0.42.2", "0.52.6"]),
    ("windows_aarch64_msvc", &["0.42.2", "0.52.6"]),
    ("windows_i686_gnu", &["0.42.2", "0.52.6"]),
    ("windows_i686_msvc", &["0.42.2", "0.52.6"]),
    ("windows_x86_64_gnu", &["0.42.2", "0.52.6"]),
    ("windows_x86_64_gnullvm", &["0.42.2", "0.52.6"]),
    ("windows_x86_64_msvc", &["0.42.2", "0.52.6"]),
    ("winnow", &["0.5.40", "1.0.4"]),
];
const SKIPS: &[(&str, &str)] = &[
    ("getrandom", "0.2.17"),
    ("windows-sys", "0.52.0"),
    ("syn", "2.0.119"),
    ("aes", "0.8.4"),
    ("base64", "0.21.7"),
    ("bitflags", "1.3.2"),
    ("block-buffer", "0.10.4"),
    ("cipher", "0.4.4"),
    ("cpufeatures", "0.2.17"),
    ("crypto-common", "0.1.7"),
    ("digest", "0.10.7"),
    ("getrandom", "0.3.4"),
    ("hashbrown", "0.12.3"),
    ("heck", "0.4.1"),
    ("indexmap", "1.9.3"),
    ("inout", "0.1.4"),
    ("miniz_oxide", "0.8.9"),
    ("proc-macro-crate", "1.3.1"),
    ("proc-macro-crate", "2.0.2"),
    ("r-efi", "5.3.0"),
    ("rand_core", "0.6.4"),
    ("serde_spanned", "0.6.9"),
    ("sha2", "0.10.9"),
    ("syn", "1.0.109"),
    ("thiserror", "1.0.69"),
    ("thiserror-impl", "1.0.69"),
    ("toml", "0.8.2"),
    ("toml_datetime", "0.6.3"),
    ("toml_edit", "0.19.15"),
    ("toml_edit", "0.20.2"),
    ("windows_aarch64_gnullvm", "0.42.2"),
    ("windows_aarch64_msvc", "0.42.2"),
    ("windows_i686_gnu", "0.42.2"),
    ("windows_i686_msvc", "0.42.2"),
    ("windows_x86_64_gnu", "0.42.2"),
    ("windows_x86_64_gnullvm", "0.42.2"),
    ("windows_x86_64_msvc", "0.42.2"),
    ("windows-sys", "0.45.0"),
    ("windows-targets", "0.42.2"),
    ("winnow", "0.5.40"),
];
const LICENSE_EXCEPTIONS: &[&str] = &[
    "{ name = \"ring\", version = \"=0.17.14\", allow = [\"Apache-2.0\", \"ISC\"] }",
    "{ name = \"untrusted\", version = \"=0.9.0\", allow = [\"ISC\"] }",
    "{ name = \"rustls-webpki\", version = \"=0.103.16\", allow = [\"ISC\"] }",
    "{ name = \"cssparser\", version = \"=0.37.0\", allow = [\"MPL-2.0\"] }",
    "{ name = \"cssparser-macros\", version = \"=0.7.1\", allow = [\"MPL-2.0\"] }",
    "{ name = \"dtoa-short\", version = \"=0.3.5\", allow = [\"MPL-2.0\"] }",
    "{ name = \"foldhash\", version = \"=0.2.0\", allow = [\"Zlib\"] }",
    "{ name = \"option-ext\", version = \"=0.2.0\", allow = [\"MPL-2.0\"] }",
    "{ name = \"selectors\", version = \"=0.38.0\", allow = [\"MPL-2.0\"] }",
    "{ name = \"target-lexicon\", version = \"=0.12.16\", allow = [\"Apache-2.0 WITH LLVM-exception\"] }",
];
const P256: &str =
    "p256 = { version = \"=0.14.0\", default-features = false, features = [\"ecdsa\", \"pkcs8\"] }";
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
    source: Option<String>,
    dependencies: Vec<String>,
    parse_valid: bool,
}
fn quoted(text: &str) -> Option<&str> {
    text.trim()
        .strip_prefix('"')?
        .split_once('"')
        .map(|(s, _)| s)
}
fn exact_lock_string(text: &str) -> Option<&str> {
    let value = text.trim().strip_prefix('"')?.strip_suffix('"')?;
    (!value.contains(['"', '\\']) && !value.chars().any(char::is_control)).then_some(value)
}
fn lock_details(block: &str) -> (Option<String>, Vec<String>, bool) {
    let mut source = None;
    let mut dependencies = Vec::new();
    let mut seen = [false; 5];
    let mut in_dependencies = false;
    let mut valid = true;
    for line in block
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.starts_with('#'))
    {
        if in_dependencies {
            if line == "]" {
                in_dependencies = false;
            } else if let Some(reference) = line.strip_suffix(',').and_then(exact_lock_string) {
                dependencies.push(reference.to_owned());
            } else {
                valid = false;
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            valid = false;
            continue;
        };
        let value = value.trim();
        let index = match key.trim() {
            "name" => 0,
            "version" => 1,
            "source" => 2,
            "dependencies" => 3,
            "checksum" => 4,
            _ => {
                valid = false;
                continue;
            }
        };
        if seen[index] {
            valid = false;
        }
        seen[index] = true;
        if index == 3 {
            match value {
                "[]" => {}
                "[" => in_dependencies = true,
                _ => valid = false,
            }
        } else if let Some(text) = exact_lock_string(value) {
            if index == 2 {
                source = Some(text.to_owned());
            } else if index == 4 {
                valid &= text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit());
            } else if text.is_empty() {
                valid = false;
            }
        } else {
            valid = false;
        }
    }
    (
        source,
        dependencies,
        valid && seen[0] && seen[1] && !in_dependencies,
    )
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
            let (source, dependencies, parse_valid) = lock_details(block);
            Locked {
                name: field("name = ").into(),
                version: field("version = ").into(),
                source,
                dependencies,
                parse_valid,
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
fn outside_dev_dependencies<'a>(manifest: &'a str, needle: &str) -> Vec<&'a str> {
    let mut dev = false;
    manifest
        .lines()
        .map(str::trim)
        .filter(|line| {
            if line.starts_with('[') {
                dev = line.ends_with("dev-dependencies]");
            }
            !dev && line.contains(needle)
        })
        .collect()
}
fn test_only_features_stay_in_dev_dependencies(manifest: &str) -> bool {
    ["pem\"", "macros\""]
        .iter()
        .all(|feature| outside_dev_dependencies(manifest, feature).is_empty())
}
fn bans_array<'a>(policy: &'a str, key: &str) -> Vec<&'a str> {
    let lines: Vec<_> = policy
        .lines()
        .map(str::trim)
        .skip_while(|line| *line != "[bans]")
        .skip(1)
        .take_while(|line| !line.starts_with('['))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    let open = format!("{key} = [");
    let start = lines
        .iter()
        .position(|line| *line == open)
        .map_or(lines.len(), |index| index + 1);
    lines[start..]
        .iter()
        .copied()
        .take_while(|line| *line != "]")
        .collect()
}
fn exact_skips(policy: &str) -> bool {
    let rows = bans_array(policy, "skip");
    rows.len() == SKIPS.len()
        && SKIPS.iter().zip(&rows).all(|((name, version), row)| {
            row.strip_prefix(&format!(
                "{{ name = \"{name}\", version = \"={version}\", reason = \""
            ))
            .and_then(|rest| rest.strip_suffix("\" },"))
            .is_some_and(|reason| reason.len() > 20 && !reason.contains('"'))
        })
}
fn exact_denies(policy: &str) -> bool {
    bans_array(policy, "deny").into_iter().eq(BANNED
        .iter()
        .map(|name| format!("{{ name = \"{name}\" }},")))
}
fn pins_match(packages: &[Locked], pins: &[(&str, &str)]) -> bool {
    pins.iter().all(|(name, version)| {
        match DUPLICATES.iter().find(|(duplicate, _)| duplicate == name) {
            Some((_, expected)) => {
                expected.contains(version) && versions(packages, name) == expected.to_vec()
            }
            None => versions(packages, name) == [*version],
        }
    })
}
fn license_exceptions(policy: &str) -> Vec<&str> {
    let Some((_, licenses)) = policy.split_once("[licenses]") else {
        return Vec::new();
    };
    let Some((_, exceptions)) = licenses.split_once("exceptions = [") else {
        return Vec::new();
    };
    exceptions
        .lines()
        .map(str::trim)
        .take_while(|line| *line != "]")
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| line.strip_suffix(',').unwrap_or(line))
        .collect()
}
fn exact_license_exceptions(policy: &str) -> bool {
    license_exceptions(policy)
        .into_iter()
        .eq(LICENSE_EXCEPTIONS.iter().copied())
}
fn exact_global_license_allow(policy: &str) -> bool {
    let Some((_, licenses)) = policy.split_once("[licenses]") else {
        return false;
    };
    let Some((_, allow)) = licenses.split_once("allow = [") else {
        return false;
    };
    allow
        .lines()
        .map(str::trim)
        .take_while(|line| *line != "]")
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .eq([
            "\"Apache-2.0\",",
            "\"BSD-3-Clause\",",
            "\"MIT\",",
            "\"Unicode-3.0\",",
        ])
}
const LOCK_REGISTRY: &str = "registry+https://github.com/rust-lang/crates.io-index";
fn resolve_locked_reference(packages: &[Locked], reference: &str) -> Option<usize> {
    let parts: Vec<_> = reference.split_ascii_whitespace().collect();
    if parts.join(" ") != reference {
        return None;
    }
    let (name, version) = match parts.as_slice() {
        [name] => (*name, None),
        [name, version] => (*name, Some(*version)),
        _ => return None,
    };
    let mut matches = packages.iter().enumerate().filter(|(_, package)| {
        package.name == name && version.is_none_or(|version| package.version == version)
    });
    let (index, _) = matches.next()?;
    matches.next().is_none().then_some(index)
}
fn reqwest_lock_parent_matches(packages: &[Locked]) -> bool {
    if packages.iter().any(|package| !package.parse_valid) {
        return false;
    }
    let (Some(reqwest), Some(tauri)) = (
        resolve_locked_reference(packages, "reqwest"),
        resolve_locked_reference(packages, "tauri"),
    ) else {
        return false;
    };
    if packages[reqwest].version != "0.13.5"
        || packages[tauri].version != "2.12.4"
        || packages[reqwest].source.as_deref() != Some(LOCK_REGISTRY)
        || packages[tauri].source.as_deref() != Some(LOCK_REGISTRY)
    {
        return false;
    }
    let mut inbound = 0;
    for (parent, package) in packages.iter().enumerate() {
        for reference in &package.dependencies {
            let Some(dependency) = resolve_locked_reference(packages, reference) else {
                return false;
            };
            if dependency == reqwest {
                if parent != tauri || inbound != 0 {
                    return false;
                }
                inbound += 1;
            }
        }
    }
    inbound == 1
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
fn every_owned_registry_pin_is_exact_with_only_recorded_locked_versions() {
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
        "an owned pin is missing, changed or has an unrecorded version"
    );
}
#[test]
fn rustcrypto_versions_and_only_the_recorded_workspace_duplicates() {
    let packages = packages(include_str!("../../Cargo.lock"));
    assert_eq!(packages.len(), 553, "the fixed workspace inventory changed");
    assert!(
        pins_match(&packages, RUST_CRYPTO),
        "RustCrypto versions must match the exact workspace inventory"
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
    assert_ne!(
        outside_dev_dependencies(
            &format!("{manifest}\n[target.'cfg(unix)'.dependencies]\n{P256}\n"),
            "p256"
        ),
        [P256]
    );
    for widened in [
        format!(
            "{manifest}\n[target.'cfg(unix)'.dependencies]\ntokio = {{ version = \"=1.53.3\", default-features = false, features = [\"rt\", \"macros\"] }}\n"
        ),
        format!(
            "{manifest}\n[target.'cfg(windows)'.dependencies]\nrcgen = {{ version = \"=0.14.10\", default-features = false, features = [\"crypto\", \"ring\", \"pem\"] }}\n"
        ),
        manifest.replace(
            "mock-store = []",
            "mock-store = []\nmacros = [\"tokio/macros\"]",
        ),
    ] {
        assert!(!test_only_features_stay_in_dev_dependencies(&widened));
    }
    let mut locked = packages(include_str!("../../Cargo.lock"));
    locked.push(Locked {
        name: "sha2".into(),
        version: "0.10.10".into(),
        source: None,
        dependencies: Vec::new(),
        parse_valid: true,
    });
    assert!(!pins_match(&locked, RUST_CRYPTO));
    let expected: BTreeMap<_, _> = DUPLICATES.iter().map(|(n, v)| (*n, v.to_vec())).collect();
    assert_ne!(inventory(&locked), expected);
}
#[test]
fn transport_features_and_workspace_inputs_keep_exact_tls_and_mobile_boundaries() {
    let manifest = include_str!("../Cargo.toml");
    for pin in [
        "hkdf = { version = \"=0.13.0\", default-features = false }",
        "rustls = { version = \"=0.23.46\", default-features = false, features = [\"std\", \"ring\"] }",
        "tokio-rustls = { version = \"=0.26.6\", default-features = false, features = [\"ring\"] }",
        "jiff = { version = \"=0.2.38\", features = [\"tzdb-bundle-always\"] }",
    ] {
        assert!(
            manifest.contains(pin),
            "required transport features changed"
        );
    }
    assert!(
        test_only_features_stay_in_dev_dependencies(manifest),
        "pem and macros stay test-only"
    );
    assert_eq!(
        outside_dev_dependencies(manifest, "p256"),
        [P256],
        "p256 stays the protocol's exact signing generation"
    );
    assert!(!manifest.contains("\"tls12\"") && !manifest.contains("\"aws_lc_rs\""));
    let lock = include_str!("../../Cargo.lock");
    let policy = include_str!("../../deny.toml");
    assert!(policy.contains("multiple-versions = \"deny\""));
    assert!(policy.contains("multiple-versions-include-dev = true"));
    assert!(!policy.contains("skip-tree") && !policy.contains("multiple-versions = \"allow\""));
    // This checks locked input, not mobile target/features or genuine graph origin.
    // The complete graph/route guard still precedes any isolated deny-row removal.
    assert!(
        reqwest_lock_parent_matches(&packages(lock)),
        "the sole recorded mobile HTTP input changed"
    );
    for banned in BANNED {
        if *banned != "reqwest" {
            assert!(
                !lock.contains(&format!("name = \"{banned}\"")),
                "forbidden transport dependency in lock"
            );
        }
        assert!(
            policy.contains(&format!("{{ name = \"{banned}\" }}")),
            "forbidden transport dependency lacks deny policy"
        );
    }
}
#[test]
fn policy_skips_are_only_exact_reasoned_inventory_entries_and_isc_is_scoped() {
    let policy = include_str!("../../deny.toml");
    assert!(
        exact_skips(policy),
        "skip must name the exact version and explain its parents"
    );
    let syn = "    { name = \"syn\", version = \"=2.0.119\"";
    for invalid in [
        policy.replacen(syn, &format!("    \"syn\",\n{syn}"), 1),
        policy.replacen(syn, &format!("    \"zvariant@5.15.1\",\n{syn}"), 1),
        policy.replacen(syn, "    { name = \"syn\", version = \"2.0.119\"", 1),
    ] {
        assert_ne!(invalid, policy);
        assert!(
            !exact_skips(&invalid),
            "a skip row that is not an exact reasoned version is refused"
        );
    }
    assert!(exact_denies(policy), "the deny list changed");
    assert!(
        exact_global_license_allow(policy),
        "global licence permissions changed"
    );
    let openssl = "    { name = \"openssl\" },\n";
    for invalid in [
        policy.replacen(openssl, "    # { name = \"openssl\" },\n", 1),
        policy.replacen(openssl, "    \"openssl\",\n", 1),
        policy.replacen(
            openssl,
            "    { name = \"openssl\", wrappers = [\"draftyak-transport\"] },\n",
            1,
        ),
    ] {
        assert_ne!(invalid, policy);
        assert!(!exact_denies(&invalid), "the deny list changed");
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
    assert!(
        exact_license_exceptions(policy),
        "an exact scoped licence exception changed"
    );
}

#[test]
fn finite_workspace_skip_and_licence_tables_reject_unrecorded_rows() {
    let policy = include_str!("../../deny.toml");
    let skip = bans_array(policy, "skip")
        .into_iter()
        .find(|row| row.starts_with("{ name = \"aes\", version = \"=0.8.4\""))
        .unwrap();
    for invalid in [
        policy.replacen(skip, "", 1),
        policy.replacen(skip, &format!("{skip}\n{skip}"), 1),
        policy.replacen(skip, &skip.replace("=0.8.4", "=0.8.5"), 1),
    ] {
        assert!(!exact_skips(&invalid));
    }
    let licence = LICENSE_EXCEPTIONS[3];
    for invalid in [
        policy.replacen(licence, "", 1),
        policy.replacen(licence, &format!("{licence}\n{licence}"), 1),
        policy.replacen(licence, &format!("# {licence}"), 1),
        policy.replacen(licence, &licence.replace("=0.37.0", "=0.37.1"), 1),
        policy.replacen(licence, &licence.replace("cssparser", "unrecorded"), 1),
    ] {
        assert!(!exact_license_exceptions(&invalid));
    }
    for licence in ["ISC", "MPL-2.0", "Zlib", "Apache-2.0 WITH LLVM-exception"] {
        let invalid = policy.replacen(
            "    \"MIT\",",
            &format!("    \"MIT\",\n    \"{licence}\","),
            1,
        );
        assert_ne!(invalid, policy);
        assert!(!exact_global_license_allow(&invalid));
    }
}

const REQWEST_LOCK_FIXTURE: &str = r#"
version = 4

[[package]]
name = "tauri"
version = "2.12.4"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = [
 "reqwest",
]

[[package]]
name = "reqwest"
version = "0.13.5"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#;
#[test]
fn reqwest_lock_parent_accepts_only_exact_unversioned_or_versioned_reference() {
    let parsed = packages(REQWEST_LOCK_FIXTURE);
    assert_eq!(parsed[0].source.as_deref(), Some(LOCK_REGISTRY));
    assert_eq!(parsed[0].dependencies, ["reqwest"]);
    assert!(reqwest_lock_parent_matches(&parsed));
    let explicit = REQWEST_LOCK_FIXTURE.replace("\"reqwest\",", "\"reqwest 0.13.5\",");
    assert_eq!(packages(&explicit)[0].dependencies, ["reqwest 0.13.5"]);
    assert!(reqwest_lock_parent_matches(&packages(&explicit)));
}
#[test]
fn reqwest_lock_parent_refuses_changed_generation_source_parent_and_repeated_edges() {
    let reqwest_row =
        format!("name = \"reqwest\"\nversion = \"0.13.5\"\nsource = \"{LOCK_REGISTRY}\"");
    for invalid in [
        REQWEST_LOCK_FIXTURE.replace("version = \"0.13.5\"", "version = \"0.13.4\""),
        REQWEST_LOCK_FIXTURE.replace("version = \"2.12.4\"", "version = \"2.12.3\""),
        REQWEST_LOCK_FIXTURE.replace("name = \"tauri\"", "name = \"other-parent\""),
        REQWEST_LOCK_FIXTURE.replacen(LOCK_REGISTRY, "git+https://example.invalid/tauri", 1),
        REQWEST_LOCK_FIXTURE.replace(
            &reqwest_row,
            &reqwest_row.replace(LOCK_REGISTRY, "git+https://example.invalid/reqwest"),
        ),
        REQWEST_LOCK_FIXTURE.replace(" \"reqwest\",", " \"reqwest\",\n \"reqwest 0.13.5\","),
        format!(
            "{REQWEST_LOCK_FIXTURE}\n[[package]]\nname = \"other-parent\"\nversion = \"1.0.0\"\ndependencies = [\n \"reqwest\",\n]\n"
        ),
        format!("{REQWEST_LOCK_FIXTURE}\n[[package]]\n{reqwest_row}\n"),
        REQWEST_LOCK_FIXTURE.replace(" \"reqwest\",\n", ""),
    ] {
        assert!(!reqwest_lock_parent_matches(&packages(&invalid)));
    }
}
#[test]
fn reqwest_lock_parent_refuses_unknown_ambiguous_and_qualified_dependency_references() {
    let helper_rows = "\n[[package]]\nname = \"helper\"\nversion = \"1.0.0\"\n\n[[package]]\nname = \"helper\"\nversion = \"2.0.0\"\n";
    let ambiguous = format!(
        "{}{helper_rows}",
        REQWEST_LOCK_FIXTURE.replace(" \"reqwest\",", " \"reqwest\",\n \"helper\",")
    );
    assert!(!reqwest_lock_parent_matches(&packages(&ambiguous)));
    assert!(reqwest_lock_parent_matches(&packages(
        &ambiguous.replace("\"helper\",", "\"helper 1.0.0\",")
    )));
    for reference in [
        "unknown",
        "reqwest 0.13.4",
        "reqwest 0.13.5 (registry+https://github.com/rust-lang/crates.io-index)",
        "reqwest 0.13.5 extra",
    ] {
        let invalid = REQWEST_LOCK_FIXTURE.replace("\"reqwest\",", &format!("\"{reference}\","));
        assert!(!reqwest_lock_parent_matches(&packages(&invalid)));
    }
    let hidden = format!(
        "{REQWEST_LOCK_FIXTURE}\n[[package]]\nname = \"other-parent\"\nversion = \"1.0.0\"\n\"dependencies\" = [\n \"reqwest\",\n]\n"
    );
    assert!(!reqwest_lock_parent_matches(&packages(&hidden)));
    for invalid in [
        REQWEST_LOCK_FIXTURE.replace("dependencies = [", "\"dependencies\" = ["),
        REQWEST_LOCK_FIXTURE.replace("dependencies = [", "unexpected = ["),
    ] {
        assert!(!reqwest_lock_parent_matches(&packages(&invalid)));
    }
}
