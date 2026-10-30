use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

use draftyak_protocol::jcs;
use jiff::{SignedDuration, Timestamp};
use serde::Deserialize;
use serde_json::{Value, json};

const MANIFEST: &str = include_str!("../Cargo.toml");
const PROTOCOL_MANIFEST: &str = include_str!("../../draftyak-protocol/Cargo.toml");
const WORKSPACE: &str = include_str!("../../Cargo.toml");
const LOCK: &str = include_str!("../../Cargo.lock");
const POLICY: &str = include_str!("../../deny.toml");
const SCOPE: &str = include_str!("fixtures/native-store-scope.json");
const LIB: &str = include_str!("../src/lib.rs");
const STORE: &str = include_str!("../src/key_store/mod.rs");
const CLIPPY: &str = include_str!("../clippy.toml");
const CLIPPY_POLICY: &str = r#"disallowed-types = [
    { path = "keyring_core::mock::Store", reason = "Native identity storage must not use the upstream in-memory mock store." },
    { path = "keyring_core::mock::Cred", reason = "Native identity storage must not use the upstream in-memory mock store." },
    { path = "keyring_core::mock::CredData", reason = "Native identity storage must not use the upstream in-memory mock store." },
]
disallowed-methods = [
    { path = "keyring_core::mock::Store::new", reason = "Native identity storage must not use the upstream in-memory mock store." },
    { path = "keyring_core::Entry::new", reason = "Entries come only from the platform store, never from the process-wide default store." },
    { path = "keyring_core::Entry::new_with_modifiers", reason = "Entries come only from the platform store, never from the process-wide default store." },
    { path = "keyring_core::Entry::search", reason = "Entries come only from the platform store, never from the process-wide default store." },
    { path = "keyring_core::set_default_store", reason = "Entries come only from the platform store, never from the process-wide default store." },
    { path = "keyring_core::get_default_store", reason = "Entries come only from the platform store, never from the process-wide default store." },
    { path = "keyring_core::unset_default_store", reason = "Entries come only from the platform store, never from the process-wide default store." },
]"#;
const P256: &str =
    "p256 = { version = \"=0.14.0\", default-features = false, features = [\"ecdsa\", \"pkcs8\"] }";
const P256_IMPORT: &str = "use p256::{ecdsa::SigningKey, pkcs8::DecodePrivateKey};";
const UNIX_TARGET: &str = "[target.'cfg(all(unix, not(any(target_os = \"macos\", target_os = \"ios\", target_os = \"android\"))))'.dependencies]";
const UNIX_STORE: &str = "zbus-secret-service-keyring-store = { version = \"=1.0.1\", optional = true, features = [\"crypto-rust\"] }";
const NATIVE_STORE_FEATURE: &str = "native-store = [\"dep:keyring-core\", \"dep:windows-native-keyring-store\", \"dep:apple-native-keyring-store\", \"dep:zbus-secret-service-keyring-store\"]";
const FEATURES: [&str; 3] = ["default = []", NATIVE_STORE_FEATURE, "mock-store = []"];
const MACOS_TARGET: &str = "[target.'cfg(target_os = \"macos\")'.dependencies]";
const STORE_ROWS: [(&str, &str); 4] = [
    (
        "[dependencies]",
        "keyring-core = { version = \"=1.0.1\", optional = true }",
    ),
    (
        "[target.'cfg(target_os = \"windows\")'.dependencies]",
        "windows-native-keyring-store = { version = \"=1.1.0\", optional = true }",
    ),
    (
        MACOS_TARGET,
        "apple-native-keyring-store = { version = \"=1.0.2\", optional = true, features = [\"keychain\"] }",
    ),
    (UNIX_TARGET, UNIX_STORE),
];
const MEMBERS: &str = "members = [\"draftyak-protocol\", \"draftyak-transport\"]";
const SOURCE_FILES: [&str; 10] = [
    "key_store/linux_environment.rs",
    "key_store/mod.rs",
    "key_store/platform.rs",
    "key_store/platform_controls.rs",
    "key_store/testing.rs",
    "lib.rs",
    "payload.rs",
    "sidecar.rs",
    "tls.rs",
    "websocket.rs",
];
const LINT_ESCAPES: [&str; 3] = ["clippy::all", "clippy::style", "warnings"];
const DEFAULT_STORE_CALLS: [&str; 5] = [
    "Entry::new",
    "Entry::new_with_modifiers",
    "Entry::search",
    "set_default_store",
    "get_default_store",
];
const SIGNING_CALLS: [&str; 9] = [
    "Signer",
    "hazmat",
    "sign_prehash",
    "sign_digest",
    "recoverable",
    "try_sign",
    "sign_with_rng",
    "multipart_sign",
    "as_nonzero_scalar",
];
const REGISTRY: &str = "registry+https://github.com/rust-lang/crates.io-index";
// The approved allowance: these rows at most, ending no later than TERM_END, with no renewal.
const APPROVED_ADVISORIES: [(&str, &str); 3] = [
    ("RUSTSEC-2026-0370", "zvariant 5.15.1"),
    ("RUSTSEC-2026-0371", "zbus_names 4.3.5"),
    ("RUSTSEC-2026-0372", "zvariant_derive 5.15.1"),
];
const APPROVED_SKIP: (&str, &str) = ("syn", "2.0.119");
const TERM_END: &str = "2026-11-19T13:15:04Z";
const REVIEW_INTERVAL: SignedDuration = SignedDuration::from_hours(7 * 24);
const SOURCES: [&str; 4] = [
    "unknown-registry = \"deny\"",
    "unknown-git = \"deny\"",
    "allow-registry = [\"https://github.com/rust-lang/crates.io-index\"]",
    "allow-git = []",
];

const UNLISTED_SOURCE: &str =
    "the source files changed; check a new file against these rules, then list it";
const LINT_ESCAPE: &str = "a source turns off a clippy group, the clippy bans or all warnings";
const UPSTREAM_MOCK: &str = "a source names or glob-imports the upstream keyring_core mock module";
const DEFAULT_STORE: &str = "a source uses the process-wide default credential store";
const P256_USE: &str =
    "p256 is imported once, in key_store/mod.rs, as SigningKey and DecodePrivateKey";
const SIGNING_CALL: &str = "a source signs directly instead of through the protocol crate";
const OUTSIDE_SRC: &str = "a module path or include leaves src/";

const UNREADABLE: &str = "the scope fixture is unreadable or has a missing or unknown field";
const UNRESOLVED: &str = "Cargo.lock is unreadable or has an unresolvable dependency";
const BAD_TIME: &str = "expiresAt and reviewedAt must be UTC timestamps in seconds";
const PAST_TERM: &str = "expiresAt is later than the approved term";
const EXPIRED: &str = "the allowance has expired";
const FUTURE_REVIEW: &str = "reviewedAt is in the future";
const STALE_REVIEW: &str = "the weekly review is stale";
const NO_REVIEWER: &str = "reviewer is missing";
const HEADER: &str = "unknown scope version or source";
const UNAPPROVED: &str = "only the approved advisory rows and syn skip may be recorded";
const MEMBERS_CHANGED: &str = "the workspace members changed";
const LEFT_LOCK: &str = "an advisory crate left the lock but its row remains";
const VERSION_OR_SOURCE: &str = "an advisory crate's version or source changed";
const ROUTE_ORDER: &str = "recorded routes and parents must be sorted, unique and non-empty";
const ROUTES: &str = "a route to an advisory crate changed";
const SYN_VERSIONS: &str = "the duplicate's locked versions changed";
const SYN_PARENTS: &str = "a dependent of a duplicate version changed";
const GRAPH: &str = "deny.toml must audit all features on every target";
const ADVISORY_POLICY: &str =
    "deny.toml advisories must stay strict with exactly the recorded reasoned ignores";
const SKIP: &str = "deny.toml must skip exactly the recorded duplicate version";
const SOURCES_CHANGED: &str = "deny.toml sources changed";
const STORE_SCOPE: &str = "a store row or feature left its approved section";

fn manifest_lines(manifest: &str) -> Vec<(&str, &str)> {
    let mut section = "";
    manifest
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            if line.starts_with('[') {
                section = line;
            }
            (section, line)
        })
        .collect()
}
/// [features] holds exactly the approved lines, and every line naming a keyring crate is an
/// approved store row in its exact section or the native-store feature itself.
fn store_manifest_scope(manifest: &str) -> bool {
    let lines = manifest_lines(manifest);
    let features: Vec<_> = lines
        .iter()
        .filter(|(section, line)| *section == "[features]" && *line != "[features]")
        .map(|(_, line)| *line)
        .collect();
    let mut stores: Vec<_> = lines
        .into_iter()
        .filter(|(_, line)| line.contains("keyring"))
        .collect();
    stores.sort_unstable();
    let mut approved = STORE_ROWS.to_vec();
    approved.push(("[features]", NATIVE_STORE_FEATURE));
    approved.sort_unstable();
    features == FEATURES && stores == approved
}
fn signing_pin(manifest: &str) -> bool {
    manifest
        .lines()
        .filter(|line| line.trim().starts_with("p256 ="))
        .collect::<Vec<_>>()
        == [P256]
}
fn configures_lints(manifest: &str) -> bool {
    manifest
        .lines()
        .map(str::trim_start)
        .any(|line| line.starts_with("[lints") || line.starts_with("lints"))
}
fn enables_mock_store_outside_dev_dependencies(manifest: &str) -> bool {
    let mut section = "";
    manifest.lines().map(str::trim).any(|line| {
        if line.starts_with('[') {
            section = line;
            return false;
        }
        line.contains("mock-store")
            && !section.ends_with("dev-dependencies]")
            && !(section == "[features]" && line == "mock-store = []")
    })
}

fn source_files() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, files: &mut Vec<(String, String)>) {
        for entry in fs::read_dir(dir).expect("src/ is readable") {
            let path = entry.expect("src/ is readable").path();
            if path.is_dir() {
                walk(&path, root, files);
            } else {
                let name = path.strip_prefix(root).unwrap().to_string_lossy();
                let text = fs::read_to_string(&path).expect("every source is UTF-8 text");
                files.push((name.replace('\\', "/"), text));
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    walk(&root, &root, &mut files);
    files.sort();
    files
}
fn compact(source: &str) -> String {
    source.split_whitespace().collect()
}
fn mentions(text: &str, token: &str) -> bool {
    text.match_indices(token).any(|(start, _)| {
        !text
            .as_bytes()
            .get(start + token.len())
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
    })
}
fn names_upstream_mock(source: &str) -> bool {
    let text = compact(source);
    let bytes = text.as_bytes();
    text.contains("keyring_core::*")
        || text.match_indices("keyring_core::{").any(|(start, _)| {
            text[start..]
                .split(';')
                .next()
                .is_some_and(|group| group.contains('*'))
        })
        || text.match_indices("mock").any(|(start, _)| {
            matches!(
                start.checked_sub(1).map(|before| bytes[before]),
                Some(b':' | b',' | b'{')
            ) || matches!(
                bytes.get(start + "mock".len()),
                Some(b':' | b',' | b'}' | b';' | b')' | b']')
            )
        })
}
fn leaves_src(text: &str) -> bool {
    text.contains("include!(")
        || ["[path=", ",path="].iter().any(|attribute| {
            text.match_indices(attribute).any(|(start, _)| {
                !text[start + attribute.len()..]
                    .strip_prefix('"')
                    .and_then(|rest| rest.split_once('"'))
                    .is_some_and(|(file, _)| !file.contains("..") && !file.contains(['/', '\\']))
            })
        })
}

/// Every problem is fixed text; an empty list means every source keeps the store and signing rules.
fn source_problems(files: &[(String, String)]) -> Vec<&'static str> {
    let mut problems = Vec::new();
    let mut require = |ok: bool, problem: &'static str| {
        if !ok && !problems.contains(&problem) {
            problems.push(problem);
        }
    };
    require(
        files.iter().map(|(name, _)| name.as_str()).eq(SOURCE_FILES),
        UNLISTED_SOURCE,
    );
    let mut imports = 0;
    for (name, source) in files {
        let text = compact(source);
        require(
            !text.contains("clippy::disallowed")
                && !LINT_ESCAPES.iter().any(|token| mentions(&text, token)),
            LINT_ESCAPE,
        );
        require(!names_upstream_mock(source), UPSTREAM_MOCK);
        require(
            !DEFAULT_STORE_CALLS.iter().any(|call| mentions(&text, call)),
            DEFAULT_STORE,
        );
        for line in source.lines().filter(|line| line.contains("p256")) {
            imports += 1;
            require(name == "key_store/mod.rs" && line == P256_IMPORT, P256_USE);
        }
        require(
            !SIGNING_CALLS.iter().any(|call| text.contains(call)),
            SIGNING_CALL,
        );
        require(!leaves_src(&text), OUTSIDE_SRC);
    }
    require(imports == 1, P256_USE);
    problems
}

#[test]
fn clippy_bans_the_upstream_mock_and_default_store_and_no_source_turns_the_bans_off() {
    assert_eq!(CLIPPY.trim(), CLIPPY_POLICY, "the clippy bans changed");
    for invalid in [
        CLIPPY.replace("keyring_core::mock::Store\"", "keyring_core::Entry\""),
        CLIPPY.replace("disallowed-types", "allowed-types"),
        CLIPPY.replacen("    { path = \"keyring_core::Entry::new\",", "    #", 1),
        format!("{CLIPPY}\nallow-invalid = true\n"),
    ] {
        assert_ne!(invalid.trim(), CLIPPY_POLICY);
    }
    assert!(
        !configures_lints(MANIFEST),
        "the transport manifest must not set lint levels"
    );
    for invalid in [
        format!("{MANIFEST}\n[lints.clippy]\ndisallowed_types = \"allow\"\n"),
        format!("{MANIFEST}\n[lints]\nworkspace = true\n"),
        format!("lints.clippy.style = \"allow\"\n{MANIFEST}"),
    ] {
        assert!(configures_lints(&invalid));
    }
    assert!(
        !Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".clippy.toml")
            .exists(),
        "a second clippy configuration would replace the bans"
    );
    let problems = source_problems(&source_files());
    assert!(problems.is_empty(), "transport sources: {problems:?}");
}
#[test]
fn source_rules_refuse_mock_paths_lint_escapes_default_stores_and_new_signing() {
    let files = source_files();
    assert!(source_problems(&files).is_empty());
    let edit = |name: &str, old: &str, new: &str| {
        let mut edited = files.clone();
        let (_, source) = edited
            .iter_mut()
            .find(|(file, _)| file == name)
            .expect("listed source");
        assert!(
            source.contains(old),
            "{name} no longer holds the edited text"
        );
        *source = source.replacen(old, new, 1);
        source_problems(&edited)
    };
    let mut added = files.clone();
    added.push((
        "key_store/volatile.rs".to_owned(),
        "pub(super) fn volatile() -> keyring_core::Entry {\n    keyring_core::Entry::new_with_credential(std::sync::Arc::new(keyring_core::mock::Cred {\n        specifiers: (String::new(), String::new()),\n        inner: Default::default(),\n    }))\n}\n".to_owned(),
    ));
    added.sort();
    assert_eq!(source_problems(&added), [UNLISTED_SOURCE, UPSTREAM_MOCK]);
    let mut partial = files.clone();
    partial.retain(|(name, _)| !name.starts_with("key_store/"));
    assert!(source_problems(&partial).contains(&UNLISTED_SOURCE));
    let grouped = "use keyring_core::{CredentialStore, Entry};";
    let platform = "key_store/platform.rs";
    for (name, old, new, problems) in [
        (
            platform,
            grouped,
            "use keyring_core::{CredentialStore, Entry, mock};",
            &[UPSTREAM_MOCK][..],
        ),
        (
            platform,
            grouped,
            "use keyring_core::{CredentialStore, Entry, mock as fallback};",
            &[UPSTREAM_MOCK],
        ),
        (
            platform,
            grouped,
            "use keyring_core::{CredentialStore, Entry,\n    mock\n    as  fallback};",
            &[UPSTREAM_MOCK],
        ),
        (
            platform,
            grouped,
            "use keyring_core::{\n    CredentialStore, Entry,\n    mock::{Cred, CredData},\n};",
            &[UPSTREAM_MOCK],
        ),
        (platform, grouped, "use keyring_core::*;", &[UPSTREAM_MOCK]),
        (
            platform,
            grouped,
            "use keyring_core::{CredentialStore, Entry, *};",
            &[UPSTREAM_MOCK],
        ),
        ("tls.rs", "", "#![allow(clippy::style)]\n", &[LINT_ESCAPE]),
        (
            "websocket.rs",
            "",
            "#![allow(clippy::all)]\n",
            &[LINT_ESCAPE],
        ),
        (
            "payload.rs",
            "",
            "#![expect(clippy::disallowed_types)]\n",
            &[LINT_ESCAPE],
        ),
        (
            "sidecar.rs",
            "",
            "#![cfg_attr(test, allow(clippy :: disallowed_methods))]\n",
            &[LINT_ESCAPE],
        ),
        (
            "key_store/linux_environment.rs",
            "",
            "#![allow(\n    clippy::style\n)]\n",
            &[LINT_ESCAPE],
        ),
        (
            "key_store/testing.rs",
            "",
            "#![allow(unused, warnings)]\n",
            &[LINT_ESCAPE],
        ),
        (
            "key_store/testing.rs",
            "",
            "#![allow(renamed_and_removed_lints, clippy::disallowed_type)]\n",
            &[LINT_ESCAPE],
        ),
        (
            platform,
            "",
            "fn fallback() -> keyring_core::Result<Entry> {\n    Entry::new(\"s\", \"u\")\n}\n",
            &[DEFAULT_STORE],
        ),
        (
            "lib.rs",
            "",
            "fn fallback() {\n    let _ = keyring_core::get_default_store();\n}\n",
            &[DEFAULT_STORE],
        ),
        (
            "key_store/platform_controls.rs",
            "",
            "fn fallback() {\n    keyring_core::unset_default_store();\n}\n",
            &[DEFAULT_STORE],
        ),
        (
            "key_store/mod.rs",
            P256_IMPORT,
            "use p256::{\n    ecdsa::{SigningKey, signature::Signer},\n    pkcs8::DecodePrivateKey,\n};",
            &[P256_USE, SIGNING_CALL],
        ),
        ("tls.rs", "", "use p256::ecdsa::SigningKey;\n", &[P256_USE]),
        (
            "key_store/mod.rs",
            "        &self.signing\n",
            "        let _ = self.signing.sign_recoverable(b\"DYTEST\");\n        &self.signing\n",
            &[SIGNING_CALL],
        ),
        (
            platform,
            "#[path = \"platform_controls.rs\"]",
            "#[path = \"../../tests/support/controls.rs\"]",
            &[OUTSIDE_SRC],
        ),
        (
            "lib.rs",
            "",
            "include!(\"../tests/support/extra.rs\");\n",
            &[OUTSIDE_SRC],
        ),
    ] {
        assert_eq!(edit(name, old, new), problems, "{new}");
    }
}
#[test]
fn signing_storage_reuses_the_exact_protocol_p256_generation_and_features() {
    assert!(signing_pin(MANIFEST));
    for invalid in [
        MANIFEST.replace("=0.14.0", "0.14.0"),
        MANIFEST.replace("=0.14.0", "=0.14.1"),
        MANIFEST.replace(
            P256,
            &P256.replace("default-features = false", "default-features = true"),
        ),
        MANIFEST.replace(P256, &P256.replace("\"pkcs8\"", "\"pem\"")),
    ] {
        assert!(!signing_pin(&invalid));
    }
}
#[test]
fn stores_have_only_the_approved_exact_target_rows_and_features() {
    assert!(store_manifest_scope(MANIFEST));
    let (_, keyring) = STORE_ROWS[0];
    let (_, windows) = STORE_ROWS[1];
    let (_, apple) = STORE_ROWS[2];
    for invalid in [
        MANIFEST.replace(
            MACOS_TARGET,
            "[target.'cfg(any(target_os = \"macos\", target_os = \"ios\"))'.dependencies]",
        ),
        MANIFEST.replace(
            "mock-store = []",
            "mock-store = []\nextra = [\"zbus-secret-service-keyring-store/rt-tokio-crypto-rust\"]",
        ),
        MANIFEST.replace("mock-store = []", "mock-store = []\nquiet = []"),
        MANIFEST.replace("default = []", "default = [\"native-store\"]"),
        MANIFEST.replace(
            NATIVE_STORE_FEATURE,
            &NATIVE_STORE_FEATURE.replace(
                "\"dep:keyring-core\"",
                "\"dep:keyring-core\", \"dep:android-native-keyring-store\"",
            ),
        ),
        MANIFEST
            .replace(&format!("{keyring}\n"), "")
            .replace(windows, &format!("{windows}\n{keyring}")),
        MANIFEST.replace(
            "[dev-dependencies]\n",
            &format!("[dev-dependencies]\n{keyring}\n"),
        ),
        MANIFEST.replace(
            apple,
            &apple.replace("\"keychain\"", "\"keychain\", \"protected\""),
        ),
        format!(
            "{MANIFEST}\n[target.'cfg(target_os = \"android\")'.dependencies]\nandroid-native-keyring-store = {{ version = \"=1.0.0\", optional = true }}\n"
        ),
        format!(
            "{MANIFEST}\n[target.'cfg(target_os = \"ios\")'.dependencies]\napple-native-keyring-store = {{ version = \"=1.0.2\", optional = true, features = [\"protected\"] }}\n"
        ),
        format!(
            "{MANIFEST}\n[target.'cfg(target_os = \"linux\")'.dependencies]\ndbus-secret-service-keyring-store = {{ version = \"=1.0.0\", optional = true }}\n"
        ),
        MANIFEST.replace(
            UNIX_TARGET,
            "[target.'cfg(target_os = \"linux\")'.dependencies]",
        ),
        MANIFEST.replace(
            UNIX_STORE,
            &UNIX_STORE.replace(", features = [\"crypto-rust\"]", ""),
        ),
        MANIFEST.replace(
            UNIX_STORE,
            &UNIX_STORE.replace("crypto-rust", "crypto-openssl"),
        ),
        format!("{MANIFEST}\n{UNIX_TARGET}\n{UNIX_STORE}\n"),
    ] {
        assert_ne!(invalid, MANIFEST);
        assert!(
            !store_manifest_scope(&invalid),
            "store manifest scope widened"
        );
    }
}
#[test]
fn the_explicit_mock_module_is_gated_and_never_a_product_store_fallback() {
    assert!(LIB.contains("pub mod key_store;"));
    assert!(STORE.contains("#[cfg(any(test, feature = \"mock-store\"))]\npub mod testing;"));
    assert!(!STORE.contains("testing::TestStore"));
}
#[test]
fn no_workspace_member_enables_the_mock_store_outside_dev_dependencies() {
    assert_eq!(
        WORKSPACE
            .lines()
            .filter(|line| line.trim_start().starts_with("members"))
            .collect::<Vec<_>>(),
        [MEMBERS],
        "a new member must be added to this check"
    );
    for manifest in [MANIFEST, PROTOCOL_MANIFEST] {
        assert!(!enables_mock_store_outside_dev_dependencies(manifest));
    }
    let consumer =
        "draftyak-transport = { path = \"../draftyak-transport\", features = [\"mock-store\"] }";
    for invalid in [
        MANIFEST.replace("default = []", "default = [\"mock-store\"]"),
        MANIFEST.replace(
            NATIVE_STORE_FEATURE,
            &NATIVE_STORE_FEATURE.replace("\"]", "\", \"mock-store\"]"),
        ),
        PROTOCOL_MANIFEST.replace(
            "[dev-dependencies]",
            &format!("{consumer}\n\n[dev-dependencies]"),
        ),
        format!("{PROTOCOL_MANIFEST}\n[target.'cfg(unix)'.dependencies]\n{consumer}\n"),
        format!(
            "{PROTOCOL_MANIFEST}\n[features]\ntest-store = [\"draftyak-transport/mock-store\"]\n"
        ),
    ] {
        assert!(enables_mock_store_outside_dev_dependencies(&invalid));
    }
    assert!(!enables_mock_store_outside_dev_dependencies(&format!(
        "{PROTOCOL_MANIFEST}\n[target.'cfg(unix)'.dev-dependencies]\n{consumer}\n"
    )));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    version: u8,
    source: String,
    expires_at: String,
    reviewed_at: String,
    reviewer: String,
    advisories: Vec<Advisory>,
    duplicate: Duplicate,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Advisory {
    id: String,
    #[serde(rename = "crate")]
    package: String,
    routes: Vec<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Duplicate {
    #[serde(rename = "crate")]
    package: String,
    skip: String,
    parents: BTreeMap<String, Parents>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Parents {
    active: Vec<String>,
    lock_only: Vec<String>,
}
struct Package<'a> {
    name: &'a str,
    version: &'a str,
    source: Option<&'a str>,
    dependencies: Vec<&'a str>,
}
type Node<'a> = (&'a str, &'a str);
type Graph<'a> = BTreeMap<Node<'a>, Vec<Node<'a>>>;

fn lock_packages(lock: &str) -> Option<Vec<Package<'_>>> {
    lock.split("[[package]]\n")
        .skip(1)
        .map(|block| {
            let field = |key: &str| {
                block.lines().find_map(|line| {
                    line.strip_prefix(key)?
                        .strip_prefix(" = \"")?
                        .strip_suffix('"')
                })
            };
            let dependencies = match block.split_once("dependencies = [\n") {
                None => Vec::new(),
                Some((_, rest)) => rest
                    .split_once("\n]")?
                    .0
                    .lines()
                    .map(|line| line.strip_prefix(" \"")?.strip_suffix("\","))
                    .collect::<Option<_>>()?,
            };
            Some(Package {
                name: field("name")?,
                version: field("version")?,
                source: field("source"),
                dependencies,
            })
        })
        .collect()
}
fn lock_graph<'a>(packages: &[Package<'a>]) -> Option<Graph<'a>> {
    let mut graph = Graph::new();
    for package in packages {
        let mut edges = Vec::new();
        for dependency in &package.dependencies {
            let mut parts = dependency.split(' ');
            let (name, version) = (parts.next()?, parts.next());
            let mut found = packages
                .iter()
                .filter(|p| p.name == name && version.is_none_or(|v| p.version == v));
            let target = found.next()?;
            if parts.next().is_some() || found.next().is_some() {
                return None;
            }
            edges.push((target.name, target.version));
        }
        if graph
            .insert((package.name, package.version), edges)
            .is_some()
        {
            return None;
        }
    }
    Some(graph)
}
fn label((name, version): Node<'_>) -> String {
    format!("{name} {version}")
}
fn routes<'a>(graph: &Graph<'a>, roots: &[Node<'a>], target: Node<'a>) -> Vec<String> {
    let mut reaching = BTreeSet::from([target]);
    loop {
        let more: Vec<_> = graph
            .iter()
            .filter(|(node, edges)| {
                !reaching.contains(*node) && edges.iter().any(|edge| reaching.contains(edge))
            })
            .map(|(node, _)| *node)
            .collect();
        if more.is_empty() {
            break;
        }
        reaching.extend(more);
    }
    fn walk<'a>(
        graph: &Graph<'a>,
        reaching: &BTreeSet<Node<'a>>,
        target: Node<'a>,
        trail: &mut Vec<Node<'a>>,
        found: &mut BTreeSet<String>,
    ) {
        let node = trail[trail.len() - 1];
        if node == target {
            found.insert(
                trail
                    .iter()
                    .map(|node| label(*node))
                    .collect::<Vec<_>>()
                    .join(" > "),
            );
            return;
        }
        for next in &graph[&node] {
            if reaching.contains(next) && !trail.contains(next) {
                trail.push(*next);
                walk(graph, reaching, target, trail, found);
                trail.pop();
            }
        }
    }
    let mut found = BTreeSet::new();
    for root in roots.iter().filter(|root| reaching.contains(*root)) {
        walk(graph, &reaching, target, &mut vec![*root], &mut found);
    }
    found.into_iter().collect()
}
fn sorted_unique(values: &[String]) -> bool {
    !values.is_empty() && values.windows(2).all(|pair| pair[0] < pair[1])
}
fn section<'a>(policy: &'a str, header: &str) -> Option<Vec<&'a str>> {
    let lines: Vec<_> = policy.lines().map(str::trim).collect();
    let mut starts = (0..lines.len()).filter(|index| lines[*index] == header);
    let start = starts.next()?;
    if starts.next().is_some() {
        return None;
    }
    Some(
        lines[start + 1..]
            .iter()
            .copied()
            .take_while(|line| !line.starts_with('['))
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .collect(),
    )
}
fn bans_array<'a>(policy: &'a str, key: &str) -> Option<Vec<&'a str>> {
    let lines = section(policy, "[bans]")?;
    let open = format!("{key} = [");
    let mut starts = (0..lines.len()).filter(|index| lines[*index] == open);
    let start = starts.next()?;
    if starts.next().is_some() {
        return None;
    }
    let rows = &lines[start + 1..];
    Some(rows[..rows.iter().position(|line| *line == "]")?].to_vec())
}
fn skip_row(row: &str) -> Option<(&str, &str)> {
    let (name, rest) = row
        .strip_prefix("{ name = \"")?
        .split_once("\", version = \"=")?;
    let (version, reason) = rest.split_once("\", reason = \"")?;
    let reason = reason.strip_suffix("\" },")?;
    (reason.len() > 20
        && ![name, version, reason]
            .iter()
            .any(|part| part.contains('"')))
    .then_some((name, version))
}
fn advisory_policy(policy: &str, ids: &[&str]) -> bool {
    let Some(lines) = section(policy, "[advisories]") else {
        return false;
    };
    let Some((head, rows)) = lines.split_first_chunk::<4>() else {
        return false;
    };
    *head
        == [
            "unmaintained = \"all\"",
            "unsound = \"all\"",
            "yanked = \"deny\"",
            "ignore = [",
        ]
        && rows.len() == ids.len() + 1
        && rows.last() == Some(&"]")
        && ids.iter().zip(rows).all(|(id, row)| {
            row.strip_prefix(&format!("{{ id = \"{id}\", reason = \""))
                .and_then(|rest| rest.strip_suffix("\" },"))
                .is_some_and(|reason| reason.len() > 20 && !reason.contains('"'))
        })
}
fn timestamp(text: &str) -> Option<Timestamp> {
    (text.len() == 20 && text.ends_with('Z'))
        .then(|| text.parse().ok())
        .flatten()
}

/// Binds the advisory and duplicate allowance to the locked graph it was reviewed against.
/// Every problem is fixed text; an empty list means the recorded scope is current.
fn scope_problems(
    lock: &str,
    policy: &str,
    manifest: &str,
    scope: &str,
    now: Timestamp,
) -> Vec<&'static str> {
    let Some(scope) = jcs::parse_strict(scope.as_bytes())
        .ok()
        .and_then(|value| serde_json::from_value::<Scope>(value).ok())
    else {
        return vec![UNREADABLE];
    };
    let Some(packages) = lock_packages(lock) else {
        return vec![UNRESOLVED];
    };
    let Some(graph) = lock_graph(&packages) else {
        return vec![UNRESOLVED];
    };
    let mut problems = Vec::new();
    let mut require = |ok: bool, problem: &'static str| {
        if !ok && !problems.contains(&problem) {
            problems.push(problem);
        }
    };
    require(scope.version == 1 && scope.source == REGISTRY, HEADER);
    match (
        timestamp(&scope.expires_at),
        timestamp(&scope.reviewed_at),
        timestamp(TERM_END),
    ) {
        (Some(expires), Some(reviewed), Some(term)) => {
            require(expires <= term, PAST_TERM);
            require(now < expires, EXPIRED);
            require(reviewed <= now, FUTURE_REVIEW);
            require(
                reviewed
                    .checked_add(REVIEW_INTERVAL)
                    .is_ok_and(|due| now <= due),
                STALE_REVIEW,
            );
        }
        _ => require(false, BAD_TIME),
    }
    let reviewer = scope.reviewer.trim();
    require(
        !reviewer.is_empty() && reviewer.len() <= 80 && reviewer.is_ascii(),
        NO_REVIEWER,
    );
    let recorded: Vec<_> = scope
        .advisories
        .iter()
        .map(|advisory| (advisory.id.as_str(), advisory.package.as_str()))
        .collect();
    let mut approved = APPROVED_ADVISORIES.iter();
    require(
        recorded
            .iter()
            .all(|row| approved.any(|allowed| allowed == row))
            && (
                scope.duplicate.package.as_str(),
                scope.duplicate.skip.as_str(),
            ) == APPROVED_SKIP,
        UNAPPROVED,
    );
    let roots: Vec<Node> = packages
        .iter()
        .filter(|package| package.source.is_none())
        .map(|package| (package.name, package.version))
        .collect();
    require(
        roots
            .iter()
            .map(|(name, _)| *name)
            .eq(["draftyak-protocol", "draftyak-transport"]),
        MEMBERS_CHANGED,
    );
    for advisory in &scope.advisories {
        require(sorted_unique(&advisory.routes), ROUTE_ORDER);
        let Some((name, version)) = advisory.package.split_once(' ') else {
            require(false, VERSION_OR_SOURCE);
            continue;
        };
        let locked: Vec<_> = packages.iter().filter(|p| p.name == name).collect();
        let [package] = locked[..] else {
            require(
                false,
                if locked.is_empty() {
                    LEFT_LOCK
                } else {
                    VERSION_OR_SOURCE
                },
            );
            continue;
        };
        require(
            package.version == version && package.source == Some(scope.source.as_str()),
            VERSION_OR_SOURCE,
        );
        require(
            routes(&graph, &roots, (package.name, package.version)) == advisory.routes,
            ROUTES,
        );
    }
    let duplicate = &scope.duplicate;
    let versions: Vec<_> = packages
        .iter()
        .filter(|p| p.name == duplicate.package)
        .map(|p| p.version)
        .collect();
    require(
        duplicate
            .parents
            .keys()
            .map(String::as_str)
            .eq(versions.iter().copied())
            && duplicate.parents.contains_key(&duplicate.skip),
        SYN_VERSIONS,
    );
    for (version, parents) in &duplicate.parents {
        let active: BTreeSet<_> = parents.active.iter().map(String::as_str).collect();
        let lock_only: BTreeSet<_> = parents.lock_only.iter().map(String::as_str).collect();
        require(
            sorted_unique(&parents.active)
                && (parents.lock_only.is_empty() || sorted_unique(&parents.lock_only))
                && active.is_disjoint(&lock_only),
            ROUTE_ORDER,
        );
        let target = (duplicate.package.as_str(), version.as_str());
        let locked: BTreeSet<_> = graph
            .iter()
            .filter(|(_, edges)| edges.contains(&target))
            .map(|(node, _)| label(*node))
            .collect();
        require(
            locked
                .iter()
                .map(String::as_str)
                .eq(active.union(&lock_only).copied()),
            SYN_PARENTS,
        );
    }
    require(
        section(policy, "[graph]") == Some(vec!["all-features = true"]),
        GRAPH,
    );
    let ids: Vec<_> = recorded.iter().map(|(id, _)| *id).collect();
    require(advisory_policy(policy, &ids), ADVISORY_POLICY);
    let skips = bans_array(policy, "skip")
        .and_then(|rows| rows.into_iter().map(skip_row).collect::<Option<Vec<_>>>())
        .unwrap_or_default();
    require(
        skips
            .iter()
            .filter(|(name, _)| *name == duplicate.package)
            .map(|(_, version)| *version)
            .eq([duplicate.skip.as_str()]),
        SKIP,
    );
    require(
        section(policy, "[sources]") == Some(SOURCES.to_vec()),
        SOURCES_CHANGED,
    );
    require(store_manifest_scope(manifest), STORE_SCOPE);
    problems
}

const NOW: &str = "2026-11-10T00:00:00Z";
fn at(text: &str) -> Timestamp {
    text.parse().unwrap()
}
fn fixture(edit: impl FnOnce(&mut Value)) -> String {
    let mut value: Value = serde_json::from_str(SCOPE).unwrap();
    value["reviewedAt"] = json!(NOW);
    edit(&mut value);
    serde_json::to_string(&value).unwrap()
}
fn edit_package(lock: &str, name: &str, edit: impl Fn(&str) -> String) -> String {
    let start = format!("name = \"{name}\"\n");
    lock.split("[[package]]\n")
        .map(|block| {
            if block.starts_with(&start) {
                edit(block)
            } else {
                block.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("[[package]]\n")
}
fn without_package(lock: &str, name: &str) -> String {
    let start = format!("name = \"{name}\"\n");
    let edge = format!(" \"{name}\",");
    lock.split("[[package]]\n")
        .filter(|block| !block.starts_with(&start))
        .map(|block| {
            block
                .split_inclusive('\n')
                .filter(|line| line.trim_end() != edge)
                .collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("[[package]]\n")
}

#[test]
fn native_store_scope_matches_the_locked_graph_and_its_review_is_current() {
    let problems = scope_problems(LOCK, POLICY, MANIFEST, SCOPE, Timestamp::now());
    assert!(
        problems.is_empty(),
        "native-store advisory scope: {problems:?}"
    );
}
#[test]
fn native_store_scope_fails_closed_at_the_term_and_without_a_current_review() {
    let check = |scope: &str, now: &str| scope_problems(LOCK, POLICY, MANIFEST, scope, at(now));
    let scope = fixture(|_| {});
    assert!(check(&scope, NOW).is_empty());
    assert!(check(&scope, "2026-11-17T00:00:00Z").is_empty());
    assert_eq!(check(&scope, "2026-11-17T00:00:01Z"), [STALE_REVIEW]);
    assert_eq!(check(&scope, "2026-11-09T23:59:59Z"), [FUTURE_REVIEW]);
    let late = fixture(|scope| scope["reviewedAt"] = json!("2026-11-19T00:00:00Z"));
    assert!(check(&late, "2026-11-19T13:15:03Z").is_empty());
    assert_eq!(check(&late, TERM_END), [EXPIRED]);
    let extended = fixture(|scope| scope["expiresAt"] = json!("2026-11-19T13:15:05Z"));
    assert_eq!(check(&extended, NOW), [PAST_TERM]);
    for invalid in [
        "2026-11-10T00:00:00+00:00",
        "2026-11-10T00:00:00.5Z",
        "2026-11-10T00:00:00z",
        "2026-11-10",
    ] {
        let scope = fixture(|scope| scope["reviewedAt"] = json!(invalid));
        assert_eq!(check(&scope, NOW), [BAD_TIME]);
    }
    let unnamed = fixture(|scope| scope["reviewer"] = json!(" "));
    assert_eq!(check(&unnamed, NOW), [NO_REVIEWER]);
}
#[test]
fn native_store_scope_refuses_a_missing_unknown_or_repeated_fixture_field() {
    let check = |scope: &str| scope_problems(LOCK, POLICY, MANIFEST, scope, at(NOW));
    for field in [
        "version",
        "source",
        "expiresAt",
        "reviewedAt",
        "reviewer",
        "advisories",
        "duplicate",
    ] {
        let scope = fixture(|scope| {
            scope.as_object_mut().unwrap().remove(field);
        });
        assert_eq!(check(&scope), [UNREADABLE]);
    }
    for scope in [
        fixture(|scope| {
            scope["advisories"][0]
                .as_object_mut()
                .unwrap()
                .remove("routes");
        }),
        fixture(|scope| {
            scope["duplicate"]["parents"]["3.0.9"]
                .as_object_mut()
                .unwrap()
                .remove("lockOnly");
        }),
        fixture(|scope| scope["note"] = json!("DYTEST")),
        fixture(|_| {}).replacen("\"version\":1", "\"version\":1,\"version\":1", 1),
    ] {
        assert_eq!(check(&scope), [UNREADABLE]);
    }
    let foreign =
        fixture(|scope| scope["source"] = json!("registry+https://example.invalid/index"));
    assert!(check(&foreign).contains(&HEADER));
}
#[test]
fn native_store_scope_refuses_unapproved_or_changed_rows() {
    let check = |scope: &str| scope_problems(LOCK, POLICY, MANIFEST, scope, at(NOW));
    let route = "draftyak-protocol 0.0.0 > zbus 5.19.0 > zvariant 5.15.1";
    let added_route = fixture(|scope| {
        scope["advisories"][0]["routes"]
            .as_array_mut()
            .unwrap()
            .insert(0, json!(route));
    });
    assert_eq!(check(&added_route), [ROUTES]);
    let dropped_route = fixture(|scope| {
        scope["advisories"][1]["routes"]
            .as_array_mut()
            .unwrap()
            .pop();
    });
    assert_eq!(check(&dropped_route), [ROUTES]);
    let unsorted = fixture(|scope| {
        scope["advisories"][1]["routes"]
            .as_array_mut()
            .unwrap()
            .reverse();
    });
    assert!(check(&unsorted).contains(&ROUTE_ORDER));
    let added_row = fixture(|scope| {
        scope["advisories"].as_array_mut().unwrap().push(json!({
            "id": "RUSTSEC-2026-0001",
            "crate": "zbus 5.19.0",
            "routes": ["draftyak-transport 0.0.0 > zbus-secret-service-keyring-store 1.0.1 > zbus 5.19.0"],
        }));
    });
    assert!(check(&added_row).contains(&UNAPPROVED));
    let other_skip = fixture(|scope| scope["duplicate"]["skip"] = json!("3.0.9"));
    assert!(check(&other_skip).contains(&UNAPPROVED));
    let moved_parent = fixture(|scope| {
        let parents = &mut scope["duplicate"]["parents"]["2.0.119"];
        let parent = parents["lockOnly"].as_array_mut().unwrap().remove(0);
        parents["active"].as_array_mut().unwrap().insert(0, parent);
    });
    assert!(
        check(&moved_parent).is_empty(),
        "the active split is audit data"
    );
    let doubled = fixture(|scope| {
        let parents = &mut scope["duplicate"]["parents"]["2.0.119"];
        let parent = parents["active"][0].clone();
        parents["lockOnly"]
            .as_array_mut()
            .unwrap()
            .insert(0, parent);
    });
    assert!(check(&doubled).contains(&ROUTE_ORDER));
}
#[test]
fn native_store_scope_fails_when_the_affected_graph_changes() {
    let scope = fixture(|_| {});
    let check = |lock: &str| scope_problems(lock, POLICY, MANIFEST, &scope, at(NOW));
    let removed = without_package(LOCK, "zbus_names");
    assert!(check(&removed).contains(&LEFT_LOCK));
    let bumped = edit_package(LOCK, "zvariant", |block| {
        block.replacen("version = \"5.15.1\"", "version = \"5.15.2\"", 1)
    });
    assert!(check(&bumped).contains(&VERSION_OR_SOURCE));
    let moved = edit_package(LOCK, "zvariant", |block| {
        block.replacen(REGISTRY, "registry+https://example.invalid/index", 1)
    });
    assert_eq!(check(&moved), [VERSION_OR_SOURCE]);
    let duplicated = format!(
        "{}\n[[package]]\nname = \"zvariant\"\nversion = \"5.16.0\"\nsource = \"{REGISTRY}\"\n",
        LOCK.replace(" \"zvariant\",\n", " \"zvariant 5.15.1\",\n")
    );
    assert_eq!(check(&duplicated), [VERSION_OR_SOURCE]);
    let widened = edit_package(LOCK, "draftyak-protocol", |block| {
        block.replacen("dependencies = [\n", "dependencies = [\n \"zbus\",\n", 1)
    });
    assert_eq!(check(&widened), [ROUTES]);
    let narrowed = edit_package(LOCK, "secret-service", |block| {
        block.replacen(" \"zbus\",\n", "", 1)
    });
    assert_eq!(check(&narrowed), [ROUTES]);
    let reparented = edit_package(LOCK, "zbus_names", |block| {
        block.replacen(
            "dependencies = [\n",
            "dependencies = [\n \"syn 2.0.119\",\n",
            1,
        )
    });
    assert_eq!(check(&reparented), [SYN_PARENTS]);
    let third = format!(
        "{LOCK}\n[[package]]\nname = \"syn\"\nversion = \"1.0.109\"\nsource = \"{REGISTRY}\"\n"
    );
    assert!(check(&third).contains(&SYN_VERSIONS));
    let dangling = LOCK.replacen(" \"zvariant\",\n", " \"zvariant 9.9.9\",\n", 1);
    assert_eq!(check(&dangling), [UNRESOLVED]);
    for lock in [&removed, &bumped, &widened, &narrowed, &reparented] {
        assert_ne!(lock.as_str(), LOCK);
    }
}
#[test]
fn native_store_scope_fails_when_the_audit_policy_or_store_target_changes() {
    let scope = fixture(|_| {});
    let check =
        |policy: &str, manifest: &str| scope_problems(LOCK, policy, manifest, &scope, at(NOW));
    let last = "    { id = \"RUSTSEC-2026-0372\", reason = \"";
    let syn_skip = "    { name = \"syn\", version = \"=2.0.119\"";
    for (policy, problem) in [
        (
            POLICY.replacen(
                last,
                &format!(
                    "    {{ id = \"RUSTSEC-2026-0001\", reason = \"DYTEST unreviewed ignore row\" }},\n{last}"
                ),
                1,
            ),
            ADVISORY_POLICY,
        ),
        (
            POLICY.replacen(
                last,
                "    { id = \"RUSTSEC-2026-0372\", note = \"",
                1,
            ),
            ADVISORY_POLICY,
        ),
        (
            POLICY.replacen("unmaintained = \"all\"", "unmaintained = \"workspace\"", 1),
            ADVISORY_POLICY,
        ),
        (
            POLICY.replacen("unsound = \"all\"", "unsound = \"none\"", 1),
            ADVISORY_POLICY,
        ),
        (
            POLICY.replacen("yanked = \"deny\"", "yanked = \"warn\"", 1),
            ADVISORY_POLICY,
        ),
        (
            POLICY.replacen("[graph]\nall-features = true\n", "", 1),
            GRAPH,
        ),
        (
            POLICY.replacen(
                "all-features = true",
                "all-features = true\ntargets = [\"x86_64-pc-windows-msvc\"]",
                1,
            ),
            GRAPH,
        ),
        (
            POLICY.replacen(syn_skip, "    { name = \"syn\", version = \"=3.0.9\"", 1),
            SKIP,
        ),
        (
            POLICY.replacen(syn_skip, &format!("    \"syn\",\n{syn_skip}"), 1),
            SKIP,
        ),
        (
            POLICY.replacen(syn_skip, &format!("    \"zvariant@5.15.1\",\n{syn_skip}"), 1),
            SKIP,
        ),
        (
            POLICY.replacen(
                syn_skip,
                &format!(
                    "    {{ name = \"syn\", version = \"=3.0.9\", reason = \"DYTEST second syn skip row\" }},\n{syn_skip}"
                ),
                1,
            ),
            SKIP,
        ),
        (
            POLICY.replacen(
                "allow-git = []",
                "allow-git = [\"https://example.invalid/dytest\"]",
                1,
            ),
            SOURCES_CHANGED,
        ),
    ] {
        assert_ne!(policy, POLICY);
        assert_eq!(check(&policy, MANIFEST), [problem]);
    }
    for manifest in [
        MANIFEST.replacen(
            UNIX_TARGET,
            "[target.'cfg(target_os = \"linux\")'.dependencies]",
            1,
        ),
        MANIFEST.replacen("default = []", "default = [\"native-store\"]", 1),
        MANIFEST.replacen("\"crypto-rust\"", "\"rt-tokio-crypto-rust\"", 1),
        MANIFEST.replacen(
            MACOS_TARGET,
            "[target.'cfg(any(target_os = \"macos\", target_os = \"ios\"))'.dependencies]",
            1,
        ),
        MANIFEST.replacen(
            "mock-store = []",
            "mock-store = []\nextra = [\"zbus-secret-service-keyring-store/rt-tokio-crypto-rust\"]",
            1,
        ),
    ] {
        assert_ne!(manifest, MANIFEST);
        assert_eq!(check(POLICY, &manifest), [STORE_SCOPE]);
    }
}
