import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";
import { type Schema, Validator } from "@cfworker/json-schema";
import fc from "fast-check";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { pairFixture } from "../scripts/vectors/device-api/cases.ts";
import {
	DeviceStatus,
	OperationReview,
	PairConfirmSubject,
	routeAllows,
} from "../src/device-api.ts";
import { CONFIRMATION_PRESETS } from "../src/entities/device.ts";
import * as index from "../src/index.ts";
import * as jcs from "../src/jcs.ts";
import * as pairing from "../src/pairing.ts";
import {
	decodePairingPayload,
	displayHubId,
	EKM_LABEL,
	EKM_LENGTH,
	encodePairingPayload,
	type KeyingMaterialExporter,
	MAX_CLAIM_BYTES,
	MAX_PAYLOAD_LENGTH,
	MAX_REVEAL_BYTES,
	makePairingClaim,
	NONCE_LENGTH,
	PAIRING_PREFIX,
	type PairingConnection,
	type PairingDevice,
	PairingPayload,
	PairingRefusal,
	PairingResult,
	PairingReveal,
	PairingRole,
	PairingSas,
	type PairingWindow,
	PID_LENGTH,
	pairingCommitment,
	pairingEkm,
	pairingProof,
	pairingPubs,
	pairingSas,
	readPairingClaim,
	readPairingReveal,
	SEC_LENGTH,
	sidecarWindowSecrets,
	verifyPairingClaim,
	verifyPairingProof,
	verifyPairingReveal,
} from "../src/pairing.ts";
import { fromBase64Url, toBase64Url } from "../src/scalars.ts";
import { hex, outcome, utf8, vectorFiles } from "./vectors.ts";

const { canonicalize, isCanonical } = jcs;

interface ProofCase {
	readonly id: string;
	readonly secHex: string;
	readonly ekmHex: string;
	readonly pubsHex: string;
	readonly cHex?: string;
	readonly messageHex: string;
	readonly proofHex: string;
	readonly valid: boolean;
}
interface CommitmentCase {
	readonly id: string;
	readonly ndHex: string;
	readonly messageHex: string;
	readonly c: string;
}
interface SasCase {
	readonly id: string;
	readonly ekmHex: string;
	readonly ndHex: string;
	readonly nhHex: string;
	readonly messageHex: string;
	readonly sha256: string;
	readonly sas: string;
}
interface SidecarCase {
	readonly id: string;
	readonly bootstrapSecretHex: string;
	readonly pid: string;
	readonly sec: string;
}
interface ProofVectors {
	readonly format: string;
	readonly ekm: { readonly label: string; readonly contextBytes: number; readonly length: number };
	readonly proofs: ProofCase[];
	readonly commitments: CommitmentCase[];
	readonly sas: SasCase[];
	readonly hubIds: { readonly id: string; readonly hid: string; readonly display: string }[];
	readonly sidecar: SidecarCase[];
}
interface PayloadCase {
	readonly id: string;
	readonly text: string;
	readonly payload?: PairingPayload;
	readonly json?: string;
	readonly hubId?: string;
	readonly error?: string;
}
interface PayloadVectors {
	readonly format: string;
	readonly now: number;
	readonly hubKey: { readonly testOnly: boolean; readonly publicKeySpki: string };
	readonly cases: PayloadCase[];
}
interface ClaimCase {
	readonly id: string;
	readonly window: PairingWindow;
	readonly connection: { readonly ekmHex: string; readonly clientSpkiSha256: string };
	readonly body: string;
	readonly outcome: string;
	readonly pubsHex?: string;
}
interface RevealCase {
	readonly id: string;
	readonly claim: string;
	readonly ekmHex: string;
	readonly nh: string;
	readonly body: string;
	readonly outcome: string;
	readonly sas?: string;
}
interface TestKeys {
	readonly testOnly: boolean;
	readonly transportSpki: string;
	readonly signingKey: string;
}
interface ClaimVectors {
	readonly format: string;
	readonly keys: { readonly device: TestKeys; readonly other: TestKeys };
	readonly cases: ClaimCase[];
	readonly reveals: RevealCase[];
}

const files = new Map(vectorFiles<unknown>("pairing"));
function vectorFile<T>(name: string): T {
	const content = files.get(name);
	if (content === undefined) throw new Error(`spec/vectors/pairing/${name} is missing`);
	return content as T;
}
const proofs = vectorFile<ProofVectors>("proofs.json");
const payloads = vectorFile<PayloadVectors>("payloads.json");
const claims = vectorFile<ClaimVectors>("claims.json");

const now = payloads.now;
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "hex"));
const spkiSha256 = (spki: string): string =>
	createHash("sha256")
		.update(fromBase64Url(spki) ?? new Uint8Array())
		.digest("hex");
const find = <T extends { readonly id: string }>(list: readonly T[], id: string): T => {
	const item = list.find((each) => each.id === id);
	if (item === undefined) throw new Error(`no vector case ${id}`);
	return item;
};
// SHA-256 over a label and its parts, and the six digits of a SAS from that digest, restated with
// node:crypto alone.
const digestOf = (label: string, ...parts: Uint8Array[]): Buffer =>
	parts.reduce((hash, part) => hash.update(part), createHash("sha256").update(label)).digest();
const codeOf = (digest: Buffer): string =>
	String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
const base: PairingPayload = (() => {
	const loopback = payloads.cases.find((item) => item.id === "loopback")?.payload;
	if (loopback === undefined) throw new Error("payloads.json has no loopback case");
	return loopback;
})();
const device: PairingDevice = {
	name: "Work laptop",
	transportSpkiSha256: spkiSha256(claims.keys.device.transportSpki),
	signingKey: claims.keys.device.signingKey,
};
const window: PairingWindow = { pid: base.pid, role: base.role, sec: base.sec };
const ekm = new Uint8Array(32).map((_, at) => 0x40 + at);
const nd = new Uint8Array(16).map((_, at) => 0x60 + at);
const nh = new Uint8Array(16).map((_, at) => 0x70 + at);
const connection: PairingConnection = { ekm, clientSpkiSha256: device.transportSpkiSha256 };

describe("the vector files", () => {
	// Other generators may add files to the area (the SMS contract adds its host cases).
	it("hold the three pairing files, and every file of the area has its format and unique ids", () => {
		const names = ["claims.json", "payloads.json", "proofs.json"];
		expect([...files.keys()]).toEqual(expect.arrayContaining(names));
		for (const [name, content] of files) {
			const file = content as Record<string, unknown>;
			expect(file.format, name).toBe("draftyak.vectors.pairing.v1");
			for (const list of Object.values(file).filter(Array.isArray)) {
				const ids = list.map((item: { id?: unknown }) => item.id).filter((id) => id !== undefined);
				expect(new Set(ids).size, name).toBe(ids.length);
			}
		}
		expect(proofs.ekm).toEqual({ label: EKM_LABEL, contextBytes: PID_LENGTH, length: EKM_LENGTH });
		expect(payloads.hubKey.testOnly).toBe(true);
		expect(Object.values(claims.keys).every((key) => key.testOnly)).toBe(true);
	});
});

describe("the pairing payload", () => {
	const named = (text: string): boolean => PairingPayload.shape.name.safeParse(text).success;
	const bytes16 = fc.uint8Array({ minLength: 16, maxLength: 16 }).map(toBase64Url);
	const host = fc.oneof(
		fc.ipV4().filter((ip) => Number(ip.split(".")[0]) >= 1 && Number(ip.split(".")[0]) <= 223),
		fc
			.ipV6()
			.filter((ip) => !ip.includes(".") && /[1-9a-f]/.test(ip) && !/^ff[0-9a-f]{2}:/.test(ip))
			.map((ip) => `[${ip}]`),
		// Names long enough that about a fifth of the codes go over the length limit.
		fc.domain({ size: "medium" }).filter((name) => name.length <= 253),
	);
	const address = fc
		.tuple(host, fc.integer({ min: 1, max: 65535 }))
		.map(([name, port]) => `${name}:${port}`);
	const name = fc.string({ unit: "binary", minLength: 1, maxLength: 64 }).filter(named);
	const payload = fc.record({
		hid: fc.uint8Array({ minLength: 32, maxLength: 32 }).map(hex),
		addr: fc.uniqueArray(address, { minLength: 1, maxLength: 8 }),
		pid: bytes16,
		sec: bytes16,
		exp: fc.integer({ min: now, max: Number.MAX_SAFE_INTEGER }),
		name,
		role: fc.constantFrom(...PairingRole.options),
	});

	// A payload whose code would be over the length limit is refused instead, at both ends.
	it("round-trips through its canonical text (1,000 runs)", () => {
		let longer = 0;
		fc.assert(
			fc.property(payload, (value) => {
				const full = `${PAIRING_PREFIX}${toBase64Url(utf8(canonicalize(value)))}`;
				if (full.length > MAX_PAYLOAD_LENGTH) {
					longer++;
					expect(outcome(() => encodePairingPayload(value))).toBe("PAIR_ENCODING");
					expect(outcome(() => decodePairingPayload(full, now))).toBe("PAIR_ENCODING");
					return;
				}
				const text = encodePairingPayload(value);
				expect(text).toBe(full);
				const json = fromBase64Url(text.slice(PAIRING_PREFIX.length)) ?? new Uint8Array();
				expect(isCanonical(json)).toBe(true);
				const decoded = decodePairingPayload(text, now);
				expect(decoded).toEqual(value);
				expect(encodePairingPayload(decoded)).toBe(text);
			}),
			{ numRuns: 1000 },
		);
		expect(longer).toBeGreaterThan(0);
		expect(longer).toBeLessThan(500);
	});

	it("refuses an extra field, a wrong prefix and a past exp", () => {
		const text = encodePairingPayload(base);
		const body = text.slice(PAIRING_PREFIX.length);
		const extra = toBase64Url(utf8(canonicalize({ ...base, extra: true })));
		expect(outcome(() => decodePairingPayload(`${PAIRING_PREFIX}${extra}`, now))).toBe(
			"PAIR_PAYLOAD_INVALID",
		);
		for (const prefix of ["draftyak-pair:v2:", "draftyak-pair:V1:", "draftyak-pair:", ""]) {
			expect(outcome(() => decodePairingPayload(`${prefix}${body}`, now))).toBe("PAIR_PREFIX");
		}
		expect(outcome(() => decodePairingPayload(text, base.exp))).toBe("accepted");
		expect(outcome(() => decodePairingPayload(text, base.exp + 1))).toBe("PAIR_EXPIRED");
		expect(outcome(() => decodePairingPayload(text, Number.NaN))).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => encodePairingPayload({ ...base, exp: -1 }))).toBe("PAIR_PAYLOAD_INVALID");
		const labels = ["a", "b", "c"].map((letter) => letter.repeat(63)).join(".");
		const long = { ...base, addr: [0, 1, 2, 3].map((n) => `${labels}.hub${n}:47614`) };
		expect(PairingPayload.safeParse(long).success).toBe(true);
		expect(outcome(() => encodePairingPayload(long))).toBe("PAIR_ENCODING");
	});

	it("never repeats a sender's member names in a refusal", () => {
		const forged = "x\r\n2026-10-18T00:00:00Z INFO pairing confirmed\u{85}\u{2028}\u{1b}[2K";
		const extra = toBase64Url(utf8(canonicalize({ ...base, [forged]: 1 })));
		const name = JSON.stringify(forged);
		const refusals = [
			() => decodePairingPayload(`${PAIRING_PREFIX}${extra}`, now),
			() => readPairingClaim(JSON.stringify({ [forged]: 1 })),
			() => readPairingClaim(`{${name}:1,${name}:2}`),
			() => readPairingReveal(JSON.stringify({ pid: base.pid, nd: toBase64Url(nd), [forged]: 1 })),
			() => readPairingReveal(`{${name}:1,${name}:2}`),
		].map((refuse) => {
			try {
				refuse();
			} catch (error) {
				return (error as Error).message;
			}
			return "accepted";
		});
		expect(refusals.map((message) => message.includes("1 unknown member(s)"))).toEqual([
			true,
			true,
			false,
			true,
			false,
		]);
		expect(refusals[2]).toBe("PAIR_CLAIM_INVALID: not strict JSON (JCS_DUPLICATE_KEY)");
		expect(refusals[4]).toBe("PAIR_REVEAL_INVALID: not strict JSON (JCS_DUPLICATE_KEY)");
		for (const message of refusals) {
			expect(message).not.toContain("INFO");
			expect(message).toMatch(/^[ -~]+$/);
		}
	});

	it.each(payloads.cases.map((item) => [item.id, item] as const))(
		"payloads.json: %s",
		(_, item) => {
			if (item.error !== undefined) {
				expect(outcome(() => decodePairingPayload(item.text, now))).toBe(item.error);
				return;
			}
			const decoded = decodePairingPayload(item.text, now);
			expect(decoded).toEqual(item.payload);
			expect(canonicalize(decoded)).toBe(item.json);
			expect(encodePairingPayload(decoded)).toBe(item.text);
			expect(displayHubId(decoded.hid)).toBe(item.hubId);
		},
	);

	it("has a hid that is the SHA-256 of the test hub key's SPKI", () => {
		expect(base.hid).toBe(spkiSha256(payloads.hubKey.publicKeySpki));
	});

	it("refuses every code point the spec lists in a name, and allows their neighbours", () => {
		const listed = [
			[0x00, 0x1f],
			[0x7f, 0x9f],
			[0xad, 0xad],
			[0x34f, 0x34f],
			[0x61c, 0x61c],
			[0x115f, 0x1160],
			[0x17b4, 0x17b5],
			[0x180e, 0x180e],
			[0x200b, 0x200b],
			[0x200e, 0x200f],
			[0x2028, 0x202e],
			[0x2060, 0x206f],
			[0x3164, 0x3164],
			[0xfeff, 0xfeff],
			[0xffa0, 0xffa0],
			[0xfff0, 0xfffb],
			[0x1bca0, 0x1bca3],
			[0x1d173, 0x1d17a],
			[0xe0000, 0xe00ff],
			[0xe01f0, 0xe0fff],
		];
		const inside = (point: number): boolean => named(`a${String.fromCodePoint(point)}b`);
		for (const [first = 0, last = 0] of listed) {
			for (let point = first; point <= last; point++)
				expect(inside(point), point.toString(16)).toBe(false);
		}
		const neighbours = [
			0x20, 0x7e, 0xa0, 0xae, 0x34e, 0x350, 0x17b3, 0x17b6, 0x200c, 0x200d, 0x2027, 0x202f, 0xfe0f,
			0xffef, 0xfffc, 0x1bc9f, 0x1bca4, 0x1d172, 0x1d17b, 0xe0100, 0xe01ef, 0xe1000,
		];
		for (const point of neighbours) expect(inside(point), point.toString(16)).toBe(true);
	});

	// Node's Unicode tables (17.0) against the explicit list: a new version fails here first.
	it("lists Unicode's default-ignorable code points, apart from the joiners and selectors", () => {
		const joiners = [
			[0x180b, 0x180d],
			[0x180f, 0x180f],
			[0x200c, 0x200d],
			[0xfe00, 0xfe0f],
			[0xe0100, 0xe01ef],
		];
		const joining = (point: number): boolean =>
			joiners.some(([first = 0, last = 0]) => point >= first && point <= last);
		for (let point = 0; point <= 0x10ffff; point++) {
			if ((point >= 0xd800 && point <= 0xdfff) || joining(point)) continue;
			const char = String.fromCodePoint(point);
			if (/^\p{Default_Ignorable_Code_Point}$/u.test(char)) {
				expect(named(`a${char}b`), point.toString(16)).toBe(false);
			}
		}
	});

	it("refuses a blank first or last, and a name with nothing visible", () => {
		const blanks = [0x20, 0xa0, 0x1680, 0x202f, 0x205f, 0x2800, 0x3000];
		for (let point = 0x2000; point <= 0x200a; point++) blanks.push(point);
		for (const blank of blanks.map((point) => String.fromCodePoint(point))) {
			expect([`${blank}a`, `a${blank}`, `a${blank}b`].map(named)).toEqual([false, false, true]);
		}
		for (const text of [
			"\u{200c}",
			"\u{200d}\u{fe0f}",
			"\u{180b}",
			"\u{e0100}",
			"\u{a0}\u{200d}",
		]) {
			expect(named(text), text).toBe(false);
		}
		expect(named("\u{200d}a")).toBe(true);
	});

	// Whichever rule a name breaks, and however many, the refusal is one problem in one sentence.
	it("refuses a bad name with one sentence, never repeating the name", () => {
		const rule = "name: 1 to 64 code points, visible, without hidden ones or a blank first or last";
		const refusal = (refuse: () => unknown): string => {
			try {
				refuse();
			} catch (error) {
				return (error as Error).message;
			}
			return "accepted";
		};
		const forged = "Office\r\n2026-10-18T00:00:00Z INFO pairing confirmed";
		const text = `${PAIRING_PREFIX}${toBase64Url(utf8(canonicalize({ ...base, name: forged })))}`;
		const body = canonicalize({ ...makePairingClaim(window, device, ekm, nd), name: forged });
		expect(refusal(() => decodePairingPayload(text, now))).toBe(`PAIR_PAYLOAD_INVALID: ${rule}`);
		expect(refusal(() => readPairingClaim(body))).toBe(`PAIR_CLAIM_INVALID: ${rule}`);
		const tooLong = "a".repeat(65);
		const longAndHidden = `${"a".repeat(64)}\u{200b}`;
		for (const name of ["", tooLong, longAndHidden, "Desk \ud800PC", "\ud800\u{202e}", "   "]) {
			const claim = () => makePairingClaim(window, { ...device, name }, ekm, nd);
			expect(refusal(() => encodePairingPayload({ ...base, name }))).toBe(
				`PAIR_PAYLOAD_INVALID: ${rule}`,
			);
			expect(refusal(claim)).toBe(`PAIR_INVALID_INPUT: ${rule}`);
		}
	});
});

describe("the proof, the commitment and the SAS", () => {
	it.each(proofs.proofs.map((item) => [item.id, item] as const))("proofs.json: %s", (_, item) => {
		const [sec, e, pubs, proof] = [item.secHex, item.ekmHex, item.pubsHex, item.proofHex].map(
			bytes,
		) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
		const bound = Buffer.concat([pubs, bytes(item.cHex ?? "")]);
		expect(verifyPairingProof(sec, e, bound, proof)).toBe(item.valid);
		if (item.valid) expect(hex(pairingProof(sec, e, bound))).toBe(item.proofHex);
	});

	it.each(proofs.commitments.map((item) => [item.id, item] as const))(
		"proofs.json commitment: %s",
		(_, item) => {
			expect(pairingCommitment(bytes(item.ndHex))).toBe(item.c);
		},
	);

	it.each(proofs.sas.map((item) => [item.id, item] as const))("proofs.json SAS: %s", (_, item) => {
		expect(pairingSas(bytes(item.ekmHex), bytes(item.ndHex), bytes(item.nhHex))).toBe(item.sas);
	});

	it.each(proofs.hubIds.map((item) => [item.id, item] as const))(
		"proofs.json hub ID: %s",
		(_, item) => {
			expect(displayHubId(item.hid)).toBe(item.display);
		},
	);

	// The formulas restated with node:crypto alone, and the skeleton's pair_proof numbers.
	it("holds vectors that match the formulas and the S10 skeleton's proof numbers", () => {
		for (const item of proofs.proofs) {
			const parts = `${hex(utf8("draftyak/pair/v1"))}${item.ekmHex}${item.pubsHex}`;
			expect(item.messageHex).toBe(`${parts}${item.cHex ?? ""}`);
			const mac = createHmac("sha256", bytes(item.secHex))
				.update(bytes(item.messageHex))
				.digest("hex");
			expect(mac === item.proofHex, item.id).toBe(item.valid);
		}
		for (const item of proofs.commitments) {
			expect(item.messageHex).toBe(`${hex(utf8("draftyak/sas-commit/v1"))}${item.ndHex}`);
			expect(digestOf("draftyak/sas-commit/v1", bytes(item.ndHex)).toString("hex")).toBe(item.c);
		}
		for (const item of proofs.sas) {
			const parts = [item.ekmHex, item.ndHex, item.nhHex].map(bytes);
			expect(item.messageHex).toBe(hex(Buffer.concat([utf8("draftyak/sas/v1"), ...parts])));
			const digest = digestOf("draftyak/sas/v1", ...parts);
			expect(digest.toString("hex")).toBe(item.sha256);
			expect(codeOf(digest)).toBe(item.sas);
		}
		expect(find(proofs.proofs, "skeleton")).toMatchObject({
			secHex: "01".repeat(16),
			ekmHex: "02".repeat(32),
			pubsHex: hex(utf8("pubs")),
			proofHex: "d9351b28b88772134dcbcaa57c493ae1cafff501908e530a1c9f4fe700a850f1",
			valid: true,
		});
		expect(find(proofs.hubIds, "skeleton")).toEqual({
			id: "skeleton",
			hid: "ab".repeat(32),
			display: "DYK-ABAB-ABAB-ABAB-ABAB",
		});
		for (const id of ["skeleton-other-ekm", "skeleton-other-pubs", "skeleton-other-sec"]) {
			expect(find(proofs.proofs, id).valid, id).toBe(false);
		}
	});

	it("covers the claim's commitment, so neither another one nor M1.21's proof verifies", () => {
		const claim = find(proofs.proofs, "device-claim");
		expect(claim).toMatchObject({ cHex: find(proofs.commitments, "device-claim").c, valid: true });
		const other = find(proofs.proofs, "device-claim-other-commitment");
		expect(other).toMatchObject({ proofHex: claim.proofHex, valid: false });
		expect(other.cHex).not.toBe(claim.cHex);
		const keysOnly = find(proofs.proofs, "device-claim-proof-without-commitment");
		expect(keysOnly).toMatchObject({ cHex: claim.cHex, valid: false });
		const sec = bytes(claim.secHex);
		const overPubs = createHmac("sha256", sec).update(utf8("draftyak/pair/v1"));
		overPubs.update(bytes(claim.ekmHex)).update(bytes(claim.pubsHex));
		expect(keysOnly.proofHex).toBe(overPubs.digest("hex"));
		expect(bytes(claim.messageHex)).toHaveLength(16 + 32 + 97 + 32);
	});

	// Six digits collide one time in a million, so the cases are chosen to tell these apart.
	it("holds SAS cases that change with the order, the omission or the label of each input", () => {
		const distinct = ["device-claim", "leading-zeros"];
		for (const item of proofs.sas) {
			const [e, n, h] = [item.ekmHex, item.ndHex, item.nhHex].map(bytes) as [
				Uint8Array,
				Uint8Array,
				Uint8Array,
			];
			const others = [
				codeOf(digestOf("draftyak/sas/v1", e)),
				codeOf(digestOf("draftyak/sas/v1", e, n)),
				codeOf(digestOf("draftyak/sas/v1", e, h)),
				codeOf(digestOf("draftyak/sas/v1", n, h)),
				...["draftyak/sas/v2", "draftyak/sas-commit/v1", "draftyak/pair/v1", ""].map((label) =>
					codeOf(digestOf(label, e, n, h)),
				),
			];
			if (distinct.includes(item.id)) {
				const orders = [
					[e, h, n],
					[n, e, h],
					[n, h, e],
					[h, e, n],
					[h, n, e],
				];
				others.push(...orders.map((order) => codeOf(digestOf("draftyak/sas/v1", ...order))));
			}
			for (const code of others) expect(code, item.id).not.toBe(item.sas);
		}
		expect(find(proofs.sas, "leading-zeros").sas).toMatch(/^00[0-9]{4}$/);
		expect(find(proofs.sas, "device-claim")).toMatchObject({
			ekmHex: hex(ekm),
			ndHex: hex(nd),
			nhHex: hex(nh),
		});
	});

	it("verifies only the exact sec, EKM, pubs and proof (1,000 runs)", () => {
		const input = fc.record({
			sec: fc.uint8Array({ minLength: SEC_LENGTH, maxLength: SEC_LENGTH }),
			ekm: fc.uint8Array({ minLength: EKM_LENGTH, maxLength: EKM_LENGTH }),
			pubs: fc.uint8Array({ minLength: 1, maxLength: 129 }),
			nd: fc.uint8Array({ minLength: NONCE_LENGTH, maxLength: NONCE_LENGTH }),
			nh: fc.uint8Array({ minLength: NONCE_LENGTH, maxLength: NONCE_LENGTH }),
		});
		fc.assert(
			fc.property(input, fc.nat(3), fc.nat(), (values, which, at) => {
				const proof = pairingProof(values.sec, values.ekm, values.pubs);
				expect(verifyPairingProof(values.sec, values.ekm, values.pubs, proof)).toBe(true);
				const parts = [values.sec, values.ekm, values.pubs, proof].map((part) => part.slice());
				const part = parts[which] ?? new Uint8Array(1);
				part[at % part.length] = (part[at % part.length] ?? 0) ^ 1;
				const [sec, e, pubs, changed] = parts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
				expect(verifyPairingProof(sec, e, pubs, changed)).toBe(false);
				expect(pairingSas(values.ekm, values.nd, values.nh)).toMatch(/^[0-9]{6}$/);
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses inputs of another length, and a proof of another length never verifies", () => {
		const [sec, e, pubs] = [new Uint8Array(16), new Uint8Array(32), new Uint8Array(4)];
		const [n16, n15, n17] = [16, 15, 17].map((length) => new Uint8Array(length)) as [
			Uint8Array,
			Uint8Array,
			Uint8Array,
		];
		expect(outcome(() => pairingProof(new Uint8Array(15), e, pubs))).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => pairingProof(sec, new Uint8Array(31), pubs))).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => pairingSas(new Uint8Array(33), n16, n16))).toBe("PAIR_INVALID_INPUT");
		for (const [n, h] of [
			[n15, n16],
			[n16, n17],
			[n17, n16],
			[n16, n15],
		] as const) {
			expect(outcome(() => pairingSas(e, n, h))).toBe("PAIR_INVALID_INPUT");
		}
		for (const n of [n15, n17, new Uint8Array(32)]) {
			expect(outcome(() => pairingCommitment(n))).toBe("PAIR_INVALID_INPUT");
		}
		const proof = pairingProof(sec, e, pubs);
		expect(verifyPairingProof(sec, e, pubs, proof.subarray(0, 31))).toBe(false);
		expect(verifyPairingProof(sec, e, pubs, Buffer.concat([proof, Uint8Array.of(0)]))).toBe(false);
		expect(outcome(() => displayHubId("AB".repeat(32)))).toBe("PAIR_INVALID_INPUT");
	});
});

describe("the sidecar window", () => {
	// HKDF-SHA-256 with an empty salt, restated with node:crypto alone.
	const derive = (secret: Uint8Array, part: string): string =>
		toBase64Url(
			new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(), `draftyak/pair/v1/${part}`, 16)),
		);

	it.each(proofs.sidecar.map((item) => [item.id, item] as const))(
		"proofs.json sidecar: %s",
		(_, item) => {
			const secret = bytes(item.bootstrapSecretHex);
			expect(secret.length).toBe(16);
			expect(sidecarWindowSecrets(secret)).toEqual({ pid: item.pid, sec: item.sec });
			expect([derive(secret, "sidecar-pid"), derive(secret, "sidecar-sec")]).toEqual([
				item.pid,
				item.sec,
			]);
		},
	);

	it("comes only from a 16-byte secret, and pairs a device as any window does", () => {
		for (const length of [0, 15, 17, 32]) {
			const secret = new Uint8Array(length);
			expect(outcome(() => sidecarWindowSecrets(secret))).toBe("PAIR_INVALID_INPUT");
		}
		const sidecar = {
			...sidecarWindowSecrets(new Uint8Array(16).fill(7)),
			role: "device" as const,
		};
		expect(sidecar.pid).not.toBe(sidecar.sec);
		const claim = readPairingClaim(canonicalize(makePairingClaim(sidecar, device, ekm, nd)));
		expect(verifyPairingClaim(claim, sidecar, connection)).toBe(undefined);
		const reveal = readPairingReveal(canonicalize({ pid: sidecar.pid, nd: toBase64Url(nd) }));
		expect(verifyPairingReveal(reveal, claim)).toBe(undefined);
	});
});

describe("the claim", () => {
	it.each(claims.cases.map((item) => [item.id, item] as const))("claims.json: %s", (_, item) => {
		const live = {
			ekm: bytes(item.connection.ekmHex),
			clientSpkiSha256: item.connection.clientSpkiSha256,
		};
		const verdict = outcome(() => {
			const refusal = verifyPairingClaim(readPairingClaim(item.body), item.window, live);
			if (refusal !== undefined) throw Object.assign(new Error(refusal), { code: refusal });
		});
		expect(verdict).toBe(item.outcome);
		expect(outcome(() => readPairingClaim(utf8(item.body)))).toBe(
			outcome(() => readPairingClaim(item.body)),
		);
		if (item.outcome !== "accepted") {
			expect(PairingRefusal.parse({ code: item.outcome }).code).toBe(item.outcome);
		} else if (item.pubsHex !== undefined) {
			const claim = readPairingClaim(item.body);
			expect(hex(pairingPubs(claim.transportSpkiSha256, claim.signingKey))).toBe(item.pubsHex);
		}
	});

	it("is made byte for byte as the accepted vector, binding the keys and c as specified", () => {
		const accepted = find(claims.cases, "device");
		const claim = makePairingClaim(window, device, ekm, nd);
		expect(canonicalize(claim)).toBe(accepted.body);
		const pubs = pairingPubs(device.transportSpkiSha256, device.signingKey);
		expect(pubs.length).toBe(32 + 65);
		expect(hex(pubs.subarray(0, 32))).toBe(device.transportSpkiSha256);
		expect(pubs[32]).toBe(0x04);
		const der = fromBase64Url(device.signingKey) ?? new Uint8Array();
		expect(Buffer.from(pubs.subarray(32)).equals(der.subarray(der.length - 65))).toBe(true);
		expect(claim.c).toBe(digestOf("draftyak/sas-commit/v1", nd).toString("hex"));
		const sec = fromBase64Url(window.sec) ?? new Uint8Array();
		const mac = createHmac("sha256", sec).update(utf8("draftyak/pair/v1")).update(ekm);
		expect(claim.proof).toBe(mac.update(pubs).update(bytes(claim.c)).digest("hex"));
		expect(verifyPairingClaim(claim, window, connection)).toBeUndefined();
	});

	it("refuses keys and inputs outside their forms", () => {
		expect(
			outcome(() => pairingPubs(device.transportSpkiSha256.toUpperCase(), device.signingKey)),
		).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => pairingPubs(device.transportSpkiSha256, "AAAA"))).toBe(
			"PAIR_INVALID_INPUT",
		);
		expect(outcome(() => makePairingClaim(window, { ...device, name: "" }, ekm, nd))).toBe(
			"PAIR_INVALID_INPUT",
		);
		expect(outcome(() => makePairingClaim({ ...window, sec: "AAAA" }, device, ekm, nd))).toBe(
			"PAIR_INVALID_INPUT",
		);
		for (const length of [0, 15, 17]) {
			expect(outcome(() => makePairingClaim(window, device, ekm, new Uint8Array(length)))).toBe(
				"PAIR_INVALID_INPUT",
			);
		}
		const claim = makePairingClaim(window, device, ekm, nd);
		for (const unchecked of [
			{ ...claim, proof: claim.proof.toUpperCase() },
			{ ...claim, c: claim.c.toUpperCase() },
			{ ...claim, c: undefined },
		]) {
			expect(verifyPairingClaim(unchecked as typeof claim, window, connection)).toBe(
				"PAIR_CLAIM_INVALID",
			);
		}
		expect(
			outcome(() => verifyPairingClaim(claim, window, { ...connection, ekm: new Uint8Array(31) })),
		).toBe("PAIR_INVALID_INPUT");
	});

	it("answers with a strict result or a refusal code", () => {
		const result = { deviceId: "01JAZ3W3B6Q8M2V0G5T9K4X7RC", epoch: 1, nh: toBase64Url(nh) };
		expect(PairingResult.parse(result)).toEqual(result);
		const { nh: _, ...withoutNonce } = result;
		for (const bad of [
			{ ...result, epoch: -1 },
			{ ...result, hubStatementKey: "x" },
			{ deviceId: "x", epoch: 1, nh: result.nh },
			withoutNonce,
			{ ...result, nh: toBase64Url(nh.subarray(0, 15)) },
			{ ...result, nh: hex(nh) },
			{ ...result, nh: `${result.nh}=` },
			{ ...result, sas: pairingSas(ekm, nd, nh) },
		]) {
			expect(PairingResult.safeParse(bad).success).toBe(false);
		}
		expect(PairingRefusal.shape.code.options).toEqual([
			"PAIR_WINDOW_CLOSED",
			"PAIR_CLAIM_INVALID",
			"PAIR_ROLE_MISMATCH",
			"PAIR_PROOF_INVALID",
			"PAIR_REVEAL_INVALID",
			"PAIR_COMMITMENT_MISMATCH",
		]);
		for (const extra of [{ detail: "x" }, { sas: pairingSas(ekm, nd, nh) }]) {
			expect(PairingRefusal.safeParse({ code: "PAIR_PROOF_INVALID", ...extra }).success).toBe(
				false,
			);
		}
	});
});

describe("the reveal", () => {
	it.each(claims.reveals.map((item) => [item.id, item] as const))(
		"claims.json reveal: %s",
		(_, item) => {
			const claim = readPairingClaim(item.claim);
			const verdict = outcome(() => {
				const refusal = verifyPairingReveal(readPairingReveal(item.body), claim);
				if (refusal !== undefined) throw Object.assign(new Error(refusal), { code: refusal });
			});
			expect(verdict).toBe(item.outcome);
			expect(outcome(() => readPairingReveal(utf8(item.body)))).toBe(
				outcome(() => readPairingReveal(item.body)),
			);
			if (item.outcome !== "accepted") {
				expect(PairingRefusal.parse({ code: item.outcome }).code).toBe(item.outcome);
				expect(item.sas).toBeUndefined();
				return;
			}
			expect(readPairingReveal(item.body).pid).toBe(claim.pid);
			const revealed = fromBase64Url(readPairingReveal(item.body).nd) ?? new Uint8Array();
			const hubNonce = fromBase64Url(item.nh) ?? new Uint8Array();
			expect(digestOf("draftyak/sas-commit/v1", revealed).toString("hex")).toBe(claim.c);
			expect(pairingSas(bytes(item.ekmHex), revealed, hubNonce)).toBe(item.sas);
			const parts = [bytes(item.ekmHex), revealed, hubNonce];
			expect(codeOf(digestOf("draftyak/sas/v1", ...parts))).toBe(item.sas);
		},
	);

	it("opens a commitment with its own nonce only (1,000 runs)", () => {
		const nonce = fc.uint8Array({ minLength: NONCE_LENGTH, maxLength: NONCE_LENGTH });
		fc.assert(
			fc.property(nonce, nonce, (mine, other) => {
				fc.pre(hex(mine) !== hex(other));
				const held = makePairingClaim(window, device, ekm, mine);
				expect(held.c).toBe(pairingCommitment(mine));
				const reveal = (n: Uint8Array) => ({ pid: window.pid, nd: toBase64Url(n) });
				expect(verifyPairingReveal(reveal(mine), held)).toBeUndefined();
				expect(verifyPairingReveal(reveal(other), held)).toBe("PAIR_COMMITMENT_MISMATCH");
			}),
			{ numRuns: 1000 },
		);
	});

	// Two claims with the same c, on two windows: each opens only with its own window's pid.
	it("opens only a claim on the window it names", () => {
		const sidecar = {
			...sidecarWindowSecrets(new Uint8Array(16).fill(7)),
			role: "device" as const,
		};
		const held = makePairingClaim(window, device, ekm, nd);
		const other = makePairingClaim(sidecar, device, ekm, nd);
		const reveal = { pid: window.pid, nd: toBase64Url(nd) };
		expect(held.c).toBe(other.c);
		expect(verifyPairingReveal(reveal, held)).toBeUndefined();
		expect(verifyPairingReveal(reveal, other)).toBe("PAIR_WINDOW_CLOSED");
		const named = { ...reveal, pid: sidecar.pid };
		expect(verifyPairingReveal(named, other)).toBeUndefined();
		expect(verifyPairingReveal(named, held)).toBe("PAIR_WINDOW_CLOSED");
	});

	it("checks a reveal's form, and takes only a claim that held", () => {
		const claim = makePairingClaim(window, device, ekm, nd);
		const reveal = { pid: window.pid, nd: toBase64Url(nd) };
		for (const unchecked of [
			{ ...reveal, nd: toBase64Url(nd.subarray(0, 15)) },
			{ ...reveal, nd: hex(nd) },
			{ ...reveal, pid: hex(fromBase64Url(window.pid) ?? new Uint8Array()) },
			{ ...reveal, nh: toBase64Url(nh) },
			{ nd: reveal.nd },
			{ pid: reveal.pid },
			{},
		]) {
			expect(verifyPairingReveal(unchecked as PairingReveal, claim)).toBe("PAIR_REVEAL_INVALID");
		}
		for (const held of [{ ...claim, c: "x" }, { ...claim, c: undefined }, {}]) {
			expect(outcome(() => verifyPairingReveal(reveal, held as typeof claim))).toBe(
				"PAIR_INVALID_INPUT",
			);
		}
		expect(PairingReveal.safeParse({ ...reveal, sas: pairingSas(ekm, nd, nh) }).success).toBe(
			false,
		);
	});
});

describe("the received bytes of a claim or a reveal", () => {
	const claimBody = canonicalize(makePairingClaim(window, device, ekm, nd));
	const revealBody = canonicalize({ pid: window.pid, nd: toBase64Url(nd) });
	const readers = [
		{ name: "claim", read: readPairingClaim, body: claimBody, cap: MAX_CLAIM_BYTES },
		{ name: "reveal", read: readPairingReveal, body: revealBody, cap: MAX_REVEAL_BYTES },
	];
	const code = (name: string): string =>
		name === "claim" ? "PAIR_CLAIM_INVALID" : "PAIR_REVEAL_INVALID";
	// Non-ASCII text counts more UTF-8 bytes than UTF-16 units. A claim holds it in its name; no
	// member of a reveal can, so a nonce in fullwidth letters stands in, refused once parsed.
	const fullwidth = (text: string): string =>
		String.fromCodePoint(...[...text].map((char) => (char.codePointAt(0) ?? 0) + 0xfee0));
	const named = { ...device, name: "Zo\u00eb\u2019s laptop \u{1f4bb}" };
	const wide = [
		{
			name: "claim",
			read: readPairingClaim,
			body: canonicalize(makePairingClaim(window, named, ekm, nd)),
			cap: MAX_CLAIM_BYTES,
			atCap: "accepted",
		},
		{
			name: "reveal",
			read: readPairingReveal,
			body: canonicalize({ pid: window.pid, nd: fullwidth(toBase64Url(nd)) }),
			cap: MAX_REVEAL_BYTES,
			atCap: "PAIR_REVEAL_INVALID",
		},
	];
	// Trailing spaces, which strict JSON allows, to a size in UTF-8 bytes.
	const sized = (body: string, size: number): string =>
		body.padEnd(body.length + size - utf8(body).length);

	it.each(readers)("are measured before anything parses a $name", ({ name, read, body, cap }) => {
		const parse = vi.spyOn(jcs, "parseStrict");
		try {
			for (const over of [body.padEnd(cap + 1), utf8(body.padEnd(cap + 1))]) {
				expect(outcome(() => read(over))).toBe(code(name));
			}
			const shadowed = utf8(body.padEnd(cap + 1));
			for (const property of ["length", "byteLength"]) {
				Object.defineProperty(shadowed, property, { value: body.length });
			}
			expect(outcome(() => read(shadowed))).toBe(code(name));
			expect(parse).not.toHaveBeenCalled();
			expect(outcome(() => read(utf8(body.padEnd(cap))))).toBe("accepted");
			expect(parse).toHaveBeenCalledOnce();
		} finally {
			parse.mockRestore();
		}
	});

	it.each(wide)(
		"are UTF-8 bytes, not UTF-16 units, in a $name with non-ASCII text",
		({ name, read, body, cap, atCap }) => {
			const [at, over] = [sized(body, cap), sized(body, cap + 1)];
			expect([utf8(at).length, utf8(over).length]).toEqual([cap, cap + 1]);
			expect(over.length).toBeLessThanOrEqual(cap);
			const parse = vi.spyOn(jcs, "parseStrict");
			try {
				for (const input of [over, utf8(over)]) expect(outcome(() => read(input))).toBe(code(name));
				expect(parse).not.toHaveBeenCalled();
				for (const input of [at, utf8(at)]) expect(outcome(() => read(input))).toBe(atCap);
				expect(parse).toHaveBeenCalledTimes(2);
			} finally {
				parse.mockRestore();
			}
		},
	);

	it.each(readers)(
		"are a $name view's own bytes, not its backing buffer's",
		({ name, read, body, cap }) => {
			// Spaces around the view, so only the size check can refuse the whole buffer.
			const backing = new Uint8Array(cap + 14).fill(0x20);
			backing.set(utf8(body.padEnd(cap)), 7);
			expect(outcome(() => read(backing.subarray(7, cap + 7)))).toBe("accepted");
			expect(outcome(() => read(backing))).toBe(code(name));
		},
	);
});

describe("the SAS's delivery", () => {
	const subject = (pairFixture().review as { subject: Record<string, unknown> }).subject;
	const schema = new Validator(jsonSchemaOf(PairConfirmSubject) as Schema, "2020-12", false);
	const subjects = (sas: unknown): Record<string, unknown> => {
		const { sas: _, ...rest } = subject;
		return sas === undefined ? rest : { ...rest, sas };
	};
	const refused = [
		undefined,
		"",
		"04917",
		"0049170",
		4917,
		"00491x",
		"００４９１７",
		"\u{660}\u{660}\u{664}\u{669}\u{661}\u{667}",
		...["\r", "\n", "\u2028", "\u2029"].flatMap((end) => [`004917${end}`, `00491${end}`]),
	];

	// The exported JSON Schema and zod agree on the field, so no other validator takes a suffix.
	it("is six ASCII digits in the pair-confirm review's subject, which requires it", () => {
		for (const sas of ["004917", "000000", "999999"]) {
			expect(PairConfirmSubject.safeParse(subjects(sas)).success, sas).toBe(true);
			expect(schema.validate(subjects(sas)).valid, sas).toBe(true);
			expect(PairingSas.safeParse(sas).success).toBe(true);
		}
		for (const sas of refused) {
			const label = JSON.stringify(sas) ?? "missing";
			expect(PairConfirmSubject.safeParse(subjects(sas)).success, label).toBe(false);
			expect(schema.validate(subjects(sas)).valid, label).toBe(false);
		}
	});

	it("is covered by the review's digest", () => {
		const review = pairFixture().review as Record<string, unknown>;
		expect(OperationReview.safeParse(review).success).toBe(true);
		const changed = { ...review, subject: subjects("000000") };
		expect(OperationReview.safeParse(changed).success).toBe(false);
	});

	it("is fetched only by a current confirmed approve device", () => {
		const peer = {
			role: "device",
			known: true,
			revoked: false,
			epoch: 1,
			confirmedEpoch: 1,
			capabilities: [...CONFIRMATION_PRESETS.desktop],
			sidecarClaim: false,
			bootstrapDone: true,
		};
		const fetches = (changed: object): boolean =>
			routeAllows("operation-review", { ...peer, ...changed }, { kind: "pair-confirm" });
		expect(fetches({})).toBe(true);
		for (const changed of [
			{ capabilities: [...CONFIRMATION_PRESETS.mobile] },
			{ confirmedEpoch: null, capabilities: [] },
			{ confirmedEpoch: 0 },
			{ revoked: true },
			{ known: false },
			{ role: "host:sms" },
		]) {
			expect(fetches(changed), JSON.stringify(changed)).toBe(false);
		}
	});

	it("is in no pairing answer and in no device status", () => {
		const sas = { sas: pairingSas(ekm, nd, nh) };
		const status = { deviceId: "01JAZ3W3B6Q8M2V0G5T9K4X7RC", epoch: 1, confirmed: false };
		const pending = { ...status, capabilities: [], testUpstreams: false };
		expect(DeviceStatus.safeParse(pending).success).toBe(true);
		expect(DeviceStatus.safeParse({ ...pending, ...sas }).success).toBe(false);
		const result = { deviceId: status.deviceId, epoch: 1, nh: toBase64Url(nh) };
		expect(PairingResult.safeParse(result).success).toBe(true);
		expect(PairingResult.safeParse({ ...result, ...sas }).success).toBe(false);
		expect(
			outcome(() =>
				readPairingClaim(
					canonicalize({ ...JSON.parse(find(claims.cases, "device").body), ...sas }),
				),
			),
		).toBe("PAIR_CLAIM_INVALID");
	});
});

describe("the EKM", () => {
	it("is 32 bytes exported under the pairing label with the 16 raw pid bytes as context", () => {
		const calls: unknown[][] = [];
		const socket: KeyingMaterialExporter = {
			exportKeyingMaterial(length, label, context) {
				calls.push([length, label, hex(context)]);
				return Buffer.alloc(length, 7);
			},
		};
		expect(hex(pairingEkm(socket, base.pid))).toBe("07".repeat(32));
		expect(calls).toEqual([
			[32, "EXPERIMENTAL-draftyak-pair-v1", hex(fromBase64Url(base.pid) ?? new Uint8Array())],
		]);
		expect(EKM_LABEL).toBe("EXPERIMENTAL-draftyak-pair-v1");
		expect([EKM_LENGTH, PID_LENGTH, SEC_LENGTH, NONCE_LENGTH]).toEqual([32, 16, 16, 16]);
		expectTypeOf<TLSSocket>().toExtend<KeyingMaterialExporter>();
	});

	it("refuses a pid of another length and an exporter that gives another length", () => {
		const socket: KeyingMaterialExporter = {
			exportKeyingMaterial: (length) => Buffer.alloc(length),
		};
		expect(outcome(() => pairingEkm(socket, toBase64Url(new Uint8Array(15))))).toBe(
			"PAIR_INVALID_INPUT",
		);
		const short: KeyingMaterialExporter = { exportKeyingMaterial: () => Buffer.alloc(31) };
		expect(outcome(() => pairingEkm(short, base.pid))).toBe("PAIR_INVALID_INPUT");
	});
});

describe("roles", () => {
	const protocolDir = path.resolve(import.meta.dirname, "..");
	const file = path.join(protocolDir, "src", "pairing.ts");
	const source = readFileSync(file, "utf8");
	const rolesLine = /^const pairingRoles = \[(.*)\] as const;$/m;
	const shipsHosts = (PairingRole.options as readonly string[]).includes("host:sms");

	it("are named on one line of the module only", () => {
		expect(PairingRole.options).toContain("device");
		const code = source.split("\n").filter((text) => !text.trimStart().startsWith("//"));
		const naming = code.filter((text) => /"device"|"host:/.test(text));
		expect(naming).toHaveLength(1);
		expect(naming[0]).toMatch(rolesLine);
	});

	// Applies the SMS contract's change to a copy of the module (unless it has landed), then
	// pairs a host with that copy.
	it("take host:sms by that one line", async () => {
		const cache = path.join(protocolDir, ".cache");
		mkdirSync(cache, { recursive: true });
		const dir = mkdtempSync(path.join(cache, "pairing-roles-"));
		try {
			const roles = source.match(rolesLine)?.[1] ?? "";
			const added = shipsHosts ? roles : `${roles}, "host:sms"`;
			const withHosts = source.replace(rolesLine, `const pairingRoles = [${added}] as const;`);
			const lines = source.split("\n");
			const changed = withHosts.split("\n").filter((text, at) => text !== lines[at]);
			expect(changed).toHaveLength(shipsHosts ? 0 : 1);
			const src = path.relative(dir, path.dirname(file)).split(path.sep).join("/");
			writeFileSync(
				path.join(dir, "pairing.ts"),
				withHosts.replaceAll('from "./', `from "${src}/`),
			);
			const hosts: typeof pairing = await import(pathToFileURL(path.join(dir, "pairing.ts")).href);
			expect(hosts.PairingRole.options).toContain("host:sms");

			const role = "host:sms" as unknown as PairingWindow["role"];
			const text = hosts.encodePairingPayload({ ...base, role });
			expect(hosts.decodePairingPayload(text, now)).toEqual({ ...base, role });
			const hostWindow = { ...window, role };
			const body = canonicalize(hosts.makePairingClaim(hostWindow, device, ekm, nd));
			const claim = hosts.readPairingClaim(body);
			expect(hosts.verifyPairingClaim(claim, hostWindow, connection)).toBeUndefined();
			expect(hosts.verifyPairingClaim(claim, window, connection)).toBe("PAIR_ROLE_MISMATCH");
			const deviceClaim = hosts.makePairingClaim(window, device, ekm, nd);
			expect(hosts.verifyPairingClaim(deviceClaim, hostWindow, connection)).toBe(
				"PAIR_ROLE_MISMATCH",
			);
			const reveal = hosts.readPairingReveal(
				canonicalize({ pid: window.pid, nd: toBase64Url(nd) }),
			);
			expect(hosts.verifyPairingReveal(reveal, claim)).toBeUndefined();
			if (!shipsHosts) {
				expect(outcome(() => decodePairingPayload(text, now))).toBe("PAIR_PAYLOAD_INVALID");
				expect(outcome(() => readPairingClaim(body))).toBe("PAIR_CLAIM_INVALID");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the package", () => {
	it("reaches pairing through its wildcard subpath export, never the index", () => {
		const names = Object.keys(pairing).toSorted();
		expect(Object.keys(index).filter((key) => names.includes(key))).toEqual([]);
		const script =
			'const m = await import("@draftyak/protocol/pairing");' +
			"process.stdout.write(JSON.stringify(Object.keys(m).toSorted()));";
		const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: path.resolve(import.meta.dirname, ".."),
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toEqual(names);
	});
});
