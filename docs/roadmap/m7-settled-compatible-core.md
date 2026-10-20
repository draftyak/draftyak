# Settled compatible completed-response core

This branch starts directly from `origin/m7` at
`5fbaf893a20c7f95c6b4c1cf8af1356dad170c73`. The owned donor is
`m7-11r-reviewed-compatible` commit
`23c7cad4916b9d221761f41012a225a565196703`.

The first port commit, `0d36e2c35ad922bea435f76bc85cf12488791d70`, preserved
all six source files, six test files and four package/build configurations
byte-for-byte. It added only the existing 13-line lock importer. Its 54 focused
tests passed. The donor's README and old branch handoff were excluded. The
subsequent request/repair correction is deliberately a separate commit.

Only merged `ai-provider-v1`, `draft-output`, extension, hash and JCS source is
imported; those blobs are unchanged from the merged base to the donor parent.
There is no vendor SDK, unmerged manifest, extension runtime, host, hub or content
dependency. No protocol/specification/Rust source is changed.

The donor violated [the merged prompt requirement](../../spec/extensions/ai-provider-v1.md)
by appending format/limit instructions to every supplied system prompt and
synthesizing a second provider call after invalid output. The shared contract
requires supplied prompt parts to pass through unchanged and gives the hub one
invalid-schema repair. Six new tests genuinely failed against the preserved
port: all three formats changed the system text and all three performed two
calls instead of one.

The correction sends both supplied prompt strings unchanged, including their
whitespace and Unicode representation. It removes provider-local repairProblems
rewriting from build/verifier and the internal retry/usage accumulation loop.
`generate()` now makes one transport call and returns one shared outcome. Safe
invalid-schema issues remain available for the actual hub's repair decision;
only a new hub-built prompt can produce a differently pinned repair request.
No runtime repair owner or additional transport authority is introduced.

Existing endpoint syntax and request reconstruction remain intact. The
`trustedResolution` argument is caller-supplied native configuration metadata,
not verified DNS or egress evidence. The core does no resolution and grants no
destination trust. Local presets and plaintext-LAN configuration cannot replace
the host broker's independent current policy. No new URL/egress policy is added.

Requests remain `stream: false`, with exact body/header hashes and redirect
refusal. Limits are 8,388,608 UTF-8 request bytes, 262,144 completed response bytes,
131,072 UTF-8 draft-content bytes and 500 model entries. Actual typed-array slots
are bounded before copying; shared/subclassed buffers are refused. Strict JSON,
the shared draft validator and context normalization reject malformed/tool
output. Refusal and truncation are classified before draft parsing. No vendor
call or credential access was used.

The frozen offline install passed with 253 reused packages and zero downloads.
All 60 current focused cases passed across six test files; the seventh file is
their fixture helper. Package typecheck, the twelve-file ESM/declaration build,
Biome, documentation checks and guard also passed. The one-worker checks
retained at least 8.21 GiB free with no 6 GiB stop. Full workspace verification
remains queued. Completed-buffer
validation does not bound bytes already accumulated by the injected transport.
Actual transport limits, progress/deadlines, production mounting and completion
of the full M7 milestone remain outside this slice.
