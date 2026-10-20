# M8 owner check: local MCP clients

This is the M8.7 runbook for the M8.6 stop-and-review gate. Allow 45–60 minutes
after prerequisites, including one scheduled test send. Installation and provider
setup can take longer. Only the owner performs genuine-client and provider steps.
Use synthetic mailbox content and owner-controlled test recipients; keep message
content, tokens, PINs, personal paths and screenshots containing them out of reports.

## Prerequisites and stop conditions

- M8.1–5a and their native M2/M3/M4 dependencies must be merged and verified.
  The CLI, native token/session administration, paired desktop and fake demo must
  be actual implementations. A snippet-only CLI does not mint an agent token.
- Use a separate test OS account/profile and test hub, never the owner's everyday
  installation. M3's fake demo must provide isolated data and fakes before the
  offline rehearsal. If safe test-profile setup is unavailable, stop and leave
  the rehearsal open; do not invent flags or use the real profile instead.
- Install the supported Desktop, Code, Codex and VS Code versions. Record version
  and negotiated era only. The public bridge launch is
  `draftyak mcp --client <name>`; do not substitute an internal hub-address option.
- A paired desktop must have current approval rights. PIN entry happens only on
  its native trusted surface. An agent, browser, elicitation form or client
  “Allow” dialog must never request or receive the PIN.
- Obtain M8.5's owner-approved conformance baseline and the actual locally built
  M8.1 bridge/M8.4a MCPB following M2.11's payload contract. Confirm the runtime
  actually selected by the installing host meets the authoritative Node floor;
  a valid archive or a terminal's unrelated Node version is insufficient. Leave
  the MCPB host check open if runtime provisioning is unresolved. This baseline
  does not wait for an M10 release artifact or M8b views. Release-built reruns and
  inspection belong to M10.13a–c in
  [the later acceptance](../roadmap/m8.md#later-m10-acceptance); do not import
  M10 code backward into `m8`.
- SMS rows are conditional on the S12 decision and M1.23/M6b. Record “blocked by
  prerequisite” while absent; do not replace the phone/host gate with fake data.

## Offline rehearsal

Run from the repository root in PowerShell after the listed packages are merged.
Each test must construct its own fake listeners, temporary token/config files and
data. These commands are not permission to start a real hub, read client
credentials, invoke a vendor CLI or contact a provider.

First run this source/package gate. It starts no service or installation, reads
no credentials and contacts no provider. These exact component paths match the
prepared bridge, packer and artifact-validator packages; their owning items must
reconcile any deliberate layout change before acceptance.

```powershell
@'
import { readFileSync, statSync } from "node:fs";
const files = [
  "apps/cli/src/main.ts",
  "apps/cli/src/bridge.ts",
  "apps/cli/src/stdio.ts",
  "apps/cli/src/mcp-config/plan.ts",
  "apps/cli/src/mcp-config/setup.ts",
  "apps/cli/test/client-selector.test.ts",
  "apps/cli/test/bridge.test.ts",
  "apps/cli/test/stdio.test.ts",
  "apps/cli/test/mcp-config.test.ts",
  "apps/cli/test/protected-setup.test.ts",
  "apps/cli/test/protected-close.test.ts",
  "apps/cli/test/native-bridge.test.ts",
  "apps/cli/test/launcher.test.ts",
  "tools/mcpb/index.mjs",
  "tools/mcpb/cli.mjs",
  "tools/mcpb/test/bundle.test.ts",
  "tools/mcpb/test/close-ownership.test.ts",
  "tools/mcp-conformance/cli.ts",
  "tools/mcp-conformance/artifacts.test.ts",
  "tools/mcp-conformance/gate.test.ts",
  "tools/mcp-conformance/referee-fixture.test.ts",
  "tools/mcp-conformance/test/fixtures/pinned-referee.json",
  "security/mcp-conformance-baseline.json"
];
const packages = [
  ["apps/cli/package.json", "@draftyak/cli"],
  ["tools/mcpb/package.json", "@draftyak/mcpb"],
  ["tools/mcp-conformance/package.json", "@draftyak/mcp-conformance"]
];
const missing = files.filter((name) => {
  try { return !statSync(name).isFile(); } catch { return true; }
});
for (const [name, expectedName] of packages) {
  let metadata;
  try { metadata = JSON.parse(readFileSync(name, "utf8")); } catch { /* Block below. */ }
  if (metadata?.name !== expectedName) missing.push(`${name}: package identity`);
  for (const script of ["typecheck", "test"]) {
    const command = metadata?.scripts?.[script];
    if (typeof command !== "string" || command.trim().length === 0)
      missing.push(`${name}: scripts.${script}`);
  }
}
for (const item of missing) console.error(`Missing prerequisite: ${item}`);
if (missing.length) process.exitCode = 1;
else console.log("Component source prerequisites present; inspect actual native and acceptance results next.");
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'M8 component rehearsal is blocked by missing prerequisites.' }
```

A source pass establishes file/package presence only, not valid implementations,
approved baseline exceptions, merged contracts or native authorization. Missing
files/scripts stop that section. An unmatched filter or empty selection cannot
count as a dry-run.

```powershell
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'Frozen installation failed.' }
pnpm --filter @draftyak/cli --fail-if-no-match typecheck
if ($LASTEXITCODE -ne 0) { throw 'CLI typecheck failed.' }
pnpm --filter @draftyak/cli --fail-if-no-match exec vitest run --reporter=default
if ($LASTEXITCODE -ne 0) { throw 'CLI tests failed.' }
pnpm --filter @draftyak/mcpb --fail-if-no-match typecheck
if ($LASTEXITCODE -ne 0) { throw 'MCPB typecheck failed.' }
pnpm --filter @draftyak/mcpb --fail-if-no-match exec vitest run --reporter=default
if ($LASTEXITCODE -ne 0) { throw 'MCPB tests failed.' }
pnpm --filter @draftyak/mcp-conformance --fail-if-no-match typecheck
if ($LASTEXITCODE -ne 0) { throw 'Conformance-validator typecheck failed.' }
pnpm --filter @draftyak/mcp-conformance --fail-if-no-match exec vitest run --reporter=default
if ($LASTEXITCODE -ne 0) { throw 'Conformance-validator tests failed.' }
```

The CLI fixtures check literal client selection, protected token handling,
configuration diff/backup preservation, bounded stdio and real loopback bridge
behavior. Packer tests check archives and launch handoff. Artifact-validator tests
check pinned-referee artifacts. None proves native authorization or a genuine host.
Allow roughly 5–10 minutes. If a package or target is missing, stop that section
as an unmet dependency; an empty test selection is not a dry-run.

The native rehearsal additionally requires the M8-owned targets below. They are
planned acceptance targets until implemented and registered by M8.2/3/5; their
absence is an explicit gap, not an instruction to fabricate a passing driver.

The native gate checks every named target and the real hub package before
running a command. Strict skips apply throughout; the `finally` restores the
caller's prior environment after success or failure. Missing heavy prerequisites
fail instead of becoming skipped acceptance.

```powershell
$nativeTargets = @(
  'apps/hub/test/mcp/tools.test.ts',
  'apps/hub/test/mcp/agent-tokens.test.ts',
  'apps/hub/test/mcp/surfaces.test.ts',
  'apps/hub/test/mcp/mrtr.test.ts',
  'apps/hub/test/mcp/prompt-hygiene.test.ts',
  'apps/hub/test/mcp/completion-leakage.test.ts',
  'apps/hub/test/mcp/plugin-surfaces.test.ts',
  'apps/hub/test/mcp/headers.test.ts',
  'apps/hub/test/mcp/caching.test.ts',
  'apps/hub/test/mcp/scheduling.test.ts',
  'apps/hub/test/mcp/authority.test.ts',
  'apps/hub/test/mcp/conformance.heavy.test.ts',
  'apps/hub/test/mcp/authority.heavy.test.ts'
)
foreach ($target in $nativeTargets) {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Native M8 rehearsal is blocked: missing $target"
  }
}
@'
import { readFileSync } from "node:fs";
try {
  const metadata = JSON.parse(readFileSync("apps/hub/package.json", "utf8"));
  if (metadata.name !== "@draftyak/hub") throw Error();
  for (const name of ["test", "test:heavy"]) {
    const value = metadata.scripts?.[name];
    if (typeof value !== "string" || value.trim().length === 0) throw Error();
  }
} catch {
  console.error("Missing prerequisite: real hub package with test and test:heavy scripts");
  process.exitCode = 1;
}
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'Native M8 package prerequisites are missing.' }
$hadStrictSkips = Test-Path Env:DRAFTYAK_STRICT_SKIPS
$priorStrictSkips = $env:DRAFTYAK_STRICT_SKIPS
try {
  $env:DRAFTYAK_STRICT_SKIPS = '1'
  pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --reporter=default test/mcp/tools.test.ts test/mcp/agent-tokens.test.ts test/mcp/surfaces.test.ts test/mcp/mrtr.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Native tool/token/surface/MRTR checks failed.' }
  pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --reporter=default test/mcp/prompt-hygiene.test.ts test/mcp/completion-leakage.test.ts test/mcp/plugin-surfaces.test.ts test/mcp/headers.test.ts test/mcp/caching.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Native hygiene/completion/header/cache checks failed.' }
  pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --reporter=default test/mcp/scheduling.test.ts test/mcp/authority.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Native scheduling/authority checks failed.' }
  pnpm --filter @draftyak/hub --fail-if-no-match exec vitest run --mode heavy --reporter=default test/mcp/conformance.heavy.test.ts test/mcp/authority.heavy.test.ts
  if ($LASTEXITCODE -ne 0) { throw 'Native conformance/hostile-authority checks failed.' }
} finally {
  if ($hadStrictSkips) { $env:DRAFTYAK_STRICT_SKIPS = $priorStrictSkips }
  else { Remove-Item Env:DRAFTYAK_STRICT_SKIPS -ErrorAction SilentlyContinue }
}
```

Expect real fake-hub operations in both eras, unchanged recipients, identical
tool/resource authorization and budgets, no send before approval, negative MRTR
and header controls, and a conforming pinned-referee result. M2's approval model
and release fixture exclusion remain separate prerequisites. Run each available
step below on the isolated fake demo first; reserve provider and genuine-host
observations for the owner. Do not advance a missing native driver as “covered”
by a pure schema or artifact test.

## Owner steps

| Step | Action and exact interface | Expected observation | Failure action | Estimate |
|---|---|---|---|---|
| L1 — public entry | Run `draftyak mcp --help`. In the test environment run `draftyak mcp --client unknown`. | Help lists the four canonical profiles. The invalid name exits with a fixed refusal before token access or connection. | Stop if an alias is silently chosen, credentials are read or diagnostics expose input. Fix M8.1 before continuing. | 2 min |
| L2 — configure | Run the four `mcp add` commands below. Review the snippets and shell-access warning. Provision each principal through the actual native admin/PIN flow; choose test account allowlists and leave organize off. | No files change by default. A client profile grants no authority. A real token exists only after the native admin operation. The warning explains the same-OS-user shell limit. | A credential-free snippet alone is insufficient. Stop if token minting is absent, a default write occurs, or a vendor credential file/CLI is touched. | 5–10 min |
| L3 — draft in three clients | Configure each client to launch the matching public command below. In Desktop, Code and Codex, choose the same controlled conversation and request a draft. First try without a device-approved session; then approve the correct read/draft class on the paired desktop and retry. | Before approval: readable `AGENT_SESSION_REQUIRED`, no data leak. After approval: the intended account/draft, untrusted text and provenance, no context-result text and no outbox send. Client dialogs do not approve anything. | Stop on a bypass, foreign account, missing framing/provenance or any send. Revoke the test token and retain only content-free failure metadata. | 8–12 min |
| L4 — Code surfaces | In Code run `draft_reply` for that conversation, read `draftyak://conversation/{id}` using the actual returned ULID, and request `triage_inbox` without an account while two test aliases are allowlisted. | The conversation resource uses the same session/budget pipeline. An eligible modern client shows only the alias form. A legacy/undeclared mode uses the documented readable fallback; form acceptance grants no session. | Stop on mailbox content in the prompt, arbitrary completion, PIN/secret/time input, duplicate approval prompts or a state retry that grants authority. A required real-client form that is unavailable remains an open gate. | 5 min |
| L5 — propose and approve | From each of the three clients request a send to the controlled test recipient. Make one a scheduled proposal at least five minutes ahead. Inspect `send_request_status` and its text result before entering the PIN on the paired desktop. | Every request stays pending until native approval. The desktop shows the actual recipients, bytes, fingerprint and proposed time/window. Each approved request takes effect exactly once at the accepted time. The client cannot bind or alter the schedule. | Cancel pending test requests and stop on early/late/duplicate delivery, mismatched bytes/time or a client-side approval control. Do not adjust the real hub clock to force a result. | 10–15 min |
| L6 — VS Code discovery | In VS Code list the guide, four resource templates and four prompts. Complete `account`, `window` and `tone`; try a message subject/ID prefix and a template variable. | Only routed aliases and fixed values complete, at most twenty. Resources do not enumerate mail. Native fake tests establish the bucket and canary negatives that the UI cannot prove. | Stop on contacts, subjects, labels, IDs, content-derived aliases or an exposed hidden account. | 4 min |
| L7 — isolation and revoke | Prepare a separate future request from the first agent, approve its content/time with the desktop PIN and confirm `SCHEDULED`. With a second principal attempt cancellation of that request and an edit of its live draft. Revoke the first token through native AI-app settings and retry a read. Inspect the offered cancellation of that agent's scheduled sends. | Foreign cancellation refuses; a live item yields `DRAFT_LOCKED`. Revoked access fails. Revocation does not silently send, cancel or approve; the owner explicitly chooses whether to cancel scheduled items. | Stop on leaked access or state changes. Cancel remaining approved schedules through the authorized owner path before their deadline. | 4 min |
| L8 — close and record | Revoke remaining test tokens, cancel remaining test requests, restore only the configuration diff/backup created for this check, and close the test clients/hub. Run the gate and documentation commands below. | No active test grants or pending schedules remain. Record versions, named steps, expected/actual statuses and unresolved gates without content or secrets. | A cleanup failure stays open; do not delete an everyday profile or unrelated client configuration. | 3 min |

The braces in `draftyak://conversation/{id}` denote the actual validated ID from
the test result; they are not a literal URI to send. The precise client UI for
selecting an MCP prompt can change by version, so record the menu actually used
without claiming a CLI command that the client does not supply.

```sh
draftyak mcp add --client claude-desktop
draftyak mcp add --client claude-code
draftyak mcp add --client codex
draftyak mcp add --client vscode
```

Generated client configuration must launch the corresponding command below.
The client launches it; do not start all four in an unrelated terminal and
treat an idle stdio process as successful connection.

```sh
draftyak mcp --client claude-desktop
draftyak mcp --client claude-code
draftyak mcp --client codex
draftyak mcp --client vscode
```

Use `--write` only through M8.4b's implemented preview/approval path, with its
exact preimage/plan checks and protected backup. Only the two plan-approved
configuration files may be written. Do not copy vendor credential stores or
paste a token into a report, shell history or conversation.

## Gate and handoffs

```powershell
pnpm verify:m8
if ($LASTEXITCODE -ne 0) { throw 'M8 milestone gate failed or is unavailable.' }
node tools/verify/verify.ts --profile docs
if ($LASTEXITCODE -ne 0) { throw 'Documentation checks failed.' }
pnpm guard
if ($LASTEXITCODE -ne 0) { throw 'Repository guard failed.' }
```

`verify:m8` must be registered by M8.6 and include native fake, conformance and
owner-step evidence; an absent aggregate is a blocker. The native real-client
gate is not completed by executing the component commands above. Only the owner
can accept L3–L8 and authorize the controlled provider send.

Passive-view/native-host checks are separate M8b acceptance, with its owner
check at M9; use M8b.8's planned `docs/runbooks/m8b-apps.md` there. They do not
block the local text-tool/resource/prompt gate above. Remote authentication,
number matching, rotation/reuse and deployment belong to M9.7's planned
`docs/runbooks/m9-connectors.md`; do not repeat or replace that flow here.
Leave Node provisioning, the twelve baseline decisions, unavailable host modes
and conditional SMS observations open until their owners resolve them.
