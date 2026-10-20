# MCP surface v1

This draft contract fixes the first-party MCP shapes shared by the hub, clients and passive views.
`packages/protocol/src/mcp.ts` exports the validators. The generated
`schemas/mcp-surface-v1.schema.json` contains named definitions under `$defs`; its root accepts
nothing. This is a contract item, with no listener, credential minting or successful authentication.

## Tools and authority

`McpScope` contains only `inbox:read`, `inbox:organize`, `drafts:write` and `outbox:propose`.
`MCP_TOOLS` fixes the seventeen names, titles, scopes, session classes and four annotation hints.
The classes are `read`, `draft` and `organize`. Send-request status uses `read`; creating and
cancelling a request use `draft`. There is no send, approval, scheduling, administration or plugin
scope. Proposed scheduling belongs to a pending send request; it never grants permission to send.
The runtime advertises only implemented handlers available to the current principal. Annotation
hints describe operations and grant no authority. Resource templates must retain their corresponding
tool's scope and read-session class, even when discovery projects only a subset of the catalogue.

Every authenticated attempt, including a malformed call, refusal or retry, receives one admission
charge. Before executing an operation, the hub resolves current authority and intersects the
principal's scopes, account allowlist, routing policy and device-approved session. Returned-body
charges share the protected operation's transaction. Resource reads use the same decision and
counters as the corresponding tool. Agent-token API requests use the same policy. The catalogue
and schemas grant no rights.
Cancellation must preserve proposing-principal identity and allow only that principal's requests.

## Resources

Only `draftyak://guide/agents` is enumerable. The four templates are
`draftyak://conversation/{id}`, `draftyak://message/{id}`, `draftyak://draft/{id}` and
`draftyak://send-request/{id}`. Each maps to its named tool and uses session class `read`.
The first three require `inbox:read`; send requests require `outbox:propose`.

`parseResourceUri` validates the original string before URL normalization. Schemes and hosts are
exact lowercase, IDs are canonical uppercase ULIDs and there is exactly one path component.
Userinfo, ports, query, fragment, percent encoding and trailing slashes are refused. The two
fixed `ui://draftyak/` view URIs are accepted but never enumerate user data. The guide and view
documents need authentication, with no mail session. Resources never support subscriptions.
The guide is bounded to 8,000 characters. Mail resources return one bounded plain-text item,
with the same untrusted-data framing as their tool and no attachment bytes.

## Prompts and completion

The four prompt names are `triage_inbox`, `summarize_thread`, `draft_reply` and
`prepare_send_request`. All arguments are optional, and unknown arguments are refused. Account
arguments use owner-chosen aliases, never provider names. `window` is `24h`, `72h` or `7d`
(default `24h`); `tone` is `brief`, `neutral` or `warm`. Object identifiers are ULIDs.
Scope filtering happens before arguments are returned. Authentication remains a hub duty.

Prompt text must be a fixed template using only the name and validated arguments. It may link
to the guide and the named object; it must contain no fetched mailbox data, labels, contact names,
addresses, bodies or subjects. Rendering templates and the MRTR account form belong to M8.

Completion returns at most twenty aliases or fixed window/tone values, after scope filtering.
Callers supply only aliases already projected through the current allowlist and routing policy.
Resource variables and object IDs complete to nothing. There is no completion input for contacts,
subjects, labels, phone numbers or lookup results. Runtime enforces a separate sixty-per-minute
bucket and audits argument names/counts without typed prefixes.

## Results and passive views

`message_get` returns `MessageGetResult`: the complete `MessageGetContent` in
`structuredContent` and exactly one text mirror in `content`. The email branch
`McpEmailMessage` reuses the shared `EmailMessage` metadata and delivery provenance and adds
a required `body: {untrusted: true, text, truncated?: true}`. Its plain-text field is bounded
to 40,000 code points before applying the smaller complete-result budget. A full 40,000-character
body therefore cannot fit alongside its mirror. The chat branch is the unchanged shared
`ChatMessage`, including its existing untrusted `text`. No HTML, attachment bytes, resource
links or view metadata are added. Provenance identifies delivery; it does not establish that
message text is true or safe to follow.

`messageGetTextMirror` constructs deterministic JSON text of the entire returned message,
including provenance, between `<untrusted-message-json>` and `</untrusted-message-json>`
on their own lines. The JSON uses canonical member ordering, then escapes `<`, `>`, `&`,
U+2028 and U+2029 as JSON Unicode escapes. It is deterministic JSON text, not canonical JCS
bytes. JSON escaping keeps data from injecting framing lines. `MessageGetResult` requires
the exact mirror of its own structured message and applies the same combined canonical-JCS
character count as the other results. Portable schema users must enforce this equality and
combined budget too; the JSON Schema describes structural restrictions only.

This read-result shape is an explicit MCP projection, not a change to the synced email entity.
The M3 conversation-view adapter must project the already parsed `ParsedMail.body.text`
without running hygiene a second time and set `truncated: true` when
`ParsedMail.body.removals.truncated > 0` or when the result budget requires further cutting.
Any further cut must preserve well-formed text and be marked before constructing both
representations. Unparsed emails remain absent from every view. The native adapter must retain
the persisted message's metadata and provenance, run the normal account/session/routing checks,
and apply both the character and estimated-token budgets before returning it through a tool or
resource. This contract supplies none of those runtime authorizations or a conversation view.

Single-object draft and send-request results contain structured data, one text mirror and one
resource link to their own ID. Link names are exactly `draft-<ULID>` or `send-request-<ULID>`;
they never contain sender names or subjects. The runtime must create a delimited mirror from
the validated data, visibly marking untrusted text and provenance. A list carries no object links.

The draft view accepts bounded body text, flags, provenance, a reliability notice, context reference
IDs, an optional linked send request and an optional word diff. `TOOL_*` flags expose code and
severity without free-text details; directly agent-written revisions require `AGENT_AUTHORED`,
which later owner edits may retain. It has no field for lookup output,
owner notes or privileged controls. `draft_update` requires a diff against the immediately previous
revision. Its spans are untrusted, complete words; the inserted/equal spans reconstruct the current
body. Before serving a diff, the hub must call `checkWordDiffSources` with the actual persisted
previous and current bodies; equal/deleted spans must reconstruct that previous body too.
An incomplete body cannot claim a complete diff. Email and chat are supported; an SMS
contract is deferred to its separate approved item.

Send results carry the send-request ID, eight-character uppercase fingerprint, lower-case state
and the fixed instruction to approve on the paired desktop with a PIN. `needs_reapproval` requires
a persisted reason. A proposed schedule pairs `notBefore` with `zone`; the frozen `scheduled`
state also requires `deliverBy`, strictly after `notBefore`. These instants are UTC milliseconds,
matching the shared entity wire contracts. Creating returns only `pending_approval`; cancelling
returns only `cancelled`. Neither is an approval. The hub remains responsible for actual state,
zone validity, immutable snapshot matching and authoritative transitions.

The complete serialized result, both representations and links together, is limited to 40,000
characters. Runtime must also enforce 20,000 estimated tokens over the complete result. Views are
passive text-only projections and never issue tool calls. `_meta.ui` is optional and can only name
the corresponding fixed view with `visibility: ["model"]`; the hub applies protocol/capability
and per-principal view gates before including it.

## Errors and request state

Application errors outside JSON-RPC's reserved block are `1001 AGENT_SESSION_REQUIRED`,
`1002 SCOPE_REQUIRED` and `1003 RATE_LIMITED`. Each carries a readable bounded message and
the matching `data.code`; rate-limit errors also carry a nonnegative `retryAfterMs`.
`McpSessionRequiredResult` is the tool-side refusal: `isError: true`, one readable
text item and `_meta["io.github.draftyak/error"]: {code:"AGENT_SESSION_REQUIRED"}`.
It carries no `structuredContent` and grants no authority. Plugin errors and the
shared hub error-code list are unchanged. Foreign-account IDs must remain indistinguishable
from absent IDs. Session-pending resources use `1001` in both protocol eras, with readable
paired-desktop instructions. Missing resources use `-32602` on `2026-07-28` and `-32002` on the
three supported 2025 revisions; the message is `Resource not found: <uri>` and data is exactly
`{uri}`, echoing only the canonical requested URI. It reveals no actual resource identity or
existence. JSON-RPC errors and tool error results are distinct channels.

Producers choose readable error messages from safe templates; they must not copy mailbox content,
credentials, arbitrary exception text or caller-chosen unknown field names. The public prompt,
completion and resource parsing helpers expose fixed refusal messages. Direct schema validation
returns diagnostics for local validation; callers must not forward those diagnostics as wire errors.

`snapshotMcpParams` produces a strict, deeply frozen JSON snapshot for validation and dispatch.
It preserves the complete parameter object, including `_meta`, `requestState` and `inputResponses`;
validation and dispatch must use that snapshot rather than rereading the original object.
Authorization digests use that same snapshot. The snapshot itself conveys no authentication or
approval authority.
`paramsDigest` is lowercase SHA-256 over JCS(params) after removing exactly the top-level
`_meta`, `requestState` and `inputResponses`. Nested fields with those names remain bound.
The digest skips omitted members without reading their values; full snapshot validation includes
those members before they are consumed by a transport or handler.
Non-JSON values, accessors, oversized documents and malformed Unicode are refused with a fixed
error. Property order does not matter. The input is never mutated.

`McpRequestState` holds version, epoch, grant/token principal reference, method, parameter digest,
pending ID and expiry. Epoch is a nonnegative safe integer, matching pairing and
the signed statements. Its fields carry IDs and hashes only. The later SDK HMAC codec must use
the dedicated `mcp-state` subkey, a ten-minute lifetime and at most five open pending IDs per
principal. On retry the hub checks identity, current epoch, method, digest, both clocks and atomic
single-use pending consumption, then repeats the complete authorization pipeline. A form answer
or authenticated request state cannot approve a session or send. ADR 0004 selects readable
pending-session errors; no session-approval URL or `/status` resource is introduced here.
The account-choice form is the only MRTR convenience in this surface. It is modern-only and
requires form capability on that particular request; a bare `elicitation: {}` also declares form
support under the pinned SDK. URL-only capability does not. `clientInfo` never enables a mode.

## Signed agent sessions

`agent-session.v1` is registered with the common TypeScript and Rust statement parsers and shared
signing vectors. Its precise signed fields and runtime checks are in `approval-v1.md`.
It binds a grant or token, account, tool class and either a chosen duration or one exact call.
The signing challenge lasts at most two minutes; accepted session and per-call lifetimes are
separate. Parsing a signed form is only an input check: PIN, exact pending-record matching,
current device/principal rights, routing, revocation and transactional consumption remain mandatory.

## Portable schemas and semantic checks

Generated JSON Schema preserves structural restrictions, enums, scalar bounds and declarative
dependencies. Validators must additionally run semantic checks for field equality, message mirror equality, time ordering,
valid Unicode, complete diffs and combined page limits. JSON Schema cannot compare sibling ID
values, reconstruct a diff or prove current authority. TS and Rust verify the same statement
vectors; both-way signing and mutated-field tests cover the added statement type.
