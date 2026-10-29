# Messages drafting core

This package builds a fixed Messages API request descriptor, verifies an outgoing
descriptor and converts an already-completed response into the merged
`ai-provider-v1` outcome. It constructs no SDK client, reads no credentials and
starts no network request. There is no stream accumulator, transport, production
plugin mounting or runtime integration here.

`buildRequest()` uses the shared strict draft schema, trusted system text and one
user message. Model, effort, token ceiling and fallback behavior retain the
existing reviewed source's pinned snapshot. The default model and fallback list
remain subject to ADR 0011 and owner-controlled live acceptance; this offline core
does not establish current model availability or provider acceptance.

`verifyRequest()` snapshots bounded plain input data before validation, then
reconstructs the accepted request. It checks the fixed endpoint/query shape,
header allowlist, model/effort pin, exact output schema and permitted body fields.
The API-key field is only the fixed `brokered` placeholder. No tools, injected
metadata or alternate destinations are accepted.

`readDraft()` distinguishes refusal, truncation and unexpected stops before
parsing draft content. Tool-use stops remain unexpected, and tool-result blocks
are refused; no provider tool is executed. Draft output is normalized and checked
with the shared parser and job context IDs. `repairPlan()` permits one invalid
draft repair decision and performs no retry itself.

Completed output text is capped at 262,144 UTF-8 bytes, content at 128 blocks and
usage iterations at 32. Request snapshots have a depth limit of 64, a 16,384-node
budget and 2,300,000 UTF-16 code units across strings and keys. These do not bound
a response accumulated by an SDK or transport before the core receives it.

The pinned `@anthropic-ai/sdk@0.135.0` helper constructs the JSON Schema
descriptor; Zod remains pinned at 4.6.7. Synthetic tests exercise the request,
shared contract, malformed output, tool refusal and bounded data boundary.

```powershell
pnpm --filter @draftyak/ai-messages-api test
pnpm --filter @draftyak/ai-messages-api typecheck
pnpm --filter @draftyak/ai-messages-api build
```

Actual streaming byte/event limits, progress, cancellation/deadlines, broker
authority and production transport remain separate work. This is a prepared
completed-response core, not completion of M7.
