# Anthropic compliance

This document maps DraftYak's launch requirements to Anthropic's public terms. It is a review record, not an endorsement or a claim that a particular account or use has been approved. [Privacy](../../PRIVACY.md) describes the data flows.

## Policy mapping

| Rule or policy concern | DraftYak requirement |
| --- | --- |
| The Commercial Terms cover API keys and permit customer applications; the Consumer Terms limit automated access. | The optional direct integration uses the owner's Console API key and the MIT `@anthropic-ai/sdk`. DraftYak offers no consumer-service login or subscription OAuth. It never reads another application's credentials or private configuration, invokes a consumer CLI to generate drafts, or uses the proprietary Agent SDK in either language. [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), [Client SDK](https://github.com/anthropics/anthropic-sdk-typescript) (each read 2026-10-17). |
| Commercial Terms B and D.3 address training and unreliable outputs. | DraftYak sends protected channel data only to a permitted no-training destination after account consent. The AI panel and approval window warn that drafts may be inaccurate and must be checked. A paired desktop requires PIN approval over each exact message and send window. [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (read 2026-10-17). |
| Commercial privacy guidance describes training exceptions for explicit feedback or opt-in. | DraftYak never opts channel data into training. An API's ordinary no-training posture does not authorize feedback, model improvement or another use of that data. Consumer-client connections have their own plan and training checks. [Training guidance](https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training) (read 2026-10-17). |
| Usage rules address privacy, deception, harmful uses and additional obligations for certain applications. | DraftYak's draft-and-review workflow does not grant permission for a prohibited use. Message content and tool results are untrusted data. The hub binds lookup arguments before the model runs; there is no model-controlled send or approval. The optional disclosure footer is part of the approved frozen snapshot, including for scheduled messages. [Usage Policy effective 2025-09-15](https://www.anthropic.com/legal/archive/22742366-2ef0-4c7a-a833-6523f10d3944) (read 2026-10-17). |
| The terms do not grant general rights to the vendor's intellectual property. | Vendor names appear only as plain-text references. DraftYak product, package, command and application names contain no Anthropic or Claude marks. [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) (read 2026-10-17). |

Claude applications may connect as owner-authorized MCP clients. That connection does not let DraftYak use a subscription as an API credential. MCP has no send tool; client prompts, blanket allow settings, elicitation and Apps views cannot approve a send or widen access. Gmail and Slack destinations declared may-train are refused. Consumer-plan and MCP access also requires the per-account training-off acknowledgement; Slack additionally requires an opt-in naming the provider. SMS follows Gmail's routing rules.

## Review before launch

- TODO(owner): Record legal approval of this mapping, the applicable API and MCP-client terms, input permissions, and privacy disclosures. Confirm that every offered plan's actual training exceptions satisfy the Gmail, Slack and SMS routing restrictions; a training-off setting alone must not hide an incompatible exception.
- TODO(owner): Confirm whether the optional outgoing disclosure footer is sufficient for the intended uses and identify any use requiring mandatory disclosure or additional review. Human approval alone does not establish policy compliance.
- TODO(owner): Reconcile the policy version at launch. On 2026-10-17 the [current Usage Policy URL](https://www.anthropic.com/legal/aup) displayed an effective date of 2026-11-12; the linked archive above displayed 2025-09-15. Both were read on 2026-10-17. Confirm the applicable version and review any changed obligations before release.

The weekly vendor-terms watch hashes the policy pages. A changed page triggers review; a hash is not legal approval. Static vendor checks cover forbidden authentication, SDK and naming patterns; routing, prompt handling and approval require their gating tests as well.
