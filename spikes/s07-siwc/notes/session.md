# S7b: the Sign in with ChatGPT session (M0.27, session 1)

The owner's part of S7 takes about 20 minutes, most of it the sign-in and the consent screen. The live test, `test/siwc.live.test.ts`, does the rest through `test/live-session.ts`, the same procedure the rehearsals run against M0.26's fakes:

1. It checks the opt-in and the shell, then consumes the opt-in.
2. It revokes any tokens an earlier run left in `.env.live`, and stops, keeping them, if that isn't confirmed.
3. It signs in through the system browser on `127.0.0.1:1455`, refusing first if another program holds the port, and stores the tokens only through the kit's `saveEnvLive`.
4. It drafts once with `text.format`, then once with `submit_draft` in each place a tool can go: a namespace, an `additional_tools` item, and the top level.
5. It hands the session to a second local process, the hub (`test/transfer-child.ts`), and forgets it. The hub drafts once, refreshes, revokes and forgets.
6. It drafts twice with an API key, if `DY_LIVE_RESPONSES_API_KEY` is set and the key lists a model it may use (Models, below).
7. It deletes every `DY_LIVE_SIWC_*` entry and writes `evidence/live.json`.

The evidence holds shapes, sizes, codes and request IDs hashed with a key that is never stored. It never holds a token, prompt or draft text, account ID or e-mail address.

## Before the session (orchestrator, about 5 minutes)

Work from the root of a clean checkout of `m0` that includes M0.27: the main checkout `C:/dev/draftyak` or a fresh worktree. The evidence is written into that checkout, and its fingerprint must read `dirty: false`.

1. Run `git status --porcelain`; it prints nothing. Then run `pnpm install --frozen-lockfile`.
2. Run the rehearsal: `pnpm --filter @draftyak/spike-s07-siwc test` (about a minute on a busy machine).
3. Check that no `OPENAI_*` variable is set (the run refuses otherwise) and that nothing listens on port 1455. A Codex CLI sign-in in progress would.
4. Check that no benchmark holds the kit's machine-wide lock: `%LOCALAPPDATA%\draftyak-dev\bench.lock.owner` is missing, or names a process that no longer runs (its `pid`, in Task Manager). The run waits at most 4 minutes for that lock and then fails as `machine-busy`, with the opt-in already used, so hold sibling benchmarks back for the session.
5. Ask the owner about plan usage. On ChatGPT Plus, "the five-hour usage limit is shared across all apps where they use their ChatGPT plan" (Accounts and sessions), Codex included, so the drafts can end `fails(USAGE_LIMIT)`. The owner checks ChatGPT Settings → Usage (https://chatgpt.com/settings/usage) for room, and Codex pauses for the session if it uses the same account. On Pro the five-hour limit doesn't apply.
6. Run `node spikes/s07-siwc/test/session-env.ts status`. Expect `.env.live: C:\dev\draftyak\.env.live (git ignores it)` and `not set` for every `DY_LIVE_SIWC_*` name. If the second part reads anything other than `git ignores it`, stop and fix that first.
7. Check that `spikes/s07-siwc/evidence/live.json` doesn't exist yet. If it does, it is an earlier session's evidence: commit or move it, or opt in with `--again` in step 3 below.

## The session

| # | Who | About | Step |
|---|---|---|---|
| 1 | Owner | 1 min | **The plan.** Sign in with the ChatGPT account whose plan DraftYak will use, on ChatGPT Plus or Pro (the plans the docs name for plan usage). If you haven't yet, read the Sign in with ChatGPT Terms (https://openai.com/policies/sign-in-with-chatgpt-terms/) in a browser first. |
| 2 | Owner, optional | 3 min | **An API key**, for API-key mode, the fallback if plan usage is blocked. Create a project key with a small budget at platform.openai.com, open `C:\dev\draftyak\.env.live` in Notepad, add a line `DY_LIVE_RESPONSES_API_KEY=<the key>` and save. Never paste the key into the chat or a terminal. API-key mode drafts only with a model the key lists (Models, below); to choose one, give the orchestrator its name for `DRAFTYAK_S7_API_MODEL`. |
| 3 | Orchestrator, on the owner's go | 10 s | **Opt in:** `node spikes/s07-siwc/test/session-env.ts opt-in`. |
| 4 | Orchestrator | 1 min | **Run:** `pnpm --filter @draftyak/spike-s07-siwc test:live --reporter=verbose`, in the background. Progress arrives on stderr as `s07 live: …` lines. Relay the sign-in prompt to the owner. |
| 5 | Owner | 2–5 min | **Sign in and consent.** A browser tab opens at `auth.openai.com`. Sign in. Before you allow access, copy the consent screen's wording as text: the title, the app name it shows, the access it lists and any notice, leaving out your name and e-mail address. Give it to the orchestrator for ADR 0009, then allow access. The tab then reads "DraftYak received the sign-in. You can close this tab." |
| 6 | Both | 1–2 min | **Wait** while the run drafts, transfers, tries API-key mode and revokes. It prints the five acceptance lines, then `details:` lines and the evidence path. |
| 7 | Owner | 2 min | **Check revocation.** In ChatGPT, open Settings > Security and login > Sign in with ChatGPT and remove DraftYak if it is listed; each run registers it once. If you created an API key, delete it at platform.openai.com. |
| 8 | Orchestrator | 2 min | **Close.** If an API key was added, run `node spikes/s07-siwc/test/session-env.ts forget api-key`. Run `status` (every name `not set`), then `git status --porcelain --untracked-files=all` (`?? spikes/s07-siwc/evidence/live.json`), then `pnpm guard` (0 findings). Keep the lines, the details and the consent wording for ADR 0009. |

During step 5:

- **No tab opened:** open the address the run printed after `open this address:`.
- **A second tab opened:** the code exchange failed with `invalid_grant`, and the run signs in again with the client issued to the first attempt. Sign in once more.
- **OpenAI shows an error page instead of the consent screen** (not eligible, not available, something went wrong): note its wording without personal details and close the tab. The orchestrator then runs `node spikes/s07-siwc/test/session-env.ts stop`, and the run ends within seconds as `signin: blocked(stopped)`; a stop sent while the run still waits for the lock ends it before any browser opens. Declining on the consent screen ends it as `signin: blocked(SIGN_IN_FAILED:access_denied)`. Either way the run still writes the evidence, revokes nothing because nothing was issued, and drafts with the API key if one is set and a model is found. ADR 0009 then records `Not run` with the API-key fallback, as below.
- **Nothing happens for 8 minutes:** the sign-in times out as `signin: blocked(SIGN_IN_FAILED:timeout)`.

## Commands

From the checkout's root. Git Bash and PowerShell take the same commands. In Windows PowerShell, `pnpm` runs as `pnpm.ps1`, which needs the execution policy CONTRIBUTING.md sets.

| Purpose | Git Bash | PowerShell |
|---|---|---|
| No `OPENAI_*` variables | `env \| grep -i '^openai_'` prints nothing | `Get-ChildItem Env: \| Where-Object Name -like 'OPENAI_*'` prints nothing |
| Port 1455 is free | `netstat -ano \| grep ':1455 '` prints nothing | `Get-NetTCPConnection -LocalPort 1455 -ErrorAction SilentlyContinue` prints nothing |
| No benchmark holds the lock | `cat "$LOCALAPPDATA/draftyak-dev/bench.lock.owner"` finds no file, or a `pid` that no longer runs | `Get-Content "$env:LOCALAPPDATA\draftyak-dev\bench.lock.owner"` finds no file, or a `pid` that no longer runs |
| State of `.env.live` | `node spikes/s07-siwc/test/session-env.ts status` | the same |
| Opt in (once per run) | `node spikes/s07-siwc/test/session-env.ts opt-in` | the same |
| Opt in, replacing `evidence/live.json` | `node spikes/s07-siwc/test/session-env.ts opt-in --again` | the same |
| Run | `pnpm --filter @draftyak/spike-s07-siwc test:live --reporter=verbose` | the same |
| End a waiting sign-in | `node spikes/s07-siwc/test/session-env.ts stop` | the same |
| After the key is deleted at OpenAI | `node spikes/s07-siwc/test/session-env.ts forget api-key` | the same |
| After a failed run, once DraftYak is removed in ChatGPT | `node spikes/s07-siwc/test/session-env.ts forget tokens` | the same |
| Evidence and guard | `git status --porcelain --untracked-files=all` and `pnpm guard` | the same |

Models: the plan drafts use the first model that `GET /v1/models` lists as `visibility: "list"`, in the server's order. If the list can't be read, they use `gpt-6.1-sol`, the model in the docs' example (Models and inference, still at its recorded SHA-256 on 2026-10-18). API-key mode uses `DRAFTYAK_S7_API_MODEL` if it is set, else the plan's model if the key lists it, else `gpt-6.1-sol` if the key lists it. Otherwise it doesn't draft, and the details say `api-key mode: not run (no model: …)`; it never picks a model by name or date, so it can't land on a costly one. To choose either model, set `DRAFTYAK_S7_MODEL` or `DRAFTYAK_S7_API_MODEL` in the shell before the run. The run prints each model before it drafts with it.

## What the lines mean

| Line | Values | Then |
|---|---|---|
| `signin:` | `ok`, or `blocked(<code>[:<reason>])`, such as `blocked(SIGN_IN_FAILED:access_denied)`, `blocked(stopped)` or `blocked(ID_TOKEN_INVALID:audience)` | When blocked, the drafts and the transfer read `not-run(signin blocked)`. If OpenAI issued tokens before the spike refused them, they are revoked anyway. |
| `text.format:` | `ok`; `unsupported`, when the route refused the structure's own fields (`UNSUPPORTED_CAPABILITY`, or a 400, whose `param` names `text`); `fails(<code>[:<param>])` for any other refusal, such as `fails(UNSUPPORTED_CAPABILITY:model)`, `fails(ROUTE_NOT_SUPPORTED)`, `fails(NOT_ELIGIBLE)` or `fails(USAGE_LIMIT)`; `fails(refusal)`, `fails(timeout)`; `not-run(<why>)` | `details: desktop drafts:` gives each structure's result, with the code and `param` behind an `unsupported`. |
| `submit_draft:` | `ok` when any placement drafted; `unsupported` when every placement was refused for its own fields (`tools`, `tool_choice`, or the `additional_tools` item, `input[0]`); else the first `fails(…)` | The placements that worked go into ADR 0009 and plan §5. |
| `transfer:` | `ok` (the hub took the session, drafted like the desktop and refreshed it); `fails(TRANSFER_REFUSED:<detail>)`; `fails(<code>:<detail>)` when the hub took it but couldn't go on, such as `fails(SIGN_IN_FAILED:discovery: issuer)`; `fails(draft:<code>)`; `fails(refresh:<code>)`; `fails(exit <code>)` when it gave no result; `not-run(<why>)` | When the hub refused the session, gave no result, or took it without sending a refresh or revoking it, this process revokes its own copy. |
| `revoked:` | `yes`, or `no(<reason>)` | Anything but `yes` fails the test, and the owner removes DraftYak in ChatGPT's settings (step 7). |

`revoked: yes` means every refresh token the run was issued was revoked with a 200 and then refused as invalid (`invalid_grant`, `invalid_refresh_token` or `refresh_token_invalidated`) when tried once more. The 200 alone proves nothing: "An empty HTTP `200` is the revocation success response, including for an already-invalid token" (Accounts and sessions), and Self-hosted VMs adds that "Host-specific usage attribution and revocation of ChatGPT plan access for transferred sessions are not yet available." The reasons for `no`:

- `no(revocation unconfirmed)`: the revocation endpoint didn't answer 200.
- `no(revocation unconfirmed: probe <code>[:<upstream code>])`: the token tried once more was refused for another reason, such as a 429, a 5xx, no answer, an incomplete answer or `refresh_token_reused`.
- `no(the revoked refresh token still works)`: it refreshed. The run revoked the new token at once and never used it.
- `no(revocation unconfirmed: refresh_token_reused)` or `no(revocation unconfirmed: the hub's refresh got no answer)`: the hub's own refresh may have left a newer token than the one it revoked.
- `no(hub process ended without a result)`: this process revoked its copy, but the hub may have refreshed it first.
- `no(no refresh token; remove DraftYak in ChatGPT)`: the grant had no `offline_access`, so there was nothing to revoke.
- `no(entries left in .env.live)`: a `DY_LIVE_SIWC_*` entry was back after the cleanup, such as a late `stop`.

Before anything is recorded, the run can also stop with a message and no evidence. Either fix the cause and run again (the first three), or opt in again first (the rest):

- `refusing to start: OPENAI_… set in this shell`: unset the variables. The opt-in is kept.
- `refusing to start: live.json holds an earlier session's evidence`: commit or move it, or opt in with `--again`.
- `the owner hasn't opted in`: the test skips. Under `DRAFTYAK_STRICT_SKIPS=1` it fails instead.
- `127.0.0.1:1455 is held by another program`: close the other program. This check runs before any browser opens.
- `… didn't answer`: a network problem. Tokens an earlier run left in `.env.live` stay there.
- `an earlier run's tokens in .env.live weren't revoked: …`: they stay there. Run again later, or the owner removes DraftYak in ChatGPT's settings and the orchestrator runs `forget tokens`.
- `machine-busy` after `bench lock: waiting for …`: the run holds the kit's machine-wide lock while port 1455 is bound and waits up to 4 minutes for another benchmark to release it. Stop the benchmark.

If a run fails after the sign-in (an error, a timeout, an interrupted test), it revokes what it still holds before it ends and prints each outcome as `After the failure, <which tokens>: revoked <yes or no(…)>`. Tokens in `.env.live` whose revocation isn't confirmed stay there, `status` shows them as `set`, and the next opted-in run revokes them before it signs in. Tokens the run no longer holds, such as those handed to the hub, can't be kept: the owner removes DraftYak in ChatGPT's settings. If no run follows, the owner removes DraftYak there, then the orchestrator runs `forget tokens`.

## What ADR 0009 records (M0.27's second half)

- **Decision.** `Go` if `signin: ok`, with the structured-output path the plan route takes: `text.format`, or `submit_draft` and which placements work. That updates plan §5's `tools=[submit_draft]` wording. The decision also covers the documented transfer, from the `transfer:` line. If OpenAI's enablement blocks the flow (`signin: blocked(…)`, or drafts that fail with `NOT_ELIGIBLE` or `ROUTE_NOT_SUPPORTED`), the decision is `Not run`, with the API-key fallback (`ai-responses-api` in `api-key` mode) and API-key mode's results, if a key was set. Two failures call for another run, not `Not run`: `fails(USAGE_LIMIT)`, the plan's limit (on Plus, a five-hour window every app on the plan shares), after the window resets; and `fails(UNSUPPORTED_CAPABILITY:model)`, a refused model, with `DRAFTYAK_S7_MODEL` set to another model the account lists.
- **The consent wording,** as the owner copied it, and the error page's wording if the flow was blocked.
- **Evidence** (`evidence/live.json`, `data`), answering the "Spike choices to confirm" in `notes/sources.md`:
  1. **Port:** `port`, `lock`.
  2. **Placement:** `drafts[]`, with `structure`, `toolChoice`, `outcome`, `error` (`code`, `apiCode`, `param`, `status`) and `upstream[].errorBody`.
  3. **Refresh:** `signIn.token.earliestRefreshAt`, `transfer.refresh.shape` (which fields a refresh returns, an `id_token` among them) and `transfer.afterRevoke.refreshShape`, the error body on refresh.
  4. **Discovery:** `discovery.endpoints.*.sameOrigin` and their paths, `discovery.id_token_signing_alg_values_supported`, `jwks` (a field a key leaves out reads `absent`) and `signIn.token.idToken.alg`.
  5. **Streaming:** `drafts[].upstream[].chunks`, the sizes as they arrived; `drafts[].events.completed.repeatsOutput`; and the header names in `drafts[].upstream[].headers` and `authCalls[].headers`.
  6. **Host-ID format:** the run registers a `urn:uuid:` host ID (UUIDv4), so `signin: ok` shows OpenAI accepted that form; the evidence doesn't hold the ID. Whether the hub derives the recommended RFC 9278 thumbprint from a key it already holds is ADR 0009's call.
  7. **The callback port in the broker:** a plan change, not evidence. ADR 0009 carries it into M9: plugin egress to loopback port 1455 is refused like 47613–47615, beside M0.12's `brokerDecision` list (9229, 47613–47615), which doesn't hold 1455 yet.
  - Beyond the seven: **plan usage** (`signIn.token.scopes`, `signIn.planScope` for `chatgpt.tokens.use.direct`, and `signIn.planCheck`, the result of `Session.accessToken()`); **the transfer** (`transfer`: `result`, `accepted`, `rotated`, the hub's `draft` and `refresh`, `revoked`, and `desktopForgot`); **revocation** (`revocation`: `transfer`, `orphan`, `accessOnly`, `fallback`, `remaining`; `leftovers.probe`; and `transfer.afterRevoke`, whether the revoked refresh token and the old access token still work); **the verifier** (`brokered[]`, each plugin-side request with its field names and the broker's verdict); **API-key mode** (`apiKey`: the model and its source, the shape the key's model list came in, and the drafts); and `withheld`, the number of values that read `(withheld)`.
- **Kept test:** `spikes/s07-siwc/test/rehearsal.test.ts` (`pnpm --filter @draftyak/spike-s07-siwc test`). It guards the session procedure, the evidence's shape and content, and the transfer, forget and revocation paths. Its destination is M7, `plugins/ai-responses-api/`.
