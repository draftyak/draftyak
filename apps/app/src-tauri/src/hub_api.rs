//! The ordinary desktop's bounded device-status adapter and event DATA codecs.
//! Window admission and the original request/task registry belong to the native host.
//! This module accepts no network address, authentication headers or peer claims.

use std::fmt;

use draftyak_protocol::{device_api, jcs};
use draftyak_transport::tls::PinnedConnection;

use crate::native_status::{
    DeviceStatusData, NativeStatusError, NativeStatusProbe, NativeStatusResources,
};

pub const STATUS_RESPONSE_BYTES: usize = 1_024;
pub const EVENTS_REQUEST_BYTES: usize = 1_024;
pub const EVENT_FRAME_BYTES: usize = 65_536;

/// A route selector, not authorization. Other Hub read contracts are not admitted here.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HubReadRoute {
    Status,
}

impl HubReadRoute {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "status" => Some(Self::Status),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Status => "status",
        }
    }

    pub fn method(self) -> &'static str {
        "GET"
    }

    pub fn path(self) -> &'static str {
        "/device/v1/status"
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HubApiError {
    InvalidResponse,
    CleanupIncomplete,
    /// Preserve the primary request failure separately from cleanup uncertainty.
    Status {
        primary: NativeStatusError,
        cleanup_incomplete: bool,
    },
    InvalidEventsRequest,
    InvalidEventFrame,
    EventStreamEnded,
}

impl fmt::Display for HubApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidResponse => "invalid native status response",
            Self::CleanupIncomplete => "native request cleanup incomplete",
            Self::Status { .. } => "native status request failed",
            Self::InvalidEventsRequest => "invalid events request",
            Self::InvalidEventFrame => "invalid event frame",
            Self::EventStreamEnded => "event stream ended",
        })
    }
}

impl std::error::Error for HubApiError {}

/// A schema-validated HTTP response for the renderer, with no local authority claim.
pub struct HubReply {
    status: u16,
    body: Vec<u8>,
}

impl HubReply {
    pub fn status(&self) -> u16 {
        self.status
    }

    pub fn body(&self) -> &[u8] {
        &self.body
    }
}

impl fmt::Debug for HubReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HubReply")
            .field("status", &self.status)
            .field("body", &"[redacted]")
            .finish()
    }
}

impl Drop for HubReply {
    fn drop(&mut self) {
        // An IPC recipient may own a separate copy. Clear only this native buffer.
        self.body.fill(0);
    }
}

/// Retain this same owner when execute is cancelled, then await close.
/// The original status probe owns and joins the actual HTTP driver.
pub struct NativeHubRequest {
    probe: NativeStatusProbe,
}

impl NativeHubRequest {
    pub fn new(connection: PinnedConnection) -> Self {
        Self {
            probe: NativeStatusProbe::new(connection),
        }
    }

    pub fn resource_status(&self) -> NativeStatusResources {
        // These are this owner's counters, not an OS-wide physical-close receipt.
        self.probe.resource_status()
    }

    pub async fn execute(&mut self) -> Result<HubReply, HubApiError> {
        let result = self.probe.probe().await;
        let resources = self.probe.resource_status();
        let cleanup_complete = resources.operation_completed
            && !resources.retained_connection
            && !resources.pending_driver
            && !resources.driver_failed;
        match result {
            Ok(data) if cleanup_complete => status_reply(&data),
            Ok(_) => Err(HubApiError::CleanupIncomplete),
            Err(NativeStatusError::Api { status, code }) if cleanup_complete => {
                api_error_reply(status, code)
            }
            Err(primary) => Err(HubApiError::Status {
                primary,
                cleanup_incomplete: !cleanup_complete,
            }),
        }
    }

    pub async fn close(&mut self) -> Result<(), NativeStatusError> {
        self.probe.close().await
    }
}

fn checked_reply(status: u16, bytes: Vec<u8>) -> Result<HubReply, HubApiError> {
    // Check received/produced bytes before either strict parser is called.
    if bytes.len() > STATUS_RESPONSE_BYTES
        || if status == 200 {
            !device_api::check_route_response_bytes("status", &bytes)
        } else {
            !device_api::check_api_error_bytes(&bytes, status)
        }
    {
        return Err(HubApiError::InvalidResponse);
    }
    let value = jcs::parse_strict(&bytes).map_err(|_| HubApiError::InvalidResponse)?;
    let canonical = jcs::canonicalize(&value).map_err(|_| HubApiError::InvalidResponse)?;
    if canonical.len() > STATUS_RESPONSE_BYTES {
        return Err(HubApiError::InvalidResponse);
    }
    Ok(HubReply {
        status,
        body: canonical.into_bytes(),
    })
}

fn status_reply(data: &DeviceStatusData) -> Result<HubReply, HubApiError> {
    // The real probe already bounded its response. Bound construction too, then
    // independently recheck all M1 fields; no handwritten capability admission.
    let mut string_bytes = data.device_id.len();
    if data.capabilities.len() > STATUS_RESPONSE_BYTES {
        return Err(HubApiError::InvalidResponse);
    }
    for capability in &data.capabilities {
        string_bytes = string_bytes
            .checked_add(capability.len())
            .ok_or(HubApiError::InvalidResponse)?;
        if string_bytes > STATUS_RESPONSE_BYTES {
            return Err(HubApiError::InvalidResponse);
        }
    }
    if string_bytes > STATUS_RESPONSE_BYTES {
        return Err(HubApiError::InvalidResponse);
    }
    let id = jcs::canonicalize(&data.device_id).map_err(|_| HubApiError::InvalidResponse)?;
    let capabilities =
        jcs::canonicalize(&data.capabilities).map_err(|_| HubApiError::InvalidResponse)?;
    let body = format!(
        "{{\"deviceId\":{id},\"epoch\":{},\"confirmed\":{},\"capabilities\":{capabilities},\"testUpstreams\":{}}}",
        data.epoch, data.confirmed, data.test_upstreams,
    );
    checked_reply(200, body.into_bytes())
}

fn api_error_reply(status: u16, code: &str) -> Result<HubReply, HubApiError> {
    if code.len() > STATUS_RESPONSE_BYTES {
        return Err(HubApiError::InvalidResponse);
    }
    let code = jcs::canonicalize(code).map_err(|_| HubApiError::InvalidResponse)?;
    checked_reply(status, format!("{{\"code\":{code}}}").into_bytes())
}

/// Canonical request DATA only. This does not open a socket or admit a device.
/// Actual events transport framing remains the native host's separate contract.
pub fn canonical_events_request(bytes: &[u8]) -> Result<Vec<u8>, HubApiError> {
    if bytes.len() > EVENTS_REQUEST_BYTES
        || !device_api::check_route_request_bytes("events", Some(bytes))
    {
        return Err(HubApiError::InvalidEventsRequest);
    }
    let value = jcs::parse_strict(bytes).map_err(|_| HubApiError::InvalidEventsRequest)?;
    let canonical = jcs::canonicalize(&value).map_err(|_| HubApiError::InvalidEventsRequest)?;
    if canonical.len() > EVENTS_REQUEST_BYTES {
        return Err(HubApiError::InvalidEventsRequest);
    }
    Ok(canonical.into_bytes())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EventFrameKind {
    Ready,
    Event,
    Reset,
}

/// Stream DATA validation only: ready is not authorization or complete history.
#[derive(Default)]
pub struct EventFrameValidator {
    started: bool,
    terminal: bool,
    failed: bool,
}

impl EventFrameValidator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn accept(&mut self, bytes: &[u8]) -> Result<EventFrameKind, HubApiError> {
        if self.terminal {
            return Err(HubApiError::EventStreamEnded);
        }
        let kind = self.check(bytes);
        match kind {
            Ok(kind) => {
                self.started = true;
                self.terminal = kind == EventFrameKind::Reset;
                Ok(kind)
            }
            Err(error) => {
                self.failed = true;
                self.terminal = true;
                Err(error)
            }
        }
    }

    fn check(&self, bytes: &[u8]) -> Result<EventFrameKind, HubApiError> {
        if bytes.len() > EVENT_FRAME_BYTES
            || !device_api::check_route_response_bytes("events", bytes)
        {
            return Err(HubApiError::InvalidEventFrame);
        }
        let value = jcs::parse_strict(bytes).map_err(|_| HubApiError::InvalidEventFrame)?;
        match value["type"].as_str() {
            Some("ready") => Ok(EventFrameKind::Ready),
            Some("event") if self.started => Ok(EventFrameKind::Event),
            Some("reset") => Ok(EventFrameKind::Reset),
            _ => Err(HubApiError::InvalidEventFrame),
        }
    }

    /// Checks only the observed frame sequence, never task, socket or peer closure.
    pub fn validate_end(&self) -> Result<(), HubApiError> {
        if !self.started || self.failed {
            Err(HubApiError::InvalidEventFrame)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const READY: &[u8] = br#"{"type":"ready","cursor":"cursor-a"}"#;
    const EVENT: &[u8] = br#"{"type":"event","cursor":"cursor-b","kind":"mail.changed","ids":["01ARZ3NDEKTSV4RRFFQ69G5FAV"]}"#;
    const RESET: &[u8] = br#"{"type":"reset","reason":"resync_required"}"#;

    fn status() -> DeviceStatusData {
        DeviceStatusData {
            device_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
            epoch: 1,
            confirmed: true,
            capabilities: vec!["read".into()],
            test_upstreams: false,
        }
    }

    #[test]
    fn only_the_status_route_is_exposed() {
        let route = HubReadRoute::from_id("status").unwrap();
        assert_eq!(route.id(), "status");
        assert_eq!(route.method(), "GET");
        assert_eq!(route.path(), "/device/v1/status");
        for id in [
            "send-review",
            "operation-review",
            "events",
            "/device/v1/status",
            "STATUS",
        ] {
            assert_eq!(HubReadRoute::from_id(id), None);
        }
    }

    #[test]
    fn canonical_status_data_is_independently_revalidated() {
        let reply = status_reply(&status()).unwrap();
        assert_eq!(reply.status(), 200);
        assert!(jcs::is_canonical(reply.body()));
        assert!(device_api::check_route_response_bytes(
            "status",
            reply.body()
        ));
        assert_eq!(jcs::parse_strict(reply.body()).unwrap()["epoch"], 1);
        let mut pending = status();
        pending.confirmed = false;
        pending.capabilities.clear();
        let reply = status_reply(&pending).unwrap();
        assert_eq!(jcs::parse_strict(reply.body()).unwrap()["confirmed"], false);
    }

    #[test]
    fn invalid_status_fields_and_received_overflow_are_refused() {
        let mut invalid = status();
        invalid.confirmed = false;
        assert!(matches!(
            status_reply(&invalid),
            Err(HubApiError::InvalidResponse)
        ));
        invalid = status();
        invalid.device_id = "not-a-native-id".into();
        assert!(matches!(
            status_reply(&invalid),
            Err(HubApiError::InvalidResponse)
        ));
        assert!(matches!(
            checked_reply(200, vec![b' '; STATUS_RESPONSE_BYTES + 1]),
            Err(HubApiError::InvalidResponse)
        ));
    }

    #[test]
    fn api_error_status_and_code_must_match_the_original_catalogue() {
        let reply = api_error_reply(403, "FORBIDDEN").unwrap();
        assert_eq!(reply.status(), 403);
        assert_eq!(reply.body(), br#"{"code":"FORBIDDEN"}"#);
        assert!(matches!(
            api_error_reply(403, "UNAVAILABLE"),
            Err(HubApiError::InvalidResponse)
        ));
        assert!(api_error_reply(503, "UNAVAILABLE").is_ok());
        assert!(matches!(
            api_error_reply(403, "UNKNOWN"),
            Err(HubApiError::InvalidResponse)
        ));
    }

    #[test]
    fn event_request_is_bounded_and_canonical_without_a_network_operation() {
        assert_eq!(
            canonical_events_request(br#" { "after" : null } "#).unwrap(),
            br#"{"after":null}"#
        );
        assert!(canonical_events_request(br#"{"after":null,"extra":true}"#).is_err());
        assert!(canonical_events_request(br#"{"after":null,"after":null}"#).is_err());
        assert!(canonical_events_request(&vec![b' '; EVENTS_REQUEST_BYTES + 1]).is_err());
    }

    #[test]
    fn ready_event_reset_is_valid_data_and_reset_ends_delivery() {
        let mut frames = EventFrameValidator::new();
        assert_eq!(frames.accept(READY), Ok(EventFrameKind::Ready));
        assert_eq!(frames.accept(EVENT), Ok(EventFrameKind::Event));
        assert_eq!(frames.accept(RESET), Ok(EventFrameKind::Reset));
        assert_eq!(frames.validate_end(), Ok(()));
        assert_eq!(frames.accept(EVENT), Err(HubApiError::EventStreamEnded));
    }

    #[test]
    fn a_reset_can_be_the_first_and_only_frame() {
        let mut frames = EventFrameValidator::new();
        assert_eq!(frames.accept(RESET), Ok(EventFrameKind::Reset));
        assert_eq!(frames.validate_end(), Ok(()));
        assert_eq!(frames.accept(READY), Err(HubApiError::EventStreamEnded));
    }

    #[test]
    fn first_event_and_later_recovery_are_refused() {
        let mut frames = EventFrameValidator::new();
        assert_eq!(frames.validate_end(), Err(HubApiError::InvalidEventFrame));
        assert_eq!(frames.accept(EVENT), Err(HubApiError::InvalidEventFrame));
        assert_eq!(frames.accept(READY), Err(HubApiError::EventStreamEnded));
        assert_eq!(frames.validate_end(), Err(HubApiError::InvalidEventFrame));
    }

    #[test]
    fn frame_bytes_and_duplicate_members_are_checked_before_delivery() {
        let mut oversized = EventFrameValidator::new();
        assert_eq!(
            oversized.accept(&vec![b' '; EVENT_FRAME_BYTES + 1]),
            Err(HubApiError::InvalidEventFrame)
        );
        let mut duplicate = EventFrameValidator::new();
        assert_eq!(
            duplicate.accept(br#"{"type":"ready","cursor":"a","cursor":"b"}"#),
            Err(HubApiError::InvalidEventFrame)
        );
    }
}
