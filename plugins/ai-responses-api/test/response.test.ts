import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import type { ContextId } from "@draftyak/protocol/draft-output";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	MAX_CONTENT_BLOCKS,
	MAX_DRAFT_OUTPUT_TEXT_BYTES,
	MAX_OUTPUT_ITEMS,
	ResponsesError,
	readDraft,
} from "../src/index.ts";
import { CANARY, draft, input, message } from "./helpers.ts";

const output = (blocks: readonly unknown[], extra: Record<string, unknown> = {}): unknown[] => [
	{ type: "message", role: "assistant", status: "completed", content: blocks, ...extra },
];
const textOutcome = (text: string, contextIds: readonly ContextId[] = ["c1"]): DraftOutcome =>
	readDraft(message({ output: output([{ type: "output_text", text }]) }), contextIds);
const text = { type: "output_text", text: JSON.stringify(draft) };

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
	it.each(["cancelled", "queued", "in_progress"])(
		"reads %s before absent usage or partial output",
		(status) => {
			for (const usage of [undefined, null]) {
				const source = message({ status, usage });
				Object.defineProperty(source, "output", {
					get: () => {
						throw new Error(CANARY);
					},
				});
				expect(readDraft(source, [])).toEqual({
					kind: "unexpected",
					stopReason: status,
					model: input.model,
					fallback: false,
					usage: { input: null, output: 0 },
				});
			}
		},
	);
	it("preserves valid usage on cancelled and nonterminal outcomes", () => {
		for (const status of ["cancelled", "queued", "in_progress"])
			expect(readDraft(message({ status }), [])).toMatchObject({
				kind: "unexpected",
				stopReason: status,
				usage: { input: 100, output: 50 },
			});
	});
	it("refuses malformed provided nonterminal usage instead of inventing accounting", () => {
		for (const status of ["cancelled", "queued", "in_progress"])
			for (const usage of [
				false,
				{},
				{ output_tokens: -1 },
				{ output_tokens: 1.5 },
				{ input_tokens: -1, output_tokens: 1 },
			])
				expect(() => readDraft(message({ status, usage }), [])).toThrowError(
					expect.objectContaining({ code: "TRANSIENT" }),
				);
	});
	it("maps a failed provider error before reading usage, model or output", () => {
		const source = {
			status: "failed",
			error: { code: "RATE_LIMITED", retryAfterMs: 0, detail: CANARY },
		};
		for (const key of ["usage", "model", "output"])
			Object.defineProperty(source, key, {
				get: () => {
					throw new Error(CANARY);
				},
			});
		expect(() => readDraft(source, [])).toThrowError(
			expect.objectContaining({
				code: "RATE_LIMITED",
				retryAfterMs: 0,
				message: "responses: RATE_LIMITED",
			}),
		);
		expect(() =>
			readDraft({ status: "failed", error: { code: "insufficient_quota" } }, []),
		).toThrowError(expect.objectContaining({ code: "QUOTA_EXCEEDED" }));
	});
	it("handles incomplete stops before touching partial output", () => {
		for (const [reason, kind] of [
			["max_output_tokens", "truncated"],
			["content_filter", "refusal"],
			[CANARY, "unexpected"],
		]) {
			const source = message({ status: "incomplete", incomplete_details: { reason } });
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
	it("requires valid usage for completed and incomplete responses", () => {
		for (const status of ["completed", "incomplete"])
			for (const usage of [
				undefined,
				null,
				{ output_tokens: -1 },
				{ output_tokens: 1.5 },
				{ output_tokens: 1, input_tokens: -1 },
			])
				expect(() => readDraft(message({ status, usage }), [])).toThrowError(
					expect.objectContaining({ code: "TRANSIENT", message: "responses: TRANSIENT" }),
				);
	});
	it("gives bounded refusal tags precedence without reading refused or malformed text", () => {
		const refusal = { type: "refusal" };
		Object.defineProperty(refusal, "refusal", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		const unread = { type: "output_text" };
		Object.defineProperty(unread, "text", {
			get: () => {
				throw new Error(CANARY);
			},
		});
		for (const block of [
			unread,
			{ type: "tool_call" },
			{ type: "output_text", text: "{broken" },
			{ type: "output_text", text: "x".repeat(MAX_DRAFT_OUTPUT_TEXT_BYTES + 1) },
		])
			for (const blocks of [
				[block, refusal],
				[refusal, block],
			])
				expect(readDraft(message({ output: output(blocks) }), []).kind).toBe("refusal");
	});
	it("classifies malformed, tool, nonfinal and nonassistant envelopes as nonrepairable", () => {
		for (const value of [
			[],
			[null],
			[{ type: "function_call", name: CANARY }],
			output([text, text]),
			[...output([text]), ...output([text])],
			output([text], { phase: "commentary" }),
			output([text], { role: "user" }),
			output([text], { status: "in_progress" }),
			output([{ type: "output_text", text: 7 }]),
			output([{ type: "tool_call" }]),
		]) {
			const result = readDraft(message({ output: value }), ["c1"]);
			expect(result).toMatchObject({ kind: "unexpected", stopReason: "unexpected_output" });
			expect(JSON.stringify(result)).not.toContain(CANARY);
		}
		expect(
			readDraft(message({ output: output([text], { phase: "final_answer" }) }), ["c1"]).kind,
		).toBe("draft");
	});
	it("admits exactly the item cap with a valid final message and refuses one more", () => {
		const reasoning = { type: "reasoning" };
		const final = output([text]);
		expect(
			readDraft(message({ output: [...Array(MAX_OUTPUT_ITEMS - 1).fill(reasoning), ...final] }), [
				"c1",
			]).kind,
		).toBe("draft");
		expect(
			readDraft(message({ output: [...Array(MAX_OUTPUT_ITEMS).fill(reasoning), ...final] }), [
				"c1",
			]),
		).toMatchObject({ kind: "unexpected", stopReason: "unexpected_output" });
	});
	it("refuses an over-cap block array before inspecting any block", () => {
		const blocks = Array(MAX_CONTENT_BLOCKS + 1).fill(text);
		let reads = 0;
		Object.defineProperty(blocks, 0, {
			get: () => {
				reads++;
				throw new Error(CANARY);
			},
		});
		expect(readDraft(message({ output: output(blocks) }), ["c1"])).toMatchObject({
			kind: "unexpected",
			stopReason: "unexpected_output",
		});
		expect(reads).toBe(0);
	});
	it.each(["Tuesday works.", "\u{1f600}"])(
		"pins the shared UTF-8 text limit with a valid draft body %s",
		(body) => {
			const json = JSON.stringify({ ...draft, body });
			const padded = json + " ".repeat(MAX_DRAFT_OUTPUT_TEXT_BYTES - Buffer.byteLength(json));
			expect(Buffer.byteLength(padded)).toBe(MAX_DRAFT_OUTPUT_TEXT_BYTES);
			expect(textOutcome(padded)).toMatchObject({ kind: "draft", output: { ...draft, body } });
			expect(textOutcome(`${padded} `)).toMatchObject({
				kind: "unexpected",
				stopReason: "unexpected_output",
			});
			if (body === "\u{1f600}")
				expect(`${padded} `.length).toBeLessThanOrEqual(MAX_DRAFT_OUTPUT_TEXT_BYTES);
		},
	);
	it("refuses duplicate keys in otherwise valid complete draft JSON", () => {
		const json = `{"body":"discarded",${JSON.stringify(draft).slice(1)}`;
		expect(JSON.parse(json)).toEqual(draft);
		expect(textOutcome(json)).toMatchObject({
			kind: "invalid",
			problems: ["output: invalid_JSON"],
		});
	});
	it("pins closed JSON depth where normalization would otherwise admit the draft", () => {
		const nested = (count: number): string => {
			let value: unknown = null;
			for (let index = 0; index < count; index++) value = [value];
			return JSON.stringify({ ...draft, contextRefs: ["c1", value] });
		};
		expect(textOutcome(nested(62))).toMatchObject({ kind: "draft", output: draft });
		expect(JSON.parse(nested(63))).toHaveProperty("body", draft.body);
		expect(textOutcome(nested(63))).toMatchObject({
			kind: "invalid",
			problems: ["output: invalid_JSON"],
		});
	});
	it("normalizes context ids and reserves invalid outcomes for actual draft text failures", () => {
		expect(
			textOutcome(JSON.stringify({ ...draft, contextRefs: ["C1", "c3", "c1", CANARY, 7] }), [
				"c3",
				"c1",
			]),
		).toMatchObject({ kind: "draft", output: { ...draft, contextRefs: ["c3", "c1"] } });
		for (const value of [
			CANARY,
			JSON.stringify({ ...draft, recipient: CANARY }),
			JSON.stringify({ ...draft, body: "\ud800" }),
			JSON.stringify({ ...draft, body: "\u{1f600}".repeat(8001) }),
		]) {
			const result = textOutcome(value);
			expect(result.kind).toBe("invalid");
			expect(JSON.stringify(result)).not.toContain(CANARY);
		}
		expect(textOutcome(JSON.stringify({ ...draft, body: "\u{1f600}".repeat(8000) })).kind).toBe(
			"draft",
		);
	});
	it("redacts malformed envelopes and refuses invalid caller context", () => {
		for (const value of [null, CANARY, message({ model: "bad model" })])
			expect(() => readDraft(value, [])).toThrowError(
				expect.objectContaining({ code: "TRANSIENT", message: "responses: TRANSIENT" }),
			);
		expect(() => readDraft(message(), [CANARY] as never)).toThrowError(
			expect.objectContaining({ code: "INVALID_INPUT" }),
		);
		expect(() => readDraft(null, [])).toThrow(ResponsesError);
	});
	it("keeps random malformed JSON content out of validation diagnostics", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 300 }), (value) => {
				const result = textOutcome(value + CANARY);
				expect(result.kind).toBe("invalid");
				expect(JSON.stringify(result)).not.toContain(CANARY);
			}),
			{ numRuns: 70, seed: 7202 },
		);
	});
});

describe("six distinct completed-response fixtures", () => {
	it.each([
		["valid draft", message(), "draft"],
		[
			"truncated final answer",
			message({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
			"truncated",
		],
		[
			"provider refusal",
			message({ output: output([{ type: "refusal", refusal: CANARY }]) }),
			"refusal",
		],
		[
			"invalid draft text",
			message({ output: output([{ type: "output_text", text: CANARY }]) }),
			"invalid",
		],
		[
			"normalized context catalogue",
			message({
				output: output([
					{ type: "output_text", text: JSON.stringify({ ...draft, contextRefs: [CANARY] }) },
				]),
			}),
			"draft",
		],
		["queued response", message({ status: "queued", usage: undefined }), "unexpected"],
	])(
		"%s has its expected shared-schema outcome without private diagnostics",
		(_name, response, kind) => {
			const result = readDraft(response, ["c1"]);
			expect(result.kind).toBe(kind);
			expect(DraftOutcome.safeParse(result).success).toBe(true);
			expect(JSON.stringify(result)).not.toContain(CANARY);
		},
	);
});
