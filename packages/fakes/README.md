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

## Adding a fake

1. Put the public part in `src/<name>.ts`, which `@draftyak/fakes/<name>` then exports, and anything larger in `src/<name>/`.
2. Build a Hono app for the service's routes. Let errors throw (`app.onError((error) => { throw error; })`), so an aborted request rejects as `fetch` would. Match raw paths or queries with `rawTarget(c.req.raw)`, since Hono's own path is decoded.
3. Return `createFake(app, {host, faults: createFaults({clock}), recorder})`, plus whatever controls the tests need. Take the clock from the options, and reuse the fault script for 429s, 5xx, latency and drops rather than adding routes for them. Check delay and size options when the fake is created (`checkDelay`).
4. Keep fixtures synthetic, and test the fake in `test/<name>.test.ts`.

## Scripted Responses API

`createResponsesApiFake({clock?, recorder?, steps?})` serves finite synthetic
JSON, SSE or raw responses for exact `POST /v1/responses` at logical host
`api.openai.com`. The host is used only for in-memory matching; `listen()` binds
to numeric loopback. It makes no vendor request and checks no credentials.
`createResponsesApiDraftFake` additionally checks the closed API-key drafting
request shape: model, instructions, one user input, strict `draft_output` JSON
format, `store:false`, `stream:true`, and optional nonempty reasoning effort.
Schema contents remain opaque fixture data. This is no native verifier,
pin, consent, header, schema or credential authority, nor a live wire oracle.

`enqueue(...steps)` snapshots wire bytes atomically. JSON serializes the supplied
value; SSE serializes `{event, data}` entries into exact event/data frames; raw
scripts retain malformed text and optional content type. Status, headers,
header delay, chunk bytes and inter-chunk delay are configurable. Both delays
accept `Infinity` until abort/cancel. These scripts can represent benign,
obedient, schema-breaking, refusing, slow, authentication, rate and quota cases;
they make no claim about model safety or vendor availability.

There are at most 1,024 queued steps, 4,096 events per SSE step, 16 MiB of UTF-8
wire bytes per step, 65,536 emitted chunks per step and 64 MiB of queued response
payload bytes. Chunks are 1–65,536 bytes. Preparation stops at the first overflow
without adding any part of the batch or preparing later steps; reentrant enqueue
during serialization is refused. The aggregate budget includes JSON bytes and
SSE framing, and is released at app admission, before response delays or reads.
Caller-owned input, JSON serialization temporaries, headers and active responses
are separate from that queued-payload budget; it is no global memory ceiling.
Fixture serialization and property/iterator callbacks execute caller-supplied
JavaScript; these limits neither sandbox that code nor bound its runtime.

Ordinary `fetch` and `listen` use the shared one-MiB request intake cap before
redirect cloning and handler admission. Admitted non-null bodies are buffered
into a replacement Request. Oversized input normally returns `413` and consumes
no app step. The recorder retains its configured prefix and a hash of received
bytes including the crossing chunk, marks the refusal, and does not claim the
unread remainder. Arrival faults are reserved/consumed independently; a fault
can replace the refusal response. Malformed chunks, aborts and upload errors
discard incomplete records without consuming a step. A custom recorder needs
`begin`, called with its original receiver. This cap provides no original-ingress
chunk-count, duration or global-memory limit.

The exported fake also has `handler(request)` and `recorder` for ordinary generic
composition. Passing the original Request to `handler` leaves its URL, raw target,
headers and wire body untouched. Direct calls apply no shared host check, intake
buffer, recording, Date header or fault script; callers supply those layers with
the existing shared APIs when needed. The handler's own defensive reads cap one
MiB and 65,536 yielded app chunks, including empty chunks, cancel malformed or
excess input and preserve abort/source errors. Buffered shared intake does not
preserve original upload chunk counts. Strict decoding is fatal UTF-8 with JSON's
ordinary last-member semantics, not duplicate-member refusal.

`pending()` counts queued steps only. Exact matching requests consume on app
admission before app reads or response waits, including a strict shape refusal.
With shared capped intake, a later completed upload can therefore reach the app
first while recorder entries retain arrival order. Wrong target/method and
pre-app faults consume no step; after-app faults do. Discarded response streams
release their own waits. Exhaustion is a fixed `503`; strict shape refusal is a
fixed content-free `400`. No automatic repair, native admission or billing switch
is implemented. The public root and `@draftyak/fakes/responses-api` expose the same
factories.

## The Messages request fake

`createMessagesApiFake({clock?, recorder?, steps?})` supplies finite synthetic
JSON, SSE or raw response scripts at logical host `api.anthropic.com`. It accepts
exact `POST /v1/messages` and `POST /v1/messages?beta=true`, in memory or through
the shared numeric loopback listener. It never calls the logical host or global
`fetch`. `createMessagesApiDraftFake` adds a closed synthetic draft-request shape;
the generic factory deliberately accepts malformed request content within its
intake cap. Both factories expose the shared `fetch` handler and recorder, without
a separate authentication mode.

Script steps are `{kind: "json", body}`, `{kind: "sse", events: [{event, data}]}`
or `{kind: "raw", body, contentType?}`. Optional `status`, `headers`, `delayMs`,
`chunkBytes` and `chunkDelayMs` control their wire output. Delays can be `Infinity`
to wait for cancellation. The raw script permits deliberately malformed JSON,
truncated SSE and consumer-oversize output. Scripts can express benign, obedient,
schema-breaking, refusing, slow, auth, rate and quota responses; these are invented
fixtures, not live provider behavior or a version/model oracle.

`enqueue(...steps)` validates and detaches an entire batch atomically, stopping
preparation when a limit is exceeded. `pending()` reports queued steps. There are
at most 1,024 steps, 4,096 SSE events per step, 16 MiB of UTF-8 response body per
step, and 64 MiB of response bodies across the queue. Stream chunks are 1–65,536
bytes, with at most 65,536 chunks per response. Queued body bytes are released as
soon as a matching request takes a step at app admission, before validation or a
header delay. These are queued-body budgets; they exclude caller fixtures,
preparation overhead, headers and active responses, and imply no global or
concurrent memory bound.

The event cap also counts actual iterator yields before reading excess event
fields. Reentrant `enqueue` calls from fixture getters or serialization are
refused before queue mutation; the outer batch stays atomic and preparation
recovers after a failure.

Both factories opt into shared 1 MiB request intake before redirect or app cloning.
The shared recorder keeps its configured body prefix and hashes all received
bytes, including the crossing chunk when intake returns `413 request_body_too_large`.
It does not hash unread input. Partial failed, malformed-chunk or aborted uploads
discard their incomplete record. Custom recorders must implement `begin`.
Arrival faults are reserved independently and may replace the refusal response;
before-faults can bypass app admission and after-faults can replace its result.
Discarded scripted response streams are cancelled.

Scripts are FIFO at app admission after successful intake, rather than request
arrival: a later completed upload or a pre-app latency fault can change admission
order. Intake refusal, upload failure, wrong routes and wrong methods take no
step; a matching admitted strict request takes one even if its shape is refused.
The recorder preserves arrival order. No bound is claimed on original empty
upload chunks, upload duration or simultaneous uploads; the strict app's chunk
check is only defensive after shared buffering.

The strict shape requires nonempty `model`, string `system`, one string user
message, `max_tokens` from 1 to 16,000, and `output_config` with a supported
synthetic `effort` and `format: {type: "json_schema", schema: <object>}`. It permits
only optional boolean `stream` and `fallbacks: "default"`. JSON media may specify
UTF-8 charset; decoding is fatal and duplicate members follow `JSON.parse`'s
last-member semantics. Schema contents are opaque. This fixture does not verify
native pins, prompt hashes, credentials, request headers, model availability or
provider policy, and establishes no native approval or streaming authority.
