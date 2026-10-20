# Settled Messages completed-response core

This port starts directly from `origin/m7` at
`5fbaf893a20c7f95c6b4c1cf8af1356dad170c73`, confirmed against the remote before
creation. The donor is `m7-10r-reviewed-messages` commit
`96538c3318402c1019b4c4e316197185fedf1346`.

The port includes four source files (`index.ts`, `request.ts`, `response.ts`,
`shared.ts`), six test files and their four package/build configuration files
under [the package](../../plugins/ai-messages-api/README.md), unchanged from the
donor. Its README and prior branch handoff were excluded and replaced with narrow
current-base notes. The lockfile adds only the 19-line importer; the exact pinned
`@anthropic-ai/sdk@0.135.0` package and optional peers already exist on this base.

The imported `ai-provider-v1`, `draft-output`, JCS and extension source blobs are
unchanged between the merged base and donor parent. No unmerged manifest,
protocol, extension, SDK host or runtime dependency is needed. No protocol/spec,
Rust, hub or production mounting source changes are included.

The core constructs an allowlisted descriptor and checks an already-completed
response. The native `node:util/types` proxy check and descriptor-safe bounded
request snapshot prevent validation/reconstruction from rereading caller
getters. Endpoint/query, schema, headers and pinned model/effort are checked;
only a reconstructed accepted descriptor may reach a future transport. The
`brokered` API-key placeholder is not a credential.

Completed response conversion handles refusal and truncation before parsing a
draft. Tool-use stops are unexpected and tool-result blocks are refused, never
executed. The shared validator enforces draft fields and normalizes job context
references. Errors contain fixed codes; schema issues contain paths rather than
message text. Bounded provider refusal details remain ordinary outcome data and
must not be written to logs or audit records.

Output text is limited to 262,144 UTF-8 bytes, content to 128 blocks and usage
iterations to 32. Request snapshot bounds are depth 64, 16,384 nodes and 2,300,000
UTF-16 code units across keys/strings. These are validation bounds after data has
already been supplied. There is no raw stream transport, SDK aggregation cap,
progress, cancellation/deadline owner, credential handling or production mode
mounting. Those remain separate native/runtime work; this is not all of M7.

The default model, effort, fallback-model set and beta header are preserved from
the reviewed donor's snapshot. ADR 0011 and owner-controlled live acceptance
remain pending. No vendor call or credential access was used, and this port does
not claim current model availability or live provider acceptance.

Frozen offline install passed with 253 reused packages and zero downloads.
All 121 focused cases passed across five test files; the sixth file is their
fixture helper. Package typecheck passed. These cover stable reconstruction,
getter/proxy refusal, request mutation, content/usage limits, malformed JSON,
refusal/truncation/tool handling, context normalization, one repair decision and
seeded hostile synthetic data. The eight-file ESM/declaration build, Biome,
documentation checks and guard also passed. Monitored focused checks retained
at least 8.76 GiB free without reaching the 6 GiB stop floor.
Full workspace verification remains queued and
will be recorded separately when the shared slot is available.
