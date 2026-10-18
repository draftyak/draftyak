# M10 portable build-tool composition

This local candidate starts directly from merged `origin/m10`
`5fbaf893a20c7f95c6b4c1cf8af1356dad170c73`. It combines the reviewed M10.1–2
foundation `32eef0ebb9ef2ffcdcacd1c62405680c98f6469e` with only the portable
M10.3 source checkpoint `c163c0a7e8178850f3167b638130651589665ac6`.

The bundle and release-guard source trees retain their exact foundation Git
objects, including the shared bounded file reader and tar work limit. The
portable packaging tree, two Docker launcher/healthcheck files and templates
retain their exact reviewed source objects. No root policy, CI workflow,
product application, contract, native driver or earlier-milestone runtime is
copied. The component notes retain their historical source-checkpoint context;
this note records the combined candidate's validation separately.

The real dependency closure uses those three private tooling packages and
already-merged fetch-node, vendor-guard and shared test helpers. Ordinary
installation must generate the additional packaging workspace importer; the
foundation importers, all merged importers and resolved package versions must
remain unchanged. No donor aggregate lockfile is transplanted.

The explicit packaging heavy test has one permitted case: install a local
synthetic npm tarball with `--offline --ignore-scripts`, isolated empty npm
configuration and isolated cache, then run its protected fixture launcher. It
does not execute the inert native payload, a real hub, a native installer,
Docker, credentials or provider calls. The installed current Node supplies
`npm-cli.js`; absence is a failure, not a successful skip.

Ordinary installation generated only the packaging importer and its two
workspace links. All 22 merged-base importers, both foundation importers and
every resolved package remain unchanged. Normal frozen installation passed;
253 packages came from cache and no downloads occurred.

The combined component checks passed on Node 26.12.0:

- Bundle-hub: 67 unit tests passed; one unchanged POSIX umask case is skipped
  on Windows.
- Release guard: 84 unit tests passed.
- Portable packaging: 40 unit tests and the one explicit offline npm heavy
  test passed. The actual installed fixture launcher preserved the signal
  disabling flag and exact literal arguments.
- All three scoped typechecks passed; scoped Biome checked 42 files.
- Guard reported zero findings across 826 files.

The runner held the actual kit OS lock, used two CPUs and one test worker,
required at least 8 GiB free immediately after lock acquisition, and monitored
the continuous 6 GiB floor. Its minimum across the queue and execution was
6.85 GiB. At this component checkpoint, full normal Windows verification is
still the next gate: it must run in an independent Git clone against the fresh
integration base. Publication is not authorized by these component results.

Native schedule-oracle compilation and cross-runtime equivalence, authenticated
real product probes, desktop/mobile installers, installed service permissions
and shutdown, real Docker acceptance, signing and complete release inspection
remain separate gates. The full release guard still refuses absent or
unfinished product acceptance inputs. This composition is useful packaging
tooling, not completion of M10 or evidence that a product artifact is ready.
