import { generateKeyPairSync, type KeyObject } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../scripts/vectors/sign.ts";
import { headersSha256, sha256Hex } from "../../src/hash.ts";
import { canonicalize, isCanonical, parseStrict } from "../../src/jcs.ts";
import { toBase64Url } from "../../src/scalars.ts";
import {
	exportSpki,
	openStatement,
	signingInput,
	signStatement,
	verifyStatement,
} from "../../src/sign.ts";
import { hex, outcome, utf8, vectorFiles } from "../vectors.ts";
import { type Answer, startXcheck, type Xcheck } from "./xcheck.ts";

interface Key {
	readonly privateKey: KeyObject;
	readonly pkcs8: string;
	readonly spki: string;
}

function newKey(): Key {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const pkcs8 = toBase64Url(privateKey.export({ type: "pkcs8", format: "der" }));
	return { privateKey, pkcs8, spki: exportSpki(publicKey) };
}

// What @draftyak/protocol makes of the bytes, in xcheck's jcs answer shape.
function tsJcs(input: Uint8Array): Answer {
	const code = outcome(() => parseStrict(input));
	if (code !== "accepted") return { error: code, isCanonical: false };
	const canonical = utf8(canonicalize(parseStrict(input)));
	return {
		canonicalHex: hex(canonical),
		sha256: sha256Hex(canonical),
		isCanonical: isCanonical(input),
	};
}

// Whether openStatement opens the bytes, or the code it throws.
function tsVerdict(typ: string, received: Uint8Array, signature: string, spki: string): unknown {
	try {
		return openStatement(typ, received, signature, spki) !== undefined;
	} catch (error) {
		return (error as { code?: unknown }).code ?? error;
	}
}

// A small linear congruential generator, so one fast-check seed drives a whole rewrite.
const lcg = (seed: number): ((bound: number) => number) => {
	let state = seed >>> 0;
	return (bound) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state % bound;
	};
};

// JSON text for `value`, written differently each time: members in any order, JSON's four
// whitespace characters, \u and short escapes in either case, and other spellings of numbers.
// Lone surrogates are always escaped, and a non-finite number is written as one that overflows.
function rewrite(value: unknown, seed: number): string {
	const pick = lcg(seed);
	const space = (): string => " \t\n\r".charAt(pick(4)).repeat(pick(3) === 0 ? pick(3) : 0);
	const unit = (code: number): string => {
		const escaped = `\\u${code.toString(16).padStart(4, "0")}`;
		return pick(2) === 0 ? escaped : escaped.toUpperCase().replace("\\U", "\\u");
	};
	const short: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f" };
	Object.assign(short, { "\n": "\\n", "\r": "\\r", "\t": "\\t" });
	const string = (text: string): string => {
		let out = '"';
		for (const char of text) {
			const code = char.codePointAt(0) ?? 0;
			const lone = code >= 0xd800 && code <= 0xdfff;
			if (lone || (code < 0x20 && short[char] === undefined) || pick(8) === 0) {
				for (let i = 0; i < char.length; i++) out += unit(char.charCodeAt(i));
			} else if (short[char] !== undefined) out += pick(4) === 0 ? unit(code) : short[char];
			else if (char === "/" && pick(2) === 0) out += "\\/";
			else out += char;
		}
		return `${out}"`;
	};
	const number = (n: number): string => {
		if (Number.isNaN(n)) return pick(2) === 0 ? "NaN" : "null";
		if (!Number.isFinite(n)) return n > 0 ? "1e400" : "-1e400";
		const forms = [JSON.stringify(n), n.toExponential(), n.toPrecision(17)];
		if (Number.isInteger(n) && Math.abs(n) < 1e21) forms.push(`${n}.0`, `${n}e0`, `${n}E+00`);
		return forms[pick(forms.length)] ?? JSON.stringify(n);
	};
	const write = (item: unknown): string => {
		if (item === null || typeof item === "boolean") return String(item);
		if (typeof item === "number") return number(item);
		if (typeof item === "string") return string(item);
		if (Array.isArray(item))
			return `[${space()}${item.map(write).join(`${space()},${space()}`)}${space()}]`;
		const record = item as Record<string, unknown>;
		const keys = Object.keys(record);
		for (let i = keys.length - 1; i > 0; i--) {
			const j = pick(i + 1);
			[keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
		}
		const members = keys.map(
			(key) => `${space()}${string(key)}${space()}:${space()}${write(record[key])}${space()}`,
		);
		return `{${members.join(",")}${members.length === 0 ? space() : ""}}`;
	};
	return `${space()}${write(value)}${space()}`;
}

// Any code point, lone surrogates included, though mostly printable ASCII.
const codePoint = fc.oneof(
	{ weight: 3, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
	{ weight: 2, arbitrary: fc.integer({ min: 0, max: 0x10ffff }) },
	{ weight: 1, arbitrary: fc.constantFrom(0, 0x1f, 0x7f, 0x2028, 0xd800, 0xdfff, 0xfeff, 0x1f600) },
);
const text = fc.string({
	unit: codePoint.map((code) => String.fromCodePoint(code)),
	maxLength: 10,
});
const numbers = fc.oneof(
	fc.integer(),
	fc.maxSafeInteger(),
	fc.double(),
	fc.constantFrom(2 ** 53, 2 ** 53 + 2, -(2 ** 63), 2 ** 64, 1e21, 1e-7, 5e-324, Number.MAX_VALUE),
);
const { value: values } = fc.letrec<{ value: unknown; list: unknown[]; record: object }>((tie) => ({
	value: fc.oneof(
		{ depthSize: "small" },
		fc.constant(null),
		fc.boolean(),
		numbers,
		text,
		tie("list"),
		tie("record"),
	),
	list: fc.array(tie("value"), { maxLength: 5 }),
	record: fc.dictionary(text, tie("value"), { maxKeys: 5 }),
}));

// Decimal text read as a double: digits and exponents a double holds, overflows and underflows.
const decimal = fc
	.tuple(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }), fc.integer({ min: -360, max: 330 }))
	.map(([digits, exponent]) => `${digits}e${exponent}`);

// Containers 55 to 70 deep, around the 64 both sides allow.
const deep = fc.tuple(fc.integer({ min: 55, max: 70 }), fc.nat()).map(([depth, seed]) => {
	const pick = lcg(seed);
	let out = "0";
	for (let i = 0; i < depth; i++) out = pick(2) === 0 ? `[${out}]` : `{"k${pick(3)}":${out}}`;
	return out;
});

// Bytes the parser must refuse or read with care.
const edit = fc.constantFrom(
	...[...'{}[]":,\\/ \t\n\r-+.0123456789eEtfnul'].map((c) => c.charCodeAt(0)),
	0x00,
	0x0b,
	0x0c,
	0x1f,
	0x7f,
	0x80,
	0xa0,
	0xbf,
	0xc0,
	0xc3,
	0xed,
	0xef,
	0xf4,
	0xff,
);

const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/);
const typs = fc.oneof(
	{
		weight: 9,
		arbitrary: fc
			.tuple(fc.array(segment, { minLength: 1, maxLength: 3 }), fc.integer({ min: 1, max: 120 }))
			.map(([segments, major]) => `${segments.join(".")}.v${major}`),
	},
	{
		weight: 1,
		arbitrary: fc.constantFrom("", "v1", "a.V1", "a.v0", "a.v01", "1a.v1", "a..v1", "a.v1\n"),
	},
);
const grapheme = fc.string({ unit: "grapheme", maxLength: 8 });
const { statement: statements } = fc.letrec<{
	statement: unknown;
	body: unknown;
	list: unknown[];
	record: object;
}>((tie) => ({
	statement: fc.oneof(
		{ weight: 12, arbitrary: fc.dictionary(grapheme, tie("body"), { minKeys: 1, maxKeys: 6 }) },
		{ weight: 1, arbitrary: tie("body") },
	),
	body: fc.oneof(
		{ depthSize: "small" },
		{
			weight: 12,
			arbitrary: fc.oneof(fc.maxSafeInteger(), grapheme, fc.boolean(), fc.constant(null)),
		},
		{ weight: 1, arbitrary: fc.constantFrom(0.5, 2 ** 53, -(2 ** 53), 1e21, 1.5e-7) },
		{ weight: 3, arbitrary: tie("list") },
		{ weight: 3, arbitrary: tie("record") },
	),
	list: fc.array(tie("body"), { maxLength: 4 }),
	record: fc.dictionary(grapheme, tie("body"), { maxKeys: 4 }),
}));

interface SignCase {
	readonly id: string;
	readonly typ: string;
	readonly statement?: unknown;
	readonly receivedHex?: string;
	readonly publicKeySpki: string;
	readonly signature: string;
	readonly rfc6979Signature?: string;
	readonly jcs?: string;
	readonly signingInputHex: string;
	readonly error?: string;
	readonly valid: boolean;
}
interface SignVectors {
	readonly keys: { readonly signer: { readonly privateKeyPkcs8: string } };
	readonly cases: readonly SignCase[];
}
const signVectors = vectorFiles<SignVectors>("sign")[0]?.[1];
const jcsCases = vectorFiles<{ cases: { input?: string; inputHex?: string }[] }>("jcs").flatMap(
	([, file]) => file.cases,
);

describe("TS and Rust", { tags: ["requires:cargo"] }, () => {
	let rust: Xcheck;
	const keys = [newKey(), newKey(), newKey()];

	beforeAll(async () => {
		rust = await startXcheck();
	});
	afterAll(async () => {
		await rust?.close();
	});

	// Whether both accept the bytes, once both answer alike.
	const jcsBoth = async (input: Uint8Array): Promise<boolean> => {
		const expected = tsJcs(input);
		expect(await rust.run("jcs", { inputHex: hex(input) })).toEqual(expected);
		return expected.error === undefined;
	};

	it("read every jcs vector alike", async () => {
		for (const { input, inputHex } of jcsCases) {
			if (input !== undefined) await jcsBoth(utf8(input));
			if (inputHex !== undefined) await jcsBoth(Buffer.from(inputHex, "hex"));
		}
	});

	it("give identical JCS and SHA-256 for at least 500 values written any way", async () => {
		let compared = 0;
		await fc.assert(
			fc.asyncProperty(values, fc.nat(), async (value, seed) => {
				if (await jcsBoth(utf8(rewrite(value, seed)))) compared++;
			}),
			{ numRuns: 700 },
		);
		expect(compared).toBeGreaterThanOrEqual(500);
	});

	it("read decimal text as the same double, overflow included (500 runs)", async () => {
		await fc.assert(
			fc.asyncProperty(decimal, async (number) => {
				await jcsBoth(utf8(`[${number}]`));
			}),
			{ numRuns: 500 },
		);
	});

	it("refuse nesting beyond 64 alike (150 runs)", async () => {
		await fc.assert(
			fc.asyncProperty(deep, async (text) => {
				await jcsBoth(utf8(text));
			}),
			{ numRuns: 150 },
		);
	});

	it("refuse broken documents with the same code (600 runs)", async () => {
		const edits = fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 2 }), edit), {
			minLength: 1,
			maxLength: 3,
		});
		await fc.assert(
			fc.asyncProperty(values, fc.nat(), edits, async (value, seed, changes) => {
				const bytes = [...utf8(rewrite(value, seed))];
				for (const [at, kind, byte] of changes) {
					const index = at % (bytes.length + 1);
					if (kind === 0) bytes.splice(index, 0, byte);
					else if (kind === 1) bytes.splice(index, 1, byte);
					else bytes.splice(index, 1);
				}
				await jcsBoth(Uint8Array.from(bytes));
			}),
			{ numRuns: 600 },
		);
	});

	it("hash header lists alike (300 runs)", async () => {
		const name = fc.oneof(
			{ weight: 6, arbitrary: fc.stringMatching(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,12}$/) },
			{ weight: 1, arbitrary: fc.constantFrom("", "Content Type", "X-\u{c9}", "a:b") },
		);
		const content = fc.oneof(
			{ weight: 6, arbitrary: fc.stringMatching(/^(?:[!-~](?:[\t -~]{0,10}[!-~])?)?$/) },
			{ weight: 1, arbitrary: fc.constantFrom(" a", "a\t", "a\r\nb", "caf\u{e9}") },
		);
		await fc.assert(
			fc.asyncProperty(fc.array(fc.tuple(name, content), { maxLength: 5 }), async (headers) => {
				const code = outcome(() => headersSha256(headers));
				const expected = code === "accepted" ? { sha256: headersSha256(headers) } : { error: code };
				expect(await rust.run("sha256", { headers })).toEqual(expected);
			}),
			{ numRuns: 300 },
		);
	});

	// Rust signs what TS would sign, TS verifies it, Rust verifies TS's signature, and neither
	// verifies the statement with one byte changed; or both refuse it with the same code.
	const bothWays = async (statement: unknown, typ: string, key: Key, flip: number) => {
		const signed = await rust.run("sign", { privateKeyPkcs8: key.pkcs8, typ, statement });
		const code = outcome(() => signingInput(typ, statement as object));
		if (code !== "accepted") {
			expect(signed).toEqual({ error: code });
			return false;
		}
		const input = signingInput(typ, statement as object);
		expect(signed).toEqual({
			signature: expect.any(String),
			signingInputHex: hex(input),
			publicKeySpki: key.spki,
		});
		const fromRust = signed.signature as string;
		expect(verifyStatement(typ, statement as object, fromRust, key.spki)).toBe(true);
		const fromTs = signStatement(typ, statement as object, key.privateKey);
		const received = utf8(canonicalize(statement));
		const fields = { typ, signature: fromTs, publicKeySpki: key.spki };
		const opened = await rust.run("verify", { ...fields, receivedHex: hex(received) });
		expect(opened.valid).toBe(true);
		expect(canonicalize(opened.statement)).toBe(canonicalize(statement));
		const tampered = Uint8Array.from(received);
		const at = flip % tampered.length;
		tampered[at] = (tampered[at] ?? 0) ^ 1;
		const refused = await rust.run("verify", { ...fields, receivedHex: hex(tampered) });
		expect(refused).toEqual({ valid: false });
		expect(openStatement(typ, tampered, fromTs, key.spki)).toBeUndefined();
		return true;
	};

	it("sign at least 500 statements both ways, each verifying the other's signatures", async () => {
		const key = keys[0] as Key;
		// Raw in JSON text, and line ends to readline: xcheck's answers end at \n only.
		await bothWays({ "\u{2028}": "\u{2029}", "\u{85}": ["\u{feff}"] }, "login.v1", key, 3);
		await bothWays(JSON.parse('{"__proto__":{"a":1},"b":[]}'), "approval.send.v1", key, 7);
		await bothWays({}, "test-2.statement-x.v10", key, 1);
		let signed = 0;
		await fc.assert(
			fc.asyncProperty(
				statements,
				typs,
				fc.nat(keys.length - 1),
				fc.nat(),
				async (s, typ, i, at) => {
					if (await bothWays(s, typ, keys[i] as Key, at)) signed++;
				},
			),
			{ numRuns: 1000 },
		);
		expect(signed).toBeGreaterThanOrEqual(500);
	});

	it("verify every sign vector alike and re-sign its RFC 6979 signatures byte for byte", async () => {
		if (signVectors === undefined) throw new Error("spec/vectors/sign/ is missing");
		const signer = signVectors.keys.signer.privateKeyPkcs8;
		let made = 0;
		for (const item of signVectors.cases) {
			const received = Buffer.from(item.receivedHex ?? hex(utf8(item.jcs ?? "")), "hex");
			const expected = item.error === "SIGN_INVALID_TYP" ? item.error : item.valid;
			for (const signature of [item.signature, item.rfc6979Signature]) {
				if (signature === undefined) continue;
				const fields = { typ: item.typ, signature, publicKeySpki: item.publicKeySpki };
				const answer = await rust.run("verify", { ...fields, receivedHex: hex(received) });
				expect(answer.error ?? answer.valid, item.id).toBe(expected);
				expect(tsVerdict(item.typ, received, signature, item.publicKeySpki), item.id).toBe(
					expected,
				);
			}
			if (item.rfc6979Signature !== undefined) {
				const fields = { privateKeyPkcs8: signer, inputHex: item.signingInputHex };
				expect(await rust.run("sign", fields), item.id).toEqual({
					signature: item.rfc6979Signature,
				});
			}
			// The crate's own sign, from the statement, makes the same bytes, S as computed.
			if (item.rfc6979Signature !== undefined && item.error === undefined && item.jcs) {
				const fields = { privateKeyPkcs8: signer, typ: item.typ, statement: item.statement };
				expect(await rust.run("sign", fields), item.id).toEqual({
					signature: item.rfc6979Signature,
					signingInputHex: item.signingInputHex,
					publicKeySpki: item.publicKeySpki,
				});
				made++;
			}
		}
		expect(made).toBeGreaterThanOrEqual(2);
	});

	it("refuse the valid vector with any one byte changed, in both languages", async () => {
		const valid = signVectors?.cases.find(({ id }) => id === "valid");
		if (valid?.jcs === undefined) throw new Error("the valid sign vector is missing");
		const parts = {
			receivedHex: hex(utf8(valid.jcs)),
			signature: hex(Buffer.from(valid.signature, "base64url")),
			publicKeySpki: hex(Buffer.from(valid.publicKeySpki, "base64url")),
		};
		for (const [part, original] of Object.entries(parts)) {
			for (let at = 0; at < original.length / 2; at++) {
				const bytes = Buffer.from(original, "hex");
				bytes[at] = (bytes[at] ?? 0) ^ 0x01;
				const changed = { ...parts, [part]: bytes.toString("hex") };
				const signature = Buffer.from(changed.signature, "hex").toString("base64url");
				const spki = Buffer.from(changed.publicKeySpki, "hex").toString("base64url");
				const received = Buffer.from(changed.receivedHex, "hex");
				const fields = { typ: valid.typ, signature, publicKeySpki: spki };
				const answer = await rust.run("verify", { ...fields, receivedHex: changed.receivedHex });
				expect(answer, `${part} byte ${at}`).toEqual({ valid: false });
				expect(
					openStatement(valid.typ, received, signature, spki),
					`${part} byte ${at}`,
				).toBeUndefined();
			}
		}
	});
});

describe("the sign vector generator", () => {
	it("checks RFC 6979 signatures without cargo and fails on a missing one", async () => {
		if (signVectors === undefined) throw new Error("spec/vectors/sign/ is missing");
		const cases = signVectors.cases.map((item) =>
			item.id === "valid" ? { ...item, rfc6979Signature: undefined } : item,
		);
		await expect(generate({ previous: () => ({ ...signVectors, cases }) })).rejects.toThrow(
			"sign valid: rfc6979Signature: it is missing or doesn't verify",
		);
	});
});
