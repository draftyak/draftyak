# Device API v1

This is the L2 contract consumed by the desktop's native code. It covers the
catalogue, pending/confirmed device status, reviews, challenges, signed envelopes
and ID-only events. It does not replace the hub's current authorization, PIN
locking, challenge consumption or trusted-window checks.

JSON request/response objects reject unknown members. ULIDs, hashes, instants,
canonical JSON, statement signatures and base64url follow [Encodings](README.md).
Byte caps apply to the **received bytes**, before JSON or statement parsing;
ordinary outer JSON may contain whitespace. A route with request `none` refuses
any body, including an empty byte string. A successful length check alone does
not make a value a valid payload.

`checkRouteRequestBytes` and `checkRouteResponseBytes` check the received cap once,
then strictly parse and validate the shape and route's statement type. Legal JSON
number encodings are accepted even when their canonical form would be longer.
The value-based `checkRouteRequest` and `checkRouteResponse` helpers use canonical
JSON length as a convenience when received bytes are unavailable.

## Route catalogue

`DEVICE_API_ROUTES` gives the same table in TypeScript and Rust. `known` means
known and non-revoked with role `device`; confirmation means confirmed in the
current hub epoch and non-revoked. A pending device holds no effective capability.
`requiredCapability(kind)` is `admin` for `admin.v1` and its admin kinds, otherwise
`approve` for the listed device statement/record kinds; unknown kinds are refused.

| ID | Method/path | Authority | Request/cap | Answer/cap |
|---|---|---|---|---|
| status | `GET /device/v1/status` | known device, pending or confirmed | none | DeviceStatus / 1 KiB |
| bootstrap | `POST /device/v1/bootstrap` | pending sidecar-window claimant, bootstrap not done | BootstrapRequest / 1 KiB | confirmed desktop DeviceStatus / 1 KiB |
| pairing-window | `POST /device/v1/pairing/windows` | confirmed approve | PairingWindowRequest / 1 KiB | PairingWindow / 2 KiB |
| send-review | `GET /device/v1/outbox/<id>/snapshot` | confirmed approve | none | SendReview / 1 MiB |
| new-operation | `POST /device/v1/operations` | confirmed requiredCapability; pair-confirm also canConfirm | OperationRequest / 4 KiB | OperationCreated / 1 KiB |
| operation-review | `GET /device/v1/operations/<id>` | confirmed requiredCapability | none | OperationReview / 1 MiB |
| challenge | `POST /device/v1/challenges` | confirmed requiredCapability; pair-confirm also canConfirm | ChallengeRequest / 1 KiB | Challenge / 32 KiB |
| send-approval | `POST /device/v1/approval/send` | confirmed approve | approval.send.v1 SignedEnvelope / 32 KiB | Accepted / 1 KiB |
| pair-confirmation | `POST /device/v1/pair-confirmations` | confirmed approve and canConfirm | pair-confirm.v1 SignedEnvelope / 32 KiB | Accepted / 1 KiB |
| login | `POST /device/v1/login` | confirmed approve | login.v1 SignedEnvelope / 32 KiB | Accepted / 1 KiB |
| consent | `POST /device/v1/consents` | confirmed approve | consent.v1 SignedEnvelope / 32 KiB | Accepted / 1 KiB |
| agent-session | `POST /device/v1/agent-sessions` | confirmed approve | agent-session.v1 SignedEnvelope / 32 KiB | Accepted / 1 KiB |
| admin | `POST /device/v1/admin` | confirmed admin | admin.v1 SignedEnvelope / 32 KiB | Accepted / 1 KiB |
| sync-pause | `POST /device/v1/sync/pause` | confirmed organize | SyncPause / 1 KiB | SyncPause / 1 KiB |
| events | `GET /device/v1/events` | confirmed read | EventsRequest / 1 KiB | EventFrame / 64 KiB |

The events socket upgrades with WebSocket subprotocol `draftyak.events.v1`.
The conditional host contract adds its exclusive role and host frames later;
ordinary device routes do not accept a host peer. Other routes for inbox, drafts,
outbox lists/actions, settings and audit are hub-request contracts. Claim exchange,
scheduling summaries, code relay and hub-key delivery retain their own contracts.

## Requests and status

- DeviceStatus is `{deviceId,epoch,confirmed,capabilities,testUpstreams}`. Both
  booleans are required. Capabilities are unique, in read/draft/organize/approve/
  admin order; pending status has `[]`, confirmed status a nonempty set. Hosts
  never appear in this status set. `testUpstreams` must be displayed by clients.
- BootstrapRequest is `{pin}`; the result is confirmed with exactly the desktop
  preset. Bootstrap is not a signed or self-confirming pair statement.
- PairingWindowRequest is `{role,pin}`; PairingWindow is `{pairingCode}` with the
  `draftyak-pair:v1:` prefix and at most 1,000 characters. Existing pairing proof
  and bootstrap-secret derivation are reused, not defined again here.
- OperationRequest is `{kind,ids}` for a registered admin kind, with at most 100
  distinct ULIDs, or `{kind:'pair-confirm',ids:[candidate],preset}`. The hub creates
  login, consent and session records itself; devices cannot create those kinds.
- OperationCreated is `{id}`. SyncPause is `{paused:boolean}`. Accepted is
  `{kind,id}`, with the signed route's statement type and accepted record id.
- Every PIN body holds 6–64 ASCII digits, with no final CR, LF or Unicode line
  separator. Confirmation's caller must hold approve and every granted preset
  capability. The server checks this at operation creation, challenge and signed
  confirmation. Desktop/mobile/CLI presets fit role device only.

## Reviews and challenges

SendReview is `{id,snapshot,contentHash,flags,flagsHash,state,stateReason,
requiredUsers,expiresAt}`. State/reason use the existing outbox definitions;
`stateReason` may be null. The content/flags hashes are recomputed from that exact
snapshot and flag list. Required users form a nonempty distinct list, including
the owner as enforced by the consuming approval service.

OperationReview is `{id,kind,digest,subject,expiresAt,remainingMs}`. Its digest is
SHA-256 of the subject's JCS and remainingMs is 0–120,000. Pair-confirm's
subject is `{candidate,name,role,transportSpkiSha256,signingKey,preset,capabilities}`.
Its exact capability array equals its preset and its role fits that preset.
The signing key must be a canonical P-256 approval SPKI.
The comparison-code line is added by the separate pairing contract.

The `agent-session` review uses the existing strict `AgentSessionReviewSubject`:
`{principal,account,toolClass,authorization}`. Principal is a grant or token ULID;
toolClass is read, draft or organize. Session authorization selects exactly
900,000, 3,600,000 or 28,800,000 milliseconds. One-call authorization selects
`tools/call` or `resources/read`, a parameters digest, exactly 600,000 milliseconds
and `singleUse:true`; its review also carries a fixed tool name or canonical
data-resource URI as `target`. Tool targets must match their registered class;
resource reads require read class and a conversation, message, draft or
send-request resource, excluding guide and UI resources. These records are
created through the existing MCP flow, not OperationRequest.

ChallengeRequest currently has these strict members:

- `{kind:'approval.send.v1',id,flagsAcked}`, with existing sorted unique flag codes;
- `{kind:'pair-confirm.v1',id}`;
- `{kind:'agent-session.v1',id}`.

Challenge is `{kind,id,statement}` for the same three members. Statement is unpadded
canonical base64url of canonical JCS bytes, at most **16,384 decoded bytes**
(21,846 characters). Check decoded length before parsing the named type.
16,384 passes the length gate and 16,385 fails; arbitrary bytes at the boundary
still fail typed-statement validation. The hub supplies identity, epoch, nonce,
iat/exp and the existing statement lifetime, never a caller-authored opaque body.

Before asking for the PIN and signing exactly those bytes,
`checkChallenge(challenge,review,request,{hub,device})` requires matching outer
kind/id, review id and pinned hub/device, then:

- Send: outbox equals request id; both hashes equal the review; flagsAcked equals
  the request; the schedule equals `sendWindow(snapshot,iat)`; all required ack
  codes are present. The snapshot's hub, epoch and outbox each equal the
  statement's independently.
- Pair: the review is pair-confirm; candidate, role, transport pin and signing
  key match its subject; capabilities equal the selected preset; the role fits
  that preset.
- Session: the review is agent-session; session equals the review/request ID;
  principal kind and ID, account, tool class and the complete signed
  authorization match the subject. The existing session matcher compares the
  selected duration or one-call method, parameters digest, TTL and single-use
  flag. Session review/challenge and signed submission require a current
  confirmed device with approve; they do not apply pair-confirm's preset rule.

The session review digest covers `target`, but the signed authorization has no
target member. The consuming producer must derive the target from the same
immutable validated parameters whose digest is signed. A same-class target
change with a recomputed review digest is not independently detectable by the
shared matcher. Current principal/account rights, signature and PIN checks,
freshness and atomic one-call consumption remain runtime duties. The grant starts at
hub acceptance of the signed statement, never at the challenge expiration.

Login and first-admin review/challenge members are added with their pending
subjects by their own contract items. The consent extension adds its own members
when its contract exists. Catalogue literals do not create
those subjects or allow an unknown statement body. Unavailable types fail closed.

SignedEnvelope is only `{statement,signature,pin}`. Its statement is unchanged
from the challenge and must parse as the signed route's type. Signature is
canonical unpadded base64url of exactly 64 bytes; signature verification and
single-use/current-authority checks remain with the consuming native/hub flow.

## Events and failures

EventsRequest is `{after:cursor|null}`. Cursor is opaque ASCII, up to 512
characters. EventFrame is ready `{type:'ready',cursor}`, event
`{type:'event',cursor,kind,ids}`, or reset `{type:'reset',reason}`. Event kind is
1–64 characters matching `[a-z][a-z0-9.-]*` across the complete string; final
CR/LF/U+2028/U+2029 are refused. IDs are at most 100 distinct ULIDs. Reset reasons
are `cursor_expired`, `epoch_changed`, `resync_required`. Streams start with ready
or reset; reset ends the stream. Received frames are capped at 65,536 bytes.

Error bodies hold only `{code}`. `DEVICE_API_ERRORS` fixes the status pairing:
400 INVALID_REQUEST; 403 FORBIDDEN, PIN_INVALID, SIGNATURE_INVALID, CODE_MISMATCH,
POLICY_DENIED; 404 NOT_FOUND; 413 TOO_LARGE; 429 PIN_LOCKED; 409
CHALLENGE_INVALID, ACK_REQUIRED, STALE, LOCAL_TIME_MISMATCH, WINDOW_UNAVAILABLE,
DRAFT_LOCKED, SCHEDULE_LIMIT; 503 SCHEDULING_UNAVAILABLE, UNAVAILABLE. No error
body adds input, a key, PIN, typed code or diagnostic member.

The [generated schema](schemas/device-api-v1.schema.json) describes the strict
shapes; hashes, received-byte limits, identity matching, exact preset/role and
stream sequencing also require these protocol validators. Shared
[device API vectors](vectors/device-api/) pin both language implementations.
