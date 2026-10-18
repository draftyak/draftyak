# Check pinned CIMD expiry after final processing

The pinned metadata helper already checked its CIMD deadline at response end.
It captured that time before assembling owned response blocks and calculating
cache freshness. If those synchronous operations reached expiry before the
timer could run, the standalone helper still resolved its bytes. Two controlled
regressions reproduced this with the actual assembly/freshness operations:
both resolved before the fix despite reaching the existing 2,500 ms deadline.

The helper now checks the same expiry again after constructing its result and
before resolving. Expired work follows the existing fixed refusal, clears owned
collector references and destroys the request/response. It does not change
timeouts, byte limits, HTTP/cache rules, public-address policy, DNS pins or TLS
verification. The outer fetcher retains its separate existing checks; this
change closes the lower-level helper's own publication gap. JWKS keeps its
existing outer configured deadline, with no new lower-level timeout.

Tests use the existing controlled HTTPS response fixture, genuine Buffer
assembly and freshness calculation, and an advanced monotonic clock. No real
DNS, public TLS socket, provider or authorization service is exercised. The two
new cases failed before the fix and pass afterward. All 114 client-metadata
tests pass across four files; the 85 peer/proxy cases also pass, for 199 checks
across seven files. Hub typecheck, scoped Biome, ordinary offline frozen
installation, guard (zero findings in 800 files) and whitespace checks pass.
No package version changes.

Synchronous work remains bounded by the existing byte cap and cannot be
interrupted mid-operation; elapsed expiry is checked when it returns. This
slice establishes no public issuer, OAuth document authority, native listener,
client acceptance or completed M9 milestone. Heavy builds, Rust, credential/PIN
operations and full Windows verification remain unrun.
