# Working in this repository

This is the short reference for anyone changing DraftYak, by hand or with automated tools: where things are, which commands to run and the rules every change follows. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, licensing and sign-off.

DraftYak is a local-first, open, human-approved AI inbox: AI drafts replies, and nothing is sent without the owner's explicit approval. The repository is in milestone M0, bootstrap and spikes. Its backlog, [docs/roadmap/m0.md](docs/roadmap/m0.md), lists every item with its outputs, owned paths and acceptance commands. Below, a "From" column or a bracketed item such as (M0.3) names the backlog item or milestone that adds a path, command or check; until it lands, that part doesn't exist yet.

## Repository map

| Path | Contents | From |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml`, `turbo.json` | Every root script, pnpm settings, Turbo tasks | M0.1 |
| `tsconfig.base.json`, `biome.json`, `vitest.shared.ts` | TypeScript base config, Biome config, the shared Vitest config with the test tiers | M0.1 |
| `.node-version`, `rust-toolchain.toml` | Node 26.12.0; Rust 1.95.0 with rustfmt and clippy | M0.1 |
| `.env.live.example` | The names of the live-session secrets, without values | M0.1 |
| `tools/verify/` | `pnpm verify`: one file per step in `steps/` and per profile in `profiles/`; `turbo.ts` starts Turbo for the root scripts | M0.1 |
| `docs/roadmap/` | Milestone backlogs (`m0.md`) and their appendices | M0.1 |
| `docs/adr/` | Architecture decision records, `NNNN-<slug>.md` from `template.md`; the backlog fixes each number, and numbers never change | M0.6b |
| `.github/workflows/` | `ci`, `dco`, `pr-title` and `zizmor` (M0.3); `spikes` for cross-OS spike runs (M0.8) | M0.3 |
| `tools/ci-checks/` | CI checks that also run locally: changed areas, DCO, PR title and body, PR size, CI minutes, workflow policy | M0.3 |
| `tools/vendor-guard/` | `pnpm guard`: vendor, secret, attribution and evidence rules | M0.4 |
| `tools/fetch-node/` | `pnpm fetch-node`: official Node binaries, verified against Node's signed checksums | M0.5 |
| `tools/adr-check/` | `pnpm adr`: ADR lint, index and report | M0.6b |
| `spikes/kit/` | The shared spike harness: test tiers, Node binaries, Docker, ports, live secrets, evidence, the machine lock | M0.6a |
| `spikes/<spike>/` | One private package per spike (`s01-sqlite3mc` to `s12-sms`, `sched-clock`) with its tests, `ci.json` and `evidence/` | M0.9–M0.40 |
| `apps/`, `packages/`, `plugins/`, `crates/`, `spec/` | Product code, Rust crates and specifications | M1 on |

## Commands

Run them from the repository root, in PowerShell or Git Bash. In Windows PowerShell, `npm` and `pnpm` run as `.ps1` scripts, which its default execution policy blocks; CONTRIBUTING.md's Windows setup gives the one-time fix.

| Command | What it does | From |
|---|---|---|
| `pnpm install` (`pnpm i`) | Installs dependencies. Run it again after pulling or rebasing: pnpm refuses every root script while the install is missing or stale. | M0.1 |
| `pnpm verify` | The local checks before a PR: lint, typecheck, unit tests, build and the steps later items add to its default profile. `pnpm verify --list` shows each profile's steps; `--profile cheap` runs what CI's cheap job runs. | M0.1 |
| `node tools/verify/verify.ts --profile docs` | The docs-only checks, with no install; CI's docs-only runs use it (M0.3) | M0.1 |
| `pnpm verify:m0` | The M0 gate check: prerequisites, `verify`, every spike's heavy tests with strict skips, `pnpm adr` | M0.6b |
| `pnpm lint`, `pnpm format` | Biome: check without writing; apply formatting and safe fixes | M0.1 |
| `pnpm typecheck`, `pnpm test`, `pnpm build` | Run that Turbo task in every package | M0.1 |
| `pnpm fetch-node` | Downloads an official Node binary and verifies it before use | M0.5 |
| `pnpm guard` | Runs vendor-guard over the tracked files; `--commits <range>` checks commit messages | M0.4 |
| `pnpm adr` | Lints the ADRs; `--index` writes `docs/adr/README.md`, `--report` prints the gate's spike table | M0.6b |
| `pnpm pr-size` | Counted and raw changed lines of the current branch | M0.3 |
| `pnpm ci:minutes` | CI minutes billed this month | M0.3 |
| `pnpm spikes:run` | Runs spikes on GitHub-hosted runners and downloads their evidence | M0.8 |
| `pnpm m0:prefetch` | Downloads what `verify:m0` needs: both Nodes, the pinned images, each spike's files | M0.6b |
| `uv sync`, `uv run ruff check`, `uv run pyright`, `uv run pytest` | The Python workspace: install, lint, type-check, test | M2c |

`pnpm fetch-node` takes `--version`, `--platform` (`win`, `linux` or `darwin`), `--arch` (`x64` or `arm64`), `--offline`, `--print-path` and `--docker-smoke`. `pnpm spikes:run` takes `--spikes 's01,s02'` (quoted, see below), `--os macos-15` and `--node` (`both`, `minimum` or `bundled`).

### Test tiers

Vitest picks the tier from `--mode`, through `vitestConfig()` in `vitest.shared.ts`. Each package's `vitest.config.ts` returns it directly or, for spikes, through the spike kit's Vitest factory (`spikes/kit/vitest.ts`, M0.6a), which adds the `requires:` tags.

| Files | Script | Runs in | Needs |
|---|---|---|---|
| `*.test.ts` | `test` | `pnpm test`, every CI run | only the install; offline |
| `*.heavy.test.ts` | `test:heavy` | `pnpm --filter <package> test:heavy`, `verify:m0`, CI's `full` job, spike runs | Node binaries, Docker, browsers, Rust or long runs |
| `*.live.test.ts` | `test:live` | owner sessions only | `.env.live` in the main checkout |
| `*.device.test.ts` | `test:device` | S12 sessions only | ADB and the owner's phone |

With `DRAFTYAK_STRICT_SKIPS=1`, which `verify:m0` and spike runs set, a heavy test that can't run fails instead of skipping (M0.6a).

### Turbo, telemetry and arguments

- Run Turbo only through the root scripts (`pnpm typecheck`, `pnpm test`, `pnpm build`), which use the launcher `tools/verify/turbo.ts`, or `pnpm verify`. Both start it with `DO_NOT_TRACK=1` and `TURBO_TELEMETRY_DISABLED=1`.
- Once per machine, also turn Turbo's telemetry off for good with `node tools/verify/turbo.ts telemetry disable`; it prints `Success!` once the setting is saved. Never use `pnpm exec turbo telemetry disable` for this: where telemetry is still on, that call reports itself before it turns telemetry off.
- Arguments after a script name reach the script, as in `pnpm verify --profile cheap`, with two differences between shells:
  - Git Bash and cmd pass a leading `--` through, but PowerShell's `pnpm.ps1` drops it. Every repository CLI behind a root script must therefore accept and ignore a leading `--`, as `tools/verify/verify.ts` and `turbo.ts` do. Biome doesn't: from Git Bash it reads a flag after `--` as a file path. Give `pnpm lint` and `pnpm format` their flags without `--`.
  - PowerShell splits an unquoted comma into separate values, so `--spikes s01,s02` arrives as `s01 s02`. Single-quote any value with a comma, `$`, `@` or braces, as in `--spikes 's01,s02'`; that works in both shells.

## Work rules

- No attribution trailers or statements about how work was produced.
- Tools never add `Signed-off-by`.
- Security-critical modules need tests in the same PR.

No attribution means no statements about how work was produced, anywhere: commits, PR titles and descriptions, code, comments or documents. The checks go by trailer syntax, whoever is named: every `Co-authored-by` trailer, and every line that starts with "Generated with", fails the `pr-title` check (M0.3) in a PR description and `pnpm guard` (M0.4) in a tracked file or, with `--commits`, a commit message. To credit a human co-author, name them in prose in the PR description.

- **Merging.** Only the owner merges into `main`; item PRs are integrated into `mN` by rebase-merge (`gh pr merge <n> --rebase`). At each milestone gate the owner signs off `mN` with `git rebase --signoff` and merges it into `main`, so `dco` fails on item PRs until then, as expected.
- **Branches.** Each milestone has an integration branch `mN` off `main`; M0's is `m0`. Each backlog item gets a branch `mN-<nn>-<slug>`, such as `m0-02-community`, never `m0/<item>`, which git can't hold beside `m0`. Item branches live in worktrees under `C:/dev/draftyak-wt/<branch>`, outside synced folders.
- **Daily rebases.** Rebase open item branches onto `mN` daily and after every merge into it. The rebase stays local; push only when the PR needs an update or before it merges. Resolve a `pnpm-lock.yaml` conflict by running `pnpm install` again.
- **PRs.** One PR per backlog item into `mN`, with a Conventional Commit title, opened ready for review (not as a draft) only after `pnpm verify` passes locally, and `pnpm adr` too when it adds or changes an ADR, so its first CI run is the real one.
- **PR size.** Count code, not tests: at most about 1,500 changed lines of source and configuration files. Sizes use the same count: S up to 400, M 400–900, L 900–1,500. Tests and fixtures (`*.test.*`, `test/`, `tests/`, `__tests__/`, `fixtures/`, test helpers), prose docs (`*.md`, `LICENSE`, `NOTICE`), lockfiles, generated Gradle wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`), vendored upstream files, generated vectors and evidence JSON don't count, but `pnpm pr-size` (M0.3) still reports them in its raw total. Not counting prose docs is for the owner to confirm at the M0 gate.
- **Owned paths.** Each backlog item lists the paths it owns; change only those. Shared lists are avoided by design: `package.json` declares every M0 root script once, `tools/verify` takes one file per step and per profile, each spike owns its `ci.json`, and each Rust spike is its own Cargo workspace.
- **Secrets.** Only in the main checkout's git-ignored `.env.live` (`C:/dev/draftyak/.env.live`), never in a worktree, commit, log or evidence file; `.env.live.example` lists the names. Only the spike kit's `loadEnvLive()`, `saveEnvLive()` and `deleteEnvLive()` (M0.6a) touch it, and they never print, log or snapshot a value. After each live session, revoke the tokens and grants at the vendor and delete their `DY_LIVE_*` entries.
- **Spikes.** Each spike is a private package that nothing in `apps/`, `packages/` or `plugins/` imports. Its evidence is content-free JSON written by the kit's `writeEvidence()`: measurements as numbers, ISO timestamps, environment fingerprints, status codes, field and header names.
- **Spawning on Windows.** Never `shell: true`. Spawn a native executable, or `process.execPath` with a script; `.cmd` and `.ps1` shims need a shell, and `tools/verify` refuses them.

### S12: the owner's phone

Other people's texts, numbers and names never leave the phone, so they never reach a terminal, log, test, fixture, evidence file or ADR.

- Probe reports leave the phone only through `receive-report` (`spikes/s12-sms/src/receive-report.ts`, M0.36), which validates each report in memory before writing anything.
- Never run `adb shell content`, `adb bugreport`, `adb backup`, or `adb pull` of app data.
- Run `adb logcat` only as `adb logcat -s DYProbe`.
- Use adb only for what S12 needs (M0.36–M0.39); any other adb command needs the owner's OK first:
  - `adb devices`, `adb pair`, `adb connect`, `adb disconnect`, `adb reverse` and `adb reboot`;
  - `adb install` of the locally built probe, `adb uninstall com.draftyak.smsprobe`, and `adb shell pm grant` or `adb shell pm list packages` for `com.draftyak.smsprobe`;
  - `adb shell am` for the probe only: `start` or `start-foreground-service` with `-n com.draftyak.smsprobe/…`, and `force-stop` or `kill` of `com.draftyak.smsprobe`;
  - `adb shell dumpsys deviceidle …` and `adb shell dumpsys battery unplug` or `reset`, for the Doze tests;
  - `adb exec-out run-as com.draftyak.smsprobe cat files/report.json`, run only by `receive-report --from-adb`.
- That rules out, among others: `adb pull` of any file; screenshots, screen recordings and UI dumps (`screencap`, `screenrecord`, `uiautomator dump`); every other `dumpsys` service (`dumpsys notification` shows senders and message previews); `cat` or `run-as` outside `receive-report`; `input`, `service call` and intents to other apps. Never send a text, or start a send, from adb: only the probe's send probe sends, to the owner-entered second number.
