# Optional remote peer CIDR policy

This independent M9 slice adds a pure, immutable socket-address filter on top of
`0348f47c`. It changes no authorization server, listener, public route, token,
device flow or trusted-proxy configuration. Current-base integration and full
Windows verification remain required before submission.

`createPeerPolicy()` represents an omitted optional allowlist and accepts valid
literal IP peers. An explicit empty array denies every peer. A configured array
accepts at most 32 distinct IPv4/IPv6 CIDRs; host bits must be zero, prefix lengths
use ordinary unsigned decimal, and output names are canonical and sorted. Other
policy decisions remain required even when a socket address matches. No CIDR
match authenticates an account or grants MCP access.

`allows` accepts only the actual native socket's `remoteAddress`. It does not
coerce objects, resolve DNS, inspect headers or accept hostnames, ports, URI
brackets, scoped IPv6 or alternate integer/hexadecimal IPv4 forms. IPv4-mapped
IPv6 socket addresses normalize to IPv4, so they match IPv4 rules rather than an
IPv6 `::/0` rule. Mapped IPv6 configuration networks are refused to keep that
family distinction explicit. Private, loopback and tailnet addresses are valid
when the configured network includes them; this is an ingress filter, separate
from the metadata fetcher's public-egress SSRF policy.

Configuration arrays are captured from own data properties without executing
accessors or proxy hooks. Sparse/subclass arrays, extra properties and duplicate
canonical networks are refused. The captured ranges and public result cannot be
changed by mutating the caller's array. Errors use one fixed content-free code.

Native listener integration must apply the current configured filter before
processing a remote request and re-evaluate it when policy changes. Behind a
reverse proxy or tunnel, the socket peer can identify only that proxy. Forwarded
headers cannot establish an original client address without a separately reviewed
trusted-proxy contract; this slice adds no such contract or enforcement claim.

Verification: 29 focused tests cover IPv4/IPv6 subnet edges, mapped addresses,
omitted/empty policy, malformed configuration, hook refusal and immutable input.
A deterministic set of 400 vectors is also compared with Node's independent
native subnet matcher. Hub typecheck, scoped Biome, ordinary frozen installation
and guard pass. No network connection, provider call, heavy build or public
listener acceptance ran.
