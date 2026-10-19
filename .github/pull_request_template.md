## Change

Describe the problem, resulting behavior and relevant issue or RFC. Use synthetic examples and keep private data out of the description and attachments.

## Validation

List the checks you ran and their results. Explain any check that could not run.

- [ ] I reviewed and understand the entire change and have the right to contribute it under Apache-2.0.
- [ ] Tests cover the changed behavior, or I explain why tests do not apply.
- [ ] `pnpm verify` passes (or the documented docs-only profile applies).
- [ ] A changeset covers a publishable-package change, or I explain why none is needed.
- [ ] Documentation covers the behavior, API and configuration changes, or I explain why none is needed.
- [ ] I read DCO 1.1 and personally apply the required sign-off as described in CONTRIBUTING.md; for an item PR, I identify the owner review gate where it will be applied.

## Security review

- [ ] I checked CONTRIBUTING.md's security-sensitive paths and `.github/CODEOWNERS`, and identified any affected paths below.
- [ ] Code changes in security-sensitive modules have tests in this PR, or no such code changed.
- [ ] Approval, exact content and send windows, untrusted input, credentials, tool inputs, consent, retention and outbound destinations remain protected; any relevant change is explained below.
- [ ] No real message content, credentials or other people's private information appears in the change, logs or attachments.

Affected security-sensitive paths and review notes:
