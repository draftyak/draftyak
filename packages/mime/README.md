# MIME rendering

`@draftyak/mime` renders deterministic RFC 5322 bytes from supplied in-memory values. The pinned MailComposer has file and URL access disabled. Rendering reads no clock, creates no randomness and makes no network or storage calls.

- `renderMime(input, stamp)` returns MIME bytes and canonical To/Cc/Subject/text-hash metadata.
- `canonicalAddress` and `normalizeAddresses` preserve ASCII local-part case and canonicalize IDNA domains.
- `normalizeSubject` collapses whitespace; `textSha256` normalizes decoded-text line endings and terminal newlines. That decoded-text hash is distinct from the exact request-body hash used by a send ticket.
- `snapshotClaimStamp(raw)` validates and detaches stamp data. It grants no approval, account, claim, credential or send authority.

The renderer refuses nonempty Bcc with `BCC_UNAVAILABLE` before composition. There is no preservation option. M5 must wait for ADR 0010 to settle delivered-copy behavior before Bcc rendering or activation is implemented.

The existing four-field `ClaimStamp` includes `uploadBoundary`; raw MIME composition uses only `messageId`, `dateMs` and `mimeBoundary`. The exported `BAD_THREAD_ID` code is not emitted by this renderer. Errors retain their fixed `gmail: CODE` diagnostic format. These API compatibility fields do not implement an HTTP upload or Gmail thread validation; M5 owns those integrations.

Before composition, message and stamp fields are detached through own data descriptors. Proxies, accessors, inherited/custom objects, symbols, nonenumerable metadata and sparse/custom arrays refuse without executing hooks. Known optional fields set to `undefined` keep their default behavior. Attachment content must be native unshared Buffer/Uint8Array storage; intrinsic slots determine its actual bytes. Aggregate input sizes are checked before copying any attachment. Only the explicit in-memory MailComposer allowlist is used.

Header CR/LF, controls and lone surrogates refuse before composition. Message IDs accept RFC 5322 dot-atom text and domain literals without whitespace or controls. Unsupported List-* fields and non-ASCII List-* values refuse, as do `multipart/*` and `message/*` attachments and a supplied MIME boundary collision. Limits remain 500 recipients across To/Cc/Bcc, 1,000 references, 100 attachments, 16,384 input bytes per header value, 998 octets per composed line and 36,700,160 composed bytes (35 MiB), including base64 expansion.

Run `pnpm --filter @draftyak/mime typecheck`, `test` and `build`. The package owns all four synthetic M0.28 golden files: `reply-ascii`, `reply-unicode`, `new-with-attachment` and `list-headers`. Tests compare three non-Bcc fixtures byte for byte and independently parse them back; the historical Bcc-bearing `new-with-attachment` fixture is preserved and parsed but current rendering must refuse pending ADR 0010. Tests also cover header refusals, collection and line neighbors, attachment type refusals, post-base64 size limits and explicit Bcc refusal. `test/mime-parse.ts` is a test-only reader independent of the renderer. No product code imports a spike.

Golden files were produced with Nodemailer 10.1.2 and retain CRLF bytes. Regenerate deliberately with `node test/make-golden.ts` from `packages/mime`, then review every byte change; a test run never rewrites them.

Callers must persist approved canonical content and claim stamps through their guarded outbox flow. The returned Buffer is caller-owned wire data and must be hashed and transported through the exact-request boundary. Runtime, broker, native outbox and provider-send adoption are separate owning items.
