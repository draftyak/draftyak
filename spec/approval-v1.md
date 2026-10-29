# Approval protocol v1

## Snapshot

`SendSnapshotV1` is the strict email/chat union in `schemas/snapshot-v1.schema.json`.
Unknown fields are refused at every object level. The hub identifier is the full lower-case
64-character SHA-256 of its transport SPKI. IDs are canonical ULIDs; a new email's conversation
is null, while chat requires a conversation. Optional members are omitted, never null.
SMS is a later extension and is refused by this version of the union.

The snapshot freezes recipients, subject, threading, body, footer, attachments, source revision
and authors, destination channel facts, and schedule. Email local parts are preserved exactly;
domains are lower-case ASCII DNS names with IDNs represented by A-labels. U-labels, upper-case
domains, trailing dots and CR/LF in an address or subject are refused. Display-name/homoglyph
warnings do not rewrite the address or change its hash. Subjects are bounded to 2,000 code points.

Body text and footer must already be Unicode 17 NFC with LF line endings. Validation never
normalizes them. Invisible characters remain content for hub flagging. Text is bounded to
100,000 code points, footer to 10,000. The Rust normalization pin is exactly
`unicode-normalization 0.1.25`; TypeScript requires Node's Unicode version to be `17.0`.
The cross-language test checks both tables. A runtime/table upgrade requires a coordinated
contract change and regenerated vectors.

Attachments bind filename, media type, size and SHA-256; no filesystem path or blob authority
is included. At most 100 attachments and 100 addresses in each recipient list are accepted;
at least one recipient across To, Cc and Bcc is required. Source authors contain 1–100 shared draft-author records.

A json-template renderer adds `render` with method, canonical HTTPS URL, `headersSha256` and
`bodySha256`. The header digest uses the shared header-list algorithm, binding each pair's lower-cased header name and exact value according to that algorithm, not
header order or name case. These are the hub-rendered headers; the broker adds credentials separately.
Date, Message-ID and MIME boundary are claim-time values and have no snapshot field.

`contentHash = SHA-256(JCS(snapshot))`, lower-case hexadecimal. `fingerprint` is its first eight
hexadecimal characters in upper case. It is a short human comparison aid, never an identity pin
or authorization value. The full content hash binds approval.

`schedule` is `{kind:'now'}` or the strict scheduled form with UTC-millisecond `notBefore`,
IANA zone name, `YYYY-MM-DDTHH:mm±HH:MM` local display time, `latenessSec` in
`{900,3600,14400,86400}` and `holdIfNewInbound`. The snapshot validator checks zone-name syntax,
calendar date and offset syntax. Zone existence, DST and display-time/instant agreement are
checked by schedule resolution before approval. JSON Schema covers calendar dates,
offset syntax and the declarative shape; NFC additionally requires the shared implementation.

`sendWindow(snapshot, iat)` returns `{deliverBy: iat + 900000}` for now, omitting `notBefore`.
For scheduled sends it returns `{notBefore, deliverBy: notBefore + latenessSec * 1000}`.
Every instant and result must be a nonnegative safe integer; overflow is refused. Statement
encoding represents the immediate send's absent `notBefore` as null under its own contract.

## Statements

The signature is ES256 over UTF-8 `draftyak/v1/<typ>\n` followed by the exact canonical
JCS bytes. Signatures are canonical base64url of 64-byte IEEE P1363 `r||s`, with no
low-S normalization. Keys are canonical base64url of uncompressed P-256 SPKI DER.
`typ` is the external domain separator, never a member of these statement bodies.
Unknown types, unknown object members and unsupported versions are refused.

Device statements share `{v:1, hub, epoch, device, nonce, iat, exp}`. `hub` is the full
lower-case 64-character transport SPKI SHA-256; `device` is a canonical ULID. `epoch`
is a nonnegative safe integer. `nonce` is 16 bytes encoded as canonical, unpadded
base64url. Times are nonnegative safe integer UTC milliseconds, with
`iat <= exp <= iat + 120000`. A nonce identifies the challenge; signature bytes do
not identify it, since more than one valid ECDSA signature can sign the same input.

| `typ` | Additional fields | Signing key |
|---|---|---|
| `approval.send.v1` | `{outbox, contentHash, flagsHash, flagsAcked, notBefore, deliverBy}` | Confirmed device approval key |
| `pair-confirm.v1` | `{candidate, role:'device', transportSpkiSha256, signingKey, capabilities}` | Existing approver's approval key |
| `login.v1` | `{login, digest}` | Confirmed device approval key |
| `admin.v1` | `{op, kind, digest}` | Confirmed device approval key |

`outbox`, `candidate`, `login` and `op` are ULIDs; digests and transport pins are full
lower-case SHA-256 hex. Login binds the native pending browser-login record's digest;
admin binds the immutable pending operation's digest. Each digest is the lower-case
SHA-256 of the exact JCS of its immutable pending record. The record shapes follow
the plan's §7 Browsers for login and §8 Commands for `admin_open`; their consuming
verification follows §9.3 Verification. Those native flows must specify the complete reviewed record before implementing
consumption; no caller-supplied opaque digest substitutes for re-hashing that record. The pair confirmation binds the
candidate's actual canonical approval SPKI and the exact ordered capability array,
which must be nonempty, unique and drawn from `read`, `draft`, `organize`, `approve`,
`admin`, in that canonical order (subsets keep the same relative order).
A server-selected preset is never a body field. The confirmation presets are
`desktop` (`read`, `draft`, `organize`, `approve`, `admin`), `mobile` (`read`,
`draft`, `organize`) and `cli` (`read`, `draft`), each fitting pairing role `device`.
The caller must hold `approve` and every capability its selected preset grants;
`canConfirm(capabilities, preset)` checks that policy in TypeScript and Rust.
The hub applies it when creating the operation, issuing its challenge and accepting
the confirmation. It also checks the candidate's role and that the statement's
capabilities exactly equal the selected preset. Role `host:sms` and its exclusive
`host` preset belong to the conditional SMS contract; neither is accepted here.
Pair review labels, SAS,
expiry display, user identity and the signature are outside the body. The signer device must differ from the candidate. Ordinary pairing requires an existing
confirmed approver with the PIN, after SAS comparison. The trusted hub surface records
the first approver's bootstrap directly under pairing-v1 section 10; bootstrap is not
a candidate-signed or self-confirming pair-confirm.v1 statement.

`flagsAcked` is a lexicographically sorted, unique array of closed `FlagCode` values.
`flagsHash` binds the complete flags with their severity and detail, using
`flagsHash` in [Flags v1](flags-v1.md). `requiredAckCodes` deduplicates the codes of
all `ack` flags; each must occur in `flagsAcked`. The trusted approval UI requires
explicit checked acknowledgements before the PIN. A signature over an unchecked
list is cryptographically valid but fails the operation's acknowledgement check.
Immediate sends require the `notBefore` member to be null and
`deliverBy = iat + 900000`. Scheduled sends bind the snapshot's `notBefore` and
`deliverBy = notBefore + latenessSec * 1000`. `checkSendWindow` recomputes these exact
values; callers separately compare the snapshot's hub, epoch, outbox and content hash.

`hub-key-rotate.v1` has only `{v:1, hub, epoch, keyUse:'identity', newKey, iat}`.
The outgoing pinned hub identity key signs its canonical successor SPKI. It is not a
device statement and has no device, challenge nonce, expiry or PIN. The consuming
rotation flow checks the current pin, identity, epoch and permitted succession;
parsing or signature verification alone never replaces a pin.

The PIN travels beside a device statement in its protected transport, never in the
signed body, a log or stored statement. Unregistered statement types have no generic
positive fallback. TypeScript registers one export line in statements/registry.ts;
Rust registers one plain `pub mod` line and one registration line in statements/mod.rs. Each type owns its generator
example and extra vectors; Rust document discovery follows TYPES.

### Agent-session statement

`agent-session.v1` uses the common device fields and two-minute challenge lifetime.
It additionally signs:

- `session`: the ULID of the immutable pending session operation.
- `principal`: `{kind:'grant'|'token', id:<ULID>}` for the exact agent credential.
- `account`: the exact account ULID, with no wildcard or implicit account expansion.
- `toolClass`: `read`, `draft` or `organize`.
- `authorization`: either `{kind:'session', durationMs}` with exactly 900000,
  3600000 or 28800000 milliseconds, or `{kind:'call', method, paramsDigest,
  validForMs:600000, singleUse:true}`. Per-call methods are `tools/call` and
  `resources/read`; a resource read requires class `read`. The digest is the
  [MCP parameter digest](mcp-surface-v1.md), binding the exact target and arguments.

The access lifetime starts when the hub accepts the statement, separately from
the signing challenge's `exp`. Gmail and SMS default to fifteen minutes, other
accounts to one hour; eight hours requires an explicit owner choice. A pending
record must bind every field and display the selected method and target for
per-call approval. Schemas and signatures cannot establish that review occurred.

`AgentSessionReviewSubject` is the closed TS and Rust review shape: `principal`,
`account`, `toolClass` and `authorization`. A session authorization contains the
same `kind` and `durationMs` as the statement. A call authorization contains the
statement's call fields plus `target`: a first-party tool name for `tools/call`,
or one of the four canonical data-resource URIs for `resources/read`. The target
must agree with the tool class. It never holds a subject, sender or other mailbox
text. The hub derives it from the same immutable validated params whose digest
the statement signs; the native window displays the method and target together.

`matchesAgentSessionPending(statement, {session, subject})` in TS and
`AgentSessionStatement::matches_pending(session, subject)` in Rust validate both
inputs and compare the operation ID, principal kind and ID, account, tool class
and every signed authorization field. The displayed target is review data, not
an additional signed field: consumers must retain its binding to those immutable
params. These helpers check neither a signature nor current authority, clocks or
single-use consumption. M1.26 adds this subject and statement to its review and
challenge unions when its device contract lands.

Acceptance requires the real current device/PIN gate and atomic challenge
consumption. The hub must re-read current principal, account, routing and device
rights within the write transaction, match the immutable pending operation and
store the grant with its wall/monotonic deadlines. Per-call authority is spent
once, only on the bound method and digest, within ten minutes. Revocation,
epoch changes and expiration invalidate access; retries and an accepted account
form grant no authority. Agent sessions never approve a send or mint a ticket.

### Consent statement

M1.20 defines consent.v1 and its exact fields and authority.

### Hub statement key

M1.23 defines the hub statement key and adds keyUse: statement by one list/enum line.

### Receipt key

M1.23 defines the host receipt key and its verification scope.

### Send-ticket statement

M1.23 defines send-ticket.v1; current statement dispatch does not accept it.

### Send-receipt statement

M1.23 defines send-receipt.v1; current statement dispatch does not accept it.

## Verification

The shared parsers validate structure and the typed signature opener additionally
checks the received bytes are canonical before verifying. They do not grant authority.
The consuming verifier must perform these steps:

1. Outside the write transaction, verify the authenticated device, confirmation and
   revocation state, required capability, hub/epoch, signature and Argon2 PIN. The
   exact issued challenge and operation fields must match. A local freshness check
   requires `iat <= now <= exp`; the hub also enforces its challenge's monotonic
   deadline so a wall-clock rollback or restart cannot extend it.
2. In a short `BEGIN IMMEDIATE` transaction, re-read authority and pending state,
   re-check freshness and the single-use challenge, then consume it, store the
   statement, audit and apply atomically. An asynchronous PIN check cannot authorize
   using a stale key, capability, PIN version, epoch or device record. Any failure
   rolls back the operation and must never be caught as a successful partial apply.
3. Send checks recomputed content/flag hashes and all required acknowledgements;
   the item is PENDING_APPROVAL and the draft has no other live item. SendPolicy
   permits the operation. Recompute the send window from the frozen snapshot and
   verified `iat`, never from another wall-clock read. Scheduled sends also require
   an allowed lateness window, `now + undo window <= notBefore <= now + 30 days`,
   exact zone/display-time agreement and fewer than 100 scheduled account items.
   Every other type matches its immutable pending record exactly.
4. Apply an immediate send as APPROVED, a scheduled send as SCHEDULED, storing
   approval without consuming it. N-of-M waits for every required approval, all
   arriving before `notBefore` minus the undo window. A late scheduled approval is
   refused and never converted to an immediate send.
5. Only the executor's guarded claim consumes approvals. It re-checks the epoch
   and that each counted approver remains confirmed, authorized and not revoked.

## Ticket minting

Only `outbox/executor.ts` imports `mintSendTicket` and `mintDeviceTicket` and sets
`state='SENDING'`. The guarded claim alone turns stored approvals into one-use send
authority. A statement signature, approved row, UI action, plugin, broker caller or
generic verifier cannot mint a ticket. Broker ticket and later host-ticket contracts
keep their own narrow formats; this statement module exposes no ticket-mint API.

## Admin operations

The closed `AdminKind` catalogue is grouped so later contracts add explicit kinds:

| Group | Kinds |
|---|---|
| Plugins | `plugin.install`, `plugin.upgrade` |
| Accounts | `account.connect`, `account.disconnect`, `account.mode-full` |
| Policy | `policy.routing-loosen`, `policy.auto-draft-enable` |
| Tools | `tool.instance-create`, `tool.secret-set`, `tool.enable`, `tool.posture-no-train` |
| Access | `access.token-mint`, `access.grant-widen`, `access.cimd-host-add`, `access.exposure-enable`, `access.bind-address-add`, `access.advertised-addresses-set` |
| Security | `security.device-capabilities`, `security.pin-change`, `security.key-rotate` |
| Data | `data.export`, `data.backup` |

`tool.secret-set` binds an API-key or URL-secret entry/replacement; the secret itself
is not an arbitrary statement field. `tool.enable` binds the account and tool instance
through the pending record. A parsed kind does not imply its endpoint is implemented.
access.advertised-addresses-set binds the hub's advertisedAddresses change.
access.exposure-enable covers changes to publicBaseUrl and trusted proxies as part
of the reviewed exposure configuration; it does not bypass their native policy.
`data.backup` is Back up now's encrypted hub backup, separate from `data.export`.
ADMIN_GROUPS has an empty SMS group so later contracts add each kind once.

Desktop operations use `admin_open` to create an immutable pending operation, then
the trusted window reviews it and signs `admin.v1` with the PIN. CLI admin operations
use control-socket peer credentials plus the PIN and audit `actor=cli`, unsigned.
Restore is a pre-init recovery-code operation. Revocation, disable, quarantine,
tightening, cancellation and the kill switch are never admin operations. They must
remain available through their narrower authenticated authority without demanding
an approval that the operation is intended to remove.

### S4 access kinds

M1.20 adds ADR 0006's explicit kinds to the access group; consent is not a wildcard.

### SMS admin kinds

M1.23 adds the SMS group's explicit kinds; the current empty group accepts none.

## Schedule and clock rule

`resolveLocalTime(wall, zone)` accepts a real ISO calendar minute
`YYYY-MM-DDTHH:mm` without an offset, seconds, annotations or surrounding
whitespace. The zone uses the shared `IanaZone` syntax and must exist in the
time-zone database. Earlier and later Temporal resolutions identify uniqueness:
equal instants are accepted; different instants whose earlier local time equals
the requested wall time give `AMBIGUOUS_LOCAL_TIME`; otherwise they give
`NONEXISTENT_LOCAL_TIME`. The resolver never parses an exception message or
silently adjusts a gap or overlap.

When `typeof Temporal === 'undefined'`, resolution and rendering fail with
`SCHEDULING_UNAVAILABLE`. Invalid grammar, dates, zones and unrepresentable
instants fail with `INVALID_INPUT`, without repeating the input.

`renderLocalWallTime(notBefore, zone)` returns `YYYY-MM-DDTHH:mm±HH:MM`.
Minute display preserves the original millisecond instant for hashing and send
window comparisons. The helpers accept nonnegative safe-integer UTC milliseconds
through `253402207200999`, the pinned Jiff timestamp limit. Unrepresentable years
and historical offsets containing seconds are refused. These helper limits do
not change `UtcMs` or the frozen `Schedule` schema.

Rust renders with `TimeZoneDatabase::bundled()`, rather than a global database
that can prefer system zoneinfo. The virtual `Etc/Unknown` sentinel and bundled
`Factory` placeholder are refused case-insensitively. `check_local_wall_time`
validates and renders the instant and zone, then returns false for a different
claimed display. Native review warns with the UTC instant when the display
differs. The shared schedule vectors record the Node/tzdata producer and the
pinned Rust dependencies; each language independently consumes every fixture.
A tzdata version difference alone warns; a different answer fails.

Scheduled claims and retries require
`min(hubNow, secondNow) >= notBefore` and
`max(hubNow, secondNow) <= deliverBy`. A malformed window refuses first; an
unreadable clock or skew greater than two minutes holds the account; a maximum
clock past `deliverBy` is missed; a minimum clock before `notBefore` is early.
The broker observes the pre-claim response's own `Date` header and advances it
by monotonic elapsed time. Plugins cannot supply this clock. The header must
round-trip exactly through its instant's IMF-fixdate, including the weekday;
normalised invalid dates and leap seconds are refused. Immediate items use the
hub clock.

HTTP `Date` has whole-second precision and is written before response transit.
It lags a correct upstream by less than one second plus the one-way latency.
With a correct hub clock this only delays a claim. With a slow hub clock and a
correct upstream, the literal late comparison can admit a claim after
`deliverBy` by at most that lag. This is the documented precision bound from
ADR 0015.

The scheduler uses injected-clock ticks of at most 15 seconds. It never arms a
timer from a distant `notBefore`. An early hold retries after
`clamp(ceil(notBefore - min(hubNow, secondNow)), 1000, 15000)` milliseconds;
skew holds and failed pre-claim reads retry after 15000 milliseconds. The next
due tick uses `max(notBefore, retryAt)` for each live row, with an account-wide
retry time after a skew hold. Each hold episode alerts and audits once; missed
is final. These claim and timer rules belong to the hub runtime; the schedule
helpers only resolve and display time.
