# Pairing v1

> **Status: draft.** Until the M1 gate, M1 items may change this file; after it, it changes only through contract PRs, under the versioning rule in [README.md](README.md). The EKM parameters may still change with ADR 0007 (see [The EKM parameters and ADR 0007](#the-ekm-parameters-and-adr-0007)).

How a device pairs with a hub: the pairing window, the payload the hub shows, the TLS connection and its keying-material exporter (EKM), the claim with its commitment and proof, the hub's checks and answer, the reveal, the short authentication string (SAS), and confirmation. `@draftyak/protocol/pairing` (`packages/protocol/src/pairing.ts`) implements the formats and checks; `vectors/pairing/` holds the shared vectors. Encodings follow [README.md](README.md): hashes as lower-case hex, public keys as base64url SPKI DER in the 91-byte P-256 form, base64url unpadded and canonical, instants as UTC milliseconds.

## Roles

| Role | Pairs | From |
|---|---|---|
| `device` | the desktop and mobile apps, and any other client device | this draft |
| `host:sms` | the SMS host on the owner's Android phone | the SMS contract (M1.23), after the owner's S12 decision |

A window pairs one role, which its payload names. A claim names its role too, and the hub refuses a claim whose role isn't the window's, so a host never pairs on a device window or a device on a host window. The roles are one list in `pairing.ts`; the SMS contract adds `host:sms` to it, and `packages/protocol/test/pairing.test.ts` checks that this one line is the whole change the payload, claim and checks need. What a host does differently (its receipt key, the hub statement key it pins, its `draftyak-sms://` link) belongs to `device-host-sms-v1.md`.

## 1. The window

- An owner opens a window from a trusted surface: the desktop approval window on the hub, `draftyak pair` with the PIN, or an existing approver.
- The hub draws `pid` (16 bytes: the window's id and the exporter's context) and `sec` (16 bytes, 128 bits: the window's secret, which keys the proof) from a CSPRNG, and sets `exp` to the opening time plus 300,000 ms. The sidecar's window derives them instead ([Sidecar auto-pairing](#sidecar-auto-pairing)).
- A window accepts one successful claim and then closes to claims; that claim's reveal follows before `exp` (section 8). Three failed claims burn it, and it closes at `exp` by the hub's clock.
- While a window is open, `/pair/v1/*` is the only L2 path a client certificate the hub doesn't know may reach.

## 2. The payload

The pairing code is `draftyak-pair:v1:` followed by the base64url of the payload's canonical JSON (RFC 8785, as in [README.md](README.md)), for example `draftyak-pair:v1:eyJhZGRyIjpb…`. The payload is a JSON object with exactly these members:

| Field | Form | Meaning |
|---|---|---|
| `hid` | 64 lower-case hex digits | the SHA-256 of the hub certificate's SPKI (DER); the device pins it |
| `addr` | 1 to 8 addresses, below, as different strings | where the hub listens for L2: its `advertisedAddresses` setting (an admin op) |
| `pid` | base64url of 16 bytes, 22 characters | the window's id; the exporter's context |
| `sec` | base64url of 16 bytes, 22 characters | the window's secret |
| `exp` | UTC milliseconds, a safe integer from 0 | when the window closes |
| `name` | a display name, below | the hub's name, shown for consent |
| `role` | `device` | the role the window pairs |

An **address** is `host:port`, with no scheme, user information, path or other text. `host` is one of:

- **IPv4**: dotted decimal with no leading zeros (`192.168.1.20`) and a first octet from 1 to 223, so neither `0.0.0.0/8`, multicast (`224.0.0.0/4`) nor `240.0.0.0/4` with the broadcast address;
- **IPv6**: a lower-case address in brackets (`[fd7a:115c:a1e0::1]`), in one of RFC 4291's text forms, with groups of 1 to 4 hex digits and at most one `::`, without a zone or an embedded IPv4 part, and neither the unspecified address (all zeros) nor multicast (`ff00::/8`: a first group of four digits that starts with `ff`);
- **a DNS name** in lower case (`hub.home.arpa`, `xn--bcher-kva.example`), of at most 253 characters, whose labels are 1 to 63 of `a-z`, `0-9` and `-`, never starting or ending with `-`, separated by single dots with no trailing dot, and whose last label is neither all digits nor `0x` followed by hex digits, because URL parsers read such a name as an IPv4 address or refuse it.

`port` is 1 to 65535 with no leading zeros. The addresses in `addr` are different strings, so two spellings of one IPv6 address would count twice; the hub writes IPv6 in RFC 5952's form.

`pairing.ts` checks each host form with its own regular expression, written with ASCII classes only and without lookaround, and the DNS name's length and last label as separate checks, so an engine without lookaround, such as Rust's `regex` crate, can follow it check for check.

A **display name** (the hub's `name` here, the device's in the claim) is 1 to 64 Unicode code points, well-formed, with these rules, which keep what the owner reads from being hidden or reordered:

- none of these code points: U+0000–U+001F, U+007F–U+009F, U+00AD, U+034F, U+061C, U+115F–U+1160, U+17B4–U+17B5, U+180E, U+200B, U+200E–U+200F, U+2028–U+202E, U+2060–U+206F, U+3164, U+FEFF, U+FFA0, U+FFF0–U+FFFB, U+1BCA0–U+1BCA3, U+1D173–U+1D17A, U+E0000–U+E00FF and U+E01F0–U+E0FFF;
- no **blank** first or last: U+0020, U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000 (the white space that the first list doesn't refuse) and U+2800 (braille blank);
- at least one code point that is neither a blank nor a **joiner**: U+180B–U+180D, U+180F, U+200C, U+200D, U+FE00–U+FE0F and U+E0100–U+E01EF.

The joiners (zero-width non-joiner and joiner, and the variation selectors) stay allowed inside a name, because emoji and several scripts need them. Together, the first list and the joiners cover every default-ignorable code point of Unicode 17.0; the list also holds controls, the line and paragraph separators and the interlinear annotation characters. The lists are explicit rather than Unicode properties, so every implementation refuses the same names whatever its Unicode tables; a test checks them against Node's Unicode data.

`pairing.ts` exports these rules as `DisplayName`, which the hub's record of a device (`Device.name`) takes too. Its JSON Schema, `draftyak.pairing.DisplayName` in `schemas/entities-v1.schema.json`, states only the length; the lists need code.

**Decoding.** A device checks a pairing code in this order and refuses it at the first check that fails, with that check's code:

| Code | Refused |
|---|---|
| `PAIR_PREFIX` | text that doesn't start with exactly `draftyak-pair:v1:` |
| `PAIR_ENCODING` | text longer than 1,000 characters, the prefix included; text after the prefix that isn't canonical base64url; bytes that aren't the canonical JSON of a value (invalid UTF-8, a lone surrogate, a byte-order mark, a duplicate member, whitespace, another member order, another spelling of a string or number) |
| `PAIR_PAYLOAD_INVALID` | JSON that isn't exactly the members above in their forms |
| `PAIR_EXPIRED` | `exp` earlier than the device's clock (the code is still good at `exp` itself) |

So a code that fails two checks gets the first one's code: non-canonical JSON of an invalid payload is `PAIR_ENCODING`. A text with the right prefix and any non-ASCII character is `PAIR_ENCODING` either way, so counting its length in bytes, code points or UTF-16 units gives the same code.

Requiring the canonical form gives every payload exactly one code, so a QR code, a pasted code and a link carry the same text. The 1,000-character limit keeps a code within one QR code that a phone reads easily off a screen, where the grammar alone would allow about 3,400 characters. `encodePairingPayload` refuses a payload whose code would be longer, with `PAIR_ENCODING`, so the hub keeps its `name` and `advertisedAddresses` short enough. The device's `exp` check only stops stale codes; the hub's clock decides whether the window is open.

**Delivery.** The code reaches the device as a QR code (mobile), through "Paste pairing code" (on the desktop, Rust reads the clipboard or a native dialog, so the code never enters JavaScript), or in a `draftyak://pair#<code>` link, whose fragment is the whole code. A link only opens the pairing screen: the app decodes the fragment as above, and nothing connects before the owner's consent. A link is not a code (`decodePairingPayload` refuses one with `PAIR_PREFIX`), so the app takes the fragment first.

## 3. Consent

The device shows the hub's `name` and its ID, `DYK-` followed by the first 16 hex digits of `hid` in upper case, in groups of four (`DYK-0CDA-C297-491E-0980`; `displayHubId`). The owner taps "Pair". There is no auto-connect, and a device pairs with one hub. Comparing this ID with the one the hub's trusted surface shows is what catches a code whose `hid` was replaced on its way (section 9).

## 4. Keys

The device makes two P-256 keys in its keychain store: a **transport key**, with a self-signed client certificate (`rcgen` in the apps), and a **signing key**, which signs its statements: for a `device`, the approval key that signs the six device statement types of `approval-v1.md` (M1.8, M1.9). The client certificate's SPKI is the 91-byte P-256 form with the uncompressed point, so its SHA-256 is the same whether an implementation hashes the certificate's own SPKI bytes or a re-export of the key.

## 5. Connect

The device tries the addresses in `addr` in order and connects with TLS 1.3 only, presenting its client certificate. It pins the hub: the SHA-256 of the SPKI of the certificate the hub presents must equal `hid`, or the device ends the connection before sending anything. The hub sends no session tickets, so every pairing connection runs a full handshake.

## 6. The exporter

Both ends compute, on that live connection after the handshake,

```
ekm = TLS-Exporter(label = "EXPERIMENTAL-draftyak-pair-v1", context = the 16 raw pid bytes, length = 32)
```

as RFC 8446 §7.5 defines it. In Node, `tlsSocket.exportKeyingMaterial(32, "EXPERIMENTAL-draftyak-pair-v1", pid)` (`pairingEkm`); in rustls, `conn.export_keying_material([0u8; 32], b"EXPERIMENTAL-draftyak-pair-v1", Some(pid))`; on the SMS host, Conscrypt's `SSLSockets.exportKeyingMaterial(socket, label, pid, 32)`. Labels that begin with `EXPERIMENTAL` are for private use and need no IANA registration (RFC 5705 §4).

M0.21 (S5a) showed rustls 0.23.46 with `ring` equal to Node 26.12.0 (OpenSSL 3.5.9) with these parameters, with rustls as the client presenting a certificate and as the server, on Windows x64 (`spikes/s05-desktop/evidence/ekm-win32-x64.json`); the context changes the output, as it must. M0.36's hub stand-in pins the same label and length for the SMS host, which M0.38 checks on the owner's phone.

## 7. The claim

For each claim the device draws `nd`, 16 bytes from a CSPRNG, and sends `POST /pair/v1/claim` on the same connection, with a JSON body of exactly these members:

| Field | Form | Meaning |
|---|---|---|
| `pid` | as in the payload | the window it claims |
| `role` | as in the payload | the role it claims as |
| `name` | a display name | the device's own name, which the approver sees |
| `transportSpkiSha256` | 64 lower-case hex digits | the SHA-256 of its client certificate's SPKI |
| `signingKey` | base64url SPKI DER, the 91-byte P-256 form | its signing key |
| `c` | 64 lower-case hex digits | `SHA-256("draftyak/sas-commit/v1" ‖ nd)`, its commitment to `nd` (`pairingCommitment`) |
| `proof` | 64 lower-case hex digits | `HMAC-SHA-256(sec, "draftyak/pair/v1" ‖ ekm ‖ pubs ‖ c)` |

`"draftyak/sas-commit/v1"` is those 22 ASCII bytes and `"draftyak/pair/v1"` those 16, `ekm` the 32 bytes above, `c` in the proof its 32 bytes, and

```
pubs = transportSpkiSha256 (32 bytes) ‖ the uncompressed SEC1 point of signingKey (65 bytes: 0x04 ‖ x ‖ y)
```

97 bytes in all: what the S10 transport skeleton's `claim_body` puts in `pubs` (ADR 0012), its 32-byte SPKI hash followed by the SEC1 approval key. The point is the last 65 bytes of the signing key's SPKI. Every part has a fixed length, so the proof's message is 177 bytes. The skeleton's `pair_proof(sec, ekm, pubs)` gives this proof when it is passed `pubs ‖ c`, as `pairingProof` is, so M1b's Rust side keeps the skeleton's formula and its kept test. The body is strict JSON, as [README.md](README.md) defines it, of at most 4,096 bytes; it needn't be canonical, because nothing signs its bytes. A claim without `c`, as M1.21 made it, is refused.

The device keeps `nd` to itself until it holds the hub's answer to this claim, then reveals it on this connection (section 8), and uses it for no other claim. Once it has revealed, it makes no further claim from that pairing code, whatever the answer.

**Why the signing key and `c` are in the proof.** The proof makes the window's secret and this connection's EKM vouch for both keys the hub records and for the commitment, not only the transport key. TLS already protects the body in transit, but the binding should hold in the pairing check itself, whatever sits between the TLS layer and that check (a proxy, a multiplexed stream, a request mix-up): no one can attach another signing key or another commitment to a transport key that verified. And the signing key is the key that later signs every approval, so it is covered by the same check that the SAS and the approver confirm. The device's `name` stays outside the proof: whoever claims chooses it, and it can imitate a code, so the SAS and the confirmation, not the name, tell the owner which device claimed (section 9).

## 8. The hub's checks and answer

The hub checks a claim in this order:

1. the body is at most 4,096 bytes of strict JSON with exactly the members above in their forms, or `PAIR_CLAIM_INVALID`;
2. an open window has the claim's `pid`, or `PAIR_WINDOW_CLOSED`;
3. the claim's `role` is the window's, or `PAIR_ROLE_MISMATCH`;
4. `transportSpkiSha256` is the SHA-256 of the SPKI of the client certificate on this connection, and `proof` equals the HMAC over the hub's own EKM of this connection, compared in constant time, or `PAIR_PROOF_INVALID`.

`verifyPairingClaim` makes checks 2 to 4 on a claim `readPairingClaim` has accepted (check 1). Each refusal of a claim whose `pid` names an open window counts one failure against it, and the third burns it. `PAIR_PROOF_INVALID` covers both halves of check 4, so a claimant can't tell which failed.

The hub answers a claim that holds with 200 and `{deviceId, epoch, nh}`: the new device's ULID, the hub's current epoch, which its statements carry, and `nh`, 16 bytes the hub draws from a CSPRNG for this claim once it holds, in base64url (22 characters). It answers a refusal with 403 and `{code}`, one of `PAIR_WINDOW_CLOSED`, `PAIR_CLAIM_INVALID`, `PAIR_ROLE_MISMATCH` and `PAIR_PROOF_INVALID`. Both objects are strict (`PairingResult`, `PairingRefusal`). The hub answers and logs a refusal by its code alone, as its logs are content-free; a `PairingError`'s message counts the members it didn't expect rather than repeating names the sender chose.

**The reveal.** Once it holds the answer, the device sends `POST /pair/v1/reveal` on the same connection, with a JSON body of exactly these members:

| Field | Form | Meaning |
|---|---|---|
| `pid` | as in the claim | the window whose claim it opens |
| `nd` | base64url of 16 bytes, 22 characters | the nonce that claim's `c` commits to |

The hub checks a reveal in this order:

1. the body is at most 1,024 bytes of strict JSON with exactly these members in their forms, or `PAIR_REVEAL_INVALID`;
2. a claim on the window `pid` names held on this connection and awaits its reveal, and that window's `exp` hasn't passed by the hub's clock, or `PAIR_WINDOW_CLOSED`;
3. `SHA-256("draftyak/sas-commit/v1" ‖ nd)` equals that claim's `c`, or `PAIR_COMMITMENT_MISMATCH`.

`readPairingReveal` makes check 1, and `verifyPairingReveal` makes check 3 and check 2's comparison of `pid` against the claim the hub holds; the rest of check 2 is the hub's own state. Both readers count a body's bytes as received, before anything parses it, so non-ASCII text counts in UTF-8 bytes, not in characters or UTF-16 units. Once a reveal holds, the hub records the candidate (section 10) and answers 204 with no body; if it can't record it, or its epoch has changed since its answer, it answers `PAIR_WINDOW_CLOSED` instead and discards the claim. It answers a refusal with 403 and `{code}`, a `PairingRefusal` with one of these three codes.

The window's five minutes bound the claim and its reveal, with no second timeout: the device reveals as soon as it holds the answer. The claim that holds closes the window to claims, and the hub keeps it, with its `c`, its `nh` and its connection, for one reveal. The first reveal to reach check 3 ends the exchange, whether it holds or not, and so do `exp` and the end of that connection; a reveal refused at check 1 or 2 changes nothing and counts no failure. A claim whose reveal is refused, or that has none when its exchange ends, is discarded with its pending device: it gets no SAS, no pair-confirm review and no confirmation, and the owner opens a new window. A reveal that holds grants nothing: the device stays pending, with no capability, until it is confirmed (section 10). The window's clock and counter, the claims the hub keeps and these outcomes are the hub's (M4.5); the vectors cover checks 1 and 3 and the comparison of `pid`.

## 9. The SAS

Once a reveal holds, both screens show

```
sas = u32_be(SHA-256("draftyak/sas/v1" ‖ ekm ‖ nd ‖ nh)[0..4]) mod 1,000,000
```

as six digits with leading zeros (`pairingSas`): `"draftyak/sas/v1"` is those 15 ASCII bytes, `ekm` the 32 bytes of the claim's connection, and `nd` and `nh` their 16 bytes each, 79 bytes in all. The device computes it from its own EKM, its `nd` and the `nh` of the answer it held before revealing; the hub from its EKM of that connection, the revealed `nd` and its own `nh`. This supersedes M1.21's skeleton formula, `u32_be(SHA-256("draftyak/sas/v1" ‖ ekm)[0..4]) mod 1,000,000` (the S10 skeleton's `sas()`), with its acceptance and its kept numbers (`982166` and `006520`, for EKMs of zeros and of `0xff` bytes): nothing computes or accepts it, and M1b's Rust side replaces the skeleton's kept `sas()` test with this file's vectors.

The hub's SAS appears on its trusted surface and in the pending pair-confirm review that a current confirmed `approve` device fetches over L2, as the `sas` of the review's subject ([device-api-v1.md](device-api-v1.md)), so a remote approver can compare it with the candidate's screen. It appears nowhere else: never to the candidate, in a claim, an answer to a claim or a reveal, a status answer, the pairing code, events, browsers, agents or logs. The candidate computes its own; receiving `nh` isn't receiving the hub's SAS. A claim whose reveal didn't hold has no SAS, so no pair-confirm review of it exists.

What it shows: when the device's TLS connection ends at the hub, both ends hold the same EKM, `nd` and `nh` and show the same code, and a claim that none of the owner's devices made shows a code that none of them shows. It also holds against an active attacker who is the TLS server toward the device, after replacing the code's `hid` and `addr` on its way or with a stolen hub key, and who claims at the hub over its own connection. That attacker must commit to its own `nd` in its claim before the hub draws `nh`, and must send the device an `nh` before the device reveals its `nd`, which stays hidden behind the device's `c` until then. So when it makes its last choice, it knows at most one of the two codes, and they match by chance, one time in a million, once for each window, as a window takes one claim and a device reveals once for each code. Choosing its handshake values no longer helps either, as the device's code also depends on its `nd`. The owner's comparison of the hub ID at consent (step 3) still catches a replaced `hid` before anything connects.

**Names beside the code.** Neither name is vouched for: the claim's `name` is chosen by whoever claims, and the pairing code's hub `name` by whoever made the code, and either can imitate a code (`496984`, `Phone 496984`, or the same in fullwidth or Arabic-Indic digits). The attacker above can finish the device side first and then claim under a name that is the device's code, or put the hub's code in a forged code's `name`. So every screen shows the code on its own and labelled, taken only from `sas` or from its own computation, and shows a name apart from it as unverified text, never in the code's place or style.

## 10. Confirmation and record

- **Bootstrap**, once per hub: the first approver is confirmed on the hub's trusted surface, and `bootstrap_done` is persisted.
- Every later approver needs an existing approver's confirmation with the PIN, `pair-confirm.v1` in `approval-v1.md`, which names the claim's `transportSpkiSha256` and `signingKey` byte for byte and is signed only after the approver has compared the SAS on both screens. A CLI-only confirmation gives a read and draft device; mobile devices get read, draft and organize only in the MVP.
- **Zero-approver recovery** needs the recovery code and a 24-hour delay, with alerts on all surfaces and an audit entry. The CLI can't revoke the last approver unless recovery has started.
- The hub records the device (its id, role, name and both keys) and audits the pairing. Until it is confirmed, a claimed device has no capabilities.

## Sidecar auto-pairing

On the desktop, the supervisor sends the hub a 16-byte bootstrap secret from a CSPRNG in the stdin unlock frame, as M0.22's supervisor does (`bootstrapSecret`, 32 lower-case hex digits, sent first on every spawn). Both sides derive the bootstrap window's `pid` and `sec` from it, 16 bytes each, with HKDF-SHA-256 (RFC 5869), an empty salt and the info `draftyak/pair/v1/sidecar-pid` or `draftyak/pair/v1/sidecar-sec` (`sidecarWindowSecrets`). Until `bootstrap_done` is set, the hub opens a `device` window with them and shows no payload. The secret of each unlock frame replaces any unclaimed sidecar window, so after a restart the window is the one its frame gives; M0.22's supervisor sends the same secret to every spawn of one app launch. The window closes at the first claim that holds, after three failures, or once `bootstrap_done` is set. A sidecar claim that held and was then discarded (section 8) leaves that secret's window closed, and the app treats each bootstrap secret as one pairing code (section 7), so pairing again waits for the next app launch's secret.

The hub's ready frame reports its L2 port and its full SPKI hash. M0.22's ready frame, `{ready, l2Port, hubId}`, carries only the display ID, 64 bits of the hash, which is too short to pin, so M4 adds the 64-hex-digit hash beside it and changes the frame codec's kept test (`spikes/s05-desktop/tauri-app/src-tauri/tests/sidecar.rs`) to match, as an ADR 0007 follow-up. The app connects to `127.0.0.1:<l2Port>`, pins that hash as `hid`, claims exactly as in step 7, with the same proof, and reveals as in step 8. It becomes the first approve and admin device once the owner sets the PIN (bootstrap, step 10).

## Threats

From the plan's threat table (§9.2):

- **A device↔hub man in the middle.** The device pins `hid`, so while the code is intact, a proxy with another key fails at the handshake and a relay that only forwards bytes reads nothing. Someone who holds the code can claim over their own connection, but the hub binds each claim to that connection's client certificate and EKM (check 4), so the device's proof can't be moved to another connection, and a replayed proof fails, because every connection has its own EKM and a window accepts one claim. An attacker who replaced the code's `hid` and `addr`, or holds the hub's key, is the TLS server toward the device, but the commit-reveal exchange leaves it one chance in a million for each window to make the two SAS match (section 9); against a replaced `hid`, the owner's comparison of the hub ID at consent is a further defence.
- **An intercepted pairing code or link.** Whoever holds it can claim, but can't be confirmed without an approver, the PIN and a SAS that matches the owner's device. Because a window takes one claim, the owner's own device then gets `PAIR_WINDOW_CLOSED`. That code also answers a window that expired or was burned, so it doesn't prove that someone else claimed: the owner opens a new window, and no approver confirms a claim whose SAS none of their devices shows. The window lasts five minutes, and a link never pairs by itself.
- **A name that imitates the code.** The claim's `name` and the pairing code's hub `name` are chosen by whoever claims or made the code, and either can read as a SAS: an owner who compared a name with the other screen's code would confirm the attacker's keys. So every screen shows the code on its own and labelled, from `sas` or its own computation, and a name apart from it as unverified text, never in the code's place or style (section 9).

## The EKM parameters and ADR 0007

The owner's D11 decision (2026-10-17) let this draft start on M0.21's EKM result and ADR 0012 rather than wait for ADR 0007. ADR 0007, S5's final ADR after M0.23b and macOS run B1, can still change the EKM parameters, for instance if rustls and Node disagree on macOS or Linux. What would change:

- **The label or the context:** `EKM_LABEL` or the exporter call on each side (Node, rustls, Conscrypt) and section 6. The payload, the claim, the proof and SAS formulas and every vector case stay as they are, because the cases take the EKM as an input; only the `ekm` block of `proofs.json` changes.
- **The length:** `EKM_LENGTH`, and with it the proof's and the SAS's inputs; `proofs.json` and `claims.json` are regenerated with EKMs of the new length.
- **No equal exporter at all:** the proof needs another channel binding. RFC 9266's `tls-exporter` (label `EXPORTER-Channel-Binding`, no context, 32 bytes) changes only the label and the context, as above; anything weaker than an exporter would leave the SPKI pin and the SAS alone against a relay, which is the owner's decision.

Before the M1 gate such a change edits v1 in place. After it, it is a breaking change: `draftyak-pair:v2:` and `draftyak/pair/v2`, with the hub accepting the current and the previous major. M1b's both-ways vector check runs again after any of them.

## Vectors

`pnpm --filter @draftyak/protocol vectors` writes them from `packages/protocol/scripts/vectors/pairing.ts`, and `vectors --check` (part of `pnpm test`) fails on any drift:

- `vectors/pairing/proofs.json`: the EKM parameters; proofs with their HMAC input, valid or not, among them a claim's over `pubs ‖ c` and M1.21's without `c`; commitments with their input; SAS with their input and hash, with an EKM, `nd` and `nh` that differ so that reordering them changes the code, and one with leading zeros; hub IDs; the sidecar window's `pid` and `sec` from bootstrap secrets. Proof cases whose id starts with `skeleton` are the S10 transport skeleton's own `pair_proof()` numbers from its kept test (ADR 0012), so the TypeScript side is checked against them; its `sas()` numbers are superseded (section 9).
- `vectors/pairing/payloads.json`: codes decoded at a fixed instant, accepted with their payload and canonical JSON, or refused with their code: prefixes, the length limit at and over its boundary, encodings, the order of the checks, every field form, the address grammar and the display-name rules.
- `vectors/pairing/claims.json`: claims as the hub receives them, with the window and the connection it checks them against, and their outcome: accepted, a client certificate with another key, an EKM from another connection, another window's secret, swapped keys, a flipped proof bit, another commitment under the same proof, M1.21's proof and claim without `c`, refused forms, the size limit at and past its boundary (with a multibyte name too), and the skeleton's stand-in body, which isn't the wire form. Then reveals, each with the claim that held on its connection, that connection's EKM and the hub's `nh`, and their outcome: accepted with the SAS both screens show, another window's `pid`, an `nd` that doesn't open `c` (changed, another claim's, or against another claim), refused forms, and the size limit at and past its boundary (with a nonce in fullwidth letters too).

The EKMs and keys are synthetic and test-only; the keys are public keys made from fixed scalars, so the files hold no private key. M1b adds the Rust side and checks both ways; the SMS contract adds its `host:sms` cases from its own generator file under `scripts/vectors/pairing/`.
