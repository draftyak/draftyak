//! `spike-keyring native | fallback --dir <dir> | select --dir <dir>`, one JSON line per check.
//! native: a round trip through the platform store. fallback: an `mk.wrapped` round trip in <dir>,
//! with the passphrase from the first line of stdin, as the unlock prompt would read it. select:
//! what the app does at first start, native when the platform store round-trips a key, else the
//! fallback.

use std::io::BufRead;
use std::num::NonZeroU32;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use spike_keyring::wrapped::{self, UnwrapError};
use spike_keyring::{
    MK_LEN, NativeCheck, STORE, error_kind, native_round_trip, native_store, random,
};

const USAGE: &str = "usage: spike-keyring native | fallback --dir <dir> | select --dir <dir>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = match args.as_slice() {
        [_, flag, dir] if flag == "--dir" => Some(Path::new(dir)),
        _ => None,
    };
    let result = match (args.first().map(String::as_str), dir) {
        (Some("native"), None) if args.len() == 1 => native(),
        (Some("fallback"), Some(dir)) => fallback(dir),
        (Some("select"), Some(dir)) => select(dir),
        _ => Err(USAGE.to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("spike-keyring: {error}");
            ExitCode::FAILURE
        }
    }
}

fn native() -> Result<(), String> {
    let store = native_store().map_err(|kind| format!("{STORE} unavailable: {kind}"))?;
    let check = native_round_trip(store.as_ref()).map_err(|failed| format!("{STORE}: {failed}"))?;
    report(&check)
}

fn report(check: &NativeCheck) -> Result<(), String> {
    let persistence = check
        .persistence
        .as_deref()
        .map_or_else(|| "null".to_string(), |value| format!("\"{value}\""));
    println!(
        "{{\"check\":\"native\",\"store\":\"{STORE}\",\"readBack\":{},\
         \"persistence\":{persistence},\"removed\":{},\"ms\":{}}}",
        check.read_back, check.removed, check.millis
    );
    if check.read_back && check.removed {
        Ok(())
    } else {
        Err("the round trip failed".to_string())
    }
}

fn fallback(dir: &Path) -> Result<(), String> {
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|error| error.to_string())?;
    let passphrase = line.trim_end_matches(['\r', '\n']).as_bytes();
    if passphrase.is_empty() {
        return Err("no passphrase on stdin".to_string());
    }
    let mk: [u8; MK_LEN] = random();
    let path = dir.join("mk.wrapped");
    let iterations = NonZeroU32::new(wrapped::ITERATIONS).expect("non-zero");
    let sealed = wrapped::wrap(&mk, passphrase, iterations);
    wrapped::write_new(&path, &sealed).map_err(|error| format!("mk.wrapped: {error}"))?;
    let file = std::fs::read(&path).map_err(|error| format!("mk.wrapped: {error}"))?;
    let started = Instant::now();
    let read_back = wrapped::unwrap(&file, passphrase) == Ok(mk);
    let unwrap_ms = started.elapsed().as_millis();
    let refused = |file: &[u8], passphrase: &[u8]| {
        wrapped::unwrap(file, passphrase) == Err(UnwrapError::Unlock)
    };
    let flipped = |at: usize| {
        let mut copy = file.clone();
        copy[at] ^= 1;
        refused(&copy, passphrase)
    };
    let wrong_refused = refused(&file, b"not the passphrase");
    let tamper_refused = flipped(9) && flipped(file.len() - 1);
    println!(
        "{{\"check\":\"fallback\",\"kdf\":\"{}\",\"iterations\":{},\"aead\":\"{}\",\
         \"fileBytes\":{},\"fileMode\":{},\"readBack\":{read_back},\
         \"wrongPassphraseRefused\":{wrong_refused},\"tamperRefused\":{tamper_refused},\
         \"unwrapMs\":{unwrap_ms}}}",
        wrapped::KDF,
        wrapped::ITERATIONS,
        wrapped::AEAD,
        file.len(),
        file_mode(&path),
    );
    if read_back && wrong_refused && tamper_refused {
        Ok(())
    } else {
        Err("the fallback round trip failed".to_string())
    }
}

#[cfg(unix)]
fn file_mode(path: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).map_or_else(
        |_| "null".to_string(),
        |meta| format!("\"{:o}\"", meta.permissions().mode() & 0o777),
    )
}

#[cfg(not(unix))]
fn file_mode(_: &Path) -> String {
    "null".to_string()
}

/// A store can start and still be unusable (the Secret Service with no unlocked collection), so
/// the store is chosen by a real round trip: the fallback when it can't start, or when a step of
/// its first use fails for lack of access.
fn select(dir: &Path) -> Result<(), String> {
    let (kind, step) = match native_store() {
        Err(kind) => (kind, "startup"),
        Ok(store) => match native_round_trip(store.as_ref()) {
            Ok(check) => {
                println!("{{\"check\":\"select\",\"selected\":\"native\",\"store\":\"{STORE}\"}}");
                return report(&check);
            }
            Err(failed) if failed.unavailable() => (error_kind(&failed.error), failed.step),
            Err(failed) => return Err(format!("{STORE}: {failed}")),
        },
    };
    println!(
        "{{\"check\":\"select\",\"selected\":\"fallback\",\"nativeError\":\"{kind}\",\
         \"failedAt\":\"{step}\"}}"
    );
    fallback(dir)
}
