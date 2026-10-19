# Release artifact guard

This tool inspects staged release files without changing them, building, publishing, downloading or signing anything. With an explicit `nodeSource`, it independently authenticates official Node bytes and probes an authenticated copy in a private temporary directory. Staged candidates are never executed directly.

```text
node tools/release-guard/src/cli.ts --manifest C:/release/release.json --root C:/release/staged --repo C:/dev/draftyak --scope artifacts
node tools/release-guard/src/cli.ts --manifest C:/release/release.json --root C:/release/staged --repo C:/dev/draftyak --scope full --json
```

The root `guard:release` script forwards the same arguments. A leading `--` is accepted. No arguments prints usage and exits 2; missing or malformed inputs never count as a successful release. Exit 0 means the selected scope passed, 1 means findings, and 2 means a CLI or input-read error. `--help` exits 0 without running checks.

`artifacts` checks supplied files. It does **not** claim release readiness. The default `full` scope also requires the entire publish set and release inputs, and reports the unfinished product inspectors below as failures. Full scope cannot pass until those inspectors are implemented. No manifest switch or asserted security boolean suppresses them.

## Manifest contract

Keep the release manifest outside the staged root. Paths inside it use forward slashes and are relative to that root; npm workspace paths are relative to `--repo`. The manifest is version 1 and rejects unknown top-level fields.

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "artifacts": [
    {
      "path": "hub/hub.mjs",
      "sha256": "<64 lowercase hexadecimal characters>",
      "bytes": 123
    }
  ],
  "npm": [],
  "node": {
    "path": "node/node.exe",
    "sha256": "<64 lowercase hexadecimal characters>",
    "bytes": 123,
    "version": "26.12.0"
  },
  "nodeSource": {
    "root": "C:/dev/.draftyak-cache/node/26.12.0",
    "platform": "win",
    "arch": "x64"
  },
  "runtime": {
    "canonical": "runtime-python.inventory.json",
    "copies": ["runtime-python"]
  },
  "notices": {
    "path": "THIRD_PARTY_NOTICES",
    "sbom": "bom.cdx.json"
  }
}
```

This illustrates the fields, not a complete inventory. Replace sample digests and lengths with measured values and include **every** staged file in `artifacts`, including metadata, notices, inventories and tarballs. Records have exactly `path`, `sha256` and `bytes`, sorted by path using ASCII comparison. Sizes are nonnegative safe integers. Empty inventories, duplicate or case-colliding paths, absolute paths, traversal, Windows alternate streams, reserved device names and trailing-dot/space aliases are refused. A directory tree must contain exactly the inventoried files. Empty directories are not inventoried.

All inspected files must be regular files with one hard link. Symlinks, junctions, parent links and special files fail. Individual files and expanded tar archives are capped at 256 MiB. UNC/network shares, URI inputs, device paths and environment-file paths are rejected before filesystem lookup. The same rule applies to the manifest, repository, staging root and Node source. `nodeSource.root` is an absolute local path; no URL or download fallback is accepted.

Run against owner-controlled, quiescent directories. The guard is not an OS sandbox and does not prevent a same-user process changing paths between inspection, opening, hashing and execution. Authenticated Node bytes are copied into a fresh private directory, checked again and executed there, with no staged neighboring DLLs and a clean environment. This reduces substitution and loader exposure; it does not close the same-user TOCTOU boundary. Temporary directories and their ancestors must also be local and link-free.

`tools/bundle-hub` writes `inventory.json` with `{ "schemaVersion": 1, "files": [...] }` covering the staged tree except `inventory.json` itself. To prepare `artifacts`, use those records and add the measured record for `inventory.json`, then sort. Optional runtime copies use the same record shape. The guard checks actual files and never trusts an inventory merely because it was supplied by a build tool.

## Inspections implemented

- **npm:** Each `npm` entry is `{ "path": "draftyak-0.1.0.tgz", "workspace": "apps/cli" }`. The guard decompresses the actual archive, validates ustar headers, checks entry paths and types, and reads `package/package.json`. It compares the name and version to the allowed source workspace. Private packages, unknown names, duplicated publications, mismatched workspaces and unlisted `.tgz` files fail. Link, device, PAX and GNU-extension entries fail rather than being partially understood. Package-root and bundled-dependency `binding.gyp` and all install lifecycle hooks (`preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`) are refused. No archive is extracted or executed.
- **Versions:** Existing CLI, hub, app and runtime package versions must equal `version`. The Tauri configuration version is checked where present. Full scope requires all of them. A present Python SDK `pyproject.toml` must use a literal `[project]` name `draftyak` and version equal to `@draftyak/sdk`; full scope requires it. Dynamic metadata is unsupported. Docker image version inspection remains a full-scope failure.
- **Node:** The Node record must refer to an inventoried file and declare the repository's `tools/fetch-node/versions.json` bundled pin. A matching manifest hash alone always leaves a runtime failure. Optional `nodeSource` supplies the local cache version directory and exact `platform` (`win`, `linux`, `darwin`) and `arch` (`x64`, `arm64`). The guard verifies `SHASUMS256.txt.sig` against the repository's official Node keys using the existing `fetch-node` verifier, derives the archive checksum from those authenticated sums, checks the local archive and reads its Node binary. The staged candidate must match those authenticated bytes, its digest and its length. Only then does a byte-identical authenticated copy run with fixed `--disable-sigusr1` arguments in a private empty directory and a clean environment. The probe checks its actual version, Temporal and the retained flag, with a 10-second timeout. Cross-target runtime probes require a matching host. No externally asserted signer, verification boolean or probe-result JSON is accepted as proof.
- **Python runtime:** `runtime.canonical` contains `{ "schemaVersion": 1, "files": [...] }`, with records relative to each runtime copy. Every declared copy must match it exactly: no missing, extra, modified or linked files. The canonical inventory is a trusted release input; proving it is the list compiled into the hub, derived from the pinned runtime package and present in every final installer/image still needs product inspectors.
- **Notices:** `notices.sbom` must contain a nonempty CycloneDX component list with unique `bom-ref`, name, version and license metadata. `THIRD_PARTY_NOTICES` must contain one exact line `Component: <bom-ref>` for each component and no unmatched component markers. This checks declared coverage and detects gaps between these two files. It does not establish that the SBOM contains every bundled dependency, that license text is legally sufficient, or that MPL source/tag and byte-preservation requirements hold.

## Native schedule comparison

`src/schedule.ts` exports `inspectScheduleEquivalence({ repo, root, nativeArtifact, node, nodeSource })`. This separate, opt-in API builds a small oracle from the reviewed product sources; the manifest CLI does not run it or accept a claimed result as a waiver. `repo` must be a source directory within this worktree, such as a reviewed committed snapshot under `.cache/product`. `root` contains the staged native application and Node. `nativeArtifact` and `node` use the measured file records above; `node` also declares its exact version. `nodeSource` uses the same independently authenticated official archive cache as the ordinary Node inspector.

The stored manifest is inert `native-oracle/Cargo.toml.template`. The driver measures that filename and materializes its unchanged bytes as `Cargo.toml` only inside the generated private workspace. The repository template is not an untested executable Cargo workspace and receives no CI-policy exemption.

For example, run this JavaScript from the worktree with `node --input-type=module`, supplying the real staging paths:

```js
import { inspectScheduleEquivalence } from "./tools/release-guard/src/schedule.ts";
import { hash, read } from "./tools/release-guard/src/integrity.ts";
const root = "C:/release/staged";
const record = (path) => {
  const bytes = read(root, path);
  return { path, sha256: hash(bytes), bytes: bytes.length };
};
console.log(JSON.stringify(await inspectScheduleEquivalence({
  repo: "C:/dev/draftyak-wt/m11-01-community-docs/.cache/product",
  root,
  nativeArtifact: record("draftyak.exe"),
  node: { ...record("node.exe"), version: "26.12.0" },
  nodeSource: {
    root: "C:/dev/.draftyak-cache/node/26.12.0",
    platform: "win", arch: "x64"
  }
}), null, 2));
```

The oracle copies `apps/app/src-tauri/src/schedule.rs` unchanged and compiles its actual `validate` and `view` functions with the actual `draftyak-protocol` source. The inspected app must pin jiff `0.2.38` with `std`, `tzdb-bundle-always` and no default features. Oracle dependency names, versions, sources and checksums must match the product's Rust lockfile. The oracle's own committed lock pins `jiff-tzdb` `0.1.9`. Every time-zone query uses `TimeZoneDatabase::bundled()`. Cargo runs Rust `1.95.0`, `--locked --offline`, one job and a scrubbed compiler environment with local tool-search and cache paths. No missing dependency or toolchain is downloaded. Oracle build and probe files remain within a fresh private `tools/release-guard/.cache/schedule-*` directory, removed on success or failure; Cargo's ordinary internal hard links are copied into a single-link executable before probing.

The comparison covers New York, London and Lord Howe from 2026-01-01 through 2027-12-31: 12 transitions, 72 wall-time cases and 96 instant/deadline cases. It compares `compatible`, `earlier`, `later` and `reject` answers, gap/fold classification, rendered wall times and numeric offsets, including Lord Howe's 30-minute shifts. It also checks the native schedule validation and approval/warning result for each of the four permitted lateness windows, plus every parse-valid M1 snapshot schedule. Those M1 hash vectors include four semantically inconsistent scheduled instants, which both implementations must refuse. Snapshot parse-error vectors are excluded from this schedule-only comparison. Different answers fail; different tzdata version strings alone produce a warning.

Requests and responses are bounded to 1 MiB; there are at most 256 wall times, 256 instants and 512 schedules. Compilation has a 180-second timeout and a 1 MiB output limit, with at most 8 KiB of compiler diagnostics retained on failure. Each engine request has a 15-second timeout. Product sources and the app candidate are measured before and after the comparison. Compile-time source, protocol, oracle and lock digests must match every native response. The result records these identities, engine/tzdata versions, counts and warnings. The authenticated Node runs in the clean private directory described above, with `--disable-sigusr1`; the app candidate is never executed.

The real Windows run passed against source snapshot `821a2270a0bfe4633b13f3436d9b30ee49f996e8`, jiff `0.2.38` and official Node `26.12.0`; both engines reported tzdata `2026e`. All 12 transitions, 72 wall times, 96 instants and 400 schedule cases agreed, with no warnings. The final run measured the actual MSI's extracted `draftyak.exe` (16,153,088 bytes), whose SHA-256 remained unchanged throughout the check; its identity and the oracle/source digests are recorded in the local `.cache/windows/schedule-report.json`. The heavy test passed in 65.85 seconds. A measured native application digest alone cannot prove that its machine code contains the compared sources, features and bundled database. Verified application/source binding and installed-binary schedule behavior remain full-release acceptance gates.

That is historical handoff evidence, not a run on this candidate or validation of the adapted manifest materialization. Current-base native compilation and product acceptance remain separate gates.

The repeatable heavy test requires an already reviewed source snapshot, cached official Node and a real single-link staged native candidate:

```powershell
$env:DRAFTYAK_SCHEDULE_NATIVE_ARTIFACT = "C:/release/staged/draftyak.exe"
$env:DRAFTYAK_STRICT_SKIPS = "1"
pnpm --filter @draftyak/release-guard exec vitest run --mode heavy test/schedule.heavy.test.ts
```

`DRAFTYAK_SCHEDULE_SOURCE_REPO` can select another reviewed source directory within this worktree; the default is `.cache/product`. Missing prerequisites skip only when strict skips are disabled. The test does not download, install, sign or execute the native application.

## Exact npm publish set

Full scope requires all 20 names below, with these source paths. There are no prefix or plugin-name wildcards. An additional first-party package needs an explicit plan and allowlist update.

| npm name | Workspace |
| --- | --- |
| `draftyak` | `apps/cli` |
| `create-draftyak-plugin` | `packages/create-plugin` |
| `@draftyak/protocol` | `packages/protocol` |
| `@draftyak/sdk` | `packages/sdk` |
| `@draftyak/plugin-testkit` | `packages/plugin-testkit` |
| `@draftyak/runtime-python` | `packages/runtime-python` |
| `@draftyak/client` | `packages/client` |
| `@draftyak/extensions` | `packages/extensions` |
| `@draftyak/content` | `packages/content` |
| `@draftyak/mime` | `packages/mime` |
| `@draftyak/fakes` | `packages/fakes` |
| `@draftyak/channel-gmail` | `plugins/channel-gmail` |
| `@draftyak/channel-slack` | `plugins/channel-slack` |
| `@draftyak/channel-hello` | `plugins/channel-hello` |
| `@draftyak/channel-hello-py` | `plugins/channel-hello-py` |
| `@draftyak/ai-messages-api` | `plugins/ai-messages-api` |
| `@draftyak/ai-responses-api` | `plugins/ai-responses-api` |
| `@draftyak/ai-chat-completions` | `plugins/ai-chat-completions` |
| `@draftyak/tool-hello` | `plugins/tool-hello` |
| `@draftyak/tool-calendar-ics` | `plugins/tool-calendar-ics` |

In particular, the hub, desktop/mobile client application, MCP Apps, Python source SDK, private commercial fakes, tools and spike packages are not npm publications. `@draftyak/fakes` is explicitly public in the approved plan; `@draftyak/fake-commercial` is not.

## Full release prerequisites still missing

These checks deliberately fail in full scope. Product artifacts and real inspectors must replace them; adding a manifest value such as `mockStoreAbsent: true` is not evidence.

- Inspect native build features to rule out e2e auto-confirm, mock stores and conformance profiles, then run a negative test showing compiled refusal of `key_class=dev`.
- Inspect the built Docker image, including its Node/Temporal, launch argv, version and exact Python runtime. A host Node probe does not test a container.
- Bind the separately compiled native schedule comparison to the actual application build and verify installed-binary behavior. The comparison API above implements the bounded ADR 0015 jiff/Temporal oracle checks; a detached result does not establish this application binding.
- Inspect the real SMS host APK's merged manifest, release/debug flags, signature and in-app licenses. No signing key is read or used by this tool.
- Establish dependency completeness across bundles and locks, wheel and APK dependencies, preserved license comments, unmodified Pyodide/ical.js bytes and exact MPL source links.
- Establish that the canonical runtime inventory comes from the pinned runtime package, is compiled into the hub and covers every final installer, npm archive and image.
- Inspect built Python wheel/sdist metadata and contents. Comparing source `pyproject.toml` alone does not inspect a published distribution.

Installer/upgrade behavior, native key-store functionality, device pairing, Docker read-only smoke tests, provenance, attestations and owner publishing approval also belong to the release pipeline. This tool neither simulates those behaviors nor grants publishing permission. The Windows development snapshot supplies one real native artifact; complete headless, mobile and launch inputs remain missing.

## Validation

```text
pnpm --filter @draftyak/release-guard typecheck
pnpm --filter @draftyak/release-guard test
pnpm --filter @draftyak/release-guard test:heavy
```

Unit tests use synthetic files and tarballs and check traversal and aliases, links, mismatched inventories, private and disallowed packages, lifecycle hooks, version drift and incomplete notices. A fake Node candidate with matching self-declared hashes still fails without independent trust. Failure-order tests verify that bad sources, signatures, archives and candidates cannot reach the probe, and that missing Temporal fails after authentication. Test-only programmatic signature/probe seams are not exposed by JSON or the CLI.

The heavy test runs the production signature and probe path only when the host's official Node 26.12.0 is already cached. It defaults to the standard local fetch-node cache; `DRAFTYAK_TEST_NODE_CACHE` can specify another local version directory. It never downloads missing files and skips when the cache is absent. Passing it verifies the cached official Node, not a real product bundle, native addon or installer.
