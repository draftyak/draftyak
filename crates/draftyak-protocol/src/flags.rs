use crate::{hash::jcs_sha256, jcs::parse_strict};
use serde::{Deserialize, Deserializer, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FlagCode {
    NewRecipient,
    RecipientAddedByAgent,
    ReplyToRedirect,
    AgentAuthored,
    DmarcFail,
    ExternalLink,
    AgentInsertedContact,
    AttachmentAddedByAgent,
    InvisibleChars,
    MassMention,
    CrossThreadData,
    SecretPattern,
    SuspectedInstructions,
    ToolDataInBody,
    ToolContextUsed,
    ToolInstructions,
}
impl FlagCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewRecipient => "NEW_RECIPIENT",
            Self::RecipientAddedByAgent => "RECIPIENT_ADDED_BY_AGENT",
            Self::ReplyToRedirect => "REPLY_TO_REDIRECT",
            Self::AgentAuthored => "AGENT_AUTHORED",
            Self::DmarcFail => "DMARC_FAIL",
            Self::ExternalLink => "EXTERNAL_LINK",
            Self::AgentInsertedContact => "AGENT_INSERTED_CONTACT",
            Self::AttachmentAddedByAgent => "ATTACHMENT_ADDED_BY_AGENT",
            Self::InvisibleChars => "INVISIBLE_CHARS",
            Self::MassMention => "MASS_MENTION",
            Self::CrossThreadData => "CROSS_THREAD_DATA",
            Self::SecretPattern => "SECRET_PATTERN",
            Self::SuspectedInstructions => "SUSPECTED_INSTRUCTIONS",
            Self::ToolDataInBody => "TOOL_DATA_IN_BODY",
            Self::ToolContextUsed => "TOOL_CONTEXT_USED",
            Self::ToolInstructions => "TOOL_INSTRUCTIONS",
        }
    }
    pub fn severity(self) -> Severity {
        match self {
            Self::ToolContextUsed => Severity::Info,
            Self::SuspectedInstructions | Self::ToolInstructions => Severity::Advisory,
            _ => Severity::Ack,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Ack,
    Info,
    Advisory,
}
#[derive(Debug, Clone, Serialize)]
#[serde(transparent)]
pub struct Flag(Wire);
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire {
    code: FlagCode,
    severity: Severity,
    #[serde(
        default,
        deserialize_with = "optional",
        skip_serializing_if = "Option::is_none"
    )]
    detail: Option<String>,
}
fn optional<'de, D: Deserializer<'de>>(decoder: D) -> Result<Option<String>, D::Error> {
    String::deserialize(decoder).map(Some)
}
impl<'de> Deserialize<'de> for Flag {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        let value = Wire::deserialize(decoder)?;
        if value.code.severity() != value.severity
            || value
                .detail
                .as_ref()
                .is_some_and(|s| s.is_empty() || s.chars().count() > 1000)
        {
            return Err(serde::de::Error::custom("FLAGS_INVALID"));
        }
        Ok(Self(value))
    }
}
impl Flag {
    pub fn code(&self) -> FlagCode {
        self.0.code
    }
    pub fn severity(&self) -> Severity {
        self.0.severity
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum FlagsError {
    #[error("FLAGS_INVALID")]
    Invalid,
    #[error("FLAGS_DUPLICATE")]
    Duplicate,
}
impl FlagsError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "FLAGS_INVALID",
            Self::Duplicate => "FLAGS_DUPLICATE",
        }
    }
}
pub fn parse_flags(bytes: &[u8]) -> Result<Vec<Flag>, FlagsError> {
    let value = parse_strict(bytes).map_err(|_| FlagsError::Invalid)?;
    serde_json::from_value(value).map_err(|_| FlagsError::Invalid)
}
pub fn flags_hash(flags: &[Flag]) -> Result<String, FlagsError> {
    let mut sorted = flags.to_vec();
    sorted.sort_by(|a, b| {
        a.0.code.as_str().cmp(b.0.code.as_str()).then_with(|| {
            a.0.detail
                .as_deref()
                .unwrap_or("")
                .encode_utf16()
                .cmp(b.0.detail.as_deref().unwrap_or("").encode_utf16())
        })
    });
    if sorted
        .windows(2)
        .any(|pair| pair[0].0.code == pair[1].0.code && pair[0].0.detail == pair[1].0.detail)
    {
        return Err(FlagsError::Duplicate);
    }
    jcs_sha256(&sorted).map_err(|_| FlagsError::Invalid)
}
pub fn required_ack_codes(flags: &[Flag]) -> Result<Vec<FlagCode>, FlagsError> {
    flags_hash(flags)?;
    let mut codes: Vec<_> = flags
        .iter()
        .filter(|f| f.severity() == Severity::Ack)
        .map(Flag::code)
        .collect();
    codes.sort_by_key(|code| code.as_str());
    codes.dedup();
    Ok(codes)
}
