use draftyak_protocol::sign;
use draftyak_transport::sidecar::{SidecarError, SidecarWindowSecrets, derive_window_secrets};
use serde::Deserialize;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Deserialize)]
struct SidecarCases {
    sidecar: Vec<SidecarVector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SidecarVector {
    id: String,
    bootstrap_secret_hex: String,
    pid: String,
    sec: String,
}

impl Drop for SidecarVector {
    fn drop(&mut self) {
        self.bootstrap_secret_hex.zeroize();
        self.pid.zeroize();
        self.sec.zeroize();
    }
}

fn bootstrap_bytes(hex: &str) -> Zeroizing<[u8; 16]> {
    assert!(hex.len() == 32, "sidecar fixture input length");
    let mut bytes = Zeroizing::new([0u8; 16]);
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
            .expect("sidecar fixture input encoding");
    }
    bytes
}

fn canonical_output(encoded: &str) {
    assert!(encoded.len() == 22, "sidecar output encoded length");
    assert!(
        encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "sidecar output alphabet"
    );
    let decoded =
        Zeroizing::new(sign::base64url_decode(encoded).expect("sidecar output canonical encoding"));
    assert!(decoded.len() == 16, "sidecar output decoded length");
    let round_trip = Zeroizing::new(sign::base64url_encode(&decoded));
    assert!(
        round_trip.as_str() == encoded,
        "sidecar output canonical round trip"
    );
}

#[test]
fn both_merged_sidecar_vectors_match_and_round_trip_canonically() {
    let vectors: SidecarCases =
        serde_json::from_str(include_str!("../../../spec/vectors/pairing/proofs.json"))
            .expect("merged sidecar vector structure");
    assert!(
        vectors.sidecar.len() == 2,
        "both merged sidecar cases are required"
    );
    assert!(
        vectors.sidecar.iter().any(|case| case.id == "zeros")
            && vectors.sidecar.iter().any(|case| case.id == "run"),
        "merged sidecar case identities"
    );

    for case in &vectors.sidecar {
        let input = bootstrap_bytes(&case.bootstrap_secret_hex);
        let secrets = derive_window_secrets(&*input).expect("valid sidecar fixture input");
        assert!(
            secrets.pid() == case.pid.as_str(),
            "merged sidecar pid mismatch"
        );
        assert!(
            secrets.sec() == case.sec.as_str(),
            "merged sidecar sec mismatch"
        );
        assert!(
            secrets.pid() != secrets.sec(),
            "sidecar labels must be distinct"
        );
        canonical_output(secrets.pid());
        canonical_output(secrets.sec());
    }
}

#[test]
fn wrong_bootstrap_lengths_have_only_fixed_typed_errors() {
    for length in [0, 15, 17, 32] {
        let input = Zeroizing::new(vec![0xa5; length]);
        let result = derive_window_secrets(&input);
        assert!(
            matches!(&result, Err(SidecarError::InvalidBootstrapLength)),
            "invalid sidecar bootstrap length must return the fixed error"
        );
        let Err(error) = result else {
            unreachable!("sidecar length refusal was asserted");
        };
        assert!(
            error == SidecarError::InvalidBootstrapLength,
            "wrong sidecar input error type"
        );
        assert!(
            error.code() == "SIDECAR_BOOTSTRAP_LENGTH",
            "sidecar input error code is fixed"
        );
        assert!(
            error.to_string() == "invalid sidecar bootstrap length"
                && format!("{error:?}") == "InvalidBootstrapLength",
            "sidecar input error diagnostics are fixed"
        );
    }
}

#[test]
fn borrowed_input_is_unchanged_and_result_diagnostics_are_redacted() {
    let input = Zeroizing::new([0xa5; 16]);
    let secrets = derive_window_secrets(&*input).expect("valid synthetic sidecar input");
    assert!(*input == [0xa5; 16], "borrowed sidecar input changed");
    assert!(
        format!("{secrets:?}") == "SidecarWindowSecrets([redacted])",
        "sidecar result diagnostics must be redacted"
    );
    assert!(
        SidecarError::DerivationFailed.code() == "SIDECAR_DERIVATION_FAILED"
            && SidecarError::DerivationFailed.to_string() == "sidecar derivation failed"
            && format!("{:?}", SidecarError::DerivationFailed) == "DerivationFailed",
        "sidecar derivation error diagnostics are fixed"
    );
}

#[test]
fn explicit_zeroization_clears_owned_outputs_without_reading_freed_memory() {
    fn requires_drop_zeroization<T: ZeroizeOnDrop>() {}
    requires_drop_zeroization::<SidecarWindowSecrets>();
    let input = Zeroizing::new([0x5a; 16]);
    let mut secrets = derive_window_secrets(&*input).expect("valid synthetic sidecar input");
    assert!(
        !secrets.pid().is_empty() && !secrets.sec().is_empty(),
        "sidecar result begins with owned material"
    );
    secrets.zeroize();
    assert!(
        secrets.pid().is_empty() && secrets.sec().is_empty(),
        "explicit zeroization must clear both owned outputs"
    );
    assert!(
        format!("{secrets:?}") == "SidecarWindowSecrets([redacted])",
        "cleared result diagnostics stay redacted"
    );
    assert!(
        *input == [0x5a; 16],
        "caller retains ownership of borrowed input"
    );
}

#[path = "support/sidecar_contract.rs"]
mod contract;
