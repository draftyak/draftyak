use std::{fs, path::Path};

const SOURCE: &str = include_str!("../src/lib.rs");

// The std items the library may name, and paths under them.
const ALLOWED: [&str; 5] = [
    "std::error::Error",
    "std::fmt",
    "std::mem",
    "std::sync::atomic::AtomicU64",
    "std::sync::atomic::Ordering",
];

// Words the library never needs, in code or comments: the other standard roots, foreign or
// unsafe code, printing, build-time reads of files or the environment, and clocks.
const FORBIDDEN: [&str; 17] = [
    "alloc",
    "core",
    "extern",
    "unsafe",
    "print",
    "println",
    "eprint",
    "eprintln",
    "dbg",
    "include",
    "include_str",
    "include_bytes",
    "env",
    "option_env",
    "Instant",
    "SystemTime",
    "UNIX_EPOCH",
];

// Words, `::` and single characters; comments and literals are read as code.
fn tokens(source: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let word = |c: char| c == '_' || c.is_alphanumeric();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let start = at;
        if word(chars[at]) {
            while at < chars.len() && word(chars[at]) {
                at += 1;
            }
        } else if chars[at] == ':' && chars.get(at + 1) == Some(&':') {
            at += 2;
        } else {
            at += 1;
        }
        if !chars[start].is_whitespace() {
            tokens.push(chars[start..at].iter().collect());
        }
    }
    tokens
}

fn is_word(token: &str) -> bool {
    token
        .chars()
        .next()
        .is_some_and(|c| c == '_' || c.is_alphabetic())
}

// Reads the rest of a path after `prefix`, expanding each `{...}` group into whole paths.
fn path_rest(
    tokens: &[String],
    at: &mut usize,
    prefix: &str,
    paths: &mut Vec<String>,
) -> Result<(), String> {
    if tokens.get(*at).map(String::as_str) != Some("::") {
        paths.push(prefix.to_owned());
        return Ok(());
    }
    let next = tokens.get(*at + 1).cloned().unwrap_or_default();
    *at += 2;
    match next.as_str() {
        "{" => loop {
            let item = tokens.get(*at).cloned().unwrap_or_default();
            *at += 1;
            if item == "}" {
                return Ok(());
            }
            if !is_word(&item) {
                return Err(format!("`{item}` in a group under {prefix}"));
            }
            let path = if item == "self" {
                prefix.to_owned()
            } else {
                format!("{prefix}::{item}")
            };
            path_rest(tokens, at, &path, paths)?;
            if tokens.get(*at).map(String::as_str) == Some("as") {
                *at += 2;
            }
            match tokens.get(*at).map(String::as_str) {
                Some(",") => *at += 1,
                Some("}") => {}
                _ => return Err(format!("a group under {prefix} does not close")),
            }
        },
        "<" => {
            paths.push(prefix.to_owned());
            Ok(())
        }
        word if is_word(word) => path_rest(tokens, at, &format!("{prefix}::{word}"), paths),
        other => Err(format!("`{other}` after {prefix}::")),
    }
}

// The std paths that `source` names, or the first thing it must not contain.
fn std_paths(source: &str) -> Result<Vec<String>, String> {
    if !source.contains("#![forbid(unsafe_code)]") {
        return Err("unsafe code is not forbidden".into());
    }
    let tokens = tokens(source);
    let mut paths = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if FORBIDDEN.contains(&token.as_str()) {
            return Err(format!("`{token}`"));
        }
        if token == "mod" && tokens.get(index + 2).map(String::as_str) != Some("{") {
            return Err("a module from another file".into());
        }
        if token == "std" {
            let mut at = index + 1;
            path_rest(&tokens, &mut at, "std", &mut paths)?;
        }
    }
    if let Some(path) = paths.iter().find(|path| {
        !ALLOWED
            .iter()
            .any(|allowed| path == allowed || path.starts_with(&format!("{allowed}::")))
    }) {
        return Err(path.clone());
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[test]
fn the_workflow_takes_no_dependency_and_reads_no_clock_or_io_of_its_own() {
    let manifest: Vec<_> = include_str!("../Cargo.toml").lines().collect();
    assert_eq!(
        manifest,
        [
            "[package]",
            "name = \"draftyak-desktop-pairing\"",
            "version = \"0.0.0\"",
            "edition = \"2024\"",
            "rust-version = \"1.95\"",
            "license = \"Apache-2.0\"",
            "publish = false",
        ]
    );
    let entry = include_str!("../../Cargo.lock")
        .split("[[package]]")
        .find(|block| {
            block
                .lines()
                .any(|line| line == "name = \"draftyak-desktop-pairing\"")
        })
        .unwrap();
    let entry: Vec<_> = entry.lines().filter(|line| !line.is_empty()).collect();
    assert_eq!(
        entry,
        ["name = \"draftyak-desktop-pairing\"", "version = \"0.0.0\""]
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sources: Vec<_> = fs::read_dir(root.join("src"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(sources, ["lib.rs"]);
    assert!(!root.join("build.rs").exists());
    assert_eq!(std_paths(SOURCE), Ok(ALLOWED.map(String::from).to_vec()));
}

#[test]
fn the_source_check_refuses_clocks_io_and_other_files_in_any_spelling() {
    let grouped = |items: &str, body: &str| {
        let source = SOURCE.replacen("    fmt, mem,\n", &format!("    {items}\n"), 1);
        format!("{source}\n{body}\n")
    };
    let appended = |body: &str| format!("{SOURCE}\n{body}\n");
    let cases = [
        (
            grouped(
                "fmt, mem, time,",
                "pub fn now() -> time::Duration { time::Duration::ZERO }",
            ),
            "std::time",
        ),
        (
            grouped(
                "fmt, fs, mem,",
                "pub fn probe() -> bool { fs::metadata(\"C:/\").is_ok() }",
            ),
            "std::fs",
        ),
        (
            grouped(
                "fmt, mem, net::TcpStream,",
                "pub fn probe() -> bool { TcpStream::connect(\"127.0.0.1:1\").is_ok() }",
            ),
            "std::net::TcpStream",
        ),
        (
            appended("pub fn probe() -> bool { std::path::Path::new(\"C:/\").exists() }"),
            "std::path::Path::new",
        ),
        (
            appended("pub fn probe() -> bool { r#std::path::Path::new(\"C:/\").exists() }"),
            "std::path::Path::new",
        ),
        (
            appended("pub fn probe() -> bool { ::std::thread::panicking() }"),
            "std::thread::panicking",
        ),
        (
            appended("pub fn probe() -> bool { std /* */ :: thread::panicking() }"),
            "std",
        ),
        (appended("use std as base;"), "std"),
        (appended("use std::*;"), "`*` after std::"),
        (
            SOURCE.replacen(
                "sync::atomic::{AtomicU64, Ordering}",
                "sync::{atomic::{AtomicU64, Ordering}, mpsc}",
                1,
            ),
            "std::sync::mpsc",
        ),
        (
            SOURCE.replacen(
                "sync::atomic::{AtomicU64, Ordering}",
                "sync::atomic::{self, AtomicU64, Ordering}",
                1,
            ),
            "std::sync::atomic",
        ),
        (appended("mod helper;"), "a module from another file"),
        (
            appended("#[path = \"helper.rs\"]\nmod helper;"),
            "a module from another file",
        ),
        (
            appended("pub fn probe() { println!(\"probe\") }"),
            "`println`",
        ),
        (appended("include!(\"helper.rs\");"), "`include`"),
        (appended("pub const HOME: &str = env!(\"HOME\");"), "`env`"),
        (
            appended("pub fn probe() -> u64 { core::time::Duration::ZERO.as_secs() }"),
            "`core`",
        ),
        (
            appended("pub type Text = alloc::string::String;"),
            "`alloc`",
        ),
        (appended("extern crate std as base;"), "`extern`"),
        (
            SOURCE.replacen("#![forbid(unsafe_code)]\n", "", 1),
            "unsafe code is not forbidden",
        ),
    ];
    for (case, (source, refused)) in cases.into_iter().enumerate() {
        assert!(source != SOURCE, "case {case}");
        assert_eq!(std_paths(&source), Err(refused.to_owned()), "case {case}");
    }
}
