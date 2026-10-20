import { execFileSync } from "node:child_process";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as index from "../src/index.ts";
import { canonicalize, isCanonical } from "../src/jcs.ts";
import * as pairing from "../src/pairing.ts";
import {
	decodePairingPayload,
	displayHubId,
	EKM_LABEL,
	EKM_LENGTH,
	encodePairingPayload,
	type KeyingMaterialExporter,
	MAX_PAYLOAD_LENGTH,
	makePairingClaim,
	PAIRING_PREFIX,
	type PairingConnection,
	type PairingDevice,
	PairingPayload,
	PairingRefusal,
	PairingResult,
	PairingRole,
	type PairingWindow,
	PID_LENGTH,
	pairingEkm,
	pairingProof,
	pairingPubs,
	pairingSas,
	readPairingClaim,
	SEC_LENGTH,
	sidecarWindowSecrets,
	verifyPairingClaim,
	verifyPairingProof,
} from "../src/pairing.ts";
import { fromBase64Url, toBase64Url } from "../src/scalars.ts";
import { hex, outcome, utf8, vectorFiles } from "./vectors.ts";

interface ProofCase {
	readonly id: string;
	readonly secHex: string;
	readonly ekmHex: string;
	readonly pubsHex: string;
	readonly messageHex: string;
	readonly proofHex: string;
	readonly valid: boolean;
}
interface SasCase {
	readonly id: string;
	readonly ekmHex: string;
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
		]);
		expect(refusals[2]).toBe("PAIR_CLAIM_INVALID: not strict JSON (JCS_DUPLICATE_KEY)");
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
		const body = canonicalize({ ...makePairingClaim(window, device, ekm), name: forged });
		expect(refusal(() => decodePairingPayload(text, now))).toBe(`PAIR_PAYLOAD_INVALID: ${rule}`);
		expect(refusal(() => readPairingClaim(body))).toBe(`PAIR_CLAIM_INVALID: ${rule}`);
		const tooLong = "a".repeat(65);
		const longAndHidden = `${"a".repeat(64)}\u{200b}`;
		for (const name of ["", tooLong, longAndHidden, "Desk \ud800PC", "\ud800\u{202e}", "   "]) {
			const claim = () => makePairingClaim(window, { ...device, name }, ekm);
			expect(refusal(() => encodePairingPayload({ ...base, name }))).toBe(
				`PAIR_PAYLOAD_INVALID: ${rule}`,
			);
			expect(refusal(claim)).toBe(`PAIR_INVALID_INPUT: ${rule}`);
		}
	});
});

describe("the proof and the SAS", () => {
	it.each(proofs.proofs.map((item) => [item.id, item] as const))("proofs.json: %s", (_, item) => {
		const [sec, e, pubs, proof] = [item.secHex, item.ekmHex, item.pubsHex, item.proofHex].map(
			bytes,
		) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
		expect(verifyPairingProof(sec, e, pubs, proof)).toBe(item.valid);
		if (item.valid) expect(hex(pairingProof(sec, e, pubs))).toBe(item.proofHex);
	});

	it.each(proofs.sas.map((item) => [item.id, item] as const))("proofs.json SAS: %s", (_, item) => {
		expect(pairingSas(bytes(item.ekmHex))).toBe(item.sas);
	});

	it.each(proofs.hubIds.map((item) => [item.id, item] as const))(
		"proofs.json hub ID: %s",
		(_, item) => {
			expect(displayHubId(item.hid)).toBe(item.display);
		},
	);

	// The skeleton's pair_proof and sas, restated with node:crypto alone.
	it("holds vectors that match the S10 skeleton's formulas and its own numbers", () => {
		for (const item of proofs.proofs) {
			expect(item.messageHex).toBe(`${hex(utf8("draftyak/pair/v1"))}${item.ekmHex}${item.pubsHex}`);
			const mac = createHmac("sha256", bytes(item.secHex))
				.update(bytes(item.messageHex))
				.digest("hex");
			expect(mac === item.proofHex, item.id).toBe(item.valid);
		}
		for (const item of proofs.sas) {
			const digest = createHash("sha256")
				.update("draftyak/sas/v1")
				.update(bytes(item.ekmHex))
				.digest();
			expect(digest.toString("hex")).toBe(item.sha256);
			expect(String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0")).toBe(item.sas);
		}
		const find = <T extends { id: string }>(list: T[], id: string): T | undefined =>
			list.find((item) => item.id === id);
		expect(find(proofs.proofs, "skeleton")).toMatchObject({
			secHex: "01".repeat(16),
			ekmHex: "02".repeat(32),
			pubsHex: hex(utf8("pubs")),
			proofHex: "d9351b28b88772134dcbcaa57c493ae1cafff501908e530a1c9f4fe700a850f1",
			valid: true,
		});
		expect(find(proofs.sas, "skeleton-zeros")).toMatchObject({
			ekmHex: "00".repeat(32),
			sas: "982166",
		});
		expect(find(proofs.sas, "skeleton-ones")).toMatchObject({
			ekmHex: "ff".repeat(32),
			sas: "006520",
		});
		expect(find(proofs.hubIds, "skeleton")).toEqual({
			id: "skeleton",
			hid: "ab".repeat(32),
			display: "DYK-ABAB-ABAB-ABAB-ABAB",
		});
		for (const id of ["skeleton-other-ekm", "skeleton-other-pubs", "skeleton-other-sec"]) {
			expect(find(proofs.proofs, id)?.valid, id).toBe(false);
		}
	});

	it("verifies only the exact sec, EKM, pubs and proof (1,000 runs)", () => {
		const input = fc.record({
			sec: fc.uint8Array({ minLength: SEC_LENGTH, maxLength: SEC_LENGTH }),
			ekm: fc.uint8Array({ minLength: EKM_LENGTH, maxLength: EKM_LENGTH }),
			pubs: fc.uint8Array({ minLength: 1, maxLength: 97 }),
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
				expect(pairingSas(values.ekm)).toMatch(/^[0-9]{6}$/);
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses a sec or EKM of another length, and a proof of another length never verifies", () => {
		const [sec, e, pubs] = [new Uint8Array(16), new Uint8Array(32), new Uint8Array(4)];
		expect(outcome(() => pairingProof(new Uint8Array(15), e, pubs))).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => pairingProof(sec, new Uint8Array(31), pubs))).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => pairingSas(new Uint8Array(33)))).toBe("PAIR_INVALID_INPUT");
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
		const claim = makePairingClaim(sidecar, device, ekm);
		expect(verifyPairingClaim(readPairingClaim(canonicalize(claim)), sidecar, connection)).toBe(
			undefined,
		);
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
			expect(pairingSas(live.ekm)).toBe(item.sas);
		}
	});

	it("is made byte for byte as the accepted vector, binding the keys as the skeleton does", () => {
		const accepted = claims.cases.find((item) => item.id === "device");
		const claim = makePairingClaim(window, device, ekm);
		expect(canonicalize(claim)).toBe(accepted?.body);
		const pubs = pairingPubs(device.transportSpkiSha256, device.signingKey);
		expect(pubs.length).toBe(32 + 65);
		expect(hex(pubs.subarray(0, 32))).toBe(device.transportSpkiSha256);
		expect(pubs[32]).toBe(0x04);
		const der = fromBase64Url(device.signingKey) ?? new Uint8Array();
		expect(Buffer.from(pubs.subarray(32)).equals(der.subarray(der.length - 65))).toBe(true);
		expect(verifyPairingClaim(claim, window, connection)).toBeUndefined();
	});

	it("refuses keys and inputs outside their forms", () => {
		expect(
			outcome(() => pairingPubs(device.transportSpkiSha256.toUpperCase(), device.signingKey)),
		).toBe("PAIR_INVALID_INPUT");
		expect(outcome(() => pairingPubs(device.transportSpkiSha256, "AAAA"))).toBe(
			"PAIR_INVALID_INPUT",
		);
		expect(outcome(() => makePairingClaim(window, { ...device, name: "" }, ekm))).toBe(
			"PAIR_INVALID_INPUT",
		);
		expect(outcome(() => makePairingClaim({ ...window, sec: "AAAA" }, device, ekm))).toBe(
			"PAIR_INVALID_INPUT",
		);
		const claim = makePairingClaim(window, device, ekm);
		const unchecked = { ...claim, proof: claim.proof.toUpperCase() };
		expect(verifyPairingClaim(unchecked, window, connection)).toBe("PAIR_CLAIM_INVALID");
		expect(
			outcome(() => verifyPairingClaim(claim, window, { ...connection, ekm: new Uint8Array(31) })),
		).toBe("PAIR_INVALID_INPUT");
	});

	it("answers with a strict result or a refusal code", () => {
		const result = { deviceId: "01JAZ3W3B6Q8M2V0G5T9K4X7RC", epoch: 1 };
		expect(PairingResult.parse(result)).toEqual(result);
		for (const bad of [
			{ ...result, epoch: -1 },
			{ ...result, hubStatementKey: "x" },
			{ deviceId: "x", epoch: 1 },
		]) {
			expect(PairingResult.safeParse(bad).success).toBe(false);
		}
		expect(PairingRefusal.shape.code.options).toEqual([
			"PAIR_WINDOW_CLOSED",
			"PAIR_CLAIM_INVALID",
			"PAIR_ROLE_MISMATCH",
			"PAIR_PROOF_INVALID",
		]);
		expect(PairingRefusal.safeParse({ code: "PAIR_PROOF_INVALID", detail: "x" }).success).toBe(
			false,
		);
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
		expect([EKM_LENGTH, PID_LENGTH, SEC_LENGTH]).toEqual([32, 16, 16]);
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
			const body = canonicalize(hosts.makePairingClaim(hostWindow, device, ekm));
			const claim = hosts.readPairingClaim(body);
			expect(hosts.verifyPairingClaim(claim, hostWindow, connection)).toBeUndefined();
			expect(hosts.verifyPairingClaim(claim, window, connection)).toBe("PAIR_ROLE_MISMATCH");
			const deviceClaim = hosts.makePairingClaim(window, device, ekm);
			expect(hosts.verifyPairingClaim(deviceClaim, hostWindow, connection)).toBe(
				"PAIR_ROLE_MISMATCH",
			);
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
