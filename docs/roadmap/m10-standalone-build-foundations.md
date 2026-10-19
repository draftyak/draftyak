# M10.1–2 standalone build foundations

This candidate starts directly at `origin/m10`
`5fbaf893a20c7f95c6b4c1cf8af1356dad170c73`. It contains only the nine
`tools/bundle-hub` files and twenty `tools/release-guard` files from the completed
packaging stream, followed by the explicit safety changes below. The original
snapshot is recorded by file hashes; the donor's uncommitted files are not
changed. This candidate adds tests, this note and the two package importers
that an ordinary install must generate.

The bundler stages supplied, inventoried local product bytes and authenticates
the pinned official Node archive. The release guard checks supplied artifacts,
package metadata and inventories. Their source and unit-fixture import closure
uses Node built-ins and existing fetch-node, vendor-guard and shared test
helpers. Those external helper files match the merged base. No product app,
protocol definition, desktop code, CI policy, workflow or existing M0 test is
copied. The merged shared Vitest configuration remains unchanged.

## File admission hardening

The original bundler checked the pathname size, then read a held descriptor
without comparing its size to that first snapshot. The release guard checked
a pathname and subsequently read the pathname again. Both relied on an
unbounded `readFileSync` after their size check.

`inventory.regularBytes` now supplies one reader for both tools. It compares
initial and held identity, size, timestamps and mode before allocating. Reads
use at most 64 KiB per call into the exact captured-size buffer, followed by a
one-byte EOF check, held metadata comparison and a final path/ancestor check.
The existing limits remain 512 MiB for bundle inputs and 256 MiB for release
files; a smaller optional reader limit supports callers and boundary tests.
Native no-follow/nonblocking flags are used where available. Returned byte
content is unchanged for stable valid files.

A numeric close receives one attempt. Any thrown close permanently refuses
new reads in that process at admission and immediately before open. No numeric
descriptor is retried or assumed safely retired. Restart and OS cleanup are
required after that uncertainty. These checks do not establish an OS sandbox
or eliminate a same-user change after the final observation.

The shared reader adds a real release-guard dependency on bundle-hub, declared
in its package manifest and Turbo inputs. The original snapshot and these
reader/configuration changes are recorded separately; the final tree is not
claimed to be an unchanged 29-file copy. Tar admission has a separately owned
hardening delta and regression suite in this shared candidate.

Small-file regressions cover exact binary/UTF-8 bounds, growth before
and during reads, pathname replacement, bounded native reads and isolated
before/after-effect close faults. An ignored paired-proof source tree preserves
the original reader bytes without swapping production files. The held-pathname
replacement attempt is a Windows OS-refusal control: the OS refuses replacing
the open file in both versions, so that case is not counted as a regression
fixed by the reader. The independent pre-open replacement and metadata-change
cases check the reader's own observations. The exact original source failed ten
regressions and passed two controls on Windows; all twelve pass with the shared
reader. The proof requires actual original acceptance for the growth, pre-open
replacement, mode-change and transient-hard-link cases, rather than counting
unrelated fixture exceptions as evidence.

## Tar work budget

Tar admission now counts all headers, including directories, against a 40,000
entry limit. That allows the existing 20,000-file inventory plus ordinary parent
directories. An ancestor set replaces repeated scans of all previous names;
the existing file/directory overlap refusals remain. The uncompressed byte cap
is unchanged. This is a work limit, not a claim that every possible directory
layout for a 20,000-file inventory fits within it.

The controlled original-source proof passed: the exact original accepts 40,001
headers, the current implementation refuses them, and both return identical
file bytes at 40,000 headers. Imported original sources are checked before
loading; only the copied tar module's relative integrity import is adapted.
The proof uses synthetic directory headers and never swaps production sources.

Use the direct commands documented by each package:

```text
node tools/bundle-hub/src/cli.ts --spec <reviewed-input.json> --out <new-directory>
node tools/release-guard/src/cli.ts --manifest <reviewed-manifest.json> --root <staged-directory> --repo <reviewed-product-checkout>
```

The preserved package READMEs also describe integration from the larger donor.
The root `guard:release` alias and `package:product` command are not installed in
this foundation candidate. M10.3 root wiring, Docker recipes, launcher/service
integration and the larger desktop/mobile packaging orchestration remain
separate work.

The native schedule oracle is a build template, not a standalone Cargo
application. Its driver must supply the actual reviewed product protocol and
native schedule source. The required native schedule module and snapshot
contract/vectors are absent from this base. Native-oracle compilation,
cross-runtime schedule acceptance, authenticated real-runtime probes and real
candidate smoke tests remain gated
and unrun. The ordinary unit fixtures use synthetic inputs and cannot establish
those release claims. The full release guard continues to refuse missing or
unfinished product acceptance inputs.

Ordinary and frozen installation passed without downloads. The generated lock
adds two package importers and one release-guard-to-bundle-hub workspace edge;
all existing importers and resolved packages remain unchanged. No lock conflict
or resolved package version is hand-edited.

Component checks on pinned Node 26.12.0 passed:

- `pnpm --filter @draftyak/bundle-hub test --maxWorkers=1`: 67 passed, one
  Windows skip for the unchanged POSIX umask fixture, across two files.
- `pnpm --filter @draftyak/release-guard test --maxWorkers=1`: 84 passed across
  four files, including both tar-budget regressions.
- Both packages' `typecheck` scripts passed.
- Scoped Biome checked 27 files without findings.

The final proof, unit and typecheck phase held the actual kit OS lock, used two
CPUs and one test worker, and recorded a 10.04 GiB minimum free-memory reserve.
The earlier resource-only wait stopped before starting any package command.
Staged guard passed with zero findings across 805 files, and the staged
whitespace check passed. Source proof retains 23 original files unchanged and
records six explicit original-path deltas: the reader, integrity delegation,
tar admission and their package/cache declarations. Four new regression/helper
files accompany those deltas. Product, protocol, CI and M0 helper trees remain
unchanged. Full normal Windows verification and any publication decision remain
separate later gates.
