import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

// The in-memory harness: Requests built as a 2026-era client builds them, served with no socket.
// M1's testkit takes its in-memory mode from here.
export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";
export const MCP_URL = "http://127.0.0.1/mcp";

export interface Served {
	readonly status: number;
	readonly headers: Headers;
	// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are inspected loosely in tests.
	readonly body: any;
}

export interface Fetcher {
	fetch(request: Request): Response | Promise<Response>;
}

type HeaderValues = Readonly<Record<string, string | undefined>>;

// Header-safe values go as they are; others in SEP-2243's =?base64?…?= sentinel.
export function headerValue(value: string): string {
	const safe =
		/^[\x20-\x7e]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value);
	return safe ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const nameOf = (method: string, params: Record<string, unknown>): unknown =>
	method === "resources/read"
		? params.uri
		: ["tools/call", "prompts/get"].includes(method)
			? params.name
			: undefined;

function build(body: unknown, headers: HeaderValues, raw?: string): Request {
	const all: Record<string, string | undefined> = {
		host: "127.0.0.1",
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...headers,
	};
	const defined = Object.entries(all).filter(
		(entry): entry is [string, string] => entry[1] !== undefined,
	);
	return new Request(MCP_URL, {
		method: "POST",
		headers: Object.fromEntries(defined),
		body: raw ?? JSON.stringify(body),
	});
}

export interface ModernOptions {
	readonly id?: string | number;
	readonly capabilities?: Record<string, unknown>;
	readonly clientInfo?: Record<string, unknown>;
	readonly headers?: HeaderValues;
}

// A 2026-era request: the per-request _meta envelope plus MCP-Protocol-Version, Mcp-Method and
// Mcp-Name, as SEP-2243 asks; `headers` overrides or (with undefined) drops any of them.
export function modern(
	method: string,
	params: Record<string, unknown> = {},
	options: ModernOptions = {},
): Request {
	const meta = {
		[PROTOCOL_VERSION_META_KEY]: MODERN,
		[CLIENT_CAPABILITIES_META_KEY]: options.capabilities ?? {},
		[CLIENT_INFO_META_KEY]: options.clientInfo ?? { name: "in-memory", version: "0.0.0" },
	};
	const name = nameOf(method, params);
	const body = {
		jsonrpc: "2.0",
		id: options.id ?? 1,
		method,
		params: { ...params, _meta: { ...meta, ...(params._meta as object) } },
	};
	return build(body, {
		"mcp-protocol-version": MODERN,
		"mcp-method": method,
		...(typeof name === "string" ? { "mcp-name": headerValue(name) } : {}),
		...options.headers,
	});
}

// A 2025-era request, as a stateless client sends it after `initialize`.
export function legacy(
	method: string,
	params: Record<string, unknown> = {},
	headers: HeaderValues = {},
	id: string | number | null = 1,
): Request {
	const body = { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params };
	const version = method === "initialize" ? {} : { "mcp-protocol-version": LEGACY };
	return build(body, { ...version, ...headers });
}

export function initialize(protocolVersion: string = LEGACY): Request {
	const clientInfo = { name: "in-memory", version: "0.0.0" };
	return legacy("initialize", { protocolVersion, capabilities: {}, clientInfo });
}

export function raw(text: string, headers: HeaderValues = {}): Request {
	return build(undefined, headers, text);
}

export async function serve(target: Fetcher, request: Request): Promise<Served> {
	const response = await target.fetch(request);
	const text = await response.text();
	return {
		status: response.status,
		headers: response.headers,
		body: text ? JSON.parse(text) : undefined,
	};
}
