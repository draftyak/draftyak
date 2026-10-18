import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { type ErrorFacts, headFacts, SiwcError } from "./errors.ts";
import { verifyIdToken } from "./id-token.ts";

// Sign in with ChatGPT for the hub, clean-room from OpenAI's public docs (notes/sources.md).

export const ISSUER = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const REGISTRATION_CLIENT = "dynamic_agent_client";
export const AGENT_NAME = "DraftYak";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES: readonly string[] =
	`openid profile email offline_access resource.invoke ${PLAN_SCOPE}`.split(" ");

export interface Endpoints {
	readonly issuer: string;
	readonly authorization: string;
	readonly token: string;
	readonly revocation: string;
	readonly jwks: string;
}

// Signing out drops the tokens and keeps the rest for the next sign-in.
export interface Registration {
	readonly issuer: string;
	readonly clientId: string;
	readonly subject: string;
	readonly email?: string;
	readonly hostId: string;
	readonly idTokenHint?: string;
}

export interface Tokens {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number;
	readonly earliestRefreshAt?: number;
	readonly savedAt: number;
}

export interface Credential extends Registration {
	readonly tokens: Tokens | null;
}

// A saved account, or only the client issued to an attempt whose code exchange failed.
export type KnownClient = Partial<Registration> & { readonly clientId: string };

export const planUsage = (credential: Credential): "enabled" | "disabled" =>
	credential.tokens?.scopes.includes(PLAN_SCOPE) ? "enabled" : "disabled";

export const newHostId = (): string => `urn:uuid:${randomUUID()}`;

// The docs' three formats; a UUIDv4 URN by default (the recommended RFC 9278 one is ADR 0009's call).
const HOST_ID =
	/^(?:urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}|did:key:z[1-9A-HJ-NP-Za-km-z]{20,200})$/;
export const isHostId = (value: unknown): value is string =>
	typeof value === "string" && HOST_ID.test(value);

const failed = (detail: string, extra: Record<string, unknown> = {}): SiwcError =>
	new SiwcError("SIGN_IN_FAILED", { detail, ...extra });

// Every endpoint must share the issuer's origin, so a tampered document can't redirect tokens.
export async function discover(issuer: string, fetcher: typeof fetch = fetch): Promise<Endpoints> {
	const response = await fetcher(`${issuer}/.well-known/openid-configuration`, {
		headers: { accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	}).catch(() => undefined);
	const doc = (await response?.json().catch(() => undefined)) as
		| Record<string, unknown>
		| undefined;
	if (!response?.ok || doc?.issuer !== issuer) throw failed("discovery: issuer");
	const endpoint = (name: string): string => {
		const value = doc[name];
		const sameOrigin = typeof value === "string" && URL.canParse(value);
		if (!sameOrigin || new URL(value).origin !== new URL(issuer).origin) {
			throw failed(`discovery: ${name}`);
		}
		return value;
	};
	return {
		issuer,
		authorization: endpoint("authorization_endpoint"),
		token: endpoint("token_endpoint"),
		revocation: endpoint("revocation_endpoint"),
		jwks: endpoint("jwks_uri"),
	};
}

export interface Attempt {
	readonly state: string;
	readonly nonce: string;
	readonly verifier: string;
	readonly challenge: string;
}

export function newAttempt(): Attempt {
	const verifier = randomBytes(32).toString("base64url");
	return {
		state: randomBytes(32).toString("base64url"),
		nonce: randomBytes(32).toString("base64url"),
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
	};
}

export interface AuthorizeRequest {
	readonly endpoint: string;
	readonly redirectUri: string;
	readonly hostId: string;
	readonly attempt: Attempt;
	readonly registration?: KnownClient;
	// Only the owner's explicit "use my ChatGPT plan" (Errors and recovery).
	readonly enablePlan?: boolean;
}

export function authorizationUrl(request: AuthorizeRequest): string {
	if (!isHostId(request.hostId)) throw new TypeError("authorizationUrl: not a documented host ID");
	const saved = request.registration;
	const optional = (name: string, value: string | false | undefined): [string, string][] =>
		value ? [[name, value]] : [];
	const params: [string, string][] = [
		["client_id", saved?.clientId ?? REGISTRATION_CLIENT],
		...optional("agent_name_hint", !saved && AGENT_NAME),
		["ext_agent_host_id", request.hostId],
		...optional("id_token_hint", saved?.idTokenHint),
		...optional("login_hint", saved?.email),
		["response_type", "code"],
		["redirect_uri", request.redirectUri],
		["scope", SCOPES.join(" ")],
		["resource", RESOURCE],
		["state", request.attempt.state],
		["nonce", request.attempt.nonce],
		["code_challenge_method", "S256"],
		["code_challenge", request.attempt.challenge],
		...optional("prompt", request.enablePlan && saved && "consent"),
	];
	const url = new URL(request.endpoint);
	for (const [name, value] of params) url.searchParams.append(name, value);
	return url.href;
}

export type CallbackResult =
	| { readonly kind: "code"; readonly code: string; readonly clientId?: string }
	| { readonly kind: "error"; readonly error: string };

export interface Listener {
	readonly redirectUri: string;
	readonly result: Promise<CallbackResult>;
	close(): void;
}

// Windows lets a loopback bind coexist with a wildcard listener, so a connect probe runs first.
const probe = (port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = connect({ host: CALLBACK_HOST, port, timeout: 1_000 });
		const done = (held: boolean): void => {
			socket.destroy();
			resolve(held);
		};
		// No answer within the timeout leaves the decision to the bind that follows.
		socket.once("connect", () => done(true)).once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});

const sameSecret = (a: string, b: string): boolean =>
	Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const PAGE_HEADERS = {
	"content-type": "text/plain; charset=utf-8",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	connection: "close",
};

export async function listenForCallback(
	state: string,
	options: { readonly port?: number; readonly timeoutMs?: number; readonly signal?: AbortSignal },
): Promise<Listener> {
	const port = options.port ?? CALLBACK_PORT;
	const inUse = (): SiwcError =>
		new SiwcError("PORT_IN_USE", { detail: `${CALLBACK_HOST}:${port}` });
	options.signal?.throwIfAborted();
	// Port 0 lets the OS pick, as the docs allow on reauthorization; a fixed port is probed first.
	if (port !== 0 && (await probe(port))) throw inUse();
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) =>
			reject(error.code === "EADDRINUSE" || error.code === "EACCES" ? inUse() : error),
		);
		server.listen({ host: CALLBACK_HOST, port, exclusive: true }, resolve);
	});
	const host = `${CALLBACK_HOST}:${(server.address() as AddressInfo).port}`;
	const { promise, resolve, reject } = Promise.withResolvers<CallbackResult>();
	promise.catch(() => {});
	const finish = (): void => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		if (server.listening) server.close();
		server.closeIdleConnections();
	};
	const stop = (detail: string) => (): void => {
		finish();
		reject(failed(detail));
	};
	const abort = stop("aborted");
	const timer = setTimeout(stop("timeout"), options.timeoutMs ?? 300_000);
	options.signal?.addEventListener("abort", abort, { once: true });
	const reply = (response: ServerResponse, status: number, text: string): void => {
		response.writeHead(status, PAGE_HEADERS).end(text);
	};
	server.on("request", (request, response) => {
		const url = new URL(request.url ?? "/", `http://${host}`);
		const ours = request.method === "GET" && request.headers.host === host;
		if (!ours || url.pathname !== CALLBACK_PATH) return reply(response, 404, "Not found.");
		if (!sameSecret(url.searchParams.get("state") ?? "", state)) {
			return reply(response, 400, "This sign-in doesn't belong to the one DraftYak started.");
		}
		const [error, code, clientId] = ["error", "code", "client_id"].map((name) =>
			url.searchParams.get(name),
		);
		finish();
		if (error || !code) {
			reply(response, 200, "Sign-in was cancelled. You can close this tab.");
			return resolve({ kind: "error", error: error || "no_code" });
		}
		reply(response, 200, "DraftYak received the sign-in. You can close this tab.");
		resolve({ kind: "code", code, ...(clientId ? { clientId } : {}) });
	});
	return { redirectUri: `http://${host}${CALLBACK_PATH}`, result: promise, close: stop("closed") };
}

export interface TokenResponse {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly idToken?: string;
	readonly scopes: readonly string[];
	readonly expiresIn: number;
	readonly earliestRefreshAt?: number;
}

const UNUSABLE = new Set(
	"invalid_grant invalid_refresh_token token_expired refresh_token_expired refresh_token_invalidated refresh_token_reused".split(
		" ",
	),
);

// The docs don't fix the shape: {"error": "x"} or {"error": {"code": "x"}}.
function oauthCode(body: Record<string, unknown>): string | undefined {
	const error = body.error;
	const code = typeof error === "string" ? error : (error as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : undefined;
}

// earliest_refresh_at's format is undocumented: Unix seconds or a date, else dropped.
const when = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isNaN(parsed) ? undefined : parsed;
};

export async function tokenRequest(
	endpoint: string,
	form: Readonly<Record<string, string>>,
	fetcher: typeof fetch = fetch,
): Promise<TokenResponse> {
	// A refresh that fails for a network or server reason keeps the tokens and backs off.
	const refresh = form.grant_type === "refresh_token";
	const later = (facts: ErrorFacts): SiwcError =>
		new SiwcError(refresh ? "UNAVAILABLE" : "SIGN_IN_FAILED", facts);
	const response = await fetcher(endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString(),
		redirect: "error",
		signal: AbortSignal.timeout(30_000),
	}).catch(() => {
		throw later({ detail: "token endpoint unreachable" });
	});
	const body = ((await response.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
	if (!response.ok) {
		const apiCode = oauthCode(body);
		const facts = { ...headFacts(response.status, response.headers), ...(apiCode && { apiCode }) };
		if (apiCode && UNUSABLE.has(apiCode) && refresh) throw new SiwcError("REAUTH_REQUIRED", facts);
		if (apiCode === "invalid_client") throw new SiwcError("INVALID_CLIENT", facts);
		throw response.status === 429 || response.status >= 500
			? later(facts)
			: new SiwcError("SIGN_IN_FAILED", facts);
	}
	const text = (name: string): string | undefined =>
		typeof body[name] === "string" && body[name] !== "" ? (body[name] as string) : undefined;
	const [accessToken, refreshToken, idToken] = ["access_token", "refresh_token", "id_token"].map(
		text,
	);
	const expiresIn = body.expires_in;
	const bearer = text("token_type")?.toLowerCase() === "bearer";
	if (!accessToken || !bearer || typeof expiresIn !== "number")
		throw failed("token response incomplete");
	const earliest = when(body.earliest_refresh_at);
	return {
		accessToken,
		...(refreshToken && { refreshToken }),
		...(idToken && { idToken }),
		scopes: (text("scope") ?? "").split(" ").filter((scope) => scope !== ""),
		expiresIn,
		...(earliest !== undefined && { earliestRefreshAt: earliest }),
	};
}

export interface SignInOptions {
	readonly hostId: string;
	// After invalid_grant, the next attempt keeps the issued client (Registration and sign-in, 3).
	readonly registration?: KnownClient;
	readonly enablePlan?: boolean;
	readonly openBrowser: (url: string) => void | Promise<void>;
	readonly endpoints?: Endpoints;
	readonly port?: number;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

// A grant without chatgpt.tokens.use.direct is kept with plan usage off (plan §4 step 3).
export async function signIn(options: SignInOptions): Promise<Credential> {
	const fetcher = options.fetch ?? fetch;
	const saved = options.registration;
	if (saved?.hostId !== undefined && saved.hostId !== options.hostId) {
		throw failed("host ID differs from the saved one");
	}
	const endpoints = options.endpoints ?? (await discover(ISSUER, fetcher));
	const attempt = newAttempt();
	const listener = await listenForCallback(attempt.state, options);
	let result: CallbackResult;
	try {
		await options.openBrowser(
			authorizationUrl({
				endpoint: endpoints.authorization,
				redirectUri: listener.redirectUri,
				hostId: options.hostId,
				attempt,
				...(saved && { registration: saved }),
				...(options.enablePlan && { enablePlan: true }),
			}),
		);
		result = await listener.result;
	} finally {
		listener.close();
	}
	const identifier = (value: string | undefined): string | undefined =>
		value && /^[\w.-]{1,200}$/.test(value) ? value : undefined;
	if (result.kind === "error") {
		throw failed("authorization refused", { apiCode: identifier(result.error) ?? "unknown" });
	}
	const clientId = identifier(saved?.clientId ?? result.clientId);
	if (!clientId || clientId === REGISTRATION_CLIENT) throw failed("registration incomplete");
	if (saved && result.clientId !== undefined && result.clientId !== saved.clientId) {
		throw failed("the callback named another client");
	}
	const form = {
		grant_type: "authorization_code",
		client_id: clientId,
		code: result.code,
		code_verifier: attempt.verifier,
		redirect_uri: listener.redirectUri,
		resource: RESOURCE,
	};
	const tokens = await tokenRequest(endpoints.token, form, fetcher).catch((error: unknown) => {
		throw error instanceof SiwcError
			? new SiwcError(error.code, { ...error.facts, clientId })
			: error;
	});
	if (!tokens.idToken) throw failed("token response incomplete");
	const identity = await verifyIdToken(tokens.idToken, {
		issuer: endpoints.issuer,
		jwksUri: endpoints.jwks,
		clientId,
		nonce: attempt.nonce,
		now: Date.now(),
		fetch: fetcher,
	});
	if (saved?.subject !== undefined && identity.subject !== saved.subject) {
		throw failed("another ChatGPT account signed in");
	}
	const savedAt = Date.now();
	const { idToken, refreshToken, accessToken, scopes, earliestRefreshAt } = tokens;
	return {
		issuer: endpoints.issuer,
		clientId,
		subject: identity.subject,
		...(identity.email && { email: identity.email }),
		hostId: options.hostId,
		idTokenHint: idToken,
		// Without offline_access there is nothing to refresh: the sign-in stays, plan usage off.
		tokens: refreshToken
			? {
					accessToken,
					refreshToken,
					scopes,
					expiresAt: savedAt + tokens.expiresIn * 1000,
					...(earliestRefreshAt !== undefined && { earliestRefreshAt }),
					savedAt,
				}
			: null,
	};
}
