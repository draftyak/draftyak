import { HOST_MAX_FRAME_BYTES, jsonCopy } from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { isCanonicalToolsList, type ToolEntry, type ToolKind } from "@draftyak/protocol/tool-v1";
import {
	type CallToolResult,
	isJSONRPCErrorResponse,
	isJSONRPCResultResponse,
	isSpecType,
	type ListToolsResult,
	McpServer,
	type McpServerFactory,
	ProtocolErrorCode,
	SERVER_INFO_META_KEY,
	type ServerCapabilities,
	type Transport,
} from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as z from "zod";
import { createPluginContext, type PluginContext, type PluginInstance } from "./context.ts";
import { dataCopy, fields, freezeJson } from "./definitions.ts";
import { PluginError, pluginErrorResult } from "./errors.ts";
import type { HostChannel } from "./host.ts";
import { type StdioHost, stdioHost } from "./stdio.ts";

z.config({ jitless: true });
export type PluginCallMetadata = Readonly<Record<string, unknown>>;
export interface PluginRequestContext {
	/** Reports on this MCP request only, using its caller-supplied progress token. */
	progress(value: number, total?: number): Promise<void>;
}
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
		request?: PluginRequestContext,
	) => unknown | Promise<unknown>;
}
export interface PluginEntry {
	readonly name: string;
	readonly version: string;
	readonly plugin: string;
	readonly account?: string;
	readonly extensions: Readonly<Record<string, unknown>>;
	readonly tools: readonly PluginTool[];
	readonly canonicalTools?: readonly ToolEntry[];
}
export interface PluginServerOptions {
	/** Trusted local runtime input, independent of MCP call metadata; never network authority. */
	readonly instance?: PluginInstance;
}
const EXTENSIONS = [
	"io.github.draftyak/channel",
	"io.github.draftyak/ai-provider",
	"io.github.draftyak/tool",
];
// The hub reads only structuredContent; a JSON copy in content would double the reply frame.
const RESULT_TEXT = "Result in structuredContent.";

/** The factory is fresh for each HTTP request; stdio pins its instance for a connection. */
export function createPluginServer(
	entry: PluginEntry,
	host: HostChannel,
	options: PluginServerOptions = {},
): McpServerFactory {
	const optionSlots = fields(options);
	if (Object.keys(optionSlots).some((key) => key !== "instance"))
		throw new TypeError("Serving options refused");
	let instance: PluginInstance | undefined;
	if (Object.hasOwn(optionSlots, "instance")) {
		const copy = dataCopy(optionSlots.instance?.value, 65_536);
		const slots = fields(copy);
		if (
			Object.keys(slots).sort().join() !== "config,id" ||
			typeof slots.id?.value !== "string" ||
			!/^[!-~]{1,256}$/.test(slots.id.value)
		)
			throw new TypeError("Instance refused");
		fields(slots.config?.value, 4096);
		instance = freezeJson(copy) as PluginInstance;
	}
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
	let canonical: ToolEntry[] | undefined;
	if (entry.canonicalTools !== undefined) {
		const list = dataCopy(entry.canonicalTools);
		const kinds = tools
			.map((tool) => tool.name)
			.filter((name) => name !== "tool_describe" && name !== "tool_probe") as ToolKind[];
		if (
			keys[0] !== "io.github.draftyak/tool" ||
			!isCanonicalToolsList(list, kinds) ||
			tools.length !== new Set(tools.map((tool) => tool.name)).size ||
			tools.length !== (list as ToolEntry[]).length
		)
			throw new TypeError("Canonical tools refused");
		canonical = list as ToolEntry[];
	}
	const identity = {
		plugin: entry.plugin,
		...(entry.account ? { account: entry.account } : {}),
		...(instance ? { instance } : {}),
	};
	const info = { name: entry.name, version: entry.version };
	return () => {
		const server = new McpServer(info, {
			capabilities: {
				tools: { listChanged: false },
				extensions: extensions as ServerCapabilities["extensions"],
			},
			jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
		});
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
					let active = true;
					const signal = AbortSignal.any([context.mcpReq.signal, controller.signal]);
					const timer = setTimeout(() => controller.abort(), tool.timeoutMs);
					try {
						if (signal.aborted) throw new Error("Plugin call cancelled");
						const value = await Promise.race([
							Promise.resolve().then(() => {
								const metadata = Object.freeze(jsonCopy(context.mcpReq._meta ?? {}));
								let request: PluginRequestContext | undefined;
								if (
									keys[0] === "io.github.draftyak/ai-provider" &&
									tool.name === "ai_draft_generate"
								) {
									const token = metadata.progressToken;
									if (token !== undefined && !isSpecType.ProgressToken(token))
										throw new PluginError("INVALID_INPUT");
									request = Object.freeze({
										async progress(progress: number, total?: number): Promise<void> {
											if (!active || signal.aborted) throw new Error("Plugin call ended");
											if (token === undefined) return;
											const notification = {
												method: "notifications/progress" as const,
												params: {
													progressToken: token,
													progress,
													...(total === undefined ? {} : { total }),
												},
											};
											if (!isSpecType.ProgressNotification(notification))
												throw new PluginError("INVALID_INPUT");
											await context.mcpReq.notify(notification);
										},
									});
								}
								return tool.handler(
									args,
									createPluginContext(identity, host, signal),
									metadata,
									request,
								);
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
						const reply: CallToolResult = {
							structuredContent: result as Record<string, unknown>,
							content: [{ type: "text", text: RESULT_TEXT }],
						};
						// The whole line the 2026-07-28 encoder writes for this reply must fit one frame.
						const line = canonicalize({
							jsonrpc: "2.0",
							id: context.mcpReq.id,
							result: { ...reply, resultType: "complete", _meta: { [SERVER_INFO_META_KEY]: info } },
						});
						if (Buffer.byteLength(line) > HOST_MAX_FRAME_BYTES) throw new PluginError("TRANSIENT");
						return reply;
					} catch (error) {
						return pluginErrorResult(
							error,
							keys[0] === "io.github.draftyak/tool" ? "tool" : "structured",
						);
					} finally {
						active = false;
						clearTimeout(timer);
						controller.abort();
					}
				},
			);
		if (canonical)
			server.server.setRequestHandler("tools/list", async () => ({
				tools: jsonCopy(canonical) as unknown as ListToolsResult["tools"],
				resultType: "complete",
			}));
		return server;
	};
}
export function serve(
	entry: PluginEntry,
	options: PluginServerOptions & {
		readonly host?: StdioHost;
		readonly onerror?: (error: Error) => void;
	} = {},
): StdioServerHandle {
	const slots = fields(options);
	if (Object.keys(slots).some((key) => !["host", "onerror", "instance"].includes(key)))
		throw new TypeError("Serving options refused");
	const onerror = slots.onerror?.value as ((error: Error) => void) | undefined;
	const host = slots.host?.value as StdioHost | undefined;
	const bootstrap = Object.hasOwn(slots, "instance")
		? { instance: slots.instance?.value as PluginInstance }
		: {};
	const channel = host ?? stdioHost({ onerror });
	try {
		return serveStdio(createPluginServer(entry, channel, bootstrap), {
			legacy: "reject",
			transport: answered(channel.transport, onerror),
			onerror,
		});
	} catch (error) {
		if (!host) channel.close();
		throw error;
	}
}
/** A refused reply is reported and answered once with a small error, so no request waits out its timeout. */
function answered(wire: Transport, onerror?: (error: Error) => void): Transport {
	const transport: Transport = {
		start: () => wire.start(),
		close: () => wire.close(),
		async send(message, options) {
			try {
				await wire.send(message, options);
			} catch (error) {
				if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) throw error;
				try {
					onerror?.(error instanceof Error ? error : new Error(String(error)));
				} catch {
					/* Reporting cannot leave the request unanswered. */
				}
				await wire.send(
					{
						jsonrpc: "2.0",
						id: message.id,
						error: { code: ProtocolErrorCode.InternalError, message: "Internal error" },
					},
					options,
				);
			}
		},
	};
	wire.onmessage = (message, extra) => transport.onmessage?.(message, extra);
	wire.onerror = (error) => transport.onerror?.(error);
	wire.onclose = () => transport.onclose?.();
	return transport;
}
