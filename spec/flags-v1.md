# Flags v1

> **Status: draft.** It changes only through contract PRs after the M1 gate (see [README.md](README.md)).

A flag tells the owner what to check in a draft before approving a send. The hub computes flags against the revision the owner last saw, stores them with that revision, and shows them in the composer and the approval window. An approval binds them through `flagsHash`, so the owner approves exactly the flags they were shown.

Generated from `@draftyak/protocol` (`packages/protocol/src/flags.ts`): `schemas/flags-v1.schema.json` (a revision's flags), `vectors/flags/catalogue.json` (every code with its severity) and `vectors/flags/flags-hash.json` (flag sets with their sorted bytes and `flagsHash`, and refusals).

## A flag

A flag is a JSON object with exactly these members:

| Member | Value |
|---|---|
| `code` | A code from the catalogue below |
| `severity` | The code's severity from the catalogue; any other severity makes the flag invalid |
| `detail` | Optional: what the flag is about, such as an address or a link host, as 1 to 1,000 Unicode scalar values (code points other than surrogates) |

A revision's flags are a set: no two flags share their code and detail, and their order carries no meaning. A detail may come from untrusted content, so it is shown as plain text, never as markup, with invisible and bidi characters made visible.

## Severities

| Severity | Shown | Before the PIN |
|---|---|---|
| `ack` | in the composer and the approval window | the owner must tick "I reviewed the flagged items" |
| `info` | in the composer and the approval window | nothing |
| `advisory` | in the composer and the approval window, as a warning | nothing |

`ack` is the default: every code is `ack` unless the catalogue says otherwise.

### How `ack` gates the PIN

1. The approval window shows every flag. When any flag is `ack` (`ackRequired`), "Approve & send" or "Approve & schedule" asks the owner to tick "I reviewed the flagged items" before the PIN.
2. The device signs `approval.send.v1` with the `flagsHash` of the flags it showed, and `flagsAcked`: true only when the owner ticked the box.
3. The hub's verifier recomputes `flagsHash` over the item's flags and refuses the approval when it differs, or when any flag is `ack` and `flagsAcked` is false.

A new revision gets its own flags, so an edit after approval needs a new approval.

## Catalogue

| Code | Severity | Raised when | Detail, when given |
|---|---|---|---|
| `NEW_RECIPIENT` | ack | a recipient isn't a known contact of the account | the address |
| `RECIPIENT_ADDED_BY_AGENT` | ack | an agent added a recipient | the address |
| `REPLY_TO_REDIRECT` | ack | the reply goes to a Reply-To that differs from From or its domain | the Reply-To address |
| `AGENT_AUTHORED` | ack | any revision of the draft came through MCP or an agent token | |
| `DMARC_FAIL` | ack | the message replied to failed DMARC, read from the topmost Authentication-Results of the provider's own server | |
| `EXTERNAL_LINK` | ack | the body holds a link | the link's host |
| `AGENT_INSERTED_CONTACT` | ack | an agent put an address or a phone number into the body | |
| `ATTACHMENT_ADDED_BY_AGENT` | ack | an agent attached a file | the file name |
| `INVISIBLE_CHARS` | ack | the body holds zero-width, bidi, tag or other invisible characters | |
| `MASS_MENTION` | ack | a chat body notifies a whole channel or workspace | the mention |
| `CROSS_THREAD_DATA` | ack | an exact search finds an email address, URL or number of 6 or more digits from another conversation in the body | |
| `SECRET_PATTERN` | ack | the body holds a one-time code, a key shape, a Luhn-valid number or an IBAN | |
| `SUSPECTED_INSTRUCTIONS` | advisory | the thread seems to hold instructions aimed at an AI, as the drafting model reported in DraftOutput v1's `suspectedInstructions` | |
| `TOOL_DATA_IN_BODY` | ack | an email address, URL, phone number or number of 6 or more digits from a lookup result appears in the body; recomputed for every revision | |
| `TOOL_CONTEXT_USED` | info | lookup results reached the prompt | the kinds and hosts used |
| `TOOL_INSTRUCTIONS` | advisory | a lookup result matched the hub's instruction heuristics or held a delimiter or role marker | |

SMS adds no flags: an agent's text to a new number carries `NEW_RECIPIENT` and `AGENT_AUTHORED`, and the approval window's plain-SMS and RCS warnings are fixed lines, not flags.

The v1 catalogue is closed. Every implementation refuses an unknown code (`FLAGS_INVALID`), so adding a code, or changing a code's severity, is a breaking change: it needs flags v2, and a desktop that predates v2 refuses a draft carrying the new code until it updates. A display that meets a code it doesn't know, such as the MCP Apps draft view, shows the code itself.

## `flagsHash`

1. Check the list: every flag is a catalogue code with its own severity, an optional detail of 1 to 1,000 Unicode scalar values and no other member, and no two flags share their code and detail. Otherwise refuse it (below).
2. Sort the flags by code, then by detail, comparing UTF-16 code units as JCS sorts member names: never UTF-8 bytes, a locale's collation or a case-insensitive order. A flag without a detail sorts before the same code with one.
3. Write the sorted list as canonical JSON (JCS, [README.md](README.md)): each flag with only its own members, so `{"code":"…","detail":"…","severity":"…"}` or, without a detail, `{"code":"…","severity":"…"}`.
4. `flagsHash` is the SHA-256 of those bytes, as 64 lower-case hex characters. No flags hash as `[]`: `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.

| Code | Refused |
|---|---|
| `FLAGS_INVALID` | anything but a list of flags as above: an unknown code, a severity other than the code's, a missing or unknown member, a detail that is empty, longer than 1,000 code points, not a string or holding a lone surrogate |
| `FLAGS_DUPLICATE` | two flags with the same code and detail, or the same code and no detail |

A refusal's message may say where the list is wrong, such as `1.severity`, but counts unknown members rather than naming them, so no name the input chose reaches a log.

`ackRequired` is true when any flag is `ack`, and checks the list the same way.

## `contextRefs`

A draft from the hub's AI may carry `contextRefs` (DraftOutput v1, in `extensions/ai-provider-v1.md`): the ids, `c1` to `c3`, of the lookup results in the job's context block that the model says it used.

- They are informational. Ids outside the job's lookups are dropped, and they never fail a draft.
- They never trigger a lookup: the hub plans lookups before the model runs.
- They aren't flags, and `flagsHash` doesn't cover them. `TOOL_CONTEXT_USED` is the flag: it lists the kinds and hosts whose results reached the prompt, whatever the model says it used.
- Drafts read through MCP show only `contextRefs` and `TOOL_*` flags, never the lookup results.
