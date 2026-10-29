# MCPB bundle inputs

`planMcpbBundle` accepts a canonical absolute `sourceRoot`, the shared CLI
`entryPoint`, a release `version`, and an explicit `artifacts` array. Each artifact
has a portable relative `path`, nonzero `size` and lowercase SHA-256 of its bytes.
Executable modules use `.js` or `.mjs`; compiled declaration sidecars may use
`.d.ts` or `.d.mts`. A `package.json` is allowed only with the producer's exact
`{"type":"module"}` bytes followed by one newline. Other configuration files and
additional package metadata are refused. Only the shared CLI entry basename may
be the executable entry point.

The optional `emptyDirectories` array contains reviewed portable relative paths.
An omitted field means `[]`; each supplied path must name a physical, link-free,
empty directory below `sourceRoot`. The packer performs bounded checks of those
explicit locations before and after reading artifacts. It never discovers or
recursively collects payload contents. Empty directories are terminal leaves:
duplicates, case aliases, file conflicts and descendants are refused.

Files and declared empty directories share the 128-entry payload limit. Existing
per-file, aggregate-byte and archive limits apply. Directory records use trailing
slashes, zero data and CRC, and standard directory attributes; extraction must
preserve them. File sizes, digests, strict UTF-8, canonical paths and physical
source ownership are checked before producing deterministic archive bytes.

The generated launcher consumes the shared CLI export, literal argv and exit-code
contract. Packaging does not mint credentials, authorize a native operation,
approve client installation or publish a release. Runtime, installed-client and
release inspection remain separate acceptance checks.
