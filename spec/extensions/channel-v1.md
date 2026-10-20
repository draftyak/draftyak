# `io.github.draftyak/channel` v1

> **Status: draft.** Until the M1 gate, any M1 item may change this file; afterwards only a contract PR changes it (see [the README](../README.md)).

A channel plugin connects one account of a mail or chat service. It reads changes, fetches bodies and attachments, organizes messages where the service allows it, and transports sends the hub has rendered. It never decides anything: the hub parses mail, derives direction, applies policy, renders every send and matches it byte for byte.

Generated files:

- [`schemas/channel-v1.schema.json`](../schemas/channel-v1.schema.json): one member per tool, each holding the tool's `input`, its `output`, its `error` and, for `channel_send`, the `meta` its call must carry. Required tools are required members.
- [`schemas/normalized-change-v1.schema.json`](../schemas/normalized-change-v1.schema.json) and [`schemas/broker-ticket-v1.schema.json`](../schemas/broker-ticket-v1.schema.json).
- [`vectors/send-ticket/broker.json`](../vectors/send-ticket/broker.json): tickets and requests with the check that fails, and ticket lifetimes, for every broker and mock host.

## Declaration and surface

Plugins speak MCP 2026-07-28 only. `server/discover` declares the extension under `capabilities.extensions`:

```json
{ "io.github.draftyak/channel": { "version": 1, "schemaDigest": "<64 hex>" } }
```

`schemaDigest` is the SHA-256 of the JCS of `schemas/channel-v1.schema.json` as committed, so any SDK computes it from `spec/`. The hub fails closed: a missing declaration, another major version or another digest refuses the install, and quarantines a plugin already installed. A `tools/list` that changes later quarantines it too.

A plugin never contributes prompts, resources, completion or UI. It lists all its tools in one `tools/list` result. The hub refuses a surface with any of these, as `checkPluginSurface` reports them:

| Code | Refused |
|---|---|
| `SURFACE_PROMPTS`, `SURFACE_RESOURCES`, `SURFACE_COMPLETIONS` | the capability declared at all, whatever its value |
| `SURFACE_UI` | the `io.modelcontextprotocol/ui` extension, under `capabilities.extensions` or `capabilities.experimental` |
| `SURFACE_TOOL_UI` | a tool whose `_meta` holds `ui`, a legacy `ui/…` key or `io.modelcontextprotocol/ui` |
| `SURFACE_EXTENSION_MISSING`, `SURFACE_EXTENSION_INVALID` | the declaration missing, or not `{version, schemaDigest}` |
| `SURFACE_EXTENSION_VERSION`, `SURFACE_EXTENSION_DIGEST` | another major version, or another digest |
| `SURFACE_TOOL_MISSING`, `SURFACE_TOOL_UNKNOWN` | a required tool left out of `tools/list`, or a tool this extension doesn't define |
| `SURFACE_MALFORMED` | a result that isn't a discover or tools list, an unnamed or repeated tool, or a tools list with `nextCursor` |

Other capabilities, such as `logging`, are allowed.

The hub reads only a result's `structuredContent`: on success it must match the tool's `output`, and with `isError` the tool's `error`, `{code, retryAfterMs?, detail?}` as in [`schemas/plugin-error-v1.schema.json`](../schemas/plugin-error-v1.schema.json). A result that asks for input is refused, and the hub never relays a plugin's resource links or embedded resources. Plugin tools never reach a model.

## Values

- Every string the tools' inputs, outputs and errors carry is well-formed Unicode. A lone surrogate, raw or escaped, has no UTF-8 form, so no hash or canonical form takes it, and the hub refuses it; a plugin replaces one (for example with `String.prototype.toWellFormed()`) before reporting. JSON Schema can't state this rule, so the exported schemas leave it out.
- Patterns are ECMA-262 regular expressions matched against the whole string. Where `$` also matches before a final line feed, as with Python's `re.search`, an implementation matches with `fullmatch` instead, so an id such as `"C0123\n"` stays refused.
- Ids are opaque to the hub: visible ASCII without spaces, 1 to 256 characters. Instants are UTC milliseconds, and text limits count code points.
- Bytes travel as `{base64}`, canonical base64url of at most 65,536 bytes, or as `{ref}`, a blob the hub holds, such as a `host/fetch` response saved with `saveAs: "blob"`.
  - Open point: Gmail returns a message's RFC 5322 bytes (`format=raw`) and an attachment's bytes base64url-encoded inside a JSON body, so saving that response as a blob would store the JSON, not the bytes. Until `host/fetch` can store a decoded JSON member as a blob, such a plugin can return only messages and attachments of at most 64 KiB.
- Every input and output schema has an object root (`"type": "object"`), as `tools/list` requires of an input schema, unions included.

## Tools

| Tool | Required | Input | Output |
|---|---|---|---|
| `channel_describe` | yes | `{}` | `{channel, mutations, attachments, listen}` |
| `channel_probe` | yes | `{}` | `{status: "ok" \| "degraded", detail?}` |
| `channel_sync` | yes | `{mode: "initial" \| "resync", since, cursor?}` or `{mode: "delta", cursor}` | `{changes, cursor, more}` |
| `channel_body_fetch` | yes | `{message}` | `{message}` with its body |
| `channel_attachment_fetch` | no | `{message, attachmentId}` | `{contentType, size, content}` |
| `channel_mutate` | no | `{op, messages, labelIds?}` | `{}` |
| `channel_send` | yes, executor only | `{method, url, contentType, body: {ref}}`, ticket in `_meta` | `{message?}` |
| `channel_send_reconcile` | yes | `{attemptAt, target}` | `{candidates, complete}` |
| `channel_listen` | no | `{leaseMs}` | `{leaseMs}` |

- `channel_describe` says which family of changes the plugin reports (`email` or `chat`), which organize actions it performs at the provider (`archive`, `unarchive`, `read`, `unread`, `label`, `unlabel`; any it doesn't list stay hub-local), and whether it serves attachments and listening.
- A message is named by a `MessageRef`: `{kind: "email", providerId}` or `{kind: "chat", channelId, ts}`. `channel_mutate` takes 1 to 100 of them, and `labelIds` (1 to 20) exactly for `label` and `unlabel`.
- The hub cancels a call after 30 s, and `channel_sync` after 120 s; a plugin that hasn't answered 5 s after the cancellation is stopped.

### Changes

`channel_sync` returns changes, the hub's `NormalizedChange`; `channel_body_fetch` and `channel_send_reconcile` return message changes with their bodies, an email always with `raw`. A plugin reports only the family it describes; device-hosted channels such as SMS are closed to plugins, and their changes never come through this extension.

| Kind | Fields |
|---|---|
| `email.message` | `providerId`, `threadId`, `internalDate`, `labelIds` (at most 256), `sizeBytes?`, `raw?` |
| `email.deleted` | `providerId` |
| `email.labels` | `providerId`, `threadId`, `labelIds`: the message's labels after the change |
| `chat.message` | `channelId`, `ts`, `threadTs?`, `sentAt`, `author` (`{kind: "user" \| "bot", id}`), `subtype?`, `text` (at most 40,000), `editedAt?`, `files?` (at most 20 of `{id, name, contentType, size}`, `contentType` a lower-case type/subtype) |
| `chat.deleted` | `channelId`, `ts` |
| `chat.conversation` | `channelId`, `name?` (none for direct messages), `type` (`dm`, `group_dm`, `public`, `private`), `external`, `memberCount`, `archived`, `member` |

- Mail arrives as its RFC 5322 bytes in `raw` and nothing a plugin parsed: the hub parses it. A message without `raw` is fetched later with `channel_body_fetch`.
- A chat message's `ts` is its id within the conversation (Slack's `ts`); `sentAt` dates and orders it.
- `chat.conversation` carries the facts a scheduled send's claim re-checks: renamed, archived, external or shared, type changed, the owner no longer a `member`, or the member count up. `archived` is whether the provider archived the conversation; the hub keeps its own archived flag apart and never sets it from this.
- Everything in a change is untrusted content. Direction comes from the hub alone: from hub-verified sends and hub-parsed sent mail, and for chat by comparing the author with the hub's own identity check.

### Sync

- `initial` reads the account from `since` on; `resync` does the same after the hub lost its place.
- While `more` is true, the hub calls again with the returned `cursor` and the same mode. The cursor of the page with `more: false` is where `delta` continues, and `delta` returns the same cursor when nothing changed.
- A cursor is the plugin's own string, visible ASCII up to 4,096 characters. When the provider no longer accepts it, the tool fails with `CURSOR_EXPIRED`, and the hub resyncs.
- A page holds at most 500 changes; the hub applies each page in one transaction, idempotently on the provider ids.

### Sending

The hub renders, the plugin transports and the broker matches:

1. At the claim, the executor renders the exact request from the frozen snapshot, stores its body, and mints a one-shot ticket: `{id, outboxId, instanceId, method, url, headersSha256, contentType, bodySha256, exp}`. `exp` is the earlier of the minting time plus 60 s and the item's `deliverBy`, in UTC milliseconds (`sendTicketExp`), so no request is accepted after the approved window.
2. Only the executor calls `channel_send`. Its input is the rendered request's `method` (`POST`, `PUT` or `PATCH`), `url`, `contentType` and `body` as a blob ref, and the call's `_meta["io.github.draftyak/send-ticket"]` carries the ticket. A call without a valid ticket there is refused.
3. The plugin makes exactly one request: `ctx.fetch(url, {method, headers: {"Content-Type": contentType}, body: {ref}, sendTicket})`, passing the ticket on unchanged. It never retries; the hub decides that.
4. The broker looks the presented ticket's `id` up among the tickets it minted and hasn't burned, runs the checks below and burns the ticket it found, whatever the outcome. On a match it sends the request with the hub-rendered headers, adding only the credential, `Host` and the `Content-Length` of the exact body, never a `Content-Type` of its own.

The rendered headers hold exactly one `Content-Type`, whose value is the ticket's `contentType`, and `headersSha256` covers them. The plugin's own `Content-Type` is compared with the ticket's, then dropped with every other header the plugin supplied.

A send URL is canonical, so the request reaches exactly what the ticket names and no client rewrites it on the way:

- `https://`, no userinfo, and a host of lower-case DNS labels (letters, digits and inner hyphens, IDNs as A-labels) whose last label starts with a letter, so never an IP address, without a trailing dot;
- an optional port from 1 to 65535 without leading zeros, never 443;
- a path that starts with `/` and holds only RFC 3986 unreserved characters, sub-delimiters, `:`, `@` and percent-encoded octets in upper-case hex that never encode an unreserved character, with no `.` or `..` segment;
- an optional non-empty query of the same characters, `/` and `?` but no `'`; no fragment; at most 8,192 characters in all.

A WHATWG URL parser, as `fetch` uses, leaves such a URL unchanged, and the protocol's validator also refuses any URL it would change. A minted ticket that breaks these rules fails as `TICKET_INVALID`.

`ticketMismatch(minted, request, now)` runs the checks in this order and names the first that fails; `ticketMatches` is true when none does. The vectors pin the order with a case for each two adjacent checks that fail together.

| Code | Fails when |
|---|---|
| `TICKET_UNKNOWN` | the broker found no unburned ticket with the presented id: no ticket presented, a forged id, or a ticket already used |
| `TICKET_INVALID` | the ticket found isn't a `SendTicket`, or `now` isn't a safe integer |
| `TICKET_ALTERED` | the presented ticket isn't JCS-equal to the one found |
| `TICKET_EXPIRED` | `now` is after `exp` |
| `TICKET_INSTANCE_MISMATCH` | the calling plugin instance isn't the ticket's |
| `TICKET_METHOD_MISMATCH`, `TICKET_URL_MISMATCH`, `TICKET_CONTENT_TYPE_MISMATCH` | the request's method, URL or the plugin's content type differs from the ticket's, compared byte for byte without normalizing |
| `TICKET_HEADERS_MISMATCH` | the rendered headers' `headersSha256` differs, or they don't hold exactly one `Content-Type` equal to the ticket's: the same pairs in any order and name case match, any other change doesn't |
| `TICKET_BODY_MISMATCH` | the SHA-256 of the exact body differs |

Every refusal is audited. `TICKET_UNKNOWN`, `TICKET_ALTERED`, `TICKET_INSTANCE_MISMATCH`, `TICKET_METHOD_MISMATCH`, `TICKET_URL_MISMATCH`, `TICKET_CONTENT_TYPE_MISMATCH` and `TICKET_BODY_MISMATCH` are the plugin's doing: each also disables the plugin and alerts the owner's devices. `TICKET_EXPIRED`, and a ticket or headers the hub got wrong (`TICKET_INVALID`, `TICKET_HEADERS_MISMATCH`), fail the request alone.

`bodySha256` covers the exact request body. It is not reconcile's `textSha256`, which covers the normalized text part. `channel_send` returns the provider's id for the sent message when the response gave one; it is informational, since the broker classifies the response it observed itself.

### Reconcile and listen

- `channel_send_reconcile` lists, with their bodies, at most 50 messages the account sent since `attemptAt`, in an email thread or under a Message-ID (`rfc822MessageId`, with its angle brackets), or in a chat conversation or thread. The hub matches them itself and never resends; `complete: false` means the scan stopped early, and the hub asks again later.
- `channel_listen` holds the provider's event connection for a lease of 1 s to 10 minutes and signals new events with `host/changed`. The result is the lease granted; the hub renews it by calling again.

## Errors

Errors are `isError` results carrying `{code, retryAfterMs?, detail?}` with the codes of [`schemas/plugin-error-v1.schema.json`](../schemas/plugin-error-v1.schema.json): `AUTH_EXPIRED`, `AUTH_REVOKED` (which only starts the hub's own revocation check), `RATE_LIMITED`, `QUOTA_EXCEEDED`, `CURSOR_EXPIRED`, `NOT_FOUND`, `PERMISSION_DENIED`, `TRANSIENT`, `INVALID_INPUT`, `UNSUPPORTED`, `SEND_REJECTED` and `SEND_UNCERTAIN`. A tool a plugin doesn't serve, or an organize action it doesn't describe, fails with `UNSUPPORTED`.

## Versioning

A breaking change gets a new identifier (`…/channel-v2`) and major version, and the hub supports the current and the previous major for at least 12 months.

Every change to the exported schema, a description or an error code included, changes `schemaDigest`, and the hub refuses a plugin whose declared digest differs. So once this version is released, any edit to its schema refuses every installed plugin built on the earlier revision until it is rebuilt, unless the hub also accepts that revision's digest; whether it does is an open decision.
