import type { HeaderList } from "@draftyak/protocol/hash";
import { HOST_MAX_STREAM_BYTES, HOST_REQUEST_TIMEOUT_MS } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import {
	createResponsesHttpBinding,
	type ResponsesHttpBinding,
	type ResponsesHttpBindingInput,
} from "@draftyak/protocol/manifest/responses-http";
import { describe, expect, it } from "vitest";
import { matchRequest } from "../src/policy.ts";
import { manifest as scripted } from "./fixtures/ai-fixture/plugin.ts";

if (scripted.kind !== "ai-provider") throw new Error("DYTEST-provider fixture required");
const providerFixture = scripted;

const manifest: PluginManifestV1 = { ...providerFixture, egress: { profile: "responses-api-v1" } };
const secrets = new Map<string, string>();
const headers: HeaderList = [
	["accept", "application/json"],
	["authorization", "Bearer brokered"],
];
const origin = "https://api.openai.com" as const;

function binding(input: ResponsesHttpBindingInput): ResponsesHttpBinding {
	const result = createResponsesHttpBinding(input);
	if (!result.ok) throw new Error("DYTEST-trusted binding refused");
	return result.binding;
}

function matched(
	url: string,
	bindings: readonly ResponsesHttpBinding[],
	headersForRequest: HeaderList = headers,
	body = new Uint8Array(),
	method = "GET",
) {
	return matchRequest(manifest, url, method, secrets, {
		bindings,
		headers: headersForRequest,
		body,
	});
}

describe("trusted Responses HTTP fixture policy", () => {
	it("admits a constructor-bound models request with the canonical response and deadline bounds", () => {
		const selected = binding({ operation: "ai_models_list", origin });
		expect(matched(`${origin}/v1/models`, [selected])).toMatchObject({
			url: `${origin}/v1/models`,
			rule: {
				class: "read",
				method: "GET",
				host: "api.openai.com",
				pathTemplate: "/v1/models",
				maxBytes: HOST_MAX_STREAM_BYTES,
				timeoutMs: HOST_REQUEST_TIMEOUT_MS,
			},
		});
	});

	it("admits the bound model's literal RFC 3986 path characters", () => {
		const model = "DYTEST:alpha@beta+1";
		const selected = binding({ operation: "ai_probe", origin, model });
		expect(matched(`${origin}/v1/models/${model}`, [selected])?.url).toBe(
			`${origin}/v1/models/${model}`,
		);
		expect(matched(`${origin}/v1/models/DYTEST-other`, [selected])).toBeUndefined();
	});

	it("admits the bound model's encoded slash before channel-segment checks", () => {
		const selected = createResponsesHttpBinding({
			operation: "ai_probe",
			origin,
			model: "DYTEST/one",
		});
		expect(selected.ok).toBe(true);
		if (!selected.ok) throw new Error("DYTEST-trusted binding refused");
		expect(matched(`${origin}/v1/models/DYTEST%2Fone`, [selected.binding])?.url).toBe(
			`${origin}/v1/models/DYTEST%2Fone`,
		);
		expect(matched(`${origin}/v1/models/DYTEST%2Ftwo`, [selected.binding])).toBeUndefined();
		expect(matched(`${origin}/v1/models/DYTEST/one`, [selected.binding])).toBeUndefined();
	});

	it("never derives an expectation from the candidate request", () => {
		const selected = binding({ operation: "ai_probe", origin, model: "DYTEST-one" });
		expect(matched(`${origin}/v1/models/DYTEST-two`, [selected])).toBeUndefined();
		expect(matched(`${origin}/v1/models`, [selected])).toBeUndefined();
		expect(matched(`${origin}/v1/models/DYTEST-one`, [])).toBeUndefined();
		expect(matched(`${origin}/v1/models/DYTEST-one`, [{} as ResponsesHttpBinding])).toBeUndefined();
		expect(
			matchRequest(manifest, `${origin}/v1/models/DYTEST-one`, "GET", secrets),
		).toBeUndefined();
	});

	it.each([
		{
			headers: [
				["accept", "application/json"],
				["authorization", "Bearer wrong"],
			],
		},
		{ headers: [["accept", "application/json"]] },
		{
			headers: [
				["accept", "application/json"],
				["authorization", "Bearer brokered"],
				["x-extra", "DYTEST"],
			],
		},
		{
			headers: [
				["accept", "application/json"],
				["authorization", "Bearer brokered"],
				["Authorization", "Bearer brokered"],
			],
		},
	] as const)(
		"refuses original headers that filtering must not hide: %j",
		({ headers: candidate }) => {
			const selected = binding({ operation: "ai_models_list", origin });
			expect(matched(`${origin}/v1/models`, [selected], candidate)).toBeUndefined();
		},
	);

	it.each([
		"https://other.example/v1/models",
		"http://api.openai.com/v1/models",
		"https://api.openai.com:443/v1/models",
		"https://api.openai.com/v1/models?query=DYTEST",
		"https://api.openai.com/v1/models#DYTEST",
		"https://api.openai.com/v1/responses",
	])("refuses a URL outside the issued binding: %s", (url) => {
		const selected = binding({ operation: "ai_models_list", origin });
		expect(matched(url, [selected])).toBeUndefined();
	});

	it("refuses a changed method or a nonempty GET body", () => {
		const selected = binding({ operation: "ai_models_list", origin });
		expect(
			matched(`${origin}/v1/models`, [selected], headers, new Uint8Array(), "POST"),
		).toBeUndefined();
		expect(
			matched(`${origin}/v1/models`, [selected], headers, new Uint8Array([1])),
		).toBeUndefined();
	});

	it.each(["messages-api-v1", "chat-completions-v1"] as const)(
		"never grants the Responses profile to %s",
		(profile) => {
			const selected = binding({ operation: "ai_models_list", origin });
			expect(
				matchRequest(
					{ ...providerFixture, egress: { profile } },
					`${origin}/v1/models`,
					"GET",
					secrets,
					{
						bindings: [selected],
						headers,
						body: new Uint8Array(),
					},
				),
			).toBeUndefined();
		},
	);
});
