# ADR NNNN: Title

- **Status:** proposed
- **Date:** YYYY-MM-DD
- **Spike:** S1
- **Plan:** §15 S1
- **Owner decision:** no

<!-- Copy to docs/adr/NNNN-<slug>.md with the number from the ADR table in docs/roadmap/m0.md; never renumber. -->
<!-- Status: proposed, accepted or superseded. A superseded ADR adds "- **Superseded by:** NNNN"; its successor may add "- **Supersedes:** NNNN". -->
<!-- Spike: a spike id (S1, S3b, S12) or none. Plan: the plan sections (§n) this ADR answers. Owner decision: yes when the owner decides at the gate. -->
<!-- pnpm adr checks these fields, the six sections below in this order, the Decision's first line and the Kept test fields. -->

## Context
What the plan assumes, what the spike had to establish, and the constraints that shaped the run (targets, Node versions, owner sessions).

## Options
The options considered, each with what it costs and what it risks.

## Decision
Go

<!-- The first line is exactly one of: Go, Go with fallback, No-go, Not run. -->
Plan changes: none, or each change to the plan with the section it touches.

## Fallback
What replaces the decision if it fails later, and what would trigger the switch.

## Evidence
- `spikes/<id>/evidence/<file>.json`: what it shows, with the runs (OS, Node versions) it covers.

## Kept test
- **Path:** `spikes/<id>/test/<name>.test.ts`
- **Command:** `pnpm --filter @draftyak/spike-<id> test`
- **Guards:** the behaviour that breaks if this test fails.
- **Destination:** the milestone that absorbs it and its path there, e.g. M2a `apps/hub/test/`.

<!-- Repeat the four fields for each kept test. Path lists existing files, or folders below the top level, with forward slashes and the exact case; git-ignored files don't count. "none" is allowed only with No-go or Not run. -->
<!-- Destination gives the repo-relative path with its folder, not a bare name: M6 `plugins/channel-slack/`, M10 `.github/workflows/mobile.yml`. -->
