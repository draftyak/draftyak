# S9b: the Messages API live session (runbook)

M0.31 checks S9a's request on the real API with the owner's key: at most 6 requests in all, under US$1, with content-free evidence in `evidence/live.json` for ADR 0011. The owner supplies the key; nothing else needs the owner.

- `test/messages.live.test.ts`: the live test, run by the command below.
- `test/live-session.ts`: the session it runs: the planned calls, the request cap and the cost guard across runs, the acceptance lines, the evidence and the revocation check.
- `test/live-rehearsal.test.ts`: the same session against the spike's fake API, in the unit tier (`pnpm --filter @draftyak/spike-s09-messages-api test`, and every CI run).

## The owner's step

1. In the Claude Console, create an API key in a workspace with a low monthly spend limit (US$5 is plenty). Check that the organization has credits and that the limit has about US$1 of room: without them the API refuses every request, and the run stops and says so.
2. Put the key into the main checkout's `.env.live` (`C:\dev\draftyak\.env.live`, which git ignores). Either:
   - Copy the key, then run this from `C:\dev\draftyak`. It reads the clipboard, so the key never appears on a command line or in shell history. It is for the key only: it saves what the clipboard holds as `DY_LIVE_MESSAGES_API_KEY`, replacing any earlier value, and refuses text that can't be a key.

     PowerShell:
     ```powershell
     Get-Clipboard | node --input-type=module -e "import { saveEnvLive } from './spikes/kit/env-live.ts'; let value = ''; for await (const chunk of process.stdin) value += chunk; value = value.trim(); if (value.length < 20 || /[\s=]/.test(value)) throw new Error('the clipboard holds no API key'); saveEnvLive('DY_LIVE_MESSAGES_API_KEY', value); console.log('saved DY_LIVE_MESSAGES_API_KEY in .env.live');"
     ```
     Git Bash: the same command, starting with `cat /dev/clipboard |` instead of `Get-Clipboard |`.
   - Or open the file in Notepad (`notepad C:\dev\draftyak\.env.live`) and add this line, with nothing after the `=` but the key (no quotes or spaces):
     ```
     DY_LIVE_MESSAGES_API_KEY=<the key>
     ```
3. Optional: allow the refusal probe, with this command from `C:\dev\draftyak` (PowerShell or Git Bash) or the line `DY_LIVE_MESSAGES_REFUSAL_PROBE=yes` added in Notepad. Never use the clipboard command above for it.
   ```
   node --input-type=module -e "import { saveEnvLive } from './spikes/kit/env-live.ts'; saveEnvLive('DY_LIVE_MESSAGES_REFUSAL_PROBE', 'yes'); console.log('saved DY_LIVE_MESSAGES_REFUSAL_PROBE=yes in .env.live');"
   ```
   The probe asks the model to write out its reasoning, the documented trigger for a `reasoning_extraction` refusal. It deliberately trips a safety classifier on the owner's key, may not fire, has no fallback, and is billed either way. Without this line the refusal shape comes from the documentation.

## The command

Run every step from the root of the same clean checkout of `m0` that includes M0.31 (a worktree works too: `.env.live` is always read from the main checkout). `evidence/live.json` holds the session's state until it is committed with ADR 0011, so don't move, copy, clean (`git clean`) or stash it in between. From the first request on, `.env.live` also holds `DY_LIVE_MESSAGES_KEY_SHA256`, the key's SHA-256, and a run stops before sending anything if the record has gone missing or the key has changed.

The command first clears every `ANTHROPIC_*` variable from the shell: the SDK reads them, and the broker refuses the headers they add. `DRAFTYAK_RECORD_EVIDENCE=1` holds for that one run, and the exit code is the test's.

Git Bash:
```bash
unset $(compgen -e | grep -i '^ANTHROPIC_'); DRAFTYAK_RECORD_EVIDENCE=1 pnpm --filter @draftyak/spike-s09-messages-api test:live --reporter=default
```

PowerShell:
```powershell
Get-ChildItem Env:ANTHROPIC_* | Remove-Item; cmd /c "set DRAFTYAK_RECORD_EVIDENCE=1&& pnpm --filter @draftyak/spike-s09-messages-api test:live --reporter=default"
```

The same command does every step; `evidence/live.json` says which is due:

- **Step 1, the session** (no `live.json`, or one that records a stopped session that can go on): 3 calls, or 4 with the probe, in this order:

  | Call | Request | Answers |
  |---|---|---|
  | `fallbacks` | S9a's draft request as M7 will send it: `claude-opus-5-5`, effort `medium`, `max_tokens` 16,000, the `DraftOutput`-lite format, `fallbacks: "default"` with only the `server-side-fallback-2026-07-01` beta, on `?beta=true` | `fallbacks: accepted` |
  | `parse-effort` | the same without fallbacks and with no `anthropic-beta` header | `parse: ok`, `effort: ok` |
  | `max-tokens` | `parse-effort`'s request with `max_tokens` 16 | `max_tokens: detected` |
  | `refusal-probe` | only with the owner's line: `parse-effort`'s request with a format that has a `reasoning` field, `max_tokens` 2,048 | `refusal: probed (<category>)`, or `refusal: from the documentation` without it |

  Only `fallbacks` sends fallbacks, so a rejected fallbacks parameter takes no other line with it. The run prints a line per call, then the acceptance lines, the requests used and the estimated cost, where the evidence went, and what comes next. For example:
  ```
  S9b live session: 3 calls (refusal probe from the documentation), 6 of 6 requests left, budget US$1
  fallbacks: 200 draft from claude-opus-5-5, 1 attempt, 6.2 s, US$0.0180
  ...
  parse: ok
  effort: ok
  fallbacks: accepted
  max_tokens: detected
  refusal: from the documentation
  calls: 3 of 6; estimated US$0.0400 of US$1
  evidence: …\spikes\s09-messages-api\evidence\live.json
  next: revoke the key in the Claude Console, then run the same command again
  ```
  A line that reads otherwise, such as `fallbacks: rejected (400 invalid_request_error)` (the API's verdict on the request; the call's line shows its message), fails the test, but the evidence still records the whole session for ADR 0011, and the owner decides between keeping it and a new session.
- **Step 2, after the owner revokes the key** (`live.json` records a finished session with `revoked: no`, or a stopped one that can't go on): the owner deletes the key in the Claude Console, then the command runs again. With the session's own key (its SHA-256 must match `DY_LIVE_MESSAGES_KEY_SHA256`), it sends one request for a model that doesn't exist; the API answers a revoked key with a 401 and a working one with a 404, and bills neither. Only the API's own `401 authentication_error` counts: it records `revoked: yes`, then deletes `DY_LIVE_MESSAGES_API_KEY`, `DY_LIVE_MESSAGES_REFUSAL_PROBE` and `DY_LIVE_MESSAGES_KEY_SHA256` from `.env.live`. A 404 means the key still works: nothing is deleted, and the command can run again once the key is gone. Each check counts toward the 6 requests and is recorded before it is sent; if none is left, it says so and sends and records nothing.
- **Done** (`live.json` records `revoked: yes`): with the key gone from `.env.live` the command skips, and nothing runs over that record.

Then `pnpm guard` must report 0 findings, and `evidence/live.json` is committed with ADR 0011 (`pnpm adr`).

## Limits and expected cost

- **Requests.** At most 6 are made with the key across every run: retries, stopped runs and revocation checks included. Each is recorded in `evidence/live.json` before it is sent, so a run that stops or dies still counts it, a request that can't be recorded isn't sent, and a 7th is refused before it is sent. The SDK retries a session call once after no answer or a 408, 409, 429 or 5xx status, but never an answer that says the account can't pay; the probe and the revocation check are sent once. The probe is sent only while a request is left for the revocation check after it.
- **Cost.** Before each request, the estimate so far plus that request's worst case must stay within US$1.00, or it is refused before it is sent. The worst case counts the prompt (its size plus 8,192 tokens) and the full `max_tokens`, plus one fallback hop when the request has fallbacks: about US$0.88 for `fallbacks`, which goes first while nothing is spent, US$0.36 for `parse-effort`, US$0.04 for `max-tokens` and US$0.08 for the probe. The estimate, stopped runs included, comes from each answer's `usage`, attempt by attempt. An error status counts nothing, and a request without a usable answer counts as its prompt at the input price: whether the API billed it can't be seen, and counting its whole worst case would leave no room to retry it.
- **Prices** (USD per million tokens, input/output, as of 2026-10-06): Claude Opus 5.5 4/20; Claude Opus 5 and Claude Opus 4.8, the documented fallback models, 5/25; any other model 10/50. If Anthropic's pricing page shows other prices on the day, update `PRICES` in `test/live-session.ts` in a PR to `m0` first, then run the command from the updated, clean `m0` checkout: a session refuses a dirty tree.
- **Expected:** about US$0.03 to US$0.15 for the whole session; the revocation check costs nothing.
- **Time:** about a minute; the test allows 30 minutes.

## The evidence

`evidence/live.json`, written by the kit's `writeEvidence()` from a clean tree only:

- `session`: `step` (`session`, or `stopped` while a session hasn't finished), when it ran, the SDK version, model, effort, the requests made with the key (stopped runs included) and the cap, the estimated cost, whether the owner allowed the probe, and `revoked`.
- `stops`: each run that stopped before finishing: when, its requests and estimated cost, the call it stopped at and why (`no answer`, a status such as `529 overloaded_error`, `400 usage limit` or `429 usage limit` (a spend limit or too little credit), `broker refused`, `budget`, `call-cap`, `interrupted` (a request had no answer when the run ended) or `error`).
- `acceptance`: the lines above.
- `calls[]`, per attempt:
  - the request: the endpoint, the header names, the body field names, the model, `max_tokens`, effort, format type, schema field names and `fallbacks`; whether the fallback beta, or any other beta, was sent; the verifier's verdict.
  - the response: the status and header names, with values only for `content-type`, `*ratelimit*` and `retry-after` (numbers as numbers); the body's field names, model, `stop_reason`, the shape of `stop_details`, the content blocks' types and lengths, and the `usage` figures.
  - `readDraft()`'s result as kinds and sizes; the cost estimate; for the probe, why it wasn't sent or how it failed.
- `revocation`: the check's status (`interrupted` if it had no answer when the run ended), the number of checks and the names of the deleted entries that held a value.

It never holds prompt or completion text, the key or its hash, organization, request or message ids, signatures, the API's error messages, or other header values.

## When it stops

A run that stops after sending a request records the stop in `evidence/live.json` (`session.step: stopped`, with the run in `stops`), as does a run the cap or the cost guard stops. Running the same command again starts the session over within what is left of the 6 requests and US$1. A session needs 3 requests: once the cap or the cost guard has stopped it, or fewer than 3 are left, it can't go on. The stop's message then ends with `the session can't go on: revoke the key in the Claude Console, then run the same command again`, the next run is step 2, and ADR 0011 records S9b as not run unless the owner allows a new session.

| Message | Meaning |
|---|---|
| `DY_LIVE_MESSAGES_API_KEY is not in .env.live: …` (skipped) | No key. With `DRAFTYAK_STRICT_SKIPS=1` this is a failure. |
| `unset ANTHROPIC_… first` | Run the command as written. |
| `set DRAFTYAK_RECORD_EVIDENCE=1` | A live run always records its evidence; run the command as written. |
| `live evidence comes from a clean tree` | Commit or stash first. |
| `… evidence/live.json is missing, but the key has made requests` | The record isn't in this checkout. Run the command from the checkout that holds it, or restore it (`git stash pop`). If it is lost, the owner decides: revoke the key (ADR 0011 then records S9b as not run), or start a new session (below). |
| `DY_LIVE_MESSAGES_API_KEY isn't the key that made the recorded requests` | The key entry was replaced. Put the session's key back if you still have it. Otherwise the owner revokes that key in the Console and confirms it; delete the entries as below and record the confirmation in ADR 0011. |
| `<call>: no answer (Connection error.)` or `(Request timed out.)` | The request and its retry got no answer. Run the same command again later. |
| `<call>: the API didn't answer (529 overloaded_error: …)` | Still rate-limited, overloaded or failing (408, 409, 429 or 5xx) after the retry. Run the same command again later. |
| `<call>: the account can't pay for it (400 invalid_request_error: You have reached your specified API usage limits …)`, or `(… credit balance is too low …)`, or a 429 spend cap | The workspace's spend limit is reached, or the organization has too little credit. Nothing was billed or retried. Raise the limit or add credits in the Claude Console, then run the same command again. |
| `<call>: the API refused the key (401 …)` | The key in `.env.live` is wrong or already revoked. |
| `<call>: the API refused the request (403 …)` | The key's workspace can't use `claude-opus-5-5` (402, 403 or 404). |
| `<call>: the broker refused the request (…)` | The verifier refused the request the SDK built, so it never left. The code needs a fix in a PR to `m0` first. |
| `<call>: refused before sending: all 6 requests are used` or `… could pass US$1.00` | The cap or the cost guard: nothing more was sent, and the session can't go on. Revoke the key, then run the same command again. |
| `<call>: refused before sending: it couldn't be recorded first (…)` | `evidence/live.json` or `.env.live` couldn't be written, so nothing was sent. Fix what the message names, then run the same command again. |
| `the key still works (404 not_found_error)` | Step 2 ran before the key was deleted in the Console. |
| `the revocation check got no verdict (…)` | No answer, a retryable status, or a status that proves nothing about the key, such as a 401 without the API's `authentication_error`. Run the same command again later. |
| `the key can't be tied to the recorded session` | `DY_LIVE_MESSAGES_KEY_SHA256` is gone from `.env.live`, so a 401 wouldn't show that the session's key is revoked. The owner revokes the key in the Console and confirms it; delete the entries as below and record the confirmation in ADR 0011. |
| `the key can't be checked (not run: …)` | No request is left for the check, or the cost guard refused it. Once the owner confirms the key is deleted in the Console, delete the entries as below and record that in ADR 0011. |
| `… records revoked: yes, but .env.live still holds DY_LIVE_MESSAGES_API_KEY` | Deleting the entries after the 401 failed, or a new key went in. Delete them as below; for a new session, move `evidence/live.json` away first. |

To delete the entries by hand, run this from `C:\dev\draftyak` (PowerShell or Git Bash):
```
node --input-type=module -e "import { deleteEnvLive } from './spikes/kit/env-live.ts'; console.log(deleteEnvLive(['DY_LIVE_MESSAGES_API_KEY', 'DY_LIVE_MESSAGES_REFUSAL_PROBE', 'DY_LIVE_MESSAGES_KEY_SHA256']));"
```

A new session, with a new count of 6 requests and US$1, is the owner's call. Move `evidence/live.json` away, then delete the key's hash:
```
node --input-type=module -e "import { deleteEnvLive } from './spikes/kit/env-live.ts'; console.log(deleteEnvLive(['DY_LIVE_MESSAGES_KEY_SHA256']));"
```

## What ADR 0011 records

1. The drafting call, for the owner to choose:
   - `client.beta.messages.parse` with the per-request `anthropic-beta` pin (what `draft()` does now);
   - `client.beta.messages.create` with `betas: [FALLBACK_BETA]`, which sends the same body and headers (a test compares them), adds no beta, parses nothing itself and loses only the unused `parsed_output`;
   - the GA `client.messages.parse`, whose types have no `fallbacks` field.

   The live calls are the same bytes whichever is chosen.
2. A `format.parse` that returns the text unchanged, with `stop_reason` checked before the parser.
3. The header allowlist and the dropped platform headers.
4. The body re-serialized after verification; redirects never followed.
5. `fallbacks: "default"` only, on the documented models (Claude Haiku 5.5 has none); fallback text joined across `fallback` blocks.
6. `MAX_TOKENS_CAP` 16,000, and the SDK's 21,333 non-streaming ceiling.
7. The API enforces neither lengths nor enums; `contextRefs` is read leniently.
8. Whether non-default models need `thinking` (refused today), decided in M7.
9. Refusal problems name only API vocabulary.
10. From this session: the four acceptance lines; the refusal line; that the API accepted the pinned request without `structured-outputs-2025-12-15` on `?beta=true`; whether ordinary turns carry `stop_details: null` and `usage.iterations: null`; the thinking block's shape; the response header names and rate limits; the request count and estimated cost, and any stopped runs (a usage-limit stop is told apart from a rejected request); `revoked: yes` with its 401.
11. Kept tests: `test/verify.test.ts` and `test/draft.test.ts`, with `test/fake-messages-api.ts` and `test/harness.ts`, run by `pnpm --filter @draftyak/spike-s09-messages-api test`; destination M7 `plugins/ai-messages-api/`. `test/live-session.ts`'s request cap, cost guard and usage-limit stop can seed M7's spend controls.
