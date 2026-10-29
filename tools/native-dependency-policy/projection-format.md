# Cargo projection version 1

`projectCargoGraph(metadata, paths, affected)` is a pure library function. It does
not approve a policy, discover authority, select a trusted revision, evaluate cfg
expressions or establish the provenance of supplied metadata. The runner must
produce locked all-feature metadata without a platform filter, validate sources
and configuration, and supply realpath-contained workspace bindings. Production
affected tuples come from trusted policy state, with no CLI override.

Workspace bindings match each package ID and each target's name, kinds and exact
metadata source path. The relative manifest/target paths are canonical
slash-separated ASCII repository paths; empty/dot/parent/absolute segments,
backslashes and non-ASCII paths refuse. Casing is retained, and conflicting case
aliases refuse. No source, feature, cfg or Unicode string is normalized. A new
repository path vocabulary requires a reviewed format change. Registry identities
retain their exact source URI. Root IDs, workspace members and default members
are distinct sets, and default/root entries must belong to workspace members.

Strings must contain Unicode scalar values. Unknown metadata keys, accessors,
duplicate identities/nodes/edges, missing targets/bindings, dangling references,
inconsistent legacy dependency lists and unreachable packages refuse. Snapshots
of own data properties prevent validation/projection rereads. The runner still
compares the complete count/digest with its trusted expected graph: a self-consistent
smaller graph cannot establish that the expected graph was captured.

All canonical payloads are ordered tuple arrays. Unordered rows sort by unsigned
UTF-8 bytes of their `JSON.stringify` encoding; string lists use unsigned UTF-8
byte order. Declared feature/requested-feature list multiplicity is retained;
identity sets and resolved features reject duplicates. The encoding is
`JSON.stringify(payload)` encoded as UTF-8. SHA-256 receives the domain followed
directly by those bytes, including the domain's final NUL byte:

- Graph domain: `draftyak/native-dependency-policy/graph/v1\0`
- Ancestor domain: `draftyak/native-dependency-policy/ancestor/v1\0`

The tuple schema is:

```text
identity = [source|null, name, version, workspaceManifest|null]
selection = [true, true, roots[], members[], defaultMembers[], resolveRoot|null]
target = [name, kinds[], crateTypes[], workspaceSource|null, edition,
          requiredFeatures[], doc, doctest, test]
declaredDependency = [name, source|null, requirement, kind, rename|null,
                      optional, usesDefaultFeatures, requestedFeatures[],
                      exactTargetExpression|null, registry|null, pathIdentity|null]
package = [identity, resolvedFeatures[], [featureName, values[]][], targets[],
           declaredDependencies[], license|null, edition, rustVersion|null,
           links|null, defaultRun|null]
edge = [fromIdentity, toIdentity, resolvedDependencyName, [kind, target|null][]]
graph = ["graph", 1, selection, packages[], edges[]]
ancestor = ["ancestor", 1, affectedIdentity, ancestorRoots[], packages[], edges[]]
```

Normal dependency kind is Cargo's null kind projected to `"normal"`; the other
accepted kinds are `"build"` and `"dev"`. Every normal/build/dev edge and target
kind, including proc-macro targets, remains bound. Ancestors are the complete
reverse closure from the affected package in the root-reachable graph; all
internal edges are retained. Finite adjacency traversal handles cycles/shared
ancestry without choosing a shortest path or enumerating exponential paths.

The input key vocabulary was checked against actual Rust 1.95 Cargo metadata
schema 1. These keys are explicitly accepted but omitted from the portable hash:

- Top-level `build_directory`, `target_directory`, `workspace_root`, `metadata`.
  Environment paths and raw configuration are separately checked/bound by the runner.
- Package `authors`, `categories`, `description`, `documentation`, `homepage`,
  `keywords`, `license_file`, `metadata`, `publish`, `readme`, `repository`.
  Prose contents are not inspected or emitted. Raw manifests/lock and strict
  licence/source checks remain separate required bindings.
- Opaque package IDs are translated to identities. Registry manifest paths and
  registry target source paths are environment-specific and omitted; workspace
  manifest/target paths use the checked relative bindings instead.

All other recognized structural fields are validated and projected or checked for
consistency. Newly introduced Cargo keys refuse until reviewed. Raw lock,
manifest/configuration/toolchain bytes remain separately hashed; this projection
does not replace them. Compact synthetic tests do not authorize operational use
of the historical research graph or any advisory exception.
