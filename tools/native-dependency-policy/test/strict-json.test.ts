import { describe, expect, it } from "vitest";
import { InputError, type JsonLimits, parseStrictJson } from "../src/strict-json.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const parse = (text: string, limits?: Partial<JsonLimits>): unknown =>
	parseStrictJson(encode(text), limits);

function refuses(input: Uint8Array, limits?: Partial<JsonLimits>): void {
	expect(() => parseStrictJson(input, limits)).toThrow(InputError);
	try {
		parseStrictJson(input, limits);
	} catch (error) {
		expect(error).toMatchObject({
			name: "InputError",
			code: "INVALID_INPUT",
			message: "invalid JSON input",
		});
	}
}

describe("strict UTF-8 JSON input", () => {
	it("reads ordinary JSON values without importing protocol behavior", () => {
		for (const text of [
			"null",
			"true",
			"false",
			"0",
			"-0",
			"1.25",
			"1e3",
			"-1.25e-3",
			"[]",
			"{}",
			' { "packages": [{"name":"synthetic", "features":[]}], "resolve": null }\r\n',
		]) {
			expect(JSON.stringify(parse(text))).toBe(JSON.stringify(JSON.parse(text)));
		}
		expect(Object.is(parse("-0"), -0)).toBe(true);
	});

	it("decodes every JSON escape and supplementary scalars", () => {
		expect(parse('"\\"\\\\\\/\\b\\f\\n\\r\\t"')).toBe('"\\/\b\f\n\r\t');
		expect(parse('"\\u0000\\u00E9\\uD83D\\uDE00"')).toBe("\0é😀");
		expect(parse('"é😀"')).toBe("é😀");
	});

	it("keeps normalization-distinct names and equal names in different records", () => {
		const result = parse('{"é":1,"e\\u0301":2,"a":{"same":3},"b":{"same":4}}');
		expect(JSON.stringify(result)).toBe('{"é":1,"é":2,"a":{"same":3},"b":{"same":4}}');
	});

	it.each([
		'{"a":1,"a":2}',
		'{"a":1,"\\u0061":2}',
		'{"/":1,"\\/":2}',
		'{"😀":1,"\\ud83d\\ude00":2}',
		'{"nested":[{"key":1,"\\u006bey":2}]}',
	])("refuses repeated decoded member names: %s", (text) => {
		refuses(encode(text));
	});

	it("represents prototype-sensitive keys as data on null-prototype records", () => {
		const result = parse(
			'{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}',
		) as Record<string, unknown>;
		expect(Object.getPrototypeOf(result)).toBe(null);
		expect(Object.hasOwn(result, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(Object.getOwnPropertyDescriptor(result, "__proto__")?.value)).toBe(
			null,
		);
		expect(Object.getPrototypeOf(result.constructor)).toBe(null);
		expect(Object.hasOwn({}, "polluted")).toBe(false);
	});

	it.each([
		[0x22, 0xff, 0x22],
		[0x22, 0xc0, 0xaf, 0x22],
		[0x22, 0xc2, 0x22],
		[0x22, 0xed, 0xa0, 0x80, 0x22],
		[0x22, 0xf4, 0x90, 0x80, 0x80, 0x22],
	])("refuses invalid UTF-8 inside an otherwise quoted string: %j", (...bytes) => {
		refuses(new Uint8Array(bytes));
	});

	it.each(['"\\ud800"', '"\\udc00"', '"\\ud800\\u0000"', '"\\ud800x"'])(
		"refuses lone or incorrectly paired escaped surrogates: %s",
		(text) => refuses(encode(text)),
	);

	it.each([
		"9007199254740992",
		"-9007199254740992",
		"1e20",
		"1e999",
		"-1e999",
		"1e-999",
		"NaN",
		"Infinity",
	])("refuses unsafe, overflowing or underflowing numbers: %s", (text) => {
		refuses(encode(text));
	});

	it("accepts the safe integer limits and finite fractional numbers", () => {
		expect(parse("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
		expect(parse("-9007199254740991")).toBe(Number.MIN_SAFE_INTEGER);
		expect(parse("5e-324")).toBe(Number.MIN_VALUE);
		expect(parse("0.125")).toBe(0.125);
	});

	it.each([
		"",
		" ",
		"01",
		"+1",
		".1",
		"1.",
		"1e",
		"1e+",
		"true false",
		"nullx",
		"[1,]",
		"[,1]",
		'{"a":1,}',
		'{"a" 1}',
		"{a:1}",
		"[1",
		'"unterminated',
		'"\\x20"',
		'"\\uXYZ0"',
		'"raw\nnewline"',
		"\ufeff0",
		"\u00a00",
		"0\u000b",
	])("refuses malformed, trailing or non-JSON input: %j", (text) => refuses(encode(text)));

	it("enforces received bytes before decode, counting legal trailing whitespace", () => {
		expect(parse("0 ", { maxBytes: 2 })).toBe(0);
		refuses(encode("0  "), { maxBytes: 2 });
		const misleading = encode("0  ");
		Object.defineProperty(misleading, "byteLength", { get: () => 0 });
		refuses(misleading, { maxBytes: 2 });
	});

	it("decodes only the input view's actual extent", () => {
		const backing = new Uint8Array([0xff, 0x30, 0x20, 0xff]);
		expect(parseStrictJson(backing.subarray(1, 3), { maxBytes: 2 })).toBe(0);
	});

	it("counts container depth with scalar depth zero", () => {
		expect(parse("0", { maxDepth: 0 })).toBe(0);
		expect(parse("[{}]", { maxDepth: 2 })).toHaveLength(1);
		refuses(encode("[{}]"), { maxDepth: 1 });
		refuses(encode("[]"), { maxDepth: 0 });
		refuses(encode(`${"[".repeat(65)}0${"]".repeat(65)}`));
	});

	it("counts values and member names before accepting another node", () => {
		expect(parse("[true,null]", { maxNodes: 3 })).toEqual([true, null]);
		refuses(encode("[true,null]"), { maxNodes: 2 });
		expect(JSON.stringify(parse('{"a":1}', { maxNodes: 3 }))).toBe('{"a":1}');
		refuses(encode('{"a":1}'), { maxNodes: 2 });
		refuses(encode("0"), { maxNodes: 0 });
	});

	it("bounds each decoded string and key by UTF-8 bytes, not escape spelling", () => {
		expect(parse('"\\u00e9"', { maxStringBytes: 2 })).toBe("é");
		refuses(encode('"é"'), { maxStringBytes: 1 });
		expect(parse('"\\ud83d\\ude00"', { maxStringBytes: 4 })).toBe("😀");
		refuses(encode('"😀"'), { maxStringBytes: 3 });
		refuses(encode('{"é":0}'), { maxStringBytes: 1 });
		expect(parse('""', { maxStringBytes: 0 })).toBe("");
		refuses(encode('"a"'), { maxStringBytes: 0 });
	});

	it("refuses invalid limits with one fixed error and no input content", () => {
		for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, undefined]) {
			for (const key of ["maxBytes", "maxDepth", "maxNodes", "maxStringBytes"] as const) {
				refuses(encode("0"), { [key]: value });
			}
		}
		refuses(encode("0"), { unexpected: 1 } as Partial<JsonLimits>);
		refuses(encode("0"), null as unknown as Partial<JsonLimits>);
		const options = {
			get maxBytes(): number {
				throw new Error("synthetic rejected detail");
			},
		};
		refuses(encode("0"), options);
	});
});
