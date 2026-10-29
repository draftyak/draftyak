import { createECDH, createHash, createPublicKey, type KeyObject } from "node:crypto";
import { sha256Hex } from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import {
	decodePairingPayload,
	displayHubId,
	EKM_LABEL,
	EKM_LENGTH,
	encodePairingPayload,
	MAX_CLAIM_BYTES,
	MAX_PAYLOAD_LENGTH,
	MAX_REVEAL_BYTES,
	makePairingClaim,
	PAIRING_PREFIX,
	type PairingClaim,
	type PairingConnection,
	type PairingDevice,
	PairingError,
	type PairingPayload,
	type PairingWindow,
	PID_LENGTH,
	pairingCommitment,
	pairingProof,
	pairingPubs,
	pairingSas,
	readPairingClaim,
	readPairingReveal,
	sidecarWindowSecrets,
	verifyPairingClaim,
	verifyPairingProof,
	verifyPairingReveal,
} from "../../src/pairing.ts";
import { fromBase64Url, toBase64Url } from "../../src/scalars.ts";
import { exportSpki } from "../../src/sign.ts";
import type { VectorFile } from "../vectors.ts";

const format = "draftyak.vectors.pairing.v1";
const now = 1792000000000;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text));
const run = (start: number, length: number): Uint8Array =>
	Uint8Array.from({ length }, (_, at) => (start + at) & 0xff);
const filled = (byte: number, length: number): Uint8Array => new Uint8Array(length).fill(byte);
// Each ASCII character as its fullwidth form, U+FF01 to U+FF5E, of three UTF-8 bytes.
const fullwidth = (text: string): string =>
	String.fromCodePoint(...[...text].map((char) => (char.codePointAt(0) ?? 0) + 0xfee0));

function check(what: string, actual: unknown, expected: unknown): void {
	if (actual !== expected) throw new Error(`pairing ${what}: ${String(actual)}, not ${expected}`);
}

// Non-ASCII text with trailing spaces, which strict JSON allows, to a size in UTF-8 bytes. It counts
// fewer UTF-16 units and code points, so one byte past a limit it is still within it in both.
function sized(body: string, size: number): string {
	const text = body.padEnd(body.length + size - utf8(body).length);
	check(`a body of ${size} bytes`, utf8(text).length, size);
	check(`a body of ${size} bytes in UTF-16 units`, text.length < size, true);
	return text;
}

// The S10 transport skeleton's own numbers (ADR 0012's kept test), which the TS side must give.
// Its sas() numbers belong to the superseded formula over the EKM alone.
const skeleton = {
	proof: "d9351b28b88772134dcbcaa57c493ae1cafff501908e530a1c9f4fe700a850f1",
	hubId: "DYK-ABAB-ABAB-ABAB-ABAB",
};

// A test-only public key from a fixed scalar, so no private key is recorded.
function publicKey(name: string, curve = "prime256v1", hash = "sha256"): KeyObject {
	const ecdh = createECDH(curve);
	ecdh.setPrivateKey(createHash(hash).update(`draftyak/vectors/pairing/${name}`).digest());
	const point = ecdh.getPublicKey();
	const half = (point.length - 1) / 2;
	const [x, y] = [1, 1 + half].map((at) => point.subarray(at, at + half).toString("base64url"));
	const crv = curve === "prime256v1" ? "P-256" : "P-384";
	return createPublicKey({ key: { kty: "EC", crv, x, y }, format: "jwk" });
}
const spkiOf = (name: string): string => exportSpki(publicKey(name));
const spkiSha256 = (spki: string): string => sha256Hex(fromBase64Url(spki) ?? new Uint8Array());

// The same bytes with an unused low bit of the last character set, which a lax decoder accepts.
function loose(encoded: string): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const text = `${encoded.slice(0, -1)}${alphabet[alphabet.indexOf(encoded.at(-1) ?? "") + 1]}`;
	const same = Buffer.from(text, "base64url").equals(Buffer.from(encoded, "base64url"));
	if (!same || fromBase64Url(text) !== undefined) throw new Error(`${encoded} has no loose form`);
	return text;
}

interface Fixture {
	readonly base: PairingPayload;
	readonly hubKey: string;
	readonly window: PairingWindow;
	readonly ekm: Uint8Array;
	readonly keys: Record<"device" | "other", { transportSpki: string; signingKey: string }>;
	readonly device: PairingDevice;
	// The device's nonce, another claim's, and the hub's nonce in its answer.
	readonly nd: Uint8Array;
	readonly otherNd: Uint8Array;
	readonly nh: Uint8Array;
}

const withCommitment = (pubs: Uint8Array, c: string): Uint8Array =>
	Buffer.concat([pubs, Buffer.from(c, "hex")]);

function proofs({ base, window, ekm, device, nd, otherNd, nh }: Fixture): VectorFile {
	const proofCase = (
		id: string,
		s: Uint8Array,
		e: Uint8Array,
		pubs: Uint8Array,
		at: { c?: string; proof?: string } = {},
	) => {
		const bound = at.c === undefined ? pubs : withCommitment(pubs, at.c);
		const presented = at.proof ?? hex(pairingProof(s, e, bound));
		const message = Buffer.concat([utf8("draftyak/pair/v1"), e, bound]);
		const valid = verifyPairingProof(s, e, bound, Buffer.from(presented, "hex"));
		const [secHex, ekmHex, pubsHex] = [s, e, pubs].map(hex);
		const committed = at.c === undefined ? {} : { cHex: at.c };
		const fields = { messageHex: hex(message), proofHex: presented, valid };
		return { id, secHex, ekmHex, pubsHex, ...committed, ...fields };
	};
	const commitmentCase = (id: string, n: Uint8Array) => {
		const message = Buffer.concat([utf8("draftyak/sas-commit/v1"), n]);
		return { id, ndHex: hex(n), messageHex: hex(message), c: pairingCommitment(n) };
	};
	const sasCase = (id: string, e: Uint8Array, n: Uint8Array, h: Uint8Array) => {
		const message = Buffer.concat([utf8("draftyak/sas/v1"), e, n, h]);
		const [ekmHex, ndHex, nhHex] = [e, n, h].map(hex);
		const digest = { messageHex: hex(message), sha256: sha256Hex(message) };
		return { id, ekmHex, ndHex, nhHex, ...digest, sas: pairingSas(e, n, h) };
	};
	const [one, two, pubs] = [filled(1, 16), filled(2, 32), utf8("pubs")];
	const sec = fromBase64Url(window.sec) ?? new Uint8Array();
	const devicePubs = pairingPubs(device.transportSpkiSha256, device.signingKey);
	const c = pairingCommitment(nd);
	const claimProof = hex(pairingProof(sec, ekm, withCommitment(devicePubs, c)));
	const cases = [
		proofCase("skeleton", one, two, pubs),
		proofCase("skeleton-other-ekm", one, filled(3, 32), pubs, { proof: skeleton.proof }),
		proofCase("skeleton-other-pubs", one, two, utf8("pubz"), { proof: skeleton.proof }),
		proofCase("skeleton-other-sec", filled(9, 16), two, pubs, { proof: skeleton.proof }),
		proofCase("skeleton-proof-truncated", one, two, pubs, { proof: skeleton.proof.slice(0, 62) }),
		proofCase("device-claim", sec, ekm, devicePubs, { c }),
		proofCase("device-claim-other-commitment", sec, ekm, devicePubs, {
			c: pairingCommitment(otherNd),
			proof: claimProof,
		}),
		// M1.21's proof, over pubs alone.
		proofCase("device-claim-proof-without-commitment", sec, ekm, devicePubs, {
			c,
			proof: hex(pairingProof(sec, ekm, devicePubs)),
		}),
	];
	check("skeleton proof", cases[0]?.proofHex, skeleton.proof);
	check("device claim proof", cases[5]?.proofHex, claimProof);
	const commitments = [
		commitmentCase("zeros", filled(0, 16)),
		commitmentCase("ones", filled(0xff, 16)),
		commitmentCase("device-claim", nd),
	];
	// The first hub nonce, counting up from zero, whose SAS with the claim's EKM and nd starts 00.
	const zeroLed = (() => {
		for (let count = 0; count < 100_000; count++) {
			const h = new Uint8Array(16);
			new DataView(h.buffer).setUint32(12, count);
			if (pairingSas(ekm, nd, h).startsWith("00")) return h;
		}
		throw new Error("pairing SAS: no hub nonce gives a leading zero pair");
	})();
	const sas = [
		sasCase("zeros", filled(0, 32), filled(0, 16), filled(0, 16)),
		sasCase("ones", filled(0xff, 32), filled(0xff, 16), filled(0xff, 16)),
		sasCase("device-claim", ekm, nd, nh),
		sasCase("leading-zeros", ekm, nd, zeroLed),
	];
	const hubIds = [
		{ id: "skeleton", hid: "ab".repeat(32), display: displayHubId("ab".repeat(32)) },
		{ id: "payload-hub", hid: base.hid, display: displayHubId(base.hid) },
	];
	check("skeleton hub ID", hubIds[0]?.display, skeleton.hubId);
	const sidecar = Object.entries({ zeros: filled(0, 16), run: run(0x10, 16) }).map(
		([id, secret]) => ({ id, bootstrapSecretHex: hex(secret), ...sidecarWindowSecrets(secret) }),
	);
	const description =
		'The proof, the commitment, the SAS, the hub ID display and the sidecar window. "ekm" ' +
		"gives the exporter's parameters: its label, a context of the 16 raw pid bytes, and its " +
		"length; the EKMs below are synthetic, since only a live TLS connection gives a real one. " +
		'A proof case\'s "messageHex" is the ASCII of draftyak/pair/v1 followed by "ekmHex", ' +
		'"pubsHex" and, in a claim\'s case, the 32 bytes of the commitment "cHex"; "valid" says ' +
		'whether the presented "proofHex" equals HMAC-SHA-256 keyed with "secHex" over that ' +
		'message (lengths first, then in constant time). A commitment case\'s "c" is the SHA-256 ' +
		'of its "messageHex", the ASCII of draftyak/sas-commit/v1 followed by "ndHex". A SAS ' +
		'case\'s "sha256" is the SHA-256 of its "messageHex", the ASCII of draftyak/sas/v1 ' +
		'followed by "ekmHex", "ndHex" and "nhHex", and "sas" is the big-endian u32 of its first ' +
		'4 bytes mod 1,000,000, as six digits with leading zeros. A hub ID\'s "display" is DYK- ' +
		'and the first 16 hex digits of "hid" in upper case, in groups of four. A sidecar case\'s ' +
		'"pid" and "sec" are base64url of 16 bytes of HKDF-SHA-256 over "bootstrapSecretHex" ' +
		"with an empty salt and the info draftyak/pair/v1/sidecar-pid or " +
		"draftyak/pair/v1/sidecar-sec. Ids starting with skeleton are the S10 transport " +
		"skeleton's own numbers (ADR 0012's kept test).";
	const parameters = { label: EKM_LABEL, contextBytes: PID_LENGTH, length: EKM_LENGTH };
	const content = { format, description, ekm: parameters, proofs: cases, commitments, sas };
	return { path: "pairing/proofs.json", content: { ...content, hubIds, sidecar } };
}

const badAddresses: readonly [string, string][] = [
	["scheme", "https://127.0.0.1:47614"],
	["no-port", "127.0.0.1"],
	["port-zero", "127.0.0.1:0"],
	["port-65536", "127.0.0.1:65536"],
	["port-leading-zero", "127.0.0.1:047614"],
	["port-leading-zero-short", "hub.home.arpa:080"],
	["ipv4-leading-zero", "192.168.001.20:47614"],
	["ipv4-leading-zero-short", "10.0.01.1:47614"],
	["ipv4-octet-256", "192.168.1.256:47614"],
	["ipv4-unspecified", "0.0.0.0:47614"],
	["ipv4-this-network", "0.1.2.3:47614"],
	["ipv4-multicast", "224.0.0.251:47614"],
	["ipv4-broadcast", "255.255.255.255:47614"],
	["ipv6-unbracketed", "fd7a:115c:a1e0::1:47614"],
	["ipv6-zone", "[fe80::1%25eth0]:47614"],
	["ipv6-upper-case", "[FD7A:115C:A1E0::1]:47614"],
	["ipv6-embedded-ipv4", "[::ffff:192.0.2.1]:47614"],
	["ipv6-five-digit-group", "[12345::1]:47614"],
	["ipv6-eight-groups-and-elision", "[1:2:3:4:5:6:7:8::]:47614"],
	["ipv6-two-elisions", "[1::2::3]:47614"],
	["ipv6-unspecified", "[::]:47614"],
	["ipv6-unspecified-in-full", "[0:0:0:0:0:0:0:0]:47614"],
	["ipv6-multicast", "[ff02::1]:47614"],
	["name-upper-case", "Hub.home.arpa:47614"],
	["name-trailing-dot", "hub.home.arpa.:47614"],
	["name-numeric-last-label", "hub.123:47614"],
	["name-hex-number", "0x7f000001:47614"],
	["name-hex-last-label", "a.0x1:47614"],
	["name-0x-last-label", "hub.0x:47614"],
	["name-leading-hyphen", "-hub.home.arpa:47614"],
	["name-trailing-hyphen", "hub-.home.arpa:47614"],
	["name-64-character-label", `${"a".repeat(64)}.example:47614`],
	["name-254-characters", `${"a.".repeat(126)}ab:47614`],
	["userinfo", "owner@hub.home.arpa:47614"],
	["path", "hub.home.arpa:47614/pair"],
];

const badNames: readonly [string, string][] = [
	["empty", ""],
	["65-characters", "a".repeat(65)],
	["leading-space", " Office hub"],
	["trailing-space", "Office hub "],
	["leading-no-break-space", "\u{a0}Office hub"],
	["trailing-ideographic-space", "Office hub\u{3000}"],
	["trailing-braille-blank", "Office hub\u{2800}"],
	["only-joiners", "\u{200d}\u{200c}"],
	["only-a-variation-selector", "\u{fe0f}"],
	["line-feed", "Office\nhub"],
	["c1-control", "Office\u{85}hub"],
	["bidi-override", "Office \u{202e}buh"],
	["bidi-isolate", "Office \u{2067}hub"],
	["zero-width-space", "Office\u{200b}hub"],
	["byte-order-mark", "\u{feff}Office hub"],
	["soft-hyphen", "Off\u{ad}ice hub"],
	["combining-grapheme-joiner", "Off\u{34f}ice hub"],
	["khmer-inherent-vowel", "Office\u{17b4}hub"],
	["hangul-filler", "Office\u{3164}hub"],
	["ignorable-unassigned", "Office\u{fff0}hub"],
	["shorthand-format-control", "Office\u{1bca0}hub"],
	["musical-beam", "Office\u{1d173}hub"],
	["tag-character", "Office hub\u{e0041}"],
	["ignorable-after-the-tags", "Office hub\u{e0080}"],
	["ignorable-after-the-selectors", "Office hub\u{e01f0}"],
];

function payloads({ base, hubKey }: Fixture): VectorFile {
	const accepted = (id: string, fields: Partial<PairingPayload>) => {
		const payload = { ...base, ...fields };
		const text = encodePairingPayload(payload);
		const json = canonicalize(payload);
		check(`payload ${id}`, canonicalize(decodePairingPayload(text, now)), json);
		return { id, text, payload, json, hubId: displayHubId(payload.hid) };
	};
	const refused = (id: string, text: string, error: string) => {
		try {
			decodePairingPayload(text, now);
		} catch (thrown) {
			if (!(thrown instanceof PairingError)) throw thrown;
			check(`payload ${id}`, thrown.code, error);
			return { id, text, error };
		}
		throw new Error(`pairing payload ${id}: accepted`);
	};
	const coded = (json: string | Uint8Array): string =>
		`${PAIRING_PREFIX}${toBase64Url(typeof json === "string" ? utf8(json) : json)}`;
	const changed = (fields: object): string => coded(canonicalize({ ...base, ...fields }));
	// A canonical code of exactly `length` characters, with one member too many.
	const padded = (length: number): string => {
		for (let size = 0; size < length; size++) {
			const text = changed({ pad: "x".repeat(size) });
			if (text.length === length) return text;
		}
		throw new Error(`pairing payload: no padded code of ${length} characters`);
	};
	const valid = encodePairingPayload(base);
	const body = valid.slice(PAIRING_PREFIX.length);
	const unaligned = ["", "!", "!!"]
		.map((mark) => encodePairingPayload({ ...base, name: `${base.name}${mark}` }))
		.map((text) => text.slice(PAIRING_PREFIX.length))
		.find((encoded) => encoded.length % 4 !== 0);
	const json = canonicalize(base);
	const at = json.indexOf("Office");
	const { name: _, ...unnamed } = base;
	const lan = ["192.168.1.20:47614", "[fd7a:115c:a1e0::1]:47614", "hub.home.arpa:47614"];
	const eight = Array.from({ length: 8 }, (_, n) => `10.0.0.${n + 1}:47614`);
	const ipEdges = [
		"1.0.0.0:1",
		"223.255.255.255:65535",
		"[::1]:47614",
		"[1:2:3:4:5:6:7:8]:47614",
		"[fe80::]:47614",
		"[ff::1]:47614",
	];
	const nameEdges = [
		"localhost:47614",
		"xn--bcher-kva.example:47614",
		"x0.0xg:47614",
		`${"a".repeat(63)}.example:47614`,
		`${"a.".repeat(125)}abc:47614`,
	];
	const [encoding, invalid] = ["PAIR_ENCODING", "PAIR_PAYLOAD_INVALID"];
	const cases = [
		accepted("loopback", {}),
		accepted("lan-tailnet-and-name", { addr: lan }),
		accepted("eight-addresses", { addr: eight }),
		accepted("address-edges", { addr: ipEdges }),
		accepted("address-name-edges", { addr: nameEdges }),
		accepted("unicode-name", { name: "B\u{fc}ro \u{6771}\u{4eac} \u{1f3e0}" }),
		accepted("name-with-joiners", {
			name: "\u{1f469}\u{200d}\u{1f4bb} \u{645}\u{6cc}\u{200c}\u{634}\u{648}\u{62f}",
		}),
		accepted("name-with-inner-blanks-and-a-selector", { name: "Office\u{a0}hub \u{2764}\u{fe0f}" }),
		accepted("name-64-astral-characters", { name: "\u{1f3e0}".repeat(64) }),
		accepted("expires-now", { exp: now }),
		accepted("exp-largest", { exp: Number.MAX_SAFE_INTEGER }),
		refused("prefix-v2", `draftyak-pair:v2:${body}`, "PAIR_PREFIX"),
		refused("prefix-upper-case", `DRAFTYAK-PAIR:v1:${body}`, "PAIR_PREFIX"),
		refused("prefix-missing", body, "PAIR_PREFIX"),
		refused("prefix-leading-space", ` ${valid}`, "PAIR_PREFIX"),
		refused("link-not-payload", `draftyak://pair#${valid}`, "PAIR_PREFIX"),
		refused("empty", "", "PAIR_PREFIX"),
		refused("base64-empty", PAIRING_PREFIX, encoding),
		refused("base64-padded", `${valid}==`, encoding),
		refused("base64-plus", `${valid.slice(0, 30)}+${valid.slice(31)}`, encoding),
		refused("base64-trailing-line-feed", `${valid}\n`, encoding),
		refused("base64-loose-last-character", `${PAIRING_PREFIX}${loose(unaligned ?? "")}`, encoding),
		refused("length-limit", padded(MAX_PAYLOAD_LENGTH), invalid),
		refused("length-over-the-limit", padded(MAX_PAYLOAD_LENGTH + 1), encoding),
		refused("json-space", coded(json.replace(",", ", ")), encoding),
		refused(
			"json-space-and-extra-field",
			coded(canonicalize({ ...base, v: 1 }).replace(",", ", ")),
			encoding,
		),
		refused("json-members-in-other-order", coded(JSON.stringify(base)), encoding),
		refused("json-duplicate-member", coded(json.replace("{", '{"addr":[],')), encoding),
		refused("json-escaped-letter", coded(json.replace("Office", "\\u004ffice")), encoding),
		refused("json-exponent", coded(json.replace(`${base.exp}`, "1.7920003e12")), encoding),
		refused("json-lone-surrogate", coded(json.replace("Office", "\\ud800ffice")), encoding),
		refused(
			"json-byte-order-mark",
			coded(Buffer.concat([Uint8Array.of(0xef, 0xbb, 0xbf), utf8(json)])),
			encoding,
		),
		refused(
			"json-invalid-utf8",
			coded(Buffer.concat([utf8(json.slice(0, at)), Uint8Array.of(0xff), utf8(json.slice(at))])),
			encoding,
		),
		refused("not-an-object", coded("[]"), invalid),
		refused("extra-field", changed({ v: 1 }), invalid),
		refused("missing-name", coded(canonicalize(unnamed)), invalid),
		refused("role-unknown", changed({ role: "admin" }), invalid),
		refused("role-upper-case", changed({ role: "Device" }), invalid),
		refused("hid-upper-case", changed({ hid: base.hid.toUpperCase() }), invalid),
		refused("hid-short", changed({ hid: base.hid.slice(2) }), invalid),
		refused("pid-15-bytes", changed({ pid: toBase64Url(run(0, 15)) }), invalid),
		refused("pid-17-bytes", changed({ pid: toBase64Url(run(0, 17)) }), invalid),
		refused("pid-loose-encoding", changed({ pid: loose(base.pid) }), invalid),
		refused("sec-15-bytes", changed({ sec: toBase64Url(run(0xa0, 15)) }), invalid),
		refused("exp-fraction", changed({ exp: now + 0.5 }), invalid),
		refused("exp-negative", changed({ exp: -1 }), invalid),
		refused("exp-beyond-safe-integers", changed({ exp: 2 ** 53 }), invalid),
		refused("exp-string", changed({ exp: String(base.exp) }), invalid),
		refused("addr-empty", changed({ addr: [] }), invalid),
		refused("addr-nine", changed({ addr: [...eight, "10.0.0.9:47614"] }), invalid),
		refused("addr-repeated", changed({ addr: [...base.addr, ...base.addr] }), invalid),
		refused("addr-not-a-list", changed({ addr: base.addr[0] }), invalid),
		...badAddresses.map(([id, addr]) => refused(`addr-${id}`, changed({ addr: [addr] }), invalid)),
		...badNames.map(([id, name]) => refused(`name-${id}`, changed({ name }), invalid)),
		refused("expired", changed({ exp: now - 1 }), "PAIR_EXPIRED"),
		refused("expired-with-extra-field", changed({ exp: now - 1, v: 1 }), invalid),
	];
	const description =
		"Pairing payloads: draftyak-pair:v1: followed by the unpadded, canonical base64url of the " +
		'payload\'s canonical JSON. Each case decodes "text" at the instant "now" (UTC ms). An ' +
		'accepted case gives "payload" and its canonical JSON "json", encoding "payload" gives ' +
		'"text" back, and "hubId" is how the device shows hid. A case with "error" is refused with ' +
		"that code, from the first check that fails: PAIR_PREFIX (the text doesn't start with the " +
		"exact prefix), PAIR_ENCODING (over 1000 characters, prefix included, not canonical " +
		"base64url, or not the canonical JSON of a value: invalid UTF-8, a lone surrogate, a " +
		"byte-order mark, a duplicate member or any other spelling), PAIR_PAYLOAD_INVALID (not " +
		"exactly the fields hid, addr, pid, sec, exp, name and role in their forms) and " +
		"PAIR_EXPIRED (exp before now). So a code that fails two checks gets the first one's code. " +
		'"hubKey" is the test-only P-256 key whose SPKI hash is the cases\' hid.';
	const key = { testOnly: true, publicKeySpki: hubKey };
	return {
		path: "pairing/payloads.json",
		content: { format, description, now, hubKey: key, cases },
	};
}

function claims({ window, ekm, keys, device, nd, otherNd, nh }: Fixture): VectorFile {
	const connection: PairingConnection = { ekm, clientSpkiSha256: device.transportSpkiSha256 };
	const honest = makePairingClaim(window, device, ekm, nd);
	const pubs = pairingPubs(device.transportSpkiSha256, device.signingKey);
	const claimCase = (
		id: string,
		claim: object | string,
		expected: string,
		at: { connection?: PairingConnection; extra?: object } = {},
	) => {
		const body = typeof claim === "string" ? claim : canonicalize(claim);
		const live = at.connection ?? connection;
		let outcome: string;
		try {
			outcome = verifyPairingClaim(readPairingClaim(body), window, live) ?? "accepted";
		} catch (thrown) {
			if (!(thrown instanceof PairingError)) throw thrown;
			outcome = thrown.code;
		}
		check(`claim ${id}`, outcome, expected);
		const seen = { ekmHex: hex(live.ekm), clientSpkiSha256: live.clientSpkiSha256 };
		return { id, window, connection: seen, body, outcome, ...at.extra };
	};
	const otherTransport = spkiSha256(keys.other.transportSpki);
	const otherClient = { connection: { ekm, clientSpkiSha256: otherTransport } };
	const otherEkm = run(0x80, 32);
	const der = fromBase64Url(device.signingKey) ?? new Uint8Array();
	const head = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");
	const parity = Uint8Array.of(2 + ((der.at(-1) ?? 0) & 1));
	const compressed = toBase64Url(Buffer.concat([head, parity, der.subarray(27, 59)]));
	const p384 = publicKey("p384", "secp384r1", "sha384").export({ type: "spki", format: "der" });
	const flipped = `${honest.proof.slice(0, -1)}${honest.proof.endsWith("0") ? "1" : "0"}`;
	const [proofInvalid, invalid] = ["PAIR_PROOF_INVALID", "PAIR_CLAIM_INVALID"];
	const reordered = JSON.stringify(Object.fromEntries(Object.entries(honest).toReversed()));
	const otherSec = { ...window, sec: toBase64Url(run(0xb0, 16)) };
	const otherPid = { ...window, pid: toBase64Url(run(0x10, 16)) };
	const sec = fromBase64Url(window.sec) ?? new Uint8Array();
	// M1.21's proof, over pubs alone, and its claim, which had no commitment.
	const keysOnly = hex(pairingProof(sec, ekm, pubs));
	const { c: _, ...uncommitted } = honest;
	// A name with characters of two, three and four UTF-8 bytes.
	const named = { ...device, name: "Zo\u00eb\u2019s laptop \u{1f4bb}" };
	const multibyte = canonicalize(makePairingClaim(window, named, ekm, nd));
	const cases = [
		claimCase("device", honest, "accepted", { extra: { pubsHex: hex(pubs) } }),
		claimCase("device-members-in-other-order", reordered, "accepted"),
		claimCase("client-certificate-of-another-key", honest, proofInvalid, otherClient),
		claimCase(
			"transport-hash-of-the-client",
			{ ...honest, transportSpkiSha256: otherTransport },
			proofInvalid,
			otherClient,
		),
		claimCase(
			"ekm-of-another-connection",
			makePairingClaim(window, device, otherEkm, nd),
			proofInvalid,
		),
		claimCase(
			"secret-of-another-window",
			makePairingClaim(otherSec, device, ekm, nd),
			proofInvalid,
		),
		claimCase(
			"signing-key-swapped",
			{ ...honest, signingKey: keys.other.signingKey },
			proofInvalid,
		),
		claimCase("proof-bit-flipped", { ...honest, proof: flipped }, proofInvalid),
		claimCase(
			"commitment-of-another-nonce",
			{ ...honest, c: pairingCommitment(otherNd) },
			proofInvalid,
		),
		claimCase("proof-without-commitment", { ...honest, proof: keysOnly }, proofInvalid),
		claimCase(
			"pid-of-another-window",
			makePairingClaim(otherPid, device, ekm, nd),
			"PAIR_WINDOW_CLOSED",
		),
		claimCase("commitment-missing", uncommitted, invalid),
		claimCase("superseded-claim", { ...uncommitted, proof: keysOnly }, invalid),
		claimCase("commitment-upper-case", { ...honest, c: honest.c.toUpperCase() }, invalid),
		claimCase("commitment-31-bytes", { ...honest, c: honest.c.slice(2) }, invalid),
		claimCase(
			"commitment-base64url",
			{ ...honest, c: toBase64Url(Buffer.from(honest.c, "hex")) },
			invalid,
		),
		claimCase("commitment-null", { ...honest, c: null }, invalid),
		claimCase("nonce-in-the-claim", { ...honest, nd: toBase64Url(nd) }, invalid),
		claimCase("sas-in-the-claim", { ...honest, sas: pairingSas(ekm, nd, nh) }, invalid),
		claimCase("proof-upper-case", { ...honest, proof: honest.proof.toUpperCase() }, invalid),
		claimCase("proof-31-bytes", { ...honest, proof: honest.proof.slice(2) }, invalid),
		claimCase("signing-key-compressed-point", { ...honest, signingKey: compressed }, invalid),
		claimCase("signing-key-p384", { ...honest, signingKey: toBase64Url(p384) }, invalid),
		claimCase(
			"transport-hash-upper-case",
			{ ...honest, transportSpkiSha256: device.transportSpkiSha256.toUpperCase() },
			invalid,
		),
		claimCase("role-unknown", { ...honest, role: "admin" }, invalid),
		claimCase("name-bidi-override", { ...honest, name: "Work \u{202e}potpal" }, invalid),
		claimCase("capabilities-asked-for", { ...honest, capabilities: ["approve"] }, invalid),
		claimCase("duplicate-member", canonicalize(honest).replace("{", '{"name":"Other",'), invalid),
		claimCase("skeleton-stand-in-body", `${hex(pubs)}.${honest.proof}`, invalid),
		// The ASCII claim with trailing spaces, which strict JSON allows, to the limit and past it.
		claimCase("at-4096-bytes", canonicalize(honest).padEnd(MAX_CLAIM_BYTES), "accepted"),
		claimCase("over-4096-bytes", canonicalize(honest).padEnd(MAX_CLAIM_BYTES + 1), invalid),
		// Again with the multibyte name, padded in UTF-8 bytes.
		claimCase("multibyte-name-at-4096-bytes", sized(multibyte, MAX_CLAIM_BYTES), "accepted"),
		claimCase("multibyte-name-over-4096-bytes", sized(multibyte, MAX_CLAIM_BYTES + 1), invalid),
	];
	const revealCase = (
		id: string,
		body: string,
		expected: string,
		at: { claim?: PairingClaim; shown?: boolean } = {},
	) => {
		const claim = at.claim ?? honest;
		let outcome: string;
		try {
			outcome = verifyPairingReveal(readPairingReveal(body), claim) ?? "accepted";
		} catch (thrown) {
			if (!(thrown instanceof PairingError)) throw thrown;
			outcome = thrown.code;
		}
		check(`reveal ${id}`, outcome, expected);
		const shown = at.shown === true ? { sas: pairingSas(ekm, nd, nh) } : {};
		return {
			id,
			claim: canonicalize(claim),
			ekmHex: hex(ekm),
			nh: toBase64Url(nh),
			body,
			outcome,
			...shown,
		};
	};
	const honestNd = toBase64Url(nd);
	const reveal = (fields: object): string =>
		canonicalize({ pid: window.pid, nd: honestNd, ...fields });
	const ndFlipped = Uint8Array.from(nd, (byte, at) => (at === nd.length - 1 ? byte ^ 0x80 : byte));
	const wide = reveal({ nd: fullwidth(honestNd) });
	const [revealInvalid, mismatch] = ["PAIR_REVEAL_INVALID", "PAIR_COMMITMENT_MISMATCH"];
	const reveals = [
		revealCase("device", reveal({}), "accepted", { shown: true }),
		revealCase(
			"device-members-in-other-order-with-whitespace",
			` { "pid" : "${window.pid}" , "nd" : "${honestNd}" } `,
			"accepted",
			{ shown: true },
		),
		// Trailing spaces again, to the limit and past it.
		revealCase("at-1024-bytes", reveal({}).padEnd(MAX_REVEAL_BYTES), "accepted", { shown: true }),
		revealCase("over-1024-bytes", reveal({}).padEnd(MAX_REVEAL_BYTES + 1), revealInvalid),
		// No member of a reveal can hold non-ASCII, so a nonce in fullwidth letters stands in: refused
		// by its form at the limit, once its size has passed, and by its size past it.
		revealCase("fullwidth-nonce-at-1024-bytes", sized(wide, MAX_REVEAL_BYTES), revealInvalid),
		revealCase("fullwidth-nonce-over-1024-bytes", sized(wide, MAX_REVEAL_BYTES + 1), revealInvalid),
		revealCase("pid-of-another-window", reveal({ pid: otherPid.pid }), "PAIR_WINDOW_CLOSED"),
		// The window is checked before the commitment.
		revealCase(
			"pid-of-another-window-and-nonce-of-another-claim",
			reveal({ pid: otherPid.pid, nd: toBase64Url(otherNd) }),
			"PAIR_WINDOW_CLOSED",
		),
		revealCase("nonce-bit-flipped", reveal({ nd: toBase64Url(ndFlipped) }), mismatch),
		revealCase("nonce-of-another-claim", reveal({ nd: toBase64Url(otherNd) }), mismatch),
		revealCase("claim-of-another-nonce", reveal({}), mismatch, {
			claim: makePairingClaim(window, device, ekm, otherNd),
		}),
		revealCase(
			"commitment-as-nonce",
			reveal({ nd: toBase64Url(Buffer.from(honest.c, "hex")) }),
			revealInvalid,
		),
		revealCase("commitment-hex-as-nonce", reveal({ nd: honest.c }), revealInvalid),
		revealCase("nonce-15-bytes", reveal({ nd: toBase64Url(nd.subarray(0, 15)) }), revealInvalid),
		revealCase(
			"nonce-17-bytes",
			reveal({ nd: toBase64Url(Buffer.concat([nd, Uint8Array.of(0)])) }),
			revealInvalid,
		),
		revealCase("nonce-loose-encoding", reveal({ nd: loose(honestNd) }), revealInvalid),
		revealCase("nonce-padded", reveal({ nd: `${honestNd}==` }), revealInvalid),
		revealCase("nonce-hex", reveal({ nd: hex(nd) }), revealInvalid),
		revealCase("nonce-null", reveal({ nd: null }), revealInvalid),
		revealCase("nonce-missing", canonicalize({ pid: window.pid }), revealInvalid),
		revealCase("pid-missing", canonicalize({ nd: honestNd }), revealInvalid),
		revealCase("pid-loose-encoding", reveal({ pid: loose(window.pid) }), revealInvalid),
		revealCase("hub-nonce-echoed", reveal({ nh: toBase64Url(nh) }), revealInvalid),
		revealCase("sas-in-the-reveal", reveal({ sas: pairingSas(ekm, nd, nh) }), revealInvalid),
		revealCase(
			"duplicate-member",
			reveal({}).replace("{", `{"nd":"${toBase64Url(otherNd)}",`),
			revealInvalid,
		),
		revealCase("not-an-object", JSON.stringify([window.pid, honestNd]), revealInvalid),
		revealCase("not-json", `pid=${window.pid}&nd=${honestNd}`, revealInvalid),
		revealCase("empty", "", revealInvalid),
	];
	const description =
		"Pairing claims and reveals as the hub checks them. Each claim case gives the window the " +
		"hub holds, the live connection (its EKM, synthetic here, and the SHA-256 of the client " +
		'certificate\'s SPKI) and the claim body as received. "outcome" is accepted or the refusal ' +
		"code, from the first check that fails: PAIR_CLAIM_INVALID (over 4096 bytes, not strict " +
		"JSON, or not exactly the fields pid, role, name, transportSpkiSha256, signingKey, c and " +
		"proof in their forms), PAIR_WINDOW_CLOSED (the claim's pid isn't the window's), " +
		"PAIR_ROLE_MISMATCH (its role isn't the window's) and PAIR_PROOF_INVALID " +
		"(transportSpkiSha256 isn't the client certificate's SPKI hash, or proof isn't the HMAC " +
		"over pubs, transportSpkiSha256's 32 bytes and then signingKey's 65-byte uncompressed " +
		'point, followed by the 32 bytes of c). "pubsHex" is what the accepted claim binds before ' +
		"c. Each reveal case gives the claim that held on the reveal's connection, as its body, the " +
		'EKM of that connection, the hub\'s nonce "nh" from its answer and the reveal body as ' +
		'received; "outcome" is accepted or the refusal code, from the first check that fails: ' +
		"PAIR_REVEAL_INVALID (over 1024 bytes, not strict JSON, or not exactly the fields pid and " +
		"nd, each base64url of 16 bytes), PAIR_WINDOW_CLOSED (its pid isn't the claim's) and " +
		"PAIR_COMMITMENT_MISMATCH (the SHA-256 of the ASCII of draftyak/sas-commit/v1 followed by " +
		"nd isn't the claim's c). A body's size is its UTF-8 bytes: one byte past its limit, a " +
		"multibyte-name or fullwidth-nonce body is still within it in UTF-16 units and in code " +
		'points. "sas" is what both screens show once a reveal holds. "keys" are test-only public ' +
		"keys.";
	const recorded = {
		device: { testOnly: true, ...keys.device },
		other: { testOnly: true, ...keys.other },
	};
	const content = { format, description, keys: recorded, cases, reveals };
	return { path: "pairing/claims.json", content };
}

export function generate(): VectorFile[] {
	const hubKey = spkiOf("hub");
	const base: PairingPayload = {
		hid: spkiSha256(hubKey),
		addr: ["127.0.0.1:47614"],
		pid: toBase64Url(run(0x00, 16)),
		sec: toBase64Url(run(0xa0, 16)),
		exp: now + 300_000,
		name: "Office hub",
		role: "device",
	};
	const keys = {
		device: { transportSpki: spkiOf("device-transport"), signingKey: spkiOf("device-signing") },
		other: { transportSpki: spkiOf("other-transport"), signingKey: spkiOf("other-signing") },
	};
	const device: PairingDevice = {
		name: "Work laptop",
		transportSpkiSha256: spkiSha256(keys.device.transportSpki),
		signingKey: keys.device.signingKey,
	};
	const window: PairingWindow = { pid: base.pid, role: base.role, sec: base.sec };
	// The EKM and the nonces are distinct runs, so reordering them changes every hash input.
	const nonces = { nd: run(0x60, 16), otherNd: run(0xc0, 16), nh: run(0x70, 16) };
	const fixture: Fixture = { base, hubKey, window, ekm: run(0x40, 32), keys, device, ...nonces };
	return [proofs(fixture), payloads(fixture), claims(fixture)];
}
