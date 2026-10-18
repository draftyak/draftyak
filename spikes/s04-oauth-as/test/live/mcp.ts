// The live session's MCP endpoint: S3's dual-era server (M0.14–M0.16) with synthetic data only,
// behind its own Host check and the AS's bearer tokens, as M0.14's and M0.15's handoffs allow:
// s03's createApp accepts only loopback names and its stub principal, so this app reuses its body
// cap, header and version checks and its surfaces. Origin is recorded, never refused: these are
// bearer-authenticated server-to-server requests, and hosted Claude sends one.

import type { View } from "@draftyak/spike-s03-mcp-sdk/src/apps.ts";
import {
	bodyCap,
	headerMatch,
	MAX_BODY_BYTES,
	rpcError,
	versionAllowlist,
} from "@draftyak/spike-s03-mcp-sdk/src/middleware.ts";
import {
	createHub,
	type Hub,
	sessionKey,
	ULID,
} from "@draftyak/spike-s03-mcp-sdk/src/resources.ts";
import {
	type ServerFactory,
	serveLegacy,
	surfaceFactory,
} from "@draftyak/spike-s03-mcp-sdk/src/server.ts";
import type { HttpBindings } from "@hono/node-server";
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	createMcpHandler,
	isLegacyRequest,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { Hono, type MiddlewareHandler } from "hono";
import type { Provider } from "oidc-provider";
import * as z from "zod";
import { MCP_PATH, SCOPES, verifyAccessToken } from "../../src/provider.ts";
import { PRM_PATH } from "../../src/routes.ts";
import {
	type McpAnswer,
	type McpRequestFacts,
	type Recorder,
	WRITE_SCOPE,
	WRITE_TOOL,
} from "./record.ts";

export interface McpEnv {
	Bindings: HttpBindings;
	Variables: {
		body: unknown;
		principal: AuthInfo;
		tokenClient: string;
		grant: string;
		scopes: readonly string[];
	};
}

// Synthetic items only: two account aliases (so a 2026-era triage_inbox asks which), one
// conversation and one message on gmail-1, and one draft for the Apps view.
export const ALIASES: readonly string[] = ["gmail-1", "slack-1"];
export const CONVERSATION_ID = "01JS4C0000000000000000000A";
export const MESSAGE_ID = "01JS4M0000000000000000000A";
export const DRAFT_ID = "01JS4D0000000000000000000A";
export const DRAFT: Readonly<Record<string, unknown>> = {
	draftId: DRAFT_ID,
	account: "gmail-1",
	channel: "gmail",
	revision: 1,
	aiAuthored: true,
	flags: ["AGENT_AUTHORED"],
	body: "Synthetic draft for the S4 live session. There is no real mail here.",
};

export interface LiveHub {
	readonly hub: Hub;
	// A principal's first request: it reads both aliases, with read sessions already approved, so the
	// session-pending path (and ADR 0004's dropped URL prompt) never comes up.
	admit(principal: string): void;
}

export function liveHub(views: readonly View[]): LiveHub {
	const aliases = new Map<string, readonly string[]>();
	const base = createHub({
		items: {
			[CONVERSATION_ID]: {
				kind: "conversation",
				account: "gmail-1",
				text: "Synthetic conversation for the S4 live session. There is no real mail here.",
			},
			[MESSAGE_ID]: {
				kind: "message",
				account: "gmail-1",
				text: "Synthetic message for the S4 live session.",
			},
		},
		apps: { views, drafts: { [DRAFT_ID]: DRAFT } },
	});
	const hub: Hub = { ...base, aliases };
	return {
		hub,
		admit(principal) {
			if (aliases.has(principal)) return;
			aliases.set(principal, ALIASES);
			for (const alias of ALIASES) hub.sessions.add(sessionKey(principal, alias, "read"));
		},
	};
}

const WRITE = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

// s03's surfaces plus one fake write tool, for ChatGPT's write access on the owner's plan. It
// stores and sends nothing, its arguments are never recorded, and like §6's draft_create it needs
// drafts:write: a token without it gets an isError result.
export function liveFactory(hub: Hub): ServerFactory {
	const surfaces = surfaceFactory(hub);
	return async (ctx) => {
		const server = await surfaces(ctx);
		const writes = (ctx.authInfo?.scopes ?? []).includes(WRITE_SCOPE);
		server.registerTool(
			WRITE_TOOL,
			{
				title: "Create a draft (fake)",
				description:
					"Creates a draft reply in a conversation. Spike stand-in: it stores and sends nothing.",
				inputSchema: z.object({
					conversationId: z.string().regex(ULID),
					body: z.string().max(2_000).optional(),
				}),
				annotations: WRITE,
			},
			() => {
				if (!writes) {
					return {
						isError: true,
						content: [{ type: "text", text: `This token lacks ${WRITE_SCOPE}.` }],
					};
				}
				const result = { draftId: DRAFT_ID, status: "fake", stored: false };
				return {
					structuredContent: result,
					content: [{ type: "text", text: JSON.stringify(result) }],
				};
			},
		);
		return server;
	};
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// What one request asks for, read from the body and headers the checks already passed.
export function requestFacts(
	httpMethod: string,
	body: unknown,
	headers: McpRequestFacts["headers"],
	legacy: boolean,
): McpRequestFacts {
	const messages = (Array.isArray(body) ? body : [body]).filter(isObject);
	const methods: string[] = [];
	const versions: string[] = [];
	const tools: string[] = [];
	let capabilities: unknown;
	let clientInfo: unknown;
	let reads = { ui: 0, other: 0 };
	let inputAnswered = false;
	const versionHeader = headers["mcp-protocol-version"];
	if (typeof versionHeader === "string") versions.push(versionHeader);
	for (const message of messages) {
		if (typeof message.method !== "string") continue;
		methods.push(message.method);
		const params = isObject(message.params) ? message.params : {};
		const meta = isObject(params._meta) ? params._meta : {};
		if (message.method === "initialize") {
			if (typeof params.protocolVersion === "string") versions.push(params.protocolVersion);
			capabilities = params.capabilities;
			clientInfo = params.clientInfo;
		}
		if (typeof meta[PROTOCOL_VERSION_META_KEY] === "string") {
			versions.push(meta[PROTOCOL_VERSION_META_KEY] as string);
		}
		capabilities ??= meta[CLIENT_CAPABILITIES_META_KEY];
		clientInfo ??= meta[CLIENT_INFO_META_KEY];
		if (message.method === "tools/call" && typeof params.name === "string") tools.push(params.name);
		if (message.method === "resources/read") {
			reads = String(params.uri).startsWith("ui://")
				? { ...reads, ui: reads.ui + 1 }
				: { ...reads, other: reads.other + 1 };
		}
		if (params.inputResponses !== undefined) inputAnswered = true;
	}
	return {
		httpMethod,
		era: messages.length === 0 ? undefined : legacy ? "2025" : "2026",
		methods,
		versions,
		capabilities,
		clientInfo,
		tools,
		reads,
		inputAnswered,
		headers,
	};
}

// What the answer tells the recorder: an input-required result, and a tools/list result that
// names the write tool.
async function answerOf(response: Response): Promise<McpAnswer> {
	const answer = { status: response.status, inputRequired: false, listedWriteTool: false };
	if (!(response.headers.get("content-type") ?? "").includes("application/json")) return answer;
	try {
		const body = (await response.clone().json()) as unknown;
		const results = (Array.isArray(body) ? body : [body])
			.map((reply) => (isObject(reply) && isObject(reply.result) ? reply.result : undefined))
			.filter((result) => result !== undefined);
		return {
			...answer,
			inputRequired: results.some((result) => result.resultType === "input_required"),
			listedWriteTool: results.some(
				(result) =>
					Array.isArray(result.tools) &&
					result.tools.some((tool) => isObject(tool) && tool.name === WRITE_TOOL),
			),
		};
	} catch {
		return answer;
	}
}

export interface McpOptions {
	readonly provider: Provider;
	readonly publicOrigin: URL;
	readonly views: readonly View[];
	readonly recorder: Recorder;
	readonly onerror?: (error: Error) => void;
}

export function liveMcp(options: McpOptions): Hono<McpEnv> {
	const { provider, publicOrigin, recorder } = options;
	const { hub, admit } = liveHub(options.views);
	const factory = liveFactory(hub);
	const onerror = options.onerror;
	const modern = createMcpHandler(factory, {
		legacy: "reject",
		responseMode: "json",
		maxRequestBodySize: MAX_BODY_BYTES,
		...(onerror ? { onerror } : {}),
	});
	const scheme = publicOrigin.protocol.slice(0, -1);
	// The scope names what to ask for (MCP 2025-11-25's scope selection; Claude's and ChatGPT's docs
	// show it), the same list as the resource metadata's scopes_supported.
	const challenge = `Bearer resource_metadata="${publicOrigin.origin}${PRM_PATH}", scope="${SCOPES.join(" ")}"`;

	// §6 L3: the public host only, from the configured proxy's X-Forwarded-Host or else Host
	// (serveBehindProxy has already dropped X-Forwarded-* from any other peer).
	const publicHostOnly: MiddlewareHandler<McpEnv> = async (c, next) => {
		const { headers } = c.env.incoming;
		const forwarded = headers["x-forwarded-host"];
		const host = provider.proxy && forwarded !== undefined ? forwarded : headers.host;
		const proto = headers["x-forwarded-proto"];
		if (host !== publicOrigin.host || (proto !== undefined && proto !== scheme)) {
			return rpcError(421, -32000, "Misdirected Request: unknown host");
		}
		await next();
	};

	// The AS's own opaque tokens, for this resource, with a live grant; the principal is the grant.
	const bearer: MiddlewareHandler<McpEnv> = async (c, next) => {
		const presented = /^Bearer ([\w.~+/-]+=*)$/i.exec(c.req.header("authorization") ?? "")?.[1];
		const token = presented ? await verifyAccessToken(provider, presented) : undefined;
		if (!presented || !token) {
			recorder.mcpUnauthenticated();
			const error = presented ? `, error="invalid_token"` : "";
			return c.json({ error: presented ? "invalid_token" : "unauthorized" }, 401, {
				"www-authenticate": `${challenge}${error}`,
			});
		}
		admit(`grant:${token.grantId}`);
		const scopes = token.scope.split(" ").filter(Boolean);
		c.set("tokenClient", token.clientId);
		c.set("grant", token.grantId);
		c.set("scopes", scopes);
		c.set("principal", {
			token: presented,
			clientId: token.clientId,
			scopes,
			resource: new URL(MCP_PATH, publicOrigin),
			extra: { grantId: token.grantId },
		});
		await next();
	};

	const app = new Hono<McpEnv>();
	app.use("*", publicHostOnly);
	// The token check comes before s03's body and header checks, the reverse of §6 Serving's order,
	// so any request without a valid token gets the 401 challenge that starts sign-in (Claude's
	// connector docs require a 401), a body-less discovery probe included; s03's order would answer
	// that probe 415.
	app.use(
		MCP_PATH,
		bearer,
		bodyCap as unknown as MiddlewareHandler<McpEnv>,
		headerMatch as unknown as MiddlewareHandler<McpEnv>,
		versionAllowlist as unknown as MiddlewareHandler<McpEnv>,
	);
	app.post(MCP_PATH, async (c) => {
		const body = c.get("body");
		const authInfo = c.get("principal");
		const legacy = await isLegacyRequest(c.req.raw, body);
		const facts = requestFacts("POST", body, c.env.incoming.headers, legacy);
		let response: Response;
		try {
			if (isObject(body) && body.method === "subscriptions/listen") {
				response = rpcError(404, -32601, "Method not found: subscriptions/listen", body);
			} else if (legacy) {
				response = await serveLegacy(factory, c.req.raw, body, authInfo, onerror);
			} else {
				response = await modern.fetch(c.req.raw, { parsedBody: body, authInfo });
			}
		} catch (error) {
			// Still one of the client's requests: its row shows the 500.
			onerror?.(error as Error);
			response = rpcError(500, -32603, "Internal error");
		}
		recorder.mcp(
			c.get("tokenClient"),
			c.get("grant"),
			c.get("scopes"),
			facts,
			await answerOf(response),
			c.env.incoming,
		);
		return response;
	});
	app.all(MCP_PATH, (c) => {
		const facts = requestFacts(c.req.method, undefined, c.env.incoming.headers, true);
		recorder.mcp(
			c.get("tokenClient"),
			c.get("grant"),
			c.get("scopes"),
			facts,
			{ status: 405, inputRequired: false, listedWriteTool: false },
			c.env.incoming,
		);
		return rpcError(405, -32000, "Method not allowed: use POST", null, undefined, {
			Allow: "POST",
		});
	});
	app.notFound(() => rpcError(404, -32000, "Not found"));
	app.onError((error) => {
		onerror?.(error);
		return rpcError(500, -32603, "Internal error");
	});
	return app;
}
