import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cimd, withoutLoopbackPort } from "../src/cimd.ts";
import {
	type CimdAs,
	claudeAi,
	claudeCode,
	FakeVendorHost,
	ScriptedClient,
	standIn,
	startCimdAs,
	typesCode,
} from "./connectors.ts";
import { authorizeUrl, Browser, startAs, type TestClient } from "./flow.ts";

let vendor: FakeVendorHost;
let as: CimdAs;
const code = claudeCode();
const codeId = code.clientId ?? "";
const mixed = standIn("mixed-redirects");
const elsewhere = standIn("loopback-elsewhere");
// A static client that oidc-provider 9.12.2 alone would let use any loopback port.
const native: TestClient = {
	id: "spike-native",
	kind: "public",
	metadata: {
		client_id: "spike-native",
		application_type: "native",
		token_endpoint_auth_method: "none",
		redirect_uris: ["http://127.0.0.1/callback"],
	},
};

beforeAll(async () => {
	vendor = await FakeVendorHost.start();
	vendor.serveAll(code.documents);
	vendor.serveAll(claudeAi().documents);
	for (const { url = "", document } of [mixed, elsewhere])
		vendor.serve(url, JSON.stringify(document));
	as = await startCimdAs(vendor, { clients: [native] });
});
afterAll(async () => {
	await as?.close();
	await vendor?.close();
});

// Whether the AS takes the redirect URI: the consent page, or its own error page (never a redirect).
async function accepts(clientId: string, redirectUri: string): Promise<boolean> {
	const client = { id: clientId, kind: "public" as const, metadata: {} };
	const response = await new Browser().get(
		authorizeUrl(as, client, { redirect_uri: redirectUri }).url,
	);
	const location = response.headers.get("location") ?? "";
	if (response.status === 303 && location.startsWith("/oauth/interaction/")) return true;
	expect(response.status, redirectUri).toBe(400);
	expect(await response.text(), redirectUri).toMatch(
		/<p>error: invalid_(?:redirect_uri|client)<\/p>/,
	);
	return false;
}

test.each([
	["http://localhost/callback", "http://localhost/callback"],
	["http://localhost:1/callback", "http://localhost/callback"],
	["http://127.0.0.1:65535/callback?x=1", "http://127.0.0.1/callback?x=1"],
	["http://[::1]:8080/", "http://[::1]/"],
	["http://localhost:0/callback", undefined],
	["http://localhost:065/callback", undefined],
	["http://localhost:65536/callback", undefined],
	["http://localhost:x/callback", undefined],
	["http://localhost:5@evil.example/callback", undefined],
	["http://localhost.evil.example:5/callback", undefined],
	["http://127.0.0.2:5/callback", undefined],
	["https://localhost:5/callback", undefined],
	["HTTP://LOCALHOST:5/callback", undefined],
	["http://localhost:5/callback#x", undefined],
])("withoutLoopbackPort(%s) is %s", (uri, expected) => {
	expect(withoutLoopbackPort(uri)).toBe(expected);
});

describe("the fake remote Claude Code (allowlisted CIMD, every redirect URI loopback)", () => {
	test("completes authorization on an ephemeral port, with refresh, rotation and reuse revocation", async () => {
		expect(new URL(code.redirectUri).port).not.toBe("");
		const client = new ScriptedClient(code, { origin: as.origin, approve: typesCode(as) });
		const tokens = await client.connect();
		expect(as.pushes.at(-1)).toMatchObject({
			clientName: "Claude Code",
			redirectHost: new URL(code.redirectUri).host,
		});
		const rotated = await client.refresh(tokens.refreshToken);
		expect(rotated.status).toBe(200);
		const reused = await client.refresh(tokens.refreshToken);
		expect([reused.status, reused.body.error]).toStrictEqual([400, "invalid_grant"]);
		expect(await client.callMcp(String(rotated.body.access_token))).toBe(401);
	});

	test.each([
		"http://localhost/callback",
		"http://127.0.0.1/callback",
		"http://localhost:1/callback",
		"http://localhost:65535/callback",
		"http://127.0.0.1:49152/callback",
	])("takes %s", async (uri) => {
		expect(await accepts(codeId, uri)).toBe(true);
	});

	test.each([
		"http://localhost:5/callback2",
		"http://localhost:5/callback/",
		"http://localhost:5/Callback",
		"http://localhost:5/callback?x=1",
		"http://localhost:5/callback#x",
		"http://localhost:5",
		"https://localhost:5/callback",
		"http://[::1]:5/callback",
		"http://127.0.0.2:5/callback",
		"http://user@localhost:5/callback",
		"http://localhost.evil.example:5/callback",
		"http://evil.example:5/callback",
		"http://localhost:0/callback",
		"http://localhost:65536/callback",
		"HTTP://LOCALHOST:5/callback",
	])("refuses %s", async (uri) => {
		expect(await accepts(codeId, uri)).toBe(false);
	});

	test("the token request repeats the exact redirect URI, port included", async () => {
		const client = new ScriptedClient(code, { origin: as.origin, approve: typesCode(as) });
		const authorized = await client.authorize();
		const other = new URL(code.redirectUri);
		other.port = String(Number(other.port) === 65_535 ? 49_152 : Number(other.port) + 1);
		const moved = await client.exchange(authorized, { redirect_uri: other.href });
		expect(moved.body).toStrictEqual({
			error: "invalid_grant",
			error_description: "grant request is invalid",
		});
		// The mismatch is checked before the code is spent.
		expect((await client.exchange(authorized)).status).toBe(200);
	});

	test("an error after the redirect check goes back to the ephemeral port, with iss", async () => {
		const { url } = authorizeUrl(
			as,
			{ id: codeId, kind: "public", metadata: {} },
			{
				redirect_uri: code.redirectUri,
				code_challenge: undefined,
			},
		);
		const response = await new Browser().get(url);
		const back = new URL(response.headers.get("location") ?? "");
		expect(response.status).toBe(303);
		expect(`${back.origin}${back.pathname}`).toBe(code.redirectUri);
		expect(back.searchParams.get("error")).toBe("invalid_request");
		expect(back.searchParams.get("iss")).toBe(as.origin);
	});
});

describe("only that client: every other client's redirect URIs match exactly", () => {
	test("the same all-loopback document from a host nobody allowlisted is refused outright", async () => {
		expect(await accepts(elsewhere.url ?? "", "http://localhost/callback")).toBe(false);
		expect(vendor.count(elsewhere.url ?? "")).toBe(0);
	});

	test("an allowlisted CIMD client with a loopback and an https redirect URI", async () => {
		const id = mixed.url ?? "";
		expect(await accepts(id, "http://localhost/callback")).toBe(true);
		expect(await accepts(id, "https://cimd.example/callback")).toBe(true);
		expect(await accepts(id, "http://localhost:5/callback")).toBe(false);
	});

	test("a static application_type native client, which 9.12.2 would let use any port", async () => {
		expect(await accepts(native.id, "http://127.0.0.1/callback")).toBe(true);
		expect(await accepts(native.id, "http://127.0.0.1:5/callback")).toBe(false);
	});

	test("why the override: 9.12.2 alone refuses Claude Code's port and lets native clients use any", async () => {
		const stock = await startAs([native], {
			provider: { configure: cimd(vendor.guard()).configure },
		});
		try {
			const attempt = async (clientId: string, redirectUri: string) => {
				const client = { id: clientId, kind: "public" as const, metadata: {} };
				const { url } = authorizeUrl(stock, client, { redirect_uri: redirectUri });
				return (await new Browser().get(url)).status;
			};
			expect(await attempt(codeId, code.redirectUri)).toBe(400);
			expect(await attempt(native.id, "http://127.0.0.1:5/callback")).toBe(303);
		} finally {
			await stock.close();
		}
	});

	test("claude.ai's https redirect URI, with a port added", async () => {
		const ai = claudeAi();
		const withPort = new URL(ai.redirectUri);
		withPort.port = "8443";
		expect(await accepts(ai.clientId ?? "", ai.redirectUri)).toBe(true);
		expect(await accepts(ai.clientId ?? "", withPort.href)).toBe(false);
	});
});
