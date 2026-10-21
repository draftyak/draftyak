# Google Workspace compliance

This document maps DraftYak's Gmail requirements to the Google Workspace API User Data and Developer Policy dated 2026-09-03. It separates product controls from interpretations that need legal confirmation. [Privacy](../../PRIVACY.md) covers destinations, consent and deletion.

DraftYak complies with Google's Limited Use requirements when using or transferring information received from Google APIs. This includes derived data.

## Policy mapping

| Policy requirement | DraftYak requirement |
| --- | --- |
| Use approved Gmail productivity purposes and minimum permissions. | Each owner supplies a Desktop OAuth client; the repository contains no client ID. Scopes are `openid email gmail.modify`, or `gmail.readonly` for read-only mode. No unrelated access is requested. |
| Disclose access, use and sharing in context before consent. | Disclosures appear immediately before Google consent and before any AI or agent consent. Non-loopback destinations require separate, per-account opt-in with the disclosure version and time recorded. Widening access requires an admin operation. |
| Limited Use restricts use, transfer, human access and model training for protected scope data, including derivatives. | Gmail content goes only to permitted local, local-network or no-training destinations. Consumer-plan and MCP-client access also needs the training-off acknowledgement. May-train destinations are refused. Verified Gmail-derived values follow the same restriction when used in a lookup. |
| Agentic invocations require granular confirmation. | The method matrix below controls agent access. A cloud lookup receiving Gmail-derived values also needs one explicit "Draft with these lookups" confirmation on that draft, in addition to account-by-tool-instance consent. |
| Delayed email sending is an approved productivity use. | Every send, including an agent proposal or scheduled reply, requires a paired desktop's PIN approval over exact frozen content and the send window. The hub holds scheduled items; there is no bulk, mail-merge, recurring or rule-triggered scheduling. Missed windows require re-approval. |
| Secure protected data, tokens and agentic integrations against injection. | Data and tokens are encrypted at rest. The hub binds tool arguments from verified metadata, owner settings, clock or constants before inference. Message content never becomes lookup input. Hygiene, spotlighting, typed results, visible flags and per-item approval protect privileged sinks. |
| Retain only necessary data and give users control. | Cached bodies follow the configured eviction interval. Disconnect revokes the grant at Google, purges the account's retained data in batches and lists hub-state backup files that still hold its credentials, drafts or outbox for the owner to delete or re-create. A hub-observed `invalid_grant` starts a visible, configurable 30-day deletion deadline with notifications, after which the account is purged unless the owner reconnects. Export is available. Tool results are never stored or backed up. |

Sources: [Google Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) (last updated 2026-09-03; read 2026-10-17), and [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) (last updated 2024-02-15; read 2026-10-17). These policies establish the obligations; the controls in the right column are DraftYak's launch requirements, not claims that Google has approved them.

## Agent access by MCP method

| Method or surface | Google data and confirmation boundary |
| --- | --- |
| `tools/call` | A device-approved agent session for the requested tool class is required before Google data is accessed. A proposed send still needs its own desktop PIN approval. |
| `resources/read` for mail | Requires a device-approved agent session for the `read` class, with the account's routing checks. |
| `resources/read` for the guide | Contains no Google data; no Google-data confirmation is required. It grants no mail access. |
| `resources/read` for `ui://` views | The view code contains no Google data and loads nothing. It grants no mail access. |
| `prompts/get` | First-party prompt text contains no Google data; it cannot authorize a tool or a send. |
| `completion/complete` | Contains no Google data and grants no access. |
| `elicitation/create` | Carries no Google data. Accepting elicitation never supplies the required confirmation or approval. |
| Apps views | Render only tool results already covered by the session and routing checks. Displaying a result never adds access or counts as approval. |

Agent sessions are time-boxed per tool class; Gmail's default is 15 minutes. Client prompts and blanket allow settings never substitute for device confirmation. Lookups are hub-planned before the model sees the message. Auto-drafts never send Gmail-derived values to a tool.

## Review before launch

TODO(owner): Record owner/legal review of the retained desktop Gmail feature, send and one-off delayed-send approval, actual data flows and provider destinations, injection safeguards, scopes/OAuth setup and verification responsibilities, privacy disclosures and Limited Use statement, retention/deletion/export/backups (including the configurable 30-day deletion deadline and owner-deleted or re-created hub-state backups), and nominative channel-descriptor naming before publication. Record current source versions, release applicability, unanswered issues and conditions. A user-supplied OAuth client, successful spike or policy hash does not itself establish an exemption or approval.

## Deferred interpretation reviews

The following four questions are preserved for tools, lookups and MCP when those features resume. They are postponed, not approved, and are not prerequisites for this desktop pilot. This deferral does not waive baseline Gmail, privacy, security or enabled-provider obligations; the policy has not been interpreted to approve these readings.

1. TODO(owner): Confirm that a secret iCal feed fetched without a Google API or scope carries no Google Limited Use obligations. The calendar lookup sends no message data to the feed host.
2. TODO(owner): Confirm that one "Draft with these lookups" confirmation per draft is sufficiently granular for the selected cloud lookups receiving Gmail-derived values.
3. TODO(owner): Confirm that a time-boxed, device-approved agent session per tool class, with Gmail's 15-minute default, is sufficiently granular for MCP tool calls and mail resource reads.
4. TODO(owner): Confirm that a Gmail auto-draft may run a cloud-tool lookup receiving no Gmail data without a per-draft confirmation. If rejected, Gmail auto-drafts run only local and local-network lookups.

Vendor-guard rejects embedded Google credentials. Routing, lookup planning, consent and send-approval gating tests check the remaining boundaries. The weekly vendor-terms watch hashes the cited policies and triggers review when they change; it cannot resolve these legal readings.
