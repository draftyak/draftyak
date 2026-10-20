# M8.5a conformance artifact contract

[M8.5a](m8.md#m85a-bounded-conformance-artifact-validation) owns bounded validation
of local referee outputs. M8.5 owns the actual product profiles, their lifecycle,
workflow, release exclusion and HTTP/stdio hub/bridge/template acceptance.
Passing a fixture profile does not establish product conformance.
This appendix defines the required consumer contract; it adds no validator,
referee dependency, baseline or product workflow to this branch.

ADR [0004](../adr/0004-mcp-sdk-surfaces-and-apps.md) pins
`@modelcontextprotocol/conformance` to `0.2.0-alpha.12`. M8.5a declares that exact
devDependency when its implementation lands. The validator resolves its
installed `package.json` from its own module and checks the package name/version;
callers cannot substitute a
metadata directory. Installed package metadata is trusted dependency data, not
an untrusted artifact snapshot or an authenticated claim about executed code.

## Commands and receipts

```text
pnpm install --frozen-lockfile
pnpm --filter @draftyak/mcp-conformance typecheck
pnpm --filter @draftyak/mcp-conformance test
node tools/mcp-conformance/cli.ts --legacy legacy-artifacts --modern modern-artifacts
pnpm verify
pnpm guard
```

The required CLI reads the fixed repository baseline and emits a bounded JSON
report.
Exit 0 means pass, 1 means evaluated failures, and 2 means invalid arguments or
refused artifacts. Reports contain fixed finding codes, known scenario/baseline
IDs and counts. Raw diagnostics, URLs, details, arguments and environment values
stay out of reports. Genuine fixture files project only scenario/check IDs and
statuses from the pinned referee; they contain no tool content or diagnostics.

Each output directory contains one `run.json` and fresh
`server-<scenario>-<timestamp>/checks.json` directories. The runner executes the
`dist/index.js` belonging to the locally resolved dependency, captures its real
exit status and writes this exact receipt shape, for example for
`legacy-artifacts`:

```json
{
  "era": "2025-11-25",
  "conformanceVersion": "0.2.0-alpha.12",
  "exitCode": 0,
  "args": [
    "server", "--url", "http://127.0.0.1:47613/mcp",
    "--suite", "all", "--spec-version", "2025-11-25",
    "--output-dir", "legacy-artifacts",
    "--expected-failures", "expected-2025-11-25.json"
  ]
}
```

Run both `2025-11-25` and `2026-07-28` with this argument order. The expected-failures
file is `{ "server": [<baseline IDs for that era>] }`. A resolved receipt output
path must equal the directory the validator loads. Copied check files beside a
receipt naming another directory refuse. `--requirements` cannot replace
`--spec-version`: it leaves pending header scenarios unscored. Preserve nonzero
subprocess exits even when check files exist.

Receipts remain unauthenticated local files. M8.5's `conformance.yml` must run the
resolved referee and this validator in one job from reviewed code, recording
the actual executable path/version/invocation and profile provenance. Metadata
alone cannot prove which build, server or profile produced an artifact.

## Evaluation and bounds

Each era needs its complete pinned scenario set. Duplicate/unexpected scenarios,
missing receipts and malformed check IDs/statuses refuse. Check IDs are 1–180
printable ASCII characters without whitespace or `:`; this includes the
referee's JSON Schema `$schema` and `$defs` IDs. Baseline check halves use the
same rule, with a separate known scenario before `:`.

Each exception needs a reason and a matching FAILURE or WARNING. Passing,
skipped, informational or missing exceptions are stale; another failing check
in the same scenario is still unexpected. Exceptions cannot name must-run
scenarios or match `/header|cach|2243|2549|2164/i`. Modern caching, header
validation and SEP-2164 require non-INFO results, all successful. Protected
checks elsewhere must succeed, including
`server-stateless:sep-2575-http-server-header-mismatch-400`. A protected skip
fails even alongside success. Nonprotected skips remain visible in counts.

Artifact loading caps top-level entries at 128, each `checks.json` at 4 MiB,
receipts at 64 KiB, and an era at 32 MiB including its receipt. Caller files use
the single shared bounded regular-file reader: canonical absolute native paths,
no linked ancestors, symlinks or multiple hard links, and unchanged identity,
mode, size and timestamps. Directory iteration uses its own awaited `finally`
close; independent loads do not share an admission slot or retained handles.
An operation refuses if its close rejects, without poisoning later operations.

## Owner review of the copied baseline

M8.5a copies `security/mcp-conformance-baseline.json` unchanged from S03. It is
not yet owner-reviewed: all twelve entries and their reasons await ADR 0004 and
the M0 gate. No acceptance run or matching status grants that approval. Until
protected ownership rules are installed on the target branches, every change
requires the owner's review; a CODEOWNERS file on `m11` does not establish those
branch protections. While the S03
byte-equality test remains, an approved change updates both copies.

| Era | Check | Reason awaiting review |
|---|---|---|
| 2025-11-25 | `logging-set-level:logging-set-level` | Logging is not declared; the method is absent. |
| 2025-11-25 | `tools-call-with-logging:tools-call-with-logging` | No logging capability or SSE notifications; its fixture is absent. |
| 2025-11-25 | `tools-call-with-progress:tools-call-with-progress` | **Explicit decision:** JSON-only responses drop progress notifications. |
| 2025-11-25 | `tools-call-sampling:tools-call-sampling` | Stateless legacy has no server requests; sampling is deliberately absent. |
| 2025-11-25 | `tools-call-elicitation:tools-call-elicitation` | Stateless legacy uses a readable elicitation fallback. |
| 2025-11-25 | `elicitation-sep1034-defaults:elicitation-sep1034-general` | Stateless legacy cannot run server-to-client elicitation. |
| 2025-11-25 | `elicitation-sep1330-enums:elicitation-sep1330-general` | **Explicit decision:** extend the same legacy rationale beyond SEP-1034. |
| 2025-11-25 | `resources-subscribe:resources-subscribe` | Resource subscriptions are not declared. |
| 2025-11-25 | `resources-unsubscribe:resources-unsubscribe` | Resource subscriptions are not declared. |
| 2025-11-25 | `server-sse-polling:server-sse-polling-session` | Warning: no session ID or SSE stream. |
| 2025-11-25 | `server-sse-multiple-streams:server-sse-multiple-streams-session` | Warning: no session ID and only JSON responses. |
| 2026-07-28 | `tools-call-with-progress:tools-call-with-progress` | **Explicit decision:** JSON-only responses drop progress notifications. |

## Remaining M8.5 gates

- Construct an explicit test-only product profile without bypassing transport or
  policy checks, and prove its names/modules absent from release artifacts.
- Complete runner/workflow lifecycle, annotation lint, production-surface checks
  and both eras over HTTP and stdio against the hub, bridge and template.
- Accept actual supported clients and paired-device native approval after their
  dependencies land. Review a referee bump with its complete scenario inventory
  and baseline. Spike retirement waits for every kept case's accepted owner.

Heavy local acceptance uses the shared OS benchmark lease and free-memory
reserve. Remote workflows remain owner-run.
