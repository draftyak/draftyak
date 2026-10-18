# Standalone bridge bundle workspace verification

Private `@draftyak/mcpb` registers the protected deterministic payload packer and
its twenty-two native Node tests with the root workspace. The test command uses
one test-file worker and a thirty-second timeout. The package has no compilation
step; it runs its checked-in MJS sources directly.

This standalone candidate starts at merged `m8` checkpoint `5fbaf893`. Its only
runtime workspace dependency is the public `@draftyak/protocol/jcs` export,
already present on that base. The schema test directly declares the existing
exact `@cfworker/json-schema` 4.1.1 pin. No CLI, hub, native service, unmerged
M1.19 contract or conformance-reader code is imported. The normal protocol build
dependency is the merged protocol package, not a later runtime stack.

The existing `tools/*` workspace glob discovers this package without root
configuration changes. Its Turbo test task includes every local source, test
and pinned-schema file and the protocol source inputs consumed at runtime, so
changes to that implementation invalidate the cached result. Dependency
installation may add only the tool's importer; no new registry resolution or
version is required.

A compiled bridge is an explicit caller-provided artifact, not a packer build
dependency. The generated bootstrap requires exported `main()` and the existing
`mcp --hub` argv. Synthetic test payloads exercise that bootstrap without a real
hub or client. The summary remains `selfContained: "not-verified"`,
`runtimeExecution: "not-run"` and `clientAcceptance: "not-run"`; producing and
inspecting a real self-contained bridge and actual desktop-client acceptance
remain separate gates. This component does not complete M8.

Fresh standalone Windows component checks pass: ordinary installation reused
253 cached packages with zero downloads, followed by normal frozen installation.
All twenty-two Node cases pass with no skips. Biome checks eight source/config/test
files; guard reports zero findings in 784 files; whitespace checks pass. The
lockfile changes only by the ten-line importer, with no registry resolution or
version changes. Turbo's dry run discovers `@draftyak/mcpb#test`, 57 inputs and
the merged `@draftyak/protocol#build` dependency.

Execution held the actual kit benchmark lock, used two CPUs and one test-file
worker, and continuously monitored the six-GiB free-memory floor. The observed
minimum stayed above nine GiB. Unchanged full Windows verification remains
queued in an independent Git clone; component checks do not substitute for it.
No real bridge build, installed client or provider acceptance is claimed.
