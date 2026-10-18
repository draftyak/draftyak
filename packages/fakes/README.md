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
const fake = createFake(app, { host: "hello.draftyak.example", recorder?, faults? });
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

The recorder reads a copy, so the app still gets the body. Pass one recorder to several fakes to see all of their traffic in the order it arrived.

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

## Synthetic connector client

`ConnectorClient` is an offline client fixture, with explicit `profile`, `issuer`,
`resource`, `clientId`, `redirectUri` and `transport` options. The transport must
be an explicitly supplied `Fake`; the client captures its `fetch` method and
uses only canonical HTTPS URLs under `.example`, with no credentials, ports,
queries or fragments in its configured or advertised destinations, including
bare `?` and `#` delimiters. It never calls global
fetch, resolves a host, starts a listener, registers a client or issues a token.
The profiles `cimd-public` and `issuer-resource` describe synthetic checks, with
no claim about a vendor's current client-authentication behavior.

`discover()` follows the protected resource's challenge to same-issuer resource
metadata and RFC 8414 metadata. It requires the exact configured resource and
issuer, S256, public `none` authentication and authorization-response issuer
support. `cimd-public` additionally requires CIMD support. Endpoints stay on that
issuer. `clientMetadata()` returns a frozen synthetic document for a test to
serve itself; returning it does not register or approve that client.

`beginAuthorization()` creates one pending state and S256 verifier, returning
the authorization URL. The test must drive a real external authorization and
consent implementation separately and pass its received redirect to
`acceptCallback()`. This client has no consent callback or approval stub.
Callbacks require the exact redirect spelling, unique known parameters, exact
state and exact issuer on both success and error. A literal `#` delimiter is
refused, including an empty fragment; percent-encoded `?` and `#` in parameter
values remain supported. Invalid callbacks leave the
pending state available; an accepted callback consumes it once. `kind: exchange`
returns the observed token endpoint reply, including a possible error, without
asserting that a token was granted. Code and refresh forms bind `resource` and
`client_id` explicitly and contain no client secret or assertion.

`refresh()` and `revoke()` return observed status and JSON fields.
`callResource()` sends a bare authenticated POST and returns its status; it is
not an MCP protocol or read-session acceptance test. `observeReuse()` submits a
retired and current refresh token and probes the previous and current access
tokens. Its booleans report `400 invalid_grant` observations only. A scripted
reply is not evidence of real refresh rotation, grant revocation or audience
enforcement. Those require the actual authorization server and native resource
integration; the owner-run remote connector gate remains separate.

Responses are capped at 64 KiB, JSON at depth 16 and 2,048 values, callbacks at
8,192 characters, and each operation at ten seconds including parsing. Duplicate
JSON members, invalid UTF-8, BOMs and lone surrogates are refused. Received
native Buffer and Uint8Array views are copied using their intrinsic byte
bounds; proxy, subclass and shared-buffer chunks are refused. Only one operation
runs at a time; an expired client refuses future operations so a held
transport cannot accumulate work through that instance. Parsed values are
frozen, and errors contain only `Connector fixture refused`. Returned token
fields and recorder bodies are intentionally visible to the test: use synthetic
values only and never print them as diagnostic evidence.
