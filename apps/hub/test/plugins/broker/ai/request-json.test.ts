import { Buffer } from "node:buffer";
import * as jcs from "@draftyak/protocol/jcs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_AI_REQUEST_JSON_UNITS,
	parseCapturedAiRequestBody,
} from "../../../../src/plugins/broker/ai/request-json.ts";
import { AiVerificationError } from "../../../../src/plugins/broker/ai/types.ts";

const originalParseStrict = jcs.parseStrict;
function observeStrictParser() {
	return vi.spyOn(jcs, "parseStrict").mockImplementation((input) => originalParseStrict(input));
}
let parser: ReturnType<typeof observeStrictParser>;
beforeEach(() => {
	parser = observeStrictParser();
});
afterEach(() => {
	vi.restoreAllMocks();
});

function fixed(error: unknown): void {
	expect(error).toBeInstanceOf(AiVerificationError);
	if (!(error instanceof AiVerificationError)) throw new Error("Expected AI request refusal");
	expect(error.name).toBe("AiVerificationError");
	expect(error.code).toBe("AI_REQUEST_REFUSED");
	expect(error.message).toBe("Provider request refused");
	expect("cause" in error).toBe(false);
}
function accepted(bytes: Uint8Array): void {
	const expected = originalParseStrict(bytes);
	parser.mockClear();
	const actual = parseCapturedAiRequestBody(bytes);
	// This positive also proves that the real parser spy observes the consumed import.
	expect(parser).toHaveBeenCalledTimes(1);
	expect(actual).toStrictEqual(expected);
}
function attempt(bytes: Uint8Array): unknown {
	try {
		parseCapturedAiRequestBody(bytes);
	} catch (error) {
		return error;
	}
	return undefined;
}
function excess(bytes: Uint8Array): void {
	accepted(Buffer.from("[0]"));
	parser.mockClear();
	const error = attempt(bytes);
	// Assert the preparse boundary first, without downstream schema/signature credit.
	expect(parser).not.toHaveBeenCalled();
	fixed(error);
}
function strictFailure(bytes: Uint8Array): void {
	accepted(Buffer.from("0"));
	expect(() => originalParseStrict(bytes)).toThrow();
	parser.mockClear();
	const error = attempt(bytes);
	expect(parser).toHaveBeenCalledTimes(1);
	fixed(error);
}
function flatArray(members: number): Buffer {
	return Buffer.from(`[${"0,".repeat(members - 1)}0]`);
}
function flatObject(members: number): Buffer {
	return Buffer.from(`{${Array.from({ length: members }, (_, at) => `"k${at}":0`).join(",")}}`);
}

describe("captured AI request JSON structure", () => {
	it("keeps the fixed ceiling and delegates ordinary values to the real strict parser", () => {
		expect(MAX_AI_REQUEST_JSON_UNITS).toBe(4096);
		for (const value of [null, true, 0, "DYTEST", [], {}, { prompt: "DYTEST", context: [] }]) {
			accepted(Buffer.from(JSON.stringify(value)));
		}
	});

	it("accepts a 4095-member flat array at the exact ceiling", () => {
		accepted(flatArray(4095));
	});

	it("rejects a 4096-member flat array before strict parsing", () => {
		const bytes = flatArray(4096);
		expect(bytes.byteLength).toBeLessThan(16 * 1024);
		excess(bytes);
	});

	it("accepts the exact flat-object boundary and refuses one additional property", () => {
		accepted(flatObject(4095));
		excess(flatObject(4096));
	});

	it("charges empty containers without confusing them with primitive members", () => {
		const empties = Array.from({ length: 2047 }, (_, at) => (at % 2 ? "{}" : "[]")).join(",");
		accepted(Buffer.from(`[${empties},0]`));
		excess(Buffer.from(`[${empties},{}]`));
	});

	it("counts nested singleton chains below the independent strict depth limit", () => {
		expect(jcs.JCS_MAX_DEPTH).toBe(64);
		const chain = `${"[".repeat(62)}0${"]".repeat(62)}`;
		// 65 chains with 62 containers each have 4096 units, at depth 63.
		accepted(Buffer.from(`[${Array(65).fill(chain).join(",")}]`));
		excess(Buffer.from(`[${Array(66).fill(chain).join(",")}]`));
	});

	it("preserves quote and backslash parity while ignoring escaped and Unicode punctuation", () => {
		const samples = [
			"[,{}]",
			'\\"[,{}]',
			"\\\\",
			"\\",
			'quote"then\\',
			"DYTEST-\u00c5-\ud83d\udc02",
		];
		const values = Array.from({ length: 4095 }, (_, at) => samples[at % samples.length]);
		accepted(Buffer.from(JSON.stringify(values)));
		excess(Buffer.from(JSON.stringify([...values, "DYTEST-extra"])));
		accepted(Buffer.from(String.raw`"\u005b\u005d\u007b\u007d\u002c\u0022\u005c"`));
	});

	it("accepts millions of punctuation bytes inside one genuine JSON string", () => {
		const value = "[,{}]".repeat(400_000);
		expect(value.length).toBe(2_000_000);
		accepted(Buffer.from(JSON.stringify(value)));
	});

	it.each([
		{ name: "malformed UTF-8", bytes: Buffer.from([34, 255, 34]) },
		{ name: "duplicate keys", bytes: Buffer.from('{"x":0,"x":1}') },
		{ name: "truncated grammar", bytes: Buffer.from('{"x":') },
		{ name: "invalid string escapes", bytes: Buffer.from(String.raw`"\q"`) },
		{ name: "invalid numeric grammar", bytes: Buffer.from("01") },
		{
			name: "excessive depth",
			bytes: Buffer.from(
				`${"[".repeat(jcs.JCS_MAX_DEPTH + 1)}0${"]".repeat(jcs.JCS_MAX_DEPTH + 1)}`,
			),
		},
	])("leaves $name to the real strict parser", ({ bytes }) => {
		strictFailure(bytes);
	});

	it("rejects the 8 MiB flat issue witness without invoking strict parsing", () => {
		const bytes = 8 * 1024 * 1024;
		const flat = `${"0,".repeat(4_194_302)}0`;
		const flatWitness = Buffer.from(`[${flat}] `);
		expect(flatWitness.byteLength).toBe(bytes);
		excess(flatWitness);
	});

	it("rejects the 8 MiB singleton-chain issue witness without invoking strict parsing", () => {
		const bytes = 8 * 1024 * 1024;
		// Encoded text only: setup never materializes the millions of possible values.
		const chain = `${"[".repeat(62)}0${"]".repeat(62)}`;
		const count = Math.floor((bytes - 2) / (chain.length + 1));
		const encoded = `[${`${chain},`.repeat(count - 1)}${chain}]`;
		const nestedWitness = Buffer.from(encoded + " ".repeat(bytes - encoded.length));
		expect(nestedWitness.byteLength).toBe(bytes);
		excess(nestedWitness);
	});
});
