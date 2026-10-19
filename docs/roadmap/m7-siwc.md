# M7 backlog: Sign in with ChatGPT (clean-room)

> **Status:** draft of 2026-10-19, written before the M0 gate. Backlog only: each item starts when its **Starts** line holds.
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
  - Every item that absorbs one merges before M7.S4 or M7.S9. Whichever of those two merges last deletes `spikes/s07-siwc/` in its PR, with the spike's `pnpm-lock.yaml` importer. Only `notes/sources.md` stays: it is the clean-room record, and vendor-guard treats it as data.
- SIWC test tokens live only in the local `.env.live`, never in CI secrets. CI runs on M7.S8's and M7.S8b's fakes.
- The SIWC Terms allow automated or background requests only with express consent, and another user's activity may not trigger them.
  - Every SIWC request comes from the owner's own on-demand action.
  - Auto-draft stays off for SIWC (§5) until OpenAI confirms background use, and agent-token or MCP requests never start one.

## Items

| # | Item | Size | Depends on | Lands on |
|---|---|---|---|---|
| M7.S1 | Registration and the per-hub host ID | M | M7.S8, M1.20, M2.11, M2.17 | m7 |
| M7.S2 | Sign-in as an admin op from the hub CLI: PKCE, the transient 1455 listener, `prompt=consent`, the scope check | M | M7.S1, M2.3, M2.4, M2.11, M2.17, M2.23 | m7 |
| M7.S2b | Sign-in from the desktop approval window | S | M7.S2, M4.13, M4.14 | m7 |
| M7.S3 | SIWC credentials: storage, serialized refresh, revocation on disconnect | M | M7.S2, M2.3, M2.4, M2.11, M2.12, M2.17, M2.23 | m7 |
| M7.S3b | Disconnect from the desktop approval window | S | M7.S3, M4.13 | m7 |
| M7.S3c | Revocation before an instance or the plugin is removed | S | M7.S3, M7.3 | m7 |
| M7.S4 | The documented transfer for a headless hub | M | M7.S3, M4.7, M4.13, M4.14 | m7 |
| M7.S5 | The broker's SIWC verifier and the shared hostile-request table | S | M2.19, M1.20 | m2 |
| M7.S5b | The siwc drafting mode: request builder, streaming, broker refusals | L | M7.S3, M7.S5, M7.S8b, M7.4, M7.9, M1.12, M1.13, M1.25's record | m7 |
| M7.S5c | The `cloud-consumer-plan` destination class | S | M7.S5b, M7.5, M7.7 | m7 |
| M7.S6 | The full error set and no silent billing switch | M | M7.S5b, M7.S5c, M7.S8b, M7.4, M7.5, M7.11, M3.5 | m7 |
| M7.S7 | SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage | S | M7.S2b, M7.S6, M7.5, M7.7, M4.13 | m7 |
| M7.S8 | The siwc-auth fake | M | M1.20 | m7 |
| M7.S8b | The responses-siwc fake and its scripted models | M | M7.S5, M7.S8, M7.11 | m7 |
| M7.S9 | SIWC rows of M7's corpus and policy matrix | S | M7.S5c, M7.S6, M7.S8b, M7.4, M7.5, M7.6, M7.7, M7.11 | m7 |
| M7.S9b | The SIWC row of M7b's obedient-model suite | S | M7.S9, M7b.10 | m7b |
| M7.S9c | The SIWC cross-stream cells: SMS, agent tokens, MCP | S | M7.S9, M8.2; on an S12 go, M1.23 and M6b's FakeSmsHost | whichever of m7, m8 and m6b lands last |

Every item also needs ADR 0009 merged into `m0`. If ADR 0009 records Not run, the items wait for the owner's M0-gate decision, and M7 ships the API-key modes alone.

A dependency from another branch counts only once its work has reached the branch the dependent item lands on; ADR 0009 counts once it merges into `m0`. So an item on `m7` that needs M1, M2 or M4 work, or M7.S5, starts once that work is on `m7`. M4's work gets there after M4 merges into `main` and `m7` is brought up to date with it (§12: device UI lands after M4). pr-meta takes an item branch `mN-<nn>-<slug>` only into `mN`. So M7.S5 lands from an `m2-<nn>-<slug>` branch, M7.S9b from an `m7b-<nn>-<slug>` branch, and M7.S9c from an item branch of the stream it lands on.

Paths and commands below are the intended ones; packages that don't exist yet take these names when their milestones create them. No command passes with nothing run:
- every pnpm command passes `--fail-if-no-match`, so a filter that matches no package fails;
- every Vitest command names its test files, and a unit run that finds none of them fails;
- heavy runs add `--no-passWithNoTests` and set `DRAFTYAK_STRICT_SKIPS=1`, so a heavy run fails if it finds no file or skips a test;
- `node --test` fails on a missing file;
- `cargo test` names its integration-test targets with `--test`, and a missing target fails.

### Hooks in other items
These are the lines and calls this backlog needs in other items' files. Each is a request until its owner agrees, except H2 and H3, which M1.20 already lists. An item that adds a line to a hook owns only that line.

| # | Owner | File and export | Shape | Used by |
|---|---|---|---|---|
| H1 | M2.3 | `apps/hub/src/authz/admin-ops.ts`, `registerAdminOp` | `registerAdminOp(kind, handler)`, one line per kind. Both entry points, M2.11's CLI and M4.13's approval window, reach `handler(op, actor)` only after the authority and PIN checks pass. The SIWC kinds need the `admin` capability, which a read/draft desktop (a CLI-only confirmation, §7) lacks | M7.S2, M7.S2b, M7.S3, M7.S3b |
| H2 | M1.20 | `packages/protocol/src/statements/admin.ts`, `ADMIN_GROUPS` | the connect and disconnect kinds for an AI-instance credential, unless an existing kind fits | M7.S2, M7.S2b, M7.S3, M7.S3b, M7.S4 |
| H3 | M1.20 | `packages/protocol/src/manifest/ai-http.ts`, `AI_HTTP_PROFILES` | one ChatGPT-plan profile id | M7.S5, M7.S5b, M7.S5c |
| H4 | M2.11 | the kernel's bundled configuration under `apps/hub/src/kernel/`, its namespace-to-folder map, which M2.1's store copies at construction | one line: the `siwc` namespace → `apps/hub/src/store/migrations/siwc/` | M7.S1 |
| H5 | M2.17 | `apps/hub/src/plugins/broker/credentials.ts`, `registerCredentialKind` | `registerCredentialKind(kind, {token(), refresh(stale)})`, run under the per-credential mutex, with the tokens in M2's common vault. A session code that `token()` throws becomes `{error: {type: "broker_refused", code}}` with 401, 403 or 503 by its recovery, and `x-should-retry: false` | M7.S3, M7.S5b, M7.S6 |
| H6 | M2.17 | `apps/hub/src/plugins/broker/ports.ts`, `BLOCKED_LOOPBACK_PORTS` | 1455 beside 47613–47615 and 9229. M2.17 adds it as a plan change; no SIWC item adds a line | M7.S2 |
| H7 | M2.19 | `apps/hub/src/plugins/broker/ai-verifiers.ts`, `AI_VERIFIERS` | profile id → `verify(request, pin, input)`, one line per profile. `pin` is the hub's model and effort, and `input` is the hub's DraftRequest. It returns `{ok: true, request}`, rebuilt from those values, or `{ok: false, problems}`. For every AI profile, the broker reads only a string body that parses to a JSON object, gives `verify` the parsed value, sends exactly the request `verify` returns, and allows one `POST /v1/responses` per attempt (M0.26's broker contract) | M7.S5 |
| H8 | M2.12 | `apps/hub/src/backup/exclusions.ts`, `EXCLUDED_CREDENTIAL_KINDS` | the credential kinds a backup skips and a restore drops; one line per kind | M7.S3 |
| H9 | M4.13 | `apps/hub/src/identity/admin-pending/index.ts`, `pendingAdminOp` | `pendingAdminOp(op)` → kind, target digest, approving device, approval time and state (open, cancelled, expired or consumed). An approved SIWC transfer op stays open until a credential consumes it or 10 minutes after approval, whichever comes first; the record's own expiry is never shorter | M7.S4 |
| H10 | M4.7 | `apps/hub/src/identity/device-routes/snapshot.ts`, `DEVICE_ROUTES` | two transfer routes, for the device that approved an open SIWC op only: a `GET` that returns the op's host ID, issuer and issued client (none on a first sign-in), and a `POST` that takes the credential | M7.S4 |
| H11 | M4.2 (command registration) and M4.13 (command permissions) | the command list in `apps/app/src-tauri/src/lib.rs`, and the `permissions` list in `apps/app/src-tauri/capabilities/approval.json` | the `siwc_*` commands, granted in the approval window's capability only | M7.S2b, M7.S4 |
| H12 | M4.14 | `apps/app/src-tauri/src/external.rs`, `open_external` | `open_external(url)` shows the real host, then opens the URL in the system browser | M7.S2b, M7.S4 |
| H13 | M4.14 | the Security Center's egress destination list, in `apps/web/src/desktop/` | each AI instance's hosts, including those of the hub's own calls for it: for a SIWC instance, the auth host (sign-in, refresh, revoke) and the API host (drafting) | M7.S1, M7.S7 |
| H14 | M7.3 (the install and disconnect hooks it accepts) | `apps/hub/src/ai/instances/lifecycle.ts`, `registerBeforeRemove` | `registerBeforeRemove(kind, handler)`, one line per credential kind. Deleting an AI instance, or uninstalling its plugin, first runs the handler for each of its credentials and removes nothing until it returns | M7.S3c |
| H15 | M7.9 | `plugins/ai-responses-api/src/modes.ts`, `MODES` | mode name → that mode's four ai-provider-v1 handlers; `siwc` sits beside `"api-key"` | M7.S5b |
| H16 | M7.5 | `apps/hub/src/ai/routing.ts`, `PROFILE_DESTINATIONS` | AI profile id → destination class; the ChatGPT-plan id maps to `cloud-consumer-plan` | M7.S5c |
| H17 | M7.5 and M7.7 | in plan §8's one SPA, `apps/web`: the provider slot of M7.5's routing screen (`providerSlots`) and the billing-line slot of M7.7's drafting screen (`billingSlots`) | one entry per mode: `{mode, component}` | M7.S7 |
| H18 | M7.6 | `apps/hub/test/ai-providers/rows.ts`, `PROVIDER_ROWS` | one line per row file, read by the corpus, policy-matrix and fields suites | M7.S9, M7.S9c |
| H19 | M7b.10 | `apps/hub/test/security/context-lookups.providers.ts`, `OBEDIENT_PROVIDERS` | one line per provider mode | M7.S9b |
| H20 | M11 | `PRIVACY.md`, its list of outbound destinations, and M11's egress-recorder check of it | M11 lists the auth host (sign-in, refresh, revoke) and the API host (drafting). The egress-recorder check runs the SIWC flows on the fakes and fails if either host is missing | M7.S1 |
| H21 | M11 | `docs/runbook.md`, step 8 | M11 adds a pointer to `docs/runbooks/m7-siwc.md` | M7.S7 |

### M7.S1 Registration and the per-hub host ID
- **Inputs.** §5's SIWC row (`dynamic_agent_client` → issued client; a per-hub `ext_agent_host_id`; `agent_name_hint: "DraftYak"`); §4 Credential flow 2; §9.2 (SSRF, OAuth mix-up); guardrail 8; ADR 0009's registration result and host-ID format; M1.20's `oauth2-dynamic-agent` descriptor; M2.17's guarded fetch; the kernel's namespace map (H4); PRIVACY.md and the Security Center's destination list (H20, H13).
- **Outputs.**
  - **Calls to OpenAI.** Every hub-side call to the OpenAI auth host goes through M2.17's guarded fetch: https, the issuer's origin only, no redirects. These calls are discovery, JWKS, the code exchange, refresh and revoke, and later items follow this rule.
  - The auth and API hosts appear in PRIVACY.md (H20) and in the Security Center's destination list (H13). M11's egress-recorder check covers the SIWC flows.
  - The hub reads the auth endpoints from the issuer's discovery document. Every endpoint, the revocation endpoint included, must share the issuer's origin.
  - Registration happens in the browser: the first authorization request names `dynamic_agent_client`, `agent_name_hint: "DraftYak"` and the host ID, and the callback returns the issued client. The hub makes no registration call of its own. It keeps the issued client and reuses it.
  - One `ext_agent_host_id` per hub, in the format ADR 0009 records, is created once, kept, and reused for every registration, sign-in and transfer.
  - The `siwc` namespace (`apps/hub/src/store/migrations/siwc/`, mapped by H4) holds the issued client, the host ID and the plan-usage state. The tokens live in M2's common vault (M7.S3).
  - Declining plan usage keeps the registration and stores no tokens. This is the spike's behaviour, pending the owner's answer (Open items).
- **Owns.** `apps/hub/src/ai/siwc/{discovery,registration}.ts`, the `siwc` namespace's migration folder `apps/hub/src/store/migrations/siwc/`, one line in H4, and `apps/hub/test/ai/siwc/{discovery,registration}.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/discovery.test.ts test/ai/siwc/registration.test.ts`, on the siwc-auth fake:
  - **discovery:** another issuer, an endpoint on another origin or on `http:`, and a missing revocation endpoint are refused; a redirect from the discovery URL is not followed; every call goes through M2.17's guarded fetch;
  - **registration:** the first authorization request carries the hub's host ID and `agent_name_hint: "DraftYak"`, and the ID survives a hub restart;
  - a second hub (another `--profile`) gets a different ID;
  - after a decline, the `siwc` namespace holds the issued client and the host ID, and no token is stored.
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
    - It closes after success, failure, cancellation or timeout.
    - It has its own route snapshot, with the callback route only.
  - **`prompt=consent`** follows the owner's M0-gate answer.
    - The plan as written sends it on every sign-in until OpenAI confirms the deployment.
    - The proposed fix, which spike S7 already follows, sends it only when the owner turns plan usage on, including after a decline, with the saved client.
  - **The scope check:** after the code exchange, the granted scopes are checked (ported from spike S7's plan-usage check), and the plan-usage state goes to the `siwc` namespace.
    - Without `chatgpt.tokens.use.direct`, plan usage stays off and no SIWC drafting request goes out.
    - M7.S7 then offers two explicit owner actions: turn plan usage on, or "Use an OpenAI API key instead".
  - The flow hands its tokens to the credential store: M7.S3's, once it merges. Until then, this item's tests use an in-memory store.
- **Owns.** `apps/hub/src/ai/siwc/{signin,listener,scopes}.ts`, the listener's route snapshot, the CLI command `apps/cli/src/commands/siwc-sign-in.ts` with `apps/cli/test/commands/siwc-sign-in.test.ts`, one line in H1, `apps/hub/test/ai/siwc/{signin,listener}.test.ts`, and `apps/hub/test/ai/siwc/listener.heavy.test.ts` with its port lock, `apps/hub/test/support/siwc-port-lock.ts`.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin.test.ts test/ai/siwc/listener.test.ts`, covering:
    - **the admin op:** the CLI path without the PIN or with a wrong one is refused. Through the admin-op service, FakeDevice is refused as a mobile device, a browser session, an unconfirmed device, a revoked device, and a confirmed desktop with read and draft only; a confirmed desktop approver with the PIN is admitted. The plan-enable path, which reuses the saved client, is refused in the same cases. A second sign-in while the listener is open is refused, and the first goes on;
    - **the flow:** the URL the CLI prints is the issuer's authorization endpoint from discovery; two sign-ins carry the hub's host ID; `error=access_denied` exchanges nothing; ID tokens with a bad or missing signature, or a wrong `iss`, `aud`, `exp` or `nonce`, are refused; another `sub`, or another host ID's registration, is refused; `redirect_uri` is identical in the request and the exchange; a redirect from the JWKS URL, or from the token endpoint during the code exchange, is not followed;
    - **`prompt=consent`:** the chosen rule, on an ordinary sign-in and on the plan-enable path, which reuses the saved client and host ID;
    - **the scope check:** with the scope missing, nothing goes to SIWC, and no API-key instance is created or used until the owner acts;
    - **the listener, on an OS-assigned port:** a wrong, missing or replayed `state`, another path, a `POST` or another Host is refused, and so is a second callback, or one after close; a port held on `127.0.0.1` or on `0.0.0.0` gives a clear refusal; the listener closes after success, failure, cancellation and timeout.
  - `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-sign-in.test.ts` tests the CLI command itself: its arguments, its PIN prompt, the URL it prints and its exit codes. `draftyak` is the CLI package's name in M2.11.
  - With `DRAFTYAK_STRICT_SKIPS=1` set, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/ai/siwc/listener.heavy.test.ts` binds 1455 itself. It is spike S7's port test, moved in rather than imported.
    - Its port lock is the kit's machine-wide bench lock in port-only mode: the same lock file and the same OS lock, copied from `spikes/kit/lock.ts`, since product code can't import spikes. So this test, the spike's own 1455 tests and an owner's live session wait for each other.
    - If another program holds 1455, the test skips, and under strict skips that skip fails the run.
    - It covers 1455 held on `127.0.0.1` and on `0.0.0.0`, refused before any browser opens, and the route snapshot.
    - With the listener open, a plugin's `ctx.fetch` to `127.0.0.1:1455` is refused. This needs M2.17's 1455 block (H6), since M0.12's list lacks it.
- **Starts** after M7.S1, M2.3, M2.4, M2.11, M2.17 and M2.23 are on `m7`, and the owner's M0-gate answers.

### M7.S2b Sign-in from the desktop approval window
- **Inputs.** M7.S2's handler (H1, H2); M4.13's admin pending operations and approval window; M4.14's system-browser opener (H12), which never opens a URL from JS; M4's command registration (H11); §9.3 admin ops.
- **Outputs.**
  - A confirmed desktop approver starts the sign-in through `admin_open` and the approval window, with the PIN. The hub runs M7.S2's handler, with its listener on the hub machine's `127.0.0.1:1455`.
  - The handler returns the authorization URL to the approving desktop over L2. The `siwc_signin` native module opens it through M4.14's opener (H12), which shows the real host first. No URL comes from JS.
  - A headless hub uses M7.S4 instead.
- **Owns.** `apps/app/src-tauri/src/siwc_signin.rs` with its integration test `apps/app/src-tauri/tests/siwc_signin.rs`, one line in H11, and `apps/hub/test/ai/siwc/signin-window.test.ts`.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin-window.test.ts`, with FakeDevice through `admin_open`: a confirmed desktop approver with the PIN starts an ordinary sign-in and the plan-enable path; a mobile device, a browser session, an unconfirmed or revoked device, a confirmed read/draft desktop, and a missing or wrong PIN are refused.
  - `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_signin`, on Tauri's mock runtime: the URL opened through H12 is the one the hub returned, on the issuer's authorization endpoint, and any other URL is refused; a URL from JS is never opened; `siwc_signin` is refused from the main window and from a foreign origin.
- **Starts** after M7.S2, M4.13 and M4.14 are on `m7`.

### M7.S3 SIWC credentials: storage, serialized refresh, revocation on disconnect
- **Inputs.**
  - §4 Credential flow 4 and 5; §3 Backup and Restore; §9.2 (theft of disk, backups or logs; OAuth mix-up); guardrail 8.
  - M2's common vault, and M2.17's per-credential mutex through its credential hook (H5); M7.S1's rule for calls to OpenAI.
  - M2.12's backup and restore (H8).
  - The disconnect kind from M1.20 (H2), through the admin-op service as in M7.S2 (H1).
  - M0.27's revocation evidence and handoff.
  - Spike S7's broker and session rules for a credential the hub can't use and for a refresh that fails.
  - The SIWC Terms: persistent token storage stays local and under the user's control, and no transfer is allowed except as the Terms permit.
  - The owner's answer on the backup change (Changed since the plan).
- **Outputs.**
  - **Storage.** Tokens and their granted scopes live only in M2's common vault, as the `siwc` credential kind (one line in H5), with no second vault (as M5.10 does for Gmail). M7.S2's sign-in stores its tokens here. `draftyak backup` leaves SIWC tokens out, and a restore drops any it finds, so the owner signs in again (Changed since the plan). `HubDataClass` has one `credentials` class, so the backup tells SIWC tokens apart by credential kind (one line in H8).
  - **Refresh.** The siwc credential refreshes under M2.17's mutex through the broker's credential hook (H5), with no second mutex. The rotated refresh token is persisted before its first use.
    - A refresh that fails on the network, with a 429 or with a 5xx gives UNAVAILABLE with backoff and keeps the tokens.
    - A refresh that narrows the scopes turns plan usage off.
    - After a refresh refused as unusable, the hub keeps the last tokens it held, unused, so disconnect can still revoke them (M0.27).
  - **An unusable credential** (signed out, plan usage off, a refused refresh) stops the request in the broker. The plugin gets `{error: {type: "broker_refused", code}}` with the session code, status 401 (sign in again), 403 (don't retry) or 503 (back off), and `x-should-retry: false`. Nothing leaves.
  - **Disconnect.** It is an admin op (one line in H1): revoke at OpenAI, then delete locally.
    - Revocation is confirmed only as M0.27 defines it: the revoke answers 200, then the revoked refresh token, tried once more, is refused with `invalid_grant`, `invalid_refresh_token` or `refresh_token_invalidated`.
    - Nothing else confirms it: a 429, a 5xx, no answer, an incomplete 200, a follow-up refresh that works, `refresh_token_reused` or an expiry.
    - A kept token that a refresh already refused is revoked too, but it is always reported as not confirmed, since another process may hold a newer one.
    - On the unconfirmed path the hub still clears its tokens and tells the owner to remove DraftYak in ChatGPT's Sign in with ChatGPT settings.
- **Owns.** `apps/hub/src/ai/siwc/credential.ts`, `apps/hub/test/ai/siwc/credential.test.ts`, the CLI command `apps/cli/src/commands/siwc-disconnect.ts` with `apps/cli/test/commands/siwc-disconnect.test.ts`, and one line each in H1, H5 and H8.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/credential.test.ts`, on the siwc-auth fake:
    - concurrent requests make one refresh;
    - a failure between rotation and first use leaves the new token stored, and a rotated token whose write fails is never used;
    - the old refresh token is never sent again;
    - a refresh that fails on the network, with a 429 or with a 503 gives UNAVAILABLE with backoff, and the stored tokens don't change;
    - a refresh that narrows the scopes turns plan usage off;
    - an unusable credential gets the `broker_refused` answer with its code, status and `x-should-retry: false`, and the fake receives nothing;
    - a redirect from the token endpoint on refresh, or from the revocation endpoint, is not followed;
    - disconnect runs only as an admin op: the CLI path needs the PIN, and through the admin-op service FakeDevice is refused as a mobile device, a browser session, an unconfirmed or revoked device, and a confirmed desktop with read and draft only;
    - disconnect records the revoke before the local deletion, on both the confirmed and the unconfirmed path;
    - a 200, then a follow-up refresh refused with `invalid_grant`, `invalid_refresh_token` or `refresh_token_invalidated`, confirms, one case per code;
    - these never confirm, one case each: a revoke answered with a 429, a 5xx or nothing; a follow-up refresh that works; one that gets an incomplete 200, a 429, a 5xx or no answer; one refused with `refresh_token_reused` or an expiry error;
    - on every unconfirmed path, the tokens are cleared and the owner is told to remove DraftYak in ChatGPT's settings;
    - after a refresh refused as unusable, disconnect revokes the kept token and reports it as not confirmed;
    - a plaintext token canary never appears in logs, audit, events, the db or `-wal`, URLs, plugin argv, env or stdio, or `ctx.fetch` frames;
    - a backup holds no SIWC token, and a restore asks for a new sign-in;
    - restoring a backup fixture that holds a SIWC token drops the token and asks for a new sign-in.
  - `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-disconnect.test.ts` tests the CLI command itself: its arguments, its PIN prompt, its "confirmed" or "not confirmed" report and its exit codes.
- **Starts** after M7.S2, M2.3, M2.4, M2.11, M2.12, M2.17 and M2.23 are on `m7`, and the owner's answer on the backup change. If the owner declines it, this item adds no line to H8, SIWC tokens are backed up like other credentials (§3), and the two backup cases check that a backup holds them and a restore keeps them.

### M7.S3b Disconnect from the desktop approval window
- **Inputs.** M7.S3's handler (H1, H2); M4.13's admin pending operations and approval window; §9.3 admin ops.
- **Outputs.** A confirmed desktop approver disconnects through `admin_open` and the approval window, with the PIN. The hub runs M7.S3's handler: the same revoke-then-delete and the same report as the CLI path.
- **Owns.** `apps/hub/test/ai/siwc/disconnect-window.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/disconnect-window.test.ts`, on the siwc-auth fake with FakeDevice through `admin_open`: a confirmed desktop approver with the PIN disconnects, and the revoke is recorded before the deletion; a mobile device, a browser session, an unconfirmed or revoked device, a confirmed read/draft desktop, and a missing or wrong PIN are refused.
- **Starts** after M7.S3 and M4.13 are on `m7`.

### M7.S3c Revocation before an instance or the plugin is removed
- **Inputs.** §3 Data lifecycle (uninstall deletes the plugin's instances, credentials and consents); §4 Credential flow 5 (SIWC tokens are revoked at OpenAI on disconnect); M7.3's instance lifecycle hooks (H14); M7.S3's disconnect.
- **Outputs.** Deleting a SIWC instance, or uninstalling `ai-responses-api`, first runs M7.S3's revoke-then-delete through H14. Nothing is removed until it returns. An unconfirmed revoke still deletes the tokens and tells the owner, as disconnect does.
- **Owns.** One line in H14 and `apps/hub/test/ai/siwc/removal.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/removal.test.ts`, on the siwc-auth fake: deleting the instance and uninstalling the plugin each record the revoke at OpenAI before the tokens are deleted; with an unconfirmed revoke, the tokens are still deleted and the owner is told.
- **Starts** after M7.S3 and M7.3 are on `m7`.

### M7.S4 The documented transfer for a headless hub
- **Inputs.**
  - §4 Credential flow 2 (headless hub).
  - ADR 0009's transfer result and M0.27's transfer handoff (order and failure rules).
  - M4.13's admin pending operations (H9), M4.7's L2 route snapshots (H10), M4's command registration (H11) and M4.14's system-browser opener (H12). M4's backlog doesn't name these SIWC lines yet, so they are requests.
  - M5.20's native boundary for `gmail_*`: no code, verifier or token in webview JS or logs.
  - The SIWC Terms' transfer clause.
  - OpenAI's answer to question 1a, on this transfer. A "no" means the transfer doesn't ship, and the owner settles this before launch.
- **Outputs.**
  - The hub creates a pending admin op for the flow (the connect kind, through M7.S2's handler). A confirmed desktop approver opens it in the approval window with the PIN.
  - That desktop reads the op's host ID, issuer and issued client over H10's `GET` route (no client on a first sign-in), and runs the flow with them. It opens the authorization URL through M4.14's opener (H12). Its local listener follows M7.S2's rules: the port check, one flow, the callback route only, and closing in every outcome.
  - The desktop's discovery and code exchange reach only the issuer's https endpoints, follow no redirect and take no URL from JS.
  - No code, verifier or token reaches webview JS or logs. The `siwc_*` commands take and return ids only, and only the approval window may call them (H11).
  - The hub's credential route (H10's `POST`) takes exactly one credential:
    - for its own pending op, while that op is open (not cancelled, expired or consumed);
    - from the device that completed that op's PIN approval;
    - once, within 10 minutes of that approval. H9 keeps the approved op open that long, unless a credential consumes it first.
  - **Handoff order:** serialise the tokens, wipe the desktop store, then send. The desktop keeps the serialised copy in memory only. It revokes that copy if the hub refuses, returns no result, or takes the tokens without refreshing or revoking them. The hub refreshes the tokens as soon as it takes them.
  - **A lost handoff:** if the desktop closes or crashes after the wipe and before the hub answers, nobody holds the tokens. The op expires 10 minutes after the approval, and the hub tells the owner to remove DraftYak in ChatGPT's Sign in with ChatGPT settings.
  - The `siwc_*` native modules in `apps/app` use M4's hooks (H11, H12), as M5.20 adds `gmail_*` modules.
- **Owns.** The `siwc_*` modules in `apps/app/src-tauri/src/` other than M7.S2b's `siwc_signin`, with their integration tests `apps/app/src-tauri/tests/siwc_{listener,exchange,handoff,acl}.rs`; `apps/hub/src/ai/siwc/transfer.ts` and `apps/hub/test/ai/siwc/transfer.test.ts`; one line each in H10 and H11. If it merges after M7.S9, also the deletion of `spikes/s07-siwc/` (except `notes/sources.md`) and the spike's `pnpm-lock.yaml` importer.
- **Acceptance.**
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/transfer.test.ts`, on the siwc-auth fake with FakeDevice as the desktop:
    - FakeDevice reads the op's host ID and issued client over the `GET` route, and its authorization request to the fake carries them; the `GET` refuses any other device and an op that isn't open;
    - the hub takes the tokens over L2 once, bound to its host ID and its pending op, and refreshes them at once;
    - on the injected clock, a credential just inside 10 minutes of the approval is taken, and one just after is refused;
    - with no credential, the op expires 10 minutes after the approval, and the hub tells the owner to remove DraftYak in ChatGPT's settings;
    - these are refused:
      - an unconfirmed or revoked device;
      - a mobile or browser role;
      - a second confirmed approver, not the one that approved;
      - a pending op that was cancelled, expired or never approved;
      - a wrong host ID or issuer;
      - another client or `sub` for a known account;
      - a replay, or a second flow;
      - an oversized or malformed body.
  - `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_listener --test siwc_exchange --test siwc_handoff --test siwc_acl` runs four integration-test targets, and fails if any is missing:
    - **`siwc_listener`, on an OS-assigned port:** a port held on `127.0.0.1` or on `0.0.0.0` gives a clear refusal; a second callback, a wrong `state`, another Host, another path or a `POST` is refused; the listener closes after success, failure, cancellation and timeout;
    - **`siwc_exchange`:** discovery and the code exchange reach only the issuer's https endpoints, a redirect is not followed, and a URL from JS is refused; the URL opened through H12 is the issuer's authorization endpoint;
    - **`siwc_handoff`:** the desktop store is already empty when the send starts; each failure path (refused, no result, taken but neither refreshed nor revoked) ends with the desktop's copy revoked; afterwards the process, its store and its logs hold no copy; a token and code canary never reaches webview JS or the logs;
    - **`siwc_acl`, on Tauri's mock runtime:** each `siwc_*` command is refused from the main window and from a foreign origin, and takes and returns ids only.
- **Starts** after ADR 0009 records the transfer, and M7.S3, M4.7, M4.13 and M4.14 are on `m7`.

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
    - any route that ADR 0009's confirmed plan changes add (spike S7 also allows a bodiless `GET /v1/models`).
  - The shared hostile-request table, `packages/fakes/src/siwc-hostile-requests.ts`. It lands with this item on `m2`, in a package the base already has, because the fakes can't import from `apps/hub`. M7.S8b's fake runs the same table, so the two copies of the allowlist can't drift.

  The plugin holds only a placeholder key; the broker injects the access token after verification.
- **Owns.** `apps/hub/src/ai/siwc/verifier.ts`, `apps/hub/test/ai/siwc/verifier.test.ts`, one line in H7, and `packages/fakes/src/siwc-hostile-requests.ts` with one export line in `packages/fakes/src/index.ts`. Unless an earlier M2 item adds it, also the `"@draftyak/fakes": "workspace:*"` devDependency in `apps/hub/package.json` and its `pnpm-lock.yaml` importer entry, agreed with the hub package's owner.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/verifier.test.ts test/ai/request-verifier.test.ts` runs the table beside M2.19's three API-key allowlists, each case as a hostile vector through the verifier and the broker path:
  - **pin and input:** a `model` or `reasoning.effort` other than the pin's; `instructions` other than the hub's; an `input` other than one user message (and the single `submit_draft` item, if ADR 0009 puts it there); a user message other than the hub's prompt;
  - **fields and values:** a field outside the nine; `store:true` or no `store`; `stream:false`; a different or second tool, or anything other than the pinned `submit_draft` JSON; `function_call_output` input items;
  - **body:** anything but a string that parses to a JSON object (bytes, a stream, an object with its own `toJSON`) is refused; with a duplicate key, the broker sends only the re-serialized value it verified;
  - **origin:** any host other than the API host, including ChatGPT's private backend (that URL is built at run time, as spike S7's test does, so vendor-guard stays clean); `http:`; a URL with userinfo or a query;
  - **path and method:** any other path or method;
  - **headers:** a header outside the allowlist, or any Authorization value other than the placeholder bearer;
  - **flow:** a redirect, or more than one `POST /v1/responses` per attempt.

  A valid request comes back rebuilt from the pin and the hub's DraftRequest.
- **Starts** after ADR 0009 merges into `m0`, and M1.20 and M2.19 are on `m2`. Its branch is `m2-<nn>-<slug>`.

### M7.S5b The siwc drafting mode: request builder, streaming, broker refusals
- **Inputs.**
  - §5's SIWC row: a strict `submit_draft` function tool that is never executed.
  - ai-provider-v1 (`spec/extensions/ai-provider-v1.md`: `ai_describe`, `ai_models_list`, `ai_probe`, `ai_draft_generate`; refusal, truncation and no tool call are outcomes, not errors; progress at least every 10 s while the model works).
  - The host channel's `host/stream.chunk` (M1.12, M1.13 and the hub side of streamed `host/fetch`, after the ADR 0003 decision).
  - M7.4's byte and event caps; M7.9's mode table (H15); the broker's `broker_refused` answer (H5).
  - M7.S5's verifier and M7.S8b's benign model, for the positive control.
  - How an instance gets the siwc auth and the ChatGPT-plan profile rather than the API-key ones: ADR 0009's follow-up, which M1.25 records (M1.20).
- **Outputs.**
  - The siwc mode of `plugins/ai-responses-api`, beside M7.9's api-key mode, as one `siwc` line in M7.9's mode table (H15):
    - `ai_describe`, `ai_models_list` (the only user of `GET /v1/models`), `ai_probe` and `ai_draft_generate`;
    - the request builder, from the hub's DraftRequest, using the pinned `openai` SDK through `ctx.fetch` with a placeholder key, like the API-key factory;
    - streaming over `ctx.fetch` with `host/stream.chunk`, under M7.4's caps;
    - progress at least every 10 s while the model works;
    - broker refusals, in `src/siwc/broker-refused.ts`: a `broker_refused` answer whose code names a session code maps back to that code, and any other to BROKER_REFUSED. The SDK never retries one.
  - Nothing under `apps/hub` imports `openai`.
- **Owns.** `plugins/ai-responses-api/src/siwc/` and `plugins/ai-responses-api/test/siwc/`, except M7.S6's `src/siwc/errors.ts` and `test/siwc/errors.test.ts`; `apps/hub/test/ai/siwc/drafting.test.ts`; one line in H15.
- **Acceptance.**
  - `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/request.test.ts test/siwc/stream.test.ts test/siwc/broker-refused.test.ts` covers:
    - `submit_draft` arguments only parsed as `DraftOutput`;
    - stream splits at 1, 7 and 4,096 bytes giving the same draft (spike S7's `stream.test.ts`, moved in);
    - refusal, incomplete and no-tool-call outcomes;
    - a slow stream on an injected clock still sends progress at least every 10 s;
    - a `broker_refused` answer with `x-should-retry: false` whose code names a session code ends with that code; one whose code is `broker_refused`, or unknown, ends as BROKER_REFUSED; in each case the SDK sends one request and doesn't retry.
  - With `DRAFTYAK_STRICT_SKIPS=1` set, `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/siwc/contract.heavy.test.ts`: `aiProviderContract()` and `runConformance` pass in process mode under production flags.
  - `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/drafting.test.ts`:
    - the positive control: the pinned SDK's request through `ctx.fetch` passes M7.S5's verifier, reaches the responses-siwc fake with exactly the allowed fields, and M7.S8b's benign model streams back the draft;
    - an import scan shows `apps/hub` never imports `openai`.
- **Starts** after M7.S3, M7.S5, M7.S8b, M7.4, M7.9, the host channel's streamed fetch (M1.12, M1.13) and M1.25's record of the per-mode auth and profile choice are on `m7`.

### M7.S5c The `cloud-consumer-plan` destination class
- **Inputs.** §5's SIWC row (destination `cloud-consumer-plan`) and Routing policy; M7.5's destination table (H16) and routing; the ChatGPT-plan profile id (H3).
- **Outputs.** The hub maps the ChatGPT-plan profile to `cloud-consumer-plan` (one line in H16). Nothing the plugin says sets the class.
- **Owns.** One line in H16 and `apps/hub/test/ai/siwc/destination.test.ts`.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/destination.test.ts`: a SIWC instance resolves to `cloud-consumer-plan` through M7.5's routing; a plugin that declares another class (`local` or `cloud-no-train`) changes nothing, so auto-draft stays off and the training-off acknowledgement is still required.
- **Starts** after M7.S5b, M7.5 and M7.7 are on `m7`.

### M7.S6 The full error set and no silent billing switch
- **Inputs.** §5's seven SIWC errors (usage limit, unavailable, not eligible, unsupported capability, route not supported, invalid user, scope not authorized); Owner decisions (ChatGPT: no silent billing switches); plugin-error-v1; spike S7's error table; ADR 0009's recorded shapes; M7.4's execution path and its one repair, which only an invalid draft starts; M3.5's draft job; M7.S8b's scripted SIWC models and its wrapper over M7.11's responses-api fake; M7.11's messages-api fake; the broker's `broker_refused` answer (H5) and M7.S5b's mapping of it.
- **Outputs.**
  - `src/siwc/errors.ts` maps each of the seven errors to a plugin-error-v1 code and a visible owner choice: wait, Manage usage, sign in again, or switch to an API key only by explicit action. A `broker_refused` answer goes to M7.S5b's mapping.
  - The choices show through M7.S7's slots.
  - Credential refusals reach the plugin as `broker_refused` and end the job with their session code and its choice. A refresh that fails on the network, with a 429 or with a 5xx ends as UNAVAILABLE (wait), and the tokens are kept.
  - The hub's draft job never re-routes a failed SIWC draft. It does no retry on another instance and no repair through another provider. Its one repair, after a draft that fails DraftOutput, goes to the same SIWC instance; if routing no longer allows that instance, the job ends with its error.
- **Owns.** `plugins/ai-responses-api/src/siwc/errors.ts`, `plugins/ai-responses-api/test/siwc/errors.test.ts` and `apps/hub/test/ai/siwc/no-billing-switch.test.ts`.
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
- **Starts** after M7.S5b, M7.S5c, M7.S8b, M7.4, M7.5, M7.11 and M3.5 are on `m7`.

### M7.S7 SIWC UX: Continue with ChatGPT, Using ChatGPT plan, Manage usage
- **Inputs.** §5's SIWC UI; §8's AI screens; §14 step 8; the provider slot in M7.5's routing screen and the billing-line slot in M7.7's drafting screen (H17); M7.S2b's approval-window sign-in; M4.13's admin pending operations; M11's launch runbook (H21).
- **Outputs.**
  - A text-only "Continue with ChatGPT" button. It opens M7.S2's admin op through `admin_open` and the approval window (M7.S2b), and is inert in the loopback browser and on mobile.
  - The "Using ChatGPT plan" label and the "Manage usage" link.
  - M7.S6's error choices and M7.S2's API-key offer, shown in the same slots.
  - No ChatGPT logo until OpenAI's reply to the logo-use question allows it. The M7.5 and M7.7 files hold no SIWC code.
  - The SIWC owner runbook, `docs/runbooks/m7-siwc.md` (§14 step 8), written as an owner check: setup, exact steps, what the owner sees, failure handling and duration. M11's launch runbook (`docs/runbook.md`) points to it for step 8 (H21). It needs a real ChatGPT plan, so it never runs in CI.
- **Owns.** `apps/web/src/ai/siwc/` with its Vitest tests, one entry in each slot (H17), and `docs/runbooks/m7-siwc.md`.
- **Acceptance.** `pnpm --filter @draftyak/web --fail-if-no-match exec vitest run src/ai/siwc` tests:
  - all three elements;
  - the button inert outside the desktop;
  - each error choice;
  - the Security Center's destination list (H13) shows both the auth host and the API host for a SIWC instance.
- **Starts** after M7.S2b, M7.S6, M7.5, M7.7 and M4.13 are on `m7`.

### M7.S8 The siwc-auth fake
- **Inputs.** §13 Fakes (`siwc-auth`); spike S7's clean-room fake (`test/fake-auth.ts`).
- **Outputs.** `packages/fakes/src/siwc-auth.ts`, which provides:
  - discovery and JWKS;
  - registration through the authorization request, with the issued client on the callback;
  - the PKCE code exchange with ID tokens;
  - rotating refresh and revoke;
  - grants with and without `chatgpt.tokens.use.direct`;
  - faults, each scripted on request:
    - ID tokens with a bad or missing signature, or a wrong `iss`, `aud`, `exp` or `nonce`;
    - a rewritten discovery document: another issuer, an endpoint on another origin or on `http:`, or no revocation endpoint;
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
- **Inputs.** §13 Fakes (the responses-api fake rejects non-allowlisted fields and emits SIWC errors; scripted benign, obedient, schema-breaking, refusing and slow models); spike S7's clean-room fake (`test/fake-responses.ts`); M7.S5's hostile-request table; M7.S8's siwc-auth fake; M7.11's responses-api fake, which speaks the API-key dialect only.
- **Outputs.** `packages/fakes/src/responses-siwc.ts`, which holds:
  - the allowlist check, tested against M7.S5's table;
  - the documented unsupported fields;
  - the seven SIWC errors, both as HTTP statuses and in-stream;
  - scripted benign, obedient, schema-breaking, refusing and slow models, each a `submit_draft` function-call stream:
    - benign returns a valid draft; it is the stream M7.S5b's positive control reads;
    - obedient follows the demands injected into its input;
    - schema-breaking returns arguments that fail DraftOutput;
    - refusing returns a refusal;
    - slow streams on an injected clock;
  - `withSiwc(responsesApi, siwcAuth)`, a wrapper over M7.11's responses-api fake. Requests whose bearer siwc-auth issued go to the SIWC module; all others go to M7.11's handler unchanged. So `responses-api.ts` holds no SIWC code, and M7.11 needs no SIWC option.
- **Owns.** That file, `packages/fakes/test/responses-siwc.test.ts` and one export line in `packages/fakes/src/index.ts`.
- **Acceptance.** `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/responses-siwc.test.ts`:
  - the table's valid request is accepted and streams the benign model's draft;
  - each scripted model streams as described, one case each;
  - responses-siwc rejects the field, value, path and method cases of M7.S5's table, the documented unsupported fields and any other route;
  - responses-siwc emits each of the seven errors both ways;
  - through the wrapper, a siwc-auth bearer reaches the SIWC module, and an API-key bearer reaches M7.11's handler unchanged.

  CI needs no SIWC credentials.
- **Starts** after M7.S5, M7.S8 and M7.11 are on `m7`.

### M7.S9 SIWC rows of M7's corpus and policy matrix
- **Inputs.**
  - §5 Routing policy: `cloud-consumer-plan` is a per-account opt-in, with the disclosure immediately before consent. Gmail, Slack and SMS content also need the training-off acknowledgement, and loosening is an admin op.
  - §5 Triggers: auto-draft only on `local` and `cloud-no-train`, never SIWC.
  - §12 M7 acceptance and its rule for cross-stream checks; the SIWC Terms clause above.
  - M7.6's corpus, policy-matrix and fields suites (H18); M7.S8b's benign and obedient SIWC models, in place of M7.11's, which speak the API-key dialect; M7.S5c's destination class; M7.5's routing, consent and disclosure; M7.7's triggers.
- **Outputs.**
  - SIWC rows added through one line in H18, so the rows never edit the suite files.
  - **Corpus rows:** the corpus (at least 60 cases) runs for siwc mode, with M7.S8b's benign and obedient models.
  - **Policy-matrix rows:** for each of Gmail, Slack and channel-hello, `cloud-consumer-plan` × consent state (none; opted in without the acknowledgement; opted in with it) gives run or skip, with the chip reason.
    - The disclosure is rendered immediately before the opt-in.
    - Loosening happens only by admin op.
    - Auto-draft is excluded by class, and never starts a SIWC request.
  - **Fields rows:** no non-allowlisted field leaves in any captured SIWC request.
  - This item merges with these M7 cells only. The SMS cells, and the cells for agent tokens and MCP, are M7.S9c's.
- **Owns.** `apps/hub/test/ai-providers/rows/siwc.ts`, `apps/hub/test/ai/siwc/rows.test.ts` and one line in H18. If it merges after M7.S4, also the deletion of `spikes/s07-siwc/` (except `notes/sources.md`) and the spike's `pnpm-lock.yaml` importer.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/rows.test.ts test/ai-providers/corpus.test.ts test/ai-providers/policy-matrix.test.ts test/ai-providers/fields.test.ts` passes with the SIWC rows:
  - `rows.test.ts` asserts that `PROVIDER_ROWS` lists the SIWC row file, so a missing line fails;
  - recipients unchanged, flags raised, no non-allowlisted field in any captured request, and every cell above as stated.
- **Starts** after M7.S5c, M7.S6, M7.S8b, M7.4, M7.5, M7.6, M7.7 and M7.11 are on `m7`.

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
  - **SMS cells:** SMS × `cloud-consumer-plan` × consent state in the policy matrix, as M7.S9 does for the other channels, with the training-off acknowledgement and the SMS disclosure.
  - **Agent-token and MCP cells:** an agent token or an MCP request never starts a SIWC request.
  - On an S12 no-go, the SMS cells are dropped, not failed, and the gate report says so.
- **Owns.** `apps/hub/test/ai-providers/rows/siwc-cross-stream.ts`, `apps/hub/test/ai/siwc/cross-stream-rows.test.ts` and one line in H18.
- **Acceptance.** `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/cross-stream-rows.test.ts test/ai-providers/policy-matrix.test.ts` passes with these cells, and `cross-stream-rows.test.ts` asserts that `PROVIDER_ROWS` lists their row file.
- **Starts** once M7.S9 and M8.2 are on the branch it lands on, and on an S12 go also M1.23 and M6b's FakeSmsHost. It lands on whichever of `m7`, `m8` and `m6b` lands last.

## Plan coverage

| Plan clause (§12 M7 row and the sections it cites) | Item | Acceptance command (intended) |
|---|---|---|
| Registration, per-hub `ext_agent_host_id`; calls to OpenAI (§9.2 SSRF and OAuth mix-up; guardrail 8) | M7.S1 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/discovery.test.ts test/ai/siwc/registration.test.ts` |
| Port 1455 check, `prompt=consent`, scope check, sign-in as an admin op from the CLI | M7.S2 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin.test.ts test/ai/siwc/listener.test.ts`; `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-sign-in.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/ai/siwc/listener.heavy.test.ts` |
| Sign-in from the approval window (§9.3) | M7.S2b | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/signin-window.test.ts`; `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_signin` |
| Serialized refresh; tokens revoked at OpenAI on disconnect; no tokens in backups or logs | M7.S3 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/credential.test.ts`; `pnpm --filter draftyak --fail-if-no-match exec vitest run test/commands/siwc-disconnect.test.ts` |
| Disconnect from the approval window (§9.3) | M7.S3b | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/disconnect-window.test.ts` |
| Revocation before an instance or the plugin is removed (§3 Data lifecycle; §4 Credential flow 5) | M7.S3c | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/removal.test.ts` |
| Documented transfer (headless hub) | M7.S4 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/transfer.test.ts`; `cargo test --locked --manifest-path crates/Cargo.toml -p draftyak-desktop --features desktop-tests,native-hub-integration --test siwc_listener --test siwc_exchange --test siwc_handoff --test siwc_acl` |
| SIWC allowlist verifier (§4); guardrail 4 | M7.S5 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/verifier.test.ts test/ai/request-verifier.test.ts` |
| Streaming via host chunks; `submit_draft` never executed (§5); the captured request passes the verifier | M7.S5b | `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/request.test.ts test/siwc/stream.test.ts test/siwc/broker-refused.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/siwc/contract.heavy.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/drafting.test.ts` |
| Destination class `cloud-consumer-plan` (§5) | M7.S5c | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/destination.test.ts` |
| Full error set; no silent billing switch | M7.S6 | `pnpm --filter @draftyak/ai-responses-api --fail-if-no-match exec vitest run test/siwc/errors.test.ts`; `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/no-billing-switch.test.ts` |
| SIWC UI (§5) and runbook step 8 (§14) | M7.S7 | `pnpm --filter @draftyak/app --fail-if-no-match exec node --test test/ai-siwc.test.mjs`; the runbook itself is an owner check |
| `siwc-auth` fake (§13) | M7.S8 | `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/siwc-auth.test.ts` |
| The responses-api fake's SIWC allowlist, errors and scripted models (§13) | M7.S8b | `pnpm --filter @draftyak/fakes --fail-if-no-match exec vitest run test/responses-siwc.test.ts` |
| Corpus (at least 60), policy matrix, no non-allowlisted field, auto-draft never for SIWC | M7.S9 | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/rows.test.ts test/ai-providers/corpus.test.ts test/ai-providers/policy-matrix.test.ts test/ai-providers/fields.test.ts` |
| Obedient-model suite (every provider) | M7.S9b | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/obedient-row.test.ts`; with `DRAFTYAK_STRICT_SKIPS=1`, `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --no-passWithNoTests test/security/context-lookups.heavy.test.ts` |
| Cross-stream cells: SMS, agent tokens and MCP (§12) | M7.S9c | `pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run test/ai/siwc/cross-stream-rows.test.ts test/ai-providers/policy-matrix.test.ts` |

## Changed since the plan
- **Sign-in, transfer and disconnect are admin ops** (owner decision D19 in `docs/roadmap/m1.md`, pending the owner's confirmation at the M0 gate, or before M1.20 merges if that is earlier). Plan §9.3 makes account connect and disconnect and API-key entry admin ops, but doesn't name SIWC. Without this rule, any paired device that the L2 snapshot admits could install tokens for an account of its choice. M1.20 adds the admin-op kind if no existing kind fits (H2).
- **SIWC tokens stay out of backups** (pending the owner's confirmation at the M0 gate). Plan §3 Backup includes credentials. The SIWC Terms keep persistent token storage local and under the user's control, and allow no transfer except as they permit. A backup file can leave the machine, and a restore onto another machine would move the tokens. So a backup skips SIWC tokens, a restore drops any it finds, and the owner signs in again (M7.S3). A per-kind filter in M2.12's backup tells them apart (H8); a separate data class would be an M1 contract change. If the owner declines, M7.S3 adds no H8 line, and SIWC tokens are backed up like other credentials.

### Open items
Each is recorded here when it settles:
- the owner's M0-gate answers on `prompt=consent` and on what declining plan usage keeps;
- the owner's confirmation of the two changes above;
- ADR 0009's `submit_draft` placement and the host-ID format;
- how one `ai-responses-api` manifest declares both its api-key and siwc modes, when a manifest has one `auth` kind and one AI egress profile: ADR 0009's follow-up, which M1.25 records (M1.20);
- the fixed port 1455, and the broker's 1455 block as a plan change;
- each request under **Hooks in other items**, until its owner agrees;
- OpenAI's answers to these questions:
  - 1a, the headless transfer: a "no" means M7.S4's transfer doesn't ship;
  - 1b, whether a hub on a VPS or another remote machine may keep tokens at all, since the Terms bar persistent token storage "in a remote or managed environment": a "no" keeps SIWC off any hub that isn't on the owner's own computer, however the tokens would arrive, and points those hubs to the API-key alternative;
  - 2b, the licence link;
  - 5, whether plan usage follows the training setting: a "no" removes Slack content from SIWC and changes the Gmail and SMS acknowledgement text;
- a `vendor-terms-watch` entry for the SIWC Terms, and `docs/compliance/openai.md`, both proposed and pending the owner's confirmation.
