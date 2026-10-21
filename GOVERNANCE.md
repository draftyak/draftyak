# Governance

DraftYak uses a maintainer-led model. Nick Savov is the project owner and final decision maker. [MAINTAINERS.md](MAINTAINERS.md) lists the people responsible for review and releases. This document describes project decisions; [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) governs community conduct.

## Decisions and review

Use an issue for a bounded change and an RFC Discussion for a change to architecture, security guarantees, policy, a tool kind, an extension point or a plugin contract. Describe the problem, proposed behavior, alternatives, privacy impact and validation. A new tool kind needs an RFC before implementation. Maintainers record the decision and its reasons in the discussion; architectural decisions also belong in an ADR.

Contributors may review and challenge proposals. The owner resolves disagreements after considering the discussion and records the reason. There is no voting quorum or elected council. Security reports stay private under [SECURITY.md](SECURITY.md) until coordinated disclosure.

## Integration and releases

Work is divided into milestone backlog items with owned paths. Item branches are rebase-merged into the milestone integration branch after review and verification. Only the owner merges into `main`. At the milestone gate, the owner reviews and applies the required DCO sign-off before integration into `main`; the DCO check remains strict.

Security-sensitive code needs tests in the same change and review by its code owner. A successful check does not replace review. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) and [.github/CODEOWNERS](.github/CODEOWNERS) for the workflow and paths.

## Contributions and commitments

Contributions use DCO 1.1, with no CLA. Apache-2.0 inbound equals outbound; contributors grant no additional relicensing rights. Only the human contributor applies their sign-off. The licence and the [stewardship promises](STEWARDSHIP.md) guide product and commercial decisions. The [trademark policy](TRADEMARKS.md) is separate from the code licence.

## Maintainer changes

The current single-maintainer arrangement is valid for launch; recruiting another maintainer is optional. The owner appoints additional maintainers after reviewing their contributions and judgment and obtaining their agreement to take responsibility. Changes to responsibilities and this document are proposed publicly and recorded in the repository. Maintainers disclose conflicts relevant to a decision and ask an uninvolved reviewer where possible.

TODO(owner): Record continuity and handover arrangements for the current maintainer structure before launch. Update them when responsibilities change; do not assume an additional maintainer has agreed to serve.
