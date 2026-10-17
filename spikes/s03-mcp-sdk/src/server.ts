import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import {
	type AuthInfo,
	type CallToolResult,
	createMcpHandler,
	isLegacyRequest,
	type McpRequestContext,
	McpServer,
	type McpServerOptions,
	mergeCapabilities,
	type ServerCapabilities,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import * as z from "zod";
import {
	bodyCap,
	type Env,
	headerMatch,
	hostOrigin,
	LEGACY_VERSIONS,
	MAX_BODY_BYTES,
	MODERN_VERSIONS,
	principal,
	rpcError,
	versionAllowlist,
} from "./middleware.ts";

export const UI_EXTENSION = "io.modelcontextprotocol/ui";
const HOUR = 3_600_000;

// §6 caching hints. Tool calls, completion and InputRequiredResult get none: the SDK adds hints
// only to these six results.
export const CACHE_HINTS: NonNullable<McpServerOptions["cacheHints"]> = {
	"server/discover": { cacheScope: "public", ttlMs: HOUR },
	"resources/list": { cacheScope: "public", ttlMs: HOUR },
	"tools/list": { cacheScope: "private", ttlMs: 60_000 },
	"prompts/list": { cacheScope: "private", ttlMs: 60_000 },
	"resources/templates/list": { cacheScope: "private", ttlMs: 60_000 },
	"resources/read": { cacheScope: "private", ttlMs: 0 },
};

const READ_ONLY = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

const fake = (data: Record<string, unknown>): CallToolResult => ({
	structuredContent: data,
	content: [{ type: "text", text: JSON.stringify(data) }],
});

export type ServerFactory = (ctx: McpRequestContext) => McpServer | Promise<McpServer>;

const CAPABILITIES: ServerCapabilities = {
	tools: { listChanged: false },
	resources: { listChanged: false },
	prompts: { listChanged: false },
	extensions: { [UI_EXTENSION]: {} },
};

// A fresh instance per request: SDK 2.3 fails a concurrent request on a shared one. listChanged
// is false because McpServer would declare it true. `completions` is left to the SDK, which
// declares it once a completable argument exists (M0.15); declared without one, it answers -32601.
// Capabilities and cache hints in `options` merge over these key by key, keeping the rest.
export function createMcpServer(options: McpServerOptions = {}): McpServer {
	const { capabilities = {}, cacheHints, ...rest } = options;
	const server = new McpServer(
		{ name: "draftyak-spike-s03", version: "0.0.0" },
		{
			supportedProtocolVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
			...rest,
			capabilities: mergeCapabilities(CAPABILITIES, capabilities),
			cacheHints: { ...CACHE_HINTS, ...cacheHints },
		},
	);
	server.registerTool(
		"accounts_list",
		{
			title: "List accounts",
			description: "Lists the accounts this agent may read (fake data).",
			inputSchema: z.object({}),
			annotations: READ_ONLY,
		},
		() => fake({ accounts: [{ alias: "gmail-1", channel: "gmail", mode: "full" }] }),
	);
	server.registerTool(
		"message_get",
		{
			title: "Get a message",
			description: "Reads one message by its id (fake data).",
			inputSchema: z.object({ messageId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }),
			annotations: READ_ONLY,
		},
		({ messageId }) => fake({ messageId, subject: "Fake subject", untrusted: true }),
	);
	return server;
}

// 2025-era requests get stateless JSON serving from a fresh instance: createMcpHandler's own
// legacy leg would answer them with text/event-stream. As in that leg, a client that goes away
// tears the exchange down; a JSON-mode response never settles after that, hence the race.
async function serveLegacy(
	factory: ServerFactory,
	request: Request,
	parsedBody: unknown,
	authInfo: AuthInfo,
	onerror?: (error: Error) => void,
): Promise<Response> {
	const server = await factory({ era: "legacy", authInfo, requestInfo: request });
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	if (onerror) transport.onerror = onerror;
	await server.connect(transport);
	const { promise: gone, resolve: leave } = Promise.withResolvers<Response>();
	const abandon = (): void => leave(new Response(null, { status: 499 }));
	try {
		if (request.signal.aborted) return new Response(null, { status: 499 });
		request.signal.addEventListener("abort", abandon, { once: true });
		return await Promise.race([transport.handleRequest(request, { parsedBody, authInfo }), gone]);
	} finally {
		request.signal.removeEventListener("abort", abandon);
		await server.close();
	}
}

export interface AppOptions {
	readonly factory?: ServerFactory;
	readonly token?: string;
	readonly onerror?: (error: Error) => void;
}

export function createApp(options: AppOptions = {}): Hono<Env> {
	const factory = options.factory ?? (() => createMcpServer());
	const { onerror } = options;
	const modern = createMcpHandler(factory, {
		legacy: "reject",
		responseMode: "json",
		maxRequestBodySize: MAX_BODY_BYTES,
		...(onerror ? { onerror } : {}),
	});
	const app = new Hono<Env>();
	app.use("*", hostOrigin);
	app.use("/mcp", bodyCap, headerMatch, versionAllowlist, principal(options.token));
	app.post("/mcp", async (c) => {
		const body = c.get("body");
		const authInfo = c.get("principal");
		// No SSE anywhere: the SDK serves subscriptions/listen as a stream whatever responseMode says.
		if ((body as { method?: unknown } | null)?.method === "subscriptions/listen") {
			return rpcError(404, -32601, "Method not found: subscriptions/listen", body);
		}
		if (await isLegacyRequest(c.req.raw, body)) {
			return serveLegacy(factory, c.req.raw, body, authInfo, onerror);
		}
		return modern.fetch(c.req.raw, { parsedBody: body, authInfo });
	});
	app.all("/mcp", () =>
		rpcError(405, -32000, "Method not allowed: use POST", null, undefined, { Allow: "POST" }),
	);
	app.notFound(() => rpcError(404, -32000, "Not found"));
	app.onError((error) => {
		onerror?.(error);
		return rpcError(500, -32603, "Internal error");
	});
	return app;
}

export interface Listening {
	readonly url: string;
	close(): Promise<void>;
}

// Loopback only, on the given port (0 picks a free one).
export function listen(port: number, options: AppOptions = {}): Promise<Listening> {
	const app = createApp(options);
	return new Promise((resolve, reject) => {
		const server = serve(
			{ fetch: app.fetch, hostname: "127.0.0.1", port, overrideGlobalObjects: false },
			(info) => {
				const close = (): Promise<void> =>
					new Promise((done) => {
						server.close(() => done());
						server.closeAllConnections();
					});
				resolve({ url: `http://127.0.0.1:${info.port}/mcp`, close });
			},
		) as Server;
		server.once("error", reject);
	});
}

if (import.meta.main) {
	const { url } = await listen(Number(process.argv[2] ?? 0));
	console.log(url);
}
