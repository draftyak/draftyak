import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	API_URL,
	buildRequest,
	EFFORTS,
	type RequestBody,
	ResponsesError,
	verifyRequest,
} from "../src/index.ts";
import { CANARY, input } from "./helpers.ts";

describe("API-key Responses requests", () => {
	it("builds the exact stateless no-tool request with the shared strict draft schema", () => {
		const request = buildRequest(input);
		expect(request).toMatchObject({
			method: "POST",
			url: API_URL,
			headers: { authorization: "Bearer brokered" },
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
						schema: { type: "object", additionalProperties: false },
					},
				},
			},
		});
		expect(request.body).not.toHaveProperty("tools");
		expect(request.body).not.toHaveProperty("reasoning");
		expect(request.body.text.format).not.toHaveProperty("$parseRaw");
		expect(verifyRequest(request, { model: input.model }).ok).toBe(true);
	});

	it("derives the wire schema from every shared field while adapting unsupported uniqueness", () => {
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
		"pins explicit reasoning effort %s without automatic model substitution",
		(effort) => {
			const request = buildRequest(input, { effort });
			expect(request.body.reasoning).toEqual({ effort });
			expect(verifyRequest(request, { model: input.model, effort }).ok).toBe(true);
			expect(verifyRequest(request, { model: input.model }).ok).toBe(false);
			expect(verifyRequest(request, { model: "different-owner-model", effort }).ok).toBe(false);
		},
	);

	it("rejects malformed input, lone surrogates, excessive prompt codepoints and invalid efforts", () => {
		for (const change of [
			{ model: "bad model" },
			{ system: "\ud800" },
			{ contextIds: ["c9"] },
			{ prompt: "x".repeat(1_000_001) },
		]) {
			expect(() => buildRequest({ ...input, ...change } as typeof input)).toThrow(ResponsesError);
		}
		expect(() => buildRequest(input, { effort: CANARY } as never)).toThrow("INVALID_INPUT");
		expect(buildRequest({ ...input, contextIds: [] }).body.input).toEqual([
			{ role: "user", content: input.prompt },
		]);
	});

	it.each([
		"tools",
		"tool_choice",
		"metadata",
		"previous_response_id",
		"conversation",
		"background",
		"include",
		"max_output_tokens",
		"temperature",
		"service_tier",
		"prompt_cache_key",
		"user",
		CANARY,
	])("rejects non-allowlisted field %s without reflecting its value", (key) => {
		const request = buildRequest(input);
		const result = verifyRequest(
			{ ...request, body: { ...request.body, [key]: CANARY } },
			{ model: input.model },
		);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain(CANARY);
	});

	it("rejects retained state, nonstreaming and nested schema/input drift", () => {
		const request = buildRequest(input);
		for (const body of [
			{ ...request.body, store: true },
			{ ...request.body, stream: false },
			{ ...request.body, text: { format: { ...request.body.text.format, strict: false } } },
			{ ...request.body, text: { format: { ...request.body.text.format, schema: {} } } },
			{ ...request.body, input: [{ role: "user", content: input.prompt, name: CANARY }] },
			{ ...request.body, input: [{ role: "assistant", content: input.prompt }] },
			{ ...request.body, input: [...request.body.input, ...request.body.input] },
			{ ...request.body, reasoning: { effort: "medium", summary: "detailed" } },
		])
			expect(verifyRequest({ ...request, body }, { model: input.model }).ok).toBe(false);
	});

	it("rejects alternate hosts, redirect/query/fragment targets and extra credential or metadata headers", () => {
		const request = buildRequest(input);
		for (const url of [
			`${API_URL}/`,
			`${API_URL}?x=1`,
			`${API_URL}#x`,
			"https://other.example/v1/responses",
			"http://api.openai.com/v1/responses",
		])
			expect(verifyRequest({ ...request, url }, { model: input.model }).ok).toBe(false);
		for (const headers of [
			{ ...request.headers, authorization: `Bearer ${CANARY}` },
			{ ...request.headers, "openai-organization": CANARY },
			{ ...request.headers, "x-stainless-os": CANARY },
		])
			expect(verifyRequest({ ...request, headers }, { model: input.model }).ok).toBe(false);
		expect(verifyRequest({ ...request, method: "GET" }, { model: input.model }).ok).toBe(false);
	});

	it("reconstructs detached values, strips serialization hooks and is idempotent", () => {
		const request = buildRequest(input);
		Object.defineProperty(request.body, "toJSON", {
			value: () => ({ store: true, metadata: CANARY }),
		});
		const result = verifyRequest(request, { model: input.model });
		if (!result.ok) throw new Error("expected verified request");
		expect(result.request.body).not.toBe(request.body);
		expect(JSON.stringify(result.request)).not.toContain(CANARY);
		expect(verifyRequest(result.request, { model: input.model })).toEqual(result);
		(request.body.text.format as RequestBody["text"]["format"]).schema.additionalProperties = true;
		expect(result.request.body.text.format.schema.additionalProperties).toBe(false);
	});

	it("refuses arbitrary extra fields in seeded requests (60 runs)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), fc.jsonValue({ maxDepth: 3 }), (key, value) => {
				const request = buildRequest(input);
				const result = verifyRequest(
					{ ...request, body: { ...request.body, [`${CANARY}${key}`]: value } },
					{ model: input.model },
				);
				expect(result.ok).toBe(false);
				expect(JSON.stringify(result)).not.toContain(CANARY);
			}),
			{ numRuns: 60, seed: 7201 },
		);
	});
});
