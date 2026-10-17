import { sha256Hex } from "../../src/hash.ts";
import { canonicalize, JcsError, type JcsErrorCode, parseStrict } from "../../src/jcs.ts";
import type { VectorFile } from "../vectors.ts";

const format = "draftyak.vectors.jcs.v1";
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
// A JSON \u escape as text, for the inputs below.
const u = (code: string): string => `\\u${code}`;

// Every expected value is written out here, and the implementation must reproduce it.
function same(id: string, actual: string, expected: string): void {
	if (actual !== expected) throw new Error(`jcs ${id}: got ${actual}, expected ${expected}`);
}

function outcome(run: () => unknown): string {
	try {
		run();
		return "accepted";
	} catch (error) {
		if (error instanceof JcsError) return error.code;
		throw error;
	}
}

function valid(id: string, input: string, canonical: string, source?: string): object {
	same(id, canonicalize(parseStrict(input)), canonical);
	const bytes = utf8(canonical);
	const cited = source === undefined ? {} : { source };
	return { id, ...cited, input, canonical, canonicalHex: hex(bytes), sha256: sha256Hex(bytes) };
}

function number(id: string, ieee754: string, expected: string): object {
	const value = Buffer.from(ieee754, "hex").readDoubleBE(0);
	const source = "RFC 8785 Appendix B";
	if (expected.startsWith("JCS_")) {
		const code = outcome(() => canonicalize(value));
		same(id, code, expected);
		return { id, source, ieee754, error: expected };
	}
	same(id, canonicalize(value), expected);
	return { id, source, ieee754, canonical: expected };
}

function refused(id: string, input: string | Uint8Array, error: JcsErrorCode): object {
	const code = outcome(() => parseStrict(input));
	same(id, code, error);
	return typeof input === "string" ? { id, input, error } : { id, inputHex: hex(input), error };
}

const nested = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;
const nestedObjects = (depth: number): string =>
	`${'{"a":'.repeat(depth - 1)}{}${"}".repeat(depth - 1)}`;
const bytes = (spaced: string): Uint8Array =>
	new Uint8Array(Buffer.from(spaced.replaceAll(" ", ""), "hex"));

function rfc8785(): object[] {
	const primitives = `{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"${u("20ac")}$${u("000F")}${u("000a")}A'${u("0042")}${u("0022")}${u("005c")}\\\\\\"\\/","literals":[null,true,false]}`;
	const sorting = `{"${u("20ac")}":"Euro Sign","\\r":"Carriage Return","${u("fb33")}":"Hebrew Letter Dalet With Dagesh","1":"One","${u("d83d")}${u("de00")}":"Emoji: Grinning Face","${u("0080")}":"Control","${u("00f6")}":"Latin Small Letter O With Diaeresis"}`;
	const unnormalized = `{"Unnormalized Unicode":"A${u("030a")}"}`;
	// §3.2.4 gives the canonical bytes themselves.
	same(
		"utf8",
		hex(utf8(canonicalize(parseStrict(unnormalized)))),
		"7b22556e6e6f726d616c697a656420556e69636f6465223a2241cc8a227d",
	);
	return [
		valid(
			"primitives",
			primitives,
			'{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"\u{20ac}$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
			"RFC 8785 §3.2.2",
		),
		valid(
			"sorting",
			sorting,
			'{"\\r":"Carriage Return","1":"One","\u{80}":"Control","\u{f6}":"Latin Small Letter O With Diaeresis","\u{20ac}":"Euro Sign","\u{1f600}":"Emoji: Grinning Face","\u{fb33}":"Hebrew Letter Dalet With Dagesh"}',
			"RFC 8785 §3.2.3",
		),
		valid("utf8", unnormalized, '{"Unnormalized Unicode":"A\u{30a}"}', "RFC 8785 §3.2.4"),
		number("zero", "0000000000000000", "0"),
		number("minus-zero", "8000000000000000", "0"),
		number("min-positive", "0000000000000001", "5e-324"),
		number("min-negative", "8000000000000001", "-5e-324"),
		number("max-positive", "7fefffffffffffff", "1.7976931348623157e+308"),
		number("max-negative", "ffefffffffffffff", "-1.7976931348623157e+308"),
		number("max-positive-integer", "4340000000000000", "9007199254740992"),
		number("max-negative-integer", "c340000000000000", "-9007199254740992"),
		number("two-to-68", "4430000000000000", "295147905179352830000"),
		number("nan", "7fffffffffffffff", "JCS_NUMBER_RANGE"),
		number("infinity", "7ff0000000000000", "JCS_NUMBER_RANGE"),
		number("below-1e23", "44b52d02c7e14af5", "9.999999999999997e+22"),
		number("1e23", "44b52d02c7e14af6", "1e+23"),
		number("above-1e23", "44b52d02c7e14af7", "1.0000000000000001e+23"),
		number("below-1e21-a", "444b1ae4d6e2ef4e", "999999999999999700000"),
		number("below-1e21-b", "444b1ae4d6e2ef4f", "999999999999999900000"),
		number("1e21", "444b1ae4d6e2ef50", "1e+21"),
		number("below-1e-6", "3eb0c6f7a0b5ed8c", "9.999999999999997e-7"),
		number("1e-6", "3eb0c6f7a0b5ed8d", "0.000001"),
		number("thirds-3", "41b3de4355555553", "333333333.3333332"),
		number("thirds-4", "41b3de4355555554", "333333333.33333325"),
		number("thirds-5", "41b3de4355555555", "333333333.3333333"),
		number("thirds-6", "41b3de4355555556", "333333333.3333334"),
		number("thirds-7", "41b3de4355555557", "333333333.33333343"),
		number("negative-small", "becbf647612f3696", "-0.0000033333333333333333"),
		number("round-to-even", "43143ff3c1cb0959", "1424953923781206.2"),
	];
}

function edges(): object[] {
	return [
		valid("empty-object", "{}", "{}"),
		valid("empty-array", "[]", "[]"),
		valid("whitespace", ' \t\n\r{ "a" : [ 1 , 2 ] , "b" : { } }\r\n ', '{"a":[1,2],"b":{}}'),
		valid("literals-and-scalars", '[true, false, null, "x", -0]', '[true,false,null,"x",0]'),
		valid("top-level-string", '"top"', '"top"'),
		valid(
			"nested-sort",
			'{"b":{"z":1,"a":2},"a":[{"y":1,"x":2}]}',
			'{"a":[{"x":2,"y":1}],"b":{"a":2,"z":1}}',
		),
		valid("name-prefixes", '{"abc":3,"ab":2,"a":1,"":0}', '{"":0,"a":1,"ab":2,"abc":3}'),
		valid(
			"names-by-utf16-units",
			`{"${u("ff01")}":1,"${u("d83d")}${u("de00")}":2,"${u("00e9")}":3,"e":4,"E":5,"${u("007f")}":6}`,
			'{"E":5,"e":4,"\u{7f}":6,"\u{e9}":3,"\u{1f600}":2,"\u{ff01}":1}',
		),
		valid(
			"no-unicode-normalization",
			`{"${u("00e9")}":"nfc","e${u("0301")}":"nfd"}`,
			'{"e\u{301}":"nfd","\u{e9}":"nfc"}',
		),
		valid(
			"string-escapes",
			`"${["0000", "0001", "001f"].map(u).join("")}\\b\\t\\n\\f\\r\\"\\\\\\/${["007f", "0080", "2028", "2029"].map(u).join("")}"`,
			'"\\u0000\\u0001\\u001f\\b\\t\\n\\f\\r\\"\\\\/\u{7f}\u{80}\u{2028}\u{2029}"',
		),
		valid(
			"escapes-decoded",
			`"${u("0041")}${u("00E9")}${u("D83D")}${u("DE00")}\\/"`,
			'"A\u{e9}\u{1f600}/"',
		),
		valid("astral-raw", '["\u{1f600}\u{10ffff}"]', '["\u{1f600}\u{10ffff}"]'),
		valid(
			"noncharacters-and-bom-in-strings",
			`["${u("fffe")}${u("ffff")}","${u("feff")}x"]`,
			'["\u{fffe}\u{ffff}","\u{feff}x"]',
		),
		valid("markup-unescaped", `"</script><!--&'"`, `"</script><!--&'"`),
		valid("proto-member", '{"__proto__":{"a":1},"b":2}', '{"__proto__":{"a":1},"b":2}'),
		valid(
			"safe-integers",
			"[0,-0,1,-1,9007199254740991,-9007199254740991,9007199254740992]",
			"[0,0,1,-1,9007199254740991,-9007199254740991,9007199254740992]",
		),
		valid(
			"integers-as-doubles",
			"[9007199254740993,-9007199254740993,18446744073709551615]",
			"[9007199254740992,-9007199254740992,18446744073709552000]",
		),
		valid(
			"number-forms",
			"[1.0,1e0,10e-1,0.1e1,1E+2,-0.0,1e-7,1e21,1e20,123e-2]",
			"[1,1,1,1,100,0,1e-7,1e+21,100000000000000000000,1.23]",
		),
		valid("number-underflow", "[1e-400,-1e-400]", "[0,0]"),
		// Correctly rounded, ties to even: no double rounding, no shortcut for long or tiny inputs.
		valid(
			"number-halfway-to-even",
			"[1.00000000000000011102230246251565404236316680908203125,9007199254740993.0]",
			"[1,9007199254740992]",
		),
		valid(
			"number-subnormals",
			"[2.4703282292062328e-324,2.4703282292062327e-324,2.2250738585072011e-308,4.35679845e-310]",
			"[5e-324,0,2.225073858507201e-308,4.35679845e-310]",
		),
		valid("number-near-max", "[1.7976931348623158e308]", "[1.7976931348623157e+308]"),
		valid("nesting-64-arrays", nested(64), nested(64)),
		valid("nesting-64-objects", nestedObjects(64), nestedObjects(64)),
	];
}

function refusals(): object[] {
	return [
		refused("duplicate-name", '{"a":1,"a":2}', "JCS_DUPLICATE_KEY"),
		refused("duplicate-name-escaped", `{"a":1,"${u("0061")}":2}`, "JCS_DUPLICATE_KEY"),
		refused("duplicate-name-nested", '{"x":{"b":1,"b":1}}', "JCS_DUPLICATE_KEY"),
		refused(
			"duplicate-name-astral",
			`{"\u{1f600}":1,"${u("d83d")}${u("de00")}":2}`,
			"JCS_DUPLICATE_KEY",
		),
		refused("lone-high-surrogate", `["${u("d800")}"]`, "JCS_LONE_SURROGATE"),
		refused("lone-low-surrogate", `["${u("dc00")}"]`, "JCS_LONE_SURROGATE"),
		refused("reversed-surrogates", `["${u("dc00")}${u("d800")}"]`, "JCS_LONE_SURROGATE"),
		refused("high-surrogate-then-ascii", `["${u("d800")}a"]`, "JCS_LONE_SURROGATE"),
		refused("lone-surrogate-in-name", `{"${u("d800")}":1}`, "JCS_LONE_SURROGATE"),
		refused("utf8-stray-continuation", bytes("22 80 22"), "JCS_INVALID_UTF8"),
		refused("utf8-overlong", bytes("22 c0 af 22"), "JCS_INVALID_UTF8"),
		refused("utf8-encoded-surrogate", bytes("22 ed a0 80 22"), "JCS_INVALID_UTF8"),
		refused("utf8-truncated", bytes("22 e2 82 22"), "JCS_INVALID_UTF8"),
		refused("utf8-beyond-10ffff", bytes("22 f4 90 80 80 22"), "JCS_INVALID_UTF8"),
		refused("utf8-invalid-byte", bytes("22 ff 22"), "JCS_INVALID_UTF8"),
		refused("byte-order-mark", bytes("ef bb bf 7b 7d"), "JCS_SYNTAX"),
		refused("empty-document", "", "JCS_SYNTAX"),
		refused("trailing-comma-array", "[1,]", "JCS_SYNTAX"),
		refused("trailing-comma-object", '{"a":1,}', "JCS_SYNTAX"),
		refused("leading-zero", "[01]", "JCS_SYNTAX"),
		refused("plus-sign", "[+1]", "JCS_SYNTAX"),
		refused("bare-fraction", "[.5]", "JCS_SYNTAX"),
		refused("fraction-without-digits", "[1.]", "JCS_SYNTAX"),
		refused("lone-minus", "[-]", "JCS_SYNTAX"),
		refused("exponent-without-digits", "[1e]", "JCS_SYNTAX"),
		refused("hex-number", "[0x10]", "JCS_SYNTAX"),
		refused("nan-literal", "[NaN]", "JCS_SYNTAX"),
		refused("comment", '{"a":1/* note */}', "JCS_SYNTAX"),
		refused("single-quotes", "{'a':1}", "JCS_SYNTAX"),
		refused("raw-control-character", '["a\tb"]', "JCS_SYNTAX"),
		refused("invalid-escape", '["\\x41"]', "JCS_SYNTAX"),
		refused("short-unicode-escape", `["${u("00e")}"]`, "JCS_SYNTAX"),
		refused("unterminated-string", '["abc', "JCS_SYNTAX"),
		refused("text-after-value", "{} {}", "JCS_SYNTAX"),
		refused("number-overflow", "[1e400]", "JCS_NUMBER_RANGE"),
		refused("number-overflow-negative", "[-1e400]", "JCS_NUMBER_RANGE"),
		refused("number-overflow-by-rounding", "[1.7976931348623159e308]", "JCS_NUMBER_RANGE"),
		// JSON's whitespace is space, tab, line feed and carriage return only.
		refused("vertical-tab-between-values", "[1,\u{b}2]", "JCS_SYNTAX"),
		refused("form-feed-between-values", "[1,\f2]", "JCS_SYNTAX"),
		refused("no-break-space-between-values", "[1,\u{a0}2]", "JCS_SYNTAX"),
		refused("byte-order-mark-between-values", "[1,\u{feff}2]", "JCS_SYNTAX"),
		refused("nesting-65-arrays", nested(65), "JCS_TOO_DEEP"),
		refused("nesting-65-objects", nestedObjects(65), "JCS_TOO_DEEP"),
	];
}

const description = (what: string): string =>
	`${what}. A case with "canonical" parses "input" strictly and canonicalizes it to exactly ` +
	'"canonicalHex" (UTF-8), whose SHA-256 is "sha256"; one with "ieee754" canonicalizes that ' +
	'double; one with "error" is refused with that code ("inputHex" holds input that isn\'t text).';

export function generate(): VectorFile[] {
	const file = (name: string, what: string, cases: object[]): VectorFile => ({
		path: `jcs/${name}.json`,
		content: { format, description: description(what), cases },
	});
	return [
		file("rfc8785", "RFC 8785's own examples", rfc8785()),
		file("edges", "Unicode, escaping, number and nesting edges", edges()),
		file("refusals", "What the strict parser refuses", refusals()),
	];
}
