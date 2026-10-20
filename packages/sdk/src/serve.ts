import { jsonCopy } from "@draftyak/protocol/host-channel";
import {
	type CallToolResult,
	McpServer,
	type McpServerFactory,
	type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as z from "zod";
import { createPluginContext, type PluginContext } from "./context.ts";
import { pluginErrorResult } from "./errors.ts";
import type { HostChannel } from "./host.ts";
import { type StdioHost, stdioHost } from "./stdio.ts";

z.config({ jitless: true });
export type PluginCallMetadata = Readonly<Record<string, unknown>>;
export interface PluginTool {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: z.ZodType;
	readonly outputSchema?: z.ZodType;
	readonly timeoutMs?: number;
	readonly handler: (
		args: unknown,
		context: PluginContext,
		metadata: PluginCallMetadata,
	) => unknown | Promise<unknown>;
}
export interface PluginEntry {
	readonly name: string;
	readonly version: string;
	readonly plugin: string;
	readonly account?: string;
	readonly extensions: Readonly<Record<string, unknown>>;
	readonly tools: readonly PluginTool[];
}
const EXTENSIONS = [
	"io.github.draftyak/channel",
	"io.github.draftyak/ai-provider",
	"io.github.draftyak/tool",
];

/** The factory is fresh for each HTTP request; stdio pins its instance for a connection. */
export function createPluginServer(entry: PluginEntry, host: HostChannel): McpServerFactory {
	const extensions = jsonCopy(entry.extensions);
	const keys = Object.keys(extensions);
	if (keys.length !== 1 || !EXTENSIONS.includes(keys[0] ?? ""))
		throw new Error("Unsupported plugin extension");
	for (const value of Object.values(extensions))
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid plugin extension");
	const tools = entry.tools.map((tool) => {
		const timeoutMs = tool.timeoutMs ?? 30_000;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000)
			throw new Error("Invalid plugin timeout");
		return { ...tool, timeoutMs };
	});
	const identity = { plugin: entry.plugin, ...(entry.account ? { account: entry.account } : {}) };
	return () => {
		const server = new McpServer(
			{ name: entry.name, version: entry.version },
			{
				capabilities: {
					tools: { listChanged: false },
					extensions: extensions as ServerCapabilities["extensions"],
				},
				jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
			},
		);
		for (const tool of tools)
			server.registerTool(
				tool.name,
				{
					...(tool.description ? { description: tool.description } : {}),
					inputSchema: tool.inputSchema ?? z.strictObject({}),
					...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
				},
				async (args, context): Promise<CallToolResult> => {
					const controller = new AbortController();
					const signal = AbortSignal.any([context.mcpReq.signal, controller.signal]);
					const timer = setTimeout(() => controller.abort(), tool.timeoutMs);
					try {
						if (signal.aborted) throw new Error("Plugin call cancelled");
						const value = await Promise.race([
							Promise.resolve().then(() => {
								const metadata = Object.freeze(jsonCopy(context.mcpReq._meta ?? {}));
								return tool.handler(args, createPluginContext(identity, host, signal), metadata);
							}),
							new Promise<never>((_, reject) =>
								signal.addEventListener("abort", () => reject(new Error("Plugin call cancelled")), {
									once: true,
								}),
							),
						]);
						const result = jsonCopy(value);
						if (!result || typeof result !== "object" || Array.isArray(result))
							throw new Error("Invalid plugin result");
						return {
							structuredContent: result as Record<string, unknown>,
							content: [{ type: "text", text: JSON.stringify(result) }],
						};
					} catch (error) {
						return pluginErrorResult(
							error,
							keys[0] === "io.github.draftyak/tool" ? "tool" : "structured",
						);
					} finally {
						clearTimeout(timer);
						controller.abort();
					}
				},
			);
		return server;
	};
}
export function serve(
	entry: PluginEntry,
	options: { readonly host?: StdioHost; readonly onerror?: (error: Error) => void } = {},
): StdioServerHandle {
	const host = options.host ?? stdioHost({ onerror: options.onerror });
	return serveStdio(createPluginServer(entry, host), {
		legacy: "reject",
		transport: host.transport,
		onerror: options.onerror,
	});
}
