# Support

DraftYak support takes place in the [DraftYak repository](https://github.com/draftyak/draftyak). Community help has no guaranteed response time.

The selected v0.1.0 pilot targets Windows NSIS, Apple-silicon macOS DMG and Ubuntu 24.04 deb installers with the desktop app and bundled hub. Its scope is Gmail, Slack, drafting and one-off scheduled send, with only the bundled first-party plugins listed in [PRIVACY.md](PRIVACY.md). Paired remote desktops and their hub connections remain in scope. Installer availability, first-run instructions and real platform results still need confirmation before launch.

| Need | Where to go |
| --- | --- |
| Setup, usage or troubleshooting | [Discussions: Q&A](https://github.com/draftyak/draftyak/discussions/categories/q-a) |
| An idea to explore | [Discussions: Ideas](https://github.com/draftyak/draftyak/discussions/categories/ideas) |
| A design change | [Discussions: RFCs](https://github.com/draftyak/draftyak/discussions/categories/rfcs) |
| A reproducible bug, feature or documentation correction | [Issue forms](https://github.com/draftyak/draftyak/issues/new/choose) |
| A suspected vulnerability or vendor-policy breach | [Private reporting instructions](SECURITY.md) |
| An accessibility barrier | [Accessibility reporting](ACCESSIBILITY.md) |
| Community conduct | The private contact in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

## A useful report

Include the DraftYak version, installation method, operating system, affected component and minimal steps using synthetic data. Explain what you expected and what happened. For a scheduled send, describe the state and timing without copying its content or approval.

Never post message bodies, headers, attachments, phone numbers, contact details, secret calendar links, credentials, pairing codes or database files. Check screenshots and logs before sharing. A public issue is not a place to upload an inbox or a support archive. Report suspected data exposure privately through SECURITY.md.

DraftYak's security reporting route also accepts suspected plugin sandbox or permission failures.

## Limits to keep in mind

Sending requires PIN approval on a paired desktop over the exact frozen content and send window. The desktop must be awake and running for scheduled sends; a missed window requires fresh approval. See [SECURITY.md](SECURITY.md) for the same-OS-user security limit and the [privacy notice](PRIVACY.md) for retained disclosure requirements. Native behavior, accessibility and the selected operating systems keep their own release checks.

Mobile/Android SMS, context tools, MCP/Apps, Python, the plugin-author kit, third-party plugin installation, headless npm/Docker deployment and network update checks are postponed. Optional sign-in is separately maintained and does not block launch. These scope statements do not establish product, platform or legal acceptance.

## Postponed feature support

When third-party plugins resume, start with the plugin's own support channel for a problem specific to it. A plugin to share belongs in [Discussions: Plugin showcase](https://github.com/draftyak/draftyak/discussions/categories/plugin-showcase) after that category and feature are available. The showcase is not a pilot launch prerequisite.

Future mobile clients may read, draft and organize; they cannot approve. The separate Android SMS host's retained scope is SMS sends and SMS/MMS reads; MMS and group sends remain later work, and RCS may be missing or partial. These are postponed requirements, not available pilot capabilities. The phone security limits remain in [SECURITY.md](SECURITY.md).

TODO(owner): Confirm that the Q&A, Ideas and RFCs Discussion categories exist at these URLs before launch. Confirm Plugin showcase when its postponed feature resumes.
