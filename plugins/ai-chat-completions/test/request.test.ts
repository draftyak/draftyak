import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";
import { headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CompatibleError, createCompatibleCore, LOCAL_PRESETS } from "../src/index.ts";
import { core, MODEL, REQUEST } from "./helpers.ts";

describe("pinned compatible endpoint", () => {
	const config = {
		endpoint: "https://model.example.invalid/v1/chat/completions",
		model: MODEL,
		format: "json_schema",
	};
	const publicResolution = { hostname: "model.example.invalid", destination: "cloud" };
	it("uses trusted resolved classification, independent of hostname or preset labels", () => {
		expect(createCompatibleCore(config, publicResolution).config.destination).toBe("cloud");
		expect(() =>
			createCompatibleCore(
				{ ...config, endpoint: "http://model.example.invalid/v1/chat/completions" },
				publicResolution,
			),
		).toThrow(CompatibleError);
		expect(() =>
			createCompatibleCore({ ...config, destination: "local" }, publicResolution),
		).toThrow(CompatibleError);
		expect(() =>
			createCompatibleCore(config, { ...publicResolution, hostname: "other.example.invalid" }),
		).toThrow(CompatibleError);
		for (const destination of ["mixed", "blocked", "may-train", undefined])
			expect(() => createCompatibleCore(config, { ...publicResolution, destination })).toThrow(
				CompatibleError,
			);
	});
	it("requires explicit managed-LAN acknowledgement for plaintext", () => {
		const lan = { ...config, endpoint: "http://192.168.1.10:8000/v1/chat/completions" };
		const facts = { hostname: "192.168.1.10", destination: "local-network" };
		expect(() => createCompatibleCore(lan, facts)).toThrow(CompatibleError);
		expect(
			createCompatibleCore({ ...lan, allowPlaintextLan: true }, facts).config.destination,
		).toBe("local-network");
		expect(() =>
			createCompatibleCore(
				{
					...config,
					endpoint: "http://model.example.invalid/v1/chat/completions",
					allowPlaintextLan: true,
				},
				publicResolution,
			),
		).toThrow(CompatibleError);
	});
	it.each([
		"https://user:pass@model.example.invalid/v1/chat/completions",
		"https://model.example.invalid/v1/chat/completions?token=PRIVATE_CANARY",
		"https://model.example.invalid/v1/chat/completions?",
		"https://model.example.invalid/v1/chat/completions#",
		"https://model.example.invalid/v1/chat/completions#fragment",
		"https://model.example.invalid/v1/%63hat/completions",
		"https://model.example.invalid/v1/a/../chat/completions",
		"https://MODEL.example.invalid/v1/chat/completions",
		"https://model.example.invalid/v1/chat/completions/",
		"https://model.example.invalid/v1/chat/completions\n",
		"https://model.example.invalid/v1/responses",
		"file:///v1/chat/completions",
	])("rejects noncanonical or unauthorized endpoint %s", (endpoint) =>
		expect(() => createCompatibleCore({ ...config, endpoint }, publicResolution)).toThrow(
			CompatibleError,
		),
	);
	it("offers only loopback candidates and never chooses another endpoint itself", () => {
		expect(LOCAL_PRESETS.llamaCpp).toHaveLength(2);
		for (const endpoints of Object.values(LOCAL_PRESETS))
			for (const endpoint of endpoints) expect(new URL(endpoint).hostname).toBe("127.0.0.1");
		expect(Object.isFrozen(LOCAL_PRESETS.ollama)).toBe(true);
	});
});

describe("closed request construction", () => {
	it.each(["json_schema", "json_object", "ollama"] as const)(
		"builds documented %s without tool or sampling fields",
		(format) => {
			const provider = core(format);
			const request = provider.build(REQUEST);
			const body = JSON.parse(request.body);
			expect(Object.keys(body)).toEqual([
				"model",
				"messages",
				format === "ollama" ? "format" : "response_format",
				"stream",
			]);
			expect(body.model).toBe(MODEL);
			expect(body.stream).toBe(false);
			expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
				"system",
				"user",
			]);
			expect(body.messages[0].content).toBe(REQUEST.system);
			expect(body.messages[1].content).toBe(REQUEST.prompt);
			if (format === "json_schema") {
				expect(body.response_format).toMatchObject({
					type: "json_schema",
					json_schema: {
						name: "draft_output_v1",
						strict: true,
						schema: { additionalProperties: false },
					},
				});
			} else if (format === "json_object")
				expect(body.response_format).toEqual({ type: "json_object" });
			else {
				expect(body.format.type).toBe("object");
				expect(request.url).toContain("/api/chat");
			}
			expect(request.bodySha256).toBe(sha256Hex(request.body));
			expect(request.headersSha256).toBe(headersSha256(Object.entries(request.headers)));
			expect(Object.isFrozen(request)).toBe(true);
			expect(Object.isFrozen(request.headers)).toBe(true);
			expect(provider.describe().structuredOutput).toBe("validated");
		},
	);
	it("requires exact pinned model and canonical DraftRequest", () => {
		const provider = core();
		for (const request of [
			{ ...REQUEST, model: "another-model" },
			{ ...REQUEST, system: "\ud800" },
			{ ...REQUEST, extra: "PRIVATE_CANARY" },
			{ ...REQUEST, contextIds: ["c9"] },
		])
			expect(() => provider.build(request)).toThrow(CompatibleError);
		expect(() =>
			provider.build({
				get model() {
					throw new Error("PRIVATE_CANARY");
				},
			}),
		).toThrow(CompatibleError);
	});
	it("derives required fields, types and context enum from the canonical protocol schema", () => {
		const actual = JSON.parse(core().build(REQUEST).body).response_format.json_schema.schema;
		const canonical = exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1);
		expect(actual.required).toEqual(canonical.required);
		expect(actual.additionalProperties).toBe(false);
		const properties = canonical.properties as Record<string, { type: string; items?: unknown }>;
		expect(Object.keys(actual.properties)).toEqual(Object.keys(properties));
		for (const [key, value] of Object.entries(properties))
			expect(actual.properties[key].type).toBe(value.type);
		expect(actual.properties.contextRefs.items).toEqual(properties.contextRefs?.items);
		expect(actual.properties.body.maxLength).toBeUndefined();
		expect(actual.properties.needsOwnerInput.maxItems).toBeUndefined();
	});
	it("rejects extra repair metadata without invoking accessors or echoing thrown text", () => {
		const problems: string[] = [];
		let called = false;
		Object.defineProperty(problems, 0, {
			get() {
				called = true;
				throw new Error("PRIVATE_CANARY");
			},
		});
		try {
			core().build({ ...REQUEST, repairProblems: problems });
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(CompatibleError);
			expect(String(error)).not.toContain("PRIVATE_CANARY");
		}
		expect(called).toBe(false);
	});
	it("detached verification captures exact prompt, endpoint, model, phase and hashes", () => {
		const provider = core();
		const input = { ...REQUEST };
		const verify = provider.verifier(input);
		const expected = provider.build(input);
		input.prompt = "Mutated after verifier creation";
		expect(verify(expected)).toBe(true);
		for (const mutation of [
			{ url: "https://other.example.invalid/v1/chat/completions" },
			{ method: "GET" },
			{ redirect: "follow" },
			{ body: expected.body.replace("Synthetic", "Injected") },
			{ bodySha256: "0".repeat(64) },
			{ headersSha256: "0".repeat(64) },
			{ headers: { ...expected.headers, authorization: "PRIVATE_CANARY" } },
			{ tools: [] },
		])
			expect(verify({ ...expected, ...mutation })).toBe(false);
		const repairInput = { ...REQUEST, system: `${REQUEST.system}\nHub-owned repair instruction.` };
		const repair = provider.build(repairInput);
		expect(verify(repair)).toBe(false);
		expect(provider.verifier(repairInput)(repair)).toBe(true);
		expect(JSON.parse(repair.body).messages[0].content).toBe(repairInput.system);
	});
	it.each([
		{ change: "changes content-type", headers: { "content-type": "text/plain" } },
		{ change: "omits content-type", headers: {} },
	])("rejects a request that $change with a copied header hash", ({ headers }) => {
		const provider = core();
		const expected = provider.build(REQUEST);
		const verify = provider.verifier(REQUEST);
		const candidate = { ...expected, headers, headersSha256: expected.headersSha256 };
		expect(verify(expected)).toBe(true);
		expect(verify(candidate)).toBe(false);
	});
	it("rejects every changed prompt at the detached boundary (100 runs)", () => {
		const provider = core("json_object");
		const verify = provider.verifier(REQUEST);
		fc.assert(
			fc.property(fc.string({ maxLength: 100 }), (extra) => {
				if (extra.length === 0) return;
				if (!extra.isWellFormed()) return;
				expect(verify(provider.build({ ...REQUEST, prompt: REQUEST.prompt + extra }))).toBe(false);
			}),
			{ numRuns: 100, seed: 7301 },
		);
	});
});
