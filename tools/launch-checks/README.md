# Launch metadata checks

This private package checks the repository's current contribution metadata. It
does not require a product SDK, generated API reference or documentation site.

From the repository root:

```sh
pnpm --filter @draftyak/launch-checks --fail-if-no-match typecheck
pnpm --filter @draftyak/launch-checks --fail-if-no-match test
pnpm --filter @draftyak/launch-checks --fail-if-no-match metadata
```

The metadata command checks all six issue forms, their defined labels, the issue
chooser, PR review checkboxes, contributor guidance and effective CODEOWNERS
coverage. Field types must be supported scalar strings. Required form fields must
be interactive; Markdown cannot replace an input or the required bug-report
privacy acknowledgement. Undefined or duplicate
labels, ambiguous YAML and a later ownership override that removes the required
owner fail the check. Required PR checkboxes must be top-level Markdown task-list
items with an ASCII space or tab after the closing marker, outside code fences,
indented code and HTML comments. Fence contents stay literal, including comment
markers. This bounded policy conservatively refuses
HTML-style tags and declaration/processing prefixes outside fences/comments;
put literal examples in a fence. This includes CDATA and incomplete openers.
Comment openers outside fences must begin a line with at most three spaces;
embedded or indented-code openers are refused instead of parsing inline Markdown.
Backtick fence information containing another backtick is refused. Closing fences
allow only ASCII spaces/tabs after their delimiters.

The CLI accepts one repository-root argument, optionally after `--`:

```sh
node tools/launch-checks/src/metadata-cli.ts .
```

It reads only the named metadata inputs and Git's tracked-path names. Inputs must
be regular files under an unlinked worktree root, with no linked path components,
and each must be smaller than 3 MiB. YAML aliases, non-string keys, duplicate keys,
unknown tags, multiple documents, parse warnings and invalid syntax are refused. Success exits
0, structural problems exit 1, and invalid invocation or unreadable/unsafe inputs
exit 2. Diagnostics identify rules and repository-relative names, without echoing
file contents or filesystem exception details. It never changes repository
settings, creates public issues or contacts a service.

Ownership follows the last matching CODEOWNERS rule for the supported rooted
paths and glob stars. Unsupported syntax fails explicitly. Representative direct
and nested paths check declared security boundaries; all actual tracked security
paths are also checked, including conditional bounded-files, lookup-core and hub
listeners paths when present. These conditional checks do not claim that their
implementations have arrived. The grammar is a deliberately limited repository
policy, not a validator for every possible CODEOWNERS feature or account's review
permissions.

A passing metadata audit does not prove working product setup, an SDK/channel
walkthrough, launch readiness, legal approval or owner acceptance. The initial
desktop pilot bundles first-party plugins; the plugin-author kit and third-party
installation are postponed. M11.2b reconciles actual retained M1.25 contributor/setup
additions after they reach this branch. The canonical plugin-author/channel
walkthrough belongs to postponed documentation and requires real future
implementations. Later documentation and launch commands are introduced with
their own implementations; this package currently provides only metadata checks.
