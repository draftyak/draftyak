import { describe, expect, it, vi } from "vitest";
import { DraftProblem } from "../src/ai-provider-v1.ts";
import {
	type ContextId,
	type DraftOutputV1,
	normalizeDraftOutput,
	validateDraftOutput,
} from "../src/draft-output.ts";
import { MAX_DRAFT_OUTPUT_TEXT_BYTES, parseDraftOutputText } from "../src/draft-output-text.ts";

const draft: DraftOutputV1 = {
	body: "DYTEST reply",
	ownerNotes: "",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: [],
};
const encode = (value: unknown): string => JSON.stringify(value);
const invalidJson = { ok: false, problems: ["output: invalid_JSON"] };

describe("bounded draft text shared by provider readers", () => {
	it("accepts a completed draft and preserves the existing informational context normalization", () => {
		const value = { ...draft, contextRefs: ["C2", "foreign", "c1", "C1"] };
		expect(parseDraftOutputText(encode(value), ["c1", "c2"])).toEqual({
			ok: true,
			output: { ...draft, contextRefs: ["c1", "c2"] },
		});
	});
	it("accepts the exact ASCII byte bound and refuses its otherwise-valid neighbor", () => {
		expect(MAX_DRAFT_OUTPUT_TEXT_BYTES).toBe(262_144);
		const text = encode(draft);
		const exact = text.padEnd(MAX_DRAFT_OUTPUT_TEXT_BYTES, " ");
		expect(new TextEncoder().encode(exact).byteLength).toBe(MAX_DRAFT_OUTPUT_TEXT_BYTES);
		expect(parseDraftOutputText(exact, [])).toEqual({ ok: true, output: draft });
		expect(parseDraftOutputText(`${exact} `, [])).toEqual({
			ok: false,
			problems: ["output: too_big"],
		});
	});
	it("accepts JSON whitespace around a single completed draft", () => {
		expect(parseDraftOutputText(`\t \r\n${encode(draft)}\n `, [])).toEqual({
			ok: true,
			output: draft,
		});
	});
	it.each([
		{ name: "a JSON code fence", text: ["```json", encode(draft), "```"].join("\n") },
		{ name: "leading prose", text: `DYTEST answer: ${encode(draft)}` },
		{ name: "trailing prose", text: `${encode(draft)} DYTEST explanation` },
		{ name: "a byte-order mark", text: `\ufeff${encode(draft)}` },
	])("refuses $name instead of extracting or stripping it", ({ text }) => {
		expect(parseDraftOutputText(text, [])).toEqual(invalidJson);
	});
	it.each([
		{ name: "ASCII JSON nesting", text: "[".repeat(262_145) },
		{ name: "multibyte non-JSON text", text: "\u{1F600}".repeat(70_000) },
	])("caps $name before strict parsing", ({ text }) => {
		expect(parseDraftOutputText(text, [])).toEqual({
			ok: false,
			problems: ["output: too_big"],
		});
	});
	it("enforces UTF-8 bytes when a valid multibyte draft remains below the UTF-16 limit", () => {
		const value = { ...draft, body: "😀".repeat(8_000) };
		expect(validateDraftOutput(value).ok).toBe(true);
		const text = encode(value);
		const exact =
			text + " ".repeat(MAX_DRAFT_OUTPUT_TEXT_BYTES - new TextEncoder().encode(text).byteLength);
		expect(exact.length + 1).toBeLessThan(MAX_DRAFT_OUTPUT_TEXT_BYTES);
		expect(parseDraftOutputText(exact, [])).toEqual({ ok: true, output: value });
		expect(parseDraftOutputText(`${exact} `, [])).toEqual({
			ok: false,
			problems: ["output: too_big"],
		});
	});
	it("refuses repeated keys even when JSON.parse would produce a valid draft", () => {
		const text = encode(draft).replace('"body":', '"body":"DYTEST duplicate", "body":');
		expect(validateDraftOutput(JSON.parse(text)).ok).toBe(true);
		expect(parseDraftOutputText(text, [])).toEqual(invalidJson);
	});
	it("refuses excessive balanced JSON depth before informational refs could be dropped", () => {
		let nested: unknown = "c1";
		for (let depth = 0; depth < 65; depth++) nested = [nested];
		const text = encode({ ...draft, contextRefs: nested });
		expect(() => JSON.parse(text)).not.toThrow();
		expect(validateDraftOutput(normalizeDraftOutput(JSON.parse(text), [])).ok).toBe(true);
		expect(parseDraftOutputText(text, [])).toEqual(invalidJson);
	});
	it.each(["{", '"\\ud800"', '{"body":1e999}', "\ufeff{}"])(
		"returns fixed JSON errors without echoing text: %s",
		(text) => {
			expect(parseDraftOutputText(text, [])).toEqual(invalidJson);
		},
	);
	it("keeps schema failures separate from malformed JSON and returns no model text", () => {
		const value = {
			...draft,
			body: 1,
			ownerNotes: "DYTEST_PRIVATE_CANARY",
			recipient: "DYTEST_PRIVATE_ADDRESS",
		};
		const result = parseDraftOutputText(encode(value), []);
		expect(result).toEqual(validateDraftOutput(value));
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("DYTEST_PRIVATE");
	});
	it.each([{ contextIds: ["c1", "c1"] }, { contextIds: ["foreign"] }])(
		"throws a content-free caller error for invalid hub context catalogues",
		({ contextIds }) => {
			expect(() => parseDraftOutputText(encode(draft), contextIds as readonly ContextId[])).toThrow(
				new TypeError("Invalid draft context catalogue"),
			);
		},
	);
	it.each([
		{ name: "null", text: null },
		{ name: "undefined", text: undefined },
		{ name: "a number", text: 262_145 },
		{ name: "encoded bytes", text: new Uint8Array([123, 125]) },
	])("throws a content-free caller error for $name text", ({ text }) => {
		expect(() => parseDraftOutputText(text as unknown as string, [])).toThrow(
			new TypeError("Draft text must be a string"),
		);
	});
	it("rethrows unexpected encoding failures rather than classifying a model draft", () => {
		const text = encode(draft);
		const failure = new Error("DYTEST unexpected encoding failure");
		const encoder = vi.spyOn(TextEncoder.prototype, "encode").mockImplementationOnce(() => {
			throw failure;
		});
		let caught: unknown;
		try {
			parseDraftOutputText(text, []);
		} catch (error) {
			caught = error;
		} finally {
			encoder.mockRestore();
		}
		expect(caught).toBe(failure);
	});
	it("returns fixed problems accepted by the merged draft outcome contract", () => {
		const failures = [parseDraftOutputText("{", []), parseDraftOutputText("[".repeat(262_145), [])];
		const problems = failures.flatMap((result) => (result.ok ? [] : result.problems));
		expect(problems).toEqual(["output: invalid_JSON", "output: too_big"]);
		for (const problem of problems) expect(DraftProblem.safeParse(problem).success).toBe(true);
	});
});
