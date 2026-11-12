# Attempted-egress recorder primitives

This private package provides a test-only observation session, a bounded result
reader and destination assertions. It records attempts before policy dispatch,
including policy refusals and failures before a fake receives a request.

The current writer always emits `scope: "component"`. Synthetic callbacks and the
loopback TCP adapter exercise the recorder itself. They do not intercept a hub
process or observe direct plugin sockets under production flags. Native hooks
remain with the supervisor and broker after those implementations merge.

```ts
import { createRecorder, assertDestinations } from "@draftyak/egress-recorder";

const point = {
  id: "hub-point",
  caller: { kind: "hub" as const, instanceId: "test-hub" },
};
const target = { host: "upstream.example", port: 443, transport: "tcp" as const };
const recorder = createRecorder({ profile: "test", observers: [point] });
const observer = recorder.observer(point.id);
await observer.observe(target, {
  policy: () => false,
  resolve: () => { throw new Error("No DNS expected"); },
  connect: () => { throw new Error("No connection expected"); },
});
observer.complete();
const result = recorder.finish();
assertDestinations(result, {
  scope: "component", observers: [point], canary: false,
}, [target]);
```

`observe()` records synchronously before evaluating policy. It advances through
policy, DNS and connection callbacks, and returns a fixed outcome when a callback
fails. Successful callback values go only to the caller, never into the result.
An operation timeout defaults to 1,000 ms and must be 1–30,000 ms. Signals reach
each callback; deadlines and closure prevent subsequent stages after late
settlement. The callbacks are trusted test adapters, not a JavaScript sandbox.

`activateTestOnly(profile, callback)` gates installation and test-upstream
overrides before invoking the callback. Both it and `createRecorder` reject any
profile except the explicit string `"test"`. There is no environment override.
Future native composition must place observer and fake wiring behind this gate.

## Version 1 result and reader

The JSON root has exactly `format: "draftyak.egress-recorder"`, `version: 1`,
`scope: "component"`, `state`, `observers` and `attempts`. Each observer contains
its ID, caller kind and instance ID, lifecycle state, attempt count and canary
verdict. Each attempt contains an observer ID, contiguous sequence number,
destination `{host, port, transport}`, outcome and stage. Caller identity is
resolved through the observer roster. No URL, path, query, credential, request or
response content, arbitrary error, canary value or content digest is retained.
Instance and observer IDs are bounded metadata tokens, not proof of identity.

Outcomes are `succeeded`, `refused`, `failed` or an incomplete `pending`; stages
are `policy`, `dns` and `connect`. A refusal is a policy outcome. A DNS or
connection failure is a completely observed attempted connection, and still
participates in destination assertions. Results are not runtime permission or
an attestation of the producer's instrumentation.

`readResult(input, requirements)` requires the consumer's exact observer and
caller roster and expected scope. It never trusts a report to choose its own
required coverage. Unknown fields, versions, scopes, malformed UTF-8, duplicate
keys, trailing JSON, invalid metadata, inconsistent counts and sequences are
refused. Missing observation, failed observation and complete zero-attempt
observation remain distinct. An active observer, pending attempt or truncated
result cannot become a complete report. A component report cannot satisfy a
consumer requiring native coverage.

Limits are 1 MiB of encoded result JSON, 64 observers, 1,024 attempts, 64 pending
operations and 1,024 canary scans per session. Overflow poisons the session rather
than dropping records and claiming completion. Metadata rejects proxies, accessors
and unknown members before reading values. Records and bounded array slots use
own-data snapshots; results and validated metadata are detached and frozen.
`finish()` seals the session once, aborts pending observation and never upgrades
a failed/missing observation on late completion. Calling observation or scanning
after an observer completes fails the still-unsealed session without dispatch.

`assertDestinations` checks every attempted destination, including denied and
failed attempts, against an exact bounded host/port/transport list. A refused
synthetic CDN, package-index or undeclared tool destination still fails it.

## Canary observation

`observer.scanCanary(generatedBytes, payloadChunks)` scans an explicitly supplied
byte stream, preserving only a fixed verdict: `unobserved`, `observed-clean`,
`matched` or `failed`. The pattern is 1–256 bytes; KMP prefix bookkeeping detects
matches across chunk boundaries without retaining payloads or content digests.
The private pattern and prefix table are erased at cleanup. The caller still
owns its original buffers.

A scan accepts at most 1 MiB and 4,096 chunks, with the same bounded deadline as
other observation. These are recorder resource limits, not Gmail/MIME or broker
payload guarantees. Invalid input, overflow, a stalled source or observation
closure fails the observation. Cleanup does not wait for a source's noncooperative
return hook. Matches and failures are sticky across later scans.

The consumer sets `canary: true` to require clean canary coverage from every
required observer. Missing scanning, a failed budget or a match fails closed.
An explicitly observed empty stream can be clean; zero attempts alone never
implies that a payload source was observed. Destination checks do not infer
canary results. The consumer owns which source streams must be submitted and
must retain controls that fail when its actual observation point is removed.

Iterator factories, callable `next` operations and object completion results
are required; missing or primitive results cannot stand in for clean EOF.
Ordinary iterator `done` coercion and getters retain JavaScript semantics.
Patterns and chunks use their actual Uint8Array byte elements and intrinsic view
length, including Buffer/subarray offsets. Custom iteration, length, buffer or
species properties do not redefine the bytes scanned or the resource budget.

## Remaining native acceptance

M2.16/M2.17 must bind real hub/plugin identities, install process/socket and broker
observation hooks, cover all attempts including refusal before DNS/socket/fake,
and connect actual payload sources to canary scanning. Direct plugin attempts
under production flags, actual hub interception and denied native test overrides
remain composed acceptance, not established by the local adapter. M7b.5,
M7b.10, M2c's no-CDN check and M11.7 consume this format through their own hooks
and require their actual coverage; they must not copy its reader or treat
component fixtures as native evidence.

Run the package tests, typecheck and build through the workspace. Tests use
synthetic callbacks and ephemeral `127.0.0.1` listeners; named index/CDN targets
are refused synthetic metadata and are never contacted.
