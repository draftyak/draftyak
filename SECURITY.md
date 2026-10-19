# Security policy

Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/draftyak/draftyak/security/advisories/new). Do not put exploit details, credentials or message content in a public issue, discussion or pull request.

If that form is unavailable, email [draftyak@gmail.com](mailto:draftyak@gmail.com) privately.

## Security model

Every send requires a paired desktop's PIN-verified approval over the exact frozen content and send window. The hub consumes that approval once, while the approver remains confirmed and non-revoked, and sends only inside the approved window. A missed window requires fresh approval. For plugin channels, the broker matches the request byte-for-byte to the approved rendering. For SMS, the hub signs a single-use ticket and the SMS host verifies it before making one send call.

Mobile clients can read, draft and organize but cannot approve. MCP, API, browser, rule, plugin and phone paths cannot approve or set a binding send time. Read-only MCP surfaces and an AI app's consent prompts never substitute for PIN approval. No recurring, rule-triggered or automatic sends are part of core.

Message content, headers, plugin- or device-asserted metadata, and tool results are untrusted data. They reach data sinks rather than privileged decisions unless a visible flag is shown. Inbound content can hold a scheduled send; it cannot start, advance or change one. The hub binds lookup inputs from verified metadata, owner settings, the clock or constants before drafting. Message content never reaches tool inputs, and SMS sender numbers never reach them either.

DraftYak warns when connecting a shell-capable client because the same-OS-user limit below still applies. `login-code` requires the PIN. Credentials stay in the hub; the SMS SIM stays on the phone, which receives tickets rather than hub credentials. See [PRIVACY.md](PRIVACY.md) for routing, consent, retention and outbound destinations.

## What to report

Reports about any release or the current source are welcome. Security fixes target the latest stable release and `main`; older release branches do not have a separate security maintenance commitment.

In scope:

- Sending without the required PIN approval, reusing approval, changing approved content or sending outside its approved time window.
- Prompt injection or other untrusted input reaching a privileged decision or sink without the required protection.
- Message, credential or other private data exfiltration, including an unconsented destination or tool input.
- Plugin or runtime sandbox escape.
- OAuth, authentication, authorization, device pairing or revocation flaws.
- A breach of the vendor-policy protections in the [compliance documents](docs/compliance/).

The approval boundary covers DraftYak's sends. It does not protect against a process already running as the hub's OS user, which can read that user's keychain; a compromised SMS host phone; or another phone app with `SEND_SMS`. These documented limits are out of scope by themselves. A flaw that crosses a DraftYak boundary without already having that access remains in scope. Separate-user and container hub modes reduce exposure to other processes. Protected desktop service-user mode and hardware-backed wrapping are outside the MVP.

## A useful private report

Include the affected version or commit, platform, component, impact, prerequisites, and the smallest reproduction you can provide. Use synthetic accounts and messages. Describe which approval, data-routing or isolation boundary fails. Remove tokens, real message content, addresses, phone numbers and other people's information from attachments and logs. A report can start with incomplete information; we can work through the details privately.

## Response and disclosure

The security maintainer acknowledges a report within 72 hours and completes initial triage within 7 calendar days of receipt. We use the private advisory to discuss impact, remediation and credit preferences with the reporter.

Coordinated public disclosure is at 90 calendar days after receipt. We aim to publish a fix or mitigation with the advisory; an incomplete fix does not silently reset the disclosure date. We discuss any necessary change to that date with the reporter and record it privately. If active exploitation warrants earlier disclosure, we coordinate that change as promptly as possible.

## Safe harbor

The maintainer considers good-faith security research that follows this policy authorized and will not pursue legal action against a researcher for that research. This commitment covers only systems and rights the maintainer can authorize; it does not bind vendors, carriers or other third parties.

Test on your own installation and accounts, or obtain their owner's permission first. Use the minimum access needed to demonstrate a problem. Avoid service disruption, persistent access, destructive changes, and accessing or retaining other people's data. Stop and report if you encounter such data. Report promptly and coordinate disclosure through the private channel above.

**TODO(owner): complete the pre-launch legal review of this safe-harbor wording and the maintainer's authority to offer it.**

## Reporting setup

The repository's `.github/VULNERABILITY_REPORT.yml` customizes the private form. It does not enable reporting. GitHub offers private vulnerability reporting for public repositories; see [Configuring private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository) (read 2026-10-18).

TODO(owner): at launch, once the repository is public, enable private vulnerability reporting, subscribe the responders and test the reporting link; then remove this line.
