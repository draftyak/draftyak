use draftyak_protocol::sign::{base64url_decode, base64url_encode};
use draftyak_transport::sidecar::{SidecarError, SidecarWindowSecrets, derive_window_secrets};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use zeroize::{Zeroize, ZeroizeOnDrop};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex16(text: &str) -> [u8; 16] {
    assert!(text.len() == 32, "sidecar fixture input width");
    assert!(
        text.bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
        "sidecar fixture input alphabet"
    );
    std::array::from_fn(|index| {
        u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .expect("sidecar fixture hexadecimal input")
    })
}

fn varied_inputs() -> Vec<[u8; 16]> {
    let mut inputs = vec![
        [0xff; 16],
        [0xaa; 16],
        [0x55; 16],
        std::array::from_fn(|index| (index as u8).wrapping_mul(17).wrapping_add(3)),
        std::array::from_fn(|index| 255 - index as u8),
    ];
    for index in 0..16 {
        let mut input = [0x6d; 16];
        input[index] ^= 1 << (index % 8);
        inputs.push(input);
    }
    inputs
}

fn node_executable() -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    env::split_paths(&env::var_os("PATH").expect("native Node PATH is required"))
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
        .expect("native Node executable is required")
}

struct OwnedReference(Child);
impl Drop for OwnedReference {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

fn node_reference(inputs: &[[u8; 16]]) -> Value {
    let request = json!({
        "version": 1,
        "secrets": inputs.iter().map(|input| hex(input)).collect::<Vec<_>>(),
    });
    let input = serde_json::to_vec(&request).expect("sidecar reference request JSON");
    assert!(input.len() <= 4096, "sidecar reference request bound");
    let fixture =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sidecar-reference.mjs");
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
    let mut child = OwnedReference(command.spawn().expect("sidecar reference starts"));
    let output = child.0.stdout.take().expect("sidecar reference stdout");
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        output.take(16_385).read_to_end(&mut bytes).map(|_| bytes)
    });
    child
        .0
        .stdin
        .take()
        .expect("sidecar reference stdin")
        .write_all(&input)
        .expect("sidecar reference request write");
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.0.try_wait().expect("sidecar reference wait") {
            break status;
        }
        if started.elapsed() >= Duration::from_secs(10) {
            let _ = child.0.kill();
            let _ = child.0.wait();
            let _ = reader.join();
            panic!("sidecar reference deadline");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let bytes = reader
        .join()
        .expect("sidecar reference reader joined")
        .expect("sidecar reference bounded read");
    assert!(status.success(), "sidecar reference successful completion");
    assert!(bytes.len() <= 16_384, "sidecar reference response bound");
    let result: Value = serde_json::from_slice(&bytes).expect("sidecar reference response JSON");
    assert!(result["version"] == 1, "sidecar reference response version");
    assert!(
        result["node"].as_str() == Some(include_str!("../../../../.node-version").trim()),
        "sidecar reference pinned Node"
    );
    result
}

fn canonical_output(actual: &str, expected: &Value, expected_hex: &Value) {
    assert!(actual.len() == 22, "sidecar output encoded width");
    assert!(
        actual
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte)),
        "sidecar output unpadded base64url alphabet"
    );
    let decoded = base64url_decode(actual).expect("sidecar output canonical decoding");
    assert!(decoded.len() == 16, "sidecar output decoded width");
    assert!(
        base64url_encode(&decoded) == actual,
        "sidecar output canonical roundtrip"
    );
    assert!(
        expected.as_str() == Some(actual),
        "sidecar independent Node encoded agreement"
    );
    assert!(
        expected_hex.as_str() == Some(hex(&decoded).as_str()),
        "sidecar independent Node decoded agreement"
    );
}

#[test]
fn varied_inputs_match_fixed_node_reference_and_committed_sidecar_anchors() {
    let document: Value =
        serde_json::from_str(include_str!("../../../../spec/vectors/pairing/proofs.json"))
            .expect("committed sidecar fixture JSON");
    let anchors = document["sidecar"]
        .as_array()
        .expect("committed sidecar block");
    assert!(anchors.len() == 2, "committed sidecar anchor inventory");
    let mut inputs: Vec<[u8; 16]> = anchors
        .iter()
        .map(|anchor| {
            hex16(
                anchor["bootstrapSecretHex"]
                    .as_str()
                    .expect("committed sidecar input"),
            )
        })
        .collect();
    inputs.extend(varied_inputs());
    assert!(
        inputs.iter().copied().collect::<HashSet<_>>().len() == inputs.len(),
        "independent sidecar input diversity"
    );
    let reference = node_reference(&inputs);
    let cases = reference["cases"]
        .as_array()
        .expect("sidecar reference cases");
    assert!(
        cases.len() == inputs.len(),
        "sidecar reference complete inventory"
    );
    for (index, (input, expected)) in inputs.iter().zip(cases).enumerate() {
        assert!(
            expected["bootstrapSecretHex"].as_str() == Some(hex(input).as_str()),
            "sidecar reference input binding"
        );
        if let Some(anchor) = anchors.get(index) {
            assert!(
                expected["pid"] == anchor["pid"],
                "Node committed sidecar pid agreement"
            );
            assert!(
                expected["sec"] == anchor["sec"],
                "Node committed sidecar sec agreement"
            );
        }
        let actual = derive_window_secrets(input).expect("valid sidecar input");
        canonical_output(actual.pid(), &expected["pid"], &expected["pidHex"]);
        canonical_output(actual.sec(), &expected["sec"], &expected["secHex"]);
        assert!(
            actual.pid() != actual.sec(),
            "sidecar fixed info labels remain separate"
        );
    }
}

#[test]
fn other_slice_lengths_have_one_public_redacted_failure() {
    for length in [1, 2, 8, 14, 18, 31, 255, 4096] {
        let input = vec![0xd3; length];
        let error = match derive_window_secrets(&input) {
            Err(error) => error,
            Ok(_) => panic!("non16 sidecar input must refuse"),
        };
        assert!(
            matches!(error, SidecarError::InvalidBootstrapLength),
            "non16 sidecar typed error"
        );
        assert!(
            error.code() == "SIDECAR_BOOTSTRAP_LENGTH",
            "sidecar input error code"
        );
        assert!(
            error.to_string() == "invalid sidecar bootstrap length",
            "sidecar input error display is fixed"
        );
        assert!(
            format!("{error:?}") == "InvalidBootstrapLength",
            "sidecar input error Debug is fixed"
        );
    }
    let error = SidecarError::DerivationFailed;
    assert!(
        error.code() == "SIDECAR_DERIVATION_FAILED",
        "sidecar derivation error code"
    );
    assert!(
        error.to_string() == "sidecar derivation failed",
        "sidecar derivation error display is fixed"
    );
    assert!(
        format!("{error:?}") == "DerivationFailed",
        "sidecar derivation error Debug is fixed"
    );
}

#[test]
fn opaque_public_debug_is_constant_and_explicit_zeroize_clears_live_accessors() {
    fn supports_standard_erasure<T: Zeroize + ZeroizeOnDrop>() {}
    supports_standard_erasure::<SidecarWindowSecrets>();
    for input in varied_inputs() {
        let mut value = derive_window_secrets(&input).expect("valid public sidecar control");
        assert!(
            format!("{value:?}") == "SidecarWindowSecrets([redacted])",
            "sidecar public Debug remains fixed"
        );
        assert!(
            !value.pid().is_empty() && !value.sec().is_empty(),
            "live outputs are present"
        );
        value.zeroize();
        assert!(
            value.pid().is_empty() && value.sec().is_empty(),
            "explicit zeroize clears both live outputs"
        );
        value.zeroize();
        assert!(
            value.pid().is_empty() && value.sec().is_empty(),
            "explicit zeroize remains idempotent"
        );
    }
    // This observes live public state only; it does not inspect freed memory.
}
