import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import type { ContextId } from "@draftyak/protocol/draft-output";
import { describe, expect, it, vi } from "vitest";
import { MAX_DRAFT_OUTPUT_TEXT_BYTES, MessagesError, readDraft } from "../src/index.ts";
import { canary, draft, message } from "./helpers.ts";

const textOutcome = (text: string, contextIds: readonly ContextId[] = ["c1"]): DraftOutcome =>
	readDraft(message({ content: [{ type: "text", text }] }), contextIds);

describe("outcomes", () => {
	it.each([
		["refusal", "refusal"],
		["max_tokens", "truncated"],
		["model_context_window_exceeded", "truncated"],
		["tool_use", "unexpected"],
		["pause_turn", "unexpected"],
		["stop_sequence", "unexpected"],
		["compaction", "unexpected"],
	])("checks %s before touching content", (stop_reason, kind) => {
		const source = message({ stop_reason });
		Object.defineProperty(source, "content", {
			get: () => {
				throw new Error(canary);
			},
		});
		const result = readDraft(source, []);
		expect(result.kind).toBe(kind);
		if (kind !== "refusal") expect(result).toHaveProperty("stopReason", stop_reason);
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
		for (const bad of [[], [{ type: "tool_use", input: canary }]])
			expect(readDraft(message({ content: bad }), [])).toMatchObject({
				kind: "unexpected",
				stopReason: "unexpected_content",
			});
	});
	it.each([undefined, null, "c1", ["C3", "c2", "C1", "c1", canary, 7]])(
		"narrows contextRefs %j to the job order",
		(contextRefs) => {
			const parsed = textOutcome(JSON.stringify({ ...draft, contextRefs }), ["c3", "c1"]);
			expect(parsed).toMatchObject({
				kind: "draft",
				output: { ...draft, contextRefs: Array.isArray(contextRefs) ? ["c3", "c1"] : [] },
			});
		},
	);
	it("preserves codepoint limits from the shared protocol schema", () => {
		expect(textOutcome(JSON.stringify({ ...draft, body: "😀".repeat(8_000) })).kind).toBe("draft");
		expect(textOutcome(JSON.stringify({ ...draft, body: "😀".repeat(8_001) })).kind).toBe(
			"invalid",
		);
	});
	it("keeps malformed JSON and invalid draft fields out of validation problems", () => {
		for (const text of [
			canary,
			JSON.stringify({ ...draft, [canary]: canary }),
			JSON.stringify({ ...draft, body: "\ud800" }),
		]) {
			const parsed = textOutcome(text);
			expect(parsed.kind).toBe("invalid");
			expect(JSON.stringify(parsed)).not.toContain(canary);
		}
	});
	it("pins the content-block cap with an otherwise valid final text", () => {
		const text = { type: "text", text: JSON.stringify(draft) };
		const thinking = { type: "thinking" };
		expect(
			readDraft(message({ content: [...Array(127).fill(thinking), text] }), ["c1"]),
		).toMatchObject({ kind: "draft", output: draft });
		expect(
			readDraft(message({ content: [...Array(128).fill(thinking), text] }), ["c1"]),
		).toMatchObject({ kind: "unexpected", stopReason: "unexpected_content" });
	});
	it("pins the usage-iteration cap with an otherwise valid draft", () => {
		const usage = {
			input_tokens: 300,
			output_tokens: 100,
			iterations: Array(32).fill({ type: "message" }),
		};
		expect(readDraft(message({ usage }), ["c1"])).toMatchObject({ kind: "draft", output: draft });
		expect(() =>
			readDraft(
				message({ usage: { ...usage, iterations: [...usage.iterations, { type: "message" }] } }),
				["c1"],
			),
		).toThrow(MessagesError);
	});
	it("refuses two same-segment text slices that would otherwise join into a valid draft", () => {
		const json = JSON.stringify(draft);
		const first = { type: "text", text: json.slice(0, 20) };
		const second = { type: "text", text: json.slice(20) };
		expect(JSON.parse(first.text + second.text)).toEqual(draft);
		expect(readDraft(message({ content: [first, second] }), ["c1"])).toMatchObject({
			kind: "unexpected",
			stopReason: "unexpected_content",
		});
		expect(
			readDraft(message({ content: [first, { type: "fallback" }, second] }), ["c1"]),
		).toMatchObject({ kind: "draft", output: draft });
	});
	it.each(["Synthetic reply.", "\u{1f600}"])(
		"pins the shared UTF-8 cap with complete padded draft text: %s",
		(body) => {
			const json = JSON.stringify({ ...draft, body });
			const padded = json + " ".repeat(MAX_DRAFT_OUTPUT_TEXT_BYTES - Buffer.byteLength(json));
			expect(Buffer.byteLength(padded)).toBe(MAX_DRAFT_OUTPUT_TEXT_BYTES);
			expect(textOutcome(padded)).toMatchObject({ kind: "draft", output: { ...draft, body } });
			expect(textOutcome(`${padded} `)).toMatchObject({
				kind: "unexpected",
				stopReason: "unexpected_content",
			});
			if (body === "\u{1f600}")
				expect(`${padded} `.length).toBeLessThanOrEqual(MAX_DRAFT_OUTPUT_TEXT_BYTES);
		},
	);
	it("counts joined UTF-8 bytes when a surrogate pair crosses fallback segments", () => {
		const body = "\u{1f600}";
		const json = JSON.stringify({ ...draft, body });
		const padded = json + " ".repeat(MAX_DRAFT_OUTPUT_TEXT_BYTES - Buffer.byteLength(json));
		const at = padded.indexOf(body) + 1;
		const prefix = padded.slice(0, at);
		const suffix = padded.slice(at);
		expect(prefix.charCodeAt(prefix.length - 1)).toBe(0xd83d);
		expect(suffix.charCodeAt(0)).toBe(0xde00);
		expect(Buffer.byteLength(prefix) + Buffer.byteLength(suffix)).toBe(
			MAX_DRAFT_OUTPUT_TEXT_BYTES + 2,
		);
		expect(Buffer.byteLength(prefix + suffix)).toBe(MAX_DRAFT_OUTPUT_TEXT_BYTES);
		const content = (tail: string): unknown[] => [
			{ type: "text", text: prefix },
			{ type: "fallback" },
			{ type: "text", text: tail },
		];
		expect(readDraft(message({ content: content(suffix) }), ["c1"])).toMatchObject({
			kind: "draft",
			output: { ...draft, body },
		});
		expect(readDraft(message({ content: content(`${suffix} `) }), ["c1"])).toMatchObject({
			kind: "unexpected",
			stopReason: "unexpected_content",
		});
	});
	it("stops an over-cap aggregate before inspecting following content", () => {
		const json = JSON.stringify(draft);
		const oversized = json + " ".repeat(MAX_DRAFT_OUTPUT_TEXT_BYTES + 1 - json.length);
		const unread = {};
		let reads = 0;
		Object.defineProperty(unread, "type", {
			get: () => {
				reads++;
				throw new Error(canary);
			},
		});
		expect(
			readDraft(message({ content: [{ type: "text", text: oversized }, unread] }), ["c1"]),
		).toMatchObject({ kind: "unexpected", stopReason: "unexpected_content" });
		expect(reads).toBe(0);
	});
	it("refuses duplicate keys in an otherwise valid complete draft", () => {
		const json = `{"body":"discarded",${JSON.stringify(draft).slice(1)}`;
		expect(JSON.parse(json)).toEqual(draft);
		expect(textOutcome(json)).toMatchObject({
			kind: "invalid",
			problems: ["output: invalid_JSON"],
		});
	});
	it("pins closed JSON depth at the shared normalization boundary", () => {
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
	it("maps unrecognized stops to null and leaves draft problems for the hub", () => {
		expect(readDraft(message({ stop_reason: canary }), [])).toMatchObject({
			kind: "unexpected",
			stopReason: null,
		});
		const invalid = readDraft(message({ content: [{ type: "text", text: canary }] }), []);
		expect(invalid).toMatchObject({ kind: "invalid", problems: ["output: invalid_JSON"] });
	});
});
