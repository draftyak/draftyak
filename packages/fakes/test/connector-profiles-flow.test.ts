import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import dns from "node:dns";
import { afterEach, expect, it, vi } from "vitest";
import {
	ConnectorClient,
	ConnectorClientError,
	type ConnectorClientOptions,
} from "../src/connector-client.ts";
import { createRecorder } from "../src/recorder.ts";
import { createFake, type Fake } from "../src/server.ts";

const ISSUER = "https://as.draftyak.example";
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT = "https://connector.example.net/client-metadata.json";
const REDIRECT = "https://connector.example.net/callback";
const TOKEN = `${ISSUER}/token`;
const REFUSED = /^Connector fixture refused$/;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PROFILES = [
	"cimd-public",
	"issuer-resource",
	"cimd-private",
	"loopback-cimd",
	"registered-public",
] as const;

interface FixtureSettings {
	readonly profile?: ConnectorClientOptions["profile"];
	readonly redirectUri?: string;
	readonly scope?: ConnectorClientOptions["scope"];
	readonly challengeScope?: string | null;
	readonly fallbackScopes?: unknown;
	readonly advertisedMethods?: readonly string[];
}

function fixture(settings: FixtureSettings = {}) {
	const profile = settings.profile ?? "cimd-public";
	const confidential = profile === "cimd-private";
	const clientId = profile === "registered-public" ? "DYTEST-opaque-dcr-result" : CLIENT;
	const redirectUri =
		settings.redirectUri ??
		(profile === "loopback-cimd" ? "http://127.0.0.1:53827/callback" : REDIRECT);
	const metadata = {
		client_id: clientId,
		redirect_uris: [profile === "loopback-cimd" ? "http://127.0.0.1/callback" : redirectUri],
		token_endpoint_auth_method: confidential ? "private_key_jwt" : "none",
		...(confidential ? { jwks_uri: "https://keys.example.net/jwks.json" } : {}),
	};
	const challengeScope =
		settings.challengeScope === undefined ? "mcp:read mcp:invoke" : settings.challengeScope;
	const authorizationMetadata = {
		issuer: ISSUER,
		authorization_endpoint: `${ISSUER}/authorize`,
		token_endpoint: TOKEN,
		revocation_endpoint: `${ISSUER}/revoke`,
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: settings.advertisedMethods ?? [
			confidential ? "private_key_jwt" : "none",
		],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
	};
	const resourceMetadata: Record<string, unknown> = {
		resource: RESOURCE,
		authorization_servers: [ISSUER],
		scopes_supported: settings.fallbackScopes ?? ["mcp:fallback"],
	};
	const cancelled: number[] = [];
	const statusBody = (
		status: number,
		contentType: string,
		headers: Record<string, string> = {},
	) => {
		const index = cancelled.push(0) - 1;
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("DYTEST deliberately not a JSON response"));
				},
				cancel() {
					cancelled[index] = 1;
				},
			}),
			{ status, headers: { "content-type": contentType, ...headers } },
		);
	};
	const responses = new Map<string, (request: Request) => Response>();
	responses.set("/mcp", (request) =>
		request.headers.has("authorization")
			? statusBody(200, "text/event-stream")
			: statusBody(401, "text/plain", {
					"www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"${challengeScope === null ? "" : `, scope="${challengeScope}"`}`,
				}),
	);
	responses.set("/.well-known/oauth-protected-resource", () => Response.json(resourceMetadata));
	responses.set("/.well-known/oauth-authorization-server", () =>
		Response.json(authorizationMetadata),
	);
	responses.set("/token", () =>
		Response.json({
			access_token: "DYTEST-access",
			refresh_token: "DYTEST-refresh",
			token_type: "Bearer",
		}),
	);
	responses.set("/revoke", () => Response.json({}));
	const transport = createFake(
		{
			fetch(request) {
				return (
					responses.get(new URL(request.url).pathname)?.(request) ??
					new Response(null, { status: 404 })
				);
			},
		},
		{
			host: "as.draftyak.example",
			recorder: createRecorder({ headerValues: ["content-type", "accept", "authorization"] }),
		},
	);
	const options: ConnectorClientOptions = {
		profile,
		issuer: ISSUER,
		resource: RESOURCE,
		redirectUri,
		metadata,
		transport,
		...(confidential ? { privateKey, assertionAudience: TOKEN } : {}),
		...(Object.hasOwn(settings, "scope") ? { scope: settings.scope } : {}),
	};
	return {
		client: new ConnectorClient(options),
		options,
		transport,
		responses,
		resourceMetadata,
		authorizationMetadata,
		cancelled,
		clientId,
		redirectUri,
	};
}

afterEach(() => vi.restoreAllMocks());

it.each([
	[
		`bEaReR Resource_Metadata = "${ISSUER}/.well-known/oauth-protected-resource", SCOPE = "mcp:challenge"`,
		"mcp:challenge",
	],
	[
		`Basic realm="DYTEST", scope="basic:scope", Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
		"mcp:fallback",
	],
	[
		`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", Basic realm="DYTEST", scope="basic:scope"`,
		"mcp:fallback",
	],
])("selects only the Bearer challenge's advertised scopes", async (header, expected) => {
	const { client, responses } = fixture();
	responses.set(
		"/mcp",
		() => new Response(null, { status: 401, headers: { "www-authenticate": header } }),
	);
	expect(new URL(await client.beginAuthorization()).searchParams.get("scope")).toBe(expected);
});

it("refuses mixed-case duplicate Bearer scope fields before metadata or token requests", async () => {
	const { client, responses, transport } = fixture();
	responses.set(
		"/mcp",
		() =>
			new Response(null, {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", Scope="mcp:one", sCoPe="mcp:two"`,
				},
			}),
	);
	await expect(client.beginAuthorization()).rejects.toThrow(REFUSED);
	expect(transport.recorder.takeRequests()).toHaveLength(1);
});

it("preserves the exact configured redirect query through authorization and callback", async () => {
	const redirectUri = `${REDIRECT}?target=inbox%20view&mode=fixture`;
	const { client, transport } = fixture({ redirectUri });
	const authorization = new URL(await client.beginAuthorization());
	expect(authorization.searchParams.get("redirect_uri")).toBe(redirectUri);
	const response = `${redirectUri}&${new URLSearchParams({ iss: ISSUER, state: authorization.searchParams.get("state") ?? "", code: "DYTEST-code" })}`;
	await expect(
		client.acceptCallback(response.replace("mode=fixture", "mode=changed")),
	).rejects.toThrow(REFUSED);
	expect(transport.recorder.takeRequests()).toHaveLength(3);
	expect(await client.acceptCallback(response)).toMatchObject({
		kind: "exchange",
		reply: { status: 200 },
	});
	const form = new URLSearchParams(
		new TextDecoder().decode(transport.recorder.takeRequests()[0]?.body),
	);
	expect(form.get("redirect_uri")).toBe(redirectUri);
});

it.each(["iss", "state", "%73tate", "code", "error", "error_description", "error_uri"])(
	"refuses configured redirect query member %s that would shadow a callback field",
	(name) => {
		expect(() => fixture({ redirectUri: `${REDIRECT}?${name}=DYTEST-fixed` })).toThrow(REFUSED);
	},
);

it.each(PROFILES)(
	"%s completes the authorization, refresh and revoke flow through the genuine fake",
	async (profile) => {
		const outbound = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("DYTEST-network-forbidden"));
		const test = fixture({ profile });
		expect(Object.hasOwn(test.options, "clientId")).toBe(false);
		const authorization = new URL(await test.client.beginAuthorization());
		expect(authorization.origin + authorization.pathname).toBe(`${ISSUER}/authorize`);
		expect(authorization.searchParams.get("client_id")).toBe(test.clientId);
		expect(authorization.searchParams.get("redirect_uri")).toBe(test.redirectUri);
		expect(authorization.searchParams.get("scope")).toBe("mcp:read mcp:invoke");
		const callback = `${test.redirectUri}?${new URLSearchParams({
			iss: ISSUER,
			state: authorization.searchParams.get("state") ?? "",
			code: "DYTEST-code",
		})}`;
		const exchanged = await test.client.acceptCallback(callback);
		expect(exchanged).toMatchObject({
			kind: "exchange",
			reply: { status: 200, body: { access_token: "DYTEST-access" } },
		});
		expect((await test.client.refresh("DYTEST-refresh")).status).toBe(200);
		expect((await test.client.revoke("DYTEST-refresh")).status).toBe(200);
		expect(await test.client.callResource("DYTEST-access")).toBe(200);
		const requests = test.transport.recorder.takeRequests();
		expect(requests.map((request) => request.path)).toEqual([
			"/mcp",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-authorization-server",
			"/token",
			"/token",
			"/revoke",
			"/mcp",
		]);
		expect(requests.every((request) => request.host === "as.draftyak.example")).toBe(true);
		for (const request of [requests[0], requests[6]]) {
			expect(request?.method).toBe("POST");
			expect(request?.headers["content-type"]).toBe("application/json");
			expect(request?.headers.accept).toBe("application/json, text/event-stream");
			expect(JSON.parse(new TextDecoder().decode(request?.body))).toEqual({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "DYTEST-connector", version: "0.0.0" },
				},
			});
		}
		expect(requests[0]?.headerNames).not.toContain("authorization");
		expect(requests[6]?.headers.authorization).toBe("Bearer DYTEST-access");
		const forms = requests
			.slice(3, 6)
			.map((request) => new URLSearchParams(new TextDecoder().decode(request.body)));
		expect(forms[0]?.get("grant_type")).toBe("authorization_code");
		expect(forms[0]?.get("redirect_uri")).toBe(test.redirectUri);
		expect(forms[1]?.get("grant_type")).toBe("refresh_token");
		expect(forms[2]?.get("token")).toBe("DYTEST-refresh");
		const jtis: string[] = [];
		for (const form of forms) {
			expect(form.get("client_id")).toBe(test.clientId);
			expect(form.has("client_secret")).toBe(false);
			if (profile !== "cimd-private") {
				expect(form.has("client_assertion")).toBe(false);
				expect(form.has("client_assertion_type")).toBe(false);
				continue;
			}
			expect(form.get("client_assertion_type")).toBe(
				"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
			);
			const assertion = form.get("client_assertion") ?? "";
			const [header = "", payload = "", signature = ""] = assertion.split(".");
			const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
			const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
			expect(decodedHeader).toMatchObject({ alg: "RS256", typ: "JWT" });
			expect(claims).toMatchObject({ iss: test.clientId, sub: test.clientId, aud: TOKEN });
			expect(claims.exp - claims.iat).toBe(60);
			expect(claims.jti).toMatch(/^[a-f0-9]{32}$/u);
			jtis.push(claims.jti);
			const keys = test.client.clientJwks()?.keys as readonly Record<string, unknown>[];
			const key = keys.find((key) => key.kid === decodedHeader.kid);
			if (!key) throw new Error("Expected generated public signing material");
			expect(
				verify(
					"RSA-SHA256",
					Buffer.from(`${header}.${payload}`),
					createPublicKey({ key, format: "jwk" }),
					Buffer.from(signature, "base64url"),
				),
			).toBe(true);
			expect(key).not.toHaveProperty("d");
		}
		if (profile === "cimd-private") expect(new Set(jtis).size).toBe(3);
		await vi.waitFor(() => expect(test.cancelled).toEqual([1, 1]));
		expect(outbound).not.toHaveBeenCalled();
	},
);

it("rejects metadata auth mismatches before reaching the transport", () => {
	const test = fixture();
	expect(
		() =>
			new ConnectorClient({
				...test.options,
				metadata: {
					...(test.options.metadata as Record<string, unknown>),
					token_endpoint_auth_method: "private_key_jwt",
				},
			}),
	).toThrow(REFUSED);
	expect(test.transport.recorder.takeRequests()).toHaveLength(0);
});

it("refuses a forged plain transport before invoking its fetch function", () => {
	const outbound = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("DYTEST-network-forbidden"));
	const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
		throw new Error("DYTEST-DNS-forbidden");
	});
	const test = fixture();
	const fetch = vi.fn();
	const forged = { host: "as.draftyak.example", fetch } as unknown as Fake;
	expect(() => new ConnectorClient({ ...test.options, transport: forged })).toThrow(
		ConnectorClientError,
	);
	expect(fetch).not.toHaveBeenCalled();
	expect(test.transport.recorder.takeRequests()).toHaveLength(0);
	expect(outbound).not.toHaveBeenCalled();
	expect(lookup).not.toHaveBeenCalled();
});

it("uses the genuine captured transport after its public fetch method was replaced", async () => {
	const outbound = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("DYTEST-network-forbidden"));
	const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
		throw new Error("DYTEST-DNS-forbidden");
	});
	const test = fixture();
	const replacement = vi.fn(async () => {
		throw new Error("DYTEST-replaced-fetch");
	});
	test.transport.fetch = replacement;
	const client = new ConnectorClient(test.options);
	expect(await client.discover()).toMatchObject({ issuer: ISSUER, resource: RESOURCE });
	expect(test.transport.recorder.takeRequests().map((request) => request.path)).toEqual([
		"/mcp",
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-authorization-server",
	]);
	expect(replacement).not.toHaveBeenCalled();
	expect(outbound).not.toHaveBeenCalled();
	expect(lookup).not.toHaveBeenCalled();
});

it("refuses a private profile when discovery advertises only public authentication", async () => {
	const test = fixture({ profile: "cimd-private", advertisedMethods: ["none"] });
	await expect(test.client.beginAuthorization()).rejects.toThrow(REFUSED);
	expect(test.transport.recorder.takeRequests().map((request) => request.path)).toEqual([
		"/mcp",
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-authorization-server",
	]);
});

it.each([
	{ scope: ["mcp:explicit", "mcp:second"], expected: "mcp:explicit mcp:second" },
	{ scope: "none" as const, expected: null },
	{ scope: [], expected: null },
])("uses the explicit scope selection $scope", async ({ scope, expected }) => {
	const test = fixture({ scope });
	expect(new URL(await test.client.beginAuthorization()).searchParams.get("scope")).toBe(expected);
});

it("snapshots an explicit scope array before discovery", async () => {
	const scope = ["mcp:original"];
	const test = fixture({ scope });
	scope[0] = "mcp:changed";
	scope.push("mcp:extra");
	expect(new URL(await test.client.beginAuthorization()).searchParams.get("scope")).toBe(
		"mcp:original",
	);
});

it("uses challenge scopes ahead of the resource metadata fallback", async () => {
	const test = fixture({ challengeScope: "mcp:challenge", fallbackScopes: ["mcp:fallback"] });
	expect(new URL(await test.client.beginAuthorization()).searchParams.get("scope")).toBe(
		"mcp:challenge",
	);
});

it("snapshots fallback scopes when the challenge omits its scope field", async () => {
	const fallback = ["mcp:fallback", "mcp:second"];
	const test = fixture({ challengeScope: null, fallbackScopes: fallback });
	await test.client.discover();
	fallback[0] = "mcp:changed";
	test.resourceMetadata.scopes_supported = ["mcp:replacement"];
	expect(new URL(await test.client.beginAuthorization()).searchParams.get("scope")).toBe(
		"mcp:fallback mcp:second",
	);
});

it("omits scope when both discovery sources omit it", async () => {
	const test = fixture({ challengeScope: null });
	delete test.resourceMetadata.scopes_supported;
	expect(new URL(await test.client.beginAuthorization()).searchParams.has("scope")).toBe(false);
});

it("refuses option and scope-array hooks without executing them", () => {
	const test = fixture();
	let hooks = 0;
	const trap = () => {
		hooks++;
		throw new Error("DYTEST-input-hook");
	};
	const getterArray = Object.defineProperty(["mcp:read"], "0", { get: trap });
	const proxyArray = new Proxy(["mcp:read"], { get: trap, ownKeys: trap, getPrototypeOf: trap });
	const revoked = Proxy.revocable(["mcp:read"], {});
	revoked.revoke();
	for (const options of [
		Object.defineProperty({ ...test.options }, "scope", { get: trap }),
		new Proxy(test.options, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
		{ ...test.options, scope: getterArray },
		{ ...test.options, scope: proxyArray },
		{ ...test.options, scope: revoked.proxy },
		{ ...test.options, scope: new Array<string>(1) },
	])
		expect(() => new ConnectorClient(options)).toThrow(REFUSED);
	expect(hooks).toBe(0);
	expect(test.transport.recorder.takeRequests()).toHaveLength(0);
});

it.each([
	{ scope: ["mcp:duplicate", "mcp:duplicate"] },
	{ scope: ["contains space"] },
	{ scope: ['quote"'] },
	{ scope: ["back\\slash"] },
	{ scope: [""] },
	{ scope: new Array<string>(65).fill("mcp:too-many") },
])("refuses malformed explicit scope values $scope", ({ scope }) => {
	expect(() => fixture({ scope })).toThrow(REFUSED);
});

it.each(["mcp:read  mcp:invoke", "mcp:duplicate mcp:duplicate", ""])(
	"refuses malformed advertised challenge scopes %j",
	async (challengeScope) => {
		const test = fixture({ challengeScope });
		await expect(test.client.beginAuthorization()).rejects.toThrow(REFUSED);
		expect(
			test.transport.recorder.takeRequests().some((request) => request.path === "/token"),
		).toBe(false);
	},
);

it("refuses duplicate challenge scope attributes", async () => {
	const test = fixture();
	test.responses.set(
		"/mcp",
		() =>
			new Response("DYTEST-challenge", {
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", scope="mcp:one", scope="mcp:two"`,
				},
			}),
	);
	await expect(test.client.beginAuthorization()).rejects.toThrow(REFUSED);
});
