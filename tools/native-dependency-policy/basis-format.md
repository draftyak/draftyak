# Current basis format, version 1

`normalizeCurrentBasis` accepts normalized audit findings, an independently
delivered current RustSec head binding, complete field-only official release
snapshots for the five bounded crate names, a verified current security-event
snapshot, and start/completion times. It returns four domain-separated digests,
their reviewable ordered tuple payloads and the oldest observation time.
It makes no authorization, review, approval, renewal or operational-pass decision.

`loadCurrentBasis` obtains all three snapshots through `CurrentBasisProducer`.
Its collection options contain only start time and maximum age. It reads the
real `Date.now` completion clock after the last awaited source, then normalizes;
an injected completion clock is a pure-test seam, never a CLI option. A caller
cannot supply a completion timestamp known before collection. The final runner
must recheck freshness and current authority immediately before its verdict.
That interface is an established trusted-producer boundary, not a serialized
approval format. Its `independent-current-head` delivery contract requires an
independently delivered current upstream head. Copying the same stale local ref
into both commit fields does not establish that contract. The pure normalizer
can validate data consistency; it cannot authenticate a producer or prove that a
security notice has not gone unobserved.

`UnavailableCurrentBasisProducer` is the production default and always raises
the fixed `BASIS_UNAVAILABLE` error. No current verified delivery route for all
three sources is implemented here. In particular, local database `FETCH_HEAD`
time is not upstream freshness, and no complete security-notice feed is invented.
The remaining source-delivery gap must be resolved through the existing trusted
repository route before operational current-basis evidence can exist. There is
no HTTP client, endpoint/ref/time override, authentication input or fallback to
historical evidence in this module.

All schemas are closed. Findings use only the five exact source/name/version/ID
tuples in `BOUNDED_TUPLES`; unknown scope refuses. Every official release crate
must appear exactly once, with its exact affected version and any other relevant
version records delivered by the producer. Missing, duplicate or partial crate
sets refuse. Release records contain only version, creation instant, yanked flag,
archive checksum, licence expression and dependency declarations. Dependency
declarations bind name, requirement, kind, exact target, optional/default flags,
feature set, registry and rename. Authors, contacts, descriptions and other prose
are excluded; unknown/accessor fields refuse without executing the accessor.

Security events target an exact bounded tuple and bind an immutable event
revision, technical event ID, publication instant and one of `advisory`, `release`
or `security-notice`. A release event identifies the affected bounded tuple;
newly released version metadata belongs in the official release snapshot.
An empty event list is data from a verified producer, not independent proof of
complete notice coverage. Missing or unverified source delivery always refuses.

Revisions are lowercase immutable 40-character commit IDs or 64-character
digests; database commits are exactly 40 characters and must agree with the
independently delivered current head. No mapping of an upstream branch/ref is
guessed. Freshness uses all three observations through completion: each must be
no later than completion, completion cannot precede start, and
`completedAt - min(observedAt) < maxAgeMs`. The positive safe-integer maximum age
cannot exceed 3,600,000 ms. Fresh observations may fall between start and
completion. Cached observations may precede start while still within the age
limit through completion. Exact cutoff refuses. Production supplies real times
and the fixed policy limit; pure fixtures may choose shorter limits.

Inputs are snapshotted through own data descriptors into null-prototype records.
Accessors, symbols, custom object prototypes, sparse/extra arrays, cycles, invalid
Unicode, unsafe numbers and excessive inputs refuse. Limits are depth 64, one
million value nodes, 100,000 rows per array, 64 KiB per scalar string, 32 MiB total
decoded string/key bytes, and 32 MiB per final tuple payload. Credential-bearing
registry URLs refuse. Ranges/licence expressions are preserved technical data,
not interpreted as dependency selection or approval.

Tuple notation (unordered rows/sets use explicit UTF-8 byte order):

```text
identity = [source, name, version]
advisory = [id, package, informational|null, categories[], collection,
            source|null, date, null, cvss|null]
finding = [identity, classification, advisory,
           [architectures[], operatingSystems[], [function, ranges[]][]]|null,
           patchedRanges[], unaffectedRanges[]]
dependency = [name, requirement, kind, target|null, optional, defaultFeatures,
              features[], registry|null, rename|null]
release = [version, createdAt, yanked, checksum, license|null, dependencies[]]
basis = ["basis",1,"independent-current-head",commit,currentCommit,revision,findings[]]
releases = ["releases",1,"crates.io",revision,[source,name,releases[]][]]
security = ["security",1,"verified-security-event-feed",revision,
            [identity,id,kind,publishedAt,eventRevision][]]
observation = ["observation",1,startedAt,completedAt,maxAgeMs,
               [fixedSourceName,revision,observedAt][]]
```

SHA256 input is `draftyak/native-dependency-policy/{kind}/v1` followed by one NUL
byte and `JSON.stringify(tuple)` encoded as UTF-8. The four kinds are `basis`,
`releases`, `security` and `observation`. Observation timestamps and run timing
are excluded from semantic digests, so a freshly verified unchanged snapshot
does not rewrite policy identity. `observationDigest` separately binds those
times and all three source revisions. A changed semantic field or source
revision still changes its semantic binding and requires the existing review
rules; fresh local timestamps cannot authorize an old or unverified snapshot.
