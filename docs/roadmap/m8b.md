# M8b: passive MCP Apps views

M8b provides passive draft and send-status views for M8 and runs alongside M9.
M1.19 owns the shared display and MCP contracts; M8 owns native serving and
authorization. The owner accepts supported hosts at the M9 gate.

Type and runtime acceptance require merged M1.19 contracts and the checks
below. Planned test paths or commands must be implemented and registered
before their acceptance can pass. Package tests, a reference-core fixture and
generated artifacts establish separate portions of the milestone.

Before a ready item PR, rebase onto the current base, install with the frozen
lockfile and run touched-package tests, typecheck/build, changed-file lint,
applicable item acceptance and zero-finding `pnpm guard`. CI supplies the full
suites, including Windows. For CI/verification controls, run every affected check
locally with boundary attacks and mutation proofs, retain required test exclusions,
and use full/Windows CI at the exact head for unrelated suites. Branch integration
retains all default local checks with those exclusions; the milestone gate retains
its full acceptance. Item PRs require `required`, `pr-title` and reviewed-head
`review`; review enables automatic integration. DCO remains separate until
milestone sign-off. Changes to shared protocol/specification files land in M1
before this milestone consumes them.

## M8b.1 Passive display projections

**Goal:** Display the tool result already supplied by the host without creating
conversation, routing, approval or send authority.

**Inputs:** Merged M1.19 view inputs and tool results, the MCP Apps specification
and `io.modelcontextprotocol/ui` extension, and the shared schedule, flag,
provenance and word-diff contracts.

**Outputs:** One self-contained `text/html;profile=mcp-app` resource for each of
`ui://draftyak/draft-v1` and `ui://draftyak/send-status-v1`. The draft view shows
body, flag codes including unknown codes, provenance, the AI-reliability notice
when required by revision provenance, linked send state and schedule, and the
previous revision's word diff for `draft_get`, `draft_create` and `draft_update`.
The send-status view handles the three `send_request_*` results and shows state,
fingerprint, schedule and “Approve on your paired desktop with your PIN”.
Context text never appears.

All supplied text uses `textContent`. Bidi, zero-width and tag characters receive
visible `⟨U+XXXX⟩` markers. Display projections are bounded, refuse malformed
Unicode and recognized accessors without executing them, and ignore unknown
fields without reading their values. Invalid updates clear stale content. Views
have no links, buttons, approval controls or remote loads; they emit only the
protocol handshake and size notifications. They send no `tools/call`,
`resources/read`, `ui/message`, `ui/update-model-context` or `ui/open-link`.
Protocol validator imports remain
test-only; the native hub validates full inputs before delivery.

**Owns:** `apps/mcp-apps/src/{draft,send-status,render,inputs,jitless}.ts`,
`apps/mcp-apps/src/style.css`, both HTML entries, and display/input-parity tests
under `apps/mcp-apps/test/**`. The public package surface remains the integrity
verifier. This item creates the private package's `package.json`, `tsconfig.json`,
`vite.config.ts`, `vitest.config.ts` and lockfile importer; use the established
shared Vitest tiers and exact dependency pins. Each later item extends only
the package configuration required by its owned tests or build outputs.

**Acceptance:** `pnpm --filter @draftyak/mcp-apps --fail-if-no-match exec vitest run --reporter=default` and
`pnpm --filter @draftyak/mcp-apps --fail-if-no-match typecheck`. Compare projections with the merged
contracts using test-only imports. Exercise malformed and oversized data,
hostile text, unknown flags, schedules, provenance, word diffs, invisible
characters, accessor refusal and stale-content clearing. Assert absence of
context text and interactive or active markup. SMS display follows the owner's
S12 decision and M1.23/M6b contracts; it is not enabled by synthetic fixtures.

**Depends on:** M1.19, applicable scheduling contracts, and M1.23/M6b plus the
owner's S12 decision for SMS fields.

## M8b.2 Deterministic artifacts, integrity and recovery

**Goal:** Build complete bounded views and bind their verified bytes to trusted
release metadata before native serving.

**Inputs:** Reviewed package sources, locked build dependencies, Zod jitless
initialization before the SDK, the fixed resource identities and M2.11's shared
bounded regular-file reader. Consume that reader rather than adding a second
implementation.

**Outputs:** `draft-v1.html`, `send-status-v1.html`, `views.manifest.json`,
`manifest.mjs` and `views.mjs`. Every view has inline JavaScript and CSS, an
independent hard 256 KiB cap, a complete-file SHA-256 entry, and an inline-script
hash in its own meta CSP immediately after the charset. The policy is
`default-src 'none'; script-src 'sha256-<script digest>'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'`.
No CSP domains, permissions or `ui.domain` are declared. Unsafe evaluation stays
disabled. Rebuild reproducibility checks whenever source or locked inputs change.

The integrity verifier captures one owned snapshot using native typed-array
slots before allocation, preserves native subview offset and length, and uses
those same bytes for bounds, hashing and HTML inspection. Proxies, subclasses
and shared storage refuse without invoking caller byte properties or iterators.
The embedded manifest and artifact bytes form trusted hub-build input;
`viewAssetsOptions()` returns fresh artifact buffers. Mutable adjacent files or
a caller-supplied matching manifest establish no release authenticity.

Preparation verifies both views before publication. The bounded regular-file
reader checks descriptor/path identity and refuses links, invalid UTF-8, growth,
replacement and oversized input. Publication stages and flushes all artifacts,
checks the package-owned directory bounds and known entries, and retains the
previous release for recovery. The portable two-rename swap attempts rollback
if installation fails; a failed rollback preserves the previous bytes for
recovery. Retained releases require deliberate cleanup.

An unsuccessful publication returns the fixed `ViewReleaseError`, including
cleanup failure, without exposing paths or content. Cleanup failure after a
successful publication reports `cleanupPending: true`. This contract does not
promise crash-atomic replacement, directory-fsync durability, protection from a
compromised build process or filesystem-ownership attestation.

**Owns:** `apps/mcp-apps/scripts/build.ts`,
`apps/mcp-apps/src/{integrity,release}.ts`, artifact/release tests under
`apps/mcp-apps/test/**`, and the package's generated artifact format. M10 owns
release inspection and embedding of the reviewed artifacts.

**Acceptance:** `pnpm --filter @draftyak/mcp-apps --fail-if-no-match build`, package unit tests and
typecheck. Build twice from identical locked inputs and compare every output
byte. Independently verify resource names, UTF-8, caps, full-file/script hashes,
CSP placement and passive markup. Exercise intrinsic-slot spoofing, subviews,
source mutation, links, bounded reads, partial publication, rollback and cleanup
faults, and fresh returned buffers. M10 inventories all
applicable dependencies and licenses before release.

**Depends on:** M8b.1, merged contract parity, M2.11 and locked build inputs.
Trusted release embedding and its final inventory/integrity acceptance land
later in M10.13b; they do not block the independent M8b artifact implementation.

## M8b.3 Synthetic browser security harness

**Goal:** Demonstrate the real built views' rendering, CSP and passive behavior
with an independent synthetic host.

**Inputs:** The verified artifacts from M8b.2, the synthetic XSS/result corpus,
and locally available pinned Chromium and WebKit engines.
For later corpus composition, consume M7.6's applicable hostile cross-thread,
prompt, resource-link, completion and Apps inputs after M7 reaches M8 and is
synced forward here. Provider parsing/flag results do not establish view behavior.

**Outputs:** A bounded loopback harness with isolated browser contexts, an egress
barrier, complete message observation and deliberate positive controls. Exercise
direct, sandboxed and top-level documents. The observer survives document
rewrites and records unexpected traffic rather than filtering it away. A quiet
window precedes policy probes. Startup errors, page errors, overflow, dialogs,
popups, unexpected frames and callbacks refuse acceptance.

**Owns:** `apps/mcp-apps/test/browser{,-fixtures,-harness}*.ts` and the synthetic
document helpers under `apps/mcp-apps/test/**`.

**Acceptance:** Build first, then run
`pnpm --filter @draftyak/mcp-apps --fail-if-no-match exec vitest run --mode heavy --reporter=default test/browser.heavy.test.ts`.
Both engines are required; missing
engines fail without downloading them. Confirm hostile text remains literal,
large/invalid results clear safely, scripts and unsafe evaluation never execute,
and remote requests are blocked. Calibrate script/evaluation/network probes on
an unrestricted control so a broken observer cannot produce a pass. Permit only
the exact protocol handshake and size traffic; top-level synthetic responses
must match their observed request and fixed complete response shape.

The later corpus hook is
`pnpm --filter @draftyak/mcp-apps --fail-if-no-match exec vitest run --mode heavy --reporter=default test/browser-corpus.heavy.test.ts`.
Preserve the shared case IDs and exercise applicable inputs through the real
built views with the same observer and calibrated controls. Native prompt,
resource-link, completion and full-policy enforcement remain M8.5/M8b.6 checks.

**Depends on:** M8b.2 and the pinned browser runtime. This harness does not
establish reference-host, native service or installed-client acceptance.
The later corpus hook additionally requires M7.6 propagated through M8; the
independent package-local baseline does not wait for that composition.

## M8b.4 Pinned reference-core and sandbox-proxy suite

**Goal:** Exercise both views through the pinned upstream basic-host core and
its sandbox proxy without changing that upstream implementation.

**Inputs:** Licensed upstream files and provenance recorded in fixture metadata,
the locally resolved locked SDK/client packages, and M8b.2's verified artifacts.
The upstream revision and file digests belong in
`apps/mcp-apps/test/fixtures/basic-host/upstream.json`.

**Outputs:** An independently checked fixture containing the unchanged core and
proxy. The fixture supplies resource HTML and results and an initialize-only
in-memory client transport. It follows the reference proxy-before-bridge
lifecycle. This component check is followed by the complete pinned basic-host
application in both browser engines and sandbox modes; a core/proxy-only pass
does not complete the item. Native service transport and genuine client-host
integration remain separate. Preserve the complete upstream license
text and applicable Apache-2.0, MIT and CC-BY terms; M10's inventory determines
the notices required for the actual included files.

**Owns:** `apps/mcp-apps/test/fixtures/basic-host/**`,
`apps/mcp-apps/test/reference-{observation,harness}.ts`,
`apps/mcp-apps/test/reference-fixtures.test.ts` and
`apps/mcp-apps/test/reference-{host,app}.heavy.test.ts`. Any package TypeScript
exclusion is limited to this vendored fixture; browser bundling must exercise
the actual fixture files.

**Acceptance:** Package unit tests verify fixture metadata and unmodified-file
identity. After building, run
`pnpm --filter @draftyak/mcp-apps --fail-if-no-match exec vitest run --mode heavy --reporter=default test/reference-host.heavy.test.ts`.
Cover Chromium and WebKit, direct and sandbox-proxy modes, and both views.
Also run the full basic-host smoke in `test/reference-app.heavy.test.ts` with
the same corpus, message observer and egress controls.
Keep strict CSP/script, egress, known-message, page-error, lifecycle, callback,
overflow and quiet-window checks. Retain the original observation across
document replacement, and test refusal controls for unexpected or duplicate
messages and corrupted observation. Record the exact installed build inputs
and browser artifacts; changes in content, identity,
inventory or module membership refuse acceptance. Diagnostic collection grants
no exception to a failed assertion.

After M7.6 propagates through M8, run its applicable hostile corpus inputs with
the same case IDs through the complete basic-host application:
`pnpm --filter @draftyak/mcp-apps --fail-if-no-match exec vitest run --mode heavy --reporter=default test/reference-app.heavy.test.ts`.
Both engines and sandbox modes must exercise those cases; a provider-only or
core/proxy-only pass does not satisfy this later composition. It adds no reverse
dependency from M7 to M8b.

**Depends on:** M8b.1–.3, approved upstream licensing/provenance and the actual
merged M1.19 contracts. Passing this fixture does not complete M8b.7.

## M8b.5 Accessibility

**Goal:** Make both passive views readable and navigable in their supported
embedding modes.

**Inputs:** Verified real artifacts, representative bounded tool results,
Chromium/WebKit and the locked test-only axe integration.

**Outputs:** Accessibility assertions for structure, readable names, contrast,
text resizing and keyboard/reading order, including unknown flags, schedules,
diffs, refusal states and visible codepoint markers. No approval or other
interactive control is added to resolve an accessibility issue.

**Owns:** `apps/mcp-apps/test/accessibility.heavy.test.ts` and accessibility
fixtures/helpers under `apps/mcp-apps/test/**`; view fixes remain M8b.1-owned.

**Acceptance:** Build first, then run
`pnpm --filter @draftyak/mcp-apps --fail-if-no-match exec vitest run --mode heavy --reporter=default test/accessibility.heavy.test.ts`
with the same browser requirements. Run axe against both real views and
embedding modes, review its findings and exercise keyboard, reading order and
text scaling. Synthetic accessibility checks do not replace the supported-host
owner check.

**Depends on:** M8b.1–.4 and the browser/tooling prerequisites.

## M8b.6 Native serving, negotiation and release integration

**Goal:** Serve only trusted static view artifacts and advertise them through
the exact era, capability and principal settings required by the plan.

**Inputs:** M8's native discovery/SDK/HTTP composition, M1.19, the trusted
embedded artifact module and current authenticated grant/token state.

**Outputs:** The versioned `ui://` resources stay out of `resources/list`, contain
no hub or user data and remain byte-identical across hubs. Any authenticated
principal may read these static assets. The discovery, SDK and serving paths
use the same verified asset instance, including agreement when views are absent;
mismatched composition refuses before listening or advertisement.

For modern-era requests, attach `_meta.ui` only when
`io.modelcontextprotocol/ui` is declared. On the legacy path, attach it whenever
`appsViews` is enabled; hosts without UI support ignore it. In both eras the
principal's `appsViews` setting applies per grant or token, defaults on and is
controlled in AI-app settings without an admin operation. Every advertised
`_meta.ui` sets `visibility:["model"]`; the six linked tools also set their
versioned `resourceUri`. The `content` array is identical with or without UI
metadata. Host-originated calls use the same token and full policy; an origin
marker conveys no privilege.

**Owns:** `apps/hub/test/mcp/{views,ui-composition,authority}.test.ts`.
M10.13b owns built-view integrity/embedding checks and M10.13c owns the installed
native-serving/release acceptance, each submitted into M10 after its dependencies
reach that branch. M8 owns production changes to native view
loading, discovery, SDK factories, local serving and principal settings through
its own backlog items; this backlog authorizes no second implementation.

**Acceptance:** Implement and run
`pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --reporter=default test/mcp/views.test.ts test/mcp/ui-composition.test.ts`
and hub typecheck against the real native adapters. Verify both eras, extension
declaration and toggle combinations, byte-exact content parity, hidden resource
listing, authenticated reads, mismatch-before-bind refusal and tampered-asset
refusal. Release checks inspect the actual embedded bytes, CSP and applicable
license inventory. UI metadata and rendered content never approve or send.

**Depends on:** M8.2–.3, M8b.1–.5, actual M1.19 merge and the applicable
owner-approved protocol handoffs. M10.13c consumes this native contract later;
M8b does not wait for code from M10.

## M8b.7 Supported-host and owner gate

**Goal:** Deliver the independent automated M8b profile and the supported-host
procedure that M9 consumes for genuine-host acceptance at its gate.

**Inputs:** For the automated profile and local drivers, merged M8 native/bridge
contracts, M4's paired-device path, M8b.1–.6 and their verified local artifacts.
The owner procedure uses M8b.8's runbook and the owner's supported-host matrix.
M9 receives these outputs forward; no M9 service, remote connector or later
release/native target is an input to this earlier profile.

**Outputs:** A supported-client guide and owner acceptance procedure covering both
resources, literal hostile text, unknown flags, schedules, diffs, accessibility,
CSP and passive message behavior. VS Code renders both views without an approve
control. Claude Desktop renders through the bridge or remote connector;
Claude Code shows the text representation. M9.6 owns remote host/connector,
native/genuine-host and era-specific observations, including the planned
web-client view checks, using the M9.7 owner runbook and the forwarded M8b
procedure. Writing the procedure does not establish any of those observations.

**Owns:** The M8b portion of `docs/guides/mcp-clients.md`, supported-host
acceptance drivers under `apps/mcp-apps/test/supported-host*.heavy.test.ts`,
`tools/verify/profiles/m8b.ts` and one root `verify:m8b` script line. Extend
the existing verifier through its profile seam, without changing its core.
The drivers here rehearse the merged local contracts and built views. Remote
case drivers belong to M9.6; neither they nor later native targets are registered
in this branch's automated profile.
The gate record (`docs/roadmap/m8b-gate.md`) is written at the gate, after the gate review.

**Acceptance:** Register and run `pnpm verify:m8b` with the preceding automated
suites and local contract drivers, using only the merged M8/M4 and M8b.1–.6
targets. Missing implementations fail this profile; an unavailable later M9
case is not replaced by an empty or synthetic pass.

M9.6/.7 consume the profile, guide, drivers and runbook forward and obtain the
genuine-host observations and shared owner review at the M9 gate. Confirm only
handshake/size traffic and no tool/resource calls, model-context changes, links
or native approval controls from a view. The accepted send still requires the
paired desktop's native PIN flow; client dialogs and passive displays grant no
authorization. Keep unimplemented or unavailable host/native observations open;
the earlier automated pass cannot complete owner acceptance.

**Depends on:** For automated implementation, M8, M4's paired-device path and
M8b.1–.6. Preparing the owner procedure additionally uses M8b.8 and the owner's
host matrix. M9.6/.7 consume these outputs later without a backward source
dependency. SMS observations additionally require M1.23/M6b and the S12 decision.

## M8b.8 Owner-check runbook

**Goal:** Make passive-view acceptance repeatable without confusing a fixture,
client dialog or rendered status with send approval.

**Inputs:** The approved M8b plan, merged view/native contracts, verified release
assets, M8's local-client setup and M9's connector owner flow when applicable.

**Outputs:** `docs/runbooks/m8b-apps.md` with prerequisites,
exact available commands, fake rehearsal, host steps, expected observations,
failure handling and timing. Missing implementation or supported-host behavior
stays an explicit gap. Record observations without inbox text or credentials.

**Owns:** `docs/runbooks/m8b-apps.md` and this backlog's coverage table. M8b.7
owns the independent automated profile/local drivers; M9.6/.7 consume this
runbook for the shared owner execution/sign-off at M9. M8 and M9 retain their
native setup/authentication flows.

**Acceptance:** Run the docs profile and guard, dry-run every executable offline
section against the implemented package, then use steps A1–A7 through M9.6/.7
at the M9 owner gate. A dry-run failure or unavailable native step cannot count
as completion.

**Depends on:** The merged interfaces and prerequisites named by each runbook
section. Writing the procedure does not depend on recording M8b.7 as passed.

## Plan coverage

This table maps requirements, not passed checks. Named future native targets and
aggregate scripts must be implemented and registered before they can pass. Use
`--fail-if-no-match`; an absent package or empty test selection is a failure.

### Milestone deliverables and acceptance (plan §12)

| Clause | Owning item | Acceptance command or explicit gap |
|---|---|---|
| Self-contained draft and send-status HTML entries | M8b.1–2 | `pnpm --filter @draftyak/mcp-apps --fail-if-no-match build` and package unit tests |
| Plan names `views.manifest.json` | M8b.2 | Package build and exact release inventory/read tests must use this name. The source correction needs actual contract, build and runtime validation before acceptance; no alternate name is approved. |
| SDK 2.0.x, inline-only JavaScript/CSS, deterministic build and hashes | M8b.2 | Package build twice, unit reproducibility/integrity cases and typecheck |
| Meta CSP, independent 256 KiB cap and passive markup lint | M8b.2–4 | Package unit tests and `exec vitest run --mode heavy --reporter=default test/browser.heavy.test.ts test/reference-host.heavy.test.ts` |
| Versioned `ui://` resources, hidden from listing and static authenticated reads | M8b.6; M8 owns serving | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --reporter=default test/mcp/views.test.ts` after native implementation |
| Modern extension declaration, legacy behavior and per-principal default-on `appsViews` toggle | M8b.6 | Same native views suite across both eras/capabilities/toggles; no admin operation for this setting |
| `_meta.ui` visibility model, six tools' resource URI and byte-identical text content | M8b.6 | Native views and `test/mcp/ui-composition.test.ts` |
| Draft body, flags, provenance, reliability notice, linked send state, schedule and word diff | M8b.1 | Package contract-parity/unit tests; runbook A3 |
| Send state, fingerprint, schedule and paired-desktop/PIN notice | M8b.1 | Package contract-parity/unit tests; runbook A4 |
| No links, buttons, approvals, network or model-context updates | M8b.1, M8b.3–4 | Browser and reference-host heavy suites; native authority suite remains required |
| Basic-host harness with unmodified upstream sources | M8b.4 | Reference fixture unit checks, core/proxy controls and full basic-host `test/reference-app.heavy.test.ts`, in both browser engines and sandbox modes. |
| Later composition of M7.6 hostile surface inputs | M8b.3–4, after M7 reaches M8 | `test/browser-corpus.heavy.test.ts` and full `test/reference-app.heavy.test.ts` with shared case IDs, real built views and calibrated observation controls. Native surface/full-policy checks remain M8.5/M8b.6. |
| Chromium and WebKit, sandboxed and direct modes | M8b.3–4 | Both browser heavy suites, no missing-engine skips |
| Hostile XSS corpus: no execution or remote traffic, only handshake/size messages | M8b.3–4 | Browser/reference-host heavy suites with calibrated negative controls |
| View bytes identical across hubs, no private context and schedule/SMS text | M8b.1, M8b.6 | Unit parity plus native views suite; SMS requires S12/M1.23/M6b rather than fixtures alone |
| Accessibility/axe | M8b.5 | `exec vitest run --mode heavy --reporter=default test/accessibility.heavy.test.ts`; runbook A5 adds owner keyboard/reading checks |
| VS Code renders both views without approve control | M8b.7–8 procedure; M9.6–7 execution | Runbook A2–A5 with the actual supported client at M9; `pnpm verify:m8b` proves only its earlier automated scope |
| Desktop bridge or remote view and Code text fallback | M8b.7–8 procedure; M9.6–7 execution | Same shared owner gate at M9; remote setup uses M9's owner flow, consumed forward |
| Owner review at M9 gate | M8b.7–8 handoff to M9.6–7 | Earlier `pnpm verify:m8b`, then named genuine-client observations and explicit owner sign-off at M9; unavailable clients remain open |

### Owned suites, threats and workflows (plan §§9.2, 11 and 13)

| Clause | Owning item | Acceptance command or explicit gap |
|---|---|---|
| Hostile draft text runs script in an Apps view | M8b.1, M8b.3–4 | Built-artifact browser/reference-host suites with hostile corpus in Chromium/WebKit, with and without sandbox: no script and no network, including native-WebView-style host settings. |
| A view injects into the conversation or calls tools | M8b.1, M8b.3–4, M8b.6 | Built browser/reference-app message recorder sees only handshake and size changes; `_meta.ui` visibility is model-only and native policy applies to every call. |
| App-originated tool call has no additional privilege | M8b.6; M8/M2 enforce policy | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --reporter=default test/mcp/authority.test.ts`; package passivity alone is insufficient |
| No egress or inbox canary in view artifacts | M8b.2–4; M11 owns installed recorder | Browser egress assertions and M11's native egress-recorder gate; no claim from an unauthenticated file hash |
| Artifact tamper, intrinsic-slot spoofing, bounded input, rollback and cleanup | M8b.2 | Package unit/integrity/release tests; M10 must inspect actual embedded bytes and licenses |
| Same verified asset across discovery/SDK/native serving, mismatch before binding | M8b.6 | Native `test/mcp/ui-composition.test.ts`; no parallel loader implementation |
| Unknown flags, schedules, word diffs, marker rendering and content parity | M8b.1 | Package parity/unit tests and browser cases; real host A3–A5 |
| CSP/passivity observer and negative controls stay independent of axe instrumentation | M8b.3–5 | Separate browser/reference-host and accessibility heavy suites |
| `security.yml` selects real Apps corpus and UI-origin authority tests | M8b.3–6 with shared workflow owner | Heavy suites plus native authority target at the submitted head; path-filtered skips do not execute them |
| `ci.yml` unit/types/build/drift/guard | M8b.1–5 with shared workflow owner | Touched-package unit/types/build, `pnpm guard`, required full CI jobs and package artifact drift checks |
| `e2e.yml` installed hub/UI and genuine host composition | M8b.6–7 local scope with M3/M4/M8; M9.6 remote/genuine-host composition | Earlier `pnpm verify:m8b` after aggregate registration, then M9.6/.7's forward-composed host acceptance; core/proxy fixtures do not satisfy the later observations |
| §13 production approval/budget/scheduling properties | M2/M8 own enforcement, not passive Apps | Explicit dependency on native policy/approval model suites; view code grants no authority |
| Setup, commands, observations, failures, timing and fake dry-run | M8b.8 | Runbook offline commands and A1–A7, docs profile and guard |

All other §9.2 threats remain with their named enforcement owners. Remote auth,
number matching, consent, rotation/reuse and deployment are M9-owned; this
backlog neither replaces those tests nor claims a genuine host from a fixture.
