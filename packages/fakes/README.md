# @draftyak/fakes

Fake upstreams: small [Hono](https://hono.dev) apps that stand in for the services plugins call, so tests and `pnpm demo` never need credentials or the network. The plugin testkit routes a plugin's `host/fetch` to these fakes by host, and later fakes (gmail, slack, the AI providers, ICS feeds, FakeSmsHost) build on the same pieces: `createFake`, the recorder, the faults module and request targets. The package is private.

Import from `@draftyak/fakes`, or from `@draftyak/fakes/<module>` for a file directly under `src/` (`server`, `recorder`, `faults`, `target`, `hello`, `tool-upstream`).

## Rules every fake follows

- **One host.** A fake answers for its own host name; a request for any other host gets `421 Misdirected Request` and meets neither a scripted fault nor the app. The fakes here live under `.example`, which RFC 2606 reserves, so their names never resolve to a real host. No fake makes an outbound request.
- **Loopback only.** `fake.fetch` serves in memory, with no socket. `fake.listen()` binds 127.0.0.1 only, on a port the OS picks, and never keeps 47613–47615 (the hub's listeners) or 9229 (the Node inspector): when the OS offers one of those, it closes it and asks again.
- **Header values only on request.** The recorder keeps every header's name but a header's value only when the test names that header, so tokens and cookies in headers aren't stored by default. Paths, queries and bodies are kept as sent, and they can hold secrets: the tool upstream's secret path is the url-secret itself, and later fakes see query tokens and OAuth form bodies. So never print recorder entries in a canary test.
- **Synthetic data.** Texts start with `DYTEST`, and names and addresses are under `.example`.

## createFake

```ts
const fake = createFake(app, { host: "hello.draftyak.example", recorder?, faults?, maxRequestBodyBytes? });
```

`app` is a Hono app, or anything with Hono's `fetch(request)`. The fake gets a fresh recorder and fault script unless you pass shared ones. It returns:

| Member | What it does |
|---|---|
| `host` | The host name it answers for. |
| `fetch(input, init?)` | Serves a request in memory, with `fetch`'s signature, so it can stand in for `fetch`. A bare path such as `"/v1/me"` goes to `https://<host>/v1/me`. A URL string keeps its exact target (below), which `fetch` would normalize first. An aborted signal rejects with its reason, whether the request hasn't been sent, the app is still working or the body is still streaming. Redirect modes act as in `fetch`: `follow`, the default, asks the same fake again, up to 20 times, and turns a 303, or a 301 or 302 after a POST, into a GET; `manual` returns the 3xx; `error` rejects. A redirect to another host gets this fake's 421. A dropped connection rejects with `TypeError("fetch failed")`, as `fetch` does. |
| `listen()` | Serves the fake on `127.0.0.1` at a random port and resolves to `{port, origin, close()}`. There it also answers for `<host>:<port>`, `127.0.0.1:<port>` and `localhost:<port>`. `close()` ends open connections and can be called twice. |
| `recorder` | Every request the fake received, below. |
| `faults` | The fault script and the clock, below. |

Each request is recorded as it arrives. A request for another host then gets its 421; any other meets its scripted fault, if any, then the app. Requests are recorded and take their faults in arrival order, a request's record is complete before its answer goes out, and every answer gets a `Date` header from the fault script's clock.

`maxRequestBodyBytes` optionally limits uploads to whole bytes from 1 to 64 MiB, inclusive.
Both in-memory and loopback intake reserve the record and fault on arrival, then read under
the cap before any redirect or application body clone. An oversized upload is cancelled and
never reaches the app. It returns `413 {"error":"request_body_too_large"}` with the clock's
`Date`, unless it targets another host (421) or a matching scripted fault supplies the answer.
The record contains all bytes read through the chunk that crossed the cap, with only the
configured prefix retained, and `refused: "request_body_too_large"`. Its hash and length cover
those received bytes, not the unread remainder. A refused record cannot prove a byte-equal
whole send. The hello fake and tool upstream leave intake uncapped.

## Request targets

A request's target is what it asks for: its path, query and any fragment. The recorder, a fault's `path` and the tool upstream's secret path all use the target exactly as it arrived: over loopback, the request line; in memory, the URL string passed to `fake.fetch`. URL parsing (`new URL`, `new Request` and so `fetch` itself) would resolve `.` and `..` segments, `%2e%2e` included, turn `\` into `/`, drop tabs and percent-encode spaces, quotes and non-ASCII, and `fetch` sends no fragment. So a `Request` or `URL` object reaches a fake already normalized: to check that a URL arrives unaltered, pass it as a string.

`rawTarget(request)` returns a request's target and `splitTarget(target)` its path and query; a later fake matches raw paths with them. Code that must build a `Request` from a URL string itself keeps the string's target with `withTarget(request, targetOf(url))`.

## Recorder

`createRecorder({headerValues?, maxBodyBytes?})`, which throws a `RangeError` unless `maxBodyBytes` is a whole number. `recorder.takeRequests()` returns the requests recorded since the last call, in arrival order, and forgets them; a request still sending its body holds back itself and every later one until a later call. Each is:

| Field | Contents |
|---|---|
| `method`, `host` | As received; `host` includes a port when the request had one. |
| `target` | The request target as it arrived, nothing decoded, resolved or dropped. |
| `path`, `query` | The target's path, and its query without `?`, each ending at any `#`; `%40` stays `%40`. |
| `headerNames` | Every header name, lower-case and sorted. |
| `headers` | Values of the headers named in `headerValues` only; `{}` by default. |
| `body` | The first `maxBodyBytes` bytes (65,536 by default). |
| `bodyLength`, `bodySha256` | The whole body's length and the lowercase hex SHA-256 of its exact bytes, however long. |
| `refused` | Absent for a complete body; `"request_body_too_large"` when bounded intake stopped. In that case the length and hash cover only the bytes received before refusal. |

The recorder hashes its copy incrementally and retains only the configured prefix, so the app
still gets the body and the hash covers every byte. Its retention cap does not reject uploads;
set `maxRequestBodyBytes` on the fake to bound intake before body cloning. Pass one recorder to
several fakes to see their traffic in arrival order. `begin(request)` reserves a slot and returns
`write(bytes)`, `finish(refused?)` and `discard()` for bounded intake; each slot must be finished
or discarded once. `record(request)` streams a clone into the same writer for uncapped intake.
Custom recorders that expose only `record` and `takeRequests` remain valid for uncapped fakes.
A capped fake requires `begin` and refuses an incompatible recorder during construction,
before any request is accepted. `createRecorder` returns a `StreamingRecorder` with `begin`.

## Faults and the clock

`createFaults({clock?})`. `faults.add(...faults)` scripts faults; each request takes the first fault that matches it and still has uses left. `faults.pending()` lists what is left and `faults.clear()` drops it all. A script shared by several fakes gives each fault to the first matching request any of them receives.

| Fault | Effect |
|---|---|
| `{kind: "rate-limit", retryAfter: 30}` | `429` with `Retry-After: 30`; `retryAfter: {at: utcMs}` sends an HTTP date instead. |
| `{kind: "server-error", status?: 5xx}` | That status, `503` by default. |
| `{kind: "latency", ms}` | Waits, then lets the app answer; `Infinity` waits until the request is aborted. Aborting the request ends the wait with the signal's reason, as `fetch` would. |
| `{kind: "drop"}` | Closes the connection without an answer: over loopback the socket is destroyed; in memory `fetch` rejects. |

Every fault also takes `method` (any case), `path` (the target's exact path, or a `RegExp` tested against it), `times` (1 by default, `Infinity` for every match) and `after: true`, which lets the app answer first, so the request takes effect before the fault: a send that succeeded but whose answer was lost.

`add` throws a `RangeError`, and adds none of the batch, for a fault that couldn't run as scripted: `retryAfter` below 0 or not a number of seconds, an `at` outside 1970–9999, `ms` that isn't whole milliseconds from 0 to 2^31 − 1 or `Infinity` (Node fires a longer timer after 1 ms), a status outside 5xx, or `times` that isn't a positive integer or `Infinity`.

The clock is `{now(): number}` in UTC milliseconds; `systemClock` is the default. `manualClock(start)` moves only through `set(ms)` and `advance(ms)`. Fakes stamp `Date` from it, and the hello fake also expires cursors by it. `httpDate(ms)` formats an IMF-fixdate, `wait(ms, signal)` is the abortable wait the faults use, and `checkDelay(name, ms)` checks a delay option as `add` does.

## The hello fake

`createHelloFake({clock?, recorder?, conversations?, cursorTtlMs?})`: a chat service at `hello.draftyak.example` for `channel-hello` and the channel template. It starts with `HELLO_SEED`, two conversations, `conv-1` with three messages and `conv-2` with one. `cursorTtlMs` is milliseconds from 0, or `Infinity` for cursors that never expire. Besides the `Fake` members it has `addMessage(conversationId, {author, text})`, a message from someone else as if it had just arrived, and `messages(conversationId)`.

| Request | Answer |
|---|---|
| `GET /v1/me` | `{id: "me"}`, the account's own user id. |
| `GET /v1/conversations` | `{conversations: [{id, name}]}` |
| `GET /v1/conversations/{id}/messages?limit=<n>&cursor=<cursor>` | `{messages, cursor, more}`, oldest first, `limit` 1–200 (50 by default). Without a `cursor`, or with an empty one, the first page. A held `cursor` later returns only what arrived since. A cursor expires `cursorTtlMs` after it was issued (one hour by default): `410 {"error": "cursor_expired"}`. An unknown cursor, or one from another conversation, gets `400 invalid_cursor`; a bad limit `400 invalid_limit`; an unknown conversation `404 unknown_conversation`. |
| `POST /v1/conversations/{id}/messages?idempotency_key=` | Body exactly `{"text": "<1 to 4,000 code points>"}` as `application/json`: one member, nothing before or after the object, no byte order mark and no lone surrogate. The limit counts code points, as Python's `len` and Rust's `chars().count()` do, so 4,000 emoji pass. `201 {id, conversationId, createdAt}`, with the provider id `msg_NNNNNN`; the message's author is `me`. The key may come from the query, where a json-template binds the outbox id, or from an `Idempotency-Key` header, but not two different ones (`400 idempotency_key_mismatch`). A repeat of a key with the same conversation and body gets the first answer again, with `Idempotent-Replayed: true`, and creates nothing; any other reuse gets `409 idempotency_key_reused`. Otherwise `415 unsupported_media_type` or `400 invalid_body`. |

Message objects are `{id, conversationId, author, text, createdAt}`, with `createdAt` in UTC milliseconds from the clock. Errors are `{"error": "<code>"}`.

## The tool upstream

`createToolUpstream({clock?, recorder?, feed?, secretPath?, slowMs?, oversizeBytes?})`: a read-only feed host at `feeds.draftyak.example` for `toolContract()`, its fixtures and the tool template. Besides the `Fake` members it has `secretUrl`, the full secret URL a test stores as the url-secret, and `setFeed(text)`, which replaces the feed and so its `ETag` and `Last-Modified`. It throws a `TypeError` for a `secretPath` that URL parsing would change or that decodes to a public route's path (such as `/feed.ics?token=…`), and a `RangeError` for a `slowMs` or `oversizeBytes` it couldn't keep.

| `GET` or `HEAD` | Answer |
|---|---|
| `/feed.ics` | `TOOL_FEED`, a small DYTEST calendar, as `text/calendar` with `ETag`, `Last-Modified` and `Content-Length`. `If-None-Match` (weak comparison, a list, or `*`) and, without it, `If-Modified-Since` get `304`. |
| `TOOL_SECRET_PATH` | The same feed, at a secret path holding `%40`. It matches only a target that arrives byte for byte as the secret, so the decoded `@`, a `%2540`, an added query, `?` or fragment, and `.`, `..` or `\` changes get `404`, as an owner-entered secret URL must reach the host unaltered. |
| `/redirect.ics` | `302` to `/feed.ics`, which a broker must not follow; `fake.fetch` follows it unless told `redirect: "manual"`. |
| `/oversize.ics` | `oversizeBytes` of padding, 32 MiB + 1 byte by default (past the largest tool fetch cap), streamed in 64 KiB chunks with its `Content-Length`. |
| `/slow.ics` | The feed after `slowMs`, 30 s by default (past every lookup timeout), or never with `Infinity`; an aborted request stops the wait. |
| anything else | `404` with no body. |

Every feed answer also carries `Set-Cookie` and `X-Upstream-Trace` (and `Date`), headers outside the `tool-*` allowlist (`Content-Type`, `ETag`, `Last-Modified`, `Content-Length`) that the broker must strip. Other methods find no route and get `404`.

## The Gmail fake

`createGmailFake({accessGrant, clock?, recorder?, messages?, readBudget?, sendBudget?})`
returns the shared `Fake` interface with Gmail fixture controls. Import it from
`@draftyak/fakes/gmail` or the package root. `GMAIL_HOST` is the logical host
`gmail.googleapis.com`, so an injected fetch can receive the exact approved
provider URL. This fixture makes no outbound request; its optional listener is
still loopback-only. Message addresses and content must remain synthetic.

`accessGrant(token)` supplies `{scopes, expiresAt}` or `undefined` for a synthetic
bearer. It can bind the Google OAuth fake's `accessGrant` without importing that
fake or any production credential service. The expiry uses UTC milliseconds.
Missing/expired grants return 401, and insufficient scopes return 403. Read-only
can read raw mail but cannot mutate or send. Metadata-only grants cannot retrieve
bodies or search. These fixtures do not authenticate or approve a real account.

Seeds are `{id, threadId?, raw: Uint8Array, labelIds?, internalDate?}`. The fake
copies raw bytes and returned state. `addMessage`, `deleteMessage` and `setLabels`
record history; `historyId` exposes the current checkpoint and
`expireHistory(before)` makes older checkpoints return 404 for rescan tests.
`message(id)` returns a detached stored message. `queueSend(...steps)` accepts
`{kind: "accept", date?, messageId?}` or
`{kind: "mail-rate-limit" | "concurrent-rate-limit", retryAfterSeconds}`. A
queued header rewrite models a possible provider outcome rather than an S8
finding. A rate step returns 429 immediately with the complete Retry-After;
tests advance their clock rather than waiting hours. The shared fault
`{kind: "drop", after: true}` models an accepted send with a lost reply.

Supported routes under `/gmail/v1/users/me` are profile, paginated messages and
threads, message/thread projections, history, label modification/batch modification,
and JSON `messages/send`. The approved
`/upload/gmail/v1/users/me/messages/send?uploadType=multipart` route accepts a
bounded multipart/related metadata part plus exact message/rfc822 bytes. Raw
read-back preserves those bytes unless the fixture explicitly scripts a header
rewrite. Metadata projections contain headers without body data. The `full`
projection is a basic top-level header/body fixture, not a general MIME parser;
use raw mail with the real content parser for MIME integration.

Only the documented search subset is implemented; unsupported queries and wire
fields fail rather than fabricate a match. A Gmail-UI scheduled seed carries
`SCHEDULED`/`DRAFT`, not `SENT`; it can be read without establishing that a send
happened. Native consumers must still enforce their own scheduled-mail exclusion,
complete bounded scans, attempt identity, body/thread checks and uncertainty rules.

Thread joins in this fixture require an exact Subject match plus References and
In-Reply-To identifying a stored parent in the requested thread. A mismatch is a
fixture refusal, not a prediction of how Gmail would assign a thread. Search
supports AND combinations of `in:sent`, `in:inbox`, `in:scheduled`, `is:unread`,
`after:<epoch-seconds>` and `rfc822msgid:<id>` only. Page tokens retain a bounded
snapshot for 60 seconds and bind the bearer, route and filter set; changing those
inputs refuses the token. Retrying a non-final token returns the same continuation
without reserving another cursor. Expiring or evicting history advances its floor.

Optional budgets are `{units, windowMs}`: one unit per admitted request, in
independent send and non-send fixed windows. They are synthetic counters rather
than Google's quota weights. Moving the fixture clock backward clears budget
and page state. Storage is capped at 1,024 messages and 64 MiB of raw bytes,
with at most 36,700,160 raw bytes per message, 2,048 retained history records,
128 page tokens/4 MiB of retained page data, and 1,024 queued send steps.
Shared intake caps request bodies at 50 MiB before application or redirect
cloning. Oversize requests normally return the shared `413 request_body_too_large`
response and are cancelled; a scripted fault retains its arrival-order response.
The recorder retains its configured prefix and hashes received bytes, including
the offending chunk, with a refusal marker rather than claiming to read the
unreceived remainder. Custom recorders must implement the shared `begin` writer.
App-side request and JSON response parsing retains its 50 MiB cap. The app reader
also limits its forwarded body to 65,536 yielded chunks; shared intake buffers
and replaces the body, so this is not a limit on original ingress chunk count.
These are no global memory, concurrency or stream-duration bounds. Native
transport limits remain separate.

The independent test oracle reads the vendored Gmail discovery document
(revision `20261012`, SHA-256
`1eefc40da41cc5d19736d26b16f7f276a0300307c36b9abe33dc6c3ab12f414b`)
and checks supported request and successful response shapes. Required fields
follow that document; the fixture separately requires `startHistoryId` for history
requests. Product modules import no spike code. Discovery conformance does not
establish live Gmail behavior. Actual approval, broker scope/identity injection,
exact MIME rendering, durable apply/outbox state and S8/ADR 0010 cases remain
native/owner integration.

## Adding a fake

1. Put the public part in `src/<name>.ts`, which `@draftyak/fakes/<name>` then exports, and anything larger in `src/<name>/`.
2. Build a Hono app for the service's routes. Let errors throw (`app.onError((error) => { throw error; })`), so an aborted request rejects as `fetch` would. Match raw paths or queries with `rawTarget(c.req.raw)`, since Hono's own path is decoded.
3. Return `createFake(app, {host, faults: createFaults({clock}), recorder})`, plus whatever controls the tests need. Take the clock from the options, and reuse the fault script for 429s, 5xx, latency and drops rather than adding routes for them. Check delay and size options when the fake is created (`checkDelay`).
4. Keep fixtures synthetic, and test the fake in `test/<name>.test.ts`.

## The Google OAuth fake

`createGoogleOAuthFake({clock?, recorder?, clients?, codeTtlMs?,
accessTtlSeconds?, refreshTtlSeconds?, rotateRefreshTokens?})` serves the synthetic
`google-oauth.draftyak.example` host in memory or on the shared loopback listener.
Import it from `@draftyak/fakes` or `@draftyak/fakes/google-oauth`. Constants
`GOOGLE_OAUTH_HOST`, `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_REDIRECT_URI`
provide an invented Desktop registration. No request calls Google or follows an
outbound callback. Use `redirect: "manual"` to inspect the authorization response.

| Request | Fixture behavior |
|---|---|
| `GET /o/oauth2/v2/auth` | Requires a registered client/exact callback, nonempty state/scope, `response_type=code` and a 43-character S256 challenge. Returns a 302 with echoed state and a single-use code, or a queued consent denial. |
| `POST /token` | Accepts UTF-8 form data. Checks the registered client/secret, exact callback, 43–128-character verifier and S256 digest before code exchange. Refresh checks client binding, expiry, revocation and the configured rotation policy. |
| `POST /revoke` | Accepts a form `token`. Revokes that client's current authorization, including earlier consents, rotated tokens and pending codes. Other clients remain independent. A fresh consent establishes a fresh authorization. |

`endpoints` exposes the three synthetic URLs. `enqueueConsent(...steps)` accepts
`{kind: "grant", scopes?}` for normal granular consent, `{kind: "deny"}`, or
`{kind: "unexpected-grant", scopes}` to deliberately return unrequested grants
for caller-refusal scenarios. Only that explicit hostile step can overgrant;
ordinary consent stays within the requested scope set. `email` and `profile`
have their Google URI aliases in responses; equivalent spellings compare equally
for granular consent. The fixture can supply complete, missing, empty, companion,
broad, settings and out-of-mode grants. It makes no decision about the caller's
full/read-only scope admission.

`enqueueTokenError(...steps)` scripts `invalid_grant`, `invalid_client` or
`temporarily_unavailable`, optionally restricted to `authorization_code` or
`refresh_token`. An error consumes no code or refresh token. Wrong code binding
consumes that authenticated exchange attempt; a valid code exchanges only once,
including concurrent attempts. Shared before-effect faults bypass the handler;
after-effect lost replies leave its code consumption or refresh rotation intact.

`accessGrant(accessToken)` returns a new frozen `{clientId, scopes, expiresAt}`
with a frozen scope list, or `undefined`. `revoke(token)` is the fixture-side
equivalent of a successful revoke request. Revoke requests are recorded so callers
can distinguish confirmed/unconfirmed initial-grant cleanup from failed
reconnect/mode-switch handling that makes no automatic whole-client revoke.
These are synthetic grant facts and traces; native admission and persistence
belong to the connection flow.

Callbacks are exact canonical HTTP URLs with numeric `127.0.0.1` or `[::1]`,
an explicit port and no query/fragment. No wildcard or hostname callback exists.
There are at most 32 clients and 16 callbacks per client, 256 queued consent
steps and 256 token errors, 4,096 pending codes and 4,096 token entries. Expired
entries still count toward those finite budgets; create a fresh instance to reset.
Scope requests allow at most 16 entries and 2,048 characters, with 256 characters
per scope. Forms/authorization queries allow 32 unique parameters and 16 KiB;
duplicate keys and malformed percent-encoded or raw UTF-8 are refused.

The shared `maxRequestBodyBytes: 16384` intake runs before handler admission or
body cloning. Oversize intake cancels and normally returns a dated 413. Its
recorder entry is marked `request_body_too_large`; the length/hash cover all
received bytes through the crossing chunk, not an unread remainder. Retention
uses the recorder's configured prefix. Arrival faults are still reserved and
consumed and can supply the response instead. Incomplete malformed/aborted
streams reject and discard their recorder slots. A byte cap provides neither an
upload deadline nor an original-ingress chunk-count bound. A custom recorder
must provide `begin` as well as `record` and `takeRequests`.

Default lifetimes are ten minutes for codes and one hour for access tokens;
refresh tokens have no expiry unless configured. The injected clock determines
expiry and `Date`. Refresh rotation defaults to true as declared fixture policy,
not a claim about Google's behavior. The fake proves no native callback-state,
identity, credential storage, disclosure, cleanup enforcement or live acceptance.

## The Slack read fake

`createSlackReadFake({conversations, ownerId?, users?, scopes?, nowMs?, readBudget?})`
serves synthetic reads at `slack.draftyak.example`, in memory or on its loopback
listener. It has no authentication exchange, Socket Mode, send, scheduling or
reconciliation implementation. Its responses establish no native approval,
credential, freshness, purge or vendor-policy authority.

`ownerId` is an invented Slack user ID, default `UDYTEST01`. Conversation
`member` means membership of that connected owner. A request cannot select
another owner. `users` contains detached `{id, name, displayName, realName}`
profiles; without it, the fake supplies a synthetic owner profile. `scopes`
defaults to the supported channel read/history scopes and `users:read`.

| Request | Behavior |
|---|---|
| `GET /api/users.conversations` | The connected owner's conversations allowed by its read scopes. Accepts only `cursor`, `limit`, `types` and `exclude_archived`; a caller `user` selector is refused. |
| `GET /api/users.info?user=<id>` | A validated user selector is required. `users:read` is required before looking up the profile; otherwise `missing_scope`, including for an unknown user. |
| `GET /api/conversations.info?channel=<id>&include_num_members=true` | Current synthetic facts under the conversation type's read scope. The optional member count is emitted only when requested. |
| `GET /api/conversations.history?channel=<id>` | Root messages, newest first, under that type's history scope. |
| `GET /api/conversations.replies?channel=<id>&ts=<root>` | Root and replies, oldest first, under that type's history scope. |

History and replies accept `cursor`, `limit`, `oldest`, `latest` and `inclusive`.
Timestamp comparisons preserve up to nine fractional digits without floating
point conversion. Unknown keys, duplicate keys, malformed raw paths and
selectors are refused. Legacy `conversations.list`, `users.list` and all writes
are denied. No request makes a provider call.

Lists and message reads use pages of 1–200 rows (100 by default). Cursor tokens
are opaque, instance/route/filter-bound snapshots; a repeat is stable, a token
expires after 60,000 injected milliseconds, and moving the clock backwards
invalidates cursors and rate windows. Provider filters run after each virtual
page, so an empty page can still have a next cursor. Current owner membership
and scopes still restrict every list page.

Membership controls list visibility. Configured fixture info and message routes
remain addressable under their type scopes after membership changes; this
synthetic control does not model Slack's complete resource authorization rules.

Fixture controls are `conversation(id)`, `changeConversation(id, patch)`,
`addMessage(channel, message)`, the checked manual `clock`, and `revoke()`.
They support rename, archive, sharing, membership, growth and new replies.
`revoke()` makes every supported read return `token_revoked`; it does not
purge fixture state or call a revoke endpoint. Create a new instance to reset
state. Constructor values and returned facts are isolated from caller changes.

Limits are 300 conversations, 1,024 user profiles and 1,024 messages. Message
text is NFC and at most 4,096 UTF-8 bytes; conversation names and profile display
names are at most 256 bytes, user names 64 bytes. Responses are capped at
256 KiB, with separate 4 MiB budgets for message text, cursor snapshots and
recorder accounting. At most 128 cursors and 1,024 pending recorder entries
are kept. Raw targets are at most 2,048 characters; each record permits 64
headers and 8,192 bytes of target/header accounting. Draining the recorder
releases its budget. Header values are not retained. Unsupported request bodies
are cancelled without cloning or collecting them.

`readBudget: {calls, windowMs}` supplies a synthetic per-method fixed window
(default 1,000 calls per 60,000 milliseconds). Exhaustion returns Slack-shaped
`429 ratelimited` and a ceiling-rounded delay-seconds `Retry-After`. This is
fixture policy, not a claim about Slack's actual tier or internal-app exemption.
The shared `faults` script remains available for rate limits, errors, latency
and drops, and stamps `Date` from the same injected clock.

### Synthetic Slack send effects

`createSlackSendFake({read, userToken: "DYTEST-send-user"})` adds a separate
provider write fixture using a supplied `createSlackReadFake` instance. The
existing read factory stays read-only. The new factory is available from the root
and `@draftyak/fakes/slack` exports; it adds no dependency or native approval
implementation.

Only POST `/api/chat.postMessage` with JSON `channel`, optional `thread_ts`,
`text`, and both `unfurl_links:false` and `unfurl_media:false` is admitted.
A fixed invented DYTEST bearer is required. Extra fields, including
`reply_broadcast`, refuse. This fixture never renders or converts broadcast
intent. Native rendering, approval, broker tickets, current-fact policy,
scheduling and actual reconciliation remain separate.

A successful write appends once through the reader's public `addMessage`
control. Read it back with that reader's public history/replies requests. Text
is opaque already-rendered data, retained exactly: nonempty NFC, well-formed,
at most 4,096 UTF-8 bytes and 4,096 UTF-16 units, with only TAB/LF controls.
The existing 1,024-message/4 MiB state and thread-parent constraints apply;
this is narrower than the native renderer's limits. A supplied reader whose
owner cannot be stored by its message controls is refused at construction.
The collaborator is trusted executable fixture input, not a runtime identity
proof. The sender owns only its own listeners, not the supplied reader.

Timestamps use the reader clock with a per-sender monotonic nanosecond suffix.
Clock rollback does not reuse a committed identity. Collision, refusal or state
exhaustion leaves the suffix unchanged; advancing the fixture clock can resolve
a collision with seeded data. This is synthetic identity behavior, not provider
pacing or idempotence. A repeated successful request remains a second write.

The shared 32 KiB wire-intake cap is distinct from the stored-text limit.
Refused intake can retain a received-prefix record and consume an arrival
fault; the shared recorder is not globally bounded. Before-effect failures
produce no message; after-effect drops can leave one message despite a lost
reply. Abort before the synchronous append has no effect, while loss after
append does not undo it. Rate limits, Retry-After and Date use shared scripted
faults and the reader clock; they establish no real tier/exemption or live
Slack behavior. No shared server/recorder/fault changes or Socket Mode fixture
dependency are required.


### Synthetic auth and Socket Mode companion

`createSlackSocketFake` is separate from the read factory. It adapts the ordinary
S6 fixture's synthetic user/app token checks, `auth.test`,
`apps.connections.open`, hello/event envelopes, acknowledgements, dropped ACKs,
redelivery and disconnect controls. It implements no native credential, approval,
broker, send, scheduling, reconciliation or corpus authority.

`await fake.start()` starts one private HTTP/WebSocket listener on IPv4 loopback;
`fake.apiBase` is its HTTP API base. `fake.listen()` returns that same listener,
and its `close()` closes the whole companion. An in-memory
`fake.fetch('/api/apps.connections.open', ...)` also starts the private listener
to return a usable WebSocket URL. HTTP requests use the existing capped shared
fake/recorder/fault path. There is no shared server upgrade API or native fetch
fallback.

Use `fake.userToken` for a bare POST to `/api/auth.test` and `fake.appToken`
for `/api/apps.connections.open`, in a Bearer header. These generated DYTEST
values are fixture controls. Extra query/form arguments and every other route
are refused. The open response contains a single-use, instance-bound local URL;
wrong paths, queries and browser Origin headers cannot redeem it. The controlled
`clock` expires unused tickets after 60 seconds and supplies HTTP Date headers.
A failed handshake on the correct path may consume a ticket, as in S6.

`sendHello`, `deliver(payload, {connection?, type?, acceptsResponsePayload?})`,
`frame(connection, value)`, `dropAcks`, `acksFor(id)`,
`disconnect(connection, reason, delayOrNull)` and `terminate(connection)` are
synthetic controls. Obtain opaque connection handles from `live()`; another
instance's handle refuses. Envelopes and ACK diagnostics are available through
read-only bounded snapshots; current pending ACK lookup survives diagnostic history
eviction. Caller payloads are copied as inert, finite JSON;
getters, proxies, custom serialization, deep/large collections and nonfinite
numbers refuse. Caller-provided payload content remains intentional fixture data.

ACKs are text JSON containing only `envelope_id`. Unlike the permissive spike,
this companion refuses binary/malformed ACKs, binds valid IDs to their delivery
socket, omits unknown IDs from retained diagnostics and consumes `dropAcks` only
for valid ACKs. It does not process response payloads;
`acceptsResponsePayload` controls the emitted wire flag only. Unacknowledged
envelopes retry at most three times (attempts 0,1,2,3), each with a fresh ID, the
same copied payload/type and the newest live connection. Retries reset the
response-payload flag to false, as in S6. An old-ID ACK does not cancel a newer
retry. Work stops if no live socket remains instead of waiting forever.

| Work | Fixture-local bound |
|---|---|
| HTTP admission | 16 KiB per upload, 16 concurrent in-memory/bridged requests, a 1-second abort timer |
| Private transport | 8 TCP sockets including handshakes/HTTP/WS; 4 KiB handshake headers; 60-second socket lifetime |
| Tickets | 32 outstanding, 60 seconds on the controlled clock |
| Event wire / ACK message | 16 KiB / 1 KiB |
| Delivery work | 64 pending events; at most 3 redeliveries per event |
| Per-connection work | 256 outgoing messages and 256 received ACK/ping/pong messages |
| Retention / timers | 256 entries per envelope/ACK/connection/HTTP record collection; 128 owned timers |
| HTTP fault scripts | 32 pending; finite uses at most 1024 and latency at most 1 second |

These bound completed message work and fixture-owned state; they make no
original-ingress chunk/fragment count, arbitrary JavaScript CPU/time or global
process-memory guarantee. Public `faults.add/run` refuse after close; `pending`
and `clear` remain usable. Fault selection and latency use an abortable bodyless
metadata request; the app still receives its original Request without a body
clone. Close aborts fixture-owned waiting without waiting for a caller-provided
app callback to settle. Such callbacks retain ownership of their own work; no
arbitrary JavaScript is preempted. ACK/retry/disconnect timers and socket lifetime use
real timers; advancing the HTTP/ticket clock does not advance them. Event-loop
scheduling can delay timer callbacks. Trusted shared-fault match predicates
retain their usual caller responsibilities.

Retained HTTP records omit all header values, query values and body prefixes,
while keeping bounded method/route metadata and received-byte lengths/hashes
(including shared over-cap refusal evidence). Unknown paths become `/refused`; unknown method names become `OTHER`, and
only fixed known header names remain.
Synthetic auth values and ticket URLs are not retained in HTTP/ACK diagnostics.
Direct `recorder.record` refuses body-bearing uploads; capped admission uses
`begin/write` through `fetch`. Draining records releases their slots.

`await fake.close()` is idempotent: it aborts owned uploads, cancels timers,
invalidates tickets, terminates owned sockets, closes the private listener and
clears retained state. It leaves other fakes alone; later use refuses.
This synthetic suite is not native client ACK-before-reduce/deduplication,
Socket Mode broker, ADR 0008, renderer/corpus or milestone acceptance.
