import { parseStrict } from "@draftyak/protocol/jcs";
import { type McpParams, paramsDigest, snapshotMcpParams } from "@draftyak/protocol/mcp";
import { agentCredential } from "./credentials.ts";
import { LocalHttp } from "./http.ts";
import { type Message, object, requestId, type Transport } from "./wire.ts";

export const MODERN = "2026-07-28";
export const LEGACY: readonly string[] = Object.freeze(["2025-11-25", "2025-06-18", "2025-03-26"]);
export const VERSION = "io.modelcontextprotocol/protocolVersion";
export const CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const UI = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };
const METHODS = new Set([
	"server/discover",
	"tools/list",
	"tools/call",
	"prompts/list",
	"prompts/get",
	"resources/list",
	"resources/templates/list",
	"resources/read",
	"completion/complete",
	"ping",
]);
const NAMES: Readonly<Record<string, "name" | "uri">> = Object.freeze({
	"tools/call": "name",
	"prompts/get": "name",
	"resources/read": "uri",
});
const INFO = { name: "draftyak-bridge", version: "0.0.0" };
export interface BridgeOptions {
	readonly hub: { readonly url: string; readonly token: string };
}
export interface BridgeHandle {
	close(): Promise<void>;
}
class Refusal extends Error {
	readonly code: number;
	constructor(code: number = -32602) {
		super("DraftYak MCP request refused.");
		this.code = code;
	}
}
function header(value: string): string {
	if (!value.isWellFormed()) throw new Refusal();
	const encoded =
		/^[\x20-\x7e]*$/.test(value) && value === value.trim() && !/^=\?base64\?.*\?=$/.test(value)
			? value
			: `=?base64?${Buffer.from(value).toString("base64")}?=`;
	if (encoded.length > 8192) throw new Refusal();
	return encoded;
}
function capabilities(raw: unknown, revision: string): Record<string, unknown> {
	const elicitation = object(raw) ? raw.elicitation : undefined;
	const form =
		revision >= "2025-06-18" &&
		object(elicitation) &&
		(object(elicitation.form) || Object.keys(elicitation).length === 0);
	return form ? { elicitation: { form: {} }, extensions: UI } : { extensions: UI };
}
function modernParams(params: McpParams): McpParams {
	const meta = params._meta;
	if (!object(meta) || meta[VERSION] !== MODERN || !object(meta[CAPABILITIES])) throw new Refusal();
	const info = meta[CLIENT_INFO];
	if (
		info !== undefined &&
		(!object(info) || typeof info.name !== "string" || typeof info.version !== "string")
	)
		throw new Refusal();
	return snapshotMcpParams({
		...params,
		_meta: {
			[VERSION]: MODERN,
			[CAPABILITIES]: capabilities(meta[CAPABILITIES], MODERN),
			...(info === undefined ? {} : { [CLIENT_INFO]: info }),
		},
	});
}

/** A relay carries the existing credential; native token/current-authority checks stay at the hub. */
export async function startBridge(
	transport: Transport,
	options: BridgeOptions,
): Promise<BridgeHandle> {
	const token = agentCredential(options.hub.token);
	const http = new LocalHttp(options.hub.url);
	const shutdown = new AbortController();
	const active = new Map<string | number, AbortController>();
	const pending = new Map<string, { method: string; digest: string; deadline: number }>();
	let revision: string | undefined;
	let initialized = false;
	let closing = false;
	async function call(
		id: string | number,
		method: string,
		params: McpParams,
		version: string,
		signal: AbortSignal,
	): Promise<Message> {
		const field = NAMES[method];
		const name = field === undefined ? undefined : params[field];
		if (field !== undefined && typeof name !== "string") throw new Refusal();
		const headers = {
			"content-type": "application/json",
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"mcp-protocol-version": version,
			"mcp-method": method,
			...(typeof name === "string" ? { "mcp-name": header(name) } : {}),
		};
		const response = await http.post(
			headers,
			Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
			signal,
		);
		if (response.status === 401) throw new Refusal(-32603);
		const body = parseStrict(response.body);
		if (
			!object(body) ||
			body.jsonrpc !== "2.0" ||
			body.id !== id ||
			Object.hasOwn(body, "result") === Object.hasOwn(body, "error")
		)
			throw new Refusal(-32603);
		if (object(body.error)) {
			if (
				!Number.isSafeInteger(body.error.code) ||
				typeof body.error.message !== "string" ||
				body.error.message.length > 2000
			)
				throw new Refusal(-32603);
		} else if (response.status !== 200 || !object(body.result)) throw new Refusal(-32603);
		return body as unknown as Message;
	}
	const handle: BridgeHandle = {
		async close() {
			if (closing) return;
			closing = true;
			shutdown.abort();
			http.close();
			active.clear();
			pending.clear();
			await transport.close();
		},
	};
	try {
		const probe = await call(
			0,
			"server/discover",
			snapshotMcpParams({ _meta: { [VERSION]: MODERN, [CAPABILITIES]: {}, [CLIENT_INFO]: INFO } }),
			MODERN,
			shutdown.signal,
		);
		if (
			probe.error ||
			!object(probe.result) ||
			!Array.isArray(probe.result.supportedVersions) ||
			!probe.result.supportedVersions.includes(MODERN)
		)
			throw new Refusal(-32603);
		transport.onclose = () => {
			void handle.close();
		};
		transport.onmessage = (message) => {
			if (!requestId(message.id)) {
				if (
					message.method === "notifications/cancelled" &&
					object(message.params) &&
					requestId(message.params.requestId)
				) {
					active.get(message.params.requestId)?.abort();
				}
				return;
			}
			const id = message.id;
			const abort = new AbortController();
			active.set(id, abort);
			void (async () => {
				try {
					const method = message.method ?? "";
					let params = snapshotMcpParams(message.params ?? {});
					let retry = false;
					if (method === "initialize") {
						if (revision !== undefined || !LEGACY.includes(String(params.protocolVersion)))
							throw new Refusal();
						revision = String(params.protocolVersion);
						params = snapshotMcpParams({
							...params,
							capabilities: capabilities(params.capabilities, revision),
						});
					} else {
						if (!METHODS.has(method)) throw new Refusal(-32601);
						if (revision === undefined) {
							if (method !== "server/discover") throw new Refusal(-32600);
							revision = MODERN;
						}
						if (revision !== MODERN && !initialized) throw new Refusal(-32600);
					}
					if (revision === MODERN) {
						params = modernParams(params);
						for (const [state, value] of pending)
							if (performance.now() > value.deadline) pending.delete(state);
						if (params.requestState !== undefined) {
							if (typeof params.requestState !== "string") throw new Refusal();
							const state = pending.get(params.requestState);
							pending.delete(params.requestState);
							if (!state || state.method !== method || state.digest !== paramsDigest(params))
								throw new Refusal();
							retry = true;
						} else if (params.inputResponses !== undefined) throw new Refusal();
					} else if (params.requestState !== undefined || params.inputResponses !== undefined)
						throw new Refusal();
					const result = await call(
						id,
						method,
						params,
						revision,
						AbortSignal.any([shutdown.signal, abort.signal]),
					);
					if (method === "initialize") {
						if (!object(result.result) || result.result.protocolVersion !== revision)
							throw new Refusal(-32603);
						initialized = true;
					}
					if (object(result.result) && result.result.resultType === "input_required") {
						const state = result.result.requestState,
							requests = result.result.inputRequests;
						const declared = object(params._meta) ? params._meta[CAPABILITIES] : undefined;
						const form =
							object(declared) && object(declared.elicitation) && object(declared.elicitation.form);
						if (
							revision !== MODERN ||
							retry ||
							typeof state !== "string" ||
							state.length > 65_536 ||
							pending.size >= 5 ||
							pending.has(state) ||
							!form ||
							!object(requests) ||
							Object.values(requests).some(
								(value) =>
									!object(value) ||
									value.method !== "elicitation/create" ||
									!object(value.params) ||
									value.params.mode !== "form",
							)
						)
							throw new Refusal();
						pending.set(state, {
							method,
							digest: paramsDigest(params),
							deadline: performance.now() + 595_000,
						});
					}
					if (!abort.signal.aborted && !closing) await transport.send(result);
				} catch (error) {
					if (!abort.signal.aborted && !closing)
						await transport.send({
							jsonrpc: "2.0",
							id,
							error: {
								code: error instanceof Refusal ? error.code : -32603,
								message: "DraftYak MCP request refused.",
							},
						});
				} finally {
					active.delete(id);
					transport.release(id);
				}
			})().catch(() => {
				void handle.close();
			});
		};
		await transport.start();
		return handle;
	} catch {
		await handle.close();
		throw new Refusal(-32603);
	}
}
