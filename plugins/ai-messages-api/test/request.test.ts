import { describe, expect, it } from "vitest";
import {
	API_URL,
	buildRequest,
	EFFORTS,
	FALLBACK_BETA,
	MessagesError,
	supportsFallback,
	verifyRequest,
} from "../src/index.ts";
import { canary, input, pin } from "./helpers.ts";

describe("closed draft requests", () => {
	it("builds only the approved request with fixed defaults and schema", () => {
		const request = buildRequest(input);
		expect(request.body).toMatchObject({
			model: pin.model,
			max_tokens: 16_000,
			stream: true,
			output_config: {
				effort: "medium",
				format: { type: "json_schema", schema: { type: "object", additionalProperties: false } },
			},
			fallbacks: "default",
		});
		expect(request.headers["anthropic-beta"]).toBe(FALLBACK_BETA);
		expect(request.body.messages).toEqual([{ role: "user", content: input.prompt }]);
		expect(verifyRequest(request, pin).ok).toBe(true);
	});
	it("reconstructs input and settings so extra fields never enter the wire object", () => {
		const request = buildRequest(
			{ ...input, [canary]: canary } as typeof input,
			{ [canary]: canary } as object,
		);
		expect(JSON.stringify(request)).not.toContain(canary);
	});
	it.each(EFFORTS)("pins effort %s", (effort) => {
		const request = buildRequest(input, { effort });
		expect(verifyRequest(request, { ...pin, effort }).ok).toBe(true);
		expect(
			verifyRequest(request, { ...pin, effort: effort === "medium" ? "low" : "medium" }).ok,
		).toBe(false);
	});
	it("omits fallbacks and beta on unsupported and unknown models", () => {
		for (const model of ["claude-haiku-5-5", "claude-future-model"]) {
			const request = buildRequest(input, { model });
			expect(supportsFallback(model)).toBe(false);
			expect(request.body).not.toHaveProperty("fallbacks");
			expect(request.headers).not.toHaveProperty("anthropic-beta");
			expect(verifyRequest(request, { ...pin, model }).ok).toBe(true);
		}
	});
	it.each([0, -1, 16_001, 1.2, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects token limit %s",
		(maxTokens) => {
			expect(() => buildRequest(input, { maxTokens })).toThrow(MessagesError);
		},
	);
	it.each([
		"temperature",
		"top_p",
		"top_k",
		"tools",
		"tool_choice",
		"thinking",
		"metadata",
		"stop_sequences",
		"container",
		"mcp_servers",
		"service_tier",
		"cache_control",
		canary,
	])("refuses extra body field %s without echoing it", (key) => {
		const request = buildRequest(input);
		const verdict = verifyRequest({ ...request, body: { ...request.body, [key]: canary } }, pin);
		expect(verdict.ok).toBe(false);
		expect(JSON.stringify(verdict)).not.toContain(canary);
	});
	it.each([
		{ url: `${API_URL}/` },
		{ url: `${API_URL}?beta=true&note=x` },
		{ url: `${API_URL}#x` },
		{ url: "https://example.invalid/v1/messages" },
		{ method: "GET" },
	])("refuses alternate target %j", (target) =>
		expect(verifyRequest({ ...buildRequest(input), ...target }, pin).ok).toBe(false),
	);
	it("rejects nested fields, swapped schema, missing effort, extra turns and beta drift", () => {
		const request = buildRequest(input);
		const bodies = [
			{ ...request.body, output_config: { ...request.body.output_config, [canary]: canary } },
			{ ...request.body, output_config: { format: request.body.output_config.format } },
			{
				...request.body,
				output_config: { effort: "medium", format: { type: "json_schema", schema: {} } },
			},
			{ ...request.body, messages: [{ role: "user", content: input.prompt, [canary]: canary }] },
			{ ...request.body, messages: [...request.body.messages, ...request.body.messages] },
			{ ...request.body, fallbacks: ["claude-haiku-5-5"] },
		];
		for (const body of bodies) expect(verifyRequest({ ...request, body }, pin).ok).toBe(false);
		const extraHeaders: Record<string, string>[] = [
			{ authorization: canary },
			{ "x-stainless-os": canary },
			{ "anthropic-beta": "structured-outputs-2025-12-15" },
		];
		for (const extra of extraHeaders)
			expect(verifyRequest({ ...request, headers: { ...request.headers, ...extra } }, pin).ok).toBe(
				false,
			);
	});
	it("keeps fallback omission truly absent and verification idempotent", () => {
		const request = buildRequest(input);
		const { fallbacks: _fallbacks, ...body } = request.body;
		const headers = { ...request.headers };
		delete headers["anthropic-beta"];
		const without = { ...request, body, headers };
		const before = structuredClone(without);
		const first = verifyRequest(without, pin);
		expect(without).toEqual(before);
		if (!first.ok) throw new Error("verification failed");
		expect(first.request.body).not.toHaveProperty("fallbacks");
		expect(verifyRequest(first.request, pin)).toEqual(first);
	});
	it("returns a detached authorized request and keeps no original mutable body references", () => {
		const original = buildRequest(input);
		const verdict = verifyRequest(original, pin);
		if (!verdict.ok) throw new Error("verification failed");
		expect(verdict.request.body).toEqual(original.body);
		expect(verdict.request.body).not.toBe(original.body);
		expect(verdict.request.body.output_config.format.schema).not.toBe(
			original.body.output_config.format.schema,
		);
		original.body.output_config.format.schema.additionalProperties = true;
		expect(verifyRequest(verdict.request, pin).ok).toBe(true);
	});
});
