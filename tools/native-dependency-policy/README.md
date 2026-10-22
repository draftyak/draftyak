# Native dependency policy

This private standalone tool validates the finite native dependency exception policy described in the M4 backlog. It does not register a default verification step, change the underlying strict cargo-deny policy, write approvals or renew exceptions.

From the checkout root:

```sh
node tools/native-dependency-policy/src/cli.ts check --phase item --format json
node tools/native-dependency-policy/src/cli.ts check --phase m4-gate --format json
```

An optional `--evidence-dir` names a new absolute directory outside every checkout. Existing directories, aliases, links and overwrites are refused. Without this option, evidence uses a fresh OS temporary directory. Captured native stdout/stderr stay in that directory; the result never prints native diagnostic prose or absolute paths. Preserve evidence privately when diagnosing a refusal.

The command emits one bounded JSON result. Exit 0 denotes `strict-pass` or `pass-with-scoped-exceptions`; exit 1 denotes a policy refusal; exit 2 denotes malformed, unavailable or incomplete evidence. An exception pass preserves the original audit exits and findings and must not be described as an advisory-free audit. The legacy policy permits zero exceptions in the gate phase. An explicitly renewed version-2 record uses release/fix termination instead; trusted terminal state refuses in every phase.

## Initial operational state

The checked-in authority record is deliberately refusal-only. The command loads the record from the current merged M4 repository revision, verifies its immutable content, and checks the current revision again before deciding. A changed PR-head record cannot authorize itself. Unavailable authority, an unknown state, missing actual-source confirmation or a terminal state refuses before native collection.

Current security-event delivery is not established. The production collector returns `BASIS_UNAVAILABLE` for an otherwise active record and starts no native workload. Pure normalization APIs and serialized `delivery` fields cannot establish that external evidence is independently current. Cached advisory database refs and repeatedly fetched old records are insufficient. No operational exception allowance is enabled by this package.

Activation requires a separately reviewed actual-source graph and explicit unchanged-scope confirmation in the established merged repository record, together with independently current advisory, release/dependency and security-event delivery. Relevant changes require review; an expanded scope requires a new decision. The original research graph is not an implementation or runtime attestation. Native acceptance and later profile/CI integration remain separate.

## Fixed bounds

The policy admits only the five exact advisory/package/version/source tuples in the reviewed backlog. It binds the full graph and every complete ancestor subgraph, exact lock and input bytes, resolved features, declared dependencies, target predicates, structured advisory classification/ranges, release/security basis and strict policy. Alternate roots, sources, configurations, changed inputs, malformed JSON, hidden errors and partial reports refuse.

The first review is due at `2026-10-27T13:15:04Z`; subsequent reviews are at most seven days apart. Relevant evidence changes and lock changes require a fresh review and strict audit with explicit scope confirmation. Evidence must remain less than one hour old through actual completion; collection-time observations may occur after the start and never after completion. A trusted host clock and exclusive input stability are explicit assumptions.

Version-1 active records retain `gate: "open"`, GLib's `2026-11-03T13:15:04Z` expiry, the other four rows' `2026-11-19T13:15:04Z` expiry and the earlier M4 gate boundary. They are never automatically renewed. A version-2 active record instead requires `termination: "release-or-validated-fix"` and the same actual-source confirmation, exact binding, review and exception fields. Its exception scope ends through delivered release closure or earlier validated-fix disposition, with the same weekly and event review. Neither the old fixed expiries nor the M4 phase alone end that explicitly renewed scope. No replacement calendar deadline or grace period is introduced, and the policy marker never changes a review timestamp.

Both schemas are closed. Version-2 terminal records are exactly `{version:2,state:"release-closed"}`, `{version:2,state:"removed"}` or `{version:2,state:"revoked"}`. They refuse before collection, including when a caller selects the item phase or expects a strict-only audit. Legacy terminal states also remain refusing. A reviewed reduction of the active exception subset must match the complete audit exactly; findings cannot silently disappear from the expected set, and an affected copy cannot remain after its row is removed. A strict pass requires an explicitly empty trusted scope and complete zero-exit audits. Terminal closure never fabricates such a pass or reactivates an empty record.

This versioned evaluator does not implement product-release delivery or independently assess fix compatibility. The existing crate release snapshots and upstream `release` events are not product publication evidence. Validated fixes still require all affected parent/target paths, exact locked pins and applicable native/security acceptance; a new version number alone is insufficient. Release/fix closure must arrive through the established current reviewed repository record. That delivery and assessment integration remains incomplete, as does current security-event delivery. Production remains refusal-only and `BASIS_UNAVAILABLE`; this component enables no operational allowance or expanded graph scope.

Native capture uses argument arrays, native executable checks, a restricted environment, fixed output/deadline bounds and per-run opaque receipts. Its process-tree and host limitations are documented in [capture-format.md](capture-format.md). Input, graph, strict JSON, audit and current-basis formats have separate package-local specifications and deterministic tests. Rust toolchain identity is a trusted-host boundary; a dispatcher hash does not attest an entire Rust distribution.

There are no policy, authority-ref, clock, platform, hash, feature, arbitrary command or serialized report overrides. This tool never changes a review date, exception tuple, gate state or audit ignore list.
