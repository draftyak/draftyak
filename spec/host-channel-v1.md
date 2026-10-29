# Host channel v1

The hub owns credentials and egress policy. A plugin sends only JSON-RPC 2.0 host
requests through this child-side contract; request validation is not authorization.
The source is `packages/protocol/src/host-channel.ts`; its generated structural
schema is [host-channel-v1.schema.json](schemas/host-channel-v1.schema.json).

## Transport and limits

ADR 0003's selected transport carries tagged host frames alongside MCP on
stdin/stdout. Each host line is the byte `0x1e` (RS), a UTF-8 JSON object and LF.
An untagged line is MCP. The tag is outside JSON; embedded control characters
must be JSON-escaped. Duplicate keys, invalid UTF-8, non-JSON values, internal
`NODE_*` objects, invalid envelopes, overlong or unfinished lines close the child
channel and reject its pending requests. No Node IPC channel or handle-transfer
API is used.

One JSON frame is at most 1,048,576 bytes before RS/LF. A child has at most 16
active host requests; replies use the exact opaque string request ID. A request
times out within 30,000 ms, or sooner when its call's signal is cancelled. Closing
the channel rejects all pending requests. Late replies to retired IDs are ignored.
Local ID retirement is not a request to cancel upstream work. The parent broker
and supervisor must bind host work to their own current MCP/lookup permit signal
and stop it on cancellation, timeout or instance shutdown; an SDK promise alone
does not grant or extend that authority.
Headers have at most 64 pairs, each name at most 128 ASCII token characters and
each value at most 8,192 visible ASCII characters with interior spaces/tabs.
Their aggregate name/value bytes are at most 16,384. Line terminators are refused.
Inline byte values follow the existing `Bytes` contract (canonical base64url,
at most 65,536 decoded bytes) or a hub-held ULID blob reference.

Production parent stdio is owned by the shared
`@draftyak/protocol/plugin-stdio` module in the process-mode item: FIFOs for
stdin/stdout/stderr on Linux and macOS; spawn pipes on Windows. The parent ends
and drains outputs on plugin exit using a bounded nonblocking drain, then cleans
up; it must not wait indefinitely for EOF. This child contract does not spawn,
create FIFOs, duplicate the parent's helper, or establish its descriptor-isolation
acceptance. Synthetic child adapter tests do not replace process-mode acceptance.

## Methods

| Method | Params | Result |
|---|---|---|
| `host/fetch` | `method`, `url`, `headers`; optional `body`, opaque `sendTicket`, `saveAs`, `stream`, `lookupPermit` | HTTP `status`, `headers`, exactly one `body` or `streamId` |
| `host/ws.open` | `url` | `socketId` |
| `host/ws.send` | `socketId`, `envelopeId` | null; acknowledgement only |
| `host/ws.close` | `socketId` | null |
| `host/kv.get` | `key` | `{value}` (JSON, null for absent) |
| `host/kv.set` | `key`, JSON `value` | null |
| `host/kv.delete` | `key` | null |
| `host/changed` | optional `cursor` | null |
| `host/log` | `level` (`debug`, `info`, `warn`, `error`), `message` | null |
| `host/progress` | `token`, nonnegative `progress`, optional `total` | null |

Fetch supports GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. The hub canonicalizes
the URL, applies its profile and header allowlists, substitutes `secret://` refs,
checks tickets, injects credentials, and caps size/time before transport. The SDK
does not fetch directly or interpret a send ticket. Blob body refs and tickets
preserve their JSON value across the boundary. `saveAs` results remain body refs;
the SDK exposes `Response.bodyRef` so callers cannot mistake them for fetched bytes.

## Parent-granted lookup membership

For the canonical `calendar.freebusy`, `contact.notes` and `kb.lookup` tools,
the parent supplies `_meta["io.github.draftyak/lookup-permit"]` on each admitted
MCP `tools/call`. The SDK captures that value for the call and echoes it as
`host/fetch.params.lookupPermit`. `LookupPermit` is exactly 32 bytes encoded as
43 canonical unpadded base64url characters, including zero unused terminal bits.
Padding, whitespace, alternate alphabets, malformed values and coercion are
refused. The request envelope remains exactly `jsonrpc`, `id`, `method`, `params`;
its ID is reply correlation, not lookup authority. The optional fetch member is
shared by both structural fetch variants; it grants no storage or method permission.

A permit identifies a parent grant. Presenting active B's permit selects B's
admitted native account, policy, four-attempt budget and deadline, regardless of
which internal callback presents it. A delayed A continuation can present B's
permit or retain B's fetch closure in the same hostile process. This contract
does not establish causal origin, data origin, intent or cross-call/account
memory isolation. Retired A's grant cannot be revived by calling while B is active.

### Admission and accounting

Parents implementing lookup membership must establish all of these boundaries:

- Before sending a lookup to a ready, discovered instance, reserve a native
  invocation/resource slot and validate the canonical kind, hub-bound arguments,
  current account/instance generation, consent and routing. Merge MCP metadata,
  replacing any caller value at the reserved key. A child-supplied label, ID,
  argument, deadline or signal cannot create a grant.
- Draw 32 fresh bytes from the OS CSPRNG. Check against every retained active and
  retiring token, using at most four draws; entropy failure or repeated collision
  refuses admission with `DENIED`. Never intentionally reuse a token. Disposed
  tokens do not require unbounded tombstones. Fresh randomness gives a negligible
  accidental-reuse assumption, not deterministic historical uniqueness: for n
  draws the birthday bound is at most n(n-1)/2^257. An accidental disposed-token
  collision could make old bytes identify a later grant in the same generation.
- Keep trusted references to the actual attached transport/process generation,
  instance, admitted account, native invocation, canonical kind/arguments, current
  policy/consent, native cancellation signal, monotonic deadline and attempt count.
  The actual consumer must supply its reviewed finite admission/resource bound.
  Active plus retiring resources count until disposal finishes; no slot means no
  issuance or dispatch, unlimited queue or deadline extension. The 16-active-host-
  request ceiling is separate and does not select a 16-lookup admission policy.
- Start the deadline at ready admission/send: 5,000 ms for `contact.notes` and
  `kb.lookup`, 15,000 ms for `calendar.freebusy`. At the exact deadline the grant
  is inactive. Child timeouts, rule timeouts, retries and first fetch never extend
  or reset it; existing stricter limits continue to apply.
- Before any asynchronous policy, DNS, secret or transport work, require the
  active token's exact receiving transport/generation/instance and unchanged
  native admission, then atomically reserve one of four attempts. A valid matching
  attempt consumes a reservation even if later refused, failed or cancelled.
  Internal retries need another reservation. There are no refunds. Missing,
  unknown or foreign tokens never dispatch or allocate chargeable lookup state.
- Apply all existing read-class, URL, canonical-address, header, credential,
  response and consent rules using the captured grant. A grant is not permission
  for an arbitrary URL, account or secret. An independently native account pin
  must also match. Remove `lookupPermit` before constructing the upstream request;
  never put it in HTTP headers, URLs, bodies, argv, environment, disk, logs or
  error details. Non-tool instances cannot present lookup permits.
- Bind work to that exact grant's signal and deadline. Recheck admission,
  generation, cancellation and absolute monotonic deadline after each relevant
  await, before dispatch, after headers/chunks and before positive output or blob
  commit. Closures retain unique native invocation/resource identity, never a
  reusable child ID or whichever lookup happens to be current.

Retire once, before outward native completion, on success/error, cancellation,
deadline, shutdown/exit or required authority invalidation. Remove the token from
admission lookup, abort captured work and discard late output. Resource cleanup
must survive throwing callbacks and remain bounded; retiring resources have no
authority. Cancellation cannot undo bytes already sent upstream.

A duplicate pending host request ID closes the ambiguous channel under existing
`BAD_REQUEST` handling before another dispatch and retires its grants. Reusing an
ID after terminal removal is a new chargeable attempt, not a replay or refund;
late callbacks cannot reply into its replacement. Unknown/retired/foreign/missing
grants and a fifth matching attempt are `DENIED`. Structurally malformed permits
follow existing `BAD_REQUEST` handling. Known in-flight deadline expiry is
`TIMEOUT`; cancellation/invalidation is `DENIED`. No new host error code is added.

The five-second unanswered-call grace is process liveness, not extra grant
lifetime. A whole-generation stop may end concurrent work in that generation;
an old timer must never stop a replacement generation or an answered invocation.

### SDK behavior and compatibility

On a covered lookup, malformed present metadata becomes an `INVALID_INPUT`
plugin-error result before the handler runs. Missing metadata permits computation
without network I/O, but its `ctx.fetch` rejects with `DENIED` before any host
request. Each call captures its own immutable scalar; no global current permit,
public context permit field or fetch-init override is provided. The shared host
channel/stream router remains the same object. Call cancellation and settlement
retire the cooperative SDK scope. A raw hostile child can bypass SDK helpers;
native parent enforcement remains mandatory.

The optional scope parameters of `createPluginContext` and `hostFetch` are
callable low-level serving plumbing, not authority. Child-supplied values remain
subject to the parent ledger. The handler's existing third metadata argument and
fourth request/progress context are preserved.

Ordinary channel/provider calls do not inherit tool permits. This lookup contract
does not select probe, setup or re-probe admission or a probe timeout. An unbound
request must never be guessed to be a probe. Those paths and the actual finite
native active-plus-retiring resource bound require reviewed consumer inputs before
whole process activation.

There is no negotiated host-feature handshake. A new parent refuses old SDK
unbound tool egress; a new SDK requires a conforming parent for covered tool fetch.
An old strict parent may refuse a manually supplied new field. Never strip it,
retry unbound or downgrade after refusal. MCP version, manifest SDK semver,
`tool-v1` version and schema digest do not prove parent support. Canonical tool
entries, arguments, results and extension declarations remain unchanged. Deploying
runtime/testkit consumers requires this host contract and actual conformance
evidence. Structural schemas/vectors and SDK tests do not establish native ledger,
process, cancellation, storage or platform enforcement.

## Decoded JSON-member blobs

`saveAs: 'blob'` continues to store the complete upstream response unchanged.
The additive option `saveAs: {kind: 'base64url-json-member', member: 'raw' | 'data'}`
selects exactly one case-sensitive, top-level JSON string and stores its decoded
bytes. It is available only for an otherwise-authorized read-class channel GET.
It grants no URL, redirect, credential, account, instance or network permission.
Tool plugins cannot use it. The request schema rejects other methods and
`stream: true`; omitted `stream` and `stream: false` are equivalent here.

For a 2xx upstream response, the broker must validate strict UTF-8 and one complete
JSON root object, with no trailing document or data. The selected member must
occur exactly once and be a string. Duplicate keys anywhere, including escaped-key
collisions, are refused. Other metadata is validated and skipped without becoming
authority. JSON has at most 64 container levels (the root object is level one)
and 65,536 value nodes (including the root, every object value and array element;
object keys are not additional value nodes). Token/key bookkeeping must stay
bounded within these limits and the entity limit.

The selected string is base64url: only `A-Z`, `a-z`, `0-9`, `-`, `_` and exact
terminal padding are accepted. Canonical unpadded strings and their exactly
padded equivalents are valid; the empty string produces an empty blob. Whitespace,
`+`, `/`, impossible lengths, interior/excess/incomplete padding and nonzero
unused bits are refused. JSON string escapes are decoded before checking this
alphabet. This input rule does not change the protocol's unpadded `Bytes` encoding.

Compressed HTTP entity input and entity bytes after Content-Encoding are counted
independently, each at most 50,331,648 bytes (48 MiB). Decoded output is at most
33,554,432 bytes (32 MiB). At that output limit the canonical string has
44,739,243 unpadded characters or 44,739,244 with proper padding. The broker must
stream projection/decoding with actual input, encoded-character and decoded-byte
counters, without materializing or copying the complete entity. Stricter route,
account, storage, MIME-parser and broker limits win. In particular, the existing
35 MiB general channel-rule ceiling is unchanged; these maxima do not promise
32 MiB MIME parsing or support for every provider payload.

Decoded bytes go through the hub-owned encrypted blob writer. Return the existing
`body: {ref}` only after the whole document validates and storage commits. Preserve
the existing caller/account/instance scope. Cancellation, timeout, malformed input,
quota or persistence failure discards partial state and returns no reference.
Content and secret-bearing input must never enter logs, argv or error detail.

Preserve upstream status and headers; they describe the JSON envelope, not the
decoded blob. A non-2xx response is not projected: return its ordinary inline
error body, bounded to 65,536 bytes, or refuse an excess. Malformed successful
UTF-8/JSON/member/encoding returns `BAD_REQUEST`; size or structural resource
exhaustion returns `TOO_LARGE`. Cancellation and timeout keep the existing host
errors. No error-body decoding or partial success is permitted.

The SDK forwards the explicit option and exposes the existing `bodyRef`; it does
not decode input or implement native persistence. A caller must require a host
version supporting this option. An older strict host rejects it; no automatic
retry as raw JSON, inline bytes or a stream is permitted, and no new handshake is
defined. Native conformance must cover both members, empty/padded/unpadded data,
all exact size/depth/node neighbors, malformed UTF-8/JSON and duplicates at any
depth, encoding/padding/bit failures, and cancellation/timeout/storage cleanup
before scoped-reference commit. Contract vectors define these outcomes separately
from the request-schema cases exercised here.

Hub notifications have no request ID. `host/ws.message` supplies `socketId` and
`data`; `host/stream.chunk` supplies `streamId`, zero-based `sequence`, canonical
base64url `base64`, `done`, and optional typed `error`. Stream chunks are at most
65,536 bytes; the SDK caps a streamed response at 33,554,432 bytes and rejects
out-of-order chunks, typed errors, cancellation or incomplete channel closure.
Chunks arriving in the fetch reply's read are buffered within the frame bound.

`host/ws.message` `data` is the text of one WebSocket message, bounded only by
the frame. A frame is at most 1,048,576 bytes and the smallest `host/ws.message`
frame (one-character `socketId`, empty `data`) is 80 bytes, so `data` is at most
1,048,496 characters, counted as Unicode code points like JSON Schema
`maxLength`. Multi-byte characters, JSON escapes and a longer `socketId` take
more bytes, so the frame bound decides whether a message fits. `data` may span
lines: JSON escapes LF and CR, so they never end a frame. The hub never
truncates or splits a message, and never sends a frame over the bound: when a
message would not fit in one frame, it closes that WebSocket with status 1009
(Message Too Big) instead and retires its `socketId`, so later requests naming
it fail with `DENIED`. A `host/ws.message` that fails the schema or the frame
bound is refused like any other invalid or overlong frame: the child channel
closes, taking MCP with it, and its pending requests are rejected.

Host errors have `{jsonrpc:'2.0', id, error:{code,message,data:{code}}}`. The typed
`data.code` is one of `DENIED`, `TIMEOUT`, `TOO_LARGE`, `BAD_REQUEST`, `UNSUPPORTED`.
The SDK reports this bounded code rather than exposing arbitrary remote messages.
Plugin tool errors separately use the merged `PluginErrorResult` contract and
MCP `isError` results.

The hub redacts logs and applies method/instance restrictions. Tool-plugin
capability reduction is implemented by its definition and broker: only GET/HEAD
fetch without saveAs, log and memory-only kv; no ws, changed or progress. This
general core does not grant those capabilities or replace the broker check.
