import { createHash, timingSafeEqual } from "node:crypto";
import {
	type AuthInfo,
	hostHeaderValidationResponse,
	isJsonContentType,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { MiddlewareHandler } from "hono";

const FIRST_MODERN = "2026-07-28";
export const MODERN_VERSIONS: readonly string[] = [FIRST_MODERN];
export const LEGACY_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const MAX_BODY_BYTES: number = 1024 * 1024;
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_VERSION = -32022;

export interface Env {
	Variables: { body: unknown; principal: AuthInfo };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// Every error is a JSON-RPC error body (application/json), with the request's id when it has one.
export function rpcError(
	status: number,
	code: number,
	message: string,
	body?: unknown,
	data?: unknown,
	headers?: Record<string, string>,
): Response {
	const id = isObject(body) && ["string", "number"].includes(typeof body.id) ? body.id : null;
	const error = { code, message, ...(data === undefined ? {} : { data }) };
	return Response.json({ jsonrpc: "2.0", error, id }, { status, headers });
}

// 1. Loopback Host only; Origin absent or loopback (DNS rebinding).
export const hostOrigin: MiddlewareHandler<Env> = async (c, next) => {
	const rejected =
		hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames()) ??
		originValidationResponse(c.req.raw, localhostAllowedOrigins());
	if (rejected) return rejected;
	await next();
};

async function readCapped(request: Request, max: number): Promise<string | undefined> {
	if (Number(request.headers.get("content-length")) > max) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of request.body ?? []) {
		size += chunk.byteLength;
		if (size > max) return undefined;
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

// 2. The body is read here, capped at 1 MiB (the SDK caps no supplied parsedBody), and parsed once.
export const bodyCap: MiddlewareHandler<Env> = async (c, next) => {
	if (c.req.method !== "POST") return next();
	if (!isJsonContentType(c.req.header("content-type") ?? null)) {
		return rpcError(415, -32000, "Unsupported Media Type: Content-Type must be application/json");
	}
	const text = await readCapped(c.req.raw, MAX_BODY_BYTES);
	if (text === undefined) {
		return rpcError(413, -32000, `Payload Too Large: the body is over ${MAX_BODY_BYTES} bytes`);
	}
	try {
		c.set("body", JSON.parse(text));
	} catch {
		return rpcError(400, -32700, "Parse error: the body is not valid JSON");
	}
	await next();
};

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// SEP-2243's =?base64?…?= sentinel; undefined for bad Base64 or bytes that aren't UTF-8.
export function decodeSentinel(value: string): string | undefined {
	const payload = /^=\?base64\?(.*)\?=$/s.exec(value)?.[1];
	if (payload === undefined) return value;
	if (!CANONICAL_BASE64.test(payload)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(payload, "base64"));
	} catch {
		return undefined;
	}
}

const claimOf = (body: Json): unknown =>
	isObject(body.params) && isObject(body.params._meta)
		? body.params._meta[PROTOCOL_VERSION_META_KEY]
		: undefined;
// Body-primary, as the SDK classifies: an envelope claim, else a header naming 2026-07-28 or later.
const isModern = (header: string | undefined, body: Json): boolean =>
	claimOf(body) !== undefined || (header !== undefined && header >= FIRST_MODERN);
const NAME_SOURCE: Readonly<Record<string, "name" | "uri">> = {
	"tools/call": "name",
	"prompts/get": "name",
	"resources/read": "uri",
};

// 3. 2026-era headers match the body: MCP-Protocol-Version, Mcp-Method, Mcp-Name (decoded).
// Header values need no trimming here: Fetch Headers already drop surrounding whitespace (OWS).
export const headerMatch: MiddlewareHandler<Env> = async (c, next) => {
	const body = c.get("body");
	const version = c.req.header("mcp-protocol-version");
	if (!isObject(body) || typeof body.method !== "string" || !isModern(version, body)) return next();
	const isRequest = "id" in body;
	const mismatch = (header: string, problem: string): Response =>
		rpcError(400, HEADER_MISMATCH, `Bad Request: ${header} ${problem}`, body, { header });
	const claim = claimOf(body);
	if (isRequest && version === undefined) return mismatch("MCP-Protocol-Version", "is missing");
	if (typeof claim === "string" && version !== undefined && version !== claim) {
		return mismatch("MCP-Protocol-Version", "differs from the body's protocol version");
	}
	const method = c.req.header("mcp-method");
	if (method === undefined ? isRequest : method !== body.method) {
		return mismatch("Mcp-Method", method === undefined ? "is missing" : "differs from the method");
	}
	const field = Object.hasOwn(NAME_SOURCE, body.method) ? NAME_SOURCE[body.method] : undefined;
	if (isRequest && field !== undefined) {
		const raw = c.req.header("mcp-name");
		const name = raw === undefined ? undefined : decodeSentinel(raw);
		const expected = isObject(body.params) ? body.params[field] : undefined;
		if (raw === undefined) return mismatch("Mcp-Name", "is missing");
		if (name === undefined) return mismatch("Mcp-Name", "has a bad Base64 sentinel");
		if (name !== expected) return mismatch("Mcp-Name", `differs from params.${field}`);
	}
	await next();
};

// 4. Only the protocol versions this hub serves, per era.
export const versionAllowlist: MiddlewareHandler<Env> = async (c, next) => {
	if (c.req.method !== "POST") return next();
	const body = c.get("body");
	const header = c.req.header("mcp-protocol-version");
	const claim = isObject(body) ? claimOf(body) : undefined;
	const allowed = isObject(body) && isModern(header, body) ? MODERN_VERSIONS : LEGACY_VERSIONS;
	for (const requested of [header, typeof claim === "string" ? claim : undefined]) {
		if (requested !== undefined && !allowed.includes(requested)) {
			const message = `Unsupported protocol version ${requested}; supported: ${allowed.join(", ")}`;
			return rpcError(400, UNSUPPORTED_VERSION, message, body, { supported: allowed, requested });
		}
	}
	await next();
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

// 5. A stub principal: one fixed agent identity, optionally behind a bearer token.
export function principal(token?: string): MiddlewareHandler<Env> {
	return async (c, next) => {
		const given = c.req.header("authorization") ?? "";
		if (token !== undefined && !timingSafeEqual(digest(given), digest(`Bearer ${token}`))) {
			const headers = { "WWW-Authenticate": 'Bearer error="invalid_token"' };
			return Response.json({ error: "invalid_token" }, { status: 401, headers });
		}
		const resource = new URL(c.req.path, c.req.url);
		c.set("principal", {
			token: token ?? "",
			clientId: "stub-agent",
			scopes: ["inbox:read"],
			resource,
		});
		await next();
	};
}
