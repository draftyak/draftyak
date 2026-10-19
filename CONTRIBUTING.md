# Contributing to DraftYak

DraftYak is in its first milestone, M0 (workspace bootstrap and spikes), and the repository stays private until launch. This guide covers what exists today and names the milestone for anything still to come. [AGENTS.md](AGENTS.md) has the repository map, every command and the full work rules.

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
2. Clone outside OneDrive or any other synced folder, to a short path such as `C:\dev\draftyak`. Windows can't start a program whose path has 260 characters or more, even with long paths on, and `node_modules` adds about 100 characters to some tools' paths, so keep the clone path well under 150 characters.
3. Install Node.js 26.12.0, the version in `.node-version`; `package.json` requires at least 26.5.1.
4. In Windows PowerShell, `npm` and `pnpm` run as `.ps1` scripts, which its default execution policy blocks. Allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or with the PowerShell setting under Settings → System → Advanced. Git Bash needs neither.
5. Install pnpm 11.28.6, the version in the `packageManager` field of `package.json`: `npm install --global pnpm@11.28.6`. Node 26 no longer ships Corepack.
6. In the clone, run:

   ```
   pnpm install
   node tools/verify/turbo.ts telemetry disable
   pnpm verify
   ```

   The second command turns Turbo's telemetry off for good on this machine and prints `Success!`. It goes through the repository's Turbo launcher, so the call itself reports nothing; `pnpm exec turbo telemetry disable` would, where telemetry is still on. `pnpm verify` ends with `verify: <n>/<n> steps passed`. From then on, run Turbo only through the root scripts (`pnpm typecheck`, `pnpm test`, `pnpm build`) or `pnpm verify`, which start it with telemetry off.

Add the rest when your work needs it:

- **Rust**, for the Rust spikes and later the desktop app: rustup, plus Visual Studio Build Tools with the "Desktop development with C++" workload. `rust-toolchain.toml` pins Rust 1.95.0 with rustfmt and clippy, and rustup uses it inside the repository.
- **Docker Desktop** with Linux containers, for heavy tests. Your Windows account must be in the `docker-users` group.
- **Developer Mode** (Settings → System → Advanced; "For developers" on older Windows 11 builds), so heavy tests can create symlinks. Without it, the symlink cases of the plugin-sandbox and Python escape tests (M0.11, M0.34) run only in CI.
- **Long paths**, for deep build folders such as Rust's and Gradle's: turn on "Enable long paths" on the same Settings page, and run `git config core.longpaths true` in the clone.
- **GitHub CLI** (`gh`), signed in with access to the repository, for `pnpm ci:minutes` (M0.3) and `pnpm spikes:run` (M0.8).
- **uv 0.13.1** (`winget install --id astral-sh.uv --exact --version 0.13.1`, then open a new terminal). It runs the zizmor workflow audit (M0.3; `pnpm verify:m0` fails without uv) and, from M2c, the Python packages.
- **JDK 21 and the Android SDK** command-line tools and platform-tools, for the SMS probe spike (M0.37a) and later the DraftYak SMS host app (M6b). Accept the SDK licences yourself (`sdkmanager --licenses`).

## Making a change

- Start from the backlog: `docs/roadmap/mN.md` lists each item with the paths it owns and its acceptance commands. Change only those paths.
- Branch from the milestone branch as `mN-<nn>-<slug>`, for example `m0-02-community`. Rebase onto `mN` daily and after every merge into it; resolve a `pnpm-lock.yaml` conflict by running `pnpm install` again.
- Keep a PR to about 1,500 changed lines of code or fewer. Only source and configuration files count, not tests; AGENTS.md lists everything that doesn't.
- Never commit secrets. Live-session secrets live only in the main checkout's git-ignored `.env.live`; `.env.live.example` lists their names.
- Run `pnpm verify` before you open the PR, and `pnpm adr` too if you added or changed an ADR; then open it ready for review, not as a draft. For a change to Markdown, community files or spike evidence only, `node tools/verify/verify.ts --profile docs` is enough: it runs the docs checks with no install, as CI does.
- Write commit messages and PR titles as Conventional Commits, `<type>(<scope>): <summary>` with an optional scope and one of the types `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert` or `spike`. The `pr-title` check (M0.3) enforces it for titles.
- Arguments after a script name reach the script, with two differences between shells. PowerShell's `pnpm.ps1` drops a leading `--`, which Git Bash and cmd pass through, so every repository CLI behind a root script must accept and ignore one; Biome doesn't, so give `pnpm lint` and `pnpm format` their flags without `--`. PowerShell also splits an unquoted comma into separate values, so single-quote such values, as in `pnpm spikes:run --spikes 's01,s02'`, which works in both shells.
- Changesets start with the first publishable package; until then, no PR needs one.

Item PRs are rebase-merged into the milestone branch `mN`. Only the owner merges into `main`, after reviewing the milestone branch at its gate and signing it off with `git rebase --signoff`, so `dco` may fail on item PRs until the gate.

## Security-sensitive paths

Changes to these paths get careful review, and code there needs tests in the same PR:

- in M0: `.github/` and `tools/ci-checks/` (M0.3), `tools/vendor-guard/` (M0.4), `tools/fetch-node/` (M0.5), `spikes/kit/env-live.ts` and `spikes/kit/evidence.ts` (M0.6a), the S12 privacy gate (`spikes/s12-sms/schema/` and `spikes/s12-sms/src/receive-report.ts`, M0.36; the probe's report serializer and manifest, M0.37a) and the supply-chain settings in `pnpm-workspace.yaml` (M0.1);
- from M1 on, as they arrive: `packages/{protocol,mime,extensions,runtime-python}/`, `crates/`, `security/`, the hub's security modules under `apps/hub/src/` (key manager, audit, identity, authz, policy, accounts, plugins, devicehost, tools, outbox, mcp, oauth-as, api), `apps/{mcp-apps,sms-host}/` and `tools/{release-guard,android-manifest-guard,egress-recorder,sign-sms-host}/`.

[CODEOWNERS](.github/CODEOWNERS) requests the owner's review for changes to these paths. Report a suspected vulnerability privately, as [SECURITY.md](SECURITY.md) describes, never in an issue or PR.

## Adding a channel

The guide to adding a channel plugin arrives in M1, with the plugin SDK, the plugin testkit, `create-draftyak-plugin` and the `channel-hello` example.
