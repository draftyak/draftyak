use draftyak_protocol::sign::base64url_encode;
use serde_json::{Value, json};
use std::{
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const LIMIT: usize = 1 << 20;

pub struct Opening<'a> {
    pub typ: &'a str,
    pub bytes: &'a [u8],
    pub signature: &'a [u8],
    pub key: &'a [u8],
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn node_executable() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    env::split_paths(&env::var_os("PATH").expect("native Node PATH is required"))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
        .expect("native Node executable is required")
}

struct OwnedVerifier(Child);
impl Drop for OwnedVerifier {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

/// The JCS of what the merged TypeScript `openTypedStatement` returns for each opening, or
/// `None` where it refuses.
pub fn open_in_typescript(openings: &[Opening<'_>]) -> Vec<Option<String>> {
    let request = json!({
        "version": 1,
        "cases": openings
            .iter()
            .map(|opening| json!({
                "typ": opening.typ,
                "statementHex": hex(opening.bytes),
                "signature": base64url_encode(opening.signature),
                "key": base64url_encode(opening.key),
            }))
            .collect::<Vec<_>>(),
    });
    let input = serde_json::to_vec(&request).expect("statement verifier request JSON");
    assert!(input.len() <= LIMIT, "statement verifier request bound");
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/statement-verifier.mjs");
    let mut command = Command::new(node_executable());
    command
        .env_clear()
        .args(["--disable-sigusr1", "--max-old-space-size=128"])
        .arg(fixture)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    if let Some(root) = env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = OwnedVerifier(command.spawn().expect("statement verifier starts"));
    let started = Instant::now();
    let output = child.0.stdout.take().expect("statement verifier stdout");
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output
            .take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let mut stdin = child.0.stdin.take().expect("statement verifier stdin");
    let writer = thread::spawn(move || stdin.write_all(&input));
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("statement verifier wait") {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(30) {
            let _ = child.0.kill();
            let _ = child.0.wait();
            let _ = writer.join();
            let _ = reader.join();
            panic!("statement verifier deadline");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let written = writer.join().expect("statement verifier writer joined");
    let bytes = reader
        .join()
        .expect("statement verifier reader joined")
        .expect("statement verifier bounded read");
    assert!(status.success(), "statement verifier completed");
    written.expect("statement verifier request write");
    assert!(bytes.len() <= LIMIT, "statement verifier response bound");
    let result: Value = serde_json::from_slice(&bytes).expect("statement verifier response JSON");
    assert!(
        result["version"] == 1,
        "statement verifier response version"
    );
    assert!(
        result["node"].as_str() == Some(include_str!("../../../../.node-version").trim()),
        "statement verifier pinned Node"
    );
    let results = result["results"]
        .as_array()
        .expect("statement verifier results");
    assert!(
        results.len() == openings.len(),
        "statement verifier complete inventory"
    );
    results
        .iter()
        .map(|opened| {
            (!opened.is_null()).then(|| opened.as_str().expect("opened statement JCS").to_owned())
        })
        .collect()
}
