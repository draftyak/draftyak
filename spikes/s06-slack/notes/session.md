# S6b Slack live: session 2 runbook (M0.25)

This session answers S6 (plan §15): do Slack's user events reach a bot-less internal app over Socket Mode, per conversation type? It also records the rate-limit headers of the claim-time reads, checks the internal-app rate exemption, measures Slack's `Date` header against this machine's clock, and sees what Slack sends when the owner uninstalls the app. The owner and a second user take part for about 30 minutes; everything else is the orchestrator's.

The run is `test/events.live.test.ts`. It drives `test/live-session.ts`, the same code `test/rehearsal.test.ts` runs against FakeSlack in every `pnpm test`. It writes `evidence/live.json` (counts, timings, Slack's codes, header names, Slack ids and `ts` only as per-session HMACs, never text), which ADR 0008 cites. `scripts/tokens.ts` handles the tokens and `scripts/quotes.ts` the re-read of Slack's pages. Nothing here edits `manifest.yaml`.

## Before the session (orchestrator, about 20 minutes, no owner)

Use a worktree at an `m0` commit that includes M0.25, with a clean tree and dependencies installed. The kit finds the main checkout's `.env.live` from any worktree. The main checkout (`C:/dev/draftyak`) holds `.env.live`, so it must stay on a branch whose `.gitignore` lists `.env.live`, such as `m0`: on `main`, the empty root commit, `saveEnvLive()` refuses to write the file. The commands below name the worktree `WT` (Git Bash) or `$wt` (PowerShell); set it again in each new shell.

1. **Worktree and rehearsal** (5 min).

   Git Bash:
   ```bash
   WT=/c/dev/draftyak-wt/<session worktree>
   cd "$WT" && git status --porcelain        # prints nothing
   pnpm install --frozen-lockfile
   pnpm --filter @draftyak/spike-s06-slack test
   node spikes/s06-slack/scripts/tokens.ts check
   ```
   PowerShell:
   ```powershell
   $wt = 'C:\dev\draftyak-wt\<session worktree>'
   Set-Location $wt; git status --porcelain
   pnpm install --frozen-lockfile
   pnpm --filter @draftyak/spike-s06-slack test
   node spikes/s06-slack/scripts/tokens.ts check
   ```
   `tokens.ts check` exits 1 and prints `.env.live: C:\dev\draftyak\.env.live (git ignores it)`, then both entries as `missing`. If its first line says git doesn't ignore the file, switch the main checkout back to `m0` before the owner pastes anything. It never prints a value.

2. **Vendor-guard on the rehearsal's evidence** (3 min). The rehearsal already runs vendor-guard's CLI on its output in a temp repository. This repeats the check with `pnpm guard` in the worktree, through a throwaway folder shaped like `evidence/`. `DRAFTYAK_S6_REHEARSAL_DIR` must be a missing or empty folder outside every git work tree; the rehearsal refuses anything else, since it runs `git init` there.

   Git Bash:
   ```bash
   OUT="$(cygpath -m "$(mktemp -d)")"
   DRAFTYAK_S6_REHEARSAL_DIR="$OUT" pnpm --filter @draftyak/spike-s06-slack test test/rehearsal.test.ts
   mkdir -p spikes/s06-slack/rehearsal-check/evidence
   cp "$OUT"/spikes/s06-slack/evidence/*.json spikes/s06-slack/rehearsal-check/evidence/
   pnpm guard                                  # vendor-guard: 0 findings
   rm -rf spikes/s06-slack/rehearsal-check "$OUT"
   ```
   PowerShell:
   ```powershell
   $out = Join-Path $env:TEMP "s06-rehearsal-$(Get-Random)"
   $env:DRAFTYAK_S6_REHEARSAL_DIR = $out
   pnpm --filter @draftyak/spike-s06-slack test test/rehearsal.test.ts
   Remove-Item Env:DRAFTYAK_S6_REHEARSAL_DIR
   New-Item -ItemType Directory -Force spikes\s06-slack\rehearsal-check\evidence | Out-Null
   Copy-Item "$out\spikes\s06-slack\evidence\*.json" spikes\s06-slack\rehearsal-check\evidence\
   pnpm guard
   Remove-Item -Recurse -Force spikes\s06-slack\rehearsal-check, $out
   ```

3. **Re-read Slack's pages** (10 min). M0.24's handoff asks for this before session 2. `fetch` saves today's Markdown copies of 12 pages: each page a `> ` quote in `notes/rate-limits.md` cites (the two rate-limit changelog entries of 2025-05-29 and 2025-06-03, the rate-limits page and five others), plus the pages the notes quote inside running text (Using Socket Mode, Comparing HTTP and Socket Mode, `apps.connections.open`, `auth.test`). `check` looks up each `> ` quote in each page linked just above it.

   Git Bash:
   ```bash
   PAGES="$(cygpath -m "$(mktemp -d)")"
   node spikes/s06-slack/scripts/quotes.ts fetch "$PAGES"
   node spikes/s06-slack/scripts/quotes.ts check "$PAGES"   # "13 of 13 quotes found in the pages they cite (14 checks; 12 pages saved)"
   ```
   PowerShell:
   ```powershell
   $pages = Join-Path $env:TEMP "s06-pages-$(Get-Random)"
   node spikes/s06-slack/scripts/quotes.ts fetch $pages
   node spikes/s06-slack/scripts/quotes.ts check $pages
   ```
   For every quote reported `not in <page>`, read that page and note the change for ADR 0008. The quotes inside running text aren't checked by the tool: read the saved pages for the notes' "How Slack counts and signals limits" (tiers, the 429 and `Retry-After`, the per-method, per-workspace scope), "Socket Mode" and the methods table (`auth.test`'s "hundreds of requests per minute"). If the exemption wording changed, tell the owner before the session, because ADR 0015's dependency rests on it. Delete the folder afterwards.

   Also check Slack's current help on removing an app from a workspace and on deleting an app. Owner steps 7 and 8 name the menus as this runbook expects them; correct them if Slack renamed anything.

4. **Settings for the run.** Agree these with the owner beforehand. Environment variables pass through pnpm and turbo, and the run records them in the evidence.
   - `DRAFTYAK_S6_EXPECT`: the message types to wait for (`im`, `mpim`, `channel`, `group`; unset means all four). Drop one only if the owner's workspace can't provide it.
   - `DRAFTYAK_S6_KEEP_APP=1`: no uninstall at the end; the app and its tokens stay for M6. Not recommended: tokens would sit in `.env.live` for months, and recreating the app from the manifest takes 5 minutes.
   - `DRAFTYAK_S6_DEBUG_RECONNECTS=0`: turns off the refresh tip. By default, the run adds `&debug_reconnects=true` to each Socket Mode URL, so Slack refreshes the connection every 360 seconds and the session sees real `warning` and `refresh_requested` frames.
   - `DRAFTYAK_S6_DROP_ACK=0`: turns off the dropped ack. By default, the run withholds the ack of the first message from another user once, so Slack retries it and the evidence shows the shape of Slack's redelivery (notes open point 7). The run still handles that message once.

## Owner prerequisites (about 10 minutes, any day before)

- **A free Slack workspace with the owner, the second user and a third member.** The third member never has to act after joining, but Slack's group DMs (MPIMs) need at least three people. A second e-mail address of the owner's works.
- **A public channel** (for example `#s6-test`) and **a private channel** (for example `#s6-private`), each with the owner and the second user.
- **More than 15 messages in `#s6-test`** before the run, such as 16 short ones posted by the owner ("1" to "16"). The exemption check tries the owner's public channels in turn until one holds more than 15; with none, it reads "inconclusive". The run counts the owner's own messages apart from the second user's.
- **A group DM** between the second user, the owner and the third member, with one message so it exists.

## Owner steps, in order (about 30 minutes with the second user)

1. **Create the app** (5 min). At https://api.slack.com/apps: Create New App → From a manifest → the test workspace. Paste `spikes/s06-slack/manifest.yaml` as it is, then Next → Create. If Slack refuses `is_mcp_enabled`, delete that one line in the paste box and go on (notes open point 8; false is the default). Tell the orchestrator what Slack said.
2. **Add the two revocation events** (2 min). Open Event Subscriptions → "Subscribe to events on behalf of users" → Add Workspace Event → `app_uninstalled`, then `tokens_revoked` → Save Changes. Don't add a bot user or bot events. Tell the orchestrator whether Slack accepted both, or what it said. This is done in the app settings, not in `manifest.yaml` (M0.24's handoff). Doing it before installing saves a reinstall. If Slack asks you to reinstall after saving, reinstall and save the user token again in step 4.
3. **Install and generate the tokens** (4 min).
   - Install App → Install to Workspace → Allow.
   - Basic Information → App-Level Tokens → Generate Token and Scopes: name `s6-socket`, scope `connections:write` → Generate. Leave the page open.
   - OAuth & Permissions → OAuth Tokens → User OAuth Token (it starts with `xoxp-`).
4. **Save both tokens** (2 min). The orchestrator opens a PowerShell window for you (below), or you open Windows Terminal in the worktree yourself. Run `node spikes/s06-slack/scripts/tokens.ts save` and paste each token when asked; the input stays hidden, and the kit's `saveEnvLive()` stores both in the main checkout's `.env.live`. The window answers `saved DY_LIVE_SLACK_USER_TOKEN and DY_LIVE_SLACK_APP_TOKEN in …\.env.live`; then close it. Never paste a token into the chat.
5. **Wait for "connected"** (about 1 min). The orchestrator starts the run and says when it's connected.
6. **The second user sends four messages** (3 min), any short text: a DM to the owner, one in the group DM, one in `#s6-test` and one in `#s6-private`. The run reports each type as it arrives.
7. **Uninstall the app** (2 min), when the orchestrator relays "Owner: uninstall the app now". In Slack: the workspace menu → Tools & settings → Manage apps → DraftYak S6 spike → Configuration → Remove App. Labels may differ slightly; the app only has to leave the workspace.
8. **Delete the app** (1 min), when the orchestrator relays "Owner: now delete the app". At https://api.slack.com/apps → DraftYak S6 spike → Basic Information → Delete App, then confirm. Deleting also revokes the app-level token.
9. **Answers for ADR 0008:** whether Slack took the manifest unchanged (step 1), whether it accepted both events (step 2), and any warning Slack showed.

## The run (orchestrator)

Open the token window for the owner (step 4). PowerShell:
```powershell
Start-Process powershell.exe -WorkingDirectory $wt -ArgumentList '-NoExit', '-Command', 'node spikes/s06-slack/scripts/tokens.ts save'
```
Git Bash:
```bash
powershell.exe -NoProfile -Command "Start-Process powershell.exe -WorkingDirectory '$(cygpath -w "$WT")' -ArgumentList '-NoExit','-Command','node spikes/s06-slack/scripts/tokens.ts save'"
```
Then check that both tokens are stored, still without seeing them, and start the run in the background:

Git Bash:
```bash
node spikes/s06-slack/scripts/tokens.ts check     # both "set", exit 0
git status --porcelain                            # prints nothing
pnpm --filter @draftyak/spike-s06-slack test:live
```
PowerShell:
```powershell
node spikes/s06-slack/scripts/tokens.ts check
git status --porcelain
pnpm --filter @draftyak/spike-s06-slack test:live
```
Settings go in front of the run: `DRAFTYAK_S6_KEEP_APP=1 pnpm …` in Git Bash, or `$env:DRAFTYAK_S6_KEEP_APP = '1'` before it and `Remove-Item Env:DRAFTYAK_S6_KEEP_APP` after it in PowerShell. Vitest may hide a passing test's console output, so the run writes its `S6 live:` lines straight to stderr, where they show at once. Relay these to the owner:

| The run says | Who acts |
|---|---|
| `connected after … Second user, send now: …` | the second user, owner step 6 |
| `still waiting for message.…` (each minute) | the second user, for the types listed |
| `message.…: nothing from others since the run connected. Second user, send … now` | the second user: nothing of theirs is in that conversation's history yet |
| `Owner: uninstall the app now …` | the owner, step 7 |
| `still waiting for app_uninstalled, …` | nobody: Slack may deliver late |
| `Owner: now delete the app …`, then `waiting for the owner to delete the app` | the owner, step 8 |

Each phase has a limit: connecting 1 minute, messages 15, the uninstall 10 and the delete 10. A run takes about 10 minutes when every event arrives, about 20 when Slack sends no revocation events, and at most about 38.
- **Messages.** Every 3 minutes the run reads the history of each type that has sent no event yet. At 15 minutes each such type gets `not delivered` (a message from someone other than the owner is in its history since the run connected, but no event came), `not sent (…)` (nobody else posted there) or `not confirmed (…)` (the history couldn't be fully read). For `not sent`, or whenever another try is wanted, don't let the owner uninstall: stop the run, which writes nothing, and start it again. The tokens stay valid until the uninstall.
- **The dropped ack.** Unless `DRAFTYAK_S6_DROP_ACK=0`, the run says it dropped one ack, and then that Slack redelivered the message, after how long and with which `retry_attempt`.
- **Uninstall.** The phase ends once `app_uninstalled` and `tokens_revoked` have arrived and auth.test refuses the user token, or after 10 minutes, since Slack may deliver the events late.
- **Delete.** The run polls `apps.connections.open` until Slack refuses the app-level token. If Slack already refused it right after the uninstall, the run can't see the delete, so it waits the full 10 minutes. Then it asks Slack about both tokens once more (`final check: …`); that check decides `revoked`.
- **Clean tree.** The run refuses to start on a tree with uncommitted tracked changes, since the evidence must come from a clean tree. It fails, writing nothing, if Socket Mode can't connect or stops while messages are expected.

It ends with the acceptance lines, one per event type (`received over Socket Mode`, `not delivered`, `not sent (…)` or `not confirmed (…)`), then `exemption: …`, `app_uninstalled: …`, `tokens_revoked: …`, `revoked: …`, `Slack's Date header: …`, and `evidence written to evidence/live.json`, with a count of any header values replaced for their shape.

## After the run (orchestrator, about 5 minutes)

The `.env.live` entries go only once Slack refuses both tokens. Git Bash and PowerShell alike:
- **`revoked: yes`:**
  ```text
  node spikes/s06-slack/scripts/tokens.ts delete    # deleted DY_LIVE_SLACK_USER_TOKEN and DY_LIVE_SLACK_APP_TOKEN …
  node spikes/s06-slack/scripts/tokens.ts check     # both "missing", exit 1
  ```
- **`revoked: no (…)`:** the owner deletes the app, or revokes the token the line names in the app's settings. Then ask Slack again; once both say `refused by Slack (…)`, delete and check as above. ADR 0008 records the manual step.
  ```text
  node spikes/s06-slack/scripts/tokens.ts revoked   # both "refused by Slack (…)", exit 0
  ```
- **`DRAFTYAK_S6_KEEP_APP=1`:** no delete. The tokens stay in `.env.live` for M6, the evidence says `revoked: not done (app kept for M6)`, and ADR 0008 names the date by which the owner revokes them.

Then, in every case:
```text
git status --porcelain --untracked-files=all    # only: ?? spikes/s06-slack/evidence/live.json
pnpm guard                                      # vendor-guard: 0 findings, the evidence included
```
Cleanup checks:
- The owner sees no "DraftYak S6 spike" at https://api.slack.com/apps or under Manage apps.
- No raw Slack id in the evidence, only `hmac:` values. vendor-guard can't recognise ids, though it does catch raw `ts` values, which are long digit runs. Each of these prints nothing:
  - Git Bash: `grep -nE '"[CDGTUW][A-Z0-9]{8,}"' spikes/s06-slack/evidence/live.json`
  - PowerShell: `Select-String -CaseSensitive -Pattern '"[CDGTUW][A-Z0-9]{8,}"' spikes\s06-slack\evidence\live.json`

Commit `evidence/live.json` with ADR 0008. The evidence's fingerprint names the code commit the run used, with `dirty: false`.

## What ADR 0008 records from the evidence

- **Decision.** Go (Socket Mode) when all four message types are `received over Socket Mode`. Go with fallback (the budgeted poller, `src/poller.ts`) for any type `not delivered`, with the plan changes for M6. A type `not sent` or `not confirmed` is never a reason for the fallback: re-run it, or record it as `Not run` for that type. Latency per type (min, median, max): the receive time minus the message's `ts`, from new messages without a subtype only (an edit or a reply notification carries an older `ts`). The clock skew below bounds its error.
- **Sent but not delivered.** Per type without an event, `historySinceConnect`: conversations of that type, how many were read, and the messages from others since the run connected. The poller's `fromOthersSinceConnect` counts the same per type.
- **The connection.** The time to the first `hello`, Slack's `approximate_connection_time`, every refresh (`warning`, `refresh_requested`), the reconnects and `apps.connections.open` calls, and the WebSocket pings and their interval (for M6's dead-connection check). `retryProbe` answers notes open point 7: whether Slack redelivered the envelope whose ack was dropped, after how long, with which `retry_attempt` and `retry_reason`, under a new `envelope_id` or not, and with the same `event_id` or not. That confirms or corrects FakeSlack's redelivery shape.
- **Rate-limit headers** (open point 4) of `conversations.info`, `.history` and `.replies`, plus `auth.test`, `users.conversations` and `apps.connections.open`. These are the header names, with values only for `*ratelimit*`, `retry-after` and `content-type`; whole-number values are kept as numbers, and `headerValuesReplaced` counts values replaced for an unexpected shape. They show whether Slack sends any limit header on success.
- **The exemption** (open point 2): `holds`, `inconclusive`, `does not hold (capped …)` or `does not hold (… rate limited …)`, from `conversations.history` with `limit` 100 on the owner's public channels in turn until one returns more than 15 messages, then a second call on it in the same minute, and from any rate limit on history or replies during the run. This is the dependency ADR 0015 builds on; cross-reference ADR 0015 if it doesn't hold. The limit ceiling (open point 3: 1,000 or 999) would need 1,000 messages, so it stays as documented.
- **`conversations.info`'s channel fields** per conversation type, read with `include_num_members`: which of the pre-claim facts (archived, shared, type, member count as `num_members`) the read returns.
- **Slack's `Date` header** (plan §3 Clock rule; ADR 0015's `secondNow`): on how many responses it came, whether every one round-trips as an IMF-fixdate, and the skew against this machine (min, median, max; the header counts whole seconds, so it reads up to a second low).
- **One poller cycle** against Slack: conversations read, failures and cut-off reads, the live check of the fallback.
- **Revocation** (open point 6). Whether Slack accepted `app_uninstalled` and `tokens_revoked` as user events (owner step 2), and whether each arrived over Socket Mode on uninstall, how soon, and whether `tokens_revoked` listed the owner. auth.test's answer after the uninstall, and how soon it refused, is the hub's own check (plan §3 Revocation); only Slack's auth codes (`token_revoked`, `invalid_auth`, `account_inactive`, `not_authed`, `token_expired`) count as a refusal, and anything else reads `unexpected (…)`. Also: whether the app-level token still works after the uninstall (it belongs to the app, not the install) and is refused once the app is deleted, what Socket Mode did meanwhile, and the final check of both tokens.
- **Cleanup.** `revoked: yes` and the deleted `DY_LIVE_SLACK_*` entries, any manual revoke with its `tokens.ts revoked` result, or the keep-for-M6 decision.
- **The manifest** as Slack took it (open point 8), and the re-read: unchanged, or each change.
- **Kept from M0.24's notes:** `users.conversations` in place of plan §4's `conversations.list`, and Slack's written confirmation (open point 1) with its date, or still pending.
- **Kept tests:** `spikes/s06-slack/test/socket-mode.test.ts`, `test/poller.test.ts` and `test/reduce.test.ts` (`pnpm --filter @draftyak/spike-s06-slack test`), going to M6 `plugins/channel-slack/`. FakeSlack goes to `@draftyak/fakes`, seeded from `test/fake-slack.ts`.
