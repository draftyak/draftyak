import { createFake } from "@draftyak/fakes";
import { defineAiProviderPlugin } from "@draftyak/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiProviderFixtures, checkAiProviderOutput } from "../src/contracts/ai-provider.ts";
import { createMockHub } from "../src/mock-hub.ts";
import { type MockHub, MockHubError, type MockHubOptions, type MockPlugin } from "../src/types.ts";
import { manifest as baseManifest } from "./fixtures/ai-fixture/plugin.ts";
import {
	compatibleBody,
	compatibleConfig,
	outcome,
	request,
} from "./fixtures/ai-provider-compatible-http/fixture.ts";

const hubs: MockHub[] = [];
const directFetch = vi.fn(() => Promise.reject(new Error("Direct fetch refused")));
beforeEach(() => {
	directFetch.mockClear();
	vi.stubGlobal("fetch", directFetch);
});
afterEach(async () => {
	try {
		await Promise.all(hubs.splice(0).map((hub) => hub.close()));
	} finally {
		vi.unstubAllGlobals();
	}
	expect(directFetch).not.toHaveBeenCalled();
});

function setup(
	profile: "chat-completions-v1" | "responses-api-v1" | "messages-api-v1" = "chat-completions-v1",
) {
	const config: {
		endpoint: string;
		model: string;
		format: "json_schema" | "json_object" | "ollama";
	} = {
		...compatibleConfig("json_schema"),
	};
	const draft = {
		model: request.model,
		system: request.system,
		prompt: request.prompt,
		contextIds: [...request.contextIds],
	};
	const selected = { operation: "ai_draft_generate" as const, config, draft };
	const bindings = [selected];
	const endpoint = config.endpoint;
	const originalBody = compatibleBody("json_schema", structuredClone(request));
	let body = originalBody;
	let calls = 0;
	const upstream = createFake(
		{
			fetch: () => {
				calls++;
				return new Response("DYTEST fixture response", {
					headers: { "content-type": "text/plain" },
				});
			},
		},
		{ host: new URL(endpoint).hostname },
	);
	const manifest = { ...baseManifest, egress: { profile } };
	const plugin: MockPlugin = {
		manifest,
		entry: defineAiProviderPlugin({
			manifest,
			describe: () => ({ name: "Compatible constructor fixture", structuredOutput: "validated" }),
			listModels: () => ({ models: [{ id: request.model }] }),
			probe: () => ({ status: "ok" }),
			async generateDraft(_request, context) {
				const response = await context.fetch(endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
					redirect: "error",
				});
				if (response.status !== 200 || (await response.text()) !== "DYTEST fixture response")
					throw new Error("DYTEST fixture response refused");
				return structuredClone(outcome);
			},
		}),
	};
	return {
		config,
		draft,
		selected,
		bindings,
		plugin,
		upstream,
		calls: () => calls,
		setBody(value: string) {
			body = value;
		},
		originalBody,
		options(): MockHubOptions {
			return { mode: "in-memory", plugin, upstreams: [upstream], compatibleHttp: bindings };
		},
		mutate() {
			config.endpoint = "https://changed.example.invalid/api/chat";
			config.model = "DYTEST-changed-model";
			config.format = "ollama";
			draft.model = "DYTEST-changed-model";
			draft.system = "DYTEST changed system";
			draft.prompt = "DYTEST changed prompt";
			draft.contextIds.splice(0, draft.contextIds.length, "c3");
			bindings.length = 0;
		},
	};
}

function open(options: MockHubOptions): MockHub {
	const hub = createMockHub(options);
	hubs.push(hub);
	return hub;
}
async function accepted(hub: MockHub): Promise<void> {
	const result = await hub.call("ai_draft_generate", { ...structuredClone(request) });
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual(outcome);
}
function refused(options: MockHubOptions, expected: string): void {
	let code: string | undefined;
	try {
		open(options);
	} catch (error) {
		code = error instanceof MockHubError ? error.code : "UNEXPECTED_ERROR";
	}
	expect(code).toBe(expected);
}

describe("compatible HTTP public constructor snapshots", () => {
	it("captures nested inputs before an intervening plugin getter can replace them", async () => {
		const f = setup();
		let reads = 0;
		const options: MockHubOptions = {
			...f.options(),
			get plugin() {
				reads++;
				f.mutate();
				return f.plugin;
			},
		};
		const hub = open(options);
		expect(reads).toBeGreaterThan(0);
		expect(f.bindings).toHaveLength(0);
		await accepted(hub);
		expect(f.calls()).toBe(1);
	});

	it("captures contract fixture inputs before its request getter mutates nested configuration", async () => {
		const f = setup();
		let reads = 0;
		const fixtures: AiProviderFixtures = {
			compatibleHttp: f.bindings,
			upstreams: [f.upstream],
			get request() {
				reads++;
				f.mutate();
				return structuredClone(request);
			},
			expected: structuredClone(outcome),
			progress: [
				{ progress: 0, total: 1 },
				{ progress: 1, total: 1 },
			],
		};
		expect(
			await checkAiProviderOutput({
				mode: "in-memory",
				plugin: f.plugin,
				fixtures: () => fixtures,
			}),
		).toEqual({ status: "pass" });
		expect(reads).toBeGreaterThan(0);
		expect(f.calls()).toBe(1);
	});

	it("keeps constructor configuration and nested draft arrays detached after construction", async () => {
		const f = setup();
		const hub = open(f.options());
		f.mutate();
		await accepted(hub);
		expect(f.calls()).toBe(1);
	});

	it("never takes a replacement schema array from the candidate request", async () => {
		const f = setup();
		const hub = open(f.options());
		const candidate = JSON.parse(f.originalBody) as {
			response_format: { json_schema: { schema: { required: string[] } } };
		};
		expect(Array.isArray(candidate.response_format.json_schema.schema.required)).toBe(true);
		expect(candidate.response_format.json_schema.schema.required.length).toBeGreaterThan(0);
		candidate.response_format.json_schema.schema.required.length = 0;
		f.setBody(JSON.stringify(candidate));
		const result = await hub.call("ai_draft_generate", { ...structuredClone(request) });
		expect(result.isError).toBe(true);
		expect(hub.host.denials.map((row) => row.reason)).toContain("OFF_RULE");
		expect(f.calls()).toBe(0);
		f.setBody(f.originalBody);
		await accepted(hub);
		expect(f.calls()).toBe(1);
	});

	it.each([
		"proxy-array",
		"accessor-entry",
		"proxy-config",
		"accessor-model",
		"extra-field",
		"sparse-array",
		"accessor-option",
	] as const)(
		"refuses %s constructor bindings before hooks, plugin reads or upstream dispatch",
		(kind) => {
			const f = setup();
			let hooks = 0,
				pluginReads = 0;
			const hook = (): never => {
				hooks++;
				throw new Error("DYTEST binding hook reached");
			};
			const traps = {
				get: hook,
				ownKeys: hook,
				getPrototypeOf: hook,
				getOwnPropertyDescriptor: hook,
			};
			let inputs: unknown = f.bindings;
			if (kind === "proxy-array") inputs = new Proxy([], traps);
			if (kind === "accessor-entry")
				inputs = Object.defineProperty([null], "0", { enumerable: true, get: hook });
			if (kind === "proxy-config") inputs = [{ ...f.selected, config: new Proxy({}, traps) }];
			if (kind === "accessor-model")
				inputs = [
					{
						...f.selected,
						config: Object.defineProperty({ ...f.config }, "model", {
							enumerable: true,
							get: hook,
						}),
					},
				];
			if (kind === "extra-field") inputs = [{ ...f.selected, nativePermission: true }];
			if (kind === "sparse-array") inputs = new Array(1);
			const options: MockHubOptions = {
				mode: "in-memory",
				get plugin() {
					pluginReads++;
					return f.plugin;
				},
				upstreams: [f.upstream],
				compatibleHttp: inputs as MockHubOptions["compatibleHttp"],
			};
			if (kind === "accessor-option")
				Object.defineProperty(options, "compatibleHttp", { enumerable: true, get: hook });
			refused(options, "INVALID_COMPATIBLE_BINDINGS");
			expect(hooks).toBe(0);
			expect(pluginReads).toBe(0);
			expect(f.calls()).toBe(0);
		},
	);

	it.each(["messages-api-v1", "responses-api-v1"] as const)(
		"refuses compatible bindings on the %s profile",
		(profile) => {
			const f = setup(profile);
			refused(f.options(), "INVALID_COMPATIBLE_BINDINGS");
			expect(f.calls()).toBe(0);
		},
	);

	it("keeps nonempty process instance configuration unavailable", () => {
		const f = setup();
		refused(
			{
				...f.options(),
				mode: "process",
				instance: { id: "00000000000000000000000001", config: { model: request.model } },
			},
			"INSTANCE_CONFIG_UNAVAILABLE",
		);
		expect(f.calls()).toBe(0);
	});

	it("refuses accessor contract bindings before reading another fixture field", async () => {
		const f = setup();
		let hooks = 0,
			reads = 0;
		const fixtures = Object.defineProperties(
			{},
			{
				compatibleHttp: {
					enumerable: true,
					get() {
						hooks++;
						throw new Error("DYTEST fixture hook reached");
					},
				},
				request: {
					enumerable: true,
					get() {
						reads++;
						return request;
					},
				},
			},
		);
		expect(
			await checkAiProviderOutput({
				mode: "in-memory",
				plugin: f.plugin,
				fixtures: () => fixtures as AiProviderFixtures,
			}),
		).toEqual({ status: "fail", code: "AI_FIXTURES_INVALID" });
		expect(hooks).toBe(0);
		expect(reads).toBe(0);
		expect(f.calls()).toBe(0);
	});
});
