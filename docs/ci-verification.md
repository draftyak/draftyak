# CI verification and review

Run `pnpm verify` locally before opening a ready PR, together with the item's
required checks and `pnpm adr` when changing an ADR. CI then supplies reusable
results for review of that exact revision. A reviewer does not need to repeat a
successful suite solely because a new review starts.

## Coverage

The existing `ci` workflow keeps its changed-area selection and required-job
aggregation. A ready PR with non-doc changes runs the Windows default
verification job as well as the applicable Linux jobs. Docs-only PRs use the
docs profile; draft PRs skip the full and Windows jobs. The receipt records those
skips explicitly, so a green aggregate does not turn a skipped job into a pass.

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

The report summarizes job results rather than listing every test. Detailed test
output stays in the job logs. A failure or cancellation remains visible even
when the reporting step completes. The report invokes no review service and
makes no external model call.

## Review steps

1. Check the current PR and its checks:

   ```text
   gh pr view <pr> --json url,headRefOid,baseRefName
   gh pr checks <pr>
   gh api repos/<owner>/<repo>/pulls/<pr> --jq '{head: .head.sha, base: .base.sha, merge: .merge_commit_sha}'
   ```

2. Open the matching `ci` run and attempt. Check its Actions summary or download
   its receipt:

   ```text
   gh run view <run-id> --attempt <attempt>
   gh run download <run-id> --name ci-verification-<run-id>-<attempt>
   ```

3. Match the receipt's PR head, base and tested merge commit to the current PR
   and selected run. Check the actual job checkouts and coverage. A receipt for
   an earlier head or base cannot establish the current merge result. A missing
   receipt or missing checkout metadata cannot establish a match.
4. Reuse passing covered results. For a failed job, inspect its failure output
   first:

   ```text
   gh run view <run-id> --attempt <attempt> --log-failed
   ```

   Run the affected checks after the fix. Repeat or extend verification when
   source or base changes, a check fails or is cancelled, or a required property
   is outside the recorded coverage. A docs-only change still uses the new
   revision's applicable checks rather than borrowing another commit's receipt.

The receipt makes the tested revision and coverage easy to inspect. Review of
the change, required platform evidence and milestone approval remain separate.
