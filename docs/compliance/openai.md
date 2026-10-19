# OpenAI compliance

This document maps DraftYak's launch requirements to OpenAI's public terms and official documentation. It does not claim endorsement or account eligibility. [Privacy](../../PRIVACY.md) describes the destinations and consent triggers.

## Access and data

| Rule or policy concern | DraftYak requirement |
| --- | --- |
| Sign in with ChatGPT offers eligible plan usage to open-source, locally hosted applications; paid or remotely hosted applications need separate consideration. | DraftYak implements the documented sign-in flow clean-room. It does not use the noncommercial DevKit, another application's OAuth identity, private credential files, client packages or private web backend. An optional owner-supplied API key is a separate choice. [Plan-usage overview](https://developers.openai.com/siwc/token-sharing-open-source) (read 2026-10-17). |
| Deployment and background-use confirmation remain separate launch gates. | Auto-draft never uses Sign in with ChatGPT until OpenAI confirms background use is tolerated. Sign-in uses `prompt=consent` until OpenAI confirms the deployment. These are DraftYak's holds, not a claim that either confirmation has been received. [Plan-usage overview](https://developers.openai.com/siwc/token-sharing-open-source), [Consent guidance](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) (each read 2026-10-18). |
| Plan-usage inference uses the public Responses API with explicit storage and streaming settings. | Every inference request uses Responses with `store:false` and `stream:true`. No private web endpoint is used. [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses) (each read 2026-10-17). |
| Sign-in guidance requires a clear plan-usage and billing experience. | The owner sees which account and billing route are selected. Reaching a plan limit never silently switches to an API key or another billable route. [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) (read 2026-10-17). |
| API terms place input permissions and output evaluation on the customer and restrict use of customer content for improvement without agreement. | The owner must have permission to send inputs. Drafts remain subject to review, and each send requires PIN approval over exact content and timing. DraftYak does not opt protected channel data into training. [Services Agreement, sections 3-5](https://openai.com/policies/services-agreement/) (read 2026-10-17). |
| Consumer terms differ from API terms. | Plan use is evaluated under its applicable terms and controls; an API account's data posture is never assumed for a consumer account. [Terms of Use](https://openai.com/policies/terms-of-use/) (read 2026-10-17). |
| Storage controls do not eliminate every form of vendor retention. | `store:false` disables requested response storage, but does not promise zero vendor retention. API abuse-monitoring logs ordinarily last up to 30 days, with exceptions; caching and feature-specific retention also apply. Approved Zero Data Retention controls are separate. [Data controls](https://developers.openai.com/api/docs/guides/your-data) (read 2026-10-17). |
| Usage rules prohibit harmful uses and policy circumvention. | Untrusted content and lookup results are data, never approval. The hub plans lookups before inference; the model cannot choose tool arguments or send messages. PIN approval does not make a prohibited use permissible. [Usage policies](https://openai.com/policies/usage-policies/) (read 2026-10-17). |
| Brand guidance limits misleading naming and affiliation. | Vendor marks appear only in necessary plain-text descriptions, never in DraftYak product, package, command or application names. [Design guidelines](https://openai.com/brand/) (read 2026-10-17). |

## Channel restrictions

Loopback is the default. Every other AI destination needs per-account affirmative consent immediately after disclosure of the recipient, data and training posture. Gmail and Slack may-train destinations are always refused; SMS follows Gmail. Consumer-plan and MCP-client destinations also require the acknowledgement that training is off and the provider's policy forbids training on the data. Slack opt-ins name the provider.

Tool results reach only the consented AI destination and inherit any channel data class. Raw message content never enters lookup arguments. MCP clients and Apps views cannot approve a send. The AI panel and approval window show a reliability notice; an enabled outgoing disclosure footer is frozen into the approved message.

## Review before launch

- TODO(owner): Record legal approval of this mapping, the sign-in implementation's clean-room provenance, applicable sign-in terms and plan eligibility, including any paid or remotely hosted offering. Excluding the DevKit does not by itself establish permission.
- TODO(owner): Record OpenAI's answers on eligibility, the clean-room flow and background use before lifting either the auto-draft hold or the `prompt=consent` deployment hold.
- TODO(owner): Confirm that each offered account and plan's actual training, feedback and retention rules meet the Gmail, Slack and SMS restrictions and match the consent text. Do not equate `store:false`, no training and zero retention.
- TODO(owner): Confirm input permissions, required disclosures and any restrictions on intended uses under the applicable regional consumer or API agreement. Validate the plain-text vendor references and lack of implied endorsement.

The weekly vendor-terms watch hashes policy pages for review. Vendor-guard checks forbidden credentials, endpoints and names; request-shape, routing and approval tests remain separate release gates.
