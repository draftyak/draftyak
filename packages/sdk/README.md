# Plugin SDK core

`@draftyak/sdk` supplies the child-side host channel, context, brokered fetch,
errors, contract-specific definitions and MCP serving.
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

`defineChannelPlugin({manifest, describe, probe, sync, fetchBody, send,
reconcileSend, fetchAttachment?, mutate?, listen?})` captures exactly the supplied
channel handlers. `defineAiProviderPlugin({manifest, describe, listModels, probe,
generateDraft})` supplies the provider contract, including all `DraftOutcome`
branches and `context.progress`. Each helper validates its manifest kind and
checks arguments and results against the protocol schemas. Missing handlers,
unknown members, accessors and proxies are refused at definition. A channel send
requires a validated `_meta['io.github.draftyak/send-ticket']` and exposes it as
`context.sendTicket`; no other channel handler receives that field. Pass it
explicitly to fetch when forwarding the hub-rendered request.

Provider draft results first normalize `contextRefs` against that request's
required `contextIds`, ignoring case, removing duplicates and unknown IDs, and
following request order. Missing or malformed references become empty. The
normalized draft passes `validateDraftOutput`; failures become the existing
`invalid` outcome with at most 20 content-free schema problems, retaining model,
fallback and usage. Other outcome variants and typed error envelopes are unchanged.
`generateDraft` receives an `AiProviderContext` whose `progress(value, total?)`
emits MCP `notifications/progress` using only that call's incoming
`_meta.progressToken`. It does nothing when progress was not requested and
refuses reports after completion or cancellation. Concurrent calls retain their
own tokens; tokens correlate notifications and grant no authority. Other
handlers retain `PluginContext.progress(token, value, total?)` for host messages.
Provider handlers must report at least every 10 seconds while drafting; M1.15's
long-running provider contract fixture checks cadence. The SDK creates neither
tokens nor automatic progress intervals.

`defineToolPlugin({manifest, probe, lookup: {'kb.lookup': (args, context) => result}})`
requires exactly the manifest's declared lookup kinds. Its arguments and results
are typed by kind, and each output is bounded by the manifest's declared byte cap.
The server emits the protocol's literal canonical tool entries, including titles
and schemas, in a complete, unpaginated `tools/list` response. Generic entries
without the optional `canonicalTools` field retain ordinary MCP registration.
When supplied, that field must match the entire canonical list and registered
tool set, and is accepted only for the tool extension.

Tool serving requires a local bootstrap input:
`createPluginServer(entry, host, {instance: {id, config}})` or
`serve(entry, {instance: {id, config}})`. The runtime supplies the instance ID and
owner-entered non-secret configuration; MCP metadata cannot replace either.
The SDK detaches and deeply freezes this ordinary JSON input when creating the
factory: at most 65,536 canonical UTF-8 bytes, 32 nested levels and 65,536 nodes;
the configuration must be an object. These labels grant no broker authority.
Calls without an instance fail closed. The testkit may pass synthetic values
through the same local options; native bootstrap and credential authorization
remain host responsibilities.

`ToolContext` contains only `plugin`, `instance`, `fetch`, `kv`, `log` and `signal`.
Fetch accepts GET or HEAD, preserves opaque `secret://<name>` spelling, and refuses
body, send-ticket, saveAs and websocket options. It does not expose account,
websockets, changed notifications or progress. These SDK checks complement the
host's independent authorization; a plugin definition is not a sandbox.
