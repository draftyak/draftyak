import { createHash } from "node:crypto";
import { Hono } from "hono";
import { type Clock, createFaults } from "./faults.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";
import { rawTarget, splitTarget } from "./target.ts";

export const GOOGLE_OAUTH_HOST = "google-oauth.draftyak.example";
export const GOOGLE_OAUTH_CLIENT_ID = "DYTEST-google-desktop";
export const GOOGLE_OAUTH_REDIRECT_URI = "http://127.0.0.1:54321/oauth/google/callback";

export interface GoogleOAuthClient {
	readonly clientId: string;
	readonly clientSecret?: string;
	/** Exact registered loopback callback URIs; no wildcard matching. */
	readonly redirectUris: readonly string[];
}

export type GoogleOAuthConsent =
	| { readonly kind: "grant"; readonly scopes?: readonly string[] }
	/** Deliberately hostile returned scopes for caller-refusal scenarios, never normal consent. */
	| { readonly kind: "unexpected-grant"; readonly scopes: readonly string[] }
	| { readonly kind: "deny" };

export interface GoogleOAuthTokenError {
	readonly error: "invalid_grant" | "invalid_client" | "temporarily_unavailable";
	/** Absent means the next client-authenticated token request of either grant kind. */
	readonly grantType?: "authorization_code" | "refresh_token";
}

export interface GoogleOAuthOptions {
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	readonly clients?: readonly GoogleOAuthClient[];
	readonly codeTtlMs?: number;
	readonly accessTtlSeconds?: number;
	/** Optional fixture expiry, e.g. seven days for a Testing-mode scenario. */
	readonly refreshTtlSeconds?: number;
	/** A synthetic test policy, true by default; not a claim about Google's defaults. */
	readonly rotateRefreshTokens?: boolean;
}

export interface GoogleOAuthGrant {
	readonly clientId: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number;
}

export interface GoogleOAuthFake extends Fake {
	readonly endpoints: {
		readonly authorization: string;
		readonly token: string;
		readonly revocation: string;
	};
	/** Queues granular-consent results; an empty scope list can exercise caller refusal. */
	enqueueConsent(...steps: readonly GoogleOAuthConsent[]): void;
	/** Scripts a client-authenticated grant request, without consuming or rotating its token. */
	enqueueTokenError(...steps: readonly GoogleOAuthTokenError[]): void;
	/** Fixture-side validation for a Gmail fake, never a production authorization API. */
	accessGrant(token: string): GoogleOAuthGrant | undefined;
	/** Revokes this client's existing authorization, including previous consents. */
	revoke(token: string): boolean;
}

interface Authorization {
	revoked: boolean;
}
interface Code {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly challenge: string;
	readonly scopes: readonly string[];
	readonly offline: boolean;
	readonly expiresAt: number;
	readonly authorization: Authorization;
}
interface Token extends GoogleOAuthGrant {
	readonly kind: "access" | "refresh";
	readonly authorization: Authorization;
	active: boolean;
}

const MAX_ENTRIES = 4_096;
const MAX_QUEUE = 256;
const MAX_FORM = 16_384;
const LONG_NAMES: Readonly<Record<string, string>> = {
	email: "https://www.googleapis.com/auth/userinfo.email",
	profile: "https://www.googleapis.com/auth/userinfo.profile",
};

function normalizeScope(scope: string): string {
	return Object.hasOwn(LONG_NAMES, scope) ? (LONG_NAMES[scope] ?? scope) : scope;
}

function text(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		/^[!-~]+$/.exec(value)?.[0] === value
	);
}

function scopes(value: string): string[] | undefined {
	const list = value.split(" ");
	return value.length <= 2_048 && list.length <= 16 && list.every((s) => text(s, 256))
		? [...new Set(list)]
		: undefined;
}

function scopeList(input: readonly string[]): string[] {
	if (!Array.isArray(input) || input.length > 16 || input.some((s) => !text(s, 256))) {
		throw new TypeError("Google OAuth fake scopes are invalid");
	}
	return [...new Set(input)];
}

function redirectUri(value: string): boolean {
	// The fake only redirects to an explicitly registered numeric loopback callback.
	if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/[^?#\s\\]*$/.test(value)) return false;
	try {
		const url = new URL(value);
		return Number(url.port) <= 65_535 && url.href === value;
	} catch {
		return false;
	}
}

function positive(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 31_536_000) {
		throw new RangeError(`Google OAuth fake ${name} is invalid`);
	}
	return value;
}

function params(value: string): URLSearchParams | undefined {
	if (Buffer.byteLength(value) > MAX_FORM) return;
	try {
		// URLSearchParams alone replaces malformed percent-encoded UTF-8 with U+FFFD.
		decodeURIComponent(value.replaceAll("+", " "));
	} catch {
		return;
	}
	const result = new URLSearchParams(value);
	const names = [...result.keys()];
	if (names.length > 32 || new Set(names).size !== names.length) return;
	return result;
}

function answer(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store", pragma: "no-cache" },
	});
}

/** Deterministic offline fixture, not a Google emulator or an OAuth security authority. */
export function createGoogleOAuthFake(options: GoogleOAuthOptions = {}): GoogleOAuthFake {
	const codeTtlMs = positive(options.codeTtlMs ?? 600_000, "codeTtlMs");
	const accessTtlSeconds = positive(options.accessTtlSeconds ?? 3_600, "accessTtlSeconds");
	const refreshTtlSeconds =
		options.refreshTtlSeconds === undefined
			? undefined
			: positive(options.refreshTtlSeconds, "refreshTtlSeconds");
	const rotate = options.rotateRefreshTokens ?? true;
	if (typeof rotate !== "boolean") throw new TypeError("Google OAuth fake rotation is invalid");
	const clients = new Map<string, GoogleOAuthClient>();
	const entries: readonly GoogleOAuthClient[] = options.clients ?? [
		{ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
	];
	if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) {
		throw new RangeError("Google OAuth fake client count is invalid");
	}
	for (const client of entries) {
		if (
			!text(client.clientId, 512) ||
			clients.has(client.clientId) ||
			(client.clientSecret !== undefined && !text(client.clientSecret, 512)) ||
			!Array.isArray(client.redirectUris) ||
			client.redirectUris.length < 1 ||
			client.redirectUris.length > 16 ||
			client.redirectUris.some((uri: unknown) => typeof uri !== "string" || !redirectUri(uri))
		) {
			throw new TypeError("Google OAuth fake client is invalid");
		}
		clients.set(client.clientId, { ...client, redirectUris: [...client.redirectUris] });
	}
	const faults = createFaults({ clock: options.clock });
	const codes = new Map<string, Code>();
	const tokens = new Map<string, Token>();
	const authorizations = new Map<string, Authorization>();
	const consents: GoogleOAuthConsent[] = [];
	const errors: GoogleOAuthTokenError[] = [];
	let sequence = 0;
	const id = (kind: string): string => `DYTEST-${kind}-${String(++sequence).padStart(6, "0")}`;
	const current = (token: Token | undefined): token is Token =>
		token?.active === true && !token.authorization.revoked && faults.clock.now() < token.expiresAt;
	const invalidGrant = (): Response => answer({ error: "invalid_grant" }, 400);
	const invalidRequest = (): Response => answer({ error: "invalid_request" }, 400);
	function revoke(token: string): boolean {
		const entry = tokens.get(token);
		if (!entry || entry.authorization.revoked) return false;
		entry.authorization.revoked = true;
		return true;
	}
	function authorizationFor(clientId: string): Authorization {
		let authorization = authorizations.get(clientId);
		if (!authorization || authorization.revoked) {
			authorization = { revoked: false };
			authorizations.set(clientId, authorization);
		}
		return authorization;
	}
	function issue(
		kind: "access" | "refresh",
		base: Omit<Token, "kind" | "expiresAt" | "active">,
	): string {
		const token = id(kind);
		const ttl = kind === "access" ? accessTtlSeconds : refreshTtlSeconds;
		tokens.set(token, {
			...base,
			kind,
			active: true,
			expiresAt: ttl === undefined ? Infinity : faults.clock.now() + ttl * 1_000,
		});
		return token;
	}
	function tokenResponse(
		base: Omit<Token, "kind" | "expiresAt" | "active">,
		refresh: boolean,
	): Response {
		if (tokens.size + (refresh ? 2 : 1) > MAX_ENTRIES)
			return answer({ error: "temporarily_unavailable" }, 503);
		return answer({
			access_token: issue("access", base),
			token_type: "Bearer",
			expires_in: accessTtlSeconds,
			scope: base.scopes.map(normalizeScope).join(" "),
			...(refresh
				? {
						refresh_token: issue("refresh", base),
						...(refreshTtlSeconds === undefined
							? {}
							: { refresh_token_expires_in: refreshTtlSeconds }),
					}
				: {}),
		});
	}
	function authorize(query: URLSearchParams): Response {
		const client = clients.get(query.get("client_id") ?? "");
		const uri = query.get("redirect_uri") ?? "";
		if (!client?.redirectUris.includes(uri)) return invalidRequest();
		const state = query.get("state") ?? "";
		const challenge = query.get("code_challenge") ?? "";
		const requested = scopes(query.get("scope") ?? "");
		if (
			query.get("response_type") !== "code" ||
			query.get("code_challenge_method") !== "S256" ||
			challenge.length !== 43 ||
			!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
			!text(state, 512) ||
			!requested ||
			(query.has("access_type") && !["offline", "online"].includes(query.get("access_type") ?? ""))
		)
			return invalidRequest();
		const consent: GoogleOAuthConsent = consents[0] ?? { kind: "grant" };
		const granted = consent.kind === "deny" ? [] : (consent.scopes ?? requested);
		// Ordinary granular consent is a subset. Only the explicit hostile step can overgrant.
		if (
			consent.kind === "grant" &&
			granted.some(
				(scope) => !requested.some((entry) => normalizeScope(entry) === normalizeScope(scope)),
			)
		)
			return invalidRequest();
		if (consent.kind !== "deny" && codes.size >= MAX_ENTRIES)
			return answer({ error: "temporarily_unavailable" }, 503);
		consents.shift();
		const back = new URL(uri);
		back.searchParams.set("state", state);
		if (consent.kind === "deny") back.searchParams.set("error", "access_denied");
		else {
			const code = id("code");
			codes.set(code, {
				clientId: client.clientId,
				redirectUri: uri,
				challenge,
				scopes: [...granted],
				offline: query.get("access_type") === "offline",
				expiresAt: faults.clock.now() + codeTtlMs,
				authorization: authorizationFor(client.clientId),
			});
			back.searchParams.set("code", code);
			back.searchParams.set("scope", granted.map(normalizeScope).join(" "));
		}
		return new Response(null, {
			status: 302,
			headers: { location: back.href, "cache-control": "no-store" },
		});
	}
	function token(form: URLSearchParams): Response {
		const client = clients.get(form.get("client_id") ?? "");
		if (
			!client ||
			(client.clientSecret === undefined
				? form.has("client_secret")
				: form.get("client_secret") !== client.clientSecret)
		) {
			return answer({ error: "invalid_client" }, 401);
		}
		const grantType = form.get("grant_type");
		if (grantType !== "authorization_code" && grantType !== "refresh_token")
			return answer({ error: "unsupported_grant_type" }, 400);
		const errorIndex = errors.findIndex(
			(error) => error.grantType === undefined || error.grantType === grantType,
		);
		if (errorIndex !== -1) {
			const error = errors.splice(errorIndex, 1)[0];
			if (!error) throw new Error("Google OAuth fake error queue mismatch");
			return answer(
				{ error: error.error },
				error.error === "invalid_client"
					? 401
					: error.error === "temporarily_unavailable"
						? 503
						: 400,
			);
		}
		if (grantType === "authorization_code") {
			const key = form.get("code") ?? "";
			const pending = codes.get(key);
			codes.delete(key); // One authenticated exchange attempt, including a rejected binding.
			const verifier = form.get("code_verifier") ?? "";
			if (
				!pending ||
				pending.clientId !== client.clientId ||
				pending.authorization.revoked ||
				faults.clock.now() >= pending.expiresAt ||
				pending.redirectUri !== form.get("redirect_uri") ||
				verifier.length < 43 ||
				verifier.length > 128 ||
				/[^A-Za-z0-9._~-]/.test(verifier) ||
				createHash("sha256").update(verifier).digest("base64url") !== pending.challenge
			)
				return invalidGrant();
			return tokenResponse(
				{ clientId: client.clientId, scopes: pending.scopes, authorization: pending.authorization },
				pending.offline,
			);
		}
		const previous = tokens.get(form.get("refresh_token") ?? "");
		if (!current(previous) || previous.kind !== "refresh" || previous.clientId !== client.clientId)
			return invalidGrant();
		const result = tokenResponse(previous, rotate);
		if (result.ok && rotate) previous.active = false;
		return result;
	}
	const app = new Hono();
	app.onError((error) => {
		throw error;
	});
	app.all("*", async (context) => {
		const request = context.req.raw;
		const target = rawTarget(request);
		const { path, query } = splitTarget(target);
		if (target.includes("#")) return invalidRequest();
		if (request.method === "GET" && path === "/o/oauth2/v2/auth") {
			const parsed = params(query);
			return parsed ? authorize(parsed) : invalidRequest();
		}
		if (request.method !== "POST" || !["/token", "/revoke"].includes(path))
			return new Response(null, { status: 404 });
		if (query !== "") return invalidRequest();
		if (
			!/^\s*application\/x-www-form-urlencoded\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(
				request.headers.get("content-type") ?? "",
			)
		)
			return answer({ error: "invalid_request" }, 415);
		const reader = request.body?.getReader();
		if (!reader) return invalidRequest();
		let length = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const part = await reader.read();
				if (part.done) break;
				if (!(part.value instanceof Uint8Array)) {
					void reader.cancel().catch(() => {});
					return invalidRequest();
				}
				if (part.value.byteLength === 0) continue;
				length += part.value.byteLength;
				if (length > MAX_FORM) {
					// A redirect tee may retain another branch; cancellation must not await it.
					void reader.cancel().catch(() => {});
					return invalidRequest();
				}
				chunks.push(part.value);
			}
		} finally {
			reader.releaseLock();
		}
		let encoded: string;
		try {
			encoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
		} catch {
			return invalidRequest();
		}
		const form = params(encoded);
		if (!form) return invalidRequest();
		if (path === "/token") return token(form);
		const value = form.get("token");
		if (!text(value, 512)) return invalidRequest();
		return revoke(value) ? answer({}) : answer({ error: "invalid_token" }, 400);
	});
	const fake = createFake(app, {
		host: GOOGLE_OAUTH_HOST,
		faults,
		recorder: options.recorder,
		maxRequestBodyBytes: MAX_FORM,
	});
	return {
		...fake,
		endpoints: Object.freeze({
			authorization: `https://${GOOGLE_OAUTH_HOST}/o/oauth2/v2/auth`,
			token: `https://${GOOGLE_OAUTH_HOST}/token`,
			revocation: `https://${GOOGLE_OAUTH_HOST}/revoke`,
		}),
		enqueueConsent(...steps) {
			if (steps.length + consents.length > MAX_QUEUE)
				throw new RangeError("Google OAuth fake consent queue limit");
			const prepared = steps.map((step): GoogleOAuthConsent => {
				if (step.kind === "deny") return { kind: "deny" };
				if (step.kind === "unexpected-grant")
					return { kind: "unexpected-grant", scopes: scopeList(step.scopes) };
				if (step.kind !== "grant") throw new TypeError("Google OAuth fake consent is invalid");
				return {
					kind: "grant",
					...(step.scopes === undefined ? {} : { scopes: scopeList(step.scopes) }),
				};
			});
			consents.push(...prepared);
		},
		enqueueTokenError(...steps) {
			if (steps.length + errors.length > MAX_QUEUE)
				throw new RangeError("Google OAuth fake error queue limit");
			const prepared = steps.map((step): GoogleOAuthTokenError => {
				if (
					!["invalid_grant", "invalid_client", "temporarily_unavailable"].includes(step.error) ||
					(step.grantType !== undefined &&
						!["authorization_code", "refresh_token"].includes(step.grantType))
				)
					throw new TypeError("Google OAuth fake token error is invalid");
				return {
					error: step.error,
					...(step.grantType === undefined ? {} : { grantType: step.grantType }),
				};
			});
			errors.push(...prepared);
		},
		accessGrant(value) {
			const entry = tokens.get(value);
			return current(entry) && entry.kind === "access"
				? Object.freeze({
						clientId: entry.clientId,
						scopes: Object.freeze([...entry.scopes]),
						expiresAt: entry.expiresAt,
					})
				: undefined;
		},
		revoke,
	};
}
