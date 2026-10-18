# Plugin manifest v1

`draftyak.plugin.json` is an inert JSON declaration validated by
`@draftyak/protocol/manifest`. The normative structural schema is
[`plugin-manifest-v1.schema.json`](plugin-manifest-v1.schema.json), JSON Schema
2020-12. `validateManifest` also checks relationships the schema cannot express.
Consumers must call `validateManifest`; `PluginManifestV1.parse` alone checks
shape and cannot replace native policy validation. It returns `{ok:true, manifest}` or `{ok:false, problems:[{code}]}`. Problems contain
fixed codes, never package-provided values. Unknown fields are refused.

Validation grants no right to install, enable, launch, read an account, obtain a
credential, disclose data or send. Native authority must independently verify the
installed package, owner, current account/instance generation, permissions and
applicable request verifier. A profile name never substitutes for that verifier.
There is no positive registry or owner-registration API in this contract.

## Identity and runtime

`id` is an exact lowercase npm package name, optionally scoped; `version` and `sdk`
are exact SemVer strings, never tags, ranges or URLs. The SDK major must equal the
extension contract major. This version accepts only major 1:

| `kind` | `contract.extension` | `contract.version` |
|---|---|---|
| `channel` | `io.github.draftyak/channel` | `1` |
| `ai-provider` | `io.github.draftyak/ai-provider` | `1` |
| `tool` | `io.github.draftyak/tool` | `1` |

`isolation` is exactly `standard`. `runtime` may be `node` or omitted; omission means
Node operationally and remains omitted in the validated declaration. Every other
runtime yields `RUNTIME_UNSUPPORTED`. Python and dynamic-agent OAuth need their
separate contracts before they can be accepted.

Any `sms.*` data class, `sms-text-v1` renderer or `host:*` capability is
`CLOSED_TO_PLUGINS`. Before schema checking, a conservative scan examines every
member named `render`, `dataClass`, `dataClasses` or `capabilities` at any depth,
including json-template constants and body containers. String values, including
elements of nested arrays, associated with `render` equal to `sms-text-v1`, or
with `dataClass` or `dataClasses` starting `sms.`, refuse. A `host:*` key or string
anywhere under `capabilities` refuses too. Other nested objects are scanned by
their own member names. Thus a constant
named `render` with value `sms-text-v1` is closed too. This rule includes extension
maps and applies even when another field would fail structural validation.
Device-hosted channels require native authority and cannot become plugins.
Manifest capabilities are otherwise not a supported field; MCP capabilities are
validated separately as part of the pinned discovered surface.

## Authentication, credentials and limits

`auth` has `kind`, `scopes`, `requiredGrantedScopes` and optional
`modes:{read_only:{scopes,requiredGrantedScopes}}`. The closed kinds are
`oauth2-pkce-loopback`, `manifest-app`, `api-key`, `token-paste`, `url-secret` and
`none`. Scope arrays contain unique, visible-ASCII strings. Each required set
must be a subset of its own mode's requested set. Read-only scopes need not be
a subset of full-mode scopes: Gmail read-only may request `gmail.readonly` where
full mode requests `gmail.modify`.

Only `oauth2-pkce-loopback` has an `endpoints` object. It requires `authorization`
and `token`, and may include `revocation`; each is a canonical HTTPS URL with a
public DNS hostname. Other kinds reject endpoints. OAuth state, secrets, provider
identity checks and effective grants remain native responsibilities.

`credentials` is `{mode:"brokered",urlSecrets:[{name,label,help}]}`. Names are
unique; labels and help are bounded plain text. Values, tokens and owner URLs
never belong in the manifest. A tool rule's `secret://name` must name a declared
entry. Actual address entry, validation, probe and storage require native admin
approval; the plugin receives only the reference.

Tools accept only `url-secret`, `api-key` or `none`. `url-secret` is required
exactly when both nonempty `urlSecrets` and a `secret://` rule are declared;
every rule reference must name a declared secret. Without that auth kind,
neither URL-secret declarations nor references are accepted. The exported
`AUTH_VARIANTS` list in `manifest/auth.ts` is the additive schema seam: later
contracts add their actual variant there and its inferred auth types follow.
`manifest/auth-fields.ts` owns the shared `scope`, `scopes`, `mode`, `authFields`
and `authScopesValid` descriptors/check. Both the variant union and a later
variant module import these fields from that module, without a cycle or another
copy of the scope grammar. Scope strings have 1..256 visible ASCII characters;
arrays have at most 128 entries.

`permissions` is a closed object with optional boolean `dataDir`. Omitted or false
does not request an own-data-directory grant. Tool plugins permit only false or
omission. A request is never an effective grant.

`dataClasses` contains unique shared data classes, excluding `credentials` and
`hub.state`. Tool declarations must match their kinds' output classes exactly;
other plugins cannot declare tool classes. Community metadata/content names use
the shared data-class grammar. Names do not authorize reading those classes.
Gmail profiles accept only `gmail.*` classes and `slack-v1` only `slack.*`.
Rules-based channels refuse both protected families.

Optional `sync` is `{initialWindowDays:1..3650,pollIntervalMs:1000..86400000}`;
tools cannot declare it. Optional `rateLimits` is
`{requestsPerMinute:1..60000,concurrency:1..16}`. These are bounded declarations,
with defaults and stricter effective limits chosen natively. `license` is a
bounded, nonempty declaration displayed at install; validation is not a legal
license-policy decision.

## Egress and tool declarations

Channels select exactly one of `{profile:"gmail-v1"|"gmail-readonly-v1"|"slack-v1"}`
or `{rules:[...]}`. General rules are closed objects containing `class`, `method`,
`host`, `pathTemplate`, optional `query`, `maxBytes` and `timeoutMs`. Hosts are
public DNS names; paths are absolute path templates without URL schemes, query,
fragments, backslashes or dot segments. Literal segments may use only the canonical
path octets below; percent escapes use upper-case hex. Read methods are GET/HEAD/POST, organize
methods POST/PUT/PATCH/DELETE and send methods POST/PUT/PATCH. Responses are capped
at 35 MiB and timeouts at 30 seconds. These declarations cannot override native
DNS/address/port/redirect checks, credentials or ticket requirements.

Read/organize paths use named wildcard segments `{name}`, where names match
`[A-Za-z][A-Za-z0-9_]{0,31}`. A wildcard matches exactly one nonempty canonical
`SendUrl` path segment. Send binding segments match this same grammar when the
broker classifies a request without a ticket: a matching send rule is send-class,
never an unmatched request that can fall through to another class. `PathSegment`
from `manifest/egress.ts` defines the grammar for literals, wildcards and send
bindings. Raw octets are unreserved characters plus `!$&'()*+,;=:@`; escapes are
exactly `SendUrl`'s canonical upper-case percent octets, excluding `%2F` and `%5C`.
The segment is nonempty, never `.` or `..`, and contains no raw slash or backslash.
Escapes of unreserved characters, such as `%41` or `%2E`, are noncanonical and
refuse. Both `!abc:example.org` and `!abc%3Aexample.org` are valid segments.
Declared path templates retain their 2048-character total bound; matched rendered
paths retain `SendUrl`'s 8192-character URL bound. In particular a 256-character
provider id can expand to 768 percent-encoded bytes without a separate
256-byte wildcard ceiling. Literals match byte for byte. Their `query` is an optional unique list of up to
32 parameter names: omitted names are allowed, undeclared or duplicate names
are refused, and values remain untrusted request data. Omitted `query` allows
no parameters. For example, `/v1/conversations/{id}/messages` with
`query:["limit","cursor"]` describes paged reads without destination bindings.
The broker checks method and host exactly, then each path segment, then query
names; redirects and alternate encodings do not bypass that comparison.

Send rules instead use the destination bindings and exact query-binding map
below. A request may match rules of only one class. Installation refuses
cross-class overlap on the same method and host: two paths overlap when they
have the same segment count and every pair is equal literals after exactly one
canonical percent-octet decode followed by ASCII-only case folding, or includes
a wildcard/binding. For example `!abc%3Aexample.org` and `!abc:example.org` overlap.
No Unicode case folding, UTF-8 interpretation or repeated percent decoding occurs:
`%FF` is compared as one octet, and `%253A` does not become `:`. This conservative overlap check
includes read/organize overlaps too; the broker's literal matching remains byte
for byte. Query constraints never make an otherwise overlapping path
safe. This prevents read or organize classification from bypassing send tickets.

AI providers declare one API-shape profile from the exported `AI_HTTP_PROFILES`
list in `manifest/ai-http.ts`: `messages-api-v1`, `responses-api-v1` or
`chat-completions-v1`. An additional contract appends one entry to that list.
These declarations define no adapter or runtime capability. Native verifiers
still bind owner-configured endpoints/models and recheck configuration, DNS,
routing and consent; no generic fallback or local/LAN permission is inferred.

Tool egress is `{rules:[ToolEgressRule...]}`, reusing the shared tool-v1 grammar:
read class, GET or HEAD, public `host` or `secret://name`, at most 32 MiB and 15
seconds. No POST, WebSocket, organize/send class, `send` block, `saveAs`, custom
header field or alternate rule field is accepted. The broker's credential and
header restrictions remain mandatory.
An empty `rules:[]` explicitly means no egress and a `local` tool destination;
the `egress` object remains required. It never permits an undeclared request.

`tool.kinds` is a unique list of closed `{kind,inputs,output}` objects:

| Kind | Required input field names | Output class | Maximum bytes |
|---|---|---|---|
| `calendar.freebusy` | `window`, `tz` | `tool.calendar.freebusy` | 20,480 |
| `contact.notes` | `participant` | `tool.contact.notes` | 4,096 |
| `kb.lookup` | `topic` | `tool.kb.lookup` | 4,096 |

The unique `inputs` list must equal all of the kind's fields, in any order;
subsets and duplicates are refused. It declares fields, not values or binding authority.
Canonical argument/result schemas, native planner bindings, participant
verification and exact discovered tools remain shared tool-v1 requirements.

## Sending and constrained templates

A channel without `send` is read-only. Every `send` declaration has `render`.
Built-in renderers are `gmail-rfc5322` (only `gmail-v1`) and `slack-postmessage`
(only `slack-v1`); their declarations have no other fields, including no
`constants` map, even an empty one. Their bytes are produced by native renderers.
Only `json-template` declares a required `constants` map. `json-template`
also requires `template` and an explicit general send rule. Constants are named
JSON primitives, at most 32 entries; strings are at most 4096 characters.

A template contains exactly `rule`, `path`, `query`, `headers` and `body`:

```json
{
  "rule": 0,
  "path": ["v1", "channels", {"bind":"chat.channelId"}, "messages"],
  "query": {"reply":{"bind":"chat.threadTs"}},
  "headers": {"content-type":"application/json"},
  "body": {"type":{"const":"msgtype"},"text":{"bind":"body.text"},"footer":{"bind":"body.footer"}}
}
```

For this example the selected send rule declares
`pathTemplate:"/v1/channels/{chat.channelId}/messages"` and
`query:{reply:"chat.threadTs"}`, while constants declares `msgtype:"m.text"`.
`rule` is the zero-based rule index. Literal path segments must match the selected
rule byte for byte. A variable segment must bind to the exact typed variable
declared there; a fixed destination cannot replace it. Query names and their
bindings must match exactly. The method and host come exclusively from that rule.
The template binds either a chat destination or email recipients. A chat template
must bind `chat.channelId` in its path or query; `chat.threadTs` and `outbox.id`
cannot supply that destination. An email template must bind at least one of
`email.to`, `email.cc` or `email.bcc` in its path or query. Mixed chat/email
families are refused. An outbox binding alone never supplies a destination.

Supported path bindings are `chat.channelId` (snapshot `chat.channelId`),
`email.to`, `email.cc`, `email.bcc` (the corresponding snapshot email arrays)
and `outbox.id` (snapshot `outbox`). Query bindings additionally allow
`chat.threadTs` (snapshot `chat.threadTs`), omitted entirely when absent for a
top-level message. It cannot appear in a path or body binding. A channel-only
template remains valid for top-level messages. If the frozen chat snapshot
contains `threadTs`, native rendering must refuse when the selected template
does not bind `chat.threadTs` in its query; the channel binding alone cannot
replace the approved thread destination. This check precedes ticket minting
and applies again at claim-time rendering. Other absent required values
refuse rendering. Renderers percent-encode each bound segment separately,
refuse `.` and `..`, and encode `'` as `%27` in query values. No binding reads
message body, display names, plugin metadata, source fields or clocks here.

Each email query binding emits one parameter per address, in snapshot array
order, with the same name repeated; an empty array emits none. Query names are
processed in ascending UTF-16 order, retaining each field's recipient order.
For example `to:["first@example.com","second@example.com"]` with query binding
`to:email.to` produces `to=first%40example.com&to=second%40example.com`.
An email path binding requires its field to contain exactly one address; zero
or multiple addresses refuse rendering. Renderers percent-encode the whole
address as one segment, including `@`, `+`, query delimiters and any other
reserved character. They never join addresses with commas or reinterpret an
address as a URL. Query values use the same UTF-8 encoding, leaving only RFC 3986
unreserved characters literal. Before rendering an email template, refuse a
snapshot with a nonempty recipient field that the template does not bind. Every
frozen To, Cc and Bcc recipient must reach the rendered destination. All these
checks precede ticket minting and apply again to claim-time rendering.
`spec/vectors/manifests/bindings.json` gives valid and refused rendering inputs;
M2.18 implements and consumes that contract.

Header names are exactly `content-type` and `accept`.
`content-type` is required and exactly `application/json`, without parameters.
The optional values match `^[!-~](?:[ -~]*[!-~])?$`, at most 1024 characters,
so padding, controls and non-ASCII values are refused. All other names,
including credentials, cookies, routing, forwarding, framing and method
overrides, are refused. Native credential injection also refuses any collision;
no plugin header selects an injected secret. A constant `idempotency-key` header
is refused; bind `outbox.id` in the path or query so each outbox item has its own
idempotency key.

The body is an object/array tree with only `{bind:"body.text"}`,
`{bind:"body.footer"}`, `{bind:"body.textWithFooter"}` or `{const:"declaredName"}`
leaves. `body.textWithFooter` is derived solely from the frozen snapshot: its exact
value is `body.text + (body.footer === "" ? "" : "\n\n" + body.footer)`. No trimming,
normalization or other separator is applied; an empty footer adds no characters.
For example, channel-hello's single-member body is
`{"text":{"bind":"body.textWithFooter"}}`; its outbox id binds in the query.
The template must contain exactly one joined leaf and no separate text/footer
leaves, or exactly one `body.text` and one `body.footer` leaf and no joined leaf.
Missing or repeated text/footer leaves refuse, including when the frozen footer
is empty. Other `body.*` names need a contract amendment. No source or
clock-derived binding exists. Constant references must be declared; a
constant-only body cannot replace approved content.
A future renderer must distinguish a leaf by its string-valued `bind` or `const`,
not merely by that property name: containers may legitimately have those keys.
Constants and the exact rendered request must be shown in the trusted native
approval window, with constants identified as “set by plugin”.
String constants, labels, help and license text refuse controls, bidi controls,
tags and all default-ignorable points from pairing's shared hidden and joiner
lists. Those exported range lists and every tuple are immutable; consuming
them cannot change `DisplayName`. Text is neither trimmed nor normalized.

This item implements grammar, not native rendering. Email recipient arrays use
the explicit serialization, escaping and completeness rules above and the
[shared binding vectors](vectors/manifests/bindings.json). A native implementation
of those rules is still required; no join, first-element or implicit string
coercion is authorized. Unsupported rendering remains denied. Every
usable native renderer must be deterministic, hash/check exact bytes, re-render
at claim, and pass the broker's exact one-use ticket gate.

## Pins and install review

The five digest helpers return lowercase SHA-256 of JCS, after bounded inert-JSON
checking. `manifestDigest` covers the complete declared manifest, `egressDigest`
the declared egress object, `sendTemplateDigest` the complete `send` object
(including constants and template), `toolKindsDigest` the declared `tool.kinds`
array, and `surfaceDigest` the object `{capabilities,tools}` from discovery and
tools/list. Object-member order is irrelevant; array order and omitted fields
are preserved. No defaults, stripping or schema repair are applied before hashing.
Any declaration/template change changes the relevant pin, even when equivalent
operationally. Native install/upgrade approval must pin the accepted declarations
and complete discovered surface independently.
Manifest/declaration digests keep the 256-KiB, 16-level inert-JSON bound.
`surfaceDigest` has a separate one-MiB discovery bound, 65,536 nodes/elements
and JCS's 64-level ceiling. Member names are limited to 256 UTF-16 code units;
ordinary JSON Schema property names including
`constructor` and `prototype` are allowed. Non-data hooks, proxies and malformed
Unicode still refuse. The eventual transport frame limit must be at least this
surface ceiling; accepting a digest does not authorize or execute the surface.

The install dialog must show exact package/version, sha512 and provenance,
scopes for each mode, every egress rule/class, data classes, requested permissions,
license and actual native spawn command. It must show template constants and
literal routing, plus each tool kind's input fields and their data classes, output class/ceiling and
that it never receives message content. A URL-secret rule is shown as “the address
you enter later; its host is shown then”. No scripts run during install; native
inventory verification, owner approval, surface quarantine and account setup
remain required before execution.

The JSON boundary refuses duplicate keys, accessors, proxies, hidden/symbol or
prototype members, invalid Unicode/non-JSON values, cycles and sparse arrays.
It caps input/canonical JSON at 256 KiB, depth at 16, nodes at 8192 and arrays at
1024 elements. Each string value is at most 32,768 UTF-16 code units. Every member
name is at most 256 UTF-16 code units and cannot equal `__proto__`, `constructor`
or `prototype`; these bounds apply before namespace and schema checks, even inside
constants. Semantic problem codes are stable: `MANIFEST_INVALID`,
`MANIFEST_POLICY_INVALID`, `RUNTIME_UNSUPPORTED`, `CLOSED_TO_PLUGINS`,
`TEMPLATE_INVALID`, `TEMPLATE_RULE_MISMATCH`, `TEMPLATE_BINDING_INVALID` and
`TEMPLATE_CONSTANT_UNDECLARED`. Schema validation alone does not replace these
bounded/relational checks.

The first problem is deterministic, in this order: (1) inert-JSON bounds and
syntax (`MANIFEST_INVALID`); (2) closed host/SMS namespaces;
(3) runtime support; (4) structural schema; (5) tool class/auth/secret coherence
or non-tool tool-class refusal; (6) channel profile/class binding and
cross-class path overlap; (7) send renderer/profile and template checks.
Template checks parse the three declarations, then rule index/class, path
length/segments, query-name equality and bindings, supported destination,
declared body constants, and the exactly-once approved body/footer binding rule.
Structural header errors therefore precede semantic template errors.

`manifest/runtime.ts` owns `runtimeFields`, `RuntimeDeclaration` and
`runtimeSupported` as one future runtime seam. Its current node-only check and
fields are spread/consumed by the manifest without separate hard-coded runtime
policy. Runtime omission is never filled into the digested declaration.
