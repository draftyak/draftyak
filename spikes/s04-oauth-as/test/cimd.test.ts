import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CIMD_HOSTS } from "../src/cimd.ts";
import { METADATA_PATH } from "../src/routes.ts";
import {
	type CimdAs,
	chatgpt,
	claudeAi,
	claudeCode,
	FakeVendorHost,
	type RecordedName,
	recorded,
	ScriptedClient,
	standIn,
	startCimdAs,
	typesCode,
} from "./connectors.ts";
import { authorizeUrl, Browser, callMcp } from "./flow.ts";

let vendor: FakeVendorHost;
let as: CimdAs;
const claude = claudeAi();

beforeAll(async () => {
	vendor = await FakeVendorHost.start();
	vendor.serveAll(claude.documents);
	as = await startCimdAs(vendor);
});
afterAll(async () => {
	await as?.close();
	await vendor?.close();
});

const NAMES: readonly RecordedName[] = ["claude-ai", "claude-code", "chatgpt", "chatgpt-jwks"];

describe("the recorded documents (fixtures/cimd/)", () => {
	test.each(NAMES)("%s: the bytes served, from an allowlisted host, 200, dated", (name) => {
		const { source, fetchedAt, response, sha256, document } = recorded(name);
		expect(createHash("sha256").update(JSON.stringify(document)).digest("hex")).toBe(sha256);
		const url = new URL(source);
		expect(url.protocol).toBe("https:");
		expect(CIMD_HOSTS).toContain(url.host);
		expect(response.status).toBe(200);
		expect(response.contentType).toMatch(/^application\/json\b/);
		expect(new Date(fetchedAt).toISOString()).toBe(fetchedAt);
		if (name !== "chatgpt-jwks") expect(document.client_id).toBe(source);
	});

	test("hold no client secret, and only public keys", () => {
		for (const name of NAMES) {
			const { document } = recorded(name);
			expect(Object.keys(document), name).not.toContain("client_secret");
		}
		const { keys } = recorded("chatgpt-jwks").document as { keys: Record<string, unknown>[] };
		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
			for (const part of ["d", "p", "q", "dp", "dq", "qi"]) expect(key).not.toHaveProperty(part);
		}
	});

	test("claude.ai's connector is public; ChatGPT's uses RS256 private_key_jwt with a jwks_uri on its own host; remote Claude Code's redirects are all loopback", () => {
		const ai = recorded("claude-ai").document;
		const gpt = recorded("chatgpt").document;
		const code = recorded("claude-code").document;
		expect(ai.token_endpoint_auth_method).toBe("none");
		expect(gpt).toMatchObject({
			token_endpoint_auth_method: "private_key_jwt",
			token_endpoint_auth_signing_alg: "RS256",
		});
		expect(new URL(String(gpt.jwks_uri)).host).toBe(new URL(String(gpt.client_id)).host);
		expect(recorded("chatgpt-jwks").source).toBe(gpt.jwks_uri);
		expect(code.token_endpoint_auth_method).toBe("none");
		for (const uri of code.redirect_uris as string[]) {
			expect(uri).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1)\//);
		}
	});
});

test("the metadata advertises CIMD, both client auth methods, S256 and iss, and no registration", async () => {
	const metadata = await (await fetch(`${as.origin}${METADATA_PATH}`)).json();
	expect(metadata).toStrictEqual({
		issuer: as.origin,
		authorization_endpoint: `${as.origin}/oauth/authorize`,
		token_endpoint: `${as.origin}/oauth/token`,
		jwks_uri: `${as.origin}/oauth/jwks`,
		scopes_supported: ["inbox:read", "inbox:organize", "drafts:write", "outbox:propose"],
		response_types_supported: ["code"],
		response_modes_supported: ["form_post", "fragment", "query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
		token_endpoint_auth_signing_alg_values_supported: ["RS256"],
		revocation_endpoint: `${as.origin}/oauth/revoke`,
		code_challenge_methods_supported: ["S256"],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
		revocation_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
		revocation_endpoint_auth_signing_alg_values_supported: ["RS256"],
	});
});

describe("the fake claude.ai connector (public CIMD client)", () => {
	test("finds everything claude.ai needs before it uses CIMD", async () => {
		const client = new ScriptedClient(claude, { origin: as.origin, approve: typesCode(as) });
		const { unmet, issuer, resource } = await client.discover();
		expect(unmet).toStrictEqual([]);
		expect([issuer, resource]).toStrictEqual([as.origin, `${as.origin}/mcp`]);
		for (const connector of [claudeCode(), chatgpt()]) {
			const other = new ScriptedClient(connector, { origin: as.origin, approve: typesCode(as) });
			expect((await other.discover()).unmet, connector.name).toStrictEqual([]);
		}
	});

	test("completes authorization, refreshes with rotation, and a reused refresh token revokes the grant", async () => {
		const client = new ScriptedClient(claude, { origin: as.origin, approve: typesCode(as) });
		const tokens = await client.connect();
		expect(tokens.scope).toBe("inbox:read drafts:write outbox:propose");
		expect(as.pushes.at(-1)).toMatchObject({
			clientId: claude.clientId,
			clientName: "Claude",
			redirectHost: "claude.ai",
		});
		const rotated = await client.refresh(tokens.refreshToken);
		expect(rotated.status).toBe(200);
		const next = String(rotated.body.refresh_token);
		expect(next).not.toBe(tokens.refreshToken);
		expect(await client.callMcp(String(rotated.body.access_token))).toBe(200);
		const reused = await client.refresh(tokens.refreshToken);
		expect([reused.status, reused.body.error]).toStrictEqual([400, "invalid_grant"]);
		expect((await client.refresh(next)).body.error).toBe("invalid_grant");
		expect(await callMcp(as, tokens.accessToken)).toBe(401);
		expect(await callMcp(as, String(rotated.body.access_token))).toBe(401);
	});

	test("revocation ends the grant", async () => {
		const client = new ScriptedClient(claude, { origin: as.origin, approve: typesCode(as) });
		const tokens = await client.connect();
		expect((await client.revoke(tokens.refreshToken)).status).toBe(200);
		expect((await client.refresh(tokens.refreshToken)).body.error).toBe("invalid_grant");
		expect(await client.callMcp(tokens.accessToken)).toBe(401);
	});

	test("the document is fetched once while cached, and the AS keeps only the grant types it serves", async () => {
		const client = new ScriptedClient(claude, { origin: as.origin, approve: typesCode(as) });
		await client.connect();
		expect(vendor.count(claude.clientId ?? "")).toBe(1);
		const resolved = await as.provider.Client.find(claude.clientId ?? "");
		expect(resolved?.clientIdMetadataDocument).toBe(true);
		expect(recorded("claude-ai").document.grant_types).toContain(
			"urn:ietf:params:oauth:grant-type:jwt-bearer",
		);
		expect(resolved?.grantTypes).toStrictEqual(["authorization_code", "refresh_token"]);
	});

	test("a refresh token is the client's alone", async () => {
		const tokens = await new ScriptedClient(claude, {
			origin: as.origin,
			approve: typesCode(as),
		}).connect();
		const code = claudeCode();
		vendor.serveAll(code.documents);
		const thief = new ScriptedClient(code, { origin: as.origin, approve: typesCode(as) });
		expect((await thief.refresh(tokens.refreshToken)).body.error).toBe("invalid_grant");
	});
});

// oidc-provider hides why: the guard's refusal, a status other than 200, its own 5 KiB cap.
const FETCH_FAILED = "invalid_client: client_id metadata document fetch failed";
const NOT_ALLOWED = "invalid_client: client_id metadata document fetch not allowed";

// The authorization request, as a browser sends it: an error page on the AS, never a redirect.
async function refused(clientId: string, redirectUri: string, on: CimdAs = as): Promise<string> {
	const client = { id: clientId, kind: "public" as const, metadata: {} };
	const { url } = authorizeUrl(on, client, { redirect_uri: redirectUri });
	const response = await new Browser().get(url);
	expect(response.status, clientId).toBe(400);
	expect(response.headers.get("location"), clientId).toBeNull();
	const page = await response.text();
	const field = (name: string): string =>
		new RegExp(`<p>${name}: ([^<]*)</p>`).exec(page)?.[1] ?? "";
	return `${field("error")}: ${field("error_description")}`;
}

describe("CIMD clients the AS refuses", () => {
	test("a client ID on a host nobody allowlisted, without fetching it", async () => {
		const { url = "", document = {} } = standIn("loopback-elsewhere");
		vendor.serve(url, JSON.stringify(document));
		expect(await refused(url, "http://localhost/callback")).toBe(NOT_ALLOWED);
		expect(vendor.count(url)).toBe(0);
		expect(vendor.resolved).not.toContain("agent.example");
	});

	test("an allowlisted host that resolves to a private address, without connecting", async () => {
		const url = "https://keys.cimd.example/client.json";
		vendor.serve(
			url,
			JSON.stringify({ client_id: url, redirect_uris: ["https://cimd.example/cb"] }),
		);
		vendor.resolveTo("keys.cimd.example", "10.20.30.40");
		const dialed = vendor.dialed.length;
		expect(await refused(url, "https://cimd.example/cb")).toBe(FETCH_FAILED);
		expect(vendor.dialed.length).toBe(dialed);
		expect(vendor.count(url)).toBe(0);
	});

	const redirect = { redirect_uris: ["https://cimd.example/cb"] };
	test.each([
		[
			"names another client_id",
			(url: string) => ({ client_id: `${url}#other`, ...redirect }),
			"invalid_client_metadata: client_id metadata document client_id does not match the expected value",
		],
		[
			"holds a client secret",
			(url: string) => ({ client_id: url, client_secret: "not-a-real-secret", ...redirect }),
			"invalid_client_metadata: client_id metadata document must not contain client_secret or client_secret_expires_at",
		],
		[
			"uses a shared-secret auth method",
			(url: string) => ({
				client_id: url,
				token_endpoint_auth_method: "client_secret_basic",
				...redirect,
			}),
			"invalid_client_metadata: client_id metadata document must not use shared-secret token endpoint authentication methods",
		],
		["isn't JSON", () => "<!doctype html><p>hello</p>", FETCH_FAILED],
	])("a document that %s", async (name, document, error) => {
		const url = `https://cimd.example/${name.replaceAll(/\W+/g, "-")}.json`;
		const body = document(url);
		vendor.serve(url, typeof body === "string" ? body : JSON.stringify(body));
		expect(await refused(url, "https://cimd.example/cb")).toBe(error);
	});

	test.each([
		["missing", { status: 404, body: "{}" }],
		["redirected", { status: 302, headers: { location: "https://cimd.example/elsewhere.json" } }],
		["over 5 KiB", { body: JSON.stringify({ padding: "x".repeat(6 * 1024) }) }],
	])("a document that is %s", async (name, answer) => {
		const url = `https://cimd.example/${name.replaceAll(/\W+/g, "-")}.json`;
		vendor.serve(url, answer);
		expect(await refused(url, "https://cimd.example/cb")).toBe(FETCH_FAILED);
		expect(vendor.count("https://cimd.example/elsewhere.json")).toBe(0);
	});

	test("an http client ID, which oidc-provider never treats as a document", async () => {
		expect(await refused("http://cimd.example/client.json", "https://cimd.example/cb")).toBe(
			"invalid_client: client is invalid",
		);
		expect(vendor.count("https://cimd.example/client.json")).toBe(0);
	});
});

// Each request naming an unknown client ID on an allowlisted host would otherwise make the AS GET it
// twice: oidc-provider caches only usable documents, and its error page looks the client up again.
describe("a client ID whose lookup failed", () => {
	let quick: CimdAs;
	beforeAll(async () => {
		quick = await startCimdAs(vendor, { policy: { retryMs: 500 } });
	});
	afterAll(async () => {
		await quick?.close();
	});

	test("is fetched once per request, and not again until retryMs has passed", async () => {
		const url = "https://cimd.example/not-yet.json";
		expect(await refused(url, "https://cimd.example/cb", quick)).toBe(FETCH_FAILED);
		expect(vendor.count(url)).toBe(1);
		expect(await refused(url, "https://cimd.example/cb", quick)).toBe(NOT_ALLOWED);
		expect(vendor.count(url)).toBe(1);
		vendor.serve(
			url,
			JSON.stringify({ client_id: url, redirect_uris: ["https://cimd.example/cb"] }),
		);
		await sleep(600);
		const client = { id: url, kind: "public" as const, metadata: {} };
		const { url: start } = authorizeUrl(quick, client, { redirect_uri: "https://cimd.example/cb" });
		expect((await new Browser().get(start)).status).toBe(303);
		expect(vendor.count(url)).toBe(2);
	});

	test("costs one fetch per new path, at the token endpoint too", async () => {
		const paths = ["a", "b", "c"].map((name) => `https://chatgpt.com/any/path-${name}?q=x`);
		for (const clientId of paths) {
			expect(await refused(clientId, "https://cimd.example/cb", quick)).toBe(FETCH_FAILED);
			const token = await fetch(`${quick.origin}/oauth/token`, {
				method: "POST",
				body: new URLSearchParams({
					client_id: clientId,
					grant_type: "refresh_token",
					refresh_token: "unknown",
				}),
			});
			expect([token.status, (await token.json()).error]).toStrictEqual([400, "invalid_client"]);
			expect(vendor.count(clientId), clientId).toBe(1);
		}
	});
});
