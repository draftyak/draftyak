# Remote discovery and ingress boundaries

## Metadata transport and limits

`ClientMetadataFetcher` returns only bounded untrusted bytes and an accepted
media type. It does not authenticate/register a client, accept a document or
key, follow a document's `jwks_uri`, choose a redirect, grant consent or issue a
token. Destination rules distinguish CIMD and JWKS, match a complete canonical
DNS host and exact paths or explicit directory prefixes, and default to no
allowed destinations. Configuration is detached plain data with bounded shape;
getters, proxies and serialization hooks are refused without execution.

| Limit | Value and source |
|---|---|
| CIMD body | At most 5,120 bytes, preserving the S4/oidc-provider body limit (`5 * 1024`). This is the exact implementation ceiling, rather than a new interpretation of the plan's informal KB unit. |
| CIMD operation | At most 2,500 ms across DNS, TLS and collection, as required by the remote OAuth design. |
| JWKS body | At most 1 MiB as a configurable transport ceiling; accepted JWK/document structure remains a later AS check. |
| JWKS operation | At most 5,000 ms across DNS, TLS and collection, leaving time for CIMD and other work inside the plan's under-ten-second token endpoint. |
| Configured limits | Stricter positive byte/time limits win; configuration cannot raise either purpose ceiling. |
| Response collection | At most 16 KiB of headers; owned response blocks at most 64 KiB each; final bytes checked after copying and before publication. |
| Work bounds | At most eight distinct in-flight purpose/URL keys and 128 pending callers; failed-lookup memory at most 1,024 hashes for 30 seconds. |
| Cache bounds | At most 128 entries and eight MiB of aggregate body bytes; at most five minutes of non-sliding freshness. |

The shared network guard owns address classification, c-ares resolution of all
A/AAAA answers and the checked connection target. It rejects private, loopback,
link-local, multicast, reserved, transition and metadata-service addresses,
including the platform endpoint `168.63.129.16`. Hub addresses from configuration
and current interfaces are also denied; mapped spellings cannot evade that
check. The destination host uses the merged `PublicDnsHost` validator. Metadata
policy permits only canonical HTTPS on port 443, with no userinfo, query,
fragment, explicit port, percent escape, backslash or ambiguous path spelling.
Every returned address is checked before selecting a pin.

TLS uses the original destination host for SNI, certificate identity and Host,
and connects to the checked IP without another hostname lookup. Requests are
credential-free GETs: no supplied headers, cookies, bearer tokens, assertions,
body, environment proxy, connection pool or TLS session reuse. The authenticated
peer must match the pin before HTTP request bytes are sent. Redirects, non-200
responses, compressed bodies, ambiguous lengths/types, incomplete responses,
oversized bytes and deadlines refuse with fixed diagnostics. Test-only native
resolver/dial/CA seams are internal and unavailable from the package entry or
owner configuration. Runtime tests generate their own certificates.

M2b's broker must import the shared network guard instead of maintaining a
second address classifier or reconnecting through `dns.lookup`. Its explicit
port denials and owner-authorized local-rule exception remain broker policy;
metadata retrieval never enables that exception. This handoff does not copy,
modify or validate a broker implementation on another branch.

## Shared fetches and successful-byte reuse

A purpose plus exact canonical URL identifies one in-flight fetch. Concurrent
callers share its network work and consume one concurrency slot. Each receives
independent bytes and honors its own cancellation/deadline; one cancelled waiter
must not cancel other waiters. Once all waiters leave, the network work is
aborted, and its slot is retained until the underlying operation settles.
Closing the fetcher cancels every operation and prevents late cache insertion.

Cache reuse requires explicit public freshness, a valid response Date and a
JSON-object byte envelope. Cache-Control, Age and Expires can only shorten
freshness; delayed processing never extends it. Cookies, authentication headers,
Vary, private/no-store/no-cache or malformed/unsupported cache directives disable
reuse. Incidental response headers, such as trace/CDN identifiers, do not alone
disable caching. Hits repeat destination, purpose, size, cancellation and
monotonic-clock checks and return fresh owned bytes. Failed refreshes never
fall back to stale data. The cache retains no headers, credentials or parsed
authorization decision. A monotonic rollback permanently closes the instance.

## Native ingress observations

The L3 helpers are unmounted. `createPeerPolicy` is an additional native-address
filter, not authentication; absent CIDRs mean unrestricted filtering, while an
explicit empty allowlist denies every peer. Arrays hold at most 32 canonical
networks; mapped client IPv4 matches IPv4 networks. Network names never resolve.

`createPublicRequestFactsPolicy` requires an exact canonical HTTPS public origin
and explicit trusted proxy CIDRs. The caller supplies `IncomingMessage.url`,
`rawHeaders`, the socket's `remoteAddress` and its actual TLS `encrypted` flag.
An origin-form target beginning with `/` is required before Host validation;
absolute-form authorities cannot override the public origin. At most 64 header
fields and 16 KiB of encoded fields are inspected, without executing accessors.

A direct peer requires actual native TLS, exact Host and no forwarding claims.
A configured proxy supplies one literal client IP and exactly HTTPS forwarding;
optional forwarded Host must match too. Duplicates, chains, unsupported
forwarding fields and ambiguous address spellings refuse. Returned frozen facts
keep the socket peer distinct from the asserted client. Matching a CIDR cannot
attest that a proxy stripped spoofed headers, protected its backend or terminated
external TLS. Deployment acceptance must establish those conditions separately.

## Required composition

Load immutable rules from actual approved owner state. Close the old fetcher
before policy tightening/replacement, epoch changes, hub lock or exposure
shutdown. Include all advertised/public/tunnel hub IPs in `deniedAddresses`,
even when absent from interfaces. Enforce per-IP and per-client rate limits
before any lookup, including before an in-flight/cache hit. Validate retrieved
documents through the accepted AS contract; bounded bytes supply no authority.

L3 remains off until a paired approve-capable device, canonical HTTPS origin,
passing public doctor, isolated route snapshot and approved deployment exist.
Only the native request/socket facts may supply proxy observations. Consent,
registration windows, token validation/revocation, alerts and kill switch still
need their real implementations. Live-client ADR 0006, native policy lifecycle,
owner deployments and client acceptance remain open. Synthetic TLS and HTTP
fixtures do not settle those gates.
