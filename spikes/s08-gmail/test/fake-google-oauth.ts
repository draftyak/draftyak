import { createHash, randomBytes } from "node:crypto";
import type { OAuthEndpoints } from "../src/oauth.ts";
import { json, type Served, serve } from "./serve.ts";

// Google's long names for the sign-in scopes, as its token endpoint reports them.
const LONG_NAMES: Readonly<Record<string, string>> = {
	email: "https://www.googleapis.com/auth/userinfo.email",
	profile: "https://www.googleapis.com/auth/userinfo.profile",
};

export interface Grant {
	readonly scopes: readonly string[];
	readonly authorization: { revoked: boolean };
}

// Tokens shared by the fake OAuth server and the fake Gmail API, for one client and one account.
// As at Google, every consent joins the account's one authorization of the client, and revoking
// any token ends it all, tokens from earlier consents included; the next consent starts afresh.
export class TokenRegistry {
	readonly #tokens = new Map<string, { grant: Grant; kind: "access" | "refresh" }>();
	#authorization = { revoked: false };

	grant(scopes: readonly string[]): { accessToken: string; refreshToken: string } {
		if (this.#authorization.revoked) this.#authorization = { revoked: false };
		const grant: Grant = { scopes, authorization: this.#authorization };
		return { accessToken: this.issue(grant, "access"), refreshToken: this.issue(grant, "refresh") };
	}

	issue(grant: Grant, kind: "access" | "refresh"): string {
		const token = `fake-${kind}-${randomBytes(18).toString("base64url")}`;
		this.#tokens.set(token, { grant, kind });
		return token;
	}

	lookup(token: string, kind: "access" | "refresh"): Grant | undefined {
		const entry = this.#tokens.get(token);
		return entry?.kind === kind && !entry.grant.authorization.revoked ? entry.grant : undefined;
	}

	revoke(token: string): boolean {
		const entry = this.#tokens.get(token);
		if (entry === undefined || entry.grant.authorization.revoked) return false;
		entry.grant.authorization.revoked = true;
		return true;
	}
}

export interface FakeOAuthOptions {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly tokens: TokenRegistry;
	// What the owner leaves ticked on the consent screen (granular consent).
	readonly consent?: (requested: readonly string[]) => readonly string[] | "deny";
}

interface PendingCode {
	readonly redirectUri: string;
	readonly challenge: string;
	readonly scopes: readonly string[];
	used: boolean;
}

export interface FakeOAuth extends Served {
	readonly endpoints: OAuthEndpoints;
	readonly problems: string[];
	readonly authorizations: URLSearchParams[];
	readonly revocations: string[];
}

const LOOPBACK_REDIRECT = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d{1,5}$/;

export async function startFakeOAuth(options: FakeOAuthOptions): Promise<FakeOAuth> {
	const codes = new Map<string, PendingCode>();
	const problems: string[] = [];
	const authorizations: URLSearchParams[] = [];
	const revocations: string[] = [];
	const refuse = (problem: string): Response => {
		problems.push(problem);
		return new Response(`400. That's an error. ${problem}`, { status: 400 });
	};

	function authorize(url: URL): Response {
		const params = url.searchParams;
		authorizations.push(params);
		if (params.get("client_id") !== options.clientId) return refuse("unknown client_id");
		const redirectUri = params.get("redirect_uri") ?? "";
		if (!LOOPBACK_REDIRECT.test(redirectUri)) return refuse("redirect_uri is not a loopback IP");
		if (params.get("response_type") !== "code") return refuse("response_type");
		if (params.get("code_challenge_method") !== "S256") return refuse("code_challenge_method");
		const challenge = params.get("code_challenge") ?? "";
		if (!/^[\w-]{43}$/.test(challenge)) return refuse("code_challenge");
		const state = params.get("state") ?? "";
		const requested = (params.get("scope") ?? "").split(" ").filter((scope) => scope !== "");
		if (state === "" || requested.length === 0) return refuse("state or scope missing");
		const back = new URL(redirectUri);
		const consent = options.consent?.(requested) ?? requested;
		if (consent === "deny") {
			back.searchParams.set("error", "access_denied");
		} else {
			const code = `fake-code-${randomBytes(18).toString("base64url")}`;
			codes.set(code, { redirectUri, challenge, scopes: consent, used: false });
			back.searchParams.set("code", code);
			back.searchParams.set("scope", consent.map((scope) => LONG_NAMES[scope] ?? scope).join(" "));
		}
		back.searchParams.set("state", state);
		return new Response(null, { status: 302, headers: { location: back.href } });
	}

	function tokenResponse(
		scopes: readonly string[],
		tokens: { accessToken: string; refreshToken?: string },
	) {
		return json(
			200,
			{
				access_token: tokens.accessToken,
				expires_in: 3599,
				...(tokens.refreshToken === undefined ? {} : { refresh_token: tokens.refreshToken }),
				scope: scopes.map((scope) => LONG_NAMES[scope] ?? scope).join(" "),
				token_type: "Bearer",
			},
			{ "cache-control": "no-store" },
		);
	}

	function token(form: URLSearchParams): Response {
		const invalidGrant = json(400, {
			error: "invalid_grant",
			error_description: "Token has been expired or revoked.",
		});
		if (
			form.get("client_id") !== options.clientId ||
			form.get("client_secret") !== options.clientSecret
		) {
			return json(401, { error: "invalid_client", error_description: "Unauthorized" });
		}
		if (form.get("grant_type") === "authorization_code") {
			const pending = codes.get(form.get("code") ?? "");
			const verifier = form.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (pending === undefined || pending.used) return invalidGrant;
			pending.used = true;
			if (form.get("redirect_uri") !== pending.redirectUri)
				return refuseJson("redirect_uri_mismatch");
			if (challenge !== pending.challenge) return invalidGrant;
			return tokenResponse(pending.scopes, options.tokens.grant(pending.scopes));
		}
		if (form.get("grant_type") === "refresh_token") {
			const grant = options.tokens.lookup(form.get("refresh_token") ?? "", "refresh");
			if (grant === undefined) return invalidGrant;
			return tokenResponse(grant.scopes, { accessToken: options.tokens.issue(grant, "access") });
		}
		return json(400, { error: "unsupported_grant_type" });
	}

	function refuseJson(error: string): Response {
		problems.push(error);
		return json(400, { error });
	}

	const server = await serve(async (request) => {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/o/oauth2/v2/auth") return authorize(url);
		if (request.method !== "POST") return refuse(`${request.method} ${url.pathname}`);
		if (request.headers.get("content-type") !== "application/x-www-form-urlencoded") {
			return refuse("form body expected");
		}
		const form = new URLSearchParams(await request.text());
		if (url.pathname === "/token") return token(form);
		if (url.pathname === "/revoke") {
			const value = form.get("token") ?? "";
			revocations.push(value);
			return options.tokens.revoke(value)
				? json(200, {})
				: json(400, { error: "invalid_token", error_description: "Token expired or revoked" });
		}
		return refuse(`POST ${url.pathname}`);
	});
	return {
		...server,
		endpoints: {
			authorization: `${server.url}/o/oauth2/v2/auth`,
			token: `${server.url}/token`,
			revocation: `${server.url}/revoke`,
		},
		problems,
		authorizations,
		revocations,
	};
}

// The owner's browser: open the consent URL, then follow Google's redirect to the loopback listener.
export async function fakeBrowser(url: string): Promise<void> {
	const consent = await fetch(url, { redirect: "manual" });
	const location = consent.headers.get("location");
	if (consent.status !== 302 || location === null) {
		throw new Error(`consent page answered ${consent.status}`);
	}
	await (await fetch(location)).text();
}
