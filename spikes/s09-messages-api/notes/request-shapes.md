# S9a: Messages API request shapes through `ctx.fetch`

What `@anthropic-ai/sdk` 0.135.0 sends and receives when a plugin drafts with it, read from the SDK's own TypeScript sources (the `src/` folder of the installed package) and from the public documentation on 2026-10-17. The offline tests pin every shape below. M0.31 checks them against the live API, and ADR 0011 records the decision.

## The request a draft sends

`createClient(stub)` builds `new Anthropic({ apiKey: "brokered", fetch: ctxFetchStub, ... })`, with these options set as well, because the constructor would otherwise read them from the environment:

| Option | Without it |
|---|---|
| `baseURL: "https://api.anthropic.com"` | `ANTHROPIC_BASE_URL` moves every request |
| `authToken: null` | `ANTHROPIC_AUTH_TOKEN` adds `Authorization: Bearer …` next to the placeholder key |
| `webhookKey: null` | `ANTHROPIC_WEBHOOK_SIGNING_KEY` is read |
| `openTelemetry: false` | spans are on by default (no-op until the host registers a tracer provider), and propagation adds `traceparent`, `tracestate` and `baggage` |
| `logLevel: "off"` | `ANTHROPIC_LOG=debug` logs request options, prompt included, to the console (stdout is a plugin's MCP channel) |
| `defaultHeaders` with the six platform headers set to `null` | every request carries `x-stainless-lang`, `-package-version`, `-os`, `-arch`, `-runtime` and `-runtime-version` |

With `apiKey` set, the SDK never resolves profiles or credential files and never adds the OAuth beta. `ANTHROPIC_CUSTOM_HEADERS` is merged into the default headers and no client option turns it off; a plugin's scrubbed environment (§4) and the verifier's header allowlist cover it. The unit tier's setup file clears every `ANTHROPIC_*` variable, so a developer's own settings can't change the tests.

`draft()` calls `client.beta.messages.parse(params, { headers: { "anthropic-beta": … } })`, which sends `POST https://api.anthropic.com/v1/messages?beta=true` with:

- **Headers:** `accept: application/json`, `content-type: application/json`, `user-agent: Anthropic/JS 0.135.0`, `anthropic-version: 2023-06-01`, `x-api-key: brokered`, `x-stainless-retry-count` (0, then 1 and 2 on retries), `x-stainless-timeout: 600`, and `anthropic-beta: server-side-fallback-2026-07-01` only when the body has `fallbacks`. `messages.stream()` adds `x-stainless-helper-method: stream`.
- **Body:** `model` (default `claude-opus-5-5`), `system`, `messages`, `max_tokens: 16000`, `output_config: { effort: "medium", format: { type: "json_schema", schema } }`, and `fallbacks: "default"` for the models with server-side fallback.

## Findings

1. **Fallbacks are beta-only in the SDK.** `fallbacks` and `betas` exist only on `client.beta.messages`; the GA `MessageCreateParams` has neither. The GA `client.messages.parse` sends no `anthropic-beta` header at all.
2. **`client.beta.messages.parse` adds a beta.** It always appends `structured-outputs-2025-12-15` to `anthropic-beta` (`resources/beta/messages/messages.ts`, `parse()`); `create()` adds nothing beyond `betas`. The structured-outputs page says `output_config.format` is GA and needs no beta header; it names `structured-outputs-2025-11-13` only for the deprecated `output_format`, and doesn't mention `-2025-12-15`. The verifier refuses unknown betas, so `draftCall()` sets the header per request: request-option headers override the SDK's value, and `null` removes it.
3. **`messages.parse` parses whatever the stop reason.** In both namespaces it runs `output_config.format.parse` on every text block (`lib/parser.ts`, `lib/beta-parser.ts`). A `max_tokens` cut-off throws `AnthropicError: Failed to parse structured output` before the caller can read `stop_reason`; a refusal before any output gives `parsed_output: null`. `draftFormat.parse` therefore returns the text as it is, and `readDraft()` checks `stop_reason` before it calls the parser. Only `end_turn` reaches it; `refusal`, `max_tokens`, `model_context_window_exceeded`, `tool_use`, `pause_turn`, `stop_sequence` and `compaction` don't.
4. **The schema the API sees is looser than the zod schema.** The SDK's transform (`lib/transform-json-schema.ts`, over zod 4.6.7's `toJSONSchema(…, { reused: "ref" })`) keeps `type`, `properties`, `required`, `items`, `$defs` and `$ref`, `anyOf` and `allOf`, string formats from a fixed list and `minItems` 0 or 1, and forces `additionalProperties: false`. It moves everything else into `description` as text: `maxLength`, `maxItems`, `enum`, `const` and the root `$schema`. The API then constrains neither lengths nor enums, so zod checks both after parsing (plan §5: limits are validated client-side). Array items come out as `$ref`s to `$defs/__schemaN`.
5. **`contextRefs` is read leniently.** Since nothing holds the model to the enum (and the structured-outputs page says enum casing isn't guaranteed, so values should be compared case-insensitively), the parser drops ids outside the job's set, repeated ids and non-strings, compares case-insensitively, and keeps the rest of the draft (plan §5: unknown ids are dropped). `draft()` takes the job's ids as `contextIds`, default `c1`–`c3`.
6. **Fallback-served text.** A non-streaming response drops a declined model's partial output, so the answer is the text after the `fallback` blocks. A stream keeps the partial text, and the fallback model continues it, so the answer is the text on both sides of each `fallback` block, joined. `readDraft()` joins the text of every model's part (at most one text block per part) and parses the result, so both shapes read the same way; the fake serves each shape.
7. **Non-streaming has a ceiling.** The SDK throws "Streaming is required" above `max_tokens` 21,333 (an expected time over 10 minutes, `calculateNonstreamingTimeout`); 16,000 runs with a 600 s timeout.
8. **Retries.** Two by default, on 408, 409, 429, 5xx and connection errors, honouring `retry-after-ms`, `retry-after` and `x-should-retry`. Anything a custom `fetch` throws counts as a connection error and is retried, so the stub answers a refusal with a 403 and `x-should-retry: false` instead: one attempt, and a `PermissionDeniedError` whose `type` is `broker_refused`. Retries are built and verified again (`x-stainless-retry-count` changes).
9. **Redirects.** Node's `fetch` follows redirects by default, and on a cross-origin hop it drops `authorization` but keeps `x-api-key`; a 307 or 308 also re-sends the body. The stub fetches with `redirect: "manual"` and turns any 3xx into the broker refusal, recording the status and header names (§4 broker step 7: follow no redirects).
10. **Duplicate keys.** `JSON.parse` keeps a key's last value; a parser that keeps the first would see another request. The stub forwards `JSON.stringify` of the body it verified, never the raw bytes.
11. **Refusal problems stay content-free.** A problem names a field, header or beta only when the name is in the API's own vocabulary (SDK 0.135.0's request types, the headers the SDK can send and the fallback and structured-outputs betas); anything else shows as `(unknown)`, so a plugin can't carry message-derived values into the broker's denial audit through key names or beta values.
12. **No code generation.** Neither the SDK nor zod (with `jitless`) needs `eval` or `new Function`: a draft runs under `--disallow-code-generation-from-strings`.
13. **Dependencies.** The SDK brings `@opentelemetry/api` 1.9.1, `json-schema-to-ts` 3.1.1 (with `@babel/runtime` 7.29.10 and `ts-algebra` 2.0.0) and `standardwebhooks` 1.1.1 (with `@stablelib/base64` 1.0.1 and `fast-sha256` 1.3.0); zod is an optional peer. With `@opentelemetry/api` in the lockfile, pnpm also resolves vitest 5.0.5's optional peer of that name, which changes the root `vitest` entry's key in `pnpm-lock.yaml`.

## Refusals and fallbacks (documentation, 2026-10-17)

- A refusal is HTTP 200 with `stop_reason: "refusal"` and `stop_details: { type: "refusal", category, explanation, recommended_model, fallback_credit_token, fallback_has_prefill_claim }`. `category` is `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms` or `null`, and `explanation` can be `null`. Branch on `stop_reason`, never on `content`; `stop_details` is `null` for every other stop reason.
- A refusal before any output is billed for `bio`, `frontier_llm` and `reasoning_extraction`, and not for the other categories or `null`; a mid-stream refusal bills the input and the output already streamed.
- Server-side fallback exists for Claude Fable 5.1, Claude Fable 5, Claude Opus 5.5, Claude Opus 5 and Claude Sonnet 5.5. Claude Haiku 5.5 has none: `fallbacks: "default"` is a no-op there and a list is a 400. The verifier refuses `fallbacks` for any model outside that list.
- `server-side-fallback-2026-07-01` accepts `"default"` and lists of up to three models; `-2026-06-01` accepts lists only. The verifier allows `"default"` alone, so Anthropic's per-category routing picks the model and the plugin can't name a pricier one.
- A fallback-served turn names the serving model in `model`, marks each hop with a `fallback` content block (none on sticky turns) and has a `fallback_message` entry in `usage.iterations`. Finding 6 covers where the answer's text sits.
- `reasoning_extraction` usually comes from asking the model to put its reasoning in the output, for example a `reasoning`, `thinking` or `trace` field in JSON output, and has no recommended fallback model. DraftOutput's fields must not ask for the model's reasoning.

## Choices for ADR 0011

- **`client.beta.messages.parse` (what `draft()` uses).** A typed format object with a `parse` function. Costs: the per-request `anthropic-beta` pin that removes `structured-outputs-2025-12-15`, and a `format.parse` that must not parse (finding 3); both need re-checking on every SDK bump, and the tests fail closed if either changes.
- **`client.beta.messages.create` with `betas: [FALLBACK_BETA]`.** The same request body and headers (a test compares them) with `output_config.format` as a plain `{ type, schema }`: no added beta, nothing parsed before `readDraft()`, and `fallbacks` stays typed. Cost: no `parsed_output`, which `readDraft()` doesn't use anyway.
- **GA `client.messages.parse`.** Its typed params have neither `betas` nor `fallbacks`, so the fallback beta goes in a request-option header and `fallbacks` is an untyped extra field; it parses before `stop_reason` like the beta `parse`.

## For M0.31 (live)

- `const stub = await liveStub(); const client = createClient(stub);`, then `draft(client, input)` or `client.beta.messages.parse(…)` with `draftCall()`'s headers. The key comes only from `.env.live` through the kit and is added on the way out; `stub.requests[]` holds the SDK's request with the placeholder, its verdict, and the response's header names plus the values of `content-type`, `retry-after` and `*ratelimit*` headers (never `request-id` or organization ids). `liveStub()` pins the instance to `claude-opus-5-5` at effort `medium`; pass `liveStub({ model, effort })` for anything else.
- Unset `ANTHROPIC_CUSTOM_HEADERS` (and the other `ANTHROPIC_*` variables) in the live shell: the verifier refuses headers it adds, so every call would be refused.
- Confirm live: the pinned request, without `structured-outputs-2025-12-15`, is accepted on `?beta=true`; `fallbacks: "default"` with only the `-2026-07-01` beta; `effort: "medium"`; a tiny `max_tokens` gives `stop_reason: "max_tokens"`, which `readDraft()` reports as `truncated`; whether ordinary turns carry `stop_details: null` and `usage.iterations: null`.
- Refusal probe: the documentation names a trigger, a schema field asking for the model's reasoning (for example a `reasoning` string in DraftOutput), which tends to draw a `reasoning_extraction` refusal. It is not guaranteed to fire, is billed even before any output, has no fallback, and deliberately trips a safety classifier on the owner's key, so it needs the owner's OK and one of the six calls in the US$1 budget. Without that OK, the refusal shape comes from the documentation.
- `MAX_TOKENS_CAP` is 16,000: a smaller `max_tokens` passes, a larger one is refused.

## For ADR 0011 and M7 (`plugins/ai-messages-api/`)

- The broker pins `model` and `effort` to the owner's instance configuration; the verifier alone admits any `claude-*` model and any effort up to `max`. `verifyRequest(request, pin)` shows the check, and a missing effort is refused too, because the API would run its default.
- The broker follows no redirects (finding 9), and its denial audit repeats only API vocabulary (finding 11).

## Sources

- Refusals and fallback, https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback (read 2026-10-17).
- Structured outputs, https://platform.claude.com/docs/en/build-with-claude/structured-outputs (read 2026-10-17).
- `@anthropic-ai/sdk` 0.135.0 from npm (MIT; integrity in `pnpm-lock.yaml`): `client.ts`, `resources/beta/messages/messages.ts`, `resources/messages/messages.ts`, `lib/parser.ts`, `lib/beta-parser.ts`, `lib/transform-json-schema.ts`, `helpers/beta/zod.ts`, `lib/internal/beta-messages-request.ts`, `lib/BetaMessageStream.ts`, `internal/headers.ts`, `internal/tracing.ts`, `internal/detect-platform.ts`, `internal/utils/log.ts`.
