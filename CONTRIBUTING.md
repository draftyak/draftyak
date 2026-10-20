# Contributing to DraftYak

DraftYak is public and under development. Milestone backlogs describe the available work, prerequisites and remaining gates. This guide covers the current development workflow and names the milestone for anything still to come. [AGENTS.md](AGENTS.md) has the repository map and command reference; the submission rules below apply to current contributions.

## Licence and sign-off

- DraftYak is licensed under the [Apache License, Version 2.0](LICENSE), and you contribute under the same licence. There is no contributor licence agreement (CLA).
- Instead, every commit carries a `Signed-off-by` line certifying the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO): in short, that you wrote the change or otherwise have the right to submit it under the project's licence. Read the full text before your first sign-off.
- Only you, the human contributor, sign off. Tools, scripts and bots never add `Signed-off-by` for you.
  - A new commit: `git commit -s`.
  - Commits already on your branch: `git rebase --signoff <base>`, for example `git rebase --signoff origin/m0`.
- Git signs off with your `user.name` and `user.email`, so keep them equal to your commits' author: the `dco` check (M0.3) requires every commit to carry a sign-off that matches its author.
- [NOTICE](NOTICE) carries the copyright and trademark notices: DraftYak™ is a trademark of Nick Savov, and the licence grants no trademark rights. The trademark policy is [TRADEMARKS.md](TRADEMARKS.md).

## You answer for your change

You are accountable for everything you submit, whatever tools you used to make it.

- Read and understand every line, and make sure you have the right to contribute it.
- Test it. Security-critical modules need tests in the same PR.
- Credit no tool: no attribution trailers and no statements about how the work was produced, in commits, PR titles and descriptions, code, comments or documents. The checks reject every `Co-authored-by` trailer, whoever it names; to credit a human co-author, name them in prose in the PR description.

## Setting up on Windows

1. Install Git for Windows. It also provides Git Bash and the `gpgv` that `pnpm fetch-node` (M0.5) uses to check Node's signatures.
2. Clone outside OneDrive or any other synced folder, to a short folder on a local drive. Windows can't start a program whose path has 260 characters or more, even with long paths on, and `node_modules` adds about 100 characters to some tools' paths, so keep the clone path well under 150 characters.
3. Install Node.js 26.12.0, the version in `.node-version`; `package.json` requires at least 26.5.1.
4. In Windows PowerShell, `npm` and `pnpm` run as `.ps1` scripts, which its default execution policy blocks. Allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or with the PowerShell setting under Settings → System → Advanced. Git Bash needs neither.
5. Install pnpm 11.28.6, the version in the `packageManager` field of `package.json`: `npm install --global pnpm@11.28.6`. Node 26 no longer ships Corepack.
6. In the clone, run:

   ```
   pnpm install --frozen-lockfile
   node tools/verify/turbo.ts telemetry disable
   pnpm verify
   ```

   The second command turns Turbo's telemetry off for good on this machine and prints `Success!`. It goes through the repository's Turbo launcher, so the call itself reports nothing; `pnpm exec turbo telemetry disable` would, where telemetry is still on. `pnpm verify` ends with `verify: <n>/<n> steps passed`. From then on, run Turbo only through the root scripts (`pnpm typecheck`, `pnpm test`, `pnpm build`) or `pnpm verify`, which start it with telemetry off.

Add the rest when your work needs it:

- **Rust**, for the Rust spikes and later the desktop app: rustup, plus Visual Studio Build Tools with the "Desktop development with C++" workload. `rust-toolchain.toml` pins Rust 1.95.0 with rustfmt and clippy, and rustup uses it inside the repository.
- **Docker Desktop** with Linux containers, for heavy tests. Your Windows account must be in the `docker-users` group.
- **Developer Mode** (Settings → System → Advanced; "For developers" on older Windows 11 builds), so heavy tests can create symlinks. Without it, the symlink cases of the plugin-sandbox and Python escape tests (M0.11, M0.34) run only in CI.
- **Long paths**, for deep build folders such as Rust's and Gradle's: turn on "Enable long paths" on the same Settings page, and run `git config core.longpaths true` in the clone.
- **GitHub CLI** (`gh`), signed in with access to the repository, for pull requests and `pnpm ci:minutes`. Live spike execution is reserved for an owner session.
- **uv 0.13.1** (`winget install --id astral-sh.uv --exact --version 0.13.1`, then open a new terminal). It runs the zizmor workflow audit (M0.3; `pnpm verify:m0` fails without uv). Python packages are postponed beyond the initial desktop pilot.
- **JDK 21 and the Android SDK** command-line tools and platform-tools, for separately resumed SMS probe (M0.37a) or SMS host (M6b) work, which is postponed beyond the initial desktop pilot. Accept the SDK licences yourself (`sdkmanager --licenses`).

## Making a change

- Start from the backlog: `docs/roadmap/mN.md` lists each item with the paths it owns and its acceptance commands. Change only those paths.
- Branch from the current remote milestone integration branch as `mN-<number>-<slug>`, with at least two digits, for example `m11-02-labels`. Fetch and rebase only that item branch onto `origin/mN` before submitting or pushing an update; preserve frozen snapshots and divergent local branches instead of bulk rebasing. Resolve a `pnpm-lock.yaml` conflict with the normal `pnpm install` writer; preserve unrelated importers and dependency edges.
- Keep each PR within its backlog item's owned scope, focused on one item or a coherent group of related items. Do not combine unrelated PRs. The earlier approximately 1,500-line guideline is lifted; `pnpm pr-size` reports code and raw totals for review, without imposing a submission cap.
- Never commit secrets. Live-session secrets live only in the main checkout's git-ignored `.env.live`; `.env.live.example` lists their names.
- Before submitting or pushing an update, install from the frozen lockfile, run the touched packages' tests, typecheck/build where applicable, changed-file lint, the item's applicable acceptance commands, and `pnpm guard` with zero findings. Run `pnpm adr` when an ADR changes. Documentation/community/evidence-only changes use `node tools/verify/verify.ts --profile docs`, with no install required for that profile. Whole-repository `pnpm verify` remains a setup diagnostic and is required for integration updates without CI and milestone checks; it is not required before an item PR. Exact-head CI supplies the applicable full Linux/Windows suites.
- If a change affects what CI runs, skips or accepts, run every affected check locally with hostile/boundary inputs and mutation proofs. A green aggregate or receipt does not establish that a skipped check ran. Keep live, device, platform and owner acceptance separate, and preserve the documented test-tier boundaries.
- Open the PR ready for review with an explicit milestone base, such as `gh pr create --base m11`. Mark an existing draft ready when you next push it. Reviews start when CI is green at the current head, with the DCO exception described below. End the PR description with a short Self-check listing the commands you ran and their actual results; identify checks that remain unrun.
- Before submitting, reread the item's plan clauses, owned paths and acceptance commands. Fix any carried minor findings for the area and name their PR and finding numbers in the description. Backlog PRs include a coverage table mapping each owned plan requirement to its item and acceptance command, with explicit gaps or owner handoffs. Milestones with manual owner checks also own their documented runbooks and fake dry runs; M0's live-session runbooks remain with the owner.
- Write commit messages and PR titles as Conventional Commits, `<type>(<scope>): <summary>` with an optional scope and one of the types `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert` or `spike`. The `pr-title` check (M0.3) enforces it for titles.
- Arguments after a script name reach the script, with two differences between shells. PowerShell's `pnpm.ps1` drops a leading `--`, which Git Bash and cmd pass through, so every repository CLI behind a root script must accept and ignore one; Biome doesn't, so give `pnpm lint` and `pnpm format` their flags without `--`. PowerShell also splits an unquoted comma into separate values, so single-quote such values, as in `pnpm spikes:run --spikes 's01,s02'`, which works in both shells.
- Changesets start with the first publishable package; until then, no PR needs one.

Open item PRs ready for review into the explicit milestone branch. They require the applicable checks, approval of the submitted commit and rebase auto-merge pinned to that commit. Every changed head needs review again; hold an approved head unchanged unless auto-merge is disabled by a conflict. The integration owner verifies milestone-branch updates; only the owner signs off and merges a milestone into `main` at its gate, so `dco` may fail on item PRs until then.

## Security-sensitive paths

Changes to these paths get careful review, and code there needs hostile and boundary-input tests in the same PR. For security-critical code, use a controlled mutation to prove that the test fails when its guarded property breaks:

- in M0: `.github/` and `tools/ci-checks/` (M0.3), `tools/vendor-guard/` (M0.4), `tools/fetch-node/` (M0.5), `spikes/kit/env-live.ts` and `spikes/kit/evidence.ts` (M0.6a), the S12 privacy gate (`spikes/s12-sms/schema/` and `spikes/s12-sms/src/receive-report.ts`, M0.36; the probe's report serializer and manifest, M0.37a) and the supply-chain settings in `pnpm-workspace.yaml` (M0.1);
- current tooling: `tools/verify/` and `tools/launch-checks/`;
- from M1 on, as they arrive: `packages/{protocol,mime,extensions,runtime-python,bounded-files,lookup-core}/`, `crates/`, `security/`, the hub's security modules under `apps/hub/src/` (key manager, kernel, store, audit, credentials, recovery, extensions, identity, auth, authz, policy, accounts, plugins, devicehost, tools, outbox, mcp, oauth-as, api, listeners), `apps/{mcp-apps,sms-host}/` and `tools/{release-guard,android-manifest-guard,egress-recorder,sign-sms-host}/`. Required ownership covers nested files as well as direct files.

[CODEOWNERS](.github/CODEOWNERS) requests the owner's review for changes to these paths. Report a suspected vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in an issue or PR.

## Adding a channel

The initial desktop pilot bundles first-party plugins. The plugin-author kit, third-party installation, Python packages and SMS host are postponed; they are not launch prerequisites. M11.2b reconciles the actual retained M1.25 contributor/setup additions after they reach this branch. The canonical plugin-author/channel walkthrough belongs to postponed documentation and requires the actual future SDK, plugin testkit, scaffolder, `channel-hello` and guide implementations. M1.17 owns `docs/guides/adding-a-channel.md`. Do not substitute unimplemented APIs or guessed commands. S11/S12 and their implementation work are postponed. The uv requirement above remains relevant to the existing workflow audit; JDK/Android setup applies to separately resumed SMS work.
