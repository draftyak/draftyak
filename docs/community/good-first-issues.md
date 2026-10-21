# Pilot first-contribution draft catalog

These twelve optional, nonsecurity documentation proposals cover retained pilot community needs. They are draft scopes, not required protection work or evidence that a product feature, setup guide or launch check is complete. [M11.12](../roadmap/m11.md) owns the catalog and its remaining acceptance requirements.

This catalog is public documentation. **The proposals have not been created as GitHub issues by this catalog; each remains unapproved, unassigned and not ready.** No contributor is assigned or appointed. Publishing this file does not approve the proposed owner, allocate any future target path, establish a current public issue count or authorize an external action.

## Fields shared by all twelve drafts

The common fields below are part of every numbered record. Each record then supplies its title, scope, proposed future path, deliverable, prerequisites and specific acceptance observations.

- **Classification:** optional nonsecurity pilot documentation. No draft replaces a required protection, reporting route, assessment, legal decision, owner responsibility or release check. Postponed plugin-author/showcase work is excluded.
- **Proposed owner/reviewer:** Nick Savov, pending his explicit acceptance through M11.12. This is an unapproved proposal, not an appointment, accepted commitment or assignment. No contributor is assigned.
- **Status:** not created as a GitHub issue by this catalog; unapproved, unassigned and not ready. Before work starts, the owner must accept the scope, resolve its prerequisites and allocate its exact future owned path through the normal contribution process.
- **Suggested existing labels:** `good first issue`, `type:docs`, `area:docs`, `status:triage`, subject to current definition validation and later owner triage. No label is applied; accepted/help-wanted status is not implied.
- **Future acceptance:** the concrete observations in that record, `node tools/verify/verify.ts --profile docs`, `git diff --check`, applicable current item checks and independent review. These are future obligations, not commands run or passing results in this catalog. A rendered example also needs its owning site's actual build and rendered-link checks after implementation.
- **Data boundary:** invented examples only, with illustrative or unrun output clearly labeled. Do not use real accounts, inbox content, private messages, credentials, contact information, attachments, logs or platform measurements. Security reporting is only a pointer to the existing [private reporting instructions](../../SECURITY.md), never a worked vulnerability scenario.
- **Inventory boundary:** twelve distinct proposed deliverables do not establish uniqueness against current public issues or backlog assignments. A later permitted inventory and owner triage must check that separately.

Use the actual [contribution instructions](../../CONTRIBUTING.md), [PR template](../../.github/pull_request_template.md), [documentation form](../../.github/ISSUE_TEMPLATE/docs.yml) and [bug form](../../.github/ISSUE_TEMPLATE/bug.yml). The documentation form has required `location`, `problem` and `correction` fields. The bug form has `privacy`, `version`, `environment`, `reproduction`, `expected` and `observed`, including its required privacy acknowledgement. The PR template has `Change`, `Validation` and `Security review` headings; the closing Self-check comes from contribution guidance.

The linked Q&A, Ideas and RFC routes in [SUPPORT.md](../../SUPPORT.md) still require owner confirmation. [ACCESSIBILITY.md](../../ACCESSIBILITY.md) still requires a private contact, alternative reporting route and launch assessment. These proposals do not confirm or supply any of those TODOs.

## 1. Add a reader map for community documents

- **Problem and scope:** provide an optional task-oriented lookup aid without adding setup or policy requirements.
- **Proposed future path:** `docs/community/reader-map.md`.
- **Deliverable:** exactly eight questions mapped to authoritative sections: setup, choosing work, reporting a bug, help, proposing an idea/design, review, accessibility and conduct. Add one explanatory sentence per destination.
- **Prerequisites:** actual relevant contribution, support, governance, accessibility and conduct documents, plus owner-confirmed current anchors. A full M11.1 audit, M11.2b setup work or postponed plugin guide is not a prerequisite for this lookup aid.
- **Acceptance observations:** eight working source links, with no placeholder or duplicated/reinterpreted policy. This maps documents broadly; draft 7 applies routes to six scenarios, and draft 8 reads one rendered page.

## 2. Write a worked local documentation-change example

- **Problem and scope:** illustrate the existing local contribution sequence for a tiny prose correction.
- **Proposed future path:** `docs/community/first-docs-change.md`.
- **Deliverable:** at most ten fictional local steps covering an unclaimed task, scope/ownership confirmation, a tiny edit, diff inspection, documented checks and review text. Link to authoritative setup and personal sign-off guidance.
- **Prerequisites:** actual current contribution and review instructions, plus owner-accepted example wording. Do not reintroduce M0-only, private-until-launch or blanket local full-verification requirements.
- **Acceptance observations:** only existing applicable commands; no actual push, PR creation, account operation or sign-off for another person. Mark results illustrative or unrun. The sequence is distinct from draft 5's PR description and draft 11's follow-up dialogue.

## 3. Show a fictional documentation-link report

- **Problem and scope:** demonstrate a bounded report about a mistyped documentation anchor.
- **Proposed future path:** `docs/community/examples/documentation-report.md`.
- **Deliverable:** one fictional completed report, one incomplete report and exactly three missing facts. Use the actual `location`, `problem` and `correction` fields; put version, reproduction and intended-destination details within them.
- **Prerequisites:** the actual merged documentation form, an owner-accepted fictional premise and current reference links.
- **Acceptance observations:** no invented form fields or allegation of a real defect. Keep the deliberately bad anchor in literal code while genuine reference links resolve. This completed docs form differs from draft 4's bug form and draft 10's worksheet.

## 4. Show a minimal reproducible fictional bug report

- **Problem and scope:** teach expected-versus-observed reporting without requiring a product installation.
- **Proposed future path:** `docs/community/examples/bug-report.md`.
- **Deliverable:** one explicitly fictional table-wrapping report with a small synthetic Markdown input, exactly three reproduction steps, environment placeholders and separate expected/observed descriptions. Match `privacy`, `version`, `environment`, `reproduction`, `expected` and `observed`, including the actual required privacy acknowledgement.
- **Prerequisites:** the actual bug form and current support guidance, plus owner acceptance of the fictional rendering premise.
- **Acceptance observations:** no claim of a shipped bug, installation, screenshot, inbox, recorded platform behavior or real diagnostic. Keep unmeasured values as placeholders. This completed bug report differs from draft 3's link correction and draft 10's neutral worksheet.

## 5. Provide a fictional documentation PR description

- **Problem and scope:** show the initial review artifact for a tiny prose correction.
- **Proposed future path:** `docs/community/examples/docs-pull-request.md`.
- **Deliverable:** one fictional description for draft 3's hypothetical anchor correction, using the actual `Change`, `Validation` and `Security review` headings and current checkboxes. Include contribution guidance's closing Self-check and explicit unrun/result placeholders.
- **Prerequisites:** the actual merged PR template, current contribution rules and owner-confirmed wording. Draft 3 supplies a fictional premise; its proposed file need not already exist.
- **Acceptance observations:** do not invent a template-supplied Self-check heading, require an obsolete blanket full verifier or imply completed approvals/sign-off. This is an initial description, distinct from draft 2's sequence and draft 11's replies.

## 6. Explain contribution vocabulary

- **Problem and scope:** explain existing contribution terms in plain language.
- **Proposed future path:** `docs/community/contribution-glossary.md`.
- **Deliverable:** exactly twelve brief definitions: backlog item, owned path, worktree, item branch, integration branch, ADR, acceptance command, observed result, prerequisite, owner handoff, milestone gate and maintainer review. Link each to its authoritative current section.
- **Prerequisites:** current contribution/governance source and owner-verified anchors. No postponed SDK, scaffolder or plugin input is needed.
- **Acceptance observations:** describe existing practice without adding rules or private coordination details. Distinguish planned commands from observations and review from merge. This is vocabulary rather than draft 1's question map or draft 2's sequence.

## 7. Add community-routing examples

- **Problem and scope:** help readers apply the authoritative community routes to optional pilot documentation questions.
- **Proposed future path:** `docs/community/where-to-ask-examples.md`.
- **Deliverable:** six fictional questions covering setup help, a docs correction, an optional pilot-document wording idea, a documentation-organization proposal, clarification of a review term and an accessibility barrier. Give a source route and explain why it fits each question. The review-term question replaces the postponed plugin-showcase scenario.
- **Prerequisites:** current support, contribution, governance and accessibility wording, plus owner-confirmed retained Q&A/Ideas/RFC and issue/accessibility routes. Linked categories and missing contacts remain unconfirmed while their source TODOs remain open.
- **Acceptance observations:** no claim that a category/contact was created; no showcase, plugin-author task or vulnerability example. Security reporting stays an authoritative pointer. These six routing scenarios differ from draft 1's eight-question document map.

## 8. Explain reading one actual documentation page

- **Problem and scope:** provide an optional text-only reading exercise in place of the postponed plugin-showcase draft.
- **Proposed future path:** `docs/community/examples/reading-a-docs-page.md`.
- **Deliverable:** exactly four reader actions on one actual generated Stewardship page: identify its title/source relationship, follow existing local navigation, locate Accountability and use its actual rendered heading fragment. No screenshot is required.
- **Prerequisites:** the actual merged M11.3 site, current authoritative [STEWARDSHIP.md](../../STEWARDSHIP.md), and owner-confirmed real route, heading IDs and controls. M11.3 remains a future input; planned site work or an existing Markdown body is insufficient.
- **Acceptance observations:** use only links/controls present in that build. Do not invent routes, add UI or waive prerequisites to preserve a draft count. This reads one page; draft 9 teaches authoring, and draft 12 proposes an organization change. `plugin-showcase-outline.md` remains postponed and is excluded from these twelve proposals.

## 9. Write a small prose-accessibility guide

- **Problem and scope:** demonstrate optional prose improvements using supported documentation conventions.
- **Proposed future path:** `docs/community/accessible-writing.md`.
- **Deliverable:** exactly four synthetic before/after examples covering heading hierarchy, meaningful link text, linear table reading and a text equivalent for an illustration. Use at most two explanatory sentences per example.
- **Prerequisites:** actual supported M11.3 authoring syntax/conventions, current accessibility guidance and documentation-owner agreement. M11.3 remains a real future input despite this task being optional.
- **Acceptance observations:** examples work without color/images and use supported syntax. Claim no certification or screen-reader test result and do not replace the launch accessibility assessment. This teaches writing; draft 8 teaches reading an existing rendered page.

## 10. Add a text-only reporting worksheet

- **Problem and scope:** provide an optional reusable reporting aid without replacing the existing forms or alternative reporting route.
- **Proposed future path:** `docs/community/text-only-report.md`.
- **Deliverable:** exactly seven fields: task, page/heading, version, platform, expected, observed and smallest synthetic example. Include one fictional clipped-code-block completion and explain how to mark unavailable measurements without guessing.
- **Prerequisites:** actual support/accessibility routes and owner-approved safe wording. Existing source links do not prove unconfirmed categories or missing alternative/private accessibility contacts exist.
- **Acceptance observations:** usable as plain text without attachments or diagnostics; no new contact or support promise. This worksheet differs from the completed reports in drafts 3 and 4.

## 11. Show fictional documentation-review responses

- **Problem and scope:** illustrate clear follow-up dialogue on a documentation change.
- **Proposed future path:** `docs/community/review-response-example.md`.
- **Deliverable:** exactly three fictional comment/reply pairs: clarify wording, supply missing reproduction detail and ask a precise clarification question. Name the changed section/check or unanswered question.
- **Prerequisites:** current review instructions and owner-accepted fiction. Draft 3 remains a hypothetical premise; no absent proposed file is presented as published.
- **Acceptance observations:** no invented reviewer identity, accepted approval, merge, automatic retry or publication. Validation remains a labeled placeholder until run. These are follow-up replies, distinct from draft 2's sequence and draft 5's initial description.

## 12. Outline an optional documentation-organization proposal

- **Problem and scope:** explain a documentation-organization idea without implementing it.
- **Proposed future path:** `docs/community/documentation-proposal-outline.md`.
- **Deliverable:** exactly seven headings: problem, readers, current links, proposed grouping, alternatives, maintenance cost and validation. Compare two optional groupings of existing CONTRIBUTING/GOVERNANCE references.
- **Prerequisites:** actual [governance](../../GOVERNANCE.md) and current document structure, plus owner selection of the bounded-issue versus RFC route. Use present baseline documents, not absent proposed help pages; a nonexistent site is not needed to write this proposal artifact.
- **Acceptance observations:** preserve authoritative content. Do not rename documents, implement navigation, rewrite policy or imply an accepted decision. This proposal comparison differs from draft 1's directly usable reader map.

## Remaining M11.12 and launch gates

This one-file catalog is a partial deliverable. Complete M11.12 still requires its implemented launch-check `issues` acceptance with `--fail-if-no-match`, complete unique drafts and valid labels. Before candidate acceptance, a permitted read-only inventory must establish at least twelve current, distinct, owner-approved public pilot issues labeled `good first issue`, or the owner must explicitly approve a change to that clause. The twelve catalog proposals do not satisfy that public inventory.

Label-workflow implementation retains its separate reviewed-and-merged policy prerequisite. Issue creation, label/category/settings changes, dispatch and other external actions require separate explicit owner instruction. This document provides no write procedure or approval for them. Plugin showcase and its draft remain postponed.

Each future task still needs proposed-owner acceptance, resolved prerequisites, an allocated scope and actual validation/review. Drafts 8 and 9 retain their actual M11.3 inputs. Current source TODOs for contacts/categories remain open. Required baseline work and all owner, accessibility, legal/trademark, native, platform and release gates remain separate; no optional draft or successful documentation check grants their acceptance.
