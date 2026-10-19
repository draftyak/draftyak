# Portable packaging contracts

This private source package preserves the portable npm assembler, release
manifest producer, protected launcher, content-free loopback healthcheck and
service templates from the completed local packaging handoff. It is one part
of M10.3, with the build-inventory and release-guard packages as explicit
workspace dependencies. Those sibling packages are included in the combined tooling candidate. The
[M10 backlog](../../docs/roadmap/m10.md) defines its scope and acceptance gates.

`pnpm --filter @draftyak/packaging package:npm --bundle <stage> --out <directory>`
requires an existing inventoried candidate. It checks required payloads, copies
the protected launcher and creates deterministic ustar/gzip bytes with an
exclusive output publication. It does not build a product, execute a native
addon, authenticate a caller-supplied inventory or publish anything.

`pnpm --filter @draftyak/packaging release:manifest --config <json> --root <stage>
--out <new-json> --repo <workspace>` measures actual files, validates references
and refuses overwrite. The output is an inspection input, not release approval,
signing evidence or authenticated provenance.

Unit tests retain archive and manifest refusal cases and run the actual launcher
against a synthetic JavaScript payload. The heavy npm test installs only its
local synthetic archive with `--offline --ignore-scripts`, isolated npm config
and cache, then checks exact launcher arguments and the signal-disabling flag.
It executes neither a product hub nor the inert native payload fixtures.

The Docker shell launcher and healthcheck are supplied independently of a Docker
image or compose driver. The healthcheck opens only a loopback TCP connection
and sends no bytes; it establishes liveness, not authentication or application
health. No Docker execution or container acceptance is included.

The systemd and launchd files are uninstalled templates. Verify paths, dedicated
user, permissions, key-file integration and actual shutdown before installing.
Render launchd placeholders with XML escaping. No secret value belongs in a
service file. Native installers, mobile builds, distribution orchestration,
global policy/doc-link checks and full release acceptance remain separate.

The [portable component appendix](../../docs/roadmap/m10-portable-packaging.md)
retains the original source boundary; the [combined candidate appendix](../../docs/roadmap/m10-portable-build-tools.md)
and M10 backlog describe the actual composed scope.
