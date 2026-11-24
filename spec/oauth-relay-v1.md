# OAuth relay v1

This is the L2 contract for the calls the desktop's native `oauth_assist` makes
while the hub connects a Gmail account. v1 covers Google only. The hub creates
the state, the PKCE verifier and the authorization URL; the paired desktop opens
the URL in the system browser with its own `127.0.0.1:<random>` listener and
relays what comes back. The hub then exchanges the code, so tokens never leave it.

This contract fixes only shapes, byte caps and who may call each route. Binding
the state and PKCE to the flow, single use of the code, the code exchange, the
wizard's `start`, `current` and `cancel` calls (hub requests from the app), the
L1 callback `/oauth-cb/<flowId>` and the final `account.connect` review (through
the [device API](device-api-v1.md)) belong to the hub's Gmail connection flow.

The requests and the authorization view refuse unknown members; the flow view
is checked only as a JSON object. ULIDs, instants and canonical JSON follow
[Encodings](README.md#encodings). Errors use the device API's `{code}` answers
([Device API v1](device-api-v1.md#events-and-failures)), which never echo input.

## Routes

`OAUTH_RELAY_ROUTES` gives the same table in TypeScript and Rust. Each route is
`POST`, for a known, non-revoked device of role `device`, confirmed in the
current epoch and holding `admin`, since connecting an account is an admin op.
A pending device holds no capability.

| ID | Path | Request / cap | Answer / cap |
|---|---|---|---|
| client | `/device/v1/accounts/gmail/flow/client` | GmailFlowClientRequest / 32 KiB | GmailFlowView / 8 KiB |
| authorize | `/device/v1/accounts/gmail/flow/authorize` | GmailFlowAuthorizeRequest / 512 B | GmailFlowAuthorization / 8 KiB |
| relay | `/device/v1/accounts/gmail/flow/relay` | GmailFlowRelayRequest / 2,048 B | GmailFlowView / 8 KiB |

Caps count the **received bytes**, before JSON parsing; ordinary JSON whitespace
counts, and a legal number encoding is accepted even when its canonical form is
longer. `checkOAuthRelayRequestBytes` and `checkOAuthRelayResponseBytes` (Rust:
`check_route_request_bytes`, `check_route_response_bytes`) check the cap, then
parse strictly and check the shape. The value forms check a value's canonical
JSON instead, for callers without received bytes, so a value that isn't plain
JSON data is refused. Admission takes the device API's peer form, whose
capabilities are distinct capability names: `oauthRelayRouteAllows` (Rust:
`route_allows`).

## Requests

- GmailFlowClientRequest is `{flowId, client: {clientId, clientSecret}, redirectUri}`.
  `clientSecret` is required and is `null` for a client without one. Rust sends
  this call natively, so a client secret never enters the webview.
- GmailFlowAuthorizeRequest is `{flowId}`.
- GmailFlowRelayRequest is `{flowId, state, code, redirectUri}`.

Field rules, where visible ASCII is U+0021 to U+007E:

- `flowId` is a ULID.
- `clientId` is 1–512 visible ASCII characters; a `clientSecret` string is
  1–4,096.
- `state` is 43 canonical base64url characters, which decode to exactly 32 bytes;
  padding, the standard alphabet and nonzero trailing bits are refused.
- `code` is 1–256 visible ASCII characters.
- `redirectUri` is exactly `http://127.0.0.1:<port>/oauth/google/callback`, with
  a port of 1–65535 written without a leading zero. Another scheme, host or path,
  a trailing slash, userinfo, a query (even an empty `?`) or a fragment is refused.

## Answers

GmailFlowAuthorization is `{id, authorizationUrl, expiresAt, remainingMs}`: the
flow id, the URL to open, the flow's expiry as UTC milliseconds and its remaining
time in milliseconds, both non-negative safe integers. The URL is
`https://accounts.google.com/o/oauth2/v2/auth`, written exactly so, optionally
followed by a query of RFC 3986 query characters in which every `%` starts a
two-hex-digit escape. Any other origin (scheme, host or port) or path, userinfo
and a fragment are refused. Opening the URL is still the desktop's decision: this
check doesn't show that the query belongs to the current flow.

GmailFlowView answers `client` and `relay`. Its members are the hub's and carry
no secret, code or token; both languages check only that it is a strict JSON
object (no repeated member names) within the cap.

## Native handling

Rust's typed requests and the authorization view never show the client secret,
the state, the code or the authorization URL in `Debug` output, and Rust's
refusals carry no submitted value. TypeScript's parse functions throw one
`OAuthRelayRefused` with a fixed message, never the input or a member name.

The [generated schema](schemas/oauth-relay-v1.schema.json) states the field
rules as patterns; byte caps and admission need the protocol checks. Shared
[OAuth relay vectors](vectors/oauth-relay/) pin both languages: `routes.json`
holds the route table and its admission cases, `cases.json` the request and
answer cases.
