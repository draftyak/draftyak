import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { request } from "node:http";
import type { Hono } from "hono";
import type { ClientMetadata, Finder, Provider } from "oidc-provider";
import { type ConsentOptions, type ConsentRequest, ConsentStub } from "../src/consent.ts";
import { type AsOptions, createProvider } from "../src/provider.ts";
import { type AppOptions, createApp, type Env, listen } from "../src/routes.ts";

export const REDIRECT_URI = "https://client.example/callback";
export const ALL_SCOPES = "inbox:read inbox:organize drafts:write outbox:propose";

export interface TestClient {
	readonly id: string;
	readonly kind: "public" | "confidential";
	readonly metadata: ClientMetadata;
	readonly key?: KeyObject;
	readonly kid?: string;
}

export function publicClient(id = "spike-public", name = "Spike public client"): TestClient {
	return {
		id,
		kind: "public",
		metadata: {
			client_id: id,
			client_name: name,
			token_endpoint_auth_method: "none",
			redirect_uris: [REDIRECT_URI],
		},
	};
}

// private_key_jwt with a key made at run time; the public half is registered inline.
export function confidentialClient(id = "spike-confidential"): TestClient {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "spike-key-1";
	return {
		id,
		kind: "confidential",
		key: privateKey,
		kid,
		metadata: {
			client_id: id,
			client_name: "Spike confidential client",
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "RS256",
			jwks: { keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] },
			redirect_uris: [REDIRECT_URI],
		},
	};
}

export interface As {
	readonly origin: string;
	readonly provider: Provider;
	readonly app: Hono<Env>;
	readonly consent: ConsentStub;
	readonly pushes: ConsentRequest[];
	close(): Promise<void>;
}

export async function startAs(
	clients: readonly TestClient[] = [publicClient(), confidentialClient()],
	options: {
		readonly provider?: Omit<AsOptions, "issuer" | "clients">;
		readonly consent?: Omit<ConsentOptions, "onPush">;
		readonly app?: Omit<AppOptions, "provider" | "consent">;
	} = {},
): Promise<As> {
	const pushes: ConsentRequest[] = [];
	// The push limits get their own tests; elsewhere they would cut suites short.
	const consent = new ConsentStub({
		limits: { perMinute: 1000, perDay: 1000, denialsToPause: 1000 },
		...options.consent,
		onPush: (request) => pushes.push(request),
	});
	let provider: Provider | undefined;
	let app: Hono<Env> | undefined;
	const running = await listen((origin) => {
		provider = createProvider({
			issuer: origin,
			clients: clients.map((client) => client.metadata),
			...options.provider,
		});
		app = createApp({ provider, consent, ...options.app });
		return app;
	});
	if (!provider || !app) throw new Error("the AS did not start");
	return { origin: running.origin, provider, app, consent, pushes, close: running.close };
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(48).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

// A user agent: one cookie jar for every path, and no redirect following.
export class Browser {
	readonly #cookies = new Map<string, string>();

	async get(
		url: string,
		headers: Record<string, string> = {},
		method: "GET" | "HEAD" = "GET",
	): Promise<Response> {
		const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		const response = await fetch(url, {
			method,
			redirect: "manual",
			headers: { ...(cookie ? { cookie } : {}), "user-agent": "spike-browser/1", ...headers },
		});
		for (const line of response.headers.getSetCookie()) {
			const [pair = "", ...attributes] = line.split(";");
			const at = pair.indexOf("=");
			const [name, value] = [pair.slice(0, at).trim(), pair.slice(at + 1).trim()];
			const expired = attributes.some((a) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(a));
			if (expired || value === "") this.#cookies.delete(name);
			else this.#cookies.set(name, value);
		}
		return response;
	}

	cookie(name: string): string | undefined {
		return this.#cookies.get(name);
	}
}

export function authorizeUrl(
	as: As,
	client: TestClient,
	params: Record<string, string | undefined> = {},
): { url: string; state: string; verifier: string } {
	const { verifier, challenge } = pkcePair();
	const state = randomBytes(8).toString("hex");
	const query = new URLSearchParams();
	const all: Record<string, string | undefined> = {
		client_id: client.id,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: ALL_SCOPES,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${as.origin}/mcp`,
		...params,
	};
	for (const [name, value] of Object.entries(all)) if (value !== undefined) query.set(name, value);
	return { url: `${as.origin}/oauth/authorize?${query}`, state, verifier };
}

export interface Started {
	readonly uid: string;
	readonly code: string;
	readonly csrf: string;
	readonly page: Response;
	readonly html: string;
	readonly state: string;
	readonly verifier: string;
}

// The authorization request up to the consent page, as a browser makes it.
export async function startAuthorization(
	as: As,
	browser: Browser,
	client: TestClient,
	params: Record<string, string | undefined> = {},
): Promise<Started> {
	const { url, state, verifier } = authorizeUrl(as, client, params);
	const first = await browser.get(url);
	const location = first.headers.get("location") ?? "";
	const uid = /\/oauth\/interaction\/([^/?#]+)$/.exec(location)?.[1];
	if (first.status !== 303 || !uid) {
		throw new Error(`expected a redirect to the consent page, got ${first.status} ${location}`);
	}
	const page = await browser.get(new URL(location, as.origin).href);
	const html = await page.text();
	const code = /<strong id="code">(\d\d)<\/strong>/.exec(html)?.[1] ?? "";
	const csrf = /data-csrf="([^"]+)"/.exec(html)?.[1] ?? "";
	return { uid, code, csrf, page, html, state, verifier };
}

// finish, then the provider's resume, up to the redirect to the client.
export async function finish(as: As, browser: Browser, uid: string): Promise<URL> {
	const finished = await browser.get(`${as.origin}/oauth/interaction/${uid}/finish`);
	if (finished.status !== 303) throw new Error(`finish answered ${finished.status}`);
	const resumed = await browser.get(
		new URL(finished.headers.get("location") ?? "", as.origin).href,
	);
	const location = resumed.headers.get("location");
	if (resumed.status !== 303 || !location) throw new Error(`resume answered ${resumed.status}`);
	const callback = new URL(location);
	// Every authorization response in these suites, success or error, must name the issuer.
	if (callback.searchParams.get("iss") !== as.origin) throw new Error(`no iss: ${location}`);
	return callback;
}

export interface Authorized {
	readonly callback: URL;
	readonly code: string;
	readonly state: string;
	readonly verifier: string;
}

export async function authorize(
	as: As,
	client: TestClient,
	options: {
		readonly params?: Record<string, string | undefined>;
		readonly scopes?: readonly string[];
	} = {},
	browser: Browser = new Browser(),
): Promise<Authorized> {
	const started = await startAuthorization(as, browser, client, options.params);
	as.consent.approve(started.uid, started.code, options.scopes);
	const callback = await finish(as, browser, started.uid);
	if (!callback.searchParams.has("code")) throw new Error(`no code: ${callback.search}`);
	return {
		callback,
		code: callback.searchParams.get("code") ?? "",
		state: started.state,
		verifier: started.verifier,
	};
}

// Header fields and claims to change in a client assertion, such as alg, kid, aud, iss, sub, exp
// or jti; a field set to undefined is left out. The signature is always RS256 with the client's key.
export interface AssertionOverrides {
	readonly header?: Readonly<Record<string, unknown>>;
	readonly claims?: Readonly<Record<string, unknown>>;
}

// An RS256 private_key_jwt client assertion for the given audience.
export function clientAssertion(
	client: TestClient,
	audience: string,
	overrides: AssertionOverrides = {},
): string {
	if (!client.key) throw new Error(`${client.id} has no key`);
	const now = Math.floor(Date.now() / 1000);
	const encode = (part: unknown): string => Buffer.from(JSON.stringify(part)).toString("base64url");
	const header = { alg: "RS256", kid: client.kid, typ: "JWT", ...overrides.header };
	const claims = {
		iss: client.id,
		sub: client.id,
		aud: audience,
		jti: randomBytes(16).toString("hex"),
		iat: now,
		exp: now + 60,
		...overrides.claims,
	};
	const input = `${encode(header)}.${encode(claims)}`;
	return `${input}.${sign("sha256", Buffer.from(input), client.key).toString("base64url")}`;
}

export interface Posted {
	readonly status: number;
	readonly body: Record<string, unknown>;
	readonly headers: Headers;
}

// A form-encoded request to a token-style endpoint, with the client's own authentication: a
// confidential client's fresh assertion for the token endpoint, unless one is given.
export async function post(
	as: As,
	path: string,
	client: TestClient,
	params: Record<string, string | undefined>,
	options: {
		readonly assertion?: string;
		readonly headers?: Readonly<Record<string, string>>;
	} = {},
): Promise<Posted> {
	const form = new URLSearchParams({ client_id: client.id });
	for (const [name, value] of Object.entries(params))
		if (value !== undefined) form.set(name, value);
	if (client.kind === "confidential") {
		form.set("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
		form.set(
			"client_assertion",
			options.assertion ?? clientAssertion(client, `${as.origin}/oauth/token`),
		);
	}
	const response = await fetch(`${as.origin}${path}`, {
		method: "POST",
		body: form,
		...(options.headers ? { headers: options.headers } : {}),
	});
	const text = await response.text();
	return {
		status: response.status,
		body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
		headers: response.headers,
	};
}

export function exchange(
	as: As,
	client: TestClient,
	authorized: Authorized,
	extra: Record<string, string | undefined> = {},
): Promise<Posted> {
	return post(as, "/oauth/token", client, {
		grant_type: "authorization_code",
		code: authorized.code,
		redirect_uri: REDIRECT_URI,
		code_verifier: authorized.verifier,
		...extra,
	});
}

export function refresh(as: As, client: TestClient, refreshToken: string): Promise<Posted> {
	return post(as, "/oauth/token", client, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
	});
}

// The protected resource stand-in: 200 for a live token issued for /mcp, else 401.
export async function callMcp(as: As, accessToken: string): Promise<number> {
	const response = await fetch(`${as.origin}/mcp`, {
		method: "POST",
		headers: { authorization: `Bearer ${accessToken}` },
	});
	await response.body?.cancel();
	return response.status;
}

export const epoch = (): number => Math.floor(Date.now() / 1000);

// Changes a stored record as if time had passed or it had been altered at rest. The value of an
// opaque token is its id.
export async function rewrite(
	model: Finder<unknown>,
	id: string,
	change: Record<string, unknown>,
): Promise<void> {
	const payload = await model.adapter.find(id);
	if (!payload) throw new Error(`no stored record ${id}`);
	await model.adapter.upsert(id, { ...payload, ...change }, 3600);
}

// node:http sends the target and Host as given, so absolute-form targets and other Hosts can be
// tried. Host defaults to the origin's.
export function rawRequest(
	origin: string,
	target: string,
	options: {
		readonly method?: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string;
	} = {},
): Promise<{ status: number; body: string }> {
	const { hostname, port, host } = new URL(origin);
	return new Promise((resolve, reject) => {
		request({
			host: hostname,
			port,
			method: options.method ?? "GET",
			path: target,
			headers: { host, ...options.headers },
		})
			.once("response", (response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					body += chunk;
				});
				response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
			})
			.once("error", reject)
			.end(options.body);
	});
}
