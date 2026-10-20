# Lookup planning and execution core

This private protected package is the pure/injected part of M7b. The owner
approved its package placement. Only the native `apps/hub/src/tools/` boundary
may import the protected root API in production. The narrow
`@draftyak/lookup-core/calendar` entry exports pure calendar functions and types
for the offline golden harness. The package is not a runtime authority boundary:
only the trusted hub may construct verified metadata, configuration, policy
verdicts, confirmations and execution hosts. Never expose `LookupRunner.run`
as a plugin, model or MCP capability.

## Public API

- `planLookups(verifiedMeta, ownerConfig, trigger, now)` produces calls and
  content-free skip reasons. It imports no content module. Only the account,
  channel, verified sender proof, hub-verified send recipient, sensitivity and
  automatic-trigger metadata are read. Extra message fields are ignored.
- `bindLookup` uses protocol-validated sources and arguments. Gmail sender
  proofs require one From mailbox, aligned headers and the topmost provider's
  DMARC pass; Slack proofs require a user id and a false bot flag. These facts
  must already have been established by hub ingestion. No SMS participant can
  bind. An owner-recipient binding instead uses a To/Cc recipient selected by
  the owner in a hub-verified outbound send, independently of inbound-sender
  proof. That recipient may be another person, not an owner mailbox. Raw
  incoming To/Cc, asserted direction, Reply-To and message content never supply
  this trusted fact. The native metadata builder remains an integration gate.
- Presets use the protocol's limits: five presets, one default, three items,
  at most one contact lookup. Selected/unticked items are respected. Duplicate
  instance/kind/argument calls are skipped. Automatic calls require direct,
  known-contact, non-bulk/list/no-reply metadata and a verified sender, target
  only local or cloud-no-train AI, and never include contacts or SMS. Missing
  SMS sensitivity is treated as sensitive; sensitive texts trigger no lookup.
  MCP and scheduled-claim triggers are always refused.
- Gates check enabled/non-quarantined instances, approved/current digest
  equality, active account × instance × AI-destination consent, and injected
  route verdicts for both arguments and results. AI destination ids and their
  classification are separate fields; consent always names the opaque id.
  Route queries name the actual tool-instance/AI-destination id and separately
  carry destination class, data classes, effect, channel and sensitivity.
  Owner/clock/constant arguments carry `hub.state`. The trusted adapter
  must evaluate the real consent, endpoint, training posture and Slack opt-in
  policy; a literal `true` from untrusted input is never evidence.
- Cloud tools receiving participant metadata require a confirmation bound to
  the job, account and exact instance/kind/arguments digest. The hub must mint
  this evidence only after the per-draft confirmation and never reuse job ids.

## Runner and resource rules

`new LookupRunner(host).run(plan, signal?)` accepts only the original frozen
object returned by `planLookups`; a copied, deserialized or hand-built plan is
refused before any host callback, even with a correct argument digest. This
object provenance does not establish current authorization or native approval.
The runner executes up to three unique calls in parallel and validates their
bounds again. It returns admitted context entries and their `c1`–`c3` ids, fixed
skip codes and one content-free `outcomes` record per issued call in plan order.
Each outcome names the ref, instance, kind, merged `ToolRunStatus` and monotonic
latency. Valid plugin errors retain only their code and optional `retryAfterMs`,
never `detail`; schema/size refusals retain a fixed refusal code. Known raw and
clean counts measure canonical UTF-8 data before and after hygiene; missing
counts mean that stage did not produce data. Cache hits include age at selection
and preserve original receipt provenance. The core never truncates results and
reports `truncated: false`. Host exceptions are never echoed.
Derivation flags must match the closed kind/channel rules before any host
callback, preventing a malformed plan from weakening Slack job isolation.

`LookupPlan.pendingConfirmations` supplies the original preset index, instance,
kind, sorted bound field names and exact argument digest for each cloud
confirmation skip. It contains no argument values and does not mint confirmation
authority. The trusted UI must bind approval to this draft/account and these
digests before planning again; it must also account for ordinary planner skips.

The injected host supplies raw discovery/list/call frames, fresh authorization,
hygiene, time, and stop/quarantine commands. Frames may be raw result objects or
JSON-RPC result envelopes, serialized as strings or bytes. They are capped and
parsed strictly by the protocol before use. The runner checks the exact tool
extension declaration, permits only tools and that extension, and checks the
canonical, complete tools list before every call and cache hit. Drift
quarantines locally and requests quarantine in the hub. The trusted hub may call
`releaseQuarantine(instance, digest)` only after reviewing and re-approving the
exact quarantined digest. A missing or mismatched quarantine refuses release.
Release invalidates that instance's cache and retains its hourly call budget;
it does not approve a digest, restore consent or bypass fresh authorization.
Cache invalidation and a new digest alone never release quarantine. Cleanup callback
failures, including rejected promises, are settled without blocking or throwing
the draft job; the host must separately report unhealthy process state.

`hygiene(kind, data, signal, provenance, jobId)` must return
`{data, findings: {instructions, delimiters}}`. The envelope and count keys are
closed; both counts must be whole nonnegative numbers at most 65,536. The runner
refuses incomplete or malformed findings instead of assuming none. Each call
and cache hit passes its current job identity and returns that job's validated
finding counts for native revision flags. Native adapters must adopt this
required result contract. Provenance uses the captured `hosts` array; a no-egress
tool has an empty array, never a fabricated host.

Each requested kind requires a positive safe-integer ceiling in the trusted
instance's `outputMaxBytes` facts. Missing or invalid ceilings fail closed.
`checkToolResult` receives that exact ceiling and still applies its shared kind
ceiling when lower; a tightened ceiling also invalidates an over-limit cache
entry. A native adapter must derive these facts from the reviewed manifest.
That manifest extraction remains a separate integration gate until the relevant
M1 manifest contracts are merged; the local facts are not a new wire contract.

Readiness, including discovery and listing, has its own ten-second deadline.
Once ready, the kind's five-second or calendar fifteen-second deadline covers
the call and presentation. Each phase's signal is aborted when it ends, including
success. Cancellation first aborts the actual call's signal. Only a call still
unanswered five seconds later requests a stop with
`{reason: "unanswered-call", jobId, invocation}`; an answered call or cache hit requests no
such kill. Slack-derived job cleanup separately requests
`{reason: "slack-job-ended", jobId}`. Host adapters must adopt these distinct
reasons and identities rather than treating every request as an immediate
process kill. `CallContext.invocation` is a fresh opaque symbol for each actual
call; an unanswered stop carries that same symbol. The native adapter must map
it to the original transport request, including multiple calls to one instance
and reused job IDs. Never serialize/stringify this receipt or derive authority
from a job ID. Existing one-argument hosts remain type-compatible but must update
before native integration. An adapter must honor signals. Synchronous infinite
loops in a trusted injected callback cannot be
preempted by this package's JavaScript timers.

Each actual call reserves a slot in the rolling 60-calls/hour instance budget;
cache hits do not. The host receives `acquireRequest()`, which must be called
before each broker request and refuses the fifth request. The permit closes
immediately when the actual call settles, before presentation, and on abort;
later use refuses with `REQUEST_CLOSED`. Structural GET/HEAD,
lookup-bound egress and secret substitution remain broker responsibilities;
the permit alone cannot constrain an adapter that bypasses the broker.

The cache contains only memory values, keyed by instance, kind and canonical
arguments, with an additional shared/job dimension. It lasts ten minutes,
checks the instance digest, evicts on backward clock movement, and clones every
read/write. Slack-derived arguments use the job id in the key, never share
across overlapping jobs, lose their entries when the job ends, and request
instance shutdown. Calendar cache entries retain validated busy intervals and
render slots again at the current time. Cancelled jobs discard their writes.
Call `invalidateAccount`, `invalidateInstance`, and `close` on revocation,
disable, disconnect and shutdown; fresh authorization is also mandatory before
readiness, after readiness, and before admitting data. Invalidation also aborts
matching per-call controllers retained until the whole job finishes, so delayed
fetches, cached hygiene and completed parallel siblings cannot return or restore
old data after revoke/regrant or quarantine release. Final authorization runs for
all calls before any context is admitted; each retained signal is checked again.
Other accounts/instances remain usable. Listener and active-call state is removed
on completion, and close aborts active jobs before dropping that state.

Raw results use the protocol's closed schema and ceilings, including the
20,480-byte calendar ceiling. Hygiene receives a clone; text kinds are checked
again afterward. Calendar output is produced here and hygiene may not change
its structure or values. Limits include provenance: at most 4,096 bytes per
context and 8,192 bytes per job in canonical UTF-8 JSON. Admission follows
planned order, so parallel completion cannot change which results fit. An
oversized context is refused whole. Cache entries are bounded at 256; the least
recently inserted entry is evicted when full. Rate state permits at most 256
active instances, refusing new ones until old counters expire. These additional
limits bound memory without dropping a busy interval or silently trimming data.

## Calendar choices

`calendarWindow`, `workingIntervals`, and `renderFreeSlots` use native Temporal.
The horizon counts the next 3, 5 or 10 configured working days. The UTC window
starts at the planning instant floored to a ten-minute bucket; the remaining-day
decision uses that same bucket instant, keeping the complete arguments stable
for cache reuse. The window ends at Temporal's first valid instant of the day
after the final working day, including when local midnight is skipped or folded.
Every rendering still uses the current instant for its one-hour lead time.
Intervals use the validated single same-day working-hours range; overnight
ranges are refused. A 76-day traversal
bound covers ten days even with one configured working weekday. Missing
Temporal, unknown zones, and ambiguous or nonexistent working-hour boundaries
fail closed instead of inventing availability. Working-hour boundaries retain
strict disambiguation; day boundaries use start-of-day semantics. Temporal
failures are reported as fixed `LookupError` values.

Both busy and tentative intervals remove time. Slots remain within the window
and working hours, start at least one hour ahead, last at least thirty minutes,
and are limited to twelve. Starts round upward to the next local quarter hour
before applying the thirty-minute minimum. Labels show local wall dates/times,
the owner's zone and its UTC offset; a slot crossing an offset change labels both
offsets. Schema-valid busy intervals are intersected with the requested window
before subtraction, and wholly outside intervals are ignored. The renderer never emits event
text or raw busy intervals to drafting contexts.

## Sources and later integration

The approved plan's sections 4 and 5 define tool-v1 and Context lookups. Shared
schemas, presets, canonical lists, frames and result rules come directly from
[`@draftyak/protocol/tool-v1`](../protocol/src/tool-v1.ts), corresponding to
[`spec/extensions/tool-v1.md`](../../spec/extensions/tool-v1.md).

Later work must provide hub-owned verification and routing adapters, endpoint
classification, the SDK/stdio/process supervisor, pre-spawning for UI chips,
consent admin operations and lifecycle invalidation, actual broker request
enforcement, hygiene workers and instruction flags, spotlight delimiters and
provenance in prompts, `tool_runs` hashes, audit/notification wiring, and UI.
Native notification wiring remains required: authenticate each instance's
`notifications/tools/list_changed`, re-list and compare its complete canonical
surface even while idle, then quarantine, evict/fence pending work and alert the
owner's devices on drift. Unchanged canonical lists grant no authority and do not
reset ordinary TTL/hourly budgets. A changed-then-restored surface remains
quarantined until trusted reviewed-digest release; notification failures must be
bounded and alerts content-free. The package's pre-call/hit checks and cache
invalidation API alone do not establish this native event path.

No database, persistence, SDK server, network client, credential handling,
account-policy store or UI is implemented here. The existing engine and this
package's synthetic tests establish core behavior; cross-provider and full hub
security suites still belong to integration.

The [M7b backlog](../../docs/roadmap/m7b.md) defines owned integration paths,
acceptance tests and pending native/owner gates. Calendar choices preserved here
do not establish ADR 0015 acceptance or permission to schedule or send anything.

Repository tests scan inventoried tracked product runtime sources and the dedicated
golden harness without evaluating their modules,
including static, side-effect, export and dynamic ESM imports. Package identity
comparisons cover case variants that Windows resolves to the same package and
known workspace-link paths. The audit refuses CommonJS `.cjs`/`.cts` files,
parsed `require`, `module`, `createRequire`, `getBuiltinModule` and `mainModule`
loader references, including literal, cooked template and concatenated keys in
member access and binding patterns. Declarations, assignments and defaults refuse
unresolved computed binding keys on known process/global sources, including named
nested process/global fields. Parentheses and optional-chain wrappers preserve
that recognition through each known-global member chain within the same bounded
depth check. Ordinary data destructuring remains usable; the
check does not infer arbitrary aliases or loader argument flow.
Unresolved computed access to `process` or the Node global objects also refuses;
ordinary object/array indexing and non-loader global properties remain usable.
The audit refuses Node's `module` builtin and unresolved `#` package-import
aliases rather than infer loader data flow or alias configuration. These forms
require explicit boundary review. Strings, comments and erased type imports do
not create runtime edges. This source audit is not an arbitrary-code sandbox.
It rejects protected
imports from MCP, providers, plugins and other callers, and rejects external deep
imports. Only the package and the protected native tools boundary (plus its
explicit test paths) may import the root entry; the test-only calendar harness
may import the public calendar entry. The current injected host call is audited
as runner-only. Actual `tools/call` transport ownership requires the future
native adapter and is not established by that source audit.

The M11 ownership configuration must install CODEOWNERS for `/packages/lookup-core/**` and
`/apps/hub/src/tools/**`, protect the ownership file, and require the trusted hub
owner/team's review with stale approvals dismissed after changes. No CODEOWNERS
file exists on this base. Installing those rules on integration/release branches
and enabling the branch protections remain required; no root ownership or
protection file is changed here.
