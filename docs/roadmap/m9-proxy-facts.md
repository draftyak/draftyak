# Explicit single-hop proxy observations

This M9 slice extends `98af3e17` with a pure, unmounted public request-facts
checker. It introduces no issuer, listener, route, database, owner-setting
format, authentication callback, approval, grant or access-filter bypass.

`createPublicRequestFactsPolicy` requires exactly a canonical HTTPS
`publicOrigin` and an explicit `trustedProxyCidrs` array. Missing or undefined
CIDRs refuse; an empty array trusts no proxy. The existing strict CIDR parser
captures at most 32 networks and never resolves names. Origin spelling, port
and Host are exact: userinfo, query, fragment, trailing slash/dot, normalization
aliases and default-port aliases refuse. Explicit private/tailnet addresses can
still be configured; this is ingress observation, not metadata egress policy.

The caller supplies actual native socket `remoteAddress`, an actual native TLS
`encrypted` boolean and `IncomingMessage.rawHeaders`. Request parameters,
discovery claims, session fields and HTTP headers must never supply the first
two facts. The checker captures only own data on plain records and dense native
arrays, without getters, coercion, iterators or proxies. It checks at most 64
header fields and 16 KiB of UTF-8 header names/values plus field punctuation.
These allocation bounds do not replace the listener's raw HTTP parser limits.
Own-key enumeration still reflects existing input keys before count refusal.

A direct peer requires actual native TLS, the exact configured Host and no
forwarding claims. An explicitly listed proxy must supply one bare literal
`X-Forwarded-For` IP and exactly `X-Forwarded-Proto: https`; optional
`X-Forwarded-Host` must also match. The backend socket may be plaintext only in
that configured proxy case. Selected duplicate headers, commas/chains, ports,
scoped IPs, the `Forwarded` field and unsupported `X-Forwarded-*` fields refuse.
This deliberately supports one hop rather than guessing a client from a chain.
Unrelated repeated headers remain usable and are never treated as IP evidence.

Returned `{publicOrigin, socketIP, clientIP, via}` facts are detached and frozen.
IPv6 is canonicalized, and mapped IPv4 becomes ordinary IPv4, keeping the proxy
socket and reported client distinct. Fixed errors contain no supplied header,
address, origin or parser text. The checker does not itself run an access filter;
native filter integration and current policy rechecks remain separate work.

The deployment preconditions matter. A configured proxy must overwrite or strip
client-supplied forwarding data, and its backend connection must be protected
against untrusted writers or interception. Matching a CIDR cannot attest either
condition or prove the external TLS session. [RFC 7239 section 8.1](https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1)
explains why forwarded data and an earlier chain cannot be trusted without those
proxy and connection assumptions. This checker does not implement RFC 7239.

[Caddy's reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults)
describes its handling of the three `X-Forwarded-*` fields and incoming values.
Its HTTPS-upstream Host behavior also depends on version/configuration, so an
actual deployment must preserve the public Host required here. No Caddy,
Tailscale, CDN or multi-hop configuration has been installed or accepted by this
slice. Native admin-controlled persistence, exposure enablement, route policy,
device/session enforcement, doctor probes and public authorization remain gates.

All 175 hub unit tests pass, including 44 new proxy-facts cases, alongside
typecheck, scoped Biome, ordinary frozen install, guard (zero findings) and
whitespace checks. The new cases cover direct/proxy source binding, spoofing,
mapped/expanded IPs, exact Host/origin, malformed chains, duplicates, header
ceilings, immutable configuration and zero-hook refusals. Independent review
also checked 256 mapped IPv4 pairs. No socket, provider, credential, heavy build,
Rust execution or complete M9 acceptance is involved in these pure tests.
