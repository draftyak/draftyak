# ADR 0011: S9 Messages API live check deferred

- **Status:** proposed
- **Date:** 2026-10-20
- **Spike:** S9
- **Plan:** §15 S9; §5 drafting providers; §9 broker controls
- **Owner decision:** yes

## Context

S9 was to check structured drafting, effort, default fallback and output-limit
handling against the pinned Messages API contract. Its original live sequence
starts with a default-fallback request. The owner selected **Not run** for the
2026-10-20 session because the required routing and billing prerequisites are
missing. The session procedure omits provider key creation, saving, execution
and revocation for this check.

A pretransport bound has not been established for every paid attempt and its
input, output and applicable rates under the original default-fallback request.
This is a missing guarantee, not evidence of a particular expensive route or an
unlimited generation chain. Local response limits and a previous successful
response cannot establish that guarantee.

The existing six-request cap, US$1 planning/reservation gate and owner-set US$5
monthly workspace control remain unchanged. They do not establish the missing
per-session spend bound. Unanswered or uncertain outcomes retain admitted
requests and full reservations; an error status alone does not establish zero
billing.

## Options

1. Defer the original live sequence and retain the fail-closed routing hold.
2. Revisit the same request after its complete routing and billing prerequisites
   are established and reviewed.
3. Propose a separate, narrower diagnostic contract with its own justified
   bounds and reviewed entry. No such diagnostic is selected here.

## Decision
Not run

The owner selected option 1 for the 2026-10-20 session. No real parsing, effort,
fallback, output-limit, billing or revocation result is reported. Offline
fixtures establish only their tested local validation, refusal and accounting
behavior.

Plan changes: none. The original S9 live acceptance and its gate remain open.
This proposed ADR records the session disposition; it does not accept a
provider architecture, complete M0.31 or authorize a substitute live request.

## Fallback

Keep the original default-fallback live entry held. Any later run requires a
reviewed finite attempt set, justified paid-input/output bounds and applicable
rate bounds, including retries and cleanup, within the unchanged controls.
A narrower diagnostic or explicit fallback list requires its own selected and
reviewed contract. Do not skip the first held call to reach a later call in the
existing sequence.

## Evidence

No live evidence is supplied for this disposition. The owner selected deferral
on 2026-10-20; session and account readiness promises are not execution results.

The existing `spikes/s09-messages-api/test/live-rehearsal.test.ts` contains
synthetic refusal and conservative reservation controls. Those controls are
offline evidence only; they do not establish provider behavior or prices.
The request/verifier and session limitations remain documented in
`spikes/s09-messages-api/notes/session.md`.

## Kept test

- **Path:** none
- **Command:** none
- **Guards:** No live result or product conformance is established by this deferral.
- **Destination:** none
