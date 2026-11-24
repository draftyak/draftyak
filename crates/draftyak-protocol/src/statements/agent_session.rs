use super::common::{device_statement, id, sha};
use serde::{Deserialize, Serialize};

pub const CALL_TTL_MS: u64 = 600_000;
pub const SESSION_DURATIONS_MS: &[u64] = &[900_000, 3_600_000, 28_800_000];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrincipalKind {
    Grant,
    Token,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentSessionPrincipal {
    pub kind: PrincipalKind,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentToolClass {
    Read,
    Draft,
    Organize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentCallMethod {
    #[serde(rename = "tools/call")]
    ToolCall,
    #[serde(rename = "resources/read")]
    ResourceRead,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum AgentSessionAuthorization {
    Session {
        #[serde(rename = "durationMs")]
        duration_ms: u64,
    },
    Call {
        method: AgentCallMethod,
        #[serde(rename = "paramsDigest")]
        params_digest: String,
        #[serde(rename = "validForMs")]
        valid_for_ms: u64,
        #[serde(rename = "singleUse")]
        single_use: bool,
    },
}

device_statement!(AgentSessionStatement, Wire, {
    session: String,
    principal: AgentSessionPrincipal,
    account: String,
    tool_class: AgentToolClass,
    authorization: AgentSessionAuthorization,
}, |s: &AgentSessionStatement| {
    id(&s.session) && id(&s.principal.id) && id(&s.account) && match &s.authorization {
        AgentSessionAuthorization::Session { duration_ms } => SESSION_DURATIONS_MS.contains(duration_ms),
        AgentSessionAuthorization::Call { method, params_digest, valid_for_ms, single_use } =>
            sha(params_digest) && *valid_for_ms == CALL_TTL_MS && *single_use &&
            (*method != AgentCallMethod::ResourceRead || s.tool_class == AgentToolClass::Read),
    }
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum AgentSessionReviewAuthorization {
    Session {
        #[serde(rename = "durationMs")]
        duration_ms: u64,
    },
    Call {
        method: AgentCallMethod,
        #[serde(rename = "paramsDigest")]
        params_digest: String,
        #[serde(rename = "validForMs")]
        valid_for_ms: u64,
        #[serde(rename = "singleUse")]
        single_use: bool,
        target: String,
    },
}

impl AgentSessionReviewAuthorization {
    fn signed(&self) -> AgentSessionAuthorization {
        match self {
            Self::Session { duration_ms } => AgentSessionAuthorization::Session {
                duration_ms: *duration_ms,
            },
            Self::Call {
                method,
                params_digest,
                valid_for_ms,
                single_use,
                ..
            } => AgentSessionAuthorization::Call {
                method: method.clone(),
                params_digest: params_digest.clone(),
                valid_for_ms: *valid_for_ms,
                single_use: *single_use,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionReviewSubject {
    pub principal: AgentSessionPrincipal,
    pub account: String,
    pub tool_class: AgentToolClass,
    pub authorization: AgentSessionReviewAuthorization,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReviewWire {
    principal: AgentSessionPrincipal,
    account: String,
    tool_class: AgentToolClass,
    authorization: AgentSessionReviewAuthorization,
}

impl<'de> Deserialize<'de> for AgentSessionReviewSubject {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        let wire: ReviewWire = super::decode_from(decoder, "STATEMENT_INVALID")?;
        let subject = Self {
            principal: wire.principal,
            account: wire.account,
            tool_class: wire.tool_class,
            authorization: wire.authorization,
        };
        if !subject.valid() {
            return Err(serde::de::Error::custom("STATEMENT_INVALID"));
        }
        Ok(subject)
    }
}

impl AgentSessionReviewSubject {
    pub fn valid(&self) -> bool {
        if !id(&self.principal.id) || !id(&self.account) {
            return false;
        }
        match &self.authorization {
            AgentSessionReviewAuthorization::Session { duration_ms } => {
                SESSION_DURATIONS_MS.contains(duration_ms)
            }
            AgentSessionReviewAuthorization::Call {
                method,
                target,
                params_digest,
                valid_for_ms,
                single_use,
            } => {
                if !sha(params_digest) || *valid_for_ms != CALL_TTL_MS || !single_use {
                    return false;
                }
                match method {
                    AgentCallMethod::ToolCall => {
                        tool_class(target).as_ref() == Some(&self.tool_class)
                    }
                    AgentCallMethod::ResourceRead => {
                        self.tool_class == AgentToolClass::Read
                            && ["conversation", "message", "draft", "send-request"]
                                .iter()
                                .any(|kind| {
                                    target
                                        .strip_prefix(&format!("draftyak://{kind}/"))
                                        .is_some_and(id)
                                })
                    }
                }
            }
        }
    }
}

fn tool_class(name: &str) -> Option<AgentToolClass> {
    match name {
        "accounts_list"
        | "contacts_search"
        | "conversation_get"
        | "conversations_list"
        | "draft_get"
        | "drafts_list"
        | "message_get"
        | "messages_search"
        | "send_request_status" => Some(AgentToolClass::Read),
        "conversation_archive" | "conversation_label" | "conversation_mark_read" => {
            Some(AgentToolClass::Organize)
        }
        "draft_create"
        | "draft_update"
        | "draft_discard"
        | "send_request_create"
        | "send_request_cancel" => Some(AgentToolClass::Draft),
        _ => None,
    }
}

impl AgentSessionStatement {
    /// Checks item fields only; callers still verify signature, PIN, freshness and consumption.
    pub fn matches_pending(&self, session: &str, subject: &AgentSessionReviewSubject) -> bool {
        self.valid()
            && subject.valid()
            && self.session == session
            && self.principal == subject.principal
            && self.account == subject.account
            && self.tool_class == subject.tool_class
            && self.authorization == subject.authorization.signed()
    }
}
