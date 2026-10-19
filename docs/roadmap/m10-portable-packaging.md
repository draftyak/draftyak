# M10.3 portable packaging source slice

This branch starts directly at merged `origin/m10`
`5fbaf893a20c7f95c6b4c1cf8af1356dad170c73`. It selects the portable portion of
the completed read-only filesystem handoff in the community-docs worktree.
These source files were not committed in that donor: its Git HEAD is
`809156ef0b68ed7d339533a153eb390c09fbc398`, which does not contain the packaging
tree. Per-file SHA-256 and Git blob hashes were captured before copying and
checked against the unchanged donor afterward. No immutable committed source
provenance is implied.

The donor has 47 packaging files. This slice copies only `src/npm.ts`,
`src/manifest.ts`, their npm/archive/offline-install and manifest tests plus npm
fixture, the protected launcher, two service templates, TypeScript/Vitest
configuration, and `docker/{draftyak,healthcheck.mjs}`. Production files and
archive assertions retain their source bytes. The launcher/healthcheck cases
are extracted from the existing mixed packaging test without policy/doc-link
cases. Test cleanup adds absolute containment and canonical non-symlink
directory checks before recursive deletion. New minimal package/Turbo metadata
registers only this actual source/test graph, with no new dependency versions.

`npm.ts` and `manifest.ts` import the real sibling build inventory and release
guard helpers. Their unchanged `inventory.ts`, `guard.ts`, `integrity.ts` and
`tar.ts` interfaces are supplied by the separately owned M10.1–2 foundation
slice; no replacement or successful stub is included here. Compose both slices
into one M10 branch before install, typecheck or tests, then generate their
workspace importers together. Only already-merged root configuration/interfaces
may be used. This uncomposed branch must not be published as an independent PR.

`distribute.ts` is excluded because it statically imports desktop, Android,
Apple and mobile-output builders. No native driver, Windows shutdown helper,
product checkout, root configuration, M0 CI workflow or donor lockfile is
copied. Docker image/compose orchestration, source readiness/doc-link checks and
full M10 acceptance are outside this subset. Templates alone prove no installed
service, actual container runtime, real artifact provenance or product behavior.

Validation is pending composition and a resource-checked execution slot. No
install, package test, native execution, Docker operation or full verification
has run for this slice. The queued checks are ordinary/frozen installation,
portable unit tests, the explicit local-only offline npm case, typecheck,
scoped Biome, guard and source/object closure proofs. Full Windows verification
and any submission remain coordinator-owned gates.
