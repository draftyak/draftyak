# Cargo-deny input format, version 1

`parseCargoDenyReports({full, advisory, denyWarnings})` consumes two bounded
captures, each with exact stdout/stderr bytes, the original numeric exit code
and a null signal. It returns a complete technical projection or the fixed
`InputError`; it performs no subprocess, graph authorization or policy decision.
Production supplies `denyWarnings:false` from its fixed command, with no caller
override. Library fixtures can exercise the other boolean value.

The compatibility boundary is cargo-deny 0.20.2 JSON output from a full four-check
run with `--show-stats`, plus the advisory check with
`--audit-compatible-output --show-stats`. Full stdout must be blank; advisory
stdout must contain exactly one database report. Each stderr is JSONL with zero
or more diagnostics followed by exactly one final summary. Blank JSON-whitespace
lines are permitted. Unknown records, fields, codes, classifications, severities,
categories, duplicate decoded keys, invalid UTF-8, malformed or trailing input,
unsafe numbers, missing summaries and signals refuse.

Limits are 32 MiB per stream and 100,000 lines or array elements. Each JSON line
also uses the strict reader's depth 64, one million nodes and 1 MiB decoded string
limit. Byte limits use the native typed-array extent and a copied byte snapshot.

The four summary categories are exactly `advisories`, `bans`, `licenses` and
`sources`; each contains nonnegative safe-integer `errors`, `warnings`, `notes`
and `helps`. Emitted errors and warnings must exactly equal their category
counts. Notes/helps may be summary-only at the default logging threshold;
emitted instances cannot exceed their counts. All counts remain visible.
The advisory-only summary must exactly agree with the full advisory category.

The closed diagnostic code table currently recognizes `vulnerability`, `notice`,
`unmaintained`, `unsound`, `yanked`, `duplicate`, `no-license-field` and
`unlicensed`. Other source, licence, ban, ignored or future diagnostics refuse
instead of becoming an implicit permission. Missing diagnostics for a nonzero
summary error/warning also refuse, including in the sources category.

Every recognized diagnostic is retained with category, severity, code, rendered
crate identities and advisory classification. A rendered crate can carry the
optional `build`/`dev` kind marker and recursive parents or a repeat marker.
These renderings remain explanatory: they lack exact source, target predicate,
complete features and authoritative resolved edges. The evaluator must map
findings to the independently validated Cargo graph and complete ancestry.

Advisory identity includes RustSec ID, package, informational class, categories,
collection, exact source, date, withdrawn date and technical CVSS vector. Known
presentation fields are type-checked but omitted. Message, notes, labels,
description, title, URLs and other prose are never returned or used as policy
identity. No report digest is calculated here; the runner binds raw captures.

Audit-compatible findings retain exact registry source/name/version,
classification, affected architecture/OS/function ranges, patched ranges and
unaffected ranges. Range strings use a bounded Cargo-style lexical grammar and
are preserved, not interpreted as version authorization. Unknown shapes, ignored
IDs, severity/platform filters, replacement packages, duplicate findings,
withdrawn findings or a dependency count smaller than the finding package set
refuse. Informational classes must include notice, unmaintained and unsound.
Each finding must match an advisory diagnostic by classification and
name/version; full and advisory diagnostic projections must agree. Registry
sources remain exact data for the separate graph mapper, not inferred from a
rendered name/version.

Underlying exit codes 0–15 remain unchanged. Zero is required exactly when no
error (or denied warning in library fixtures) exists. Observed pinned captures
establish advisory-only failure exit 1 and licence-only failure exit 4, which are
checked. Other multi-category/non-advisory combinations are preserved as
nonzero, without claiming an unverified bit mapping. The policy evaluator must
refuse every non-advisory error and every exception result outside full/advisory
exit 1. `complete:true` proves parsing/reconciliation under this compatibility
boundary; it never means strict pass, approved scope, fresh evidence or an
operational allowance.
