# Privacy

DraftYak is a local-first inbox. Core has zero telemetry: no usage analytics or automatic crash reporting. `DO_NOT_TRACK` is honored. Update checks are opt-in. No DraftYak offering, including core, Cloud or Team, shows ads or sells data. This notice describes the hub, clients and plugins; providers and clients you connect also apply their own policies.

## Storage and control

The hub keeps account data, tokens, drafts and approvals encrypted at rest. Credentials stay under the hub's control and are not handed to plugins, tools or connected agents. For SMS, the SIM stays on the owner's phone; the hub sends the paired host single-use send tickets.

Gmail metadata is kept while the account is connected. Cached Gmail bodies are evicted by default after 90 days without access, with a configurable interval, and can be fetched again on demand. Slack has a rolling 90-day cap, enforced by a daily purge. SMS copies have a rolling 90-day retention window by default, configurable from 30 to 365 days; removing a hub copy does not erase the phone's system message store or a carrier's copy. Export is available.

Disconnect purges the account's retained data in batches. Only revocation the hub observes triggers revocation handling: Slack data is purged within 14 business days of observed revocation; Gmail `invalid_grant` starts a visible, configurable 30-day deletion deadline with notifications, after which the account is purged if the owner has not reconnected. Revoking an SMS host pauses its accounts rather than purging them. Disconnect lists existing hub-state backup files that still contain the account's credentials, drafts or outbox and prompts the owner to delete or re-create them. Pre-migration snapshots are kept for seven days and deleted on purge.

TODO(owner): Confirm that these retention defaults and the disconnect, deletion and backup procedures match the launch release and its settings, including Slack's cap and observed-revocation deadline.

Approved scheduled messages and their approvals wait encrypted in the hub database and hub-state backups until sent, cancelled or purged. Providers do not hold the scheduled item. Pre-flight and claim-time checks contact only that account's provider or paired phone. The approved content and send window stay frozen; a missed window needs new approval. Slack data is excluded from paid backups and push content, including scheduled-send content.

## Routing and consent

Only loopback `local` AI and lookup destinations are allowed by default. Each other destination requires an opt-in per account, with the recipient, fields and training posture disclosed immediately before affirmative consent. Consent version and time are stored. Widening access requires an admin operation with step-up verification; tightening access does not.

Gmail, Slack and SMS data never go to an endpoint declared “may train.” `local-network` and `cloud-no-train` destinations require consent. A public `cloud` endpoint must be declared no-train by the owner before it qualifies. `cloud-consumer-plan` and `mcp-client` access also require this acknowledgement: “I turned off model training; the provider's policy forbids training on this data.” Slack additionally requires an opt-in naming the provider for every non-local destination. Training-off declarations do not promise zero provider retention.

Message bodies, headers, attachments and unverified metadata never become lookup arguments. The hub binds arguments before a model runs, using only verified metadata, owner settings, the clock and constants. SMS sender numbers are device-asserted and can be spoofed; they never reach tool inputs. Auto-draft lookups send no message-derived values.

Each tool instance needs consent per account and instance. Its disclosure and Security Center entry name its exact host, data classes and fields, destination class, training posture, AI recipients of its results and retention. The class is rechecked when configuration or DNS changes: no egress or loopback is `local`; private RFC 1918 or ULA addresses are `local-network`; other addresses are `cloud-tool`. A cloud tool defaults to “may train”; declaring no-train requires an admin operation. Gmail- and Slack-derived values cannot go to a may-train tool. Slack-derived values also require a provider-named opt-in. Before a cloud tool receives message-derived values, an on-demand draft requires “Draft with these lookups.”

## Outbound destinations and triggers

The table lists destination families. Exact account, provider, plugin and tool-instance hosts and fields are listed in the Security Center before consent; owner-configured hosts vary by installation. Network recipients also see the connecting IP address and request time.

| Destination | Trigger | Information received |
| --- | --- | --- |
| Account provider's authorization and token hosts | Connecting, refreshing or revoking an account | The required authorization exchange, scopes and credentials for that provider; no shared Google client ID is bundled |
| Selected AI service's sign-in, authorization and token hosts | Owner-initiated sign-in, token refresh or revocation | The selected account's authorization exchange, consent and token requests; API-key access remains a separately selected route |
| Gmail account's provider hosts | Sync, user actions, draft-related account reads, send pre-flight and claim-time checks, and an approved send | Account-scoped API requests; an approved send's recipients and exact content; other requests receive their requested operation and identifiers |
| Slack account's API and Socket Mode hosts | Connecting the owner's internal app, sync, user actions, reply checks and an approved send | Account/workspace-scoped requests and identifiers; the approved message when sending; scheduling stays in the hub |
| Chosen AI provider or local model host | A requested draft, enabled auto-draft or model setup probe | Consented draft context and lookup results; a probe receives only what its setup disclosure states |
| Each configured tool host | An on-demand draft whose lookup chips include it, auto-draft with no message-derived inputs, setup probe, or re-probe after a 401, 403 or 404 indicates “needs a new address” | Only the bound fields for that tool, described below; no message content |
| Plugin download source selected for installation | An explicit plugin install or update | The package/artifact request and ordinary connection metadata; no inbox content |
| CIMD document and JWKS hosts | Connected-client consent and the associated metadata/key verification | Client metadata and public-key fetch requests, IP and time; no inbox content |
| Configured local AI probe address | Model discovery or setup initiated by the owner | Discovery/probe request; no inbox content |
| Owner's HTTPS tunnel endpoint and tunnel operator | Establishing or maintaining remote access and carrying connected client traffic | Connection metadata and the traffic handled under the selected tunnel's TLS/termination arrangement; inspect that operator's policy |
| Paired DraftYak SMS host and owner's hub | Pairing, pinned-mTLS connection, SMS/MMS sync, status checks, and approved single-use send tickets | Phone-to-hub SMS/MMS data and status; hub-to-phone approved SMS details and signed tickets |
| Release/update host | An opt-in update check or owner-requested update download | Version/platform update request or selected release download and ordinary connection metadata |
| PyPI and the pinned Pyodide package index, developer tool only | A developer runs `draftyak-plugin build` | Dependency names, versions and package requests; no inbox content |

TODO(owner): Fill in the exact release/update hosts, first-party plugin download hosts and model-setup probe fields for the launch release, and reconcile every table entry with the Security Center and egress recorder before launch. List each installed tool instance's resolved host and fields there; do not substitute a generic provider name for its host.

### Lookup fields and results

| Tool kind | Fields sent |
| --- | --- |
| `calendar.freebusy` | A fetch to the owner's secret iCal link; no message-derived fields. The calendar host sees the fetch, IP and time. Treat the link itself as a secret. |
| `contact.notes` | A hub-verified sender email address or Slack user ID; never an SMS number or message text |
| `kb.lookup` | An owner-defined topic; never a topic extracted from a message |

Tool results inherit `tool.<kind>` and the class of any message-derived argument. They reach only an AI destination named in consent and permitted by that class's routing. Results stay in memory for at most 10 minutes, and only for that draft job when an argument is Slack-derived; they are never stored or backed up, and are treated as untrusted data. A new tool or host requires an updated disclosure and destination inventory.

MCP tools and reads answer clients the owner connected. Resources, prompts, completion, elicitation and Apps introduce no additional destination. `/status` is served to a client, never fetched. Apps views load no external resources. Content displayed by an AI client, including an Apps view, passes through that vendor's infrastructure. A client's permission prompt or “Always allow” setting never approves a send.

The Python runtime ships with the hub as `@draftyak/runtime-python`; plugin bundles contain their wheels. Installed plugins do not fetch a runtime from a CDN or contact PyPI or the Pyodide index at runtime. The egress recorder checks the destination inventory, including tool plugins, and rejects runtime requests to those package hosts; the SMS emulator suite checks that the host contacts only the hub.

The self-hostable relay and hosted relay follow the MVP. Any later relay, push or backup service must disclose its destinations, data and triggers before use and preserve [STEWARDSHIP.md](STEWARDSHIP.md).

## Android SMS

Only the separate DraftYak SMS host reads the phone's SMS/MMS store, through official Android APIs. It talks only to the owner's hub over pinned mTLS; no DraftYak, Google or Firebase server handles that link. The main Tauri client has no SMS permission or notification listener. The host does not request the default-SMS role and has no RCS send or unofficial bridge. RCS may be missing or partial; MMS and group sends follow the MVP.

Texts stay local unless the account is opted into another destination under the routing rules above. They include other people's messages and may contain one-time codes. OTP-like, short-code and alphanumeric-sender texts remain visible in DraftYak but are excluded from AI and MCP tools, resources, prompts and completion by default. Changing that exclusion is an admin operation. No text content ever reaches lookup inputs or triggers a lookup, regardless of the setting. Android 17 delays OTP texts to non-default SMS apps by three hours; DraftYak accepts that delay.

Replies use plain SMS, which carriers can read. The approval guarantee covers what the DraftYak SMS host sends. A compromised phone or another app with SMS-send permission can send outside DraftYak; revoking the host stops that host, not the phone. A process running as the hub's OS user can also access that user's keychain. See [SECURITY.md](SECURITY.md).

## Questions and legal review

Use [SECURITY.md](SECURITY.md) for a suspected privacy breach. Do not put message content, credentials or personal data in public issues.

For privacy questions and requests, email [draftyak@gmail.com](mailto:draftyak@gmail.com) privately.

TODO(owner): Publish the responsible legal identity and any jurisdiction-specific notice and rights procedures after pre-launch legal review; do not infer a company, address, legal basis or statutory deadline.

TODO(owner): Complete legal review of this notice, actual data flows, retention, exports, deletion, backups, tunnel handling, vendor terms and consent language before launch. Resolve the four Google readings and the Slack user-ID/cloud-tool reading in [the compliance documents](docs/compliance/google-workspace.md), including Slack's written confirmation in [slack.md](docs/compliance/slack.md).
