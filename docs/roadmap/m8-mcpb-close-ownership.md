# M8 MCPB close-failure ownership

The synchronous MCPB file reader and exclusive bundle writer now share a private,
process-lifetime admission latch. Any `closeSync` exception makes ownership
uncertain. Both APIs then refuse before filesystem preflight and recheck directly
before opening a file, using the existing fixed `McpbError`. Successful bundle
bytes, public synchronous APIs, output permissions and no-overwrite behavior are
unchanged.

The reproduced defect used real synthetic files: a mocked close threw without
closing its genuine descriptor, yet another read or write still opened a file.
Repeated invocations could accumulate outstanding descriptors. A numeric close
failure can also happen after the descriptor has closed and its number has been
reused. Production therefore never retries that number, does not retain it for
cleanup and offers no latch reset. Restart the process; the operating system
cleans up descriptors still owned by the exiting process. This does not claim
that the failed close freed a resource. An already written output can remain
when its close fails, as before; it is reported as refused and is never silently
overwritten.

Six isolated-child filesystem regressions cover reader and writer failures before
the close takes effect, failures after actual close with genuine descriptor reuse
by an unrelated sentinel, and a failure published during filesystem preflight.
They verify cross-API refusal, no later opens or numeric close retries, and the
immediate pre-open recheck. Fixture cleanup owns the injected effects explicitly;
production has no such knowledge. The actual package test script includes this
new file, so workspace verification runs these checks.

Fresh Windows checks on Node 26.12.0 pass: all 22 MCPB tests (16 existing and six
new) through `pnpm --filter @draftyak/mcpb test`, with one test-file worker.
The same six regressions all fail against an exact copy of the parent reader
and writer. Ordinary `pnpm install --offline --frozen-lockfile` reuses 269 cached
packages, downloads none and leaves the lockfile unchanged. Scoped Biome passes.
The observed free memory was above 8 GiB before installation and test runs.
Source guard reports zero findings across 1,233 files. Whitespace/scope checks
pass; the parent lockfile and ZIP/planner/bootstrap sources remain unchanged.

Full Windows verification, real product bundle/client acceptance and milestone
acceptance are not established by these synthetic filesystem checks. No product
bundle build, native compiler, credential-store, PIN, live, browser or heavy
test ran. No runtime, authentication, protocol, native transport, dependency
version or credential handling changes are included.
