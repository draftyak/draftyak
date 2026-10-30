//! The tray and Quit summary. The hub computes `scopeHash`; a device checks its form and compares
//! it between reads, never recomputing it. A summary grants no read or send authority.
use crate::{
    hub_runtime::{SCHEDULED_SUMMARY_BYTES, SchedulingStatus, members},
    jcs::parse_strict,
    snapshot::{Schedule, valid_schedule},
    statements::common::{MAX_SAFE, id, sha},
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub const MAX_PENDING_APPROVAL_IDS: usize = 20;
pub const MAX_SCHEDULED_ITEMS: usize = 5;
pub const MAX_DESTINATION_BYTES: usize = 512;
/// A cut stops before a code point of at most 4 bytes.
pub const MIN_CUT_DESTINATION_BYTES: usize = MAX_DESTINATION_BYTES - 3;
pub const MAX_MORE_RECIPIENTS: u64 = 299;

fn alias(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes()
            .enumerate()
            .all(|(i, b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b == b'-'))
}
// The code points a display name refuses (controls, separators, bidi controls and other invisible
// ones), since the tray and the Quit dialog show a destination as is.
fn hidden(c: char) -> bool {
    matches!(c as u32,
        0..=0x1f | 0x7f..=0x9f | 0xad | 0x34f | 0x61c | 0x115f..=0x1160 | 0x17b4..=0x17b5
        | 0x180e | 0x200b | 0x200e..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f | 0x3164
        | 0xfeff | 0xffa0 | 0xfff0..=0xfffb | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a
        | 0xe0000..=0xe00ff | 0xe01f0..=0xe0fff)
}
fn destination(s: &str) -> bool {
    s.len() <= MAX_DESTINATION_BYTES && !s.chars().any(hidden)
}

/// One scheduled send as shown: no body, subject, statement or credential.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledItem {
    outbox_id: String,
    account_id: String,
    alias: String,
    destination: String,
    destination_truncated: bool,
    more_recipients: u64,
    schedule: Schedule,
    deliver_by: u64,
}
impl ScheduledItem {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        if !members(
            value,
            &[
                "outboxId",
                "accountId",
                "alias",
                "destination",
                "destinationTruncated",
                "moreRecipients",
                "schedule",
                "deliverBy",
            ],
        ) || !value["schedule"].is_object()
        {
            return None;
        }
        let item = Self {
            outbox_id: value["outboxId"].as_str()?.to_owned(),
            account_id: value["accountId"].as_str()?.to_owned(),
            alias: value["alias"].as_str()?.to_owned(),
            destination: value["destination"].as_str()?.to_owned(),
            destination_truncated: value["destinationTruncated"].as_bool()?,
            more_recipients: value["moreRecipients"].as_u64()?,
            schedule: serde_json::from_value(value["schedule"].clone()).ok()?,
            deliver_by: value["deliverBy"].as_u64()?,
        };
        item.valid().then_some(item)
    }
    fn valid(&self) -> bool {
        id(&self.outbox_id)
            && id(&self.account_id)
            && alias(&self.alias)
            && destination(&self.destination)
            && (!self.destination_truncated || self.destination.len() >= MIN_CUT_DESTINATION_BYTES)
            && self.more_recipients <= MAX_MORE_RECIPIENTS
            && valid_schedule(&self.schedule)
            && matches!(&self.schedule, Schedule::At { not_before, lateness_sec, .. }
                if lateness_sec
                    .checked_mul(1000)
                    .and_then(|span| not_before.checked_add(span))
                    .is_some_and(|end| end <= MAX_SAFE && end == self.deliver_by))
    }
    pub fn outbox_id(&self) -> &str {
        &self.outbox_id
    }
    pub fn account_id(&self) -> &str {
        &self.account_id
    }
    pub fn alias(&self) -> &str {
        &self.alias
    }
    pub fn destination(&self) -> &str {
        &self.destination
    }
    pub fn destination_truncated(&self) -> bool {
        self.destination_truncated
    }
    pub fn more_recipients(&self) -> u64 {
        self.more_recipients
    }
    /// Always the frozen `at` schedule.
    pub fn schedule(&self) -> &Schedule {
        &self.schedule
    }
    pub fn not_before(&self) -> u64 {
        match self.schedule {
            Schedule::At { not_before, .. } => not_before,
            Schedule::Now {} => 0,
        }
    }
    pub fn deliver_by(&self) -> u64 {
        self.deliver_by
    }
}
impl<'de> Deserialize<'de> for ScheduledItem {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        Self::from_json(&Value::deserialize(decoder)?)
            .ok_or_else(|| serde::de::Error::custom("SCHEDULED_ITEM_INVALID"))
    }
}

/// Counts are totals; the lists hold the first 20 pending approval ids, ascending, and the next 5
/// sends.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledSummary {
    scheduling: SchedulingStatus,
    scope_hash: String,
    pending_approval_count: u64,
    pending_approval_ids: Vec<String>,
    scheduled_count: u64,
    items: Vec<ScheduledItem>,
}
impl ScheduledSummary {
    pub(crate) fn from_json(value: &Value) -> Option<Self> {
        if !members(
            value,
            &[
                "scheduling",
                "scopeHash",
                "pendingApprovalCount",
                "pendingApprovalIds",
                "scheduledCount",
                "items",
            ],
        ) {
            return None;
        }
        let ids = value["pendingApprovalIds"].as_array()?;
        let items = value["items"].as_array()?;
        if ids.len() > MAX_PENDING_APPROVAL_IDS || items.len() > MAX_SCHEDULED_ITEMS {
            return None;
        }
        let summary = Self {
            scheduling: SchedulingStatus::from_json(&value["scheduling"])?,
            scope_hash: value["scopeHash"].as_str()?.to_owned(),
            pending_approval_count: value["pendingApprovalCount"].as_u64()?,
            pending_approval_ids: ids
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<_>>()?,
            scheduled_count: value["scheduledCount"].as_u64()?,
            items: items
                .iter()
                .map(ScheduledItem::from_json)
                .collect::<Option<_>>()?,
        };
        summary.valid().then_some(summary)
    }
    fn valid(&self) -> bool {
        let shown = |total: u64, cap: usize| total.min(cap as u64) as usize;
        sha(&self.scope_hash)
            && self.pending_approval_count <= MAX_SAFE
            && self.scheduled_count <= MAX_SAFE
            && self.pending_approval_ids.len()
                == shown(self.pending_approval_count, MAX_PENDING_APPROVAL_IDS)
            && self.pending_approval_ids.iter().all(|s| id(s))
            && self
                .pending_approval_ids
                .windows(2)
                .all(|pair| pair[0] < pair[1])
            && self.items.len() == shown(self.scheduled_count, MAX_SCHEDULED_ITEMS)
            && self.items.iter().enumerate().all(|(i, item)| {
                self.items[..i]
                    .iter()
                    .all(|prior| prior.outbox_id != item.outbox_id)
            })
            && self.items.windows(2).all(|pair| {
                (pair[0].not_before(), pair[0].outbox_id.as_str())
                    < (pair[1].not_before(), pair[1].outbox_id.as_str())
            })
    }
    pub fn scheduling(&self) -> &SchedulingStatus {
        &self.scheduling
    }
    pub fn scope_hash(&self) -> &str {
        &self.scope_hash
    }
    pub fn pending_approval_count(&self) -> u64 {
        self.pending_approval_count
    }
    pub fn pending_approval_ids(&self) -> &[String] {
        &self.pending_approval_ids
    }
    pub fn scheduled_count(&self) -> u64 {
        self.scheduled_count
    }
    pub fn items(&self) -> &[ScheduledItem] {
        &self.items
    }
    /// Whether two reads cover the same scope, by the hub's own hash.
    pub fn same_scope(&self, other: &Self) -> bool {
        self.scope_hash == other.scope_hash
    }
}
impl<'de> Deserialize<'de> for ScheduledSummary {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        Self::from_json(&Value::deserialize(decoder)?)
            .ok_or_else(|| serde::de::Error::custom("SCHEDULED_SUMMARY_INVALID"))
    }
}
/// The summary answer as received: at most 8 KiB, then strict JSON of the exact form.
pub fn parse_scheduled_summary(bytes: &[u8]) -> Option<ScheduledSummary> {
    if bytes.len() > SCHEDULED_SUMMARY_BYTES {
        return None;
    }
    ScheduledSummary::from_json(&parse_strict(bytes).ok()?)
}
