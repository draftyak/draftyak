# Plugin testkit

`@draftyak/plugin-testkit` provides in-memory MCP tests with a manifest-enforcing
mock host. It uses the merged SDK factory and the 2026-07-28 request envelope.
It is a private workspace package.

```ts
import { createMockHub } from "@draftyak/plugin-testkit";
import { createHelloFake } from "@draftyak/fakes";
import { plugin } from "./plugin.ts";

const hub = createMockHub({
  mode: "in-memory",
  plugin, // { manifest, entry: PluginEntry }
  upstreams: [createHelloFake()],
});
try {
  await hub.discover();
  await hub.listTools();
  const result = await hub.call("channel_fetch", {
    url: "https://hello.draftyak.example/v1/conversations",
  });
} finally {
  await hub.close();
}
```

Export the definition without starting a server. A separate `server.ts` may call
`serve(plugin.entry)` for the later process adapter. The channel and tool
fixtures demonstrate this split; these generic fixtures do not implement the
later channel/tool conformance factories.

The test supplies trusted local inputs: a validated manifest, the SDK definition,
fake upstreams, account mode, instance id and URL secrets. `entry.account` must
match the explicitly supplied account. Omitted account mode cannot organize.
`instance` accepts a ULID string or `{id, config?: {}}`; nonempty configuration is
refused until SDK configuration bootstrap is integrated. Metadata cannot supply
account, instance or lookup authority. The manifest and account mode are detached
before execution. In-memory callbacks share the test process; this is not a
JavaScript sandbox.

The host:

- Requires canonical URL spellings and denies unmatched methods, paths, query
  names and hosts. Routes admitted traffic only to supplied in-memory fakes, with no
  network fallback. Custom channel rules and Gmail/Slack profile endpoint
  allowlists distinguish read, organize and send; organize requires `full` mode.
  Provider credentials and native OAuth refresh are outside this component.
- Substitutes an exact declared `secret://name` using the shared URL-secret
  validator. It preserves percent encoding such as `%40`; added path, query or
  fragment syntax is denied. URL-secret entry normalization follows that
  validator and is independent of request substitution.
- Allocates private per-call tool lookup state before asynchronous dispatch.
  Only GET/HEAD are available, at most four requests per lookup. Concurrent
  lookups have separate counters. Returned, timed-out or closed calls retire
  authority, including work retaining an asynchronous callback context.
- Permits tools only `host/fetch`, `host/log` and memory `host/kv.*`. Tool request
  headers are Accept, If-None-Match and If-Modified-Since; response headers are
  Content-Type, ETag, Last-Modified and Content-Length. Redirects are manual and
  3xx responses other than 304 are refused.
- Checks actual response bytes against the manifest rule's lower cap, including
  the 32 MiB tool boundary, and limits fetch duration to the lower rule/call
  budget. Tool request/result frames pass the shared 65,536-byte raw-frame
  parser. Absolute elapsed deadlines are checked after response/read awaits and
  before publishing results, even before a timer callback gets its turn. The
  completed lookup receives the same deadline check. Declared `kb.lookup` and
  `contact.notes` calls have a 5,000 ms budget; `calendar.freebusy` has 15,000 ms,
  taken from the canonical kind definition. Plugin handler timeouts and request
  metadata cannot widen these budgets. Tool result acceptance
  applies the manifest's output ceiling.
- Keeps KV, blobs, tickets, logs, progress and denial records in memory. KV has
  1,024 keys and 64 KiB per JSON value. Blob state has 1,024 entries, 35 MiB per
  body and 64 MiB aggregate; reads and writes copy bytes. Logs/progress each
  hold at most 1,024 entries. A truncated 4,096-entry denial audit sets
  `auditComplete: false` and disables further work. Closing aborts active calls,
  clears asynchronous stream delivery and clears/zeroes stored body bytes.

`saveAs: 'blob'` stores the original response bytes. Unknown storage modes are
refused; decoded JSON-member storage is a separate SDK/native integration.
AI-provider HTTP requests remain denied until a trusted provider-origin binding
is supplied by the later provider/configuration integration. A shape profile
alone does not authorize an arbitrary host.

`hub.host` is a trusted test surface. `mintTicket(rendered)` records the exact
rendered request and expiry `min(mintedAt + 60_000, deliverBy)`. Found unburned
tickets are removed before body resolution, matcher checks or later policy
refusal. The shared matcher checks the presented ticket and exact request bytes;
plugin headers are dropped in favor of the saved rendered header list. A
plugin-supplied Content-Type must match exactly once. Refusals are recorded, and
the shared disable codes produce `disabled: true` plus fixed mock `alerts`.
Those records do not deliver a device notification. `seedTicket` exists only
for trusted negative fixtures, including invalid stored state; a plugin context
never receives minting, seeding or blob-state access.

All 66 literal ticket vectors are exercised against the shared matcher. 61 also
run through representable host frames. The valid ticket with port 8443 and an
encoded path separator is additionally refused by host manifest policy, with
the found ticket burned. Three fractional-clock vectors remain matcher-only:
the actual host uses integer UTC milliseconds from `Date.now()`. The newline URL
and non-host method vectors are explicit shared-frame BAD_REQUEST controls,
before handler dispatch. The normative vector data is unchanged.

Run checks with:

```sh
pnpm --filter @draftyak/plugin-testkit exec vitest run --reporter=default --exclude '**/*siwc*/**' --exclude '**/*siwc*' --exclude '**/*dynamic-agent*' --exclude '**/*dynamic_agent*'
pnpm --filter @draftyak/plugin-testkit typecheck
pnpm --filter @draftyak/plugin-testkit build
pnpm --filter @draftyak/plugin-testkit exec node --disallow-code-generation-from-strings test/built-consumer.mjs
```

Process mode fails closed with `PROCESS_MODE_UNAVAILABLE` until M1.14b. That
adapter must reuse this host and preserve each call's private lookup lifetime.
M1.13 configuration/canonical-list composition, M1.15/M1.16 contract suites,
native credential/approval authority, DNS/TLS/network isolation, real ticket
storage and dispatch, device alerts and production recorder coverage retain
their separate acceptance gates. No full provider or runtime isolation claim is
made by these in-memory tests.
