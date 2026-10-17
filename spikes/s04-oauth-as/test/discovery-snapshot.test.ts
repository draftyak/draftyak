import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateJwks, ROUTES } from "../src/provider.ts";
import {
	createApp,
	listen,
	METADATA_PATH,
	PRM_PATH,
	PROVIDER_ROUTES,
	projectMetadata,
} from "../src/routes.ts";
import {
	type As,
	authorize,
	clientAssertion,
	confidentialClient,
	post,
	publicClient,
	REDIRECT_URI,
	rawRequest,
	startAs,
} from "./flow.ts";

const ORIGIN = "https://as.example";

const EXPECTED_METADATA = {
	issuer: ORIGIN,
	authorization_endpoint: `${ORIGIN}/oauth/authorize`,
	token_endpoint: `${ORIGIN}/oauth/token`,
	jwks_uri: `${ORIGIN}/oauth/jwks`,
	scopes_supported: ["inbox:read", "inbox:organize", "drafts:write", "outbox:propose"],
	response_types_supported: ["code"],
	response_modes_supported: ["form_post", "fragment", "query"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
	token_endpoint_auth_signing_alg_values_supported: ["RS256"],
	revocation_endpoint: `${ORIGIN}/oauth/revoke`,
	code_challenge_methods_supported: ["S256"],
	authorization_response_iss_parameter_supported: true,
	revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
	revocation_endpoint_auth_signing_alg_values_supported: ["RS256"],
};

const ROUTE_TABLE = [
	"ALL /*",
	"GET /.well-known/oauth-protected-resource/mcp",
	"ALL /mcp",
	"GET /oauth/interaction/:uid",
	"GET /oauth/interaction/:uid/status",
	"GET /oauth/interaction/:uid/finish",
	"GET /.well-known/oauth-authorization-server",
	"GET /oauth/authorize",
	"GET /oauth/authorize/:uid",
	"POST /oauth/token",
	"POST /oauth/revoke",
	"GET /oauth/jwks",
];

// What oidc-provider serves or registers that Hono must not route: features that are off, its OIDC
// discovery, CORS preflights, its dev interaction pages and the always-on logout confirm route.
const UNROUTED: readonly (readonly [string, string])[] = [
	["GET", "/.well-known/openid-configuration"],
	["GET", "/oauth/userinfo"],
	["POST", "/oauth/userinfo"],
	["GET", "/oauth/session/end"],
	["POST", "/oauth/session/end/confirm"],
	["POST", "/oauth/par"],
	["POST", "/oauth/register"],
	["POST", "/oauth/introspect"],
	["POST", "/oauth/device/auth"],
	["GET", "/oauth/device"],
	["POST", "/oauth/backchannel"],
	["POST", "/oauth/challenge"],
	["POST", "/oauth/credential"],
	["GET", "/interaction/abc"],
	["POST", "/oauth/interaction/abc"],
	["POST", "/oauth/authorize"],
	["GET", "/oauth/token"],
	["OPTIONS", "/oauth/token"],
	["OPTIONS", "/oauth/revoke"],
	["GET", "/oauth"],
	["GET", "/.well-known/oauth-protected-resource"],
];

const ENDPOINT_METHOD: Readonly<Record<string, string>> = {
	authorization_endpoint: "GET",
	jwks_uri: "GET",
	token_endpoint: "POST",
	revocation_endpoint: "POST",
};

const confidential = confidentialClient();
let as: As;
let metadata: Record<string, unknown>;

beforeAll(async () => {
	as = await startAs([publicClient(), confidential]);
	metadata = (await (await fetch(`${as.origin}${METADATA_PATH}`)).json()) as Record<
		string,
		unknown
	>;
});
afterAll(async () => {
	await as?.close();
});

const normalized = (value: unknown): unknown =>
	JSON.parse(JSON.stringify(value).replaceAll(as.origin, ORIGIN));

describe("RFC 8414 metadata", () => {
	test("matches the snapshot exactly", () => {
		expect(normalized(metadata)).toStrictEqual(EXPECTED_METADATA);
	});

	test("Hono routes exactly the snapshot's routes", () => {
		expect(as.app.routes.map((route) => `${route.method} ${route.path}`)).toStrictEqual(
			ROUTE_TABLE,
		);
	});

	test("every advertised endpoint is routed to the provider", async () => {
		const endpoints = Object.keys(metadata).filter(
			(key) => key.endsWith("_endpoint") || key === "jwks_uri",
		);
		expect(endpoints.sort()).toStrictEqual(Object.keys(ENDPOINT_METHOD).sort());
		for (const key of endpoints) {
			const response = await fetch(String(metadata[key]), { method: ENDPOINT_METHOD[key] });
			const body = await response.text();
			expect(response.status, key).not.toBe(404);
			expect(body, key).toMatch(/"keys":|"error":"invalid_request"|error: invalid_request/);
		}
	});

	test("every forwarded provider route is advertised, apart from resume and the document", () => {
		const advertised = new Set(
			Object.values(metadata)
				.filter(
					(value): value is string => typeof value === "string" && value.startsWith(as.origin),
				)
				.map((url) => new URL(url).pathname),
		);
		const unadvertised = PROVIDER_ROUTES.map((route) => route.path).filter(
			(path) => !advertised.has(path),
		);
		expect(unadvertised).toStrictEqual([METADATA_PATH, "/oauth/authorize/:uid"]);
	});

	test("disabled features, OIDC discovery and preflights are 404 through Hono", async () => {
		for (const [method, path] of UNROUTED) {
			const response = await fetch(`${as.origin}${path}`, { method });
			expect(response.status, `${method} ${path}`).toBe(404);
			expect(await response.json()).toStrictEqual({ error: "not_found" });
		}
	});

	test("the provider itself still answers routes Hono keeps unreachable", async () => {
		const raw = createServer(as.provider.callback());
		await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
		try {
			const origin = `http://127.0.0.1:${(raw.address() as AddressInfo).port}`;
			const confirm = await fetch(`${origin}/oauth/session/end/confirm`, { method: "POST" });
			expect(confirm.status).toBe(400);
			// Off in the provider itself, not only unrouted.
			for (const [method, path] of [
				["GET", "/interaction/abc"],
				["POST", "/oauth/par"],
				["GET", "/oauth/userinfo"],
				["GET", "/oauth/session/end"],
				["POST", "/oauth/register"],
			]) {
				expect((await fetch(`${origin}${path}`, { method })).status, path).toBe(404);
			}
			const oidc = (await (
				await fetch(`${origin}/.well-known/openid-configuration`)
			).json()) as Record<string, unknown>;
			const dropped = Object.keys(oidc).filter((key) => !(key in metadata));
			expect(dropped.sort()).toStrictEqual([
				"claim_types_supported",
				"claims_parameter_supported",
				"claims_supported",
				"id_token_signing_alg_values_supported",
				"request_uri_parameter_supported",
				"subject_types_supported",
			]);
			// The provider builds endpoint URLs from the request's Host, so here they name this server.
			expect(oidc.token_endpoint).toBe(`${origin}/oauth/token`);
			const path = (value: unknown) =>
				typeof value === "string" && value.startsWith("http") ? new URL(value).pathname : value;
			for (const [key, value] of Object.entries(oidc)) {
				if (key in metadata && !["issuer", "scopes_supported"].includes(key)) {
					expect(path(metadata[key]), key).toStrictEqual(path(value));
				}
			}
			expect(oidc.issuer).toBe(metadata.issuer);
			expect(oidc.scopes_supported).toStrictEqual(["openid"]);
			// The RFC 8414 document keeps the issuer's origin whatever Host the provider saw.
			const projected = await (await fetch(`${origin}${METADATA_PATH}`)).json();
			expect(projected).toStrictEqual(metadata);
		} finally {
			raw.closeAllConnections();
			raw.close();
		}
	});

	test("an endpoint appears only while its route is open (the DCR window's switch)", () => {
		const raw = {
			issuer: ORIGIN,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			userinfo_endpoint: `${ORIGIN}/oauth/userinfo`,
			introspection_endpoint: `${ORIGIN}/oauth/introspect`,
			claims_supported: ["sub"],
			scopes_supported: ["openid"],
		};
		let open = false;
		const routed = (path: string) => open && path === "/oauth/register";
		expect(projectMetadata(raw, routed)).toStrictEqual({
			issuer: ORIGIN,
			scopes_supported: EXPECTED_METADATA.scopes_supported,
		});
		open = true;
		expect(projectMetadata(raw, routed)).toStrictEqual({
			issuer: ORIGIN,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			scopes_supported: EXPECTED_METADATA.scopes_supported,
		});
	});

	test("apps sharing a provider each advertise their own routes", async () => {
		const shared = await startAs(undefined, {
			provider: {
				configure: (configuration) => {
					(configuration.features as Record<string, unknown>).registration = { enabled: true };
				},
			},
		});
		// A second app on the same provider and issuer, with registration routed.
		const second = await listen(() =>
			createApp({
				provider: shared.provider,
				routes: [{ method: "POST", path: ROUTES.registration }],
			}),
		);
		try {
			const host = new URL(shared.origin).host;
			const endpoint = async (origin: string) =>
				JSON.parse((await rawRequest(origin, METADATA_PATH, { headers: { host } })).body)
					.registration_endpoint;
			for (let round = 0; round < 2; round++) {
				expect(await endpoint(shared.origin)).toBeUndefined();
				expect(await endpoint(second.origin)).toBe(`${shared.origin}/oauth/register`);
			}
		} finally {
			await second.close();
			await shared.close();
		}
	});

	test("forwarded responses carry the base headers and no CORS headers", async () => {
		const routes = [
			["GET", METADATA_PATH],
			["GET", ROUTES.jwks],
			["POST", ROUTES.token],
			["POST", ROUTES.revocation],
		] as const;
		for (const [method, path] of routes) {
			const response = await fetch(`${as.origin}${path}`, {
				method,
				headers: { origin: "https://client.example" },
			});
			await response.body?.cancel();
			const label = `${method} ${path}`;
			expect(response.headers.get("cache-control"), label).toBe("no-store");
			expect(response.headers.get("referrer-policy"), label).toBe("no-referrer");
			expect(response.headers.get("x-content-type-options"), label).toBe("nosniff");
			const cors = [...response.headers.keys()].filter((key) => key.startsWith("access-control-"));
			expect(cors, label).toStrictEqual([]);
		}
	});
});

describe("protected resource metadata", () => {
	test("names exactly one authorization server, this issuer", async () => {
		const response = await fetch(`${as.origin}${PRM_PATH}`);
		expect(response.status).toBe(200);
		expect(normalized(await response.json())).toStrictEqual({
			resource: `${ORIGIN}/mcp`,
			authorization_servers: [ORIGIN],
			scopes_supported: EXPECTED_METADATA.scopes_supported,
			bearer_methods_supported: ["header"],
		});
	});

	test("an unauthenticated MCP request gets a 401 with resource_metadata", async () => {
		for (const method of ["GET", "POST"]) {
			const response = await fetch(`${as.origin}/mcp`, { method });
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toBe(
				`Bearer resource_metadata="${as.origin}${PRM_PATH}"`,
			);
		}
		const forged = await fetch(`${as.origin}/mcp`, { headers: { authorization: "Bearer abc" } });
		expect(forged.status).toBe(401);
		expect(forged.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${as.origin}${PRM_PATH}", error="invalid_token"`,
		);
	});
});

describe("signing keys", () => {
	const thumbprint = (jwk: Record<string, unknown>): string =>
		createHash("sha256")
			.update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
			.digest("base64url");

	test("the JWKS holds only the public half of the hub's RS256 key", async () => {
		const { keys } = (await (await fetch(String(metadata.jwks_uri))).json()) as {
			keys: Record<string, unknown>[];
		};
		expect(keys).toHaveLength(1);
		const [key = {}] = keys;
		expect(Object.keys(key).sort()).toStrictEqual(["alg", "e", "kid", "kty", "n", "use"]);
		expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
		expect(key.kid).toBe(thumbprint(key));
	});

	test("a hub-supplied JWKS is the one served", async () => {
		const jwks = generateJwks();
		const supplied = await startAs(undefined, { provider: { jwks } });
		try {
			const { keys } = (await (await fetch(`${supplied.origin}/oauth/jwks`)).json()) as {
				keys: Record<string, unknown>[];
			};
			expect(keys.map((key) => key.kid)).toStrictEqual([thumbprint(jwks.keys[0] ?? {})]);
		} finally {
			await supplied.close();
		}
	});
});

describe("§6 L3: only requests that name the issuer get through", () => {
	// Each case is a request target and headers, given the issuer's URL.
	const cases: readonly (readonly [string, (issuer: URL) => [string, Record<string, string>]])[] = [
		["another Host", () => [METADATA_PATH, { host: "evil.example" }]],
		["an absolute-form target for another host", () => [`http://evil.example${METADATA_PATH}`, {}]],
		[
			"an absolute-form target naming the issuer",
			(issuer) => [`${issuer.origin}${METADATA_PATH}`, {}],
		],
		[
			"X-Forwarded-Host naming another host",
			() => [METADATA_PATH, { "x-forwarded-host": "evil.example" }],
		],
		[
			"X-Forwarded-Host listing another host",
			(issuer) => [METADATA_PATH, { "x-forwarded-host": `${issuer.host}, evil.example` }],
		],
		[
			"X-Forwarded-Proto naming another scheme",
			() => [METADATA_PATH, { "x-forwarded-proto": "https" }],
		],
	];
	test.each(cases)("%s is refused with 421", async (_name, request) => {
		const [target, headers] = request(new URL(as.origin));
		const response = await rawRequest(as.origin, target, { headers });
		expect(response.status).toBe(421);
		expect(JSON.parse(response.body)).toStrictEqual({
			error: "invalid_request",
			error_description: "unknown host",
		});
	});

	test("forwarded headers that name the issuer pass", async () => {
		const { host } = new URL(as.origin);
		const response = await rawRequest(as.origin, METADATA_PATH, {
			headers: { "x-forwarded-host": host, "x-forwarded-proto": "http" },
		});
		expect(response.status).toBe(200);
	});

	test("a client assertion minted for another server's token endpoint can't be replayed here", async () => {
		const authorized = await authorize(as, confidential);
		const body = new URLSearchParams({
			grant_type: "authorization_code",
			code: authorized.code,
			redirect_uri: REDIRECT_URI,
			code_verifier: authorized.verifier,
			client_id: confidential.id,
			client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
			client_assertion: clientAssertion(confidential, "http://evil.example/oauth/token"),
		}).toString();
		const headers = { "content-type": "application/x-www-form-urlencoded" };
		// oidc-provider itself would accept this audience for an absolute-form target naming it.
		const absolute = await rawRequest(as.origin, "http://evil.example/oauth/token", {
			method: "POST",
			headers,
			body,
		});
		expect(absolute.status).toBe(421);
		const originForm = await rawRequest(as.origin, "/oauth/token", {
			method: "POST",
			headers,
			body,
		});
		expect(originForm.status).toBe(401);
		expect(JSON.parse(originForm.body).error).toBe("invalid_client");
	});

	test("with provider.proxy on, X-Forwarded-Host stands in for Host and must name the issuer", async () => {
		const proxied = await startAs([publicClient(), confidential]);
		proxied.provider.proxy = true;
		try {
			const { host } = new URL(proxied.origin);
			const status = async (headers: Record<string, string>) =>
				(await rawRequest(proxied.origin, METADATA_PATH, { headers })).status;
			// A proxy may rewrite Host; Koa then builds URLs from X-Forwarded-Host.
			expect(await status({ host: "127.0.0.1:1", "x-forwarded-host": host })).toBe(200);
			expect(await status({ host: "127.0.0.1:1" })).toBe(421);
			expect(await status({ "x-forwarded-host": "evil.example" })).toBe(421);
			const authorized = await authorize(proxied, confidential);
			const injected = await post(
				proxied,
				"/oauth/token",
				confidential,
				{
					grant_type: "authorization_code",
					code: authorized.code,
					redirect_uri: REDIRECT_URI,
					code_verifier: authorized.verifier,
				},
				{
					assertion: clientAssertion(confidential, "http://evil.example/oauth/token"),
					headers: { "x-forwarded-host": "evil.example" },
				},
			);
			expect(injected.status).toBe(421);
		} finally {
			await proxied.close();
		}
	});

	test("the issuer itself is always an accepted assertion audience", async () => {
		const cases = [
			[{ aud: as.origin }, 200],
			[{ exp: undefined }, 401],
		] as const;
		for (const [claims, status] of cases) {
			const authorized = await authorize(as, confidential);
			const assertion = clientAssertion(confidential, `${as.origin}/oauth/token`, { claims });
			const params = {
				grant_type: "authorization_code",
				code: authorized.code,
				redirect_uri: REDIRECT_URI,
				code_verifier: authorized.verifier,
			};
			const response = await post(as, "/oauth/token", confidential, params, { assertion });
			expect(response.status, JSON.stringify(claims)).toBe(status);
		}
	});
});

test("the unit tier stays offline", async () => {
	await expect(fetch("https://client.example/callback")).rejects.toThrow(
		"test fetch outside loopback refused: client.example",
	);
});
