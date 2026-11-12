//! Local commit-reveal SAS preview for a still-pending native candidate.
//! A preview grants no device confirmation or capability authority.

use std::fmt;

use draftyak_protocol::{jcs, sign};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::{Error, payload::Preview};

pub(crate) const MAX_REVEAL_BYTES: usize = 1024;
const SAS_LABEL: &[u8] = b"draftyak/sas/v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireReveal {
    pid: String,
    nd: String,
}

impl WireReveal {
    fn valid(&self) -> bool {
        let fixed16 = |text: &str| {
            sign::base64url_decode(text)
                .map(Zeroizing::new)
                .is_some_and(|bytes| bytes.len() == 16)
        };
        fixed16(&self.pid) && fixed16(&self.nd)
    }
}

impl Drop for WireReveal {
    fn drop(&mut self) {
        self.nd.zeroize();
    }
}

pub(crate) fn build_reveal(pid: &str, nd: &[u8; 16]) -> Result<Zeroizing<Vec<u8>>, Error> {
    let wire = WireReveal {
        pid: pid.to_owned(),
        nd: sign::base64url_encode(nd),
    };
    if !wire.valid() {
        return Err(Error::InvalidInput);
    }
    let body = Zeroizing::new(
        jcs::canonicalize(&wire)
            .map_err(|_| Error::InvalidInput)?
            .into_bytes(),
    );
    if body.len() > MAX_REVEAL_BYTES {
        return Err(Error::InvalidInput);
    }
    Ok(body)
}

fn derive_sas(ekm: &[u8; 32], nd: &[u8; 16], nh: &[u8; 16]) -> Zeroizing<String> {
    let mut hash = Sha256::new();
    Digest::update(&mut hash, SAS_LABEL);
    Digest::update(&mut hash, ekm);
    Digest::update(&mut hash, nd);
    Digest::update(&mut hash, nh);
    let digest: Zeroizing<[u8; 32]> = Zeroizing::new(hash.finalize().into());
    let mut number =
        u32::from_be_bytes(digest[..4].try_into().expect("four digest bytes")) % 1_000_000;
    let sas = Zeroizing::new(format!("{number:06}"));
    number.zeroize();
    sas
}

/// Bounded native display data for a revealed, pending candidate.
/// It is not cloneable, serializable, a confirmed-device handle or an approval.
#[must_use]
pub struct SasPreview {
    sas: Zeroizing<String>,
    preview: Preview,
    device_id: String,
    epoch: u64,
}

impl SasPreview {
    pub(crate) fn from_revealed(
        ekm: &[u8; 32],
        nd: &[u8; 16],
        nh: &[u8; 16],
        preview: Preview,
        device_id: String,
        epoch: u64,
    ) -> Self {
        Self {
            sas: derive_sas(ekm, nd, nh),
            preview,
            device_id,
            epoch,
        }
    }

    pub fn sas(&self) -> &str {
        &self.sas
    }
    pub fn preview(&self) -> &Preview {
        &self.preview
    }
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

impl fmt::Debug for SasPreview {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SasPreview([redacted])")
    }
}

#[cfg(test)]
mod vectors {
    use super::{MAX_REVEAL_BYTES, WireReveal, build_reveal, derive_sas};
    use crate::{Error, codec, pairing};
    use draftyak_protocol::{jcs, sign};
    use serde_json::Value;
    use zeroize::Zeroizing;

    fn proof_corpus() -> Value {
        jcs::parse_strict(include_bytes!("../../../spec/vectors/pairing/proofs.json"))
            .unwrap_or_else(|_| panic!("fixed pairing proof corpus is strict JSON"))
    }

    fn reveal_corpus() -> Value {
        jcs::parse_strict(include_bytes!("../../../spec/vectors/pairing/claims.json"))
            .unwrap_or_else(|_| panic!("fixed pairing reveal corpus is strict JSON"))
    }

    fn hex_bytes<const N: usize>(text: &str) -> Zeroizing<[u8; N]> {
        assert!(text.len() == N * 2, "fixed vector hex length");
        let mut bytes = Zeroizing::new([0; N]);
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
                .unwrap_or_else(|_| panic!("fixed vector hex encoding"));
        }
        bytes
    }

    fn nonce(text: &str) -> Zeroizing<[u8; 16]> {
        let decoded = Zeroizing::new(
            sign::base64url_decode(text).expect("fixed vector canonical nonce encoding"),
        );
        assert!(decoded.len() == 16, "fixed vector nonce length");
        let mut bytes = Zeroizing::new([0; 16]);
        bytes.copy_from_slice(&decoded);
        bytes
    }

    #[test]
    fn shared_sas_vectors_include_leading_zeroes_and_nonce_order() {
        let corpus = proof_corpus();
        let cases = corpus["sas"].as_array().expect("fixed SAS vector list");
        assert!(cases.len() == 4, "complete fixed SAS corpus");
        let mut leading_zero_case = false;
        let mut ordered_nonce_case = false;
        for (index, case) in cases.iter().enumerate() {
            let ekm = hex_bytes(case["ekmHex"].as_str().expect("fixed SAS EKM"));
            let nd = hex_bytes(case["ndHex"].as_str().expect("fixed SAS device nonce"));
            let nh = hex_bytes(case["nhHex"].as_str().expect("fixed SAS hub nonce"));
            let expected = case["sas"].as_str().expect("fixed expected SAS");
            let actual = derive_sas(&ekm, &nd, &nh);
            assert!(
                actual.as_str() == expected,
                "native SAS differs from fixed corpus row {index}"
            );
            assert!(
                actual.len() == 6 && actual.bytes().all(|byte| byte.is_ascii_digit()),
                "native SAS has the fixed six-digit form at row {index}"
            );
            if case["id"].as_str() == Some("leading-zeros") {
                leading_zero_case = true;
                assert!(actual.starts_with('0'), "native SAS retains leading zeroes");
            }
            if case["id"].as_str() == Some("device-claim") {
                ordered_nonce_case = true;
                let swapped = derive_sas(&ekm, &nh, &nd);
                assert!(
                    swapped.as_str() != expected,
                    "device and hub nonce positions are bound in order"
                );
            }
        }
        assert!(
            leading_zero_case && ordered_nonce_case,
            "required SAS cases exist"
        );
    }

    // The corpus covers strict wire shape, the held pid comparison and the real
    // commitment primitive. This test-only oracle grants no hub state authority and
    // does not model its clock, connection ownership or pending-device recording.
    fn reveal_outcome(case: &Value) -> (&'static str, Option<Zeroizing<String>>) {
        let body = case["body"].as_str().expect("fixed reveal body").as_bytes();
        if body.len() > MAX_REVEAL_BYTES {
            return ("PAIR_REVEAL_INVALID", None);
        }
        let wire = jcs::parse_strict(body)
            .ok()
            .filter(Value::is_object)
            .and_then(|value| serde_json::from_value::<WireReveal>(value).ok());
        let Some(wire) = wire.filter(WireReveal::valid) else {
            return ("PAIR_REVEAL_INVALID", None);
        };
        let held = jcs::parse_strict(case["claim"].as_str().expect("fixed held claim").as_bytes())
            .unwrap_or_else(|_| panic!("fixed held claim is strict JSON"));
        if wire.pid != held["pid"].as_str().expect("fixed held pid") {
            return ("PAIR_WINDOW_CLOSED", None);
        }
        let nd = nonce(&wire.nd);
        let opened = codec::hex(&pairing::commitment(&nd));
        if opened != held["c"].as_str().expect("fixed held commitment") {
            return ("PAIR_COMMITMENT_MISMATCH", None);
        }
        let ekm = hex_bytes(case["ekmHex"].as_str().expect("fixed reveal EKM"));
        let nh = nonce(case["nh"].as_str().expect("fixed reveal hub nonce"));
        ("accepted", Some(derive_sas(&ekm, &nd, &nh)))
    }

    #[test]
    fn shared_reveal_vectors_use_native_wire_and_commitment() {
        let corpus = reveal_corpus();
        let cases = corpus["reveals"]
            .as_array()
            .expect("fixed reveal vector list");
        assert!(cases.len() == 28, "complete fixed reveal corpus");
        let mut accepted = 0;
        for (index, case) in cases.iter().enumerate() {
            let (actual, sas) = reveal_outcome(case);
            assert!(
                Some(actual) == case["outcome"].as_str(),
                "native reveal outcome differs from fixed corpus row {index}"
            );
            match (sas, case.get("sas").and_then(Value::as_str)) {
                (Some(actual), Some(expected)) => {
                    accepted += 1;
                    assert!(
                        actual.as_str() == expected,
                        "native revealed SAS differs from fixed corpus row {index}"
                    );
                }
                (None, None) => {}
                _ => panic!("only an accepted reveal has a SAS at fixed corpus row {index}"),
            }
        }
        assert!(
            accepted == 3,
            "all accepted reveal vectors retain their SAS"
        );
    }

    #[test]
    fn native_reveal_has_fixed_canonical_wire_and_refuses_noncanonical_pid() {
        let corpus = reveal_corpus();
        let cases = corpus["reveals"]
            .as_array()
            .expect("fixed reveal vector list");
        let valid = cases
            .iter()
            .find(|case| case["id"].as_str() == Some("device"))
            .expect("fixed canonical reveal case");
        let expected = valid["body"].as_str().expect("fixed canonical reveal body");
        let wire: WireReveal = serde_json::from_value(
            jcs::parse_strict(expected.as_bytes())
                .unwrap_or_else(|_| panic!("fixed strict reveal body")),
        )
        .unwrap_or_else(|_| panic!("fixed native reveal wire"));
        let nd = nonce(&wire.nd);
        let actual = build_reveal(&wire.pid, &nd)
            .unwrap_or_else(|_| panic!("native reveal accepts fixed inputs"));
        assert!(
            actual.as_slice() == expected.as_bytes(),
            "native outgoing reveal matches the fixed canonical wire"
        );
        assert!(
            jcs::is_canonical(&actual),
            "native outgoing reveal is canonical"
        );

        let invalid = cases
            .iter()
            .find(|case| case["id"].as_str() == Some("pid-loose-encoding"))
            .expect("fixed noncanonical pid case");
        let value = jcs::parse_strict(
            invalid["body"]
                .as_str()
                .expect("fixed invalid reveal body")
                .as_bytes(),
        )
        .unwrap_or_else(|_| panic!("fixed invalid reveal still has strict JSON"));
        assert!(
            matches!(
                build_reveal(value["pid"].as_str().expect("fixed invalid pid"), &nd),
                Err(Error::InvalidInput)
            ),
            "native reveal refuses the corpus noncanonical pid"
        );
    }
}
