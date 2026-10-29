//! Cross-language checks for packages/protocol/test/cross: one JSON object per line on stdin,
//! `{"cmd": <name>, …}`, answered by one line on stdout, the command's result, or
//! `{"fault": <message>}` when the request itself is wrong.

mod device_api;
mod jcs_sign;
mod schedule;
mod snapshot;
mod statements;

use draftyak_protocol::jcs::parse_strict;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::io::{self, BufRead, Write};

type Command = fn(&Map<String, Value>) -> Result<Value, String>;

// One line per area module, and no command name in two areas.
const AREAS: &[&[(&str, Command)]] = &[
    device_api::COMMANDS,
    jcs_sign::COMMANDS,
    schedule::COMMANDS,
    snapshot::COMMANDS,
    statements::COMMANDS,
    // Later areas follow, one line each.
];

fn main() -> io::Result<()> {
    let mut names = HashSet::new();
    for (name, _) in AREAS.iter().flat_map(|area| area.iter()) {
        assert!(names.insert(name), "two areas define the command {name:?}");
    }
    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        writeln!(stdout, "{}", answer(&line?))?;
        stdout.flush()?;
    }
    Ok(())
}

fn answer(line: &str) -> Value {
    let Ok(Value::Object(request)) = parse_strict(line.as_bytes()) else {
        return json!({"fault": "a request is one JSON object"});
    };
    let name = request
        .get("cmd")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match AREAS
        .iter()
        .flat_map(|area| area.iter())
        .find(|(command, _)| *command == name)
    {
        Some((_, run)) => run(&request).unwrap_or_else(|fault| json!({"fault": fault})),
        None => json!({"fault": format!("unknown command {name:?}")}),
    }
}

fn field<'a>(request: &'a Map<String, Value>, name: &str) -> Result<&'a str, String> {
    request
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} is a string"))
}

fn hex_field(request: &Map<String, Value>, name: &str) -> Result<Vec<u8>, String> {
    let text = field(request, name)?;
    (0..text.len())
        .step_by(2)
        .map(|at| text.get(at..at + 2))
        .map(|pair| pair.filter(|pair| pair.bytes().all(|byte| byte.is_ascii_hexdigit())))
        .map(|pair| pair.and_then(|pair| u8::from_str_radix(pair, 16).ok()))
        .collect::<Option<_>>()
        .ok_or_else(|| format!("{name} is hex"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
