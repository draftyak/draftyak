import { DraftOutcome } from "@draftyak/protocol/ai-provider-v1";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CompatibleError, MAX_RESPONSE_BYTES } from "../src/index.ts";
import { completion, core, MODEL, OUTPUT, REQUEST, response } from "./helpers.ts";

describe("bounded DraftOutcome parsing", () => {
	it.each(["json_schema", "json_object", "ollama"] as const)(
		"validates %s output and filters refs to job ids",
		(format) => {
			const provider = core(format);
			const result = provider.parse(
				REQUEST,
				completion(provider, { ...OUTPUT, contextRefs: ["C3", "c9", "C1", "c1", 42] }),
			);
			expect(result).toEqual({
				kind: "draft",
				model: MODEL,
				fallback: false,
				usage: { input: 10, output: 3 },
				output: { ...OUTPUT, contextRefs: ["c1", "c3"] },
			});
			expect(DraftOutcome.safeParse(result).success).toBe(true);
		},
	);
	it.each(["length", "max_tokens", "model_context_window_exceeded", "content_filter"])(
		"checks stop %s before message/output parsing",
		(finish_reason) => {
			const provider = core();
			const result = provider.parse(
				REQUEST,
				response(provider, {
					model: MODEL,
					choices: [{ finish_reason, message: "PRIVATE_CANARY" }],
				}),
			);
			expect(result.kind).toBe(finish_reason === "content_filter" ? "refusal" : "truncated");
			expect(DraftOutcome.safeParse(result).success).toBe(true);
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		},
	);
	it("keeps refusals and unknown stop reasons content-free", () => {
		const provider = core();
		const refusal = provider.parse(
			REQUEST,
			response(provider, {
				model: MODEL,
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", refusal: "PRIVATE_CANARY", content: "not JSON" },
					},
				],
			}),
		);
		expect(refusal).toMatchObject({ kind: "refusal", explanation: null, recommendedModel: null });
		const odd = provider.parse(REQUEST, completion(provider, OUTPUT, "PRIVATE_CANARY"));
		expect(odd).toMatchObject({ kind: "unexpected", stopReason: null });
		expect(JSON.stringify([refusal, odd])).not.toContain("PRIVATE_CANARY");
	});
	it("does not accept silent model substitution, executable calls, or multiple choices", () => {
		const provider = core();
		for (const body of [
			{ model: "another-model", choices: [] },
			{
				model: MODEL,
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: JSON.stringify(OUTPUT),
							tool_calls: [{ function: { name: "PRIVATE_CANARY" } }],
						},
					},
				],
			},
			{
				model: MODEL,
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: JSON.stringify(OUTPUT),
							function_call: { name: "PRIVATE_CANARY" },
						},
					},
				],
			},
			{ model: MODEL, choices: [{}, {}] },
		]) {
			const result = provider.parse(REQUEST, response(provider, body));
			expect(result.kind).toBe("unexpected");
			expect(result.fallback).toBe(false);
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		}
	});
	it("reports invalid JSON/schema with paths and codes, never original content", () => {
		const provider = core();
		for (const value of [
			"PRIVATE_CANARY not JSON",
			{ ...OUTPUT, body: 42 },
			{ ...OUTPUT, recipient: "PRIVATE_CANARY" },
			{ ...OUTPUT, body: "\ud800" },
			{ ...OUTPUT, needsOwnerInput: Array(6).fill("PRIVATE_CANARY") },
		]) {
			const result = provider.parse(REQUEST, completion(provider, value));
			expect(result.kind).toBe("invalid");
			expect(DraftOutcome.safeParse(result).success).toBe(true);
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		}
	});
	it("rejects duplicate names, lone surrogates and depth overflow in draft JSON", () => {
		const provider = core();
		for (const content of [
			'{"body":"PRIVATE_CANARY","body":"second"}',
			'{"body":"\\ud800"}',
			`${"[".repeat(65)}0${"]".repeat(65)}`,
		]) {
			const result = provider.parse(REQUEST, completion(provider, content));
			expect(result).toMatchObject({ kind: "invalid", problems: ["output: invalid_json"] });
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		}
	});
	it("rejects duplicate names, lone surrogates and depth overflow in envelopes without retry", async () => {
		const provider = core();
		const valid = completion(provider);
		for (const body of [
			'{"PRIVATE_CANARY":1,"PRIVATE_CANARY":2}',
			'{"unused":"\\ud800"}',
			`${"[".repeat(65)}0${"]".repeat(65)}`,
		]) {
			let calls = 0;
			const result = await provider.generate(REQUEST, async () => {
				calls++;
				return { ...valid, body: new TextEncoder().encode(body) };
			});
			expect(calls).toBe(1);
			expect(result).toMatchObject({
				kind: "unexpected",
				fallback: false,
				stopReason: "invalid_response",
			});
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		}
	});
	it("accepts the exact protocol output limit and fails the next character without truncation", () => {
		const provider = core();
		expect(
			provider.parse(REQUEST, completion(provider, { ...OUTPUT, body: "😀".repeat(8000) })).kind,
		).toBe("draft");
		expect(
			provider.parse(REQUEST, completion(provider, { ...OUTPUT, body: "😀".repeat(8001) })).kind,
		).toBe("invalid");
	});
	it("rejects oversized, invalid UTF-8, redirects, wrong content types and HTTP errors", () => {
		const provider = core();
		const valid = completion(provider);
		for (const input of [
			{ ...valid, body: new Uint8Array(MAX_RESPONSE_BYTES + 1) },
			{ ...valid, body: new Uint8Array([0xc0, 0xaf]) },
			{ ...valid, url: "https://another.example.invalid/v1/chat/completions" },
			{ ...valid, contentType: "text/html" },
			{ ...valid, status: 302 },
			{ ...valid, status: 401 },
			{ ...valid, body: new TextEncoder().encode("PRIVATE_CANARY") },
		]) {
			const result = provider.parse(REQUEST, input);
			expect(result.kind).toBe("unexpected");
			expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
		}
	});
	it("fuzzes malformed completion bytes without throwing or leaking diagnostics (150 runs)", () => {
		const provider = core();
		const base = completion(provider);
		fc.assert(
			fc.property(fc.uint8Array({ maxLength: 1024 }), (bytes) => {
				const result = provider.parse(REQUEST, { ...base, body: bytes });
				expect(DraftOutcome.safeParse(result).success).toBe(true);
			}),
			{ numRuns: 150, seed: 7302 },
		);
	});
});

describe("model-list shapes", () => {
	it.each(["json_schema", "ollama"] as const)(
		"uses the documented %s list endpoint and drops metadata",
		(format) => {
			const provider = core(format);
			const request = provider.modelsRequest();
			expect(request.url).toContain(format === "ollama" ? "/api/tags" : "/v1/models");
			expect(request).toMatchObject({ method: "GET", body: "", redirect: "error", headers: {} });
			expect(provider.modelsVerifier()(request)).toBe(true);
			expect(provider.modelsVerifier()({ ...request, url: provider.config.endpoint })).toBe(false);
			const body =
				format === "ollama"
					? { models: [{ name: MODEL, details: "PRIVATE_CANARY" }] }
					: { data: [{ id: MODEL, description: "PRIVATE_CANARY" }] };
			expect(provider.models({ ...response(provider, body), url: request.url })).toEqual({
				models: [{ id: MODEL, fallbacks: false }],
			});
		},
	);
	it("fails bounded lists cleanly", () => {
		const provider = core();
		for (const data of [
			Array.from({ length: 501 }, () => ({ id: MODEL })),
			[{ id: "PRIVATE_CANARY with spaces" }],
			"PRIVATE_CANARY",
		]) {
			expect(() =>
				provider.models({ ...response(provider, { data }), url: provider.config.modelsEndpoint }),
			).toThrow(CompatibleError);
		}
	});
});
