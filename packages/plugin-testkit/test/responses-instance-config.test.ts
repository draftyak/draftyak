import { inspect } from "node:util";
import { createFake } from "@draftyak/fakes";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
import { defineAiProviderPlugin, type PluginContext, type PluginInstance } from "@draftyak/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemory } from "../src/in-memory.ts";
import { createMockHub } from "../src/mock-hub.ts";
import type { MockHub, MockHubOptions, MockPlugin } from "../src/types.ts";
import { manifest as aiManifest, outcome, request } from "./fixtures/ai-fixture/plugin.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";

const ID = "00000000000000000000000001";
const OTHER = "00000000000000000000000002";
const hubs: MockHub[] = [];
afterEach(async () => {
	await Promise.all(hubs.splice(0).map((hub) => hub.close()));
});

function provider(
	observe: (context: PluginContext) => void = () => {},
	profile = "responses-api-v1",
): MockPlugin {
	const manifest = { ...aiManifest, egress: { profile } };
	return {
		manifest,
		entry: defineAiProviderPlugin({
			manifest,
			describe: (_args, context) => {
				observe(context);
				return { name: "Synthetic configured provider", structuredOutput: "validated" };
			},
			listModels: (_args, context) => {
				observe(context);
				return { models: [] };
			},
			probe: (_args, context) => {
				observe(context);
				return { status: "ok" };
			},
			generateDraft: (_args, context) => {
				observe(context);
				return structuredClone(outcome);
			},
		}),
	};
}

function options(
	instance: MockHubOptions["instance"] = { id: ID, config: { model: "synthetic" } },
): MockHubOptions {
	return {
		mode: "in-memory",
		plugin: provider(),
		upstreams: [],
		instance,
		responsesHttp: [{ operation: "ai_models_list", origin: "https://api.openai.com" }],
	};
}
function track(input: MockHubOptions): MockHub {
	const hub = createMockHub(input);
	hubs.push(hub);
	return hub;
}
function refuses(input: MockHubOptions, code = "INSTANCE_CONFIG_UNAVAILABLE"): void {
	let failure: unknown;
	try {
		hubs.push(createMockHub(input));
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({ code });
	expect(String(failure)).toBe(`Error: Mock hub: ${code}`);
	expect((failure as Error).stack).not.toContain("DYTEST-PRIVATE-CONFIG");
	expect(inspect(failure)).not.toContain("DYTEST-PRIVATE-CONFIG");
}

describe("trusted Responses instance configuration", () => {
	it("captures one frozen SDK snapshot for real MCP calls and ignores candidate metadata", async () => {
		const seen: PluginContext[] = [];
		const config = { model: "synthetic", settings: { effort: "low" }, labels: ["DYTEST"] };
		const instance = { id: ID, config };
		const bindings: ResponsesHttpBindingInput[] = [
			{ operation: "ai_models_list", origin: "https://api.openai.com" },
		];
		const input = {
			...options(instance),
			plugin: provider((context) => seen.push(context)),
			responsesHttp: bindings,
		};
		const hub = track(input);
		instance.id = OTHER;
		config.model = "changed";
		config.settings.effort = "high";
		config.labels.push("changed");
		input.instance = { id: OTHER, config: { forged: true } } as unknown as typeof instance;
		bindings.length = 0;
		const metadata = {
			instance: { id: OTHER, config: { forged: true } },
			instanceId: OTHER,
			config: { forged: true },
		};
		for (const [name, args] of [
			["ai_models_list", {}],
			["ai_probe", { model: "candidate" }],
			["ai_draft_generate", { ...request }],
		] as const) {
			expect((await hub.call(name, args, metadata)).isError).not.toBe(true);
		}
		expect(seen).toHaveLength(3);
		for (const context of seen) {
			expect(context.instance).toEqual({
				id: ID,
				config: { model: "synthetic", settings: { effort: "low" }, labels: ["DYTEST"] },
			});
			expect(context.instance).toBe(seen[0]?.instance);
			expect(Object.isFrozen(context.instance)).toBe(true);
			expect(Object.isFrozen(context.instance?.config)).toBe(true);
			expect(Object.isFrozen(context.instance?.config.settings)).toBe(true);
			expect(Object.isFrozen(context.instance?.config.labels)).toBe(true);
		}
	});

	it.each([undefined, ID, { id: ID }, { id: ID, config: {} }, { id: ID, config: undefined }])(
		"keeps legacy empty/string instance input %j",
		async (instance) => {
			const seen: PluginContext[] = [];
			const input = { ...options(), instance };
			const { responsesHttp: _bindings, ...legacy } = input;
			const hub = track({ ...legacy, plugin: provider((context) => seen.push(context)) });
			await hub.call("ai_models_list", {});
			expect(seen[0]?.instance).toEqual({ id: ID, config: {} });
		},
	);

	it.each(["messages-api-v1", "chat-completions-v1"])(
		"keeps nonempty configuration unavailable for %s",
		(profile) => {
			refuses({ ...options(), plugin: provider(undefined, profile) });
		},
	);
	it("keeps nonempty channel and process configuration unavailable", () => {
		refuses({ ...options(), plugin: channelFixture() });
		refuses({ ...options(), mode: "process" });
	});
	it.each([
		["absent", undefined],
		["empty", []],
	] as const)("requires nonempty trusted constructor inputs: %s", (_kind, responsesHttp) => {
		refuses({ ...options(), responsesHttp });
	});
	it("requires genuinely valid constructor inputs before plugin execution", () => {
		const observed = vi.fn();
		refuses(
			{
				...options(),
				plugin: provider(observed),
				responsesHttp: [
					{ operation: "ai_models_list", origin: "https://wrong.example" },
				] as unknown as ResponsesHttpBindingInput[],
			},
			"INVALID_RESPONSES_BINDINGS",
		);
		expect(observed).not.toHaveBeenCalled();
	});

	it.each([null, [], new Date(), 1, "text"])("refuses a non-record config %j", (config) => {
		refuses(options({ id: ID, config } as unknown as NonNullable<MockHubOptions["instance"]>));
	});
	it("refuses cycles, non-JSON values and excessive nesting through the public SDK capture", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		let nested: unknown = "leaf";
		for (let depth = 0; depth < 34; depth++) nested = { nested };
		for (const value of [cyclic, undefined, Symbol("DYTEST"), 1n, NaN, Infinity, () => {}, nested])
			refuses(options({ id: ID, config: { value } }));
	});
	it("refuses hostile own fields and proxies without invoking hooks", () => {
		let hooks = 0;
		const hook = () => {
			hooks++;
			throw new Error("DYTEST-PRIVATE-CONFIG");
		};
		const traps = {
			get: hook,
			ownKeys: hook,
			getPrototypeOf: hook,
			getOwnPropertyDescriptor: hook,
		};
		const proxy = new Proxy({}, traps);
		const accessor = Object.defineProperty({}, "value", { enumerable: true, get: hook });
		const array = Object.defineProperty([null], "0", { enumerable: true, get: hook });
		for (const config of [
			proxy,
			accessor,
			{ value: proxy },
			{ value: new Proxy([], traps) },
			{ value: array },
		])
			refuses(options({ id: ID, config }));
		for (const instance of [
			proxy,
			Object.defineProperty({ id: ID }, "config", { enumerable: true, get: hook }),
			Object.defineProperty({ config: {} }, "id", { enumerable: true, get: hook }),
		])
			refuses(options(instance as NonNullable<MockHubOptions["instance"]>));
		refuses(Object.defineProperty(options(), "instance", { enumerable: true, get: hook }));
		refuses(new Proxy(options(), traps), "INVALID_OPTIONS");
		refuses(
			Object.defineProperty(options(), "responsesHttp", { enumerable: true, get: hook }),
			"INVALID_RESPONSES_BINDINGS",
		);
		expect(hooks).toBe(0);
	});
	it("rejects invalid config before the SDK server can inspect plugin tools", () => {
		let factories = 0;
		const plugin = provider();
		const entry = {
			...plugin.entry,
			get tools() {
				factories++;
				return plugin.entry.tools;
			},
		};
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		refuses({ ...options({ id: ID, config: cyclic }), plugin: { ...plugin, entry } });
		expect(factories).toBe(0);
	});
	it("uses the SDK wrapper-byte bound and config-field bound exactly", async () => {
		const overhead = Buffer.byteLength(JSON.stringify({ id: ID, config: { text: "" } }));
		const exact = "x".repeat(65_536 - overhead);
		await track(options({ id: ID, config: { text: exact } })).call("ai_models_list", {});
		refuses(options({ id: ID, config: { text: `${exact}x` } }));
		const fields = Object.fromEntries(Array.from({ length: 4096 }, (_, index) => [`k${index}`, 0]));
		await track(options({ id: ID, config: fields })).call("ai_models_list", {});
		refuses(options({ id: ID, config: { ...fields, excess: 0 } }));
	});
	it("checks and serves the configuration captured before later option reads", async () => {
		const seen: PluginContext[] = [];
		const config: Record<string, unknown> = {};
		const input: Record<string, unknown> = {
			mode: "in-memory",
			plugin: provider((context) => seen.push(context), "messages-api-v1"),
			instance: { id: ID, config },
		};
		Object.defineProperty(input, "upstreams", {
			enumerable: true,
			get() {
				config.injected = "late";
				return [];
			},
		});
		await track(input as unknown as MockHubOptions).call("ai_models_list", {});
		expect(config).toEqual({ injected: "late" });
		expect(seen.map((context) => context.instance)).toEqual([{ id: ID, config: {} }]);
	});
	it("issues the bindings the configuration gate checked despite later option reads", async () => {
		const seen: PluginContext[] = [];
		const bindings: ResponsesHttpBindingInput[] = [
			{ operation: "ai_models_list", origin: "https://api.openai.com" },
		];
		const upstream = createFake({ fetch: () => new Response("ok") }, { host: "api.openai.com" });
		const input: Record<string, unknown> = {
			...options(),
			plugin: provider((context) => seen.push(context)),
			responsesHttp: bindings,
		};
		Object.defineProperty(input, "upstreams", {
			enumerable: true,
			get() {
				bindings.length = 0;
				return [upstream];
			},
		});
		const hub = track(input as unknown as MockHubOptions);
		expect(bindings).toHaveLength(0);
		await hub.call("ai_models_list", {});
		expect(seen.map((context) => context.instance)).toEqual([
			{ id: ID, config: { model: "synthetic" } },
		]);
		await expect(
			hub.host.request("host/fetch", {
				method: "GET",
				url: "https://api.openai.com/v1/models",
				headers: [
					["accept", "application/json"],
					["authorization", "Bearer brokered"],
				],
			}),
		).resolves.toMatchObject({ status: 200 });
	});
	it("treats an explicit undefined binding list like an absent one", () => {
		const hub = track({
			mode: "in-memory",
			plugin: channelFixture(),
			upstreams: [],
			responsesHttp: undefined,
		});
		expect(hub.manifest.kind).toBe("channel");
	});
	it("keeps the SDK's own report for definition errors with any serving instance", () => {
		const plugin = provider();
		const entry = {
			...plugin.entry,
			tools: plugin.entry.tools.map((tool) => ({ ...tool, timeoutMs: 0 })),
		};
		for (const input of [
			{ mode: "in-memory", plugin: { ...plugin, entry }, upstreams: [] } as const,
			{ ...options(), plugin: { ...plugin, entry } },
		])
			expect(() => createMockHub(input)).toThrow("Invalid plugin timeout");
	});
	it("retains identity and account checks", () => {
		expect(() => createMockHub(options("invalid"))).toThrow("INVALID_INSTANCE");
		refuses({ ...options(), account: { id: OTHER, mode: "read_only" } }, "ACCOUNT_MISMATCH");
	});
	it("keeps the direct three-argument in-memory API and optional fourth SDK instance", async () => {
		const hub = track(options());
		const seen: (PluginInstance | undefined)[] = [];
		const plugin = provider((context) => seen.push(context.instance));
		await createInMemory(plugin.entry, hub.host, false).request("tools/call", {
			name: "ai_models_list",
			arguments: {},
		});
		await createInMemory(plugin.entry, hub.host, false, {
			id: ID,
			config: { explicit: true },
		}).request("tools/call", { name: "ai_models_list", arguments: {} });
		expect(seen).toEqual([undefined, { id: ID, config: { explicit: true } }]);
	});
});
