# DraftYak specifications

> **Status: draft.** Until the M1 gate, any M1 item may change these files. After it they change only through contract PRs, under the versioning rule: a breaking change gets a new identifier (`…/channel-v2`), and the hub supports the current and the previous major.

These are the contracts between the hub, plugins, devices and SDKs in other languages. Prose (`*.md`) is written by hand. JSON Schemas (`*.schema.json`) and everything under `vectors/` are generated from `@draftyak/protocol` (`packages/protocol/`) and never edited by hand.

## Encodings

| What | Encoding |
|---|---|
| Canonical JSON | RFC 8785 (JCS), parsed strictly as below |
| Hashes | SHA-256 as 64 lower-case hex characters |
| Signatures | ES256 (ECDSA on P-256 with SHA-256) as base64url of the 64-byte `r‖s`, each half 32 bytes big-endian; never DER |
| Public keys | base64url of the SPKI DER, always the 91-byte P-256 form with the uncompressed point |
| base64url | RFC 4648 §5, unpadded and canonical: the unused low bits of the last character are zero |
| Numbers in signed forms | safe integers only, from −(2^53 − 1) to 2^53 − 1 |
| Instants | in snapshots, statements, tickets and receipts, UTC milliseconds as a safe integer; `localWallTime` and `zone` are their only time strings. Elsewhere an instant may be written `YYYY-MM-DDTHH:mm:ss.sssZ` |
| Text limits | count Unicode code points, as JSON Schema's `maxLength` does, not UTF-16 units |
| IDs | ULIDs: 26 upper-case Crockford base32 characters, the first at most `7` |
| Account aliases | `^[a-z0-9][a-z0-9-]{0,31}$` |

### Canonical JSON

Serialization follows RFC 8785: member names sorted by UTF-16 code units, numbers in ECMAScript's shortest form (`-0` becomes `0`), and only `"`, `\` and U+0000 to U+001F escaped (`\b`, `\t`, `\n`, `\f` and `\r`, the rest as `\u00xx` in lower-case hex). Every other character is written as itself, U+007F to U+009F, U+2028 and U+2029 included.

Numbers are read as IEEE 754 doubles, as RFC 8785 reads them, correctly rounded with ties to even, so `9007199254740993` canonicalizes to `9007199254740992`; signed forms never hold such a number. A number that rounds beyond the double range is refused, and one that rounds below the smallest subnormal reads as `0`. Whitespace between tokens is only space, tab, line feed and carriage return.

Every implementation parses strictly and refuses, with these codes:

| Code | Refused |
|---|---|
| `JCS_SYNTAX` | anything that isn't RFC 8259 JSON, including a byte-order mark or other whitespace (such as U+000B, U+000C or U+00A0) between tokens, trailing commas and text after the value |
| `JCS_INVALID_UTF8` | bytes that aren't UTF-8, such as overlong forms or encoded surrogates |
| `JCS_LONE_SURROGATE` | a lone surrogate, raw or escaped, in a name or a string |
| `JCS_DUPLICATE_KEY` | a member name that repeats in one object, compared after unescaping |
| `JCS_NUMBER_RANGE` | a number beyond the double range, and NaN or Infinity when canonicalizing |
| `JCS_TOO_DEEP` | more than 64 nested arrays and objects |

A document is canonical when its bytes equal the canonical form of what it holds.

### Statement signatures

A statement's `typ` names its type and major version, such as `approval.send.v1`: dotted segments of lower-case letters, digits and hyphens, each starting with a letter, then `v` and the major version without a leading zero, exactly `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*\.v[1-9][0-9]*$`. Any other `typ`, such as `login.V1`, `login.v0` or `login.v01`, is refused (`SIGN_INVALID_TYP`). The signature covers the UTF-8 of `draftyak/v1/<typ>` and a line feed, followed by the statement's canonical JSON.

- A statement is a JSON object (`SIGN_NOT_OBJECT` otherwise).
- Every number in a signed statement is a safe integer. Implementations refuse to build the signing input for any other number (`SIGN_UNSAFE_NUMBER`) and never verify such a statement, so no signature depends on how a language writes fractions or large numbers.
- A statement that arrives from elsewhere is verified as the bytes received: they must be the canonical JSON of a statement, and the signature covers exactly them. A verifier never re-serializes a statement it parsed and verifies that instead.
- Keys other than P-256 in the form above are refused (`SIGN_INVALID_KEY`).
- Signatures made with `node:crypto` use a random nonce and Rust's use RFC 6979, so implementations verify each other's signatures rather than compare them.

### `headersSha256`

The SHA-256 of the canonical JSON of the header list `[[name, value], …]`, with names lower-cased and the pairs sorted by name and then by value, comparing UTF-16 code units as JCS sorts names, never by a locale's collation or ignoring case. A repeated name keeps every value as its own pair. Names must be RFC 9110 tokens and values visible ASCII with spaces or tabs only between characters; anything else is refused (`HEADERS_INVALID_NAME`, `HEADERS_INVALID_VALUE`), so lower-casing and sorting mean the same in every language.

Each row is exactly two strings; this hash helper adds no pair-count or aggregate-byte cap.

The hash binds the pairs, not their order: the same pairs in any order hash alike, even when the values of a repeated name change places, which RFC 9110 §5.3 makes significant. Whoever renders the headers fixes that order; the hash doesn't.

## Naming

- Field names are lowerCamelCase; error and refusal codes are UPPER_SNAKE_CASE.
- A hash field ends in `Sha256` and names what it covers: `bodySha256` is the exact request body, `textSha256` the normalized text part that reconcile compares, `headersSha256` the rendered header list above. `contentHash` and `flagsHash` keep their names: the SHA-256 of a snapshot's, and of a flag list's, canonical JSON.
- Durations end in `Ms` or `Sec`; instants are UTC milliseconds.
- Statement types are `<name>.v<major>`; schema files `<name>-v<major>.schema.json`; vector formats `draftyak.vectors.<area>.v1`.

## Generated files

- `pnpm --filter @draftyak/protocol spec` writes a JSON Schema (draft 2020-12, with `$id` `https://draftyak.com/spec/<path>`) for each module in `packages/protocol/scripts/spec/`, and `spec --check` exits 1 listing every file that differs, is missing, or has no module.
- `pnpm --filter @draftyak/protocol vectors` writes `vectors/` the same way, and `vectors --check` checks it; `vectors/README.md` describes the files.
- `pnpm test` runs both checks, so a schema changed without re-exporting fails it. After a rebase, generated files are regenerated, never merged by hand.
- Exported schemas hold only what JSON Schema can express. Rules beyond that, such as the canonical forms above, live in the protocol's validators and in this prose.
- A definition the protocol registers with an ID uses the `$defs` key `draftyak.<module>.<Export>`, where `<module>` is the `@draftyak/protocol/<module>` entry point that defines it. An ID is never renamed or reused. Re-exporting a definition keeps its owner's ID. Each schema includes shared definitions under those IDs, so a key can appear in several files, not necessarily the file named after its module: `draftyak.tool-v1.IanaZone` is in `schemas/entities-v1.schema.json`, not `schemas/tool-v1.schema.json`. The root `anyOf` of `entities-v1.schema.json` lists only `draftyak.entities.*` definitions.
- `schemas/tool-v1.schema.json` is the exception: it is tool-v1's literal document, and its hash is the declaration's `schemaDigest`. Its `$defs` keep the names specified by [tool-v1](extensions/tool-v1.md); changing those names changes the digest every tool plugin declares.
- A schema describes a document as it arrives, before any default is filled in: a field with a default may be left out, and an object that drops unknown members accepts them.
- Patterns are ECMA-262 regular expressions with explicit ASCII classes, never `\d`, `\w`, `\s` or `\b`, whose meaning other engines widen to Unicode. `^` and `$` anchor the whole string; where `$` also matches before a final line feed, as in Python's `re`, a validator checks the whole string instead. Fixed-length strings, such as ULIDs, hashes and instants, also carry `minLength` and `maxLength`.

## Index

These checked-in contracts remain draft until the M1 gate. A dash means the contract has no file of that kind. The [vector format and regeneration guide](vectors/README.md) applies to every vector directory below. Under M1's append-only shared-file rule, each contract item adds its index row in the same PR as its prose, schema or vector directory. The protocol coverage test enforces that every checked-in contract has its links here.

| Contract | Prose | JSON Schema | Vectors |
|---|---|---|---|
| Canonical JSON, signatures and header hashes | [Encodings](#encodings) | — | [JCS](vectors/jcs/), [ES256](vectors/sign/), [header hashes](vectors/hash/) |
| Flags, severities and acknowledgement | [Flags v1](flags-v1.md) | [Flags v1](schemas/flags-v1.schema.json) | [Flags](vectors/flags/) |
| Stored and displayed entities | — | [Entities v1](schemas/entities-v1.schema.json) | — |
| Pairing and confirmation | [Pairing v1](pairing-v1.md) | — | [Pairing](vectors/pairing/) |
| Broker send tickets | [Channel v1](extensions/channel-v1.md) | [Broker ticket v1](schemas/broker-ticket-v1.schema.json) | [Send tickets](vectors/send-ticket/) |
| Channel extension | [Channel v1](extensions/channel-v1.md) | [Channel v1](schemas/channel-v1.schema.json) | — |
| Normalized channel changes | [Channel v1](extensions/channel-v1.md) | [Normalized change v1](schemas/normalized-change-v1.schema.json) | — |
| Lookup tool extension | [Tool v1](extensions/tool-v1.md) | [Tool v1](schemas/tool-v1.schema.json) | [Tool lists](vectors/tool-v1/) |
| AI provider extension | [AI provider v1](extensions/ai-provider-v1.md) | [AI provider v1](schemas/ai-provider-v1.schema.json) | — |
| Draft output | [AI provider v1](extensions/ai-provider-v1.md) | [Draft output v1](schemas/draft-output-v1.schema.json) | — |
| Plugin errors | [Channel v1](extensions/channel-v1.md), [Tool v1](extensions/tool-v1.md), [AI provider v1](extensions/ai-provider-v1.md) | [Plugin error v1](schemas/plugin-error-v1.schema.json) | — |
| Send snapshots | [Approval v1: snapshot](approval-v1.md#snapshot) | [Snapshot v1](schemas/snapshot-v1.schema.json) | [Snapshots](vectors/snapshot/) |
| Approval and identity statements | [Approval v1: statements](approval-v1.md#statements) | — | [Statements](vectors/statements/) |
| Relay architecture | [Relay protocol v1](relay-protocol-v1.md) | — | — |
| Scheduling, DST resolution and the clock rule | [Approval v1: schedule](approval-v1.md#schedule-and-clock-rule) | — | [Schedule](vectors/schedule/) |
