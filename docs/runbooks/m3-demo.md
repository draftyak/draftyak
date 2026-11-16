# M3 fake-upstream owner walkthrough

This walkthrough checks the Windows vertical slice using synthetic mail,
scripted models, a test-only FakeDevice and fake upstreams. It covers the owner
check in M3.13; M3.14 owns this document and its dry-run. No real account or
provider credential is needed.

The content and MIME commands below are available component checks. The native
walkthrough is **BLOCKED** until M3.9-12, the real M2 authorization/executor and
FakeDevice, `pnpm demo` and `pnpm verify:m3` are installed and their automated
checks pass. Component checks do not complete the owner demo. Do not replace a
missing native step with an allow-all callback, an ordinary CLI approval, or a
browser approval.

Allow 15-25 minutes for component checks and 20-30 minutes for the native
walkthrough once its prerequisites are ready. These are planning estimates;
record actual elapsed time in the M3 gate evidence.

## Setup

1. Use Windows and the repository's pinned Node, pnpm and Rust versions. Follow
   [CONTRIBUTING](../../CONTRIBUTING.md) for installation. Work from the repository
   root in a clean checkout of the candidate being tested.
2. Use only the demo's isolated synthetic data directory and ephemeral fake
   listeners. Keep real inboxes, tokens, recovery codes and personal messages
   outside this walkthrough. The demo must show its test-upstream mode in red
   in Security Center and keep it visible while it is running.
3. Run `pnpm install --frozen-lockfile`. It must exit successfully without
   changing the committed lockfile. If it fails or changes tracked files,
   stop and resolve the checkout/install before continuing.
4. Run the component checks. A failure is a failed preparation step, not an
   owner approval to continue.

## Available component dry-run

Run these exact commands from the repository root:

```powershell
$env:DRAFTYAK_STRICT_SKIPS = "1"
pnpm --filter @draftyak/content typecheck
pnpm --filter @draftyak/content test
pnpm --filter @draftyak/content test:heavy
pnpm --filter @draftyak/content build
pnpm --filter @draftyak/mime typecheck
pnpm --filter @draftyak/mime test
pnpm --filter @draftyak/mime build
pnpm guard
```

Every command must exit zero. Content tests cover synthetic authentication and
header attacks, visible/hidden HTML, link markers, removal counts, body refusals,
worker startup/job/heap limits and raw ingest-to-prompt fixtures. MIME tests must
include three byte-exact non-Bcc goldens, independent parse-back and refusal/boundary
neighbors. The historical Bcc-bearing attachment golden stays pending ADR 0010, with current refusal asserted. These results establish component behavior, not a native send,
obedient-model result or owner gate.

If a command fails, save its command and concise failure result with the
synthetic fixture id in the gate evidence, fix the cause and rerun that step and
any affected checks. Do not record a skipped or unavailable check as passed.

## Native readiness check

Run `pnpm run`. Both `demo` and `verify:m3` must be listed. The demo must also
provide a documented testkit FakeDevice action for its synthetic PIN approval;
its exact interaction belongs to the M3.12 demo output. If a script, FakeDevice
action or real M2 prerequisite is missing, record **BLOCKED: native prerequisites
unavailable** and stop here. The native steps below are the delivery contract
for the completed demo; they have not been replaced by package-only checks.

Before the owner gate, the implementer must dry-run this entire native section
against fakes and update the interaction details to match the actual demo.
There must be no undocumented approval command or setup step for the owner to
guess.

## Native walkthrough after readiness

| Step and estimated time | Action | Expected result | If it fails |
|---|---|---|---|
| Start, 2 minutes | Run `pnpm demo` and keep its terminal open. Open the loopback URL it prints. | Fresh synthetic account/inbox; fake listeners only; red test-upstream state in Security Center. | Stop; report missing startup, isolation or test-upstream indicator. |
| Ingest, 2 minutes | Open the synthetic hello thread named by the demo. Inspect sender, authentication, body and attachment metadata. | Parsed content is visible; removal/body-refusal disclosures remain readable; owner-looking From alone is not treated as verified outbound. | Record the fixture and field mismatch; do not substitute another message. |
| Draft, 3 minutes | Request a suggestion using the demo's real compatible plugin with its scripted fake model. | Suggestion appears; recipients, subject, threading and attachments remain unchanged; the model has no send authority. | Stop on changed non-body fields, a live provider request or missing policy checks. |
| Edit, 2 minutes | Edit the suggestion body, save it and inspect its revision/diff. | The saved owner edit is a new revision and the reviewed bytes match its render. | Stop on stale revision, hidden recipient change or missing provenance. |
| Browser refusal, 1 minute | Inspect the browser's approval queue. Run the automated browser-denial case through `pnpm verify:m3` in the gate step below. | Browser shows the pending item but offers no approval authority; direct browser/API approval attempts produce zero sends. | Stop if the browser can approve or reaches SENDING. |
| FakeDevice approval, 3 minutes | Follow the demo's documented testkit FakeDevice action and enter only its synthetic PIN for this revision. | Real PIN/signature/challenge/epoch/hash checks run; one approval is consumed; exactly one fake-upstream request has byte/hash equality with the frozen render. | Stop for missing PIN verification, a second request, wrong bytes, replay success or an ordinary CLI/browser approval path. |
| Cancel, 2 minutes | Propose a future send, approve it through the documented FakeDevice action with its synthetic PIN, and confirm SCHEDULED with a locked draft. Then cancel that approved item from the loopback browser. | The item is CANCELLED, the draft is editable again, and no request is sent. Cancellation is tightening and needs no PIN. | Stop on a send after cancel, missing permission checks or a locked draft after successful cancellation. |
| Scheduled delivery, 3 minutes | Follow the demo's second FakeDevice-approved schedule on its injected clock. | It sends once at `notBefore`, inside the reviewed window, and never early or twice. | Stop on early, duplicate or late delivery or a mutable approved time. |
| Missed window, 2 minutes | Approve the demo's missed-window schedule through the documented FakeDevice action and synthetic PIN, confirm SCHEDULED, then advance its injected clock beyond `deliverBy`. | NEEDS_REAPPROVAL with the missed reason; no late request. | Stop if the item silently retries or sends after `deliverBy`. |
| Gate checks, 5-10 minutes | Run `pnpm verify:m3`. | Native approval/principal/property/corpus/scheduling/browser checks pass without skips; benign and obedient fake models preserve recipients and framing, produce the expected flags, and hostile data creates no outbox authority. | Record the failed invariant and stop the gate. |

The completed native demo must supply the exact fixture names, FakeDevice
interaction and injected-clock controls used by these rows. Until those details
have been dry-run, M3.14 and the owner gate remain incomplete. Genuine MCP-client
corpus acceptance belongs to M8; SMS, tool contexts and vendor sessions keep
their own gates.

## Finish and record the decision

1. Stop the demo with Ctrl+C in its own terminal. Its fake listeners and child
   processes must exit; shutdown acceptance belongs to M3.12. Do not stop other
   applications or remove an unrelated data directory.
2. Run `git status --short`. No source, golden fixture or lockfile may have
   changed. Normal verification can update tracked spike evidence, including
   the MCP SDK and bridge-translation evidence. Preserve those outputs and
   review the changes against the command that produced them. Record approved
   evidence changes separately from source changes; do not silently restore
   unrelated files or call an unexplained difference a clean result.
3. In the M3 gate evidence, record the tested commit, commands and exit results,
   per-step expected/actual outcomes, recorder request count/hash comparison,
   schedule states, elapsed time and cleanup result. Use synthetic identifiers
   and content-free observations.
4. Record the owner's decision: accept the demonstrated milestone, request
   changes, or defer a named unmet gate. Missing prerequisites, a failed command
   or an unperformed native step cannot be recorded as acceptance.
