# Extension module contracts

`@draftyak/extensions` defines the eight native extension points, the scoped
registry and module descriptors. This package supplies contracts and metadata
validation; module loading, authorization and adapters belong to M2. It is
private until an explicitly approved release.

```ts
import { approvalCount, defineExtensionModule } from "@draftyak/extensions";

export default defineExtensionModule({
  id: "example",
  version: "0.0.0",
  async register(registry) {
    registry.sendPolicy({
      id: "example-owner-floor",
      async evaluate() {
        return { kind: "require", approvals: approvalCount(1) };
      },
    });
  },
});
```

The registry registers transport, certificates, push, backup, identity, send
policy, audit and workspace providers. It exposes module-owned structured table
operations, namespaced migration declarations, admin-operation registration,
device routes and ID-only events/log references. It has no core database,
credentials, key material, broker, executor, tickets, scheduling, clock,
statement verifier, plugin host, device-host adapter or tool runtime.

`SendPolicyResult` is only `deny` or `require`. `approvalCount` accepts a positive
safe integer; ordinary numeric values are not assignable to its branded type.
`require(1)` means no restriction beyond the native owner/PIN floor. Core ANDs
every policy with its own decision, takes the stricter approval requirement and
never lets roles omit the owner. Propose, claim and every retry run policy; a throw or
two-second timeout denies proposal or fails claim with `policy_error`. Frozen
snapshots and flags reuse the authoritative protocol types. This package does
not implement policy execution, deadlines or approval consumption.

`db()` provides no raw SQL or connection handle. For module `example`, the table
type is `ext_example_${string}`. Operations are structured, with explicit bounded
selection and synchronous transactions; transaction callbacks receive no nested
transaction method. M2 must independently validate identifier syntax, ownership,
page limits, primitive values, copied results and callback lifetime. It must use
the module's own SQLite3MC file and `ext/<id>` derived key. TypeScript annotations
do not validate arbitrary runtime values or prevent explicit casts.

`defineExtensionModule` validates plain own data properties, a lowercase module
ID and exact version, then freezes a descriptor without invoking registration.
An optional migration directory must be absolute, canonical and contain only
plain, singly linked `NNNN_<name>.sql` files. Numbers start at `0001` and cannot
repeat. The declaration admits at most 256 files; names use lowercase ASCII and
digits separated by single underscores, matching the native migrator grammar.
The name component is at most 96 characters. Directory aliases, subdirectories, linked files,
loose versions, accessors, proxies and unknown descriptor fields are refused
with one generic error. Windows UNC/device/alternate-stream directory paths are
refused before filesystem lookup, as are DOS device components, control characters
and components ending in dots/spaces. `COM0`/`LPT0` are conservatively refused too.
These lexical checks do not identify mapped network drives or assert storage locality.
No migration SQL is read or executed here.
Each migration-directory admission closes its own directory exactly once in
`finally`. A close error refuses that descriptor; independent later admissions
remain usable. The validator retains no global directory state and never retries
an uncertain close.
The native migrator must recheck pinned files, reject transaction/control SQL,
enforce `ext_<id>` table ownership and apply each migration atomically.

The Hono device-route environment is deliberately empty. The core mounts those
routes only under L2 `/ext/<id>/*`, after native mTLS and current authorization;
registration grants no listener or authentication bypass. Admin handlers run
only after native signed-statement and PIN verification. Identity providers
return login identities without approval capability. Workspace access is
intersected with core ownership and routing.

Push accepts a fixed kind and optionally device-sealed bytes. Backup targets
receive only sealed state and catalogue metadata; the hub must enforce their
refused data classes before disclosure and exclude Slack content from cloud
backups. `AuditSink.append` takes the merged protocol's deeply readonly `AuditEvent`,
including its actor and ID-only references; event notifications expose only its
ID, timestamp, action and references. Logger
adapters must validate module-owned action codes and ULID references. These
interfaces do not prove that opaque bytes were sealed correctly or that a
caller-supplied string is an ID; native adapters enforce those conditions.

Transport injection provides raw TLS bytes to the native verifier. Relay
challenge signing is a bounded, relay-domain native operation, never general
statement signing. [The relay architecture and wire-profile gate](../../spec/relay-protocol-v1.md)
record the transport design and the details that require a separate review.

Modules are trusted in-process code. The registry is an API and review boundary,
not a sandbox; a malicious native module can use platform APIs independently.
Exact version/hash checks, admin approval, fail-closed adapters and hostile
integration tests remain mandatory in M2. No free implementation, listener,
loader, commercial integration or relay server is supplied here.

Acceptance: `pnpm --filter @draftyak/extensions typecheck`, `test` and `build`.
Compile-time security tests use both `expectTypeOf` and `@ts-expect-error`; tests
must run together with typechecking, since a runtime runner alone does not check
the negative type assertions.
