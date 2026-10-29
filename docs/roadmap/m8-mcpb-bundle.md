# M8 local bridge bundle producer

`tools/mcpb` produces deterministic MCPB v0.3 archives from an explicit local
compiled bridge payload. This is an additive packaging slice on reviewed local
MCP checkpoint `94b6b607`. It changes no application, hub authority, runtime,
provider, protocol or host transport source.

The official [MCPB README](https://github.com/modelcontextprotocol/mcpb/blob/70fe3b34cd6dff1b3bba046638edc72a6467a4fb/README.md)
defines the ZIP container and root manifest. The
[manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/70fe3b34cd6dff1b3bba046638edc72a6467a4fb/MANIFEST.md)
and [v0.3 JSON Schema](https://github.com/modelcontextprotocol/mcpb/blob/70fe3b34cd6dff1b3bba046638edc72a6467a4fb/schemas/mcpb-manifest-v0.3.schema.json)
define the generated Node launch fields and sensitive user-configuration
reference. The schema is pinned as an offline test fixture and checked with the
workspace's existing validator. The producer uses only Node builtins and the
reviewed protocol's strict JSON parser/canonicalizer; it installs nothing.

## Explicit input and commands

`planMcpbBundle(input)` requires exactly `sourceRoot`, `entryPoint`, `version`,
`authorName` and `artifacts`. `sourceRoot` is an absolute native directory.
`entryPoint` is a relative `.mjs` artifact exporting the existing CLI's `main`
function. Each artifact has exactly `path`, `size` and lowercase `sha256`.
`version` is a numeric three-part release version. `authorName` is explicitly
provided human release metadata; the producer does not infer it.

Only listed `.mjs` and `.js` files are read, with at most 128 files, 8 MiB per
file and 16 MiB in total. There is no directory collector, executable installer,
source transpiler or dependency resolver. JSON/configuration files, token files,
environment files, source maps and arbitrary assets are refused. The expected
hashes and sizes must match actual local bytes. They establish consistency with
the caller's plan, not publisher authenticity or approval of the code.

A plan JSON file can use this shape, with actual reviewed artifact hashes and
sizes substituted locally:

```json
{
  "sourceRoot": "C:\\release-input\\bridge",
  "entryPoint": "main.mjs",
  "version": "0.0.1",
  "authorName": "Release owner",
  "artifacts": [
    { "path": "main.mjs", "size": 42, "sha256": "<64 lowercase hex characters>" }
  ]
}
```

```powershell
# Prepare bytes in memory and print only hashes, sizes and readiness.
node tools/mcpb/cli.mjs --plan C:\release-input\plan.json
# Write a new explicit local artifact; an existing target is always refused.
node tools/mcpb/cli.mjs --plan C:\release-input\plan.json --output C:\release-output\draftyak.mcpb
```

`readMcpbPlan` caps the JSON file at 64 KiB before reading, and rejects duplicate
members and malformed UTF-8. The programmatic API checks property descriptors
before reading values, refusing proxies, accessors, sparse/custom arrays,
non-data members and unknown fields. A token value has no accepted input field.

`plan.bytes()` returns a fresh copy. `writeMcpbBundle(plan, target)` accepts only
a genuine prepared plan, creates its output exclusively, and returns the same
summary. Neither the source's later mutation nor mutation of a returned byte
copy can alter the prepared archive. The CLI returns 2 with a fixed diagnostic
on refusal and exposes no raw filesystem/parser error or absolute source path.

## Generated contents and launch

The archive contains exactly `manifest.json`, the small fixed
`server/launch.mjs` bootstrap and the listed JavaScript payload under
`server/payload/`. It includes no Node runtime, hub, database, credentials,
static tool responses or copied application configuration. Discovery remains
native and filtered by the token's current authority.

The manifest's required sensitive `agent_token` setting has no default. Only
the literal `${user_config.agent_token}` reference appears in `DRAFTYAK_TOKEN`;
the installing host collects its value later. Launch uses `node` with
`--disable-sigusr1`, the absolute `${__dirname}` bootstrap reference and the
existing `mcp --hub http://127.0.0.1:47613/mcp` arguments. `NODE_OPTIONS` and
`NODE_PATH` are explicitly empty. The host chooses the Node executable; the
producer does not modify operating-system `PATH` or download a runtime.

Compatibility requires Node >=26.5.1. Before importing any payload, the
bootstrap also checks the version, exact protected Node flag and empty Node
options/path variables. It then explicitly invokes exported `main` with the
same stdio/process arguments. This avoids relying on `import.meta.main` after
import. The existing bridge negotiates the modern or legacy MCP era from
initialization; the native interface has no separate client/era launch flag.
The bundle does not start or unlock the hub, mint a token, grant a session,
approve a send or bypass the paired desktop/PIN boundary. Its installation text
includes the existing warning about a client with the same OS user's shell
access.

## File and archive boundaries

Input/output native paths must be absolute and canonical. Artifact names use a
restricted ASCII relative grammar; traversal, backslashes, Windows reserved
names, trailing dots/spaces, alternate data streams, short-name aliases and
case-insensitive duplicates refuse. Every case-folded directory prefix must use
one exact spelling, and no path may be both a file and an ancestor directory.
The planner checks this graph before source reads; ZIP construction independently
checks it again. Link/junction ancestors and nonregular or
hardlinked input files refuse. Reads compare path, descriptor identity, size
and timestamps before/after a bounded snapshot; hashes bind the copied bytes.
The snapshot is detached before ZIP production.

ZIP32 STORE output has fixed ordering, CRCs, 1980 timestamps and regular-file
permissions, with no compression, ZIP64, extras, comments, data descriptors or
directory entries. Output is capped at 18 MiB, including headers. Local and
central records, CRCs and entry hashes are checked independently in tests.
Exclusive output never overwrites an existing file. Failure cleanup removes
only a verified file inode created by that invocation, never a directory or
replacement. If ownership cannot be re-established, a partial output is kept
and the operation refuses. Portable Node path/identity rechecks do not provide
an OS directory-handle transaction or eliminate every hostile filesystem race.

## Readiness and verification

The machine-readable summary always says `artifactHashes: "matched"`,
`selfContained: "not-verified"`, `runtimeExecution: "not-run"` and
`clientAcceptance: "not-run"`. These values are fixed by the producer and cannot
be asserted by the input plan. The current application build may split files
or retain external imports. Preparing a real self-contained compiled bridge,
checking all required dependencies, final artifact inspection and a real
desktop installation/dual-era acceptance run remain separate gates.

`node --test tools/mcpb/test/bundle.test.mjs` passes 16 offline cases with tiny
synthetic local files. Checks cover deterministic bytes, the actual pinned
schema, protected bootstrap/argv behavior, fixed refusals, size/hash and UTF-8
checks, unsafe property hooks, JSON duplicates/limits, path/link boundaries and
exclusive output, and fault-injected cleanup through a replaced parent. Fixture payloads only report synthetic arguments; no hub,
provider or installed client is contacted. Ordinary frozen installation, source
syntax checks, Biome and guard also pass. No real bridge build, published bundle,
runtime download or upload was performed while the shared benchmark lock was
held.
