# Accessibility

DraftYak commits to WCAG 2.2 Level AA as the accessibility target for its interfaces and documentation. This is a commitment to evaluate and remove barriers, not a claim of independently certified conformance. The reference is the [W3C WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/), read 2026-10-17.

## What we review

Review covers setup, reading, drafting, organizing, consent, pairing, PIN approval, scheduling and cancellation, including keyboard and assistive-technology use. It includes visible focus, meaningful labels, contrast, zoom and reflow, status announcements, errors and accessible authentication. Security information and approval details must remain understandable without relying only on color or pointer interaction.

Changes to these flows should be checked manually with keyboard navigation and relevant screen readers alongside automated checks. Reports should identify the affected version and platform so a fix can be verified in the same context. Third-party clients and plugins can introduce their own barriers; reports about the DraftYak integration are welcome.

## Report a barrier

Use the [documentation issue form](https://github.com/draftyak/draftyak/issues/new?template=docs.yml) for a documentation barrier or the [bug form](https://github.com/draftyak/draftyak/issues/new?template=bug.yml) for an interface barrier. Describe the task, the barrier, operating system and assistive technology, and the expected result. Synthetic examples are enough; do not include inbox content or personal data.

TODO(owner): Publish a private accessibility contact and an accessible alternative reporting route before launch.

TODO(owner): Publish the launch accessibility assessment, tested platforms and assistive technologies, known barriers and remediation priorities before launch. Record evidence before making any conformance claim.
