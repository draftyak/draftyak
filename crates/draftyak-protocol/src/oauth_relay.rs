//! The Gmail code relay over L2: the calls the desktop's `oauth_assist` makes while the hub
//! connects a Gmail account. The hub keeps the state, PKCE, the code exchange and the flow; these
//! checks bind only the shapes, byte caps and admission both sides share.
use crate::{
    jcs::{canonicalize, parse_strict},
    sign::base64url_decode,
    statements::{
        common::{MAX_SAFE, id},
        decode,
        pair_confirm::DeviceCapability,
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use std::fmt;

pub const CALLBACK_PATH: &str = "/oauth/google/callback";
pub const GOOGLE_AUTHORIZATION_ORIGIN: &str = "https://accounts.google.com";
pub const GOOGLE_AUTHORIZATION_PATH: &str = "/o/oauth2/v2/auth";
pub const RESPONSE_BYTES: usize = 8192;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub id: &'static str,
    pub method: &'static str,
    pub path: &'static str,
    pub role: &'static str,
    pub confirmation: &'static str,
    pub capability: &'static str,
    pub request: &'static str,
    pub request_bytes: usize,
    pub response_bytes: usize,
    pub response: &'static str,
}
const fn route(
    id: &'static str,
    path: &'static str,
    request: &'static str,
    request_bytes: usize,
    response: &'static str,
) -> Route {
    Route {
        id,
        method: "POST",
        path,
        role: "device",
        confirmation: "confirmed",
        capability: "admin",
        request,
        request_bytes,
        response_bytes: RESPONSE_BYTES,
        response,
    }
}
// Connecting an account is an admin op, so every call needs a confirmed admin device.
pub const OAUTH_RELAY_ROUTES: &[Route] = &[
    route(
        "client",
        "/device/v1/accounts/gmail/flow/client",
        "GmailFlowClientRequest",
        32_768,
        "GmailFlowView",
    ),
    route(
        "authorize",
        "/device/v1/accounts/gmail/flow/authorize",
        "GmailFlowAuthorizeRequest",
        512,
        "GmailFlowAuthorization",
    ),
    route(
        "relay",
        "/device/v1/accounts/gmail/flow/relay",
        "GmailFlowRelayRequest",
        2048,
        "GmailFlowView",
    ),
];

pub fn catalogue() -> Value {
    json!({ "routes": OAUTH_RELAY_ROUTES })
}

fn find(name: &str) -> Option<&'static Route> {
    OAUTH_RELAY_ROUTES.iter().find(|r| r.id == name)
}

fn side(r: &Route, way: &str) -> Option<(&'static str, usize)> {
    match way {
        "request" => Some((r.request, r.request_bytes)),
        "response" => Some((r.response, r.response_bytes)),
        _ => None,
    }
}

pub fn check_route_length(name: &str, way: &str, byte_length: usize) -> bool {
    find(name)
        .and_then(|r| side(r, way))
        .is_some_and(|(_, cap)| byte_length <= cap)
}

fn visible_ascii(text: &str) -> bool {
    text.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

fn visible(text: &str, max: usize) -> bool {
    !text.is_empty() && text.len() <= max && visible_ascii(text)
}

struct UrlParts<'a> {
    scheme: &'a str,
    userinfo: Option<&'a str>,
    host: &'a str,
    path: &'a str,
    query: Option<&'a str>,
    fragment: Option<&'a str>,
}

// RFC 3986's split of an absolute URL, on visible ASCII only, so TS cuts at the same places.
fn split_url(text: &str) -> Option<UrlParts<'_>> {
    if !visible_ascii(text) {
        return None;
    }
    let (scheme, rest) = text.split_once("://")?;
    let (rest, fragment) = match rest.split_once('#') {
        Some((rest, fragment)) => (rest, Some(fragment)),
        None => (rest, None),
    };
    let (rest, query) = match rest.split_once('?') {
        Some((rest, query)) => (rest, Some(query)),
        None => (rest, None),
    };
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let (userinfo, host) = match authority.rsplit_once('@') {
        Some((userinfo, host)) => (Some(userinfo), host),
        None => (None, authority),
    };
    Some(UrlParts {
        scheme,
        userinfo,
        host,
        path,
        query,
        fragment,
    })
}

fn check_port(port: &str) -> bool {
    if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if port.len() > 1 && port.starts_with('0') {
        return false;
    }
    port.parse::<u32>().is_ok_and(|n| (1..=65_535).contains(&n))
}

/// Exactly `http://127.0.0.1:<port>/oauth/google/callback`, port 1-65535 without a leading zero.
pub fn check_redirect_uri(text: &str) -> bool {
    let Some(url) = split_url(text) else {
        return false;
    };
    if url.scheme != "http" {
        return false;
    }
    if url.userinfo.is_some() {
        return false;
    }
    if url.query.is_some() {
        return false;
    }
    if url.fragment.is_some() {
        return false;
    }
    if url.path != CALLBACK_PATH {
        return false;
    }
    url.host
        .rsplit_once(':')
        .is_some_and(|(host, port)| host == "127.0.0.1" && check_port(port))
}

/// 43 canonical base64url characters, which decode to exactly 32 bytes.
pub fn check_state(text: &str) -> bool {
    text.len() == 43 && base64url_decode(text).is_some_and(|bytes| bytes.len() == 32)
}

pub fn check_code(text: &str) -> bool {
    visible(text, 256)
}

pub fn check_client_id(text: &str) -> bool {
    visible(text, 512)
}

pub fn check_client_secret(text: &str) -> bool {
    visible(text, 4096)
}

// RFC 3986 query characters, with each percent sign starting a two-digit escape.
fn check_query(query: &str) -> bool {
    let bytes = query.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            let hex = |offset: usize| bytes.get(at + offset).is_some_and(u8::is_ascii_hexdigit);
            if !(hex(1) && hex(2)) {
                return false;
            }
            at += 3;
        } else if bytes[at].is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/?".contains(&bytes[at]) {
            at += 1;
        } else {
            return false;
        }
    }
    true
}

/// Google's fixed authorization origin and path; no userinfo or fragment; an RFC 3986 query.
pub fn check_authorization_url(text: &str) -> bool {
    let Some(url) = split_url(text) else {
        return false;
    };
    if url.userinfo.is_some() {
        return false;
    }
    if url.fragment.is_some() {
        return false;
    }
    if GOOGLE_AUTHORIZATION_ORIGIN.split_once("://") != Some((url.scheme, url.host)) {
        return false;
    }
    if url.path != GOOGLE_AUTHORIZATION_PATH {
        return false;
    }
    url.query.is_none_or(check_query)
}

fn shape(value: &Value, names: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|m| m.len() == names.len() && names.iter().all(|name| m.contains_key(*name)))
}
fn text<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field)?.as_str()
}
fn safe(value: &Value) -> bool {
    value.as_u64().is_some_and(|v| v <= MAX_SAFE)
}

fn client_request(value: &Value) -> bool {
    let client = &value["client"];
    shape(value, &["flowId", "client", "redirectUri"])
        && text(value, "flowId").is_some_and(id)
        && shape(client, &["clientId", "clientSecret"])
        && text(client, "clientId").is_some_and(check_client_id)
        && (client["clientSecret"].is_null()
            || text(client, "clientSecret").is_some_and(check_client_secret))
        && text(value, "redirectUri").is_some_and(check_redirect_uri)
}
fn relay_request(value: &Value) -> bool {
    shape(value, &["flowId", "state", "code", "redirectUri"])
        && text(value, "flowId").is_some_and(id)
        && text(value, "state").is_some_and(check_state)
        && text(value, "code").is_some_and(check_code)
        && text(value, "redirectUri").is_some_and(check_redirect_uri)
}
fn authorization(value: &Value) -> bool {
    shape(
        value,
        &["id", "authorizationUrl", "expiresAt", "remainingMs"],
    ) && text(value, "id").is_some_and(id)
        && text(value, "authorizationUrl").is_some_and(check_authorization_url)
        && safe(&value["expiresAt"])
        && safe(&value["remainingMs"])
}

/// Strict wire shapes. The hub's flow view is checked only as a JSON object.
pub fn check_schema(name: &str, value: &Value) -> bool {
    match name {
        "GmailFlowClientRequest" => client_request(value),
        "GmailFlowAuthorizeRequest" => {
            shape(value, &["flowId"]) && text(value, "flowId").is_some_and(id)
        }
        "GmailFlowRelayRequest" => relay_request(value),
        "GmailFlowAuthorization" => authorization(value),
        "GmailFlowView" => value.is_object(),
        _ => false,
    }
}

// Value form: check the value's canonical JSON as received bytes.
fn check_value(name: &str, way: &str, value: &Value) -> bool {
    canonicalize(value).is_ok_and(|text| receive(name, way, text.as_bytes()).is_some())
}

// Received form: the raw byte length is checked before the bytes are parsed.
fn receive(name: &str, way: &str, bytes: &[u8]) -> Option<Value> {
    let (schema, cap) = find(name).and_then(|r| side(r, way))?;
    if bytes.len() > cap {
        return None;
    }
    let value = parse_strict(bytes).ok()?;
    check_schema(schema, &value).then_some(value)
}

pub fn check_route_request(name: &str, value: &Value) -> bool {
    check_value(name, "request", value)
}
pub fn check_route_response(name: &str, value: &Value) -> bool {
    check_value(name, "response", value)
}
pub fn check_route_request_bytes(name: &str, bytes: &[u8]) -> bool {
    receive(name, "request", bytes).is_some()
}
pub fn check_route_response_bytes(name: &str, bytes: &[u8]) -> bool {
    receive(name, "response", bytes).is_some()
}

/// A known, non-revoked device confirmed in the current epoch that holds the route's capability,
/// given the device API's peer form.
pub fn route_allows(name: &str, peer: &Value) -> bool {
    let Some(r) = find(name) else {
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
    ) {
        return false;
    }
    let Some(held) = decode::<Vec<DeviceCapability>>(&peer["capabilities"]) else {
        return false;
    };
    peer["role"].is_string()
        && peer["known"].is_boolean()
        && peer["revoked"].is_boolean()
        && safe(&peer["epoch"])
        && (peer["confirmedEpoch"].is_null() || safe(&peer["confirmedEpoch"]))
        && peer["sidecarClaim"].is_boolean()
        && peer["bootstrapDone"].is_boolean()
        && held.iter().enumerate().all(|(i, c)| !held[..i].contains(c))
        && peer["known"] == true
        && peer["revoked"] == false
        && peer["role"] == r.role
        && peer["confirmedEpoch"] == peer["epoch"]
        && peer["capabilities"]
            .as_array()
            .is_some_and(|caps| caps.contains(&json!(r.capability)))
}

/// A refusal names only what was refused, never a submitted value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OAuthRelayError {
    #[error("OAuth relay request refused")]
    Request,
    #[error("OAuth relay response refused")]
    Response,
}

const REDACTED: &str = "[redacted]";

fn request_bytes(name: &str, value: &Value) -> Result<Vec<u8>, OAuthRelayError> {
    let text = canonicalize(value).map_err(|_| OAuthRelayError::Request)?;
    if check_route_request_bytes(name, text.as_bytes()) {
        Ok(text.into_bytes())
    } else {
        Err(OAuthRelayError::Request)
    }
}

/// The `client` call. Rust sends the client natively, so its secret never enters the webview.
pub struct GmailFlowClientRequest {
    flow_id: String,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
}
impl GmailFlowClientRequest {
    pub fn new(
        flow_id: &str,
        client_id: &str,
        client_secret: Option<&str>,
        redirect_uri: &str,
    ) -> Result<Self, OAuthRelayError> {
        if id(flow_id)
            && check_client_id(client_id)
            && client_secret.is_none_or(check_client_secret)
            && check_redirect_uri(redirect_uri)
        {
            Ok(Self {
                flow_id: flow_id.into(),
                client_id: client_id.into(),
                client_secret: client_secret.map(Into::into),
                redirect_uri: redirect_uri.into(),
            })
        } else {
            Err(OAuthRelayError::Request)
        }
    }
    /// The canonical JSON body.
    pub fn to_json(&self) -> Result<Vec<u8>, OAuthRelayError> {
        request_bytes(
            "client",
            &json!({
                "flowId": self.flow_id,
                "client": {"clientId": self.client_id, "clientSecret": self.client_secret},
                "redirectUri": self.redirect_uri,
            }),
        )
    }
}
impl fmt::Debug for GmailFlowClientRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GmailFlowClientRequest")
            .field("flow_id", &self.flow_id)
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| REDACTED),
            )
            .field("redirect_uri", &self.redirect_uri)
            .finish()
    }
}

/// The `authorize` call.
#[derive(Debug)]
pub struct GmailFlowAuthorizeRequest {
    flow_id: String,
}
impl GmailFlowAuthorizeRequest {
    pub fn new(flow_id: &str) -> Result<Self, OAuthRelayError> {
        if id(flow_id) {
            Ok(Self {
                flow_id: flow_id.into(),
            })
        } else {
            Err(OAuthRelayError::Request)
        }
    }
    /// The canonical JSON body.
    pub fn to_json(&self) -> Result<Vec<u8>, OAuthRelayError> {
        request_bytes("authorize", &json!({ "flowId": self.flow_id }))
    }
}

/// The `relay` call: what came back to the desktop's loopback listener.
pub struct GmailFlowRelayRequest {
    flow_id: String,
    state: String,
    code: String,
    redirect_uri: String,
}
impl GmailFlowRelayRequest {
    pub fn new(
        flow_id: &str,
        state: &str,
        code: &str,
        redirect_uri: &str,
    ) -> Result<Self, OAuthRelayError> {
        if id(flow_id) && check_state(state) && check_code(code) && check_redirect_uri(redirect_uri)
        {
            Ok(Self {
                flow_id: flow_id.into(),
                state: state.into(),
                code: code.into(),
                redirect_uri: redirect_uri.into(),
            })
        } else {
            Err(OAuthRelayError::Request)
        }
    }
    /// The canonical JSON body.
    pub fn to_json(&self) -> Result<Vec<u8>, OAuthRelayError> {
        request_bytes(
            "relay",
            &json!({
                "flowId": self.flow_id,
                "state": self.state,
                "code": self.code,
                "redirectUri": self.redirect_uri,
            }),
        )
    }
}
impl fmt::Debug for GmailFlowRelayRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GmailFlowRelayRequest")
            .field("flow_id", &self.flow_id)
            .field("state", &REDACTED)
            .field("code", &REDACTED)
            .field("redirect_uri", &self.redirect_uri)
            .finish()
    }
}

/// The `authorize` answer. Its URL carries the hub's state, so Debug leaves it out.
pub struct GmailFlowAuthorization {
    id: String,
    authorization_url: String,
    expires_at: u64,
    remaining_ms: u64,
}
impl GmailFlowAuthorization {
    /// Received bytes, refused over 8 KiB before parsing.
    pub fn from_json(bytes: &[u8]) -> Result<Self, OAuthRelayError> {
        let value = receive("authorize", "response", bytes).ok_or(OAuthRelayError::Response)?;
        let field = |name: &str| text(&value, name).unwrap_or_default().to_owned();
        let number = |name: &str| value[name].as_u64().unwrap_or_default();
        Ok(Self {
            id: field("id"),
            authorization_url: field("authorizationUrl"),
            expires_at: number("expiresAt"),
            remaining_ms: number("remainingMs"),
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn authorization_url(&self) -> &str {
        &self.authorization_url
    }
    pub fn expires_at(&self) -> u64 {
        self.expires_at
    }
    pub fn remaining_ms(&self) -> u64 {
        self.remaining_ms
    }
}
impl fmt::Debug for GmailFlowAuthorization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GmailFlowAuthorization")
            .field("id", &self.id)
            .field("authorization_url", &REDACTED)
            .field("expires_at", &self.expires_at)
            .field("remaining_ms", &self.remaining_ms)
            .finish()
    }
}
