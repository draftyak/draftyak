# M7 backlog: Sign in with ChatGPT (clean-room)

> **Status:** draft of 2026-10-19, written before the M0 gate. Backlog only: each item starts when its **Starts** line holds.
> **Source of truth:** the approved implementation plan, kept outside the repo; § numbers refer to it. Where this backlog and the plan differ, the plan wins, except for the owner decisions and verified facts under **Changed since the plan** and in ADR 0009.
> **Owner of this file:** the integration owner. M7's main backlog (`docs/roadmap/m7.md`) covers the API-key providers, routing and auto-draft; its Sign in with ChatGPT (SIWC) rows will point here. Apart from this backlog's items and M1.20 and M1.29, no item writes SIWC code, fakes or stubs.
> **Done when** the SIWC clauses of §12's M7 row pass their acceptance below:
> - registration and the per-hub host ID;
> - the port 1455 check;
> - the documented transfer;
> - serialized refresh;
> - streaming through host chunks;
> - the full error set;
> - `prompt=consent`;
> - revocation on disconnect.
>
> So do M7's shared checks for SIWC: the policy matrix (no non-allowlisted field leaves, no silent billing switch), the corpus (at least 60 cases), and auto-draft never firing for SIWC.

## Clean-room rules
- The implementation follows OpenAI's public documentation, the SIWC Terms and ADR 0009 only.
- It never uses or reads:
  - the noncommercial DevKit or any `@siwc` package (vendor-guard bans them);
  - Codex's client, its source or its per-user auth file;
  - ChatGPT's private backend API (guardrail 4).
- Code from spike S7 (`spikes/s07-siwc/`) may be ported into product files but never imported (m0.md: spikes are never imported).
  - ADR 0009's kept test is `spikes/s07-siwc/test/rehearsal.test.ts` (the spike's `notes/session.md`; destination M7, `plugins/ai-responses-api/`). It guards the session procedure, the evidence's shape and the transfer, forget and revocation paths. M7.S4 replaces the transfer and forget paths with `apps/hub/test/ai/siwc/transfer.test.ts` and `apps/app/src-tauri/tests/siwc_handoff.rs`, and M7.S3 replaces the revocation paths with `apps/hub/test/ai/siwc/credential.test.ts`. The session procedure and the evidence serve only the live session, so they go with the spike. ADR 0009's follow-up records those three files as the kept test's destination.
  - Every item that absorbs a kept test merges before M7.S4 or M7.S9. Whichever of those two merges last deletes `spikes/s07-siwc/` in its PR, with the spike's `pnpm-lock.yaml` importer; if M7.S4 is dropped (a "no" to OpenAI's question 1a), M7.S9 deletes it. Only `notes/sources.md` stays: it is the clean-room record, and vendor-guard treats it as data.
  - A "no" to question 1a that arrives after M7.S4 or M7.S9 has merged is recorded in Open items by a PR on `m7`. That PR deletes M7.S4's code and tests with its lines in H10, H11 and H27, and the `transfer` flow in M7.S2b's subject builder. If the spike is still there, it also deletes `spikes/s07-siwc/` (except `notes/sources.md`) with its importer. M1.29 removes its transfer parts in a contract PR (`docs/roadmap/m1.md`).
- SIWC test tokens live only in the local `.env.live`, never in CI secrets. CI runs on M7.S8's and M7.S8b's fakes.
- The SIWC Terms allow automated or background requests only with express consent, and another user's activity may not trigger them.
  - Every SIWC request comes from the owner's own on-demand action: a draft the owner asks for, the Test control (`ai_probe`) or the model picker (`ai_models_list`). The hub never calls a SIWC instance, or refreshes its tokens, at start-up, after a restart, on a timer or on a configuration change (H22). M7.S6 tests it.
  - Auto-draft stays off for SIWC (§5) until OpenAI confirms background use, and agent-token or MCP requests never start one.

## Items

| # | Item | Size | Depends on | Lands on |
|---|---|---|---|---|
| M7.S1 | Registration and the per-hub host ID | M | M7.S8, M1.20, M2.11, M2.17 | m7 |
| M7.S2 | Sign-in as an admin op from the hub CLI: PKCE, the transient 1455 listener, `prompt=consent`, the scope check | M | M7.S1, M2.3, M2.4, M2.11, M2.17, M2.23 | m7 |
| M7.S2b | Sign-in from the desktop approval window | M | M7.S2, M4.7, M4.12, M4.13, M4.14, M1.29 | m7 |
| M7.S3 | SIWC credentials: storage, serialized refresh, revocation on disconnect | M | M7.S2, M2.3, M2.4, M2.11, M2.12, M2.17, M2.23, M2.26 | m7 |
| M7.S3b | Disconnect from the desktop approval window | S | M7.S3, M7.S2b, M4.13, M1.29 | m7 |
| M7.S3c | Revocation before an instance or the plugin is removed | S | M7.S3, M7.3 | m7 |
| M7.S4 | The documented transfer for a headless hub | M | M7.S3, M7.S2b, M4.7, M4.13, M4.14, M1.29 | m7 |
| M7.S5 | The broker's SIWC verifier and the shared hostile-request table | S | M2.19, M1.20 | m2 |
| M7.S5b | The siwc drafting mode: request builder, streaming, broker refusals | L | M7.S3, M7.S5, M7.S8b, M7.4, M7.9, M2.26, M1.12, M1.13, M1.25's record | m7 |
| M7.S5c | The `cloud-consumer-plan` destination class | S | M7.S5b, M7.5, M7.7 | m7 |
| M7.S6 | The full error set and no silent billing switch | M | M7.S5b, M7.S5c, M7.S8b, M7.4, M7.5, M7.11, M3.5, M2.26 | m7 |
| M7.S7 | SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage | M | M7.S2b, M7.S3b, M7.S6, M7.3, M7.5, M7.7, M4.2, M4.7, M4.13, M4.14, M3.7 | m7 |
| M7.S8 | The siwc-auth fake | M | M1.20 | m7 |
| M7.S8b | The responses-siwc fake and its scripted models | M | M7.S5, M7.S8, M7.11 | m7 |
| M7.S9 | SIWC rows of M7's corpus and policy matrix | S | M7.S5c, M7.S6, M7.S8b, M7.4, M7.5, M7.6, M7.7, M7.11, M2.17b | m7 |
| M7.S9b | The SIWC row of M7b's obedient-model suite | S | M7.S9, M7b.10 | m7b |
| M7.S9c | The SIWC cross-stream cells: SMS, agent tokens, MCP | S | M7.S9, M8.2; on an S12 go, M1.23 and M6b's FakeSmsHost | whichever of m7, m8 and m6b lands last |

Every item also needs ADR 0009 merged into `m0`. If ADR 0009 records Not run, the items wait for the owner's M0-gate decision, and M7 ships the API-key modes alone.

The L2 calls that M7.S2b, M7.S3b and M7.S4 use are M1.29 in `docs/roadmap/m1.md`: the three routes and the capability each needs, byte caps, closed error codes, the transferred credential's form (M0.27's `transferText`), the authorization URL's fixed issuer origin and path, and the review subjects of the connect and disconnect kinds, one line each in M1.26's review subject union. Plan §12 lets only contract PRs into `m1` define these shapes, so M1.29 lands on `m1` and names M1.26, M1.20 and ADR 0009, and those three items start once it is on `m7`. Its files carry `siwc` in their names, and it stays in this backlog's clean-room stream, as M1.20 does. M1.29 fixes the subjects' shapes; M7.S2b and M7.S3b build them when M4.13 creates the pending record (H25), and M7.S2b renders them in the approval window (H26).

A dependency from another branch counts only once its work has reached the branch the dependent item lands on; ADR 0009 counts once it merges into `m0`. So an item on `m7` that needs M1, M2 or M4 work, or M7.S5, starts once that work is on `m7`. M4's work gets there after M4 merges into `main` and `m7` is brought up to date with it (§12: device UI lands after M4). pr-meta takes an item branch `mN-<nn>-<slug>` only into `mN`. So M7.S5 lands from an `m2-<nn>-<slug>` branch, M7.S9b from an `m7b-<nn>-<slug>` branch, and M7.S9c from an item branch of the stream it lands on.

Paths and commands below are the intended ones; packages that don't exist yet take these names when their milestones create them. No command passes with nothing run:
- every pnpm command passes `--fail-if-no-match`, so a filter that matches no package fails;
- every Vitest command names exactly one test file, and fails if that file is missing. Vitest treats each name as a filter and passes when it finds some of them, so a command naming several files would pass with one missing; the unit tier's `passWithNoTests: false` fails a run that finds none;
- heavy runs add `--no-passWithNoTests` and set `DRAFTYAK_STRICT_SKIPS=1`, so a heavy run fails if it finds no file or skips a test;
- `node --test` fails on a missing file;
- `cargo test` names its integration-test targets with `--test`, and a missing target fails.

### Hooks in other items
These are the lines and calls this backlog needs in other items' files. Each is a request until its owner agrees, except H2 and H3, which M1.20 already lists. An item that adds a line to a hook owns only that line. M1.29's lines in M1.26's review subject union follow M1.26's Shared files rule, so they aren't listed here.

| # | Owner | File and export | Shape | Used by |
|---|---|---|---|---|
| H1 | M2.3 | `apps/hub/src/authz/admin-ops.ts`, `registerAdminOp` | `registerAdminOp(kind, handler)`, one line per kind. Both entry points, M2.11's CLI and M4.13's approval window, reach `handler(op, actor)` only after the authority and PIN checks pass. The SIWC kinds need the `admin` capability, which a read/draft desktop (a CLI-only confirmation, §7) lacks | M7.S2, M7.S2b, M7.S3, M7.S3b |
| H2 | M1.20 | `packages/protocol/src/statements/admin.ts`, `ADMIN_GROUPS` | the connect and disconnect kinds for an AI-instance credential, unless an existing kind fits | M7.S2, M7.S2b, M7.S3, M7.S3b, M7.S4 |
| H3 | M1.20 | `packages/protocol/src/manifest/ai-http.ts`, `AI_HTTP_PROFILES` | one ChatGPT-plan profile id | M7.S5, M7.S5b, M7.S5c |
| H4 | M2.11 | the kernel's bundled configuration under `apps/hub/src/kernel/`, its namespace-to-folder map, which M2.1's store copies at construction | one line: the `siwc` namespace → `apps/hub/src/store/migrations/siwc/` | M7.S1 |
| H5 | M2.26 (the registration) and M2.17 (the broker's refusal) | `apps/hub/src/credentials/registry.ts`, `registerCredentialKind`, which M2.17's `apps/hub/src/plugins/broker/credentials.ts` consumes | `registerCredentialKind(kind, {token(), refresh(stale)})`, one line per kind, run under M2.26's per-credential mutex, with the tokens in M2.26's common vault: no second vault or mutex. M2.17's broker takes each token through it and owns the refusal: a session code that `token()` throws becomes `{error: {type: "broker_refused", code}}` with 401, 403 or 503 by its recovery, and `x-should-retry: false`, and nothing goes upstream | M7.S3, M7.S5b, M7.S6 |
| H6 | M2.17 | `apps/hub/src/plugins/broker/ports.ts`, `BLOCKED_LOOPBACK_PORTS` | 1455 beside 47613–47615 and 9229. M2.17 adds it as a plan change; no SIWC item adds a line | M7.S2 |
| H7 | M2.19 | `apps/hub/src/plugins/broker/ai-verifiers.ts`, `AI_VERIFIERS` | profile id → `verify(request, pin, input)`, one line per profile. `pin` is the hub's model and effort, and `input` is the hub's DraftRequest. It returns `{ok: true, request}`, rebuilt from those values, or `{ok: false, problems}`, which the broker audits as given. For every AI profile, the broker reads only a string body that parses to a JSON object, gives `verify` the parsed value, sends exactly the request `verify` returns, and allows one POST to the profile's route per attempt (M0.26's broker contract). A profile may also allow bodiless `GET`s on routes its verifier lists, which `verify` gets with no `input`; the ChatGPT-plan profile lists `GET /v1/models`. A profile's line may mark it on demand, as the ChatGPT-plan line does. For such a profile the broker admits a request only while a hub call to that instance is running: one POST per draft attempt, and at most one bodiless `GET` per `ai_models_list` or `ai_probe` call. Anything else, such as a request outside any call, a second `GET` in one call or one during `ai_describe`, is refused and audited before H5's `token()` runs, so it starts no refresh either. H22 then limits when the hub makes those calls | M7.S5, M7.S6 |
| H8 | M2.12 | `apps/hub/src/backup/exclusions.ts`, `EXCLUDED_CREDENTIAL_KINDS` | the credential kinds a backup skips and a restore drops; one line per kind | M7.S3 |
| H9 | M4.13 | `apps/hub/src/identity/admin-pending/index.ts`, its call into H1's handler | when the approval window's `admin.v1` for a SIWC kind is accepted, the handler gets the op, with its ids and the device that asked for it through `admin_open`, and `{device, approvedAt}`: the approving device and the approval time. The pending record keeps M1.26's 120 s review cap and is consumed as for any admin op. M7.S2b and M7.S4 keep their post-approval windows in SIWC's own state, so the record never stays open for them | M7.S2b, M7.S3b, M7.S4 |
| H10 | M4.7 | `apps/hub/src/identity/device-routes/snapshot.ts`, `DEVICE_ROUTES` | M1.29's three routes, one line each, for a confirmed `admin` device: `GET /device/v1/ai/siwc/<id>/authorization`, which answers the authorization URL (M7.S2b), and `GET` and `POST /device/v1/ai/siwc/<id>/transfer`, which answer the transfer start and take the credential (M7.S4). Each handler also checks that the caller approved op `<id>`. A fourth line mounts M7.S7's state read (H23's route) on L2 for a confirmed `read` device, as `hub_request` carries it (H28) | M7.S2b, M7.S4, M7.S7 |
| H11 | M4.2 (module and command registration) and M4.13 (command permissions) | the module and command lists in `apps/app/src-tauri/src/lib.rs`, and the `permissions` list in `apps/app/src-tauri/capabilities/approval.json` | the `siwc_*` modules and commands; the commands are granted in the approval window's capability only | M7.S2b, M7.S4, M7.S7 |
| H12 | M4.14 | `apps/app/src-tauri/src/external.rs`, `open_external` | `open_external(url)`, called from Rust modules, shows the real host, then opens the URL in the system browser. From JS it takes only a link id that a Rust module registered with its fixed URL (`register_link(id, url)`, one line per link), never a URL | M7.S2b, M7.S4, M7.S7 |
| H13 | M4.14 | the Security Center's egress destination list, in `apps/web/src/desktop/` | each AI instance's hosts from the hub's data, including the hosts of the hub's own calls for it that H29 registers: for a SIWC instance, the auth host (sign-in, refresh, revoke) and the API host (drafting) | M7.S7 |
| H14 | M7.3 (the install and disconnect hooks it accepts) | `apps/hub/src/ai/instances/lifecycle.ts`, `registerBeforeRemove` | `registerBeforeRemove(kind, handler)`, one line per credential kind. Deleting an AI instance, or uninstalling its plugin, first runs the handler for each of its credentials and removes nothing until it returns. The handler may return a notice code (`revoke-unconfirmed`), which the removal's result shows the owner | M7.S3c |
| H15 | M7.9 | `plugins/ai-responses-api/src/modes.ts`, `MODES` | mode name → that mode's four ai-provider-v1 handlers; `siwc` sits beside `"api-key"` | M7.S5b |
| H16 | M7.5 | `apps/hub/src/ai/routing.ts`, `PROFILE_DESTINATIONS` | AI profile id → destination class; the ChatGPT-plan id maps to `cloud-consumer-plan` | M7.S5c |
| H17 | M7.5 and M7.7 | in plan §8's one SPA, `apps/web`: the provider slot of M7.5's routing screen (`providerSlots`) and the billing-line slot of M7.7's drafting screen (`billingSlots`) | one entry per mode: `{mode, component}`. The slot renders `component` with the AI instance's id, and the component reads that instance's state itself through H23 | M7.S7 |
| H18 | M7.6 | `apps/hub/test/ai-providers/rows.ts`, `PROVIDER_ROWS` | one line per row file, read by the corpus, policy-matrix and fields suites. The policy matrix's consent states include Slack's provider-named opt-in (guardrail 6), so a row can expect run or skip for each | M7.S9, M7.S9c |
| H19 | M7b.10 | `apps/hub/test/security/context-lookups.providers.ts`, `OBEDIENT_PROVIDERS` | one line per provider mode | M7.S9b |
| H20 | M11 | `PRIVACY.md`, its list of outbound destinations, and M11's egress-recorder check of it | M11 lists the auth host (sign-in, refresh, revoke) and the API host (drafting). M11.7's egress-recorder check takes M7.S9's scenario, which runs the SIWC flows on the fakes under M2.17b's recorder, and fails if a host they reach is missing from the list | M7.S1, M7.S9 |
| H21 | M11 | `docs/runbook.md`, step 8 | M11 adds a pointer to `docs/runbooks/m7-siwc.md` | M7.S7 |
| H22 | M7.4 | `apps/hub/src/ai/providers/on-demand.ts`, `ON_DEMAND_PROFILES` | a set of AI profile ids, one line per profile, whose instances the hub calls only from an owner action: a draft the owner asks for, the Test control or the model picker. It never calls them at start-up, after a restart, on a timer, on a configuration or DNS change, or from auto-draft | M7.S5b, M7.S6 |
| H23 | M3.7 | the `/api/v1` route registration in `apps/hub` | one line: M7.S7's read-only route `GET /api/v1/ai/instances/{id}/siwc`, for an owner cookie session on L1 and, over L2, the desktop's `hub_request` (H10, H28); an agent token is refused. It is a hub API addition, so the line lands in a small contract PR the owner signs off (§12 Contracts), and M3.7's generated OpenAPI carries its shape | M7.S7 |
| H24 | M7.11 | `packages/fakes/src/responses-api.ts`, its request handler | the fake's request handler and recorder are exported, so a wrapper can pass a request to it unchanged. It needs no SIWC option | M7.S8b, M7.S6 |
| H25 | M4.13 | `apps/hub/src/identity/admin-pending/index.ts`, `registerAdminSubject` | `registerAdminSubject(kind, subject)`, one line per kind. When M4.13 creates the pending record for `admin_open(kind, ids)` and the kind has a builder, it calls `subject(ids, {device})` with the device that asked. If the call throws, it refuses the operation with the code the builder names (`NOT_FOUND` for an unknown or non-SIWC instance, `FORBIDDEN` for a device the kind can't serve) and keeps no record. Otherwise the review's `subject` is the result and its `digest` the SHA-256 of its JCS (M1.26) | M7.S2b, M7.S3b, M7.S4 |
| H26 | M4.12 | the approval window's native subject rendering, in its `render*` module in `apps/app/src-tauri/src/` | one line per admin kind: kind → the function that renders that kind's verified subject | M7.S2b, M7.S3b |
| H27 | M4.13 | the approval window's native `confirm*` module in `apps/app/src-tauri/src/`, `register_continuation` | `register_continuation(kind, handler)`, one line per handler. Once the hub answers an `admin.v1` with `Accepted`, the window calls each handler registered for its kind with the op id and the subject it verified and showed, from Rust to Rust; a handler ignores a subject it doesn't handle. Nothing reaches a handler from JS, and none runs without an accepted approval | M7.S2b, M7.S4 |
| H28 | M4.14 | `hub_request`'s operation allowlist, in its native `hub_api*` module in `apps/app/src-tauri/src/` (M4.13: ordinary `hub_request` stays allowlisted) | one entry: M7.S7's read-only state read (H23), so the desktop's SPA reaches it over L2 | M7.S7 |
| H29 | M7.3 | `apps/hub/src/ai/instances/lifecycle.ts`, `registerInstanceHosts` | `registerInstanceHosts(kind, hostsFor)`, one line per credential kind. The hub's per-instance destination data, which the Security Center's list reads (H13), adds the hosts that `hostsFor(instance)` gives for each of the instance's credentials: the hosts of the hub's own calls for it | M7.S7 |
| H30 | M7.5 | its routing screen in `apps/web`, `openAddProvider` | `openAddProvider({plugin, mode})` opens M7.5's add-provider flow for that plugin and mode. It creates nothing until the owner finishes the flow, whose key entry is its own admin op (§4 Credential flow 5) | M7.S7 |
| H31 | M7.9 | the plugin's manifest, `plugins/ai-responses-api/draftyak.plugin.json` | the siwc mode's entries: the `oauth2-dynamic-agent` auth and the ChatGPT-plan profile, in the form M1.25's record of ADR 0009's follow-up settles (M1.20). The hook waits for that record | M7.S5b |
| H32 | M7.5, or M7.10 or M7.7 if its `apps/web` component tests land first | `apps/web/vitest.config.ts`, the web package's unit tier, in M3.9's package configuration | the unit tier also collects `**/*.test.tsx`, so a component test that renders JSX runs in it, as these items' own component tests need; the heavy, live and device tiers keep their names out of it. The item agrees the change with M3.9 and makes it; no SIWC item adds a line | M7.S7 |

### M7.S1 Registration and the per-hub host ID
- **Inputs.** §5's SIWC row (`dynamic_agent_client` → issued client; a per-hub `ext_agent_host_id`; `agent_name_hint: "DraftYak"`); §4 Credential flow 2; §9.2 (SSRF, OAuth mix-up); guardrail 8; ADR 0009's registration result and host-ID format; M1.20's `oauth2-dynamic-agent` descriptor; M2.17's guarded fetch; the kernel's namespace map (H4); PRIVACY.md's destination list (H20).
- **Outputs.**
  - **Calls to OpenAI.** Every hub-side call to the OpenAI auth host goes through M2.17's guarded fetch: https, the issuer's origin only, no redirects. These calls are discovery, JWKS, the code exchange, refresh and revoke, and later items follow this rule.
  - The auth and API hosts appear in PRIVACY.md (H20) and, through M7.S7's line in H29, in the Security Center's destination list (H13). M11's egress-recorder check covers the SIWC flows with M7.S9's scenario.
  - The hub reads the auth endpoints from the issuer's discovery document. Every endpoint, the revocation endpoint included, must share the issuer's origin.
  - Registration happens in the browser: the first authorization request names `dynamic_agent_client`, `agent_name_hint: "DraftYak"` and the host ID, and the callback returns the issued client. The hub makes no registration call of its own. It keeps the issued client and reuses it.
  - If the issuer refuses the saved client (`invalid_client`, spike S7's `INVALID_CLIENT`), as after the owner removes DraftYak in ChatGPT's settings, the hub drops that client and keeps the host ID. The refusal comes on the hub's own code exchange or refresh or, in a transfer, on the desktop's code exchange, after which the desktop registers again inside the window (M7.S4). Tokens the hub still holds stay unused until disconnect tries to revoke them (M7.S3). The next sign-in registers again with `dynamic_agent_client` and `agent_name_hint: "DraftYak"`, and the hub takes the client it issues only for the saved account (the same `sub`), with every check M7.S2 applies to a sign-in.
  - One `ext_agent_host_id` per hub, in the format ADR 0009 records, is created once, kept, and reused for every registration, sign-in and transfer.
  - The `siwc` namespace (`apps/hub/src/store/migrations/siwc/`, mapped by H4) holds the per-hub host ID and, per instance, the issued client, the subject and account address, the plan-usage and sign-in state, and the notices M7.S3 and M7.S4 record. The tokens and the ID-token hint live in M2.26's common vault (M7.S3).
  - A grant without `chatgpt.tokens.use.direct` (a declined plan) keeps the sign-in with plan usage off, as spike S7 does. With a refresh token, the tokens are stored and never used for a drafting request (M7.S2's scope check). Without one, as when the decline also withholds `offline_access`, only the registration and the ID-token hint are kept and no token is stored. A transfer keeps the same (M7.S4). This waits for the owner's answer on what a decline keeps (Open items).
- **Owns.** `apps/hub/src/ai/siwc/{discovery,registration}.ts`, the `siwc` namespace's migration folder `apps/hub/src/store/migrations/siwc/`, one line in H4, and `apps/hub/test/ai/siwc/{discovery,registration}.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/discovery.test.ts` and `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/registration.test.ts`, on the siwc-auth fake:
  - **discovery:** another issuer, an endpoint on another origin or on `http:`, and a missing revocation endpoint are refused; a redirect from the discovery URL is not followed; every call goes through M2.17's guarded fetch;
  - **registration:** the first authorization request carries the hub's host ID and `agent_name_hint: "DraftYak"`, and the ID survives a hub restart;
  - a second hub (another `--profile`) gets a different ID;
  - after a decline that returns no refresh token, the `siwc` namespace holds the issued client and the host ID, and no token is stored; after a grant without the plan scope that returns one, the tokens are stored with plan usage off;
  - a saved client the issuer refused is never reused: the next authorization request names `dynamic_agent_client` and `agent_name_hint: "DraftYak"` with the same host ID.
- **Starts** after ADR 0009 merges into `m0`, and M1.20, M2.11, M2.17 and M7.S8 are on `m7`.

### M7.S2 Sign-in as an admin op from the hub CLI: PKCE, the transient 1455 listener, `prompt=consent`, the scope check
- **Inputs.**
  - §4 Credential flow 2 and 3; §1's transient listener row; §9.2 (SSRF, OAuth mix-up, DNS rebinding, CSRF, token in URL); §9.3 admin ops; §7 (a CLI-only confirmation gives a read/draft device).
  - ADR 0009.
  - The connect kind from M1.20 (H2) and the admin-op service (H1): M2.3's authority checks, M2.4's PIN and statement checks, M2.11's control CLI and M2.23's FakeDevice.
  - M7.S1's rule for calls to OpenAI, and its `siwc` namespace.
  - The owner's M0-gate answers on `prompt=consent` and on what a declined plan keeps.
- **Outputs.**
  - **The sign-in is an admin op.** This item registers the connect kind's handler (one line in H1). It starts only with the PIN: here from the hub CLI, and in M7.S2b from a confirmed desktop approver's approval window. It is inert in the loopback browser and on mobile.
  - The CLI prints the authorization URL, and the owner opens it in a browser on the hub machine.
  - **The transient listener on `127.0.0.1:1455`:**
    - It checks the port first, including a wildcard holder on Windows, and refuses with a clear error if anything holds it.
    - It opens for one sign-in flow only, and a second sign-in started while it is open is refused. It answers only `GET` on the OpenAI redirect path, with the expected Host and `state`.
    - It closes after success, failure, cancellation or a timeout of 300,000 ms, spike S7's default. The timeout never exceeds M1.29's 600,000 ms window, so an authorization answer's `remainingMs` stays inside its cap (M7.S2b).
    - It has its own route snapshot, with the callback route only.
  - **The ID token** from the code exchange is checked as spike S7 checks it: the signature against the issuer's JWKS, `iss`, `aud`, `exp`, the attempt's `nonce`, an `azp` equal to the issued client when `aud` has several values, and an `iat` that isn't in the future. `aud` must hold the issued client unless ADR 0009 records otherwise from M0.27b's `idToken.facts`, in which case the audience rule follows that record. A returning sign-in's `sub` must be the saved account's.
  - A code exchange refused with `invalid_client` ends the sign-in, and the hub drops that client (M7.S1). The next sign-in registers again, and the hub takes the client it issues only with the saved account's `sub`, if one is saved.
  - **`prompt=consent`** follows the owner's M0-gate answer.
    - The plan as written sends it on every sign-in until OpenAI confirms the deployment.
    - The proposed fix, which spike S7 already follows, sends it only when the owner turns plan usage on, including after a decline, with the saved client.
  - **The scope check:** after the code exchange, the granted scopes are checked (ported from spike S7's plan-usage check), and the plan-usage state goes to the `siwc` namespace.
    - Without `chatgpt.tokens.use.direct`, plan usage stays off and no SIWC drafting request goes out.
    - M7.S7 then offers two explicit owner actions: turn plan usage on, or "Use an OpenAI API key instead".
  - The flow hands its tokens to the credential store: M7.S3's, once it merges. Until then, this item's tests use an in-memory store.
- **Owns.** `apps/hub/src/ai/siwc/{signin,listener,scopes}.ts`, the listener's route snapshot, the CLI command `apps/cli/src/commands/siwc-sign-in.ts` with `apps/cli/test/commands/siwc-sign-in.test.ts`, one line in H1, `apps/hub/test/ai/siwc/{signin,listener}.test.ts`, and `apps/hub/test/ai/siwc/listener.heavy.test.ts` with its port lock, `apps/hub/test/support/siwc-port-lock.ts`.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin.test.ts` and `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/listener.test.ts`, covering:
    - **the admin op:** the CLI path without the PIN or with a wrong one is refused. Through the admin-op service, FakeDevice is refused as a mobile device, a browser session, an unconfirmed device, a revoked device, and a confirmed desktop with read and draft only; a confirmed desktop approver with the PIN is admitted. The plan-enable path, which reuses the saved client, is refused in the same cases. A second sign-in while the listener is open is refused, and the first goes on;
    - **the flow:** the URL the CLI prints is the issuer's authorization endpoint from discovery; two sign-ins carry the hub's host ID; `error=access_denied` exchanges nothing; ID tokens with a bad or missing signature, a wrong `iss`, `aud`, `exp` or `nonce`, an `azp` other than the issued client when `aud` has several values, or an `iat` in the future are refused, one case each; another `sub`, or another host ID's registration, is refused; `redirect_uri` is identical in the request and the exchange; a redirect from the JWKS URL, or from the token endpoint during the code exchange, is not followed; a code exchange refused with `invalid_client` ends the sign-in, and the next authorization request names `dynamic_agent_client` and `agent_name_hint: "DraftYak"` with the same host ID; the client that sign-in gets is taken for the saved account's `sub` and refused with another;
    - **`prompt=consent`:** the chosen rule, on an ordinary sign-in and on the plan-enable path, which reuses the saved client and host ID;
    - **the scope check:** with the scope missing, nothing goes to SIWC, and no API-key instance is created or used until the owner acts;
    - **the listener, on an OS-assigned port:** a wrong, missing or replayed `state`, another path, a `POST` or another Host is refused, and so is a second callback, or one after close; a port held on `127.0.0.1` or on `0.0.0.0` gives a clear refusal; the listener closes after success, failure and cancellation, and on the injected clock at 300,000 ms, not before.
  - `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-sign-in.test.ts` tests the CLI command itself: its arguments, its PIN prompt, the URL it prints and its exit codes. `draftyak` is the CLI package's name in M2.11.
  - With `DRAFTYAK_STRICT_SKIPS=1` set, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/ai/siwc/listener.heavy.test.ts` binds 1455 itself. It is spike S7's port test, moved in rather than imported.
    - Its port lock is the kit's machine-wide bench lock in port-only mode: the same lock file and the same OS lock, copied from `spikes/kit/lock.ts`, since product code can't import spikes. So this test, the spike's own 1455 tests and an owner's live session wait for each other.
    - If another program holds 1455, the test skips, and under strict skips that skip fails the run.
    - It covers 1455 held on `127.0.0.1` and on `0.0.0.0`, refused before any browser opens, and the route snapshot.
    - With the listener open, a plugin's `ctx.fetch` to `127.0.0.1:1455` is refused. This needs M2.17's 1455 block (H6), since M0.12's list lacks it.
- **Starts** after M7.S1, M2.3, M2.4, M2.11, M2.17 and M2.23 are on `m7`, and the owner's M0-gate answers.

### M7.S2b Sign-in from the desktop approval window
- **Inputs.** M7.S2's handler (H1, H2); M1.29's authorization route, error codes, fixed values and both review subjects; M4.13's admin pending operations and approval window, with its subject hook (H25), its call into the handler (H9) and its continuation hook (H27); M4.12's native subject rendering (H26); M4.7's route snapshot (H10); M4.14's system-browser opener (H12), which never opens a URL from JS; M4's command registration (H11); M1.27's `mode`; §7 Sidecar auto-pairing; §9.3 admin ops.
- **Outputs.**
  - **The connect subject.** `apps/hub/src/ai/siwc/connect-subject.ts` builds M1.29's connect subject when M4.13 creates the pending record (one line in H25), from the instance and the device that asked:
    - `instance` and `name` come from the AI instance, which must be a SIWC instance; any other id is refused with `NOT_FOUND`;
    - `account` is the saved registration's address, or null on a first sign-in;
    - `enablePlan` comes from the saved plan-usage state: it is true when a registration exists with plan usage off (turning plan usage on, below);
    - `flow` comes from the hub's mode (M1.27) and the device that asked. On a hub that runs as the desktop app's sidecar it is `hub`, and only the sidecar's own app may ask: the device that bootstrapped over loopback L2 (§7 Sidecar auto-pairing; M1.26's Bootstrap route), so the sign-in's browser shares the hub's machine. Any other approver of a sidecar hub is refused at once with `FORBIDDEN`, with no record, no transfer and no window to wait out, and M7.S7's slot tells it to sign in from the DraftYak app on the hub's computer. On a hub that runs as a service, the headless hub of §4 Credential flow 2, every confirmed desktop approver gets `flow: transfer` (M7.S4). Until M7.S4's transfer is on `m7`, or if it is dropped, such a device is refused with `FORBIDDEN` too, and M7.S7's slot gives it the CLI command.
  - **`flow: hub`.** The sidecar's own app, a confirmed desktop approver, starts the sign-in through `admin_open` and the approval window, with the PIN. Once the `admin.v1` is accepted, the hub runs M7.S2's handler, with its listener on the hub machine's `127.0.0.1:1455`, but only for the device that asked (H9): an approval from another device opens nothing, and the authorization route answers it `NOT_FOUND`.
  - The hub serves the authorization URL to the device that approved, over M1.29's authorization route (H10), while the flow is open; for a `flow: transfer` op the route answers `NOT_FOUND`. The approval window's continuation (one line in H27) hands the op id and the verified subject to the `siwc_signin` native module, which acts only on `flow: hub`. It reads the URL, checks it with M1.29's Rust codec and opens it through M4.14's opener (H12), which shows the real host first. No URL comes from JS, and nothing runs before the approval is accepted.
  - **The review.** `apps/app/src-tauri/src/siwc_review.rs` renders both kinds' subjects in the approval window (two lines in H26, M7.S3b's disconnect subject included), parsed with M1.29's Rust codec: the instance's name, the account or that it is a first sign-in, what `flow` and `enablePlan` mean in plain words, and the issuer's and the API's hosts from M1.29's fixed values, never from a subject.
  - Turning plan usage on (M7.S7) is the same op on an instance whose saved registration has plan usage off. The hub sets the subject's `enablePlan` and follows M7.S2's plan-enable path, with the saved client and `prompt=consent`.
- **Owns.** `apps/hub/src/ai/siwc/{signin-window,connect-subject}.ts`, with `apps/hub/test/ai/siwc/signin-window.test.ts`; `apps/app/src-tauri/src/{siwc_signin,siwc_review}.rs` with their integration tests `apps/app/src-tauri/tests/{siwc_signin,siwc_review}.rs`; one line each in H10, H25 and H27, two in H26, and the lines of its two modules in H11.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin-window.test.ts`, with FakeDevice through `admin_open`:
    - a confirmed desktop approver with the PIN starts an ordinary sign-in and the plan-enable path, and each review's subject is the one H25's builder returned, with its digest the SHA-256 of that subject's JCS;
    - one case per subject field: `instance` and `name` are the instance's, and an id that isn't a SIWC instance is refused with `NOT_FOUND` and leaves no record; `account` is the saved account's, or null on a first sign-in; `enablePlan` follows the saved plan-usage state; `flow` is `hub` only for the sidecar's own app;
    - on a sidecar hub, a confirmed desktop approver other than the sidecar's own app never gets `flow: hub` or `flow: transfer`: it is refused with `FORBIDDEN` and leaves no record, with no transfer module present and with one present (a test double here), and no listener or transfer window opens for it. On a service hub every approver gets `flow: transfer` with a transfer module present, and `FORBIDDEN` without one;
    - an approval from a device other than the one that asked opens no listener, and the route answers it `NOT_FOUND`;
    - a mobile device, a browser session, an unconfirmed or revoked device, a confirmed read/draft desktop, and a missing or wrong PIN are refused;
    - the authorization route answers only the device that approved, and only while the flow is open, in M1.29's form, with a `remainingMs` that never exceeds the listener's 300,000 ms; after the flow closes it answers `STALE`, with port 1455 held `PORT_IN_USE`, and for a `flow: transfer` op `NOT_FOUND`.
  - `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_signin --test siwc_review`, on Tauri's mock runtime:
    - **`siwc_signin`:** the continuation runs only after an accepted approval, never before, after a refused one or from JS, and ignores a `flow: transfer` subject; the URL opened through H12 is the one M1.29's authorization answer carried, on the issuer's fixed origin and path, and any other URL is refused; a URL from JS is never opened; `siwc_signin` is refused from the main window and from a foreign origin;
    - **`siwc_review`:** each field of both subjects is shown, the hosts come from M1.29's fixed values whatever a subject holds, and a subject that fails M1.29's codec is refused, not rendered.
- **Starts** after M7.S2, M4.7, M4.12, M4.13, M4.14 and M1.29 are on `m7`.

### M7.S3 SIWC credentials: storage, serialized refresh, revocation on disconnect
- **Inputs.**
  - §4 Credential flow 4 and 5; §3 Backup and Restore; §9.2 (theft of disk, backups or logs; OAuth mix-up); guardrail 8.
  - M2.26's common vault and per-credential mutex, through its credential registry (H5), and M2.17's broker, which refuses a credential the registry can't serve (H5); M7.S1's rule for calls to OpenAI.
  - M2.12's backup and restore (H8).
  - The disconnect kind from M1.20 (H2), through the admin-op service as in M7.S2 (H1).
  - M0.27's revocation evidence and handoff.
  - Spike S7's broker and session rules for a credential the hub can't use and for a refresh that fails.
  - The SIWC Terms: persistent token storage stays local and under the user's control, and no transfer is allowed except as the Terms permit.
  - The owner's answer on the backup change (Changed since the plan).
- **Outputs.**
  - **Storage.** Tokens, their granted scopes and the ID-token hint (the ID token a later sign-in sends as `id_token_hint`) live only in M2.26's common vault, as the `siwc` credential kind (one line in H5), with no second vault (as M5.10 does for Gmail). M7.S2's sign-in stores them here; after a decline that returns no refresh token, the hint is stored alone (M7.S1). `draftyak backup` leaves them out, and a restore drops any it finds, so the owner signs in again (Changed since the plan). `HubDataClass` has one `credentials` class, so the backup tells them apart by credential kind (one line in H8).
  - **Refresh.** The siwc credential refreshes under M2.26's per-credential mutex, through its credential registry (H5), with no second mutex. The rotated refresh token is persisted before its first use.
    - A refresh that fails on the network, with a 429 or with a 5xx gives UNAVAILABLE with backoff and keeps the tokens.
    - A refresh that narrows the scopes turns plan usage off.
    - After a refresh refused as unusable, the hub keeps the last tokens it held, unused, so disconnect can still revoke them (M0.27).
    - A refresh refused with `invalid_client` keeps the tokens unused in the same way, and the hub drops that client (M7.S1), so the next sign-in registers again.
    - While tokens are kept unused, the `siwc` namespace records that the instance needs a new sign-in, which M7.S7's state read shows as `reauth-required`.
  - **An unusable credential** (signed out, plan usage off, a refused refresh or client) stops the request in M2.17's broker (H5). The plugin gets `{error: {type: "broker_refused", code}}` with the session code, status 401 (sign in again), 403 (don't retry) or 503 (back off), and `x-should-retry: false`. Nothing leaves.
  - **Disconnect.** It is an admin op (one line in H1): revoke at OpenAI, then delete locally.
    - Revocation is confirmed only as M0.27 defines it: the revoke answers 200, then the revoked refresh token, tried once more, is refused with `invalid_grant`, `invalid_refresh_token` or `refresh_token_invalidated`.
    - Nothing else confirms it: a 429, a 5xx, no answer, an incomplete 200, a follow-up refresh that works, `refresh_token_reused` or an expiry.
    - If that follow-up refresh works, the tokens it returns are revoked at once and never used or stored, and the revoke stays not confirmed, as spike S7 does (`no(the revoked refresh token still works)`).
    - A kept token that a refresh already refused is revoked too, but it is always reported as not confirmed, since another process may hold a newer one.
    - On the unconfirmed path the hub still clears its tokens and tells the owner to remove DraftYak in ChatGPT's Sign in with ChatGPT settings. The CLI prints it, and the hub records the unconfirmed revoke in the `siwc` namespace until the next sign-in, so M7.S7's state read shows it on the desktop.
    - Either way, disconnect deletes the ID-token hint with the tokens and keeps the host ID and the issued client, unless the hub dropped it after the issuer refused it (M7.S1), for the next sign-in, as spike S7's sign-out does.
- **Owns.** `apps/hub/src/ai/siwc/credential.ts`, `apps/hub/test/ai/siwc/credential.test.ts`, the CLI command `apps/cli/src/commands/siwc-disconnect.ts` with `apps/cli/test/commands/siwc-disconnect.test.ts`, and one line each in H1, H5 and H8.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/credential.test.ts`, on the siwc-auth fake:
    - concurrent requests make one refresh;
    - a failure between rotation and first use leaves the new token stored, and a rotated token whose write fails is never used;
    - the old refresh token is never sent again;
    - a refresh that fails on the network, with a 429 or with a 503 gives UNAVAILABLE with backoff, and the stored tokens don't change;
    - a refresh that narrows the scopes turns plan usage off;
    - a refresh refused with `invalid_client` keeps the tokens unused, the next request gets `broker_refused` with `INVALID_CLIENT`, the `siwc` namespace records that a new sign-in is needed, and the next sign-in registers again with `dynamic_agent_client`, `agent_name_hint: "DraftYak"` and the same host ID, never naming the refused client;
    - an unusable credential gets the `broker_refused` answer with its code, status and `x-should-retry: false`, and the fake receives nothing;
    - a redirect from the token endpoint on refresh, or from the revocation endpoint, is not followed;
    - disconnect runs only as an admin op: the CLI path needs the PIN, and through the admin-op service FakeDevice is refused as a mobile device, a browser session, an unconfirmed or revoked device, and a confirmed desktop with read and draft only;
    - disconnect records the revoke before the local deletion, on both the confirmed and the unconfirmed path;
    - a 200, then a follow-up refresh refused with `invalid_grant`, `invalid_refresh_token` or `refresh_token_invalidated`, confirms, one case per code;
    - these never confirm, one case each: a revoke answered with a 429, a 5xx or nothing; a follow-up refresh that works; one that gets an incomplete 200, a 429, a 5xx or no answer; one refused with `refresh_token_reused` or an expiry error;
    - when the follow-up refresh works, the refresh token it returned is revoked at once, nothing it returned is stored or used, and the report is not confirmed;
    - on every unconfirmed path, the tokens are cleared, the owner is told to remove DraftYak in ChatGPT's settings, and the `siwc` namespace records the unconfirmed revoke;
    - after a refresh refused as unusable, disconnect revokes the kept token and reports it as not confirmed;
    - after either disconnect path, the vault holds no SIWC token or ID-token hint, and the `siwc` namespace still holds the issued client and the host ID;
    - a plaintext token canary and an ID-token canary never appear in logs, audit, events, the db or `-wal`, URLs, plugin argv, env or stdio, or `ctx.fetch` frames;
    - a backup holds no SIWC token or ID-token hint, and a restore asks for a new sign-in;
    - restoring a backup fixture that holds a SIWC token and an ID-token hint drops both and asks for a new sign-in.
  - `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-disconnect.test.ts` tests the CLI command itself: its arguments, its PIN prompt, its "confirmed" or "not confirmed" report and its exit codes.
- **Starts** after M7.S2, M2.3, M2.4, M2.11, M2.12, M2.17, M2.23 and M2.26 are on `m7`, and the owner's answer on the backup change. If the owner declines it, this item adds no line to H8, SIWC tokens and the ID-token hint are backed up like other credentials (§3), and the two backup cases check that a backup holds them and a restore keeps them.

### M7.S3b Disconnect from the desktop approval window
- **Inputs.** M7.S3's handler (H1, H2); M1.29's disconnect subject; M4.13's admin pending operations and approval window, with its subject hook (H25) and its call into the handler (H9); M7.S2b's native rendering of the subject (H26); §9.3 admin ops.
- **Outputs.**
  - `apps/hub/src/ai/siwc/disconnect-subject.ts` builds M1.29's disconnect subject when M4.13 creates the pending record (one line in H25): `instance` and `name` come from the AI instance, which must be a SIWC instance (any other id is refused with `NOT_FOUND`), and `account` is the signed-in account's address, or null if none is known.
  - A confirmed desktop approver disconnects through `admin_open` and the approval window, with the PIN, and the review shows that subject, rendered by M7.S2b's `siwc_review`. The hub runs M7.S3's handler: the same revoke-then-delete and the same report as the CLI path, which M7.S7 shows.
- **Owns.** `apps/hub/src/ai/siwc/disconnect-subject.ts`, `apps/hub/test/ai/siwc/disconnect-window.test.ts` and one line in H25.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/disconnect-window.test.ts`, on the siwc-auth fake with FakeDevice through `admin_open`:
  - a confirmed desktop approver with the PIN disconnects, the review's subject is the one H25's builder returned for that instance, with its digest the SHA-256 of that subject's JCS, and the revoke is recorded before the deletion;
  - one case per subject field: `instance` and `name` are the instance's, and an id that isn't a SIWC instance is refused with `NOT_FOUND` and leaves no record; `account` is the signed-in account's, or null when none is known;
  - a mobile device, a browser session, an unconfirmed or revoked device, a confirmed read/draft desktop, and a missing or wrong PIN are refused.
- **Starts** after M7.S3, M7.S2b, M4.13 and M1.29 are on `m7`.

### M7.S3c Revocation before an instance or the plugin is removed
- **Inputs.** §3 Data lifecycle (uninstall deletes the plugin's instances, credentials and consents); §4 Credential flow 5 (SIWC tokens are revoked at OpenAI on disconnect); M7.3's instance lifecycle hooks (H14); M7.S3's disconnect.
- **Outputs.** Deleting a SIWC instance, or uninstalling `ai-responses-api`, first runs M7.S3's revoke-then-delete through H14. Nothing is removed until it returns. An unconfirmed revoke still deletes the tokens, and the handler returns the `revoke-unconfirmed` notice, which the removal's result shows the owner (H14), since the instance and its state are gone. The handler also deletes the instance's vault entries, the ID-token hint included, and its rows in the `siwc` namespace (the issued client, the account, the plan-usage state and the notices); the per-hub host ID stays.
- **Owns.** One line in H14 and `apps/hub/test/ai/siwc/removal.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/removal.test.ts`, on the siwc-auth fake: deleting the instance and uninstalling the plugin each record the revoke at OpenAI before the tokens are deleted; with an unconfirmed revoke, the tokens are still deleted and the handler returns the `revoke-unconfirmed` notice; afterwards the vault holds nothing of the instance, and the `siwc` namespace holds no row of it, only the per-hub host ID.
- **Starts** after M7.S3 and M7.3 are on `m7`.

### M7.S4 The documented transfer for a headless hub
- **Inputs.**
  - §4 Credential flow 2 (headless hub) and 3 (scope checks).
  - ADR 0009's transfer result and M0.27's transfer handoff (order and failure rules).
  - M1.29's transfer routes, credential form, error codes and connect subject.
  - M4.13's admin pending operations (H9) and continuation hook (H27), M4.7's L2 route snapshots (H10), M4's command registration (H11) and M4.14's system-browser opener (H12). M4's backlog doesn't name these SIWC lines yet, so they are requests.
  - The connect kind from M1.20 (H2); M7.S2b's connect subject (H25), which picks `flow: transfer`, and its review rendering (H26).
  - M7.S2's checks on a sign-in (the ID token, `sub` and the scope check), which the hub applies on receipt, and M7.S1's rule for what a decline keeps.
  - M5.20's native boundary for `gmail_*`: no code, verifier or token in webview JS or logs.
  - The SIWC Terms' transfer clause.
  - OpenAI's answer to question 1a, on this transfer. A "no" means the transfer doesn't ship, and the owner settles this before launch.
- **Outputs.**
  - A hub that runs as a service (M1.27's `mode`), the headless hub of §4 Credential flow 2, signs in from the approval window through this transfer; a sidecar hub never does (M7.S2b). Its connect op (M7.S2's handler) carries M1.29's connect subject with `flow: transfer`, which M7.S2b's builder sets, and a confirmed desktop approver approves it in the approval window with the PIN. The handler opens the transfer window only for the device that asked (H9); an approval from another device opens nothing.
  - **The transfer window.** When that `admin.v1` is accepted, the handler opens a window: SIWC's own hub state, kept in memory and bound to the op, the approving device and the approval time (H9). It stays open for 10 minutes after the approval unless a credential consumes it first, and a hub restart closes it. The pending record keeps M1.26's 120 s review cap; the window never extends it.
  - The approval window's continuation (one line in H27) hands the op id and the verified subject to the transfer's native module, which acts only on `flow: transfer`. That desktop then reads M1.29's transfer start (H10's `GET`): the hub's host ID, issuer and issued client, a fresh nonce, and `consent`. The client is null on a first sign-in, or after the issuer refused the saved client (M7.S1); the request then names `dynamic_agent_client` and `agent_name_hint: "DraftYak"`. `consent` follows M7.S2's `prompt=consent` rule: under the proposed fix, it is true exactly on the plan-enable path, whose review has `enablePlan: true`, with the saved client. Its authorization request carries the host ID, that nonce, its own `state`, an S256 `code_challenge` of a fresh verifier, and `prompt=consent` exactly when `consent` is true. It opens the authorization URL through M4.14's opener (H12). Its local listener follows M7.S2's rules: the port check, one flow, the callback route only, the 300,000 ms timeout, and closing in every outcome.
  - **A refused client.** If the issuer refuses the start answer's client on the desktop's code exchange (`invalid_client`, M7.S1), the desktop sends nothing to the hub and registers again, once, inside the window: a new authorization request that names `dynamic_agent_client` and `agent_name_hint: "DraftYak"` with the start answer's host ID and nonce, a new `state`, a fresh verifier and, as before, `prompt=consent` exactly when `consent` is true, opened through H12 like the first. The credential then carries the client that registration issued. A second refusal ends the transfer with nothing sent, and the window closes as for a lost handoff.
  - The desktop's discovery and code exchange reach only the issuer's https endpoints, follow no redirect and take no URL from JS. `error=access_denied` or a wrong `state` exchanges nothing, and `redirect_uri` is identical in the request and the exchange.
  - No code, verifier or token reaches webview JS or logs. The `siwc_*` commands take and return ids only, and only the approval window may call them (H11).
  - The desktop holds the code, the verifier and the credential in memory only, from the code exchange to the send, never in the keychain (M1b's keyring store) or a file. That memory is the desktop store the handoff wipes.
  - The hub's credential route (H10's `POST`) takes one credential in M1.29's form, from the device that approved the op, while its window is open. The first `POST` closes the window, whatever its outcome. For a `flow: hub` op both transfer routes answer `NOT_FOUND`.
  - **Checks on receipt.** Before it stores anything, the hub checks the credential as M7.S2 checks its own sign-in: the ID token's signature against the issuer's JWKS, its `iss`, its `aud` (holding the credential's client, under M7.S2's audience rule), an `azp` equal to that client when `aud` has several values, an `iat` that isn't in the future, `exp` and the window's nonce; `sub` equal to the credential's subject and, for a known account, to the saved one; and the host ID and issuer, as spike S7's `acceptTransfer` does. The client is the start answer's, or one a registration in the window issued: on a first sign-in, after the issuer refused the saved client (the start answer names none), or after the desktop registered again on a refusal. The hub takes a newly issued client only for the saved account (the same `sub`), or for any account on a first sign-in, only from the approving device inside the window and with every check above; it then drops the client it replaces (M7.S1). A credential that fails gets `TRANSFER_REFUSED`, and nothing is stored. M7.S2's scope check follows: without `chatgpt.tokens.use.direct`, plan usage stays off, and the hub keeps what M7.S1 keeps after a decline.
  - **Handoff order:** serialise the credential, wipe the desktop store, then send. The desktop keeps the serialised copy in memory only. The hub refreshes the tokens as soon as it takes them and answers with M1.29's result:
    - `refreshed`: it took the tokens and its refresh worked;
    - `revoked`: its refresh failed, and it revoked the tokens with M0.27's confirmation (M7.S3);
    - `unconfirmed`: its refresh failed and its revoke wasn't confirmed, as when the refresh got no answer and may already have rotated the token. The hub records `revoke-unconfirmed` in the `siwc` namespace, which M7.S7 shows;
    - `registered`: the credential carried `tokens: null`, from a sign-in that returned no refresh token. The hub keeps what M7.S1 keeps after such a decline (the issued client, the subject and the host ID with plan usage off, and the ID-token hint) and stores no token, so the next transfer start names that client.

    The desktop revokes its copy on `unconfirmed`, on an error or no answer, and on any answer other than these four; a `registered` answer to a credential that carried tokens counts as an error.
  - **A lost handoff:** if the desktop closes or crashes after the wipe and before the hub answers, nobody holds the tokens. The window closes 10 minutes after the approval. If the approving desktop had read the transfer start, a sign-in may have finished, so the hub tells the owner that if they finished signing in, they should remove DraftYak in ChatGPT's Sign in with ChatGPT settings. If it never had, the hub says only that the sign-in expired. The hub records either notice in the `siwc` namespace, and M7.S7 shows it.
  - The `siwc_*` native modules in `apps/app` use M4's hooks (H11, H12), as M5.20 adds `gmail_*` modules, and M1.29's Rust codec for every L2 body.
- **Owns.** The `siwc_*` modules in `apps/app/src-tauri/src/` other than M7.S2b's `siwc_signin` and `siwc_review` and M7.S7's `siwc_links`, with their integration tests `apps/app/src-tauri/tests/siwc_{listener,exchange,handoff,acl}.rs`; `apps/hub/src/ai/siwc/transfer.ts` and `apps/hub/test/ai/siwc/transfer.test.ts`; two lines in H10, one in H27 and its modules' lines in H11. If it merges after M7.S9, also the deletion of `spikes/s07-siwc/` (except `notes/sources.md`) and the spike's `pnpm-lock.yaml` importer.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/transfer.test.ts`, on the siwc-auth fake with FakeDevice as the desktop:
    - FakeDevice reads the transfer start over the `GET` route, and its authorization request to the fake carries the host ID, the issued client and the nonce; the `GET` refuses any other device and a window that isn't open;
    - the hub takes the tokens over L2 once, bound to its host ID and its window, checks them and refreshes them at once, answering `refreshed`; when that refresh fails and the revoke is confirmed, it answers `revoked`;
    - a refresh answered with a 5xx followed by a revoke answered with a 5xx, and a refresh that gets no answer, each end `unconfirmed`, with `revoke-unconfirmed` recorded in the `siwc` namespace;
    - the review carries M1.29's connect subject with `flow: transfer` and keeps M1.26's 120 s cap, and the window the approval opens lasts longer: on the injected clock, a credential just inside 10 minutes of the approval is taken, and one just after is refused with `STALE`;
    - on a sidecar hub no op gets `flow: transfer`, so no transfer window opens there (M7.S2b refuses its other approvers); an approval from a device other than the one that asked opens no window;
    - the plan-enable path: its review has `enablePlan: true`, the start answer has `consent: true` and the saved client, and FakeDevice's authorization request to the fake carries `prompt=consent`;
    - both transfer routes answer `NOT_FOUND` for a `flow: hub` op;
    - the checks on receipt, one case each, each answered `TRANSFER_REFUSED` with nothing stored and no refresh sent: an ID token with a bad or missing signature, a wrong `iss`, `aud`, `exp` or `nonce`, an `azp` other than the credential's client when `aud` has several values, or an `iat` in the future; a `sub` other than the credential's subject, or than the saved account's, with the start answer's client and with a newly issued one;
    - a refused client: when the fake refuses the start answer's client on FakeDevice's code exchange (`invalid_client`), FakeDevice registers again inside the window with `dynamic_agent_client`, `agent_name_hint: "DraftYak"` and the same host ID and nonce; the hub takes the newly issued client for the saved account, answers `refreshed`, and the next transfer start names the new client, never the refused one. The same credential with another `sub` is refused with `TRANSFER_REFUSED`, from another device it gets `NOT_FOUND`, and after the window closes `STALE`;
    - after the hub's own refresh is refused with `invalid_client`, the next transfer start names no client, FakeDevice's authorization request names `dynamic_agent_client` and `agent_name_hint: "DraftYak"` with the same host ID, and the hub takes the client it gets only for the saved account;
    - a credential without `chatgpt.tokens.use.direct` is taken with plan usage off, and nothing goes to SIWC;
    - a credential with `tokens: null` is answered `registered`: the `siwc` namespace holds the issued client, the subject and the host ID with plan usage off, no token is stored, and the next transfer start names that client;
    - with no credential, the window closes 10 minutes after the approval. If FakeDevice had read the transfer start, the owner gets the notice to remove DraftYak if they finished signing in; if it hadn't, only that the sign-in expired;
    - these are refused:
      - an unconfirmed or revoked device;
      - a mobile or browser role;
      - a second confirmed approver, not the one that approved;
      - an op that was cancelled, expired or never approved;
      - a wrong host ID or issuer;
      - another `sub` for a known account, with the saved client or a newly issued one;
      - a replay, or a second flow;
      - an oversized or malformed body;
    - every answer and error is in M1.29's form.
  - `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_listener --test siwc_exchange --test siwc_handoff --test siwc_acl` runs four integration-test targets, and fails if any is missing:
    - **`siwc_listener`, on an OS-assigned port:** a port held on `127.0.0.1` or on `0.0.0.0` gives a clear refusal; a second callback, a wrong `state`, another Host, another path or a `POST` is refused; the listener closes after success, failure and cancellation, and at its 300,000 ms timeout;
    - **`siwc_exchange`:** the authorization request carries the start answer's host ID and nonce and an S256 `code_challenge` of the verifier the exchange sends, and `prompt=consent` exactly when the start answer's `consent` is true; `redirect_uri` is identical in the request and the exchange; `error=access_denied` or a wrong `state` exchanges nothing and sends nothing to the hub; a code exchange refused with `invalid_client` sends nothing to the hub and starts one new authorization request inside the window, naming `dynamic_agent_client` and `agent_name_hint: "DraftYak"` with the start answer's host ID and nonce, a new `state` and a fresh verifier, opened through H12, whose credential carries the newly issued client; a second refusal ends the transfer with nothing sent; discovery and the code exchange reach only the issuer's https endpoints, a redirect is not followed, and a URL from JS is refused; the URL opened through H12 is the issuer's authorization endpoint;
    - **`siwc_handoff`:** the desktop store is already empty when the send starts; nothing is written to the keyring or to a file from the code exchange to the end of the transfer; each failure path (refused, no answer, `unconfirmed`, an answer outside M1.29's four outcomes, or `registered` for a credential that carried tokens) ends with the desktop's copy revoked; afterwards the process, its store and its logs hold no copy; a token and code canary never reaches webview JS or the logs; every body and answer goes through M1.29's Rust codec;
    - **`siwc_acl`, on Tauri's mock runtime:** each `siwc_*` command is refused from the main window and from a foreign origin, and takes and returns ids only; the transfer's continuation runs only after an accepted approval, never before, after a refused one or from JS, and ignores a `flow: hub` subject.
- **Starts** after ADR 0009 records the transfer, and M7.S3, M7.S2b, M4.7, M4.13, M4.14 and M1.29 are on `m7`.

### M7.S5 The broker's SIWC verifier and the shared hostile-request table
- **Inputs.**
  - §4 AI request verifiers (the SIWC allowlist); guardrail 4; TB3 (credentials never in plugins).
  - M2.19's per-profile verifier registry and broker contract (H7), and M1.20's ChatGPT-plan profile id (H3).
  - How an instance gets that profile rather than the API-key one, since a manifest has one `auth` kind and one AI egress profile: ADR 0009's follow-up, which M1.25 records (M1.20).
  - ADR 0009 on `text.format` versus `submit_draft` and on top-level versus namespaced tools.
  - M7.1 and M7.9: the broker builds the model and effort pin and the DraftRequest from hub state, and plugin-supplied values authorize nothing.
  - Spike S7's broker and M0.26's broker contract: the broker reads only string bodies that parse to a JSON object, and sends the re-serialized value it verified.
- **Outputs.**
  - A pure verifier, `verify(request, pin, input)`. `pin` is the hub's model and effort; `input` is the hub's DraftRequest, with the instructions and the one user message. It checks the request against both and returns the request rebuilt from them, which is what the broker sends. Plugin-supplied values authorize nothing, as M7.1 and M7.9 say. It registers under the ChatGPT-plan id with one line in H7. It allows only:
    - §4's nine `POST /v1/responses` fields: `model`, `instructions`, `input`, `tools=[submit_draft]` (strict, never executed), `tool_choice`, `text`, `reasoning`, `stream:true` and `store:false`;
    - a bodiless `GET /v1/models` with no query, for the model picker (Changed since the plan), which `verify` gets with no `input`;
    - any other route that ADR 0009's confirmed plan changes add.
  - Its line in H7 marks the ChatGPT-plan profile on demand, so the broker admits its requests only inside a hub call to the instance: one POST per draft attempt, and at most one bodiless `GET /v1/models` per `ai_models_list` or `ai_probe` call. A request at any other time is refused and audited before H5's `token()` runs, so a plugin's own timer can neither reach SIWC nor start a refresh.
  - Its `problems` name only the API's own field and header names and show anything else as `(unknown)`, as spike S7's `verify.ts` does, so no plugin text reaches the denial audit or the logs.
  - The shared hostile-request table, `packages/fakes/src/siwc-hostile-requests.ts`. It lands with this item on `m2`, in a package the base already has, because the fakes can't import from `apps/hub`. M7.S8b's fake runs the same table, so the two copies of the allowlist can't drift. Its broker-path cases are marked as such: they script an upstream answer rather than a request.

  The plugin holds only a placeholder key; the broker injects the access token after verification.
- **Owns.** `apps/hub/src/ai/siwc/verifier.ts`, `apps/hub/test/ai/siwc/verifier.test.ts`, one line in H7, and `packages/fakes/src/siwc-hostile-requests.ts` with one export line in `packages/fakes/src/index.ts`. Unless an earlier M2 item adds it, also the `"@draftyak/fakes": "workspace:*"` devDependency in `apps/hub/package.json` and its `pnpm-lock.yaml` importer entry, agreed with the hub package's owner.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/verifier.test.ts` runs the whole table, each case as a hostile vector through the verifier and through the broker path, with the ChatGPT-plan line registered in H7 beside M2.19's three API-key verifiers. M2.19's own suite still passes with that line registered; it loads no SIWC table. The table covers:
  - **pin and input:** a `model` or `reasoning.effort` other than the pin's; `instructions` other than the hub's; an `input` other than one user message (and the single `submit_draft` item, if ADR 0009 puts it there); a user message other than the hub's prompt;
  - **fields and values:** a field outside the nine; `store:true` or no `store`; `stream:false` or no `stream`; a different or second tool, or anything other than the pinned `submit_draft` JSON; `function_call_output` input items;
  - **body:** anything but a string that parses to a JSON object (bytes, a stream, an object with its own `toJSON`) is refused; with a duplicate key, the broker sends only the re-serialized value it verified;
  - **origin:** any host other than the API host, including ChatGPT's private backend (that URL is built at run time, as spike S7's test does, so vendor-guard stays clean); `http:`; a URL with userinfo or a query;
  - **path and method:** any path or method other than `POST /v1/responses` and `GET /v1/models`; a `GET /v1/models` with a body or a query; `GET /v1/models/<id>`;
  - **headers:** a header outside the allowlist, or any Authorization value other than the placeholder bearer;
  - **flow:** more than one `POST /v1/responses` per attempt;
  - **problems:** a canary in an unknown field's name, in a header name and in a header value never appears in `problems` or in the broker's denial audit entry;
  - **broker path, not request vectors:** a 301, 302, 303, 307 or 308 from the API host, which a test upstream serves here and M7.S8b scripts for M7.S5b's run: the broker makes one upstream call, follows no redirect and sends nothing to the new location;
  - **on demand, broker path:** a valid `GET /v1/models` outside any hub call, a second one in one `ai_models_list` or `ai_probe` call, and one during `ai_describe` are each refused and audited, H5's `token()` is never called, and the test upstream receives nothing.

  A valid request comes back rebuilt from the pin and the hub's DraftRequest, and a bodiless `GET /v1/models` with the placeholder bearer passes unchanged.
- **Starts** after ADR 0009 merges into `m0`, and M1.20 and M2.19 are on `m2`. Its branch is `m2-<nn>-<slug>`.

### M7.S5b The siwc drafting mode: request builder, streaming, broker refusals
- **Inputs.**
  - §5's SIWC row: a strict `submit_draft` function tool that is never executed.
  - ai-provider-v1 (`spec/extensions/ai-provider-v1.md`: `ai_describe`, `ai_models_list`, `ai_probe`, `ai_draft_generate`; refusal, truncation and no tool call are outcomes, not errors; progress at least every 10 s while the model works).
  - The host channel's `host/stream.chunk` (M1.12, M1.13 and the hub side of streamed `host/fetch`, after the ADR 0003 decision).
  - M7.4's byte and event caps; M7.9's mode table (H15); M2.17's `broker_refused` answer for a credential that M2.26's registry can't serve (H5).
  - M7.S5's verifier and M7.S8b's benign model, for the positive control; the SIWC models list, `{models: [{slug, display_name, visibility}]}` (spike S7's `notes/sources.md`), which M7.S8b serves.
  - The on-demand rule (Clean-room rules; H22) and the broker's on-demand admission (H7).
  - How an instance gets the siwc auth and the ChatGPT-plan profile (M1.20's profile id, H3) rather than the API-key ones: ADR 0009's follow-up, which M1.25 records (M1.20), and M7.9's manifest (H31).
- **Outputs.**
  - The siwc mode of `plugins/ai-responses-api`, beside M7.9's api-key mode, as one `siwc` line in M7.9's mode table (H15):
    - `ai_describe`, `ai_models_list`, `ai_probe` and `ai_draft_generate`. The hub calls `ai_probe` and `ai_models_list` only from the Test control and the model picker (H22);
    - `ai_models_list` and `ai_probe`, the only users of `GET /v1/models` (Changed since the plan), each sending that one bodiless request per call and nothing else, as the broker allows (H7). `ai_models_list` maps each `visibility: "list"` entry's `slug` to ai-provider-v1's `id` and its `display_name` to `name`, in the server's order, and drops the rest. `ai_probe` reports whether the list came back, and `ai_describe` sends nothing;
    - the request builder, from the hub's DraftRequest, using the pinned `openai` SDK through `ctx.fetch` with a placeholder key, like the API-key factory;
    - streaming over `ctx.fetch` with `host/stream.chunk`, under M7.4's caps;
    - progress at least every 10 s while the model works;
    - broker refusals, in `src/siwc/broker-refused.ts`: a `broker_refused` answer whose code names a session code maps back to that code, and any other to BROKER_REFUSED. The SDK never retries one.
  - Nothing under `apps/hub` imports `openai`.
  - The siwc mode's entries in the plugin's manifest (H31): its `oauth2-dynamic-agent` auth and the ChatGPT-plan profile, in the form M1.25's record settles.
- **Owns.** `plugins/ai-responses-api/src/siwc/` and `plugins/ai-responses-api/test/siwc/`, except M7.S6's `src/siwc/errors.ts` and `test/siwc/errors.test.ts`; `apps/hub/test/ai/siwc/drafting.test.ts`; one line in H15; the siwc entries in H31.
- **Acceptance.**
  - `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/request.test.ts`, then the same command for `test/siwc/stream.test.ts`, `test/siwc/broker-refused.test.ts` and `test/siwc/models.test.ts`, one file each, cover:
    - `submit_draft` arguments only parsed as `DraftOutput`;
    - the models list: `slug` and `display_name` map to `id` and `name` in the server's order, a `hide` entry is dropped, and a body that isn't `{models: [...]}` ends as an error, never as an empty list; `ai_models_list` and `ai_probe` each send exactly one bodiless `GET /v1/models`, and `ai_describe` sends nothing;
    - stream splits at 1, 7 and 4,096 bytes giving the same draft (spike S7's `stream.test.ts`, moved in);
    - refusal, incomplete and no-tool-call outcomes;
    - a slow stream on an injected clock still sends progress at least every 10 s;
    - a `broker_refused` answer with `x-should-retry: false` whose code names a session code ends with that code; one whose code is `broker_refused`, or unknown, ends as BROKER_REFUSED; in each case the SDK sends one request and doesn't retry.
  - With `DRAFTYAK_STRICT_SKIPS=1` set, `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/siwc/contract.heavy.test.ts`: `aiProviderContract()` and `runConformance` pass in process mode under production flags, with M7.S8b's fake serving the models list and the draft.
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/drafting.test.ts`:
    - the positive control: the pinned SDK's request through `ctx.fetch` passes M7.S5's verifier, reaches the responses-siwc fake with exactly the allowed fields, and M7.S8b's benign model streams back the draft;
    - the hostile table's broker-path cases run against M7.S8b's scripted 3xx: one upstream call each, and nothing sent to the new location;
    - an import scan shows `apps/hub` never imports `openai`.
- **Starts** after M7.S3, M7.S5, M7.S8b, M7.4, M7.9, M2.26, the host channel's streamed fetch (M1.12, M1.13) and M1.25's record of the per-mode auth and profile choice are on `m7`.

### M7.S5c The `cloud-consumer-plan` destination class
- **Inputs.** §5's SIWC row (destination `cloud-consumer-plan`) and Routing policy; M7.5's destination table (H16) and routing; the ChatGPT-plan profile id (H3).
- **Outputs.** The hub maps the ChatGPT-plan profile to `cloud-consumer-plan` (one line in H16). Nothing the plugin says sets the class.
- **Owns.** One line in H16 and `apps/hub/test/ai/siwc/destination.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/destination.test.ts`: a SIWC instance resolves to `cloud-consumer-plan` through M7.5's routing; a plugin that declares another class (`local` or `cloud-no-train`) changes nothing, so auto-draft stays off and the training-off acknowledgement is still required.
- **Starts** after M7.S5b, M7.5 and M7.7 are on `m7`.

### M7.S6 The full error set and no silent billing switch
- **Inputs.** §5's seven SIWC errors (usage limit, unavailable, not eligible, unsupported capability, route not supported, invalid user, scope not authorized); Owner decisions (ChatGPT: no silent billing switches); plugin-error-v1; spike S7's error table; ADR 0009's recorded shapes; M7.4's execution path and its one repair, which only an invalid draft starts; M3.5's draft job; M7.S8b's scripted SIWC models and its wrapper over M7.11's responses-api fake (H24); M7.11's messages-api fake; M2.17's `broker_refused` answer for a credential that M2.26's registry can't serve (H5), and M7.S5b's mapping of it; the on-demand rule (Clean-room rules; H22).
- **Outputs.**
  - `src/siwc/errors.ts` maps each of the seven errors to a plugin-error-v1 code and a visible owner choice: wait, Manage usage, sign in again, or switch to an API key only by explicit action. A `broker_refused` answer goes to M7.S5b's mapping.
  - The choices show through M7.S7's slots.
  - Credential refusals reach the plugin as `broker_refused` and end the job with their session code and its choice. A refresh that fails on the network, with a 429 or with a 5xx ends as UNAVAILABLE (wait), and the tokens are kept.
  - The hub's draft job never re-routes a failed SIWC draft. It does no retry on another instance and no repair through another provider. Its one repair, after a draft that fails DraftOutput, goes to the same SIWC instance; if routing no longer allows that instance, the job ends with its error.
  - **No background request.** Without an owner action the hub sends nothing to SIWC: no probe, models list, draft or refresh at start-up, after a restart, on a timer or on a configuration change (Clean-room rules; H22). A request the plugin starts on its own, outside a hub call, is refused by the broker before any token is read (H7).
- **Owns.** `plugins/ai-responses-api/src/siwc/errors.ts`, `plugins/ai-responses-api/test/siwc/errors.test.ts`, `apps/hub/test/ai/siwc/no-billing-switch.test.ts` and the ChatGPT-plan line in H22.
- **Acceptance.**
  - `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/errors.test.ts` asserts each error's code and choice.
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/no-billing-switch.test.ts` runs M7.4's execution path with a SIWC instance, an API-key Responses instance and an Anthropic instance. All three are enabled and opted in for the same account and data class, so a re-route would reach the other two if the job tried. They run on M7.S8b's wrapper over M7.11's responses-api fake and on M7.11's messages-api fake. It injects:
    - each of the seven errors, both as an HTTP status and as an in-stream `response.failed`;
    - the missing-scope case;
    - the credential refusals (`PLAN_USAGE_DISABLED`, `REAUTH_REQUIRED`), which reach the plugin as `broker_refused` with 403 or 401 and `x-should-retry: false`;
    - a refresh that fails on the network, with a 429 or with a 503, which ends as UNAVAILABLE with the tokens kept;
    - a SIWC draft that fails DraftOutput (M7.S8b's schema-breaking model), which starts the hub's one repair;
    - the same schema-breaking draft with the SIWC instance's opt-in withdrawn before the repair, which ends the job with its error and choice and sends nothing to the other two instances.

    It asserts that each job ends with its error and choice, or, for the schema-breaking draft, with the repair's result; that the repair goes to the same SIWC instance; and that M7.11's responses-api handler, which the wrapper gives only API-key requests, and its messages-api fake record zero requests throughout.

    The same file holds the no-background cases. With a signed-in SIWC instance and no owner action, a long interval on the injected clock, past the access token's expiry, a hub restart, and a configuration change (renaming the instance) each leave the siwc-auth and responses-siwc fakes with zero requests. A test plugin in siwc mode that calls `ctx.fetch` on its own timer, outside any hub call, is refused and audited each time, and both fakes still record zero requests. A Test action then sends the probe, with the one refresh it needs, and nothing else.
- **Starts** after M7.S5b, M7.S5c, M7.S8b, M7.4, M7.5, M7.11, M3.5 and M2.26 are on `m7`.

### M7.S7 SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage
- **Inputs.** §5's SIWC UI; §8's AI screens and Platform adapter (JS passes ids only); §14 step 8; the provider slot in M7.5's routing screen and the billing-line slot in M7.7's drafting screen (H17); M7.5's add-provider flow (H30); M7.S2b's and M7.S4's approval-window sign-in and M7.S3b's disconnect; M4.13's admin pending operations; M3.7's `/api/v1` routes (H23), M4.7's L2 route snapshot (H10) and M4.14's `hub_request` allowlist (H28); M4.14's opener (H12) and M4's module registration (H11); M7.3's instance hosts (H29) for the Security Center's list (H13); M11's launch runbook (H21); the web package's unit tier, which collects `**/*.test.tsx` (H32).
- **Outputs.**
  - **The state read.** `GET /api/v1/ai/instances/{id}/siwc` in `apps/hub/src/ai/siwc/state.ts`, read-only, registered with one line in H23. Its callers are an owner cookie session on L1 and a confirmed `read` device through `hub_request` on L2 (one line each in H10 and H28); an agent token is refused. It answers `{signIn, planUsage, account, notice, path}` from the `siwc` namespace that M7.S1 to M7.S4 write:
    - `signIn` is `none`, `declined` (the registration kept, no tokens), `signed-out`, `signed-in`, or `reauth-required` (tokens kept unused after a refresh refused as unusable or with `invalid_client`, M7.S3);
    - `planUsage` is `on` or `off`, and `account` is the account's address or null;
    - `notice` is null, `revoke-unconfirmed` (M7.S3, M7.S4), or `transfer-expired` with whether a sign-in may have finished (M7.S4);
    - `path` says how the device that asks would sign in, as M7.S2b's subject builder picks: `hub` for the sidecar's own app (M7.S2b); `hub-app` for any other approver of a sidecar hub, which signs in from the DraftYak app on the hub's computer; `transfer` for an approver of a service hub (M7.S4), or `cli` while M7.S4's transfer isn't on `m7` or is dropped (the CLI command, M7.S2); null for a cookie session or a device without `admin`.

    It holds no token, code or ID token. It is a hub API addition, so its H23 line lands in a small contract PR the owner signs off (§12 Contracts).
  - `state.ts` also gives the Security Center the `siwc` kind's hosts (one line in H29): the issuer's host and the API's host, from M1.29's fixed values.
  - A text-only "Continue with ChatGPT" button when `signIn` is `none`, `signed-out` or `reauth-required`. It opens the connect op through `admin_open` and the approval window, and the sign-in takes the path that `path` names. With `hub-app` or `cli` the slot shows that line instead of the button: sign in from the DraftYak app on the hub's computer, or run the CLI command, which on a hub with no browser needs an SSH forward of `127.0.0.1:1455` from a computer that has one, as §4 Credential flow 1's headless fallback does for Gmail.
  - When the owner declined plan usage, or a signed-in instance has it off after a missing scope, M7.S2's two explicit owner actions: "Turn on ChatGPT plan usage", which opens the same op as M7.S2b's plan-enable path, and "Use an OpenAI API key instead", which opens M7.5's add-provider flow for `ai-responses-api` in api-key mode (H30). That flow creates nothing until the owner finishes it.
  - A "Disconnect" control, which opens M7.S3b's op through `admin_open` and the approval window, then shows the report: confirmed, or not confirmed with the notice below.
  - The notices from the state read: with `revoke-unconfirmed`, remove DraftYak in ChatGPT's Sign in with ChatGPT settings; with `transfer-expired`, that line only if a sign-in may have finished, and otherwise only that the sign-in expired.
  - The "Using ChatGPT plan" label and the "Manage usage" link. On the desktop the link passes only its id, `manage-usage`, to M4.14's opener, and `apps/app/src-tauri/src/siwc_links.rs` maps that id to `https://chatgpt.com/settings/usage` (one line in H12, and the module's line in H11). In the loopback browser it is an ordinary link to the same address.
  - M7.S6's error choices, shown in the same slots.
  - Every control is inert in the loopback browser and on mobile, where `approvals` is null.
  - No ChatGPT logo until OpenAI's reply to the logo-use question allows it (Open items). The M7.5 and M7.7 files hold no SIWC code.
  - The SIWC owner runbook, `docs/runbooks/m7-siwc.md` (§14 step 8), written as an owner check: setup, exact steps, what the owner sees, failure handling and duration. While M7.S4's transfer isn't available, it also gives the CLI sign-in on a hub with no browser, over an SSH forward of `127.0.0.1:1455` from the owner's computer. M11's launch runbook (`docs/runbook.md`) points to it for step 8 (H21). It needs a real ChatGPT plan, so it never runs in CI.
- **Owns.** `apps/web/src/ai/siwc/` with its Vitest tests `apps/web/src/ai/siwc/{provider-slot,billing-slot,destinations}.test.tsx`; `apps/hub/src/ai/siwc/state.ts` with `apps/hub/test/ai/siwc/state.test.ts`; `apps/app/src-tauri/src/siwc_links.rs` with its integration test `apps/app/src-tauri/tests/siwc_links.rs`; one entry in each slot (H17); one line each in H10, H12, H23, H28 and H29, and the module's line in H11; `docs/runbooks/m7-siwc.md`.
- **Acceptance.**
  - `pnpm --filter @draftyak/web --fail-if-no-match exec vitest run src/ai/siwc/provider-slot.test.tsx`, then the same command for `src/ai/siwc/billing-slot.test.tsx` and `src/ai/siwc/destinations.test.tsx`, one file each:
    - `provider-slot`: from state-read fixtures, the button for `none`, `signed-out` and `reauth-required`, the `hub-app` and `cli` lines in its place, the plan-usage control with the API-key offer, the disconnect control and both notices in each wording; the button, the plan-usage control and the disconnect control each call `admin_open` with their kind and the instance's id only; "Use an OpenAI API key instead" calls H30's `openAddProvider` with `ai-responses-api` and `api-key` only, and never `admin_open`; every control is inert outside the desktop;
    - `billing-slot`: the label, the link and each of M7.S6's error choices; on the desktop the link passes only the id `manage-usage`, never a URL;
    - `destinations`: the Security Center's destination list (H13) shows both the auth host and the API host for a SIWC instance.
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/state.test.ts`:
    - the state read answers each state and notice from the `siwc` namespace: never signed in, declined, signed out, signed in with plan usage on and off, `reauth-required` after an unusable refresh and after `invalid_client`, a revoke not confirmed, and an expired transfer with and without a started sign-in;
    - `path` for the sidecar's own app, for another approver of a sidecar hub (`hub-app` either way) and for a service hub's approver, each with the transfer registered and without it, and null for a cookie session and for a device without `admin`;
    - FakeDevice with `read` gets the answer over L2, and an agent token on L1 is refused;
    - `hostsFor` gives the issuer's host and the API's host;
    - a token, code and ID-token canary never appears in an answer;
    - H23, H10 and H29 list their lines, so a missing line fails.
  - `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_links`, on Tauri's mock runtime: `manage-usage` opens exactly `https://chatgpt.com/settings/usage` through H12, after the host is shown; an unknown id or a URL from JS is refused; `hub_request`'s allowlist holds the state read (H28), so a missing entry fails.
- **Starts** after M7.S2b, M7.S3b, M7.S6, M7.3, M7.5, M7.7, M4.2, M4.7, M4.13, M4.14 and M3.7 are on `m7`.

### M7.S8 The siwc-auth fake
- **Inputs.** §13 Fakes (`siwc-auth`); spike S7's clean-room fake (`test/fake-auth.ts`).
- **Outputs.** `packages/fakes/src/siwc-auth.ts`, which provides:
  - discovery and JWKS;
  - registration through the authorization request, with the issued client on the callback;
  - the PKCE code exchange with ID tokens;
  - rotating refresh and revoke;
  - grants with and without `chatgpt.tokens.use.direct`;
  - faults, each scripted on request:
    - ID tokens with a bad or missing signature, a wrong `iss`, `aud`, `exp` or `nonce`, several audiences with an `azp` other than the issued client, or an `iat` in the future;
    - a rewritten discovery document: another issuer, an endpoint on another origin or on `http:`, or no revocation endpoint;
    - `invalid_client` from the token endpoint, on a code exchange and on a refresh, for a client the owner removed, while a new registration with the same host ID still gets a new client;
    - a 429, a 5xx, no answer or a 3xx from the token and revocation endpoints, and a 3xx from discovery and JWKS;
    - an incomplete 200 from the token endpoint;
    - a refresh refused with `invalid_grant`, `invalid_refresh_token`, `refresh_token_invalidated`, `refresh_token_reused` or an expiry error;
    - scopes narrowed on refresh;
    - a revoke that answers 200 without revoking;
    - ID tokens for another subject;
    - a callback with another issued client, or with a client registered to another host ID;
    - a declined consent (`error=access_denied`).

  It is all that M7.S1 to M7.S4 need.
- **Owns.** That file, `packages/fakes/test/siwc-auth.test.ts` and one export line in `packages/fakes/src/index.ts`.
- **Acceptance.** `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/siwc-auth.test.ts`:
  - a full sign-in succeeds (the authorization request, the issued client on the callback, the code exchange, and an ID token that verifies against the fake's JWKS), and so does a refresh;
  - siwc-auth refuses a replayed code, a wrong verifier, a mismatched `redirect_uri`, an unknown client, and a reused or revoked refresh token;
  - each scripted fault is served as scripted, one case each.

  CI needs no SIWC credentials.
- **Starts** after ADR 0009 merges into `m0` and M1.20 is on `m7`.

### M7.S8b The responses-siwc fake and its scripted models
- **Inputs.** §13 Fakes (the responses-api fake rejects non-allowlisted fields and emits SIWC errors; scripted benign, obedient, schema-breaking, refusing and slow models); spike S7's clean-room fake (`test/fake-responses.ts`) and its models list; M7.S5's hostile-request table; M7.S8's siwc-auth fake; M7.11's responses-api fake, which speaks the API-key dialect only, and its exported handler (H24).
- **Outputs.** `packages/fakes/src/responses-siwc.ts`, which holds:
  - the allowlist check, tested against M7.S5's table;
  - the documented unsupported fields;
  - the seven SIWC errors, both as HTTP statuses and in-stream;
  - the models list on a bodiless `GET /v1/models`: `{models: [{slug, display_name, visibility}]}`, with `list` and `hide` entries;
  - a 301, 302, 303, 307 or 308 with a `Location` on another host, scripted on request, so M7.S5's broker-path cases can run against it;
  - scripted benign, obedient, schema-breaking, refusing and slow models, each a `submit_draft` function-call stream:
    - benign returns a valid draft; it is the stream M7.S5b's positive control reads;
    - obedient follows the demands injected into its input;
    - schema-breaking returns arguments that fail DraftOutput;
    - refusing returns a refusal;
    - slow streams on an injected clock;
  - `withSiwc(responsesApi, siwcAuth)`, a wrapper over M7.11's responses-api fake. Requests whose bearer siwc-auth issued go to the SIWC module; all others go to M7.11's exported handler unchanged (H24). So `responses-api.ts` holds no SIWC code, and M7.11 needs no SIWC option.
- **Owns.** That file, `packages/fakes/test/responses-siwc.test.ts` and one export line in `packages/fakes/src/index.ts`.
- **Acceptance.** `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/responses-siwc.test.ts`:
  - the table's valid request is accepted and streams the benign model's draft;
  - each scripted model streams as described, one case each;
  - responses-siwc rejects the field, value, path and method cases of M7.S5's table, the documented unsupported fields and any other route;
  - the models list is served to a siwc-auth bearer, and a `GET /v1/models` with a body or a query is rejected;
  - each scripted 3xx is served as scripted, one case each;
  - responses-siwc emits each of the seven errors both ways;
  - through the wrapper, a siwc-auth bearer reaches the SIWC module, and an API-key bearer reaches M7.11's handler unchanged.

  CI needs no SIWC credentials.
- **Starts** after M7.S5, M7.S8 and M7.11 are on `m7`.

### M7.S9 SIWC rows of M7's corpus and policy matrix
- **Inputs.**
  - §5 Routing policy and guardrail 6: `cloud-consumer-plan` is a per-account opt-in, with the disclosure immediately before consent. Gmail, Slack and SMS content also need the training-off acknowledgement, Slack also needs an opt-in that names the provider, and loosening is an admin op.
  - §5 Triggers: auto-draft only on `local` and `cloud-no-train`, never SIWC.
  - §12 M7 acceptance and its rule for cross-stream checks; the SIWC Terms clause above.
  - M7.6's corpus, policy-matrix and fields suites (H18); M7.S8b's benign and obedient SIWC models, in place of M7.11's, which speak the API-key dialect; M7.S5c's destination class; M7.5's routing, consent and disclosure; M7.7's triggers.
  - M2.17b's attempted-egress recorder and its one result format, which M11.7's privacy check reads (H20).
- **Outputs.**
  - SIWC rows added through one line in H18, so the rows never edit the suite files.
  - **Egress scenario:** `apps/hub/test/ai/siwc/egress.heavy.test.ts` runs a sign-in, a refresh, a draft and a revoke on the fakes under M2.17b's recorder. It asserts that the only destinations attempted are the auth host and the API host the fakes stand in for, and leaves its result in the recorder's format for M11.7's check (H20).
  - **Corpus rows:** the corpus (at least 60 cases) runs for siwc mode, with M7.S8b's benign and obedient models.
  - **Policy-matrix rows:** `cloud-consumer-plan` × channel × consent state gives run or skip, with the chip reason for each skip:

    | Channel | Consent state | Expected |
    |---|---|---|
    | Gmail | no opt-in | skip |
    | Gmail | opted in, without the training-off acknowledgement | skip |
    | Gmail | opted in, with the acknowledgement | run |
    | Slack | no opt-in | skip |
    | Slack | opted in with the acknowledgement, by an opt-in that doesn't name the provider | skip |
    | Slack | opted in by an opt-in that names the provider, without the acknowledgement | skip |
    | Slack | opted in by an opt-in that names the provider, with the acknowledgement | run |
    | channel-hello | no opt-in | skip |
    | channel-hello | opted in, without the acknowledgement, which only Gmail, Slack and SMS content need | run |

    - The disclosure is rendered immediately before the opt-in.
    - Loosening happens only by admin op.
    - Auto-draft is excluded by class, and never starts a SIWC request.
  - **Fields rows:** no non-allowlisted field leaves in any captured SIWC request.
  - This item merges with these M7 cells only. The SMS cells, and the cells for agent tokens and MCP, are M7.S9c's.
- **Owns.** `apps/hub/test/ai-providers/rows/siwc.ts`, `apps/hub/test/ai/siwc/{rows.test,egress.heavy.test}.ts` and one line in H18. If it merges after M7.S4, or M7.S4 is dropped (a "no" to OpenAI's question 1a), also the deletion of `spikes/s07-siwc/` (except `notes/sources.md`) and the spike's `pnpm-lock.yaml` importer.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/rows.test.ts`, then the same command for `test/ai-providers/corpus.test.ts`, `test/ai-providers/policy-matrix.test.ts` and `test/ai-providers/fields.test.ts`, one file each, pass with the SIWC rows:
    - `rows.test.ts` asserts that `PROVIDER_ROWS` lists the SIWC row file, so a missing line fails;
    - recipients unchanged, flags raised, no non-allowlisted field in any captured request, and each row of the table above with its expected run or skip.
  - With `DRAFTYAK_STRICT_SKIPS=1` set, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/ai/siwc/egress.heavy.test.ts`: the recorder's result lists only the auth host and the API host, a positive control that tries another host is recorded and fails the comparison, and the result reads back through M2.17b's reader.
- **Starts** after M7.S5c, M7.S6, M7.S8b, M7.4, M7.5, M7.6, M7.7, M7.11 and M2.17b are on `m7`.

### M7.S9b The SIWC row of M7b's obedient-model suite
- **Inputs.** §13's obedient-model suite (every provider; provider requests carry no new tools); M7b.10's provider-row registry (H19); ADR 0009's `submit_draft` placement.
- **Outputs.** The siwc mode's row in M7b.10's obedient-model suite, landing on `m7b`.
- **Owns.** `apps/hub/test/security/context-lookups/siwc.ts`, `apps/hub/test/ai/siwc/obedient-row.test.ts` and one line in H19.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/obedient-row.test.ts`: `OBEDIENT_PROVIDERS` lists the siwc mode, so a missing line fails.
  - With `DRAFTYAK_STRICT_SKIPS=1` set, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/security/context-lookups.heavy.test.ts` passes with the SIWC row: no extra `tool_runs`, and no tool beyond the single pinned `submit_draft` entry. Each request offers exactly that entry, wherever ADR 0009 places it: in the top-level tools, in a namespace or as the single `additional_tools` input item.
- **Starts** after M7.S9 and M7b.10 are on `m7b`. Its branch is `m7b-<nn>-<slug>`.

### M7.S9c The SIWC cross-stream cells: SMS, agent tokens, MCP
- **Inputs.** §12's rule for cross-stream checks: they run in whichever stream lands last, and on a no-go they are dropped, not failed. M7.S9's rows; M8.2's MCP tools and agent tokens; on the owner's S12 go, M1.23's SMS contracts and M6b's FakeSmsHost.
- **Outputs.**
  - **SMS cells:** SMS × `cloud-consumer-plan` × consent state in the policy matrix, with the SMS disclosure and Gmail's three rows and outcomes from M7.S9's table, since SMS follows Gmail's rules.
  - **Agent-token and MCP cells:** an agent token or an MCP request never starts a SIWC request.
  - On an S12 no-go, the SMS cells are dropped, not failed, and the gate report says so.
- **Owns.** `apps/hub/test/ai-providers/rows/siwc-cross-stream.ts`, `apps/hub/test/ai/siwc/cross-stream-rows.test.ts` and one line in H18.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/cross-stream-rows.test.ts` and `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai-providers/policy-matrix.test.ts` pass with these cells, and `cross-stream-rows.test.ts` asserts that `PROVIDER_ROWS` lists their row file.
- **Starts** once M7.S9 and M8.2 are on the branch it lands on, and on an S12 go also M1.23 and M6b's FakeSmsHost. It lands on whichever of `m7`, `m8` and `m6b` lands last.

## Plan coverage

| Plan clause (§12 M7 row and the sections it cites) | Item | Acceptance command (intended) |
|---|---|---|
| Registration, per-hub `ext_agent_host_id`; calls to OpenAI (§9.2 SSRF and OAuth mix-up; guardrail 8) | M7.S1 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/discovery.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/registration.test.ts` |
| Port 1455 check, `prompt=consent`, scope check, sign-in as an admin op from the CLI | M7.S2 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/listener.test.ts`; `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-sign-in.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/ai/siwc/listener.heavy.test.ts` |
| The L2 calls of the approval-window sign-in, disconnect and transfer, as a contract PR into `m1` (§12 Contracts) | M1.29 | M1.29's acceptance in `docs/roadmap/m1.md` |
| Sign-in from the approval window (§9.3), over M1.29's authorization route, with the connect subject and the review of both kinds | M7.S2b | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin-window.test.ts`; `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_signin --test siwc_review` |
| Serialized refresh; tokens revoked at OpenAI on disconnect; no tokens in backups or logs | M7.S3 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/credential.test.ts`; `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-disconnect.test.ts` |
| Disconnect from the approval window (§9.3), with M1.29's disconnect subject | M7.S3b | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/disconnect-window.test.ts` |
| Revocation before an instance or the plugin is removed (§3 Data lifecycle; §4 Credential flow 5) | M7.S3c | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/removal.test.ts` |
| Documented transfer for a headless hub, over M1.29's transfer routes, with the ID-token, client and scope checks on receipt (§9.2 OAuth mix-up; §4 Credential flow 3) | M7.S4 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/transfer.test.ts`; `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_listener --test siwc_exchange --test siwc_handoff --test siwc_acl` |
| SIWC allowlist verifier (§4) and the models route (Changed since the plan); guardrail 4 | M7.S5 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/verifier.test.ts`; M2.19's own suite, with the ChatGPT-plan line registered |
| Streaming via host chunks; `submit_draft` never executed (§5); the captured request passes the verifier; the models list | M7.S5b | `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/request.test.ts`; `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/stream.test.ts`; `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/broker-refused.test.ts`; `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/models.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/siwc/contract.heavy.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/drafting.test.ts` |
| Destination class `cloud-consumer-plan` (§5) | M7.S5c | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/destination.test.ts` |
| Full error set; no silent billing switch; no background request (the SIWC Terms) | M7.S6 | `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/errors.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/no-billing-switch.test.ts` |
| SIWC UI (§5), its controls, state read and Manage usage link, and runbook step 8 (§14) | M7.S7 | `pnpm --filter @draftyak/web --fail-if-no-match exec vitest run src/ai/siwc/provider-slot.test.tsx`; `pnpm --filter @draftyak/web --fail-if-no-match exec vitest run src/ai/siwc/billing-slot.test.tsx`; `pnpm --filter @draftyak/web --fail-if-no-match exec vitest run src/ai/siwc/destinations.test.tsx`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/state.test.ts`; `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_links`; the runbook itself is an owner check |
| `siwc-auth` fake (§13) | M7.S8 | `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/siwc-auth.test.ts` |
| The responses-api fake's SIWC allowlist, errors, scripted models, models list and scripted redirects (§13) | M7.S8b | `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/responses-siwc.test.ts` |
| Corpus (at least 60), policy matrix, no non-allowlisted field, auto-draft never for SIWC; the egress scenario for M11's PRIVACY check | M7.S9 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/rows.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai-providers/corpus.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai-providers/policy-matrix.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai-providers/fields.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/ai/siwc/egress.heavy.test.ts` |
| Obedient-model suite (every provider) | M7.S9b | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/obedient-row.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/security/context-lookups.heavy.test.ts` |
| Cross-stream cells: SMS, agent tokens and MCP (§12) | M7.S9c | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/cross-stream-rows.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai-providers/policy-matrix.test.ts` |

## Changed since the plan
- **Sign-in, transfer and disconnect are admin ops** (owner decision D19 in `docs/roadmap/m1.md`, pending the owner's confirmation at the M0 gate, or before M1.20 merges if that is earlier). Plan §9.3 makes account connect and disconnect and API-key entry admin ops, but doesn't name SIWC. Without this rule, any paired device that the L2 snapshot admits could install tokens for an account of its choice. M1.20 adds the admin-op kind if no existing kind fits (H2).
- **SIWC tokens stay out of backups** (pending the owner's confirmation at the M0 gate). Plan §3 Backup includes credentials. The SIWC Terms keep persistent token storage local and under the user's control, and allow no transfer except as they permit. A backup file can leave the machine, and a restore onto another machine would move the tokens. So a backup skips SIWC tokens and the ID-token hint the vault keeps with them, a restore drops any it finds, and the owner signs in again (M7.S3). A per-kind filter in M2.12's backup tells them apart (H8); a separate data class would be an M1 contract change. If the owner declines, M7.S3 adds no H8 line, and SIWC tokens and the hint are backed up like other credentials.
- **A models list from the plan's API** (pending the owner's confirmation at the M0 gate). Guardrail 4 says Responses API only, and §4's SIWC allowlist names only `POST /v1/responses`. OpenAI's plan-usage docs list the models through `GET /v1/models`, whose answer is `{models: [{slug, display_name, visibility}]}` (spike S7's `notes/sources.md`), and the model picker needs it. So M7.S5's verifier also allows a bodiless `GET /v1/models` with no query, M7.S5b's `ai_models_list` maps each `visibility: "list"` entry to ai-provider-v1's `{id, name}` in the server's order, its `ai_probe` sends the same single request, and M7.S8b serves the list. If the owner declines, `ai_models_list` returns the hub's pinned model, `ai_probe` sends nothing upstream, and no `GET` leaves.

### Open items
Each is recorded here when it settles:
- the owner's M0-gate answers on `prompt=consent` and on what declining plan usage keeps;
- the owner's confirmation of the three changes above;
- ADR 0009's `submit_draft` placement and the host-ID format;
- how one `ai-responses-api` manifest declares both its api-key and siwc modes, when a manifest has one `auth` kind and one AI egress profile: ADR 0009's follow-up, which M1.25 records (M1.20);
- the fixed port 1455, and the broker's 1455 block as a plan change;
- each request under **Hooks in other items**, until its owner agrees;
- OpenAI's answers to these questions:
  - 1a, the headless transfer: a "no" means M7.S4's transfer doesn't ship and M1.29 leaves out its transfer parts. If neither M7.S4 nor M7.S9 has merged, M7.S9 deletes the spike. If either has, a PR on `m7` removes the transfer and, if it is still there, the spike, and a contract PR removes M1.29's transfer parts (Clean-room rules). The answer may come any time before launch;
  - 1b, whether a hub on a VPS or another remote machine may keep tokens at all, since the Terms bar persistent token storage "in a remote or managed environment": a "no" keeps SIWC off any hub that isn't on the owner's own computer, however the tokens would arrive, and points those hubs to the API-key alternative;
  - 2b, the licence link;
  - 5, whether plan usage follows the training setting: a "no" removes Slack content from SIWC and changes the Gmail and SMS acknowledgement text;
  - the logo-use question: until OpenAI's answer allows it, M7.S7 shows no ChatGPT logo;
- a `vendor-terms-watch` entry for the SIWC Terms, and `docs/compliance/openai.md`, both proposed and pending the owner's confirmation.
