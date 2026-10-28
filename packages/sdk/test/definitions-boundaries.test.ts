import { describe, expect, it } from "vitest";
import { defineAiProviderPlugin } from "../src/ai-provider.ts";
import { defineChannelPlugin } from "../src/channel.ts";
import { createPluginContext } from "../src/context.ts";
import { dataCopy } from "../src/definitions.ts";
import { memoryHost } from "../src/host.ts";
import { createPluginServer, type PluginEntry, type PluginTool, serve } from "../src/serve.ts";
import { defineToolPlugin } from "../src/tool.ts";
import { aiManifest, bootstrap, channelManifest, toolManifest } from "./definitions-fixtures.ts";

const channel = {
	manifest: channelManifest,
	describe: () => ({ channel: "chat" as const, mutations: [], attachments: false, listen: false }),
	probe: () => ({ status: "ok" as const }),
	sync: () => ({ changes: [], cursor: "next", more: false }),
	fetchBody: () => {
		throw new Error("not found");
	},
	send: () => ({}),
	reconcileSend: () => ({ candidates: [], complete: true }),
};
function probe(entry: PluginEntry): PluginTool {
	const found = entry.tools.find((tool) => tool.name.endsWith("_probe"));
	if (!found) throw new Error("Probe missing");
	return found;
}
describe("definition trust boundaries", () => {
	it("rejects an otherwise valid function at an unknown definition member", () => {
		for (const key of ["prompts", "resources", "completion", "ui"])
			expect(() => defineChannelPlugin({ ...channel, [key]: () => ({}) })).toThrow();
	});
	it("keeps a captured handler independent of later definition changes", async () => {
		const input = { ...channel };
		const entry = defineChannelPlugin(input);
		input.probe = () => {
			throw new Error("replaced");
		};
		const host = memoryHost(() => null);
		try {
			expect(
				await probe(entry).handler({}, createPluginContext({ plugin: "test" }, host), {}),
			).toEqual({ status: "ok" });
		} finally {
			host.close();
		}
	});
	it("rejects off-schema channel and provider output before the MCP library can mask that guard", async () => {
		const entries = [
			defineChannelPlugin({
				...channel,
				probe: () => ({ status: "invalid" }),
			} as unknown as Parameters<typeof defineChannelPlugin>[0]),
			defineAiProviderPlugin({
				manifest: aiManifest,
				describe: () => ({ name: "Provider", structuredOutput: "validated" }),
				listModels: () => ({ models: [] }),
				probe: () => ({ status: "invalid" }),
				generateDraft: () => {
					throw new Error("unused");
				},
			} as unknown as Parameters<typeof defineAiProviderPlugin>[0]),
		];
		const host = memoryHost(() => null);
		try {
			for (const entry of entries)
				await expect(
					probe(entry).handler({}, createPluginContext({ plugin: "test" }, host), {}),
				).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		} finally {
			host.close();
		}
	});
	it("rejects off-schema input before invoking a handler even without MCP prevalidation", async () => {
		let calls = 0;
		const entry = defineChannelPlugin({
			...channel,
			probe: () => {
				calls++;
				return { status: "ok" };
			},
		});
		const host = memoryHost(() => null);
		try {
			await expect(
				probe(entry).handler({ injected: true }, createPluginContext({ plugin: "test" }, host), {}),
			).rejects.toMatchObject({ result: { code: "INVALID_INPUT" } });
			expect(calls).toBe(0);
		} finally {
			host.close();
		}
	});
	it("rejects off-schema tool output before MCP output validation", async () => {
		const entry = defineToolPlugin({
			manifest: toolManifest,
			probe: () => ({ status: "ok", bytes: 0, items: 0 }),
			lookup: { "kb.lookup": () => ({ entries: [{ label: "long", text: "x".repeat(2001) }] }) },
		});
		const handler = entry.tools.find((tool) => tool.name === "kb.lookup");
		if (!handler) throw new Error("Lookup missing");
		const host = memoryHost(() => null);
		try {
			await expect(
				handler.handler(
					{ topic: "work" },
					createPluginContext({ plugin: "test", instance: bootstrap.instance }, host),
					{},
				),
			).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		} finally {
			host.close();
		}
	});
	it("rejects proxy accessor cyclic sparse and symbol JSON without executing reflection or getters", () => {
		let behavior = 0;
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		const sparse: unknown[] = [];
		sparse.length = 2;
		const proxy = new Proxy(
			{},
			{
				getPrototypeOf() {
					behavior++;
					return Object.prototype;
				},
				ownKeys() {
					behavior++;
					return [];
				},
			},
		);
		for (const value of [
			proxy,
			{ nested: proxy },
			Object.defineProperty({}, "value", {
				enumerable: true,
				get() {
					behavior++;
					return "text";
				},
			}),
			cycle,
			sparse,
			{ [Symbol("extra")]: true },
		])
			expect(() => dataCopy(value)).toThrow();
		expect(behavior).toBe(0);
		expect(dataCopy({ nested: [null, true, "text", 1] })).toEqual({
			nested: [null, true, "text", 1],
		});
	});
	it("enforces fixed bootstrap JSON bounds and refuses accessor serving options before creating a transport", () => {
		const entry = defineToolPlugin({
			manifest: toolManifest,
			probe: () => ({ status: "ok", bytes: 0, items: 0 }),
			lookup: { "kb.lookup": () => ({ entries: [] }) },
		});
		const host = memoryHost(() => null);
		try {
			expect(() =>
				createPluginServer(entry, host, {
					instance: { id: "ok", config: { text: "x".repeat(32_768) } },
				}),
			).not.toThrow();
			expect(() =>
				createPluginServer(entry, host, {
					instance: { id: "ok", config: { text: "x".repeat(65_537) } },
				}),
			).toThrow();
			let depth: unknown = null;
			for (let index = 0; index < 40; index++) depth = { nested: depth };
			expect(() =>
				createPluginServer(entry, host, { instance: { id: "ok", config: { depth } } }),
			).toThrow();
			let accessed = 0;
			const options = Object.defineProperty({}, "instance", {
				enumerable: true,
				get() {
					accessed++;
					return bootstrap.instance;
				},
			});
			expect(() => serve(entry, options)).toThrow();
			expect(accessed).toBe(0);
		} finally {
			host.close();
		}
	});
});
