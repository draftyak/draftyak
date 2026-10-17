# ADR 0005: S3b bridge translator for 2025-era clients

- **Status:** proposed
- **Date:** 2026-10-17
- **Spike:** S3b
- **Plan:** §6 Surfaces, §6 Elicitation (Fallback), §6 MCP Apps, §12 In scope and M8, §15 S3b
- **Owner decision:** no

## Context
§6 lets the hub elicit only on 2026-era requests that declare the mode: the account form for `triage_inbox` and, while L3 is on, the session-pending URL prompt. Each is one multi round-trip (MRTR) round whose `requestState` is HMAC-signed, lives 600 s and carries a single-use `pendingId`. Everywhere else, including every 2025-era request, the hub answers with the readable fallback. The local stdio bridge (`draftyak mcp`) is planned as a relay that adds the agent token and the protocol headers, so 2025-era clients behind it never see a dialog.

§15 S3b asks whether the bridge can speak 2026 MRTR to the hub and send 2025 `elicitation/create` to a 2025 client that declared elicitation. It checks `maxRounds`, the `requestState` TTL against how long approval takes, and capability pass-through. No-go means elicitation needs a 2026-era client, and the docs say so. §12 M8 builds the translator only if S3b passes.

The spike (`spikes/s03b-bridge-elicitation`) ran offline on the Windows dev box (Node 26.12.0) against M0.15's merged hub in `spikes/s03-mcp-sdk`, in memory and over a loopback socket, with `@modelcontextprotocol/server` and `/client` 2.3.1. The 2025 client is the SDK's own `Client` in its default 2025 mode, plus a wire-level JSON-RPC client. The delay cases run every timer on faked time: the client's request timeout, the bridge's wait for an answer and the hub's 600 s state. No live host took part; M0.20 records which eras the live clients negotiate. M0.15's notes find that the static `/status` URL prompt doesn't conform, and ADR 0004 decides whether it ships; the account form is unaffected.

## Options
- **No translator (No-go).** 2025-era clients behind the bridge keep the readable fallback (triage for every account, `1001` for a pending session). No cost, and the account form stays with 2026-era clients.
- **The SDK's legacy shim behind a relay (chosen).** In SDK 2.3.1, when a `tools/call`, `prompts/get` or `resources/read` handler on a 2025-era connection returns input-required, the server's legacy shim takes over. It checks the capabilities declared at `initialize`, sends each embedded `elicitation/create` (with a generated `elicitationId` for URL mode), waits up to `inputRequired.roundTimeoutMs` for each answer, and calls the handler again with the answers and the echoed `requestState`, at most `inputRequired.maxRounds` times. The bridge serves the 2025 client with the SDK's `Server` and relays: each request goes to the hub as a 2026-era request, and the hub's answer comes back in 2025 form. About 410 lines (`src/bridge.ts`, its command line included). It depends on the shim's behaviour and wording in 2.3.x, which the kept test pins.
- **A translator loop of our own in the bridge.** Full control of messages and deadlines, but it repeats what the shim already does (the capability gate, URL ids, parallel legs, abort linking, failures per method family) and would have to follow the shim's fixes.
- **The SDK client's MRTR driver upstream.** A 2026-era `Client` to the hub, whose `elicitation/create` handler forwards through the 2025 server's push API. It brings the client package's runtime dependencies (`jose`, `eventsource`, `cross-spawn`, `pkce-challenge`) into the bridge and splits each round between two drivers. Not built.

## Decision
Go

Plan changes:
- §6 Elicitation, Fallback: "Optional spike S3b may bring dialogs to local 2025 clients through the bridge" becomes: local 2025-era clients that declare elicitation get the same dialogs through the stdio bridge, which relays their requests to the hub as 2026-era ones and lets the SDK's legacy shim turn the hub's input requests into `elicitation/create`. Hosted and other remote 2025-era clients keep the fallback.
- §6 Surfaces, stdio bridge: for 2025-era clients the bridge serves the session itself and relays each request as a 2026-era one, with the envelope, the token, `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`. It no longer forwards 2025-era requests. The spike's bridge serves only the 2025 revisions, so a 2026-era client's `server/discover` probe gets `-32601` and the client opens a 2025-11-25 session instead. Serving 2026-era clients with the plain relay (routing by era on stdio) is M8 work that the spike didn't build or test.
- §12 M8, bridge: the translator is in scope, as built here:
  - the SDK's legacy shim with `maxRounds` 1 and `roundTimeoutMs` 595 s, 5 s short of the state's TTL;
  - elicitation pass-through cut to the client's revision, plus the UI extension on every relayed request;
  - a retry only where the hub asked on that same request, carrying the hub's own state, and the readable expiry error;
  - the 2025 result and not-found fixes, and the surfaces' spec-schema params check before relaying, with params relayed as sent;
  - hub requests on a `node:http` agent of the bridge's own (never an environment proxy), a 10 s limit on `server/discover`, an RFC 6750 token check, fixed-text startup errors and an 8,192-character cap on `Mcp-Name`.

  M8's bridge suite takes over this spike's tests. M8's owner check adds a 2025-era local client completing the account form through the bridge, if the owner uses one that declares elicitation.
- §12 In scope, MCP: "2026-era elicitation (account form; …)" gains "and the same dialogs for local 2025-era clients through the bridge". §12 Deferred keeps "2025-era elicitation, except through the bridge if the optional S3b passes" as written, since S3b passed.
- §6 MCP Apps: the bridge declares `extensions["io.modelcontextprotocol/ui"]` (with the `text/html;profile=mcp-app` MIME type) on every relayed request. When M8b gates `_meta.ui` on the declared extension, bridged 2025 clients keep getting it, as the hub's 2025 leg always sends it.

### What the spike showed
- **The account form works for 2025 clients.** A 2025-11-25 client completes it through the bridge: one dialog, and the triage covers the chosen account. The hub re-checks the answer, so an alias outside the allowlist, another spelling of one, decline and cancel each render for every account. The retry replays the original params (the same JCS digest), and the `requestState` never reaches the client. A 2025-06-18 client gets the same dialog in the 2026 shape: it carries `mode` and `requestedSchema.$schema`, neither of which 2025-06-18 defines. The SDK client accepts both; strict live hosts are unverified.
- **`maxRounds`.** The bridge sets `inputRequired.maxRounds` to 1, §6's one round (the SDK default is 8), and against DraftYak's hub each request asks once. A hub that keeps asking gets exactly `maxRounds` dialogs. The shim then fails the request: a `-32603` error for prompts and resources, an `isError` result for tools ("Multi-round-trip request '<method>' still required input after N rounds").
- **How long a dialog stays open.** The account form and the session-pending read behave alike.
  - The host's own request timeout usually comes first. The SDK client's default is 60 s, and nothing on the dialog extends it. An SDK-default client was served at 30 and 59 s. At 61 s it had given up at 60 s, cancelled its request and closed the dialog, and the user sees the host's own timeout message.
  - The bridge's 595 s applies only to a host that waits longer. A client waiting 1,200 s was served at 300 and 594 s. At 596 s the bridge had closed the dialog at 595 s (`notifications/cancelled`), and the request failed with the shim's "Fulfilling input required by '<method>' failed: Request timed out" (`-32603`; an `isError` result for tools). M8 could reword that text in the bridge's send hook, as it already rewrites not-found.
  - So answers are served for the shorter of the host's timeout and 595 s, and the hub never sees a retry for a dialog that was closed.
  - 595 s is a wait for each answer, not a hard cap: the shim starts it again on every progress notification the client sends on the dialog. A client that sent one every 100 s answered at 700 s.
  - The readable expiry error appears only when the hub refuses an answer's state: after 600 s through progress like that, after a hub restart, or after the wall clock jumped while timers stood still (such as sleep and resume). Each gave `-32602` with "DraftYak no longer accepts the answer to this request's question: it came more than 10 minutes after the question, or the hub restarted in between. Nothing was done; run the request again." For `tools/call` the same text comes as an `isError` result, checked against a stub hub that asks on `tools/call`.
- **Abandoned dialogs hold the hub's slots.** A dialog that the client cancels or times out on, or that the bridge closes, leaves its `pendingId` open until the state lapses, because the hub never sees a retry. Every local client with the same agent token is one principal, and the hub allows 5 open states per principal. After 5 abandoned dialogs the form stopped appearing (triage rendered for every account) until their states lapsed 600 s later. M8 decides whether that is acceptable. The bridge could free a slot with a background retry that answers `cancel`, but only if the hub then executes nothing: s03's read serves the content once the session is approved, whatever the answer says.
- **URL mode gains little.** A 2025-11-25 client answers a URL elicitation once the user agrees to open the link. If the owner hasn't approved the session by then, that spends the one round and the read ends in the readable `1001`, which the client would have got anyway. If ADR 0004 drops the URL prompt, as M0.15's notes recommend, only the account form remains.
- **Capability pass-through.** Every relayed request carries the `elicitation` object the client declared at `initialize`, cut to what its revision defines (elicitation from 2025-06-18, URL mode from 2025-11-25), plus the UI extension. It never carries `sampling`, `roots` or anything else. The SDK checks no revision, and it reads a bare `elicitation: {}` as `{ form: {} }`. The client's `clientInfo` goes along in the envelope; the hub never gates on it. In the other direction, the bridge's `initialize` answer carries the hub's `server/discover` capabilities and `serverInfo`.
- **Parity.** For everything that doesn't elicit, the bridge's answer is the same JSON value as the hub's own 2025 leg's, key order aside. The corpus is `initialize` plus 32 requests over tools, prompts, resources, completion and `ping`, 14 of them with params of the wrong shape. That takes four fixes in the bridge:
  - It drops the 2026-only result fields (`resultType`, `ttlMs`, `cacheScope` and the `serverInfo` stamped in `_meta`), which the SDK's 2025 encoder would pass on as they are.
  - It rewrites the not-found `-32602` to the 2025 `-32002` as it writes to the client, because SDK 2.3.1 sends `-32602` in both eras.
  - It checks the params of prompts, resources and completion against the spec schemas before relaying, as the hub's 2025 leg does (M0.15), and relays them as sent. Without that check, the bridge's own SDK `Server` answered malformed params with `-32603` and the raw zod issue list where the hub gives a readable `-32602`, and it dropped a `__proto__` prompt argument and served the prompt, which the hub refuses. Relaying such params to the hub's 2026 leg isn't enough: a request without a string name or URI fails its `Mcp-Name` check first (`-32020`). `tools/list` and `tools/call` keep the SDK's own check on both sides, so a `tools/list` with a malformed cursor gets the SDK's raw `-32603` from both, for M8 to settle.
  - A name or URI whose `Mcp-Name` header would exceed 8,192 characters gets a readable `-32602` from the bridge and never reaches the hub. Node's HTTP server takes 16 KiB of request headers in all; past that the hub answered 431 or dropped the connection, where its 2025 leg answers `-32602` with its own message.
- **Only the hub's own states.** The bridge sends a `requestState` and `inputResponses` only when the shim re-enters a request that the hub asked on, and the state is the one the hub gave that request (a `requestState.verify` hook checks it). A `requestState` that a 2025 client puts in its own `tools/call`, `prompts/get` or `resources/read` gets the SDK's fixed `-32602` before anything reaches the hub. On the other five methods, and for `inputResponses` anywhere, the bridge drops what the client sent. A hub that asks without a `requestState` still gets the answers on the retry.
- **As a process.** `DRAFTYAK_TOKEN=<token> node src/bridge.ts http://127.0.0.1:<port>/mcp` serves a 2025 client over stdio against the hub on a loopback port, and exits 0 when stdin closes.
  - A hub URL that isn't plain HTTP on 127.0.0.1 or [::1], one with userinfo, or a token that isn't an RFC 6750 `b64token` once trimmed (with a line break, carriage return or space inside, say) exits 2 with a usage line that never names the token.
  - Startup failures print only the bridge's own fixed lines, never an exception's text. A refused token and a hub that isn't answering each exit 1 with a readable line; a hub that takes the connection but doesn't answer `server/discover` within 10 s counts as not answering.
  - The bridge sends its hub requests on a `node:http` agent of its own. With `NODE_USE_ENV_PROXY=1` and `HTTP_PROXY` set, Node's own `fetch` sent a request for the loopback hub to the proxy, agent token included; the bridge sent it nothing.

## Fallback
If live 2025-era hosts mishandle the relayed dialogs (for example a strict 2025-06-18 host rejecting `mode` or `requestedSchema.$schema`), or M0.20 shows that no local client the owner uses negotiates 2025 and declares elicitation, M8 drops the translator. The bridge then forwards 2025-era requests to the hub's own 2025 leg with `MCP-Protocol-Version`, as §6 first planned, and the docs say elicitation needs a 2026-era client. Clients lose only the account form, a convenience: they get the readable fallback the plan already specifies. The triggers are M8's owner check and M0.20's table of each live client's era, elicitation modes and request timeouts. An SDK bump that changes the shim's behaviour or texts fails the kept test first.

## Evidence
- `spikes/s03b-bridge-elicitation/evidence/translate.json` (win32-x64, Node 26.12.0, SDK server and client 2.3.1, recorded from the clean item commit):
  - the account form: dialogs, hub requests, equal digests, the state never shown;
  - answers the hub re-checks;
  - 13 approval delays end to end for the form and the session-pending read, each with the client's timeout, the outcome, when the dialog closed and the hub requests; and the accept before approval;
  - the 595 s close and the client's own cancel, with no hub retry;
  - five abandoned dialogs blocking the form until their states lapse;
  - `maxRounds` 1 and 2 against a hub that always asks, and one round against s03;
  - a round without a `requestState`, and a tools/call retry the hub refuses;
  - nine revision and declaration pairs for pass-through, and the fields of a 2025-06-18 client's dialog;
  - a 2026-era client served as 2025-11-25;
  - 33 exchanges of parity, 14 of them malformed;
  - states and answers a client injects into the eight methods, the headers and the name cap, and the readable hub errors.
- `spikes/s03b-bridge-elicitation/test/stdio.test.ts` (test output only, not in the evidence file): the bridge as a process against the hub on a loopback port; no environment proxy, beside a control in which Node's `fetch` used the proxy; `__proto__` over a real pipe; the URL and token refusals; a silent hub on a real socket.
- The server SDK 2.3.1's own code, as installed:
  - the legacy shim: `maxRounds` 8 and `roundTimeoutMs` 600,000 by default, each leg armed with `resetTimeoutOnProgress` and no total cap, a generated `elicitationId` for URL legs, failures per method family, and accepted content passed on without validation;
  - the `requestState.verify` hook, which runs before every round, the shim's included;
  - `setRequestHandler`'s two-argument form, which checks params against the era's wire schema and throws a plain `Error` (`-32603`), and its three-argument form, which hands the handler what a params schema returns;
  - the 2025 encoder, which writes `-32602` for a missing resource and passes a handler's result fields on as they are.
- The client SDK 2.3.1: a 60 s default request timeout that answering a dialog doesn't reset.

## Kept test
- **Path:** `spikes/s03b-bridge-elicitation/test/translate.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s03b-bridge-elicitation test`
- **Guards:** the hub's input requests reach a 2025 client as `elicitation/create` through the SDK shim, and its answers return as the retry; one round; the delay outcomes end to end (the host's timeout, the 595 s close, the readable expiry error) and the five-slot lockout; pass-through cut to the client's revision, plus the UI extension; parity with the hub's 2025 leg, malformed params included; retries only where the hub asked; the 2026-era headers and the name cap.
- **Destination:** M8 `apps/cli/`, the `draftyak mcp` bridge's suite.
- **Path:** `spikes/s03b-bridge-elicitation/test/stdio.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s03b-bridge-elicitation test`
- **Guards:** the bridge as a stdio process against a loopback hub: the account form end to end, exit 0 when stdin closes, no environment proxy, `__proto__` over the pipe, refusal of hubs off this machine and of missing, malformed or refused tokens, and the limit on `server/discover`.
- **Destination:** M8 `apps/cli/`, the `draftyak mcp` bridge's suite.

Both tests run against M0.15's hub in `@draftyak/spike-s03-mcp-sdk`: they import its `src/server.ts`, `src/resources.ts`, `src/elicit.ts` and `test/harness.ts`. The M8 PR that absorbs ADR 0004's kept tests and deletes `spikes/s03-mcp-sdk` moves these with them, or points them at `apps/hub`'s in-memory hub.
