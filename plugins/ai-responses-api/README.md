# Responses API-key drafting core

This package builds an allowlisted API-key request descriptor and validates an
already-completed response against the shared `ai-provider-v1` draft contract.
It constructs no SDK client, reads no credentials and initiates no network I/O.
It has no production mode handling, plugin mounting or stream accumulator.

`buildRequest()` preserves the supplied model and optional reasoning effort. It
uses trusted instructions and one user message, the shared strict draft schema,
`store: false` and `stream: true`. Its authorization value is only the fixed
`Bearer brokered` placeholder. `verifyRequest()` reconstructs that descriptor and
refuses different targets, extra fields, headers, tools and retained state.

`readDraft()` checks completion/refusal/truncation before parsing a draft. It
accepts one assistant message with one output-text block, refuses tool outputs,
narrows context references to the supplied job IDs and returns shared outcomes.
The parser caps output text at 262,144 UTF-8 bytes, output items at 64 and content
blocks at 16 per message. These are completed-response validation limits. They
do not bound bytes accumulated by a transport or SDK before this function runs.

`generateDraft()` invokes a trusted, injected `CompletedTransport` once and
checks cancellation before and after the call. The caller must supply a bounded
transport, deadline and actual broker authority. `repairPlan()` permits one
repair decision for an invalid completed draft; it performs no retry itself.

The pinned SDK is `openai@7.36.0`. Its local `zodTextFormat` helper is used only
to construct the schema descriptor. The [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)
describes that Responses API format and separate refusal handling; the tests
exercise the pinned SDK and merged shared schemas with synthetic data.

Run the offline package checks from the workspace root:

```powershell
pnpm --filter @draftyak/ai-responses-api test
pnpm --filter @draftyak/ai-responses-api typecheck
pnpm --filter @draftyak/ai-responses-api build
```

Actual stream transport/accumulation, full-response byte bounds, progress,
credentials, production mode handling and runtime integration remain outside
this package's completed-response proof. This is a prepared M7 foundation.
