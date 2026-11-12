# Shared network boundary

`addressFacts` and `canonicalAddress` describe addresses. They do not grant access,
validate a caller, or establish that an address was observed by the hub. Native
routing adapters consume these facts; pure policy packages receive observations
through their inputs and do not import this application or keep another table.

Native callers supply `EgressPolicy` from current listener/configuration state,
including configured bind addresses and ports. `allowLocal` is a restrictive
native rule input, never a field copied from a plugin request. The guard always
refuses metadata/special-use destinations, configured denied addresses, non-loopback
interface addresses and the shared reserved-port list. Interface-derived loopback
addresses remain reachable by a permitted local rule; an explicitly denied
loopback address remains denied. Every DNS answer must pass, and public, loopback
and LAN answers cannot be mixed. Mapped addresses compare by their embedded IPv4
identity in deny lists; mapped DNS answers are refused rather than changing socket
family silently.

`resolveEgressAnswers` returns a detached complete accepted answer set for native
classification/fingerprinting. `resolveEgress` selects its first address. Both use
c-ares and capture policy before awaiting resolution. A failed family other than
an absent DNS record refuses the operation.

`createPinnedHttpsConnection` captures one accepted pin. Its options retain the
original authority in Host and TLS verification (DNS names also use SNI; IP literals
send no SNI and require an IP SAN), disable proxies, automatic family selection,
connection reuse and TLS session caching, and supply a lookup that returns only the
pin. Register `guard` before writing headers or body; send only from its `ready`
callback. The caller destroys the request on `fail`, owns cancellation/deadlines
and response/body limits, and calls `destroy` when the operation finishes. The
guard refuses redirects and a peer that is unauthorized, expired or different from
the pin. Callers must preserve these options and the original Host, and validate
the complete URL, method, headers and payload separately.

Fixture resolver/dial/CA hooks are internal, omitted from exports/configuration and
refuse outside the test environment. Tests generate certificates in memory and
connect only to their own loopback servers.

This component provides no account, job, credential, approval or lookup authority.
The complete broker, profile matching, native observations, audits and lifecycle
composition remain M2.17 acceptance with their merged prerequisites.
