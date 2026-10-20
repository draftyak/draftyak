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
| `host/fetch` | `method`, `url`, `headers`; optional `body`, opaque `sendTicket`, `saveAs`, `stream` | HTTP `status`, `headers`, exactly one `body` or `streamId` |
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

Host errors have `{jsonrpc:'2.0', id, error:{code,message,data:{code}}}`. The typed
`data.code` is one of `DENIED`, `TIMEOUT`, `TOO_LARGE`, `BAD_REQUEST`, `UNSUPPORTED`.
The SDK reports this bounded code rather than exposing arbitrary remote messages.
Plugin tool errors separately use the merged `PluginErrorResult` contract and
MCP `isError` results.

The hub redacts logs and applies method/instance restrictions. Tool-plugin
capability reduction is implemented by its definition and broker: only GET/HEAD
fetch without saveAs, log and memory-only kv; no ws, changed or progress. This
general core does not grant those capabilities or replace the broker check.
