# Hub candidate staging

This tool stages already-built product assets for desktop, npm and Docker packaging. It does not build or imitate the hub, run install scripts, fetch dependencies, execute candidate code, or publish anything. Missing product assets fail the command. The repository's product prerequisites must exist before this can produce a release candidate.

Run from the repository root:

```text
node tools/bundle-hub/src/cli.ts --spec <reviewed-input.json> --out <new-directory>
```

The output's parent must exist. An existing output is refused. Use one producer per output path and keep all input directories immutable while staging. The command writes a private sibling scratch directory, verifies the staged inventory, then publishes it with a same-parent rename. Failures remove its scratch directory and leave an existing output untouched. No timestamps or absolute input paths enter metadata. On POSIX, file modes are fixed to 0644, with directories and the Node executable set to 0755 regardless of umask. Windows exposes its read/write attributes rather than POSIX group or execute bits. Filesystem timestamps are not a reproducibility contract.

For a development desktop candidate, `profile: "desktop-snapshot"` accepts the real sidecar layout: `hub.mjs`, `web/index.html`, migrations and the target's native binding. It requires that binding to match the authenticated native package exactly and still ships the complete eight-target native package. It does not accept CLI or Python payloads. `package:product` measures this profile from a pinned, built product checkout; it preserves the actual product version. The full release guard rejects this profile, including when its metadata is carried into installed resources as provenance.

## Input contract

The spec is JSON with these fields. All source paths resolve relative to the spec file. Omit optional sections entirely when they do not apply.

| Field | Shape and checks |
|---|---|
| `schemaVersion` | `1`. |
| `version` | Release version such as `0.1.0` or `0.1.0-rc.1`. |
| `target` | `{ "platform": "win", "arch": "x64" }`; platforms are `win`, `linux`, `darwin`; architectures are `x64`, `arm64`. Official Node archives are used, so Linux Node is glibc; musl images need a separately reviewed runtime path. |
| `hub` | `{ "root": "build/hub", "files": [...] }`; requires nonempty `hub.mjs` and `spa/index.html`, plus files under `plugins/` and `migrations/`. The producer supplies bundled hub code, first-party plugins, SQL migrations and the built SPA. |
| `cli` | Optional `{ "root": "build/cli", "files": [...] }`; requires `main.js` and the key-free `draftyak.mjs` launcher from `tools/packaging/templates/`. Required by Docker packaging; desktop candidates may omit it. |
| `python` | Optional `{ "root": "build/runtime-python", "files": [...] }`; requires `package.json` and `shim.mjs`. The package name must be `@draftyak/runtime-python` and its version must equal the hub's. Its complete reviewed hash list must cover Pyodide, the shim, the allowlist, pinned `ws` and all other shipped runtime files. Omit only when Python is excluded by the release decision. |
| `node` | `{ "root": "cache/node/26.12.0" }`; the version directory contains the official archive for the target, `SHASUMS256.txt` and `SHASUMS256.txt.sig`, obtainable beforehand with `fetch-node`. The bundled version comes from `tools/fetch-node/versions.json`. |
| `native` | `{ "archive": "vendor/native-package.tgz", "files": [...] }`; a local better-sqlite3-multiple-ciphers 13.0.3 npm tarball. Its sha512 must match the reviewed lockfile pin mirrored in the bundler. Paths in `files` are package-relative, without the tarball's `package/` prefix. |

Every `files` array is a reviewed inventory of records with exactly `path`, `sha256` (64 lowercase hex digits) and `bytes` (nonnegative integer). For example, a record for a one-byte file containing `a` is:

```json
{
  "path": "example.txt",
  "sha256": "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  "bytes": 1
}
```

Payload directory contents must match their inventories exactly. The native archive must include every inventoried file and all runtime JS entry points, its license, its N-API 10 build definition and all eight prebuilds from ADR 0002. Other package files can be included by inventory without changing their package-relative paths. Omitted tarball entries are never extracted. Archive parsing and official Node signature verification reuse `tools/fetch-node` directly; no spike code is imported.

Input and output ancestors must be link-free. Source files must be regular files with one link; pnpm store aliases must first be copied into an immutable, link-free payload. Traversal, case aliases, path-prefix conflicts, Windows device names, alternate data streams, empty directories, unexpected files and private-state filenames are refused. The repository's credential-shape rules also check staged bytes without printing matches. Inventory review remains necessary: hash validation and filename/token detection cannot establish that arbitrary content contains no private information.

## Output contract

```text
node or node.exe
LICENSE.node
hub/                         # original product-relative layout
cli/                         # optional; main.js and draftyak.mjs included
native/                      # package-relative layout, including prebuilds/
runtime-python/              # optional; exact runtime copy
runtime-python.inventory.json # optional canonical runtime inventory
bundle.json
inventory.json
```

`inventory.json` has `{ "schemaVersion": 1, "files": [...] }`. Its sorted records cover every staged file except `inventory.json` itself. `runtime-python.inventory.json` uses the same schema with paths relative to `runtime-python/`. For `release-guard`, append a record for `inventory.json` to its files and sort to obtain the full staged `artifacts` list; declare the runtime inventory and copy path when Python is present.

`bundle.json` records the release version and target; Node version, signer, archive hash and relative binary/license paths; `hub.entry`; optional `cli.entry` and `cli.main`; native package identity, archive integrity, main entry and eight relative binding paths; and optional Python root and canonical inventory path. It carries no execution or acceptance claim.

The product loads the native package's main `native/lib/index.js` entry and passes an **absolute** `.node` path through `nativeBinding`. Resolve the appropriate `bundle.json` binding path against the installed bundle root. Per-platform package subpath exports do not accept `nativeBinding`. The musl and glibc prebuilds both ship, as do both Windows and macOS architectures.

## Verification boundary

This is a staging foundation. It does not implement application supervision, encryption, PIN approval, migrations, CLI commands, mobile projects or installer hooks. It does not run the bundled Node, verify Temporal or jiff agreement, perform a keyed database round trip, or validate a Python sandbox. Those release checks belong to `release-guard` and platform acceptance jobs. Keeping static staging separate also permits producing an arm64 candidate on an x64 build host.

The unit suite uses synthetic Node archives, native binaries, runtime files and product payloads. It covers complete deterministic output, byte tampering, incomplete inventories, link aliases, malformed input, private data detection and failed-stage cleanup. Signature and native-integrity test seams exist only in the programmatic API; the CLI exposes no override and rejects synthetic signatures. Passing this suite is not a real product bundle smoke test.
