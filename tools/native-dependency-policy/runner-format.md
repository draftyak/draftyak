# Standalone policy runner

`runNativePolicy` composes the current authority loader, a fixed trusted native
producer, current-evidence revalidation and the existing decision evaluator.
Inputs contain only phase and injected authority/producer interfaces. A clock
callback is a pure-test seam; production uses `Date.now`. The CLI chooses its
fixed production factory and exposes no clock, ref, policy, source, serialized
DTO or report override.

The runner reads start time, loads and freezes current authority, then calls
`preflightDecision` before any native producer. The initial refusal-only record,
terminal records and invalid authority cannot start native collection. Normal
preflight policy refusal exits 1; malformed or unavailable authority exits 2.

`createNativePolicyProducer` is a trusted internal collector boundary. Creation
has no I/O. Its `collect` callback must obtain fresh native captures through the
opaque capture API, checked input snapshots and verified tool provenance, then
construct the validated report/graph/basis binding. Those producer obligations
are separate from this orchestration module's schema checks. Synthetic injected
collectors model them; a friendly object does not prove actual capture origin,
current source delivery or owner authorization.

The produced DTO binds a fresh UUIDv4 run ID, report/evidence digest, all seven
policy bindings, complete audit and four-category counts, independently known raw
tool exits/signals, observation time and immutable database/release/security
source revisions. Every member is closed and bounded. Digests are lowercase
64-character hex; source revisions are immutable 40- or 64-character hex. Audit
findings are restricted to the five exact bounded tuples and ancestor digests;
duplicates, extra members, sparse arrays, accessors and inconsistent counts or
raw completions refuse. Counts are at most one million per severity/category;
`unexpectedErrors` must equal total errors minus the scoped advisory findings.

The wrapper snapshots normalized DTO members and recursively freezes them before
any revalidation await. It issues a private WeakMap receipt tied to that exact
producer and opaque run context. Foreign, serialized, reused-context and replayed
receipts refuse; a previously used run UUID cannot be reminted. The process
tracks at most 100,000 issued run IDs, then refuses without eviction. The run
context contains phase and start time; the capture producer generates the actual
capture run ID during collection.

An expected producer refusal can retain a fully reconciled audit and its raw
exits while binding/source/observation fields are unavailable. Parser-invalid or
partial native outputs use `audit:null` and separately validated raw completions;
they never fabricate complete counts. A fixed refusal without any captured
report can have a null report digest. Any captured raw output or complete audit
requires its report digest. A malformed DTO is not accepted as evidence and
receives no invented audit. Arbitrary thrown messages are replaced with fixed
safe codes. The default production source-feed gap remains `BASIS_UNAVAILABLE`.

`revalidate(context,sealedDTO)` must freshly check native input/report identities
and current source revisions, returning the current report digest, binding and
source revisions. The runner compares these values with the frozen capture.
It then checks current authority even if collection/revalidation refused. Only
after both asynchronous stages finish does it read completion time. The decision
evaluator applies exact binding, review, source freshness and scoped finding
checks using that completion time. Version-1 records retain their fixed expiry
and M4-gate limits. Explicit version-2 active records instead require the closed
`termination: "release-or-validated-fix"` policy marker and retain the same
first/weekly review deadlines. The marker is not proof of product-release or
compatible-fix delivery. Neither a caller phase nor an upstream crate release
event supplies that proof. It cannot evaluate a partial refusal
as an operational pass. Current source delivery and final authority are mandatory;
cached or unavailable source feeds cannot activate exceptions.

Results contain `{exitCode,output}`. Output is versioned, deeply frozen and capped
at 32 KiB, with fixed verdict/reason, phase, authority revision/record digest,
run/report identity, binding, audit, raw completions and accepted scoped tuples.
Every valid captured count and underlying exit remains visible after a later
source/authority/policy refusal. Invalid snapshots have null audit; preflight
refusals have no invented native results. No absolute paths, capture contents,
dependency prose, error stack or subprocess stdout/stderr is returned.

Exit 0 denotes the evaluator's strict pass or explicitly scoped exception pass.
Policy changes, delivered terminal state, legacy expiry, overdue reviews and changed
authority/inputs/sources refuse with exit 1. Input, tool, malformed evidence and
unavailable producer/authority failures use exit 2. No code here approves,
reviews, renews, publishes or modifies policy records.

Version-2 `release-closed`, `removed` and `revoked` records refuse in preflight,
before evidence directory creation or a native producer. The final authority
revision check also refuses closure delivered during collection; the earlier
active record cannot supply a verdict. Legacy terminal records retain that
behavior. An explicit reduced active subset is compared with the complete
actual finding set, and does not authorize a new version, parent, target,
feature or graph. Empty actual findings cannot silently reduce the trusted
scope. No terminal record is treated as an empty successful audit.

Actual product-release closure ordering and independently validated compatible
fix assessment remain integration responsibilities of the existing reviewed
repository route. This module neither creates those facts nor checks arbitrary
record history for reactivation. It introduces no caller-selected status,
authority, phase, ref, clock or serialized proof. The initial checked-in record
and production `BASIS_UNAVAILABLE` remain unchanged.
