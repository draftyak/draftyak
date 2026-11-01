//! Native device claims bound to the stored keys and their actual pinned connection.
//!
//! The caller obtains native owner consent before connecting. An accepted claim is
//! pending protocol state, never device confirmation or capability authority. Reveal
//! and SAS composition consume this state in the later native flow. Owned secrets
//! are erased best effort; TLS, HTTP and cryptographic temporaries are not covered.

use std::{
    fmt,
    time::{Duration, Instant},
};

use draftyak_protocol::{jcs, sign};
use hkdf::hmac::{Hmac, KeyInit, Mac};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{Request, body::Bytes, client::conn::http1::SendRequest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    Error, RefusalCode, codec, key_store::StoredIdentity, payload::Payload, tls::PinnedConnection,
};

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const MAX_BODY_BYTES: usize = 4096;
const IO_TIMEOUT: Duration = Duration::from_secs(10);
const PROOF_LABEL: &[u8] = b"draftyak/pair/v1";
const COMMIT_LABEL: &[u8] = b"draftyak/sas-commit/v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireClaim {
    pid: String,
    role: String,
    name: String,
    transport_spki_sha256: String,
    signing_key: String,
    c: String,
    proof: String,
}

impl WireClaim {
    fn valid(&self) -> bool {
        fixed_base64::<16>(&self.pid).is_some()
            && self.role == "device"
            && codec::display_name(&self.name)
            && codec::unhex::<32>(&self.transport_spki_sha256).is_some()
            && sign::base64url_decode(&self.signing_key)
                .is_some_and(|der| sign::verifying_key_from_spki(&der).is_ok())
            && codec::unhex::<32>(&self.c).is_some()
            && codec::unhex::<32>(&self.proof).is_some()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireAnswer {
    device_id: String,
    epoch: u64,
    nh: String,
}

impl Drop for WireAnswer {
    fn drop(&mut self) {
        self.nh.zeroize();
    }
}

fn fixed_base64<const N: usize>(text: &str) -> Option<[u8; N]> {
    let decoded = Zeroizing::new(sign::base64url_decode(text)?);
    let mut fixed = [0; N];
    if decoded.len() != N {
        return None;
    }
    fixed.copy_from_slice(&decoded);
    Some(fixed)
}

fn valid_device_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 26
        && matches!(bytes[0], b'0'..=b'7')
        && bytes[1..].iter().all(|b| {
            matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z')
        })
}

fn commitment(nd: &[u8; 16]) -> [u8; 32] {
    let mut hash = Sha256::new();
    Digest::update(&mut hash, COMMIT_LABEL);
    Digest::update(&mut hash, nd);
    hash.finalize().into()
}

fn proof_mac(sec: &[u8; 16], ekm: &[u8; 32], bound: &[u8]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(sec).expect("fixed HMAC key length");
    Mac::update(&mut mac, PROOF_LABEL);
    Mac::update(&mut mac, ekm);
    Mac::update(&mut mac, bound);
    mac
}

fn claim_bound(
    transport: &[u8; 32],
    signing_spki: &[u8],
    c: &[u8; 32],
) -> Result<[u8; 129], Error> {
    let key = sign::verifying_key_from_spki(signing_spki).map_err(|_| Error::InvalidKey)?;
    let point = key.to_sec1_point(false);
    let mut bound = [0; 129];
    bound[..32].copy_from_slice(transport);
    bound[32..97].copy_from_slice(point.as_bytes());
    bound[97..].copy_from_slice(c);
    Ok(bound)
}

fn make_claim(
    pid: &[u8; 16],
    sec: &[u8; 16],
    name: &str,
    transport: &[u8; 32],
    signing_spki: &[u8],
    ekm: &[u8; 32],
    nd: &[u8; 16],
) -> Result<Zeroizing<Vec<u8>>, Error> {
    let c = commitment(nd);
    let bound = claim_bound(transport, signing_spki, &c)?;
    let proof = proof_mac(sec, ekm, &bound).finalize().into_bytes();
    let claim = WireClaim {
        pid: sign::base64url_encode(pid),
        role: "device".to_owned(),
        name: name.to_owned(),
        transport_spki_sha256: codec::hex(transport),
        signing_key: sign::base64url_encode(signing_spki),
        c: codec::hex(&c),
        proof: codec::hex(&proof),
    };
    if !claim.valid() {
        return Err(Error::InvalidInput);
    }
    let bytes = Zeroizing::new(
        jcs::canonicalize(&claim)
            .map_err(|_| Error::InvalidInput)?
            .into_bytes(),
    );
    if bytes.len() > MAX_BODY_BYTES {
        return Err(Error::InvalidInput);
    }
    Ok(bytes)
}

struct Channel {
    sender: SendRequest<Full<Bytes>>,
    driver: Option<tokio::task::JoinHandle<()>>,
    authority: String,
}

impl Channel {
    async fn open(connection: PinnedConnection) -> Result<Self, Error> {
        let (stream, authority) = connection.into_stream();
        let (sender, connection) = tokio::time::timeout(
            IO_TIMEOUT,
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(stream)),
        )
        .await
        .map_err(|_| Error::TimedOut)?
        .map_err(|_| Error::ConnectionFailed)?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(Self {
            sender,
            driver: Some(driver),
            authority,
        })
    }

    async fn claim(&mut self, body: &[u8]) -> Result<Zeroizing<Vec<u8>>, Error> {
        if body.len() > MAX_BODY_BYTES {
            return Err(Error::InvalidInput);
        }
        let request = Request::post("/pair/v1/claim")
            .header("host", &self.authority)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::copy_from_slice(body)))
            .map_err(|_| Error::InvalidInput)?;
        tokio::time::timeout(IO_TIMEOUT, async {
            let response = self
                .sender
                .send_request(request)
                .await
                .map_err(|_| Error::ConnectionFailed)?;
            let status = response.status().as_u16();
            let bytes = Limited::new(response.into_body(), MAX_BODY_BYTES)
                .collect()
                .await
                .map_err(|_| Error::InvalidResponse)?
                .to_bytes();
            match status {
                200 => Ok(Zeroizing::new(bytes.to_vec())),
                403 => Err(Error::Refused(RefusalCode::read(&bytes)?)),
                _ => Err(Error::InvalidResponse),
            }
        })
        .await
        .map_err(|_| Error::TimedOut)?
    }

    async fn close(&mut self) {
        if let Some(task) = self.driver.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        if let Some(task) = &self.driver {
            task.abort();
        }
    }
}

/// One native attempt using a stored identity and a freshly established pinned TLS stream.
/// Not cloneable or serializable; it exposes neither its nonce nor its proof secret.
#[must_use]
pub struct PairingAttempt {
    channel: Channel,
    pid: Zeroizing<String>,
    nd: Zeroizing<[u8; 16]>,
    ekm: Zeroizing<[u8; 32]>,
    body: Zeroizing<Vec<u8>>,
    started: Instant,
    window_remaining: Duration,
}

impl fmt::Debug for PairingAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PairingAttempt([redacted])")
    }
}

impl PairingAttempt {
    /// The caller has obtained explicit native consent. The payload's hub pin must
    /// match the persisted pin; DNS/address handling remains the pinned connector's.
    pub async fn connect(
        identity: &StoredIdentity,
        payload: &Payload,
        address_index: usize,
        name: &str,
        now_ms: u64,
    ) -> Result<Self, Error> {
        if now_ms > MAX_SAFE_INTEGER
            || payload.expires_at_ms() < now_ms
            || payload.hub_pin() != identity.hub_pin()
            || payload.native_addresses().get(address_index).is_none()
            || !codec::display_name(name)
        {
            return Err(Error::InvalidInput);
        }
        let started = Instant::now();
        let window_remaining = Duration::from_millis(payload.expires_at_ms() - now_ms);
        let pid = payload.exporter_context();
        let sec = payload.pairing_secret();
        let mut nd = Zeroizing::new([0; 16]);
        rustls::crypto::ring::default_provider()
            .secure_random
            .fill(&mut *nd)
            .map_err(|_| Error::ConnectionFailed)?;
        let connection = identity.connect_for_pairing(payload, address_index).await?;
        let ekm = connection.pairing_ekm(&pid)?;
        let body = make_claim(
            &pid,
            &sec,
            name,
            &identity.transport_spki_hash(),
            &identity.signing_public_key(),
            &ekm,
            &nd,
        )?;
        let channel = Channel::open(connection).await?;
        Ok(Self {
            channel,
            pid: Zeroizing::new(sign::base64url_encode(&pid)),
            nd,
            ekm,
            body,
            started,
            window_remaining,
        })
    }

    /// Sends exactly one claim. Its successful answer retains this same channel
    /// for the later reveal; it does not confirm or authorize a device.
    pub async fn claim(mut self) -> Result<AcceptedClaim, Error> {
        if self.started.elapsed().as_millis() > self.window_remaining.as_millis() {
            self.channel.close().await;
            return Err(Error::InvalidInput);
        }
        let result = self.channel.claim(&self.body).await;
        let response = match result {
            Ok(value) => value,
            Err(error) => {
                self.channel.close().await;
                return Err(error);
            }
        };
        let answer = read_answer(&response);
        let (device_id, epoch, nh) = match answer {
            Ok(value)
                if self.started.elapsed().as_millis() <= self.window_remaining.as_millis() =>
            {
                value
            }
            Ok(_) => {
                self.channel.close().await;
                return Err(Error::InvalidInput);
            }
            Err(error) => {
                self.channel.close().await;
                return Err(error);
            }
        };
        Ok(AcceptedClaim {
            channel: self.channel,
            pid: self.pid,
            nd: self.nd,
            ekm: self.ekm,
            nh,
            device_id,
            epoch,
        })
    }
}

fn read_answer(bytes: &[u8]) -> Result<(String, u64, Zeroizing<[u8; 16]>), Error> {
    if bytes.len() > MAX_BODY_BYTES {
        return Err(Error::InvalidResponse);
    }
    let value = jcs::parse_strict(bytes).map_err(|_| Error::InvalidResponse)?;
    let mut answer: WireAnswer =
        serde_json::from_value(value).map_err(|_| Error::InvalidResponse)?;
    if !valid_device_id(&answer.device_id) || answer.epoch > MAX_SAFE_INTEGER {
        return Err(Error::InvalidResponse);
    }
    let nh = Zeroizing::new(fixed_base64::<16>(&answer.nh).ok_or(Error::InvalidResponse)?);
    Ok((std::mem::take(&mut answer.device_id), answer.epoch, nh))
}

/// A claim answer awaiting the separate reveal flow on its original connection.
/// The two getters identify a pending candidate and grant no confirmation authority.
#[must_use]
pub struct AcceptedClaim {
    channel: Channel,
    pid: Zeroizing<String>,
    nd: Zeroizing<[u8; 16]>,
    ekm: Zeroizing<[u8; 32]>,
    nh: Zeroizing<[u8; 16]>,
    device_id: String,
    epoch: u64,
}

impl AcceptedClaim {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

impl fmt::Debug for AcceptedClaim {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AcceptedClaim([redacted])")
    }
}

impl Drop for AcceptedClaim {
    fn drop(&mut self) {
        self.pid.zeroize();
        self.nd.zeroize();
        self.ekm.zeroize();
        self.nh.zeroize();
        if let Some(task) = &self.channel.driver {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn vectors(name: &str) -> Value {
        let text = match name {
            "claims" => include_bytes!("../../../spec/vectors/pairing/claims.json").as_slice(),
            "proofs" => include_bytes!("../../../spec/vectors/pairing/proofs.json").as_slice(),
            _ => unreachable!(),
        };
        jcs::parse_strict(text).unwrap()
    }

    fn hex_bytes(text: &str) -> Vec<u8> {
        assert!(text.len().is_multiple_of(2));
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn shared_proof_vectors() {
        let value = vectors("proofs");
        let cases = value["proofs"].as_array().unwrap();
        assert_eq!(cases.len(), 8);
        for case in cases {
            let sec: [u8; 16] = hex_bytes(case["secHex"].as_str().unwrap())
                .try_into()
                .unwrap();
            let ekm: [u8; 32] = hex_bytes(case["ekmHex"].as_str().unwrap())
                .try_into()
                .unwrap();
            let mut bound = hex_bytes(case["pubsHex"].as_str().unwrap());
            if let Some(c) = case["cHex"].as_str() {
                bound.extend(hex_bytes(c));
            }
            let proof = hex_bytes(case["proofHex"].as_str().unwrap());
            assert_eq!(
                proof_mac(&sec, &ekm, &bound).verify_slice(&proof).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["id"]
            );
        }
        for case in value["commitments"].as_array().unwrap() {
            let nd = hex_bytes(case["ndHex"].as_str().unwrap())
                .try_into()
                .unwrap();
            assert_eq!(
                codec::hex(&commitment(&nd)),
                case["c"].as_str().unwrap(),
                "{}",
                case["id"]
            );
        }
    }

    // A test-only oracle exercises the private outgoing wire representation and
    // production proof primitive against the shared corpus. It is not a server API.
    fn vector_claim_outcome(case: &Value) -> &'static str {
        let body = case["body"].as_str().unwrap().as_bytes();
        if body.len() > MAX_BODY_BYTES {
            return "PAIR_CLAIM_INVALID";
        }
        let claim = jcs::parse_strict(body)
            .ok()
            .and_then(|value| serde_json::from_value::<WireClaim>(value).ok());
        let Some(claim) = claim.filter(WireClaim::valid) else {
            return "PAIR_CLAIM_INVALID";
        };
        if claim.pid != case["window"]["pid"].as_str().unwrap() {
            return "PAIR_WINDOW_CLOSED";
        }
        if claim.role != case["window"]["role"].as_str().unwrap() {
            return "PAIR_ROLE_MISMATCH";
        }
        if claim.transport_spki_sha256 != case["connection"]["clientSpkiSha256"].as_str().unwrap() {
            return "PAIR_PROOF_INVALID";
        }
        let transport = codec::unhex(&claim.transport_spki_sha256).unwrap();
        let spki = sign::base64url_decode(&claim.signing_key).unwrap();
        let c = codec::unhex(&claim.c).unwrap();
        let bound = claim_bound(&transport, &spki, &c).unwrap();
        let sec = fixed_base64(case["window"]["sec"].as_str().unwrap()).unwrap();
        let ekm = hex_bytes(case["connection"]["ekmHex"].as_str().unwrap())
            .try_into()
            .unwrap();
        let proof = codec::unhex::<32>(&claim.proof).unwrap();
        if proof_mac(&sec, &ekm, &bound).verify_slice(&proof).is_ok() {
            "accepted"
        } else {
            "PAIR_PROOF_INVALID"
        }
    }

    #[test]
    fn shared_claim_vectors() {
        let value = vectors("claims");
        let cases = value["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 33);
        for case in cases {
            assert_eq!(
                vector_claim_outcome(case),
                case["outcome"].as_str().unwrap(),
                "{}",
                case["id"]
            );
        }
    }

    #[test]
    fn strict_answer_and_redacted_state_contract() {
        let good =
            br#"{"deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":7,"nh":"AAECAwQFBgcICQoLDA0ODw"}"#;
        let (device, epoch, _) = read_answer(good).unwrap();
        assert_eq!(device, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
        assert_eq!(epoch, 7);
        for bad in [
            br#"{"deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":7,"epoch":8,"nh":"AAECAwQFBgcICQoLDA0ODw"}"#.as_slice(),
            br#"{"deviceId":"81ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":7,"nh":"AAECAwQFBgcICQoLDA0ODw"}"#.as_slice(),
            br#"{"deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":9007199254740992,"nh":"AAECAwQFBgcICQoLDA0ODw"}"#.as_slice(),
            br#"{"deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":7,"nh":"AAECAwQFBgcICQoLDA0ODx"}"#.as_slice(),
            br#"{"deviceId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","epoch":7,"nh":"AAECAwQFBgcICQoLDA0ODw","sas":"123456"}"#.as_slice(),
        ] { assert!(matches!(read_answer(bad), Err(Error::InvalidResponse))); }
    }
}
