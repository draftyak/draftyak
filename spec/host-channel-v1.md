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
| `host/fetch` | `method`, `url`, `headers`; optional `body`, opaque `sendTicket`, `saveAs: 'blob'`, `stream` | HTTP `status`, `headers`, exactly one `body` or `streamId` |
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
