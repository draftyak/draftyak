# S7a: Sign in with ChatGPT, sources and findings

S7a implements Sign in with ChatGPT (SIWC) clean-room (guardrail 4), from OpenAI's public developer documentation only. This file lists every source, the date it was read and what it settled. It is a vendor-guard data-only path, so it may name the DevKit packages and Codex files that the rules ban everywhere else.

## Clean-room record

- **Read:** the public pages listed below, all fetched with a plain GET as Markdown (`<page>.md`) on 2026-10-18 between 00:43 and 00:53 UTC. The SHA-256 is of the exact bytes fetched. `Last-Modified` on these pages tracks site deployments, not edits, so it isn't recorded.
- **Not read, installed or run:** the noncommercial DevKit (its repository, packages, README, examples and licence text), Codex's client or source, `~/.codex/auth.json`, and ChatGPT's `backend-api` endpoints.
- **The cookbook article** (row 14) quotes DevKit source in its code blocks. It was used only for the DevKit's package names, which appear in its prose (the `@siwc/react` components) and in one import line (`@siwc/local`). Its code excerpts and the DevKit files it links were not used.
- **The SIWC Terms** (https://openai.com/policies/sign-in-with-chatgpt-terms/, dated 2026-09-29) answered HTTP 403 with a browser check to a plain GET on 2026-10-18, so they weren't read for this item. The 2026-10-17 vendor research summarized them (express consent before background use, local user-controlled token storage, no charge, "the applicable license"). The owner reads them in a browser before S7b.
- **No OpenAI endpoint was called.** No sign-in, account, discovery document or JWKS fetch: every protocol fact below comes from the docs, and the tests run against loopback fakes built from those facts.

## Sources

| # | Page | URL (`.md` twin read) | SHA-256 |
|---|---|---|---|
| 1 | Quickstart | https://developers.openai.com/siwc/quickstart | `9333205c63f73c561ee7055b8e8e924ff3bd491d6c9e2e0ca45b52e63a2391ff` |
| 2 | ChatGPT plan usage: Overview | https://developers.openai.com/siwc/token-sharing-open-source | `7c916a3136973625481fe21673c2f342e97fe5a70153bc71e068d5b11be83ebd` |
| 3 | Registration and sign-in | https://developers.openai.com/siwc/token-sharing-open-source/sign-in | `94e9158385ba3048ad3454785940c97c92d9d2dcf8dfda66b0f4418643d146a5` |
| 4 | Accounts and sessions | https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions | `ab3eb6b64956e7ca22edbe4eb70f67ab2245cf9aea197902b16c639a6cf8dfc1` |
| 5 | Errors and recovery | https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery | `0b7f6d6a7a07ba4d81967858ca9f64264e2be017dfaed1e25297969a57a2c005` |
| 6 | Models and inference | https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference | `4cd568e57168de134717e5ed611d15d3505b88d30d6a45bd234b2a0a1ea96370` |
| 7 | Preview limitations | https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations | `051ee06d537d746de9a5f1aa5019a44400fd9856b27ec37b4a9c9fec5874fa0c` |
| 8 | Self-hosted VMs | https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms | `c4d541d0127073b8c7a0fa140bfe28742ea68b5569f4af56172932eb41ebd999` |
| 9 | Token reference | https://developers.openai.com/siwc/token-sharing-open-source/token-reference | `d48d4bee9f15062bf4cde08fe33fd32aab2a8df1a304dde70969eb528e07d0a1` |
| 10 | Codex app-server (read; not used, guardrail 4) | https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server | `eeee9ebe330f236ee2c70b6026c17337af56cd328c8acb3540bc194f86072d7d` |
| 11 | UI/UX guidelines | https://developers.openai.com/siwc/ui-ux-guidelines | `e22fc24b8ec25290f3830430c64a2914da432df6e9eb6a84cba03b457466f63f` |
| 12 | On your website (ID-token validation, discovery) | https://developers.openai.com/siwc/website | `4f1c4aceb50b85d69f3919550154fc555110c9bcc0a9e128eed0a6c905ffeee2` |
| 13 | Request a client ID | https://developers.openai.com/siwc/request-client-id | `41677a6f7bb9713b4a6b3c6d72193fd9035e7f0aa53ca1d3da8453678ce9a7a4` |
| 14 | Cookbook: Integrating Sign in with ChatGPT in your Opensource App (package names only) | https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt | `dd4cf106047a8c410a7a4b0ee736bd2f6a25c170698e8596f18a8892119b550a` |
| 15 | Responses API: Create a model response | https://developers.openai.com/api/reference/resources/responses/methods/create | `98dbc86be77dc477b1b33b862b5edfd334f6d30870e39616bd6c5bc54a20a664` |
| 16 | Responses API: streaming events | https://developers.openai.com/api/reference/resources/responses/streaming-events | `13dc8304ab014f6501dcf0528e25eb87ffcaaf3a9e10a212a141856051e0faad` |
| 17 | Structured model outputs | https://developers.openai.com/api/docs/guides/structured-outputs | `09aa3814251cf168070294ace79d677091de04b330055048392548d604aa7104` |
| 18 | Function calling | https://developers.openai.com/api/docs/guides/function-calling | `ce460da5635ff6b235fd45bb94a425975fc438f5e47ba71705e7ebf689172ae1` |
| 19 | Streaming API responses | https://developers.openai.com/api/docs/guides/streaming-responses | `7e147ae8c9e2ef2a30ecd7f3502a4c350e929487c7e51643cef2e4fb66281f7f` |
| 20 | Codex authentication (learn.chatgpt.com) | https://learn.chatgpt.com/docs/auth | `ef2f4e55abe70a66783a34be97778df35d29ad23fb7f6d68eb2610be51a61644` |
| 21 | Sign in with ChatGPT (help, learn.chatgpt.com) | https://learn.chatgpt.com/docs/sign-in-with-chatgpt | `6e1d173c2eed6f108d249301689c713f4e9a0c6df6e3f0bfaefd4a6a13e7e028` |

Rows 1–13 were also read in the combined export https://developers.openai.com/siwc/llms-full.txt (SHA-256 `14884eaed93be7406b7c4ae17729a9fa4eb6ec8474ec6cb9025d0d383dccd2db`), whose index is https://developers.openai.com/siwc/llms.txt.

The `openai` SDK 7.36.0 (Apache-2.0, integrity in `pnpm-lock.yaml`) was read from its installed sources: `client.ts`, `core/streaming.ts`, `core/error.ts`, `internal/decoders/line.ts`, `internal/detect-platform.ts` and `resources/responses/responses.ts`.

## What each source settled

### Eligibility (1, 2, 13, 21)
- "ChatGPT plan usage is available to all open-source partners and selected private clients" (1). The plan-usage docs cover "open-source and locally hosted apps"; a paid or remotely hosted app goes through the interest form (2). Request a client ID (13) is for the commercial website and plugin flows, not this one.
- Eligible users: the developer docs and the help page say ChatGPT Plus and Pro (1, 21). The help page names the disconnect path: ChatGPT Settings > Security and login > Sign in with ChatGPT.

### Registration and sign-in (2, 3, 4) → `src/auth.ts`
- First sign-in: `client_id=dynamic_agent_client`, `agent_name_hint` (the app's real name, used consistently: `DraftYak`) and `ext_agent_host_id`. The callback returns the issued `client_id` (`oaiapp_…`), which is saved and reused; `dynamic_agent_client` is never saved or used for the exchange. No client secret.
- Reauthorization: the issued `client_id`, the same host ID, `id_token_hint` and `login_hint` when kept, and no `agent_name_hint`. The callback may omit `client_id`; a different one is rejected.
- Authorize endpoint `https://auth.openai.com/api/accounts/authorize`. Parameters: `response_type=code`, `redirect_uri`, `scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`, `resource=https://api.openai.com/v1`, fresh `state` and `nonce`, `code_challenge_method=S256` and `code_challenge` (base64url SHA-256, no padding).
- Callback: an HTTP loopback on `127.0.0.1` with path `/auth/callback`. The docs' example is port 1455, "later sign-ins may use another available port … only the port may vary", the URI is identical in the request and the exchange, and `localhost` is never substituted. The listener starts before the browser opens.
- `error=access_denied`: validate `state`, stop, exchange nothing.
- Exchange: a form POST to `https://auth.openai.com/api/accounts/oauth/token` with the issued `client_id`, `code`, `code_verifier`, the same `redirect_uri` and `resource`. After `invalid_grant`, a fresh authorization reuses the issued client ID: a failed exchange hands that ID to the caller, and `signIn({ registration: { clientId } })` starts the next attempt with it, without `agent_name_hint`, so no second agent is registered.
- ID token (3, 12): signature against the published JWKS; `iss` equal to discovery's issuer; `aud` equal to the issued client ID; `exp`; the saved `nonce`; `sub` as the identity, checked against the saved account on a returning sign-in. Discovery is `https://auth.openai.com/.well-known/openid-configuration` (12); the spike also requires every endpoint to share the issuer's origin.
- Plan permission (3, 5): check the token response's granted scopes for `chatgpt.tokens.use.direct`. Without it, keep the sign-in, mark plan usage disabled and offer another billing path, such as an API key (plan §4 step 3). "Do not proceed to inference on this path": `Session.accessToken()` refuses with `PLAN_USAGE_DISABLED`, so the broker sends nothing. A refresh replaces the stored scopes, so a narrowed grant turns plan usage off. The docs group `offline_access` and `resource.invoke` with plan usage but don't say whether a decline withholds them too; without a refresh token the spike keeps the registration with no tokens.
- Host IDs (2): one stable, opaque ID per host, persisted before the first sign-in: `urn:ietf:params:oauth:jwk-thumbprint:…` (recommended, RFC 9278), `urn:uuid:` with a UUIDv4, or `did:key:`. "OpenAI does not verify possession of the private key."

### Consent (5) → `authorizationUrl({ enablePlan })`
- "Your app should not force consent on every ordinary sign-in." When the owner explicitly turns plan usage on, including after a decline, the app repeats OAuth with the saved client ID, the complete scope set and `prompt=consent`; `force_reconsent=true` only after OpenAI confirms deployment for the integration.
- The spike sends `prompt=consent` only on that explicit path, for a saved account. A first registration shows consent anyway, and a routine sign-in keeps an earlier decline.

### Tokens, refresh and sign-out (4, 9) → `src/session.ts`
- The token response holds `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in`, `scope` and `earliest_refresh_at`. Access tokens last one hour, refresh tokens 30 days, renewed on every refresh with no fixed limit.
- Refresh: a form POST with `grant_type=refresh_token`, the issued `client_id`, the saved `refresh_token` and `resource`, without `scope`. "Serialize refreshes for the same session so two processes do not race a rotating token", and store the replacement before use.
- Unusable refresh token (`invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`): clear it and sign in again with the saved client. `invalid_client`: fix the client. A refresh that fails on the network, a 429 or a 5xx is `UNAVAILABLE` with bounded backoff and keeps the tokens ("Do not erase credentials solely because of a temporary network or infrastructure failure").
- Sign-out: a form POST to discovery's `revocation_endpoint` with `token=<refresh token>`, `token_type_hint=refresh_token` and the issued `client_id`. An empty 200 is success, even for an invalid token. Retry network failures and 5xx with backoff; if revocation isn't confirmed, clear the tokens anyway and tell the user. Keep the client mapping and host ID; drop the ID-token hint.
- Never put tokens in URLs or logs; redact authorization URLs that carry `id_token_hint`.

### Transfer to another host (8) → `transferText`, `acceptTransfer`
- The documented order: create the VM's host ID, complete OAuth locally with the same client for the same account, move the credential file over a secure channel, keep the VM's own host ID ("so a copied laptop ID does not overwrite it"), and let the VM own later refreshes. "Host-specific usage attribution and revocation … are not yet available."
- Plan §4 step 2 differs: the desktop signs in with the hub's host ID and registration from the start, hands the tokens over L2 and forgets them. `acceptTransfer` takes only a credential carrying the hub's own host ID and issuer, and, for an account the hub knows, the same client and subject. `test/transfer-child.ts` is the receiving process for M0.27: it reads the text on stdin, refreshes once, revokes on `--revoke` and prints content-free results.

### Inference (6, 7, 15–19) → `src/responses.ts`, `src/verify.ts`
- Only `POST https://api.openai.com/v1/responses` with `Authorization: Bearer <access token>`, `store: false` and `stream: true`, never ChatGPT's `backend-api` endpoints. Success only after `response.completed`; a usage limit can arrive as `response.failed` after streaming began.
- Models: `GET https://api.openai.com/v1/models` returns `{"models": [{"slug", "display_name", "visibility"}]}`; show `visibility: "list"` in the server's order and pass `slug` as `model`. The SDK's `models.list()` expects `data`, so the picker uses `client.get("/models")`.
- Preview limitations: `input` is an array; `instructions` or developer messages, never `system` items; no `previous_response_id`. Unsupported fields: `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`. Function and custom tools go in namespaces or in `additional_tools` input items (role `developer`).
- Plan §4's allowlist (`model`, `instructions`, `input`, `tools`, `tool_choice`, `text`, `reasoning`, `stream`, `store`) is a subset of what the route accepts. The tests check every field the SDK can send (its `ResponseCreateParamsBase`) plus the docs' unsupported list.
- Structured outputs (17, 18): strict mode needs an object root, `additionalProperties: false` on every object, every property required, and no `allOf`, `not`, `if`/`then`/`else` or `dependent*`. It doesn't enforce string lengths, so `parseDraft` does.
- Streaming (16, 19): `event:` and `data:` lines; `response.output_text.delta`, `response.function_call_arguments.delta`, `response.refusal.delta`, `response.completed`, `response.incomplete`, `response.failed` and `error`.

### Errors (5) → `src/errors.ts`

| Upstream | Status | Code | Plugin code (§4) | Recovery |
|---|---|---|---|---|
| `subscription_sharing_usage_limit_exceeded` | 429 | `USAGE_LIMIT` | `QUOTA_EXCEEDED` | never retried; Manage usage |
| `subscription_sharing_usage_unavailable` | 503 | `UNAVAILABLE` | `TRANSIENT` | bounded backoff |
| `subscription_sharing_user_unavailable` | 503 | `UNAVAILABLE` | `TRANSIENT` | bounded backoff |
| `subscription_sharing_user_not_eligible` | 403 | `NOT_ELIGIBLE` | `PERMISSION_DENIED` | never; no OAuth loop |
| `subscription_sharing_unsupported_capability` | 400 | `UNSUPPORTED_CAPABILITY` | `UNSUPPORTED` | never; `param` names the field |
| `subscription_sharing_route_not_supported` | 403 | `ROUTE_NOT_SUPPORTED` | `UNSUPPORTED` | never |
| `subscription_sharing_invalid_user` | 401 | `INVALID_USER` | `AUTH_REVOKED` | sign in again |
| `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context` | 403 | `SCOPE_NOT_AUTHORIZED` | `PERMISSION_DENIED` | never |
| direct admission `{"detail": …}` | 401 / 403 / 503 | `ADMISSION_REFUSED` / `ADMISSION_REFUSED` / `UNAVAILABLE` | `AUTH_EXPIRED` / `PERMISSION_DENIED` / `TRANSIENT` | sign in / never / backoff |
| the hub's own credential refusal, before anything leaves | 401 / 403 / 403 / 503 | `REAUTH_REQUIRED` / `INVALID_CLIENT` / `PLAN_USAGE_DISABLED` / `UNAVAILABLE` | `AUTH_REVOKED` / `AUTH_REVOKED` / `PERMISSION_DENIED` / `TRANSIENT` | sign in / never / never / backoff |

"OpenAI does not silently switch the request to another billing path"; neither does DraftYak. Errors keep the status, body shape, code, `param` and request ID, never message text; errors inside a stream (`response.failed`, `error`) keep the stream's status and request ID. When the broker can't get a usable token, it answers the plugin with a `broker_refused` error whose `code` is the session's code, so the reason crosses the host channel as data.

### UI (11)
"Continue with ChatGPT" starts sign-in; "Using ChatGPT plan" with a "Manage usage" link to https://chatgpt.com/settings/usage shows near the composer; a usage-limit message makes Manage usage the primary action; a welcome modal shows once after the first sign-in with plan usage; an app's pricing page must say which of its plans support ChatGPT plan usage.

### Package names for vendor-guard (14)
The DevKit's packages, as the cookbook names them: `@siwc/local` (its runtime: sign-in, storage, requests) and `@siwc/react` (button, connection card, usage links). They are `devkitNames` in `tools/vendor-guard/rules/openai.ts`. The DevKit lives at `github.com/openai/sign-in-with-chatgpt-devkit` with packages under `packages/local` and `packages/react`; the same rule entry also refuses any package in the `@siwc` scope and that repository's name, in a git dependency or anywhere else.

### Codex (20)
Codex's login server listens on `localhost:1455` by default and caches tokens in `~/.codex/auth.json`, so a Codex sign-in running at the same time is the likeliest holder of port 1455: the spike refuses with `PORT_IN_USE` rather than share the port. No public page read here gives Codex's OAuth client ID, so vendor-guard's existing value stays unconfirmed.

## Spike choices to confirm in S7b (M0.27) and ADR 0009

1. **Port.** The plan fixes 127.0.0.1:1455 and refuses a collision with `PORT_IN_USE`; the docs would let reauthorization use another free port. A connect probe runs before the bind, because Windows lets a bind on 127.0.0.1 succeed beside a wildcard listener on the same port.
2. **`submit_draft` placement.** The docs ask for a namespace or an `additional_tools` item; the fake refuses top-level function tools under that reading, and accepts them when told to. Record which forms the live route takes, with which `tool_choice`, and whether `text.format` strict json_schema works.
3. **Refresh details.** The format and meaning of `earliest_refresh_at` (the spike reads Unix seconds or a date, and holds back only a still-valid token), the error body shape on refresh, and whether a refresh returns a new `id_token`.
4. **Discovery.** Whether every endpoint, the revocation endpoint included, shares `https://auth.openai.com`'s origin (the spike requires it); the ID-token `alg` (RS256 and ES256 accepted).
5. **Streaming.** Chunk sizes as they arrive, whether `response.completed` repeats the full output with `store: false` (the spike requires the stream and the final output to agree when both are present), and the request-ID header names.
6. **Host-ID format.** The spike issues UUIDv4 URNs and accepts all three documented forms. The docs recommend an RFC 9278 thumbprint of a host key; whether the hub derives one from a key it already holds is ADR 0009's call.
7. **The callback port in the broker (plan changes).** Plan §1 opens `127.0.0.1:1455` only during a sign-in, and its broker blocks it like 47613–47615. ADR 0009 should carry that into M9: plugin egress to loopback port 1455 is refused like the hub ports, beside M0.12's `brokerDecision` list (9229, 47613–47615), which doesn't hold 1455 yet.
