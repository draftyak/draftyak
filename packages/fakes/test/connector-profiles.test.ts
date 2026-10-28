import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	type ConnectorProfileOptions,
	normalizeConnectorProfile,
} from "../src/connector-client/profiles.ts";

const CLIENT = "https://connector.example.net/metadata.json";
const REDIRECT = "https://connector.example.net/callback";
const ENDPOINT = "https://as.draftyak.example/token";
const REFUSED = /^Connector fixture refused$/;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

function publicMetadata() {
	return {
		client_id: CLIENT,
		redirect_uris: [REDIRECT],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
	};
}

function privateOptions(): ConnectorProfileOptions {
	return {
		profile: "cimd-private",
		redirectUri: REDIRECT,
		privateKey,
		metadata: {
			...publicMetadata(),
			token_endpoint_auth_method: "private_key_jwt",
			jwks_uri: "https://keys.example.net/jwks.json",
		},
	};
}

afterEach(() => vi.restoreAllMocks());

it("bounds the serialized metadata bytes for object inputs as well as JSON strings", () => {
	for (const extension of ["é".repeat(33_000), ["x".repeat(40_000), "x".repeat(40_000)]]) {
		expect(() =>
			normalizeConnectorProfile({
				profile: "cimd-public",
				redirectUri: REDIRECT,
				metadata: { ...publicMetadata(), extension },
			}),
		).toThrow(REFUSED);
	}
});

it("refuses malformed Unicode member names in object and serialized metadata alike", () => {
	const metadata = { ...publicMetadata(), ["DYTEST-\ud800"]: "value" };
	for (const value of [metadata, JSON.stringify(metadata)])
		expect(() =>
			normalizeConnectorProfile({ profile: "cimd-public", redirectUri: REDIRECT, metadata: value }),
		).toThrow(REFUSED);
});

it.each(["cimd-public", "issuer-resource"] as const)(
	"preserves the %s legacy form profile with any canonical HTTPS client host",
	(profile) => {
		const client = normalizeConnectorProfile({ profile, clientId: CLIENT, redirectUri: REDIRECT });
		expect(client.clientId).toBe(CLIENT);
		expect(client.redirectUri).toBe(REDIRECT);
		expect(client.requirements).toEqual({ cimd: profile === "cimd-public", authMethod: "none" });
		expect(client.clientMetadata()).toMatchObject({
			client_id: CLIENT,
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "none",
		});
		const form = new URLSearchParams({ grant_type: "refresh_token" });
		client.authenticateForm(form, ENDPOINT);
		expect([...form]).toEqual([
			["grant_type", "refresh_token"],
			["client_id", CLIENT],
		]);
		expect(client.clientJwks()).toBeUndefined();
	},
);

it("derives and snapshots public metadata without consulting global fetch", () => {
	const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST-no-network"));
	const metadata = publicMetadata();
	const client = normalizeConnectorProfile({
		profile: "cimd-public",
		redirectUri: REDIRECT,
		metadata,
	});
	metadata.client_id = "https://changed.example.net/metadata.json";
	metadata.redirect_uris[0] = "https://changed.example.net/callback";
	expect(client.clientId).toBe(CLIENT);
	expect(client.clientMetadata().redirect_uris).toEqual([REDIRECT]);
	expect(Object.isFrozen(client)).toBe(true);
	expect(Object.isFrozen(client.clientMetadata())).toBe(true);
	expect(Object.isFrozen(client.clientMetadata().redirect_uris)).toBe(true);
	expect(outbound).not.toHaveBeenCalled();
});

it("accepts the same bounded document as JSON and refuses duplicate metadata members", () => {
	const metadata = JSON.stringify(publicMetadata());
	expect(
		normalizeConnectorProfile({ profile: "cimd-public", redirectUri: REDIRECT, metadata }).clientId,
	).toBe(CLIENT);
	expect(() =>
		normalizeConnectorProfile({
			profile: "cimd-public",
			redirectUri: REDIRECT,
			metadata: metadata.replace('"client_id":', '"client_id":"DYTEST-duplicate","client_id":'),
		}),
	).toThrow(REFUSED);
});

it.each(["localhost", "127.0.0.1", "[::1]"])(
	"selects an arbitrary loopback port for recorded %s redirects",
	(host) => {
		const selected = `http://${host}:49163/callback`;
		const metadata = { ...publicMetadata(), redirect_uris: [`http://${host}/callback`] };
		const client = normalizeConnectorProfile({
			profile: "loopback-cimd",
			redirectUri: selected,
			metadata,
		});
		expect(client.redirectUri).toBe(selected);
		expect(client.clientMetadata().redirect_uris).toEqual([`http://${host}/callback`]);
		expect(client.requirements.cimd).toBe(true);
	},
);

it.each([
	"http://localhost:1/callback",
	"http://127.0.0.1:65535/callback",
	"http://[::1]:28441/callback",
	"https://redirect.example.net:8443/a%20b?fixture=DYTEST",
])("retains an exact authorized redirect spelling %s", (redirectUri) => {
	const client = normalizeConnectorProfile({
		profile: "registered-public",
		redirectUri,
		metadata: {
			...publicMetadata(),
			client_id: "DYTEST-registered-opaque",
			redirect_uris: [redirectUri],
		},
	});
	expect(client.clientId).toBe("DYTEST-registered-opaque");
	expect(client.redirectUri).toBe(redirectUri);
	expect(client.requirements.cimd).toBe(false);
});

it.each([
	"http://localhost.evil.example/callback",
	"http://192.0.2.10/callback",
	"http://[::2]/callback",
	"https://user:pass@redirect.example.net/callback",
	"https://redirect.example.net:443/callback",
	"https://redirect.example.net/unused/../callback",
	"https://redirect.example.net/callback?",
	"https://redirect.example.net/callback#",
	"https://redirect.example.net/callback#fragment",
	"https://redirect.example.net/callback ",
])("refuses an invalid redirect %s", (redirectUri) => {
	expect(() =>
		normalizeConnectorProfile({ profile: "cimd-public", clientId: CLIENT, redirectUri }),
	).toThrow(REFUSED);
});

it.each([
	"http://connector.example.net/metadata.json",
	"https://connector.example.net:443/metadata.json",
	"https://connector.example.net/metadata.json?",
	"https://connector.example.net/metadata.json#",
	"DYTEST-opaque-not-cimd",
])("requires a canonical HTTPS CIMD identity %s", (clientId) => {
	expect(() =>
		normalizeConnectorProfile({ profile: "cimd-public", clientId, redirectUri: REDIRECT }),
	).toThrow(REFUSED);
});

it("accepts a canonical HTTPS identity with a port and query without using it as a destination", () => {
	const clientId = "https://metadata.example.net:8443/client.json?fixture=DYTEST";
	expect(
		normalizeConnectorProfile({ profile: "cimd-public", clientId, redirectUri: REDIRECT }).clientId,
	).toBe(clientId);
});

it.each([
	{ clientId: "DYTEST-wrong" },
	{ metadata: { ...publicMetadata(), client_id: undefined } },
	{ metadata: { ...publicMetadata(), token_endpoint_auth_method: "client_secret_basic" } },
	{ metadata: { ...publicMetadata(), redirect_uris: [`${REDIRECT}/other`] } },
	{ metadata: { ...publicMetadata(), redirect_uris: [REDIRECT, "http://192.0.2.10/callback"] } },
	{ metadata: { ...publicMetadata(), client_secret: "DYTEST-rejected" } },
])("refuses inconsistent public metadata %j", (changed) => {
	expect(() =>
		normalizeConnectorProfile({
			profile: "cimd-public",
			redirectUri: REDIRECT,
			metadata: publicMetadata(),
			...changed,
		}),
	).toThrow(REFUSED);
});

it.each([
	"http://127.0.0.1:49163/other",
	"http://localhost:49163/callback",
	"http://127.0.0.1:49163/callback?other=DYTEST",
])("a loopback exception cannot change host, path or query: %s", (redirectUri) => {
	expect(() =>
		normalizeConnectorProfile({
			profile: "loopback-cimd",
			redirectUri,
			metadata: { ...publicMetadata(), redirect_uris: ["http://127.0.0.1/callback"] },
		}),
	).toThrow(REFUSED);
});

it("uses port-independent matching only for the loopback profile", () => {
	expect(() =>
		normalizeConnectorProfile({
			profile: "cimd-public",
			redirectUri: "http://127.0.0.1:49163/callback",
			metadata: { ...publicMetadata(), redirect_uris: ["http://127.0.0.1/callback"] },
		}),
	).toThrow(REFUSED);
});

it("signs fresh bounded RS256 assertions with the generated key and selected audience", () => {
	const client = normalizeConnectorProfile(privateOptions());
	expect(client.requirements).toEqual({ cimd: true, authMethod: "private_key_jwt" });
	expect(client.clientMetadata().jwks_uri).toBe("https://keys.example.net/jwks.json");
	const assertions: Array<Record<string, unknown>> = [];
	for (let attempt = 0; attempt < 2; attempt++) {
		const form = new URLSearchParams();
		client.authenticateForm(form, ENDPOINT);
		expect(form.get("client_id")).toBe(CLIENT);
		expect(form.has("client_secret")).toBe(false);
		expect(form.get("client_assertion_type")).toBe(
			"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
		);
		const assertion = form.get("client_assertion") ?? "";
		expect(assertion.length).toBeLessThan(8192);
		const [encodedHeader = "", encodedClaims = "", signature = ""] = assertion.split(".");
		const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
		const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString());
		expect(header).toMatchObject({ alg: "RS256", typ: "JWT" });
		expect(claims).toMatchObject({ iss: CLIENT, sub: CLIENT, aud: ENDPOINT });
		expect(claims.exp - claims.iat).toBe(60);
		expect(claims.iat).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 1);
		expect(claims.jti).toMatch(/^[a-f0-9]{32}$/u);
		expect(
			verify(
				"RSA-SHA256",
				Buffer.from(`${encodedHeader}.${encodedClaims}`),
				publicKey,
				Buffer.from(signature, "base64url"),
			),
		).toBe(true);
		const jwks = client.clientJwks();
		const key = ((jwks?.keys ?? []) as Array<Record<string, unknown>>)[0];
		expect(key?.kid).toBe(header.kid);
		expect(key).not.toHaveProperty("d");
		expect(key).not.toHaveProperty("p");
		assertions.push(claims);
	}
	expect(assertions[0]?.jti).not.toBe(assertions[1]?.jti);
});

it("can pin assertion audience for a revocation request", () => {
	const client = normalizeConnectorProfile({ ...privateOptions(), assertionAudience: ENDPOINT });
	const form = new URLSearchParams();
	client.authenticateForm(form, "https://as.draftyak.example/revoke");
	const claims = JSON.parse(
		Buffer.from((form.get("client_assertion") ?? "").split(".")[1] ?? "", "base64url").toString(),
	);
	expect(claims.aud).toBe(ENDPOINT);
});

it("serves only generated public key material for inline private-profile metadata", () => {
	const client = normalizeConnectorProfile({
		...privateOptions(),
		metadata: {
			...publicMetadata(),
			token_endpoint_auth_method: "private_key_jwt",
			jwks: { keys: [{ kty: "RSA", n: "DYTEST-public-placeholder", e: "AQAB" }] },
		},
	});
	expect(client.clientMetadata().jwks).toBe(client.clientJwks());
});

it.each([
	{ privateKey: undefined },
	{ privateKey: publicKey },
	{ privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey },
	{ privateKey: generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey },
	{ metadata: { ...publicMetadata(), token_endpoint_auth_method: "none" } },
	{
		metadata: {
			...publicMetadata(),
			token_endpoint_auth_method: "private_key_jwt",
			jwks: { keys: [{ kty: "RSA", d: "DYTEST-private-component-refused" }] },
		},
	},
])("refuses invalid private profile configuration %j", (change) => {
	expect(() => normalizeConnectorProfile({ ...privateOptions(), ...change })).toThrow(REFUSED);
});

it("refuses option and nested metadata hooks without executing them", () => {
	let hooks = 0;
	const trap = () => {
		hooks++;
		throw new Error("DYTEST-must-not-run");
	};
	const valid: ConnectorProfileOptions = {
		profile: "cimd-public",
		redirectUri: REDIRECT,
		metadata: publicMetadata(),
	};
	const getterMetadata = Object.defineProperty(publicMetadata(), "client_id", { get: trap });
	const getterArray = Object.defineProperty([REDIRECT], "0", { get: trap });
	for (const raw of [
		Object.defineProperty({ ...valid }, "metadata", { get: trap }),
		new Proxy(valid, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
		{ ...valid, metadata: getterMetadata },
		{ ...valid, metadata: new Proxy(publicMetadata(), { get: trap, ownKeys: trap }) },
		{ ...valid, metadata: { ...publicMetadata(), redirect_uris: getterArray } },
		{ ...valid, metadata: { ...publicMetadata(), extension: { toJSON: trap } } },
		{ ...privateOptions(), privateKey: new Proxy(privateKey, { get: trap }) },
	])
		expect(() => normalizeConnectorProfile(raw)).toThrow(REFUSED);
	expect(hooks).toBe(0);
});

it("refuses accessors attached to a native private key without invoking them", () => {
	const generated = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
	let hooks = 0;
	Object.defineProperty(generated, "type", {
		get() {
			hooks++;
			throw new Error("DYTEST-key-hook");
		},
	});
	expect(() => normalizeConnectorProfile({ ...privateOptions(), privateKey: generated })).toThrow(
		REFUSED,
	);
	expect(hooks).toBe(0);
});

it("bounds metadata depth, nodes and bytes", () => {
	let nested: unknown = null;
	for (let depth = 0; depth < 17; depth++) nested = { nested };
	for (const extension of [nested, new Array(2049).fill(0), "x".repeat(64 * 1024)])
		expect(() =>
			normalizeConnectorProfile({
				profile: "cimd-public",
				redirectUri: REDIRECT,
				metadata: { ...publicMetadata(), extension },
			}),
		).toThrow(REFUSED);
});

it("does not accept pre-filled authentication fields or invoke a form override", () => {
	const client = normalizeConnectorProfile(privateOptions());
	for (const field of ["client_secret", "client_assertion", "client_assertion_type"])
		expect(() =>
			client.authenticateForm(new URLSearchParams({ [field]: "DYTEST" }), ENDPOINT),
		).toThrow(REFUSED);
	const form = new URLSearchParams();
	Object.defineProperty(form, "set", {
		get: () => {
			throw new Error("DYTEST-form-hook");
		},
	});
	client.authenticateForm(form, ENDPOINT);
	expect(form.get("client_id")).toBe(CLIENT);
	expect(form.get("client_assertion")).toBeTruthy();
});

it("the exported public JWK verifies the generated assertion", () => {
	const client = normalizeConnectorProfile(privateOptions());
	const form = new URLSearchParams();
	client.authenticateForm(form, ENDPOINT);
	const assertion = form.get("client_assertion") ?? "";
	const [header = "", claims = "", signature = ""] = assertion.split(".");
	const jwk = ((client.clientJwks()?.keys ?? []) as Array<Record<string, unknown>>)[0];
	if (!jwk) throw new Error("Expected a generated public JWK");
	const key = createPublicKey({ key: jwk, format: "jwk" });
	expect(
		verify(
			"RSA-SHA256",
			Buffer.from(`${header}.${claims}`),
			key,
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
});
