import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import { describe, expect, it } from "vitest";
import { readDraft } from "../src/index.ts";
import { canary, draft, message } from "./helpers.ts";

// Sixty seeded synthetic cases: six variants of each outcome and reference scenario.
const corpus = Array.from({ length: 60 }, (_, index) => {
	const output = { ...draft, body: `Synthetic reply ${(index * 7919) % 65521}.` };
	const text = JSON.stringify(output);
	const cases = [
		{ fields: { content: [{ type: "text", text }] }, kind: "draft" },
		{
			fields: { stop_reason: "refusal", content: [{ type: "text", text: canary }] },
			kind: "refusal",
		},
		{
			fields: { stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] },
			kind: "truncated",
		},
		{ fields: { stop_reason: "model_context_window_exceeded", content: [] }, kind: "truncated" },
		{ fields: { stop_reason: "tool_use", content: [] }, kind: "unexpected" },
		{ fields: { content: [{ type: "text", text: canary }] }, kind: "invalid" },
		{
			fields: {
				content: [{ type: "text", text: JSON.stringify({ ...output, [canary]: canary }) }],
			},
			kind: "invalid",
		},
		{
			fields: {
				content: [{ type: "text", text: JSON.stringify({ ...output, contextRefs: undefined }) }],
			},
			kind: "draft",
		},
		{
			fields: {
				content: [
					{ type: "text", text: JSON.stringify({ ...output, contextRefs: ["C1", "c9", canary] }) },
				],
			},
			kind: "draft",
		},
		{
			fields: {
				usage: { input_tokens: 10, output_tokens: 20, iterations: [{ type: "fallback_message" }] },
				content: [
					{ type: "text", text: text.slice(0, 17) },
					{ type: "fallback" },
					{ type: "text", text: text.slice(17) },
				],
			},
			kind: "draft",
		},
	];
	return { index, ...(cases[index % cases.length] ?? { fields: {}, kind: "draft" }) };
});

describe("provider corpus", () => {
	it.each(corpus)("synthetic case $index", ({ fields, kind }) => {
		const outcome = readDraft(message(fields), ["c1"]);
		expect(outcome.kind).toBe(kind);
		expect(DraftOutcome.safeParse(outcome).success).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain(canary);
	});
});
