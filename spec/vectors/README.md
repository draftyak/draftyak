# Shared test vectors

Every implementation of the protocol, in any language, must pass these files byte for byte. They are generated: never edit them by hand.

## Files

- Each file lives in `vectors/<area>/` and is a JSON object `{"format": "draftyak.vectors.<area>.v1", "description": "…", …}`. Every file of an area has the same `format` id, and its `description` says how to read its cases.
- Expected bytes are given as hex (`canonicalHex`, `signingInputHex`), as are inputs that aren't valid text (`inputHex`) and bytes as a verifier receives them (`receivedHex`). Every string in a file is well-formed Unicode, so any JSON parser can read the files.
- Keys in vectors are test-only, made for the vectors and marked `"testOnly": true`; they are never used for anything else.
- Vectors that depend on data tables, such as tzdata or Unicode, record the versions they were made with.
- SMS bodies are invented or start with `DYTEST-`, and phone numbers come only from fictional ranges (NANP 555-0100 to 555-0199, UK 07700 900000 to 900999).

## Regenerating and checking

```
pnpm --filter @draftyak/protocol vectors
pnpm --filter @draftyak/protocol vectors --check
```

The first writes every file from its generator, `packages/protocol/scripts/vectors/<area>.ts` or `<area>/<part>.ts`, each of which writes only its own area. The second exits 1 and lists every file that differs, is missing, or has no generator; `pnpm test` runs the same check.

`node:crypto` signs with a random nonce, so generators keep each recorded signature while it still verifies, and sign again only when what it covers or its key changes. Test keys are kept the same way.
