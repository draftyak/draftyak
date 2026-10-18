# `io.github.draftyak/tool` v1

> **Status: draft, normative.** It becomes binding at the M1 gate and then changes only through contract PRs; a breaking change gets a new identifier. `@draftyak/protocol/tool-v1` implements it, and the files under [Files](#files) are generated from that module.

A tool plugin answers lookups that the hub plans, binds and starts: it never chooses what to look up, never sees message content and never talks to a model. The hub authors every tool a tool plugin serves, down to the last byte of its description and schemas.

Terms used below:

- **Kind**: one kind of lookup, such as `calendar.freebusy`. A plugin's manifest declares the kinds it serves.
- **Tool instance**: one configured copy of a tool plugin, running as its own process.
- **Lookup job**: one call the hub makes to a kind's tool or to `tool_probe`. A plugin's network access exists only inside one.

Instants are UTC milliseconds as safe integers, text limits count Unicode code points, and canonical JSON is RFC 8785 as [the spec README](../README.md) defines it.

## Declaration and capabilities

- A tool plugin speaks MCP 2026-07-28 only and declares this extension in `server/discover` under `capabilities.extensions` as `{"version": 1, "schemaDigest": …}`. The digest is the SHA-256, in lower-case hex, of the canonical JSON of [`schemas/tool-v1.schema.json`](../schemas/tool-v1.schema.json). That document holds every canonical entry, so any change to a tool's bytes, down to a description, changes the digest; [`vectors/tool-v1/tools-list.json`](../vectors/tool-v1/tools-list.json) records the declaration. The hub fails closed on a missing declaration, another version or an unknown digest.
- Its capabilities are `tools` and this extension, nothing else: no `prompts`, `resources`, `completions`, `logging` or `io.modelcontextprotocol/ui`, and no tool carries `_meta`. Install fails on anything more, and a later change quarantines the plugin.
- The hub offers a tool plugin no elicitation, sampling or roots. A plugin therefore never asks anyone anything: an `InputRequiredResult` is refused, and a result never carries a `resource_link`.
- Tools are never offered to a model, and lookups and their results are never reachable over the hub's own MCP server.

## Tools

A plugin serving some kinds lists exactly these tools:

| Tool | Arguments | Result |
|---|---|---|
| `tool_describe` | none | `kinds`: the kinds this instance serves, 1 to 16 dotted lower-case names, no repeats; the hub checks them against the manifest. The entry names no kind, so a kind added later leaves it unchanged |
| `tool_probe` | none | `status`: `ok`, or `degraded` when the upstream answered with something the plugin can't fully use, such as an empty or partly unreadable feed; `bytes`: what the upstream returned; `items`: what the plugin found in it, such as events, notes or entries. Status and sizes only, never data |
| one per declared kind | the kind's arguments | the kind's result |

The hub authors each entry: `name`, `title`, `description`, `inputSchema` and `outputSchema`, nothing else. [`vectors/tool-v1/tools-list.json`](../vectors/tool-v1/tools-list.json) holds every entry with its canonical JSON and SHA-256. [`schemas/tool-v1.schema.json`](../schemas/tool-v1.schema.json) holds each entry as a `const` (such as `CalendarFreebusyEntry`) and its schemas (such as `CalendarFreebusyArguments`) for SDKs that generate types.

A plugin's `tools/list` result is **canonical** when its `resultType` is `"complete"` and its `tools` hold exactly the entries for its manifest's kinds, compared by name in any order, each equal to its entry as canonical JSON. A changed title, description or schema, an added field anywhere in an entry (`annotations`, `icons`, `execution`, `_meta`, `$schema`), and a missing, extra, repeated or renamed tool all break it. The list arrives in one page, so a `nextCursor` is drift too. `ttlMs` and `cacheScope` are ignored: the hub lists again whenever the rules below say so. SDKs serve the entries as given rather than deriving them from their own types.

The hub checks the result exactly as the plugin sent it, parsed from its frame (Results below). A copy that an MCP client library has decoded can't be checked, because decoding may drop members the library doesn't know, such as an injected field or a `"__proto__"` property.

- **At install** the hub lists the tools; a list that isn't canonical fails the install.
- **Before every lookup job**, and on `notifications/tools/list_changed`, the hub lists them again. Any drift quarantines the plugin and alerts the owner's devices; a quarantined plugin runs no lookup until the owner reviews it.

## Kinds

| Kind | Arguments | Result | Data class | Ceiling | Timeout |
|---|---|---|---|---|---|
| `calendar.freebusy` | `window {start, end}`, `tz` | `busy[] {start, end, status}`, at most 200 | `tool.calendar.freebusy` | 20,480 bytes | 15 s |
| `contact.notes` | `participant` | `notes[] {label, text}`, at most 5 | `tool.contact.notes` | 4,096 bytes | 5 s |
| `kb.lookup` | `topic` | `entries[] {label, text}`, at most 5 | `tool.kb.lookup` | 4,096 bytes | 5 s |

Every object is closed: all its members are required and no others are allowed. The hub binds and sends every argument of a kind, so a manifest's `tool.kinds[].inputs`, which the install dialog shows, names all of them. `order.status` is deferred. No kind takes free text, a URL or a value taken from message content; only `contact.notes` takes a message-derived value, the participant the hub binds.

- **`calendar.freebusy`.** `window` is UTC milliseconds with `start` before `end`; `tz` is the owner's IANA zone, for floating times. The result holds busy times only, never a title, attendee, location or any other event text. `status` is `busy` or `tentative`, and the hub treats both as busy. Intervals are sorted and merged: each starts before it ends and ends before the next one starts, so none overlap or touch. An interval merged from busy and tentative times is `busy`; one merged only from tentative times stays `tentative`. A result over the ceiling fails the lookup and is never truncated, since a dropped interval would read as free time.
- **`contact.notes`.** `participant` is a verified email address or a Slack user id that the hub binds, never a display name, a phone number or a bot id. An address keeps its local part as given (a dot-atom) and has a lower-case ASCII domain, internationalized labels as A-labels and no trailing dot; a Slack user id is `U` or `W` and 2 to 20 upper-case letters or digits. Each note has a `label` of at most 64 characters and a `text` of at most 1,000.
- **`kb.lookup`.** `topic` is an owner-defined topic id, `^[a-z0-9][a-z0-9-]{0,63}$`. Each entry has a `label` of at most 64 characters and a `text` of at most 2,000.

`tool_describe` and `tool_probe` results have a ceiling of 4,096 bytes. A lookup's timeout counts from the moment its call reaches a ready instance; spawning has its own 10 s limit.

## Results

What a tool plugin returns is untrusted data, used only as described here.

1. **Frames.** A message from a tool plugin of more than 65,536 bytes, not counting the line terminator (LF or CR LF) that ends it on stdout, is dropped unparsed. Every other message is parsed strictly, as canonical JSON is: a repeated member name or a lone surrogate drops it.
2. **Result type.** A `tools/call` result carries `resultType: "complete"` and a `content` array, as MCP 2026-07-28 requires. A missing `resultType` or `content`, `input_required` and any other value are refused.
3. **Content.** `content` may hold only text blocks, which the hub ignores. A `resource_link`, an embedded resource, an image, audio or any other block is refused, in an error as anywhere else.
4. **Structured content.** Only `structuredContent` is used. It must be an object of at most the kind's ceiling, or the manifest's smaller `output.maxBytes`, counted as the UTF-8 bytes of its canonical JSON. Over that, the result is refused, never truncated. It must then match the tool's result schema and the rules above.
5. **Errors.** An error is a result with `isError: true`, no `structuredContent`, and a [`PluginErrorResult`](../schemas/plugin-error-v1.schema.json) `{code, retryAfterMs?, detail?}` under `_meta["io.github.draftyak/error"]`, with the codes channel and AI plugins use. Keeping errors out of `structuredContent` means it always matches the tool's `outputSchema`, as MCP requires, so an MCP client that validates results accepts errors too. A 401, 403 or 404 on a `url-secret` fetch is `AUTH_REVOKED`: the hub probes the address again and marks the instance as needing a new address.

| Refusal | When |
|---|---|
| `TOOL_FRAME_TOO_LARGE` | a message over 65,536 bytes, dropped unparsed |
| `TOOL_FRAME_INVALID` | a message that isn't strict JSON |
| `TOOL_RESULT_INVALID` | a result that isn't an object, a missing or unknown `resultType`, or a missing or malformed `content` or `isError` |
| `TOOL_RESULT_INPUT_REQUIRED` | an `InputRequiredResult` |
| `TOOL_RESULT_CONTENT` | a content block other than text |
| `TOOL_RESULT_TOO_LARGE` | `structuredContent` over the limit |
| `TOOL_RESULT_OFF_SCHEMA` | missing, invalid or non-JSON `structuredContent`; an error with `structuredContent` or without a valid `PluginErrorResult` |

The hub then hygiene-filters the text fields, caps each result and each draft's context, and shows the model what it used only inside delimited, labelled context. A result carries its kind's data class and the class of any message-derived argument it was called with.

## Bindings

**Content never reaches tool inputs (invariant I5).** The hub binds every argument before any model runs, from a closed set of sources. Message bodies, subjects, display names, unverified headers, plugin- and device-asserted metadata and model output are never sources.

| Source | Gives | Data class |
|---|---|---|
| `const` | a value fixed in the preset | `hub.state` |
| `owner` (`field`: `zone` or `workingHours`) | the owner's setting | `hub.state` |
| `clock` (`horizonDays`: 3, 5 or 10; default 3) | a window over the next working days | `hub.state` |
| `participant.verifiedSender` | the latest inbound sender the hub verified | the account's `.metadata` class |
| `participant.ownerRecipient` | the owner's own To or Cc from sends the hub verified | the account's `.metadata` class |

Each argument takes only some sources:

| Kind | Argument | Sources |
|---|---|---|
| `calendar.freebusy` | `window` | `clock` |
| | `tz` | `owner` with `field: "zone"` |
| `contact.notes` | `participant` | `participant.verifiedSender`, `participant.ownerRecipient` |
| `kb.lookup` | `topic` | `const`, a valid topic id |

The hub verifies participants only on Gmail accounts (a single From mailbox with the topmost provider DMARC pass, aligned with the From domain) and Slack accounts (the API user id, never a bot or `username` post). So `participant.*` never binds on an SMS account, whose sender numbers the phone asserts, whatever becomes of SMS, nor on a plugin channel, whose metadata the plugin asserts. A contact lookup is skipped when DMARC fails or the address came only from Reply-To.

The hub checks each preset for the account's channel as its own records give it: `gmail` or `slack` for its first-party Gmail and Slack channels, `sms`, or `{"plugin": <id>}` for any other channel plugin. It never takes the channel from anything a plugin declares, such as its manifest id, so a plugin named `gmail` is still a plugin channel.

### Context presets

The owner picks lookups per account in presets: at most 5 presets, exactly one of them the default, each with at most 3 items and at most one `contact.notes` item, so a draft runs at most 3 lookups and at most one contact lookup. An item is `{toolInstance, kind, bindings, onDemand, autoDraft}`: the instance's id, the kind, one binding per argument of the kind and no others, and whether it runs on drafts the owner asks for and on automatic drafts.

An `autoDraft` item binds only `hub.state` sources and is never `contact.notes`: automatic drafts send no message-derived value to any tool.

| Problem | When |
|---|---|
| `PRESET_INVALID` | an item or preset that doesn't have this shape, such as an unknown member, kind or instance id |
| `PRESET_BINDING_FIELD` | an argument left unbound, or a binding for an argument the kind doesn't take |
| `PRESET_BINDING_SOURCE` | a binding outside the closed set, or a source the argument doesn't take |
| `PRESET_BINDING_VALUE` | a `const` the argument refuses |
| `PRESET_AUTODRAFT` | an `autoDraft` item with a `participant.*` binding or of kind `contact.notes` |
| `PRESET_PARTICIPANT_CHANNEL` | a `participant.*` binding on an account whose participants the hub doesn't verify |
| `PRESETS_TOO_MANY` | more than 5 presets |
| `PRESETS_DEFAULT` | presets without exactly one default |
| `PRESET_CONTACT_ITEMS` | a preset with more than one `contact.notes` item |

Every lookup also needs an active consent for the account, the tool instance and the draft's AI destination, and the routing rules for the argument's data class. Before a `cloud-tool` instance receives a message-derived value on a draft the owner asked for, the owner confirms that draft's lookups once.

## Egress

A tool plugin's egress rules follow the `tool-*` profile. Each rule is:

| Member | Value |
|---|---|
| `class` | `read` |
| `method` | `GET` or `HEAD` |
| `host` or `url` | `host`: a public DNS name of two or more lower-case labels, never an IP address or a name under `localhost`, `local`, `internal`, `home.arpa` or `onion`, reached over HTTPS on port 443; or `url`: `secret://<name>`, one of the manifest's url-secrets |
| `maxBytes` | the response body cap, 1 byte to 32 MiB |
| `timeoutMs` | 1 ms to 15 s |

Any other member, method or class, a `ws` rule, `saveAs` or a `send` block fails install.

The hub enforces the rest on every request:

- A request belongs to a lookup job the hub started, at most 4 per job; anything else is denied and audited.
- It matches a rule exactly, follows no redirects and stays within the rule's caps.
- Request headers other than `Accept`, `If-None-Match` and `If-Modified-Since` are stripped. The plugin gets back only `Content-Type`, `ETag`, `Last-Modified` and `Content-Length`.
- A tool plugin's host channel is `host/fetch` (GET or HEAD, no `saveAs`), `host/log` and a memory-only `host/kv.*`, nothing else.

### url-secret

A `url-secret` is an address the owner enters, such as a calendar's secret iCal link. It is entered only in the desktop approval window or the hub's CLI, as an admin op, and the hub probes it once and shows its host, size and status before saving it. The plugin only ever sees `secret://<name>`.

The hub accepts an address only when, after any surrounding white space is removed:

| Refusal | Rule |
|---|---|
| `URL_SECRET_INVALID` | it parses as a URL |
| `URL_SECRET_NOT_HTTPS` | its scheme is `https`, or `webcal`, which is shown and stored as `https` |
| `URL_SECRET_TOO_LONG` | it has at most 2,048 characters |
| `URL_SECRET_USERINFO` | it has no user name or password |
| `URL_SECRET_HOST` | its host is a public DNS name: two or more lower-case labels, never an IP address, and nothing under `localhost`, `local`, `internal`, `home.arpa` or `onion` |
| `URL_SECRET_FRAGMENT` | it has no fragment |
| `URL_SECRET_NOT_CANONICAL` | it is exactly the URL an HTTP client sends, so nothing is resolved, decoded or re-encoded on the way: no dot segments, back slashes, tabs or spaces, a lower-case host as A-labels, no default port, and a path |

`%40` and every other percent-escape stay as the owner entered them. Names reserved for documentation, such as `.example`, pass these rules and fail at the probe; tests use them.

A plugin fetches the address as `secret://<name>`, exactly: an added path, query, fragment, port or user name is refused. The hub replaces the reference with the stored address byte for byte and never percent-decodes or rewrites it.

## Files

- [`schemas/tool-v1.schema.json`](../schemas/tool-v1.schema.json): each canonical entry as a `const`, and each tool's argument and result schemas, under `$defs`; the declaration's `schemaDigest` is its hash.
- [`vectors/tool-v1/tools-list.json`](../vectors/tool-v1/tools-list.json): the declaration; the canonical entries with their canonical JSON and SHA-256; each kind's data class, ceiling and timeout; for every set of kinds, the tool names in order and the SHA-256 of the list's canonical JSON; and `tools/list` results with the answer a canonical-list check must give.

`pnpm --filter @draftyak/protocol spec` and `vectors` regenerate both from `packages/protocol/src/tool-v1/`, and `pnpm test` fails when they drift.
