import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AudienceForm } from "../src/cimd.ts";
import {
	type CimdAs,
	type Connector,
	chatgpt,
	claudeAi,
	FakeVendorHost,
	type Reply,
	recorded,
	ScriptedClient,
	standIn,
	startCimdAs,
	typesCode,
} from "./connectors.ts";
import { authorizeUrl, Browser, callMcp, epoch } from "./flow.ts";

let vendor: FakeVendorHost;
let as: CimdAs;
let strict: CimdAs;
const gpt = chatgpt();
const jwksUri = String(recorded("chatgpt").document.jwks_uri);
// What each AS reported of the assertions it verified.
const forms: AudienceForm[] = [];
const strictForms: AudienceForm[] = [];

beforeAll(async () => {
	vendor = await FakeVendorHost.start();
	vendor.serveAll(gpt.documents);
	as = await startCimdAs(vendor, { policy: { onAssertion: (form) => forms.push(form) } });
	strict = await startCimdAs(vendor, {
		policy: { audience: "issuer", onAssertion: (form) => strictForms.push(form) },
	});
});
afterAll(async () => {
	await as?.close();
	await strict?.close();
	await vendor?.close();
});

const scripted = (connector: Connector = gpt, on: CimdAs = as): ScriptedClient =>
	new ScriptedClient(connector, { origin: on.origin, approve: typesCode(on) });

// The code exchange with an assertion naming `aud`.
async function exchangeNaming(aud: unknown, on: CimdAs = as): Promise<Reply> {
	const client = scripted(gpt, on);
	const authorized = await client.authorize();
	return client.post(
		"token_endpoint",
		{
			grant_type: "authorization_code",
			code: authorized.code,
			redirect_uri: gpt.redirectUri,
			code_verifier: authorized.verifier,
		},
		{ assertion: await client.assertion({ claims: { aud } }) },
	);
}

// A private_key_jwt connector with its own document and key, served by the fake vendor host.
function keyedConnector(url: string, document: Record<string, unknown>): Connector {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "stand-in-key";
	const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
	const documents = new Map([
		[url, JSON.stringify(document)],
		[String(document.jwks_uri), JSON.stringify({ keys: [jwk] })],
	]);
	vendor.serveAll(documents);
	const redirectUri = String((document.redirect_uris as string[])[0]);
	return {
		name: "chatgpt",
		clientId: url,
		redirectUri,
		auth: "private_key_jwt",
		key: privateKey,
		kid,
		documents,
		requires: [],
	};
}

describe("the fake ChatGPT connector (RS256 private_key_jwt, jwks_uri)", () => {
	test("finds everything ChatGPT needs, and completes authorization with refresh, rotation and reuse revocation", async () => {
		const client = scripted();
		expect((await client.discover()).unmet).toStrictEqual([]);
		const tokens = await client.connect();
		expect(as.pushes.at(-1)).toMatchObject({ clientName: "ChatGPT", redirectHost: "chatgpt.com" });
		const rotated = await client.refresh(tokens.refreshToken);
		expect(rotated.status).toBe(200);
		expect(rotated.body.refresh_token).not.toBe(tokens.refreshToken);
		expect(await client.callMcp(String(rotated.body.access_token))).toBe(200);
		const reused = await client.refresh(tokens.refreshToken);
		expect([reused.status, reused.body.error]).toStrictEqual([400, "invalid_grant"]);
		expect((await client.refresh(String(rotated.body.refresh_token))).body.error).toBe(
			"invalid_grant",
		);
		expect(await callMcp(as, String(rotated.body.access_token))).toBe(401);
	});

	test("revokes with its assertion; an unauthenticated revocation or refresh is refused", async () => {
		const client = scripted();
		const tokens = await client.connect();
		const bare = new URLSearchParams({ client_id: gpt.clientId ?? "", token: tokens.refreshToken });
		const unauthenticated = await fetch(`${as.origin}/oauth/revoke`, {
			method: "POST",
			body: bare,
		});
		expect([unauthenticated.status, (await unauthenticated.json()).error]).toStrictEqual([
			401,
			"invalid_client",
		]);
		expect(await client.callMcp(tokens.accessToken)).toBe(200);
		expect((await client.revoke(tokens.refreshToken)).status).toBe(200);
		expect(await client.callMcp(tokens.accessToken)).toBe(401);
	});

	test("the document is fetched once while cached; the JWKS for every authenticated request", async () => {
		const client = scripted();
		const [documents, keys] = [vendor.count(gpt.clientId ?? ""), vendor.count(jwksUri)];
		const tokens = await client.connect();
		await client.refresh(tokens.refreshToken);
		expect(vendor.count(gpt.clientId ?? "")).toBe(documents === 0 ? 1 : documents);
		// oidc-provider 9.12.2 builds a new client from the cached document on every lookup, and with
		// it a new key store: one JWKS fetch for the code exchange, one for the refresh.
		expect(vendor.count(jwksUri) - keys).toBe(2);
	});

	test("an assertion signed by the stand-in fails against the key ChatGPT really publishes", async () => {
		const client = scripted();
		const authorized = await client.authorize();
		vendor.serve(jwksUri, JSON.stringify(recorded("chatgpt-jwks").document));
		try {
			const refused = await client.exchange(authorized);
			expect([refused.status, refused.body.error]).toStrictEqual([401, "invalid_client"]);
		} finally {
			vendor.serveAll(gpt.documents);
		}
		expect((await client.exchange(authorized)).status).toBe(200);
	});
});

describe("client assertions at the token endpoint", () => {
	// Client authentication runs before the code is looked at, so one code serves every case.
	let client: ScriptedClient;
	let exchange: (assertion: string) => Promise<Reply>;
	beforeAll(async () => {
		client = scripted();
		const authorized = await client.authorize();
		exchange = (assertion) =>
			client.post(
				"token_endpoint",
				{
					grant_type: "authorization_code",
					code: authorized.code,
					redirect_uri: gpt.redirectUri,
					code_verifier: authorized.verifier,
				},
				{ assertion },
			);
	});

	const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
	test.each([
		[
			"aud names another server's token endpoint",
			{ claims: { aud: "https://evil.example/oauth/token" } },
		],
		["aud is missing", { claims: { aud: undefined } }],
		["alg names HS256", { header: { alg: "HS256" } }],
		["alg names PS256", { header: { alg: "PS256" } }],
		["alg names none", { header: { alg: "none" } }],
		["exp is missing", { claims: { exp: undefined } }],
		["exp has passed", { claims: { iat: epoch() - 600, exp: epoch() - 300 } }],
		["jti is missing", { claims: { jti: undefined } }],
		["iss names another client", { claims: { iss: claudeAi().clientId } }],
		["kid names no published key", { header: { kid: "unknown" } }],
	])("refused when %s", async (_name, overrides) => {
		const refused = await exchange(await client.assertion(overrides));
		expect([refused.status, refused.body.error]).toStrictEqual([401, "invalid_client"]);
	});

	test("refused when sub names another client: oidc-provider takes sub as the client_id", async () => {
		const refused = await exchange(
			await client.assertion({ claims: { sub: claudeAi().clientId } }),
		);
		expect(refused).toMatchObject({
			status: 400,
			body: { error: "invalid_request", error_description: "client_id mismatch" },
		});
	});

	test("refused when signed with another key under the published kid", async () => {
		const forged = new ScriptedClient(
			{ ...gpt, key: otherKey },
			{ origin: as.origin, approve: typesCode(as) },
		);
		const refused = await exchange(await forged.assertion());
		expect([refused.status, refused.body.error]).toStrictEqual([401, "invalid_client"]);
	});

	test("refused when replayed", async () => {
		const assertion = await client.assertion({ claims: { aud: as.origin } });
		const first = await exchange(assertion);
		expect(first.status).toBe(200);
		const replayed = await exchange(assertion);
		expect([replayed.status, replayed.body.error_description]).toStrictEqual([
			401,
			"client authentication failed",
		]);
	});
});

// The spike's default rule, kept only so M0.20 can record which audience ChatGPT sends: these
// acceptances are not meant to reach M9.
describe("the spike's default audience rule (endpoints)", () => {
	test.each([
		["the issuer", (issuer: string) => issuer, "issuer"],
		["the token endpoint", (issuer: string) => `${issuer}/oauth/token`, "token endpoint"],
		["a list holding the issuer", (issuer: string) => ["https://other.example", issuer], "list"],
	])("accepts an assertion whose aud is %s, and reports it as %s", async (_name, aud, form) => {
		expect((await exchangeNaming(aud(as.origin))).status).toBe(200);
		expect(forms.at(-1)).toBe(form);
	});

	test("accepts this endpoint's URL at revocation, and reports it as endpoint", async () => {
		const client = scripted();
		const tokens = await client.connect();
		const assertion = await client.assertion({}, `${as.origin}/oauth/revoke`);
		const revoked = await client.post(
			"revocation_endpoint",
			{ token: tokens.refreshToken },
			{ assertion },
		);
		expect(revoked.status).toBe(200);
		expect(forms.at(-1)).toBe("endpoint");
	});

	test("takes its audiences from the issuer, whatever the request named", () => {
		const audiences = (route: string) => [
			...as.provider.OIDCContext.prototype.clientJwtAuthExpectedAudience.call({
				route,
				clientJwtAuthExpectedAudience: () => new Set(),
			}),
		];
		expect(audiences("token")).toStrictEqual([as.origin, `${as.origin}/oauth/token`]);
		expect(audiences("revocation")).toStrictEqual([
			as.origin,
			`${as.origin}/oauth/token`,
			`${as.origin}/oauth/revoke`,
		]);
	});
});

// draft-ietf-oauth-rfc7523bis: the issuer alone, as one string. M9's rule if M0.20 finds ChatGPT
// sends the issuer.
describe("the issuer-only audience rule", () => {
	test("accepts the issuer, as one string", async () => {
		expect((await exchangeNaming(strict.origin, strict)).status).toBe(200);
		expect(strictForms.at(-1)).toBe("issuer");
	});

	test.each([
		["the token endpoint", (issuer: string) => `${issuer}/oauth/token`],
		["a list holding the issuer", (issuer: string) => ["https://other.example", issuer]],
		["a list of the issuer alone", (issuer: string) => [issuer]],
	])("refuses an assertion whose aud is %s", async (_name, aud) => {
		const refused = await exchangeNaming(aud(strict.origin), strict);
		expect([refused.status, refused.body.error]).toStrictEqual([401, "invalid_client"]);
	});

	test("expects only the issuer, at every endpoint", () => {
		for (const route of ["token", "revocation"]) {
			const audiences = strict.provider.OIDCContext.prototype.clientJwtAuthExpectedAudience.call({
				route,
				clientJwtAuthExpectedAudience: () => new Set(),
			});
			expect([...audiences], route).toStrictEqual([strict.origin]);
		}
	});
});

describe("jwks_uri through the guard", () => {
	test("a jwks_uri host that resolves to a private address is refused at the token endpoint, without connecting", async () => {
		const { url = "", document = {} } = standIn("private-jwks");
		const connector = keyedConnector(url, document);
		const keysHost = new URL(String(document.jwks_uri)).hostname;
		vendor.resolveTo(keysHost, "10.0.0.7");
		const client = scripted(connector);
		const authorized = await client.authorize();
		const dialed = vendor.dialed.length;
		const refused = await client.exchange(authorized);
		expect([refused.status, refused.body.error]).toStrictEqual([401, "invalid_client"]);
		expect(vendor.count(String(document.jwks_uri))).toBe(0);
		expect(vendor.dialed.slice(dialed)).toStrictEqual([]);
		vendor.resolveTo(keysHost, "203.0.113.11");
		expect((await client.exchange(authorized)).status).toBe(200);
	});

	test("a jwks_uri on a host nobody allowlisted refuses the client at authorization", async () => {
		const { url = "", document = {} } = standIn("outside-jwks");
		keyedConnector(url, document);
		const { url: start } = authorizeUrl(
			as,
			{ id: url, kind: "confidential", metadata: {} },
			{
				redirect_uri: String((document.redirect_uris as string[])[0]),
			},
		);
		const response = await new Browser().get(start);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("<p>error_description: client is not allowed</p>");
		expect(vendor.count(String(document.jwks_uri))).toBe(0);
	});

	test("a JWKS that holds a private key is refused", async () => {
		const url = `https://cimd.example/leaky-${randomBytes(4).toString("hex")}.json`;
		const jwks = `https://cimd.example/leaky-jwks-${randomBytes(4).toString("hex")}.json`;
		const connector = keyedConnector(url, {
			client_id: url,
			redirect_uris: ["https://cimd.example/callback"],
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "RS256",
			jwks_uri: jwks,
		});
		const leaked = {
			...connector.key?.export({ format: "jwk" }),
			kid: connector.kid,
			alg: "RS256",
		};
		vendor.serve(jwks, JSON.stringify({ keys: [leaked] }));
		const client = scripted(connector);
		const refused = await client.exchange(await client.authorize());
		expect([refused.status, refused.body.error]).toStrictEqual([401, "invalid_client"]);
	});
});
