# ADR 0004: MCP SDK v2, surfaces and Apps

- **Status:** proposed
- **Date:** 2026-10-17
- **Spike:** S3
- **Plan:** §6 MCP server (Serving, Resources, Prompts, Completion, Elicitation, MCP Apps), §9.2, §11 `apps/mcp-apps`, §13 MCP conformance, §15 S3
- **Owner decision:** yes

## Context
Plan §6 serves MCP from the hub with `createMcpHandler` from `@modelcontextprotocol/server` 2.3 inside Hono, in both eras: 2025-11-25 (and 2025-06-18, 2025-03-26) through stateless serving, 2026-07-28 through `server/discover` and the per-request `_meta` envelope. Resources, prompts, completion and elicitation are first-party conveniences over the tool pipeline, and two passive MCP Apps views (M8b) render tool results. §15 S3 asked the spike to show that this holds:

1. `createMcpHandler` in Hono passes conformance in both eras, caching and header scenarios included, with a fresh `McpServer` per request; `serveStdio(…, {legacy:'reject'})`; `capabilities.extensions`; `server/discover` liveness; a 2026-era in-memory harness (M0.14).
2. Resources, templates, prompts and `completable` arguments in both eras, with the caching hints and each era's not-found code (M0.15).
3. MRTR `inputRequired.elicit` and `elicitUrl` with `createRequestStateCodec`, the per-request capability check, the readable error on legacy serving, and whether the session-pending `/status` URL conforms (M0.15).
4. `_meta.ui` gated by the declared extension; hosts accept `_meta.ui` without `resourceUri`; a single-file ext-apps 2.0.x view renders in the basic host under its hash-pinned CSP with zod jitless (M0.16).
5. Which conformance fixture names the suites need (§13), with the conformance pin of V3.

Pins: `@modelcontextprotocol/server` and `/client` 2.3.1 (core 2.3.1), `@modelcontextprotocol/conformance` 0.2.0-alpha.12 (V3), hono 4.13.13, `@hono/node-server` 2.1.5, zod 4.6.7, fast-check 4.10.2, `@modelcontextprotocol/ext-apps` 2.0.3, vite 8.3.4, vite-plugin-singlefile 2.3.3 and `@playwright/test` 1.64.1, whose pinned builds are Chromium 156.0.8078.4 and WebKit 27.2. Everything ran on the Windows 11 x64 dev box on Node 26.12.0; the spike is one package, `spikes/s03-mcp-sdk`.

## Options
- **Serving the 2025 era:** `createMcpHandler`'s own legacy leg, which answers with `text/event-stream`, against the hub's stateless JSON transport reached through `isLegacyRequest()` (§6: no SSE).
- **Checks the SDK has no seam for** (the raw URI as sent, the spec-schema params check, the completion cap): patch the SDK, run them at the transport before dispatch, or wrap the handlers `McpServer` stores in its private `_requestHandlers` map, failing at construction when the layout changes.
- **Session-pending elicitation:** keep the URL-mode prompt to the static `https://<publicBaseUrl>/status` page, or drop it for the readable fallback.
- **Conformance:** npm `latest` 0.1.16, which predates 2026-07-28, or the exact prerelease 0.2.0-alpha.12 with a test profile for the fixtures its scenarios call.
- **The Apps view:** ext-apps' `App` (its SDK, the client's `Protocol` and zod, about 230 KiB built), or a hand-written handshake of a few kilobytes that re-implements the Apps protocol.
- **zod in the view:** rely on the `App` constructor's own `z.config({ jitless: true })`, or configure zod in a module the view imports before the SDK.
- **The `_meta.ui` gate:** by `clientInfo` (host names), or by the extension the request declares, as §6 requires.

## Decision
Go

Plan changes: drop the session-pending URL elicitation and the static status page (§1 L3 routes, §6 Elicitation and its Fallback, §9.2, §11, §12 MVP scope and M9, §13 Fakes, §14 runbook step 11); serve the 2025 era through the hub's own stateless JSON transport (§6 Serving); rewrite the SDK's not-found code to -32002 on the 2025 leg (§6 Resources); views configure zod before they import the SDK, and `_meta.ui` needs the extension declared with the views' MIME type (§6 MCP Apps); each view has about 25 KiB of its own within the 256 KiB cap (§11).

### Plan changes
- **Drop the session-pending URL elicitation and the static `/status` page** (owner confirms). `notes/elicitation-url-conformance.md` finds that the prompt does not conform: both elicitation specs say URL mode is not for authorizing the MCP client's access to the MCP server, and an agent session is exactly that. Session-pending tools return `AGENT_SESSION_REQUIRED` and resources app error `1001` with the readable text, in both eras. The changes:
  - §1, L3 route table: the static `/status` page leaves the routes L3 serves.
  - §6 Elicitation: the "Agent session pending" case and its fixed URL go; the Fallback paragraph already covers these requests. The account form for `triage_inbox` keeps the MRTR codec, digest, single-use `pendingId` and per-request capability check.
  - §6 Elicitation, Fallback: "L3 off for a pending session" leaves the list of cases; a pending session gets the readable fallback whether L3 is on or off.
  - §9.2, "Elicitation phishing or automated accept": "fixed static `/status` URL" leaves the mitigations; the MRTR suite stays the test.
  - §11, "No new destination": "`/status` is served, never fetched" goes.
  - §12, MVP scope (MCP): 2026-era elicitation is the account form only.
  - §12, M9: the deliverable "the static `/status` page and, only if S3 found it conforms, session-pending URL elicitation (2026 era)" goes, and so does the acceptance "A scripted 2026 client gets the `/status` URL, and its retry succeeds only after the desktop approval". In its place: a scripted 2026-era client's `tools/call` and `resources/read` for a pending session end in `AGENT_SESSION_REQUIRED` and `1001` with no `InputRequiredResult`, a retry after the desktop approval succeeds, and L3's route snapshot has no `/status`. "An auto-accepting client gains nothing" stays, in M8's MRTR suite through the account form.
  - §13 Fakes, MCP clients: the scripted 2026-era client keeps form elicitation and its auto-accept mode, and declares URL mode only to check that the hub never issues it.
  - §14 runbook step 11 (Remote): "With L3 on, Claude Code (2026 era) shows a URL dialog for a pending session. The link opens the static `/status` page, and Continue succeeds only after the desktop approval" becomes: with L3 on, a pending session in Claude Code ends in the readable "approve on your paired desktop" error, and the same request succeeds after the desktop approval.
  - M8 ports no `sessionPrompt` and no URL branch from `src/elicit.ts` and `src/resources.ts`; the spike keeps them as the record of the mechanics. Revisit only if a later spec revision allows URL mode for approvals made out of band at the server itself.
- **§6 Serving:** 2025-era requests go to the hub's own stateless JSON transport (`isLegacyRequest()`, then `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse`) on a fresh `McpServer`; `createMcpHandler(…, {legacy: 'reject', responseMode: 'json'})` serves only the 2026 era. `subscriptions/listen`, which the SDK always streams, gets HTTP 404 `-32601` from the hub.
- **§6 Resources:** SDK 2.3.1 writes `-32602` for a missing resource in every era, so the 2025-era `-32002` comes from rewriting that error on the legacy leg.
- **§6 MCP Apps, views:** each view imports a module that calls `z.config({ jitless: true })` before it imports the ext-apps SDK. zod 4.6.7 decides whether to compile an object schema with `new Function` when the schema is built, and the SDK builds its schemas on import, so the `App` constructor's own call comes too late: a view built that way tries `new Function` at load, which its CSP blocks and reports as a `script-src` violation, Chromium in every frame and WebKit only in a top-level document.
- **§6 MCP Apps, `_meta.ui`:** on 2026-era requests the gate is the declared `io.modelcontextprotocol/ui` extension whose `mimeTypes` (a required setting in the Apps spec) lists `text/html;profile=mcp-app`; never `clientInfo`. It is always on for the 2025 legacy path and off while the principal's `appsViews` toggle is off (the spike reads it from `AuthInfo.extra.appsViews`). Every tool gets `visibility: ["model"]`; view-linked tools also get `resourceUri`. Results are identical either way. `ui://` resources stay out of `resources/list`, which the Apps spec allows.
- **§11 `apps/mcp-apps`:** the 256 KiB cap holds with room for little else. `draft-v1` is 236,011 bytes, and nearly all of it is ext-apps' `App` with the client SDK's `Protocol`, the core schemas and zod; marking those packages side-effect free saves about 7 KB. M8b fits `send-status-v1` and the `draft_update` word diff into the remaining 25 KiB or so per view, or asks the owner to raise the cap, or replaces the SDK in the views with a hand-written handshake.

### SDK 2.3.1
Go, with these findings for M8 (each re-checked on every SDK bump):
- One `McpServer` per request: a shared one fails an overlapping request with `-32603` (`ALREADY_CONNECTED`).
- `McpServer` installs its handlers in its constructor and hands callbacks parsed values only (a resource callback gets the WHATWG-normalized URL). The spike wraps the stored handlers in the private `_requestHandlers` map for the raw-URI check, the params pre-check, the completion cap, keeping `ui://` out of `resources/list` and the `_meta.ui` gate; construction fails on any other layout.
- A request that fails the SDK's own wire check gets `-32603` with the raw zod issue list in both eras, and the SDK's record parser drops a prompt argument named `__proto__`; the spike checks params against `specTypeSchemas` first and answers `-32602`. `tools/list` and `tools/call` keep the SDK's behaviour for M8 to settle.
- The `requestState` codec signs but doesn't encrypt, and its verify decodes the MAC with `atob`, which accepts other spellings of one MAC; the spike requires canonical base64url and never keys anything on the state string.
- A bare `elicitation: {}` counts as form mode; `completable()` marks the schema it is given, so completable schemas are built per request; the registries are plain objects (a prompt or tool named `constructor` reads as "disabled", still `-32602`); completion `total` and `hasMore` come from the completer and values are capped at 100, so the 20-value cap comes after.
- `@modelcontextprotocol/client` 2.3.1 negotiates the 2025 era unless a client opts into `versionNegotiation`; a stock client, the ext-apps basic host's included, connects with `initialize`.

### Conformance and fixtures (V3)
Go with 0.2.0-alpha.12, exact, run per era with `--spec-version` (`--requirements 2026-07-28` would leave the SEP-2243 header scenarios unscored as pending). On this item's commit: 2025-11-25 ran 33 scenarios, 22 clean, and each of the 11 with failures matches one of the 11 baseline entries (9 FAILURE, 2 WARNING); 2026-07-28 ran 40, 39 clean, and the one left, `tools-call-with-progress`, is its only baseline entry (§6: no SSE). The must-run scenarios (`caching`, `http-header-validation`, `http-custom-header-server-validation`, `sep-2164-resource-not-found`) and the protected header check in `server-stateless` pass every check. The suites call 20 fixture tools, 5 prompts, 2 resources and 1 template (listed in the evidence), served only by the test profile in `test/conformance-fixtures.ts`, which `release-guard` must reject (§13); 9 more names stay unserved, and `conformance-baseline.json` gives the reason for each scenario that asks for one. Without the fixtures, the production surface fails 26 (2025) and 30 (2026) scenarios. M8's `conformance.yml` keeps the guards: no baseline id matching `/header|cach|2243|2549|2164/i` or naming a must-run scenario, every entry must match a FAILURE or WARNING, and every non-INFO check of a must-run scenario must be SUCCESS (SKIPPED fails).

### MCP Apps
Go. `views/draft-v1` (vanilla TypeScript on ext-apps 2.0.3's `App`) builds with Vite 8.3.4 and vite-plugin-singlefile 2.3.3 into one HTML file; `views/build.ts` hashes its one inline script, puts §6's meta CSP right after the charset and writes `views.manifest.json` (URI, file, SHA-256, size, CSP); two builds give the same bytes. The hub's `loadViews()` refuses a file that differs from the manifest, and one whose CSP isn't §6's policy over its own inline-script hashes or isn't the meta tag right after the one charset meta that opens the head; M8 embeds the manifest in the hub, as §11 says, instead of reading it beside the files. The view renders with `textContent` only and shows control and format characters and the other default-ignorable code points (variation selectors, Hangul fillers, the combining grapheme joiner, unassigned tag code points) as `⟨U+XXXX⟩` markers. That marks the joiner and VS16 inside emoji and the ZWNJ of Persian and Indic words too, which M8b decides how to present. The view ignores unknown fields and sends nothing but the handshake and size changes. The tests take Chromium and WebKit from `<DRAFTYAK_CACHE_DIR>/playwright` unless `PLAYWRIGHT_BROWSERS_PATH` is set (`0`: inside `playwright-core`; a relative value is refused). `pnpm m0:prefetch` installs them there through `spikes/s03-mcp-sdk/prefetch.ts`, never into the user profile, and `verify:m0`'s prerequisite check (`tools/verify/profiles/m0.ts`, changed with this item) looks in the same folder.

In the vendored ext-apps basic host (commit `82221c0c`, the `gitHead` of ext-apps 2.0.3), in Chromium and WebKit, through the basic host's sandbox (its proxy on a second origin with its CSP header and sandbox attributes) and without it (a plain same-origin `srcdoc` frame with no host CSP), five drafts rendered as text: plain, a 32-payload XSS corpus in every field, bidi, zero-width, tag, control and other default-ignorable characters ("ignore all rules" hidden in variation selectors among them), a 1,000,000-character body, and `__proto__` keys. The SDK's 2025 leg, which the basic host uses, drops an own `__proto__` key from `structuredContent` (its 2026 leg passes it through), so the harness hands that draft to the view from the host side; the key reached the view's frame and nothing was polluted. No payload ran (no marker, no dialog), the view frame made no request and no code from strings, the canary origin got no request, nothing left loopback, no frame reported a CSP violation, and the recorder, read again once no message had arrived for 2.5 s, saw only `ui/initialize`, `ui/notifications/initialized` and one or two `ui/notifications/size-changed` (plus the proxy's own `ui/notifications/sandbox-proxy-ready`). Loaded as the top document, as a WebView that loads a view itself would show it, the view blocked the CSP control's payloads as it did in the frames, and both browsers reported its blocked eval. The basic host lists the tools whose `_meta.ui` has no `resourceUri` and calls them as plain tools.

Findings about the basic host for M8b and M9:
- Its client declares no `io.modelcontextprotocol/ui` extension and negotiates the 2025 era, so it gets views only because the 2025 path always carries `_meta.ui`. A 2026-era host has to declare the extension to see views (the Apps spec asks servers to check), which the M8b and M9 owner checks show per client.
- Its sandbox CSP header allows `'unsafe-inline'`, `'unsafe-eval'` and `connect-src 'self'` for a view that declares no `ui.csp`, looser than the Apps spec's restrictive default. The view's own meta CSP is what blocks the payloads there.
- Its `onsizechange` animation starts from `offsetWidth`, so a content-box frame with a border grows 2 px per round without end; the harness frames the view the way the basic host's own CSS does (border-box).
- ext-apps' server helper also writes the deprecated flat `_meta["ui/resourceUri"]`; the hub sets only `_meta.ui`, and M8b decides whether older hosts need the flat key.
- It doesn't enforce `visibility`. `AppBridge.connect` forwards every `tools/call` from a view when the server declares tools, and the control shows a view's call to `accounts_list` (`visibility: ["model"]`) reaching the server and its result reaching the view. The Apps spec says hosts must refuse such calls, but nothing may rest on that: §9.2's "A view injects into the conversation or calls tools" rests on passive views and full policy on every call (§6 Hosts). With passive views, the owner checks can't observe whether claude.ai, ChatGPT or VS Code refuse such calls, and nothing depends on it.

Findings for M8b's suite:
- A CSP check needs a positive control and more than violation events. WebKit 27.2 dispatches no `securitypolicyviolation` event for eval inside a `srcdoc` or `document.write` frame (the basic host writes its inner frame with `document.write`); it does for a top-level document, and Chromium does in every frame. So the suite counts code made from strings where it starts (the global `Function`, `eval` and string timers; Playwright evaluates through the page's own `this.global.eval`, so calls with the window as receiver aren't counted), loads the view as a top-level page for the control and the jitless check, and keeps injecting a handler, a script, `eval`, `Function`, a fetch and a remote image after render to prove the policy is live.
- The SDK's 2026 leg passes an own `__proto__` key of `structuredContent` through to a host, so a view must never merge a result into another object; the harness delivers that key from the host side, since the basic host's 2025 leg drops it.
- A view that sends something late is seen only while its page stays open: the recorder is read again once no message has arrived for 2.5 s.

## Fallback
- **SDK:** an SDK bump that changes the stored-handler layout fails at server construction; pin the previous SDK until the wraps are moved, or move the checks to the transport before dispatch.
- **Conformance:** if 0.2.0-alpha.12 has to change, a new pin updates the baseline under M8's guards, with each entry's reason reviewed by the owner.
- **`/status`:** the readable fallback is already the decision; nothing else depends on the URL prompt.
- **Apps:** if the views outgrow 256 KiB, the owner raises the cap, or the views drop the SDK for a hand-written handshake (`ui/initialize`, `ui/notifications/initialized`, size changes and the tool result). If a host must not render views at all, the principal's `appsViews` toggle turns `_meta.ui` off and the host shows the text result, which is identical either way.

## Evidence
- `spikes/s03-mcp-sdk/evidence/conformance.json`: both eras against the reviewed baseline, the must-run and protected checks, fixture names served and not served, and the production surface without fixtures; recorded on this item's code commit from a clean tree (Windows 11 x64, Node 26.12.0).
- `spikes/s03-mcp-sdk/evidence/mrtr.json`: the MRTR codec and its negative cases and flows (M0.15).
- `spikes/s03-mcp-sdk/evidence/apps-win32-x64.json`: the view build (size against the cap, SHA-256, script hash, CSP, reproducibility), the `_meta.ui` gate, and per browser the five drafts in each mode with how long the pages were watched, the visibility control, the CSP control in sandbox, direct and top-level modes, and the jitless comparison in a `srcdoc` frame and top-level (Windows 11 x64, Node 26.12.0, Chromium 156.0.8078.4, WebKit 27.2).
- Each evidence file is written only with `DRAFTYAK_RECORD_EVIDENCE=1` (or in CI) after a complete passing run, and its fingerprint counts tracked changes outside the spike's evidence folder, so recording the files in any order on a clean tree gives `dirty: false`.
- `spikes/s03-mcp-sdk/notes/elicitation-url-conformance.md`: the elicitation spec text and the assessment of the session-pending status URL.
- Not run: the browsers on Linux and macOS (s03 has no `ci.json`; M8b's suite runs in `e2e.yml`), and the heavy suites on Node 26.5.1.

## Kept test
- **Path:** `spikes/s03-mcp-sdk/test/in-memory.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s03-mcp-sdk test`
- **Guards:** 2026-era serving with no socket through `createMcpHandler().fetch`, a fresh `McpServer` per request, and `server/discover` with `capabilities.extensions`; `test/harness.ts` builds its requests.
- **Destination:** M1 `packages/plugin-testkit/` (the in-memory mode of `createMockHub`), with the harness.
- **Path:** `spikes/s03-mcp-sdk/test/headers.test.ts`, `spikes/s03-mcp-sdk/test/middleware.test.ts`, `spikes/s03-mcp-sdk/test/caching.test.ts`, `spikes/s03-mcp-sdk/test/discover.test.ts`, `spikes/s03-mcp-sdk/test/stdio.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s03-mcp-sdk test`
- **Guards:** the §6 middleware order, `Mcp-Name` and `Mcp-Method` matching with sentinel decoding (HTTP 400 `-32020`), the version allowlist, JSON-only responses and 405 on GET, exact caching hints, the discover result, and the legacy rejection over stdio.
- **Destination:** M8 `apps/hub/src/mcp/`.
- **Path:** `spikes/s03-mcp-sdk/test/surfaces.test.ts`, `spikes/s03-mcp-sdk/test/mrtr.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s03-mcp-sdk test`
- **Guards:** resources, templates, prompts and completion in both eras (scopes, not-found codes, prompt hygiene, completion leakage) and the MRTR state: tampered, replayed, expired, cross-principal and params-swapped states fail, and an auto-accepting client gains nothing.
- **Destination:** M8 `apps/hub/src/mcp/` (the parity, prompt-hygiene, completion-leakage and MRTR suites).
- **Path:** `spikes/s03-mcp-sdk/test/conformance.heavy.test.ts`, `spikes/s03-mcp-sdk/conformance-baseline.json`
- **Command:** `pnpm --filter @draftyak/spike-s03-mcp-sdk test:heavy`
- **Guards:** conformance in both eras against the reviewed baseline, with the caching, header and SEP-2164 scenarios required to pass in full.
- **Destination:** M8 `.github/workflows/conformance.yml`, with the baseline in `security/mcp-conformance-baseline.json`.
- **Path:** `spikes/s03-mcp-sdk/test/apps.test.ts`, `spikes/s03-mcp-sdk/test/apps.heavy.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-s03-mcp-sdk test`, then `pnpm m0:prefetch` and `pnpm --filter @draftyak/spike-s03-mcp-sdk test:heavy`
- **Guards:** the `_meta.ui` gate, `ui://` serving and the hub's view check; the view build's size cap and hash-pinned CSP; text-only rendering of the XSS corpus in the basic host in Chromium and WebKit, with and without its sandbox: no script, request, code from strings or CSP violation, and a recorder that sees only the handshake and size changes over a quiet period; the CSP control, also with the view as the top document; the jitless check; the visibility control.
- **Destination:** M8b `apps/mcp-apps/`, with the corpus in `security/xss-corpus/`.
