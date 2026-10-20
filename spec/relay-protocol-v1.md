# Relay transport architecture, version 1 draft

Status: architecture draft for M1.11. This specifies the relay's trust boundary;
an interoperable wire profile and its test vectors still require separate review
before a producer or consumer is enabled.

## TLS and connection injection

The relay carries connections to the same native TLS and authorization gates as
the core direct transport. The hub retains its identity key and terminates TLS.
An extension injects raw, still-encrypted bytes through `injectConnection`.
Injected bytes and relay metadata create no authenticated principal and bypass
no native certificate, SPKI, current-device, capability or route check.

The hub initiates `wss://relay.<domain>/v1/tunnel`. The relay supplies a bounded
nonce for signing in a fixed, relay-specific native domain. `signChallenge`
never exposes a private key or provides general signing: the native adapter
must validate the relay profile, length and replay rules before using the hub
identity key. It must not sign arbitrary statements, admin forms, approval
bytes, raw digests or another protocol's challenge.

Binary WebSocket messages carry yamux streams, one per incoming client
connection, with untrusted `{sni, clientAddr}` metadata. The relay accepts TCP
443, reads ClientHello SNI `<hub-id>.relay.<domain>` for routing and forwards the
original TLS bytes to the hub. It neither terminates nor decrypts client TLS.
Native clients retain their pinned hub SPKI.

## Certificates, presence and wake

Browser and L3 access use WebPKI certificates through ACME DNS-01. The private
key and CSR stay native; DNS authority is scoped to the intended name. Native
certificate validation checks the CSR/key match, chain, names and lifetime.
The hub monitors Certificate Transparency.

Rendezvous records describe online presence. Content-free or device-sealed wake
hooks convey no approval and cannot reopen a missed send window. A wake still
enters the native scheduler and current authorization checks.

## Disclosure boundary

The relay observes IP addresses, SNI, timing and byte sizes. It must receive no
message bodies, approval plaintext, private keys or upstream credentials.
Transport injection grants no account access, send authority or permission to
fall back to plaintext. Modules remain trusted in-process code; their API types
are a review boundary and do not establish a sandbox.

## Wire-profile gate

Before enabling a relay producer or consumer, a reviewed versioned profile with
bounded test vectors must define:

- Nonce length, signing preimage and encoding, and replay windows.
- Hub-ID-to-SNI encoding, yamux version and metadata serialization.
- Frame, stream, connection and rate limits; reconnect behavior.
- Certificate renewal and rendezvous/wake request and response formats.

This draft defines none of those wire bytes. M1.11 supplies the typed extension
points and this architecture, with no relay service, native signing adapter,
plaintext fallback or authentication bypass. Native implementations and hostile
transport tests belong to their owning integration milestones.
