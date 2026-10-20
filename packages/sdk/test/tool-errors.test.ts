import {
	canonicalToolsV1,
	checkToolResult,
	TOOL_ERROR_META_KEY,
	TOOL_EXTENSION_ID,
	toolExtensionDeclaration,
} from "@draftyak/protocol/tool-v1";
import { parseJSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { PluginError } from "../src/errors.ts";
import { memoryHost } from "../src/host.ts";
import { createPluginServer, type PluginEntry } from "../src/serve.ts";

interface Reply {
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}
const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const canonical = canonicalToolsV1.tool_describe;
const limited = { code: "RATE_LIMITED", retryAfterMs: 250, detail: "Try later" } as const;

async function served(
	extension: string,
	tool: PluginEntry["tools"][number],
	check: (
		ask: (method: string, params?: Record<string, unknown>) => Promise<Reply>,
	) => Promise<void>,
): Promise<void> {
	const started = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	let nextId = 0;
	const transport: Transport = {
		async start() {
			started.resolve();
		},
		async send(message) {
			if ("id" in message && typeof message.id === "number" && !("method" in message)) {
				pending.get(message.id)?.resolve(message as Reply);
				pending.delete(message.id);
			}
		},
		async close() {
			for (const reply of pending.values()) reply.reject(new Error("Connection closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const host = memoryHost(() => {
		throw new Error("Unexpected host request");
	});
	const factory = createPluginServer(
		{
			name: "tool-error-fixture",
			version: "1.0.0",
			plugin: "tool-error-fixture",
			extensions: {
				[extension]: extension === TOOL_EXTENSION_ID ? toolExtensionDeclaration : {},
			},
			tools: [tool],
		},
		host,
	);
	const handle = serveStdio(factory, { legacy: "reject", transport });
	try {
		await started.promise;
		await check(async (method, params = {}) => {
			const id = ++nextId;
			const reply = Promise.withResolvers<Reply>();
			pending.set(id, reply);
			transport.onmessage?.(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id,
					method,
					params: { ...params, _meta: metadata },
				}),
			);
			return reply.promise;
		});
	} finally {
		await handle.close();
		host.close();
	}
}

function describeTool(
	handler: PluginEntry["tools"][number]["handler"],
): PluginEntry["tools"][number] {
	return {
		name: canonical.entry.name,
		description: canonical.entry.description,
		inputSchema: z.fromJSONSchema(canonical.entry.inputSchema),
		outputSchema: z.fromJSONSchema(canonical.entry.outputSchema),
		handler,
	};
}

describe("served tool error envelopes", () => {
	it("accepts RATE_LIMITED with the canonical declared tool_describe output schema", async () => {
		await served(
			TOOL_EXTENSION_ID,
			describeTool(() => {
				throw new PluginError(limited.code, limited);
			}),
			async (ask) => {
				const list = await ask("tools/list");
				expect(list.error).toBeUndefined();
				expect(list.result?.tools).toMatchObject([
					{
						name: "tool_describe",
						outputSchema: canonical.entry.outputSchema,
					},
				]);
				const reply = await ask("tools/call", { name: "tool_describe", arguments: {} });
				expect(reply.error).toBeUndefined();
				expect(checkToolResult("tool_describe", reply.result)).toEqual({
					status: "error",
					error: limited,
				});
				expect(reply.result).not.toHaveProperty("structuredContent");
				expect(reply.result?._meta).toMatchObject({ [TOOL_ERROR_META_KEY]: limited });
			},
		);
	});

	it("sanitizes unexpected tool failures in the accepted error envelope", async () => {
		await served(
			TOOL_EXTENSION_ID,
			describeTool(() => {
				throw new Error("DYTEST-handler-exception-canary");
			}),
			async (ask) => {
				const reply = await ask("tools/call", { name: "tool_describe", arguments: {} });
				expect(reply.error).toBeUndefined();
				expect(checkToolResult("tool_describe", reply.result)).toEqual({
					status: "error",
					error: { code: "TRANSIENT" },
				});
				expect(reply.result).not.toHaveProperty("structuredContent");
				expect(JSON.stringify(reply)).not.toContain("DYTEST-");
			},
		);
	});

	it("preserves successful canonical tool outputs", async () => {
		const value = { kinds: ["kb.lookup"] };
		await served(
			TOOL_EXTENSION_ID,
			describeTool(() => value),
			async (ask) => {
				const reply = await ask("tools/call", { name: "tool_describe", arguments: {} });
				expect(reply.error).toBeUndefined();
				expect(reply.result?.structuredContent).toEqual(value);
				expect(checkToolResult("tool_describe", reply.result)).toMatchObject({
					status: "ok",
					value,
				});
				expect(reply.result?._meta).not.toHaveProperty(TOOL_ERROR_META_KEY);
			},
		);
	});

	it.each([
		["io.github.draftyak/channel", "channel_describe"],
		["io.github.draftyak/ai-provider", "ai_describe"],
	])("preserves structured PluginError results for %s", async (extension, name) => {
		await served(
			extension,
			{
				name,
				handler: () => {
					throw new PluginError(limited.code, limited);
				},
			},
			async (ask) => {
				const reply = await ask("tools/call", { name, arguments: {} });
				expect(reply.error).toBeUndefined();
				expect(reply.result).toMatchObject({ isError: true, structuredContent: limited });
				expect(reply.result?._meta).not.toHaveProperty(TOOL_ERROR_META_KEY);
			},
		);
	});
});
