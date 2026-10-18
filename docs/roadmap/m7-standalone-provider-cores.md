# Standalone completed-response provider cores

This grouped M7 branch starts directly at merged `origin/m7`
`5fbaf893a20c7f95c6b4c1cf8af1356dad170c73`. The 15 Messages package files retain
their exact objects from `2b40d4a44fbd449e5c83cd31ef2a691215f826b3`; the 18
Compatible package files retain those from
`ceca80f25d5fff517569a605911b0664d1dfa5b0`. Their two settled-core notes remain
historical evidence. No earlier branch ancestry, contract, native service,
content package, credential code or transport is copied.

Both cores use the merged `ai-provider-v1`, `draft-output` and JCS contracts.
Compatible additionally imports extension and hash helpers. The complete
protocol closure includes extension, errors, hash and scalars; every source
blob is identical on the base and both donors. Shared TypeScript, Vitest and
Turbo configuration is unchanged. The existing SDK helper and dependency pins
remain unchanged; installation must add only the two workspace importers.

Messages constructs and verifies a fixed request descriptor, then validates an
already-completed response. Compatible builds JSON-schema, JSON-object or
Ollama descriptors and validates completed response buffers through a mandatory
trusted transport interface. That interface grants no account, credential,
destination or egress authority. Tests use only synthetic values and injected
responses. Neither package creates a network client or reads credentials.

The source READMEs retain explicit limits: accumulation before the completed
response, actual streaming/progress/deadlines, broker enforcement and production
mounting remain separate work. The Messages pinned model snapshot remains gated
by ADR 0011 and owner-controlled live acceptance; no current model availability
or vendor acceptance is claimed.

On this merged base, ordinary and frozen installs pass, followed by all 121
Messages tests in five files and 60 Compatible tests in six files. Each actual
test command contains exactly one single-worker flag. Both package typechecks
and ESM/declaration builds pass, along with scoped Biome and guard. Removing
only the two generated importers reconstructs the exact base lockfile, with no
resolved dependency changes. Object proofs preserve all 33 package files and
the two historical notes; all unrelated tracked paths remain unchanged.

The component sequence holds the actual kit lock, starts with at least eight
GiB free, and uses two CPUs with a six-GiB watchdog. These are offline component
checks. Independent-clone full Windows verification, real transport and the
complete M7 owner/live gates remain pending. No push or remote run occurred.
