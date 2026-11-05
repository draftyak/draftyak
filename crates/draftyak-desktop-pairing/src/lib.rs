//! Native desktop pairing workflow for one device pairing attempt at a time: consent, claim,
//! reveal, comparison and completion correlated with the hub's confirmation, in the order of
//! M1.21b's commit-reveal revision of spec/pairing-v1.md.
//!
//! The state machine performs no I/O, reads time only from the injected [`Clock`] and computes
//! no claim, proof, commitment, nonce or comparison code: the native session holds those values.
//! Owner actions never confirm a device. The hub's answers reach an attempt only through the
//! [`HubLink`] that its consent handed to the native session, and the attempt completes only on
//! the hub's correlated confirmation after the owner has acknowledged the comparison. The code's
//! expiry bounds the attempt until the reveal holds. Once the hub has accepted a claim from a
//! code, the code is spent: no later attempt of this workflow claims from it, nor of a workflow
//! built with its [`Pairing::spent_codes`] and [`Pairing::clock_floor_ms`]. No [`Projection`]
//! carries native values. When an attempt ends, its code, session and comparison are dropped; a
//! [`Completion`] hands the session back instead.
//!
//! M4.11 handoff: only the trusted pairing surface calls [`Pairing::consent`],
//! [`Pairing::acknowledge`], [`Pairing::decline`] and [`Pairing::comparison`]; the renderer gets
//! [`Pairing::projection`] and [`Pairing::cancel`]. A device keeps one live [`Pairing`]: the next
//! is built with [`Pairing::with_floor`] only after the last one is dropped, from what the native
//! store read of it, [`Pairing::spent_codes`] first and then [`Pairing::clock_floor_ms`].
#![forbid(unsafe_code)]

use std::{
    fmt, mem,
    sync::atomic::{AtomicU64, Ordering},
};

/// The caller's UTC clock, in milliseconds. The workflow keeps its latest reading and never goes
/// back from it, so one reading far ahead expires every later code and attempt of that workflow.
pub trait Clock {
    fn now_ms(&self) -> u64;
}

impl<F: Fn() -> u64> Clock for F {
    fn now_ms(&self) -> u64 {
        self()
    }
}

/// A natively decoded pairing code. Every value comes from the one decoded payload that the
/// native session later pins and claims with.
pub trait PairingCode {
    /// `hid`, the SHA-256 of the hub's SPKI. Consent shows its `DYK-` ID.
    fn hub_pin(&self) -> [u8; 32];
    /// The hub's display name, shown for consent.
    fn hub_name(&self) -> String;
    /// The raw `pid` bytes, which name the code's window.
    fn window_id(&self) -> [u8; 16];
    /// `exp`, in UTC milliseconds.
    fn expires_at_ms(&self) -> u64;
}

/// What consent shows: the hub's display name and the `DYK-` ID of the pin that the attempt's
/// answers must come from.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HubPreview {
    pub name: String,
    pub hub_id: String,
}

// `DYK-` and the first 16 hex digits of the pin in upper case, in groups of four.
fn hub_id(pin: &[u8; 32]) -> String {
    let digits: String = pin[..8].iter().map(|byte| format!("{byte:02X}")).collect();
    format!(
        "DYK-{}-{}-{}-{}",
        &digits[..4],
        &digits[4..8],
        &digits[8..12],
        &digits[12..]
    )
}

/// Names one attempt. No value is issued twice in a process.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct AttemptId(u64);

impl AttemptId {
    pub fn new(raw: u64) -> Self {
        Self(raw)
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

static NEXT_ATTEMPT: AtomicU64 = AtomicU64::new(1);

// Issues 1 to u64::MAX - 1 once each; at u64::MAX the counter stays put and issues nothing.
fn allocate(counter: &AtomicU64) -> Option<AttemptId> {
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |next| {
            next.checked_add(1)
        })
        .ok()
        .map(AttemptId)
}

/// How a native session reports the hub's answers on its attempt. Only consent makes one, for
/// the session it starts; nothing in a projection can stand in for it.
#[derive(Debug)]
pub struct HubLink {
    attempt_id: AttemptId,
}

impl HubLink {
    pub fn attempt(&self) -> AttemptId {
        self.attempt_id
    }
}

/// The claimed device as the hub's claim answer names it: its id and the hub's epoch.
#[derive(Clone, Eq, PartialEq)]
pub struct DeviceRef {
    id: String,
    epoch: u64,
}

impl DeviceRef {
    pub fn new(id: impl Into<String>, epoch: u64) -> Self {
        Self {
            id: id.into(),
            epoch,
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

impl fmt::Debug for DeviceRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("DeviceRef([redacted])")
    }
}

/// A code whose claim the hub accepted: the window it names and its expiry. A native store keeps
/// it until then for later workflows, so that the device reveals once for each code.
#[derive(Clone, Copy, Eq, PartialEq)]
pub struct SpentCode {
    window_id: [u8; 16],
    expires_at_ms: u64,
}

impl SpentCode {
    pub fn new(window_id: [u8; 16], expires_at_ms: u64) -> Self {
        Self {
            window_id,
            expires_at_ms,
        }
    }

    pub fn window_id(&self) -> [u8; 16] {
        self.window_id
    }

    pub fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

impl fmt::Debug for SpentCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SpentCode([redacted])")
    }
}

/// The hub's answers on the attempt's pinned connection, as its native session reports them.
pub enum HubEvent<S> {
    /// The hub accepted the claim and named the device and epoch. The claim's commitment `c` and
    /// the answer's nonce `nh` stay with the native session, which reveals `nd` only after
    /// [`Pairing::hub_event`] has applied this answer. From then on the code is spent.
    ClaimAccepted(DeviceRef),
    /// The hub accepted the reveal. `S` is the comparison the native session derived for the
    /// trusted surface; this crate neither computes nor reads it.
    RevealAccepted(S),
    /// The hub's confirmation authority confirmed the claimed device.
    Confirmed(DeviceRef),
    /// The hub refused the claim, the reveal or the pending device.
    Refused,
    /// The native session lost the hub and gave the attempt up.
    Disconnected,
}

impl<S> fmt::Debug for HubEvent<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ClaimAccepted(_) => "ClaimAccepted",
            Self::RevealAccepted(_) => "RevealAccepted",
            Self::Confirmed(_) => "Confirmed",
            Self::Refused => "Refused",
            Self::Disconnected => "Disconnected",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Phase {
    Idle,
    AwaitingConsent,
    /// The native session connects and claims.
    Claiming,
    /// The hub accepted the claim; the native session reveals.
    Revealing,
    /// The reveal held; the trusted surface shows the comparison.
    Comparing,
    /// The owner acknowledged the comparison; only the hub's confirmation completes.
    AwaitingConfirmation,
    Confirmed,
    Cancelled,
    Expired,
    Failed(Failure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Failure {
    Refused,
    Transport,
    Declined,
    Mismatch,
    OutOfOrder,
}

/// The renderer-safe view: no code, address, pin, window, device or comparison material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Projection {
    pub attempt: Option<AttemptId>,
    pub phase: Phase,
    pub hub: Option<HubPreview>,
    pub deadline_ms: Option<u64>,
}

/// A confirmed attempt: the pinned hub and the confirmed device for the native device store,
/// with the native session handed back so that the caller decides when it stops.
pub struct Completion<H> {
    attempt: AttemptId,
    hub_pin: [u8; 32],
    device: DeviceRef,
    session: H,
}

impl<H> Completion<H> {
    pub fn attempt(&self) -> AttemptId {
        self.attempt
    }

    pub fn hub_pin(&self) -> [u8; 32] {
        self.hub_pin
    }

    pub fn device(&self) -> &DeviceRef {
        &self.device
    }

    pub fn into_session(self) -> H {
        self.session
    }
}

impl<H> fmt::Debug for Completion<H> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Completion({}, [redacted])", self.attempt.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Refusal {
    NoAttempt,
    Stale,
    Closed,
    Expired,
    OutOfOrder,
    Mismatch,
    Busy,
    AlreadyPaired,
    CodeUsed,
    AwaitingOwner,
    StartFailed,
    Exhausted,
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NoAttempt => "no pairing attempt",
            Self::Stale => "not the current pairing attempt",
            Self::Closed => "the pairing attempt has ended",
            Self::Expired => "the pairing attempt expired",
            Self::OutOfOrder => "not valid at this step of pairing",
            Self::Mismatch => "the answer names another hub, window or device",
            Self::Busy => "a pairing attempt is already in progress",
            Self::AlreadyPaired => "this device is already paired",
            Self::CodeUsed => "this pairing code has already been used",
            Self::AwaitingOwner => "the owner has not acknowledged the comparison",
            Self::StartFailed => "the native pairing session could not start",
            Self::Exhausted => "no attempt identifiers remain",
        })
    }
}

impl std::error::Error for Refusal {}

/// A content-free failure from the native session starter.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeError;

#[derive(Clone, Copy)]
enum Ending {
    Confirmed,
    Cancelled,
    Expired,
    Failed(Failure),
}

enum Stage<C, H, S> {
    AwaitingConsent(C),
    Claiming(H),
    Revealing(H, DeviceRef),
    Comparing(H, DeviceRef, S),
    AwaitingConfirmation(H, DeviceRef, S),
    Ended(Ending),
}

struct Attempt<C, H, S> {
    id: AttemptId,
    hub: HubPreview,
    hub_pin: [u8; 32],
    window_id: [u8; 16],
    expires_at_ms: u64,
    deadline_ms: u64,
    stage: Stage<C, H, S>,
}

impl<C, H, S> Attempt<C, H, S> {
    fn phase(&self) -> Phase {
        match &self.stage {
            Stage::AwaitingConsent(_) => Phase::AwaitingConsent,
            Stage::Claiming(_) => Phase::Claiming,
            Stage::Revealing(..) => Phase::Revealing,
            Stage::Comparing(..) => Phase::Comparing,
            Stage::AwaitingConfirmation(..) => Phase::AwaitingConfirmation,
            Stage::Ended(Ending::Confirmed) => Phase::Confirmed,
            Stage::Ended(Ending::Cancelled) => Phase::Cancelled,
            Stage::Ended(Ending::Expired) => Phase::Expired,
            Stage::Ended(Ending::Failed(failure)) => Phase::Failed(*failure),
        }
    }

    fn active(&self) -> bool {
        !matches!(self.stage, Stage::Ended(_))
    }

    fn end(&mut self, ending: Ending) {
        self.stage = Stage::Ended(ending);
    }
}

fn current<C, H, S>(
    slot: &mut Option<Attempt<C, H, S>>,
    id: AttemptId,
) -> Result<&mut Attempt<C, H, S>, Refusal> {
    let current = slot.as_mut().ok_or(Refusal::NoAttempt)?;
    if current.id != id {
        return Err(Refusal::Stale);
    }
    match current.stage {
        Stage::Ended(Ending::Expired) => Err(Refusal::Expired),
        Stage::Ended(_) => Err(Refusal::Closed),
        _ => Ok(current),
    }
}

/// One device pairing attempt at a time. `C` is the decoded code, `H` the running native session
/// and `S` the opaque comparison for the trusted surface. A call that ends an attempt drops its
/// session before returning, so dropping `H` must stop its native work without waiting on
/// anything that calls into this workflow.
///
/// A device keeps one live workflow. Workflows share nothing but what the native store keeps
/// from [`Pairing::spent_codes`] and [`Pairing::clock_floor_ms`], so the next one is built from
/// those with [`Pairing::with_floor`] only after this one is dropped.
pub struct Pairing<C, H, S, K> {
    clock: K,
    confirm_within_ms: u64,
    latest_ms: u64,
    floor_ms: u64,
    spent: Vec<SpentCode>,
    attempt: Option<Attempt<C, H, S>>,
}

impl<C, H, S, K> fmt::Debug for Pairing<C, H, S, K> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pairing")
            .field("projection", &self.snapshot())
            .finish()
    }
}

impl<C, H, S, K> Pairing<C, H, S, K> {
    fn snapshot(&self) -> Projection {
        match &self.attempt {
            None => Projection {
                attempt: None,
                phase: Phase::Idle,
                hub: None,
                deadline_ms: None,
            },
            Some(attempt) => Projection {
                attempt: Some(attempt.id),
                phase: attempt.phase(),
                hub: Some(attempt.hub.clone()),
                deadline_ms: attempt.active().then_some(attempt.deadline_ms),
            },
        }
    }
}

impl<C: PairingCode, H, S, K: Clock> Pairing<C, H, S, K> {
    /// The code's expiry bounds consent, the claim and the reveal, as the hub's window does; once
    /// the hub accepts the reveal, the attempt must be confirmed within `confirm_within_ms`. An
    /// attempt is still open at its deadline and expires after it; a deadline past `u64::MAX`
    /// saturates there.
    pub fn new(clock: K, confirm_within_ms: u64) -> Self {
        Self::with_spent(clock, confirm_within_ms, Vec::new())
    }

    /// As [`Pairing::new`], with the codes that earlier workflows spent, as the native store kept
    /// them from [`Pairing::spent_codes`]. It keeps no clock floor: with the clock set back, a
    /// spent code that had expired before the store read them can be revealed again, so a restart
    /// uses [`Pairing::with_floor`].
    pub fn with_spent(
        clock: K,
        confirm_within_ms: u64,
        spent: impl IntoIterator<Item = SpentCode>,
    ) -> Self {
        Self::with_floor(clock, confirm_within_ms, 0, spent)
    }

    /// As [`Pairing::with_spent`], for a workflow that never reads time below `floor_ms`: the
    /// [`Pairing::clock_floor_ms`] that the native store kept with those codes. A spent code that
    /// had expired before the store read them stays expired, however far back the clock is set
    /// across a restart.
    pub fn with_floor(
        clock: K,
        confirm_within_ms: u64,
        floor_ms: u64,
        spent: impl IntoIterator<Item = SpentCode>,
    ) -> Self {
        Self {
            clock,
            confirm_within_ms,
            latest_ms: floor_ms,
            floor_ms,
            spent: spent.into_iter().collect(),
            attempt: None,
        }
    }

    pub fn projection(&mut self) -> Projection {
        self.refresh();
        self.snapshot()
    }

    /// Native only: the spent codes that have not expired. A code is spent once
    /// [`Pairing::hub_event`] has applied the hub's acceptance of its claim, and the native store
    /// keeps these, with [`Pairing::clock_floor_ms`], before the session reveals.
    pub fn spent_codes(&mut self) -> Vec<SpentCode> {
        self.refresh();
        self.spent.clone()
    }

    /// Native only: one past the latest expiry among the spent codes that have expired, or the
    /// floor this workflow was built with when that is later, so a clock reading far ahead does
    /// not carry over. The native store reads it after [`Pairing::spent_codes`], since a floor read
    /// first misses a code that expires before those are read, and keeps both for
    /// [`Pairing::with_floor`].
    pub fn clock_floor_ms(&mut self) -> u64 {
        self.refresh();
        self.floor_ms
    }

    /// Expires the current attempt once its deadline has passed. It names the attempt only when
    /// this call expired it: every other call, a projection included, applies the expiry too.
    pub fn tick(&mut self) -> Option<AttemptId> {
        let active = self.attempt.as_ref().filter(|a| a.active()).map(|a| a.id);
        self.refresh();
        active.filter(|_| {
            self.attempt
                .as_ref()
                .is_some_and(|a| matches!(a.stage, Stage::Ended(Ending::Expired)))
        })
    }

    /// Holds a natively decoded code for the owner's consent. Nothing starts. A code naming the
    /// window of a spent code is refused until that spent code expires, whatever its own expiry.
    pub fn stage(&mut self, code: C) -> Result<AttemptId, Refusal> {
        self.stage_with(&NEXT_ATTEMPT, code)
    }

    fn stage_with(&mut self, ids: &AtomicU64, code: C) -> Result<AttemptId, Refusal> {
        let now = self.refresh();
        if let Some(attempt) = &self.attempt {
            if matches!(attempt.stage, Stage::Ended(Ending::Confirmed)) {
                return Err(Refusal::AlreadyPaired);
            }
            if attempt.active() {
                return Err(Refusal::Busy);
            }
        }
        let expires_at_ms = code.expires_at_ms();
        if now > expires_at_ms {
            return Err(Refusal::Expired);
        }
        let window_id = code.window_id();
        if self.spent.iter().any(|spent| spent.window_id == window_id) {
            return Err(Refusal::CodeUsed);
        }
        let id = allocate(ids).ok_or(Refusal::Exhausted)?;
        let hub_pin = code.hub_pin();
        self.attempt = Some(Attempt {
            id,
            hub: HubPreview {
                name: code.hub_name(),
                hub_id: hub_id(&hub_pin),
            },
            hub_pin,
            window_id,
            expires_at_ms,
            deadline_ms: expires_at_ms,
            stage: Stage::AwaitingConsent(code),
        });
        Ok(id)
    }

    /// The owner's consent. Only here does `start` receive the code, with the attempt's
    /// [`HubLink`], and return the running native session; it reports answers later, never from
    /// inside `start`. Only the trusted pairing surface calls this: the renderer gets
    /// [`Pairing::projection`] and [`Pairing::cancel`].
    pub fn consent<F>(&mut self, attempt: AttemptId, start: F) -> Result<(), Refusal>
    where
        F: FnOnce(C, HubLink) -> Result<H, NativeError>,
    {
        self.refresh();
        let current = current(&mut self.attempt, attempt)?;
        match mem::replace(
            &mut current.stage,
            Stage::Ended(Ending::Failed(Failure::Transport)),
        ) {
            Stage::AwaitingConsent(code) => {
                let link = HubLink {
                    attempt_id: current.id,
                };
                let session = start(code, link).map_err(|_| Refusal::StartFailed)?;
                current.stage = Stage::Claiming(session);
                Ok(())
            }
            other => {
                current.stage = other;
                Err(Refusal::OutOfOrder)
            }
        }
    }

    /// The owner's acknowledgement that both screens show the same comparison. It grants
    /// nothing: only the hub's later confirmation completes the attempt. Only the trusted pairing
    /// surface calls this: the renderer gets [`Pairing::projection`] and [`Pairing::cancel`].
    pub fn acknowledge(&mut self, attempt: AttemptId) -> Result<(), Refusal> {
        self.refresh();
        let current = current(&mut self.attempt, attempt)?;
        match mem::replace(
            &mut current.stage,
            Stage::Ended(Ending::Failed(Failure::OutOfOrder)),
        ) {
            Stage::Comparing(session, device, comparison) => {
                current.stage = Stage::AwaitingConfirmation(session, device, comparison);
                Ok(())
            }
            other => {
                current.stage = other;
                Err(Refusal::OutOfOrder)
            }
        }
    }

    /// The owner saw different comparisons: the attempt fails. Only the trusted pairing surface
    /// calls this: the renderer gets [`Pairing::projection`] and [`Pairing::cancel`].
    pub fn decline(&mut self, attempt: AttemptId) -> Result<(), Refusal> {
        self.refresh();
        let current = current(&mut self.attempt, attempt)?;
        if !matches!(
            current.stage,
            Stage::Comparing(..) | Stage::AwaitingConfirmation(..)
        ) {
            return Err(Refusal::OutOfOrder);
        }
        current.end(Ending::Failed(Failure::Declined));
        Ok(())
    }

    pub fn cancel(&mut self, attempt: AttemptId) -> Result<(), Refusal> {
        self.refresh();
        current(&mut self.attempt, attempt)?.end(Ending::Cancelled);
        Ok(())
    }

    /// Native only: no projection carries it. Only the trusted pairing surface calls this, to show
    /// it: the renderer gets [`Pairing::projection`] and [`Pairing::cancel`].
    pub fn comparison(&mut self, attempt: AttemptId) -> Result<&S, Refusal> {
        self.refresh();
        match &current(&mut self.attempt, attempt)?.stage {
            Stage::Comparing(_, _, comparison) | Stage::AwaitingConfirmation(_, _, comparison) => {
                Ok(comparison)
            }
            _ => Err(Refusal::OutOfOrder),
        }
    }

    /// Applies one hub answer that the native session received on the connection pinned to
    /// `hub_pin`, for the window `window_id`. A link for another attempt changes nothing.
    /// Another hub or window, or an answer out of order, ends the attempt. Only `Confirmed`, for
    /// the claimed device and after the owner's acknowledgement, completes it; before the
    /// acknowledgement it is refused with [`Refusal::AwaitingOwner`] and changes nothing, so the
    /// session reports the hub's confirmation again after [`Pairing::acknowledge`], for example
    /// from its next status poll.
    pub fn hub_event(
        &mut self,
        link: &HubLink,
        hub_pin: [u8; 32],
        window_id: [u8; 16],
        event: HubEvent<S>,
    ) -> Result<Option<Completion<H>>, Refusal> {
        let now = self.refresh();
        let current = current(&mut self.attempt, link.attempt())?;
        if hub_pin != current.hub_pin || window_id != current.window_id {
            current.end(Ending::Failed(Failure::Mismatch));
            return Err(Refusal::Mismatch);
        }
        let stage = mem::replace(
            &mut current.stage,
            Stage::Ended(Ending::Failed(Failure::OutOfOrder)),
        );
        match (stage, event) {
            (Stage::Claiming(session), HubEvent::ClaimAccepted(device)) => {
                self.spent
                    .push(SpentCode::new(current.window_id, current.expires_at_ms));
                current.stage = Stage::Revealing(session, device);
                Ok(None)
            }
            (Stage::Revealing(session, device), HubEvent::RevealAccepted(comparison)) => {
                current.deadline_ms = now.saturating_add(self.confirm_within_ms);
                current.stage = Stage::Comparing(session, device, comparison);
                Ok(None)
            }
            (Stage::Comparing(session, device, comparison), HubEvent::Confirmed(confirmed)) => {
                if confirmed != device {
                    current.end(Ending::Failed(Failure::Mismatch));
                    return Err(Refusal::Mismatch);
                }
                current.stage = Stage::Comparing(session, device, comparison);
                Err(Refusal::AwaitingOwner)
            }
            (
                Stage::AwaitingConfirmation(session, device, comparison),
                HubEvent::Confirmed(confirmed),
            ) => {
                drop(comparison);
                if confirmed != device {
                    current.end(Ending::Failed(Failure::Mismatch));
                    return Err(Refusal::Mismatch);
                }
                current.end(Ending::Confirmed);
                Ok(Some(Completion {
                    attempt: current.id,
                    hub_pin: current.hub_pin,
                    device,
                    session,
                }))
            }
            (
                Stage::Claiming(_)
                | Stage::Revealing(..)
                | Stage::Comparing(..)
                | Stage::AwaitingConfirmation(..),
                HubEvent::Refused,
            ) => {
                current.end(Ending::Failed(Failure::Refused));
                Ok(None)
            }
            (
                Stage::Claiming(_)
                | Stage::Revealing(..)
                | Stage::Comparing(..)
                | Stage::AwaitingConfirmation(..),
                HubEvent::Disconnected,
            ) => {
                current.end(Ending::Failed(Failure::Transport));
                Ok(None)
            }
            _ => Err(Refusal::OutOfOrder),
        }
    }

    fn refresh(&mut self) -> u64 {
        let now = self.clock.now_ms().max(self.latest_ms);
        self.latest_ms = now;
        // A code dropped here stays expired: readings never go back, and a workflow built with the
        // floor reads none at or below its expiry.
        self.spent.retain(|code| {
            let live = now <= code.expires_at_ms;
            if !live {
                self.floor_ms = self.floor_ms.max(code.expires_at_ms + 1);
            }
            live
        });
        if let Some(attempt) = &mut self.attempt
            && attempt.active()
            && now > attempt.deadline_ms
        {
            attempt.end(Ending::Expired);
        }
        now
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Code;

    impl PairingCode for Code {
        fn hub_pin(&self) -> [u8; 32] {
            [1; 32]
        }
        fn hub_name(&self) -> String {
            "Hub".into()
        }
        fn window_id(&self) -> [u8; 16] {
            [2; 16]
        }
        fn expires_at_ms(&self) -> u64 {
            u64::MAX
        }
    }

    #[test]
    fn attempt_ids_are_never_reused_or_wrapped() {
        let counter = AtomicU64::new(u64::MAX - 1);
        assert_eq!(allocate(&counter), Some(AttemptId(u64::MAX - 1)));
        assert_eq!(allocate(&counter), None);
        assert_eq!(allocate(&counter), None);
        assert_eq!(counter.load(Ordering::Relaxed), u64::MAX);
    }

    #[test]
    fn staging_is_refused_once_attempt_ids_run_out() {
        let ids = AtomicU64::new(u64::MAX - 1);
        let mut fresh: Pairing<Code, (), (), _> = Pairing::new(|| 0, 0);
        let mut used: Pairing<Code, (), (), _> = Pairing::new(|| 0, 0);
        let last = used.stage_with(&ids, Code).unwrap();
        assert_eq!(last, AttemptId(u64::MAX - 1));
        used.cancel(last).unwrap();
        assert_eq!(used.stage_with(&ids, Code), Err(Refusal::Exhausted));
        let projection = used.projection();
        assert_eq!(projection.attempt, Some(last));
        assert_eq!(projection.phase, Phase::Cancelled);
        assert_eq!(fresh.stage_with(&ids, Code), Err(Refusal::Exhausted));
        assert_eq!(fresh.projection().phase, Phase::Idle);
    }
}
