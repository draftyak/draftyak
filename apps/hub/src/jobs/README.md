# Durable native work

Register `JOB_MIGRATIONS` and `EVENT_MIGRATIONS` as the `jobs` and `events`
namespaces when constructing `HubStore`, then migrate them after the audit
foundation. The build stages their SQL beside the compiled entry point, in
distinct directories. The existing audit SQL is staged under
`store/migrations/audit`.

`WorkDatabase.write` owns a short synchronous `HubStore.write` transaction.
Its frozen scope exposes the actual transaction for consumer state and audit;
jobs and events accept only live scopes from their issuing coordinator. A
failed jobs/events mutation poisons the scope even when its caller catches the
error. Consumers propagate mandatory audit failures so their state and audit
roll back together. An expired scope or an engine-rolled-back write cannot
issue authority.

`JobQueue` accepts only canonical IDs and the closed sync, draft, retention and
reconcile kinds. IDs are metadata, not proof of current account authorization.
There is no send job. Consumers still check their actual account, policy and
generation before applying a result. Claims use a native partial unique index
for one RUNNING job per account and execute inside BEGIN IMMEDIATE.

Leases last 30 seconds. Completion, failure and renewal consume an opaque,
queue-bound capability and recheck its persisted token, scope, state and
expiry. Renewal rotates the token. An enclosing rollback never revives a
consumed in-process capability. A process-local monotonic deadline also
refuses work after elapsed lease time despite a backward wall jump.

Restart does not imply ownership of another process's work. Recovery only
retires persisted wall-expired leases, in batches of at most 100. A backward
wall jump can delay recovery until wall time reaches the stored expiry.
Expired final attempts fail; retries have at most 20 attempts and a requested
delay of at most one day. A current lease fences durable mutations; it does
not cancel an already-running asynchronous operation or authorize side effects.

Events contain closed kinds, canonical ID lists and data-class metadata, never
message bodies, credentials or arbitrary payloads. Their durable sequence and
contiguous retention floor support bounded refetch after missed events.
Authenticated streams, revocation and device-bound cursors belong to the API
consumer; a native sequence number confers no authority.
