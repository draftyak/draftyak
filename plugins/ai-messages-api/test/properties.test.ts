import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildRequest, parseDraft, readDraft, verifyRequest } from "../src/index.ts";
import { canary, draft, input, message, pin } from "./helpers.ts";

describe("seeded properties", () => {
	it("never sends unknown request fields or echoes their values (100 runs)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), fc.jsonValue({ maxDepth: 3 }), (key, value) => {
				const request = buildRequest(input);
				const field = `${canary}${key}`;
				const result = verifyRequest(
					{ ...request, body: { ...request.body, [field]: value } },
					pin,
				);
				expect(result.ok).toBe(false);
				expect(JSON.stringify(result)).not.toContain(canary);
			}),
			{ numRuns: 100, seed: 7_701 },
		);
	});
	it("keeps only actual job context ids and produces shared-schema outcomes (100 runs)", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(fc.string({ maxLength: 10 }), fc.constantFrom("C1", "c2", "C3", null, 7)),
					{ maxLength: 20 },
				),
				(refs) => {
					const outcome = readDraft(
						message({
							content: [{ type: "text", text: JSON.stringify({ ...draft, contextRefs: refs }) }],
						}),
						["c3", "c1"],
					);
					expect(DraftOutcome.safeParse(outcome).success).toBe(true);
					expect(outcome.kind).toBe("draft");
					if (outcome.kind === "draft")
						expect(outcome.output.contextRefs).toEqual(
							["c3", "c1"].filter((id) =>
								refs.some((ref) => typeof ref === "string" && ref.toLowerCase() === id),
							),
						);
				},
			),
			{ numRuns: 100, seed: 7_702 },
		);
	});
	it("bounds malformed parsing and emits content-free errors (150 runs)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 1024 }), (text) => {
				const result = parseDraft(text + canary, []);
				expect(result.ok).toBe(false);
				expect(JSON.stringify(result)).not.toContain(canary);
			}),
			{ numRuns: 150, seed: 7_703 },
		);
	}, 2_000);
});
