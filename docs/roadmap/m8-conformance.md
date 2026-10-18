# M8 conformance artifact gate

This is the artifact-validation portion of M8.5. It validates local outputs from
the pinned referee. Product profile construction, a real referee run and actual
client acceptance remain separate gates.

ADR [0004](../adr/0004-mcp-sdk-surfaces-and-apps.md) pins
`@modelcontextprotocol/conformance` to `0.2.0-alpha.12`. The repository baseline
in `security/mcp-conformance-baseline.json` retains the reviewed S3 exceptions.
The package-local Turbo inputs include that baseline and the reviewed S3
baseline/evidence, so their changes invalidate cached tests.

## Commands and artifact contract

```powershell
pnpm install --frozen-lockfile
pnpm --filter @draftyak/mcp-conformance test
pnpm --filter @draftyak/mcp-conformance typecheck
pnpm verify
pnpm guard
```

After a real test profile produces fresh outputs for both eras:

```powershell
node tools/mcp-conformance/cli.ts --cli-package <installed-conformance-package-directory> --legacy <legacy-artifacts> --modern <modern-artifacts>
```

The command reads package metadata without importing package code. It refuses a
different package name or version, reads the fixed baseline, emits JSON to
stdout and returns 0 for a passing gate, 1 for evaluated failures, or 2 for
invalid arguments/artifacts. Reports contain fixed finding codes, known
scenario/baseline identifiers and counts. Raw diagnostics, URLs, check details,
invocation arguments and environment values stay out of reports.

Each era directory contains fresh `server-<scenario>-<timestamp>/checks.json`
directories and a `run.json` receipt captured directly from the completed
subprocess. The receipt records the era, exact referee version, exit code and
arguments. The runner must invoke `server --url <loopback-profile-url> --suite
all --spec-version <era> --output-dir <fresh-directory> --expected-failures
<era-baseline-file>` for `2025-11-25` and `2026-07-28`. The expected-failures file
has the shape `{ "server": [<reviewed baseline IDs for that era>] }`.
`--requirements` cannot substitute for `--spec-version` because it leaves the
pending header scenarios unscored. Preserve a failing subprocess status even
when check files were written.

The gate requires exact invocation shape, exit 0 and each era's complete pinned
scenario set. Duplicate or unexpected directories refuse. Each baseline entry
needs an explanation and a matching FAILURE or WARNING; passing, skipped,
informational or missing entries are stale. Any other FAILURE or WARNING fails
the gate, including another check in a baselined scenario.

Exceptions cannot name must-run scenarios or match
`/header|cach|2243|2549|2164/i`. Modern caching, header validation and
`sep-2164-resource-not-found` scenarios require non-INFO checks, all successful. Protected non-INFO
checks elsewhere must also succeed, including
`server-stateless:sep-2575-http-server-header-mismatch-400`. A skipped protected
check fails even if another result for its ID succeeds. Nonprotected skips
remain visible in counts.

Receipts and check files are ordinary local artifacts. They do not authenticate
the tested server, commit or profile; handwritten metadata cannot establish a
product conformance result.

## Native reader bounds and cleanup

Artifact loading allows 128 top-level entries, 4 MiB per `checks.json`, 64 KiB
per receipt or package metadata, and 32 MiB per era including its receipt.
Reads use one descriptor with a size-plus-one bound and refuse identity, size,
change-time or UTF-8 drift, final file symlinks, and artifact-root or scenario-
directory symlinks and junctions. Ancestor paths remain caller-selected.

The asynchronous reader holds one private operation slot across filesystem and
cleanup awaits, owning at most one original native directory and one file.
Resources register immediately after open. Captured native methods perform
cleanup before any new allocation; selected paths are snapshotted before a
cleanup await. An unresolved native operation retains admission.

`FileHandle` can retire its public descriptor before its close promise settles.
A rejected close after retirement therefore permanently retains that original
object and blocks new allocation. A later resolved public close cannot establish
native completion. Failures before retirement retain original-object recovery;
numeric descriptors never become cleanup authority.

`Dir` also advances logical state before native completion. An initial
`ERR_DIR_CLOSED`, or any other rejected close, permanently retains the original
directory. The marker establishes completion only after a successful awaited
close in the same cleanup sequence. Repeated false success cannot release
admission. Other retained resources still receive cleanup attempts.

Uncertain ownership requires process restart and eventual OS cleanup. Tests
inject native file-close failures and controlled directory-wrapper failures;
they do not establish a reproduced native directory callback failure or promise
to interrupt blocked I/O. Independent descriptors remain outside this reader's
authority.

## Remaining M8.5 integration

- Build a test-only product profile through explicit construction while retaining
  transport and policy checks. This validator adds synthetic output fixtures;
  it supplies no product callback, fixture server or authority bypass.
- Install the exact pinned referee, manage the profile's lifecycle, capture real
  receipts and complete fresh outputs, invoke this validator, and retain
  content-free provenance for the actual server commit and profile.
- Prove fixture names and modules are absent from release artifacts. Complete
  annotation lint, HTTP/stdin era parity and production-surface checks.
- Run actual supported clients and the owner acceptance gate after the required
  native and integration dependencies land. Review a referee bump with the
  complete scenario inventory and baseline together.

Use the shared OS benchmark lock and preserve the machine's free-memory reserve
for heavy verification or conformance runs. Remote workflows remain owner-run.
