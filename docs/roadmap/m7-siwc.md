# M7 backlog: Sign in with ChatGPT (clean-room)

> **Status:** draft of 2026-10-19, revised after review, written before the M0 gate. Backlog only: each item starts when its **Starts** line holds.
> **Source of truth:** the approved implementation plan, kept outside the repo; § numbers refer to it. Where this backlog and the plan differ, the plan wins, except for the owner decisions and verified facts under **Changed since the plan** and in ADR 0009.
> **Owner of this file:** the integration owner. M7's main backlog (`docs/roadmap/m7.md`) covers the API-key providers, routing and auto-draft; its Sign in with ChatGPT (SIWC) rows will point here. No other item writes SIWC code, fakes or stubs.
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
  - The tests that ADR 0009's Kept tests section lists move with the code they test.
  - M7.S9, the last item to absorb one, deletes `spikes/s07-siwc/` in its PR, except `notes/sources.md`. That file is the clean-room record, and vendor-guard treats it as data.
- SIWC test tokens live only in the local `.env.live`, never in CI secrets. CI runs on M7.S8's fakes.
- The SIWC Terms allow automated or background requests only with express consent, and another user's activity may not trigger them.
  - Every SIWC request comes from the owner's own on-demand action.
  - Auto-draft stays off for SIWC (§5) until OpenAI confirms background use, and agent-token or MCP requests never start one.

## Items

| # | Item | Size | Depends on | Lands on |
|---|---|---|---|---|
| M7.S1 | Registration and the per-hub host ID | M | M7.S8, M1.20 | m7 |
| M7.S2 | Sign-in as an admin op: PKCE, the transient 1455 listener, `prompt=consent`, the scope check | M | M7.S1, M2.17 | m7 |
| M7.S3 | SIWC credentials: storage, serialized refresh, revocation on disconnect | M | M7.S2, M2.17 | m7 |
| M7.S4 | The documented transfer for a headless hub | M | M7.S3, M4.7, M4.13 | m7 |
| M7.S5 | The broker's SIWC verifier | S | M2.19, M1.20 | m2 |
| M7.S5b | The siwc drafting mode: request builder, streaming, destination class | L | M7.S3, M7.S5, M7.4, M7.9, M1.12, M1.13 | m7 |
| M7.S6 | The full error set and no silent billing switch | M | M7.S5b, M7.4, M3.5 | m7 |
| M7.S7 | SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage | S | M7.S6, M7.5, M7.7 | m7 |
| M7.S8 | SIWC fakes | M | M1.20 | m7 |
| M7.S9 | SIWC rows of M7's corpus and policy matrix | S | M7.S6, M7.4, M7.6, M7.11 | m7 |
| M7.S9b | The SIWC row of M7b's obedient-model suite | S | M7.S9, M7b.10 | m7b |

Every item also needs ADR 0009 merged into `m0`. If ADR 0009 records Not run, the items wait for the owner's M0-gate decision, and M7 ships the API-key modes alone. Paths and commands below are the intended ones; packages that don't exist yet take these names when their milestones create them.

### M7.S1 Registration and the per-hub host ID
- **Inputs.** §5's SIWC row (`dynamic_agent_client` → issued client; a per-hub `ext_agent_host_id`; `agent_name_hint: "DraftYak"`); §4 Credential flow 2; ADR 0009's registration result and host-ID format; M1.20's `oauth2-dynamic-agent` descriptor.
- **Outputs.**
  - The hub registers once through `dynamic_agent_client` and keeps the issued client in its encrypted store.
  - One `ext_agent_host_id` per hub, in the format ADR 0009 records, is created once, kept in the encrypted store, and reused for every registration, sign-in and transfer.
  - Declining plan usage keeps the registration and stores no tokens. This follows the owner's M0-gate answer; see Changed since the plan.
- **Owns.** `apps/hub/src/ai/siwc/registration.ts` and `apps/hub/test/ai/siwc/registration.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub exec vitest run test/ai/siwc/registration.test.ts`, on the siwc-auth fake:
  - two sign-ins and a transfer carry the same host ID, and the ID survives a hub restart;
  - a second hub (another `--profile`) gets a different ID;
  - after a decline, the store holds the issued client and the host ID and no token, and turning plan usage on reuses them with `prompt=consent`.
- **Starts** after ADR 0009 merges into `m0` and M1.20 into `m1`.

### M7.S2 Sign-in as an admin op: PKCE, the transient 1455 listener, `prompt=consent`, the scope check
- **Inputs.**
  - §4 Credential flow 2 and 3; §1's transient listener row; §9.2 (SSRF, OAuth mix-up, DNS rebinding, CSRF, token in URL); §9.3 admin ops.
  - ADR 0009.
  - The admin-op kind M1.20 adds for an AI-instance credential's connect and disconnect.
  - The owner's M0-gate answers on `prompt=consent` and on what a declined plan keeps.
- **Outputs.**
  - **The sign-in is an admin op.** It can be started only from the desktop approval window (or the hub CLI with the PIN) by a confirmed approver. It is inert in the loopback browser and on mobile.
  - **The transient listener on `127.0.0.1:1455`:**
    - It checks the port first, including a wildcard holder on Windows, and refuses with a clear error if anything holds it.
    - It opens for one sign-in flow only and answers only `GET` on the OpenAI redirect path, with the expected Host and `state`.
    - It closes after success, failure, cancellation or timeout.
    - It has its own route snapshot, with the callback route only.
  - **`prompt=consent`** follows the owner's M0-gate answer.
    - The plan as written sends it on every sign-in until OpenAI confirms the deployment.
    - The proposed fix, which spike S7 already follows, sends it only when the owner turns plan usage on, including after a decline, with the saved client.
  - **The scope check:** after the code exchange, the granted scopes are checked (ported from spike S7's plan-usage check).
    - Without `chatgpt.tokens.use.direct`, plan usage stays off and no SIWC drafting request goes out.
    - M7.S7 then offers two explicit owner actions: turn plan usage on, or "Use an OpenAI API key instead".
- **Owns.** `apps/hub/src/ai/siwc/{signin,listener,scopes}.ts`, the listener's route snapshot, `apps/hub/test/ai/siwc/signin.test.ts` and `apps/hub/test/ai/siwc/listener.heavy.test.ts`.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub exec vitest run test/ai/siwc/signin.test.ts`, covering:
    - a wrong, missing or replayed `state`;
    - a second callback, or one after close;
    - `error=access_denied` exchanges nothing;
    - ID tokens with a bad or missing signature, or a wrong `iss`, `aud`, `exp` or `nonce`;
    - another `sub`, or another host ID's registration, is refused;
    - `redirect_uri` is identical in the request and the exchange;
    - the chosen `prompt=consent` rule, on an ordinary sign-in and on the plan-enable path;
    - with the scope missing, nothing goes to SIWC, and no API-key instance is created or used until the owner acts;
    - a start from the loopback browser, a mobile device or an unconfirmed device is refused.
  - `pnpm --filter @draftyak/hub exec vitest run --mode heavy test/ai/siwc/listener.heavy.test.ts`: a fixed-port test, spike S7's port test moved in rather than imported.
    - It takes the machine-wide lock through the product test kit's lock helper; spikes' kit can't be imported.
    - It covers a port already held, the route snapshot, and the listener closed in every outcome.
  - M2.17's blocked ports include 1455, with a hostile-plugin case: `ctx.fetch` to `127.0.0.1:1455` is refused while the listener is open. This is to be requested from M2.17's owner, since M0.12's list lacks the port.
- **Starts** after M7.S1 and the owner's M0-gate answers.

### M7.S3 SIWC credentials: storage, serialized refresh, revocation on disconnect
- **Inputs.**
  - §4 Credential flow 4 and 5; §3 Backup and Restore; §9.2 (theft of disk, backups or logs); guardrail 8.
  - M2.17's per-credential mutex, its refresh hook and its guarded fetch.
  - The AI-instance disconnect hook that M7.3 or an M3 lifecycle item names.
  - M0.27's revocation evidence and handoff.
  - The SIWC Terms: persistent token storage stays local and under the user's control, and no transfer is allowed except as the Terms permit.
- **Outputs.**
  - **Storage.** Tokens live only in the hub's encrypted store. `draftyak backup` leaves SIWC tokens out, and a restore drops any it finds, so the owner signs in again.
  - **Refresh.** The siwc credential refreshes under M2.17's mutex through the broker's refresh hook, with no second mutex (as M5.10 does for Gmail). The rotated refresh token is persisted before its first use.
  - **Calls to OpenAI.** Every hub-side call to the OpenAI auth host (discovery, JWKS, registration, token, refresh, revoke) goes through M2.17's guarded fetch: https, the issuer's origin only, no redirects. The auth and API hosts are listed for PRIVACY.md and the Security Center.
  - **Disconnect.** It is an admin op: revoke at OpenAI, then delete locally.
    - Revocation is confirmed as M0.27 defines it: a 200, then the revoked refresh token refused with `invalid_grant`, `invalid_refresh_token` or `refresh_token_invalidated`.
    - A 429, a 5xx, no answer, `refresh_token_reused` or expiry never confirms it. On the unconfirmed path the hub still clears its tokens and tells the owner to remove DraftYak in ChatGPT's Sign in with ChatGPT settings.
- **Owns.** `apps/hub/src/ai/siwc/credential.ts`, `apps/hub/test/ai/siwc/credential.test.ts`, one registration line at the disconnect hook, and one exclusion line in the backup's data-class list.
- **Acceptance.** `pnpm --filter @draftyak/hub exec vitest run test/ai/siwc/credential.test.ts`, on the siwc-auth fake:
  - concurrent requests make one refresh;
  - a failure between rotation and first use leaves the new token stored;
  - the old refresh token is never sent again;
  - disconnect records the revoke before the local deletion, on both the confirmed and the unconfirmed path;
  - a plaintext token canary never appears in logs, audit, events, the db or `-wal`, URLs, plugin argv, env or stdio, or `ctx.fetch` frames;
  - a backup holds no SIWC token, and a restore asks for a new sign-in.
- **Starts** after M7.S2 and M2.17.

### M7.S4 The documented transfer for a headless hub
- **Inputs.**
  - §4 Credential flow 2 (headless hub).
  - ADR 0009's transfer result and M0.27's transfer handoff (order and failure rules).
  - M4's browser hook and L2 route snapshots (M4.7) and its admin pending operations (M4.13), as agreed in the M4 backlog.
  - The SIWC Terms' transfer clause.
  - OpenAI's answer to questions 1a/1b. It decides only whether the transfer ships enabled, and the owner settles that before launch.
- **Outputs.**
  - The hub creates a pending admin op for the flow (the AI-instance connect kind from M1.20), opened through the approval window by a confirmed desktop approver with the PIN.
  - That desktop runs the flow with the hub's host ID and registration. Its local listener follows M7.S2's rules: the port check, one flow, the callback route only, and closing in every outcome.
  - The hub's single L2 route takes exactly one credential:
    - for its own pending flow;
    - from the approver that completed that PIN approval;
    - once, within a short window.
  - **Handoff order:** serialise the tokens, wipe the desktop store, then send. The desktop revokes its own copy if the hub refuses, returns no result, or takes the tokens without refreshing or revoking them.
  - `siwc_*` native modules in `apps/app` use M4's hooks with agreed command registration, as M5.20 adds `gmail_*` modules. The FakeDevice path ships first, and the desktop UI follows after M4.
- **Owns.** The `siwc_*` modules in `apps/app/src-tauri/src/` and their Rust tests; `apps/hub/src/ai/siwc/transfer.ts` and `apps/hub/test/ai/siwc/transfer.test.ts`; the route's line in M4.7's snapshot.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub exec vitest run test/ai/siwc/transfer.test.ts`, on fakes:
    - the hub receives the tokens over L2, bound to its host ID and its pending flow;
    - the desktop process, its store and its logs keep no copy.
  - Hostile cases are refused:
    - an unconfirmed or revoked device;
    - a mobile or browser role;
    - a wrong host ID or issuer;
    - another client or `sub` for a known account;
    - a replay, or a second flow;
    - an oversized or malformed body.
  - Each handoff failure path ends with the desktop's copy revoked. The Rust modules' tests run with `cargo test` in the app crate.
- **Starts** after ADR 0009 records the transfer, and M4.7 and M4.13 merge.

### M7.S5 The broker's SIWC verifier
- **Inputs.** §4 AI request verifiers (the SIWC allowlist); guardrail 4; TB3 (credentials never in plugins); M2.19's per-profile verifier registry; M1.20's ChatGPT-plan profile id; ADR 0009 on `text.format` versus `submit_draft` and on top-level versus namespaced tools.
- **Outputs.** A pure verifier that the broker imports, registered with one line under the ChatGPT-plan `AI_HTTP_PROFILES` id at M2.19's registry point. It allows only:
  - §4's nine `POST /v1/responses` fields: `model`, `instructions`, `input`, `tools=[submit_draft]` (strict, never executed), `tool_choice`, `text`, `reasoning`, `stream:true` and `store:false`;
  - any route that ADR 0009's confirmed plan changes add (spike S7 also allows a bodiless `GET /v1/models`).

  It shares one hostile-request table with M7.S8's fake, so the two copies of the allowlist can't drift.
- **Owns.** The SIWC verifier file at M2.19's registration point, its test, and the shared hostile-request table.
- **Acceptance.** M2.19's verifier test command runs these cases beside the three API-key allowlists, each as a hostile vector through the verifier and the broker path:
  - **values:** `store:true` or no `store`; `stream:false`; a different or second tool, or anything other than the pinned `submit_draft` JSON; `function_call_output` input items;
  - **origin:** any host other than the API host, including ChatGPT's private backend (that URL is built at run time, as spike S7's test does, so vendor-guard stays clean); `http:`; a URL with userinfo or a query;
  - **path and method:** any other path or method;
  - **headers:** a header outside the allowlist, or a plugin-supplied Authorization header;
  - **flow:** a redirect, or more than one `POST /v1/responses` per attempt.

  The plugin holds only a placeholder key; the broker injects the access token after verification.
- **Starts** after ADR 0009 merges into `m0`, M1.20 into `m1` and M2.19 into `m2`.

### M7.S5b The siwc drafting mode: request builder, streaming, destination class
- **Inputs.**
  - §5's SIWC row: destination `cloud-consumer-plan`, and a strict `submit_draft` function tool that is never executed.
  - ai-provider-v1 (`ai_describe`, `ai_models_list`, `ai_probe`, `ai_draft_generate`; refusal, truncation and no tool call are outcomes, not errors).
  - The host channel's `host/stream.chunk` (M1.12, M1.13 and the hub side of streamed `host/fetch`, after the ADR 0003 decision).
  - M7.4's byte and event caps; M7.9's mode handling in `plugins/ai-responses-api`; M7.5's destination table.
- **Outputs.**
  - The siwc mode of `plugins/ai-responses-api`, beside M7.9's api-key mode:
    - `ai_describe`, `ai_models_list` (the only user of `GET /v1/models`), `ai_probe` and `ai_draft_generate`;
    - the request builder, using the pinned `openai` SDK through `ctx.fetch` with a placeholder key, like the API-key factory;
    - streaming over `ctx.fetch` with `host/stream.chunk`, under M7.4's caps;
    - progress at least every 10 s.
  - The mode declares its destination class, `cloud-consumer-plan`, in the table M7.5 reads (one line, requested from M7.5's owner).
  - Nothing under `apps/hub` imports `openai`.
- **Owns.**
  - `plugins/ai-responses-api/src/siwc/`, with its tests.
  - One line in the mode switch M7.9 provides. It is requested from M7.9's owner, and its file and line will be named there.
  - The destination-table line.
- **Acceptance.**
  - `pnpm --filter @draftyak/plugin-ai-responses-api exec vitest run src/siwc` covers:
    - `submit_draft` arguments only parsed as `DraftOutput`;
    - stream splits at 1, 7 and 4,096 bytes giving the same draft (spike S7's `stream.test.ts`, moved in);
    - refusal, incomplete and no-tool-call outcomes.
  - `aiProviderContract()` and `runConformance` pass under production flags.
  - An import scan shows `apps/hub` never imports `openai`.
- **Starts** after M7.S3 and M7.S5, M7.4, M7.9 and the host channel's streamed fetch.

### M7.S6 The full error set and no silent billing switch
- **Inputs.** §5's seven SIWC errors (usage limit, unavailable, not eligible, unsupported capability, route not supported, invalid user, scope not authorized); Owner decisions (ChatGPT: no silent billing switches); plugin-error-v1; spike S7's error table; ADR 0009's recorded shapes; M7.4's execution path and M3.5's draft job.
- **Outputs.**
  - Each of the seven errors maps to a plugin-error-v1 code and a visible owner choice: wait, Manage usage, sign in again, or switch to an API key only by explicit action.
  - The choices show through M7.S7's slots.
  - The hub's draft job never re-routes a failed SIWC draft. It does no retry on another instance and no repair through another provider.
- **Owns.** `plugins/ai-responses-api/src/siwc/errors.ts` with its tests, and `apps/hub/test/ai/siwc/no-billing-switch.test.ts`.
- **Acceptance.**
  - The plugin tests assert each error's code and choice.
  - `pnpm --filter @draftyak/hub exec vitest run test/ai/siwc/no-billing-switch.test.ts` runs M7.4's execution path with a SIWC instance, an API-key Responses instance and an Anthropic instance, all on fakes. It injects:
    - each of the seven errors, both as an HTTP status and as an in-stream `response.failed`;
    - the missing-scope case;
    - the credential refusals (`PLAN_USAGE_DISABLED`, `REAUTH_REQUIRED`).

    It asserts that the other fakes record zero requests, that the job ends with the error and its choice, and that the hub's one repair retry doesn't re-route.
- **Starts** after M7.S5b, M7.4 and M3.5.

### M7.S7 SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage
- **Inputs.** §5's SIWC UI; §8's AI screens; §14 step 8; the provider-UI slots that M7.5 (provider screen) and M7.7 (draft billing line) name in `apps/web`; M4.13's admin pending operations.
- **Outputs.**
  - A text-only "Continue with ChatGPT" button. It opens M7.S2's admin op through the approval window, and is inert in the loopback browser and on mobile.
  - The "Using ChatGPT plan" label and the "Manage usage" link.
  - M7.S6's error choices and M7.S2's API-key offer, shown in the same slots.
  - No ChatGPT logo until OpenAI's reply to the logo-use question allows it. The M7.5 and M7.7 files hold no SIWC code.
  - The SIWC section of the owner runbook (§14 step 8), written as an owner check: setup, exact steps, what the owner sees, failure handling and duration. It needs a real ChatGPT plan, so it never runs in CI.
- **Owns.** `apps/web/src/ai/siwc/` with its tests, one mount line per slot, and `docs/runbook/siwc.md`, which the M11 runbook includes.
- **Acceptance.** `pnpm --filter @draftyak/web exec vitest run src/ai/siwc` tests:
  - all three elements;
  - the button inert outside the desktop;
  - each error choice.
- **Starts** after M7.S6, M7.5 and M7.7.

### M7.S8 SIWC fakes
- **Inputs.** §13 Fakes (`siwc-auth`; the responses-api fake's SIWC errors); spike S7's clean-room fakes (`test/fake-auth.ts`, `test/fake-responses.ts`); M7.11's fake option.
- **Outputs.**
  - `packages/fakes/src/siwc-auth.ts`, which provides:
    - discovery and JWKS;
    - registration;
    - the PKCE code exchange with ID tokens;
    - rotating refresh and revoke;
    - grants with and without `chatgpt.tokens.use.direct`.
  - `packages/fakes/src/responses-siwc.ts`, which holds:
    - the allowlist check, from M7.S5's shared table;
    - the documented unsupported fields;
    - the seven SIWC errors, both as HTTP statuses and in-stream.

  The responses-api fake composes this module through the option M7.11 names, so `responses-api.ts` holds no SIWC code.
- **Owns.** Those two files, `packages/fakes/test/{siwc-auth,responses-siwc}.test.ts`, and one export line each in `packages/fakes/src/index.ts`.
- **Acceptance.** `pnpm --filter @draftyak/fakes exec vitest run test/siwc-auth.test.ts test/responses-siwc.test.ts`:
  - siwc-auth refuses a replayed code, a wrong verifier, a mismatched `redirect_uri`, an unknown client, and a reused or revoked refresh token;
  - responses-siwc rejects each non-allowlisted body field, the documented unsupported fields and any other route;
  - responses-siwc emits each of the seven errors both ways.

  CI needs no SIWC credentials.
- **Starts** after ADR 0009 merges into `m0` and M1.20 into `m1`.

### M7.S9 SIWC rows of M7's corpus and policy matrix
- **Inputs.**
  - §5 Routing policy: `cloud-consumer-plan` is a per-account opt-in, with the disclosure immediately before consent. Gmail, Slack and SMS content also need the training-off acknowledgement, and loosening is an admin op.
  - §5 Triggers: auto-draft only on `local` and `cloud-no-train`, never SIWC.
  - §12 M7 acceptance; the SIWC Terms clause above.
  - M7.6's corpus and policy-matrix suites, and M7.11's scripted fakes.
- **Outputs.**
  - SIWC rows added through each suite's provider-row registry. The registry is one line per provider, requested from M7.6's owner so these rows never edit the suite files.
  - **Corpus rows:** the corpus (at least 60 cases) runs for siwc mode.
  - **Policy-matrix rows:** for each channel (Gmail, Slack, SMS, channel-hello), `cloud-consumer-plan` × consent state (none; opted in without the acknowledgement; opted in with it) gives run or skip, with the chip reason.
    - The disclosure is rendered immediately before the opt-in.
    - Loosening happens only by admin op.
    - Auto-draft is excluded by class.
    - No path other than the owner's on-demand action starts a SIWC request: not auto-draft, not agent tokens, not MCP.
  - When this lands, the PR deletes `spikes/s07-siwc/` except `notes/sources.md`.
- **Owns.** The SIWC row files under `plugins/ai-responses-api/src/siwc/test/rows/`, and one registry line per suite.
- **Acceptance.** `pnpm --filter @draftyak/hub exec vitest run test/ai-providers/corpus.test.ts test/ai-providers/policy-matrix.test.ts` passes with the SIWC rows: recipients unchanged, flags raised, and every matrix cell as above.
- **Starts** after M7.S6, M7.4, M7.6 and M7.11.

### M7.S9b The SIWC row of M7b's obedient-model suite
- **Inputs.** §13's obedient-model suite (every provider); M7b.10's provider-row registry (requested from M7b.10's owner).
- **Outputs.** The siwc mode's row in M7b.10's obedient-model suite, landing on `m7b`.
- **Owns.** One row file and one registry line.
- **Acceptance.** M7b.10's heavy test command passes with the SIWC row: no extra `tool_runs`, and no tools in provider requests.
- **Starts** after M7.S9 and M7b.10.

## Plan coverage

| Plan clause (§12 M7 row and the sections it cites) | Item | Acceptance command (intended) |
|---|---|---|
| Registration, per-hub `ext_agent_host_id` | M7.S1 | `pnpm --filter @draftyak/hub exec vitest run test/ai/siwc/registration.test.ts` |
| Port 1455 check, `prompt=consent`, scope check, sign-in as an admin op | M7.S2 | `... test/ai/siwc/signin.test.ts`; `... --mode heavy test/ai/siwc/listener.heavy.test.ts` |
| Serialized refresh; tokens revoked at OpenAI on disconnect; no tokens in backups or logs | M7.S3 | `... test/ai/siwc/credential.test.ts` |
| Documented transfer (headless hub) | M7.S4 | `... test/ai/siwc/transfer.test.ts`; `cargo test` in the app crate |
| SIWC allowlist verifier (§4); guardrail 4 | M7.S5 | M2.19's verifier test command |
| Streaming via host chunks; `submit_draft` never executed (§5); destination class | M7.S5b | `pnpm --filter @draftyak/plugin-ai-responses-api exec vitest run src/siwc`; `aiProviderContract()` |
| Full error set; no silent billing switch | M7.S6 | `... test/ai/siwc/no-billing-switch.test.ts` |
| SIWC UI (§5) and runbook step 8 (§14) | M7.S7 | `pnpm --filter @draftyak/web exec vitest run src/ai/siwc` |
| `siwc-auth` and SIWC error fakes (§13) | M7.S8 | `pnpm --filter @draftyak/fakes exec vitest run test/siwc-auth.test.ts test/responses-siwc.test.ts` |
| Corpus (at least 60), policy matrix, auto-draft never for SIWC | M7.S9 | `... test/ai-providers/corpus.test.ts test/ai-providers/policy-matrix.test.ts` |
| Obedient-model suite (every provider) | M7.S9b | M7b.10's heavy test command |

## Changed since the plan
- **Sign-in, transfer and disconnect are admin ops** (pending the owner's confirmation at the M0 gate). Plan §9.3 makes account connect and disconnect and API-key entry admin ops, but doesn't name SIWC. Without this rule, any paired device that the L2 snapshot admits could install tokens for an account of its choice. M1.20 adds the admin-op kind if no existing kind fits.

### Open items
Each is recorded here when it settles:
- the owner's M0-gate answers on `prompt=consent` and on what declining plan usage keeps;
- ADR 0009's `submit_draft` placement and the host-ID format;
- the fixed port 1455, and the broker's 1455 block as a plan change;
- OpenAI's answers to questions 1a/1b (headless transfer), 2b (the licence link) and 5 (whether plan usage follows the training setting). A "no" to 5 removes Slack content from SIWC and changes the Gmail and SMS acknowledgement text.
