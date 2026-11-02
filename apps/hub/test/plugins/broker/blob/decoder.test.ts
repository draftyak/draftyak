import { readFileSync } from "node:fs";
import {
	HOST_ERROR_CODES,
	HOST_JSON_MEMBER_MAX_DECODED_BYTES,
	HOST_JSON_MEMBER_MAX_DEPTH,
	HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
	HOST_JSON_MEMBER_MAX_ERROR_BYTES,
	HOST_JSON_MEMBER_MAX_NODES,
} from "@draftyak/protocol/host-channel";
import { describe, expect, it } from "vitest";
import {
	createJsonMemberDecoder,
	JSON_MEMBER_REFUSALS,
	type JsonMember,
	type JsonMemberDecoder,
	type JsonMemberLimits,
	JsonMemberRefusal,
	type JsonMemberRefusalCode,
} from "../../../../src/plugins/broker/blob/index.ts";

interface ProjectionVector {
	readonly id: string;
	readonly member: JsonMember;
	readonly json?: string;
	readonly entityHex?: string;
	readonly decodedHex?: string;
	readonly error?: string;
}
const vectors = JSON.parse(
	readFileSync(
		new URL("../../../../../../spec/vectors/host-channel/decoded-member.json", import.meta.url),
		"utf8",
	),
) as {
	projection: ProjectionVector[];
	boundaries: { counter: string; maximum: number }[];
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MiB = 1_048_576;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** A view of `length` alphabet bytes whose memory was then transferred away. */
function detached(length: number): Uint8Array {
	const memory = new ArrayBuffer(length + 2);
	const chunk = new Uint8Array(memory, 1, length).fill(0x41);
	memory.transfer();
	return chunk;
}

function refusal(run: () => unknown): JsonMemberRefusal | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof JsonMemberRefusal) return error;
		throw error;
	}
	return undefined;
}

function decode(
	member: JsonMember,
	chunks: Iterable<Uint8Array>,
	limits?: JsonMemberLimits,
): Uint8Array {
	const decoder = createJsonMemberDecoder(member, limits);
	const parts: Uint8Array[] = [];
	for (const chunk of chunks) parts.push(decoder.push(chunk));
	decoder.end();
	return new Uint8Array(Buffer.concat(parts));
}

const codeOf = (
	member: JsonMember,
	chunks: Iterable<Uint8Array>,
	limits?: JsonMemberLimits,
): JsonMemberRefusalCode | undefined => refusal(() => decode(member, chunks, limits))?.code;

/** The whole entity, every two-chunk split and one byte at a time. */
function* splits(entity: Uint8Array): Generator<Uint8Array[]> {
	yield [entity];
	for (let at = 0; at <= entity.length; at++) yield [entity.subarray(0, at), entity.subarray(at)];
	yield Array.from(entity, (_, index) => entity.subarray(index, index + 1));
}

/** Pushes `count` bytes of `fill` in 1 MiB chunks without holding them all; returns bytes decoded. */
function pushRepeated(decoder: JsonMemberDecoder, fill: number, count: number): number {
	const chunk = new Uint8Array(MiB).fill(fill);
	let decoded = 0;
	for (let left = count; left > 0; left -= MiB)
		decoded += decoder.push(chunk.subarray(0, Math.min(left, MiB))).byteLength;
	return decoded;
}

describe("decoded JSON-member contract vectors", () => {
	it.each(vectors.projection)(
		"$id projects as the vector says, whole and split at every byte",
		(vector) => {
			const entity =
				vector.entityHex === undefined
					? text(vector.json as string)
					: new Uint8Array(Buffer.from(vector.entityHex, "hex"));
			for (const chunks of splits(entity)) {
				if (vector.error === undefined)
					expect(hex(decode(vector.member, chunks))).toBe(vector.decodedHex);
				else expect(refusal(() => decode(vector.member, chunks))?.hostError).toBe(vector.error);
			}
		},
	);

	it("counts every bounded quantity the vectors list, with the contract maxima", () => {
		const maxima: Record<string, number> = {
			compressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
			decompressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
			decodedBytes: HOST_JSON_MEMBER_MAX_DECODED_BYTES,
			containerDepth: HOST_JSON_MEMBER_MAX_DEPTH,
			valueNodes: HOST_JSON_MEMBER_MAX_NODES,
			non2xxInlineBytes: HOST_JSON_MEMBER_MAX_ERROR_BYTES,
		};
		expect(vectors.boundaries.map(({ counter }) => counter).sort()).toEqual(
			Object.keys(maxima).sort(),
		);
		const counters = createJsonMemberDecoder("raw").counters();
		for (const { counter, maximum } of vectors.boundaries) {
			expect(maxima[counter]).toBe(maximum);
			if (counter !== "non2xxInlineBytes") expect(counters).toHaveProperty(counter, 0);
		}
	});
});

describe("base64url member", () => {
	it("decodes canonical unpadded strings and their exactly padded forms, for both members", () => {
		for (let length = 0; length <= 13; length++) {
			const bytes = Uint8Array.from({ length }, (_, index) => (index * 73 + 41) & 0xff);
			const unpadded = Buffer.from(bytes).toString("base64url");
			const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
			for (const encoded of [unpadded, padded])
				for (const member of ["raw", "data"] as const)
					expect(hex(decode(member, [text(`{"${member}":"${encoded}"}`)]))).toBe(hex(bytes));
		}
	});

	it("decodes every character of the URL-safe alphabet", () => {
		expect(hex(decode("raw", [text(`{"raw":"${ALPHABET}"}`)]))).toBe(
			Buffer.from(ALPHABET, "base64url").toString("hex"),
		);
	});

	it("decodes JSON escapes before checking the alphabet", () => {
		for (const [encoded, decoded] of [
			["\\u005a\\u0067", "66"],
			["\\u005Ag", "66"],
			["Z\\u0067\\u003d\\u003d", "66"],
			["Zg\\u003D=", "66"],
			["\\u005a\\u006d\\u0039\\u0076", "666f6f"],
		] as const)
			for (const chunks of splits(text(`{"raw":"${encoded}"}`)))
				expect(hex(decode("raw", chunks))).toBe(decoded);
	});

	it.each([
		["the standard alphabet", "+/8="],
		["a plus sign", "Zm+v"],
		["a slash", "Zm/v"],
		["a space", "Zm 9v"],
		["leading whitespace", " Zm9v"],
		["an escaped line feed", "Zg\\n"],
		["an escaped tab", "Z\\tg"],
		["an escaped plus sign", "Zm\\u002bv"],
		["an escaped slash", "Zm\\/v"],
		["an escaped NUL", "Zm\\u0000v"],
		["one character", "Z"],
		["five characters", "Zm9vY"],
		["padding alone", "="],
		["two pads alone", "=="],
		["a pad after one character", "Z="],
		["incomplete padding", "Zg="],
		["excess padding after two characters", "Zg==="],
		["excess padding after three characters", "Zm8=="],
		["padding after a full group", "Zm9v="],
		["a group of padding", "Zm9v===="],
		["escaped excess padding", "Zg==\\u003d"],
		["interior padding", "Z=g="],
		["padding before more data", "Zg==Zg=="],
		["two pads between groups", "Zg==AAAA"],
		["one pad between groups", "Zm8=AAAA"],
		["data after padding", "Zg==x"],
		["a percent escape", "Zg%3D%3D"],
		["a dot", "Zm9v.Zg"],
		["a non-ASCII letter", "Zmév"],
		["an emoji", "Zm\u{1f600}v"],
		["a full-width letter", "ZmＺv"],
		["an escaped non-ASCII letter", "Zm\\u00e9v"],
		["an escaped surrogate pair", "Zm\\ud83d\\ude00v"],
	])("refuses %s in the member", (_name, encoded) => {
		for (const chunks of splits(text(`{"raw":"${encoded}"}`)))
			expect(codeOf("raw", chunks)).toBe("ENCODING_INVALID");
	});

	it("refuses nonzero unused bits in the last character, padded or not", () => {
		for (const [index, character] of [...ALPHABET].entries()) {
			const two = index % 16 === 0 ? undefined : "ENCODING_INVALID";
			const three = index % 4 === 0 ? undefined : "ENCODING_INVALID";
			expect(codeOf("raw", [text(`{"raw":"Z${character}"}`)])).toBe(two);
			expect(codeOf("raw", [text(`{"raw":"Z${character}=="}`)])).toBe(two);
			expect(codeOf("raw", [text(`{"raw":"Zm${character}"}`)])).toBe(three);
			expect(codeOf("raw", [text(`{"raw":"Zm${character}="}`)])).toBe(three);
		}
	});

	it("decodes the same bytes at every chunk boundary, through escapes in the member", () => {
		const bytes = Uint8Array.from({ length: 40 }, (_, index) => (index * 37 + 11) & 0xff);
		const encoded = [...Buffer.from(bytes).toString("base64url")]
			.map((character, index) =>
				index % 5 === 2
					? `\\u${(character.codePointAt(0) as number).toString(16).padStart(4, "0")}`
					: character,
			)
			.join("");
		const json = `{"pre":"x\\u00e9\\ud83d\\ude00é\u{1f600}","n":[1.5e-3,{"k":null}],"data":"${encoded}","post":true}`;
		for (const chunks of splits(text(json))) expect(hex(decode("data", chunks))).toBe(hex(bytes));
	});
});

describe("member selection", () => {
	it("selects the case-sensitive top-level member, written plainly or with escapes", () => {
		const json =
			'{"data":"Zm8","raw":"Zg","Raw":"Zm9v","nested":{"raw":"Zm9v"},"list":[{"data":"Zg"}]}';
		expect(hex(decode("raw", [text(json)]))).toBe("66");
		expect(hex(decode("data", [text(json)]))).toBe("666f");
		expect(hex(decode("raw", [text('{"\\u0072\\u0061\\u0077":"Zg"}')]))).toBe("66");
		expect(hex(decode("data", [text('{"d\\u0061t\\u0061":"Zg"}')]))).toBe("66");
	});

	it.each([
		["an empty object", "{}"],
		["only the other member", '{"data":"Zg"}'],
		["a different case", '{"Raw":"Zg","RAW":"Zg"}'],
		["a trailing space", '{"raw ":"Zg"}'],
		["a longer name", '{"rawx":"Zg"}'],
		["a shorter name", '{"ra":"Zg"}'],
		["an escaped NUL suffix", '{"raw\\u0000":"Zg"}'],
		["a nested member", '{"nested":{"raw":"Zg"}}'],
		["a member in an array", '{"list":[{"raw":"Zg"}]}'],
	])("refuses a document without the member: %s", (_name, json) => {
		for (const chunks of splits(text(json))) expect(codeOf("raw", chunks)).toBe("MEMBER_MISSING");
	});

	it.each([
		["0"],
		["-1.5e3"],
		["true"],
		["false"],
		["null"],
		["{}"],
		["[]"],
		['["Zg"]'],
		['{"raw":"Zg"}'],
	])("refuses the member value %s", (value) => {
		for (const chunks of splits(text(`{"raw":${value}}`)))
			expect(codeOf("raw", chunks)).toBe("MEMBER_NOT_STRING");
	});
});

describe("duplicate names", () => {
	const long = "k".repeat(200);
	it.each([
		["at the root", '{"raw":"Zg","a":1,"a":2}'],
		["in a nested object", '{"raw":"Zg","o":{"x":1,"x":2}}'],
		["deep inside arrays", '{"raw":"Zg","a":[[{"x":1,"y":{"z":1,"z":2}}]]}'],
		["after an escape", '{"raw":"Zg","o":{"x":1,"\\u0078":2}}'],
		["after an escaped solidus", '{"raw":"Zg","o":{"/":1,"\\/":2}}'],
		["as an escaped surrogate pair", `{"raw":"Zg","o":{"\u{1f600}":1,"\\ud83d\\ude00":2}}`],
		["of the member", '{"raw":"Zg","raw":"Zg"}'],
		["of the member after an escape", '{"raw":"Zg","r\\u0061w":"Zg"}'],
		["of the member before it", '{"r\\u0061w":"Zg","raw":"Zg"}'],
		["of the other member", '{"data":"Zg","raw":"Zg","data":"Zg"}'],
		["of an empty name", '{"raw":"Zg","":1,"":2}'],
		["of a 64-byte name", `{"raw":"Zg","${"k".repeat(64)}":1,"${"k".repeat(64)}":2}`],
		["of a 65-byte name", `{"raw":"Zg","${"k".repeat(65)}":1,"${"k".repeat(65)}":2}`],
		["of a long name", `{"raw":"Zg","${long}a":1,"${long}a":2}`],
		["of a long name after an escape", `{"raw":"Zg","${long}a":1,"${long}\\u0061":2}`],
	])("refuses a duplicate %s", (_name, json) => {
		for (const chunks of splits(text(json))) expect(codeOf("raw", chunks)).toBe("DUPLICATE_KEY");
	});

	it("accepts names that differ in case, length or past their first 64 bytes, and repeats in other objects", () => {
		const k64 = "k".repeat(64);
		const json = `{"raw":"Zg","Raw":1,"RAW":2,"raw ":3,"${k64}":4,"${k64}a":5,"${k64}b":6,"${long}a":7,"${long}b":8,"o":{"raw":"x","a":1},"p":[{"a":1},{"a":2}],"a":{"a":{"a":1}}}`;
		for (const chunks of splits(text(json))) expect(hex(decode("raw", chunks))).toBe("66");
	});

	// The first and last code points of each multi-byte UTF-8 length, and two in between.
	const points = [0x80, 0xe9, 0x7ff, 0x800, 0x4e2d, 0xffff, 0x10000, 0x10ffff];
	/** `point` as JSON escapes, one per UTF-16 unit. */
	const escaped = (point: number, upper = false): string =>
		String.fromCodePoint(point)
			.split("")
			.map((unit) => {
				const digits = unit.charCodeAt(0).toString(16).padStart(4, "0");
				return `\\u${upper ? digits.toUpperCase() : digits}`;
			})
			.join("");

	it.each(
		points.map((point): [string, number] => [
			point.toString(16).toUpperCase().padStart(4, "0"),
			point,
		]),
	)("refuses U+%s twice in one object, once written out and once escaped", (_name, point) => {
		const character = String.fromCodePoint(point);
		for (const json of [
			`{"raw":"Zg","o":{"${character}":1,"${escaped(point)}":2}}`,
			`{"raw":"Zg","o":{"${escaped(point, true)}":1,"${character}":2}}`,
		])
			for (const chunks of splits(text(json))) expect(codeOf("raw", chunks)).toBe("DUPLICATE_KEY");
	});

	it("accepts escaped names of neighboring code points", () => {
		const objects = points.map(
			(point, index) => `"${index}":{"${escaped(point)}":1,"${escaped(point - 1)}":2}`,
		);
		const json = `{"raw":"Zg",${objects.join(",")}}`;
		for (const chunks of splits(text(json))) expect(hex(decode("raw", chunks))).toBe("66");
	});
});

describe("strict JSON", () => {
	it("validates and skips metadata of every JSON type, with whitespace anywhere", () => {
		const json = ` \t\r\n{ "id" : "m-1" , "n" : [ 0 , -0 , 1.5 , -2e+10 , 3E-2 , 4e5 , 12345678901234567890 , true , false , null , { } , [ ] , {"a":{"b":[[]]}} ] , "s" : "\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00é\u{1f600}" , "raw" : "Zm9v" , "e" : "" } \n\t `;
		for (const chunks of splits(text(json))) expect(hex(decode("raw", chunks))).toBe("666f6f");
	});

	it.each([
		["an empty entity", ""],
		["whitespace only", " \n"],
		["a byte order mark", '﻿{"raw":"Zg"}'],
		["an array root", '[{"raw":"Zg"}]'],
		["a string root", '"Zg"'],
		["a number root", "1"],
		["a literal root", "null"],
		["a second document", '{"raw":"Zg"}{}'],
		["trailing text", '{"raw":"Zg"} x'],
		["a trailing comma in an object", '{"raw":"Zg",}'],
		["a trailing comma in an array", '{"raw":"Zg","a":[1,]}'],
		["a leading comma in an array", '{"raw":"Zg","a":[,1]}'],
		["a missing colon", '{"raw" "Zg"}'],
		["a missing comma", '{"raw":"Zg" "a":1}'],
		["a missing value", '{"raw":"Zg","a":}'],
		["an unquoted name", '{"raw":"Zg",a:1}'],
		["single quotes", "{'raw':'Zg'}"],
		["an unclosed object", '{"raw":"Zg"'],
		["an unclosed member", '{"raw":"Zg'],
		["an unclosed array", '{"raw":"Zg","a":[1'],
		["a mismatched bracket", '{"raw":"Zg","a":[1}'],
		["an extra closing brace", '{"raw":"Zg"}}'],
		["a leading zero", '{"raw":"Zg","a":01}'],
		["a negative leading zero", '{"raw":"Zg","a":-01}'],
		["a bare minus", '{"raw":"Zg","a":-}'],
		["a plus sign", '{"raw":"Zg","a":+1}'],
		["a leading dot", '{"raw":"Zg","a":.5}'],
		["a trailing dot", '{"raw":"Zg","a":1.}'],
		["an empty exponent", '{"raw":"Zg","a":1e}'],
		["an exponent sign alone", '{"raw":"Zg","a":1e+}'],
		["a hexadecimal number", '{"raw":"Zg","a":0x10}'],
		["NaN", '{"raw":"Zg","a":NaN}'],
		["Infinity", '{"raw":"Zg","a":Infinity}'],
		["a truncated literal", '{"raw":"Zg","a":tru}'],
		["a capitalized literal", '{"raw":"Zg","a":True}'],
		["a misspelled literal", '{"raw":"Zg","a":nul1}'],
		["an unescaped control character", '{"raw":"Zg","a":"\u0001"}'],
		["an unescaped line feed", '{"raw":"Zg","a":"\n"}'],
		["an unknown escape", '{"raw":"Zg","a":"\\x41"}'],
		["a short unicode escape", '{"raw":"Zg","a":"\\u004"}'],
		["a non-hex unicode escape", '{"raw":"Zg","a":"\\u00g1"}'],
		["a lone high surrogate", '{"raw":"Zg","a":"\\ud800"}'],
		["a lone low surrogate", '{"raw":"Zg","a":"\\udc00"}'],
		["a high surrogate before text", '{"raw":"Zg","a":"\\ud800x"}'],
		["a high surrogate before a short escape", '{"raw":"Zg","a":"\\ud800\\n"}'],
		["two high surrogates", '{"raw":"Zg","a":"\\ud800\\ud800"}'],
		["a lone surrogate in a name", '{"raw":"Zg","\\udfff":1}'],
		["a lone surrogate in the member", '{"raw":"\\ud800Zg"}'],
		["a comment", '{"raw":"Zg"/* note */}'],
		["a non-breaking space between tokens", '{"raw":"Zg", "a":1}'],
	])("refuses %s", (_name, json) => {
		for (const chunks of splits(text(json))) expect(codeOf("raw", chunks)).toBe("JSON_INVALID");
	});
});

describe("strict UTF-8", () => {
	const places: readonly (readonly [string, string])[] = [
		['{"raw":"Zg","s":"', '"}'],
		['{"raw":"Zg","', '":1}'],
		['{"raw":"', '"}'],
	];

	it.each([
		["an overlong two-byte form", [0xc0, 0x80]],
		["an overlong two-byte DEL", [0xc1, 0xbf]],
		["an overlong three-byte form", [0xe0, 0x80, 0x80]],
		["the last overlong three-byte form", [0xe0, 0x9f, 0xbf]],
		["an encoded high surrogate", [0xed, 0xa0, 0x80]],
		["an encoded low surrogate", [0xed, 0xbf, 0xbf]],
		["an overlong four-byte form", [0xf0, 0x80, 0x80, 0x80]],
		["the last overlong four-byte form", [0xf0, 0x8f, 0xbf, 0xbf]],
		["a code point past U+10FFFF", [0xf4, 0x90, 0x80, 0x80]],
		["a lead byte past F4", [0xf5, 0x80, 0x80, 0x80]],
		["a stray continuation byte", [0x80]],
		["a truncated sequence", [0xe2, 0x82]],
		["a sequence cut by ASCII", [0xe2, 0x41, 0xac]],
		["FE", [0xfe]],
		["FF", [0xff]],
	])("refuses %s in a skipped string, a name and the member", (_name, bytes) => {
		for (const [before, after] of places) {
			const entity = new Uint8Array(
				Buffer.concat([Buffer.from(before), Buffer.from(bytes), Buffer.from(after)]),
			);
			for (const chunks of splits(entity)) expect(codeOf("raw", chunks)).toBe("UTF8_INVALID");
		}
	});

	it("accepts every boundary of valid UTF-8 in names and skipped strings", () => {
		const characters = ["\u0080", "߿", "ࠀ", "퟿", "", "￿", "\u{10000}", "\u{10ffff}"];
		const json = `{${characters.map((character, index) => `"${character}${index}":"${character}"`).join(",")},"raw":"Zg"}`;
		for (const chunks of splits(text(json))) expect(hex(decode("raw", chunks))).toBe("66");
	});

	it("refuses non-ASCII bytes outside strings as invalid JSON", () => {
		for (const bytes of [[0xc2, 0xa0], [0xef, 0xbb, 0xbf], [0x80]]) {
			const entity = new Uint8Array(
				Buffer.concat([Buffer.from('{"raw":"Zg"}'), Buffer.from(bytes)]),
			);
			expect(refusal(() => decode("raw", [entity]))?.hostError).toBe("BAD_REQUEST");
		}
	});
});

describe("bounds", () => {
	it("accepts 64 container levels and refuses the 65th when it opens", () => {
		const arrays = (levels: number): string =>
			`{"raw":"Zg","d":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;
		const objects = (levels: number): string =>
			`{"raw":"Zg","d":${'{"a":'.repeat(levels - 2)}{}${"}".repeat(levels - 2)}}`;
		for (const nest of [arrays, objects]) {
			const decoder = createJsonMemberDecoder("raw");
			decoder.push(text(nest(HOST_JSON_MEMBER_MAX_DEPTH)));
			decoder.end();
			expect(decoder.counters().containerDepth).toBe(HOST_JSON_MEMBER_MAX_DEPTH);
			expect(codeOf("raw", [text(nest(HOST_JSON_MEMBER_MAX_DEPTH + 1))])).toBe("DEPTH_TOO_LARGE");
		}
		const open = createJsonMemberDecoder("raw");
		const refused = refusal(() => open.push(text(`{"raw":"Zg","d":${"[".repeat(64)}`)));
		expect(refused).toMatchObject({ code: "DEPTH_TOO_LARGE", hostError: "TOO_LARGE" });
		expect(open.counters().containerDepth).toBe(HOST_JSON_MEMBER_MAX_DEPTH);
	});

	it("counts the root, object values and array elements, not names, up to 65,536 nodes", () => {
		const small = createJsonMemberDecoder("raw");
		small.push(text('{"raw":"Zg","o":{"a":1,"b":[true,null]}}'));
		small.end();
		expect(small.counters().valueNodes).toBe(7);
		// The root, the member's string and the array are three nodes; the rest are its elements.
		const document = (elements: number): Uint8Array =>
			text(`{"raw":"Zg","a":[${Array.from({ length: elements }, () => "0").join(",")}]}`);
		const decoder = createJsonMemberDecoder("raw");
		decoder.push(document(HOST_JSON_MEMBER_MAX_NODES - 3));
		decoder.end();
		expect(decoder.counters().valueNodes).toBe(HOST_JSON_MEMBER_MAX_NODES);
		const over = createJsonMemberDecoder("raw");
		expect(refusal(() => over.push(document(HOST_JSON_MEMBER_MAX_NODES - 2)))).toMatchObject({
			code: "NODES_TOO_LARGE",
			hostError: "TOO_LARGE",
		});
		// The refused node is counted; nothing after it is read.
		expect(over.counters().valueNodes).toBe(HOST_JSON_MEMBER_MAX_NODES + 1);
	});

	it("decodes exactly 32 MiB and refuses the group that would pass it before storing it", () => {
		const unpadded = Math.ceil((HOST_JSON_MEMBER_MAX_DECODED_BYTES * 4) / 3);
		expect(unpadded).toBe(44_739_243);
		for (const padding of ["", "="]) {
			const decoder = createJsonMemberDecoder("raw");
			let decoded = decoder.push(text('{"raw":"')).byteLength;
			decoded += pushRepeated(decoder, 0x41, unpadded);
			decoded += decoder.push(text(`${padding}"}`)).byteLength;
			decoder.end();
			expect(decoded).toBe(HOST_JSON_MEMBER_MAX_DECODED_BYTES);
			expect(decoder.counters()).toMatchObject({
				decodedBytes: HOST_JSON_MEMBER_MAX_DECODED_BYTES,
				encodedCharacters: unpadded + padding.length,
			});
		}
		// One more character completes a group of three: 33,554,433 bytes.
		const over = createJsonMemberDecoder("raw");
		over.push(text('{"raw":"'));
		expect(refusal(() => pushRepeated(over, 0x41, unpadded + 1))).toMatchObject({
			code: "DECODED_TOO_LARGE",
			hostError: "TOO_LARGE",
		});
		expect(over.counters().decodedBytes).toBe(HOST_JSON_MEMBER_MAX_DECODED_BYTES - 2);
	});

	it("reads exactly 48 MiB of entity and refuses the next byte without reading it", () => {
		const head = text('{"raw":"Zg","pad":"');
		const tail = text('"}');
		const fill = HOST_JSON_MEMBER_MAX_ENTITY_BYTES - head.byteLength - tail.byteLength;
		const filled = (count: number): JsonMemberDecoder => {
			const decoder = createJsonMemberDecoder("raw");
			decoder.push(head);
			pushRepeated(decoder, 0x61, count);
			return decoder;
		};
		const exact = filled(fill);
		exact.push(tail);
		exact.end();
		expect(exact.counters().decompressedEntityBytes).toBe(HOST_JSON_MEMBER_MAX_ENTITY_BYTES);
		for (const extra of [" ", "x"]) {
			const over = filled(fill);
			over.push(tail);
			expect(refusal(() => over.push(text(extra)))).toMatchObject({
				code: "ENTITY_TOO_LARGE",
				hostError: "TOO_LARGE",
			});
		}
		// A chunk that crosses the bound is refused even though the document ends inside it.
		const crossing = filled(fill - 1);
		expect(refusal(() => crossing.push(text('a"} ')))?.code).toBe("ENTITY_TOO_LARGE");
	});

	it("counts compressed input up to 48 MiB, independently of the entity", () => {
		const decoder = createJsonMemberDecoder("raw");
		decoder.countCompressed(HOST_JSON_MEMBER_MAX_ENTITY_BYTES - 1);
		decoder.countCompressed(1);
		decoder.countCompressed(0);
		decoder.push(text('{"raw":"Zg"}'));
		decoder.end();
		expect(decoder.counters()).toMatchObject({
			compressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
			decompressedEntityBytes: 12,
		});
		const over = createJsonMemberDecoder("raw");
		over.countCompressed(HOST_JSON_MEMBER_MAX_ENTITY_BYTES);
		expect(refusal(() => over.countCompressed(1))).toMatchObject({
			code: "COMPRESSED_TOO_LARGE",
			hostError: "TOO_LARGE",
		});
	});

	it("refuses a compressed count that is not a whole nonnegative number", () => {
		for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "1", 1n, null]) {
			const decoder = createJsonMemberDecoder("raw");
			expect(refusal(() => decoder.countCompressed(count as number))?.code).toBe("ENTITY_FAILED");
		}
	});
});

describe("stricter limits", () => {
	it("lowers each maximum, inclusively", () => {
		expect(hex(decode("raw", [text('{"raw":"Zm9v"}')], { decodedBytes: 3 }))).toBe("666f6f");
		expect(codeOf("raw", [text('{"raw":"Zm9vZg"}')], { decodedBytes: 3 })).toBe(
			"DECODED_TOO_LARGE",
		);
		expect(hex(decode("raw", [text('{"raw":""}')], { decodedBytes: 0 }))).toBe("");
		expect(codeOf("raw", [text('{"raw":"Zg"}')], { decodedBytes: 0 })).toBe("DECODED_TOO_LARGE");
		const stopped = createJsonMemberDecoder("raw", { decodedBytes: 4 });
		expect(refusal(() => stopped.push(text('{"raw":"Zm9vZm9v"}')))?.code).toBe("DECODED_TOO_LARGE");
		expect(stopped.counters().decodedBytes).toBe(3);
		const entity = text('{"raw":"Zg"}');
		const limit = { decompressedEntityBytes: entity.byteLength };
		expect(hex(decode("raw", [entity], limit))).toBe("66");
		expect(codeOf("raw", [entity, text(" ")], limit)).toBe("ENTITY_TOO_LARGE");
		expect(codeOf("raw", [text('{"raw":"Zg"}x')], limit)).toBe("ENTITY_TOO_LARGE");
		const compressed = createJsonMemberDecoder("raw", { compressedEntityBytes: 5 });
		compressed.countCompressed(5);
		expect(refusal(() => compressed.countCompressed(1))?.code).toBe("COMPRESSED_TOO_LARGE");
	});

	it("keeps the contract maximum for an absent or undefined limit", () => {
		const decoder = createJsonMemberDecoder("raw", {
			compressedEntityBytes: undefined,
			decodedBytes: undefined,
		});
		decoder.countCompressed(HOST_JSON_MEMBER_MAX_ENTITY_BYTES);
		expect(refusal(() => decoder.countCompressed(1))?.code).toBe("COMPRESSED_TOO_LARGE");
	});

	it("refuses a limit above its maximum or not a whole nonnegative number", () => {
		const maxima = {
			compressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
			decompressedEntityBytes: HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
			decodedBytes: HOST_JSON_MEMBER_MAX_DECODED_BYTES,
		};
		for (const [name, maximum] of Object.entries(maxima)) {
			expect(() =>
				createJsonMemberDecoder("raw", { [name]: maximum } as JsonMemberLimits),
			).not.toThrow();
			for (const value of [
				maximum + 1,
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
				"1",
				null,
				1n,
			])
				expect(() => createJsonMemberDecoder("raw", { [name]: value } as JsonMemberLimits)).toThrow(
					RangeError,
				);
		}
		const accessor = Object.defineProperty({}, "decodedBytes", { get: () => 1, enumerable: true });
		for (const limits of [null, "small", 1, new Proxy({}, {}), accessor])
			expect(() => createJsonMemberDecoder("raw", limits as JsonMemberLimits)).toThrow(RangeError);
	});

	it("refuses limits it would otherwise ignore, and reads a null-prototype object", () => {
		class Getter {
			get decodedBytes(): number {
				return 1;
			}
		}
		class Field {
			readonly decodedBytes = 1;
		}
		const ignored: unknown[] = [
			Object.create({ decodedBytes: 1 }),
			new Getter(),
			new Field(),
			Object.assign([], { decodedBytes: 1 }),
			{ decodedByte: 1 },
			{ decodedBytes: 1, [Symbol("decodedBytes")]: 1 },
		];
		for (const limits of ignored)
			expect(() => createJsonMemberDecoder("raw", limits as JsonMemberLimits)).toThrow(RangeError);
		const bare = Object.assign(Object.create(null) as JsonMemberLimits, { decodedBytes: 1 });
		expect(hex(decode("raw", [text('{"raw":"Zg"}')], bare))).toBe("66");
		expect(codeOf("raw", [text('{"raw":"Zm8"}')], bare)).toBe("DECODED_TOO_LARGE");
	});

	it("refuses a member other than raw or data", () => {
		for (const member of ["RAW", "Raw", "body.raw", "", "raw ", undefined, null])
			expect(refusal(() => createJsonMemberDecoder(member as JsonMember))).toMatchObject({
				code: "REQUEST_INVALID",
				hostError: "BAD_REQUEST",
			});
	});
});

describe("decoder lifecycle", () => {
	it("yields decoded bytes as they arrive, in fresh arrays", () => {
		const decoder = createJsonMemberDecoder("raw");
		const input = text('{"raw":"Zm9vYmFy"}');
		const first = decoder.push(input.subarray(0, 14));
		expect(hex(first)).toBe("666f6f");
		input.fill(0x20, 0, 14);
		const second = decoder.push(input.subarray(14));
		expect(hex(second)).toBe("626172");
		expect(hex(first)).toBe("666f6f");
		expect(first.buffer).not.toBe(second.buffer);
		expect(first.buffer).not.toBe(input.buffer);
		decoder.end();
	});

	it("reports actual input, character, byte, depth and node counts", () => {
		const decoder = createJsonMemberDecoder("raw");
		decoder.countCompressed(17);
		const entity = text('{"raw":"Zm8=","n":[1,{"a":null}],"s":"\\u0041"}');
		decoder.push(entity);
		decoder.end();
		const counters = decoder.counters();
		expect(counters).toEqual({
			compressedEntityBytes: 17,
			decompressedEntityBytes: entity.byteLength,
			encodedCharacters: 4,
			decodedBytes: 2,
			containerDepth: 3,
			valueNodes: 7,
		});
		expect(Object.isFrozen(counters)).toBe(true);
	});

	it("refuses an incomplete document only when the entity ends", () => {
		const decoder = createJsonMemberDecoder("raw");
		expect(hex(decoder.push(text('{"raw":"Zg"')))).toBe("66");
		expect(refusal(() => decoder.end())?.code).toBe("JSON_INVALID");
	});

	it("keeps its first refusal and refuses every later call with it", () => {
		const decoder = createJsonMemberDecoder("raw");
		const first = refusal(() => decoder.push(text('{"raw":"Zg","raw":"Zg"}')));
		expect(first?.code).toBe("DUPLICATE_KEY");
		expect(decoder.failure).toBe(first);
		expect(refusal(() => decoder.push(text(" ")))).toBe(first);
		expect(refusal(() => decoder.countCompressed(1))).toBe(first);
		expect(refusal(() => decoder.end())).toBe(first);
	});

	it("refuses input after the entity ended", () => {
		const decoder = createJsonMemberDecoder("raw");
		decoder.push(text('{"raw":"Zg"}'));
		decoder.end();
		expect(decoder.failure).toBeUndefined();
		expect(refusal(() => decoder.push(text(" ")))?.code).toBe("JSON_INVALID");
		expect(refusal(() => decoder.end())?.code).toBe("JSON_INVALID");
	});

	it("refuses a chunk that is not a byte array or whose memory is detached", () => {
		for (const chunk of [
			"{}",
			[0x7b],
			new ArrayBuffer(1),
			new DataView(new ArrayBuffer(1)),
			new Uint16Array(1),
			new Proxy(new Uint8Array(1), {}),
			detached(4),
			null,
			undefined,
		]) {
			const decoder = createJsonMemberDecoder("raw");
			expect(refusal(() => decoder.push(chunk as Uint8Array))?.code).toBe("ENTITY_FAILED");
		}
		const decoder = createJsonMemberDecoder("raw");
		expect(hex(decoder.push(Buffer.from('{"raw":"Zg"}')))).toBe("66");
		decoder.end();
		// A detached chunk inside the member is refused, not read as empty.
		const inside = createJsonMemberDecoder("raw");
		expect(hex(inside.push(text('{"raw":"Zm9v')))).toBe("666f6f");
		const refused = refusal(() => inside.push(detached(4)));
		expect(refused).toMatchObject({ code: "ENTITY_FAILED", hostError: "DENIED" });
		expect(refusal(() => inside.push(text('Zm9v"}')))).toBe(refused);
		expect(inside.counters()).toMatchObject({ decompressedEntityBytes: 12, decodedBytes: 3 });
	});

	it("carries no entity bytes, member text or names in a refusal", () => {
		const canary = "DYTESTcanary";
		for (const json of [
			`{"raw":"${canary}!"}`,
			`{"raw":"Zg","${canary}":1,"${canary}":2}`,
			`{"raw":"Zg","${canary}":tru}`,
		]) {
			const error = refusal(() => decode("raw", [text(json)]));
			expect(error).toBeInstanceOf(JsonMemberRefusal);
			const shown = `${String(error)} ${JSON.stringify(error)} ${error?.stack ?? ""}`;
			expect(shown).not.toContain(canary);
			expect(error?.message).toBe("Decoded JSON member refused");
			expect(Object.keys(error as object).sort()).toEqual(["code", "hostError", "name"]);
		}
	});

	it("maps malformed input to BAD_REQUEST and exhausted bounds to TOO_LARGE", () => {
		for (const hostError of Object.values(JSON_MEMBER_REFUSALS))
			expect(HOST_ERROR_CODES).toContain(hostError);
		const expected: Record<JsonMemberRefusalCode, string> = {
			REQUEST_INVALID: "BAD_REQUEST",
			REQUEST_DENIED: "DENIED",
			COMPRESSED_TOO_LARGE: "TOO_LARGE",
			ENTITY_TOO_LARGE: "TOO_LARGE",
			DECODED_TOO_LARGE: "TOO_LARGE",
			DEPTH_TOO_LARGE: "TOO_LARGE",
			NODES_TOO_LARGE: "TOO_LARGE",
			ERROR_BODY_TOO_LARGE: "TOO_LARGE",
			UTF8_INVALID: "BAD_REQUEST",
			JSON_INVALID: "BAD_REQUEST",
			DUPLICATE_KEY: "BAD_REQUEST",
			MEMBER_MISSING: "BAD_REQUEST",
			MEMBER_NOT_STRING: "BAD_REQUEST",
			ENCODING_INVALID: "BAD_REQUEST",
			ENTITY_FAILED: "DENIED",
			STORAGE_FAILED: "DENIED",
			ABORTED: "DENIED",
		};
		expect(JSON_MEMBER_REFUSALS).toEqual(expected);
		expect(new JsonMemberRefusal("DEPTH_TOO_LARGE")).toMatchObject({
			name: "JsonMemberRefusal",
			code: "DEPTH_TOO_LARGE",
			hostError: "TOO_LARGE",
		});
	});
});
