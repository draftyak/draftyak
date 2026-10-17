# Session-pending URL elicitation: does the static `/status` URL conform?

**Answer: no.** The URL itself meets every rule the specs set for URLs, but the prompt's only purpose is to get the owner to authorize this MCP client's access to DraftYak's own data, which both elicitation specs say URL mode is not for. Under plan §6 (Elicitation) and §15 S3, the session-pending prompt therefore doesn't ship: those requests get the readable fallback (tools `AGENT_SESSION_REQUIRED`, resources app error `1001`), and the static `/status` page goes with it, along with every plan passage listed under the recommendation below. ADR 0004 (M0.16) records the decision, and the owner confirms it at the M0 gate.

The account form for `triage_inbox` is form mode and is unaffected.

## What DraftYak would send

Plan §6 (Elicitation, "Agent session pending"): on a 2026-era `tools/call` or `resources/read` whose agent session isn't approved yet, only while L3 is enabled and only when the request declares `elicitation.url`, the hub returns an `InputRequiredResult` with one URL-mode request:

- message: `Approve the agent session for <alias> (<tool class>) on your paired desktop, then continue`
- url: `https://<publicBaseUrl>/status`, the same for every principal and request. The L3 page is static: no input, ids, cookies, script or per-request data, a strict CSP and `frame-ancestors 'none'`.

The owner approves the session on a paired desktop, not at the URL. Accepting the elicitation grants nothing: the retry re-runs the whole pipeline and, if the session is still pending, ends in the readable fallback.

The spike implements this in `src/elicit.ts` (`sessionPrompt`) and `src/resources.ts` (`read`), and `test/mrtr.test.ts` covers it: the fixed URL, an auto-accepting client that gains nothing, a retry served once the session was approved in between, and `1001` when L3 is off. So the mechanics work; the open question is only whether the spec allows the use.

## The spec text

All pages accessed 2026-10-17; quotes are from the 2026-07-28 pages. The 2025-11-25 page has the same purpose note, MUST NOT, Safe URL Handling and Phishing passages, with only small wording differences ("personal identifiable information"). Its accept paragraph differs (there, a `notifications/elicitation/complete` notification reports completion), and MRTR exists only in 2026-07-28.

**What URL mode is for.** [2026-07-28, client/elicitation, URL Mode Elicitation Requests](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#url-mode-elicitation-requests); the same note is in [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-mode-elicitation-requests):

> URL mode elicitation enables servers to direct users to external URLs for out-of-band interactions that must not pass through the MCP client. This is essential for auth flows, payment processing, and other sensitive or secure operations.

> **Important**: URL mode elicitation is *not* for authorizing the MCP client's access to the MCP server (that's handled by [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)). Instead, it's used when the MCP server needs to obtain sensitive information or third-party authorization on behalf of the user. The MCP client's bearer token remains unchanged. The client's only responsibility is to provide the user with context about the elicitation URL the server wants them to open.

**The normative rule.** [2026-07-28, URL Mode Elicitation for OAuth Flows](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#url-mode-elicitation-for-oauth-flows); same in [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#url-mode-elicitation-for-oauth-flows):

> Authorization with external APIs enabled by URL mode elicitation is separate from [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization). MCP servers **MUST NOT** rely on URL mode elicitation to authorize users for themselves.

**What an accept means.** [2026-07-28, URL Mode Elicitation Requests](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#url-mode-elicitation-requests):

> The response with `action: "accept"` indicates that the user has consented to the interaction. It does not mean that the interaction is complete. The interaction occurs out of band and the client is not directly informed of the outcome. When the client retries the original request, the server determines from the echoed `requestState` (or its own stored state) whether the out-of-band interaction has completed, and either returns the final result or responds with another `InputRequiredResult`.

**The URL itself.** [2026-07-28, Safe URL Handling](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#safe-url-handling); same in [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#safe-url-handling):

> 1. **MUST NOT** include sensitive information about the end-user, including credentials, personally identifiable information, etc., in the URL sent to the client in a URL elicitation request.
> 2. **MUST NOT** provide a URL which is pre-authenticated to access a protected resource, as the URL could be used to impersonate the user by a malicious client.
> 3. **SHOULD NOT** include URLs intended to be clickable in any field of a form mode elicitation request.
> 4. **SHOULD** use HTTPS URLs for non-development environments.

and, for clients:

> 1. **MUST NOT** automatically pre-fetch the URL or any of its metadata.
> 2. **MUST NOT** open the URL without explicit consent from the user.
> 3. **MUST** show the full URL to the user for examination before consent.

**Phishing.** [2026-07-28, Phishing](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#phishing):

> URL mode elicitation returns a URL that an attacker can use to send to a victim. The MCP Server **MUST** verify the identity of the user who opens the URL before accepting information.

**The state that carries the round.** [2026-07-28, basic/patterns/mrtr, Server Requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr#server-requirements-basic-workflow):

> If `requestState` influences authorization, resource access, or business logic, servers **MUST** protect its integrity (e.g. HMAC or AEAD) and **MUST** reject state that fails verification.

> Servers **MUST NOT** send an `inputRequests` that the client has not declared support for in its capabilities.

## Assessment

| Rule | The `/status` prompt | Verdict |
|---|---|---|
| Safe URL handling: no personal data, not pre-authenticated, HTTPS | A fixed, static `https://<publicBaseUrl>/status`: no ids, tokens or cookies, and nothing to accept | Conforms |
| Phishing: verify who opens the URL before accepting information | The page accepts nothing, so there is nothing to verify | Conforms |
| MRTR state integrity; no undeclared input requests | HMAC codec bound to the principal (its grant or agent token), method and epoch; before any handler, the verify hook also needs an open single-use `pendingId` for the same params digest; asked only when the request declares `elicitation.url` | Conforms |
| "MUST NOT rely on URL mode elicitation to authorize users for themselves" | The hub doesn't rely on it: the device approval authorizes, and an accept grants nothing | Conforms to the letter |
| "URL mode elicitation is *not* for authorizing the MCP client's access to the MCP server … it's used when the MCP server needs to obtain sensitive information or third-party authorization" | An agent session is an authorization of this MCP client's (the agent's) access to the MCP server's own data. The prompt exists only to get that approval made, and it obtains neither sensitive information nor a third-party authorization | **Does not conform** |

Two more points weigh against it:

- Clients have to show the full URL, ask for consent and open it in a secure browser, yet the page does nothing: the user's real step is on the desktop. A server prompting people to open a URL "to approve access" trains exactly the habit the Phishing section warns about.
- What the hub needs (tell the user to approve on the desktop, then retry) fits the readable fallback, which needs no URL and works in both eras.

## Recommendation for ADR 0004

1. Drop the session-pending URL elicitation. Session-pending tools return `AGENT_SESSION_REQUIRED` and resources app error `1001` with the readable text, in both eras.
2. Drop the static `/status` page. These plan passages rest on it or on the URL prompt, and ADR 0004 lists their changes:
   - §1, the L3 public route table: the "static `/status` page" route goes.
   - §6 Elicitation, "Agent session pending": the case and its fixed URL go; the Fallback paragraph already covers these requests.
   - §9.2, the "Elicitation phishing or automated accept" row: "fixed static `/status` URL" leaves the mitigations; the MRTR suite stays as the test.
   - §11, the "No new destination" note: "`/status` is served, never fetched" goes.
   - §12, MVP scope (MCP): "2026-era elicitation (account form; session-pending URL when L3 is on, if S3 finds it conforms)" keeps the account form only.
   - §12, M9: the deliverable "the static `/status` page and, only if S3 found it conforms, session-pending URL elicitation (2026 era)" goes, and so does the acceptance "A scripted 2026 client gets the `/status` URL, and its retry succeeds only after the desktop approval". Its "an auto-accepting client gains nothing" is already M8's MRTR suite, through the account form.
   - §14, owner runbook step 11 (Remote): "With L3 on, Claude Code (2026 era) shows a URL dialog for a pending session. The link opens the static `/status` page, and Continue succeeds only after the desktop approval" goes.
3. Keep the MRTR machinery: the `triage_inbox` account form (form mode) uses the same codec, digest, single-use `pendingId` and per-request capability check.
4. Revisit only if a later spec revision allows URL mode for approvals that happen out of band at the server itself.

## Related: resource not-found codes

The spike answers each era with its own revision's code. [2025-11-25, server/resources, Error Handling](https://modelcontextprotocol.io/specification/2025-11-25/server/resources#error-handling): "Resource not found: `-32002`". [2026-07-28, server/resources, Error Handling](https://modelcontextprotocol.io/specification/2026-07-28/server/resources#error-handling): "If the requested resource does not exist, servers **MUST** return a JSON-RPC error with code `-32602` (Invalid Params)." SDK 2.3.1 writes `-32602` on every revision (its 2025 codec maps a thrown `-32002` to `-32602`), so the spike's 2025-era leg rewrites the SDK's not-found error (a `-32602` whose data is exactly `{ uri }`) to `-32002` on the way out (`legacyNotFound` in `src/resources.ts`).
