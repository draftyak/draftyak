# S8b session runbook (M0.29, session 1)

The live half of S8: what the owner does, what the orchestrator runs, and what ADR 0010 records afterwards. It takes about 70 minutes, with the owner present for about 50, including scheduling one mail in the Gmail web UI. The code is `test/gmail.live.test.ts` (one step per run), `test/live-session.ts` (the steps) and `test/live-cli.ts` (client import, disclosure, send time, status, cleanup); `test/rehearsal.test.ts` runs the same steps against FakeGmail and fake Google OAuth on every `pnpm test`.

Ground rules for the whole session:
- Secrets go only into the main checkout's `.env.live`, through `live-cli.ts save-client` and the connect step (both call the kit's `saveEnvLive`). Nobody pastes a client secret or token into a chat, a command line or a file.
- Record the consent wording as typed text, with the account's name and address replaced by `<account>`. No screenshots.
- Before each consent (steps 1 to 3), the orchestrator shows the owner that client's disclosure text in the chat and waits for the owner's OK: `node spikes/s08-gmail/test/live-cli.ts disclosure agent` (or `standard`) prints it. This stands in for M5's wizard, which shows it before Google's consent.
- At most 8 API sends in the session (the steps refuse more), plus the one scheduled mail. "Mail sending" (429) is never provoked: it can lock sending for hours.
- Everything content-free goes to the session folder, `C:/dev/.draftyak-cache/s08-session` (or `DRAFTYAK_S8_SESSION`). Evidence is written only by the report step.

## Before the session (owner, about 20 minutes, any day before)

Use a browser profile signed in only to the test Gmail account. Steps 2 to 4 follow `notes/consent-and-policy.md`.

1. **Cloud project.** In the Google Cloud console, create the test project (or use the one from the week-1 pre-task), then APIs & Services → Library → Gmail API → Enable.
2. **Branding** (Google Auth Platform → Branding): app name "DraftYak S8 spike", the test account as support and developer contact. Leave the homepage, privacy policy and terms empty for now; the homepage check comes later in the session.
3. **Audience:** user type External, publishing status Testing, and the test Gmail address as the only test user.
4. **Data access:** add `openid`, `.../auth/userinfo.email` and `.../auth/gmail.modify`.
5. **Client without the flag** (Clients → Create client): application type Desktop app, name `s8-standard`, "Use this client for an AI-powered agent" off. In the dialog that follows, choose Download JSON before closing it: Google may show the secret only once.
6. **Client with the flag:** the same, named `s8-agent`, with the AI-powered-agent option on. Download its JSON too.
7. Tell the orchestrator the two downloaded file names, your second e-mail address (the mailbox the probes go to; not the test account, nor a `+tag` or dotted form of it), the test account's address, and the test account's name exactly as Google shows it.

The placeholder homepage on draftyak.com, verified in Search Console, should be live by then (owner pre-task, 2026-10-22). If it isn't, say whether you want to skip the homepage check, and why.

## Preparing the checkout (orchestrator, about 5 minutes)

Run the session from an installed worktree of a branch made from `origin/m0` with M0.29 merged, with no tracked changes: the report step records evidence only from a clean checkout at the commit every step ran on. The worktree reads `.env.live` from the main checkout.

Re-read the policy pages that `notes/consent-and-policy.md` cites, and note whether anything changed since 2026-10-16 (`policyPages` below).

Import the clients (the same command in Git Bash and PowerShell; quote the paths). Each call saves `DY_LIVE_GMAIL_CLIENT_ID` and `DY_LIVE_GMAIL_CLIENT_SECRET`, or the `DY_LIVE_GMAIL_AGENT_*` pair, through `saveEnvLive`, then deletes the download. It refuses a file whose client is already saved under the other name:

```
node spikes/s08-gmail/test/live-cli.ts save-client standard "C:/Users/<you>/Downloads/<s8-standard's file>.json"
node spikes/s08-gmail/test/live-cli.ts save-client agent "C:/Users/<you>/Downloads/<s8-agent's file>.json"
node spikes/s08-gmail/test/live-cli.ts status
```

Then write `C:/dev/.draftyak-cache/s08-session/input.json` as UTF-8 (the Write tool, or PowerShell's `Set-Content -Encoding utf8`; a byte-order mark is fine, UTF-16 from `>` is refused):

```json
{
  "secondAddress": "<the owner's second address>",
  "testAccount": "<the test Gmail address>",
  "accountName": "<the test account's name as Google shows it>"
}
```

`testAccount` goes to Google as `login_hint` on each consent, and connect refuses (and revokes) a grant from any other account. `accountName` is for the report step, which refuses observations that contain it.

Define the step command once per shell. Each run prints its lines only with `--reporter=default` (Vitest hides passing tests' output in agent shells). The optional second word is the owner's declaration (below).

Git Bash:

```bash
export DO_NOT_TRACK=1
s8() { DRAFTYAK_S8_STEP="$1" DRAFTYAK_S8_OUTCOME="${2:-}" pnpm --filter @draftyak/spike-s08-gmail test:live -- --reporter=default; }
```

PowerShell:

```powershell
$env:DO_NOT_TRACK = '1'
function s8($step, $outcome) {
  $env:DRAFTYAK_S8_STEP = $step
  if ($outcome) { $env:DRAFTYAK_S8_OUTCOME = $outcome }
  try { pnpm --filter @draftyak/spike-s08-gmail test:live -- --reporter=default }
  finally {
    Remove-Item Env:DRAFTYAK_S8_STEP
    if (Test-Path Env:DRAFTYAK_S8_OUTCOME) { Remove-Item Env:DRAFTYAK_S8_OUTCOME }
  }
}
```

`pnpm --filter @draftyak/spike-s08-gmail test:live` without a step only checks the `.env.live` entries and prints the session's state, like `live-cli.ts status`; it skips when entries are missing. A step that is asked for fails when its entries are missing, so it never passes as a skip.

## The steps

| # | Command | Who | Time | What happens |
|---|---|---|---|---|
| 1 | `s8 agent` | both | 3 min | After the agent client's disclosure in the chat: one consent on the agent client. Allow everything, and copy the page's wording. Prints whether Gmail's API took the token. The grant is then revoked, and refreshes repeat for up to a minute (then a second revoke and another minute) until Google answers `invalid_grant`; only then does the step print `grant revoked` and record. If Google's redirect brings back its own error code, the step records that refusal. If Google shows its own error page and nothing comes back (the step times out after 5 minutes), record the refusal with `s8 agent refused` and copy that page's wording. Cancel by mistake (`access_denied`): rerun `s8 agent`. |
| 2 | `s8 drop` | both | 3 min | The scope drop, on the standard client before it has any grant: after the standard client's disclosure, untick the Gmail permission and continue. connect() refuses the grant and revokes it; refreshes then have to end in `invalid_grant` as in step 1. Prints `scope drop: …`. If the page offers no Gmail checkbox, press Cancel and record that with `s8 drop no-checkbox`. |
| 3 | `s8 connect` | both | 3 min | After the standard disclosure: one consent on the standard client; allow everything, copy the wording. The refresh token goes into `.env.live` as `DY_LIVE_GMAIL_REFRESH_TOKEN`. |
| 4 | `s8 send` | orchestrator, then owner | 5 min | Sends the probe "DY S8 send probe" to the second address with the test account in Bcc, back-dated 90 s, then a reply into its thread: 2 of the 8 sends. A failed read-back is read again (up to 4 tries), never recorded as inconclusive. Prints `messageId preserved`, `date preserved`, Bcc, index delay, thread, reconcile and `threads.get` lines. Then the owner opens the probe in the second mailbox, shows the original message, and says whether it has a `Bcc:` line. |
| 5 | `s8 concurrency` | orchestrator | 1 min | Bursts of parallel reads (10, 25, 50 and 100 profile reads, then 40 one-message lists; at most 225 requests) until Gmail answers with a limit: a 429, or a 403 rate limit. Prints `429 concurrent: …`. |
| 6 | `s8 schedule` | orchestrator, then owner | 3 min | Records the history start point and prints the send time to pick: at least 10 minutes ahead, on a whole minute. The owner writes a new mail in the Gmail web UI to the second address, subject "DY S8 scheduled probe", one line of text, and uses the arrow beside Send → Schedule send → Pick date & time → exactly that time. The owner confirms the time picked; if it differs, record it before step 7: `node spikes/s08-gmail/test/live-cli.ts send-at <HH:MM>` (the computer's clock). |
| 7 | `s8 scheduled` | orchestrator | 1–4 min | Right after the owner scheduled it, before the time it printed (a minute before the send time). Its labels when first seen and after Gmail's search index caught up, whether `in:scheduled` and a SCHEDULED label filter list it (up to 90 s each, but never past a minute before the send time), `in:sent`, `in:drafts`, the history events. Prints `in:scheduled: works` or `fails`. If the mail already went out, or goes out while the step reads, the step stops without recording: rerun `schedule` and schedule a new mail. |
| 8 | homepage check | owner | 10 min | While the mail waits; see below. |
| 9 | `s8 sent` | orchestrator | 1–8 min | After the send time (it refuses to start more than a minute before it): waits until the mail went out, then records its labels, whether it kept its id, the history events since the step 7 look that first showed it scheduled, and whether `sentIn()` counts it. |
| 10 | `s8 revoke` | orchestrator | 1–3 min | Revokes the standard grant at `https://oauth2.googleapis.com/revoke`, waits for `invalid_grant` as in step 1, and only then deletes every `DY_LIVE_GMAIL_*` entry. |
| 11 | delete the clients | owner | 2 min | First, `node spikes/s08-gmail/test/live-cli.ts status` must show `grants: agent ended (invalid_grant)` (or `none (no grant made)`), `drop ended (invalid_grant)` (or `none (no grant made)`) and `standard ended (invalid_grant)`. Then Google Auth Platform → Clients: delete `s8-standard` and `s8-agent`. |
| 12 | observations, then `s8 report` | orchestrator | 10 min | Fill in the observations (below), preview the report, then record it. |

A step that fails can be rerun on its own; its result replaces the earlier one, and a failed step never replaces it. A consent waits 5 minutes for the browser; a consent the owner didn't finish (closed, timed out, Cancel) or a failed token request is rerun, never recorded. A step that stops because a grant still refreshes says so: rerun it while the client exists (its revoke ends the client's whole grant), or remove the app's access in the test account (Google Account → Security → Your connections to third-party apps), then rerun it. `drop` must run before `connect`. Rerunning `send` counts against the 8-send limit. If `scheduled` says the history start point expired, or the mail went out, rerun `schedule` and schedule a new mail; first cancel any earlier scheduled probe still waiting (Gmail → Scheduled → open it → Cancel send) and delete the draft that leaves.

The consent steps can outlast the Bash tool's 10-minute foreground limit if the owner is slow; run them in the background there and watch the output for the disclosure lines.

### The homepage check (step 8)

It decides `homepage` and `publishing status`, and it is mandatory unless the owner declines it, with a reason (recorded as `homepage: not checked(<reason>)`).

1. **Publish without the homepage.** With the Branding links still empty: Audience → Publish app. Note whether Google published it or blocked it (and the message, without personal data). If it published, choose Back to testing.
2. **With the homepage.** Branding: add `draftyak.com` as an authorized domain, `https://draftyak.com/` as the homepage and the placeholder's privacy page as the privacy policy; save. Then Publish app again. `accepted` means Google saved the homepage and published the app; `rejected` means it refused the URL or refused to publish because of it.
3. Note the status the hub's client should have after M0: `production` if publishing worked and the owner wants it, else `testing`, whose grants (refresh tokens included) end 7 days after consent.

### The observations

Add an `observations` object to `input.json` before the report step. The report refuses missing or unknown fields, `@`, runs of 6 or more digits, any `<placeholder>` other than `<account>`, invisible format characters (bidi controls, zero-width marks; retype such a line), and the test account's name from `accountName` in any case, or any word of it of three or more letters as written. It lists every problem by its path, never by its value. `live-cli.ts status` shows whether they are complete.

```json
{
  "secondAddress": "<the owner's second address>",
  "testAccount": "<the test Gmail address>",
  "accountName": "<the test account's name as Google shows it>",
  "observations": {
    "consent": {
      "agent": {
        "wording": ["<each line of the consent page, top to bottom, with <account> for the account>"],
        "screens": ["disclosure", "account-chooser", "unverified-app", "consent", "done"],
        "scopeCheckboxes": true
      },
      "standard": { "wording": ["<…>"], "screens": ["<…>"], "scopeCheckboxes": true }
    },
    "bccInToCopy": "absent | present | not checked",
    "publishing": {
      "atConsent": "testing",
      "withoutHomepage": "published | blocked | not tried",
      "homepage": "accepted | rejected | not checked",
      "homepageReason": "<only when not checked: the owner's reason>",
      "final": "testing | production"
    },
    "readings": {
      "R1": { "verdict": "consistent | inconsistent | unclear", "note": "<optional>" },
      "R2": { "verdict": "…" }, "R3": { "verdict": "…" }, "R4": { "verdict": "…" }, "R5": { "verdict": "…" }
    },
    "policyPages": "unchanged | changed",
    "policyNote": "<only when changed: what changed>",
    "clientsDeleted": true
  }
}
```

`screens` is the order of what the owner saw, as short names; `disclosure` is the text the orchestrator showed in the chat before the consent. For the agent client, `scopeCheckboxes` also records whether its consent page offered the per-permission checkboxes that step 2 used on the standard client. The readings R1–R5 and the sentences (a)–(e) they rest on are in `notes/consent-and-policy.md`; the report adds the letters.

### Recording (step 12)

Preview first: `s8 report` writes `C:/dev/.draftyak-cache/s08-session/evidence/live.json` and prints the lines below. Read the preview, then record into `spikes/s08-gmail/evidence/live.json`:

- Git Bash: `DRAFTYAK_RECORD_EVIDENCE=1 DRAFTYAK_S8_STEP=report pnpm --filter @draftyak/spike-s08-gmail test:live -- --reporter=default`
- PowerShell: `$env:DRAFTYAK_RECORD_EVIDENCE = '1'; s8 report; Remove-Item Env:DRAFTYAK_RECORD_EVIDENCE`

It records only when `revoked: yes` and the checkout is clean at the commit every step ran on; otherwise it says why and leaves the preview. The output starts with the acceptance lines:

```
messageId preserved: yes|no
date preserved: yes|no
in:scheduled: works|fails
scope drop: <behaviour>
agent flag: wording recorded (with, without)
publishing status: Testing (refresh 7d)|Production
homepage: accepted|rejected|not checked(<owner reason>)
429 concurrent: <shape>
429 mail sending: documented only (not provoked)
revoked: yes
```

followed by the extra checks: Bcc, index delay, `threads.get` minimal, reconcile, Publish without the homepage and the readings.

## Revocation and cleanup checks

- `s8 agent` printed `grant revoked (refresh: invalid_grant)` (or that Google refused the consent), and `s8 drop` printed `scope drop: … grant revoked by … (refresh: invalid_grant)` (or `not possible at consent`). Neither records a grant that still refreshes.
- `s8 revoke` printed `refresh afterwards: invalid_grant` and `left: none`.
- `node spikes/s08-gmail/test/live-cli.ts status` shows every `DY_LIVE_GMAIL_*` entry as missing and every grant as ended or none, before the clients are deleted.
- Both clients are gone from Google Auth Platform → Clients. Optionally, the test account's Google Account → Security → third-party connections no longer lists the app.
- `pnpm guard` reports 0 findings, the new evidence included; `git status` shows only `spikes/s08-gmail/evidence/live.json` (and later ADR 0010).
- Once the evidence is committed: `node spikes/s08-gmail/test/live-cli.ts forget` deletes the session folder, which holds the addresses, the account's name and the session's working Gmail ids.

If the session stops early: run `s8 revoke` if connect saved a grant (`status` shows `DY_LIVE_GMAIL_REFRESH_TOKEN: set`), else `node spikes/s08-gmail/test/live-cli.ts delete-entries`, which deletes every `DY_LIVE_GMAIL_*` entry. If a step stopped because a grant still refreshes, remove the app's access in the test account first. Then delete both clients (that ends every grant they hold) and run `forget`.

## What ADR 0010 records

From `evidence/live.json`, the observations and `notes/consent-and-policy.md`:

1. Reconcile: `rfc822msgid:` if the Message-ID is kept, else the `in:sent` fallback; the measured index delay that M5 waits before concluding `not_found`; and the new-thread refinement (a match in a thread that began after the attempt), a deviation from the plan's literal "match on threadId".
2. The claim-time `Date`: kept or rewritten, with the deltas (read-back Date minus internalDate), and whether internalDate follows our Date.
3. Mail scheduled in the Gmail web UI: its labels before it goes out (when first seen, and after the index delay) and after, whether `in:scheduled` (and a SCHEDULED label filter) lists it, whether `in:sent` lists it before it goes out, its history events, whether it keeps its id, and that `countsAsSent()` and `sentIn()` exclude it until it goes out. Every "before" reading ended a minute or more before the send time (`finishedBeforeSendMs`).
4. The agent-flag recommendation for the setup wizard, from the two consents' wording and whether Gmail's REST API took the agent client's token (or whether Google refused that client's consent: by its redirect's error code, or on its own page as the owner declared).
5. The Testing-mode 7-day horizon, the publishing status for the hub's client, and the token answer's `refresh_token_expires_in` if Google sent one. The consents ask for `access_type=offline` (the authorization request's parameter names are in the evidence), so M5's connect should too.
6. The homepage result, and whether Publish works without it.
7. The scope drop on the standard client before connect: connect() refuses the grant and revokes it, refreshes then end in `invalid_grant`, and how long that took; or that the page offered no Gmail checkbox. Whether the agent client's page offered the checkboxes comes from its consent observation.
8. Both 429 shapes: the concurrency limit as observed (a 429, or a 403 rate limit if Gmail answered with one); "Mail sending" from the documentation and the fake, never provoked.
9. Bcc: whether the To recipient's copy has a `Bcc:` line, which decides M5's keepBcc.
10. `threads.get` minimal returning internalDate, which the new-thread fallback relies on.
11. The five consent-review readings R1–R5, each consistent, inconsistent or unclear, with sentences (a)–(e); R2–R5 stay open for the pre-launch legal review.
12. The disclosure placement: the orchestrator showed each client's disclosure text in the chat before its consent (a stand-in for M5's wizard), and the screens' order; any policy page changes since 2026-10-16.
13. V1: nodemailer 10.1.2.
14. Revocation: both clients' grants revoked and confirmed with `invalid_grant` (with how long Google took), the entries deleted, both clients deleted.
15. Kept tests: `spikes/s08-gmail/test/mime.test.ts`, `test/reconcile.test.ts` and `test/fake-gmail.test.ts` (`pnpm --filter @draftyak/spike-s08-gmail test`), moving to M5 `plugins/channel-gmail/`, `packages/mime/` and `packages/fakes/` (FakeGmail and FakeGoogleOAuth).
