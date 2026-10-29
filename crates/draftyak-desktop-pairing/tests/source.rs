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

// `source` with each comment and each string, byte or character literal replaced by a space.
fn code(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let is = |at: usize, text: &str| {
        text.chars()
            .enumerate()
            .all(|(i, c)| chars.get(at + i) == Some(&c))
    };
    let mut code = String::new();
    let mut at = 0;
    while at < chars.len() {
        let joined = at > 0 && (chars[at - 1] == '_' || chars[at - 1].is_alphanumeric());
        let prefix = if joined {
            0
        } else if is(at, "br") || is(at, "cr") {
            2
        } else {
            usize::from(is(at, "r"))
        };
        let hashes = chars[at + prefix..]
            .iter()
            .take_while(|&&c| c == '#')
            .count();
        if is(at, "//") {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
        } else if is(at, "/*") {
            let mut depth = 0;
            while at < chars.len() {
                if is(at, "/*") {
                    depth += 1;
                    at += 2;
                } else if is(at, "*/") {
                    depth -= 1;
                    at += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    at += 1;
                }
            }
        } else if prefix > 0 && is(at + prefix + hashes, "\"") {
            let close = format!("\"{}", "#".repeat(hashes));
            at += prefix + hashes + 1;
            while at < chars.len() && !is(at, &close) {
                at += 1;
            }
            at += close.len();
        } else if chars[at] == '"' {
            at += 1;
            while at < chars.len() && chars[at] != '"' {
                at += if chars[at] == '\\' { 2 } else { 1 };
            }
            at += 1;
        } else if is(at, "'\\") {
            at += 3;
            while at < chars.len() && chars[at] != '\'' {
                at += 1;
            }
            at += 1;
        } else if chars[at] == '\'' && chars.get(at + 2) == Some(&'\'') {
            at += 3;
        } else {
            code.push(chars[at]);
            at += 1;
            continue;
        }
        code.push(' ');
    }
    code
}

// The `#![...]` attributes that open the crate, read as code, each as one string.
fn crate_attributes(source: &str) -> Vec<String> {
    let tokens = tokens(&code(source));
    let at = |index: usize| tokens.get(index).map_or("", String::as_str);
    let mut attributes = Vec::new();
    let mut next = 0;
    while (at(next), at(next + 1), at(next + 2)) == ("#", "!", "[") {
        let start = next;
        let mut depth = 0;
        while next < tokens.len() {
            next += 1;
            match at(next - 1) {
                "[" => depth += 1,
                "]" if depth == 1 => break,
                "]" => depth -= 1,
                _ => {}
            }
        }
        attributes.push(tokens[start..next].concat());
    }
    attributes
}

// The index of the `}` that closes the group opening at `open`.
fn group_end(tokens: &[String], open: usize) -> usize {
    let mut depth = 0;
    for (at, token) in tokens.iter().enumerate().skip(open) {
        match token.as_str() {
            "{" => depth += 1,
            "}" if depth == 1 => return at,
            "}" => depth -= 1,
            _ => {}
        }
    }
    tokens.len()
}

// Traits that make a value of their own type, derived or implemented.
const MAKERS: [&str; 3] = ["Clone", "Copy", "Default"];

// Whether consent alone makes a `HubLink`, or the first other way that `source` has to make one.
fn hub_links(source: &str) -> Result<(), String> {
    let tokens = tokens(&code(source));
    let at = |index: usize| tokens.get(index).map_or("", String::as_str);
    let find = |pair: [&str; 2]| (0..tokens.len()).find(|&i| [at(i), at(i + 1)] == pair);
    if tokens.iter().any(|token| token == "macro_rules") {
        return Err("a macro could make a HubLink".into());
    }
    let definition = find(["struct", "HubLink"]).ok_or("no HubLink")?;
    let item = (0..definition)
        .rev()
        .find(|&i| matches!(at(i), "}" | ";"))
        .map_or(0, |i| i + 1);
    if let Some(derived) = tokens[item..definition]
        .iter()
        .find(|token| MAKERS.contains(&token.as_str()))
    {
        return Err(format!("HubLink derives {derived}"));
    }
    // The name of a tuple or unit struct is itself a way to make one.
    let fields = definition + 2;
    if at(fields) != "{" {
        return Err("HubLink has no named fields".into());
    }
    if tokens[fields..group_end(&tokens, fields)]
        .iter()
        .any(|token| token == "pub")
    {
        return Err("HubLink has a public field".into());
    }
    let borrowed = (0..tokens.len()).any(|i| {
        let mut name = i + 1;
        while at(name + 1) == "::" {
            name += 2;
        }
        at(i) == "mut" && at(name) == "HubLink"
    });
    if borrowed {
        return Err("a HubLink is borrowed mutably".into());
    }
    let renamed = (0..tokens.len()).any(|i| {
        [at(i), at(i + 1)] == ["HubLink", "as"]
            || (at(i) == "type"
                && tokens[i..]
                    .iter()
                    .take_while(|token| token.as_str() != ";")
                    .any(|token| token == "HubLink"))
    });
    if renamed {
        return Err("HubLink under another name".into());
    }
    for start in (0..tokens.len()).filter(|&i| at(i) == "impl") {
        let open = (start..tokens.len())
            .find(|&i| at(i) == "{")
            .unwrap_or(tokens.len());
        let header = &tokens[start + 1..open];
        let target = header
            .iter()
            .position(|token| token == "for")
            .map_or(header, |f| &header[f + 1..]);
        if !target
            .iter()
            .take_while(|token| token.as_str() != "where")
            .any(|token| token == "HubLink")
        {
            continue;
        }
        if let Some(maker) = header.iter().find(|token| MAKERS.contains(&token.as_str())) {
            return Err(format!("{maker} for HubLink"));
        }
        let end = group_end(&tokens, open);
        if tokens[start..end].iter().any(|token| token == "mut") {
            return Err("an impl on HubLink changes one".into());
        }
        let body = &tokens[open..end];
        let returns_one = body.windows(2).enumerate().any(|(i, pair)| {
            pair == ["-", ">"]
                && body[i + 2..]
                    .iter()
                    .take_while(|token| !matches!(token.as_str(), "{" | ";" | "where"))
                    .any(|token| token == "Self" || token == "HubLink")
        });
        if returns_one {
            return Err("an impl on HubLink returns one".into());
        }
        if body
            .windows(2)
            .any(|pair| pair[0] == "Self" && matches!(pair[1].as_str(), "{" | "("))
        {
            return Err("an impl on HubLink makes one".into());
        }
    }
    let literal = |i: usize| {
        let mut first = i;
        while first >= 2 && at(first - 1) == "::" {
            first -= 2;
        }
        let before = |n: usize| first.checked_sub(n).map_or("", at);
        at(i) == "HubLink"
            && matches!(at(i + 1), "{" | "(")
            && !matches!(before(1), "struct" | "impl" | "for")
            && [before(2), before(1)] != ["-", ">"]
    };
    let literals: Vec<usize> = (0..tokens.len()).filter(|&i| literal(i)).collect();
    let consent = find(["fn", "consent"]).ok_or("no consent")?;
    let open = (consent..tokens.len())
        .find(|&i| at(i) == "{")
        .unwrap_or(tokens.len());
    match literals[..] {
        [one] if (open..group_end(&tokens, open)).contains(&one) => Ok(()),
        [_] => Err("the HubLink literal is outside consent".into()),
        _ => Err(format!("{} HubLink literals", literals.len())),
    }
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
    if !crate_attributes(source)
        .iter()
        .any(|attribute| attribute == "#![forbid(unsafe_code)]")
    {
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
    let spelled = |forbid: &str| SOURCE.replacen("#![forbid(unsafe_code)]", forbid, 1);
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
        (
            spelled("// #![forbid(unsafe_code)]"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("/* #![forbid(unsafe_code)] */"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("#![doc = \"#![forbid(unsafe_code)]\"]"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("#![doc = r#\"#![forbid(unsafe_code)]\"#]"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("#![doc = \"] #![forbid(unsafe_code)] [\"]"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("#![doc = r#\"a\"] #![forbid(unsafe_code)] [\"b\"#]"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("#![doc = \"x\" /* ] #![forbid(unsafe_code)] #![doc = [ */]"),
            "unsafe code is not forbidden",
        ),
        (
            spelled("#![cfg_attr(any(), forbid(unsafe_code))]"),
            "unsafe code is not forbidden",
        ),
        (
            SOURCE.replacen("#![forbid(unsafe_code)]\n", "", 1)
                + "\nmod inner {\n    #![forbid(unsafe_code)]\n}\n",
            "unsafe code is not forbidden",
        ),
    ];
    for (case, (source, refused)) in cases.into_iter().enumerate() {
        assert!(source != SOURCE, "case {case}");
        assert_eq!(std_paths(&source), Err(refused.to_owned()), "case {case}");
    }
}

#[test]
fn the_source_check_finds_the_forbid_attribute_past_comments_and_literals() {
    for spelling in [
        "/* note */ #![forbid(unsafe_code)]",
        "#![doc = \"]\"]\n#![forbid(unsafe_code)]",
        "#![doc = '\"']\n#![forbid(unsafe_code)]\n#![doc = '\"']",
        "#![doc = '\\\"']\n#![forbid(unsafe_code)]\n#![doc = '\\\"']",
    ] {
        let source = SOURCE.replacen("#![forbid(unsafe_code)]", spelling, 1);
        assert!(source != SOURCE, "{spelling}");
        assert_eq!(
            std_paths(&source),
            Ok(ALLOWED.map(String::from).to_vec()),
            "{spelling}"
        );
    }
}

#[test]
fn only_consent_makes_a_hub_link() {
    assert_eq!(hub_links(SOURCE), Ok(()));
}

#[test]
fn the_hub_link_check_refuses_every_other_way_to_make_one() {
    let derived = |derives: &str| {
        let with = format!("#[derive({derives})]\npub struct HubLink");
        SOURCE.replacen("#[derive(Debug)]\npub struct HubLink", &with, 1)
    };
    let appended = |body: &str| format!("{SOURCE}\n{body}\n");
    let tuple = |fields: &str| {
        SOURCE
            .replacen(
                "pub struct HubLink {\n    attempt: AttemptId,\n}",
                &format!("pub struct HubLink({fields});"),
                1,
            )
            .replacen(
                "HubLink {\n                    attempt: current.id,\n                }",
                "HubLink(current.id)",
                1,
            )
    };
    let cases = [
        (derived("Clone, Debug"), "HubLink derives Clone"),
        (derived("Debug, Copy"), "HubLink derives Copy"),
        (derived("Debug, Default"), "HubLink derives Default"),
        (
            appended("impl Clone for HubLink { fn clone(&self) -> Self { todo!() } }"),
            "Clone for HubLink",
        ),
        (
            appended("impl Copy for crate::HubLink {}"),
            "Copy for HubLink",
        ),
        (
            appended("impl Default for HubLink { fn default() -> Self { todo!() } }"),
            "Default for HubLink",
        ),
        (
            appended(
                "impl HubLink { pub fn forge(attempt: AttemptId) -> Self { Self { attempt } } }",
            ),
            "an impl on HubLink returns one",
        ),
        (
            appended("impl HubLink { pub fn again(&self) -> Option<HubLink> { None } }"),
            "an impl on HubLink returns one",
        ),
        (
            appended("impl From<u64> for HubLink { fn from(_: u64) -> Self { todo!() } }"),
            "an impl on HubLink returns one",
        ),
        (
            appended(
                "impl HubLink { pub fn pass(&self, to: fn(HubLink)) { \
                 to(Self { attempt: self.attempt }) } }",
            ),
            "an impl on HubLink makes one",
        ),
        (
            appended("pub fn forge(attempt: AttemptId) -> HubLink { HubLink { attempt } }"),
            "2 HubLink literals",
        ),
        (
            SOURCE.replacen(
                "HubLink {\n                    attempt: current.id,\n                }",
                "link_for(current.id)",
                1,
            ) + "\nfn link_for(attempt: AttemptId) -> HubLink { HubLink { attempt } }\n",
            "the HubLink literal is outside consent",
        ),
        (
            appended("type Link = HubLink;"),
            "HubLink under another name",
        ),
        (
            appended("use self::HubLink as Link;"),
            "HubLink under another name",
        ),
        (
            SOURCE.replacen(
                "pub struct HubLink {\n    attempt: AttemptId,",
                "pub struct HubLink {\n    pub attempt: AttemptId,",
                1,
            ),
            "HubLink has a public field",
        ),
        (tuple("pub AttemptId"), "HubLink has no named fields"),
        (
            tuple("AttemptId")
                + "\npub fn forge(id: AttemptId) -> Option<HubLink> { Some(id).map(HubLink) }\n",
            "HubLink has no named fields",
        ),
        (
            appended(
                "macro_rules! make { ($t:ident, $a:expr) => { $t { attempt: $a } }; }\n\
                 pub fn forge(id: AttemptId) -> HubLink { make!(HubLink, id) }",
            ),
            "a macro could make a HubLink",
        ),
        (
            appended(
                "macro_rules! cl { ($t:ty) => { impl Clone for $t { \
                 fn clone(&self) -> Self { todo!() } } }; }\ncl!(HubLink);",
            ),
            "a macro could make a HubLink",
        ),
        (
            appended(
                "impl HubLink { pub fn retarget(&mut self, attempt: AttemptId) { \
                 self.attempt = attempt } }",
            ),
            "an impl on HubLink changes one",
        ),
        (
            appended(
                "pub fn retarget(link: &mut HubLink, attempt: AttemptId) { link.attempt = attempt }",
            ),
            "a HubLink is borrowed mutably",
        ),
    ];
    for (case, (source, refused)) in cases.into_iter().enumerate() {
        assert!(source != SOURCE, "case {case}");
        assert_eq!(hub_links(&source), Err(refused.to_owned()), "case {case}");
    }
}
