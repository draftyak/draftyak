import { Agent, request as post } from "node:http";
import { buffer } from "node:stream/consumers";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	type ClientCapabilities,
	type Implementation,
	type JSONRPCMessage,
	PROTOCOL_VERSION_META_KEY,
	ProtocolError,
	ProtocolErrorCode,
	SERVER_INFO_META_KEY,
	Server,
	type ServerCapabilities,
	type ServerContext,
	type StandardSchemaV1,
	specTypeSchemas,
	type Transport,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export const MODERN = "2026-07-28";
// The 2025-era revisions a client may open with: those the hub's own 2025 leg serves.
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];
// §6 Elicitation: one round, and a requestState that lives 600 s.
export const MAX_ROUNDS = 1;
export const STATE_TTL_MS = 600_000;
// A dialog still unanswered 5 s before its state lapses is cancelled: the hub would refuse the answer.
// It is a wait for each answer, which a progress notification from the client starts again.
export const ANSWER_TIMEOUT_MS: number = STATE_TTL_MS - 5_000;
// The hub is on this machine: one that hasn't answered server/discover by then isn't serving.
export const DISCOVER_TIMEOUT_MS = 10_000;
// Node's HTTP server takes 16 KiB of request headers in all; a longer Mcp-Name never reaches it.
export const MAX_NAME_LENGTH = 8_192;
// §6 MCP Apps: the 2025 path always gets _meta.ui, so every relayed request declares the extension.
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
const UI_SETTINGS = { mimeTypes: ["text/html;profile=mcp-app"] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface HubOptions {
	// The hub's local MCP endpoint (§6 Surfaces: http://127.0.0.1:47613/mcp).
	readonly url: string;
	readonly token: string;
	readonly fetch?: (request: Request) => Promise<Response>;
}

export interface BridgeOptions {
	readonly hub: HubOptions;
	readonly maxRounds?: number;
	readonly answerTimeoutMs?: number;
	readonly discoverTimeoutMs?: number;
}

// The 2025 client behind the bridge, as each 2026-era request's envelope describes it.
interface Downstream {
	readonly capabilities: ClientCapabilities;
	readonly clientInfo: Implementation;
}

type Call = (
	method: string,
	params: Json,
	downstream: Downstream,
	signal?: AbortSignal,
) => Promise<Json>;

const BRIDGE: Implementation = { name: "draftyak-bridge", version: "0.0.0" };
const NAME_SOURCE: Readonly<Record<string, "name" | "uri">> = {
	"tools/call": "name",
	"prompts/get": "name",
	"resources/read": "uri",
};

// SEP-2243's Mcp-Name: header-safe text as it is, anything else in the =?base64?…?= sentinel.
function headerValue(value: string): string {
	const safe =
		/^[\x20-\x7e]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value);
	return safe ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// The bridge's own failures, in fixed words: no exception text reaches them, so they are safe to print.
class HubUnavailable extends ProtocolError {
	constructor(message: string) {
		super(ProtocolErrorCode.InternalError, message);
	}
}
const HUB_DOWN = "The DraftYak hub isn't answering; check that it is running.";

function invalidParams(method: string, where: string, problem: string): ProtocolError {
	const message = `Invalid ${method} params: ${where}: ${problem}`;
	return new ProtocolError(ProtocolErrorCode.InvalidParams, message, { reason: "invalid_params" });
}

// The hub over node:http with an agent of its own: Node's fetch and http.globalAgent send through
// HTTP_PROXY under NODE_USE_ENV_PROXY or --use-env-proxy, even to 127.0.0.1, and the agent token
// travels in plain HTTP.
const agent = new Agent();
async function direct(request: Request): Promise<Response> {
	const body = Buffer.from(await request.arrayBuffer());
	const headers = { ...Object.fromEntries(request.headers), "content-length": `${body.length}` };
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const sent = post(
		request.url,
		{ method: "POST", headers, agent, signal: request.signal },
		(reply) =>
			buffer(reply)
				.then((data) => new Response(new Uint8Array(data), { status: reply.statusCode }))
				.then(resolve, reject),
	);
	sent.on("error", reject);
	sent.end(body);
	return promise;
}

// 2026-era requests as a 2026 client sends them: the per-request envelope plus MCP-Protocol-Version,
// Mcp-Method and Mcp-Name (§6 Serving, step 3), with the agent token. The hub answers JSON only.
function hubCaller(hub: HubOptions): Call {
	let lastId = 0;
	return async (method, params, downstream, signal) => {
		const id = ++lastId;
		const field = Object.hasOwn(NAME_SOURCE, method) ? NAME_SOURCE[method] : undefined;
		const name = field === undefined ? undefined : params[field];
		const mcpName = typeof name === "string" ? headerValue(name) : undefined;
		if (field !== undefined && mcpName !== undefined && mcpName.length > MAX_NAME_LENGTH) {
			throw invalidParams(method, field, "too long for the hub's Mcp-Name header");
		}
		const envelope = {
			[PROTOCOL_VERSION_META_KEY]: MODERN,
			[CLIENT_CAPABILITIES_META_KEY]: downstream.capabilities,
			[CLIENT_INFO_META_KEY]: downstream.clientInfo,
		};
		let response: Response;
		try {
			const request = new Request(hub.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${hub.token}`,
					"mcp-protocol-version": MODERN,
					"mcp-method": method,
					...(mcpName === undefined ? {} : { "mcp-name": mcpName }),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id,
					method,
					params: { ...params, _meta: envelope },
				}),
				...(signal ? { signal } : {}),
			});
			response = await (hub.fetch ?? direct)(request);
		} catch (error) {
			// The client gave up on its request; anything else, a timeout included, is a silent hub.
			if (signal?.aborted && signal.reason?.name !== "TimeoutError") throw error;
			throw new HubUnavailable(HUB_DOWN);
		}
		const reply: unknown = await response.json().catch(() => undefined);
		if (isObject(reply) && isObject(reply.error)) {
			const { code, message, data } = reply.error;
			const known = typeof code === "number" && typeof message === "string";
			if (known) throw new ProtocolError(code, message, data);
			throw new HubUnavailable("The DraftYak hub's error is malformed.");
		}
		if (response.status === 401) {
			throw new HubUnavailable(
				"The DraftYak hub refused the bridge's agent token; check DRAFTYAK_TOKEN.",
			);
		}
		if (!isObject(reply) || reply.id !== id || !isObject(reply.result)) {
			throw new HubUnavailable(
				`The DraftYak hub sent no JSON-RPC result (HTTP ${response.status}).`,
			);
		}
		return reply.result;
	};
}

// Capability pass-through: the elicitation modes the 2025 client declared at initialize, as far as its
// revision defines them (elicitation from 2025-06-18, URL mode from 2025-11-25), plus the UI extension.
// Nothing else reaches the hub: it never asks for sampling or roots. The SDK checks neither revision,
// and reads a bare `elicitation: {}` as form.
function passThrough(declared: ClientCapabilities | undefined, revision = ""): ClientCapabilities {
	const extensions = { [UI_EXTENSION]: UI_SETTINGS };
	const elicitation = revision >= "2025-06-18" ? declared?.elicitation : undefined;
	if (elicitation === undefined) return { extensions };
	if (revision >= "2025-11-25") return { elicitation, extensions };
	const { url, ...rest } = elicitation;
	return rest.form === undefined ? { extensions } : { elicitation: rest, extensions };
}

// A 2026-era result as the hub's own 2025 leg writes it: no resultType, cache hints or the serverInfo
// the 2026 encoder stamps into every result. Input-required results go to the SDK's legacy shim.
function legacyResult(result: Json): Json {
	if (result.resultType === "input_required") return result;
	const { resultType, ttlMs, cacheScope, _meta, ...rest } = result;
	const meta = isObject(_meta)
		? Object.entries(_meta).filter(([key]) => key !== SERVER_INFO_META_KEY)
		: [];
	return meta.length > 0 ? { ...rest, _meta: Object.fromEntries(meta) } : rest;
}

// The 2025 not-found code, as the hub's own 2025 leg answers it: SDK 2.3.1 writes -32602 on every
// revision, and its not-found error is the -32602 whose data is exactly { uri }.
function legacyNotFound(message: JSONRPCMessage): JSONRPCMessage {
	if (!("error" in message)) return message;
	const { code, data } = message.error;
	const notFound =
		code === ProtocolErrorCode.InvalidParams &&
		isObject(data) &&
		typeof data.uri === "string" &&
		Object.keys(data).length === 1;
	return notFound ? { ...message, error: { ...message.error, code: -32002 } } : message;
}

// The surfaces' params as the spec defines them, checked as the hub's own 2025 leg checks them: SDK
// 2.3.1 answers params that fail its wire check with -32603 and the raw issue list, and its record
// parser drops an argument named __proto__ without a word. tools/list and tools/call keep the SDK's
// own check, as on the hub.
const SPEC_PARAMS = {
	"prompts/list": specTypeSchemas.PaginatedRequestParams,
	"prompts/get": specTypeSchemas.GetPromptRequestParams,
	"resources/list": specTypeSchemas.PaginatedRequestParams,
	"resources/templates/list": specTypeSchemas.PaginatedRequestParams,
	"resources/read": specTypeSchemas.ReadResourceRequestParams,
	"completion/complete": specTypeSchemas.CompleteRequestParams,
} as const;
type CheckedMethod = keyof typeof SPEC_PARAMS;
const isChecked = (method: string): method is CheckedMethod => Object.hasOwn(SPEC_PARAMS, method);

function checkParams(method: CheckedMethod, params: Json): void {
	const [issue] = SPEC_PARAMS[method]["~standard"].validate(params).issues ?? [];
	if (issue !== undefined) {
		const path = (issue.path ?? []).map((key) => String(typeof key === "object" ? key.key : key));
		throw invalidParams(method, path.length > 0 ? path.join(".") : "params", issue.message);
	}
	const args = params.arguments;
	if (method === "prompts/get" && args instanceof Object && Object.hasOwn(args, "__proto__")) {
		throw new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			`Invalid arguments for prompt ${String(params.name)}: unknown argument __proto__`,
		);
	}
}

// The params as sent, untouched, for the checked methods to relay.
const AS_SENT: StandardSchemaV1<Json, Json> = {
	"~standard": { version: 1, vendor: "draftyak", validate: (value) => ({ value: value as Json }) },
};

const STATE_REFUSED = "invalid_request_state";
export const EXPIRED =
	"DraftYak no longer accepts the answer to this request's question: it came more than 10 minutes after the question, or the hub restarted in between. Nothing was done; run the request again.";

const refusedState = (error: unknown): boolean =>
	error instanceof ProtocolError && isObject(error.data) && error.data.reason === STATE_REFUSED;

// The 2025-era methods the bridge relays, by the hub capability that serves them.
const RELAYED: Readonly<Record<string, readonly string[]>> = {
	tools: ["tools/list", "tools/call"],
	prompts: ["prompts/list", "prompts/get"],
	resources: ["resources/list", "resources/templates/list", "resources/read"],
	completions: ["completion/complete"],
};

// A 2025-era MCP server for one client that relays every request to the hub as a 2026-era one. Where
// the hub answers input_required, the SDK's legacy shim sends the client elicitation/create, at most
// maxRounds times, and re-enters the relay with the answers, which retries with the hub's requestState.
async function createBridge(options: BridgeOptions): Promise<Server> {
	const call = hubCaller(options.hub);
	const discovered = await call(
		"server/discover",
		{},
		{ capabilities: {}, clientInfo: BRIDGE },
		AbortSignal.timeout(options.discoverTimeoutMs ?? DISCOVER_TIMEOUT_MS),
	);
	const capabilities = (
		isObject(discovered.capabilities) ? discovered.capabilities : {}
	) as ServerCapabilities;
	const hubInfo = isObject(discovered._meta) ? discovered._meta[SERVER_INFO_META_KEY] : undefined;
	// The round the hub opened on each request, by the request's own signal, which the SDK keeps across
	// the shim's re-entries: the state the hub gave, if any.
	const rounds = new WeakMap<AbortSignal, { readonly state: string | undefined }>();
	const server = new Server(isObject(hubInfo) ? (hubInfo as Implementation) : BRIDGE, {
		capabilities,
		...(typeof discovered.instructions === "string"
			? { instructions: discovered.instructions }
			: {}),
		supportedProtocolVersions: [...LEGACY_VERSIONS],
		inputRequired: {
			maxRounds: options.maxRounds ?? MAX_ROUNDS,
			roundTimeoutMs: options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS,
		},
		requestState: {
			// The shim echoes the state the hub gave; any other (a 2025 client can put params.requestState
			// in a request too) is refused with the SDK's frozen -32602.
			verify: (state, ctx) => {
				if (state !== rounds.get(ctx.mcpReq.signal)?.state) {
					throw new Error("not the state the hub gave this request");
				}
			},
		},
	});
	const relay = async (method: string, params: Json, ctx: ServerContext): Promise<Json> => {
		const { _meta, ...sent } = params;
		// Only a re-entry after the hub asked carries a retry: the hub's own state, if it gave one, and
		// the answers. Whatever a client puts in its own request never reaches the hub.
		const round = rounds.get(ctx.mcpReq.signal);
		rounds.delete(ctx.mcpReq.signal);
		const { inputResponses } = ctx.mcpReq;
		const retry =
			round === undefined
				? {}
				: {
						...(round.state === undefined ? {} : { requestState: round.state }),
						...(inputResponses === undefined ? {} : { inputResponses }),
					};
		const downstream = {
			capabilities: passThrough(
				server.getClientCapabilities(),
				server.getNegotiatedProtocolVersion(),
			),
			clientInfo: server.getClientVersion() ?? BRIDGE,
		};
		try {
			const result = await call(method, { ...sent, ...retry }, downstream, ctx.mcpReq.signal);
			if (result.resultType === "input_required") {
				const state = typeof result.requestState === "string" ? result.requestState : undefined;
				rounds.set(ctx.mcpReq.signal, { state });
			}
			return legacyResult(result);
		} catch (error) {
			// Only a retry carries the hub's state, so a refusal here means the answer came too late.
			if (round?.state === undefined || !refusedState(error)) throw error;
			if (method === "tools/call")
				return { content: [{ type: "text", text: EXPIRED }], isError: true };
			throw new ProtocolError(ProtocolErrorCode.InvalidParams, EXPIRED, {
				reason: STATE_REFUSED,
			});
		}
	};
	const register = server.setRequestHandler.bind(server) as (
		method: string,
		handler: (request: { params?: Json }, ctx: ServerContext) => Promise<Json>,
	) => void;
	for (const [capability, methods] of Object.entries(RELAYED)) {
		if (!isObject(capabilities[capability as keyof ServerCapabilities])) continue;
		for (const method of methods) {
			if (isChecked(method)) {
				server.setRequestHandler(method, { params: AS_SENT }, (params, ctx) => {
					checkParams(method, params);
					return relay(method, params, ctx);
				});
			} else {
				register(method, (request, ctx) => relay(method, request.params ?? {}, ctx));
			}
		}
	}
	return server;
}

// Serves one 2025 client on `transport`, once the hub has said what it serves.
export async function startBridge(transport: Transport, options: BridgeOptions): Promise<Server> {
	const server = await createBridge(options);
	const send = transport.send.bind(transport);
	transport.send = (message, sendOptions) => send(legacyNotFound(message), sendOptions);
	await server.connect(transport);
	return server;
}

// This machine only: the bridge sends its agent token over plain HTTP.
function isLocalHub(url: string): boolean {
	const parsed = URL.parse(url);
	return (
		parsed?.protocol === "http:" &&
		["127.0.0.1", "[::1]"].includes(parsed.hostname) &&
		parsed.username === "" &&
		parsed.password === ""
	);
}

// RFC 6750's b64token, the only form a Bearer credential takes.
const B64TOKEN = /^[\w.~+/-]+=*$/;

if (import.meta.main) {
	const url = process.argv[2] ?? "";
	const token = (process.env.DRAFTYAK_TOKEN ?? "").trim();
	if (!isLocalHub(url) || !B64TOKEN.test(token)) {
		process.stderr.write(
			"usage: DRAFTYAK_TOKEN=<agent token> node bridge.ts http://127.0.0.1:<port>/mcp\n",
		);
		process.exit(2);
	}
	try {
		const server = await startBridge(new StdioServerTransport(), { hub: { url, token } });
		server.onclose = () => process.exit(0);
	} catch (error) {
		// Only the bridge's own words: an exception's text can quote what it was given.
		const reason =
			error instanceof HubUnavailable
				? error.message
				: error instanceof ProtocolError
					? `The DraftYak hub refused the bridge's server/discover request (error ${error.code}).`
					: "The bridge couldn't start.";
		process.stderr.write(`draftyak bridge: ${reason}\n`);
		process.exit(1);
	}
}
