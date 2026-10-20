# Native tool provenance, version 1

The production entry point is
`captureNativeToolProvenance(repositoryRoot, probe)`. It accepts a trusted version
capture callback, not caller-selected tool paths, hashes, versions or host flags.
The callback receives a normalized absolute native invocation path and frozen arguments:
`["--version", "--verbose"]` for Cargo/Rust, `["--version"]` for cargo-deny.
It returns `{code,stdout,stderr}` with stdout/stderr as byte views. The caller
must use a bounded, cancellable native subprocess capture with controlled cwd
and environment. No shell, provider, credentials or network step is requested.

The live opaque result has a portable digest and frozen public facts only:
name, version, host, executable SHA-256, native format and identity boundary.
Private module-owned state retains file paths and filesystem identities. Copies,
serialized data and synthetic file observations cannot substitute for that state.
`nativeToolPath(provenance,name)` rechecks the selected file before returning its
absolute invocation path. Its realpath target remains privately bound. `assertNativeToolsUnchanged(provenance)` must
also run after subprocess workloads, before acceptance or evidence publication.

## Fixed policy and resolution

Supported hosts are x86_64 Windows/MSVC and x86_64 Linux/GNU. Other architectures,
macOS and unknown platforms refuse. Native PE32+ and ELF64 headers must agree with
the platform and x86_64 machine type; PE DLLs, non-executable images, wrong-width,
wrong-endian, malformed and script headers refuse. Windows paths must end in
`.exe`. `.cmd`, `.bat`, `.ps1` and `.sh` paths refuse even if their contents look
native. Linux files must have an executable mode bit. A native header identifies
a file format, not the authenticity of arbitrary code.

The existing `DRAFTYAK_CARGO_DENY` environment convention is retained: when
nonempty it selects cargo-deny, resolving a relative value from the repository
root, with no fallback on failure. Otherwise each tool is found by its native
filename on inherited PATH. Empty PATH entries are skipped; relative entries,
conflicting `PATH`/`Path`, over256 entries and a preceding shell shim refuse.
Resolution never asks a shell or PATHEXT to select a wrapper. Environment input
only chooses a candidate; it cannot change the fixed executable-hash policy.

| cargo-deny version | Host artifact | Executable SHA-256 |
| --- | --- | --- |
| `0.20.2` | Windows x86_64 MSVC | `f7292fab58c706638c999e64c4ba82e5128ae628130ba55e3266a768ee431fbf` |
| `0.20.2` | Linux x86_64 musl release executable | `b329e25933d01c36dd7c47d84ea5716694f9b7caf53a5003d45674703a8ed54a` |

These are **executable** hashes, not archive hashes. The Linux executable digest
was derived from the exact executable member of the official
[`0.20.2` x86_64 musl archive](https://github.com/EmbarkStudios/cargo-deny/releases/download/0.20.2/cargo-deny-0.20.2-x86_64-unknown-linux-musl.tar.gz),
after its archive bytes matched
`9f12ed4c49936e09b48bf862b595cde2fe64fcbd9d74dfacac6131ca824c8d5f`.
That archive pin and exact member path are already in `.github/workflows/ci.yml`
at base `00c76695b0301d3d7526e7d1d173fc270df53c79`. Extraction used only executable
bytes for hashing; the artifact was not installed or executed. No reviewed
macOS artifact-to-executable provenance is present, so macOS is unsupported.

All three native files are observed before any version subprocess. In particular
cargo-deny's fixed hash must match before even its version command can execute.
Version output must be successful, ASCII, at most8192 bytes and have empty stderr.
cargo-deny reports exactly `cargo-deny 0.20.2`. Cargo/Rust must report exact stable
`1.95.0`, matching verbose release/host, consistent commit hash prefix/date and no
duplicate fields. Output text is parsed internally and never copied into public
facts or errors. Errors have only fixed `TOOL_PROVENANCE_REFUSED` diagnostics.

## Filesystem and process boundary

Executable reads are capped at64MiB, checked before opening, with64KiB read buffers
and at most1MiB retained for header inspection. An opened regular file must retain
device/inode, size, timestamps and mode across the read. Hashing covers every byte,
including bytes beyond the header. Canonical path and filesystem identity are
rechecked after reading, before/after each version probe and after all probes.
Native symlinks/junctions are allowed only while their resolved target remains
unchanged. Direct execution preserves the captured absolute invocation path;
resolving a native rustup proxy to a differently named target before spawning
would change its basename dispatch. Replacing the
requested link, executable, or ordinary same-byte inode refuses on recheck.

These pre/post observations do not make path-based spawning atomic. The caller
must ensure exclusive/trusted control of executables, links, loader inputs and
the host runtime between observation and child completion. A coordinated ABA
change, malicious kernel/filesystem or counterfeit observations is outside this
claim. Open file descriptors are closed on both success and refusal. There is no
download, installation or execution code in this module apart from invoking the
supplied fixed-argument version capture callback.

Cargo/Rust hashes are observations, **not authenticated Rust distribution pins**.
The reviewed toolchain file/workflow select1.95.0, but provide no approved Cargo/
rustc executable digests. A native rustup dispatcher may be what PATH resolves;
its hash and version/host result do not authenticate delegated toolchain binaries,
dynamic libraries, environment-dependent behavior or all files subsequently
executed. The explicit `trusted-host-toolchain` boundary requires the caller's
controlled environment/cwd and a trustworthy installed toolchain. Only cargo-deny
has `official-release-executable` provenance here. Neither boundary attests build
output, Cargo inputs, registry data, graph scope or current policy authority.

The portable digest is SHA-256 of UTF-8
`draftyak/native-dependency-policy/tools/v1\0` followed by compact UTF-8 JSON of:

```text
["tools",1,[[name,version,hostOrNull,exeSha256,format,identityBoundary],...]]
```

Names occur in fixed order `cargo`, `rustc`, `cargo-deny`; `\0` is a NUL byte.
Local paths, raw version text and filesystem identities never enter this digest.
`toolProvenanceTestInterface` contains pure checks and synthetic file observations;
it cannot mint production provenance and must not be used by the acceptance CLI.
Synthetic tests execute no Cargo/Rust/cargo-deny binary and do not establish a
runtime or cross-platform installation result.
