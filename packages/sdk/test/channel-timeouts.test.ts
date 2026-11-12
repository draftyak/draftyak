import { channelV1 } from "@draftyak/protocol/channel-v1";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it, vi } from "vitest";
import { type ChannelPluginDefinition, defineChannelPlugin } from "../src/channel.ts";
import type { PluginContext } from "../src/context.ts";
import { memoryHost } from "../src/host.ts";
import { createPluginServer, type PluginEntry } from "../src/serve.ts";
import { channelManifest } from "./definitions-fixtures.ts";

const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const output = { changes: [], cursor: "next", more: false };
type Reply = { result?: Record<string, unknown>; error?: unknown };
function definition(sync: ChannelPluginDefinition["sync"]): ChannelPluginDefinition {
	return {
		manifest: channelManifest,
		describe: () => ({ channel: "chat", mutations: [], attachments: false, listen: false }),
		probe: () => ({ status: "ok" }),
		sync,
		fetchBody: () => {
			throw new Error("unused");
		},
		send: () => ({}),
		reconcileSend: () => ({ candidates: [], complete: true }),
	};
}
function delayed(context: PluginContext, delay: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, delay);
		context.signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Cancelled"));
			},
			{ once: true },
		);
	});
}
async function connection(entry: PluginEntry) {
	const ready = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	const host = memoryHost(() => {
		throw new Error("Unexpected host request");
	});
	const transport: Transport = {
		async start() {
			ready.resolve();
		},
		async send(message) {
			if ("id" in message && typeof message.id === "number" && !("method" in message)) {
				pending.get(message.id)?.resolve(message);
				pending.delete(message.id);
			}
		},
		async close() {
			for (const reply of pending.values()) reply.reject(new Error("Closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = serveStdio(createPluginServer(entry, host), { legacy: "reject", transport });
	await ready.promise;
	let nextId = 0;
	return {
		begin(name = "channel_sync") {
			const id = ++nextId,
				reply = Promise.withResolvers<Reply>();
			void reply.promise.catch(() => {});
			pending.set(id, reply);
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: {
						name,
						arguments: name === "channel_sync" ? { mode: "delta", cursor: "prior" } : {},
						_meta: meta,
					},
				}),
			);
			return { id, response: reply.promise };
		},
		cancel(requestId: number) {
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId, _meta: meta },
				}),
			);
		},
		async close() {
			await handle.close();
			host.close();
		},
	};
}

describe("channel call deadlines", () => {
	it.each([1000, 45000])(
		"allows a valid %i-millisecond sync through the frozen definition",
		async (delay) => {
			vi.useFakeTimers();
			const entry = defineChannelPlugin(
				definition(async (_args, context) => {
					await delayed(context, delay);
					return output;
				}),
			);
			const peer = await connection(entry);
			try {
				expect(Object.isFrozen(entry.tools.find((tool) => tool.name === "channel_sync"))).toBe(
					true,
				);
				const call = peer.begin();
				await vi.advanceTimersByTimeAsync(delay);
				expect((await call.response).result?.structuredContent).toEqual(output);
			} finally {
				await peer.close();
				vi.useRealTimers();
			}
		},
	);
	it("cancels unfinished sync at exactly 120 seconds, after admitting the preceding instant", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const peer = await connection(
			defineChannelPlugin(
				definition(async (_args, context) => {
					signal = context.signal;
					await delayed(context, 200000);
					return output;
				}),
			),
		);
		try {
			const call = peer.begin();
			let settled = false;
			void call.response.then(() => {
				settled = true;
			});
			await vi.advanceTimersByTimeAsync(119999);
			expect(signal?.aborted).toBe(false);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(signal?.aborted).toBe(true);
			expect((await call.response).result).toMatchObject({
				isError: true,
				structuredContent: { code: "TRANSIENT" },
			});
		} finally {
			await peer.close();
			vi.useRealTimers();
		}
	});
	it("propagates caller cancellation before the sync deadline", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const peer = await connection(
			defineChannelPlugin(
				definition(async (_args, context) => {
					signal = context.signal;
					await delayed(context, 200000);
					return output;
				}),
			),
		);
		try {
			const call = peer.begin();
			await vi.advanceTimersByTimeAsync(10000);
			expect(signal?.aborted).toBe(false);
			peer.cancel(call.id);
			await vi.advanceTimersByTimeAsync(0);
			expect(signal?.aborted).toBe(true);
		} finally {
			await peer.close();
			vi.useRealTimers();
		}
	});
	it.each(["helper probe", "generic sync"])(
		"keeps the unconfigured %s deadline at 30 seconds",
		async (mode) => {
			vi.useFakeTimers();
			let signal: AbortSignal | undefined;
			const sync: ChannelPluginDefinition["sync"] = async (_args, context) => {
				signal = context.signal;
				await delayed(context, 45000);
				return output;
			};
			const defined = defineChannelPlugin({
				...definition(sync),
				probe: async (_args, context) => {
					signal = context.signal;
					await delayed(context, 45000);
					return { status: "ok" };
				},
			});
			const entry: PluginEntry =
				mode === "generic sync"
					? {
							...defined,
							tools: [
								{
									name: "channel_sync",
									inputSchema: channelV1.tools.channel_sync.input,
									outputSchema: channelV1.tools.channel_sync.output,
									handler: (args, context) => sync(args as Parameters<typeof sync>[0], context),
								},
							],
						}
					: defined;
			const peer = await connection(entry);
			try {
				const call = peer.begin(mode === "generic sync" ? "channel_sync" : "channel_probe");
				await vi.advanceTimersByTimeAsync(29999);
				expect(signal?.aborted).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				expect(signal?.aborted).toBe(true);
				expect((await call.response).result).toMatchObject({
					isError: true,
					structuredContent: { code: "TRANSIENT" },
				});
			} finally {
				await peer.close();
				vi.useRealTimers();
			}
		},
	);
});
