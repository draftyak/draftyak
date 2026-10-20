import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { describe, expect, it, vi } from "vitest";
import {
	MAX_OUTPUT_BYTES,
	MessagesError,
	parseDraft,
	readDraft,
	repairPlan,
} from "../src/index.ts";
import { canary, draft, message } from "./helpers.ts";

describe("outcomes", () => {
	it.each([
		"refusal",
		"max_tokens",
		"model_context_window_exceeded",
		"tool_use",
		"pause_turn",
		"compaction",
	])("checks %s before touching content", (stop_reason) => {
		const source = message({ stop_reason });
		Object.defineProperty(source, "content", {
			get: () => {
				throw new Error(canary);
			},
		});
		const result = readDraft(source, []);
		expect(result.kind).not.toBe("draft");
		expect(DraftOutcome.safeParse(result).success).toBe(true);
		expect(JSON.stringify(result)).not.toContain(canary);
	});
	it("preserves validated refusal metadata without partially parsing the answer", () => {
		expect(
			readDraft(
				message({
					stop_reason: "refusal",
					stop_details: {
						category: "safety",
						explanation: "Synthetic refusal.",
						recommended_model: "claude-haiku-5-5",
						extra: canary,
					},
				}),
				[],
			),
		).toMatchObject({
			kind: "refusal",
			category: "safety",
			explanation: "Synthetic refusal.",
			recommendedModel: "claude-haiku-5-5",
		});
	});
	it("reports served model, fallback and total usage including absent input", () => {
		expect(
			readDraft(
				message({
					model: "claude-sonnet-5-5",
					usage: { output_tokens: 250, iterations: [{ type: "fallback_message" }] },
				}),
				["c1"],
			),
		).toMatchObject({
			model: "claude-sonnet-5-5",
			fallback: true,
			usage: { input: null, output: 250 },
		});
	});
	it("joins one text fragment per fallback segment", () => {
		const text = JSON.stringify(draft);
		const content = [
			{ type: "thinking", thinking: canary },
			{ type: "text", text: text.slice(0, 20) },
			{ type: "fallback" },
			{ type: "text", text: text.slice(20) },
		];
		expect(readDraft(message({ content }), ["c1"])).toMatchObject({ kind: "draft", output: draft });
		for (const bad of [
			[],
			[content[1], content[1]],
			[{ type: "tool_use", input: canary }],
			Array.from({ length: 129 }, () => ({ type: "thinking" })),
		])
			expect(readDraft(message({ content: bad }), []).kind).toBe("invalid");
	});
	it.each([undefined, null, "c1", ["C3", "c2", "C1", "c1", canary, 7]])(
		"narrows contextRefs %j to the job order",
		(contextRefs) => {
			const parsed = parseDraft(JSON.stringify({ ...draft, contextRefs }), ["c3", "c1"]);
			expect(parsed).toEqual({
				ok: true,
				output: { ...draft, contextRefs: Array.isArray(contextRefs) ? ["c3", "c1"] : [] },
			});
		},
	);
	it("preserves codepoint limits from the shared protocol schema", () => {
		expect(parseDraft(JSON.stringify({ ...draft, body: "😀".repeat(8_000) }), []).ok).toBe(true);
		expect(parseDraft(JSON.stringify({ ...draft, body: "😀".repeat(8_001) }), []).ok).toBe(false);
	});
	it("bounds malformed JSON, depth, duplicates and private validation problems", () => {
		for (const text of [
			canary,
			"x".repeat(MAX_OUTPUT_BYTES + 1),
			"[".repeat(1000),
			'{"body":"one","body":"two"}',
			JSON.stringify({ ...draft, [canary]: canary }),
			JSON.stringify({ ...draft, body: "\ud800" }),
		]) {
			const parsed = parseDraft(text, []);
			expect(parsed.ok).toBe(false);
			expect(JSON.stringify(parsed)).not.toContain(canary);
		}
	});
	it("never logs hostile responses or exposes their content in thrown errors", () => {
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		for (const value of [
			null,
			canary,
			{ model: canary, usage: { output_tokens: canary } },
			message({ usage: { output_tokens: -1 } }),
		]) {
			try {
				readDraft(value, []);
				throw new Error("expected failure");
			} catch (error) {
				expect(error).toBeInstanceOf(MessagesError);
				expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(canary);
			}
		}
		for (const log of logs) {
			expect(log).not.toHaveBeenCalled();
			log.mockRestore();
		}
	});
	it("maps unrecognized stop reasons to null and allows exactly one schema repair", () => {
		expect(readDraft(message({ stop_reason: canary }), [])).toMatchObject({
			kind: "unexpected",
			stopReason: null,
		});
		const invalid = readDraft(message({ content: [{ type: "text", text: canary }] }), []);
		expect(repairPlan(invalid, 0)).toEqual({ kind: "repair", problems: ["output: invalid_JSON"] });
		expect(repairPlan(invalid, 1)).toEqual({ kind: "stop" });
		expect(repairPlan(readDraft(message({ stop_reason: "max_tokens" }), []), 0)).toEqual({
			kind: "stop",
		});
	});
});
