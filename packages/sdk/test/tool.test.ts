import { canonicalize } from "@draftyak/protocol/jcs";
import {
	canonicalToolsList,
	checkToolResult,
	isCanonicalToolsListResult,
	TOOL_ERROR_META_KEY,
	type ToolResultsV1,
} from "@draftyak/protocol/tool-v1";
import { describe, expect, it } from "vitest";
import { PluginError } from "../src/errors.ts";
import { memoryHost } from "../src/host.ts";
import { createPluginServer, type PluginServerOptions } from "../src/serve.ts";
import {
	defineToolPlugin,
	type ToolContext,
	type ToolFetchInit,
	type ToolPluginDefinition,
} from "../src/tool.ts";
import { bootstrap, channelManifest, served, toolManifest } from "./definitions-fixtures.ts";

type Definition = ToolPluginDefinition<typeof toolManifest>;
function first<T>(list: readonly T[]): T {
	const item = list[0];
	if (!item) throw new Error("Empty fixture");
	return item;
}
function definition(
	lookup: Definition["lookup"]["kb.lookup"] = () => ({ entries: [] }),
): Definition {
	return {
		manifest: toolManifest,
		probe: () => ({ status: "ok", bytes: 0, items: 0 }),
		lookup: { "kb.lookup": lookup },
	};
}
describe("tool definitions", () => {
	it("serves all three declared lookup kinds with their distinct typed arguments and schemas", async () => {
		const manifest = {
			...toolManifest,
			dataClasses: ["tool.calendar.freebusy", "tool.contact.notes", "tool.kb.lookup"],
			tool: {
				kinds: [
					{
						kind: "calendar.freebusy" as const,
						inputs: ["window", "tz"],
						output: { dataClass: "tool.calendar.freebusy", maxBytes: 20480 },
					},
					{
						kind: "contact.notes" as const,
						inputs: ["participant"],
						output: { dataClass: "tool.contact.notes", maxBytes: 4096 },
					},
					toolManifest.tool.kinds[0],
				],
			},
		};
		const entry = defineToolPlugin({
			manifest,
			probe: () => ({ status: "ok", bytes: 0, items: 0 }),
			lookup: {
				"calendar.freebusy": (args) => {
					const tz: string = args.tz;
					const start: number = args.window.start;
					return { busy: tz && start >= 0 ? [] : [] };
				},
				"contact.notes": (args) => ({ notes: [{ label: "Contact", text: args.participant }] }),
				"kb.lookup": (args) => ({ entries: [{ label: "Topic", text: args.topic }] }),
			},
		});
		await served(
			entry,
			async (ask) => {
				expect(
					isCanonicalToolsListResult((await ask("tools/list")).result, [
						"calendar.freebusy",
						"contact.notes",
						"kb.lookup",
					]),
				).toBe(true);
				const calendar = (
					await ask("tools/call", {
						name: "calendar.freebusy",
						arguments: { window: { start: 0, end: 1000 }, tz: "UTC" },
					})
				).result;
				expect(checkToolResult("calendar.freebusy", calendar)).toMatchObject({
					status: "ok",
					value: { busy: [] },
				});
				expect(
					checkToolResult(
						"contact.notes",
						(await ask("tools/call", { name: "contact.notes", arguments: { participant: "UAB" } }))
							.result,
					).status,
				).toBe("ok");
				expect(
					checkToolResult(
						"kb.lookup",
						(await ask("tools/call", { name: "kb.lookup", arguments: { topic: "work" } })).result,
					).status,
				).toBe("ok");
			},
			bootstrap,
		);
	});
	it("serves literal canonical entries as JCS and complete raw pinned MCP responses repeatedly", async () => {
		await served(
			defineToolPlugin(definition()),
			async (ask) => {
				const capabilities = (await ask("server/discover")).result?.capabilities as Record<
					string,
					unknown
				>;
				expect(Object.keys(capabilities).sort()).toEqual(["extensions", "tools"]);
				for (let index = 0; index < 2; index++) {
					const result = (await ask("tools/list")).result;
					expect(isCanonicalToolsListResult(result, ["kb.lookup"])).toBe(true);
					expect(canonicalize(result?.tools)).toBe(canonicalize(canonicalToolsList(["kb.lookup"])));
					expect(result).not.toHaveProperty("nextCursor");
				}
				expect(
					checkToolResult(
						"tool_describe",
						(await ask("tools/call", { name: "tool_describe" })).result,
					),
				).toMatchObject({ status: "ok", value: { kinds: ["kb.lookup"] } });
			},
			bootstrap,
		);
	});
	it("refuses canonical-list injection including title schema extra or missing registered tools and non-tool extension", () => {
		const host = memoryHost(() => ({}));
		try {
			const original = defineToolPlugin(definition());
			for (const alter of [
				(list: ReturnType<typeof canonicalToolsList>) => {
					list[0] = { ...first(list), title: "Forged" };
				},
				(list: ReturnType<typeof canonicalToolsList>) => {
					list[0] = { ...first(list), description: "Forged" };
				},
				(list: ReturnType<typeof canonicalToolsList>) => {
					list[0] = { ...first(list), inputSchema: { type: "object" } };
				},
				(list: ReturnType<typeof canonicalToolsList>) => {
					list.pop();
				},
			]) {
				const list = canonicalToolsList(["kb.lookup"]);
				alter(list);
				expect(() => createPluginServer({ ...original, canonicalTools: list }, host)).toThrow();
			}
			for (const tools of [original.tools.slice(1), [...original.tools, first(original.tools)]])
				expect(() => createPluginServer({ ...original, tools }, host)).toThrow();
			expect(() =>
				createPluginServer(
					{ ...original, extensions: { [channelManifest.contract.extension]: {} } },
					host,
				),
			).toThrow();
		} finally {
			host.close();
		}
	});
	it("captures exactly manifest-declared typed lookup handlers and rejects unknown accessor proxy or missing definitions", () => {
		let invoked = 0;
		for (const patch of [
			{ probe: undefined },
			{ lookup: {} },
			{ lookup: { "contact.notes": () => ({ notes: [] }) } },
			{ lookup: { "kb.lookup": () => ({ entries: [] }), extra: () => ({}) } },
			{ resources: [] },
		])
			expect(() => defineToolPlugin({ ...definition(), ...patch } as Definition)).toThrow();
		expect(() =>
			defineToolPlugin({
				...definition(),
				lookup: Object.defineProperty({}, "kb.lookup", {
					enumerable: true,
					get() {
						invoked++;
						return () => ({ entries: [] });
					},
				}),
			} as Definition),
		).toThrow();
		expect(() =>
			defineToolPlugin({
				...definition(),
				lookup: new Proxy(
					{},
					{
						ownKeys() {
							invoked++;
							return [];
						},
					},
				),
			} as Definition),
		).toThrow();
		expect(() =>
			defineToolPlugin({ ...definition(), manifest: channelManifest } as unknown as Definition),
		).toThrow();
		expect(invoked).toBe(0);
	});
	it("gets a frozen detached trusted instance and no forbidden context even with forged metadata", async () => {
		let seen: ToolContext | undefined;
		const instance = {
			id: "actual-instance",
			config: { topic: "Owner", nested: { enabled: true } },
		};
		const entry = defineToolPlugin(
			definition((_args, context) => {
				seen = context;
				return { entries: [] };
			}),
		);
		await served(
			entry,
			async (ask) => {
				instance.id = "changed-after-bootstrap";
				instance.config.topic = "changed";
				const reply = await ask("tools/call", {
					name: "kb.lookup",
					arguments: { topic: "work" },
					_meta: {
						instance: { id: "forged", config: { topic: "forged" } },
						config: { topic: "forged" },
					},
				});
				expect(checkToolResult("kb.lookup", reply.result).status).toBe("ok");
				expect(seen?.instance).toEqual({
					id: "actual-instance",
					config: { topic: "Owner", nested: { enabled: true } },
				});
				expect(Object.keys(seen ?? {}).sort()).toEqual([
					"fetch",
					"instance",
					"kv",
					"log",
					"plugin",
					"signal",
				]);
				expect(Object.isFrozen(seen?.instance)).toBe(true);
				expect(Object.isFrozen(seen?.instance.config.nested)).toBe(true);
			},
			{ instance },
		);
	});
	it("refuses missing bootstrap independently of metadata and validates hostile local instance inputs without behavior", async () => {
		let invoked = 0;
		await served(
			defineToolPlugin(
				definition(() => {
					invoked++;
					return { entries: [] };
				}),
			),
			async (ask) => {
				const result = (
					await ask("tools/call", {
						name: "kb.lookup",
						arguments: { topic: "work" },
						_meta: { instance: bootstrap.instance },
					})
				).result;
				expect(checkToolResult("kb.lookup", result)).toEqual({
					status: "error",
					error: { code: "INVALID_INPUT" },
				});
			},
		);
		expect(invoked).toBe(0);
		const host = memoryHost(() => ({}));
		try {
			for (const instance of [
				{ id: "", config: {} },
				{ id: "ok", config: [] },
				{ id: "ok", config: {}, extra: true },
				{ id: "ok", config: { text: "x".repeat(65_537) } },
				new Proxy(
					{},
					{
						ownKeys() {
							invoked++;
							return [];
						},
					},
				),
				Object.defineProperty({}, "id", {
					enumerable: true,
					get() {
						invoked++;
						return "bad";
					},
				}),
			])
				expect(() =>
					createPluginServer(defineToolPlugin(definition()), host, {
						instance,
					} as PluginServerOptions),
				).toThrow();
		} finally {
			host.close();
		}
		expect(invoked).toBe(0);
	});
	it("allows only GET HEAD without write or saveAs options and preserves opaque secret spelling", async () => {
		const requests: unknown[] = [];
		const host = memoryHost((method, params) => {
			expect(method).toBe("host/fetch");
			requests.push(params);
			return { status: 200, headers: [], body: { base64: "" } };
		});
		await served(
			defineToolPlugin(
				definition(async (_args, context) => {
					for (const init of [
						{ method: "POST" },
						{ method: "PUT" },
						{ saveAs: "blob" },
						{ saveAs: undefined },
						{ body: "x" },
						{ sendTicket: {} },
						{ ws: true },
					])
						await expect(
							context.fetch("https://example.test/read", init as ToolFetchInit),
						).rejects.toThrow();
					await expect(
						context.fetch(new Request("https://example.test/read", { method: "POST" })),
					).rejects.toThrow();
					for (const suffix of ["/extra", "?query", "#fragment", "\n", "%40"])
						await expect(context.fetch(`secret://calendarUrl${suffix}`)).rejects.toThrow();
					await context.fetch("secret://calendarUrl");
					await context.fetch("https://example.test/read", { method: "HEAD" });
					return { entries: [] };
				}),
			),
			async (ask) => {
				expect(
					checkToolResult(
						"kb.lookup",
						(await ask("tools/call", { name: "kb.lookup", arguments: { topic: "work" } })).result,
					).status,
				).toBe("ok");
			},
			bootstrap,
			host,
		);
		expect(requests).toEqual([
			{ method: "GET", url: "secret://calendarUrl", headers: [] },
			{ method: "HEAD", url: "https://example.test/read", headers: [] },
		]);
	});
	it("checks semantic results and the declared byte cap and sanitizes typed and unknown errors", async () => {
		for (const lookup of [
			() => ({ entries: [{ label: "long", text: "x".repeat(2001) }] }),
			() => {
				throw new Error("untrusted-private-detail");
			},
			() => {
				throw new PluginError("RATE_LIMITED", { retryAfterMs: 250 });
			},
		]) {
			await served(
				defineToolPlugin(definition(lookup)),
				async (ask) => {
					const result = (
						await ask("tools/call", { name: "kb.lookup", arguments: { topic: "work" } })
					).result;
					expect(result).toMatchObject({
						isError: true,
						_meta: {
							[TOOL_ERROR_META_KEY]: { code: expect.stringMatching(/^(TRANSIENT|RATE_LIMITED)$/) },
						},
					});
					expect(result).not.toHaveProperty("structuredContent");
					expect(JSON.stringify(result)).not.toContain("untrusted-private-detail");
				},
				bootstrap,
			);
		}
		const manifest = {
			...toolManifest,
			tool: {
				kinds: [
					{
						...toolManifest.tool.kinds[0],
						output: { ...toolManifest.tool.kinds[0].output, maxBytes: 32 },
					},
				],
			},
		};
		await served(
			defineToolPlugin({
				...definition(),
				manifest,
				lookup: {
					"kb.lookup": () => ({ entries: [{ label: "x", text: "text beyond byte ceiling" }] }),
				},
			}),
			async (ask) => {
				expect(
					checkToolResult(
						"kb.lookup",
						(await ask("tools/call", { name: "kb.lookup", arguments: { topic: "work" } })).result,
					),
				).toEqual({ status: "error", error: { code: "TRANSIENT" } });
			},
			bootstrap,
		);
	});
	it("narrows public handler and context types", () => {
		const compileOnly = (context: ToolContext): void => {
			// @ts-expect-error A tool has no websocket surface.
			context.ws;
			// @ts-expect-error A tool has no account or progress surface.
			context.account;
			// @ts-expect-error A tool cannot emit changed notifications.
			context.changed();
			// @ts-expect-error A tool cannot report drafting progress.
			context.progress("x", 1);
			// @ts-expect-error Tool fetch is read-only.
			context.fetch("https://example.test", { method: "POST" });
			// @ts-expect-error Tool fetch cannot save blobs.
			context.fetch("https://example.test", { saveAs: "blob" });
		};
		const typed = definition((args) => {
			const topic: string = args.topic;
			return { entries: [{ label: "Topic", text: topic }] };
		});
		expect(typed.lookup["kb.lookup"]).toBeTypeOf("function");
		expect(compileOnly).toBeTypeOf("function");
		const result: ToolResultsV1["kb.lookup"] = { entries: [] };
		expect(result.entries).toEqual([]);
	});
});
