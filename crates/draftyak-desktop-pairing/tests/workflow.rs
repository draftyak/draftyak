use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use draftyak_desktop_pairing::{
    AttemptId, Clock, Completion, DeviceRef, Failure, HubEvent, HubLink, HubPreview, NativeError,
    Pairing, PairingCode, Phase, Projection, Refusal, SpentCode,
};

const NAME: &str = "Workshop hub";
const HUB_ID: &str = "DYK-1234-5678-9ABC-DEF0";
// Only the first eight bytes are public (the DYK ID); 0xee and 0xd7 mark the rest.
const HUB_PIN: [u8; 32] = [
    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee,
    0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee,
];
const OTHER_HUB_PIN: [u8; 32] = [
    0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee,
    0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xee, 0xef,
];
const WINDOW: [u8; 16] = [0xd7; 16];
const OTHER_WINDOW: [u8; 16] = [
    0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd8,
];
// The window of a later code from the same hub.
const NEW_WINDOW: [u8; 16] = [
    0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd7, 0xd9,
];
const DEVICE_ID: &str = "01JBQ7ZK3D5Z9H2M4N6P8R0T2V";
const OTHER_DEVICE_ID: &str = "01JBQ7ZK3D5Z9H2M4N6P8R0T2W";
const EPOCH: u64 = 7;
const DIGITS: &str = "482019";
const START_MS: u64 = 1_000;
const EXPIRES_MS: u64 = 301_000;
const CONFIRM_WITHIN_MS: u64 = 600_000;
const ACTIVE: [Phase; 5] = [
    Phase::AwaitingConsent,
    Phase::Claiming,
    Phase::Revealing,
    Phase::Comparing,
    Phase::AwaitingConfirmation,
];

#[derive(Default)]
struct Counts {
    codes: Cell<i32>,
    sessions: Cell<i32>,
    comparisons: Cell<i32>,
    starts: Cell<i32>,
}

fn up(cell: &Cell<i32>) {
    cell.set(cell.get() + 1);
}

fn down(cell: &Cell<i32>) {
    cell.set(cell.get() - 1);
}

struct Code {
    pin: [u8; 32],
    window: [u8; 16],
    expires_at_ms: u64,
    counts: Rc<Counts>,
}

impl PairingCode for Code {
    fn hub_pin(&self) -> [u8; 32] {
        self.pin
    }
    fn hub_name(&self) -> String {
        NAME.into()
    }
    fn window_id(&self) -> [u8; 16] {
        self.window
    }
    fn expires_at_ms(&self) -> u64 {
        self.expires_at_ms
    }
}

impl Drop for Code {
    fn drop(&mut self) {
        down(&self.counts.codes);
    }
}

// The running native session owns the code it was started with, as a connection task would.
struct Session {
    _code: Code,
    counts: Rc<Counts>,
}

impl Drop for Session {
    fn drop(&mut self) {
        down(&self.counts.sessions);
    }
}

struct Comparison {
    digits: &'static str,
    counts: Rc<Counts>,
}

impl Drop for Comparison {
    fn drop(&mut self) {
        down(&self.counts.comparisons);
    }
}

struct TestClock(Rc<Cell<u64>>);

impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.0.get()
    }
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    Claim,
    Reveal,
    Confirm,
    Refuse,
    Disconnect,
}

const KINDS: [Kind; 5] = [
    Kind::Claim,
    Kind::Reveal,
    Kind::Confirm,
    Kind::Refuse,
    Kind::Disconnect,
];

type Outcome = Result<bool, Refusal>;

struct Harness {
    pairing: Pairing<Code, Session, Comparison, TestClock>,
    time: Rc<Cell<u64>>,
    counts: Rc<Counts>,
}

// An attempt driven to some phase, with its code's window and the link its consent minted.
struct Run {
    id: AttemptId,
    window: [u8; 16],
    link: Option<HubLink>,
}

impl Run {
    fn link(&self) -> &HubLink {
        self.link.as_ref().expect("a consented attempt")
    }
}

impl Harness {
    fn new() -> Self {
        Self::with_spent(Vec::new())
    }

    fn with_spent(spent: Vec<SpentCode>) -> Self {
        let time = Rc::new(Cell::new(START_MS));
        Self {
            pairing: Pairing::with_spent(TestClock(time.clone()), CONFIRM_WITHIN_MS, spent),
            time,
            counts: Rc::default(),
        }
    }

    fn at(&self, ms: u64) {
        self.time.set(ms);
    }

    fn code(&self) -> Code {
        self.code_for(HUB_PIN, WINDOW, EXPIRES_MS)
    }

    fn code_for(&self, pin: [u8; 32], window: [u8; 16], expires_at_ms: u64) -> Code {
        up(&self.counts.codes);
        Code {
            pin,
            window,
            expires_at_ms,
            counts: self.counts.clone(),
        }
    }

    fn comparison(&self) -> Comparison {
        up(&self.counts.comparisons);
        Comparison {
            digits: DIGITS,
            counts: self.counts.clone(),
        }
    }

    fn make(&self, kind: Kind) -> HubEvent<Comparison> {
        match kind {
            Kind::Claim => HubEvent::ClaimAccepted(device()),
            Kind::Reveal => HubEvent::RevealAccepted(self.comparison()),
            Kind::Confirm => HubEvent::Confirmed(device()),
            Kind::Refuse => HubEvent::Refused,
            Kind::Disconnect => HubEvent::Disconnected,
        }
    }

    fn stage(&mut self) -> AttemptId {
        let code = self.code();
        self.pairing.stage(code).unwrap()
    }

    fn try_consent(&mut self, id: AttemptId) -> Result<HubLink, Refusal> {
        let counts = self.counts.clone();
        let minted = Rc::new(RefCell::new(None));
        let keep = minted.clone();
        self.pairing.consent(id, move |code, link| {
            *keep.borrow_mut() = Some(link);
            up(&counts.starts);
            up(&counts.sessions);
            Ok(Session {
                _code: code,
                counts,
            })
        })?;
        let link = minted.borrow_mut().take();
        Ok(link.expect("consent minted a link"))
    }

    fn consent(&mut self, id: AttemptId) -> HubLink {
        let link = self.try_consent(id).unwrap();
        assert_eq!(link.attempt(), id);
        link
    }

    fn event_from(
        &mut self,
        link: &HubLink,
        pin: [u8; 32],
        window: [u8; 16],
        event: HubEvent<Comparison>,
    ) -> Outcome {
        self.pairing
            .hub_event(link, pin, window, event)
            .map(|done| done.is_some())
    }

    fn event(&mut self, run: &Run, event: HubEvent<Comparison>) -> Outcome {
        self.event_from(run.link(), HUB_PIN, run.window, event)
    }

    fn send(&mut self, run: &Run, kind: Kind) -> Outcome {
        let event = self.make(kind);
        self.event(run, event)
    }

    fn complete(&mut self, run: &Run) -> Completion<Session> {
        let event = self.make(Kind::Confirm);
        let done = self
            .pairing
            .hub_event(run.link(), HUB_PIN, run.window, event);
        done.unwrap().expect("a completion")
    }

    // A fresh attempt for the default code, driven to `phase` along the only valid path.
    fn to(&mut self, phase: Phase) -> Run {
        let code = self.code();
        self.drive(code, phase)
    }

    fn drive(&mut self, code: Code, phase: Phase) -> Run {
        let window = code.window;
        let id = self.pairing.stage(code).unwrap();
        let steps = ACTIVE.iter().position(|p| *p == phase).unwrap();
        let link = (steps >= 1).then(|| self.consent(id));
        let run = Run { id, window, link };
        if steps >= 2 {
            assert_eq!(self.send(&run, Kind::Claim), Ok(false));
        }
        if steps >= 3 {
            assert_eq!(self.send(&run, Kind::Reveal), Ok(false));
        }
        if steps >= 4 {
            self.pairing.acknowledge(id).unwrap();
        }
        assert_eq!(self.phase(), phase);
        run
    }

    fn phase(&mut self) -> Phase {
        self.pairing.projection().phase
    }

    // Native values still held: codes, sessions and comparisons.
    fn live(&self) -> (i32, i32, i32) {
        (
            self.counts.codes.get(),
            self.counts.sessions.get(),
            self.counts.comparisons.get(),
        )
    }
}

fn preview() -> HubPreview {
    HubPreview {
        name: NAME.into(),
        hub_id: HUB_ID.into(),
    }
}

fn device() -> DeviceRef {
    DeviceRef::new(DEVICE_ID, EPOCH)
}

// Every call that isn't a hub answer: consent, acknowledge, decline, reading the comparison and
// cancel.
const ACTIONS: usize = 5;

fn owner_action(h: &mut Harness, id: AttemptId, action: usize) -> Result<(), Refusal> {
    match action {
        0 => h.try_consent(id).map(|_| ()),
        1 => h.pairing.acknowledge(id),
        2 => h.pairing.decline(id),
        3 => h.pairing.comparison(id).map(|_| ()),
        _ => h.pairing.cancel(id),
    }
}

#[test]
fn staging_projects_consent_and_starts_nothing() {
    let mut h = Harness::new();
    assert_eq!(
        h.pairing.projection(),
        Projection {
            attempt: None,
            phase: Phase::Idle,
            hub: None,
            deadline_ms: None,
        }
    );
    let id = h.stage();
    assert_eq!(
        h.pairing.projection(),
        Projection {
            attempt: Some(id),
            phase: Phase::AwaitingConsent,
            hub: Some(preview()),
            deadline_ms: Some(EXPIRES_MS),
        }
    );
    assert_eq!(h.counts.starts.get(), 0);
    assert_eq!(h.live(), (1, 0, 0));
}

// The shared hub ID vectors: each `hid` with the `DYK-` ID that consent shows for it.
fn hub_id_vectors() -> Vec<([u8; 32], String)> {
    let vectors = include_str!("../../../spec/vectors/pairing/proofs.json");
    let cases = vectors.split_once("\"hubIds\": [").unwrap().1;
    let cases = cases.split_once(']').unwrap().0;
    let field = |case: &str, key: &str| {
        let value = case.split_once(&format!("\"{key}\": \"")).unwrap().1;
        value.split_once('"').unwrap().0.to_owned()
    };
    cases
        .split('}')
        .filter(|case| case.contains("\"hid\""))
        .map(|case| {
            let hid = field(case, "hid");
            assert_eq!(hid.len(), 64);
            let mut pin = [0; 32];
            for (byte, pair) in pin.iter_mut().zip(hid.as_bytes().chunks_exact(2)) {
                *byte = u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap();
            }
            (pin, field(case, "display"))
        })
        .collect()
}

#[test]
fn consent_shows_the_id_of_the_hub_that_answers_must_come_from() {
    let vectors = hub_id_vectors();
    assert!(vectors.len() >= 2);
    for (pin, display) in vectors {
        let mut h = Harness::new();
        let code = h.code_for(pin, WINDOW, EXPIRES_MS);
        h.drive(code, Phase::Claiming);
        let hub = HubPreview {
            name: NAME.into(),
            hub_id: display,
        };
        assert_eq!(h.pairing.projection().hub, Some(hub));
    }
}

#[test]
fn consent_alone_starts_the_native_session_once_with_its_link() {
    let mut h = Harness::new();
    let id = h.stage();
    let link = h.consent(id);
    assert_eq!(link.attempt(), id);
    assert_eq!(h.counts.starts.get(), 1);
    assert_eq!(h.phase(), Phase::Claiming);
    assert_eq!(
        h.pairing.consent(id, |_, _| panic!("a second start")),
        Err(Refusal::OutOfOrder)
    );
    assert_eq!(h.counts.starts.get(), 1);
    assert_eq!(h.live(), (1, 1, 0));
}

#[test]
fn only_the_correlated_hub_confirmation_completes() {
    let mut h = Harness::new();
    let run = h.to(Phase::AwaitingConfirmation);
    let completion = h.complete(&run);
    assert_eq!(completion.attempt(), run.id);
    assert_eq!(completion.hub_pin(), HUB_PIN);
    assert_eq!(completion.device(), &device());
    assert_eq!(completion.device().id(), DEVICE_ID);
    assert_eq!(completion.device().epoch(), EPOCH);
    assert_eq!(
        h.pairing.projection(),
        Projection {
            attempt: Some(run.id),
            phase: Phase::Confirmed,
            hub: Some(preview()),
            deadline_ms: None,
        }
    );
    // The session comes back to the caller; the comparison is gone.
    assert_eq!(h.live(), (1, 1, 0));
    drop(completion.into_session());
    assert_eq!(h.live(), (0, 0, 0));
    for kind in KINDS {
        assert_eq!(h.send(&run, kind), Err(Refusal::Closed), "{kind:?}");
    }
    for code in [h.code(), h.code_for(HUB_PIN, NEW_WINDOW, EXPIRES_MS)] {
        assert_eq!(h.pairing.stage(code), Err(Refusal::AlreadyPaired));
    }
    assert_eq!(h.live(), (0, 0, 0));
    assert_eq!(h.phase(), Phase::Confirmed);
}

#[test]
fn acknowledging_the_comparison_alone_grants_nothing() {
    let mut h = Harness::new();
    let run = h.to(Phase::Comparing);
    assert_eq!(h.pairing.acknowledge(run.id), Ok(()));
    assert_eq!(h.phase(), Phase::AwaitingConfirmation);
    assert_eq!(h.pairing.acknowledge(run.id), Err(Refusal::OutOfOrder));
    assert_eq!(h.phase(), Phase::AwaitingConfirmation);
    assert_eq!(h.live(), (1, 1, 1));
    h.at(START_MS + CONFIRM_WITHIN_MS + 1);
    assert_eq!(h.pairing.tick(), Some(run.id));
    assert_eq!(h.phase(), Phase::Expired);
    assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::Expired));
    assert_eq!(h.phase(), Phase::Expired);
    assert_eq!(h.live(), (0, 0, 0));
}

#[test]
fn no_owner_action_or_pair_of_actions_confirms_a_device() {
    for phase in ACTIVE {
        for first in 0..ACTIONS {
            for second in 0..ACTIONS {
                let mut h = Harness::new();
                let run = h.to(phase);
                let _ = owner_action(&mut h, run.id, first);
                let _ = owner_action(&mut h, run.id, second);
                assert_ne!(
                    h.phase(),
                    Phase::Confirmed,
                    "{phase:?} actions {first} {second}"
                );
            }
        }
    }
}

#[test]
fn a_confirmation_before_the_owner_acknowledges_is_not_applied() {
    let mut h = Harness::new();
    let run = h.to(Phase::Comparing);
    for _ in 0..2 {
        assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::AwaitingOwner));
        assert_eq!(h.phase(), Phase::Comparing);
        assert_eq!(h.live(), (1, 1, 1));
    }
    h.pairing.acknowledge(run.id).unwrap();
    assert_eq!(h.complete(&run).attempt(), run.id);
    assert_eq!(h.phase(), Phase::Confirmed);
}

#[test]
fn hub_answers_out_of_order_end_the_attempt() {
    let cases = [
        (Phase::Claiming, Kind::Reveal),
        (Phase::Claiming, Kind::Confirm),
        (Phase::Revealing, Kind::Claim),
        (Phase::Revealing, Kind::Confirm),
        (Phase::Comparing, Kind::Claim),
        (Phase::Comparing, Kind::Reveal),
        (Phase::AwaitingConfirmation, Kind::Claim),
        (Phase::AwaitingConfirmation, Kind::Reveal),
    ];
    for (phase, kind) in cases {
        let mut h = Harness::new();
        let run = h.to(phase);
        assert_eq!(
            h.send(&run, kind),
            Err(Refusal::OutOfOrder),
            "{phase:?} {kind:?}"
        );
        assert_eq!(h.phase(), Phase::Failed(Failure::OutOfOrder));
        assert_eq!(h.live(), (0, 0, 0), "{phase:?} {kind:?}");
        assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::Closed));
    }
}

#[test]
fn out_of_order_owner_actions_are_refused_and_change_nothing() {
    // Per phase: whether consent, acknowledge, decline, comparison and cancel are refused.
    let refused = [
        (Phase::AwaitingConsent, [false, true, true, true, false]),
        (Phase::Claiming, [true, true, true, true, false]),
        (Phase::Revealing, [true, true, true, true, false]),
        (Phase::Comparing, [true, false, false, false, false]),
        (
            Phase::AwaitingConfirmation,
            [true, true, false, false, false],
        ),
    ];
    for (phase, expected) in refused {
        for (action, refused) in expected.into_iter().enumerate() {
            if !refused {
                continue;
            }
            let mut h = Harness::new();
            let run = h.to(phase);
            let before = (h.pairing.projection(), h.live(), h.counts.starts.get());
            assert_eq!(
                owner_action(&mut h, run.id, action),
                Err(Refusal::OutOfOrder),
                "{phase:?} action {action}"
            );
            let after = (h.pairing.projection(), h.live(), h.counts.starts.get());
            assert_eq!(after, before, "{phase:?} action {action}");
        }
    }
}

#[test]
fn answers_through_an_earlier_attempts_link_change_nothing() {
    let mut h = Harness::new();
    let old = h.to(Phase::AwaitingConfirmation);
    h.pairing.cancel(old.id).unwrap();
    let code = h.code_for(HUB_PIN, NEW_WINDOW, EXPIRES_MS);
    let new = h.drive(code, Phase::AwaitingConfirmation);
    assert_ne!(old.id, new.id);
    let before = (h.pairing.projection(), h.live(), h.counts.starts.get());
    for kind in KINDS {
        for window in [old.window, new.window] {
            let event = h.make(kind);
            assert_eq!(
                h.event_from(old.link(), HUB_PIN, window, event),
                Err(Refusal::Stale),
                "{kind:?}"
            );
        }
    }
    for action in 0..ACTIONS {
        assert_eq!(owner_action(&mut h, old.id, action), Err(Refusal::Stale));
    }
    let after = (h.pairing.projection(), h.live(), h.counts.starts.get());
    assert_eq!(after, before);
    assert_eq!(h.complete(&new).attempt(), new.id);
}

#[test]
fn a_link_from_another_workflow_reaches_nothing_here() {
    let mut other = Harness::new();
    let foreign = other.to(Phase::AwaitingConfirmation);
    let mut h = Harness::new();
    for kind in KINDS {
        assert_eq!(h.send(&foreign, kind), Err(Refusal::NoAttempt));
    }
    let run = h.to(Phase::AwaitingConfirmation);
    assert_ne!(foreign.id, run.id);
    let before = (h.pairing.projection(), h.live());
    for kind in KINDS {
        assert_eq!(h.send(&foreign, kind), Err(Refusal::Stale), "{kind:?}");
    }
    assert_eq!((h.pairing.projection(), h.live()), before);
    assert_eq!(other.phase(), Phase::AwaitingConfirmation);
    assert_eq!(h.complete(&run).attempt(), run.id);
}

#[test]
fn owner_actions_naming_another_attempt_change_nothing() {
    let mut h = Harness::new();
    for action in 0..ACTIONS {
        assert_eq!(
            owner_action(&mut h, AttemptId::new(1), action),
            Err(Refusal::NoAttempt)
        );
    }
    let run = h.to(Phase::Comparing);
    let before = (h.pairing.projection(), h.live(), h.counts.starts.get());
    for other in [
        AttemptId::new(0),
        AttemptId::new(run.id.get() + 1),
        AttemptId::new(u64::MAX),
    ] {
        for action in 0..ACTIONS {
            assert_eq!(
                owner_action(&mut h, other, action),
                Err(Refusal::Stale),
                "action {action}"
            );
        }
    }
    let after = (h.pairing.projection(), h.live(), h.counts.starts.get());
    assert_eq!(after, before);
}

#[test]
fn callbacks_after_cancellation_are_refused() {
    for phase in ACTIVE {
        let mut h = Harness::new();
        let run = h.to(phase);
        assert_eq!(h.pairing.cancel(run.id), Ok(()));
        assert_eq!(h.phase(), Phase::Cancelled);
        assert_eq!(h.live(), (0, 0, 0), "{phase:?}");
        let starts = h.counts.starts.get();
        if run.link.is_some() {
            for kind in KINDS {
                assert_eq!(
                    h.send(&run, kind),
                    Err(Refusal::Closed),
                    "{phase:?} {kind:?}"
                );
            }
        }
        for action in 0..ACTIONS {
            assert_eq!(
                owner_action(&mut h, run.id, action),
                Err(Refusal::Closed),
                "{phase:?} action {action}"
            );
        }
        assert_eq!(h.phase(), Phase::Cancelled);
        assert_eq!(h.live(), (0, 0, 0));
        assert_eq!(h.counts.starts.get(), starts);
    }
}

// The one valid next step before the reveal holds: consent, the claim's answer or the reveal's.
fn next_step(h: &mut Harness, run: &Run, phase: Phase) -> Result<(), Refusal> {
    match phase {
        Phase::AwaitingConsent => h.try_consent(run.id).map(|_| ()),
        Phase::Claiming => h.send(run, Kind::Claim).map(|_| ()),
        _ => h.send(run, Kind::Reveal).map(|_| ()),
    }
}

#[test]
fn the_window_bounds_consent_the_claim_and_the_reveal() {
    for phase in [Phase::AwaitingConsent, Phase::Claiming, Phase::Revealing] {
        let mut h = Harness::new();
        let run = h.to(phase);
        h.at(EXPIRES_MS);
        assert_eq!(h.pairing.tick(), None, "{phase:?}");
        assert_eq!(h.pairing.projection().deadline_ms, Some(EXPIRES_MS));
        assert_eq!(next_step(&mut h, &run, phase), Ok(()), "{phase:?}");
        assert_ne!(h.phase(), Phase::Expired);

        let mut h = Harness::new();
        let run = h.to(phase);
        let starts = h.counts.starts.get();
        h.at(EXPIRES_MS + 1);
        assert_eq!(
            next_step(&mut h, &run, phase),
            Err(Refusal::Expired),
            "{phase:?}"
        );
        assert_eq!(h.phase(), Phase::Expired);
        assert_eq!(h.live(), (0, 0, 0), "{phase:?}");
        assert_eq!(h.counts.starts.get(), starts);
        if run.link.is_some() {
            for kind in KINDS {
                assert_eq!(
                    h.send(&run, kind),
                    Err(Refusal::Expired),
                    "{phase:?} {kind:?}"
                );
            }
        }
        for action in 0..ACTIONS {
            assert_eq!(owner_action(&mut h, run.id, action), Err(Refusal::Expired));
        }
        assert_eq!(h.pairing.tick(), None);
    }

    let mut h = Harness::new();
    let id = h.stage();
    h.at(EXPIRES_MS + 1);
    assert_eq!(h.pairing.tick(), Some(id));
    assert_eq!(h.pairing.tick(), None);
    assert_eq!(h.live(), (0, 0, 0));
}

#[test]
fn every_owner_action_as_the_first_call_after_the_deadline_is_refused() {
    for phase in ACTIVE {
        for action in 0..ACTIONS {
            let mut h = Harness::new();
            let run = h.to(phase);
            let deadline = h.pairing.projection().deadline_ms.unwrap();
            let starts = h.counts.starts.get();
            h.at(deadline + 1);
            assert_eq!(
                owner_action(&mut h, run.id, action),
                Err(Refusal::Expired),
                "{phase:?} action {action}"
            );
            assert_eq!(h.phase(), Phase::Expired, "{phase:?} action {action}");
            assert_eq!(h.live(), (0, 0, 0), "{phase:?} action {action}");
            assert_eq!(h.counts.starts.get(), starts);
        }
    }
}

#[test]
fn a_projection_alone_reports_an_expiry_that_tick_then_does_not_name() {
    for phase in ACTIVE {
        let mut h = Harness::new();
        let run = h.to(phase);
        let deadline = h.pairing.projection().deadline_ms.unwrap();
        h.at(deadline + 1);
        assert_eq!(
            h.pairing.projection(),
            Projection {
                attempt: Some(run.id),
                phase: Phase::Expired,
                hub: Some(preview()),
                deadline_ms: None,
            },
            "{phase:?}"
        );
        assert_eq!(h.live(), (0, 0, 0), "{phase:?}");
        assert_eq!(h.pairing.tick(), None, "{phase:?}");
    }
}

#[test]
fn a_code_is_accepted_up_to_its_expiry_and_refused_after() {
    let mut h = Harness::new();
    h.at(EXPIRES_MS + 1);
    let code = h.code();
    assert_eq!(h.pairing.stage(code), Err(Refusal::Expired));
    assert_eq!(h.phase(), Phase::Idle);
    assert_eq!(h.live(), (0, 0, 0));

    let mut h = Harness::new();
    h.at(EXPIRES_MS);
    let id = h.stage();
    assert_eq!(h.pairing.projection().deadline_ms, Some(EXPIRES_MS));
    assert_eq!(h.phase(), Phase::AwaitingConsent);
    h.consent(id);
    assert_eq!(h.phase(), Phase::Claiming);
}

#[test]
fn the_confirmation_deadline_starts_when_the_reveal_holds() {
    let revealed = EXPIRES_MS - 1_000;
    let deadline = revealed + CONFIRM_WITHIN_MS;
    for late in [false, true] {
        let mut h = Harness::new();
        let run = h.to(Phase::Revealing);
        h.at(revealed);
        assert_eq!(h.send(&run, Kind::Reveal), Ok(false));
        assert_eq!(h.pairing.projection().deadline_ms, Some(deadline));
        h.at(EXPIRES_MS + 1);
        assert_eq!(h.pairing.tick(), None);
        h.pairing.acknowledge(run.id).unwrap();
        h.at(deadline + u64::from(late));
        let event = h.make(Kind::Confirm);
        let done = h.pairing.hub_event(run.link(), HUB_PIN, WINDOW, event);
        if late {
            assert_eq!(done.map(|c| c.is_some()), Err(Refusal::Expired));
            assert_eq!(h.phase(), Phase::Expired);
        } else {
            assert_eq!(done.unwrap().expect("a completion").attempt(), run.id);
            assert_eq!(h.phase(), Phase::Confirmed);
        }
        assert_eq!(h.live(), (0, 0, 0));
    }
}

#[test]
fn a_confirmation_deadline_past_u64_max_saturates() {
    let mut h = Harness::new();
    h.at(u64::MAX - 1);
    let code = h.code_for(HUB_PIN, WINDOW, u64::MAX);
    let run = h.drive(code, Phase::Revealing);
    assert_eq!(h.send(&run, Kind::Reveal), Ok(false));
    assert_eq!(h.pairing.projection().deadline_ms, Some(u64::MAX));
    h.at(u64::MAX);
    assert_eq!(h.pairing.tick(), None);
    h.pairing.acknowledge(run.id).unwrap();
    assert_eq!(h.complete(&run).attempt(), run.id);
}

#[test]
fn time_never_runs_backwards_for_the_workflow() {
    let mut h = Harness::new();
    h.at(EXPIRES_MS + 1);
    assert_eq!(h.pairing.tick(), None);
    h.at(START_MS);
    let code = h.code();
    assert_eq!(h.pairing.stage(code), Err(Refusal::Expired));
    assert_eq!(h.live(), (0, 0, 0));

    let mut h = Harness::new();
    let run = h.to(Phase::Revealing);
    h.at(START_MS + 5_000);
    assert_eq!(h.pairing.tick(), None);
    h.at(START_MS);
    assert_eq!(h.send(&run, Kind::Reveal), Ok(false));
    assert_eq!(
        h.pairing.projection().deadline_ms,
        Some(START_MS + 5_000 + CONFIRM_WITHIN_MS)
    );

    let mut h = Harness::new();
    let run = h.to(Phase::Claiming);
    h.at(EXPIRES_MS + 1);
    assert_eq!(h.pairing.tick(), Some(run.id));
    h.at(START_MS);
    assert_eq!(h.phase(), Phase::Expired);
    assert_eq!(h.send(&run, Kind::Claim), Err(Refusal::Expired));
}

#[test]
fn one_clock_reading_far_ahead_expires_every_later_code_of_that_workflow() {
    let mut h = Harness::new();
    h.at(u64::MAX);
    assert_eq!(h.phase(), Phase::Idle);
    h.at(START_MS);
    for expires_at_ms in [EXPIRES_MS, u64::MAX - 1] {
        let code = h.code_for(HUB_PIN, WINDOW, expires_at_ms);
        assert_eq!(h.pairing.stage(code), Err(Refusal::Expired));
    }
    assert_eq!(h.phase(), Phase::Idle);
    assert_eq!(h.live(), (0, 0, 0));
    let mut next = Harness::new();
    next.to(Phase::Claiming);
}

#[test]
fn an_answer_from_another_hub_or_window_ends_the_attempt() {
    for phase in &ACTIVE[1..] {
        for kind in KINDS {
            for (pin, window) in [(OTHER_HUB_PIN, WINDOW), (HUB_PIN, OTHER_WINDOW)] {
                let mut h = Harness::new();
                let run = h.to(*phase);
                let event = h.make(kind);
                assert_eq!(
                    h.event_from(run.link(), pin, window, event),
                    Err(Refusal::Mismatch),
                    "{phase:?} {kind:?}"
                );
                assert_eq!(h.phase(), Phase::Failed(Failure::Mismatch));
                assert_eq!(h.live(), (0, 0, 0), "{phase:?} {kind:?}");
                assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::Closed));
            }
        }
    }
}

#[test]
fn a_confirmation_for_another_device_or_epoch_ends_the_attempt() {
    for phase in [Phase::Comparing, Phase::AwaitingConfirmation] {
        for confirmed in [
            DeviceRef::new(OTHER_DEVICE_ID, EPOCH),
            DeviceRef::new(DEVICE_ID, EPOCH + 1),
        ] {
            let mut h = Harness::new();
            let run = h.to(phase);
            assert_eq!(
                h.event(&run, HubEvent::Confirmed(confirmed)),
                Err(Refusal::Mismatch),
                "{phase:?}"
            );
            assert_eq!(h.phase(), Phase::Failed(Failure::Mismatch));
            assert_eq!(h.live(), (0, 0, 0));
            assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::Closed));
        }
    }
}

#[test]
fn hub_refusals_and_lost_connections_end_the_attempt() {
    for phase in &ACTIVE[1..] {
        for (kind, failure) in [
            (Kind::Refuse, Failure::Refused),
            (Kind::Disconnect, Failure::Transport),
        ] {
            let mut h = Harness::new();
            let run = h.to(*phase);
            assert_eq!(h.send(&run, kind), Ok(false));
            assert_eq!(h.phase(), Phase::Failed(failure));
            assert_eq!(h.live(), (0, 0, 0), "{phase:?} {kind:?}");
            assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::Closed));
            let code = h.code_for(HUB_PIN, NEW_WINDOW, EXPIRES_MS);
            let next = h.pairing.stage(code).unwrap();
            assert_ne!(next, run.id);
            assert_eq!(h.phase(), Phase::AwaitingConsent);
        }
    }
}

#[test]
fn a_native_start_failure_ends_the_attempt() {
    let mut h = Harness::new();
    let id = h.stage();
    assert_eq!(
        h.pairing.consent(id, |_, _| Err(NativeError)),
        Err(Refusal::StartFailed)
    );
    assert_eq!(h.phase(), Phase::Failed(Failure::Transport));
    assert_eq!(h.live(), (0, 0, 0));
    for action in 0..ACTIONS {
        assert_eq!(owner_action(&mut h, id, action), Err(Refusal::Closed));
    }
}

#[test]
fn an_active_attempt_is_never_replaced() {
    for phase in ACTIVE {
        let mut h = Harness::new();
        let run = h.to(phase);
        let before = (h.pairing.projection(), h.live());
        let code = h.code_for(OTHER_HUB_PIN, OTHER_WINDOW, EXPIRES_MS);
        assert_eq!(h.pairing.stage(code), Err(Refusal::Busy), "{phase:?}");
        assert_eq!((h.pairing.projection(), h.live()), before);
        assert_eq!(h.pairing.projection().attempt, Some(run.id));
    }
    let mut h = Harness::new();
    let id = h.stage();
    h.at(EXPIRES_MS + 1);
    let code = h.code_for(HUB_PIN, WINDOW, EXPIRES_MS + 10);
    let next = h.pairing.stage(code).unwrap();
    assert_ne!(next, id);
    assert_eq!(h.live(), (1, 0, 0));
}

// Ends an attempt in each way other than expiry: confirmed, cancelled, declined, not started,
// refused, disconnected or answered out of order.
fn end_somehow(h: &mut Harness, how: usize) -> Run {
    let (phase, kind) = match how {
        0 => {
            let run = h.to(Phase::AwaitingConfirmation);
            drop(h.complete(&run));
            return run;
        }
        1 => {
            let run = h.to(Phase::Comparing);
            h.pairing.cancel(run.id).unwrap();
            return run;
        }
        2 => {
            let run = h.to(Phase::Comparing);
            h.pairing.decline(run.id).unwrap();
            return run;
        }
        3 => {
            let id = h.stage();
            let started = h.pairing.consent(id, |_, _| Err(NativeError));
            assert_eq!(started, Err(Refusal::StartFailed));
            return Run {
                id,
                window: WINDOW,
                link: None,
            };
        }
        4 => (Phase::Claiming, Kind::Refuse),
        5 => (Phase::Revealing, Kind::Disconnect),
        _ => (Phase::Claiming, Kind::Reveal),
    };
    let run = h.to(phase);
    let _ = h.send(&run, kind);
    run
}

#[test]
fn an_ended_attempt_keeps_its_ending_after_its_deadline() {
    for how in 0..7 {
        let mut h = Harness::new();
        let run = end_somehow(&mut h, how);
        let ended = h.pairing.projection();
        assert!(!ACTIVE.contains(&ended.phase), "ending {how}");
        assert_ne!(ended.phase, Phase::Expired, "ending {how}");
        h.at(u64::MAX);
        assert_eq!(h.pairing.tick(), None, "ending {how}");
        assert_eq!(h.pairing.projection(), ended, "ending {how}");
        if run.link.is_some() {
            for kind in KINDS {
                assert_eq!(h.send(&run, kind), Err(Refusal::Closed), "ending {how}");
            }
        }
        for action in 0..ACTIONS {
            assert_eq!(
                owner_action(&mut h, run.id, action),
                Err(Refusal::Closed),
                "ending {how} action {action}"
            );
        }
        let code = h.code_for(HUB_PIN, NEW_WINDOW, u64::MAX);
        let staged = h.pairing.stage(code);
        if ended.phase == Phase::Confirmed {
            assert_eq!(staged, Err(Refusal::AlreadyPaired));
        } else {
            assert_ne!(staged.unwrap(), run.id, "ending {how}");
        }
    }
}

// Ends an attempt whose claim the hub accepted: cancel, decline, the hub's refusal, a lost
// connection or an answer out of order.
fn end_accepted(h: &mut Harness, run: &Run, how: usize) {
    let _ = match how {
        0 => h.pairing.cancel(run.id),
        1 => h.pairing.decline(run.id),
        2 => h.send(run, Kind::Refuse).map(|_| ()),
        3 => h.send(run, Kind::Disconnect).map(|_| ()),
        _ => h.send(run, Kind::Claim).map(|_| ()),
    };
    if ACTIVE.contains(&h.phase()) {
        h.pairing.cancel(run.id).unwrap();
    }
}

#[test]
fn a_code_is_spent_once_the_hub_accepts_its_claim_however_the_attempt_ends() {
    for phase in [
        Phase::Revealing,
        Phase::Comparing,
        Phase::AwaitingConfirmation,
    ] {
        for how in 0..5 {
            let mut h = Harness::new();
            let run = h.to(phase);
            end_accepted(&mut h, &run, how);
            let before = (h.pairing.projection(), h.live(), h.counts.starts.get());
            assert_eq!(before.1, (0, 0, 0), "{phase:?} ending {how}");
            for pin in [HUB_PIN, OTHER_HUB_PIN] {
                let code = h.code_for(pin, WINDOW, EXPIRES_MS);
                assert_eq!(
                    h.pairing.stage(code),
                    Err(Refusal::CodeUsed),
                    "{phase:?} ending {how}"
                );
            }
            let after = (h.pairing.projection(), h.live(), h.counts.starts.get());
            assert_eq!(after, before, "{phase:?} ending {how}");
            let code = h.code_for(HUB_PIN, NEW_WINDOW, EXPIRES_MS);
            h.drive(code, Phase::Claiming);
        }
    }
}

#[test]
fn a_code_can_be_tried_again_until_the_hub_accepts_its_claim() {
    let mut h = Harness::new();
    let run = h.to(Phase::AwaitingConsent);
    h.pairing.cancel(run.id).unwrap();
    let id = h.stage();
    assert_eq!(
        h.pairing.consent(id, |_, _| Err(NativeError)),
        Err(Refusal::StartFailed)
    );
    for how in 0..5 {
        let run = h.to(Phase::Claiming);
        let outcome = match how {
            0 => h.pairing.cancel(run.id).map(|()| false),
            1 => h.send(&run, Kind::Refuse),
            2 => h.send(&run, Kind::Disconnect),
            3 => {
                let event = h.make(Kind::Claim);
                h.event_from(run.link(), HUB_PIN, OTHER_WINDOW, event)
            }
            _ => h.send(&run, Kind::Reveal),
        };
        assert_ne!(outcome, Ok(true), "ending {how}");
        assert!(!ACTIVE.contains(&h.phase()), "ending {how}");
    }
    let run = h.to(Phase::Revealing);
    h.pairing.cancel(run.id).unwrap();
    let code = h.code();
    assert_eq!(h.pairing.stage(code), Err(Refusal::CodeUsed));
    assert_eq!(h.live(), (0, 0, 0));
}

#[test]
fn a_spent_code_stays_refused_through_its_expiry() {
    let mut h = Harness::new();
    let run = h.to(Phase::Revealing);
    h.pairing.cancel(run.id).unwrap();
    h.at(EXPIRES_MS);
    let code = h.code();
    assert_eq!(h.pairing.stage(code), Err(Refusal::CodeUsed));
    h.at(EXPIRES_MS + 1);
    let code = h.code();
    assert_eq!(h.pairing.stage(code), Err(Refusal::Expired));
    let code = h.code_for(HUB_PIN, NEW_WINDOW, EXPIRES_MS + 10);
    let next = h.pairing.stage(code).unwrap();
    h.pairing.cancel(next).unwrap();
    h.at(START_MS);
    let code = h.code();
    assert_eq!(h.pairing.stage(code), Err(Refusal::Expired));
    assert_eq!(h.live(), (0, 0, 0));
}

#[test]
fn a_spent_window_is_refused_until_the_spent_code_expires() {
    let later = EXPIRES_MS + 20_000;
    let mut h = Harness::new();
    let run = h.to(Phase::Revealing);
    h.pairing.cancel(run.id).unwrap();
    for at in [START_MS, EXPIRES_MS] {
        h.at(at);
        let code = h.code_for(HUB_PIN, WINDOW, later);
        assert_eq!(h.pairing.stage(code), Err(Refusal::CodeUsed), "{at}");
    }
    h.at(EXPIRES_MS + 1);
    let code = h.code_for(HUB_PIN, WINDOW, later);
    assert_ne!(h.pairing.stage(code).unwrap(), run.id);
    assert_eq!(h.phase(), Phase::AwaitingConsent);
}

#[test]
fn spent_codes_carry_into_a_later_workflow_until_they_expire() {
    let mut h = Harness::new();
    let run = h.to(Phase::Claiming);
    assert_eq!(h.pairing.spent_codes(), []);
    assert_eq!(h.send(&run, Kind::Claim), Ok(false));
    let spent = h.pairing.spent_codes();
    assert_eq!(spent, [SpentCode::new(WINDOW, EXPIRES_MS)]);
    assert_eq!(spent[0].window_id(), WINDOW);
    assert_eq!(spent[0].expires_at_ms(), EXPIRES_MS);
    h.at(EXPIRES_MS + 1);
    assert_eq!(h.pairing.spent_codes(), []);

    let mut later = Harness::with_spent(spent.clone());
    for pin in [HUB_PIN, OTHER_HUB_PIN] {
        let code = later.code_for(pin, WINDOW, EXPIRES_MS);
        assert_eq!(later.pairing.stage(code), Err(Refusal::CodeUsed));
    }
    assert_eq!(later.phase(), Phase::Idle);
    assert_eq!(later.pairing.spent_codes(), spent);
    let code = later.code_for(HUB_PIN, NEW_WINDOW, EXPIRES_MS);
    later.drive(code, Phase::Claiming);
    later.at(EXPIRES_MS + 1);
    assert_eq!(later.pairing.spent_codes(), []);

    let mut restarted = Harness::with_spent(spent);
    restarted.at(EXPIRES_MS + 1);
    let code = restarted.code_for(HUB_PIN, WINDOW, EXPIRES_MS + 10);
    restarted.drive(code, Phase::Claiming);
}

#[test]
fn declining_the_comparison_ends_the_attempt() {
    for phase in [Phase::Comparing, Phase::AwaitingConfirmation] {
        let mut h = Harness::new();
        let run = h.to(phase);
        assert_eq!(h.pairing.decline(run.id), Ok(()));
        assert_eq!(h.phase(), Phase::Failed(Failure::Declined));
        assert_eq!(h.live(), (0, 0, 0));
        assert_eq!(h.send(&run, Kind::Confirm), Err(Refusal::Closed));
        assert_eq!(h.pairing.acknowledge(run.id), Err(Refusal::Closed));
    }
}

#[test]
fn comparison_material_stays_native_and_ends_with_its_attempt() {
    let mut h = Harness::new();
    let run = h.to(Phase::Revealing);
    assert_eq!(
        h.pairing.comparison(run.id).err(),
        Some(Refusal::OutOfOrder)
    );
    assert_eq!(h.send(&run, Kind::Reveal), Ok(false));
    assert_eq!(h.pairing.comparison(run.id).unwrap().digits, DIGITS);
    assert_eq!(
        h.pairing.comparison(AttemptId::new(run.id.get() + 1)).err(),
        Some(Refusal::Stale)
    );
    h.pairing.acknowledge(run.id).unwrap();
    assert_eq!(h.pairing.comparison(run.id).unwrap().digits, DIGITS);
    drop(h.complete(&run));
    assert_eq!(h.pairing.comparison(run.id).err(), Some(Refusal::Closed));
    assert_eq!(h.live(), (0, 0, 0));
}

#[test]
fn projections_and_diagnostics_carry_no_native_values() {
    let mut h = Harness::new();
    let run = h.to(Phase::AwaitingConfirmation);
    let mut texts = vec![
        format!("{:?}", h.pairing),
        format!("{:?}", h.pairing.projection()),
        format!("{:?}", run.link()),
        format!("{:?}", device()),
        format!("{:?}", h.make(Kind::Reveal)),
        format!("{:?}", h.make(Kind::Confirm)),
    ];
    let completion = h.complete(&run);
    texts.push(format!("{completion:?}"));
    texts.push(format!("{:?}", h.pairing.projection()));
    texts.push(format!("{:?}", h.pairing.spent_codes()));
    for refusal in [
        Refusal::NoAttempt,
        Refusal::Stale,
        Refusal::Closed,
        Refusal::Expired,
        Refusal::OutOfOrder,
        Refusal::Mismatch,
        Refusal::Busy,
        Refusal::AlreadyPaired,
        Refusal::CodeUsed,
        Refusal::AwaitingOwner,
        Refusal::StartFailed,
        Refusal::Exhausted,
    ] {
        texts.push(format!("{refusal} {refusal:?}"));
    }
    for text in texts {
        for native in [
            "238, 238", "eeee", "EEEE", "215, 215", "d7d7", "D7D7", DEVICE_ID, DIGITS,
        ] {
            assert!(!text.contains(native), "{text}");
        }
    }
}

#[test]
fn a_link_and_hub_answers_can_cross_from_a_native_session_thread() {
    fn crosses<T: Send + Sync>() {}
    crosses::<HubLink>();
    crosses::<DeviceRef>();
    crosses::<HubEvent<String>>();
    crosses::<Projection>();
    crosses::<SpentCode>();
}
