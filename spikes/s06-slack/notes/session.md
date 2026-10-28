# S6b Slack live: session 2 runbook (M0.25)

This session answers S6 (plan §15): do Slack's user events reach a bot-less internal app over Socket Mode, per conversation type? It also records the rate-limit headers of the claim-time reads, checks the internal-app rate exemption, measures Slack's `Date` header against this machine's clock, and sees what Slack sends when the owner uninstalls the app. The owner and a second user take part for about 30 minutes; everything else is the orchestrator's.

The run is `test/events.live.test.ts`. It drives `test/live-session.ts`, the same code `test/rehearsal.test.ts` runs against FakeSlack in every `pnpm test`. It writes `evidence/live.json` (counts, timings, Slack's codes, header names, Slack ids and `ts` only as per-session HMACs, never text), which ADR 0008 cites. `scripts/tokens.ts` handles the tokens and `scripts/quotes.ts` the re-read of Slack's pages. Nothing here edits `manifest.yaml`.

## Before the session (orchestrator, about 20 minutes, no owner)

Use a worktree at an `m0` commit that includes M0.25, with a clean tree and dependencies installed. The kit finds the main checkout's `.env.live` from any worktree. The main checkout (`C:/dev/draftyak`) holds `.env.live`, so it must stay on a branch whose `.gitignore` lists `.env.live`, such as `m0`: on `main`, the empty root commit, `saveEnvLive()` refuses to write the file. The commands below name the worktree `WT` (Git Bash) or `$wt` (PowerShell); set it again in each new shell.

1. **Worktree and rehearsal** (5 min).

   Git Bash:
   ```bash
   WT='/c/dev/draftyak-wt/<session worktree>'
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

2. **Vendor-guard on the rehearsal's evidence** (3 min). The rehearsal writes synthetic evidence into a missing or empty scratch folder outside every git worktree. Run the guard from that scratch repository using the worktree's absolute CLI path, then check for raw Slack IDs. Retain the scratch folder for inspection until these checks pass.

   Git Bash:
   ```bash
   OUT="$(cygpath -m "$(mktemp -d)")"
   DRAFTYAK_S6_REHEARSAL_DIR="$OUT" pnpm --filter @draftyak/spike-s06-slack test test/rehearsal.test.ts --reporter=default
   (cd "$OUT" && node "$WT/tools/vendor-guard/src/cli.ts")
   grep -nE '"[CDGTUW][A-Z0-9]{8,}"' "$OUT"/spikes/s06-slack/evidence/*.json
   git -C "$WT" status --porcelain
   ```
   PowerShell:
   ```powershell
   $out = Join-Path ([IO.Path]::GetTempPath()) ("s06-rehearsal-" + [guid]::NewGuid().ToString('N'))
   $env:DRAFTYAK_S6_REHEARSAL_DIR = $out
   try {
     pnpm --filter @draftyak/spike-s06-slack test test/rehearsal.test.ts --reporter=default
   } finally {
     Remove-Item Env:DRAFTYAK_S6_REHEARSAL_DIR
   }
   Push-Location $out
   try { node "$wt/tools/vendor-guard/src/cli.ts" } finally { Pop-Location }
   Select-String -CaseSensitive -Pattern '"[CDGTUW][A-Z0-9]{8,}"' "$out/spikes/s06-slack/evidence/*.json"
   git -C $wt status --porcelain
   ```
   The guard reports 0 findings; the ID scan and worktree status print nothing. An interrupted or failing check leaves the synthetic files in the external scratch folder for inspection. Remove only that exact scratch folder after inspection.

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

Open the token window for the owner (step 4) using a temporary two-line script outside every repository. The script saves hidden input, then waits at a secure close prompt. Start PowerShell with `-NoProfile`; the child also uses `-NoProfile` and `-File`, and closes after the prompt.

PowerShell:
```powershell
$tokenWindow = Join-Path ([IO.Path]::GetTempPath()) ('s06-token-window-' + [guid]::NewGuid().ToString('N') + '.ps1')
@'
node spikes/s06-slack/scripts/tokens.ts save
$null = Read-Host -AsSecureString 'Press Enter to close this window'
'@ | Set-Content -LiteralPath $tokenWindow -Encoding utf8
Start-Process powershell.exe -WorkingDirectory $wt -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $tokenWindow)
```
Git Bash:
```bash
TOKEN_WINDOW="$(mktemp --suffix=.ps1)"
cat > "$TOKEN_WINDOW" <<'POWERSHELL'
node spikes/s06-slack/scripts/tokens.ts save
$null = Read-Host -AsSecureString 'Press Enter to close this window'
POWERSHELL
powershell.exe -NoProfile -Command "Start-Process powershell.exe -WorkingDirectory '$(cygpath -w "$WT")' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"$(cygpath -w "$TOKEN_WINDOW")\"'"
```
After the owner has saved both tokens and pressed Enter to close the window, remove that exact temporary script. Rehearse the paste/close behavior with synthetic values before the real token step.

Then perform the existing token-presence and clean-tree checks from the session checkout's root, without showing a token:

```text
node spikes/s06-slack/scripts/tokens.ts check
git status --porcelain
```

Both tokens must be set and the tracked tree clean. In the same managed shell, set `DRAFTYAK_S6_LOGS` to an existing private log folder outside every checkout and the token store. Submit the complete invocation below as a managed background task/session that stays alive through the native wait and receipt write. Its task lifetime must accommodate the existing 45-minute live-test timeout plus startup/shutdown; this changes no harness phase or timeout. Do not detach the wrapper and return early. Its printed fresh log basename identifies only this invocation.

Git Bash, in a managed `--noprofile --norc` shell from the session checkout root:

```bash
: "${DRAFTYAK_S6_LOGS:?Set the existing private log folder}"; s6_log="$(mktemp "$DRAFTYAK_S6_LOGS/s06-live-$(date +%Y%m%d-%H%M%S)-XXXXXX")" || exit 1; printf '%s\n' "$s6_log"; (if cd spikes/s06-slack && env DO_NOT_TRACK=1 DRAFTYAK_STRICT_SKIPS=1 node ../kit/run.ts --live --reporter=default --exclude '**/*siwc*/**' --exclude '**/*siwc*' --exclude '**/*dynamic-agent*' --exclude '**/*dynamic_agent*'; then s6_exit=0; else s6_exit=$?; fi; printf '%s\n' "$s6_exit" >"$s6_log.exit" || exit 1; exit "$s6_exit") >"$s6_log.stdout.log" 2>"$s6_log.stderr.log" & s6_pid=$!; printf '%s\n' "$s6_pid" >"$s6_log.pid"; wait "$s6_pid"
```

PowerShell, in a managed `-NoProfile` shell from the session checkout root:

```powershell
$ErrorActionPreference = 'Stop'
$s6Log = Join-Path $env:DRAFTYAK_S6_LOGS ('s06-live-' + (Get-Date -Format yyyyMMdd-HHmmss) + '-' + [Guid]::NewGuid().ToString('N'))
Write-Output $s6Log
$previousStrictSkips = $env:DRAFTYAK_STRICT_SKIPS
$previousDoNotTrack = $env:DO_NOT_TRACK
$env:DRAFTYAK_STRICT_SKIPS = '1'
$env:DO_NOT_TRACK = '1'
try {
  $s6Process = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('../kit/run.ts', '--live', '--reporter=default', '--exclude', '**/*siwc*/**', '--exclude', '**/*siwc*', '--exclude', '**/*dynamic-agent*', '--exclude', '**/*dynamic_agent*') -WorkingDirectory (Join-Path $PWD 'spikes/s06-slack') -WindowStyle Hidden -PassThru -RedirectStandardOutput ($s6Log + '.stdout.log') -RedirectStandardError ($s6Log + '.stderr.log')
  $null = $s6Process.Handle
  $s6Process.Id | Set-Content -LiteralPath ($s6Log + '.pid') -Encoding ascii
  $s6Process.WaitForExit()
  $s6Exit = $s6Process.ExitCode
  if ($null -eq $s6Exit) { throw 'The owned process did not provide an exit code' }
  [IO.File]::WriteAllText(($s6Log + '.exit'), ([string]$s6Exit + [Environment]::NewLine), [Text.Encoding]::ASCII)
  exit $s6Exit
} finally {
  if ($null -eq $previousStrictSkips) { Remove-Item Env:DRAFTYAK_STRICT_SKIPS -ErrorAction SilentlyContinue } else { $env:DRAFTYAK_STRICT_SKIPS = $previousStrictSkips }
  if ($null -eq $previousDoNotTrack) { Remove-Item Env:DO_NOT_TRACK -ErrorAction SilentlyContinue } else { $env:DO_NOT_TRACK = $previousDoNotTrack }
}
```

These invoke the existing `test:live` entry directly through the kit runner. Strict skips are `1` during this live invocation; Bash confines its assignment to the child command, and PowerShell restores the previous value in its managed shell's `finally`. Other owner-selected settings retain their existing meanings and cleanup; no token belongs in a command or log.

Keep the wrapper shell/process object through `WaitForExit()` and reading `ExitCode`; PowerShell writes an ASCII integer-only `<log basename>.exit` receipt in that same invocation and exits with the native status. Bash must keep its receipt-writing group and wait in the originating managed shell. A fresh shell may inspect saved evidence after completion, but cannot `wait` on another shell's child or recover its status from PID disappearance.

Completion requires all three: the managed task completed successfully with exit0, this invocation's fresh receipt contains exactly ASCII `0` followed by LF or CRLF, and guarded logs contain the final passed `Test Files` summary. A missing/malformed/nonzero receipt, cancelled/pending task or missing/failed summary is not a pass. Never infer completion from a PID, elapsed time, a vanished process or a summary alone. Do not rerun while the managed task or any owned child remains.

PowerShell's `.pid` records the native Windows child; stop only its verified owned process/descendants through the managed task or retained OS handles. Bash's `s6_pid` and `.pid` identify an MSYS wrapper, not a taskkill-safe Windows PID. Bash cancellation requires a managed session that retains the owned Windows child handles; otherwise use PowerShell. Stopping only a wrapper does not prove children ended. Never search broadly by process name. Relay new prompt lines promptly from the current guarded logs.


Vitest may hide a passing test's console output, so the run writes its `S6 live:` lines straight to stderr, where they show at once. Relay these to the owner:

| The run says | Who acts |
|---|---|
| `connected after … Second user, send now: …` | the second user, owner step 6 |
| `still waiting for message.…` (each minute) | the second user, for the types listed |
| `message.…: nothing from others since the run connected. Second user, send … now` | the second user: nothing of theirs is in that conversation's history yet |
| `Owner: uninstall the app now …` | the owner, step 7 |
| `still waiting for app_uninstalled, …` | nobody: Slack may deliver late |
| `Owner: now delete the app …`, then `waiting for the owner to delete the app` | the owner, step 8 |

The phase settings remain: connecting 1 minute, messages 15, the uninstall 10 and the delete 10. About 10 minutes when every event arrives, 20 when revocation events do not arrive, and 38 for a long run are planning estimates, not elapsed-time maxima. Paced reads, including the existing final history check after the message wait, can extend the duration. The live test retains its 45-minute timeout; no phase or request allowance is increased.
- **Messages.** Every 3 minutes the run reads the history of each type that has sent no event yet. After the 15-minute wait and final history check, each absent type gets `not delivered` (history contains a message from someone other than the owner, no event came, and continuity is confirmed), `not sent (…)` (nobody else posted there) or `not confirmed (…)` (incomplete history, untyped events from others, or interrupted/unknown continuity prevents a conclusion). The delivery window includes the final history check, but excludes later uninstall/deletion closes. For `not sent` or `not confirmed`, or whenever another try is wanted, do not relay a later uninstall cue. Stop only this invocation's verified owned processes, preserve any existing evidence, and review the current observed credential/cleanup state with the owner before an existing retry. Early revocation can precede the cue, so cue order alone does not prove that tokens still work; an event alone also does not prove credential refusal. If validity or cleanup is uncertain, stop for the normal owner cleanup/disposition. This prescribes no additional verification calls or retry allowance.
- **Read pacing.** History and replies share the configured Tier 3 token bucket (50 reads/minute, burst 5), and each call's time is stamped after its pacing wait. This bucket does not guarantee at most 50 sends in every sliding minute. At the first history/replies 429, 50 or more actual sends in the preceding 60 seconds makes the exemption result `inconclusive`, rather than attributing that limit to Slack's app policy.
- **The dropped ack.** Unless `DRAFTYAK_S6_DROP_ACK=0`, the run says it dropped one ack, and then that Slack redelivered the message, after how long and with which `retry_attempt`.
- **Uninstall.** The phase ends once `app_uninstalled` and `tokens_revoked` have arrived and auth.test refuses the user token, or after 10 minutes, since Slack may deliver the events late. Events received before the uninstall prompt are announced and retained. Such an event does not prove credential refusal; review an early arrival with the owner, and keep the token checks separate.
- **Delete.** The run polls `apps.connections.open` until Slack refuses the app-level token. If Slack already refused it right after the uninstall, the run can't see the delete, so it waits the full 10 minutes. Then it asks Slack about both tokens once more (`final check: …`); that check decides `revoked`.
- **Clean tree.** The run refuses to start on a tree with uncommitted tracked changes, since the evidence must come from a clean tree. It fails, writing nothing, if Socket Mode can't connect or stops while messages are expected.

It prints `Slack's Date header: …` first, then the acceptance lines, one per event type (`received over Socket Mode`, `not delivered`, `not sent (…)` or `not confirmed (…)`), then `exemption: …`, `app_uninstalled: …`, `tokens_revoked: …`, `revoked: …`, and `evidence written to evidence/live.json`, with a count of any header values replaced for their shape.

## After the run (orchestrator, about 5 minutes)

The `.env.live` entries go only once both saved tokens are verified as refused. Ordinary `delete` independently asks `auth.test` and `apps.connections.open` exactly once each. Both must return HTTP 200 with one of `token_revoked`, `invalid_auth`, `account_inactive`, `not_authed` or `token_expired`; then the helper rechecks that neither saved token changed before deleting the pair. These are two additional verification requests after the run's final check, with no socket connection.

Accepted, unknown, network-error and non-200 responses preserve the file's exact bytes, including auth-looking bodies on 403, 429 or 5xx. A partial/invalid pair or a pair replaced during verification is also preserved; both entries already absent is an idempotent no-op. There is no force bypass. If deletion refuses, retain the store, resolve the app/token state with the owner and retry verification. A prior `revoked: yes` or revocation event never bypasses these checks. Git Bash and PowerShell alike:
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
- **The connection.** The time to the first `hello`, Slack's `approximate_connection_time`, every refresh (`warning`, `refresh_requested`), the reconnects and `apps.connections.open` calls, and the WebSocket pings and their interval (for M6's dead-connection check). Continuity uses the full internal state history through the final message-history check, rather than only the first 100 serialized state examples. `eventsContinuity` records the window, gap count/first gap and proven planned overlaps; `stateCount` and `stateExamplesOmitted` describe the bounded examples. A planned old-socket close is exempt only when its refresh and another non-draining socket's hello were observed before that close. Quick recovery alone does not erase a gap. Untyped messages from others or unproven continuity make absent types `not confirmed`; neither justifies the poller fallback. `retryProbe` answers notes open point 7: whether Slack redelivered the envelope whose ack was dropped, after how long, with which `retry_attempt` and `retry_reason`, under a new `envelope_id` or not, and with the same `event_id` or not. That confirms or corrects FakeSlack's redelivery shape.
- **Rate-limit headers** (open point 4) of `conversations.info`, `.history` and `.replies`, plus `auth.test`, `users.conversations` and `apps.connections.open`. These are the header names, with values only for `*ratelimit*`, `retry-after` and `content-type`; whole-number values are kept as numbers, and `headerValuesReplaced` counts values replaced for an unexpected shape. They show whether Slack sends any limit header on success.
- **Call evidence.** `rateLimits.calls` retains the first 100 `sent check` examples and every other retained call record in original order, including later claim-time reads, exemption probes and final token checks. `omittedSentCheckCalls` reports the exact omitted example count. Verdicts use the complete internal read-attempt audit; the serialized total may exceed 200 without increasing any request budget.
- **The exemption** (open point 2): `holds`, `inconclusive`, `does not hold (capped …)` or `does not hold (… rate limited …)`, from `conversations.history` with `limit` 100 on the owner's public channels in turn until one returns more than 15 messages, then a second call on it in the same minute, and from any rate limit on history or replies during the run. This is the dependency ADR 0015 builds on; cross-reference ADR 0015 if it doesn't hold. The limit ceiling (open point 3: 1,000 or 999) would need 1,000 messages, so it stays as documented.
- **`conversations.info`'s channel fields** per conversation type, read with `include_num_members`: which of the pre-claim facts (archived, shared, type, member count as `num_members`) the read returns.
- **Slack's `Date` header** (plan §3 Clock rule; ADR 0015's `secondNow`): on how many responses it came, whether every one round-trips as an IMF-fixdate, and the skew against this machine (min, median, max; the header counts whole seconds, so it reads up to a second low).
- **One poller cycle** against Slack: conversations read, failures and cut-off reads, the live check of the fallback.
- **Revocation** (open point 6). Whether Slack accepted `app_uninstalled` and `tokens_revoked` as user events (owner step 2), and whether each arrived over Socket Mode, how soon, and whether `tokens_revoked` listed the owner. Events are selected from all arrivals in the run, including before the uninstall cue: `beforeCue: true` marks an early first arrival and its signed `afterCueMs` is retained (null if no cue was planned). Arrival is independent of the token-refusal verdict. auth.test's answer after the uninstall, and how soon it refused, is the hub's own check (plan §3 Revocation); only Slack's auth codes (`token_revoked`, `invalid_auth`, `account_inactive`, `not_authed`, `token_expired`) count as a refusal, and anything else reads `unexpected (…)`. Also: whether the app-level token still works after the uninstall (it belongs to the app, not the install) and is refused once the app is deleted, what Socket Mode did meanwhile, and the final check of both tokens. The later deletion command applies its separate HTTP 200-only verification policy above.
- **Cleanup.** `revoked: yes` and the deleted `DY_LIVE_SLACK_*` entries, any manual revoke with its `tokens.ts revoked` result, or the keep-for-M6 decision.
- **The manifest** as Slack took it (open point 8), and the re-read: unchanged, or each change.
- **Kept from M0.24's notes:** `users.conversations` in place of plan §4's `conversations.list`, and Slack's written confirmation (open point 1) with its date, or still pending.
- **Kept tests:** `spikes/s06-slack/test/socket-mode.test.ts`, `test/poller.test.ts` and `test/reduce.test.ts` (`pnpm --filter @draftyak/spike-s06-slack test`), going to M6 `plugins/channel-slack/`. FakeSlack goes to `@draftyak/fakes`, seeded from `test/fake-slack.ts`.
