import { CHANNEL_V1 } from "@draftyak/protocol/channel-v1";
import { jsonCopy } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import { parseToolFrame } from "@draftyak/protocol/tool-v1";
import {
	createPluginServer,
	type HostChannel,
	type PluginEntry,
	type PluginInstance,
} from "@draftyak/sdk";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	createMcpHandler,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { MockHubError } from "./types.ts";

export const MCP_VERSION = "2026-07-28";
// The SDK captures a serving instance before reading any definition field.
const INSTANCE_CHECK: PluginEntry = Object.freeze({
	name: "instance-check",
	version: "0.0.0",
	plugin: "instance-check",
	extensions: Object.freeze({ [CHANNEL_V1]: Object.freeze({}) }),
	tools: Object.freeze([]),
});
function acceptsInstance(host: HostChannel, instance: PluginInstance): boolean {
	try {
		createPluginServer(INSTANCE_CHECK, host, { instance });
		return true;
	} catch {
		return false;
	}
}
async function responseText(response: Response, tool: boolean): Promise<string> {
	const maximum = tool ? 65_538 : 1_048_576;
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (reader) {
			const item = await reader.read();
			if (item.done) break;
			if (item.value.byteLength > maximum - bytes)
				throw new MockHubError(tool ? "TOOL_FRAME_TOO_LARGE" : "MCP_RESPONSE_TOO_LARGE");
			bytes += item.value.byteLength;
			chunks.push(item.value);
		}
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
	} finally {
		void reader?.cancel().catch(() => {});
		reader?.releaseLock();
	}
}
export function headerValue(value: string): string {
	const safe =
		/^[\x20-\x7e]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value);
	return safe ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
export function modernRequest(
	method: string,
	params: Record<string, unknown> = {},
	options: {
		readonly id?: number;
		readonly headers?: Readonly<Record<string, string | undefined>>;
		readonly signal?: AbortSignal;
	} = {},
): Request {
	const metadata = {
		[PROTOCOL_VERSION_META_KEY]: MCP_VERSION,
		[CLIENT_CAPABILITIES_META_KEY]: {},
		[CLIENT_INFO_META_KEY]: { name: "plugin-testkit", version: "0.0.0" },
		...(params._meta as Record<string, unknown> | undefined),
	};
	const headers = Object.entries({
		host: "127.0.0.1",
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": MCP_VERSION,
		"mcp-method": method,
		...(method === "tools/call" && typeof params.name === "string"
			? { "mcp-name": headerValue(params.name) }
			: {}),
		...options.headers,
	}).filter((entry): entry is [string, string] => entry[1] !== undefined);
	return new Request("http://127.0.0.1/mcp", {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: options.id ?? 1,
			method,
			params: { ...params, _meta: metadata },
		}),
		...(options.signal ? { signal: options.signal } : {}),
	});
}
export function createInMemory(
	entry: PluginEntry,
	host: HostChannel,
	tool: boolean,
	instance?: PluginInstance,
): {
	request(
		method: string,
		params?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
} {
	let factory: ReturnType<typeof createPluginServer>;
	try {
		factory = createPluginServer(entry, host, instance === undefined ? {} : { instance });
	} catch (error) {
		// Only the instance refusal maps here; definition errors keep the SDK's own report.
		if (instance !== undefined && !acceptsInstance(host, instance))
			throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
		throw error;
	}
	const handler = createMcpHandler(factory, {
		legacy: "reject",
		responseMode: "json",
	});
	let sequence = 0;
	return {
		async request(method, params = {}, signal) {
			const request = modernRequest(method, jsonCopy(params), {
				id: ++sequence,
				...(signal ? { signal } : {}),
			});
			if (tool && parseToolFrame(await request.clone().text()).status !== "ok")
				throw new MockHubError("TOOL_FRAME_TOO_LARGE");
			const response = await handler.fetch(request);
			const text = await responseText(response, tool);
			let parsed: unknown;
			if (tool) {
				const frame = parseToolFrame(text);
				if (frame.status !== "ok") throw new MockHubError(frame.reason);
				parsed = frame.message;
			} else {
				if (Buffer.byteLength(text) > 1_048_576) throw new MockHubError("MCP_RESPONSE_TOO_LARGE");
				parsed = parseStrict(text);
			}
			const envelope = parsed as { result?: unknown; error?: unknown };
			if (
				response.status !== 200 ||
				envelope.error ||
				!envelope.result ||
				typeof envelope.result !== "object" ||
				Array.isArray(envelope.result)
			)
				throw new MockHubError("MCP_REQUEST_REFUSED");
			return envelope.result as Record<string, unknown>;
		},
	};
}
