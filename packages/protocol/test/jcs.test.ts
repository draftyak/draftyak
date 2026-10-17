import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/hash.ts";
import { canonicalize, isCanonical, JCS_MAX_DEPTH, parseStrict } from "../src/jcs.ts";
import { hex, outcome, utf8, vectorFiles } from "./vectors.ts";

interface JcsCase {
	readonly id: string;
	readonly input?: string;
	readonly inputHex?: string;
	readonly ieee754?: string;
	readonly canonical?: string;
	readonly canonicalHex?: string;
	readonly sha256?: string;
	readonly error?: string;
}

const files = vectorFiles<{ format: string; cases: JcsCase[] }>("jcs");
const double = (bits: string): number => Buffer.from(bits, "hex").readDoubleBE(0);
const nested = (depth: number): unknown => (depth === 0 ? [] : [nested(depth - 1)]);

describe("the jcs vectors", () => {
	it("cover RFC 8785, the edges and the refusals", () => {
		expect(files.map(([file]) => file)).toEqual(["edges.json", "refusals.json", "rfc8785.json"]);
		for (const [, { format }] of files) expect(format).toBe("draftyak.vectors.jcs.v1");
	});

	for (const [file, { cases }] of files) {
		it.each(cases.map((item) => [item.id, item] as const))(`${file}: %s`, (_, item) => {
			const input = item.inputHex === undefined ? item.input : Buffer.from(item.inputHex, "hex");
			if (item.ieee754 !== undefined) {
				const run = (): string => canonicalize(double(item.ieee754 as string));
				expect(item.error === undefined ? run() : outcome(run)).toBe(item.error ?? item.canonical);
				return;
			}
			if (input === undefined) throw new Error(`${item.id} has no input`);
			if (item.error !== undefined) {
				expect(outcome(() => parseStrict(input))).toBe(item.error);
				expect(isCanonical(input)).toBe(false);
				return;
			}
			const canonical = canonicalize(parseStrict(input));
			const bytes = utf8(canonical);
			expect(canonical).toBe(item.canonical);
			expect(hex(bytes)).toBe(item.canonicalHex);
			expect(sha256Hex(bytes)).toBe(item.sha256);
			expect(isCanonical(bytes)).toBe(true);
			expect(isCanonical(input)).toBe(input === canonical);
		});
	}
});

const json = fc.jsonValue({ maxDepth: 6, stringUnit: "binary" });

// A seeded Fisher-Yates shuffle.
function shuffle<T>(items: readonly T[], seed: number): T[] {
	const out = [...items];
	let state = seed >>> 0;
	for (let i = out.length - 1; i > 0; i--) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		const j = state % (i + 1);
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

// Rebuilds every object with its members inserted in another order.
function reorder(value: unknown, seed: number): unknown {
	if (Array.isArray(value)) return value.map((item) => reorder(item, seed + 1));
	if (value === null || typeof value !== "object") return value;
	const entries = shuffle(Object.entries(value), seed);
	return Object.fromEntries(entries.map(([key, item]) => [key, reorder(item, seed + 1)]));
}

describe("canonicalize", () => {
	it("is idempotent through parseStrict and reads like JSON.parse (1,000 runs)", () => {
		fc.assert(
			fc.property(json, (value) => {
				const canonical = canonicalize(value);
				expect(canonicalize(parseStrict(canonical))).toBe(canonical);
				expect(isCanonical(canonical)).toBe(true);
				const pretty = JSON.stringify(value, null, 2);
				expect(parseStrict(utf8(pretty))).toEqual(JSON.parse(pretty));
			}),
			{ numRuns: 1000 },
		);
	});

	it("doesn't depend on the order of members (1,000 runs)", () => {
		fc.assert(
			fc.property(json, fc.nat(), (value, seed) => {
				expect(canonicalize(reorder(value, seed))).toBe(canonicalize(value));
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses values JSON can't hold", () => {
		class Point {
			x = 1;
		}
		const sparse: unknown[] = [];
		sparse[1] = 1;
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const unsupported: unknown[] = [
			undefined,
			{ a: undefined },
			() => 1,
			Symbol("s"),
			1n,
			new Date(0),
			new Map(),
			new Point(),
			new Uint8Array(1),
			sparse,
		];
		for (const value of unsupported) {
			expect(outcome(() => canonicalize(value))).toBe("JCS_UNSUPPORTED_VALUE");
		}
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, [Number.NEGATIVE_INFINITY]]) {
			expect(outcome(() => canonicalize(value))).toBe("JCS_NUMBER_RANGE");
		}
		for (const value of ["\u{d800}", { "\u{dc00}": 1 }, ["a\u{d83d}"]]) {
			expect(outcome(() => canonicalize(value))).toBe("JCS_LONE_SURROGATE");
		}
		expect(outcome(() => canonicalize(cyclic))).toBe("JCS_TOO_DEEP");
	});

	it("allows exactly JCS_MAX_DEPTH nested containers, as parseStrict does", () => {
		expect(canonicalize(nested(JCS_MAX_DEPTH - 1))).toBe(
			`${"[".repeat(JCS_MAX_DEPTH)}${"]".repeat(JCS_MAX_DEPTH)}`,
		);
		expect(outcome(() => canonicalize(nested(JCS_MAX_DEPTH)))).toBe("JCS_TOO_DEEP");
	});

	it("takes null-prototype objects, and keeps a __proto__ member a member", () => {
		const bare = Object.assign(Object.create(null) as object, { b: 1, a: [true] });
		expect(canonicalize(bare)).toBe('{"a":[true],"b":1}');
		const parsed = parseStrict('{"__proto__":{"polluted":1}}') as Record<string, unknown>;
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
		expect(Object.keys(parsed)).toEqual(["__proto__"]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(canonicalize(parsed)).toBe('{"__proto__":{"polluted":1}}');
	});
});

describe("parseStrict and isCanonical", () => {
	it("read strings and UTF-8 bytes alike", () => {
		const text = '{"b":[1,"\u{e9}\u{1f600}"],"a":null}';
		expect(parseStrict(utf8(text))).toEqual(parseStrict(text));
		expect(parseStrict(text)).toEqual({ a: null, b: [1, "\u{e9}\u{1f600}"] });
	});

	it("refuse a lone surrogate in text, and a byte-order mark", () => {
		expect(outcome(() => parseStrict('["\u{d800}"]'))).toBe("JCS_LONE_SURROGATE");
		expect(outcome(() => parseStrict("\u{feff}{}"))).toBe("JCS_SYNTAX");
	});

	it("tell canonical text from equivalent text", () => {
		for (const text of ['{"a":1,"b":[]}', '"\u{e9}"', "1e+21", "null"]) {
			expect(isCanonical(text)).toBe(true);
		}
		const equivalent = [
			'{"b":[],"a":1}',
			'{"a":1, "b":[]}',
			'"\\u00e9"',
			"1e21",
			"1.0",
			"-0",
			" null",
		];
		for (const text of equivalent) expect(isCanonical(text)).toBe(false);
		expect(isCanonical(new Uint8Array([0x22, 0xff, 0x22]))).toBe(false);
	});
});
