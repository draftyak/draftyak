# `io.github.draftyak/ai-provider` v1

> **Status: draft.** Until the M1 gate, any M1 item may change this file; afterwards only a contract PR changes it (see [the README](../README.md)).

An AI provider plugin turns the prompt the hub built into a draft from one model endpoint. The hub decides everything around the call: what goes into the prompt, where it may be sent (routing), which provider requests the broker lets through (an allowlist of request fields per provider), how the draft is checked and flagged, and whether to retry.

Generated files: [`schemas/ai-provider-v1.schema.json`](../schemas/ai-provider-v1.schema.json), one member per tool with its `input`, `output` and `error`, and [`schemas/draft-output-v1.schema.json`](../schemas/draft-output-v1.schema.json).

## Declaration and surface

As for [channel v1](channel-v1.md): MCP 2026-07-28 only, the declaration `capabilities.extensions["io.github.draftyak/ai-provider"] = {"version": 1, "schemaDigest": "<64 hex>"}` with the SHA-256 of the JCS of `schemas/ai-provider-v1.schema.json`, the hub failing closed on a missing declaration, another version or another digest, the same surface rules and codes, the same rules for values (well-formed text, whole-string patterns), and results read only from `structuredContent`.

## Tools

Every tool is required.

| Tool | Input | Output |
|---|---|---|
| `ai_describe` | `{}` | `{name, structuredOutput: "native" \| "validated"}` |
| `ai_models_list` | `{}` | `{models}`: at most 500 of `{id, name?, contextTokens?, fallbacks?}` |
| `ai_probe` | `{model?}` | `{status: "ok" \| "degraded", detail?}` |
| `ai_draft_generate` | `{model, system, prompt, contextIds}` | a draft outcome |

- `structuredOutput` is `native` when the endpoint enforces the output's JSON Schema itself, and `validated` when the plugin only checks it after the call. Neither enforces lengths, so the hub validates every draft either way.
- Model ids are the provider's own, visible ASCII up to 256 characters.

### `ai_draft_generate`

The input is the prompt as the hub built it:

- `system`: the trusted drafting instructions, with the output schema and its length limits, at most 100,000 code points;
- `prompt`: the owner's context, the `<context-…>` block of lookup results when lookups ran, the `<thread-…>` block of messages and a trusted reminder, at most 1,000,000 code points;
- `contextIds`: the job's context ids, a subset of `c1`, `c2` and `c3`.

The plugin sends `system` and `prompt` as its endpoint expects them, as instructions and one user message, and adds nothing to them. When the call carries a progress token, it sends `notifications/progress` at least every 10 s while the model works. The hub cancels the call 30 s after it starts or after the last progress notification, and in any case 10 minutes after it starts.

The result is one outcome, read from the provider's stop reason before any output is parsed. Every outcome carries `model`, the model that answered after any fallback, `fallback`, whether a fallback model ran, and `usage` as `{input, output}` tokens, `input` null when the provider didn't report it.

| `kind` | Also carries | When |
|---|---|---|
| `draft` | `output`: a `DraftOutputV1` | the model finished and its output parsed and passed `validateDraftOutput` |
| `refusal` | `category`, `explanation`, `recommendedModel`, each possibly null | the model refused; the output is never parsed |
| `truncated` | `stopReason`: `max_tokens` or `model_context_window_exceeded` | the output was cut off; it is never parsed |
| `invalid` | `problems`: 1 to 20 | the model finished but its output isn't a valid draft |
| `unexpected` | `stopReason`, possibly null | any other stop reason |

Each of `problems` is a schema path and an issue, `<path>: <words>` of ASCII letters, digits and underscores (`^[A-Za-z0-9_]+(?:[.][A-Za-z0-9_]+)*: [A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*$`, at most 200 characters), such as `output.body: at most 8000 characters` or `output: not JSON`, and never any content. The hub retries an `invalid` draft once with them, as its repair attempt. They are still plugin output: the hub writes them to no log or audit record. Anything outside this union is refused.

The hub reads a result with `checkDraftOutcome(result, contextIds)`, giving the job's own context ids: it applies `normalizeDraftOutput` to a draft's output first, so `contextRefs` never fail a draft and name only lookups that ran, and then checks the result as any other.

## `DraftOutputV1`

`{body, ownerNotes, needsOwnerInput, suspectedInstructions, contextRefs}`, and nothing else: there are no recipient, subject or attachment fields, because the hub computes reply targets, the subject, threading and the chat thread itself.

| Field | Limit |
|---|---|
| `body` | at most 8,000 code points |
| `ownerNotes` | at most 1,000 code points |
| `needsOwnerInput` | at most 5 strings of at most 300 code points each |
| `suspectedInstructions` | a boolean |
| `contextRefs` | at most 3 distinct ids among `c1`, `c2` and `c3` |

The limits are provisional. Structured outputs enforce neither lengths nor enums, so the limits are stated in the instructions and checked by `validateDraftOutput`.

`contextRefs` is informational and never fails a draft. Before validating, `normalizeDraftOutput(output, contextIds)` keeps, in the job's order, each of the job's context ids that the model's list names, ignoring case, and drops everything else: unknown ids, ids of lookups that didn't run, repeats and values that aren't strings. A missing or malformed list becomes empty. It changes no other field. A draft never triggers a lookup.

## Errors

Errors are `isError` results carrying `{code, retryAfterMs?, detail?}` with the codes of [`schemas/plugin-error-v1.schema.json`](../schemas/plugin-error-v1.schema.json), such as `AUTH_EXPIRED`, `AUTH_REVOKED`, `RATE_LIMITED` and `QUOTA_EXCEEDED` (with `retryAfterMs` when the provider gave one), `TRANSIENT`, `INVALID_INPUT` for a model the instance doesn't offer, and `UNSUPPORTED`. A refusal or a truncated draft is an outcome, not an error.

## Versioning

A breaking change gets a new identifier (`…/ai-provider-v2`) and major version, and the hub supports the current and the previous major for at least 12 months. As for channel v1, every change to the exported schema changes `schemaDigest`, so after release an edit refuses installed plugins built on the earlier revision until they are rebuilt, unless the hub also accepts that revision's digest.
