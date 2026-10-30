//! L2 device request, review and event contracts. Runtime authentication and challenge
//! consumption remain the hub's responsibility; these checks bind the bytes a device signs.
use crate::{
    flags::{Flag, FlagCode, flags_hash},
    hash::jcs_sha256,
    jcs::{canonicalize, is_canonical, parse_strict},
    sign::base64url_decode,
    snapshot::{SendSnapshotV1, content_hash},
    statements::{
        self, Statement,
        admin::ADMIN_KINDS,
        agent_session::AgentSessionReviewSubject,
        common::{MAX_SAFE, id, key, sha},
        decode,
        pair_confirm::{ConfirmationPreset, DeviceCapability, can_confirm},
        send::{check_flags_acked, check_send_window},
    },
};
use serde::Serialize;
use serde_json::{Map, Value, json};

pub mod admin;

pub const STATEMENT_BYTES: usize = 16_384;
pub const FRAME_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    pub role: &'static str,
    pub capability: Option<&'static str>,
    pub confirmation: &'static str,
    pub request: &'static str,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub response: &'static str,
    pub statement_type: Option<&'static str>,
    pub pair_confirm_policy: bool,
}
macro_rules! routes {
    ($($id:literal,$method:literal,$path:literal,$cap:expr,$confirmation:literal,$request:literal,$req:literal,$res:literal,$response:literal,$typ:expr,$pair:literal);* $(;)?) => {
        pub const DEVICE_API_ROUTES: &[Route] = &[$(Route {id:$id,method:$method,path:$path,role:"device",capability:$cap,confirmation:$confirmation,request:$request,request_bytes:$req,response_bytes:$res,response:$response,statement_type:$typ,pair_confirm_policy:$pair}),*];
    }
}
// Literal routes do not import subjects added by later contract items.
routes! {
    "status","GET","/device/v1/status",None,"known","none",0,1024,"DeviceStatus",None,false;
    "bootstrap","POST","/device/v1/bootstrap",None,"sidecar-bootstrap","BootstrapRequest",1024,1024,"DeviceStatus",None,false;
    "pairing-window","POST","/device/v1/pairing/windows",Some("approve"),"confirmed","PairingWindowRequest",1024,2048,"PairingWindow",None,false;
    "send-review","GET","/device/v1/outbox/<id>/snapshot",Some("approve"),"confirmed","none",0,1048576,"SendReview",None,false;
    "new-operation","POST","/device/v1/operations",Some("requiredCapability"),"confirmed","OperationRequest",4096,1024,"OperationCreated",None,true;
    "operation-review","GET","/device/v1/operations/<id>",Some("requiredCapability"),"confirmed","none",0,1048576,"OperationReview",None,false;
    "challenge","POST","/device/v1/challenges",Some("requiredCapability"),"confirmed","ChallengeRequest",1024,32768,"Challenge",None,true;
    "send-approval","POST","/device/v1/approval/send",Some("approve"),"confirmed","SignedEnvelope",32768,1024,"Accepted",Some("approval.send.v1"),false;
    "pair-confirmation","POST","/device/v1/pair-confirmations",Some("approve"),"confirmed","SignedEnvelope",32768,1024,"Accepted",Some("pair-confirm.v1"),true;
    "login","POST","/device/v1/login",Some("approve"),"confirmed","SignedEnvelope",32768,1024,"Accepted",Some("login.v1"),false;
    "consent","POST","/device/v1/consents",Some("approve"),"confirmed","SignedEnvelope",32768,1024,"Accepted",Some("consent.v1"),false;
    "agent-session","POST","/device/v1/agent-sessions",Some("approve"),"confirmed","SignedEnvelope",32768,1024,"Accepted",Some("agent-session.v1"),false;
    "admin","POST","/device/v1/admin",Some("admin"),"confirmed","SignedEnvelope",32768,1024,"Accepted",Some("admin.v1"),false;
    "sync-pause","POST","/device/v1/sync/pause",Some("organize"),"confirmed","SyncPause",1024,1024,"SyncPause",None,false;
    "events","GET","/device/v1/events",Some("read"),"confirmed","EventsRequest",1024,65536,"EventFrame",None,false;
}
pub const DEVICE_API_ERRORS: &[(&str, u16)] = &[
    ("INVALID_REQUEST", 400),
    ("FORBIDDEN", 403),
    ("NOT_FOUND", 404),
    ("TOO_LARGE", 413),
    ("PIN_INVALID", 403),
    ("PIN_LOCKED", 429),
    ("SIGNATURE_INVALID", 403),
    ("CHALLENGE_INVALID", 409),
    ("CODE_MISMATCH", 403),
    ("ACK_REQUIRED", 409),
    ("STALE", 409),
    ("LOCAL_TIME_MISMATCH", 409),
    ("WINDOW_UNAVAILABLE", 409),
    ("POLICY_DENIED", 403),
    ("DRAFT_LOCKED", 409),
    ("SCHEDULE_LIMIT", 409),
    ("SCHEDULING_UNAVAILABLE", 503),
    ("UNAVAILABLE", 503),
];
const DEVICE_TYPES: &[&str] = &[
    "approval.send.v1",
    "pair-confirm.v1",
    "login.v1",
    "consent.v1",
    "agent-session.v1",
    "admin.v1",
];
pub fn required_capability(kind: &str) -> Option<&'static str> {
    if kind == "admin.v1" || ADMIN_KINDS.contains(&kind) {
        Some("admin")
    } else if DEVICE_TYPES.contains(&kind)
        || ["pair-confirm", "login", "consent", "agent-session"].contains(&kind)
    {
        Some("approve")
    } else {
        None
    }
}
pub fn catalogue() -> Value {
    let errors: Map<String, Value> = DEVICE_API_ERRORS
        .iter()
        .map(|(code, status)| ((*code).into(), json!(status)))
        .collect();
    let capabilities: Map<String, Value> = DEVICE_TYPES
        .iter()
        .chain(["pair-confirm", "login", "consent", "agent-session"].iter())
        .chain(ADMIN_KINDS)
        .map(|kind| ((*kind).into(), json!(required_capability(kind))))
        .collect();
    json!({"routes":DEVICE_API_ROUTES,"errors":errors,"capabilities":capabilities,"presets":{
        "desktop":ConfirmationPreset::Desktop.capabilities(),"mobile":ConfirmationPreset::Mobile.capabilities(),"cli":ConfirmationPreset::Cli.capabilities()
    }})
}
fn route(name: &str) -> Option<&'static Route> {
    DEVICE_API_ROUTES.iter().find(|r| r.id == name)
}
pub fn check_statement_length(bytes: &[u8]) -> bool {
    bytes.len() <= STATEMENT_BYTES
}
pub fn check_frame_length(byte_length: usize) -> bool {
    byte_length <= FRAME_BYTES
}
pub fn check_route_length(name: &str, direction: &str, byte_length: usize) -> bool {
    route(name).is_some_and(|r| match direction {
        "request" => byte_length <= r.request_bytes,
        "response" => byte_length <= r.response_bytes,
        _ => false,
    })
}
fn shape(value: &Value, names: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.len() == names.len() && names.iter().all(|name| m.contains_key(*name)))
}
fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or("")
}
fn is_text(value: &Value, field: &str, check: impl FnOnce(&str) -> bool) -> bool {
    value[field].as_str().is_some_and(check)
}
fn safe(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= MAX_SAFE)
}
fn pin(text: &str) -> bool {
    (6..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}
fn ids(value: &Value, min: usize, max: usize) -> bool {
    value.as_array().is_some_and(|ids| {
        (min..=max).contains(&ids.len())
            && ids
                .iter()
                .enumerate()
                .all(|(i, v)| v.as_str().is_some_and(id) && !ids[..i].contains(v))
    })
}
fn capabilities(value: &Value, empty: bool) -> bool {
    decode::<Vec<DeviceCapability>>(value).is_some_and(|caps| {
        (empty || !caps.is_empty()) && caps.windows(2).all(|pair| pair[0] < pair[1])
    })
}
fn preset(value: &Value) -> Option<ConfirmationPreset> {
    decode(value)
}
fn cursor(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.len() <= 512 && s.is_ascii())
}
fn event_kind(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
}
fn display_name(s: &str) -> bool {
    let hidden = |c: char| matches!(c as u32,0..=0x1f|0x7f..=0x9f|0xad|0x34f|0x61c|0x115f..=0x1160|0x17b4..=0x17b5|0x180e|0x200b|0x200e..=0x200f|0x2028..=0x202e|0x2060..=0x206f|0x3164|0xfeff|0xffa0|0xfff0..=0xfffb|0x1bca0..=0x1bca3|0x1d173..=0x1d17a|0xe0000..=0xe00ff|0xe01f0..=0xe0fff);
    let blank = |c: char| {
        matches!(
            c as u32,
            0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x202f | 0x205f | 0x2800 | 0x3000
        )
    };
    let joiner = |c: char| matches!(c as u32,0x180b..=0x180d|0x180f|0x200c..=0x200d|0xfe00..=0xfe0f|0xe0100..=0xe01ef);
    !s.is_empty()
        && s.chars().count() <= 64
        && !s.chars().any(hidden)
        && !s.starts_with(blank)
        && !s.ends_with(blank)
        && s.chars().any(|c| !blank(c) && !joiner(c))
}
fn flags_acked(value: &Value) -> bool {
    decode::<Vec<FlagCode>>(value).is_some_and(|codes| {
        codes
            .windows(2)
            .all(|pair| pair[0].as_str() < pair[1].as_str())
    })
}
fn statement_bytes(value: &Value) -> Option<Vec<u8>> {
    let s = value.as_str()?;
    if s.len() > 21_846 {
        return None;
    }
    let bytes = base64url_decode(s)?;
    (check_statement_length(&bytes) && is_canonical(&bytes)).then_some(bytes)
}
fn typed_statement(value: &Value, typ: &str) -> Option<Statement> {
    if !DEVICE_TYPES.contains(&typ) {
        return None;
    }
    statements::parse_statement(typ, &statement_bytes(value)?)
}
/// The snapshot and flags of a strict send review.
fn send_review(value: &Value) -> Option<(SendSnapshotV1, Vec<Flag>)> {
    if !shape(
        value,
        &[
            "id",
            "snapshot",
            "contentHash",
            "flags",
            "flagsHash",
            "state",
            "stateReason",
            "requiredUsers",
            "expiresAt",
        ],
    ) {
        return None;
    }
    let snapshot: SendSnapshotV1 = decode(&value["snapshot"])?;
    let flags: Vec<Flag> = decode(&value["flags"])?;
    let valid = is_text(value, "id", id)
        && content_hash(&snapshot).is_ok_and(|h| value["contentHash"] == h)
        && flags_hash(&flags).is_ok_and(|h| value["flagsHash"] == h)
        && [
            "PENDING_APPROVAL",
            "APPROVED",
            "SCHEDULED",
            "SENDING",
            "RETRY_WAIT",
            "UNKNOWN",
            "SENT",
            "FAILED",
            "NEEDS_REAPPROVAL",
            "CANCELLED",
            "REJECTED",
            "SUPERSEDED",
            "EXPIRED",
        ]
        .contains(&text(value, "state"))
        && (value["stateReason"].is_null()
            || [
                "missed",
                "new_reply",
                "channel_changed",
                "approver_revoked",
                "credential_lost",
                "plugin_quarantined",
                "policy",
                "restored",
                "not_found",
            ]
            .contains(&text(value, "stateReason")))
        && ids(&value["requiredUsers"], 1, usize::MAX)
        && safe(&value["expiresAt"]);
    valid.then_some((snapshot, flags))
}
/// The pairing SAS (`spec/pairing-v1.md` section 9): exactly six ASCII digits.
fn sas(s: &str) -> bool {
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit())
}
fn pair_subject(value: &Value) -> bool {
    shape(
        value,
        &[
            "candidate",
            "name",
            "role",
            "transportSpkiSha256",
            "signingKey",
            "preset",
            "capabilities",
            "sas",
        ],
    ) && is_text(value, "candidate", id)
        && is_text(value, "name", display_name)
        && value["role"] == "device"
        && is_text(value, "transportSpkiSha256", sha)
        && is_text(value, "signingKey", key)
        && preset(&value["preset"])
            .is_some_and(|p| json!(p.capabilities()) == value["capabilities"])
        && is_text(value, "sas", sas)
}
fn operation_review(value: &Value) -> bool {
    shape(
        value,
        &[
            "id",
            "kind",
            "digest",
            "subject",
            "expiresAt",
            "remainingMs",
        ],
    ) && is_text(value, "id", id)
        && match text(value, "kind") {
            "pair-confirm" => pair_subject(&value["subject"]),
            "agent-session" => agent_subject(&value["subject"]).is_some(),
            "account.disconnect" => admin::account_subject(&value["subject"]),
            "account.mode-full" => admin::account_subject(&value["subject"]),
            "security.device-capabilities" => admin::device_capabilities_subject(&value["subject"]),
            "data.backup" => admin::data_backup_subject(&value["subject"]),
            _ => false,
        }
        && jcs_sha256(&value["subject"]).is_ok_and(|h| value["digest"] == h)
        && safe(&value["expiresAt"])
        && value["remainingMs"].as_u64().is_some_and(|v| v <= 120_000)
}
fn agent_subject(value: &Value) -> Option<AgentSessionReviewSubject> {
    decode(value)
}
fn operation_request(value: &Value) -> bool {
    if value["kind"] == "pair-confirm" {
        shape(value, &["kind", "ids", "preset"])
            && ids(&value["ids"], 1, 1)
            && preset(&value["preset"]).is_some()
    } else {
        let (min, max) = admin::request_ids(text(value, "kind"));
        shape(value, &["kind", "ids"])
            && ADMIN_KINDS.contains(&text(value, "kind"))
            && ids(&value["ids"], min, max)
    }
}
fn challenge_request(value: &Value) -> bool {
    is_text(value, "id", id)
        && match text(value, "kind") {
            "approval.send.v1" => {
                shape(value, &["kind", "id", "flagsAcked"]) && flags_acked(&value["flagsAcked"])
            }
            "pair-confirm.v1" | "agent-session.v1" => shape(value, &["kind", "id"]),
            "admin.v1" => shape(value, &["kind", "id"]),
            _ => false,
        }
}
fn challenge(value: &Value) -> bool {
    shape(value, &["kind", "id", "statement"])
        && is_text(value, "id", id)
        && [
            "approval.send.v1",
            "pair-confirm.v1",
            "agent-session.v1",
            "admin.v1",
        ]
        .contains(&text(value, "kind"))
        && typed_statement(&value["statement"], text(value, "kind")).is_some()
}
fn envelope(value: &Value, typ: Option<&str>) -> bool {
    shape(value, &["statement", "signature", "pin"])
        && is_text(value, "pin", pin)
        && value["signature"]
            .as_str()
            .and_then(base64url_decode)
            .is_some_and(|s| s.len() == 64)
        && match typ {
            Some(typ) => typed_statement(&value["statement"], typ).is_some(),
            None => DEVICE_TYPES
                .iter()
                .any(|typ| typed_statement(&value["statement"], typ).is_some()),
        }
}
fn event_frame(value: &Value) -> bool {
    match text(value, "type") {
        "ready" => shape(value, &["type", "cursor"]) && cursor(&value["cursor"]),
        "event" => {
            shape(value, &["type", "cursor", "kind", "ids"])
                && cursor(&value["cursor"])
                && is_text(value, "kind", event_kind)
                && ids(&value["ids"], 0, 100)
        }
        "reset" => {
            shape(value, &["type", "reason"])
                && ["cursor_expired", "epoch_changed", "resync_required"]
                    .contains(&text(value, "reason"))
        }
        _ => false,
    }
}
/// Strict wire-shape checks. The byte wrappers additionally enforce received-byte caps.
pub fn check_schema(name: &str, value: &Value) -> bool {
    match name {
        "DeviceStatus" | "BootstrapStatus" => {
            let confirmed = value["confirmed"].as_bool();
            shape(
                value,
                &[
                    "deviceId",
                    "epoch",
                    "confirmed",
                    "capabilities",
                    "testUpstreams",
                ],
            ) && is_text(value, "deviceId", id)
                && safe(&value["epoch"])
                && value["testUpstreams"].is_boolean()
                && confirmed.is_some_and(|c| {
                    if c {
                        capabilities(&value["capabilities"], false)
                    } else {
                        value["capabilities"] == json!([])
                    }
                })
                && (name != "BootstrapStatus"
                    || (confirmed == Some(true)
                        && value["capabilities"]
                            == json!(ConfirmationPreset::Desktop.capabilities())))
        }
        "BootstrapRequest" => shape(value, &["pin"]) && is_text(value, "pin", pin),
        "PairingWindowRequest" => {
            shape(value, &["role", "pin"])
                && value["role"] == "device"
                && is_text(value, "pin", pin)
        }
        "PairingWindow" => {
            shape(value, &["pairingCode"])
                && is_text(value, "pairingCode", |s| {
                    s.starts_with("draftyak-pair:v1:") && s.chars().count() <= 1000
                })
        }
        "OperationRequest" => operation_request(value),
        "OperationCreated" => shape(value, &["id"]) && is_text(value, "id", id),
        "SyncPause" => shape(value, &["paused"]) && value["paused"].is_boolean(),
        "Accepted" => {
            shape(value, &["kind", "id"])
                && DEVICE_TYPES.contains(&text(value, "kind"))
                && is_text(value, "id", id)
        }
        "SendReview" => send_review(value).is_some(),
        "PairConfirmSubject" => pair_subject(value),
        "AgentSessionReviewSubject" => agent_subject(value).is_some(),
        "AdminAccountSubject" => admin::account_subject(value),
        "AdminDeviceCapabilitiesSubject" => admin::device_capabilities_subject(value),
        "AdminDataBackupSubject" => admin::data_backup_subject(value),
        "OperationReview" => operation_review(value),
        "ChallengeRequest" => challenge_request(value),
        "Challenge" => challenge(value),
        "SignedEnvelope" => envelope(value, None),
        "EventsRequest" => {
            shape(value, &["after"]) && (value["after"].is_null() || cursor(&value["after"]))
        }
        "EventFrame" => event_frame(value),
        "ApiError" => {
            shape(value, &["code"])
                && DEVICE_API_ERRORS
                    .iter()
                    .any(|(code, _)| value["code"] == *code)
        }
        _ => false,
    }
}
pub fn check_api_error(value: &Value, status: u16) -> bool {
    encoded_length(value).is_some_and(|n| n <= 1024)
        && check_schema("ApiError", value)
        && DEVICE_API_ERRORS
            .iter()
            .any(|(code, s)| *s == status && value["code"] == *code)
}
pub fn check_api_error_bytes(bytes: &[u8], status: u16) -> bool {
    bytes.len() <= 1024 && parse_strict(bytes).is_ok_and(|value| check_api_error(&value, status))
}
fn encoded_length(value: &Value) -> Option<usize> {
    canonicalize(value).ok().map(|s| s.len())
}
pub fn check_route_request(name: &str, value: Option<&Value>) -> bool {
    let Some(r) = route(name) else {
        return false;
    };
    if r.request == "none" {
        return value.is_none();
    }
    value.is_some_and(|v| {
        encoded_length(v).is_some_and(|n| check_route_length(name, "request", n))
            && request_shape(r, v)
    })
}
fn request_shape(r: &Route, value: &Value) -> bool {
    if r.request == "SignedEnvelope" {
        envelope(value, r.statement_type)
    } else {
        check_schema(r.request, value)
    }
}
pub fn check_route_request_bytes(name: &str, bytes: Option<&[u8]>) -> bool {
    let Some(r) = route(name) else {
        return false;
    };
    if r.request == "none" {
        return bytes.is_none();
    }
    bytes.is_some_and(|b| {
        check_route_length(name, "request", b.len())
            && parse_strict(b).is_ok_and(|v| request_shape(r, &v))
    })
}
fn response_shape(r: &Route, value: &Value) -> bool {
    check_schema(
        if r.id == "bootstrap" {
            "BootstrapStatus"
        } else {
            r.response
        },
        value,
    ) && r.statement_type.is_none_or(|typ| value["kind"] == typ)
}
pub fn check_route_response(name: &str, value: &Value) -> bool {
    route(name).is_some_and(|r| {
        encoded_length(value).is_some_and(|n| check_route_length(name, "response", n))
            && response_shape(r, value)
    })
}
pub fn check_route_response_bytes(name: &str, bytes: &[u8]) -> bool {
    route(name).is_some_and(|r| {
        check_route_length(name, "response", bytes.len())
            && parse_strict(bytes).is_ok_and(|v| response_shape(r, &v))
    })
}
pub fn check_event_stream(frames: &[Value]) -> bool {
    !frames.is_empty()
        && ["ready", "reset"].contains(&text(&frames[0], "type"))
        && frames.iter().enumerate().all(|(i, f)| {
            check_route_response("events", f) && (i + 1 == frames.len() || f["type"] != "reset")
        })
}
/// Field-by-field binding, in addition to parsing each strict request and review.
pub fn check_challenge(
    challenge_value: &Value,
    review: &Value,
    request: &Value,
    context: &Value,
) -> bool {
    if !challenge(challenge_value)
        || !challenge_request(request)
        || challenge_value["id"] != request["id"]
        || review["id"] != request["id"]
        || challenge_value["kind"] != request["kind"]
        || !shape(context, &["hub", "device"])
        || !is_text(context, "hub", sha)
        || !is_text(context, "device", id)
    {
        return false;
    }
    let Some(statement) = typed_statement(&challenge_value["statement"], text(request, "kind"))
    else {
        return false;
    };
    match statement {
        Statement::Send(s) => {
            let Some((snapshot, flags)) = send_review(review) else {
                return false;
            };
            s.hub == text(context, "hub")
                && s.device == text(context, "device")
                && s.outbox == text(request, "id")
                && s.content_hash == text(review, "contentHash")
                && s.flags_hash == text(review, "flagsHash")
                && json!(s.flags_acked) == request["flagsAcked"]
                && check_flags_acked(&s, &flags)
                && check_send_window(&s, &snapshot)
                && snapshot.hub() == s.hub
                && snapshot.epoch() == s.epoch
                && snapshot.outbox() == s.outbox
        }
        Statement::Pair(s) => {
            let subject = &review["subject"];
            operation_review(review)
                && review["kind"] == "pair-confirm"
                && s.hub == text(context, "hub")
                && s.device == text(context, "device")
                && s.candidate == text(subject, "candidate")
                && json!(s.role) == subject["role"]
                && s.transport_spki_sha256 == text(subject, "transportSpkiSha256")
                && s.signing_key == text(subject, "signingKey")
                && subject["role"] == "device"
                && preset(&subject["preset"]).is_some_and(|p| s.capabilities == p.capabilities())
        }
        Statement::Agent(s) => {
            if !operation_review(review) || review["kind"] != "agent-session" {
                return false;
            }
            let Some(subject) = agent_subject(&review["subject"]) else {
                return false;
            };
            s.hub == text(context, "hub")
                && s.device == text(context, "device")
                && s.matches_pending(text(review, "id"), &subject)
        }
        Statement::Admin(s) => {
            operation_review(review)
                && admin::ADMIN_REVIEW_KINDS.contains(&text(review, "kind"))
                && s.hub == text(context, "hub")
                && s.device == text(context, "device")
                && s.op == text(request, "id")
                && s.kind == text(review, "kind")
                && s.digest == text(review, "digest")
                && (review["kind"] != "security.device-capabilities"
                    || s.device != text(&review["subject"], "device"))
        }
        _ => false,
    }
}
pub fn route_allows(name: &str, peer: &Value, operation: Option<&Value>) -> bool {
    let Some(r) = route(name) else {
        return false;
    };
    let Some(held) = decode::<Vec<DeviceCapability>>(&peer["capabilities"]) else {
        return false;
    };
    if !shape(
        peer,
        &[
            "role",
            "known",
            "revoked",
            "epoch",
            "confirmedEpoch",
            "capabilities",
            "sidecarClaim",
            "bootstrapDone",
        ],
    ) || peer["role"] != "device"
        || peer["known"] != true
        || peer["revoked"] != false
        || !safe(&peer["epoch"])
        || !(peer["confirmedEpoch"].is_null() || safe(&peer["confirmedEpoch"]))
        || !peer["sidecarClaim"].is_boolean()
        || !peer["bootstrapDone"].is_boolean()
        || !held.iter().enumerate().all(|(i, c)| !held[..i].contains(c))
    {
        return false;
    }
    let op = operation.unwrap_or(&Value::Null);
    if operation.is_some_and(|o| {
        !o.as_object().is_some_and(|m| {
            m.iter()
                .all(|(k, v)| ["kind", "preset"].contains(&k.as_str()) && v.is_string())
        })
    }) {
        return false;
    }
    let confirmed = peer["confirmedEpoch"] == peer["epoch"];
    if r.confirmation == "known" {
        return true;
    }
    if r.confirmation == "sidecar-bootstrap" {
        return !confirmed && peer["sidecarClaim"] == true && peer["bootstrapDone"] == false;
    }
    if !confirmed {
        return false;
    }
    if name == "new-operation"
        && text(op, "kind") != "pair-confirm"
        && !ADMIN_KINDS.contains(&text(op, "kind"))
    {
        return false;
    }
    if name == "challenge"
        && ![
            "approval.send.v1",
            "pair-confirm.v1",
            "agent-session.v1",
            "admin.v1",
        ]
        .contains(&text(op, "kind"))
    {
        return false;
    }
    let capability = if r.capability == Some("requiredCapability") {
        required_capability(text(op, "kind"))
    } else {
        r.capability
    };
    let caps = &peer["capabilities"];
    if !capability.is_some_and(|cap| {
        caps.as_array()
            .is_some_and(|caps| caps.contains(&json!(cap)))
    }) {
        return false;
    }
    if r.pair_confirm_policy
        && (name == "pair-confirmation"
            || ["pair-confirm", "pair-confirm.v1"].contains(&text(op, "kind")))
    {
        let Some(preset) = preset(&op["preset"]) else {
            return false;
        };
        return can_confirm(&held, preset);
    }
    true
}
