import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { API_URL, buildRequest, EFFORTS, ResponsesError } from "../src/index.ts";
import { CANARY, input } from "./helpers.ts";

describe("API-key Responses request construction", () => {
	it("builds only the literal stateless body, headers and strict format keys", () => {
		expect(buildRequest(input)).toEqual({
			method: "POST",
			url: API_URL,
			headers: { "content-type": "application/json", authorization: "Bearer brokered" },
			body: {
				model: input.model,
				instructions: input.system,
				input: [{ role: "user", content: input.prompt }],
				store: false,
				stream: true,
				text: {
					format: {
						type: "json_schema",
						name: "draft_output",
						strict: true,
						schema: expect.objectContaining({ type: "object", additionalProperties: false }),
					},
				},
			},
		});
	});
	it("derives every wire-schema field from the shared draft while adapting unsupported uniqueness", () => {
		const expected = z.toJSONSchema(DraftOutputV1, {
			target: "draft-7",
			override: ({ jsonSchema }) => {
				delete jsonSchema.uniqueItems;
			},
		});
		const actual = buildRequest(input).body.text.format.schema;
		expect(actual.properties).toEqual(expected.properties);
		expect(actual.required).toEqual(expected.required);
		expect(actual.additionalProperties).toBe(false);
		expect(JSON.stringify(actual)).not.toContain('"uniqueItems"');
	});
	it.each(EFFORTS)(
		"constructs explicit reasoning effort %s without substituting the model",
		(effort) => {
			const request = buildRequest(input, { effort });
			expect(request.body.reasoning).toEqual({ effort });
			expect(request.body.model).toBe(input.model);
			expect(request.body.input).toEqual([{ role: "user", content: input.prompt }]);
		},
	);
	it("rejects malformed input, lone surrogates, excessive prompts and invalid efforts", () => {
		for (const change of [
			{ model: "bad model" },
			{ system: "\ud800" },
			{ contextIds: ["c9"] },
			{ prompt: "x".repeat(1_000_001) },
		])
			expect(() => buildRequest({ ...input, ...change } as typeof input)).toThrow(ResponsesError);
		expect(() => buildRequest(input, { effort: CANARY } as never)).toThrow("INVALID_INPUT");
		expect(buildRequest({ ...input, contextIds: [] }).body.input).toEqual([
			{ role: "user", content: input.prompt },
		]);
	});
	it("returns detached schema objects without retaining earlier caller mutation", () => {
		const first = buildRequest(input);
		const second = buildRequest(input);
		expect(second).toEqual(first);
		expect(second.body.text.format.schema).not.toBe(first.body.text.format.schema);
		first.body.text.format.schema.additionalProperties = true;
		expect(second.body.text.format.schema.additionalProperties).toBe(false);
	});
	it("does not copy arbitrary caller metadata into the constructed body (60 seeded samples)", () => {
		const expected = buildRequest(input);
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), fc.jsonValue({ maxDepth: 3 }), (key, value) => {
				const result = buildRequest({ ...input, [`${CANARY}${key}`]: value });
				expect(result).toEqual(expected);
				expect(JSON.stringify(result)).not.toContain(CANARY);
			}),
			{ numRuns: 60, seed: 7201 },
		);
	});
});
