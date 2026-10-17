# ADR 0001: Workspace toolchain, pins and M0 conventions

- **Status:** proposed
- **Date:** 2026-10-17
- **Spike:** none
- **Plan:** §2 Tooling, §11, §12 work rules, §14, §17
- **Owner decision:** yes

## Context
§2 fixes the tooling (pnpm 11, Turborepo 2.11, TypeScript 7.0, Biome 2.5, Vitest 5) on Node ≥26.5.1, bundling the current 26.x. §11 asks for lean CI on 2,000 free minutes and zero telemetry (guardrail 8); §12 sets the work rules (a backlog per milestone, one PR per item of at most ~1,500 lines, the owner signs off and merges each milestone); §14 ends each milestone with `pnpm verify:mN`.

M0 runs about 40 items in parallel worktrees on a Windows 11 dev box (Node 26.12.0 from the official MSI, global pnpm 11.28.6, per-user uv 0.13.1, Docker Desktop not started at login, Developer Mode off), so the contracts between items have to be fixed before their code exists. The version census of 2026-10-17 checked every pin against npm, crates.io, PyPI, GitHub and nodejs.org, and M0.1 found how the toolchain behaves on this box (`docs/roadmap/m0.md`, Changed since the plan).

## Options
- **Package manager:** pnpm 12.14.0, npm `latest` since 2026-08-26, or pnpm 11.28.6 (`latest-11`, maintained, approved by the owner).
- **Node:** wait for v26 Active LTS on 2026-10-28, or pin 26.12.0 now (Current, with Temporal) over the 26.5.1 security-release floor.
- **Test tiers:** an environment variable per tier (shell-specific syntax, lost in turbo's strict env mode), or file names switched by Vitest's `--mode`.
- **Turbo:** root scripts calling `turbo` directly, or a launcher that always turns telemetry off.
- **Branches:** `m0/<nn>` (git can't hold `refs/heads/m0` beside `refs/heads/m0/…`) or `mN-<nn>-<slug>`.
- **Merging items into `m0`:** squash or merge commits, rebase-merge on GitHub, or a local fast-forward.
- **PR size:** count every changed line, tests included, or count only code.

## Decision
Go

Plan changes: V1–V12 (Plan deviations table); item branches `mN-<nn>-<slug>`; item PRs are rebase-merged into `m0` (`gh pr merge <n> --rebase`), and only the owner merges `m0` into `main`; §12's ~1,500-line PR guideline counts only code; test tiers switched by Vitest `--mode`; root turbo scripts run through `tools/verify/turbo.ts`.

### Toolchain
- **Node 26.12.0** is bundled and used on the dev box (`.node-version`); **26.5.1** is the minimum (`engines.node` `>=26.5.1` with `engineStrict`; plugins are refused below it). `tools/fetch-node/versions.json` (`{ "minimum": "26.5.1", "bundled": "26.12.0" }`) is the single bump point, and a bump reruns M0.13 and M0.35. Node runs `.ts` files directly, so tools need no build step.
- **pnpm 11.28.6 over 12** (`packageManager`, V8), with pnpm 11's defaults (`strictDepBuilds`, `blockExoticSubdeps`) and, in `pnpm-workspace.yaml`: `minimumReleaseAge: 1440` written out, which makes it strict (a version under 24 h fails non-interactive installs unless the owner lists it in `minimumReleaseAgeExclude`); `allowBuilds: {}`; `engineStrict: true`; `savePrefix: ''`, so versions are exact everywhere; `verifyDepsBeforeRun: error`, so scripts refuse to run before an install and `pnpm test` stays offline. `.npmrc` holds only auth and registry keys.
- **TypeScript 7.0.2:** `tsc -b` per package through `turbo run typecheck`, no root solution tsconfig. `tsconfig.base.json`: `strict`, `nodenext`, `es2025`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedDeclarations` with `declaration`, `noUncheckedIndexedAccess`, `rewriteRelativeImportExtensions` (TS 7 rejects `.ts` import paths with TS5097 without it), `types: ["node"]`, `noEmit: true` and a per-package `tsBuildInfoFile`. Emitting packages set `noEmit: false` and keep `vitest.config.ts` out of the emitting tsconfig.
- **Vitest 5.0.5:** it reads no parent folder's config, so each package has a `vitest.config.ts` returning `vitestConfig(env)` from `vitest.shared.ts`; `vite` 8.3.4 is pinned at the root as its peer.
- **turbo 2.11.8** (V10) in strict env mode, with `cacheDir` `.turbo/cache` inside each worktree.
- **Biome 2.5.15:** `preset: "recommended"`, width 100, VCS ignore, JSON indented with 2 spaces; folder-form negations for `fixtures`, `vendor`, `evidence`, `vectors`, `*.lock.json` and `spikes/sched-clock/grit-check`, which keeps its own root `biome.json` and is linted from its own folder (Biome 2.5.15 rejects a nested root config given with `--config-path`).
- **Rust 1.95.0** with rustfmt and clippy (`rust-toolchain.toml`, V9); **uv 0.13.1**; **zizmor 1.31.1**.
- `.gitattributes`: `* text=auto eol=lf`; `*.eml`, `**/vectors/**`, `security/**` and `spikes/**/fixtures/**` `-text`; `*.bat` and `*.cmd` `eol=crlf`; binary types. `.gitignore` adds `.env*` with `!.env*.example`, and `*.tsbuildinfo`, to the backlog's list.

### Telemetry and the dev box
- Zero telemetry (guardrail 8): `tools/verify` sets `DO_NOT_TRACK=1` and `TURBO_TELEMETRY_DISABLED=1` for every run, every workflow sets both, and turbo passes `DO_NOT_TRACK` to every task (`globalPassThroughEnv`).
- The root `typecheck`, `test` and `build` scripts start turbo through `tools/verify/turbo.ts`, which always sets both variables; turbo is run only through the root scripts, `pnpm verify` or that launcher.
- Turborepo's own telemetry setting was on for the owner's account on the dev box and was turned off user-wide on 2026-10-17. Each new machine turns it off once with `node tools/verify/turbo.ts telemetry disable`: the launcher sets both variables before turbo starts, so the call itself sends nothing.
- On 2026-10-17 the owner had `C:/dev/draftyak`, `C:/dev/draftyak-wt` and `C:/dev/.draftyak-cache` restricted to their own account, Administrators and SYSTEM (inheritance removed), because `C:/dev` inherits `Authenticated Users: Modify` from `C:/` and the PC has two other local accounts (the Codex CLI's sandbox accounts).

### Branches, merging and PR size
- The integration branch is `m0`; item branches are `mN-<nn>-<slug>`, each in a worktree `C:/dev/draftyak-wt/<branch>` outside OneDrive; `spikes-run/<branch>-<UTC stamp>` branches live for one CI run.
- One PR per item into `m0`, opened ready after local `pnpm verify` passes. Open item branches rebase onto `m0` locally, daily and after every merge, and push only when the PR needs it; a `pnpm-lock.yaml` conflict is resolved by rerunning `pnpm install`.
- **Merge rule, confirmed by the owner on 2026-10-17:** item PRs are rebase-merged into `m0` (`gh pr merge <n> --rebase`); only the owner merges `m0` into `main`, after `git rebase --signoff` at the gate. The first merge (PR #2, `a493396`) showed that GitHub's rebase-merge adds no `Signed-off-by` (it sets the committer to the owner's noreply address), so merges stay on GitHub. The repo allows rebase merges only and deletes merged branches (`docs/roadmap/m0-appendix/github-settings.json`).
- Commits: author `Nick Savov <nicksavov@protonmail.com>`; conventional messages and PR titles (standard types plus `spike`); no `Signed-off-by`, which the owner adds at the gate (so `dco` is red until then); no attribution trailers and no statements about how work was produced.
- **PR size, decided by the owner on 2026-10-17 ("Count code, not tests"):** at most ~1,500 changed lines per PR (§12), counting only code: source and configuration files. Not counted, but still reported: tests and fixtures (`*.test.*`, and anything under `test/`, `tests/`, `__tests__/` or `fixtures/`, where test helpers live), prose docs (`*.md`, `LICENSE`, `NOTICE`), lockfiles, generated wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`), vendored upstream files (`vendor/`), generated vectors (`vectors/`) and evidence JSON (`spikes/<id>/evidence/`). Excluding prose docs, the `docs/roadmap/` backlogs among them, is the build's reading of "code, not tests" and awaits the owner's confirmation at the gate. `pnpm pr-size` prints the counted and raw totals and each uncounted category; S is ≤400, M 400–900, L 900–1,500 counted code lines. PR #2 (M0.1) counts 791 lines this way, against 1,754 with its tests and the 694-line backlog.

### Spikes, test tiers and evidence
- One private package per spike, `spikes/<id>-<slug>` named `@draftyak/spike-<id>-<slug>` (the kit is `spikes/kit`, `@draftyak/spike-kit`). No package outside `spikes/` depends on a spike, and `apps/`, `packages/` and `plugins/` never import one. Each spike owns its `ci.json`; each Rust spike is its own Cargo workspace.
- **Tiers** by file name, switched by Vitest's `--mode`: `*.test.ts` in the default mode, `test` (`pnpm test`, every CI run, offline); `*.heavy.test.ts` with `--mode heavy` (`verify:m0`, CI `full`, `spikes-run`); `*.live.test.ts` with `--mode live` (owner sessions); `*.device.test.ts` with `--mode device` (S12 sessions). `tierFromMode` throws on any other mode. Package scripts pass their own flags (`vitest run --mode heavy`, the kit's `node ../kit/run.ts --heavy`), so PowerShell and Git Bash behave alike; with `DRAFTYAK_STRICT_SKIPS=1` (`verify:m0`, `spikes-run`) a heavy test that can't run fails instead of skipping; `requires:` tags route cases a host can't run.
- **Evidence:** content-free JSON in `spikes/<id>/evidence/`, written by `kit.writeEvidence()`: measurements as numbers, ISO timestamps, environment fingerprints, status codes, field and header names. Header values are kept only for `*ratelimit*`, `retry-after` and `content-type`; vendor ids only as per-session HMACs whose key is never stored; URLs as host plus document hash. `spikes-run` uploads evidence only, never an installable build, as 7-day artifacts, and the spike's ADR PR commits it.
- **Secrets** live only in the main checkout's git-ignored `.env.live`, never in a worktree, and only the kit's `loadEnvLive()`, `saveEnvLive()` and `deleteEnvLive()` touch it. `.env.live.example` lists names only: `DY_LIVE_FUNNEL_BASE_URL` (M0.20); `DY_LIVE_SLACK_APP_TOKEN`, `DY_LIVE_SLACK_USER_TOKEN` (M0.25); `DY_LIVE_SIWC_ACCESS_TOKEN`, `DY_LIVE_SIWC_REFRESH_TOKEN`, `DY_LIVE_RESPONSES_API_KEY` (M0.26, M0.27); `DY_LIVE_GMAIL_CLIENT_ID`, `DY_LIVE_GMAIL_CLIENT_SECRET`, `DY_LIVE_GMAIL_REFRESH_TOKEN` (M0.29); `DY_LIVE_MESSAGES_API_KEY` (M0.31). After each live session the vendor tokens are revoked, the entries deleted and `revoked: yes` recorded.
- **ADRs:** `docs/adr/NNNN-<slug>.md` from `docs/adr/template.md`, numbered by the backlog's ADR table and never renumbered. `pnpm adr` checks the header (`Status` proposed, accepted or superseded with its successor named; `Date`; `Spike`; `Plan`; `Owner decision` yes or no), the sections Context, Options, Decision, Fallback, Evidence and Kept test in that order, the Decision's first line (`Go`, `Go with fallback`, `No-go` or `Not run`), and each kept test's path (a file, or a folder below the top level, with forward slashes and its exact case, not git-ignored), command, guard and destination (a milestone and a repo-relative path). HTML comments and fenced code don't count as fields. `pnpm adr --index` writes `docs/adr/README.md` at the gate; `pnpm adr --report` prints the gate's spike table. Kept tests run in `pnpm test`, `verify:m0` and CI until their destination milestone absorbs them; that PR deletes the spike.

### Root scripts and tool contracts
- `package.json` declares every M0 root script once: `lint` (`biome ci .`), `format`, `typecheck`, `test` and `build` (through `tools/verify/turbo.ts`), `verify` and `verify:m0` (`node tools/verify/verify.ts [--profile m0]`), `fetch-node` (`node tools/fetch-node/fetch-node.mjs`), and `guard` (`@draftyak/vendor-guard`), `adr` (`@draftyak/adr-check`), `pr-size`, `ci:minutes`, `spikes:run` (`@draftyak/ci-checks`) and `m0:prefetch` (`@draftyak/verify`, `node prefetch.ts`) as `pnpm --filter <package> --fail-if-no-match run <name>`, each backed by a script of the same name in that package. Every CLI behind a root script that forwards arguments accepts a leading `--`: Git Bash and cmd pass it through, `pnpm.ps1` drops it.
- **`tools/verify` modules:** `steps/<name>.ts` exports `step: Step` = `{ name, order, profiles, run(ctx) }` with `name` equal to the file name, and `run` returns passed, failed (reason) or skipped (reason); `profiles/<name>.ts` exports `profile: Profile` = `{ name, description, select(steps) }`. Orders: lint 10, typecheck 20, test 30, build 40, the m0 profile's `test:heavy` 45, adr 50. Step and profile files, and `prefetch.ts` (loaded by the m0 profile), import only `node:` built-ins and relative files, because verify loads them all before `pnpm install`; unit tests enforce it. Steps run tools through `ctx` (`run`, `capture`, `node`, `pnpm`, `turbo`, `biome`), and an `options.env` merges over the parent environment. `tools/verify/turbo.json` (added by M0.6b) keeps the package's `test` task uncached, because the workspace-policy test reads files outside the package that turbo doesn't hash.
- **Profiles:** `default` (`pnpm verify`: lint, typecheck, test, build and later default steps); `cheap` (CI: no build, plus adr); `docs` (CI's docs-only job: `node tools/verify/verify.ts --profile docs` with setup-node and no pnpm, running vendor-guard and adr; `verifyDepsBeforeRun: error` makes `pnpm verify` refuse before an install); `m0` (`pnpm verify:m0`, below).
- **Windows spawning:** never `shell: true`. pnpm runs as `process.execPath` plus `npm_execpath`, Vitest as `process.execPath` plus `vitest/vitest.mjs`, turbo and Biome as the native executables from their platform packages; a unit test refuses `.cmd`, `.bat` and `.ps1` targets.
- **`pnpm verify:m0`:** a prerequisite check first (Docker through `ensure()` from `spikes/kit/docker.ts`, uv, gpgv, the Playwright browsers of packages that use `@playwright/test`, and whether the Node binaries and pinned images are cached) that always prints its table and the expected duration (3 min, plus 3 per spike and 1 per tool with heavy tests, plus downloads) and skips every later step when something is missing; Docker queries give up after 20 s. Then the `default` steps and any step tagged `m0`; `turbo run test:heavy --filter=./spikes/* --filter=./tools/* --concurrency=1` with `DRAFTYAK_STRICT_SKIPS=1`, one suite at a time so the kit's lock and idle check hold; and `pnpm adr`.
- **`pnpm m0:prefetch`** (idempotent): both Nodes from `versions.json` for the host and Linux through `fetch-node`; every image reference written as `name[:tag]@sha256:<64 hex>` in tracked files under `tools/` and `spikes/` (outside `evidence/`, `vendor/` and `fixtures/`), so only real pinned images may be written that way there; then each `spikes/<id>/prefetch.ts`, run with `node` from its spike folder.

### Version pins (census 2026-10-17)
Exact versions everywhere. Every new pin must be over 24 h old, or the owner adds it to `minimumReleaseAgeExclude`. Docker images are pinned by digest at first use. Versions outside the census are marked; they were checked on 2026-10-17.
- **Toolchain:** Node 26.12.0 (bundled and dev) and 26.5.1 (minimum); pnpm 11.28.6; typescript 7.0.2; @types/node 26.6.5; turbo 2.11.8 (V10); @biomejs/biome 2.5.15; vitest 5.0.5; Rust 1.95.0 with rustfmt and clippy (V9); uv 0.13.1; zizmor 1.31.1 (outside the census).
- **npm, by item:** better-sqlite3-multiple-ciphers 13.0.3 (M0.9, M0.10, M0.22; V11); kysely 0.29.6 (M0.10); zod 4.6.7 (M0.12, M0.14–M0.16, M0.30); @modelcontextprotocol/server and /client 2.3.1, with core 2.3.1 exact through both (M0.12, M0.14–M0.17); @modelcontextprotocol/conformance 0.2.0-alpha.12 (M0.14; V3); @modelcontextprotocol/ext-apps 2.0.3, vite 8.3.4, vite-plugin-singlefile 2.3.3 (outside the census; its `rollup` peer warning is accepted) and @playwright/test 1.64.1 (M0.16); hono 4.13.13 and @hono/node-server 2.1.5 (M0.14, M0.18, M0.19); oidc-provider 9.12.2 (M0.18–M0.20); @tauri-apps/cli 2.12.3, /api 2.12.4, /plugin-autostart 2.7.0 (M0.22–M0.23b, M0.32); ws 8.22.0 (M0.24, M0.33); openai 7.36.0, installable from 2026-10-18 00:39Z (M0.26); nodemailer 10.1.2 (M0.28; V1); @anthropic-ai/sdk 0.135.0 (M0.30); pyodide 314.0.7 (M0.33–M0.35); @peculiar/x509 2.2.0 (M0.36); fast-check 4.10.2 (M0.15, M0.40).
- **Rust crates** (each Rust spike is its own workspace; no crate in two majors per lockfile): tokio 1.53.3, tokio-rustls 0.26.6, rustls 0.23.46 with `ring` 0.17.14, aws-lc-rs 1.18.2 for trial builds only (M0.21, M0.23b, M0.32); keyring 4.2.0, keyring-core 1.0.1 and the stores windows-native 1.1.0, zbus-secret-service 1.0.1, apple-native 1.0.2 (`keychain` on macOS, `protected` on iOS) and android-native 1.0.0 (M0.21, M0.23b, M0.32); tauri 2.12.4, tauri-build 2.7.3, tauri-plugin-autostart 2.7.0 (M0.22–M0.23b, M0.32); hyper 1.12.0, hyper-util 0.1.21, tokio-tungstenite 0.30.0, p256 0.14.0, ecdsa 0.17.0, hmac 0.13.0 and sha2 0.11.1 (one RustCrypto generation that moves together), rcgen 0.14.10, serde_json_canonicalizer 0.4.1 (0.4.0 yanked; rejects duplicate keys) (M0.32); jiff 0.2.38 with `tzdb-bundle-always` and jiff-tzdb 0.1.9 (M0.32, M0.40); for power and resume APIs, the `windows`, `objc2` and `zbus` versions tauri and keyring already resolve (M0.23b).
- **Android:** Kotlin 2.4.21, AGP 9.4.1, Gradle 9.8.1 (`bin.zip`, `distributionSha256Sum` `dce76f55f8e251a3a1f130eb120f30b3d271de2b76c9b0729d316b5a1b6dc01f`), JDK 21, `minSdk 34`, `targetSdk`/`compileSdk 37`.
- **Pyodide 314.0.7 lock:** CPython 3.14.2, ABI `pyemscripten_2026_0`; S11 candidates pydantic-core 2.41.5 (pydantic 2.12.5), orjson 3.11.8, regex 2026.3.32, pyyaml 6.0.3, rpds-py 0.30.0, msgspec 0.20.0, lxml 6.1.3, cryptography 47.0.0, numpy 2.4.6; httpx 0.28.1.
- **Images:** `debian:bookworm-slim`, `node:26.5.1-alpine` and `node:26.12.0-alpine` (Node publishes no musl binary), `rust:1.95.0-bookworm`, Caddy 2.
- **GitHub Actions in M0** (full SHAs; `pnpm/action-setup`'s floating `v6` lags, and `dtolnay/rust-toolchain` has no release tags, so `master` is pinned and `toolchain: 1.95.0` is always passed):

  | Action | Tag | SHA | Used by |
  |---|---|---|---|
  | actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | all |
  | actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` | ci, spikes |
  | pnpm/action-setup | v6.1.0 | `ea17c68df8912ef543352723c149a84f56e3d413` | ci, spikes |
  | actions/cache | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | ci, spikes |
  | zizmorcore/zizmor-action | v0.7.1 | `85b2b9fb8e3325e7a23d7d0a9d7ba5ae0f999e3e` | zizmor |
  | dtolnay/rust-toolchain | master | `683b588c487a69d01f6c6ddf40f036ff682cc2c8` | ci, spikes |
  | Swatinem/rust-cache | v2.9.2 | `6323deb102c322ba6fcbdcafc7e3dddab59af2b6` | ci, spikes |
  | actions/setup-java | v6.1.0 | `b843ebf9b913146b38da2eaa7aeddf76074ae1ad` | spikes (S12) |
  | android-actions/setup-android | v4.0.4 | `be39fa834029ff78f1a44aa3bb0819b8fc2bd8fd` | spikes (S10, S12) |
  | actions/upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | spikes (evidence only) |

- **GitHub Actions for later milestones** (census SHAs, each re-verified against its tag; `setup-uv` gets `version: 0.13.1`; CodeQL uses one SHA for `/init`, `/analyze` and `/upload-sarif`):

  | Action | Tag | SHA | For |
  |---|---|---|---|
  | astral-sh/setup-uv | v10.3.0 | `1c37ad07a6a961277cf70c0d37d6f313000f5884` | `python` job (M2c) |
  | github/codeql-action | v4.39.0 | `6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee` | CodeQL |
  | actions/dependency-review-action | v5.0.0 | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` | dependency review |
  | ossf/scorecard-action | v2.5.0 | `fa7117db83c52d787ae5a89f350999701505d78e` | Scorecard (public) |
  | amannn/action-semantic-pull-request | v6.1.1 | `48f256284bd46cdaab1048c3721360e808335d50` | PR-title linting |
  | pypa/gh-action-pypi-publish | v1.14.2 | `dc37677b2e1c63e2034f94d8a5b11f265b73ba33` | PyPI publishing |
  | changesets/action | v2.1.2 | `ae32849d5ba541f9ae29e40e22a623bc13562f51` | Changesets |
  | actions/attest-build-provenance | v4.2.2 | `4d101475d8b20a2381f78447822ac1eab6504dd8` | attestations |
  | docker/setup-buildx-action | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` | `docker.yml` |
  | docker/build-push-action | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` | `docker.yml` |
  | docker/login-action | v4.6.0 | `dbcb813823bdd20940b903addbd779551569679f` | release |
  | docker/setup-qemu-action | v4.4.0 | `99012661954931238ded8c8b007157a8430204e1` | arm64 images once public |
  | docker/metadata-action | v6.2.0 | `dc802804100637a589fabce1cb79ff13a1411302` | release |

### Plan deviations (confirmed in m0-gate.md §3, re-checked in §5)
| # | Deviation | Affects |
|---|---|---|
| V1 | nodemailer 7 → 10.1.2. 7.x ended at 7.0.13, inside 15 GitHub advisories (e.g. GHSA-268h-hp4c-crq3, CR/LF injection in List-* headers; GHSA-2x7j-588g-ccc2 and GHSA-v53p-9fqp-m79j, address-parser DoS). 10.1.2 has none and still exports `nodemailer/lib/mail-composer`; since 7 it renamed `NoAuth` to `ENOAUTH`, verifies TLS by default and ships an ESM+CJS build for Node ≥20. | M0.28, M5 |
| V2 | postal-mime 2 → 4.0.7. 2.x stopped at 2.7.6; 3.0 keeps folding whitespace, makes duplicate single-value headers first-wins and returns address lists in document order; 4.0 is a TypeScript rewrite. Parser fixtures follow 3.x+ semantics. | M3 |
| V3 | MCP conformance is the exact prerelease 0.2.0-alpha.12; npm `latest` (0.1.16) predates 2026-07-28 and has no `--spec-version`. | M0.14, M8 |
| V4 | TS 7's root export is only `./lib/version.cjs`: `openapi-typescript` 7.13.0 (M3 `@draftyak/client`) needs a package-local `typescript` alias to 5.9.3; TypeDoc 0.28.20 (M11) uses `@typescript/typescript6` 6.0.2, as planned. | M3, M11 |
| V5 | WebdriverIO stays on 9.32.0 (with `@wdio/cli` 9.32.0): `@wdio/tauri-service` 1.5.0 requires `webdriverio` ^9. | M4 |
| V6 | Python bundles use Pyodide's pydantic 2.12.5 and pydantic-core 2.41.5, not PyPI's 2.14.1 and 2.50.1; the SDK's optional extra admits `>=2.12.5,<3`. | M2c |
| V7 | Node 26 isn't LTS yet: 26.12.0 is "Current", and v26 becomes Active LTS on 2026-10-28 (§2 calls it LTS). The 26.5.1 floor is confirmed (a security release). | gate |
| V8 | pnpm 12 (12.14.0) is npm `latest`; 11.28.6 stays, as the owner approved, with pnpm 11's defaults (release age, `strictDepBuilds`, `blockExoticSubdeps`, `allowBuilds`). | all |
| V9 | Rust stays on 1.95.0 while stable is 1.99.1 (2026-10-16); every pinned crate needs at most 1.90. A bump is the owner's call. | Rust |
| V10 | turbo 2.11.8, not the census's 2.11.9, which was under 24 h old and fails strict installs until 2026-10-17 19:07Z; bump once it matures. | M0.1 |
| V11 | better-sqlite3-multiple-ciphers 13.0.3 ships all 8 N-API prebuilds in the npm package and has no install script, so M0.9 copies them instead of fetching release assets, and `allowBuilds` stays empty. | M0.9, M2a, M10 |
| V12 | Later constraints: the React Compiler on Vite 8 goes through `@vitejs/plugin-react` 6.1.2, `@rolldown/plugin-babel` 0.2.4 and `@babel/core` 7.29.7 (not Babel 8); Base UI is `@base-ui/react` 1.9.0; Starlight 0.42.6 needs `astro` 7.4.0; `tauri-plugin-single-instance` is Rust-only (2.5.4). | M3, M4, M11 |

### For the owner at the gate
V1–V12; excluding prose docs from the PR-size count; the M0.1 choices above that the plan doesn't name (the turbo launcher, `noEmit: true` with per-package build info, Biome's `preset` and folder-form negations, the root `vite` pin, the `.gitignore` additions, the grit-check exclusion, the worktree-local turbo cache, tiers by `--mode`); M0.6b's `tools/verify/turbo.json` and its backlog edits (the Size convention, identical to M0.3's, and size L for M0.6a and M0.6b), both outside its listed paths; and the dev-box change to Turborepo's telemetry setting.

## Fallback
- **pnpm:** if pnpm 11 stops getting fixes or a tool needs 12, the owner decides the switch; `packageManager` and `pnpm/action-setup` move together and pnpm 12's changed defaults are rechecked. No M0 dependency needs 12.
- **Node:** a regression in 26.12.0 moves `.node-version` and `versions.json` together (and `engines` if the floor moves), then M0.13 and M0.35 rerun. If the LTS date slips, 26.12.0 stays "Current".
- **turbo:** 2.11.9 or later once it is older than 24 h (V10). If turbo ever needs another telemetry switch, `tools/verify/lib/tools.ts` sets it for every run.
- **Merging:** if a rebase-merge ever adds a `Signed-off-by`, merges switch to a local fast-forward: rebase onto `m0`, then `git push origin HEAD:<branch> HEAD:m0`, which marks the PR merged (one CI run each).
- **PR size:** if the owner doesn't confirm excluding prose docs at the gate, they count again; `pnpm pr-size` follows that and any later change to what is counted.

## Evidence
- `docs/roadmap/m0.md`: Changed since the plan, Version pins and Conventions, verified on 2026-10-17 against the version census of that day (npm, crates.io, PyPI, GitHub, nodejs.org), which is kept outside the repo.
- `docs/roadmap/m0-appendix/github-settings.json`: rebase merges only, delete-on-merge, web sign-off.
- M0.1 (PR #2, `a493396`): `pnpm verify` → `verify: 4/4 steps passed` on the dev box; its rebase-merge carries no `Signed-off-by`.
- `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `vitest.shared.ts` and `pnpm-lock.yaml` as committed.
- `tools/verify/test/turbo-env.heavy.test.ts`: a probe task run through turbo receives `DRAFTYAK_STRICT_SKIPS` and `DO_NOT_TRACK` and nothing undeclared.

## Kept test
- **Path:** `tools/verify/test/workspace-policy.test.ts`
- **Command:** `pnpm --filter @draftyak/verify test`
- **Guards:** `.node-version`, `engines`, `packageManager` and `versions.json` agree and are exact; the pnpm settings above: the package folders, the release-age, build and trust settings exactly as listed (`minimumReleaseAge: 1440`, `minimumReleaseAgeExclude: []`, `allowBuilds: {}` and nothing else of that kind), `engineStrict`, `savePrefix`, `verifyDepsBeforeRun`, and an `.npmrc` holding only registry and auth keys; exact dependency versions, npm aliases included; the `.gitattributes` rules and LF in the index; `.env.live` ignored and absent from every linked worktree at any depth, `.env.live.example` names only; `"private": true` in every package.json outside fixtures, vectors, vendored code and templates; spike package names; nothing outside `spikes/` depends on a spike by name, alias or path, and `apps/`, `packages/` and `plugins/` import none.
- **Destination:** stays at `tools/verify/test/workspace-policy.test.ts` from M0 on. In M10, `release-guard` takes over the publishing rules, and that PR turns the `"private": true` case into an allowlist of §11's launch packages.
- **Path:** `tools/verify/test/turbo-env.heavy.test.ts`
- **Command:** `pnpm --filter @draftyak/verify test:heavy`
- **Guards:** turbo's strict env mode passes `DRAFTYAK_*` and `DO_NOT_TRACK` to `test:heavy` tasks and nothing undeclared. It runs only in `pnpm verify:m0` (and the later `verify:mN`), not in `pnpm test` or CI, whose `full` job runs heavy tests only for the spikes a PR touches.
- **Destination:** stays at `tools/verify/test/turbo-env.heavy.test.ts` from M0 on.
