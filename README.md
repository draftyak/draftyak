# DraftYak

The local-first, open, human-approved AI inbox.

**In development.** This repository contains source, development tools and milestone plans. The desktop pilot below is a planned release target; source and documentation do not establish a shipped or installable application. See the [launch-readiness backlog](docs/roadmap/m11.md) for remaining work and gates.

## Selected desktop pilot

The planned v0.1.0 release combines the desktop app and bundled hub with Gmail, Slack, reply drafting and one-off scheduled send. Paired remote desktops and their hub connections remain in scope. Only the five bundled first-party plugins listed in [PRIVACY.md](PRIVACY.md) are selected.

| Selected installer target | Native-store release requirement |
| --- | --- |
| Windows NSIS | Windows Credential Manager |
| Apple-silicon macOS DMG | macOS Keychain; actual prompts after updates must be measured |
| Ubuntu 24.04 deb | Working Secret Service, GNOME Keyring or KWallet; absence must refuse with guidance, without a Linux passphrase fallback, silent new identity or silent re-pair |

These are design and release obligations, not completed platform results. Per-OS installer and first-run quickstarts remain blocked on actual installers and verified product flows. Artifact, signing, native-platform, owner and legal acceptance remain open; publication requires the owner's explicit approval.

Mobile/Android SMS, browser login/access, context tools and lookups, MCP, Python, the plugin-author kit, third-party plugin installation, headless npm/Docker deployment and network update checks are postponed. Optional sign-in is separately maintained and does not block launch.

## Approval and privacy model

The release must preserve these boundaries:

- Every send needs a paired desktop's PIN-verified approval over the exact frozen content and send window. The approval is consumed once while its approver remains confirmed and non-revoked.
- The desktop must be awake and running for a scheduled send. A missed window requires fresh approval; no repeating sends, wake-to-send or provider-held scheduling is selected.
- Message content and asserted metadata are untrusted data. A draft or client consent prompt cannot approve a send, and inbound content cannot start or advance one.
- Account data, tokens, drafts and approvals must remain encrypted at rest, credentials must stay in the hub and core must have zero telemetry. Data destinations require the disclosures, consent and routing restrictions in [PRIVACY.md](PRIVACY.md).
- The security model excludes a process already running as the hub's OS user, which can access that user's keychain. See [SECURITY.md](SECURITY.md) for the full model and private reporting route.

## Project documents

- [Contributing](CONTRIBUTING.md) and the [repository map and command reference](AGENTS.md).
- [Support](SUPPORT.md), [accessibility](ACCESSIBILITY.md) and [community conduct](CODE_OF_CONDUCT.md).
- [Governance](GOVERNANCE.md), [maintainers](MAINTAINERS.md) and [stewardship commitments](STEWARDSHIP.md).
- [Apache-2.0 licence](LICENSE) and the separate [trademark policy](TRADEMARKS.md).

Keep credentials, message content and other people's information out of public reports. Use the private route in [SECURITY.md](SECURITY.md) for suspected vulnerabilities or data exposure.
