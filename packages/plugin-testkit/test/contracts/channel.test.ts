import { channelV1 } from "@draftyak/protocol/channel-v1";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { SEND_TICKET_META } from "@draftyak/protocol/send-ticket";
import { HostError, PluginError, type PluginTool } from "@draftyak/sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ChannelContractFixture,
	type ChannelContractOptions,
	channelChecks,
	channelContract,
	checkChannelBody,
	checkChannelEgress,
	checkChannelErrors,
	checkChannelListen,
	checkChannelMutations,
	checkChannelReconcile,
	checkChannelSend,
	checkChannelSurface,
	checkChannelSync,
	checkChannelTools,
	checkChannelUnticketedSend,
} from "../../src/contracts/channel.ts";
import * as factory from "../../src/mock-hub.ts";
import { MockHubError, type MockPlugin } from "../../src/types.ts";
import { contractChannel, contractFixtures } from "../fixtures/channel-contract/plugin.ts";

const options = (plugin: MockPlugin = contractChannel()): ChannelContractOptions => ({
	plugin,
	mode: "in-memory",
	fixtures: contractFixtures,
});
afterEach(() => {
	vi.restoreAllMocks();
});

await channelContract(options());

it("exports the complete directly callable check set", () => {
	expect(Object.keys(channelChecks)).toEqual([
		"surface",
		"tools",
		"describeProbe",
		"sync",
		"body",
		"mutations",
		"send",
		"unticketedSend",
		"reconcile",
		"listen",
		"errors",
		"egress",
	]);
});

it("creates and closes fresh fixtures and hubs for repeated stateful direct checks", async () => {
	let opened = 0;
	let closed = 0;
	const fresh = {
		...options(),
		fixtures: () => {
			opened++;
			return contractFixtures(() => {
				closed++;
			});
		},
	};
	for (let repeat = 0; repeat < 2; repeat++) {
		expect(await checkChannelSync(fresh)).toEqual({ status: "pass" });
		expect(await checkChannelSend(fresh)).toEqual({ status: "pass" });
	}
	expect(opened).toBe(4);
	expect(closed).toBe(4);
});

it.each([
	["host denial", () => new HostError("DENIED")],
	["process refusal", () => new MockHubError("PROCESS_REQUEST_REFUSED")],
] as const)("requires a trusted replay denial for a %s", async (_label, refusal) => {
	const create = factory.createMockHub;
	vi.spyOn(factory, "createMockHub").mockImplementation((input) => {
		const hub = create({ ...input, mode: "in-memory" });
		let sends = 0;
		return {
			...hub,
			async call(name, args, meta) {
				if (name === "channel_send" && ++sends === 2) throw refusal();
				return hub.call(name, args, meta);
			},
		};
	});
	expect(await checkChannelSend({ ...options(), mode: "process" })).toEqual({
		status: "fail",
		code: "CHANNEL_SEND_REPLAY_RESULT",
	});
});

it.each([false, true])(
	"preserves an explicit provider sharing fact of %s through sync and resync",
	async (shared) => {
		expect(
			await checkChannelSync({
				...options(),
				fixtures: () => contractFixtures(undefined, { shared }),
			}),
		).toEqual({ status: "pass" });
	},
);

it("rejects omitted provider sharing metadata instead of assuming false", async () => {
	expect(
		await checkChannelSync({
			...options(),
			fixtures: () => contractFixtures(undefined, { shared: false, omitShared: true }),
		}),
	).toEqual({ status: "fail", code: "CHANNEL_RESULT" });
});

it("delegates the omitted mode to the actual process factory and preserves bounded refusal codes", async () => {
	const create = vi.spyOn(factory, "createMockHub").mockImplementation(() => {
		throw new MockHubError("DYTEST_PROCESS_REFUSAL");
	});
	let closed = false;
	const result = await checkChannelSurface({
		plugin: contractChannel(),
		fixtures: () =>
			contractFixtures(() => {
				closed = true;
			}),
	});
	expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: "process" }));
	expect(result).toEqual({ status: "fail", code: "DYTEST_PROCESS_REFUSAL" });
	expect(closed).toBe(true);
});

it("rejects an extension digest that differs from the canonical channel contract", async () => {
	const plugin = contractChannel({
		extension: {
			[channelV1.id]: { ...extensionDeclaration(channelV1), schemaDigest: "0".repeat(64) },
		},
	});
	expect(await checkChannelSurface(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_SURFACE",
	});
});

it("checks canonical descriptions and schemas rather than only channel tool names", async () => {
	const original = contractChannel();
	const plugin = {
		...original,
		entry: {
			...original.entry,
			tools: original.entry.tools.map((tool) =>
				tool.name === "channel_probe" ? { ...tool, description: "DYTEST changed" } : tool,
			),
		},
	};
	expect(await checkChannelTools(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_TOOL_DESCRIPTION",
	});
});

it("fails a schema-valid sync that silently drops the expected provider changes", async () => {
	const plugin = contractChannel({
		replace: { channel_sync: async () => ({ changes: [], cursor: "DYTEST-cursor", more: false }) },
	});
	expect(await checkChannelSync(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_SYNC_INITIAL",
	});
});

it("requires the CURSOR_EXPIRED error before resync", async () => {
	const original = contractChannel();
	const sync = original.entry.tools.find((tool) => tool.name === "channel_sync") as PluginTool;
	const plugin = contractChannel({
		replace: {
			channel_sync: async (args, context, meta) => {
				try {
					return await sync.handler(args, context, meta);
				} catch (error) {
					if (error instanceof PluginError && error.result.code === "CURSOR_EXPIRED")
						throw new PluginError("TRANSIENT");
					throw error;
				}
			},
		},
	});
	expect(await checkChannelSync(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_ERROR_CODE",
	});
});

it("compares body content with the expected provider message", async () => {
	const expected = contractFixtures().body.expected;
	const plugin = contractChannel({
		replace: {
			channel_body_fetch: async () => ({ message: { ...expected, text: "DYTEST incorrect" } }),
		},
	});
	expect(await checkChannelBody(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_BODY_MISMATCH",
	});
});

it("rejects a successful send that omits the provider id", async () => {
	const plugin = contractChannel({ replace: { channel_send: async () => ({}) } });
	expect(await checkChannelSend(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_SEND_PROVIDER_ID",
	});
});

it("does not accept a ticketed send that changes the hub-rendered bytes", async () => {
	const plugin = contractChannel({
		replace: {
			channel_send: async (input, context, meta) => {
				const args = input as { url: string; method: string; contentType: string };
				await context.fetch(args.url, {
					method: args.method,
					headers: { "content-type": args.contentType },
					body: '{"text":"DYTEST changed"}',
					sendTicket: meta[SEND_TICKET_META],
				});
				return {};
			},
		},
	});
	expect((await checkChannelSend(options(plugin))).status).toBe("fail");
});

it("detects a duplicate dispatch attempt even when the plugin swallows the host refusal", async () => {
	const original = contractChannel();
	const send = original.entry.tools.find((tool) => tool.name === "channel_send") as PluginTool;
	const plugin = contractChannel({
		replace: {
			channel_send: async (args, context, meta) => {
				const value = await send.handler(args, context, meta);
				try {
					await send.handler(args, context, meta);
				} catch {
					/* The check must still observe the refusal. */
				}
				return value;
			},
		},
	});
	expect((await checkChannelSend(options(plugin))).status).toBe("fail");
});

it("rejects a plugin that reports success without a ticket even when no bytes dispatch", async () => {
	const plugin = contractChannel({ replace: { channel_send: async () => ({}) } });
	expect(await checkChannelUnticketedSend(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_ERROR_RESULT",
	});
});

it("requires reconciliation to find the message just sent", async () => {
	const plugin = contractChannel({
		replace: { channel_send_reconcile: async () => ({ candidates: [], complete: true }) },
	});
	expect(await checkChannelReconcile(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_RECONCILE_MISMATCH",
	});
});

it("refuses an undeclared mutation tool", async () => {
	const plugin = contractChannel({ mutate: async () => ({}) });
	expect(await checkChannelMutations(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_MUTATE_DECLARATION",
	});
});

it("checks observed mutation state and refuses operations omitted from describe", async () => {
	let read = false;
	const plugin = contractChannel({
		description: { channel: "chat", mutations: ["read"], attachments: false, listen: false },
		mutate: async (input) => {
			if ((input as { op: string }).op !== "read") throw new PluginError("UNSUPPORTED");
			read = true;
			return {};
		},
	});
	const fixtures = (): ChannelContractFixture => {
		read = false;
		return {
			...contractFixtures(),
			mutations: [
				{
					arguments: { op: "read", messages: [contractFixtures().body.message] },
					observe: () => read,
					expected: true,
				},
			],
		};
	};
	expect(await checkChannelMutations({ ...options(plugin), fixtures })).toEqual({ status: "pass" });
	const wrong = (): ChannelContractFixture => ({
		...fixtures(),
		mutations: [
			{
				...fixtures().mutations?.[0],
				arguments: { op: "read", messages: [contractFixtures().body.message] },
				observe: () => false,
				expected: true,
			},
		],
	});
	expect(await checkChannelMutations({ ...options(plugin), fixtures: wrong })).toEqual({
		status: "fail",
		code: "CHANNEL_MUTATE_STATE",
	});
});

it("checks listen declaration and rejects a lease beyond ten minutes", async () => {
	const plugin = contractChannel({
		description: { channel: "chat", mutations: [], attachments: false, listen: true },
		listen: async () => ({ leaseMs: 600_001 }),
	});
	expect(await checkChannelListen(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_RESULT",
	});
});

it("requires actual extension error envelopes and their expected codes", async () => {
	const plugin = contractChannel({
		replace: { channel_body_fetch: async () => ({ code: "NOT_FOUND" }) },
	});
	expect(await checkChannelErrors(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_ERROR_RESULT",
	});
});

it("detects swallowed off-manifest fetch attempts", async () => {
	const plugin = contractChannel({
		replace: {
			channel_probe: async (_args, context) => {
				try {
					await context.fetch("https://off-manifest.example/DYTEST");
				} catch {
					/* Preserve evidence in the host denial record. */
				}
				return { status: "ok" };
			},
		},
	});
	expect(await checkChannelEgress(options(plugin))).toEqual({
		status: "fail",
		code: "CHANNEL_EGRESS_DENIED",
	});
});

it("closes hub and fixture on a failed property and bounds unexpected diagnostics", async () => {
	const created = vi.spyOn(factory, "createMockHub");
	let closed = false;
	const plugin = contractChannel({
		replace: {
			channel_body_fetch: async () => {
				throw new Error("DYTEST private diagnostic");
			},
		},
	});
	const result = await checkChannelBody({
		...options(plugin),
		fixtures: () =>
			contractFixtures(() => {
				closed = true;
			}),
	});
	expect(result).toEqual({ status: "fail", code: "CHANNEL_RESULT" });
	expect(closed).toBe(true);
	const hub = created.mock.results[0]?.value as ReturnType<typeof factory.createMockHub>;
	await expect(hub.discover()).rejects.toThrow("HOST_CLOSED");
});
