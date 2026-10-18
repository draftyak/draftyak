# Bounded metadata response collection

This M9 follow-up starts from `079c28d9`. It changes the native pinned-HTTPS
response collector and extends its existing network-boundary tests. Destination
policy, DNS validation and address pinning, TLS/SNI/Host binding, credentials,
cache rules, public request facts, authorization and contracts are unchanged.

The previous collector copied and retained a Buffer for every response data
event. A production-helper probe with the native HTTPS request mocked returned
an 8,200-byte synthetic JWKS body while retaining 8,200 buffers until assembly.
The permanent regression failed with that count before the fix and passes with
one collector block afterward. This is collector evidence under a native request
mock, not successful TLS or destination acceptance. A loopback TLS probe would
require weakening the existing public-IP and port-443 policy, which remains
intact.

Responses now copy immediately into owned blocks of at most 64 KiB. Before any
new block allocation or copy, the collector checks the incoming byte count
against the remaining purpose/configuration cap and checks expiry. The last
allocation is also restricted to the remaining cap. Total collector allocation
therefore never exceeds the effective cap: at most 5,120 bytes in one block for
CIMD and one MiB in sixteen blocks for JWKS. A stricter configured byte cap still
applies. The final contiguous result is a separate owned copy; only initialized
body bytes are included, excluding unused block suffixes.

Settled requests ignore late data before examining it. Failure and successful
assembly clear collector references and counters. Assembly failures retain the
fixed `Client metadata refused` error and destroy the native request/response.
The existing two-and-a-half-second CIMD and ten-second JWKS fetcher deadlines,
cancellation, complete-body checks and cache freshness behavior remain covered
by the existing tests. This change adds no new timeout policy or transport
injection seam.

Ten new cases cover the failed-before tiny-chunk regression; exact CIMD, JWKS
and configured partial-block bounds; each purpose's adjacent-byte refusal before
allocation; late data after cancellation, error or bare request close; and
reference cleanup after a final assembly failure. All 197 hub unit cases pass,
including the twelve real-loopback raw-header observation cases. Typecheck,
scoped Biome, ordinary offline frozen install, guard and whitespace checks pass.
The content-free report is `.cache/reports/m9-metadata-collector.json`.

No vendor, DNS or actual HTTPS request, credential operation, PIN, Rust execution
or heavy build ran for this follow-up. Its native HTTPS mock tests preserve the
existing policy inputs and never contact their synthetic destinations. Public
route mounting, owner-controlled configuration, actual CIMD/OAuth validation,
deployment trust and live remote-client acceptance remain separate M9 gates.
