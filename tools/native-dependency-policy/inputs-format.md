# Native input binding, version 1

`captureNativeInputs(repositoryRoot, cargoHome)` creates an opaque live capture.
Its frozen public surface contains only `inputDigest` and `lockDigest`. A private
module-owned table holds filesystem identities and the repository mapping;
serialized data, object copies and proxies cannot stand in for a live capture.
Both arguments must be existing, absolute local directories. The caller resolves Cargo home;
this module does not discover or read account settings or credentials.

`bindNativeCargoPaths(capture, metadata)` first rechecks the capture, then returns
the fixed workspace mapping required by `projectCargoGraph`. It admits one
binding attempt; concurrent attempts and reuse after failure refuse.
`assertNativeInputsUnchanged(capture)` requires that binding and rechecks the
inputs after metadata, projection and audit. Every refusal uses
`NativeInputsError`, a fixed message and one of `INPUTS_INVALID`,
`INPUTS_CHANGED`, or `CONFIGURATION_UNSUPPORTED`; filesystem messages and local
paths are not copied into diagnostics.

## Supported layout and sources

The workspace root is `crates`. These are the only four local packages:

| Manifest | Package |
| --- | --- |
| `crates/draftyak-protocol/Cargo.toml` | `draftyak-protocol` |
| `crates/draftyak-desktop-pairing/Cargo.toml` | `draftyak-desktop-pairing` |
| `crates/draftyak-transport/Cargo.toml` | `draftyak-transport` |
| `apps/app/src-tauri/Cargo.toml` | `draftyak-desktop` |

The app is contained in the repository, not beneath `crates`. All four metadata
workspace members must identify these exact packages once. A workspace target
must be a real regular `.rs` file within its own member directory, present in
the initial inventory. The mapping retains each target name, kind set and checked
repository-relative path. Metadata for Git dependencies, alternate registries,
unknown local packages, outside path dependencies and registry overrides refuses.
The only accepted registry source is
`registry+https://github.com/rust-lang/crates.io-index`.

Every filesystem component is checked with directory enumeration, `lstat` and
`realpath`. Links, junctions, short aliases, noncanonical case, case-fold
ambiguity, devices, and files with multiple hard links refuse. Relative public
paths use slash-separated ASCII `[A-Za-z0-9._-]` components with no `.` or `..`
component. UNC paths are unsupported. These restrictions intentionally refuse
unsupported layouts rather than infer their equivalence.

## Raw bytes, configuration and inventory

Raw SHA-256 hashes cover `crates/Cargo.toml`, `crates/Cargo.lock`,
`crates/deny.toml`, `rust-toolchain.toml` and the four member manifests. Each file
is limited to 8 MiB and their total to 16 MiB. Reads use a bounded 64 KiB buffer;
an opened handle must retain the checked device/inode, size and timestamps before
and after reading. The initial size is checked before opening. This does not
parse or rewrite TOML or the lockfile.

Both `.cargo/config` and `.cargo/config.toml` are checked at the repository root
and every in-repository ancestor of a member. Absence is explicit. One zero-byte
file is supported; two filenames or any nonempty content (including comments or
whitespace) refuse. Configuration in the supplied Cargo home or above the
repository refuses by presence **without opening its contents**. Configuration
symlinks/junctions and ambiguous case also refuse. Pre/post comparison detects
added or removed configurations and replacement of captured files/directories.
No source replacement, Cargo aliases, patch overrides, credential provider or
other nonempty Cargo configuration is interpreted or silently accepted.

Member directories are recursively enumerated for `.rs` names and filesystem
identities only. Source bytes are never opened. The walk is limited to 24 levels
and 20,000 entries across all members. `target`, `node_modules`, `.cache`, `.git`
and `.cargo` directories are excluded from recursion after checking for links;
metadata targets inside them therefore refuse. Other extensions are not valid
target mappings. There is no claim to hash Rust implementation contents or
identify every possible non-Rust compiler input.

The portable digest payload is the UTF-8 encoding of compact `JSON.stringify`
of the following tuple:

```text
["inputs", 1, [[rawOrConfigRelativePath, sha256OrNull], ...],
 [rustRelativePath, ...], true]
```

Both arrays are sorted by unsigned UTF-8 bytes (`Buffer.compare`), independently
of discovery order and locale. `null` denotes an absent in-repository config;
the final `true` binds absence of the unsupported external configurations.
`inputDigest` is SHA-256 of the UTF-8 domain
`draftyak/native-dependency-policy/inputs/v1\0` followed by those bytes. The
terminal `\0` means a single NUL byte. `lockDigest` is SHA-256 of the unmodified
raw `crates/Cargo.lock` bytes. Absolute paths, inodes and timestamps are retained
privately for change detection and never enter the portable digest.

## Required composition and limits

The production caller must use trusted resolved tools, a controlled Cargo
environment/current directory and fixed locked arguments. It must compose a
pre-capture, fresh metadata subprocess, strict parsing into **one immutable
data value**, path binding, complete graph projection, strict audit, post-capture,
and the final current-authority/time check. This module does not authenticate
metadata, Cargo's executable, environment variables, command-line overrides,
registry-cache contents, toolchain executables, release facts or authority data.
It does not replace the graph projector's complete schema/edge checks. Its
mapping and digests alone cannot activate exceptions or establish acceptance.

Pre/post checks are not an atomic attestation of bytes Cargo actually read.
They require exclusive or otherwise trusted control of these inputs throughout
the operation; a coordinated change and restoration between observations (ABA)
or a concurrent hostile writer cannot be ruled out. Identity/stat comparisons
catch ordinary same-byte replacement, not an adversary able to counterfeit or
restore all observations. Async metadata consumers must retain the same immutable
strict-parsed value; swapping or mutating it between binding and projection
violates the composition contract. Source content, build output and runtime
behavior remain separate evidence. Synthetic temp-root tests establish the
stated checks only, not an operational graph or advisory permission.
