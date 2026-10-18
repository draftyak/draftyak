# M9 metadata configuration admission

This independent slice starts at `0348f47c`, after the reviewed metadata
transport/cache purpose limits. It changes only the configuration data copier,
its offline tests and this note. CIMD/JWKS document acceptance, public
authorization routes, peer CIDR policy, native owner-policy persistence and
runtime composition remain outside it.

The earlier `configData` guard counted nodes and depth but accepted arbitrarily
long strings/keys and materialized every descriptor before rejecting a large
container. Synthetic baseline probes admitted a 9 MiB + 1 string, a key of that
length, 257 array elements and a 257-member record. A constructor regression also
observed bulk descriptor materialization of an oversized destination array before
the semantic rule-count check.

The copier now returns detached, deeply frozen plain JSON data and enforces:

- 9 MiB of encoded JSON, including keys, punctuation, UTF-8 and escapes;
- at most 256 elements or record members per container;
- the existing 20,000 visited values and 16 nesting levels.

An array's intrinsic own length is checked before enumerating keys or reading
element descriptors. Record key count is checked before individual descriptors
are copied; no bulk descriptor object is constructed. Raw string/key length is
checked before Unicode scans. Encoded length is counted directly, without
allocating an escaped JSON representation. Ordinary object keys still require
one native own-key enumeration; this code does not claim an allocation-free
inspection of an already supplied JavaScript object.

Proxies, accessors, sparse/custom arrays, symbol keys, nonenumerable members,
functions, `undefined`, nonfinite numbers and malformed Unicode refuse without
running input hooks. Every refusal remains the fixed `Client metadata refused`
error, with no configuration text or nested exception attached. Existing closed
field, host/path and numeric validators still run after admission. The data
copier establishes no permission, provenance or configuration authenticity.

## Preserving the documented maximum

The 9 MiB cap is the smallest whole-MiB ceiling that admits the full currently
valid native configuration. The maximum is 8,495,307 encoded bytes, comprising
128 rules, each with a 253-character host and 32 prefix paths of 2,048
characters; 256 deny-address strings of the maximum 45-character IPv6 spelling;
and the existing maximum numeric settings. The regression constructs this
complete value and admits it through both `ClientMetadataFetcher` and
`MetadataDestinations`, without making a request. All documented arrays have at
most 256 elements, and valid records have at most four members.

The guard changes no host/path rule, destination default, cache behavior,
purpose-specific response cap or deadline. CIMD remains at most 5,120 bytes and
2,500 ms; JWKS retains its configurable 1 MiB and 10-second ceilings. Original
configuration mutation cannot alter the copied owner rules.

## Local checks

`pnpm --filter @draftyak/hub exec vitest run test/client-metadata` passes 102
tests across four files. Nine new cases cover oversized configuration, rejection
before descriptor/serialization work, full-maximum native configuration,
exact encoded boundaries for ASCII, JSON escapes and four-byte text, aggregate
field limits, detached freezing and fixed hook refusals. Existing destination,
SSRF, transport, timeout, purpose and cache cases also pass.

Hub type checking, scoped Biome, whitespace checks and repository guard pass.
Ordinary frozen installation reused 253 cached packages with no downloads or
package/lock changes. No vendor request, provider operation, client acceptance,
PIN/Argon fixture, Rust execution or heavyweight build was run under the shared
benchmark restriction.
