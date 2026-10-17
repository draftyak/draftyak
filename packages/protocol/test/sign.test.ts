import {
	createPrivateKey,
	createPublicKey,
	ECDH,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/jcs.ts";
import { fromBase64Url, toBase64Url } from "../src/scalars.ts";
import {
	exportSpki,
	importSpki,
	openStatement,
	signingInput,
	signStatement,
	verifyStatement,
} from "../src/sign.ts";
import { hex, outcome, utf8, vectorFiles } from "./vectors.ts";

interface SignCase {
	readonly id: string;
	readonly typ: string;
	readonly statement?: object;
	readonly receivedHex?: string;
	readonly publicKeySpki: string;
	readonly signature: string;
	readonly jcs?: string;
	readonly signingInputHex: string;
	readonly error?: string;
	readonly valid: boolean;
}
interface RecordedKey {
	readonly testOnly: boolean;
	readonly privateKeyPkcs8: string;
	readonly publicKeySpki: string;
}
interface SignVectors {
	readonly format: string;
	readonly keys: { readonly signer: RecordedKey; readonly other: RecordedKey };
	readonly cases: SignCase[];
}

const vectors = vectorFiles<SignVectors>("sign").find(([file]) => file === "es256.json")?.[1];
if (vectors === undefined) throw new Error("spec/vectors/sign/es256.json is missing");
const pair = (curve = "P-256"): { privateKey: KeyObject; publicKey: KeyObject } =>
	generateKeyPairSync("ec", { namedCurve: curve });
const statement = {
	v: 1,
	device: "01JAZ3W3B6Q8M2V0G5T9K4X7RC",
	iat: 1792000000000,
	note: "\u{e9}",
};
// A correct ES256 signature over any bytes, as a careless signer would make it.
const rawSignature = (input: Uint8Array, key: KeyObject): string =>
	toBase64Url(sign("sha256", input, { key, dsaEncoding: "ieee-p1363" }));
const rawVerify = (input: Uint8Array, signature: string, key: KeyObject): boolean => {
	const bytes = fromBase64Url(signature) ?? new Uint8Array();
	return verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, bytes);
};
const loginInput = (body: Uint8Array): Uint8Array =>
	Buffer.concat([utf8("draftyak/v1/login.v1\n"), body]);
// What verification gives: true, false, or the code it throws.
function verdict(run: () => unknown): unknown {
	try {
		return run();
	} catch (error) {
		return (error as { code?: unknown }).code;
	}
}

describe("the sign vectors", () => {
	it("hold two test-only P-256 keys", () => {
		expect(vectors.format).toBe("draftyak.vectors.sign.v1");
		const { signer, other } = vectors.keys;
		for (const key of [signer, other]) {
			expect(key.testOnly).toBe(true);
			const der = Buffer.from(fromBase64Url(key.privateKeyPkcs8) ?? []);
			const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
			expect(exportSpki(createPublicKey(privateKey))).toBe(key.publicKeySpki);
		}
		expect(other.publicKeySpki).not.toBe(signer.publicKeySpki);
	});

	it("tamper with the statement, signature, key, typ and received bytes", () => {
		const expected = {
			valid: true,
			"statement-byte-changed": false,
			"signature-bit-flipped": false,
			"key-bit-flipped": false,
			"other-key": false,
			"typ-byte-changed": false,
			"der-encoded-signature": false,
			"zero-signature": false,
			"out-of-range-signature": false,
			"signature-not-canonical-base64url": false,
			"key-not-canonical-base64url": false,
			"key-compressed-point": false,
			"fraction-in-statement": false,
			"unsafe-integer-in-statement": false,
			"statement-is-string": false,
			"statement-is-array": false,
			"typ-digits-and-hyphens": true,
			"typ-upper-case-version": false,
			"typ-version-zero": false,
			"typ-version-leading-zero": false,
			"typ-segment-starting-with-digit": false,
			"received-inner-space": false,
			"received-trailing-line-feed": false,
			"received-members-in-other-order": false,
			"received-duplicate-member": false,
		};
		// Later cases may join; these stay.
		const recorded = Object.fromEntries(vectors.cases.map(({ id, valid }) => [id, valid]));
		expect(recorded).toMatchObject(expected);
		expect(new Set(vectors.cases.map(({ id }) => id)).size).toBe(vectors.cases.length);
	});

	it.each(vectors.cases.map((item) => [item.id, item] as const))("es256.json: %s", (_, item) => {
		const { typ, signature, publicKeySpki } = item;
		const input = Buffer.from(item.signingInputHex, "hex");
		if (item.receivedHex !== undefined) {
			const received = Buffer.from(item.receivedHex, "hex");
			expect(input).toEqual(Buffer.concat([utf8(`draftyak/v1/${typ}\n`), received]));
			expect(rawVerify(input, signature, importSpki(publicKeySpki))).toBe(true);
			expect(openStatement(typ, received, signature, publicKeySpki)).toBeUndefined();
			expect(verifyStatement(typ, received, signature, publicKeySpki)).toBe(item.valid);
			return;
		}
		const body = item.statement ?? {};
		expect(canonicalize(body)).toBe(item.jcs);
		expect(input.toString("utf8")).toBe(`draftyak/v1/${typ}\n${item.jcs}`);
		if (item.error === undefined) {
			expect(hex(signingInput(typ, body))).toBe(item.signingInputHex);
		} else {
			expect(outcome(() => signingInput(typ, body))).toBe(item.error);
			expect(rawVerify(input, signature, importSpki(publicKeySpki))).toBe(true);
		}
		const result = item.error === "SIGN_INVALID_TYP" ? item.error : item.valid;
		const received = utf8(item.jcs ?? "");
		expect(verdict(() => verifyStatement(typ, body, signature, publicKeySpki))).toBe(result);
		expect(verdict(() => verifyStatement(typ, received, signature, publicKeySpki))).toBe(result);
		const opened = verdict(() => openStatement(typ, received, signature, publicKeySpki));
		expect(opened).toEqual(result === true ? body : result === false ? undefined : result);
	});

	it("compress the signer's own key in key-compressed-point", () => {
		const item = vectors.cases.find(({ id }) => id === "key-compressed-point");
		const der = Buffer.from(fromBase64Url(item?.publicKeySpki ?? "") ?? []);
		const key = createPublicKey({ key: der, format: "der", type: "spki" });
		expect(der.length).toBe(59);
		expect(exportSpki(key)).toBe(vectors.keys.signer.publicKeySpki);
		const input = Buffer.from(item?.signingInputHex ?? "", "hex");
		expect(rawVerify(input, item?.signature ?? "", key)).toBe(true);
	});
});

describe("signStatement, openStatement and verifyStatement", () => {
	it("sign the UTF-8 of draftyak/v1/<typ>\\n and the JCS bytes", () => {
		const input = new TextDecoder().decode(signingInput("approval.send.v1", { b: 1, a: "\u{e9}" }));
		expect(input).toBe('draftyak/v1/approval.send.v1\n{"a":"\u{e9}","b":1}');
	});

	it("verify a fresh signature, as a statement and as its canonical bytes only", () => {
		const { privateKey, publicKey } = pair();
		const signature = signStatement("login.v1", statement, privateKey);
		const bytes = utf8(canonicalize(statement));
		expect(fromBase64Url(signature)?.length).toBe(64);
		expect(verifyStatement("login.v1", statement, signature, publicKey)).toBe(true);
		expect(verifyStatement("login.v1", statement, signature, exportSpki(publicKey))).toBe(true);
		expect(verifyStatement("login.v1", bytes, signature, publicKey)).toBe(true);
		expect(openStatement("login.v1", bytes, signature, exportSpki(publicKey))).toEqual(statement);
		const pretty = utf8(JSON.stringify(statement, null, 1));
		expect(verifyStatement("login.v1", pretty, signature, publicKey)).toBe(false);
		expect(verifyStatement("admin.v1", statement, signature, publicKey)).toBe(false);
		expect(verifyStatement("login.v1", statement, signature, pair().publicKey)).toBe(false);
		expect(openStatement("admin.v1", bytes, signature, publicKey)).toBeUndefined();
		expect(openStatement("login.v1", bytes, signature, pair().publicKey)).toBeUndefined();
	});

	it("open only bytes that are canonical JCS, even when the signature covers them", () => {
		const { privateKey, publicKey } = pair();
		for (const text of ['{"v":1, "a":2}', '{"v":1,"a":2}', '{"a":2,"a":2,"v":1}', '{"a":2}\n']) {
			const raw = utf8(text);
			const signature = rawSignature(loginInput(raw), privateKey);
			expect(openStatement("login.v1", raw, signature, publicKey)).toBeUndefined();
			expect(verifyStatement("login.v1", raw, signature, publicKey)).toBe(false);
		}
		const text = canonicalize(statement);
		const signature = rawSignature(loginInput(utf8(text)), privateKey);
		const asText = text as unknown as Uint8Array;
		expect(openStatement("login.v1", asText, signature, publicKey)).toBeUndefined();
	});

	it("take only JSON objects as statements, never received text as a string", () => {
		const { privateKey, publicKey } = pair();
		const text = canonicalize(statement);
		const signature = signStatement("login.v1", statement, privateKey);
		for (const body of [text, "x", 1, true, null, [statement], []]) {
			const value = body as object;
			expect(outcome(() => signingInput("login.v1", value))).toBe("SIGN_NOT_OBJECT");
			expect(outcome(() => signStatement("login.v1", value, privateKey))).toBe("SIGN_NOT_OBJECT");
			const jcs = utf8(canonicalize(body));
			const own = rawSignature(loginInput(jcs), privateKey);
			expect(verifyStatement("login.v1", value, own, publicKey)).toBe(false);
			expect(openStatement("login.v1", jcs, own, publicKey)).toBeUndefined();
		}
		expect(verifyStatement("login.v1", text as unknown as object, signature, publicKey)).toBe(
			false,
		);
		const bare = Object.assign(Object.create(null) as object, statement);
		expect(verifyStatement("login.v1", bare, signature, publicKey)).toBe(true);
	});

	it("allow only safe integers as numbers, at any depth", () => {
		const { privateKey, publicKey } = pair();
		const unsafe = [1.5, 2 ** 53, -(2 ** 53), 1e21, 5e-324];
		for (const number of unsafe) {
			for (const body of [{ n: number }, { a: [1, { n: number }] }]) {
				expect(outcome(() => signingInput("login.v1", body))).toBe("SIGN_UNSAFE_NUMBER");
				expect(outcome(() => signStatement("login.v1", body, privateKey))).toBe(
					"SIGN_UNSAFE_NUMBER",
				);
				const jcs = utf8(canonicalize(body));
				const signature = rawSignature(loginInput(jcs), privateKey);
				expect(verifyStatement("login.v1", body, signature, publicKey)).toBe(false);
				expect(verifyStatement("login.v1", jcs, signature, publicKey)).toBe(false);
				expect(openStatement("login.v1", jcs, signature, publicKey)).toBeUndefined();
			}
		}
		const safe = { n: [0, -0, -1, 2 ** 53 - 1, -(2 ** 53 - 1)] };
		const signature = signStatement("login.v1", safe, privateKey);
		expect(verifyStatement("login.v1", utf8(canonicalize(safe)), signature, publicKey)).toBe(true);
	});

	it("fail, never throw, on a malformed signature, key or statement", () => {
		const { privateKey, publicKey } = pair();
		const signature = signStatement("login.v1", statement, privateKey);
		const bytes = fromBase64Url(signature) ?? new Uint8Array();
		const order = Buffer.from(
			"ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
			"hex",
		);
		const scalars = [
			new Uint8Array(64),
			new Uint8Array(64).fill(255),
			Buffer.concat([bytes.subarray(0, 32), new Uint8Array(32)]),
			Buffer.concat([order, bytes.subarray(32)]),
		].map(toBase64Url);
		const malformed = [`${signature}=`, signature.slice(1), "", "!".repeat(86), 42, ...scalars];
		const canonical = utf8(canonicalize(statement));
		for (const bad of malformed) {
			expect(verifyStatement("login.v1", statement, bad as string, publicKey)).toBe(false);
			expect(openStatement("login.v1", canonical, bad as string, publicKey)).toBeUndefined();
		}
		expect(verifyStatement("login.v1", statement, toBase64Url(bytes.subarray(1)), publicKey)).toBe(
			false,
		);
		for (const key of ["", "AAAA", exportSpki(publicKey).slice(2)]) {
			expect(verifyStatement("login.v1", statement, signature, key)).toBe(false);
			expect(openStatement("login.v1", canonical, signature, key)).toBeUndefined();
		}
		for (const raw of [new Uint8Array([0xff]), utf8('{"a":1,"a":1}'), utf8("")]) {
			expect(verifyStatement("login.v1", raw, signature, publicKey)).toBe(false);
		}
		for (const body of [{ a: undefined }, { a: "\u{d800}" }, { a: Number.NaN }]) {
			expect(verifyStatement("login.v1", body, signature, publicKey)).toBe(false);
		}
	});

	it("refuse a malformed typ and keys that aren't P-256", () => {
		const malformed = [
			"",
			"Login.v1",
			"login.V1",
			"login",
			"login.v0",
			"login.v01",
			"login.2fa.v1",
			"login.v1\n",
			"a..v1",
			"login.v1 ",
		];
		for (const typ of malformed) {
			expect(outcome(() => signingInput(typ, {}))).toBe("SIGN_INVALID_TYP");
			expect(outcome(() => verifyStatement(typ, utf8("{}"), "", pair().publicKey))).toBe(
				"SIGN_INVALID_TYP",
			);
			expect(outcome(() => verifyStatement(typ, {}, "", "AAAA"))).toBe("SIGN_INVALID_TYP");
			expect(outcome(() => openStatement(typ, utf8("{}"), "", "AAAA"))).toBe("SIGN_INVALID_TYP");
		}
		const { privateKey, publicKey } = pair("P-384");
		expect(outcome(() => signStatement("login.v1", {}, privateKey))).toBe("SIGN_INVALID_KEY");
		expect(outcome(() => signStatement("login.v1", {}, pair().publicKey))).toBe("SIGN_INVALID_KEY");
		expect(outcome(() => exportSpki(publicKey))).toBe("SIGN_INVALID_KEY");
		expect(outcome(() => verifyStatement("login.v1", {}, "", publicKey))).toBe("SIGN_INVALID_KEY");
		expect(outcome(() => openStatement("login.v1", utf8("{}"), "", publicKey))).toBe(
			"SIGN_INVALID_KEY",
		);
	});
});

describe("SPKI", () => {
	it("round-trips the 91-byte uncompressed P-256 form", () => {
		const { publicKey } = pair();
		const spki = exportSpki(publicKey);
		expect(fromBase64Url(spki)?.length).toBe(91);
		expect(exportSpki(importSpki(spki))).toBe(spki);
	});

	it("refuses other curves, other key types, compressed points and loose base64url", () => {
		const { publicKey } = pair();
		const uncompressed = Buffer.from(fromBase64Url(exportSpki(publicKey)) ?? []).subarray(26);
		const point = ECDH.convertKey(uncompressed, "prime256v1", undefined, undefined, "compressed");
		const header = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");
		const compressed = toBase64Url(Buffer.concat([header, point as Buffer]));
		expect(
			createPublicKey({
				key: Buffer.from(fromBase64Url(compressed) ?? []),
				format: "der",
				type: "spki",
			}).asymmetricKeyType,
		).toBe("ec");
		const others = [
			spkiOf(pair("P-384").publicKey),
			spkiOf(generateKeyPairSync("ed25519").publicKey),
			compressed,
			`${exportSpki(publicKey)}=`,
			"not a key",
		];
		for (const spki of others) expect(outcome(() => importSpki(spki))).toBe("SIGN_INVALID_KEY");
	});
});

function spkiOf(key: KeyObject): string {
	return toBase64Url(key.export({ type: "spki", format: "der" }));
}
