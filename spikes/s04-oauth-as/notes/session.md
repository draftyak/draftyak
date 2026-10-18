# S4c live connectors: the session 2 runbook

M0.20's live half. claude.ai, ChatGPT, remote Claude Code and Codex connect, one at a time, to the spike AS and its fake-data MCP endpoint through Tailscale Funnel, while `test/connectors.live.test.ts` records what the AS saw. The owner is needed for about 90 minutes: Funnel, the route checks, the four clients and the clean-up. The orchestrator runs every `pnpm` command and relays what the test prints. Commands are given for Git Bash and PowerShell where they differ. The last sections list what ADR 0006 will record, what the session doesn't measure, and the vendor pages each step was checked against.

## What the session records, and what it never does

The test records AS-side facts only, in `evidence/live-clients.json`. A fact counts toward a client only when a client ID or a token names that client (or, for a DCR registration, the step the owner opened the window in). Per client:

- each CIMD document and JWKS fetched: host, HTTP statuses and content types, and only for a 200 JSON document its SHA-256, whether it matches `fixtures/cimd/` and the auth method it declares; the auth method the token endpoint saw; why a document or client was refused, first cause first;
- redirect URIs as shapes, as requested, registered (DCR) and declared (CIMD document): scheme, host (loopback hosts by kind), port (`none`, `loopback port`, `default` or the number) and path, with every segment that isn't a plain word replaced by `{id}`; and which rule let each through (exact, cimd's port-free rule, or the session's rule below);
- the scopes each authorization request named, and how many named none; the scopes each token held;
- the era (2025 or 2026), the protocol versions, the MCP methods called and the capabilities declared; which of prompts, resources, completion, elicitation and Apps the client used (`prompts/get`, a `resources/read` other than a view, `completion/complete`, an answered input-required result, a `ui://` read), and separately what it declared or listed;
- the `Origin` it sends to `/mcp` and `/oauth/token` (hosted Claude's is a §15 S4 item);
- the address class its token and MCP requests came from (loopback, tailnet, private, public, or `Anthropic egress` for Claude's documented 160.79.104.0/21), never the address;
- whether ChatGPT listed and called the fake write tool and whether its token held `drafts:write`, plus the owner's answer in the console: offered and ran, offered but blocked, or not offered;
- each client assertion's audience category (`issuer`, `token endpoint`, `endpoint` or `list`), from cimd's `onAssertion`;
- `DCR fallback verified: yes|no`, and the row: `ok`, `fallback` or `blocked`, with a reason from the client's own facts.

For the session as a whole: the proxy's header names per route (Funnel's public ingress has no identity headers, the tailnet route has Tailscale's), which header carries the client IP, how many `X-Forwarded-For` entries arrive, the class of the nearest untrusted hop, and what the proxy did with forwarding headers a client sends itself (the self-check sends documentation-range values and records dropped, replaced, appended to or passed through); every request by step, route and kind, and per step what no client ID or token named (an internet-facing name draws scanners, so those never land in a client's row); the route checks; the clean-up and `revoked`.

It never records tokens, codes, IP addresses, the Funnel host, URL path ids, tool arguments, header values or anything typed. Registered client IDs and grants appear only as `hashId(newSessionKey(), id)` HMACs under a key that is never written. A value that still fails the kit's content rules is replaced by `other` and counted (`session.valuesReplaced`), so one odd request can't lose the session's evidence. The MCP endpoint serves synthetic data only (two account aliases, one conversation, one message and one draft, all made up) and never touches mail. The spike never reads or writes the vendors' config or auth files (guardrail 3): the owner runs the `claude` and `codex` commands in their own terminal.

Choices of this session that go beyond plan §6, recorded in `session` for ADR 0006 and M9 and listed for the owner to confirm:

- The MCP endpoint's `401` names the four §6 scopes in its `WWW-Authenticate` challenge, the same list as the resource metadata's `scopes_supported`. An authorization request that names no scope gets that list as a default, so the client can still connect; its row says `with the session's default scope` and counts it (`authorization.withoutScope`). The spike AS itself has no default and would finish such a sign-in with `access_denied`.
- Access tokens last 10 minutes instead of §6's 60, so each client's refresh and rotation show within its step.
- A client registered in the DCR window whose redirect URIs are all loopback may use any loopback port (RFC 8252 §7.3). Codex registers `http://127.0.0.1/callback` without its port and adds its listener's port when it signs in, and its docs say authorization servers must accept that. Plan §6 and cimd's rule give port-free matching to allowlisted CIMD clients only, which would refuse Codex's DCR fallback. A row connected this way says `through the session's any-port loopback rule`.
- The MCP endpoint checks the bearer token before s03's body cap, header match and version checks, the reverse of §6 Serving's order: a body-less discovery probe must get the `401` that starts sign-in (Claude's docs require it), not s03's `415`. `Origin` is recorded, never refused, for these bearer-authenticated server-to-server requests: Claude's docs warn that a strict `Origin` check rejects Anthropic's requests.
- The fake `draft_create` needs `drafts:write`, as §6 puts it; a token without it gets an `isError` result.

## Before the session

The owner, as the week-1 pre-task for session 2:

- Tailscale installed and signed in, with MagicDNS and HTTPS certificates on. Funnel also needs the `funnel` node attribute in the tailnet policy file. If it isn't there yet, the first `tailscale funnel` command opens a web page to approve enabling Funnel.
- Before turning HTTPS certificates on, check this machine's name in the Tailscale admin console. A certificate puts the machine name and the tailnet's DNS name in the public Certificate Transparency logs, permanently, and Tailscale says not to enable HTTPS if any machine name holds sensitive information. Rename the machine first if its name includes a personal name. Once Funnel runs, expect scanners to find the name; the session keeps their requests out of every client's row.
- A claude.ai account. Free, Pro and Max add the connector themselves (Free allows one custom connector). On Team or Enterprise an Owner adds it for the organization.
- A ChatGPT plan that can add a custom MCP server. Whether ChatGPT may call write tools depends on the plan; the session records it.
- Claude Code and the Codex CLI installed and signed in, in the owner's own terminal.
- A phone that can turn Tailscale off and use mobile data, for the public route check.

The orchestrator, the day before: M0.20 is merged into `m0`, and the main checkout `C:/dev/draftyak` is on that `m0` with a clean tree. A recording run refuses a dirty tree before it starts, since committed evidence must come from a clean tree of the final code.

## The session, step by step

Times are estimates. The test gives each client up to 15 minutes (`DRAFTYAK_LIVE_CLIENT_MINUTES` changes that, from 1 to 60), and the owner ends a step early from the console.

### 1. Prepare (orchestrator, 5 minutes)

Ask the owner to pause other work on this PC for the session: sibling benchmarks, Codex's hub test runs (its m9 work listens on plan §1's ports too) and anything else that takes the kit's bench lock. The live test needs both the lock and the fixed port 127.0.0.1:47615. Then check both. PowerShell:

```
netstat -ano | findstr :47615
Get-Content "$env:LOCALAPPDATA\draftyak-dev\bench.lock.owner" -ErrorAction SilentlyContinue
```

Git Bash:

```
netstat -ano | grep ':47615'
cat "$LOCALAPPDATA/draftyak-dev/bench.lock.owner" 2>/dev/null
```

- `netstat` must show no `LISTENING` line on `127.0.0.1:47615` (`TIME_WAIT` lines go away by themselves). If something listens there, its last column is the process id: find out what it is before stopping anything. The test also stops with that hint if the port is taken.
- No `bench.lock.owner` file means nothing holds the lock. If it names a holder, wait for it or ask whoever runs it; the test would wait up to 4 minutes and then fail as machine-busy.

Then, in `C:/dev/draftyak`, the same in Git Bash and PowerShell:

```
pnpm install --frozen-lockfile
pnpm --filter @draftyak/spike-s04-oauth-as record-cimd -- --check
pnpm --filter @draftyak/spike-s04-oauth-as test
```

- `record-cimd -- --check` is M0.19's re-check of the recorded CIMD documents. It fetches each `fixtures/cimd/*.json` source again (GETs to claude.ai and chatgpt.com) and prints one line per file, such as `claude-ai.json: unchanged (sha256 …)`. It exits 0 when nothing changed and 1 when a document changed. PowerShell drops the `--`; the script takes `--check` either way.
- If a document changed, run `pnpm --filter @draftyak/spike-s04-oauth-as record-cimd`, then the unit tests, and commit the fixture before the live run, so the evidence names the final code.
- The unit tests include the rehearsal (`test/connectors-rehearsal.test.ts`), which drives this session's code with M0.19's scripted connectors through a loopback stand-in for Funnel, about 7 s.

### 2. Funnel, for this session only (owner, 5 to 15 minutes)

1. Check that nothing is configured yet: `tailscale funnel status` must list no server. If it lists any, stop and ask the owner before changing anything: that configuration is theirs, and the session must leave it alone.
2. In a terminal the owner keeps open for the whole session:

   ```
   tailscale funnel --https=443 http://127.0.0.1:47615
   ```

   Without `--bg` the command runs in the foreground until Ctrl+C, and it doesn't come back after a restart. 443 is one of the three ports Funnel allows (443, 8443, 10000), and `http://127.0.0.1` is the only proxy target the docs support, here the port the live test listens on (plan §1's L3 port). Public DNS for a new name can take up to 10 minutes.
3. The command prints the public address, `https://<machine>.<tailnet>.ts.net`. The owner saves it to the main checkout's `.env.live` once, from `C:/dev/draftyak/spikes/s04-oauth-as`, in either shell, with the address in place of `<address>` and no trailing slash. The one-liner refuses anything that isn't `https://<host>` alone, without printing it:

   ```
   node --input-type=module -e "const v = process.argv[1]; const u = URL.parse(v); if (u?.protocol !== 'https:' || u.origin !== v) { console.error('not https://<host> with no path or slash'); process.exit(1); } const { saveEnvLive } = await import('@draftyak/spike-kit'); saveEnvLive('DY_LIVE_FUNNEL_BASE_URL', v);" "<address>"
   ```

   `saveEnvLive` writes only to the git-ignored `.env.live`, and the address never appears in the test's terminal output or evidence (the session console, on this machine only, shows it).
4. Check that Funnel serves only the spike's port: in a second terminal, `tailscale funnel status` and `tailscale serve status` must list exactly one server, the machine's HTTPS name on 443 with Funnel on, proxying to `http://127.0.0.1:47615`, and nothing else. The docs show no sample output, so confirm the format in the session.

### 3. Start the live test and check the routes (orchestrator and owner, 5 to 15 minutes)

In `C:/dev/draftyak`. Git Bash:

```
DRAFTYAK_RECORD_EVIDENCE=1 pnpm --filter @draftyak/spike-s04-oauth-as test:live
```

PowerShell:

```
$env:DRAFTYAK_RECORD_EVIDENCE = '1'; pnpm --filter @draftyak/spike-s04-oauth-as test:live; Remove-Item Env:DRAFTYAK_RECORD_EVIDENCE
```

- The run usually takes 80 to 100 minutes and at most about two hours (the route checks, four steps of up to 15 minutes and the clean-up), so start it in the background and read its output as it streams. Everything the owner needs goes to stderr, which every Vitest reporter shows at once.
- A recording run first checks for a clean tree and stops if tracked files changed. It then takes the kit's machine-wide lock for the fixed port (other benchmarks wait), builds the Apps view from `spikes/s03-mcp-sdk/views` into a temp folder (a few seconds) and starts the AS and the MCP endpoint on `127.0.0.1:47615`.
- The self-check then fetches the public resource metadata through Funnel from this machine, for up to 10 minutes. Every client needs this route (the consent pages open in this machine's browser, and the CLIs run here), so the test stops if the request never arrives, or arrives and is refused (a `421` means neither `Host` nor `X-Forwarded-Host` named the public host). It says which way the request came: `over the tailnet` (Tailscale serve's identity headers, the usual case with MagicDNS on) or `through Funnel's public ingress`.
- The test then prints the session console's address, `http://127.0.0.1:<port>/<random>/`. The owner opens it in a browser on this machine. It shows the MCP URL to paste, the route checks, the current step, the sign-ins waiting for a code, the DCR window's state, the progress and, at the end, the clean-up.
- The route checks, before any client step: in the console, the owner opens the public check link in this machine's browser (it shows a small JSON document), and on a phone with Tailscale off, on mobile data, opens the address the console shows under Funnel's public route (it ends `?check=phone`). The steps start once both requests have arrived, the phone's through Funnel's public ingress, which is the way claude.ai and ChatGPT will come. A phone whose request came over the tailnet is named in the progress: turn Tailscale off on it and try again. If no phone is at hand, the owner can press **Start the steps without the remaining checks**; the evidence then records which checks were missing. After 15 minutes without either, the test stops without running a step.
- Without `DY_LIVE_FUNNEL_BASE_URL` the test skips with that reason; under `DRAFTYAK_STRICT_SKIPS=1` it fails instead.

For each client, the test prints the steps below and waits until the owner presses **Done** (or **Blocked**, with the closest of four fixed reasons) in the console, or the client's deadline passes. Each sign-in opens DraftYak's consent page, which shows a 2-digit code. The owner types that code in the console's one code field, which stands in for the paired desktop: it approves the waiting sign-in whose page shows that code. Each waiting sign-in is listed, newest first, with when it started, the requester address and class, its user agent and the last characters of its page's address; deny any sign-in you didn't start. A code that matches no waiting sign-in changes nothing, and two that show the same code ask for the extra one to be denied first. The consent limits are §6's: 3 sign-ins a minute and 20 a day, and five denials pause sign-in for 15 minutes. If the DraftYak page says "Too many sign-in requests", wait a minute and start the sign-in again. The console refreshes itself every 3 s, except while the owner is typing a code, has picked a reason or answer, or has selected text.

### 4. claude.ai (owner, 10 to 15 minutes)

1. Customize > Connectors, then **+ Add** > **Add custom connector**. On Team or Enterprise, an Owner adds it under Organization settings > Connectors > **Add** > **Custom** (type **Web**) instead, and the owner then clicks **Connect** on it under Customize > Connectors.
2. Name `DraftYak S4 spike`, URL: the MCP URL the console shows (the Funnel address followed by `/mcp`), **Continue**.
3. **Authentication**: Sign in now. **OAuth client**: Use Claude's published identity (Recommended), which is CIMD. Then **Add**. If the dialog is one screen with **Advanced settings**, leave those empty and **Add**.
4. Type the code from the DraftYak page into the console.
5. In a new chat, **+ > Connectors**: turn on DraftYak S4 spike. Ask it to list the DraftYak accounts and to show DraftYak draft `01JS4D0000000000000000000A`, which may render the Apps view. From the **+** menu, add the `triage_inbox` prompt and the agents guide resource, if Claude offers them.
6. **Done** in the console.

If sign-in fails at client registration, open the DCR window (below), remove the connector and add it again with **OAuth client: Register automatically**, which is DCR. Authentication settings can't be changed after adding.

### 5. ChatGPT (owner, 10 to 15 minutes)

1. ChatGPT Plugins, then **+** > **Add custom MCP server**. If ChatGPT asks for developer mode first, turn it on (confirm in the session: OpenAI's current developer docs don't mention it).
2. Name and description `DraftYak S4 spike`. Under **Connection**: Public endpoint, URL: the MCP URL from the console. Authentication: OAuth (the docs say only "configure authentication", so confirm the option's name in the session).
3. Review the risk warning (**I understand and want to continue**), then **Create as a plugin**, review the tools it found, and install it.
4. Type the code from the DraftYak page into the console.
5. In a new chat, type `@` and pick the plugin. Ask it to list the DraftYak accounts, to show draft `01JS4D0000000000000000000A`, and to create a DraftYak draft reply in conversation `01JS4C0000000000000000000A`. That last one is the fake write tool `draft_create`, which stores and sends nothing.
6. In the console, choose what ChatGPT showed for `draft_create` (offered and ran it, offered but the plan or a setting blocked it, didn't offer it, or not tried), then **Done**. The requests alone can't tell a blocked tool from an unused one.

ChatGPT should use its stable CIMD document and stable redirect, because this AS returns `iss` on every authorization response and advertises it. The test records which document and redirect it actually used, and the audience of its client assertions. If sign-in fails at client registration: open the DCR window, remove the plugin and add it again, choosing DCR if ChatGPT offers the choice (confirm in the session).

### 6. Remote Claude Code (owner, 10 minutes)

In the owner's own terminal, in an empty folder (the default local scope keeps the server to that folder):

```
claude mcp add --transport http draftyak-spike <MCP URL>
claude mcp login draftyak-spike
```

Or start `claude` there, open `/mcp` and follow its sign-in in the browser. Type the code into the console. Then start `claude` in that folder and:

- run `/mcp__draftyak-spike__triage_inbox` (also listed as `/draftyak-spike:triage_inbox (MCP)`). On protocol revision 2026-07-28 Claude Code declares form and URL elicitation, so an account form may appear: that is elicitation;
- mention `@draftyak-spike:draftyak://guide/agents` (a resource);
- ask it to list the DraftYak accounts and to show draft `01JS4D0000000000000000000A`;
- **Done** in the console.

Claude Code identifies itself with its own CIMD document on claude.ai and a loopback redirect on an ephemeral port, which cimd's rule matches without the port. A client on this machine usually reaches the Funnel name over the tailnet, so its MCP requests show `tailnet identity headers` (header names only), while the hosted clients show Funnel's public ingress.

### 7. Codex (owner, 10 minutes)

```
codex mcp add draftyak-spike --url <MCP URL>
codex mcp login draftyak-spike
```

- The docs show `--url` only together with `--oauth-client-id`; confirm with `codex mcp add --help` that no other flag is needed. Without a client ID, `codex mcp login` picks CIMD when the AS advertises it, accepts `none` and the callback is a supported loopback URL; this AS meets all three.
- Type the code into the console. Then start `codex` and ask it to list the DraftYak accounts (`/mcp` shows the server). **Done** in the console.
- If login fails at client registration: open the DCR window, then `codex mcp login draftyak-spike --oauth-client-registration dcr`.
- If time allows after a CIMD login, verify the DCR fallback once here (3 minutes): open the DCR window, then `codex mcp login draftyak-spike --oauth-client-registration dcr`, then ask for the accounts again. The row stays `ok` and shows `DCR fallback verified: yes`. Codex registers its callback without the port, so this works through the session's any-port loopback rule, which the row names.

### The DCR window (only for a client that fails CIMD, or the optional Codex check)

The console and the output say when a client was refused (`CIMD refused: …`, with the cause: a fetch's HTTP status, a host that isn't allowlisted, a refused document), and when a registration request arrived while the window was closed. That request carries no client ID, so it isn't tied to the client in the step; open the window only if the client itself reports a registration error. Then, in a second terminal in `C:/dev/draftyak` (the same in both shells):

```
pnpm --filter @draftyak/spike-s04-oauth-as dcr-window
```

- It prints `dcr-window: registration is open for 10 minutes or 10 registrations` (exit 0), or exits 1 when no AS took the request within 5 s.
- The client then retries with registration: claude.ai with **Register automatically**, Codex with `--oauth-client-registration dcr`. A client that registers in the window and then connects gets `fallback` (or keeps `ok` if it connected through CIMD first) and `DCR fallback verified: yes`. The row records the redirect URIs it registered and any registration error.

### 8. Results (orchestrator, 5 minutes)

After the last step the test prints a table, one row per client: outcome, era, CIMD or DCR, the five surfaces used, `DCR fallback verified` and the reason. Below it: ChatGPT's write tool (the owner's answer, whether it was listed and called, and any refusal for a missing `drafts:write`), and per step what no client ID or token named.

A run limited with `DRAFTYAK_LIVE_CLIENTS` (for example `codex`) is for retrying one client: it skips the clean-up and is never recorded. A code fix during the session means a full re-run on the fixed, committed code before anything is recorded. After a restart each client must sign in again, because the AS keeps its grants in memory.

### 9. Clean-up, inside the recorded run (owner, 10 minutes)

The recording run doesn't end with the table: it keeps the AS running and shows the clean-up in the console and the output, so a client that revokes its tokens on the way out still reaches the AS and the evidence can record `revoked`.

1. claude.ai: Customize > Connectors, then **Remove** on DraftYak S4 spike, or its three-dot menu.
2. ChatGPT: remove the DraftYak S4 spike plugin. The checked pages cover adding and refreshing, not removing, so confirm the path in the session.
3. Claude Code, in the folder used: `claude mcp remove draftyak-spike`, which also deletes the tokens and client registration Claude Code stored for it.
4. Codex: `codex mcp logout draftyak-spike`, then `codex mcp remove draftyak-spike`. The checked page documents neither, so confirm both with `codex mcp --help`.
5. **I removed the connectors** in the console.
6. Funnel: Ctrl+C in its terminal. The test then checks that the public address no longer reaches the AS (two probes in a row that don't arrive, for up to 10 minutes). Then `tailscale funnel status`; if it still lists the spike's server, run `tailscale funnel --https=443 off` (an `off` command repeats the original flags; the target may be left out). `tailscale funnel status` and `tailscale serve status` must then list no server (backlog acceptance); confirm the exact empty-status text in the session. `tailscale funnel reset` also clears it, but only use it if step 2 found nothing configured before the session.

Once Funnel no longer reaches the AS, the test removes `DY_LIVE_FUNNEL_BASE_URL` from `.env.live` itself (`deleteEnvLive`), writes `evidence/live-clients.json` and prints `evidence: <path>`. Its `session.cleanup` records the owner's confirmation, Funnel's state, the entry and that the AS's tokens and grants lived only in memory; `revoked` is `yes` only when the owner confirmed and Funnel was off. If it says `no`, finish the step that's missing, then remove the entry by hand, from `C:/dev/draftyak/spikes/s04-oauth-as`, in either shell; it prints `[ 'DY_LIVE_FUNNEL_BASE_URL' ]` when the entry was there, and ADR 0006 notes the late clean-up:

```
node --input-type=module -e "const { deleteEnvLive } = await import('@draftyak/spike-kit'); console.log(deleteEnvLive(['DY_LIVE_FUNNEL_BASE_URL']));"
```

7. The orchestrator commits `evidence/live-clients.json` (and any re-recorded fixture) and writes ADR 0006.

## What ADR 0006 will record

- **Decision:** Go, Go with fallback, or No-go, from the four rows.
- **DCR window:** whether any client needed it, which ones, and whether the fallback was verified. If none needed it, the plan keeps DCR off (§6). If one did, M9 enforces the window where the client is created (`idFactory`), as M0.19's handoff says. If Codex's DCR fallback worked only through the session's any-port loopback rule, M9 either accepts any loopback port for registered all-loopback clients (RFC 8252 §7.3) or keeps DCR from Codex; the owner decides.
- **CIMD:** each client's document host, statuses and SHA-256 against `fixtures/cimd/`, its auth method, and any refusal with its first cause. Codex's document (`https://chatgpt.com/oauth/codex/client.json` per the Codex docs) gets a fixture after the session: add `fixtures/cimd/codex.json` holding only its `source`, then run `record-cimd`.
- **The assertion audience** ChatGPT sends. If it is the issuer as a single string, M9 adopts cimd's `audience: "issuer"` rule, and `pkjwt.test.ts`'s issuer-only tests become kept tests. Otherwise ADR 0006 lists the remaining audience-injection exposure (the token endpoint, this endpoint, lists).
- **Redirect URIs** per client, as requested, registered and declared, and which rule matched them. Claude's docs also ask the consent page to show the redirect host and to warn when every registered redirect URI is loopback; M9's consent page decides the warning.
- **Scopes:** which scopes each client asked for, whether it followed the `401`'s `scope` or the resource metadata, and whether any sent none. If one did, M9 gives the AS a default scope or an `invalid_scope` refusal (RFC 6749 §3.3).
- **The proxy and the CIDR allowlist:** Funnel's forwarding headers and client-IP header, the `X-Forwarded-For` entry count, the class of the nearest untrusted hop (for claude.ai's own requests, whether it lies in Anthropic's egress range), what Funnel does with a client's own forwarding headers, whether `Host` arrives as the public name, and the tailnet route for clients on this machine. The optional CIDR allowlist is possible only if the nearest hop is the requester's public address and a client can't set it. With the proxy on the same machine the trusted peer is loopback, so the allowlist can't gate by the proxy's own address, and the requester IP stays display and audit only.
- **Remote Claude Code and Codex:** OAuth works, or the SSH-forward fallback with an agent token (§6) is M9's path. If a remote client failed only because this machine's route did (the evidence's route checks show it), that isn't a client failure.
- **The client-surface table** for `docs/guides/mcp-clients.md` (M9): era, and prompts, resources, completion, elicitation and Apps per client as used (with what each declared or listed beside it), plus hosted Claude's `Origin`, whether any client sends `Origin` to `/oauth/token` or needs CORS, and ChatGPT's write-tool access on the owner's plan.
- **The MCP endpoint:** it checks the public `Host` (or the trusted proxy's `X-Forwarded-Host`), records `Origin` without refusing it, and checks the token before the body and header checks, for the reasons above.
- **TTLs and limits** (M0.18's handoff): access tokens 60 minutes in the plan and 10 in this session; the store and consent caps; the 421 rule; no CORS; HEAD 405.
- **ADR 0005's triggers** (M0.17's handoff): see the next section.
- **Evidence:** `evidence/live-clients.json` and `evidence/proxy-caddy-win32-x64.json` (M0.19).
- **Kept tests** (M9 `apps/hub/src/oauth-as/` and `@draftyak/fakes`): `test/{discovery-snapshot,pkce,refresh,iss,interaction}.test.ts` and M0.19's `test/{cimd,pkjwt,loopback,ssrf,dcr}.test.ts` with `test/connectors.ts` depend only on s04 and the kit. `test/connectors-rehearsal.test.ts`, `test/console.heavy.test.ts` and `test/live/` also import `spikes/s03-mcp-sdk` (its middleware, surfaces, Apps views and test harness) and vendor-guard's CLI, which `apps/hub` can't import: name them only as references, or move them with their s03 imports re-pointed when M8 absorbs s03.
- **Clean-up:** the connectors removed, `tailscale funnel status` showing no configuration, and `revoked`.

## What this session doesn't measure: ADR 0005's triggers

M0.17's handoff asks this session, for each local client, for the era it negotiates and the elicitation modes it declares (recorded per client), its request timeouts for `prompts/get`, `resources/read` and `tools/call`, whether a progress notification resets them, and whether a 2025-06-18 host accepts the 2026-shaped form. The last three aren't measured here, and the evidence says so (`session.adr0005`): the endpoint answers in JSON mode with no slow handler, so it can neither hold a request until a client gives up nor stream progress, and its 2025 leg never sends a form. What the vendors' docs say instead (read 2026-10-18):

- **Claude Code** ([MCP](https://code.claude.com/docs/en/mcp)): a tool call's limit is `MCP_TOOL_TIMEOUT`, about 28 hours when unset, or a per-server `timeout`, a hard wall-clock limit that progress notifications don't extend. HTTP, SSE and claude.ai connector servers also get a per-request timer, the greatest of 60 seconds, that tool timeout and `MCP_TIMEOUT`. A call that sends no response and no progress notification for the idle window aborts; the window is 5 minutes for HTTP servers and 30 minutes for stdio ones (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, 0 turns it off), so progress does keep a call alive there. The page names no separate limit for `prompts/get` or `resources/read`.
- **Codex** ([MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)): `tool_timeout_sec`, default 60, and `startup_timeout_sec`, default 10, per server. Nothing about progress notifications or prompts and resources.
- **claude.ai and Claude Desktop** ([Build an MCP server](https://claude.com/docs/connectors/building/index)): 240 seconds per tool call.

M8, as ADR 0005's owner, measures them before relying on the bridge's 595-second round: a local stdio run through `spikes/s03b-bridge-elicitation`'s bridge with Claude Code and Codex, timing `prompts/get`, `resources/read` and `tools/call` with and without progress notifications, and sending the 2026-shaped form to a 2025-06-18 host.

## Vendor documentation checked (read-only GETs, 2026-10-18)

Where a page left a step unclear, the step above says "confirm in the session".

- Tailscale, [tailscale funnel command](https://tailscale.com/kb/1311/tailscale-funnel) (last validated 2026-01-26): `tailscale funnel [flags] <target>`; `--https=<port>`; `--bg`, without which Funnel isn't restored after a restart (the sample output ends "Press Ctrl+C to exit"); `status [--json]`, `reset`, and `off` appended to the original flags with the target optional; ports 443, 8443 and 10000; "only `http://127.0.0.1` is currently supported for proxies". No sample status output.
- Tailscale, [Funnel](https://tailscale.com/kb/1223/funnel) (last validated 2026-01-20): beta; Tailscale v1.38.3 or later, MagicDNS, HTTPS certificates and the `funnel` node attribute; the command opens a web page to approve enabling Funnel; public DNS up to 10 minutes; TLS ends on the device; available within the tailnet and to the public. It names no forwarding headers, which is why the session records them.
- Tailscale, [Serve](https://tailscale.com/kb/1312/serve) (last validated 2026-01-20): identity headers `Tailscale-User-Login`, `Tailscale-User-Name` and `Tailscale-User-Profile-Pic` on tailnet traffic, with incoming copies removed; "Funnel traffic, which is publicly available, does not include identity headers"; a port serves either the tailnet or the public, whichever command configured it last.
- Tailscale, [tailscale serve command](https://tailscale.com/kb/1242/tailscale-serve) (last validated 2026-01-26): `tailscale serve status [--json]` lists the servers running on the device; `tailscale serve reset`. No sample status output.
- Tailscale, [Enabling HTTPS](https://tailscale.com/kb/1153/enabling-https): certificates are recorded in the public Certificate Transparency ledger, including the devices' fully qualified domain names; enabling HTTPS means acknowledging that machine names and the tailnet DNS name are published there; "Do not enable the HTTPS feature if any of your machine names contain sensitive information"; a machine can be renamed before it gets a certificate.
- Claude, [Add a connector that isn't in the directory](https://claude.com/docs/connectors/custom/add-unlisted): Customize > Connectors > Add custom connector on Free, Pro and Max (Free: one custom connector); Organization settings > Connectors, Add, Custom, Web for Team and Enterprise Owners, and Connect for members; Authentication (Sign in now, Sign in when needed, No sign-in) and OAuth client (Use Claude's published identity, Register automatically, Use your own OAuth client), under Advanced settings in one-screen dialogs; + > Connectors in a chat; Remove or the three-dot menu; authentication settings can't be changed after adding.
- Claude help centre, [custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) (updated "over 2 weeks ago"): + Add, then Add custom connector; name, URL, Continue; "Use Claude's published identity (Recommended)"; Free users are limited to one custom connector; removal.
- Claude, [Authentication for connectors](https://claude.com/docs/connectors/building/authentication): CIMD only when the AS metadata has `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`, otherwise DCR; a `401` with `resource_metadata` starts sign-in; only the first `authorization_servers` entry is used; scopes from the `401`'s `scope`, else the resource metadata's `scopes_supported`, plus `offline_access` when the AS metadata lists it; the hosted callback `https://claude.ai/api/mcp/auth_callback`; Claude Code's loopback callback on any port, for `localhost` and `127.0.0.1`; 10 s for discovery, registration and token responses, 30 s for refresh; refresh on a `401` and up to five minutes before expiry; `invalid_grant`; rotated refresh tokens; egress from `160.79.104.0/21`.
- Claude, [Test your connector](https://claude.com/docs/connectors/building/testing): Connected under Your connectors; Tool permissions; `clientInfo` names such as `claude-ai`, `Anthropic` and `claude-code`; an overly strict `Origin` check rejects Anthropic's requests.
- Claude, [Build an MCP server for Claude](https://claude.com/docs/connectors/building/index): the 2025-03-26, 2025-06-18 and 2025-11-25 authorization specifications; Streamable HTTP; a 240-second tool-call timeout on claude.ai and Desktop, and `MCP_TOOL_TIMEOUT` in Claude Code.
- Claude Code, [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp): `claude mcp add --transport http <name> <url>` with local scope by default; `claude mcp login <name>` or sign-in from `/mcp`; `claude mcp logout <name>`; `claude mcp remove <name>`, which deletes the stored tokens and client registration; CIMD discovered automatically; a random callback port unless `--callback-port`; prompts as `/server:prompt (MCP)` or `/mcp__server__prompt`; resources as `@server:protocol://path`; the v2 runtime adds revision 2026-07-28, declares form and URL elicitation there, and is chosen with `MCP_SDK_GENERATION` and `MCP_PROTOCOL_NEGOTIATION`; Apps `ui://` resources stay out of `@` suggestions; the timeouts in the previous section.
- Codex, [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) (developers.openai.com/codex/mcp answered 308 to it): `codex mcp add <name> --url <url>`, shown with `--oauth-client-id`; `codex mcp login <name>` with `--oauth-client-registration cimd|dcr` (default auto); CIMD when the AS advertises it, accepts `none` and the callback is a supported loopback URL; the stable document `https://chatgpt.com/oauth/codex/client.json` when the AS advertises and returns `iss`, else a per-server one; for a plain `http://127.0.0.1` callback, Codex "omits the listener port from the URL it displays and stores" and "inserts the active listener port during authorization", and "Authorization servers must accept variable loopback ports under RFC 8252, Section 7.3"; scopes from `scopes_supported`; `tool_timeout_sec` (default 60) and `startup_timeout_sec` (default 10); `codex mcp list` and `codex mcp --help`. Logout and remove aren't on the page.
- ChatGPT, Apps SDK [Authentication](https://developers.openai.com/apps-sdk/build/auth): the stable CIMD document `https://chatgpt.com/oauth/client.json` and redirect `https://chatgpt.com/connector_platform_oauth_redirect` when the AS returns `iss` on every response and advertises it, else callback-specific ones; CIMD first, DCR when the builder chooses it or CIMD isn't available; `private_key_jwt` with the JWKS at `/oauth/jwks.json`; `resource` on authorization and token requests; S256 required; the `401` example names a `scope`. The page doesn't say which scope ChatGPT requests or which assertion audience it uses, which the session records.
- ChatGPT, Apps SDK [Connect and test your plugin](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt) (the same page at `/apps-sdk/deploy/testing`): ChatGPT Plugins, the plus button, Add custom MCP server; name and description; Connection with Public endpoint and the `/mcp` URL; configure authentication; "I understand and want to continue"; Create as a plugin; review the tools; `@` in a fresh chat; Refresh. It doesn't cover developer mode, the authentication options' names or removal, and OpenAI's help-centre article on developer mode (12584461) answered HTTP 403 to a read-only GET.
