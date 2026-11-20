import { createMessagesPlugin } from "@draftyak/ai-messages-api";
import { createClient } from "@draftyak/ai-messages-api/client";
import {
	createMessagesApiDraftFake,
	createMessagesApiFake,
	type MessagesApiFake,
} from "@draftyak/fakes/messages-api";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manifest = {
	id: "@example/messages",
	version: "1.0.0",
	sdk: "1.0.0",
	kind: "ai-provider",
	contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
	isolation: "standard",
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	license: "Apache-2.0",
	dataClasses: ["community.content"],
	egress: { profile: "messages-api-v1" },
};
const entry = createMessagesPlugin(manifest);
const model = (id: string, fields: Record<string, unknown> = {}) => ({
	id,
	type: "model",
	display_name: "Synthetic model",
	lifecycle: "active",
	max_input_tokens: 12_345,
	...fields,
});
const page = (id: string, more = false) => ({
	data: [model(id)],
	has_more: more,
	first_id: id,
	last_id: id,
});
const noNetwork = vi.fn(async () => {
	throw new Error("Unexpected global network");
});
beforeEach(() => {
	noNetwork.mockClear();
	vi.stubGlobal("fetch", noNetwork);
});
afterEach(() => {
	expect(noNetwork).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function mounted(fake: MessagesApiFake) {
	const controller = new AbortController();
	const base = createPluginContext(
		{ plugin: manifest.id, instance: { id: "synthetic", config: { model: "claude-configured" } } },
		memoryHost(() => {
			throw new Error("Unexpected host method");
		}),
		controller.signal,
	);
	const context: PluginContext = {
		...base,
		fetch: (input, init) => {
			const { body, ...options } = init ?? {};
			expect(body).toBeUndefined();
			return fake.fetch(input, options);
		},
	};
	return {
		controller,
		invoke: (name: string, args: unknown) => {
			const tool = entry.tools.find((value) => value.name === name);
			if (!tool) throw new Error("Missing provider tool");
			return Promise.resolve(tool.handler(args, context, {}, { progress: async () => {} }));
		},
	};
}

describe.each([
	["generic", createMessagesApiFake],
	["draft", createMessagesApiDraftFake],
] as const)("merged Messages client with %s metadata fake", (_name, create) => {
	it("lists two actual SDK pages and retrieves an explicit model with no request body", async () => {
		const fake = create({
			steps: [
				{ kind: "json", body: page("claude-model-1", true) },
				{ kind: "json", body: page("claude-model-2") },
				{ kind: "json", body: model("claude-probe") },
			],
		});
		const f = mounted(fake);
		await expect(f.invoke("ai_models_list", {})).resolves.toEqual({
			models: [
				{ id: "claude-model-1", name: "Synthetic model", contextTokens: 12_345 },
				{ id: "claude-model-2", name: "Synthetic model", contextTokens: 12_345 },
			],
		});
		await expect(f.invoke("ai_probe", { model: "claude-probe" })).resolves.toEqual({
			status: "ok",
		});
		expect(fake.pending()).toBe(0);
		expect(
			fake.recorder
				.takeRequests()
				.map(({ method, target, bodyLength }) => ({ method, target, bodyLength })),
		).toEqual([
			{ method: "GET", target: "/v1/models?limit=100", bodyLength: 0 },
			{ method: "GET", target: "/v1/models?limit=100&after_id=claude-model-1", bodyLength: 0 },
			{ method: "GET", target: "/v1/models/claude-probe", bodyLength: 0 },
		]);
	});

	it("preserves malformed model metadata for the actual component to refuse", async () => {
		const fake = create({
			steps: [{ kind: "raw", body: '{"broken":', contentType: "application/json" }],
		});
		await expect(mounted(fake).invoke("ai_models_list", {})).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(fake.pending()).toBe(0);
	});
});

it("keeps opaque scripted cursors separate from mounted catalogue admission", async () => {
	const opaque = "opaque/cursor+value";
	const fake = createMessagesApiDraftFake({
		steps: [
			{ kind: "json", body: { ...page("claude-model-1", true), last_id: opaque } },
			{ kind: "json", body: page("claude-model-2") },
		],
	});
	await expect(mounted(fake).invoke("ai_models_list", {})).rejects.toMatchObject({
		result: { code: "TRANSIENT" },
	});
	expect(fake.pending()).toBe(1);
	expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
		"/v1/models?limit=100",
	]);
	const client = createClient((input, init) => fake.fetch(input, init), { maxRetries: 0 });
	expect(
		(await client.models.list({ limit: 100, after_id: opaque }, {})).data.map((value) => value.id),
	).toEqual(["claude-model-2"]);
	expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
		"/v1/models?limit=100&after_id=opaque%2Fcursor%2Bvalue",
	]);
	expect(fake.pending()).toBe(0);
});

it("preserves the pinned SDK path pchars independently of component ModelId admission", async () => {
	const opaque = "claude-synthetic:@!$&'()*+,;=";
	const fake = createMessagesApiDraftFake({ steps: [{ kind: "json", body: model(opaque) }] });
	await expect(mounted(fake).invoke("ai_probe", { model: opaque })).rejects.toMatchObject({
		result: { code: "INVALID_INPUT" },
	});
	expect(fake.pending()).toBe(1);
	const client = createClient((input, init) => fake.fetch(input, init), { maxRetries: 0 });
	await expect(client.models.retrieve(opaque, {}, {})).resolves.toMatchObject({ id: opaque });
	expect(fake.recorder.takeRequests().map(({ method, target }) => ({ method, target }))).toEqual([
		{ method: "GET", target: "/v1/models/claude-synthetic:@!$&'()*+,;=" },
	]);
	expect(fake.pending()).toBe(0);
});

it("uses configured probe metadata and leaves retired-model classification to the component", async () => {
	const fake = createMessagesApiDraftFake({
		steps: [{ kind: "json", body: model("claude-configured", { lifecycle: "retired" }) }],
	});
	await expect(mounted(fake).invoke("ai_probe", {})).resolves.toEqual({
		status: "degraded",
		detail: "MODEL_RETIRED",
	});
	expect(fake.recorder.takeRequests().map(({ target }) => target)).toEqual([
		"/v1/models/claude-configured",
	]);
});

it("keeps actual SDK metadata failures single-attempt with canonical retry hints", async () => {
	const fake = createMessagesApiDraftFake({
		steps: [
			{
				kind: "json",
				status: 429,
				headers: { "retry-after": "3" },
				body: { type: "error", error: { type: "rate_limit_error", message: "Synthetic limit" } },
			},
		],
	});
	await expect(mounted(fake).invoke("ai_probe", {})).rejects.toMatchObject({
		result: { code: "RATE_LIMITED", retryAfterMs: 3000 },
	});
	expect(fake.pending()).toBe(0);
	expect(fake.recorder.takeRequests()).toHaveLength(1);
});

it("cancels an actual SDK metadata call after queue reservation", async () => {
	vi.useFakeTimers();
	const fake = createMessagesApiFake({
		steps: [{ kind: "json", body: page("claude-model-1"), delayMs: 60_000 }],
	});
	const f = mounted(fake);
	const settled = f.invoke("ai_models_list", {}).then(
		() => undefined,
		(error: unknown) => error,
	);
	try {
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.pending()).toBe(0);
		f.controller.abort();
		expect(await settled).toBeInstanceOf(PluginError);
		expect(await settled).toMatchObject({ result: { code: "TRANSIENT" } });
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	} finally {
		f.controller.abort();
		await settled;
	}
});
