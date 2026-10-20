# M7b backlog: context lookups

The approved plan's sections 3–5, invariant I5 in section 9.1, milestone M7b
and the context-lookup suites in section 13 define this backlog. The hub plans
lookups before native AI drafting. Arguments come only from verified metadata,
owner settings, the clock and constants. Models, plugins, MCP methods and
scheduled claims cannot trigger lookups or choose their arguments.

The `packages/lookup-core/` component contains pure planning, binding,
calendar rendering and an injected runner. It requires trusted native adapters;
it supplies no endpoint, native authorization, consent store, broker, credential
store or UI. Callbacks, permission booleans and self-consistent plans are not
native authorization evidence. Calendar availability grants no permission to send.

## Changed since the plan

- **Protected package placement is approved (decision D23).** The planner, binder and runner
  remain in `packages/lookup-core/`. Only the native `apps/hub/src/tools/`
  boundary may import its protected root entry in production. The separate
  `./calendar` entry exports only pure calendar functions and types; the offline
  calendar golden harness may use that entry. Repository checks enforce these
  imports, while actual native authorization and transport call-site acceptance
  remain M7b.2/5/10 work. The ownership handoff below installs the protected rules.
- **Owner-recipient binding is independently approved (decision D23).** A To/Cc recipient
  chosen by the owner in a hub-verified outbound send is eligible without a
  verified inbound sender. That recipient may be another person; it need not be
  an address belonging to the owner. The separate verified-sender binding still
  requires its own sender proof. Neither raw incoming To/Cc, asserted direction,
  Reply-To nor content establishes a verified outbound-send recipient. Consent,
  no-train posture, routing and per-draft cloud confirmation still apply.
- **The sender-authentication skip is specific to `participant.verifiedSender`.**
  Section 5's DMARC skip and section 13's DMARC-fail contact test apply to that
  binding. They do not suppress an independently verified
  `participant.ownerRecipient`. A Reply-To-only address never binds. M7b.1/11
  test both proofs independently.
- **Plugin transport follows decision D27.** Native lookup integration consumes
  the shared M1 `@draftyak/protocol/plugin-stdio` contract: tagged host frames
  on stdin/stdout, FIFOs on Linux/macOS and spawn pipes on Windows. Consumers
  wait for that contract and the M2 runtime to merge. Other ADR 0003 gate
  questions remain pending.

## Ownership and acceptance conventions

Component paths identify the pure lookup implementation. Planned hub, SPA,
security and documentation paths identify integration work to coordinate with
their owning streams, not deliverables implemented by the component. Shared
protocol or manifest changes land in M1 before consumer use. Placement-dependent
paths keep the protected package and its native adapter boundary above.

Root ownership configuration is maintained on `m11`. Its
CODEOWNERS must assign `/packages/lookup-core/**` and `/apps/hub/src/tools/**`
to `@nicksavov`, protect `/.github/CODEOWNERS` itself and require that owner's
review on the integration and release branches with stale approvals dismissed
after changes. The file's presence on `m11` does not establish these protections
on earlier integration branches. Installing the path rules and branch settings
is an explicit integration handoff, not a completed runtime control. The
package's test scanner grants no runtime authority.

Commands naming pending hub, SPA or security targets are required future
acceptance. Each item must provide its test target and package script before
passing. `pnpm verify:m7b` is the planned milestone gate, not an existing command
or a completed result. Verification logs and run counts belong in the PR body.

The main interface is the one `apps/web` SPA shared by browser, desktop and
mobile. Tool features use its React 19.3/React Compiler 1.0, Vite 8,
TanStack Router/Query/Virtual, shadcn/ui on Base UI, Tailwind v4, DOMPurify 3.4
and openapi-fetch stack, with ADR 0001 V12 pins and Vitest tiers. Tauri bundles
that build as `frontendDist`. Tool-consent and secret-calendar-address entry
stay in the trusted approval window or CLI through M4.12/M4.13 admin hooks;
they are never accepted through the SPA.

## Work items

### M7b.1 Planner and binder

- **Goal.** Enforce I5 before a model runs using closed binding sources.
- **Inputs.** Merged tool-v1, M7b.11 verified metadata, owner presets and trigger, and the protected package/native adapter boundary above.
- **Outputs.** Detached immutable plans, deduplication, skip reasons and pending cloud confirmations. Only planner-issued objects reach the runner.
- **Owns.** Component `packages/lookup-core/src/{planner,binder,metadata}.ts`, `test/{planner,planner-security,planner-contracts,owner-recipient,boundary,repository-boundary}.test.ts` and `test/{runtime-imports,repository-imports}.ts`; planned `apps/hub/src/tools/{planner,binder}.ts` and `apps/hub/test/tools/{planner,import-boundary}.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/lookup-core test` and `pnpm --filter './apps/hub' test -- tools/planner tools/import-boundary`: 500 generated metadata/preset cases preserve kinds, instances and JCS arguments when bodies, subjects, names, Reply-To and unverified headers change, including nested fields. Exercise both participant sources, Gmail authentication failures, Slack bots and attempted SMS contacts; automatic positive controls contain real calls with only `hub.state` arguments. Enforce merged preset limits and exact deduplication. Scan the transitive runtime imports to exclude content modules. If the package remains, a repository scan permits only the protected hub tools boundary to import it.
- **Depends on.** M1.7, M7b.11; the hub scaffold and installed protected ownership rules for native I5 acceptance.

### M7b.2 Bounded runner and sole lookup call site

- **Goal.** Execute only approved plans under current native authorization.
- **Inputs.** M7b.1 plans, current instance/consent facts and M2 runtime/broker.
- **Outputs.** Parallel calls with content-free per-call outcomes, discovery checks, cancellation, quarantine and trusted reviewed-digest release.
- **Owns.** Component `packages/lookup-core/src/{runner,model}.ts`, `test/{runner,runner-outcomes,review-lifecycle,elapsed-deadlines,discovery-cancellation}.test.ts`; planned `apps/hub/src/tools/runner.ts`, its `LookupHost` adapter and `apps/hub/test/tools/runner.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/lookup-core test` and `pnpm --filter './apps/hub' test -- tools/runner tools/import-boundary`: refuse forged plans before callbacks; recheck exact discovery extension, canonical complete list and authorization before calls/hits. Drift quarantines before use. Native acceptance additionally handles authenticated instance `notifications/tools/list_changed`: re-list even while idle, compare the complete canonical surface, and quarantine, evict and fence affected pending results on drift. An unchanged list grants no new authority and preserves ordinary cache TTL/hourly budgets. Enforce ten-second readiness, five-second calls and fifteen-second calendar calls, including elapsed checks after awaits. Close request permits on settlement or abort; cancel through the signal and request an unanswered-call stop only if that call remains unanswered five seconds later. Bind that stop to the exact opaque per-call invocation receipt supplied to the host, including reused job IDs and multiple calls to one instance; the native adapter must map it to the original transport request without serializing it or treating job IDs as authority. Keep Slack job-end stop reasons distinct. Release only matching reviewed quarantine digests, invalidate their cache and retain hourly budgets. The repository scan permits only the protected runner adapter to send `tools/call` to a tool plugin. Preserve merged error codes/retry delay without detail, raw/clean byte counts and latency, and enforce each kind's manifest output ceiling.
- **Depends on.** The pure component uses merged tool-v1 validators and a detached trusted `ToolInstance.outputMaxBytes` input, enforced before results and cache hits. This seam neither extracts nor authenticates manifest facts. Native acceptance requires M7b.1, M7b.4–5, M2 runtime/broker, installed protected ownership rules and the merged M1 manifest definition before the adapter projects each reviewed kind's output ceiling.

### M7b.3 Cache and resource lifecycle

- **Goal.** Bound memory, request use and retained lookup data across jobs.
- **Inputs.** M7b.2 execution, native account/instance lifecycle and the clock.
- **Outputs.** Memory-only ten-minute cache, rolling instance budgets, bounded context admission and immediate invalidation.
- **Owns.** Cache/budget sections of `packages/lookup-core/src/runner.ts`, `test/{runner,provenance,hygiene-provenance,invalidation}.test.ts`; planned `apps/hub/src/tools/lifecycle.ts` and `apps/hub/test/tools/lifecycle.test.ts`, coordinated with M7b.2's runner owner.
- **Acceptance.** `pnpm --filter @draftyak/lookup-core test` and `pnpm --filter './apps/hub' test -- tools/lifecycle`: sixty actual calls/hour/instance, hits excluded; four broker requests per lookup; ten-minute expiry and backward-clock handling. Preserve host/receipt provenance and fresh authorization on hits. Slack-derived entries survive only their draft job, never another job or later reuse of its id. Revocation, disable, disconnect and cancel drop affected entries and late writes. Matching account/instance invalidation fences readiness, fresh fetches, cached hygiene and completed parallel siblings through final admission even after authorization is restored or quarantine released. Finish all final authorization callbacks before admitting any context; invalidation from a later sibling cannot leave an earlier result admitted. Keep unaffected accounts/instances usable. Admit at most 4,096 bytes/context and 8,192 bytes/draft after hygiene with provenance included, in plan order; bound cache and rate-state cardinality.
- **Depends on.** M7b.2, M7b.4–5 and native lifecycle wiring.

### M7b.4 Native consent and routing

- **Goal.** Permit arguments and results only under current policy and explicit consent.
- **Inputs.** Merged entities/routing types, M2 admin operations and storage, current instance status/digest/hosts/posture, consent kinds/fields/disclosure and AI destination; a selectable accepted/rejected policy outcome for Google reading 4. Both outcomes are built now with accepted as the plan default; final legal selection belongs only to M11 and does not block this implementation.
- **Outputs.** Account × tool-instance consents, presets and revocation; per-draft confirmation bound to actual pending argument digests before cloud disclosure. One hub policy rule records reading 4: accepted is the plan default and permits Gmail auto-draft cloud-tool lookups with only `hub.state` arguments and no per-draft confirmation; rejected permits only local/local-network lookups and skips cloud lookups with a fixed chip reason. The M11 launch gate sets the rule from the legal review's outcome.
- **Owns.** Planned `apps/hub/src/tools/{consent,policy}.ts`, `apps/hub/test/tools/{consent,policy}.test.ts` and tool-specific admin handlers; migration additions are coordinated with the storage owner.
- **Acceptance.** `pnpm --filter './apps/hub' test -- tools/consent tools/policy`: channel × destination/posture × consent × argument class × trigger produces the expected decision. Include no-egress tools, unavailable/credential-lost instances, `channel-hello`, consent field/kind changes and epoch invalidation. Gmail/Slack values never reach may-train tools; Slack non-local disclosure needs provider-named opt-in. Cloud message-derived arguments require the draft-bound confirmation; automatic calls carry no message-derived values and sensitive texts trigger none. Exercise reading 4 both accepted and rejected with nonempty Gmail auto-draft plans: accepted runs an otherwise eligible `hub.state` cloud lookup without per-draft confirmation, rejected skips it with the fixed reason while local/local-network positive controls still run. Results inherit tool and argument classes and require the consent's AI destination.
- **Depends on.** M1 entities/manifest contracts, M2 admin/storage, M7 routing and M7b.11; trusted confirmation UI follows M4.

### M7b.5 Broker and runtime integration

- **Goal.** Enforce lookup-bound egress and secret substitution in the actual broker.
- **Inputs.** M2's host channel using the merged M1 `@draftyak/protocol/plugin-stdio` contract and decision D27's tagged stdio/FIFO design, manifests, M7b.2 permits, resolved endpoint policy and M2.17b's shared `tools/egress-recorder/**` result format.
- **Outputs.** Tool instances pre-spawned when chips are planned, structural read-only egress, authenticated tool-surface notification dispatch and native health/reset handling.
- **Owns.** Planned `apps/hub/src/tools/{host,egress}.ts`, `apps/hub/test/tools/egress.heavy.test.ts` and M7b fixtures under `security/hostile-plugins/tool-*/`; M2 owns shared runtime/broker changes.
- **Acceptance.** `pnpm --filter './apps/hub' test:heavy -- tools/egress`: M2.17b's test-profile recorder observes every outbound connection the hub and plugins attempt, including attempts denied before reaching a fake. Only declared GET/HEAD hosts during running lookups pass; deny writes, WebSockets, altered secret references and post-settlement requests and audit denials. An attempted connection to an undeclared tool host is a positive control: it must be recorded and fail the egress check. Substitute calendar URLs only inside the broker; none appear in argv, environment, stdio, logs, audit or prompts. Cancel, drift and delayed answers cannot bypass policy/caps. Exercise authenticated `list_changed` ingress while idle and during pending calls/cache hygiene: a changed-then-restored surface stays quarantined until exact reviewed release; malformed probes fail within the readiness bound, and forged notifications cannot affect a second instance. `AUTH_REVOKED` triggers a native probe and needs-new-address state; replacement remains an admin operation.
- **Depends on.** M7b.2–4, the merged M1 plugin-stdio contract, M2 runtime/broker and M2.17b. Decision D27 selects the transport; this item waits for its merged implementation. Its native session binds `list_changed` to the correct instance and dispatches M7b.2's bounded re-list/quarantine path; forged notifications cannot affect another instance. M7b.9 supplies the content-free owner-device alert. If S11 starts M2c before M7b, the recorder item moves to M2c and this dependency follows it.

### M7b.6 Calendar feed engine and wire adapter

- **Goal.** Produce validated busy/tentative intervals from an explicitly configured feed without revealing event details or partial availability.
- **Inputs.** Merged UTC-ms `CalendarFreebusyResult`, owner zone/window and bounded native broker responses. The pure API accepts feed bytes and an optional trusted remaining deadline; the wire arguments remain unchanged.
- **Outputs.** Pure `tool-calendar-ics`, synthetic provider/DST fixtures and content-free typed refusals. The public `freeBusy(feed, window, timeZone, {timeoutMs?})` boundary returns shared UTC-ms intervals clipped to the requested half-open window; `mergeBusy` reuses the shared helper, and `CalendarError` exposes fixed codes without feed data or parser causes. Availability grants no credential, send or approval authority. SDK wire/fetch integration remains required below.
- **Owns.** `plugins/tool-calendar-ics/**`, `security/ics-corpus/**` and its `pnpm-lock.yaml` workspace importer/exact external library package entries. M7b.13 owns composed renderer goldens; shared contracts remain M1-owned.
- **Acceptance.** `pnpm --filter @draftyak/tool-calendar-ics test`, `pnpm --filter @draftyak/tool-calendar-ics test:heavy`, `pnpm --filter @draftyak/tool-calendar-ics typecheck` and `pnpm --filter @draftyak/tool-calendar-ics build`. Through the public API under the plugin flags and two-core resource control, accept 5,000 retained components and a roughly 30 MiB provider-shaped feed; refuse 5,001 components, inputs above 32 MiB and 2,001 positive overlapping instances. Preserve the independent 2,000-instance, 200-interval and 20,480-byte boundaries. Bound raw recurrence calls at 100,000, retained RDATE/EXDATE scalars at 10,000, and feed-zone work/transitions at 100,000/10,000; exercise the deadline independently. Check RRULE/RDATE/EXDATE/overrides, old-event/ended-rule pruning, orphan invitations, all-day/floating and feed/IANA zones, UTC/GMT aliases, and Google/Outlook forms of all six required DST goldens. Seed structural fuzzing from valid feeds under string-code-generation restriction and a 256 MiB heap; only schema-valid bounded results or typed content-free errors may emerge. Compare committed recurrence goldens with pinned development-only python-dateutil, retaining a literal RFC complete-first-week control. Keep `ical.js` external with dist/type exports. No title, description, attendee, organizer, location, URL or attachment canary reaches output. Native acceptance additionally requires one conditional broker GET, no redirects, content-type/32 MiB enforcement and only the remainder of the ready-instance 15-second budget after fetch; redirected, wrong-content-type and over-limit responses refuse. Reset/wizard integration remains M7b.5/9.
- **Depends on.** M1.7 and merged tool-v1; actual fetching, canonical SDK handlers and the native host/channel require M7b.5. M7b.10 verifies the integrated result and owns the separate owner sessions after this implementation; passing the pure engine does not complete those gates.

Release artifacts keep the exact external `ical.js` 2.2.1 bytes and license
beside the plugin bundle, with no inlining or minification. M10's release guard
checks the installed package hash and license inventory. M7b.5/10 retain broker
fetch, secret handling and native lifecycle acceptance; M7b.13 separately owns
the engine-to-renderer free-slot goldens.

### M7b.7 Working hours and free-slot display

- **Goal.** Render deterministic availability in the owner's zone.
- **Inputs.** M7b.6 intervals, owner working hours/zone and the current clock.
- **Outputs.** Working-day windows and free-slot labels; persisted settings follow in SPA integration.
- **Owns.** `packages/lookup-core/src/{clock,calendar,public-calendar}.ts`, `test/calendar.test.ts` and the package's restricted root/calendar exports; planned `apps/hub/src/tools/calendar.ts` and its native adapter tests. M7b.9 owns settings UI.
- **Acceptance.** `pnpm --filter @draftyak/lookup-core test -- test/calendar.test.ts`: next 3/5/10 working days; stable ten-minute window/horizon anchor permits actual cache reuse while rendering reapplies the current one-hour lead. Use Temporal start-of-day for midnight transitions and reject ambiguous/nonexistent working-hour boundaries with fixed errors. Clip valid busy intervals to the window; busy/tentative both subtract. Emit at most twelve slots, local quarter-hour starts rounded upward, at least thirty minutes long and one hour ahead, with local wall time, zone and applicable UTC offsets. Cover non-UTC/fractional-offset zones. M7b.13 verifies engine composition.
- **Depends on.** M1.7, native Temporal, owner settings and M7b.6; scheduling decisions stay separate.

### M7b.8 Hygiene, prompt framing and revision flags

- **Goal.** Treat tool output as untrusted data throughout drafting.
- **Inputs.** M3's isolated content-hygiene pipeline, M7 request construction, M7b.2 outcomes and captured fetch provenance.
- **Outputs.** Cleaned bounded contexts, separate random context delimiters, filtered `contextRefs` and recomputed `TOOL_*` flags on every revision.
- **Owns.** Planned `apps/hub/src/tools/{hygiene,contexts}.ts`, `apps/hub/test/tools/contexts.test.ts` and tool-context cases in `security/injection-corpus/`; provider adapters remain M7-owned.
- **Acceptance.** `pnpm --filter './apps/hub' test -- tools/contexts`: job-bound hygiene preserves ref/tool/kind/host/receipt identity on calls/hits. Findings raise `TOOL_INSTRUCTIONS`; JSON-escaped contexts use a second fresh random delimiter. Drop unknown refs. Recompute `TOOL_DATA_IN_BODY` from keyed context tokens on every revision; `TOOL_CONTEXT_USED` names actual used kinds/hosts. Hygiene cannot rewrite calendar structure. M7b.10 proves models induce no extra call.
- **Depends on.** M3 hygiene, M7 drafting, M1 flags/output contracts and M7b.2–3/12.

### M7b.9 Context chips, configuration and policy UX

- **Goal.** Show actual choices, policy and lookup outcomes before drafting.
- **Inputs.** M3's shared `apps/web` composer, M4 trusted admin surfaces, presets, pending confirmations and content-free outcomes.
- **Outputs.** Planned/running/used/cached/skipped/timed-out/quarantined chips, content-free owner-device alerts for tool-surface drift, consent and calendar-address wizard, working-hours settings and reset handling.
- **Owns.** Planned `apps/web/src/tools/**`, `apps/web/test/tools/**` and tool-specific Security Center views, plus route/nav registration lines coordinated with the SPA owner. Tool-specific trusted consent and secret-address views and `apps/app/test/tools/admin.heavy.test.ts` extend the M4.12/M4.13 admin hooks by agreement with their owner.
- **Acceptance.** `pnpm --filter './apps/web' test`, `pnpm --filter './apps/web' test:heavy -- tools` and `pnpm --filter './apps/app' test:heavy -- tools/admin`: unticking/switching changes the executed plan; show actual fields/host, fixed reason, cached age and quarantine. Native tool-surface drift triggers a content-free owner-device alert without waiting for another draft; no tool descriptions, results or plugin error detail appear in it. Missing permission skips without blocking drafting. Confirmation covers only this draft's pending cloud arguments. Context text is visible only while retained in memory, later metadata only. Setup explains provider feed options/full-detail public-link risk and admin-only secret replacement; the SPA cannot set a `url-secret`. Consent and secret entry run only through the approval window or CLI, with the admin PIN. Never show optimistic permission/availability state.
- **Depends on.** M4, M7b.1–5/7–8/12.

### M7b.10 Integrated security and owner gates

- **Goal.** Establish native I5 across channels and providers.
- **Inputs.** Fake ICS/CRM, M2.17b's shared attempted-connection recorder and result format, the messages-api, responses-api api-key and chat-completions obedient models, and the policy matrix.
- **Outputs.** Native security suites, the `verify:m7b` gate profile, an owner-only feed-canary script/runbook, sanitized owner-authorized feed fixtures and cross-milestone acceptance. Sign in with ChatGPT is clean-room work that no M7b item writes: M7b supplies no SIWC code, fake or stub, and the provider list stays open.
- **Owns.** Planned `apps/hub/test/security/context-lookups.heavy.test.ts`, M7b fake tools/upstreams in `packages/fakes/`, tool-specific hostile fixtures, `tools/verify/profiles/m7b.ts`, the root `verify:m7b` script line, `apps/hub/test/tools/calendar-feeds.live.test.ts` and `docs/runbooks/context-lookups.md`. Sanitized feeds enter `security/ics-corpus/` only through the owner's authorized live-canary workflow. Shared verifier and fake export/README additions remain limited to registration lines.
- **Acceptance.** `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` and `pnpm verify:m7b`: for messages-api, responses-api (api-key) and chat-completions, an obedient model demanding extra calls/contacts or fake tool blocks adds no `tool_runs`; the run set equals the approved plan and requests gain no tools. Execute the policy matrix and hostile result/drift/cancel/revocation cases. M2.17b records all attempted outbound connections, including an undeclared-host positive control that fails the check. Only declared hosts pass; inbox, secret URL and event-detail canaries never escape their permitted boundaries. MCP cannot trigger lookups/read results and exposes only `contextRefs` and flags; that acceptance portion lands in M8 by agreement with its owner. Google/Outlook/Fastmail owner sessions run `pnpm --filter './apps/hub' test:live -- tools/calendar-feeds` only with separate explicit authorization. The runbook gives setup, exact commands, expected results, failure/cleanup steps and duration, and is dry-run against the fakes before the owner session.
- **Depends on.** M7b.1–9/11–14, M7 providers, M2 broker and M2.17b; MCP checks land in M8 after its surface exists, SMS rows wait for M6b's FakeSmsHost and the owner's S12 go. Python integration waits for M2c and S11. A no-go drops affected optional rows, never silently passes them. The clean-room provider suite is supplied separately by its M7 work.

The gate record (`docs/roadmap/m7b-gate.md`) is written at the gate, after the gate review.

### M7b.11 VerifiedThreadMeta builder

- **Goal.** Derive trusted metadata from hub-owned message/send evidence.
- **Inputs.** Merged message entities, M3 parsing/direction evidence, Gmail/Slack ingestion and hub-verified outbound send receipts with the owner's selected To/Cc recipients.
- **Outputs.** Closed account/channel, verified latest inbound sender, eligible verified To/Cc, sensitivity and automatic facts; no content, names or unverified headers.
- **Owns.** Planned `apps/hub/src/tools/metadata.ts`, `apps/hub/test/tools/metadata.test.ts`; evidence producers stay with their channel/content streams.
- **Acceptance.** `pnpm --filter './apps/hub' test -- tools/metadata tools/planner`: compose the actual builder with planner/binder in 500 generated cases. Mutate content, names, Reply-To, non-topmost/wrong-authserv Authentication-Results and nested unknown fields without changing kinds/instances/JCS arguments. Gmail verified-sender bindings require a single From and the topmost provider `mx.google.com` DMARC pass aligned with its domain. Slack verified-sender bindings use the API user id, never bot/username posts; SMS supplies no verified participant. Owner-recipient evidence comes only from the owner's selected To/Cc in hub-verified outbound sends, never an incoming To/Cc, asserted direction/header or Reply-To. Exercise that independent recipient binding with absent/failed inbound-sender proof, and retain trusted automatic metadata checks.
- **Depends on.** M1 entities, M3 parsing and M5/M6 ingestion; optional SMS evidence follows M6b.

### M7b.12 Content-free tool_runs and keyed context evidence

- **Goal.** Persist auditable lookup metadata without arguments/results.
- **Inputs.** Merged `ToolRunStatus`, M7b.2 outcomes, M2 storage/crypto and the `tool-tokens` subkey.
- **Outputs.** `tool_runs` rows with draft/AI-run/account/instance/kind/trigger, HMAC `args_hash`/`result_hash`, raw/clean bytes, truncation, destination/host, status and latency. `ai_runs` stores refs and bounded keyed context tokens, never raw contexts.
- **Owns.** Planned `apps/hub/src/tools/evidence.ts`, `apps/hub/test/tools/evidence.test.ts` and tool-run retention/migrations coordinated with the storage owner.
- **Acceptance.** `pnpm --filter './apps/hub' test -- tools/evidence`: HMACs use `tool-tokens`, not unkeyed digests; no persisted argument/result/detail field exists. Preserve `ok|cached|timeout|error|skipped|denied|quarantined`, counts and latency for calls/hits/refusals. Link the real draft/AI run; cap keyed context tokens at 64 and support revision flag recomputation. Scan db, WAL, FTS, backup and logs for result canaries; only content the owner keeps in a draft body may persist. Exclude `tool_runs` from backups; purge on disconnect and the rolling ninety-day cap.
- **Depends on.** M1 entities, M2 storage/crypto, M7 drafting and M7b.2–3; M7b.8 consumes this evidence.

### M7b.13 Composed calendar free-slot goldens

- **Goal.** Verify the real calendar engine's wire output through the renderer.
- **Inputs.** M7b.6 engine, shared UTC-ms validation, M7b.7 rendering and fixed owner settings/clock.
- **Outputs.** End-to-end golden slots/labels from ICS, without hand-replacing the engine's busy intervals.
- **Owns.** Component `tools/calendar-goldens/**` and `security/ics-corpus/free-slots/`; planned `apps/hub/test/tools/calendar-goldens.test.ts`; shared inputs coordinate with the calendar owner.
- **Acceptance.** `pnpm --filter @draftyak/calendar-goldens typecheck` and `pnpm --filter @draftyak/calendar-goldens test` establish the offline pure composition; planned `pnpm --filter './apps/hub' test -- tools/calendar-goldens` remains required native integration. Run RRULE/RDATE/EXDATE/override, all-day/floating and transparent/cancelled/tentative fixtures through actual engine → shared validator → renderer and compare exact goldens. Include spring/fall DST in the scheduling corpus's three zones, midnight transitions, fractional offsets, in-progress clipping, quarter-hour rounding and minimum length. Require nonempty positive controls where appropriate; event-detail canaries never reach contexts. Oversize/malformed feeds stay errors, never empty availability.
- **Depends on.** M7b.6–7 and merged M1 calendar/time-zone fixtures; native broker composition also needs M7b.5. M7b.10 consumes these goldens at the integrated gate.

### M7b.14 Privacy and compliance documentation

- **Goal.** Explain real destinations, data classes, consent and retention without overstating policy approval.
- **Inputs.** Plan guardrails, recorded egress/disclosures, M7b.4/9/12 and owner/legal decisions.
- **Outputs.** Lasting privacy/provider mappings and Security Center disclosure text aligned with behavior.
- **Owns.** M7b sections of `PRIVACY.md`, `docs/compliance/{google-workspace,slack}.md` and tool-destination documentation, coordinated with shared documentation owners.
- **Acceptance.** `node tools/verify/verify.ts --profile docs`, `pnpm guard` and `pnpm verify:m7b`: document every recorded destination's trigger, fields/classes, host, posture, AI destinations and retention; memory-only results, Slack job scope, keyed evidence, secret URLs, revocation and disconnect/backup behavior. Keep four Google readings pending pre-launch legal review: secret-iCal Limited Use, per-draft cloud confirmation granularity, agent-session granularity and message-free auto-draft cloud lookups. Reading 4 uses M7b.4's single policy rule and its tested accepted/rejected outcomes; the M11 launch gate sets it from the legal review. Documentation never substitutes for owner consent, feed acceptance or legal sign-off. These sections land with the shared documentation on M11, by agreement with its owner.
- **Depends on.** M7b.4–5/9–12, documentation owners and pre-launch legal review.

## Plan coverage

These tables map requirements to acceptance work, not completed results. Commands
for planned hub, SPA and security targets must be implemented before their
rows pass. The package and offline-composition commands cover only their stated
component boundaries. No component result substitutes for native or owner gates.

### Section 12: M7b deliverables

| Plan clause | Backlog coverage | Acceptance command or explicit gap |
|---|---|---|
| Pure planner | M7b.1, with native verified inputs from M7b.11 | `pnpm --filter @draftyak/lookup-core test`; `pnpm --filter './apps/hub' test -- tools/planner tools/metadata` |
| Binder with closed binding sources | M7b.1 | `pnpm --filter './apps/hub' test -- tools/planner tools/import-boundary` |
| Runner; pre-spawn Python tools when chips are planned | M7b.2/5/9 | `pnpm --filter './apps/hub' test -- tools/runner`; `pnpm --filter './apps/hub' test:heavy -- tools/egress`; Python rows depend on M2c and the S11 go decision. |
| Per-account presets | M7b.1/4/9 | `pnpm --filter './apps/hub' test -- tools/planner tools/consent`; `pnpm --filter './apps/web' test:heavy -- tools` |
| Consent admin operation | M7b.4/9 | `pnpm --filter './apps/hub' test -- tools/consent tools/policy`; `pnpm --filter './apps/web' test:heavy -- tools`; `pnpm --filter './apps/app' test:heavy -- tools/admin` |
| Draft-bound lookup confirmation | M7b.4/9 | `pnpm --filter './apps/hub' test -- tools/consent`; `pnpm --filter './apps/web' test:heavy -- tools` |
| Context chips | M7b.9 | `pnpm --filter './apps/web' test:heavy -- tools` |
| Tool-destination routing | M7b.4 | `pnpm --filter './apps/hub' test -- tools/policy` |
| Recomputed `TOOL_*` flags | M7b.8/12 | `pnpm --filter './apps/hub' test -- tools/contexts tools/evidence` |
| Filtered `contextRefs` | M7b.8/10 | `pnpm --filter './apps/hub' test -- tools/contexts`; `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` |
| Separate random `<context-{B2}>` framing | M7b.8 | `pnpm --filter './apps/hub' test -- tools/contexts` |
| Keyed `tool_runs` hashes | M7b.12 | `pnpm --filter './apps/hub' test -- tools/evidence` |
| `tool-calendar-ics` | M7b.6 | `pnpm --filter @draftyak/tool-calendar-ics test`; `pnpm --filter @draftyak/tool-calendar-ics test:heavy`; native fetch acceptance additionally needs M7b.5/10. |
| Calendar setup wizard | M7b.9 | `pnpm --filter './apps/web' test:heavy -- tools`; `pnpm --filter './apps/app' test:heavy -- tools/admin` |
| Working-hours setting and rendering | M7b.7/9 | `pnpm --filter @draftyak/lookup-core test -- test/calendar.test.ts`; `pnpm --filter './apps/web' test:heavy -- tools` |
| Fake ICS upstream | M7b.10 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` must exercise conditional replies, redirects, oversize and slow responses. |
| ICS corpus | M7b.6/13 | `pnpm --filter @draftyak/tool-calendar-ics test`; `pnpm --filter @draftyak/calendar-goldens test` |
| Fake CRM tool | M7b.10 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` must use a real fake-plugin process and recorder. |
| Sanitized Google feed fixtures from `live-canary` | M7b.10 | Gap until an explicitly authorized owner session supplies the sanitized fixture; `pnpm verify:m7b` then validates it. M7b.10 must supply the exact session commands before this gate. |
| Sanitized Outlook feed fixtures from `live-canary` | M7b.10 | Same owner-session gap; `pnpm verify:m7b` validates the authorized sanitized fixture. |
| Sanitized Fastmail feed fixtures from `live-canary` | M7b.10 | Same owner-session gap; `pnpm verify:m7b` validates the authorized sanitized fixture. |
| Privacy documentation | M7b.14 | `node tools/verify/verify.ts --profile docs`; `pnpm guard`; `pnpm verify:m7b` checks the recorded destinations. |
| Provider compliance documentation | M7b.14 | Same commands; pre-launch legal decisions remain owner gates, not test results. |
| One SPA with trusted tool-consent and secret-address entry | M7b.9, M3 SPA and M4.12/M4.13 admin hooks | `pnpm --filter './apps/web' test:heavy -- tools`; `pnpm --filter './apps/app' test:heavy -- tools/admin`; no second inbox/settings UI and no SPA secret entry. |

### Section 12: M7b acceptance clauses

| Plan clause | Backlog coverage | Acceptance command or explicit gap |
|---|---|---|
| Planner property test passes | M7b.1/11 | `pnpm --filter './apps/hub' test -- tools/metadata tools/planner tools/import-boundary` |
| Obedient-model suite passes for messages-api, responses-api (api-key) and chat-completions | M7b.8/10 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups`; native M7 provider integration is required. |
| Obedient-model suite for Sign in with ChatGPT | Separate clean-room M7 provider work | Explicit gap: the SIWC row is supplied by that work; no M7b code, fake or stub covers it. The provider list stays open, and the milestone gate requires its separately supplied result. |
| Hostile-tool suite passes | M7b.2/5/8/10 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups tools/egress` |
| Policy matrix passes | M7b.4/10 | `pnpm --filter './apps/hub' test -- tools/policy`; `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` |
| Recorder shows only declared tool hosts | M7b.5/10, using M2.17b | `pnpm --filter './apps/hub' test:heavy -- tools/egress security/context-lookups`; record every attempted outbound connection and fail an undeclared-host positive control. |
| Recorder finds no inbox canary in a tool request | M7b.5/10 | Same native recorder command; a pure planner result alone does not prove egress. |
| RRULE, DST, override, all-day, transparent and cancelled feeds match golden free slots | M7b.6/7/13 | `pnpm --filter @draftyak/calendar-goldens typecheck`; `pnpm --filter @draftyak/calendar-goldens test`; native `pnpm --filter './apps/hub' test -- tools/calendar-goldens` remains required. |
| Calendar URL canary never leaves the broker | M7b.5/10/12 | `pnpm --filter './apps/hub' test:heavy -- tools/egress security/context-lookups`; `pnpm --filter './apps/hub' test -- tools/evidence` |
| Event title, attendee and location canaries never reach a prompt | M7b.6/8/10/13 | `pnpm --filter @draftyak/calendar-goldens test`; `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` |
| Auto-draft never runs a lookup with message-derived inputs | M7b.1/4/10/11 | `pnpm --filter './apps/hub' test -- tools/planner tools/policy tools/metadata`; native recorder suite above. |
| MCP sees only refs and flags, never lookup results | M7b.10 acceptance portion in M8 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` on M8 after its adapter exists, by agreement with its owner. This remains an explicit integration gap until then. |

### Owned requirements from sections 5, 9 and 13

| Plan clause | Backlog coverage | Acceptance command or explicit gap |
|---|---|---|
| I5: only verified metadata, owner configuration and clock bind arguments; sole runner call site | M7b.1/2/5/11 | `pnpm --filter './apps/hub' test -- tools/metadata tools/planner tools/import-boundary`; `pnpm --filter './apps/hub' test:heavy -- tools/egress` |
| Closed binding sources and independent verified sender/owner-recipient proofs | M7b.1/11; approved recipient interpretation above | `pnpm --filter './apps/hub' test -- tools/metadata tools/planner` |
| Reading 4 accepted/rejected Gmail auto-draft policy | M7b.4/10; M7b.14 documentation, M11 legal selection | `pnpm --filter './apps/hub' test -- tools/policy`; both outcomes retain nonempty `hub.state` controls. Accepted permits eligible cloud lookup without per-draft confirmation; rejected skips cloud with a fixed chip reason and permits local/local-network. Legal selection is an explicit M11 owner gate. |
| At most five presets, one default, three items and one contact lookup per draft | M7b.1/4 | `pnpm --filter './apps/hub' test -- tools/planner tools/consent` |
| Exact current consent, destination, instance digest and quarantine gates | M7b.2/4 | `pnpm --filter './apps/hub' test -- tools/runner tools/consent tools/policy` |
| Sensitive texts trigger no lookup; skip reasons do not block drafting | M7b.4/9/10 | `pnpm --filter './apps/hub' test -- tools/policy`; SPA tools and native context-lookup suites above; SMS depends on M6b/S12. |
| Parallel lookups before native AI drafting; never at a scheduled claim; provider request contracts unchanged | M7b.2/10, with M2/M7 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` |
| Ten-second readiness, five-second calls, fifteen-second calendar calls, cancellation and delayed-stop handling | M7b.2/5 | `pnpm --filter './apps/hub' test -- tools/runner`; `pnpm --filter './apps/hub' test:heavy -- tools/egress` |
| Sixty calls/hour/instance, hits excluded; four broker requests per lookup | M7b.3/5 | `pnpm --filter './apps/hub' test -- tools/lifecycle`; `pnpm --filter './apps/hub' test:heavy -- tools/egress` |
| Ten-minute memory cache; Slack-derived entries live only for their job; immediate lifecycle invalidation | M7b.3 | `pnpm --filter './apps/hub' test -- tools/lifecycle` |
| Hygiene precedes 4,096-byte/context and 8,192-byte/draft caps; provenance is included | M7b.3/8 | `pnpm --filter './apps/hub' test -- tools/lifecycle tools/contexts` |
| Calendar conditional GET, no redirects, 32 MiB and calendar content type | M7b.5/6/10 | `pnpm --filter './apps/hub' test:heavy -- tools/egress security/context-lookups`; pure feed bytes do not prove native fetch behavior. |
| Calendar retained components, overlap instances, feed/IANA/floating zones and missing-Temporal refusal | M7b.6 | `pnpm --filter @draftyak/tool-calendar-ics test`; `pnpm --filter @draftyak/tool-calendar-ics test:heavy` |
| Busy-only output; transparent/cancelled dropped, tentative retained | M7b.6/13 | `pnpm --filter @draftyak/tool-calendar-ics test`; `pnpm --filter @draftyak/calendar-goldens test` |
| At least thirty-minute slots, working hours, one-hour lead, twelve-slot cap and zone/offset labels | M7b.7/13 | `pnpm --filter @draftyak/lookup-core test -- test/calendar.test.ts`; `pnpm --filter @draftyak/calendar-goldens test` |
| Provider feed guidance, full-detail public-link warning and admin-only reset after `AUTH_REVOKED` | M7b.5/9 | `pnpm --filter './apps/hub' test:heavy -- tools/egress`; `pnpm --filter './apps/web' test:heavy -- tools` |
| Chip kind, host, fields, all states, unticking, draft confirmation and context lifetime | M7b.9 | `pnpm --filter './apps/web' test:heavy -- tools` |
| Native consent dialog fields/classes, host/posture, AI destinations, retention and PIN | M7b.4/9 | `pnpm --filter './apps/hub' test -- tools/consent`; `pnpm --filter './apps/app' test:heavy -- tools/admin` |
| Section 13 planner property: content and nested unverified fields cannot change kinds, instances or JCS arguments | M7b.1/11 | `pnpm --filter './apps/hub' test -- tools/metadata tools/planner` must execute all 500 trials against the actual metadata builder. |
| Section 13 planner refusals: failed `participant.verifiedSender` proof, Reply-To-only and SMS contacts; automatic plans contain only `hub.state` arguments | M7b.1/4/11 | Same native planner command, with nonempty automatic positive controls. Decision D23 requires independently verified outbound To/Cc owner-recipient controls to bind even when inbound sender proof fails. |
| Obedient model cannot add runs, contacts or provider tools; unknown refs drop and inserted tool data is flagged | M7b.8/10 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups`, for every native provider. |
| Hostile descriptions/schemas and write, non-GET or WebSocket egress refuse installation | M7b.5/10, with M1 manifest validation and M2 installer | `pnpm --filter './apps/hub' test:heavy -- tools/egress security/context-lookups` |
| Instruction results are framed and flagged without changing recipients | M7b.8/10 | `pnpm --filter './apps/hub' test -- tools/contexts`; native hostile-tool suite above. |
| Oversize text truncates/drops; over-ceiling calendar fails without truncation; off-schema, input-required, links and extra capabilities refuse | M7b.2/3/8/10 | `pnpm --filter './apps/hub' test -- tools/runner tools/lifecycle tools/contexts`; native hostile-tool suite above. |
| Three benign lookups followed by changed list quarantine before the fourth and alert devices | M7b.2/9/10 | `pnpm --filter './apps/hub' test -- tools/runner`; `pnpm --filter './apps/web' test:heavy -- tools` |
| Unlisted host, altered secret reference and outside-lookup requests deny and audit | M7b.5/10 | `pnpm --filter './apps/hub' test:heavy -- tools/egress security/context-lookups` |
| Slow tool times out while drafting continues | M7b.2/9/10 | `pnpm --filter './apps/hub' test:heavy -- security/context-lookups` |
| Full channel × class/posture × consent × argument × trigger × hourly-budget matrix | M7b.4/10 | `pnpm --filter './apps/hub' test -- tools/policy`; `pnpm --filter './apps/hub' test:heavy -- security/context-lookups`; SMS rows require FakeSmsHost and S12 go. |
| ICS and CRM recorder destinations match privacy disclosures and Security Center | M7b.5/9/10/14 | Native recorder and SPA tools suites above; `pnpm verify:m7b` compares recorded destinations with disclosures. |
| Calendar corpus: recurrence, three DST zones, date/status forms, malformed/oversize/redirect/content-type errors and detail canaries | M7b.6/13/10 | Calendar component and golden commands above, then native context-lookup suite for fetch and prompt/log canaries. |
| Secret URL stays in credential/broker boundary and requires admin entry; results never persist except owner-kept draft text | M7b.4/5/9/12 | `pnpm --filter './apps/hub' test -- tools/consent tools/evidence`; `pnpm --filter './apps/app' test:heavy -- tools/admin`; native recorder suite and database/WAL/FTS/backup/log canary scans. The SPA cannot set a `url-secret`. |
| Threat: injected mail steers lookups or exfiltrates through arguments | M7b.1/10/11 | Native planner property and obedient-model commands above (section 9.2 row). |
| Threat: tool poisoning or rug pull | M7b.2/5/10 | Native runner and hostile-tool commands above (section 9.2 row). |
| Threat: hostile or compromised tool results | M7b.2/3/8/10 | Native runner, context and hostile-tool commands above (section 9.2 row). |
| Threat: tool plugin exfiltrates or beacons | M7b.5/10 | Native egress command above (section 9.2 row). |
| Threat: upstream receives or trains on inbox data | M7b.4/10/14 | Native policy and recorder commands above; legal readings remain open (section 9.2 row). |
| Threat: calendar address theft or oversharing | M7b.5/6/9/10/12 | Native egress/evidence, calendar and SPA tools commands above (section 9.2 row). |
| Section 13 injection corpus: instructions, fake delimiters, names/headers and exfiltration probes targeting lookup arguments or contexts | M7b.1/8/10/11, with M3 hygiene and M7 provider owners | `pnpm --filter './apps/hub' test -- tools/contexts tools/metadata tools/planner`; `pnpm --filter './apps/hub' test:heavy -- security/context-lookups`, for every provider. The global launch corpus minimum of sixty cases remains an M3/M11 integration gate. |
| Privacy, Slack job scope, retention and all four Google legal readings | M7b.14 | `node tools/verify/verify.ts --profile docs`; `pnpm guard`; `pnpm verify:m7b`; legal approval is an owner gate. |

### Cross-stream contracts and workflow requirements

| Plan clause | Backlog coverage | Acceptance command or explicit gap |
|---|---|---|
| `tool-hello` reference/template and `toolContract()` under production flags | M1 SDK/testkit/template ownership; M7b.6/10 consumes the merged contract | Gap until the M1 tooling and M2 process runtime are merged; M7b.10 must expose the process-mode contract target in `pnpm verify:m7b`. No substitute in-memory-only pass. |
| Python tool contract and pre-spawn integration | M2c/S11 owns Python runtime; M7b.2/5/10 consumes it | Conditional gap on the owner's S11 decision and merged M2c; the process-mode contract and native lookup suites must then pass. |
| Shared recorder of every attempted outbound connection | M2.17b owns `tools/egress-recorder/**`; M7b.5/10 consumes its single result format | `pnpm --filter './apps/hub' test:heavy -- tools/egress security/context-lookups`; M2c's no-CDN and M11.7's privacy checks read the same format. Recorder implementation remains an explicit M2 dependency, moving to M2c if S11 starts it first. |
| `ci.yml`: ordinary units/types/build and the always-run required aggregate | M7b.1–14 acceptance commands; workflow wiring belongs to M0/M11 | `pnpm verify`; CI must select the affected packages and retain the aggregate. This backlog does not own root workflow edits. |
| `security.yml`: planner properties and all context-lookup suites | M7b.1–5/8/10–12 | `pnpm verify:m7b`; workflow owner must wire the actual security targets on ready PRs/main. Planned until those targets and workflow exist. |
| `conformance.yml`: production-mode `toolContract()` for both first-party tools | M7b.6/10, with M1/M2 testkit/runtime | Process-mode contract target above; workflow wiring remains with the CI owner. |
| `e2e.yml`: shared SPA context/wizard and trusted consent behavior with real hub fakes | M7b.9/10 | `pnpm --filter './apps/web' test:heavy -- tools`; `pnpm --filter './apps/app' test:heavy -- tools/admin`; M3/M4 and CI owners provide the platform wiring. |
| `nightly.yml`: increased property runs, fuzzing and soak | M7b.6/10, with CI owner | `pnpm --filter @draftyak/tool-calendar-ics test:heavy`; `pnpm verify:m7b`; larger nightly run configuration and soak target remain a CI integration gap. |
| Release rejects test profiles and preserves external `ical.js` bytes/licence | M7b.6, with M10 release tooling | Calendar build commands above; byte-identical external-library and test-profile checks remain the M10 `release-guard` gate. |
| MCP-only refs/flags and no lookup trigger | M7b.10 acceptance portion in M8 | Native context-lookup suite lands in M8 by agreement with its owner; gap until the actual M8 surface and checks exist. |
| SMS policy/sensitive-text rows | M7b.4/10 with M6b | Native policy/context-lookup suites wait for FakeSmsHost and S12 go; a no-go removes only the explicitly affected optional rows. |
| Tool-consent restore | M7b.4/12 with M10 and storage owner | Native consent/evidence suites plus M10 restore acceptance; backup/restore integration is not supplied by the lookup component. |
| Feed-canary runbook and authorized provider fixtures | M7b.10 | Fake dry-run through the native context-lookup suite; owner-only `pnpm --filter './apps/hub' test:live -- tools/calendar-feeds` following `docs/runbooks/context-lookups.md`. Authorization and provider sessions remain explicit owner gates. |
| Shared privacy/compliance files | M7b.14 sections land in M11 | `node tools/verify/verify.ts --profile docs`; M11 launch privacy check consumes M2.17b's recorder. Gap until the documentation owner accepts these sections and legal decisions are recorded. |
| Milestone profile and gate record | M7b.10 profile; gate record written after gate review | `pnpm verify:m7b`; `docs/roadmap/m7b-gate.md` is excluded from M7b.10's owned paths. |

## Milestone gate

Before an item submission, run the current-base frozen install, checks for the
touched components, its acceptance commands and `pnpm guard`, including
commit-message checks. CI supplies full verification under decision D25;
changes to CI selection or verification tools also require their affected local
checks. Final M7b acceptance additionally requires
`pnpm verify:m7b`, applicable native security/SPA/corpus checks above and the
owner's sign-off. Component tests do not establish integration/policy gates.
Protected ownership installation, native adapters, host transport and owner/legal
gates remain open until actually completed or explicitly resolved.
