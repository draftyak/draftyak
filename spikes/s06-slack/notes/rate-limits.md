# S6 Slack rate limits and the internal-app exemption

What DraftYak's Slack design depends on, for M0.25's live check, ADR 0008 and M0.40's scheduling ADR (0015). Every page below was read on 2026-10-17 from docs.slack.dev, in the Markdown form Slack serves for each page (`<page>.md`); quotes are verbatim. M0.25 re-reads the two changelog entries and the rate-limits page before session 2 and records any change in ADR 0008. The plan's sections are §3 (Sync engine, Scheduler), §4 (Profiles, `slack-v1`), §5 (Compliance) and §15 (S6).

## The facts, stated once

1. **The 2025-05-29 change.** Slack moved `conversations.history` and `conversations.replies` from Tier 3 to Tier 1 for apps commercially distributed outside the Slack Marketplace ("unlisted" apps): 1 request per minute per method, and at most 15 objects per request, which is also the new default for `limit`. It applies to unlisted apps created from 2025-05-29 and to new installations of existing ones; existing installations keep their old limits.
2. **The internal-app exemption.** Internal customer-built apps aren't affected. They keep Tier 3 ("50+ per minute") and a `limit` of up to 1,000 objects by the changelog (999 for `conversations.history` by its reference page). Slack repeated this on 2025-06-03, and each method's reference page says so today.
3. **DraftYak's dependency.** The owner creates their own app from `manifest.yaml` in their own workspace and never distributes it (guardrail 6). So the claim-time reads of a scheduled Slack send rely on the exemption: before every claim and retry the hub makes one fresh bounded read, `conversations.info` (Tier 3, outside the change) plus `conversations.replies` or `conversations.history` since the watermark with `limit` 20 (inside it; plan §3 Pre-claim). The poller's sync reads rely on it too.
4. **No Marketplace route.** Apps that use Socket Mode can't be listed in the Slack Marketplace, so becoming a Marketplace app isn't a way out of the limits for this design.
5. **Open: is an app built from DraftYak's manifest "internal customer-built"?** Slack's terms update of the same day calls the Marketplace "the only appropriate channel" for commercially distributing apps, including templated custom apps. DraftYak is free and distributes no app, but it publishes the template and plans paid tiers later (plan §10). Slack's written confirmation was requested on 2026-10-17 (plan §16); until it arrives, ADR 0008 and ADR 0015 treat the exemption as a dependency with the fallback below, and the owner confirms the reading at the M0 gate.

Guardrail 6 holds throughout: the spike never uses Slack's Real-time Search API or Slack's MCP server, although Slack's changelog points developers to the former, and no Slack data reaches a model.

## What Slack says

### The change ([changelog, 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps))

> This rate limit reduction will apply only to applications that are commercially distributed outside of the Marketplace (also called “unlisted” apps). It will immediately impact affect new unlisted applications and new installations of existing unlisted non-Marketplace applications. The new rate limits will be updated to allow 1 request per minute and will return a maximum of 15 objects per request.

> The rate limits for both the `conversations.history` and `conversations.replies` API methods are changing from `Tier 3` to `Tier 1` for commercially distributed apps that are not approved for the Slack Marketplace

> The new rate limits will not be applied to existing installations of unlisted, distributed applications published outside the Marketplace.

The page now opens with "_This page has been updated to clarify the rate limits for existing internal customer-built apps._"

### The exemption

From the same page:

> Internal customer-built applications are not impacted by these changes. For Custom apps, the `conversations.history` and `conversations.replies` API methods are limited to 50+ requests per minute. The maximum and default values for the limit parameter are 1,000 objects.

> Internal customer-built applications are not impacted by these changes and continue to have a rate limit of 1,000 messages per request at 50+ requests per minute.

> No, internal customer-built apps are not impacted and retain their current, higher rate limits. The new rate limits only apply to commercially distributed applications outside the Marketplace.

[Changelog, 2025-06-03](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity):

> Any internal customer-built apps will maintain their existing rate limits and will not be subject to the new posted limits.

[`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history) and [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies), each:

> For Marketplace and internal customer-built applications, this method has Tier 3 rate limits.

[Rate limits](https://docs.slack.dev/apis/web-api/rate-limits):

> Slack is changing the way rate limits are applied to non-Marketplace apps. Apps already approved for the Slack Marketplace and internal customer-built applications should not see rate limit changes.

### The question the exemption leaves open

[Changelog, 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps), FAQ:

> **Commercial Distribution**: The updated terms confirm that the Slack Marketplace is the only appropriate channel for commercially distributing apps built with Slack APIs, whether those apps are "unlisted" (published outside of the Marketplace) or provide a customer instructions for a templated custom app that connects to your product.

[API Terms of Service updates, 2025-05-29](https://docs.slack.dev/changelog/2025/05/29/tos-updates):

> **Commercial Distribution:** The updated terms confirm that the Slack Marketplace is the only appropriate channel for commercially distributing apps built with Slack APIs, whether those apps are unlisted (published outside of the Marketplace) or templatized one-off "custom" apps.

[Slack API Terms of Service updates, 2025-10-13](https://docs.slack.dev/changelog/2025/10/13/api-terms-update):

> The “Distribution Beyond Your Organization” section has always only applied to applications distributed beyond your organization (i.e., third-party apps, not custom internal ones), but we added more language throughout emphasizing that.

[App lifecycle & distribution](https://docs.slack.dev/app-management/distribution) on the kind of app the owner creates:

> Undistributed apps exist on a single workspace and can use the full range of app capabilities, but they can't be distributed to other workspaces.

### How Slack counts and signals limits ([rate limits](https://docs.slack.dev/apis/web-api/rate-limits))

- Scope: "applied on a "_per API method per workspace/team per app_" basis", and "Your app's requests to the Web API are evaluated per method, per workspace. Rate limit windows are per minute."
- Tiers: Tier 1 "1+ per minute", Tier 2 "20+ per minute", Tier 3 "50+ per minute", Tier 4 "100+ per minute"; the special tier's conditions "are unique".
- Bursts: "we do recommend you design your apps with a limit of 1 request per second for any given API call, knowing that we'll allow it to go over this limit as long as this is only a temporary burst."
- A 429: "Slack will return a `HTTP 429 Too Many Requests` error, and a `Retry-After` HTTP header containing the number of seconds until you can retry." It holds one method only: "Calls to other methods on behalf of this workspace are not restricted."
- Events: "Event deliveries to your server via the Events API currently max out at 30,000 per workspace/team per app per 60 minutes."

### Socket Mode ([using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), [HTTP or Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode))

- "Apps using Socket Mode are _not_ currently allowed in the public Slack Marketplace."
- `apps.connections.open` takes the app-level token: "Remember to send the token in the `Authorization` header, not as a parameter." It is Tier 3 ([reference](https://docs.slack.dev/reference/methods/apps.connections.open)).
- "Socket Mode allows your app to maintain _up to 10_ open WebSocket connections at the same time."
- Disconnects: `link_disabled` when Socket Mode is turned off, "a warning about 10 seconds before the disconnect", and `refresh_requested`; "you'll need to handle connection refreshes once every few hours." For testing: "you can append `&debug_reconnects=true` to your WebSocket URL when you connect to it in order to make the connection time significantly shorter (360 seconds)."
- "Your app still needs to acknowledge receiving _each event_ so that Slack knows whether to retry", with `{"envelope_id": …}` and an optional payload. The spike never sends a payload.

## The methods the spike calls

| Method | Internal app | Unlisted app installed since 2025-05-29 | Spike's use |
|---|---|---|---|
| `conversations.history` | Tier 3; `limit` default 100, maximum 999 | 1 a minute; `limit` 15 | the poller's window; a pre-claim read |
| `conversations.replies` | Tier 3; `limit` default 1,000 | 1 a minute; `limit` 15 | changed and owner threads; a pre-claim read |
| `conversations.info` | Tier 3 | unchanged | pre-claim channel facts (M0.25 records its headers) |
| `users.conversations` | Tier 3 | unchanged | the conversation list |
| `auth.test` | special: "This method allows hundreds of requests per minute." | unchanged | the owner's id; the hub's revocation check |
| `apps.connections.open` | Tier 3 | unchanged | the Socket Mode URL |

Tiers and `limit` values are from each method's reference page (`https://docs.slack.dev/reference/methods/<method>`).

**A deviation from plan §4.** The `slack-v1` profile names `conversations.list`, and so does the request sent to Slack on 2026-10-17, in its list of DraftYak's calls. The spike lists conversations with `users.conversations` instead, which returns only the conversations the owner belongs to, of every type, where `conversations.list` returns every public channel in the workspace. ADR 0008, M6's `slack-v1` profile and `docs/compliance/slack.md` should name `users.conversations`, and a citation of Slack's reply should note that the method set differs from the request. The spike asks for no user-profile scope: nothing it does calls `users.info`, which M6 adds with `users:read` for the profile data the approval window shows.

## How the spike budgets (`src/poller.ts`, `src/socket-mode.ts`)

- One token bucket per tier at the tier's floor: 1, 20, 50 and 100 a minute, and 100 for `auth.test`. Each holds a tenth of a minute's budget as burst (one for Tier 1). Slack counts per method, so sharing a bucket across a tier's methods is conservative.
- A 429 holds only its method, for `Retry-After` seconds (an HTTP-date is also read), or 60 s when the header is missing; the same request is then sent again. A transient failure backs off 1, 2, 4 s.
- Every `Retry-After` wait is at least the caller's current backoff step, so `0` or a past date never means an immediate retry, and at most 15 minutes, whatever the header says. No timer gets more than 2^31−1 ms: Node fires a longer one after 1 ms (plan §3 Scheduler).
- `apps.connections.open` waits out `Retry-After` the same way; other failures back off from 1 s, doubling to 60 s, with jitter, and a connection that said `hello` resets the backoff. `warning` and the `refresh_requested` that follows it on the same connection open one replacement between them.
- Each cycle reads the DMs and MPIMs active in the last 24 hours, any never read before, and the next five quiet ones in turn; then the channels active in the last 24 hours and the next five quiet ones in turn. A cycle's reads follow recent activity, not the number of conversations, and a quiet DM waits for its turn.
- A read stops after 10 pages: 2,000 conversations, 1,000 messages of a history window, 1,000 replies of a thread. Each cut-off read counts in the cycle's `truncated`; a cut-off thread is read on from where it stopped the next time its parent shows. A failed `auth.test` or conversation list counts in `failed` and is retried next cycle; only an auth failure stops the poller.

## If the exemption doesn't hold

What M0.40 plans for, as ADR 0015's fallback:
- **Claim-time reads.** `conversations.replies` and `conversations.history` would each allow one call a minute per workspace, and return at most 15 objects, below the pre-claim read's `limit` 20. Each scheduled Slack claim needs one of them (plus `conversations.info`, which is unaffected), so claims due in the same minute would queue a minute apart per method. A read that can't be made in time never lets a claim through: it retries on the next tick, and past `deliverBy` the item goes to NEEDS_REAPPROVAL (`missed`), as plan §3 already says. With the default 15-minute lateness window, that caps a burst of due items at about 15 per method.
- **Sync.** The poller would read one conversation a minute, so a workspace with 30 conversations would take half an hour per cycle. Socket Mode events would be the only practical sync path, with history and replies kept for claim-time reads.
- **Unaffected.** `conversations.info`, `users.conversations`, `auth.test`, `apps.connections.open` and Socket Mode itself.

## Open points for M0.25 and the gate

1. Whether Slack treats an app the owner creates from DraftYak's manifest as internal customer-built (fact 5): Slack's written answer, and the owner's reading at the gate.
2. Whether the exemption shows on the owner's test app. M0.25 can check it with two calls: a `conversations.history` call with `limit=100` in a channel holding more than 15 messages returns more than 15, and a second call within the same minute succeeds (an app under the new limits would get a 429 with `Retry-After`).
3. The internal `limit` ceiling: the changelog says 1,000 objects, the `conversations.history` page says "Maximum of 999".
4. Which rate-limit headers Slack sends on success: the pages name only `Retry-After` on a 429. M0.25 records the header names (and values for `*ratelimit*`, `retry-after` and `content-type` only) for `conversations.info`, `conversations.replies` and `conversations.history`. `callSlack` returns the headers only on success, and a `SlackError` keeps none, so M0.25 passes `CallOptions.fetch` a wrapper that notes each response's headers before `callSlack` reads it, which covers the 429 of point 2 too.
5. Whether user events reach a user-token app with no bot user over Socket Mode at all, per event type: the S6 question itself.
6. Whether a bot-less app can subscribe to `app_uninstalled` and `tokens_revoked`, which plan §3's hub-observed revocation listens for. Both need no scope; Slack's event pages don't say which list they belong in. In session 2, after installing from `manifest.yaml`, the owner opens the app's Event Subscriptions page, tries to add both under "Subscribe to events on behalf of users", saves, and reinstalls if Slack asks; no bot user is added for them. ADR 0008 records whether Slack accepted them and whether uninstalling the app at the end of the session delivered either event over Socket Mode; `manifest.yaml` stays as it is. If Slack refuses them, M6 relies on its own `auth.test` (`token_revoked`, `invalid_auth`), which the plan already counts.
7. Redelivery: Slack's Socket Mode guide doesn't show the envelope of a retried event. The spike's fake sends a new `envelope_id` with the same `event_id`, `retry_attempt` and `retry_reason`; the client acks every envelope once and drops a repeated `event_id`. M6's FakeSlack keeps that assumption until a live session sees a retry.
8. Whether Slack's manifest validator accepts `is_mcp_enabled: false`; it's documented for both manifest versions. If it's refused, the line comes out (false is the default).

## Sources

All read on 2026-10-17:
- [Rate limit changes for non-Marketplace apps](https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps) (2025-05-29, updated since)
- [API Terms of Service updates](https://docs.slack.dev/changelog/2025/05/29/tos-updates) (2025-05-29)
- [Clarifying rate limit changes for non-Marketplace apps](https://docs.slack.dev/changelog/2025/06/03/rate-limits-clarity) (2025-06-03)
- [Slack API Terms of Service updates](https://docs.slack.dev/changelog/2025/10/13/api-terms-update) (2025-10-13)
- [Rate limits](https://docs.slack.dev/apis/web-api/rate-limits)
- Method references: [`conversations.history`](https://docs.slack.dev/reference/methods/conversations.history), [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies), [`conversations.info`](https://docs.slack.dev/reference/methods/conversations.info), [`users.conversations`](https://docs.slack.dev/reference/methods/users.conversations), [`auth.test`](https://docs.slack.dev/reference/methods/auth.test), [`apps.connections.open`](https://docs.slack.dev/reference/methods/apps.connections.open)
- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), [Comparing HTTP & Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode), [Events API](https://docs.slack.dev/apis/events-api)
- [App lifecycle & distribution](https://docs.slack.dev/app-management/distribution), [App manifest reference](https://docs.slack.dev/reference/app-manifest), [Tokens](https://docs.slack.dev/authentication/tokens)
- Event and scope references: [`message`](https://docs.slack.dev/reference/events/message), [`message.im`](https://docs.slack.dev/reference/events/message.im), [`message.mpim`](https://docs.slack.dev/reference/events/message.mpim), [`message.channels`](https://docs.slack.dev/reference/events/message.channels), [`message.groups`](https://docs.slack.dev/reference/events/message.groups), [`app_uninstalled`](https://docs.slack.dev/reference/events/app_uninstalled), [`tokens_revoked`](https://docs.slack.dev/reference/events/tokens_revoked), [`connections:write`](https://docs.slack.dev/reference/scopes/connections.write)
