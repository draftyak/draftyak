# Threat model and security coverage

**Status: partial obligations ledger; no security result or release approval is recorded.**
M11.8 owns this map. Implementing milestones retain their security mechanisms,
tests, native consumers and owner checks. The [M11 backlog](roadmap/m11.md)
defines the retained pilot scope and the remaining checker and gate work.

T01–T50 preserve the original threat identities and order. They are document
references, not test IDs or protocol fields. A01 adds the current obligation to
prove postponed surfaces absent or refused; it replaces none of those 50 rows.

## Scope and trust boundaries

The pilot retains desktop Gmail and Slack, the bundled hub, offered first-party
providers, drafting and one-off scheduled sends on Windows, Apple-silicon macOS
and Ubuntu 24.04. The desktop must be awake and running; a missed send window
requires fresh approval. Only the selected NSIS, arm64 DMG and Ubuntu deb are in
release scope. Python, tools, MCP, Apps, SMS/mobile, public listeners and
headless distribution are postponed, not passed or declared no-go.

Untrusted messages, headers and plugin/device assertions remain data. The hub
owns authorization, approval consumption, scheduling and broker policy. Native
trusted surfaces collect the PIN and display and sign the exact operation;
ordinary renderers, browsers and plugins cannot substitute for that approval.
Retained Gmail OAuth, provider disclosure/consent, account/security administration
and paired remote-desktop authorization are not postponed with MCP or tools.
Cancellation remains a tightening from the retained desktop and bundled CLI;
browser cancellation is postponed.

The same-OS-user threat limitation does not waive any retained encryption,
credential, native-store or approval requirement. Phone/SIM limitations remain
future SMS obligations, not a reason to reduce desktop protections. Optional
sign-in is separately maintained, names/status only here, and never blocks the
pilot. No optional implementation, procedure or mounting design is specified.

## Dispositions and evidence rules

- **Retained:** every applicable mitigation and test remains required.
- **Trimmed:** the row names both retained requirements and postponed branches;
  postponing a branch does not weaken its retained security property.
- **Postponed:** preserve the threat and restart obligations. Its feature suite
  is neither a pilot prerequisite nor a passing result; current absence/refusal
  evidence still belongs to A01.
- **UNBOUND:** this document has not bound the retained requirement to checked
  current evidence. It does not assert that an upstream implementation or test
  is absent. A candidate cannot pass with required evidence unbound.

A full binding must identify exact existing source and test IDs, the real
command/configuration, source and artifact versions, applicable OS/runtime/model
matrix and actual terminal result. A prototype, test-like name, green aggregate,
historical component result or source-only assertion supplies none of those
facts by itself. Missing, stale, unrun, failed, cancelled or required-skipped
coverage is not a pass. Windows evidence cannot satisfy macOS or Linux duties.
No test identifiers, executions or producer contracts are invented here.

The eventual `pnpm --filter @draftyak/launch-checks --fail-if-no-match threats`
check must reject omitted/duplicate identities, unsupported dispositions,
nonexistent tests, missing selected-OS evidence and stale/unrun passing labels.
This documentation change supplies no checker, fixture/result schema, test
selection or execution. Product security corrections remain with their owners.

## Invariants and retained suite ownership

| Requirement | Pilot disposition / owner | Acceptance or gap |
|---|---|---|
| I1 no send without approval | Exactly one consumed PIN-verified approval by a confirmed/nonrevoked approver at claim, covering frozen content/schedule and undo/notBefore/deliverBy; executor-only claim/ticket and broker byte match in M1/M2/M4. SMS/template branches postponed | M11.8 `threats`; retained approval/ticket/property suites |
| I2 untrusted data stays in data sinks unless flagged | Retain M3/M7 mail/drafting/HTML protections; MCP/tool sinks postponed | `threats`; injection corpus and real embedded-WebKit tests |
| I3 credentials never leave the hub | Retain channel/provider/native-store/broker protections; SIM/issuer branches postponed | `privacy`/`threats`; secret-canary and retained credential suites |
| I4 loosening needs admin step-up, tightening does not | Retain native/admin/cancel matrix; postponed tools/MCP/issuer branches are absent | `threats`; actual retained statements, unavailable kinds refuse |
| I5 content never reaches tool inputs | Keep the prohibition and retained provider no-tool-call controls; context-tool execution is postponed. Preserve planner/binder typed inputs, runner-only import boundary and lookup-bound broker egress for resumption | `threats`; added absence/refusal evidence, not a fabricated tool-suite pass |
| Unit/property/integration and production flags | Retain all applicable M1/M1b/M2/M3/M4/M5/M6/M7/M10 suites | Actual retained profiles/current-head CI; missing coverage stays open |
| Migration fixtures | M11.10 retained | `migrations`; actual versions/migrator/selected installers |
| Performance and soak | M11.9 retained; Python budgets postponed | `performance`; 50k/200-ms and actual two-hour soak |
| Egress/destination disclosure/canaries | M11.7 retained for Gmail/Slack/providers/models/schedule | `privacy`; exact shared recorder contract/captures |
| Shared corpus of at least 60 distinct cases; every retained provider × obedient/benign models | M11.8 retained for shipped providers | `threats`; actual current corpus results; optional protected result supplied separately and nonblocking |
| Fake-commercial BackupTarget Slack canary | M11.8; M2 extension owner retained | Actual M2 suite; no canary reaches refusing backup target |
| Complete scaffold/Python matrix | M11.11 postponed | Not a candidate prerequisite |
| MCP/OAuth/client conformance | M11.6/.8/.14 postponed portions | Record postponed; retained first-party contracts live in actual `ci.yml` full |
| Approval model/scheduling/recovery | M11.8/.10/.14 retained | Current property, rollback-anchor, two-machine restore and zero-approver suites |
| JS sandbox/IPC fuzz/memory/inspector/signals | M11.8 retained, Python portions postponed | Production suites on all selected OSes; macOS native escape/durability required |
| E2E/axe/Tauri ACL/native WebKit | M11.8/.14 retained; mobile/MCP Apps portions postponed | Current Windows/macOS/Linux evidence, no Chromium-only waiver |

## Original threat identities and pilot obligations

The requirement and owner columns retain the backlog's complete pilot threat
mapping. All retained bindings remain unresolved in this ledger; a postponed
row is not converted into a pass or an exemption for a retained property.
Present-tense mitigation descriptions state required properties, not findings
that an implementation exists, a surface is absent or a suite has passed.

| ID | Original threat heading | Pilot disposition | Item and implementation/evidence owner | Required retained property or preserved later obligation | Binding |
|---|---|---|---|---|---|
| T01 | Injected mail steers drafting | Retained | M11.8; M3/M7; M3.5 and M7.6. Reserved checks, if later available, remain their owner's handoff. | Hygiene, spotlighting, body-only output, hub-computed recipients, flags and approval; obedient model preserves recipients and produces no outbox row. Keep one shared corpus of at least 60 distinct cases, running obedient and benign model controls through every retained provider. | UNBOUND in this ledger; retained evidence is required. |
| T02 | Header spoofing (Reply-To, forged Authentication-Results, plugin-asserted direction) | Retained | M11.8; M3/M5; §9.2 mitigation/test and full-strength injection protections. | Provider-authenticated source and hub-derived direction; Reply-To/DMARC flags; one corpus case per spoofed source. Bundled-only plugins do not waive hostile-metadata coverage. | UNBOUND in this ledger; retained evidence is required. |
| T03 | Agent proposes an exfiltrating send | Postponed | M11.8; Later M2/M8; M2.21 MCP cases and postponed M8. | Preserve no-send-tool/proposal/ack/PIN/rate-limit clauses and malicious MCP/principal property suite. Active absence/refusal comes from pilot absence/refusal checks, not a claimed run of that suite. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T04 | Agent leaks or mutates mail | Postponed | M11.8; Later M8; postponed M8 and S4 surface scope. | Preserve account opt-in, session classes, budgets, denied labels/rate limits and complete resource/tool parity matrix. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T05 | Prompt output carries injected text with the user's authority | Postponed | M11.8; Later M8; postponed M8. | Preserve static first-party prompts, allowed arguments, delimited results and canary-free prompts/resource-link names. This is distinct from the retained “Injected mail steers drafting” row. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T06 | Elicitation phishing or automated accept | Postponed | M11.8; Later M8/M9; postponed MCP/client/remote milestones. | Preserve all forbidden asks, static status URL, principal/epoch/params binding, single-use state and MRTR hostile cases. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T07 | Hostile draft text runs script in an Apps view (incl. Claude mobile's native WebView) | Postponed | M11.8; Later M8b; postponed Apps milestone. | Preserve text-only rendering, passive packaged view, CSP and both-engine basic-host corpus, with and without sandbox. This does not postpone the retained desktop WebKit XSS checks in “Hostile HTML” and “Compromised webview”. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T08 | A view injects into the conversation or calls tools (`ui/message`, `ui/update-model-context`, `tools/call`) | Postponed | M11.8; Later M8b. | Preserve passive-view/full-policy requirements and recorder restricted to handshake/size changes. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T09 | Completion leaks mailbox data | Postponed | M11.8; Later M8. | Preserve alias/fixed-value restriction, budget/audit and mailbox-field/ID canaries. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T10 | Header/body smuggling on resources and prompts | Postponed | M11.8; Later M8. | Preserve sentinel decoding, Mcp-Name equality and all missing/malformed/mismatch HTTP/RPC refusals. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T11 | Malicious plugin sends or alters a send | Trimmed | M11.8; M1/M2; M2.15, M2.17, M2.18, M2.21; pilot absence/refusal checks/bundled-only plugin admission. | Keep credential/socket isolation, deny-default broker egress, canonical paths/headers, executor-only one-shot ticket, byte-exact matching, auto-disable and all applicable hostile send mutations, including Slack native scheduling refusal. Postpone the constrained json-template renderer/approval display and hostile-template cases; refuse that send kind at admission. | UNBOUND in this ledger; retained evidence is required. |
| T12 | Plugin sandbox escape (JS or Python) | Trimmed | M11.8; M2 JS; later M2c Python; M2.16/M2.21 and platform additions. | Keep the entire JS escape suite, exact argv/environment/IPC/hash/link/process protections on minimum and bundled Node on every selected OS. Postpone Python execution/escape cases. No reduction to Windows-only, sockets-only or a smoke test. | UNBOUND in this ledger; retained evidence is required. |
| T13 | Python plugin escapes Pyodide | Postponed | M11.8; Later M2c. | Preserve process boundary, curated bridge/read grants/local wheels, complete per-OS escape suite and 10k hostile-print stream-integrity test. pilot absence/refusal checks proves runtime absence instead. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T14 | Tampered or substituted Python runtime or wheel (Pyodide ignores integrity hashes in Node and can fall back to its CDN) | Postponed | M11.8; Later M2c/M10; M11.7/.8 mapping retained as history. | Preserve install/spawn/runtime/lock integrity, extension allowlist, abort/no-net rules and all tampered/extra/linked/missing/CDN/PyPI/index cases. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T15 | Memory exhaustion (wasm memory and ArrayBuffers escape `--max-old-space-size`) | Trimmed | M11.8; M2; later M2c; M2.16/M2.21. | Keep JS ArrayBuffer and WebAssembly allocation attacks, RSS watchdog, crash accounting and repeated-kill disable. Postpone Python list allocation/MemoryError and Python wasm-page-cap branch. | UNBOUND in this ledger; retained evidence is required. |
| T16 | Worker escapes the permission model (`new Worker(…, {execArgv: []})` runs unpermissioned) | Trimmed | M11.8; M2; later M2c; M2.16/M2.21. | Keep worker never-grant, argv snapshot and JS `ERR_ACCESS_DENIED` boundary. Postpone only the Python-to-JS bridge variant. | UNBOUND in this ledger; retained evidence is required. |
| T17 | Plugin opens the hub's inspector or signals it (`process._debugProcess` and `process.kill` are ungated) | Retained | M11.8; M2/M10; actual per-OS suite, exact launch argv and release artifacts. | Every hub launch retains disable-sigusr1/no-inspector flags, broker port block, doctor refusal and all OS-specific attack paths, including Windows remote-thread behavior. Keep the declared standard-profile signal-DoS boundary and supervisor restart. | UNBOUND in this ledger; retained evidence is required. |
| T18 | Malicious package or rug-pull update | Trimmed | M11.8; M2; M2.15/bundled-only plugin admission and M2.18; later tool/template owners supply those cases. | Keep exact version/digest/provenance, admin-only admission, pinned allowed-plugin artifacts and mismatch refusal/quarantine. Admission is restricted to the five bundled first-party plugins; no third-party install or network update-check is enabled. Tool-surface/json-template-change cases remain later clauses, not current test passes. This qualification never permits a digest or relevant retained-manifest change without quarantine. | UNBOUND in this ledger; retained evidence is required. |
| T19 | Injected mail steers lookups or exfiltrates through tool arguments | Postponed | M11.8; Later M7b; pilot absence/refusal checks proves absence now. | Preserve pure planner inputs, DMARC/Reply-To skips, no model-selected tools and body/subject/header noninterference plus obedient-model suite. I5 remains a retained prohibition; no executable lookup is enabled. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T20 | Tool poisoning or rug pull | Postponed | M11.8; Later M2/M7b. | Preserve canonical kinds, per-job/list-change equality, quarantine, forbidden capabilities and before-fourth-call hostile case. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T21 | Hostile or compromised tool results | Postponed | M11.8; Later M7b. | Preserve schemas, size caps/hygiene/spotlighting, flags/approval and all hostile result types. Native mail/drafting injection protections remain in “Injected mail steers drafting” and “Header spoofing (Reply-To, forged Authentication-Results, plugin-asserted direction)”. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T22 | Tool plugin exfiltrates or beacons | Postponed | M11.8; Later M1/M2/M7b; active generic broker protection remains M2.17. | Preserve lookup-bound read egress, exact secret URLs, no ws/blobs and install/runtime/audit refusal matrix. Do not relax the retained general broker DNS/egress guard. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T23 | Tool upstream receives or trains on inbox data | Postponed | M11.8; Later M7b; active provider-policy evidence remains in “Vendor-policy breach”. | Preserve account×instance consent, destination/posture/field rules, no-may-train/Slack opt-in/SMS-number restrictions and no inbox-canary tool request. Retained provider disclosure/consent remains M7.5. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T24 | Calendar address theft or over-sharing | Postponed | M11.8; Later M7b. | Preserve encrypted URL/admin-only entry, secret indirection, busy-only output and complete URL/event-field canary sink list. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T25 | Hostile HTML | Retained | M11.8; M3/M4; M3.9, M4.19, platform §7 and retained native/WebKit acceptance. | DOMPurify, sandbox iframe, CSP, Trusted Types and remote-content-off; Chromium/WebKit XSS corpus proves no script/network. Embedded WKWebView/WebKitGTK origin, CSP/Trusted Types and real target-version checks remain required. | UNBOUND in this ledger; retained evidence is required. |
| T26 | Compromised webview | Retained | M11.8; M4; M2.3 negative classes, M4.2/.12/.13/.20. | Separate trusted approval origin, Rust re-hash/render, ids-only IPC and native ACL/capability tests on every selected desktop OS. The mobile-cannot-approve refusal remains a cheap negative protection, not a request to implement or test the postponed mobile client. | UNBOUND in this ledger; retained evidence is required. |
| T27 | Replay, edit after approval, double send, crash | Retained | M11.8; M2; M2.8/.9/.21, macOS durability/file-rollback protection. | Single-use/expiry/hash checks, guarded transitions, UNKNOWN→reconcile→reapproval; two executors and crashes at every step, including SCHEDULED. Retain macOS durability and file-rollback additions; no weakening from removal of other channels. | UNBOUND in this ledger; retained evidence is required. |
| T28 | Early, late or duplicate scheduled send (timer overflow, wall-clock jump, suspend, DST, hub down) | Retained | M11.8; M2; M1.18/M1.27, M2.7–.10, M4.15–.17, Gmail/Slack schedule acceptance. | Full two-clock/UTC/IANA/DST/timer-boundary model; guarded claim, skew hold and missed→reapproval. Desktop must be awake/running; no wake-to-send, no late send or newly inferred approval window. | UNBOUND in this ledger; retained evidence is required. |
| T29 | Stale approval used after the world changed (approver or SMS host revoked, restore, credential loss, quarantine, read-only switch, policy change, Slack channel facts changed, new reply) | Trimmed | M11.8; M2/M4/M5/M6; M2.10/M2.21. | Keep every applicable claim-time epoch/approver/policy/account/Slack-facts/inbound check, exact void state/reason and notification. Postpone only the SMS-host-revocation trigger (and tool-only instances); retained plugin quarantine still voids appropriately. | UNBOUND in this ledger; retained evidence is required. |
| T30 | Schedule manipulation by agents or inbound mail (setting or extending the time, sending early, cancelling the owner's items, editing a scheduled draft, replying to suppress a send) | Trimmed | M11.8; M2 active; later M8; M2.10/.21 and schedule protections. | Keep time/lateness inside approved contentHash, DRAFT_LOCKED/no active schedule mutation, and inbound may only visibly hold: T−1 holds, T+1 never creates a second send. Postpone MCP/agent-token proposal/cancel matrix and own-request agent cancellation; no agent surface is admitted by the trim. | UNBOUND in this ledger; retained evidence is required. |
| T31 | **Restore rollback** | Trimmed | M11.8; M2/M10; M11.10/.14 collect; M2.12, macOS durability/automatic per-OS upgrades/per-OS/cross-OS restore/file-rollback protection. | Keep uninitialized-dir recovery-code restore, epoch bump, devices unconfirmed/new PIN, once-reopened bootstrap, APPROVED/SCHEDULED→NEEDS_REAPPROVAL, past-due reconciliation and no restored send. Keep restore-hook seams. Postpone MCP grants/tokens, tool-consent state and SMS-host/no-ticket/FakeSmsHost branches. Real two-machine/per-OS and cross-OS restore evidence remains required. | UNBOUND in this ledger; retained evidence is required. |
| T32 | **Approver bootstrap abuse** | Retained | M11.8; M2; the full-strength recovery protection. | Bootstrap once; recovery-code plus 24h/alerts for zero-approver recovery; CLI cannot revoke the last approver; complete zero-approver property path. | UNBOUND in this ledger; retained evidence is required. |
| T33 | Canonicalization tricks | Retained | M11.8; M1/M1b/M3. | JCS/NFC/codepoint/IDNA/CRLF/homoglyph controls, shared TS/Rust vectors and MIME differential fuzz. Removing SMS features does not weaken the retained canonicalization boundary or invent a requirement to run Kotlin/mobile suites. | UNBOUND in this ledger; retained evidence is required. |
| T34 | Stolen device or key | Retained | M11.8; M2/M4; M1b.3/M4.4/.10; The selected Linux no-fallback and actual macOS store contracts apply. | Hub-verified PIN, lockout and revocation; signature without PIN refused. Keep genuine selected-OS identity/store results and typed refusal without regeneration/re-pair. Linux requires a real Secret Service; no passphrase fallback there. | UNBOUND in this ledger; retained evidence is required. |
| T35 | Stolen OAuth token, consent phishing, push bombing | Postponed | M11.8; Later M9; active Gmail/provider credentials remain M2/M5/M7. | Preserve audience/scope/reuse/allowlist/typed-code/public-page/rate protections and OAuth-AS suite. This is the MCP issuer row, not a waiver for retained Gmail OAuth/token-vault security. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T36 | SSRF; OAuth mix-up; DNS rebinding, CSRF, token in URL (CVE-2026-25253 class) | Trimmed | M11.8; M2/M5/M7 active; later M9/tool owners; M2.17, M3.7/.9, M4.8/browser-login exclusion and native cancellation and M11.7. | Keep generic resolve-then-connect and blocked-hub-port guard, relevant L1 Host/rebinding/query-token/CSRF refusals, retained Gmail OAuth mix-up/issuer protections and local-model probe protections. Postpone M9 OAuth issuer/public-listener and tool URL-secret branches; A1 browser-login/cookie cells are absent, not passed. No general SSRF exemption. | UNBOUND in this ledger; retained evidence is required. |
| T37 | Device↔hub MITM, intercepted pairing link | Retained | M11.8; M1b/M4; actual merged M1.21b/downstream proof checks and non-loopback desktop pairing. | SPKI pin, mTLS, EKM/certificate binding, SAS/approver confirmation and merged commit-reveal proof contract. Wrong-key proxy and proof replay fail, including retained Connect-to-hub/non-loopback use. | UNBOUND in this ledger; retained evidence is required. |
| T38 | Spoofed SMS broadcast or forged inbound text | Postponed | M11.8; Later M6b. | Preserve guarded receiver/provider-truth/hygiene obligations and SMS/WAP emulator attack. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T39 | Forged, replayed, mutated or misdirected send ticket | Postponed | M11.8; Later M1/M6b. | Preserve native host key/audience/epoch/expiry/nonce/JCS/hash/segmentation checks and hostile Kotlin/fake-hub tickets. Retained broker tickets remain in “Malicious plugin sends or alters a send” and I1. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T40 | Another app or the webview tries to make the host send | Postponed | M11.8; Later M6b/M10. | Preserve exported-component/PendingIntent/permission rules and both-app intent/manifest guard. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T41 | Hostile host attacks the hub | Postponed | M11.8; Later M2/M6b. | Preserve host-only capabilities/routes, untrusted ingest, no receipt-driven resends and all hostile FakeSmsHost refusals. pilot absence/refusal checks now refuses the role/routes. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T42 | Lost or stolen phone | Postponed | M11.8; Later M6b. | Preserve disconnect/revoke, exact pause/void/may-have-sent behavior and no later tickets/receipts. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T43 | Lossy encoding or segment tricks | Postponed | M11.8; Later M1/M6b. | Preserve hub/Rust/host recomputation and exact-body joining with GSM/emoji/NFD/translation vectors. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T44 | OTP or code leakage to AI, MCP or tools | Postponed | M11.8; Later M6b/M7/M7b/M8 composition; retained general secrecy remains in “Theft of disk, backups or logs” and I3. | Preserve its default exclusion/flags and complete future corpus/sink tests. The M7.6/.7 pilot scope explicitly postpones this SMS family. This classification does not waive retained Gmail/Slack/provider credential/canary controls or authorize real secrets in prompts/fixtures. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T45 | Premium-rate or emergency destinations | Postponed | M11.8; Later M1/M6b. | Preserve destination-class/E.164 and host recheck/refusal vectors. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T46 | Public listener exposes private routes | Postponed | M11.8; Later M9; M10 later consumes packaged results. | Preserve separate allowlisted route table, discovery snapshots and doctor-public probe. Active desktop/paired-hub routes still require their own authorization/route snapshots and pilot absence/refusal checks; no public listener is enabled. | Deferred obligation; no pilot feature-test pass claimed. A01 remains current. |
| T47 | Theft of disk, backups or logs | Retained | M11.8; M2/M10; M11.7/.8; macOS durability/native key-store requirements/per-OS/cross-OS restore. | Key-verified SQLite3MC, secret encryption/recovery wraps, age exports/content-free logs and complete DB/WAL/SHM/FTS/snapshot/backup/log canary scans. macOS flush, actual stores, encrypted backup/restore and all selected OS evidence stay required. | UNBOUND in this ledger; retained evidence is required. |
| T48 | Vendor-policy breach | Trimmed | M11.8; M5/M6/M7 active; later M7b; M11.7/.8/.13; retained legal and provider-policy requirements and M7.5/M11.13. | Keep Gmail disclosure/routing/verifiers, Slack 90-day cap/no-training/provider opt-in, provider policies, observed revocation purge and retention eviction with forbidden-field/timer matrices. Postpone the M7b/tool-destination/privacy leg and its readings; do not demand or imply those later suites passed. Retained legal review/clearance duties are not satisfied by document research; use only permitted policy sources. | UNBOUND in this ledger; retained evidence is required. |
| T49 | Extension module weakens the gate | Retained | M11.8; M2 extension owner; M11.8 maps real suite, not a replacement implementation. | Restrict-only/fail-closed registry, separate DB, owner included in N-of-M, hostile fake-commercial BackupTarget denied Slack canaries and no plugin_kv backup. No plugin-author SDK or public third-party install is needed to retain this hostile synthetic control. | UNBOUND in this ledger; retained evidence is required. |
| T50 | Test hooks or CI supply chain | Retained | M11.8; M10/CI owners; M11.15 collects; selected-OS CI/retained security/nightly workflows/translocation/signing checks and the selected installer, store and exact advisory constraints. | Release guard, exact pins/workflow policy/zizmor, supply-chain defaults, CodeQL and genuine release dry run. Cover NSIS/arm64 DMG/Ubuntu24.04 deb; refuse e2e features, mocks/dev keys/test hooks; preserve the approved exact advisory-exception scope's exact renewal/termination scope and normal dependency/advisory/license review without expansion. | UNBOUND in this ledger; retained evidence is required. |

## A01 — Postponed surfaces remain absent or refused

**Binding: UNBOUND.** The following are required observations, not completed
snapshots, refusals or artifact checks.

M11.8 maps the threat that an unavailable surface, statement, admission path, key source or release asset becomes reachable or is silently treated as authorized. M11.15 consumes its evidence. This additional row neither replaces any original row nor marks postponed suites passed.

| Implementing owner | Required current evidence |
|---|---|
| M2 hub/challenge/startup owners | Actual production route/discovery snapshots omit postponed MCP/L3/S4 issuer/discovery/access/tool/consent, agent-session, browser-login/cookie and SMS-host surfaces. Postponed statement kinds/host roles/SMS snapshots refuse with assigned fixed codes; retained approval/admin/pair paths work. Headless systemd/Docker/environment/standalone-key sources refuse at startup. Actual selected-OS desktop source/store contracts remain required, with no Linux passphrase fallback. |
| M2 plugin admission/supervisor/broker owners | Refuse tool kind, Python runtime, url-secret and json-template send admission; only the five named first-party plugins are installed. Preserve integrity/no-scripts/read-only unpack/link/extra-file controls. channel-hello stays a fixture only. |
| M4 native capability/route/statement callers | Actual per-OS route/capability/discovery snapshots omit those postponed paths while retained pairing/admin/approval/scheduling works. Unavailable statement kinds refuse; native authority/origin/ACL controls stay intact. |
| M10 release-guard owner and separately assigned module owners | Actual NSIS/arm64 DMG/Ubuntu deb inventories exclude Python runtime, tool runner, ical.js, .mcpb, ui:// and postponed headless/mobile distribution assets. Require exact source/version/integrity and signing rules; no source-only assertion substitutes for packaged evidence. M11 does not claim release-guard implementation paths. |
| M11.8/.15 | Bind exact upstream snapshot/refusal/artifact tests, owner, command/source version and applicable OS results. Missing/unrun/stale evidence fails. Absence is not inferred from a missing UI or postponed backlog. |

This absence scope does not prohibit retained Gmail consent, provider disclosure/consent, account/security administration or paired-desktop authorization. S4 consent.v1/access kinds are postponed separately. Optional ai admin-group, auth-descriptor, profile and authorization general seams are currently unmerged and fail closed until available; they are not postponed or permanently absent. Later actual owning M1 contract PRs add permitted entries under normal review. No protected implementation or mounting design is inferred, and optional sign-in never blocks launch.

## Required coverage and remaining acceptance

Keep one shared injection corpus with at least 60 distinct cases, exercised with
both obedient and benign models through every retained provider. Retained
families include multilingual/encoded instructions and fake delimiters, hidden
HTML/CSS and bidi/zero-width text, image/query exfiltration, hostile names,
subjects and filenames, fake approval notices, Reply-To/Authentication-Results
forgery and Slack mention/link/unfurl bait. MCP-client, Apps and lookup-specific
families remain preserved future obligations. Corpus count alone establishes no
assertion or model/provider coverage. Optional protected-provider results are
supplied separately and are nonblocking for a release without that route.

Retained approval/property suites cover Gmail/Slack and every retained principal:
exact frozen content/window, wrong/expired/revoked/PIN/epoch cases, both clocks,
per-OS suspend/jumps, DST/timer boundaries, two executors, crashes, UNKNOWN
reconciliation, cancellation races, inbound holds, Slack fact changes,
disconnect/read-only/quarantine/credential loss, two-machine restore and
zero-approver recovery. SMS tickets/receipts/SIM/host and MCP principal branches
are postponed. No scheduling, restore, duplicate-send or native-authority
protection is relaxed by that classification.

Keep the retained security/property, fuzz, two-hour soak, production-flag JS
escape and minimum/bundled Node requirements, including 500 security-CI property
runs, nightly 10,000 property runs and macOS escape coverage. Selected-OS native
stores, durability and file-rollback, real embedded WKWebView/WebKitGTK
origin/CSP/TrustedTypes/XSS/ACL,
Chromium/WebKit/axe, and native ACL/approval tests retain their distinct evidence.
Native Rust/smoke, Playwright WebKit and a real-Mac owner check do not waive the
embedded-WebKit proofs. Python budgets and MCP/OAuth/scaffold conformance are
postponed; they do not replace retained first-party channel/provider contracts
and actual plugin conformance through the owned CI routing.

Storage, migration, automatic in-place upgrades, per-OS/cross-OS restore,
encrypted DB/WAL/SHM/FTS/snapshot/backup/log canaries, refusing-BackupTarget Slack
canaries, first-party-only bundle integrity and selected-artifact release guards
remain required. Preserve exact dependency/advisory/licence constraints and
approved exception termination/renewal scope; this map grants no expansion.
Actual egress/privacy evidence must use its owner's confirmed contract and
current retained Gmail/Slack/provider flows, not an invented capture format.

M11.8 stays partial until exact retained bindings and the completeness/evidence
checker exist and pass, required upstream gates and all selected-OS results are
accepted, and A01 has actual current snapshots/refusals/artifact evidence.
Real-machine-pending cells must be resolved before RC. Real account sessions,
legal/trademark decisions, installed-artifact checks and explicit owner release
approval remain separate. Document research and this ledger satisfy none of them.
