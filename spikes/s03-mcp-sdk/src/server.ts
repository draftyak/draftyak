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
	ProtocolError,
	ProtocolErrorCode,
	type RequestId,
	type ServerCapabilities,
	type ServerContext,
	specTypeSchemas,
	WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import * as z from "zod";
import { capCompletion } from "./completion.ts";
import { type Params, principalId } from "./elicit.ts";
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
import { registerPrompts } from "./prompts.ts";
import {
	checkReadUri,
	createHub,
	type Hub,
	legacyNotFound,
	registerResources,
	type Surface,
} from "./resources.ts";

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
// declares it once a completable argument exists (the prompts do); declared without one, it answers
// -32601. Capabilities and cache hints in `options` merge over these key by key, keeping the rest.
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

type Handler = (request: { params?: Record<string, unknown> }, ctx: ServerContext) => unknown;

// McpServer's callbacks get parsed values only (a resources/read callback gets the WHATWG-normalized
// URL: DRAFTYAK://, a tab, a dot segment or an empty userinfo or port all read as the canonical URI),
// and it installs its handlers in its constructor. So checks on the request as sent wrap the handler
// it stored, ahead of the SDK's own seam; SDK 2.3.1 keeps them in a private map, and any other
// layout fails here rather than silently skipping the checks.
function intercept(server: McpServer, method: string, wrap: (next: Handler) => Handler): void {
	const handlers = (server.server as unknown as { _requestHandlers?: unknown })._requestHandlers;
	const stored: unknown = handlers instanceof Map ? handlers.get(method) : undefined;
	if (!(handlers instanceof Map) || typeof stored !== "function") {
		throw new Error(`no stored ${method} handler to check requests in front of`);
	}
	handlers.set(method, wrap(stored as Handler));
}

// The surfaces' methods with the spec's params schema for each. SDK 2.3.1 answers a request that
// fails its own wire check with -32603 and the raw issue list, so these are checked first.
const WIRE = {
	"prompts/list": specTypeSchemas.PaginatedRequestParams,
	"prompts/get": specTypeSchemas.GetPromptRequestParams,
	"resources/list": specTypeSchemas.PaginatedRequestParams,
	"resources/templates/list": specTypeSchemas.PaginatedRequestParams,
	"resources/read": specTypeSchemas.ReadResourceRequestParams,
	"completion/complete": specTypeSchemas.CompleteRequestParams,
} as const;
type SurfaceMethod = keyof typeof WIRE;

// -32602 with a readable message for params of the wrong shape, and for a prompt argument named
// __proto__, which the SDK's record parser drops without a word before the strict schemas see it.
function checkParams(method: SurfaceMethod, params: Params): void {
	const [issue] = WIRE[method]["~standard"].validate(params).issues ?? [];
	if (issue !== undefined) {
		const path = (issue.path ?? []).map((key) => String(typeof key === "object" ? key.key : key));
		const where = path.length > 0 ? path.join(".") : "params";
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`Invalid ${method} params: ${where}: ${issue.message}`,
			{ reason: "invalid_params" },
		);
	}
	const args = params.arguments;
	if (method === "prompts/get" && args instanceof Object && Object.hasOwn(args, "__proto__")) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`Invalid arguments for prompt ${String(params.name)}: unknown argument __proto__`,
		);
	}
}

// The production surface: the tools plus the guide, templates, prompts and completion, built per
// request for its era and principal (refused without one). Handlers give 2025-era requests the
// readable fallbacks themselves; with the legacy shim off, an input-required return there could only
// fail loudly.
export function surfaceFactory(hub: Hub): ServerFactory {
	return ({ era, authInfo }) => {
		const principal = { id: principalId(authInfo), scopes: authInfo?.scopes ?? [] };
		const sent = new Map<RequestId, Params>();
		const server = createMcpServer({
			requestState: {
				verify: (state, ctx) => hub.mrtr.resume(state, ctx, era, sent.get(ctx.mcpReq.id)),
			},
			inputRequired: { legacyShim: false },
		});
		const surface: Surface = {
			hub,
			era,
			principal,
			sent: (ctx) => {
				const params = sent.get(ctx.mcpReq.id);
				if (params === undefined) throw new Error(`no params kept for ${ctx.mcpReq.method}`);
				return params;
			},
		};
		registerResources(server, surface);
		registerPrompts(server, surface);
		// In order: the completion bucket, the params' shape, the raw URI, then the params kept for
		// the requestState digest (Mrtr.mint and Mrtr.resume).
		for (const method of Object.keys(WIRE) as SurfaceMethod[]) {
			intercept(server, method, (next) => async (request, ctx) => {
				const params = request.params ?? {};
				if (method === "completion/complete") hub.completions.take(principal.id);
				checkParams(method, params);
				if (method === "resources/read") checkReadUri(params.uri, principal);
				if (method === "prompts/get" || method === "resources/read") {
					sent.set(ctx.mcpReq.id, params);
				}
				const result = await next(request, ctx);
				return method === "completion/complete" ? capCompletion(result) : result;
			});
		}
		return server;
	};
}

// 2025-era requests get stateless JSON serving from a fresh instance: createMcpHandler's own
// legacy leg would answer them with text/event-stream. As in that leg, a client that goes away
// tears the exchange down; a JSON-mode response never settles after that, hence the race.
export async function serveLegacy(
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
	const send = transport.send.bind(transport);
	transport.send = (message, options) => send(legacyNotFound(message), options);
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
	readonly hub?: Hub;
	readonly token?: string;
	readonly onerror?: (error: Error) => void;
}

export function createApp(options: AppOptions = {}): Hono<Env> {
	const factory = options.factory ?? surfaceFactory(options.hub ?? createHub());
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
