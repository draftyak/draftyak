import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	CONTEXT_IDS,
	DRAFT_OUTPUT_LIMITS,
	DraftOutputV1,
	normalizeDraftOutput,
	validateDraftOutput,
} from "../src/draft-output.ts";
import { jcsSha256 } from "../src/hash.ts";
import { agree, committed, withMember } from "./plugin-contracts.ts";

const sample = {
	body: "Thanks, DYTEST. Tuesday at 10 works for me.",
	ownerNotes: "They asked for a time; I proposed Tuesday.",
	needsOwnerInput: ["Is Tuesday still free?"],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
const astral = "\u{1f600}";
const loneSurrogate = "DYTEST \udc00";

describe("DraftOutputV1", () => {
	it("agrees with spec/schemas/draft-output-v1.schema.json", () => {
		agree(
			DraftOutputV1,
			committed("schemas/draft-output-v1.schema.json"),
			[
				sample,
				withMember(sample, "contextRefs", []),
				withMember(sample, "contextRefs", ["c3", "c1", "c2"]),
				withMember(sample, "body", astral.repeat(DRAFT_OUTPUT_LIMITS.body)),
				withMember(sample, "needsOwnerInput", ["1", "2", "3", "4", "5"]),
			],
			[
				withMember(sample, "contextRefs", ["c1", "c1"]),
				withMember(sample, "contextRefs", ["c4"]),
				withMember(sample, "contextRefs", ["C1"]),
				withMember(sample, "body", `${astral.repeat(DRAFT_OUTPUT_LIMITS.body)}x`),
				withMember(sample, "ownerNotes", "x".repeat(DRAFT_OUTPUT_LIMITS.ownerNotes + 1)),
				withMember(sample, "needsOwnerInput", ["1", "2", "3", "4", "5", "6"]),
				withMember(sample, "needsOwnerInput", [
					"x".repeat(DRAFT_OUTPUT_LIMITS.needsOwnerInputItem + 1),
				]),
				withMember(sample, "suspectedInstructions", "no"),
				withMember(sample, "recipient", "sam@example.com"),
			],
		);
	});
});

describe("validateDraftOutput", () => {
	it("accepts a draft as it is", () => {
		expect(validateDraftOutput(sample)).toEqual({ ok: true, output: sample });
	});

	it.each([
		[
			"a recipient",
			withMember(sample, "recipient", "sam@example.com"),
			"output: unrecognized_keys",
		],
		["a subject", withMember(sample, "subject", "Re: DYTEST"), "output: unrecognized_keys"],
		["attachments", withMember(sample, "attachments", []), "output: unrecognized_keys"],
		[
			"an over-long body",
			withMember(sample, "body", "x".repeat(DRAFT_OUTPUT_LIMITS.body + 1)),
			"output.body: at most 8000 characters",
		],
		[
			"too many owner questions",
			withMember(sample, "needsOwnerInput", ["1", "2", "3", "4", "5", "6"]),
			"output.needsOwnerInput: too_big",
		],
		["a missing field", { ...sample, ownerNotes: undefined }, "output.ownerNotes: invalid_type"],
		[
			"a lone surrogate in the body",
			withMember(sample, "body", loneSurrogate),
			"output.body: lone surrogate",
		],
		[
			"a lone surrogate in the owner notes",
			withMember(sample, "ownerNotes", loneSurrogate),
			"output.ownerNotes: lone surrogate",
		],
		[
			"a lone surrogate in an owner question",
			withMember(sample, "needsOwnerInput", [loneSurrogate]),
			"output.needsOwnerInput.0: lone surrogate",
		],
	])("refuses %s, naming the path and never the value", (_name, value, problem) => {
		const result = validateDraftOutput(value);
		expect(result).toEqual({ ok: false, problems: [problem] });
		expect(JSON.stringify(result)).not.toMatch(/sam@|Re: DYTEST|DYTEST \\udc00/);
	});

	it("refuses only what no hash could take: a valid draft always canonicalizes", () => {
		expect(() => jcsSha256(withMember(sample, "body", loneSurrogate))).toThrow(/LONE_SURROGATE/);
		expect(jcsSha256(sample)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("refuses what isn't an object", () => {
		for (const value of [null, "draft", [sample]])
			expect(validateDraftOutput(value).ok).toBe(false);
	});
});

describe("normalizeDraftOutput", () => {
	it.each([
		["an unknown id", ["c1", "c9"], ["c1"]],
		["a differently cased id", ["C2"], ["c2"]],
		["a repeated id", ["c1", "c1", "c1", "c1"], ["c1"]],
		["an id that isn't a string", [1, null, "c3"], ["c3"]],
		["ids out of order", ["c3", "c1"], ["c1", "c3"]],
		["a list that isn't one", "c1", []],
		["a null list", null, []],
		["an object", { c1: true }, []],
	])("drops %s and keeps the draft", (_name, refs, kept) => {
		const normalized = normalizeDraftOutput(withMember(sample, "contextRefs", refs), CONTEXT_IDS);
		expect(normalized).toEqual({ ...sample, contextRefs: kept });
		expect(validateDraftOutput(normalized).ok).toBe(true);
	});

	it("gives a draft without contextRefs an empty list", () => {
		const { contextRefs: _, ...without } = sample;
		expect(normalizeDraftOutput(without, ["c1"])).toEqual({ ...sample, contextRefs: [] });
	});

	it("keeps only the job's own context ids", () => {
		const refs = withMember(sample, "contextRefs", ["c3", "c1", "c2"]);
		expect(normalizeDraftOutput(refs, ["c1", "c3"])).toEqual({
			...sample,
			contextRefs: ["c1", "c3"],
		});
		expect(normalizeDraftOutput(refs, [])).toEqual({ ...sample, contextRefs: [] });
	});

	it("leaves everything else to validateDraftOutput", () => {
		const long = withMember(sample, "body", "x".repeat(DRAFT_OUTPUT_LIMITS.body + 1));
		expect(normalizeDraftOutput(long, CONTEXT_IDS)).toEqual(long);
		for (const value of [null, "x", 1, [sample]]) {
			expect(normalizeDraftOutput(value, CONTEXT_IDS)).toBe(value);
		}
	});

	it("always yields valid contextRefs within the job's ids, from any value (1,000 runs)", () => {
		const ref = fc.oneof(fc.constantFrom(...CONTEXT_IDS, "C1", "c4", ""), fc.anything());
		const refs = fc.oneof(fc.array(ref, { maxLength: 8 }), fc.anything());
		fc.assert(
			fc.property(refs, fc.subarray([...CONTEXT_IDS]), (contextRefs, ids) => {
				const normalized = normalizeDraftOutput({ ...sample, contextRefs }, ids);
				const result = validateDraftOutput(normalized);
				expect(result.ok).toBe(true);
				if (result.ok) for (const id of result.output.contextRefs) expect(ids).toContain(id);
			}),
			{ numRuns: 1000 },
		);
	});
});
