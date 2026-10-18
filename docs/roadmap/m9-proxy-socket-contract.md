# Native socket proof for proxy observations

This test-only M9 follow-up starts from `ab4de942`. It adds no product source,
listener, mount, export, owner settings, proxy configuration, database,
authentication callback or access grant. The existing pure policy still requires
trusted native composition before public use.

Twelve cases send synthetic raw HTTP request lines through real loopback TCP
sockets to a temporary native `http.Server`. Its handler supplies the actual
`IncomingMessage.socket.remoteAddress`, the actual native TLS socket test and the
original `IncomingMessage.rawHeaders` directly to `createPublicRequestFactsPolicy`.
Every backend connection is plaintext: `encrypted` is observed as false, and
`X-Forwarded-Proto: https` remains a configured proxy's assertion about an earlier
connection. These tests do not prove external TLS or proxy stripping behavior.

The native observation seam matters for duplicate fields. Node's convenience
header map keeps the first Host and joins duplicate XFF and XFP values. The tests
show those actual collapsed values alongside the preserved, separately cased
raw fields, then require the policy's fixed refusal. Identical and conflicting
duplicate Host fields both refuse. The helper receives the raw header array,
rather than a reconstruction from the convenience map. Native raw headers are
parsed header fields, not an assertion that every original wire byte survives
the HTTP parser.

The other cases cover a configured single-hop loopback proxy, a canonical mapped
IPv4 client, exact public Host and optional forwarded Host, plaintext without an
approved proxy, comma-separated chains, `Forwarded` and unsupported
`X-Forwarded-*` claims. A synthetic address header cannot replace the real socket
peer. Successful facts remain frozen and keep the socket peer distinct from the
asserted client address. Refusals contain only the existing fixed code and
message.

The server binds only `127.0.0.1` on an OS-selected ephemeral port, retrying a
bounded number of times if it selects 47613–47615 or 9229. Header, connection,
request, response and test deadlines are bounded; requests carry no body. Every
case closes the client and all server sockets in a finalizer. No filesystem
cleanup, TLS key fixture, DNS lookup, native fetch, provider, production
credential, PIN, browser, Rust execution or heavy build is involved.

The focused twelve cases and the full 187-case hub unit suite pass, alongside
typecheck, scoped Biome, ordinary offline frozen install, guard and whitespace
checks. The content-free report is
`.cache/reports/m9-proxy-socket-contract.json`. This proves only the synthetic
native observation seam. It does not establish deployed proxy trust, public
authorization, policy enforcement, live client compatibility or M9 acceptance.
