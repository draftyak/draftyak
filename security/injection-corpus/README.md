# Injection corpus v1

This corpus contains 24 synthetic email ingest-to-prompt cases. Each YAML case points to a raw RFC 822 fixture and records exact expectations for parsing, body hygiene, sender authentication, and the decoded JSON thread passed to draft-request construction. The package runner sends the raw bytes through the mail worker before constructing the prompt.

All identities, addresses, URLs, notices, and attachment contents are synthetic. The only owner address is `owner@example.test`. The runner supplies the case's provider as trusted test context and supplies no sent evidence. Every case therefore remains inbound, including the owner-looking From case with forged message-supplied direction markers. Authentication-Results expectations describe the parser's provider-header policy; they are not evidence of a live provider response.

## Scope and pending gates

These are 24 ingest-worker-to-prompt cases only. They do not run an obedient model, provider SDK, native flag engine, outbox, MCP client, or send operation. M3.13's model-assisted evaluation, native flags, recipient/outbox enforcement, and MCP trust-boundary acceptance remain pending.

`expected_flags` declares a future advisory floor: `SUSPECTED_INSTRUCTIONS` is required where the current body heuristic reports `suspected_instructions: true`; an empty list makes no other native-flag claim. It is not an observed native flag result. In particular, non-English instructions and instructions confined to metadata can remain outside that English body heuristic while still appearing only as untrusted thread data.

`recipients_unchanged`, `no_outbox`, and `mcp_untrusted` are declarative expectations for later gates, not proof that those subsystems ran. The prompt runner checks the literal framing and untrusted JSON placement represented by `boundary_intact`; that is separate from a model obeying the boundary. A fresh random thread delimiter is required even when a fixture contains a plausible closing delimiter.

## Case format

Every YAML document has exactly these top-level fields: `id`, `family`, `channel`, `fixture`, `provider`, `owner_instruction`, `expected_removals`, `expected_flags`, `recipients_unchanged`, `no_outbox`, `boundary_intact`, `mcp_untrusted`, and `expected_ingest`. Fixtures are local `fixtures/<id>.eml` files. No YAML anchors or tags are used.

`expected_removals` contains exact, nonnegative UTF-16-unit counts for `hidden`, `invisible`, `quoted`, `truncated`, and `uris`. These counts apply to the ingest body, not metadata or a second cleaning pass. The quoted-history case keeps the default 4,000-unit history prefix and removes 15 units. The tag-character case removes two supplementary code points, totaling four UTF-16 units. The dangerous-URI case removes four ASCII payloads totaling 77 units while keeping ordinary `File:` and `data:` labels followed by spaces.

`expected_ingest` records direction, DMARC, optional verified sender, To and Reply-To addresses, body include/exclude checks, decoded-thread include/exclude checks, the body instruction heuristic, and visible hostname-only link metadata. Prompt checks target the decoded JSON thread data, not the trusted system instructions or owner context. Sender-name cases include the parsed display name in the thread sender. Filenames and attachment bytes stay outside the prompt; the filename case explicitly checks that separation.

## Ingest and prompt handoff

`ThreadMessage.body` takes the ingest worker's `HygieneResult`. The draft builder validates the bounded text, numeric removal counts, and exact generated-marker/link-table agreement; it preserves the body without a second cleaning pass. Sparse retained link indexes are allowed. Output, quoted-history, and prompt-budget truncation preserve complete generated markers and Unicode scalars. Literal numeric `[link <digit>` prefixes are reserved during ingest so they cannot impersonate generated annotations; ordinary `[link documentation]` prose stays literal.

Small subject and sender fields still receive bounded cleanup in the calling process, and stay inside the untrusted JSON thread. `PreparedDraft.metadataRemovals` reports that actual metadata cleanup separately from the worker's body counts. `removals.uris` counts removed URI payloads in UTF-16 units; ordinary `File:` and `data:` labels followed by spaces remain. This metadata path does not repeat body work or confer recipient, authentication, approval, or send authority.

## Inventory

| Case | Family | Expected nonzero removals |
| --- | --- | --- |
| `auth-top-fail-lower-pass` | authentication-results | 0 |
| `auth-top-pass-lower-fail` | authentication-results | 0 |
| `auth-forged-authserv` | authentication-results | 0 |
| `auth-comment-forgery` | authentication-results | 0 |
| `reply-to-redirect` | reply-to | 0 |
| `owner-looking-from` | sender-evidence | 0 |
| `instructions-in-name` | sender-name | 0 |
| `instructions-in-subject` | subject | 0 |
| `instructions-in-filename` | attachment-filename | 0 |
| `fake-approval` | approval-notice | 0 |
| `base64-instructions` | transfer-encoding | 0 |
| `multilingual-spanish` | multilingual | 0 |
| `multilingual-japanese` | multilingual | 0 |
| `markdown-image-exfiltration` | markdown-image | 0 |
| `query-link-exfiltration` | query-exfiltration | 0 |
| `fake-thread-boundary` | prompt-boundary | 0 |
| `hidden-display-none` | hidden-html | hidden 28 |
| `hidden-zero-font` | hidden-html | hidden 11 |
| `hidden-white-on-white` | hidden-html | hidden 12 |
| `invisible-zero-width` | invisible-characters | invisible 1 |
| `invisible-bidi` | bidi-controls | invisible 2 |
| `invisible-tags` | tag-characters | invisible 4 |
| `quoted-history-cap` | quoted-history | quoted 15 |
| `uri-payloads-and-labels` | dangerous-uri | URI 77 |

The cases cover top and lower Authentication-Results, forged authserv IDs and comment syntax, Reply-To redirects, owner-looking From without send evidence, instructions in quoted names/subjects/filenames, fake approval, base64 body transfer encoding, Spanish and Japanese instructions, Markdown image and query exfiltration, forged prompt delimiters, hidden HTML, invisible/bidi/tag characters, quoted history, dangerous URI payloads, and ordinary label controls.

## Fixture bytes and validation

Raw email fixtures use UTF-8 without a BOM and exact CRLF line endings. YAML and this README use UTF-8 without a BOM and LF line endings. Repository attributes preserve security fixture bytes. The base64 case stores the encoded wire body; expected body text is the parser-decoded instruction, so treating the wire encoding as already-cleaned content cannot satisfy the case.

Executable coverage belongs to the content package's injection-corpus runner. Keep the raw fixture, YAML expectations, and the package test in the same review. Exact expectations are intentionally literal and must be checked by the real ingest-worker-to-prompt path; fixture construction alone is not a passing test run.
