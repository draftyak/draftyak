# M9 bounded metadata reuse

The native `ClientMetadataFetcher` now has one successful-byte cache per immutable
fetcher instance. Its public `fetch(url, kind, signal)` result still contains only
bounded untrusted bytes and their accepted media type. This is neither client
registration nor client authentication, and it does not accept CIMD or JWK fields.
The independent port starts on the reviewed `origin/m9` base `5fbaf89`. It needs
no native store or later unmerged contract to run its focused checks.

Each cache key hashes the requested purpose (`cimd` or `jwks`) and the exact
canonical HTTPS URL already accepted by the configured destination rules. Every
hit repeats those rule checks, checks cancellation and the monotonic clock,
revalidates MIME/size and strict UTF-8 JSON-object structure, and returns a fresh
byte copy. Insertion also copies bytes. A caller cannot modify a later result by
changing an earlier returned buffer. Structural JSON validation supplies no
document, signing-key or OAuth authority.

Both insertion and reuse enforce the effective purpose limit independently:
CIMD never exceeds 5 KiB (5,120 bytes), and a stricter configured cap still wins.
JWKS retains its configurable 1 MiB ceiling. Actual typed-array storage length
is checked and copied through native intrinsics; a supplied `byteLength` getter
cannot conceal oversized bytes. A larger cached JWKS result cannot become a
CIMD result through a different purpose or a larger configured limit.

Reuse requires explicit `Cache-Control: public,max-age=N` and a canonical HTTP
`Date`. The hard ceiling is five minutes, without sliding on hits. Optional `Age`
and earlier `Expires` reduce the remaining lifetime, as do apparent response age
and request elapsed time. Freshness starts at actual response completion; delayed
processing cannot extend it. Duplicate, malformed or unsupported directives and
headers disable caching while preserving the underlying fetch behavior. Only a
small header-name allowlist permits reuse; cookies, authentication headers,
`Vary` and unknown header names disable it. `private`, `no-store`, `no-cache`,
expired data, invalid UTF-8/JSON and non-object JSON are never cached.

The cache holds at most 128 entries and eight MiB of aggregate body bytes, with
LRU eviction and expired-entry removal. It does not retain response headers,
errors, credentials, parsed authorization decisions or persisted documents. The
existing 30-second bounded failed-lookup hash memory stays separate. A failed
refresh never falls back to stale bytes. Misses retain the existing destination,
public-address DNS pin, TLS peer, byte, timeout and concurrency guards.

`close()` clears successful bytes and failed-lookup memory and aborts in-flight
work. A late response cannot refill a closed instance. Monotonic rollback closes
it permanently; instances never share entries. This branch has no native owner
policy store or epoch verifier. Native composition must close the old instance
before policy tightening/replacement, owner epoch changes, exposure shutdown or
hub lock, then construct a new one from current approved state. The instance's
immutable rules cannot prove that external owner state is still current.

The document contract, rate limits before lookup, owner-approved policy storage,
embedded authorization server, grants, consent, M1.20 and ADR 0006 remain their
separate gates. There is no fabricated epoch callback, successful OAuth path,
default vendor allowlist or live network result here.

Focused tests use synthetic DNS/HTTP objects with the production policy, transport
and cache. They cover header eligibility, clocks/expiry, response-delay anchoring,
kind separation, byte isolation, bounds/LRU, cancellation, policy rejection,
failed refresh, malformed documents and close/late-response behavior. They do not
establish an actual TLS handshake, hosted-client interoperability or native
policy/epoch lifecycle integration.

```powershell
pnpm --filter @draftyak/hub exec vitest run test/client-metadata
pnpm --filter @draftyak/hub typecheck
```
