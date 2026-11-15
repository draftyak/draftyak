import { createFake } from "@draftyak/fakes";
import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";
import { HOST_MAX_STREAM_BYTES, HOST_REQUEST_TIMEOUT_MS } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { describe, expect, it } from "vitest";
import {
	type CompatibleHttpBinding,
	type CompatibleHttpBindingInput,
	type CompatibleHttpConfig,
	type CompatibleHttpRequest,
	checkCompatibleHttpRequest,
	createCompatibleHttpBinding,
} from "../src/compatible-http.ts";
import { createMockHost } from "../src/host.ts";
import { matchRequest } from "../src/policy.ts";
import { manifest as providerFixture } from "./fixtures/ai-fixture/plugin.ts";

if (providerFixture.kind !== "ai-provider") throw new Error("Provider fixture required");
const manifest: PluginManifestV1 = {
	...providerFixture,
	egress: { profile: "chat-completions-v1" },
};
const origin = "https://compatible.example.invalid";
const draft: DraftRequest = {
	model: "DYTEST-compatible:1",
	system: "DYTEST-Trusted instructions, unchanged.\r\n",
	prompt: "DYTEST-Untrusted thread with <data> and a literal \\ sequence.\n",
	contextIds: ["c1", "c3"],
};
const formats = ["json_schema", "json_object", "ollama"] as const;
type Operation = CompatibleHttpBindingInput["operation"];
const operations: readonly Operation[] = ["ai_models_list", "ai_probe", "ai_draft_generate"];

function config(format: CompatibleHttpConfig["format"] = "json_schema"): CompatibleHttpConfig {
	return {
		endpoint: `${origin}${format === "ollama" ? "/api/chat" : "/v1/chat/completions"}`,
		model: draft.model,
		format,
	};
}
function input(
	format: CompatibleHttpConfig["format"],
	operation: Operation,
): CompatibleHttpBindingInput {
	return operation === "ai_draft_generate"
		? { operation, config: config(format), draft }
		: { operation, config: config(format) };
}
function issued(value: CompatibleHttpBindingInput): CompatibleHttpBinding {
	const result = createCompatibleHttpBinding(value);
	if (!result.ok) throw new Error("Trusted compatible fixture binding refused");
	return result.binding;
}

// Independent fixture wire construction from the accepted shared schema, not the matcher.
function schema(): unknown {
	const omitted = [
		"$id",
		"$schema",
		"maxLength",
		"minLength",
		"maxItems",
		"minItems",
		"uniqueItems",
	];
	const copy = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(copy);
		if (!value || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !omitted.includes(key))
				.map(([key, item]) => [key, copy(item)]),
		);
	};
	return copy(exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1));
}
function wire(format: CompatibleHttpConfig["format"], operation: Operation): CompatibleHttpRequest {
	if (operation === "ai_models_list")
		return {
			method: "GET",
			url: `${origin}${format === "ollama" ? "/api/tags" : "/v1/models"}`,
			headers: [],
			body: new Uint8Array(),
		};
	const prompt =
		operation === "ai_probe"
			? {
					system:
						"Return exactly one DraftOutputV1 JSON object with body, ownerNotes, needsOwnerInput, suspectedInstructions, and contextRefs.",
					prompt:
						'Return exactly {"body":"","ownerNotes":"","needsOwnerInput":[],"suspectedInstructions":false,"contextRefs":[]}.',
				}
			: draft;
	const messages = [
		{ role: "system", content: prompt.system },
		{ role: "user", content: prompt.prompt },
	];
	const body =
		format === "ollama"
			? { model: draft.model, messages, format: schema(), stream: false }
			: {
					model: draft.model,
					messages,
					response_format:
						format === "json_object"
							? { type: "json_object" }
							: {
									type: "json_schema",
									json_schema: { name: "draft_output_v1", strict: true, schema: schema() },
								},
					stream: false,
				};
	return {
		method: "POST",
		url: config(format).endpoint,
		headers: [["content-type", "application/json"]],
		body: Buffer.from(JSON.stringify(body), "utf8"),
	};
}
function match(request: CompatibleHttpRequest, bindings: readonly CompatibleHttpBinding[]) {
	return matchRequest(manifest, request.url, request.method, new Map(), undefined, {
		bindings,
		headers: request.headers,
		body: request.body,
	});
}
function changedBody(
	request: CompatibleHttpRequest,
	change: (body: Record<string, unknown>) => void,
): CompatibleHttpRequest {
	const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as Record<string, unknown>;
	change(body);
	return { ...request, body: Buffer.from(JSON.stringify(body), "utf8") };
}
function changeMessage(body: Record<string, unknown>, index: number): void {
	const message = (body.messages as { role: string; content: string }[])[index];
	if (!message) throw new Error("Fixture message missing");
	message.content = "Changed";
}

describe("constructor-bound compatible HTTP policy", () => {
	it.each(formats.flatMap((format) => operations.map((operation) => ({ format, operation }))))(
		"admits only the independently bound $format $operation wire",
		({ format, operation }) => {
			const request = wire(format, operation);
			const binding = issued(input(format, operation));
			expect(checkCompatibleHttpRequest(request, binding)).toEqual({ ok: true });
			expect(match(request, [binding])).toMatchObject({
				url: request.url,
				rule: {
					class: "read",
					method: request.method,
					host: "compatible.example.invalid",
					maxBytes: HOST_MAX_STREAM_BYTES,
					timeoutMs: HOST_REQUEST_TIMEOUT_MS,
				},
			});
		},
	);

	it("requires an issued binding rather than deriving expectations from the request", () => {
		const request = wire("json_schema", "ai_draft_generate");
		expect(match(request, [])).toBeUndefined();
		expect(match(request, [{} as CompatibleHttpBinding])).toBeUndefined();
		expect(matchRequest(manifest, request.url, request.method, new Map())).toBeUndefined();
		const models = issued(input("json_schema", "ai_models_list"));
		expect(match(request, [models])).toBeUndefined();
		expect(match(request, [issued(input("json_object", "ai_draft_generate"))])).toBeUndefined();
	});

	it.each([
		{
			name: "model",
			change: (body: Record<string, unknown>) => {
				body.model = "DYTEST-other";
			},
		},
		{
			name: "system",
			change: (body: Record<string, unknown>) => {
				changeMessage(body, 0);
			},
		},
		{
			name: "prompt",
			change: (body: Record<string, unknown>) => {
				changeMessage(body, 1);
			},
		},
		{
			name: "schema",
			change: (body: Record<string, unknown>) => {
				const format = body.response_format as Record<string, unknown>;
				const definition = format.json_schema as Record<string, unknown>;
				const shape = definition.schema as Record<string, unknown>;
				shape.additionalProperties = true;
			},
		},
		{
			name: "stream",
			change: (body: Record<string, unknown>) => {
				body.stream = true;
			},
		},
		{
			name: "extra field",
			change: (body: Record<string, unknown>) => {
				body.tools = [];
			},
		},
	])("refuses a changed $name instead of treating the profile as an allowlist", ({ change }) => {
		const request = changedBody(wire("json_schema", "ai_draft_generate"), change);
		expect(match(request, [issued(input("json_schema", "ai_draft_generate"))])).toBeUndefined();
	});

	it("refuses different endpoint, method, original headers and duplicate JSON members", () => {
		const request = wire("json_schema", "ai_draft_generate");
		const binding = issued(input("json_schema", "ai_draft_generate"));
		for (const candidate of [
			{ ...request, url: `${origin}/v1/other` },
			{ ...request, url: `${request.url}?changed=1` },
			{ ...request, method: "GET" },
			{ ...request, headers: [] },
			{
				...request,
				headers: [
					["content-type", "application/json"],
					["authorization", "Bearer invented"],
				],
			},
			{
				...request,
				headers: [
					["content-type", "application/json"],
					["Content-Type", "application/json"],
				],
			},
			{
				...request,
				body: Buffer.from(
					`{"model":"${draft.model}",${Buffer.from(request.body).toString("utf8").slice(1)}`,
				),
			},
		] as CompatibleHttpRequest[])
			expect(match(candidate, [binding])).toBeUndefined();
	});

	it("requires an empty models request and never switches the expected probe endpoint", () => {
		const request = wire("ollama", "ai_models_list");
		const models = issued(input("ollama", "ai_models_list"));
		expect(match({ ...request, body: new Uint8Array([1]) }, [models])).toBeUndefined();
		expect(
			match({ ...request, headers: [["accept", "application/json"]] }, [models]),
		).toBeUndefined();
		expect(match(request, [issued(input("ollama", "ai_probe"))])).toBeUndefined();
	});

	it("rejects a draft whose model differs from its constructor configuration", () => {
		expect(
			createCompatibleHttpBinding({
				operation: "ai_draft_generate",
				config: config(),
				draft: { ...draft, model: "DYTEST-other" },
			}).ok,
		).toBe(false);
	});

	it("does not grant another provider profile with a compatible comparison identity", () => {
		const request = wire("json_schema", "ai_draft_generate");
		const bindings = [issued(input("json_schema", "ai_draft_generate"))];
		for (const profile of ["messages-api-v1", "responses-api-v1"] as const) {
			expect(
				matchRequest(
					{ ...manifest, egress: { profile } },
					request.url,
					request.method,
					new Map(),
					undefined,
					{
						bindings,
						headers: request.headers,
						body: request.body,
					},
				),
			).toBeUndefined();
		}
	});

	it("refuses a changed trusted prompt before any Fake dispatch", async () => {
		let calls = 0;
		const fake = createFake(
			{
				fetch: () => {
					calls++;
					return Response.json({ accepted: true });
				},
			},
			{
				host: "compatible.example.invalid",
			},
		);
		const fixture = createMockHost({
			manifest,
			instance: "00000000000000000000000001",
			upstreams: [fake],
			compatibleHttp: [
				{
					operation: "ai_draft_generate",
					config: config(),
					draft: { ...draft, prompt: "Different trusted prompt" },
				},
			],
		});
		try {
			const request = wire("json_schema", "ai_draft_generate");
			let error: unknown;
			await fixture.host
				.request("host/fetch", {
					method: "POST",
					url: request.url,
					headers: request.headers,
					body: { base64: Buffer.from(request.body).toString("base64url") },
				})
				.catch((reason: unknown) => {
					error = reason;
				});
			expect(calls, "changed trusted prompt must not reach a Fake").toBe(0);
			expect(error).toMatchObject({ code: "DENIED" });
			const matching = changedBody(request, (body) => {
				const message = (body.messages as { content: string }[])[1];
				if (!message) throw new Error("Fixture user message missing");
				message.content = "Different trusted prompt";
			});
			expect(
				await fixture.host.request("host/fetch", {
					method: "POST",
					url: matching.url,
					headers: matching.headers,
					body: { base64: Buffer.from(matching.body).toString("base64url") },
				}),
			).toMatchObject({ status: 200 });
			expect(calls).toBe(1);
		} finally {
			await fixture.host.close();
		}
	});
});
