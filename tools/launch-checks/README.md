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
their own implementations.

## Static community audit

`pnpm --filter @draftyak/launch-checks --fail-if-no-match community` reuses the
metadata audit and checks the named community documents, approved Apache-2.0
text, required sections/disclosures and current installer claims. Explicit
postponed-feature references remain allowed. The CLI takes one repository root,
optionally after `--`: `node tools/launch-checks/src/community-cli.ts .`.

Inputs and file link targets must be regular files below the same unlinked
repository root, each smaller than 3 MiB. Direct tracked directory targets are
checked for existence without traversal; they cannot supply fragments.
It checks at most 256 direct
links; it neither recursively crawls target links nor fetches external URLs.
The bounded Markdown subset supports inline links, full reference and defined
shortcut links with single-line target definitions, and ATX-heading fragments
with duplicate suffixes.
Encoded root escapes, linked paths, reserved paths, ambiguous schemes, malformed
links and unsupported HTML links refuse. Missing files/sections/targets/fragments
are structural problems. File contents and filesystem errors are not echoed.
Exit codes follow metadata: 0 success, 1 structural problems, 2 invalid invocation
or unreadable/unsafe inputs. Fenced examples/comments cannot supply disclosures.

This is a static document audit, not rendered-document conformance, a policy
interpretation, installer validation or runtime/legal/platform/accessibility
acceptance. Unresolved actual destinations and owner decisions remain separate.
The base snapshot without a root README is a real failing input. Adding the
partial project overview does not by itself satisfy the required quickstarts,
sections, tray, reopen or autostart guidance; those documentation obligations
remain open. The audit creates no placeholders or evidence-result format.
