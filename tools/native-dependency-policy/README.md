# Native dependency policy

This private standalone tool validates the finite native dependency exception policy described in the M4 backlog. It does not register a default verification step, change the underlying strict cargo-deny policy, write approvals or renew exceptions.

From the checkout root:

```sh
node tools/native-dependency-policy/src/cli.ts check --phase item --format json
node tools/native-dependency-policy/src/cli.ts check --phase m4-gate --format json
```

An optional `--evidence-dir` names a new absolute directory outside every checkout. Existing directories, aliases, links and overwrites are refused. Without this option, evidence uses a fresh OS temporary directory. Captured native stdout/stderr stay in that directory; the result never prints native diagnostic prose or absolute paths. Preserve evidence privately when diagnosing a refusal.

The command emits one bounded JSON result. Exit 0 denotes `strict-pass` or `pass-with-scoped-exceptions`; exit 1 denotes a policy refusal; exit 2 denotes malformed, unavailable or incomplete evidence. An exception pass preserves the original audit exits and findings and must not be described as an advisory-free audit. The gate phase permits zero exceptions; trusted terminal state closes the exceptions in every phase.

## Initial operational state

The checked-in authority record is deliberately refusal-only. The command loads the record from the current merged M4 repository revision, verifies its immutable content, and checks the current revision again before deciding. A changed PR-head record cannot authorize itself. Unavailable authority, an unknown state, missing actual-source confirmation or a terminal state refuses before native collection.

Current security-event delivery is not established. The production collector returns `BASIS_UNAVAILABLE` for an otherwise active record and starts no native workload. Pure normalization APIs and serialized `delivery` fields cannot establish that external evidence is independently current. Cached advisory database refs and repeatedly fetched old records are insufficient. No operational exception allowance is enabled by this package.

Activation requires a separately reviewed actual-source graph and explicit unchanged-scope confirmation in the established merged repository record, together with independently current advisory, release/dependency and security-event delivery. Relevant changes require review; an expanded scope requires a new decision. The original research graph is not an implementation or runtime attestation. Native acceptance and later profile/CI integration remain separate.

## Fixed bounds

The policy admits only the five exact advisory/package/version/source tuples in the reviewed backlog. It binds the full graph and every complete ancestor subgraph, exact lock and input bytes, resolved features, declared dependencies, target predicates, structured advisory classification/ranges, release/security basis and strict policy. Alternate roots, sources, configurations, changed inputs, malformed JSON, hidden errors and partial reports refuse.

The first review is due at `2026-10-27T13:15:04Z`; subsequent reviews are at most seven days apart. GLib expires at `2026-11-03T13:15:04Z`, the other four rows at `2026-11-19T13:15:04Z`, and the earlier M4 gate ends all five. There is no grace or automatic renewal. Evidence must remain less than one hour old through actual completion; collection-time observations may occur after the start and never after completion. A trusted host clock and exclusive input stability are explicit assumptions.

Native capture uses argument arrays, native executable checks, a restricted environment, fixed output/deadline bounds and per-run opaque receipts. Its process-tree and host limitations are documented in [capture-format.md](capture-format.md). Input, graph, strict JSON, audit and current-basis formats have separate package-local specifications and deterministic tests. Rust toolchain identity is a trusted-host boundary; a dispatcher hash does not attest an entire Rust distribution.

There are no policy, authority-ref, clock, platform, hash, feature, arbitrary command or serialized report overrides. This tool never changes a review date, exception tuple, gate state or audit ignore list.
