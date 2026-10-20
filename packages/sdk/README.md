# Plugin SDK core

`@draftyak/sdk` supplies the child-side host channel, context, brokered fetch,
errors and MCP serving. Contract-specific definition helpers are a separate item.
The package is private. Import its source in a workspace and its `dist` exports
from a packed artifact.

`createPluginServer(entry, host)` returns a fresh MCP server factory. HTTP adapters
call that factory per request; `serve(entry)` uses the pinned MCP SDK's stdio
entry, which selects the modern era and pins one factory instance per connection.
Legacy initialization receives a readable rejection and can be followed by a
modern opening on the same connection. Only a DraftYak channel, provider or tool
extension and tools are declared. Logging uses the host channel; stdout carries
only MCP and tagged host frames. Unexpected handler failures return `TRANSIENT`
without their exception text. `PluginError` preserves its typed error result.
Tool extension errors use `_meta['io.github.draftyak/error']` without
`structuredContent`; channel and provider errors retain `structuredContent`.
`createPluginServer` selects this envelope from its validated extension. Direct
adapters use `pluginErrorResult(error, 'tool')` for tool results; the default
`'structured'` envelope preserves channel and provider results.

Each registered handler receives `(args, context, metadata)`. The third argument
is a detached, bounded JSON copy of that call's non-envelope MCP `_meta`, exposed
as a readonly record. A channel definition can select the send-ticket key only
for `channel_send` and pass its value unchanged to `context.fetch`. Metadata is
untrusted input; the SDK neither forwards a ticket automatically nor treats it
as native authorization. The hub's broker authenticates and consumes tickets.

`memoryHost(handler)` validates and copies JSON at the adapter boundary. It does
not simulate broker policy. `stdioHost({input, output})` supplies the same API
over RS-tagged host JSON lines and exposes its untagged MCP `transport`.
Neither API accepts an IPC handle. Host methods, limits and framing are specified
in [host-channel-v1](../../spec/host-channel-v1.md).

Each `subscribe` registration is independent, even when callbacks are reused,
and unsubscription is idempotent. Subscribing after `close()` throws
`HostError("DENIED")`. Callback exceptions cannot block other subscriptions;
closing notifies each registered close callback once. New notification listeners
start with the next notification, and closure stops any remaining notification
callbacks.

`createPluginContext({plugin, account}, host, signal)` exposes fetch, ws, kv,
changed, progress and log. It holds identifiers rather than credentials.
`fetch` accepts WHATWG Request/Response and streamed input, opaque body refs,
send tickets, secret references and `saveAs: 'blob'`. Inline bodies use the
protocol's canonical base64url encoding. A saved body is available as
`response.bodyRef`; it is not silently converted to an empty inline body.
For an authorized channel GET, `saveAs: {kind: 'base64url-json-member', member: 'raw' | 'data'}`
requests bounded decoding of that top-level JSON string into a stored blob.
The supporting host validates and commits it; the SDK only forwards the option.
It cannot be combined with `stream: true`. Require a compatible host and never
retry an unsupported mode as raw-response storage. Successful responses expose
only `bodyRef`; non-2xx responses retain ordinary bounded inline error bytes.
The original status and headers still describe the upstream JSON envelope.
Stream responses check ordering, total bytes, cancellation and completion.
Fetches share one stream subscription per host channel, with at most 16 total
pending or established streams. Chunks for an established stream reach only its
owner. Before replies identify their streams, a shared mailbox stores at most
16 stream IDs with 16 chunks and 1 MiB encoded data per ID. A mailbox overflow
refuses that ID; exhaustion by unknown IDs refuses unresolved fetches while
established streams continue. Completion, cancellation and closure release the
leases and their buffers.
WebSocket writes accept an envelope ID only, never arbitrary outbound data.
The broker remains the policy and credential enforcement point.

The child framing does not create plugin processes. Production POSIX parents
must use the shared `@draftyak/protocol/plugin-stdio` arrangement from the
process-mode item: FIFO stdin/stdout/stderr on Linux and macOS, spawn pipes on
Windows, and output cleanup on child exit with a bounded nonblocking drain.
Do not infer parent descriptor isolation from synthetic child-adapter tests.
Process-mode conformance remains dependent on that shared module and the testkit.
