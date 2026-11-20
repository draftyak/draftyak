import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import fc from "fast-check";
import { expect, it } from "vitest";
import { completion, core, MODEL, OUTPUT, REQUEST, response } from "./helpers.ts";

it("passes the seeded 60-case outcome corpus in all configured protocol modes", () => {
	const texts = fc.sample(fc.stringMatching(/^[A-Za-z0-9 ]{1,40}$/), { seed: 7360, numRuns: 12 });
	const kinds = ["draft", "invalid", "refusal", "truncated", "unexpected"] as const;
	let cases = 0;
	for (const format of ["json_schema", "json_object", "ollama"] as const) {
		const provider = core(format);
		for (let i = 0; i < 4; i++) {
			const text = texts[cases % texts.length] ?? "Synthetic";
			const malformed = response(provider, {});
			const inputs = [
				completion(provider, {
					...OUTPUT,
					body: `${text} ${cases}`,
					contextRefs: ["C3", "c9", "c1", "c1"],
				}),
				completion(
					provider,
					i % 2 ? { ...OUTPUT, body: i } : { ...OUTPUT, needsOwnerInput: Array(6).fill(text) },
				),
				format === "ollama"
					? response(provider, {
							model: MODEL,
							done: true,
							done_reason: "stop",
							message: { role: "assistant", refusal: text },
						})
					: response(provider, {
							model: MODEL,
							choices: [{ finish_reason: "stop", message: { role: "assistant", refusal: text } }],
						}),
				completion(provider, text, i % 2 ? "length" : "model_context_window_exceeded"),
				{
					...malformed,
					body: new TextEncoder().encode(`{"PRIVATE_CANARY":${i},"PRIVATE_CANARY":${cases}}`),
				},
			];
			for (let kind = 0; kind < kinds.length; kind++) {
				const outcome = provider.parse(REQUEST, inputs[kind]);
				expect(outcome.kind, `case ${cases} ${format}`).toBe(kinds[kind]);
				expect(DraftOutcome.safeParse(outcome).success).toBe(true);
				expect(JSON.stringify(outcome)).not.toContain("PRIVATE_CANARY");
				if (outcome.kind === "draft") expect(outcome.output.contextRefs).toEqual(["c1", "c3"]);
				cases++;
			}
		}
	}
	expect(cases).toBe(60);
});
