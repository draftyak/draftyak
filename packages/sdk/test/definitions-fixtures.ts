import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type MemoryHost, memoryHost } from "../src/host.ts";
import { createPluginServer, type PluginEntry, type PluginServerOptions } from "../src/serve.ts";

const base = {
	version: "1.0.0",
	sdk: "1.0.0",
	isolation: "standard" as const,
	auth: { kind: "none" as const, scopes: [] as string[], requiredGrantedScopes: [] as string[] },
	credentials: {
		mode: "brokered" as const,
		urlSecrets: [] as { name: string; label: string; help: string }[],
	},
	permissions: {},
	license: "Apache-2.0",
};
export const channelManifest: PluginManifestV1 = {
	...base,
	id: "@example/channel",
	kind: "channel",
	contract: { extension: "io.github.draftyak/channel", version: 1 },
	dataClasses: ["community.content"],
	egress: {
		rules: [
			{
				class: "read",
				method: "GET",
				host: "chat.example.com",
				pathTemplate: "/read",
				maxBytes: 4096,
				timeoutMs: 1000,
			},
		],
	},
};
export const aiManifest: PluginManifestV1 = {
	...base,
	id: "@example/provider",
	kind: "ai-provider",
	contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
	dataClasses: ["community.content"],
	egress: { profile: "messages-api-v1" },
};
export const toolManifest: Omit<Extract<PluginManifestV1, { kind: "tool" }>, "tool"> & {
	readonly tool: {
		readonly kinds: [
			{
				readonly kind: "kb.lookup";
				inputs: string[];
				output: { dataClass: string; maxBytes: number };
			},
		];
	};
} = {
	...base,
	id: "@example/tool",
	kind: "tool",
	contract: { extension: "io.github.draftyak/tool", version: 1 },
	dataClasses: ["tool.kb.lookup"],
	egress: { rules: [] },
	tool: {
		kinds: [
			{
				kind: "kb.lookup",
				inputs: ["topic"],
				output: { dataClass: "tool.kb.lookup", maxBytes: 4096 },
			},
		],
	},
};
export const bootstrap: PluginServerOptions = {
	instance: { id: "instance-owner", config: { topics: ["work"], nested: { label: "Owner" } } },
};
export interface Reply {
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}
export type Ask = (method: string, params?: Record<string, unknown>) => Promise<Reply>;
const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
export async function served(
	entry: PluginEntry,
	check: (ask: Ask) => Promise<void>,
	options: PluginServerOptions = {},
	host: MemoryHost = memoryHost(() => {
		throw new Error("Unexpected host call");
	}),
): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	let id = 0;
	const transport: Transport = {
		async start() {
			ready.resolve();
		},
		async send(message) {
			if ("id" in message && typeof message.id === "number" && !("method" in message)) {
				pending.get(message.id)?.resolve(message as Reply);
				pending.delete(message.id);
			}
		},
		async close() {
			for (const item of pending.values()) item.reject(new Error("Closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = serveStdio(createPluginServer(entry, host, options), {
		legacy: "reject",
		transport,
	});
	try {
		await ready.promise;
		await check(async (method, params = {}) => {
			const current = ++id;
			const reply = Promise.withResolvers<Reply>();
			pending.set(current, reply);
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id: current,
					method,
					params: { ...params, _meta: { ...metadata, ...(params._meta as object) } },
				}),
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					reply.promise,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("Reply timeout")), 2000);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		});
	} finally {
		await handle.close();
		host.close();
	}
}
