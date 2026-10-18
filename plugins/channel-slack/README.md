# Slack send core

`@draftyak/channel-slack` is a private, pure package for the approved plan's §3 outbox/pre-claim rules, §4 `slack-v1` and `slack-postmessage` rules, and §12 M6. It performs no I/O, holds no credentials and grants no sending authority. The hub calls these functions from its trusted executor and broker; they are not plugin-controlled renderers.

The [M6 backlog](../../docs/roadmap/m6.md) records this package's ownership,
acceptance commands and native/live integration gates. Proxies are refused
before caller traps execute, including in provider response objects.

## Public API

```ts
renderSlackPostMessage({ channelId, threadTs?, broadcast?, text, origin })
renderSlackRequest({ channelId, threadTs?, broadcast?, text, origin })
classifySlackSend({ channelId, now, deliverBy, retryAttempt, jitterMs?, observation })
parseSlackRetryAfter(header, now)
slackChatFacts({ id, type, name, isArchived, isShared, isExternal, isMember, memberCount })
decodeSlackChannelFacts(expectedChannelId, conversationsInfoResponse)
checkSlackPreflight({ approved, current, holdIfReply, approvedInboundWatermark, currentInboundWatermark })
classifySlackRequest({ method, url })
slackTimestamp(value)
tsKey(timestamp)
```

All boundaries validate runtime values. Invalid inputs throw `SlackCoreError` with `INVALID_INPUT`, `TEXT_TOO_LONG` or `REQUEST_TOO_LARGE`; messages contain only the code. The profile matcher returns `deny` for invalid input. Header parsing treats malformed values as absent. Output and errors contain no response message bodies or provider error text.

`renderSlackPostMessage` returns a frozen `{channel, thread_ts?, text, unfurl_links:false, unfurl_media:false, reply_broadcast}`. `renderSlackRequest` adds the fixed POST URL, content type, deeply frozen header pairs, an immutable JSON body string, and the protocol's `bodySha256` and `headersSha256`. Encode that string as UTF-8 without changing it. A top-level post omits `thread_ts`; null also means a top-level post. Unknown input keys are rejected, so display facts and provider options cannot bind to the request.

`broadcast` accepts only a primitive boolean; omitted or explicit `undefined` means false for existing callers. Every wire body includes `reply_broadcast:false` or `reply_broadcast:true`, and true requires a valid `threadTs`. This maps the approved snapshot's `chat.broadcast` to the plan's explicit renderer field. The native caller must obtain the frozen value and establish the owner's broadcast acknowledgement, approval and provenance independently. Passing this structural check grants no send authority. Slack documents the thread-only option in [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/).

`origin` must be `owner`, `machine` or `mcp`. Machine and MCP text escapes `&`, `<` and `>` in that order. Owner text preserves deliberate Slack markup. Only trusted frozen revision provenance may select `owner`; a client-supplied origin is insufficient, and a body containing machine or MCP contributions must use escaping for the whole body. Approval, broadcast acknowledgement and provenance checks remain hub responsibilities.

`classifySlackSend` takes one broker-observed outcome:

- `{kind:'response', status, body?, retryAfter?}` for a completed HTTP response; `body` is parsed JSON, never a string to parse here.
- `{kind:'transport', written:'none'|'maybe'}` for transport failure. **Only trusted broker transport evidence may establish `none`.** Plugin or provider assertions never establish that nothing was written. Timeouts, resets after a possible write and crashes use `maybe`.

The result is `SENT`, `RETRY_WAIT`, `FAILED`, `UNKNOWN` or `NEEDS_REAPPROVAL`. Success requires a 2xx `ok:true`, a valid timestamp and the exact expected channel. HTTP 408, 429, Slack `ratelimited` and proven never-written failures may retry. Other 4xx and a finite list of known Slack rejections fail definitively. Server errors, malformed success, unknown Slack errors and possible writes stay `UNKNOWN`, requiring reconciliation rather than automatic resend. The result never exposes an upstream error string. A success response arriving after the window still records `SENT`: classification cannot undo an already completed request.

`slackChatFacts` validates and freezes snapshot facts using the protocol's canonical channel types `dm`, `group_dm`, `public` and `private`. The caller maps provider conversation fields into those types and separately supplies sharing and external/Connect facts. Names are approval context only. Preflight reports `channel_changed` for a different id/type/name, an archived channel, newly shared or external status, lost membership, or growth both strictly over 10% and at least three members. Shrinkage, exactly 10% growth and growth of fewer than three do not block. A newer inbound watermark with hold enabled reports `new_reply`; channel changes take precedence.

`decodeSlackChannelFacts` projects a parsed `conversations.info` response into that existing fact type. It requires `ok:true`, the exact requested channel ID, and explicit name, membership, archive, member-count, type and sharing fields. It reads only a fixed selection of own data descriptors on plain objects; topic, purpose, messages, user identity, titles and other metadata remain unread. Output is detached and frozen. It makes no request, performs no authentication, and attests neither freshness nor posting ability. Native transport must bound and parse response bytes separately.

The codec uses `is_private` to distinguish public/private channels, including legacy `is_group` channels. DM/MPIM flags must be explicit and consistent. It never invents missing membership, count, names or false flags, so sparse documented DM responses refuse. Callers should request `include_num_members:true`; even then all other required facts must be present. Pending external sharing refuses because the existing facts cannot represent that transition. An explicit frozen, read-only or thread-only restriction also refuses. Optional restriction fields being absent does not establish that posting is allowed. These conservative unsupported cases and the exact required fields are recorded in the [codec appendix](../../docs/roadmap/m6.md#channel-facts-codec). Mapping follows Slack's [conversation object](https://docs.slack.dev/reference/objects/conversation-object/) and [`conversations.info`](https://docs.slack.dev/reference/methods/conversations.info/) documentation.

`classifySlackRequest` returns `read`, `send`, `hub-only` or `deny`. It matches the supported GET conversation/history/replies/info and user methods, POST `auth.test` and `apps.connections.open`, and only POST `chat.postMessage` as send. POST `auth.revoke` is `hub-only`, which plugin requests must deny. Scheduling, deletion, mutation and every unmatched method are denied. Paths, host, verb and documented query names must match; duplicate keys, credentials and override parameters are denied. This matcher covers Web API URLs; authenticated WebSocket host matching belongs in the later broker wiring.

Literal fragments are always refused. Send, revoke and zero-parameter POST reads permit no query delimiter. Supported GET parameter values may contain percent-encoded query or fragment delimiters; encoded route variants remain denied.

## Explicit choices

- Channel destinations are only `C`, `D` or `G` ids, 3–32 uppercase alphanumeric characters. User ids and channel names cannot create or redirect a DM. Timestamps have canonical nonnegative seconds, 1–12 digits with no leading zeros, and 1–9 fractional digits. Ordering uses integer nanoseconds, adapted from S6, never floating point.
- Text must already be well-formed Unicode, NFC and LF, matching frozen snapshot text. CR, NUL and other C0/DEL controls are rejected; tab and LF are allowed. The renderer does not normalize or truncate approved content. Text must be nonblank, at most 40,000 Unicode scalar values **after escaping**, and the complete UTF-8 JSON body at most 128 KiB. The byte ceiling bounds broker work independently of Slack's character limit. These are failures, never truncation.
- Input objects must be plain data objects with known keys. Accessors, exotic prototypes and symbol keys are rejected without invoking getters. Output bodies, facts and headers are immutable. The shared protocol computes hashes so later tickets use the same definitions.
- Retry attempt zero waits one second; exponential backoff plus caller-injected 0–1,000 ms jitter is capped at five minutes. Missing or malformed rate-limit headers wait at least 60 seconds. A zero/past header never eliminates backoff. Valid server waits are never shortened, including waits over five minutes. Integer seconds and strict IMF-fixdate are accepted; enormous values saturate safely. A next retry beyond `deliverBy` yields `NEEDS_REAPPROVAL/missed`, never a clipped early retry. Equality with `deliverBy` is allowed. No timers are created here.
- Preflight accepts at most one billion members and 256 UTF-16 units in a nonempty, well-formed channel display name, avoiding unsafe arithmetic and unbounded approval metadata. Both sharing and external transitions are checked independently. Returned facts never enter a renderer binding.
- Nullable watermarks mean no observed inbound message. Comparisons examine only newer timestamps; durable inbound watermarks must be monotonic and must include the final transaction's fresh inbound check. The helper does not attest freshness or completeness of a provider read.
- `users.conversations` follows S6's owner-membership listing; `conversations.list` remains supported by the approved profile. `users.info` and `users.list` provide profile data for approval context, never send bindings. Unsupported HTTP verbs are denied even if Slack accepts additional forms.

Slack's [message reference](https://docs.slack.dev/reference/methods/chat.postMessage/) documents truncation above 40,000 characters and the request fields. Its [rate-limit reference](https://docs.slack.dev/apis/web-api/rate-limits/) documents per-channel pacing and `Retry-After`. Both were checked on 2026-10-17.

## Later wiring

The hub must derive trusted input from the frozen approved snapshot, re-render and compare hashes at claim, mint a one-use broker ticket and pass the exact request through the channel transport. The generic broker must compare the actual plugin request's method, URL, body hash and header hash to the approved render and consume that ticket exactly once; this package alone supplies no send authority. The 128 KiB ceiling permits bodies above the MCP 64 KiB frame ceiling, so those bytes need the broker's blob/reference path. No new approval, ticket or transport is implemented here.

The hub still owns the two-clock window predicate, undo window, epoch/approver/policy/account-mode checks, 10-second bounded pre-claim reads (`conversations.info` plus replies/history since the watermark, limit 20), hold defaults for replies/DMs, final transactional watermark check, per-channel one-second pacing, 30 scheduled items per channel per five minutes, retries and durable state transitions. A failed or incomplete pre-claim read must not call this helper as though it succeeded. It retries on a later tick and eventually misses the window. Reconcile looks for identical text since the attempt; not found means reapproval, never resend.

SDK/manifest/disclosure/token installation, Socket Mode, polling and tier budgets, HTTP response byte caps and non-fact response decoding, normalization, revocation cancellation and hub-only revoke, 90-day purge, JSONL export, UI and FakeSlack integration are deferred. Normalization reducers are left with the later sync integration so message direction, durable watermarks and retention remain hub-owned.

## S6 provenance and tests

The identifier/timestamp validation and exact timestamp ordering adapt [S6's reducer](../../spikes/s06-slack/src/reduce.ts). Retry-After grammar and finite read-method arguments adapt [S6's API adapter](../../spikes/s06-slack/src/api.ts). No product code imports spike code. The send classifier follows the approved outbox rules: S6's transient-read retries and 15-minute wait clamp are deliberately unsuitable for an ambiguous send. [S6's rate-limit notes](../../spikes/s06-slack/notes/rate-limits.md) record the internal-app rate exemption dependency for future polling and pre-claim reads.

Tests are offline, synthetic, single-worker unit suites: golden payload bytes, outcome tables, hostile inputs and methods, exact text/byte/deadline boundaries, preflight transitions, protocol type alignment and bounded property tests. Run `pnpm --filter @draftyak/channel-slack test`, `typecheck` and `build`.
