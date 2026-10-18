import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { json, form as readForm, type Served, serve } from "./serve.ts";

// A loopback stand-in for OpenAI's SIWC authorization server, written from the public docs
// (notes/sources.md): discovery, JWKS, the authorize endpoint with dynamic registration, the token
// endpoint (code and refresh grants, rotating refresh tokens) and revocation. It refuses every
// parameter outside the documented set, so a test sees anything the spike adds.

export const RESOURCE = "https://api.openai.com/v1";
const PLAN = "chatgpt.tokens.use.direct";
const PLAN_GROUP = ["offline_access", "resource.invoke", PLAN];
const REGISTRATION = "dynamic_agent_client";

// The fake's own copies of the documented lists, kept apart from src/ so they can't agree by
// construction.
const AUTHORIZE_PARAMS = [
	"client_id",
	"agent_name_hint",
	"ext_agent_host_id",
	"id_token_hint",
	"login_hint",
	"response_type",
	"redirect_uri",
	"scope",
	"resource",
	"state",
	"nonce",
	"code_challenge_method",
	"code_challenge",
	"prompt",
];
const TOKEN_FORMS: Readonly<Record<string, readonly string[]>> = {
	authorization_code: [
		"grant_type",
		"client_id",
		"code",
		"code_verifier",
		"redirect_uri",
		"resource",
	],
	refresh_token: ["grant_type", "client_id", "refresh_token", "resource"],
};
const REVOKE_FORM = ["token", "token_type_hint", "client_id"];
const HOST_ID =
	/^(?:urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}|did:key:z[1-9A-HJ-NP-Za-km-z]+)$/;
const CALLBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/;

export interface Access {
	readonly clientId: string;
	readonly subject: string;
	readonly scopes: readonly string[];
	readonly expiresAt: number;
	readonly family: Family;
}

interface Family {
	revoked: boolean;
}

interface Refresh {
	readonly clientId: string;
	readonly subject: string;
	readonly scopes: readonly string[];
	readonly family: Family;
	used: boolean;
}

interface Code {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly challenge: string;
	readonly nonce: string;
	readonly scopes: readonly string[];
	readonly subject: string;
	used: boolean;
}

interface Client {
	readonly subject: string;
	readonly hosts: Set<string>;
	withheld: readonly string[];
}

export interface FakeAuthOptions {
	// What the owner does where a consent screen shows: allow all, decline, untick plan usage (the
	// docs don't say whether offline_access and resource.invoke go with it), or keep only identity.
	consent: "allow" | "decline" | "no-plan" | "identity-only";
	subject: string;
	email: string;
	expiresIn: number;
	earliestRefreshAt?: unknown;
	// The callback's client_id on reauthorization: none (documented as optional) or another one.
	reauthClientId: "omit" | "same" | "other";
	// Registration callbacks without the issued client_id (an incomplete registration).
	omitIssuedClient: boolean;
	// Tampering with the ID token: its claims, or a key outside the JWKS.
	idClaims?: (claims: Record<string, unknown>) => Record<string, unknown>;
	signWithStranger: boolean;
	// Refresh errors in either shape the docs leave open: {"error": "x"} or {"error": {"code": "x"}}.
	errorShape: "string" | "object";
	refreshDelayMs: number;
	// Code-exchange errors, one per exchange, then success.
	codeErrors: string[];
	// Changes a successful token response, per grant type.
	tokenResponse?: (body: Record<string, unknown>, grant: string) => Record<string, unknown>;
	// Revocation statuses, one per call, then 200.
	revocationStatuses: number[];
	discovery?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

export interface FakeAuth extends Served {
	readonly options: FakeAuthOptions;
	readonly problems: string[];
	readonly authorizations: URLSearchParams[];
	readonly tokenForms: URLSearchParams[];
	readonly revocations: URLSearchParams[];
	readonly access: Map<string, Access>;
	readonly refresh: Map<string, Refresh>;
	readonly clients: Map<string, Client>;
	// The system browser: opens the authorize URL and follows its redirect to the callback.
	browse(url: string): Promise<void>;
	// A refresh token as if the hub had kept an old copy after rotation.
	issueFor(clientId: string, scopes: readonly string[]): { access: string; refresh: string };
}

const random = (prefix: string): string => `${prefix}${randomBytes(18).toString("base64url")}`;
const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
	const signed = `${part({ alg: "RS256", kid, typ: "JWT" })}.${part(claims)}`;
	return `${signed}.${sign("sha256", Buffer.from(signed), key).toString("base64url")}`;
}

export async function startFakeAuth(overrides: Partial<FakeAuthOptions> = {}): Promise<FakeAuth> {
	const options: FakeAuthOptions = {
		consent: "allow",
		subject: "user-fake-0001",
		email: "owner@example.com",
		expiresIn: 3600,
		reauthClientId: "omit",
		omitIssuedClient: false,
		signWithStranger: false,
		errorShape: "string",
		refreshDelayMs: 0,
		codeErrors: [],
		revocationStatuses: [],
		...overrides,
	};
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "fake-key-1";
	const problems: string[] = [];
	const authorizations: URLSearchParams[] = [];
	const tokenForms: URLSearchParams[] = [];
	const revocations: URLSearchParams[] = [];
	const codes = new Map<string, Code>();
	const access = new Map<string, Access>();
	const refresh = new Map<string, Refresh>();
	const clients = new Map<string, Client>();
	let issuer = "";

	const refuse = (status: number, problem: string, error = "invalid_request"): Response => {
		problems.push(problem);
		const body =
			options.errorShape === "object" ? { error: { code: error, message: problem } } : { error };
		return json(status, body);
	};
	const unknownParams = (params: URLSearchParams, allowed: readonly string[]): string[] =>
		[...new Set(params.keys())].filter((name) => !allowed.includes(name));

	const issue = (clientId: string, subject: string, scopes: readonly string[], family: Family) => {
		const token = { access: random("fake-at-"), refresh: random("fake-rt-") };
		access.set(token.access, {
			clientId,
			subject,
			scopes,
			expiresAt: Date.now() + options.expiresIn * 1000,
			family,
		});
		refresh.set(token.refresh, { clientId, subject, scopes, family, used: false });
		return token;
	};

	const tokenBody = (
		token: { access: string; refresh: string },
		scopes: readonly string[],
		idToken?: string,
	): Record<string, unknown> => {
		const body = {
			access_token: token.access,
			...(scopes.includes("offline_access") ? { refresh_token: token.refresh } : {}),
			...(idToken ? { id_token: idToken } : {}),
			token_type: "Bearer",
			expires_in: options.expiresIn,
			scope: scopes.join(" "),
			...(options.earliestRefreshAt === undefined
				? {}
				: { earliest_refresh_at: options.earliestRefreshAt }),
		};
		const grant = idToken ? "authorization_code" : "refresh_token";
		return options.tokenResponse ? options.tokenResponse(body, grant) : body;
	};

	const authorize = (url: URL): Response => {
		const params = url.searchParams;
		authorizations.push(params);
		const extra = unknownParams(params, AUTHORIZE_PARAMS);
		const get = (name: string): string => params.get(name) ?? "";
		const clientId = get("client_id");
		const registering = clientId === REGISTRATION;
		const scopes = get("scope").split(" ");
		const checks: [boolean, string][] = [
			[extra.length === 0, `authorize: unknown ${extra.join(", ")}`],
			[[...params.keys()].length === new Set(params.keys()).size, "authorize: repeated parameter"],
			[HOST_ID.test(get("ext_agent_host_id")), "authorize: ext_agent_host_id"],
			[get("response_type") === "code", "authorize: response_type"],
			[CALLBACK.test(get("redirect_uri")), "authorize: redirect_uri"],
			[get("resource") === RESOURCE, "authorize: resource"],
			[["openid", "profile", "email"].every((scope) => scopes.includes(scope)), "authorize: scope"],
			[get("state").length >= 22 && get("nonce").length >= 22, "authorize: state and nonce"],
			[get("code_challenge_method") === "S256", "authorize: code_challenge_method"],
			[/^[A-Za-z0-9_-]{43}$/.test(get("code_challenge")), "authorize: code_challenge"],
			[
				registering ? get("agent_name_hint") !== "" : !params.has("agent_name_hint"),
				"authorize: agent_name_hint",
			],
			[
				!registering || (!params.has("id_token_hint") && !params.has("login_hint")),
				"authorize: hints",
			],
			[!params.has("prompt") || get("prompt") === "consent", "authorize: prompt"],
			[registering || clients.has(clientId), "authorize: unknown client"],
		];
		const failed = checks.find(([ok]) => !ok);
		if (failed) return refuse(400, failed[1]);
		const redirect = new URL(get("redirect_uri"));
		redirect.searchParams.set("state", get("state"));
		const known = clients.get(clientId);
		const consentShown = registering || params.has("prompt");
		if (consentShown && options.consent === "decline") {
			redirect.searchParams.set("error", "access_denied");
			return new Response(null, { status: 302, headers: { location: redirect.href } });
		}
		const choice = { allow: [], decline: [], "no-plan": [PLAN], "identity-only": PLAN_GROUP };
		const withheld = consentShown ? choice[options.consent] : (known?.withheld ?? PLAN_GROUP);
		const issued = registering ? random("oaiapp_fake") : clientId;
		const client = known ?? { subject: options.subject, hosts: new Set<string>(), withheld };
		client.withheld = withheld;
		client.hosts.add(get("ext_agent_host_id"));
		clients.set(issued, client);
		const granted = scopes.filter((scope) => !withheld.includes(scope));
		const code = random("fake-code-");
		codes.set(code, {
			clientId: issued,
			redirectUri: get("redirect_uri"),
			challenge: get("code_challenge"),
			nonce: get("nonce"),
			scopes: granted,
			subject: client.subject,
			used: false,
		});
		redirect.searchParams.set("code", code);
		redirect.searchParams.set("scope", granted.join(" "));
		const named = registering
			? options.omitIssuedClient
				? undefined
				: issued
			: options.reauthClientId === "same"
				? issued
				: options.reauthClientId === "other"
					? random("oaiapp_fake")
					: undefined;
		if (named !== undefined) redirect.searchParams.set("client_id", named);
		return new Response(null, { status: 302, headers: { location: redirect.href } });
	};

	const idToken = (code: Code): string => {
		const now = Math.floor(Date.now() / 1000);
		const claims = {
			iss: issuer,
			aud: code.clientId,
			sub: code.subject,
			email: options.email,
			nonce: code.nonce,
			iat: now,
			exp: now + 3600,
		};
		const stranger = (): KeyObject =>
			generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
		const key = options.signWithStranger ? stranger() : keys.privateKey;
		return jwt(options.idClaims ? options.idClaims(claims) : claims, key, kid);
	};

	const token = async (request: Request): Promise<Response> => {
		const params = await readForm(request);
		tokenForms.push(params);
		const grant = params.get("grant_type") ?? "";
		const allowed = TOKEN_FORMS[grant];
		if (allowed === undefined) return refuse(400, "token: grant_type", "unsupported_grant_type");
		const extra = unknownParams(params, allowed);
		if (extra.length > 0) return refuse(400, `token: unknown ${extra.join(", ")}`);
		if (params.get("resource") !== RESOURCE) return refuse(400, "token: resource");
		const clientId = params.get("client_id") ?? "";
		if (clientId === REGISTRATION || !clients.has(clientId)) {
			return refuse(401, "token: client_id", "invalid_client");
		}
		if (grant === "authorization_code") {
			const scripted = options.codeErrors.shift();
			if (scripted) return refuse(400, "token: scripted", scripted);
			const code = codes.get(params.get("code") ?? "");
			const verifier = params.get("code_verifier") ?? "";
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			if (!code || code.used) return refuse(400, "token: code", "invalid_grant");
			code.used = true;
			if (code.clientId !== clientId) return refuse(400, "token: code client", "invalid_grant");
			if (code.redirectUri !== params.get("redirect_uri"))
				return refuse(400, "token: redirect_uri", "invalid_grant");
			if (code.challenge !== challenge) return refuse(400, "token: code_verifier", "invalid_grant");
			const issued = issue(clientId, code.subject, code.scopes, { revoked: false });
			return json(200, tokenBody(issued, code.scopes, idToken(code)), {
				"x-request-id": random("req_"),
			});
		}
		await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs));
		const held = refresh.get(params.get("refresh_token") ?? "");
		if (!held || held.clientId !== clientId || held.family.revoked) {
			return refuse(400, "token: refresh_token", "invalid_grant");
		}
		if (held.used) {
			held.family.revoked = true;
			return refuse(400, "token: refresh_token reused", "refresh_token_reused");
		}
		held.used = true;
		const issued = issue(clientId, held.subject, held.scopes, held.family);
		return json(200, tokenBody(issued, held.scopes), { "x-request-id": random("req_") });
	};

	const revoke = async (request: Request): Promise<Response> => {
		const params = await readForm(request);
		revocations.push(params);
		const extra = unknownParams(params, REVOKE_FORM);
		if (extra.length > 0) return refuse(400, `revoke: unknown ${extra.join(", ")}`);
		const status = options.revocationStatuses.shift();
		if (status !== undefined && status !== 200) return new Response(null, { status });
		const held = refresh.get(params.get("token") ?? "");
		if (held && held.clientId === params.get("client_id")) held.family.revoked = true;
		return new Response(null, { status: 200 });
	};

	const served = await serve(async (request) => {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		if (route === "GET /.well-known/openid-configuration") {
			const doc = {
				issuer,
				authorization_endpoint: `${issuer}/api/accounts/authorize`,
				token_endpoint: `${issuer}/api/accounts/oauth/token`,
				jwks_uri: `${issuer}/.well-known/jwks.json`,
				revocation_endpoint: `${issuer}/oauth/revoke`,
				response_types_supported: ["code"],
				code_challenge_methods_supported: ["S256"],
			};
			return json(200, options.discovery ? options.discovery(doc) : doc);
		}
		if (route === "GET /.well-known/jwks.json") {
			const jwk = keys.publicKey.export({ format: "jwk" });
			return json(200, { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
		}
		if (route === "GET /api/accounts/authorize") return authorize(url);
		if (route === "POST /api/accounts/oauth/token") return token(request);
		if (route === "POST /oauth/revoke") return revoke(request);
		return refuse(404, `unknown route ${route}`, "not_found");
	});
	issuer = served.url;

	const browse = async (url: string): Promise<void> => {
		const consent = await fetch(url, { redirect: "manual" });
		const location = consent.headers.get("location");
		if (consent.status !== 302 || location === null) {
			throw new Error(`authorize refused: ${problems.at(-1) ?? consent.status}`);
		}
		await (await fetch(location)).text();
	};

	return {
		...served,
		options,
		problems,
		authorizations,
		tokenForms,
		revocations,
		access,
		refresh,
		clients,
		browse,
		issueFor: (clientId, scopes) => {
			const client = clients.get(clientId);
			if (!client) throw new Error("issueFor: unknown client");
			return issue(clientId, client.subject, scopes, { revoked: false });
		},
	};
}
