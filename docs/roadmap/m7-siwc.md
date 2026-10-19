# M7 backlog: Sign in with ChatGPT (clean-room)

> **Status:** draft of 2026-10-19, written before the M0 gate. Backlog only: no item starts until its **Starts** line holds.
> **Source of truth:** the approved implementation plan, kept outside the repo; § numbers refer to it. Where this backlog and the plan differ, the plan wins, except for the owner decisions and verified facts recorded here and in ADR 0009.
> **Owner of this file:** the integration owner. M7's main backlog (`docs/roadmap/m7.md`) covers the API-key providers, routing and auto-draft, and points its Sign in with ChatGPT (SIWC) rows here. No other item writes SIWC code, fakes or stubs.
> **Done when** the SIWC clauses of §12's M7 row pass their acceptance below: registration, per-hub host ID, the port 1455 check, the documented transfer, serialized refresh, streaming through host chunks, the full error set, `prompt=consent`, and revocation on disconnect. These also run in M7's shared checks: the policy matrix with no non-allowlisted field and no silent billing switch, the corpus (at least 60 cases), and auto-draft never firing for SIWC.

## Clean-room rules
- The implementation follows OpenAI's public documentation, the SIWC Terms and ADR 0009 only.
- It never uses or reads:
  - the noncommercial DevKit or any `@siwc` package (vendor-guard bans them);
  - Codex's client, its source or its per-user auth file;
  - ChatGPT's private backend API (guardrail 4).
- S7's spike code under `spikes/s07-siwc/` may be ported into product files, never imported (m0.md: spikes are never imported). ADR 0009's kept tests move with the code they test.
- SIWC test tokens live only in the local `.env.live`, never in CI secrets. CI runs on the fakes from M7.S8.
- The Terms allow automated or background requests only with express consent. Every SIWC request comes from an owner action, and auto-draft stays off for SIWC (§5) until OpenAI confirms background use.

## Starts
Every item starts after both of these merge:
- ADR 0009 (S7) into `m0`;
- M1.20 into `m1`, with the per-mode auth and profile choice recorded there.

If ADR 0009 records Not run, the items wait for the owner's M0-gate decision, and M7 ships the API-key modes alone. M7.S8 (fakes) comes first. M7.S4 also waits for M4's L2 and browser hooks. M7.S5's verifier lands on `m2` after M2.19; everything else lands on `m7`.

## Items

| # | Item | Size | Depends on |
|---|---|---|---|
| M7.S1 | Registration and the per-hub host ID | M | M7.S8 |
| M7.S2 | Sign-in: PKCE, the transient 1455 listener, `prompt=consent` and the scope check | M | M7.S1 |
| M7.S3 | SIWC credentials: storage, serialized refresh, revocation on disconnect | M | M7.S2, M2.17 |
| M7.S4 | The documented transfer for a headless hub | M | M7.S3, M4 hooks |
| M7.S5 | The siwc drafting mode: request builder, broker verifier and streaming | L | M7.S3, M2.19, M7.4 |
| M7.S6 | The full error set and no silent billing switch | M | M7.S5 |
| M7.S7 | SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage | S | M7.S6, M7.5, M7.7 |
| M7.S8 | SIWC fakes | M | M1.20 |
| M7.S9 | SIWC rows of the shared suites | S | M7.S6, M7b.10 |

### M7.S1 Registration and the per-hub host ID
- **Inputs.** §5's SIWC row (`dynamic_agent_client` → issued client; a per-hub `ext_agent_host_id`; `agent_name_hint: "DraftYak"`); §4 Credential flow 2; ADR 0009's registration result; M1.20's `oauth2-dynamic-agent` descriptor.
- **Outputs.**
  - The hub registers once per hub through `dynamic_agent_client` and stores the issued client in its encrypted store.
  - One `ext_agent_host_id` per hub is generated once, kept in the encrypted store, and reused for every registration, sign-in and transfer (M7.S4).
  - Declining plan usage keeps the registration and stores no tokens (the open gate-note item; follows the owner's answer).
- **Owns.** `apps/hub/src/ai/siwc/registration.ts` and its tests.
- **Acceptance.**
  - On the siwc-auth fake, two sign-ins and a transfer carry the same host ID, and the ID survives a hub restart.
  - A second hub (another `--profile`) gets a different ID.
  - ADR 0009's kept registration tests pass on the fake.

### M7.S2 Sign-in: PKCE, the transient 1455 listener, `prompt=consent` and the scope check
- **Inputs.** §4 Credential flow 2 and 3; §1's transient listener row; ADR 0009; the owner's M0-gate answers on `prompt=consent` and on what a declined plan keeps.
- **Outputs.**
  - **The transient listener on `127.0.0.1:1455`.** It checks the port first and refuses with a clear error if anything holds it.
    - It opens for one sign-in flow only, serves only the OpenAI redirect path, and closes after success, failure, cancellation or timeout.
    - It has its own route snapshot, with the callback route only. The broker's 1455 block stays with M2.17.
  - **`prompt=consent`** follows the owner's M0-gate answer.
    - The plan as written sends it on every sign-in until OpenAI confirms the deployment.
    - The proposed fix, which S7's spike already follows, sends it only when the owner turns plan usage on, including after a decline, with the saved client.
    - Record the answer as a plan change in ADR 0009's Decision and under this file's Changed since the plan.
  - **The scope check.** After the code exchange, check the granted scopes (porting S7's plan-usage check).
    - Without `chatgpt.tokens.use.direct`, plan usage stays off and no SIWC drafting request goes out.
    - M7.S7's slot then offers two explicit owner actions: turn plan usage on (sign in again with `prompt=consent`), or "Use an OpenAI API key instead".
- **Owns.** `apps/hub/src/ai/siwc/{signin,listener,scopes}.ts`, the listener's route snapshot, and their tests.
- **Acceptance.**
  - A fixed-port heavy test runs under the machine-wide lock. It is S7's port test moved into the product, not imported.
  - The route snapshot is checked.
  - The listener is closed in every outcome.
  - A test asserts the chosen `prompt=consent` rule on an ordinary sign-in and on the plan-enable path.
  - With the scope missing, nothing goes to SIWC, and no API-key instance is created or used until the owner acts.

### M7.S3 SIWC credentials: storage, serialized refresh, revocation on disconnect
- **Inputs.** §4 Credential flow 4 and 5; M2.17's per-credential mutex and the broker's refresh hook; the AI-instance disconnect hook that M7.3 or an M3 lifecycle item names; M0.27's revocation evidence; the SIWC Terms' rule that persistent token storage is local and under the user's control.
- **Outputs.**
  - **Storage and refresh.** Tokens live only in the hub's encrypted store. The siwc credential refreshes under M2.17's mutex through the broker's refresh hook, with no second mutex (as M5.10 does for Gmail), and the rotated refresh token is persisted before its first use.
  - **Disconnect.** It revokes the refresh and access tokens at OpenAI, then deletes them locally.
    - The revocation is confirmed as M0.27 does: the old refresh token is refused.
    - If it can't be confirmed, the owner is told to remove DraftYak in ChatGPT's Sign in with ChatGPT settings.
- **Owns.** `apps/hub/src/ai/siwc/credential.ts` and its tests, plus one registration line at the disconnect hook.
- **Acceptance** on the siwc-auth fake:
  - concurrent requests make one refresh;
  - a failure between rotation and first use leaves the new token stored;
  - the old refresh token is never sent again;
  - disconnect records the revoke before the local deletion.

### M7.S4 The documented transfer for a headless hub
- **Inputs.**
  - §4 Credential flow 2 (headless hub).
  - ADR 0009's transfer result.
  - M4's browser hook and L2 route snapshots, agreed with M4.2's and M4.7's owner through integration-status.md.
  - The SIWC Terms' transfer clause.
  - OpenAI's answer to questions 1a/1b. It decides only whether the transfer ships enabled, and the owner settles that before launch.
- **Outputs.**
  - The desktop runs the flow with the hub's `ext_agent_host_id` and registration, hands the tokens to the hub over one L2 route, then forgets them.
  - `siwc_*` native modules in `apps/app` use M4's hooks with agreed command registration, the way M5.20 adds `gmail_*` modules.
  - The FakeDevice path ships first; the desktop UI follows after M4.
- **Owns.** The `siwc_*` modules in `apps/app/src-tauri/src/`, the L2 route handler in `apps/hub/src/ai/siwc/transfer.ts`, and their tests.
- **Acceptance** on fakes:
  - the hub receives the tokens over L2, bound to its host ID;
  - the desktop process, its store and its logs keep no copy.

### M7.S5 The siwc drafting mode: request builder, broker verifier and streaming
- **Inputs.**
  - §4 AI request verifiers (SIWC allowlist).
  - §5's SIWC row: a strict `submit_draft` function tool that is never executed.
  - ADR 0009 on `text.format` versus `submit_draft`, and on top-level versus namespaced tools.
  - M2.19's per-profile verifier registry.
  - M7.4's byte and event caps.
  - The host channel's `host/stream.chunk` (M2.16).
  - M7.9's open mode handling in `plugins/ai-responses-api`.
- **Outputs.**
  - The siwc request builder in `plugins/ai-responses-api`, beside M7.9's api-key mode.
  - The broker's SIWC verifier, a pure function the broker imports. It is registered with one line under the ChatGPT-plan `AI_HTTP_PROFILES` id at M2.19's registry point. It allows only §4's nine `POST /v1/responses` fields (`model`, `instructions`, `input`, `tools=[submit_draft]`, `tool_choice`, `text`, `reasoning`, `stream:true`, `store:false`), plus any route that ADR 0009's confirmed plan changes add (S7 also allows a bodiless `GET /v1/models`).
  - Streaming over the same path as api-key mode: `ctx.fetch` with `host/stream.chunk` from the plugin process (M7.4's caps apply).
- **Owns.**
  - The siwc mode under `plugins/ai-responses-api/src/siwc/`, with one line in the plugin's mode table.
  - The SIWC verifier file at M2.19's registration point.
  - Their tests, including S7's `stream.test.ts`, moved in as ADR 0009's kept test.
- **Acceptance.**
  - `submit_draft` arguments are only parsed as `DraftOutput` and never executed.
  - Any other field or route is refused.
  - The stream splits at 1, 7 and 4,096 bytes give the same draft.
  - The verifier's cases run in M2.19's acceptance beside the three API-key allowlists.

### M7.S6 The full error set and no silent billing switch
- **Inputs.** §5's SIWC errors: usage limit, unavailable, not eligible, unsupported capability, route not supported, invalid user, scope not authorized. Also plugin-error-v1, S7's error table and ADR 0009's recorded shapes.
- **Outputs.**
  - Each of the seven errors maps to a plugin-error-v1 code and a visible owner choice: wait, Manage usage, sign in again, or switch to an API key, but only by explicit action.
  - The choices show through M7.S7's slots.
- **Owns.** `plugins/ai-responses-api/src/siwc/errors.ts` and its tests.
- **Acceptance.**
  - Each error, on the SIWC fake, asserts its code and the choice offered.
  - After every SIWC error, and in M7.S2's missing-scope case, no drafting request reaches api-key mode, an API-key instance or another provider until the owner picks that choice.

### M7.S7 SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage
- **Inputs.** §5's SIWC UI; §8's AI screens; the provider-UI slots that M7.5 (provider screen) and M7.7 (draft billing line) name in `apps/web`.
- **Outputs.**
  - The text-only "Continue with ChatGPT" button.
  - The "Using ChatGPT plan" label and the "Manage usage" link.
  - M7.S6's error choices and M7.S2's API-key offer, in the same slots.
  - No ChatGPT logo until OpenAI's reply to the logo-use question allows it.
- **Owns.** `apps/web/src/ai/siwc/` and one mount line per slot. Codex's files hold no SIWC code.
- **Acceptance.** An app test of all three elements, and the runbook text for §14 step 8.

### M7.S8 SIWC fakes
- **Inputs.** §13 Fakes (`siwc-auth`; the responses-api fake's SIWC errors); S7's clean-room fakes (`test/fake-auth.ts`, `test/fake-responses.ts`).
- **Outputs.**
  - `packages/fakes/src/siwc-auth.ts`, which provides:
    - discovery and JWKS;
    - registration;
    - the PKCE code exchange with ID tokens;
    - rotating refresh and revoke;
    - grants with and without `chatgpt.tokens.use.direct`.
  - A separate `packages/fakes/src/responses-siwc.ts`, which holds:
    - §4's SIWC allowlist check;
    - the documented unsupported fields;
    - the SIWC error replies.

  The responses-api fake composes it through an option that M7.11 names, so `responses-api.ts` holds no SIWC code.
- **Owns.** Those two files, their tests and one export line each in `packages/fakes/src/index.ts`.
- **Acceptance.** Every SIWC test in this file runs on these fakes, and CI needs no SIWC credentials.

### M7.S9 SIWC rows of the shared suites
- **Inputs.** §12 and §13: the obedient-model suite and the injection corpus run for every provider, and auto-draft never fires for SIWC. Also M7b.10's coverage row and M7's corpus run.
- **Outputs.**
  - The siwc mode's rows in M7b.10's obedient-model suite and M7's corpus run (at least 60 cases).
  - A policy-matrix row: auto-draft never fires for SIWC, and no non-allowlisted field leaves.
- **Owns.** The SIWC fixtures and rows that those suites load from `plugins/ai-responses-api/src/siwc/test/`.
- **Acceptance.**
  - The corpus and the obedient-model suite pass for siwc mode on the fakes, with recipients unchanged and flags raised.
  - An auto-draft trigger never reaches SIWC.

## Plan coverage

| Plan clause (§12 M7 row and the sections it cites) | Item |
|---|---|
| Registration, per-hub `ext_agent_host_id` | M7.S1 |
| Port 1455 check, `prompt=consent`, scope check (§4 flow 3) | M7.S2 |
| Serialized refresh; SIWC tokens revoked at OpenAI on disconnect (§4 flow 4, 5) | M7.S3 |
| Documented transfer (headless hub) | M7.S4 |
| Streaming via host chunks; SIWC allowlist verifier (§4); `submit_draft` never executed (§5) | M7.S5 |
| Full error set; no silent billing switch (Owner decisions: ChatGPT) | M7.S6 |
| SIWC UI (§5) and runbook step 8 (§14) | M7.S7 |
| `siwc-auth` and SIWC error fakes (§13) | M7.S8 |
| Corpus at least 60, obedient-model suite, auto-draft never for SIWC | M7.S9 |

## Changed since the plan
None yet. The open items are the owner's M0-gate answers on `prompt=consent` and on what declining plan usage keeps, ADR 0009's `submit_draft` placement, and OpenAI's answers to questions 1a/1b. Each is recorded here when it settles.
