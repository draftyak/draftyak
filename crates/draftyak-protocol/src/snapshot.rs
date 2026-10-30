//! Frozen email/chat sends. Deserialize through this validated type before hashing or rendering.
use crate::{hash::jcs_sha256, jcs::parse_strict, statements::decode};
use serde::{Deserialize, Deserializer, Serialize};
use unicode_normalization::is_nfc;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SnapshotError {
    #[error("SNAPSHOT_INVALID")]
    Invalid,
    #[error("SNAPSHOT_WINDOW_OVERFLOW")]
    WindowOverflow,
}
impl SnapshotError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "SNAPSHOT_INVALID",
            Self::WindowOverflow => "SNAPSHOT_WINDOW_OVERFLOW",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct SendSnapshotV1(Wire);
impl<'de> Deserialize<'de> for SendSnapshotV1 {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        let wire = Wire::deserialize(decoder)?;
        if !wire.valid() {
            return Err(serde::de::Error::custom("SNAPSHOT_INVALID"));
        }
        Ok(Self(wire))
    }
}
fn optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    decoder: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(decoder).map(Some)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(transparent)]
struct NullableId(Option<String>);
fn required_conversation<'de, D: Deserializer<'de>>(decoder: D) -> Result<NullableId, D::Error> {
    Option::<String>::deserialize(decoder).map(NullableId)
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Email,
    Chat,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Wire {
    v: u8,
    hub: String,
    epoch: u64,
    outbox: String,
    account: String,
    #[serde(deserialize_with = "required_conversation")]
    conversation: NullableId,
    kind: Kind,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    email: Option<Email>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    chat: Option<Chat>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    render: Option<Render>,
    body: Body,
    attachments: Vec<Attachment>,
    schedule: Schedule,
    source: Source,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Email {
    pub from: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub thread_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatChannelType {
    Dm,
    GroupDm,
    Public,
    Private,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Chat {
    pub channel_id: String,
    pub channel_name: String,
    pub channel_type: ChatChannelType,
    pub external: bool,
    /// Legacy absence is preserved; current send admission requires an explicit sharing fact.
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub shared: Option<bool>,
    pub member_count: u64,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub thread_ts: Option<String>,
    pub broadcast: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Render {
    pub method: String,
    pub url: String,
    pub headers_sha256: String,
    pub body_sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Body {
    pub text: String,
    pub footer: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub draft: String,
    pub rev: u64,
    pub authors: Vec<Author>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Author {
    pub kind: AuthorKind,
    pub id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorKind {
    Owner,
    Ai,
    Agent,
    Plugin,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Schedule {
    Now {},
    At {
        #[serde(rename = "notBefore")]
        not_before: u64,
        zone: String,
        #[serde(rename = "localWallTime")]
        local_wall_time: String,
        #[serde(rename = "latenessSec")]
        lateness_sec: u64,
        #[serde(rename = "holdIfNewInbound")]
        hold_if_new_inbound: bool,
    },
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SendWindow {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_before: Option<u64>,
    pub deliver_by: u64,
}

impl SendSnapshotV1 {
    pub fn hub(&self) -> &str {
        &self.0.hub
    }
    pub fn epoch(&self) -> u64 {
        self.0.epoch
    }
    pub fn outbox(&self) -> &str {
        &self.0.outbox
    }
    pub fn account(&self) -> &str {
        &self.0.account
    }
    pub fn conversation(&self) -> Option<&str> {
        self.0.conversation.0.as_deref()
    }
    pub fn kind(&self) -> &'static str {
        match self.0.kind {
            Kind::Email => "email",
            Kind::Chat => "chat",
        }
    }
    pub fn body(&self) -> &Body {
        &self.0.body
    }
    pub fn email(&self) -> Option<&Email> {
        self.0.email.as_ref()
    }
    pub fn chat(&self) -> Option<&Chat> {
        self.0.chat.as_ref()
    }
    pub fn schedule(&self) -> &Schedule {
        &self.0.schedule
    }
    pub fn source(&self) -> &Source {
        &self.0.source
    }
    pub fn render(&self) -> Option<&Render> {
        self.0.render.as_ref()
    }
    pub fn attachments(&self) -> &[Attachment] {
        &self.0.attachments
    }
}
pub fn parse_snapshot(bytes: &[u8]) -> Result<SendSnapshotV1, SnapshotError> {
    decode(&parse_strict(bytes).map_err(|_| SnapshotError::Invalid)?).ok_or(SnapshotError::Invalid)
}
/// Structural current-send admission, without enriching or rewriting legacy signed snapshots.
pub fn check_current_send_snapshot(snapshot: &SendSnapshotV1) -> bool {
    match snapshot.0.kind {
        Kind::Email => true,
        Kind::Chat => snapshot.chat().is_some_and(|chat| chat.shared.is_some()),
    }
}
pub fn check_body_text(text: &str) -> bool {
    !text.contains('\r') && is_nfc(text)
}
pub fn content_hash(snapshot: &SendSnapshotV1) -> Result<String, SnapshotError> {
    jcs_sha256(snapshot).map_err(|_| SnapshotError::Invalid)
}
pub fn fingerprint(snapshot: &SendSnapshotV1) -> Result<String, SnapshotError> {
    Ok(content_hash(snapshot)?[..8].to_ascii_uppercase())
}
pub fn send_window(snapshot: &SendSnapshotV1, iat: u64) -> Result<SendWindow, SnapshotError> {
    if iat > MAX_SAFE {
        return Err(SnapshotError::Invalid);
    }
    let (not_before, start, span) = match snapshot.schedule() {
        Schedule::Now {} => (None, iat, 900_000),
        Schedule::At {
            not_before,
            lateness_sec,
            ..
        } => (Some(*not_before), *not_before, lateness_sec * 1000),
    };
    let deliver_by = start
        .checked_add(span)
        .filter(|value| *value <= MAX_SAFE)
        .ok_or(SnapshotError::WindowOverflow)?;
    Ok(SendWindow {
        not_before,
        deliver_by,
    })
}
fn bounded(text: &str, max: usize) -> bool {
    text.chars().count() <= max
}
fn line(text: &str, max: usize) -> bool {
    bounded(text, max) && !text.contains(['\r', '\n'])
}
fn id(text: &str) -> bool {
    text.len() == 26
        && matches!(text.as_bytes()[0], b'0'..=b'7')
        && text
            .bytes()
            .all(|byte| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&byte))
}
fn sha(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
pub(crate) fn provider(text: &str) -> bool {
    !text.is_empty() && text.len() <= 256 && text.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}
fn visible_local(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || "!#$%&'*+-/=?^_`{|}~".contains(ch)
        || matches!(ch as u32,
    0x00a1..=0x00ac | 0x00ae..=0x034e | 0x0350..=0x05ff | 0x0606..=0x061b | 0x061d..=0x06dc | 0x06de..=0x070e |
    0x0710..=0x088f | 0x0892..=0x08e1 | 0x08e3..=0x115e | 0x1161..=0x167f | 0x1681..=0x17b3 | 0x17b6..=0x180a |
    0x1810..=0x1fff | 0x2010..=0x2027 | 0x2030..=0x205e | 0x2070..=0x27ff | 0x2801..=0x2fff | 0x3001..=0x3163 |
    0x3165..=0xd7ff | 0xf900..=0xfdcf | 0xfdf0..=0xfdff | 0xfe10..=0xfefe | 0xff00..=0xff9f | 0xffa1..=0xffef)
}
fn domain(text: &str, dotted: bool, max_label: bool) -> bool {
    let parts: Vec<_> = text.split('.').collect();
    (!dotted || parts.len() >= 2)
        && parts
            .last()
            .is_some_and(|part| part.as_bytes().first().is_some_and(u8::is_ascii_lowercase))
        && parts.iter().all(|part| {
            !part.is_empty()
                && (!max_label || part.len() <= 63)
                && part
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}
pub(crate) fn address(text: &str) -> bool {
    let Some((local, host)) = text.rsplit_once('@') else {
        return false;
    };
    bounded(text, 254)
        && !local.is_empty()
        && local
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(visible_local))
        && domain(host, true, true)
}
fn media(text: &str) -> bool {
    let Some((major, minor)) = text.split_once('/') else {
        return false;
    };
    text.len() <= 255
        && [major, minor].iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b"!#$&^_.+-".contains(&b)
                })
        })
}
fn zone(text: &str) -> bool {
    let parts: Vec<_> = text.split('/').collect();
    text.len() <= 64
        && text.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_+-".contains(&b))
        })
}
fn wall_time(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() != 22
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || !b"+-".contains(&b[16])
        || b[19] != b':'
        || text.ends_with("-00:00")
    {
        return false;
    }
    let numbers: Option<Vec<u32>> = [
        (0, 4),
        (5, 7),
        (8, 10),
        (11, 13),
        (14, 16),
        (17, 19),
        (20, 22),
    ]
    .iter()
    .map(|(a, z)| {
        let bytes = &b[*a..*z];
        if bytes.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(bytes).ok()?.parse().ok()
        } else {
            None
        }
    })
    .collect();
    let Some(n) = numbers else {
        return false;
    };
    let leap = n[0] % 4 == 0 && (n[0] % 100 != 0 || n[0] % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    (1..=12).contains(&n[1])
        && n[2] >= 1
        && n[2] <= days[n[1].saturating_sub(1) as usize % 12]
        && n[3] < 24
        && n[4] < 60
        && n[5] < 24
        && n[6] < 60
}
fn send_url(text: &str) -> bool {
    let Some(rest) = text.strip_prefix("https://") else {
        return false;
    };
    if text.len() > 8192 {
        return false;
    }
    let Some((authority, tail)) = rest.split_once('/') else {
        return false;
    };
    let (host, port) = authority
        .split_once(':')
        .map_or((authority, None), |(h, p)| (h, Some(p)));
    if !domain(host, false, false)
        || port.is_some_and(|p| {
            p.starts_with('0')
                || p == "443"
                || !p.bytes().all(|b| b.is_ascii_digit())
                || p.parse::<u16>().is_err()
        })
    {
        return false;
    }
    let (path, query) = tail
        .split_once('?')
        .map_or((tail, None), |(p, q)| (p, Some(q)));
    if path.split('/').any(|part| part == "." || part == "..") || query == Some("") {
        return false;
    }
    let valid = |s: &str, query: bool| {
        let mut bytes = s.bytes();
        while let Some(b) = bytes.next() {
            if b == b'%' {
                let Some((a, z)) = bytes.next().zip(bytes.next()) else {
                    return false;
                };
                let upper_hex = |c: u8| c.is_ascii_digit() || (b'A'..=b'F').contains(&c);
                if !upper_hex(a) || !upper_hex(z) {
                    return false;
                }
                let Some(decoded) = (a as char)
                    .to_digit(16)
                    .zip((z as char).to_digit(16))
                    .map(|(a, z)| (a * 16 + z) as u8)
                else {
                    return false;
                };
                if decoded.is_ascii_alphanumeric() || b"-._~".contains(&decoded) {
                    return false;
                }
            } else if !(b.is_ascii_alphanumeric()
                || b"._~!$&()*+,;=:@/-".contains(&b)
                || (!query && b == b'\'')
                || (query && b == b'?'))
            {
                return false;
            }
        }
        true
    };
    valid(path, false) && query.is_none_or(|q| valid(q, true))
}
/// The frozen schedule's checks, shared by the snapshot and the scheduled summary.
pub(crate) fn valid_schedule(schedule: &Schedule) -> bool {
    match schedule {
        Schedule::Now {} => true,
        Schedule::At {
            not_before,
            zone: z,
            local_wall_time,
            lateness_sec,
            ..
        } => {
            *not_before <= MAX_SAFE
                && zone(z)
                && wall_time(local_wall_time)
                && [900, 3600, 14400, 86400].contains(lateness_sec)
        }
    }
}
impl Wire {
    fn valid(&self) -> bool {
        let common = self.v == 1
            && sha(&self.hub)
            && (0..=MAX_SAFE).contains(&self.epoch)
            && id(&self.outbox)
            && id(&self.account)
            && self.conversation.0.as_ref().is_none_or(|s| id(s))
            && bounded(&self.body.text, 100_000)
            && bounded(&self.body.footer, 10_000)
            && check_body_text(&self.body.text)
            && check_body_text(&self.body.footer)
            && self.attachments.len() <= 100
            && self.attachments.iter().all(|a| {
                !a.filename.is_empty()
                    && line(&a.filename, 256)
                    && media(&a.content_type)
                    && a.size <= MAX_SAFE
                    && sha(&a.sha256)
            })
            && id(&self.source.draft)
            && (1..=MAX_SAFE).contains(&self.source.rev)
            && (1..=100).contains(&self.source.authors.len())
            && self.source.authors.iter().all(|a| id(&a.id))
            && self.render.as_ref().is_none_or(|r| {
                ["POST", "PUT", "PATCH"].contains(&r.method.as_str())
                    && send_url(&r.url)
                    && sha(&r.headers_sha256)
                    && sha(&r.body_sha256)
            })
            && valid_schedule(&self.schedule);
        common
            && match self.kind {
                Kind::Email => {
                    self.chat.is_none()
                        && self.email.as_ref().is_some_and(|e| {
                            address(&e.from)
                                && e.to.len() <= 100
                                && e.to.len() + e.cc.len() + e.bcc.len() > 0
                                && e.to.iter().all(|s| address(s))
                                && e.cc.len() <= 100
                                && e.cc.iter().all(|s| address(s))
                                && e.bcc.len() <= 100
                                && e.bcc.iter().all(|s| address(s))
                                && line(&e.subject, 2000)
                                && e.thread_id.as_ref().is_none_or(|s| provider(s))
                                && e.in_reply_to.as_ref().is_none_or(|s| provider(s))
                                && e.references.len() <= 100
                                && e.references.iter().all(|s| provider(s))
                        })
                }
                Kind::Chat => {
                    self.email.is_none()
                        && self.conversation.0.is_some()
                        && self.chat.as_ref().is_some_and(|c| {
                            provider(&c.channel_id)
                                && line(&c.channel_name, 256)
                                && c.member_count <= MAX_SAFE
                                && c.thread_ts.as_ref().is_none_or(|s| provider(s))
                                && (!c.broadcast || c.thread_ts.is_some())
                        })
                }
            }
    }
}
