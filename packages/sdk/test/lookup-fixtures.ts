import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import type { HostChannel } from "../src/host.ts";
import { createPluginServer, type PluginEntry, type PluginTool } from "../src/serve.ts";
import { bootstrap } from "./definitions-fixtures.ts";

export const permitA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const permitB = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
export const meta = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
export const turn = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
export interface Reply {
	result?: Record<string, unknown>;
	error?: unknown;
}
export function entry(
	handler: PluginTool["handler"],
	names: readonly string[] = ["kb.lookup"],
	extension = "io.github.draftyak/tool",
): PluginEntry {
	return {
		name: "lookup-fixture",
		version: "1.0.0",
		plugin: "lookup-fixture",
		extensions: { [extension]: {} },
		tools: names.map((name) => ({
			name,
			description: "Synthetic lookup fixture",
			inputSchema: z.object({ label: z.string().optional() }),
			handler,
		})),
	};
}
interface Connection {
	begin(
		name?: string,
		metadata?: Record<string, unknown>,
		label?: string,
	): { id: number; response: Promise<Reply> };
	cancel(requestId: number): void;
	close(): Promise<void>;
}
export async function connection(plugin: PluginEntry, host: HostChannel): Promise<Connection> {
	const ready = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	let nextId = 0;
	const transport: Transport = {
		async start() {
			ready.resolve();
		},
		async send(message) {
			if (!("method" in message) && typeof message.id === "number") {
				pending.get(message.id)?.resolve(message);
				pending.delete(message.id);
			}
		},
		async close() {
			for (const item of pending.values()) item.reject(new Error("Closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = serveStdio(createPluginServer(plugin, host, bootstrap), {
		legacy: "reject",
		transport,
	});
	await ready.promise;
	return {
		begin(name = "kb.lookup", metadata: Record<string, unknown> = {}, label = name) {
			const id = ++nextId;
			const reply = Promise.withResolvers<Reply>();
			void reply.promise.catch(() => {});
			pending.set(id, reply);
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id,
					method: "tools/call",
					params: { name, arguments: { label }, _meta: { ...meta, ...metadata } },
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
