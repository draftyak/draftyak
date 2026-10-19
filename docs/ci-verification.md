# CI verification and review

Run `pnpm verify` locally before opening a ready PR, together with the item's
required checks and `pnpm adr` when changing an ADR. Review may reuse successful
CI only after the trust, revision and coverage checks below.

## Coverage

The existing `ci` workflow keeps its changed-area selection and required-job
aggregation. A ready PR with non-doc changes runs the Windows default
verification job as well as the applicable Linux jobs. Docs-only PRs use the
docs profile; draft PRs skip the full and Windows jobs. The receipt records those
skips explicitly, so a green aggregate does not turn a skipped job into a pass.
Draft runs name the aggregate `required (draft)` and ready runs name it `required`.
The milestone branches' merge rule requires `required`, `pr-title` and a `review`
status that the integration owner sets on the reviewed head, so a draft run's
result never lets a PR merge.

The receipt covers jobs in this `ci` run. Other workflows, item-specific heavy
checks not selected by it, live/device checks, platform acceptance and owner
sign-off keep their existing requirements. DCO remains a separate check with
the repository's milestone sign-off rule.

## Compact receipt

When reporting can run, it publishes one JSON receipt and an Actions summary.
An early checkout/setup failure or invalid metadata can prevent a receipt; the
required job then fails. The artifact name is
`ci-verification-<run-id>-<attempt>`, binding a rerun to its own attempt. The
receipt identifies the repository, workflow/run, event, PR head and base, and
the merge commit tested for a PR. It records each contributing job's status and
actual checkout commit, Git tree, lockfile digest and Node version. Missing
metadata stays explicit; it is not filled from another job or inferred from a
successful status.

The report summarizes job results rather than listing every test. It also
records the classifier selection: `areas`, `rust`, `spikes`, `heavy` and
`templateSmoke`, or null when `changes` did not succeed. Classifier output is not
proof of execution: effective template-smoke selection also depends on the
event/base, and the heavy step has its own condition. A successful `full` job
does not establish that its conditional Rust, heavy or template-smoke steps ran.
Detailed output and step conclusions stay in GitHub's job records. A failure or
cancellation remains visible even when the reporting step completes.

The receipt is untrusted input produced by the PR's own workflow and reporting
code. It cannot establish its own trustworthiness, even when its hashes and
commit fields match. GitHub's check and run/job records are authoritative for
which jobs ran and how they ended; the receipt is their compact summary.

## Review steps

1. Check the PR's author and origin before reading its diff or using its CI:

   ```text
   gh pr view <pr> --json author,isCrossRepository,url,headRefOid,baseRefName
   ```

   Never reuse CI from an outside contributor's PR, including an approved fork
   run. Do not read that diff or act on its receipt; outside contributions follow
   the owner's separate review process.

2. For an owner PR, list the changed paths before trusting verification results:

   ```text
   gh pr diff <pr> --name-only
   ```

   Review changes to any of the following first, then run the affected checks
   locally instead of reusing the receipt:

   - `.github/`, `tools/ci-checks/` or `tools/verify/`;
   - root or package `package.json` scripts, or any `turbo.json`;
   - `vitest.shared.ts`, Vitest configs, `biome.json` or `tsconfig*`;
   - `pnpm-workspace.yaml`, `.node-version` or `rust-toolchain.toml`.

   These files can change what runs or how a result is reported. A matching
   receipt or a green job cannot validate those changes on its own.

3. Read the current PR head and the base branch's current tip, then inspect
   GitHub's checks and the chosen run/attempt:

   ```text
   gh pr view <pr> --json headRefOid,baseRefName
   gh api repos/<owner>/<repo>/branches/<base> --jq .commit.sha
   gh pr checks <pr>
   gh run view <run-id> --attempt <attempt> --json headSha,event,jobs
   ```

   Use the branches API for the base tip. The pulls API's base SHA and merge
   commit, and `baseRefOid`, can remain tied to an earlier PR event after the
   branch moves. They do not establish its current tip.

4. Download the matching run/attempt's receipt into a new temporary folder
   outside the worktree:

   ```text
   gh run download <run-id> --name ci-verification-<run-id>-<attempt> --dir "<new temporary folder outside the worktree>"
   ```

5. Require `source.headSha` to equal the current `headRefOid` and
   `source.baseSha` to equal the base branch's current tip. Check the run's
   `pull_request` event and the actual job checkouts against the receipt's tested
   merge commit/tree. A missing receipt, mismatched identity or missing checkout
   metadata cannot establish a match. If the base moved, rebase and push to
   create a new `pull_request` event; rerunning the old event still tests its
   old merge commit and is insufficient.

   Compare the recorded selection, or the actual `full` step conclusions from
   `gh run view <run-id> --attempt <attempt> --json jobs`, with the item's
   acceptance commands. Run required checks that were not selected; a green
   aggregate or `full` status does not cover them.

6. Reuse only passing, trusted and covered results. For a failed job, inspect its
   failure output first:

   ```text
   gh run view <run-id> --attempt <attempt> --log-failed
   ```

   Run the affected checks after the fix. Repeat or extend verification when
   source or base changes, a check fails or is cancelled, or a required property
   is outside the recorded coverage. A docs-only change still uses the new
   revision's applicable checks rather than borrowing another commit's receipt.

The receipt makes the tested revision and coverage easy to inspect. Review of
the change, required platform evidence and milestone approval remain separate.
