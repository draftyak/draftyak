# Slack compliance

This document maps DraftYak's Slack requirements to the public API Terms and App Developer Policy. It does not claim Marketplace approval, a commercial agreement or written permission. [Privacy](../../PRIVACY.md) describes data flows.

## Policy mapping

| Vendor rule or policy concern | DraftYak requirement |
| --- | --- |
| API use needs installing-organization authorization and minimum necessary processing. | The owner creates an internal app from the supplied manifest, using Socket Mode and a user token. DraftYak uses `users.conversations` to list only the owner's conversations of every type, replacing `conversations.list` in the original plan and the 2026-10-17 request to Slack. M6 adds `users.info` with `users:read` only for the approval window's profile data; the spike requests no such scope. See [the recorded method set and deviation](../../spikes/s06-slack/notes/rate-limits.md#the-methods-the-spike-calls). Scope and access remain limited to the connected account's permitted use. |
| The Developer Policy requires secure handling and a public privacy policy. | Data and tokens are encrypted at rest. The destination, fields, training posture and retention are disclosed before consent; widening access requires an admin operation. Public reports must contain no message content or credentials. |
| Slack data must not train an LLM. | No Slack data trains a model. May-train destinations are refused. Every non-local destination requires a provider-named opt-in and the training-off acknowledgement. A consumer setting alone cannot override a contrary provider policy. |
| Retention must be necessary; app deletion or discontinuation requires deletion within 14 business days. | DraftYak also imposes a rolling 90-day cap and purges on observed revocation within 14 business days. The 90-day cap is a product limit, not a claim that Slack requires or authorizes that duration. Shorter necessary retention still applies. |
| Third-party sharing and third-party benefit are restricted. | Slack-derived tool inputs need per-account-by-instance consent. A non-local tool also needs a provider-named opt-in and a no-training posture. Results derived from Slack inputs live only for that draft job and are never stored or backed up. The external-tool interpretation below requires written confirmation. |
| Commercial distribution may require a separate agreement, including free apps connected to paid services. | Slack features are never payment-gated; `slack.*` data is excluded from paid backups and push content. These product limits do not establish an exemption from Slack's distribution rules. |

Sources: [Slack API Terms](https://slack.com/terms-of-service/api) (effective 2025-10-10; read 2026-10-17), and [Slack App Developer Policy](https://docs.slack.dev/developer-policy/) (effective 2024-12-10; read 2026-10-17).

## Sends, tools and rate limits

The hub schedules messages; the broker denies Slack-native scheduling methods. The API Terms do not expressly address this scheduling design. Each item requires PIN approval on a paired desktop over its exact frozen content and send window. The hub never sends before or after the approved window, and a missed window needs re-approval. Core has no automatic replies, forwarding, bulk, recurring or rule-triggered sends.

Sends retain DraftYak's rate discipline. Claim-time reply checks rely on the treatment for customer-built internal applications. That is an exception to particular changes to history and reply limits, not an exemption from all limits. Requests respect method and workspace limits and `Retry-After` responses. [Slack Web API rate limits](https://docs.slack.dev/apis/web-api/rate-limits/) (read 2026-10-17).

DraftYak never uses the Real-time Search API or Slack's MCP service. First-party MCP surfaces expose only the hub's permitted pipeline; they never approve a send or widen access. Message content never becomes lookup input. The hub can bind a verified Slack user ID for a consented contact lookup, but external use remains subject to the legal gate below. Untrusted tool results cannot select further lookups or authorize privileged actions.

## Review before launch

- TODO(owner): Obtain legal approval and Slack's written confirmation that sending Slack user IDs to owner-selected cloud tools, and processing the results, meets the API Terms' third-party-benefit and minimum-retention restrictions and the Developer Policy's sharing restrictions. Provider opt-in is not treated as a waiver.
- TODO(owner): Confirm the internal-app and distribution classification, any required Slack agreement for distribution or connection to paid services, and the rate treatment needed for claim-time reply checks. Keeping Slack features free does not answer these questions.
- TODO(owner): Record Slack's written confirmation for the actual method set above. Any citation of Slack's reply must note that this method set differs from the 2026-10-17 request.
- TODO(owner): Obtain Slack's written confirmation that exposing Slack content to the owner's own AI agents is permitted under the API Terms and Developer Policy.
- TODO(owner): Obtain Slack's written confirmation that DraftYak falls under neither the [API Terms' API Access (C)](https://slack.com/terms-of-service/api), which bars accessing the APIs "in order to replicate or compete with the Services", nor the [Developer Policy's](https://docs.slack.dev/developer-policy/) bar on "Using the Slack API to replicate or compete with core products or services offered by Slack". The API Terms take precedence over the Developer Policy.
- TODO(owner): Record legal approval of this mapping, the hub-held scheduling reading, retention and revocation behavior, data-breach response duties, applicable age restrictions, consent wording and nominative channel-descriptor naming.

Vendor-guard blocks excluded search and MCP interfaces. Gating tests cover routing, the 90-day cap, revocation purge, job-scoped results, send approval and paid-content exclusions. The weekly vendor-terms watch hashes policy pages for review; a matching hash does not establish permission.
