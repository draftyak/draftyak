import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

// Google OAuth for the owner's own Desktop client (guardrail 5): the system browser, a loopback
// redirect on a random port and PKCE S256. The client ID and secret come from the owner at run
// time (.env.live in M0.29) and never from the repository.

export interface OAuthEndpoints {
	readonly authorization: string;
	readonly token: string;
	readonly revocation: string;
}

export const GOOGLE: OAuthEndpoints = {
	authorization: "https://accounts.google.com/o/oauth2/v2/auth",
	token: "https://oauth2.googleapis.com/token",
	revocation: "https://oauth2.googleapis.com/revoke",
};

const GMAIL = "https://www.googleapis.com/auth/gmail.";
export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export type Mode = "full" | "read_only";

export function scopesFor(mode: Mode): readonly string[] {
	return ["openid", "email", mode === "full" ? GMAIL_MODIFY : GMAIL_READONLY];
}

// The Gmail scopes a grant may carry in each mode: every method that takes one also takes the
// mode's own scope in the discovery document (the tests check it), so none reaches further.
export const WITHIN: Readonly<Record<Mode, readonly string[]>> = {
	full: ["modify", "readonly", "metadata", "labels", "compose", "send", "insert"].map(
		(name) => GMAIL + name,
	),
	read_only: [GMAIL_READONLY, `${GMAIL}metadata`],
};

export class OAuthError extends Error {
	readonly code: string;

	constructor(code: string, detail?: string) {
		super(`oauth: ${code}${detail === undefined ? "" : ` (${detail})`}`);
		this.name = "OAuthError";
		this.code = code;
	}
}

export interface ScopeCheck {
	readonly ok: boolean;
	readonly missing: readonly string[];
	readonly extra: readonly string[];
}

export class ScopeError extends OAuthError {
	readonly check: ScopeCheck;
	// false: Google didn't confirm the revocation, so the grant may still be live.
	readonly revoked: boolean;

	constructor(check: ScopeCheck, revoked: boolean) {
		const code = check.missing.length > 0 ? "scope_missing" : "scope_too_broad";
		const scopes = [...check.missing, ...check.extra].join(" ");
		super(code, `${scopes}; ${revoked ? "revoked" : "not revoked"}`);
		this.name = "ScopeError";
		this.check = check;
		this.revoked = revoked;
	}
}

// Google reports the sign-in scopes by their long names.
const SIGN_IN: Readonly<Record<string, string>> = {
	"https://www.googleapis.com/auth/userinfo.email": "email",
	"https://www.googleapis.com/auth/userinfo.profile": "profile",
};

const isGmailScope = (scope: string): boolean =>
	scope === "https://mail.google.com/" || scope.startsWith(GMAIL);

// Granular consent lets the owner untick gmail.modify, which fails the connection; a Gmail scope
// outside WITHIN (mail.google.com/, gmail.settings.*, or gmail.modify in read-only mode) fails it
// too.
export function checkScopes(granted: string, mode: Mode): ScopeCheck {
	const have = new Set(granted.split(/\s+/).filter((scope) => scope !== ""));
	const names = new Set([...have].map((scope) => SIGN_IN[scope] ?? scope));
	const missing = scopesFor(mode).filter((scope) => !names.has(scope));
	const extra = [...names]
		.filter((scope) => isGmailScope(scope) && !WITHIN[mode].includes(scope))
		.toSorted();
	return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

export interface Pkce {
	readonly verifier: string;
	readonly challenge: string;
}

// A 43-character verifier from 32 random bytes and its S256 challenge (RFC 7636).
export function newPkce(): Pkce {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthorizationRequest {
	readonly endpoint: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly scopes: readonly string[];
	readonly state: string;
	readonly challenge: string;
	readonly loginHint?: string;
	// "offline" asks for a refresh token explicitly, as Google's Desktop quickstarts do.
	readonly accessType?: "offline";
}

export function authorizationUrl(request: AuthorizationRequest): string {
	const url = new URL(request.endpoint);
	const params: Record<string, string> = {
		client_id: request.clientId,
		redirect_uri: request.redirectUri,
		response_type: "code",
		scope: request.scopes.join(" "),
		state: request.state,
		code_challenge: request.challenge,
		code_challenge_method: "S256",
		...(request.loginHint === undefined ? {} : { login_hint: request.loginHint }),
		...(request.accessType === undefined ? {} : { access_type: request.accessType }),
	};
	for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
	return url.href;
}

function sameSecret(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export interface Loopback {
	readonly redirectUri: string;
	readonly code: Promise<string>;
	close(): void;
}

// A one-shot listener on 127.0.0.1 for the redirect: only GET / with our Host and state counts.
export async function listenLoopback(
	state: string,
	options: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<Loopback> {
	if (options.signal?.aborted) throw new OAuthError("aborted");
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
	});
	const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
	const { promise: code, resolve, reject } = Promise.withResolvers<string>();
	code.catch(() => {});
	let timer: NodeJS.Timeout | undefined;
	const abort = (): void => fail(new OAuthError("aborted"));
	const close = (): void => {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		if (server.listening) server.close();
	};
	const fail = (error: OAuthError): void => {
		close();
		reject(error);
	};
	timer = setTimeout(() => fail(new OAuthError("timeout")), options.timeoutMs ?? 300_000);
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	server.on("request", (request, response) => {
		const reply = (status: number, text: string): void => {
			response.writeHead(status, {
				"content-type": "text/plain; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				connection: "close",
			});
			response.end(text);
		};
		const url = new URL(request.url ?? "/", `http://${host}`);
		if (request.method !== "GET" || request.headers.host !== host || url.pathname !== "/") {
			reply(404, "Not found.");
			return;
		}
		if (!sameSecret(url.searchParams.get("state") ?? "", state)) {
			reply(400, "This sign-in doesn't belong to the one DraftYak started.");
			return;
		}
		const value = url.searchParams.get("code");
		const error = url.searchParams.get("error");
		if (error !== null || value === null || value === "") {
			reply(400, "Sign-in was refused or cancelled. You can close this tab.");
			fail(new OAuthError(error ?? "no_code"));
			return;
		}
		reply(200, "DraftYak received the sign-in. You can close this tab.");
		close();
		resolve(value);
	});
	return { redirectUri: `http://${host}`, code, close: () => fail(new OAuthError("closed")) };
}

export interface TokenSet {
	readonly accessToken: string;
	readonly refreshToken?: string;
	readonly expiresAt: number;
	readonly scope: string;
}

export interface TokenClient {
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly endpoints?: OAuthEndpoints;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
}

async function post(
	client: TokenClient,
	url: string,
	form: Record<string, string>,
): Promise<Response> {
	try {
		return await (client.fetch ?? fetch)(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams(form).toString(),
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		});
	} catch (error) {
		throw new OAuthError("network", error instanceof Error ? error.name : undefined);
	}
}

// Error codes only: a token never appears in an error.
async function tokenRequest(client: TokenClient, form: Record<string, string>): Promise<TokenSet> {
	const body: Record<string, string> = { client_id: client.clientId, ...form };
	if (client.clientSecret !== undefined) body.client_secret = client.clientSecret;
	const response = await post(client, (client.endpoints ?? GOOGLE).token, body);
	const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	const text = (key: string): string | undefined =>
		typeof json[key] === "string" ? (json[key] as string) : undefined;
	if (!response.ok) throw new OAuthError(text("error") ?? `http_${response.status}`);
	const accessToken = text("access_token");
	if (accessToken === undefined || text("token_type")?.toLowerCase() !== "bearer") {
		throw new OAuthError("bad_token_response");
	}
	const refreshToken = text("refresh_token");
	return {
		accessToken,
		...(refreshToken === undefined ? {} : { refreshToken }),
		expiresAt: (client.now ?? Date.now)() + Number(json.expires_in ?? 0) * 1000,
		scope: text("scope") ?? "",
	};
}

export function exchangeCode(
	client: TokenClient,
	grant: { readonly code: string; readonly verifier: string; readonly redirectUri: string },
): Promise<TokenSet> {
	return tokenRequest(client, {
		grant_type: "authorization_code",
		code: grant.code,
		code_verifier: grant.verifier,
		redirect_uri: grant.redirectUri,
	});
}

// invalid_grant here is the plan's credential_lost: the 30-day deletion deadline starts.
export function refreshTokens(client: TokenClient, refreshToken: string): Promise<TokenSet> {
	return tokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function revokeToken(client: TokenClient, token: string): Promise<boolean> {
	return (await post(client, (client.endpoints ?? GOOGLE).revocation, { token })).ok;
}

// The system browser, never a webview; spawned without a shell. Windows looks for a bare program
// name in the working directory first, so rundll32.exe goes by its full path.
export function browserCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
): { readonly command: string; readonly args: readonly string[] } {
	const { href, protocol } = new URL(url);
	if (protocol !== "https:") throw new OAuthError("not_https");
	if (platform === "win32") {
		const root = process.env.SystemRoot ?? "";
		const windows = path.win32.isAbsolute(root) ? root : "C:\\Windows";
		const rundll32 = path.win32.join(windows, "System32", "rundll32.exe");
		return { command: rundll32, args: ["url.dll,FileProtocolHandler", href] };
	}
	if (platform === "darwin") return { command: "/usr/bin/open", args: [href] };
	return { command: "xdg-open", args: [href] };
}

export function openSystemBrowser(url: string): void {
	const { command, args } = browserCommand(url);
	spawn(command, args, { detached: true, stdio: "ignore" })
		.once("error", () => {})
		.unref();
}

export interface ConnectOptions extends TokenClient {
	readonly mode?: Mode;
	readonly openBrowser?: (url: string) => void | Promise<void>;
	readonly loginHint?: string;
	readonly accessType?: "offline";
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

// The whole flow; a grant that fails the scope check is revoked at once and never kept. Google's
// revoke ends the account's whole grant to this client, tokens from earlier consents included.
export async function connect(options: ConnectOptions): Promise<TokenSet> {
	const mode = options.mode ?? "full";
	const pkce = newPkce();
	const state = randomBytes(32).toString("base64url");
	const loopback = await listenLoopback(state, options);
	try {
		if (options.signal?.aborted) throw new OAuthError("aborted");
		await (options.openBrowser ?? openSystemBrowser)(
			authorizationUrl({
				endpoint: (options.endpoints ?? GOOGLE).authorization,
				clientId: options.clientId,
				redirectUri: loopback.redirectUri,
				scopes: scopesFor(mode),
				state,
				challenge: pkce.challenge,
				...(options.loginHint === undefined ? {} : { loginHint: options.loginHint }),
				...(options.accessType === undefined ? {} : { accessType: options.accessType }),
			}),
		);
		const code = await loopback.code;
		const tokens = await exchangeCode(options, {
			code,
			verifier: pkce.verifier,
			redirectUri: loopback.redirectUri,
		});
		const check = checkScopes(tokens.scope, mode);
		if (!check.ok) {
			const revoke = (): Promise<boolean> =>
				revokeToken(options, tokens.refreshToken ?? tokens.accessToken).catch(() => false);
			throw new ScopeError(check, (await revoke()) || (await revoke()));
		}
		return tokens;
	} finally {
		loopback.close();
	}
}

// Testing-mode grants, refresh tokens included, end 7 days after consent, so a scheduled Gmail
// item due later than that can't send on the grant (plan §3 Limits; the composer warns).
export const TESTING_GRANT_MS: number = 7 * 24 * 60 * 60 * 1000;

export function grantCovers(
	status: "testing" | "production",
	consentedAt: number,
	deliverBy: number,
): boolean {
	return status === "production" || deliverBy <= consentedAt + TESTING_GRANT_MS;
}
