import { createHash, hkdfSync, randomBytes } from "node:crypto";
import {
	type AuthInfo,
	CLIENT_CAPABILITIES_META_KEY,
	createRequestStateCodec,
	type InputRequest,
	inputRequired,
	ProtocolError,
	type RequestStateCodec,
	type ServerContext,
} from "@modelcontextprotocol/server";

export type Era = "legacy" | "modern";
export type Params = Readonly<Record<string, unknown>>;

// §6 Errors: DraftYak's app codes for resources, prompts and completion, each with data.code.
export const APP_ERRORS = {
	AGENT_SESSION_REQUIRED: 1001,
	SCOPE_REQUIRED: 1002,
	RATE_LIMITED: 1003,
} as const;

export function appError(
	name: keyof typeof APP_ERRORS,
	message: string,
	data: Record<string, unknown> = {},
): ProtocolError {
	return new ProtocolError(APP_ERRORS[name], message, { code: name, ...data });
}

const PRINCIPAL_ID = /^[A-Za-z0-9._-]{1,128}$/;

// §6 Agent principals: an MCP grant or an agent token, never the OAuth client alone (remote Claude
// Code installs share one client_id). The hub's token check names it in AuthInfo.extra as grantId
// or agentTokenId; a request naming neither, or both, is refused rather than served as a shared one.
export function principalId(authInfo: AuthInfo | undefined): string {
	const { grantId, agentTokenId } = authInfo?.extra ?? {};
	const named = Object.entries({ grant: grantId, token: agentTokenId }).filter(
		([, id]) => id !== undefined,
	);
	const [only, ...more] = named;
	if (!only || more.length > 0 || typeof only[1] !== "string" || !PRINCIPAL_ID.test(only[1])) {
		throw new Error("The request names no single MCP grant or agent token");
	}
	return `${only[0]}:${only[1]}`;
}

// RFC 8785 (JCS) for the JSON values a request carries: keys sorted by UTF-16 code units, numbers and
// strings in their ECMAScript JSON forms.
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const members = Object.entries(value)
			.filter(([, item]) => item !== undefined)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
		return `{${members.join(",")}}`;
	}
	if (typeof value === "number" && !Number.isFinite(value)) {
		throw new TypeError("JCS has no form for a non-finite number");
	}
	return JSON.stringify(value) ?? "null";
}

// §6 requestState: SHA-256 of JCS(params) without _meta, requestState and inputResponses.
export function paramsDigest(params: Params): string {
	const { _meta, requestState, inputResponses, ...salient } = params;
	return createHash("sha256").update(canonicalJson(salient)).digest("base64url");
}

// The SDK's own reading of a request's declared modes (a bare `elicitation: {}` means form), so an
// input request is built only where the SDK accepts it and -32021 never reaches the client.
export function declares(ctx: ServerContext, mode: "form" | "url"): boolean {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
	const declared = envelope[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
	const modes = declared?.elicitation;
	if (typeof modes !== "object" || modes === null || Array.isArray(modes)) return false;
	const { form, url } = modes as Record<string, unknown>;
	return mode === "url" ? url !== undefined : form !== undefined || url === undefined;
}

export const STATE_TTL_SECONDS = 600;
export const MAX_OPEN_PER_PRINCIPAL = 5;
export const STATE_KEY_LABEL = "draftyak/v1/mcp-state";

// The codec's wire form, "v1." body "." MAC, with the 32-byte MAC in canonical base64url: the SDK's
// decoder (atob) also takes other spellings of one MAC (spare low bits, whitespace, padding).
const STATE_FORM = /^v1\.[\w-]+\.[\w-]{43}$/;

// Ids only: the codec signs but doesn't encrypt, so the client can read every field. The principal is
// the grant or agent token id (grant:<id> or token:<id>).
export interface StatePayload {
	readonly v: 1;
	readonly epoch: number;
	readonly principal: string;
	readonly method: string;
	readonly digest: string;
	readonly pendingId: string;
	readonly exp: number;
}

interface Pending {
	readonly principal: string;
	readonly method: string;
	readonly digest: string;
	readonly exp: number;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const principalOf = (ctx: ServerContext): string => principalId(ctx.http?.authInfo);

// MRTR state: the SDK's HMAC-SHA256 codec under HKDF(MK, "draftyak/v1/mcp-state") with a 600 s TTL,
// bound to the principal, method and epoch, plus single-use pendingIds (mcp_pending).
export class Mrtr {
	epoch: number;
	readonly #codec: RequestStateCodec<StatePayload>;
	readonly #pending = new Map<string, Pending>();

	constructor(masterKey: Uint8Array, epoch = 1) {
		this.epoch = epoch;
		const key = new Uint8Array(
			hkdfSync("sha256", masterKey, new Uint8Array(0), STATE_KEY_LABEL, 32),
		);
		this.#codec = createRequestStateCodec<StatePayload>({
			key,
			ttlSeconds: STATE_TTL_SECONDS,
			bind: (ctx) => [principalOf(ctx), ctx.mcpReq.method, this.epoch].join("\0"),
		});
	}

	#openFor(principal: string): number {
		const now = nowSeconds();
		for (const [id, entry] of this.#pending) if (entry.exp < now) this.#pending.delete(id);
		return [...this.#pending.values()].filter((entry) => entry.principal === principal).length;
	}

	// A requestState for one round over the request's params as sent, or undefined once the principal
	// has 5 open.
	async mint(ctx: ServerContext, params: Params): Promise<string | undefined> {
		const principal = principalOf(ctx);
		if (this.#openFor(principal) >= MAX_OPEN_PER_PRINCIPAL) return undefined;
		const pendingId = randomBytes(16).toString("base64url");
		const entry = {
			principal,
			method: ctx.mcpReq.method,
			digest: paramsDigest(params),
			exp: nowSeconds() + STATE_TTL_SECONDS,
		};
		this.#pending.set(pendingId, entry);
		return this.#codec.mint({ v: 1, epoch: this.epoch, ...entry, pendingId }, ctx);
	}

	// ServerOptions.requestState.verify, the one place a retry's state is accepted. The SDK calls it for
	// every requestState a tools/call, prompts/get or resources/read carries, before any handler runs,
	// and answers a refusal with its frozen -32602 (the reason goes to onerror). Beyond the codec's MAC,
	// expiry and binding, the state must name an open pendingId minted on a 2026-era request for this
	// principal, method and params as sent; presenting it spends the pendingId either way.
	async resume(
		state: string,
		ctx: ServerContext,
		era: Era,
		params: Params | undefined,
	): Promise<StatePayload> {
		const mac = state.slice(state.lastIndexOf(".") + 1);
		if (!STATE_FORM.test(state) || Buffer.from(mac, "base64url").toString("base64url") !== mac) {
			throw new Error("malformed");
		}
		const payload = await this.#codec.verify(state, ctx);
		const id = typeof payload.pendingId === "string" ? payload.pendingId : "";
		const pending = this.#pending.get(id);
		this.#pending.delete(id);
		const expected = {
			principal: principalOf(ctx),
			method: ctx.mcpReq.method,
			digest: params === undefined ? undefined : paramsDigest(params),
		};
		const matches = (bound: Partial<Pending>): boolean =>
			bound.principal === expected.principal &&
			bound.method === expected.method &&
			bound.digest === expected.digest;
		if (pending === undefined || pending.exp < nowSeconds()) throw new Error("spent or unknown");
		if (era !== "modern") throw new Error("a 2025-era request has no rounds");
		if (payload.v !== 1 || payload.epoch !== this.epoch) throw new Error("version or epoch");
		if (!matches(payload) || !matches(pending)) throw new Error("another request's round");
		return payload;
	}
}

// §6 Fallback: the readable error for a missing agent session (resources: app error 1001).
export function sessionRequired(alias: string, toolClass: string): ProtocolError {
	return appError(
		"AGENT_SESSION_REQUIRED",
		`Approve an agent session for ${alias} (${toolClass}) on your paired desktop (DraftYak › AI apps › Sessions), then retry.`,
	);
}

// §6 Agent session pending: a fixed, static URL; the approval itself happens on the desktop.
export function sessionPrompt(
	alias: string,
	toolClass: string,
	publicBaseUrl: string,
): InputRequest {
	return inputRequired.elicitUrl({
		message: `Approve the agent session for ${alias} (${toolClass}) on your paired desktop, then continue`,
		url: `${publicBaseUrl}/status`,
	});
}
