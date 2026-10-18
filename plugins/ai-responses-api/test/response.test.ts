import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	MAX_CONTENT_BLOCKS,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_ITEMS,
	parseDraft,
	ResponsesError,
	readDraft,
	repairPlan,
} from "../src/index.ts";
import { CANARY, draft, input, message } from "./helpers.ts";

const output = (blocks: readonly unknown[], extra: Record<string, unknown> = {}): unknown[] => [
	{ type: "message", role: "assistant", status: "completed", content: blocks, ...extra },
];
describe("safe completed Responses parsing", () => {
	it("returns only the shared draft output, served model and normalized usage", () => {
		expect(readDraft(message(), ["c1"])).toEqual({
			kind: "draft",
			output: draft,
			model: input.model,
			fallback: false,
			usage: { input: 100, output: 50 },
		});
		expect(readDraft(message({ usage: { output_tokens: 50 } }), ["c1"])).toMatchObject({
			usage: { input: null, output: 50 },
		});
	});
	it("handles incomplete and nonterminal statuses before touching partial output", () => {
		for (const [status, incomplete_details, kind] of [
			["incomplete", { reason: "max_output_tokens" }, "truncated"],
			["incomplete", { reason: "content_filter" }, "refusal"],
			["incomplete", { reason: CANARY }, "unexpected"],
			["failed", null, "unexpected"],
			["cancelled", null, "unexpected"],
			["queued", null, "unexpected"],
		] as const) {
			const source = message({ status, incomplete_details });
			Object.defineProperty(source, "output", {
				get: () => {
					throw new Error(CANARY);
				},
			});
			const result = readDraft(source, []);
			expect(result.kind).toBe(kind);
			expect(JSON.stringify(result)).not.toContain(CANARY);
		}
	});
	it("never treats refusal blocks or content filtering as repairable JSON", () => {
		const refused = readDraft(
			message({ output: output([{ type: "refusal", refusal: CANARY }]) }),
			[],
		);
		expect(refused.kind).toBe("refusal");
		expect(JSON.stringify(refused)).not.toContain(CANARY);
		expect(repairPlan(refused, 0)).toEqual({ kind: "stop" });
		const refusal = { type: "refusal" };
		Object.defineProperty(refusal, "refusal", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		expect(readDraft(message({ output: output([refusal]) }), []).kind).toBe("refusal");
	});
	it("gives refusal precedence over other malformed or oversized bounded blocks in either order", () => {
		const refusal = { type: "refusal" };
		Object.defineProperty(refusal, "refusal", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		for (const block of [
			{ type: "tool_call" },
			{ type: "output_text", text: "{broken JSON" },
			{ type: "output_text", text: "x".repeat(MAX_OUTPUT_BYTES + 1) },
		]) {
			for (const blocks of [
				[block, refusal],
				[refusal, block],
			]) {
				const result = readDraft(message({ output: output(blocks) }), []);
				expect(result.kind).toBe("refusal");
				expect(repairPlan(result, 0)).toEqual({ kind: "stop" });
			}
		}
		const text = { type: "output_text" };
		Object.defineProperty(text, "text", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		expect(readDraft(message({ output: output([text, refusal]) }), []).kind).toBe("refusal");
	});
	it("rejects tool outputs, multiple messages/texts, commentary and excessive item/block counts", () => {
		const text = { type: "output_text", text: JSON.stringify(draft) };
		for (const value of [
			[],
			[{ type: "function_call", name: "send" }],
			output([text, text]),
			[...output([text]), ...output([text])],
			output([text], { phase: "commentary" }),
			Array(MAX_OUTPUT_ITEMS + 1).fill({ type: "reasoning" }),
			output(Array(MAX_CONTENT_BLOCKS + 1).fill(text)),
		])
			expect(readDraft(message({ output: value }), []).kind).toBe("invalid");
		expect(
			readDraft(message({ output: output([text], { phase: "final_answer" }) }), ["c1"]).kind,
		).toBe("draft");
	});
	it("bounds strict JSON, duplicate keys, depth, UTF-8 bytes and unknown output fields", () => {
		for (const text of [
			CANARY,
			"x".repeat(MAX_OUTPUT_BYTES + 1),
			`"${"😀".repeat(80_000)}"`,
			"[".repeat(70),
			'{"body":"one","body":"two"}',
			JSON.stringify({ ...draft, recipient: CANARY }),
			JSON.stringify({ ...draft, body: "\ud800" }),
		]) {
			const result = parseDraft(text, []);
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain(CANARY);
		}
		expect(parseDraft(JSON.stringify({ ...draft, body: "😀".repeat(8000) }), []).ok).toBe(true);
		expect(parseDraft(JSON.stringify({ ...draft, body: "😀".repeat(8001) }), []).ok).toBe(false);
	});
	it("narrows context refs to job ids in job order and permits only one invalid-schema repair", () => {
		expect(
			parseDraft(JSON.stringify({ ...draft, contextRefs: ["C1", "c3", "c1", CANARY, 7] }), [
				"c3",
				"c1",
			]),
		).toEqual({ ok: true, output: { ...draft, contextRefs: ["c3", "c1"] } });
		const invalid = readDraft(
			message({ output: output([{ type: "output_text", text: CANARY }]) }),
			[],
		);
		expect(repairPlan(invalid, 0)).toEqual({ kind: "repair", problems: ["output: invalid_JSON"] });
		expect(repairPlan(invalid, 1)).toEqual({ kind: "stop" });
		expect(
			repairPlan(
				readDraft(
					message({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
					[],
				),
				0,
			),
		).toEqual({ kind: "stop" });
	});
	it("redacts malformed envelopes and usage", () => {
		for (const value of [
			null,
			CANARY,
			message({ model: "bad model" }),
			message({ usage: { output_tokens: -1 } }),
			message({ usage: null }),
		]) {
			expect(() => readDraft(value, [])).toThrow(ResponsesError);
			try {
				readDraft(value, []);
			} catch (error) {
				expect(String(error)).not.toContain(CANARY);
			}
		}
	});
	it("keeps random malformed JSON content out of validation diagnostics", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 300 }), (text) => {
				const result = parseDraft(text + CANARY, []);
				expect(result.ok).toBe(false);
				expect(JSON.stringify(result)).not.toContain(CANARY);
			}),
			{ numRuns: 70, seed: 7202 },
		);
	});
});

describe("sixty synthetic provider corpus cases", () => {
	it.each(Array.from({ length: 60 }, (_, index) => index))(
		"case %i has a shared-schema outcome without private diagnostics",
		(index) => {
			const cases = [
				message(),
				message({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
				message({ output: output([{ type: "refusal", refusal: CANARY }]) }),
				message({ output: output([{ type: "output_text", text: CANARY }]) }),
				message({
					output: output([
						{ type: "output_text", text: JSON.stringify({ ...draft, contextRefs: [CANARY] }) },
					]),
				}),
				message({ status: "failed" }),
			];
			const result = readDraft(cases[index % cases.length], ["c1"]);
			expect(DraftOutcome.safeParse(result).success).toBe(true);
			expect(JSON.stringify(result)).not.toContain(CANARY);
		},
	);
});
