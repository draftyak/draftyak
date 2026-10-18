import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MAX_INTERACTIONS } from "../src/store.ts";
import {
	type As,
	authorize,
	authorizeUrl,
	Browser,
	callMcp,
	confidentialClient,
	epoch,
	exchange,
	finish,
	post,
	publicClient,
	REDIRECT_URI,
	refresh,
	rewrite,
	startAs,
	startAuthorization,
	type TestClient,
} from "./flow.ts";

const DAY = 24 * 60 * 60;

const clients = [publicClient(), confidentialClient()];
let as: As;

beforeAll(async () => {
	as = await startAs(clients);
});
afterAll(async () => {
	await as?.close();
});

async function tokensFor(client: TestClient, scope?: string) {
	const authorized = await authorize(as, client, scope ? { params: { scope } } : {});
	const { status, body } = await exchange(as, client, authorized);
	expect(status).toBe(200);
	return {
		accessToken: String(body.access_token),
		refreshToken: String(body.refresh_token),
		body,
	};
}

describe.each(clients)("$kind client", (client) => {
	test("gets an opaque 60-minute access token for /mcp and a refresh token without offline_access", async () => {
		const { body, accessToken, refreshToken } = await tokensFor(client);
		expect(body).toStrictEqual({
			access_token: accessToken,
			expires_in: 3600,
			refresh_token: refreshToken,
			scope: "inbox:read drafts:write outbox:propose",
			token_type: "Bearer",
		});
		expect(accessToken).toMatch(/^[\w-]{43}$/);
		const stored = await as.provider.AccessToken.find(accessToken);
		expect(stored?.aud).toBe(`${as.origin}/mcp`);
		expect(stored?.clientId).toBe(client.id);
		expect(await callMcp(as, accessToken)).toBe(200);
	});

	test("offline_access changes nothing", async () => {
		const { body } = await tokensFor(client, "inbox:read offline_access");
		expect(body.scope).toBe("inbox:read");
		expect(body.refresh_token).toEqual(expect.any(String));
	});

	test("every refresh rotates the refresh token", async () => {
		const first = await tokensFor(client);
		const second = await refresh(as, client, first.refreshToken);
		expect(second.status).toBe(200);
		expect(second.body.refresh_token).not.toBe(first.refreshToken);
		expect(second.body.access_token).not.toBe(first.accessToken);
		expect(second.body.scope).toBe(first.body.scope);
		expect((await as.provider.RefreshToken.find(first.refreshToken))?.consumed).toBeTypeOf(
			"number",
		);
		const third = await refresh(as, client, String(second.body.refresh_token));
		expect(third.status).toBe(200);
		expect(await callMcp(as, String(third.body.access_token))).toBe(200);
	});

	test("a reused refresh token revokes the grant, and every token of it", async () => {
		const first = await tokensFor(client);
		const grantId = (await as.provider.AccessToken.find(first.accessToken))?.grantId ?? "";
		const second = await refresh(as, client, first.refreshToken);
		expect(second.status).toBe(200);
		const reuse = await refresh(as, client, first.refreshToken);
		expect(reuse.status).toBe(400);
		expect(reuse.body).toStrictEqual({
			error: "invalid_grant",
			error_description: "grant request is invalid",
		});
		const rotated = await refresh(as, client, String(second.body.refresh_token));
		expect(rotated.status).toBe(400);
		expect(rotated.body.error).toBe("invalid_grant");
		expect(await callMcp(as, first.accessToken)).toBe(401);
		expect(await callMcp(as, String(second.body.access_token))).toBe(401);
		expect(await as.provider.Grant.find(grantId)).toBeUndefined();
	});

	test("an unknown refresh token returns invalid_grant", async () => {
		const unknown = await refresh(as, client, randomBytes(32).toString("base64url"));
		expect(unknown.status).toBe(400);
		expect(unknown.body.error).toBe("invalid_grant");
	});

	test("revocation ends the grant", async () => {
		const { accessToken, refreshToken } = await tokensFor(client);
		const revoked = await post(as, "/oauth/revoke", client, {
			token: refreshToken,
			token_type_hint: "refresh_token",
		});
		expect(revoked.status).toBe(200);
		expect((await refresh(as, client, refreshToken)).body.error).toBe("invalid_grant");
		expect(await callMcp(as, accessToken)).toBe(401);
	});

	test("tokens outlive the browser session", async () => {
		const browser = new Browser();
		const authorized = await authorize(as, client, {}, browser);
		const { body } = await exchange(as, client, authorized);
		const session = await as.provider.Session.find(browser.cookie("_session") ?? "");
		expect(session).toBeDefined();
		await session?.destroy();
		expect(await callMcp(as, String(body.access_token))).toBe(200);
		expect((await refresh(as, client, String(body.refresh_token))).status).toBe(200);
	});

	test("a replayed authorization code is refused and revokes what it issued", async () => {
		const authorized = await authorize(as, client);
		const first = await exchange(as, client, authorized);
		expect(first.status).toBe(200);
		const replay = await exchange(as, client, authorized);
		expect(replay.status).toBe(400);
		expect(replay.body.error).toBe("invalid_grant");
		expect(await callMcp(as, String(first.body.access_token))).toBe(401);
		expect((await refresh(as, client, String(first.body.refresh_token))).body.error).toBe(
			"invalid_grant",
		);
	});

	test("each rotation starts a new 30 days", async () => {
		const { refreshToken } = await tokensFor(client);
		await rewrite(as.provider.RefreshToken, refreshToken, { exp: epoch() + 100 });
		const start = epoch();
		const rotated = await refresh(as, client, refreshToken);
		expect(rotated.status).toBe(200);
		const stored = await as.provider.RefreshToken.find(String(rotated.body.refresh_token));
		expect((stored?.exp ?? 0) - start).toBeGreaterThanOrEqual(30 * DAY);
	});

	test("refresh ends when the grant's 90 days do", async () => {
		const { accessToken, refreshToken } = await tokensFor(client);
		const grantId = (await as.provider.AccessToken.find(accessToken))?.grantId ?? "";
		await rewrite(as.provider.Grant, grantId, { exp: epoch() - 1 });
		const ended = await refresh(as, client, refreshToken);
		expect(ended.status).toBe(400);
		expect(ended.body.error).toBe("invalid_grant");
	});

	// The resource server's check, as oidc-provider's own token consumers make it.
	const refusals: readonly (readonly [
		string,
		(token: { readonly accessToken: string; readonly grantId: string }) => Promise<void>,
	])[] = [
		["its grant is gone", ({ grantId }) => as.provider.Grant.adapter.destroy(grantId)],
		[
			"its grant has ended",
			({ grantId }) => rewrite(as.provider.Grant, grantId, { exp: epoch() - 1 }),
		],
		[
			"its grant is another client's",
			({ grantId }) => rewrite(as.provider.Grant, grantId, { clientId: "spike-other" }),
		],
		[
			"its grant is another account's",
			({ grantId }) => rewrite(as.provider.Grant, grantId, { accountId: "someone-else" }),
		],
		[
			"it was issued for another resource",
			({ accessToken }) =>
				rewrite(as.provider.AccessToken, accessToken, { aud: "https://other.example/mcp" }),
		],
	];
	test.each(refusals)("/mcp refuses an access token once %s", async (_name, change) => {
		const { accessToken } = await tokensFor(client);
		const grantId = (await as.provider.AccessToken.find(accessToken))?.grantId ?? "";
		expect(await callMcp(as, accessToken)).toBe(200);
		await change({ accessToken, grantId });
		expect(await callMcp(as, accessToken)).toBe(401);
	});

	test("Origin decides nothing at the token and revocation endpoints, and no response allows CORS", async () => {
		for (const origin of [undefined, "https://client.example", "https://evil.example"]) {
			const options = origin ? { headers: { origin } } : {};
			const authorized = await authorize(as, client);
			const token = await post(
				as,
				"/oauth/token",
				client,
				{
					grant_type: "authorization_code",
					code: authorized.code,
					redirect_uri: REDIRECT_URI,
					code_verifier: authorized.verifier,
				},
				options,
			);
			const revocation = await post(
				as,
				"/oauth/revoke",
				client,
				{ token: String(token.body.refresh_token) },
				options,
			);
			for (const [name, response] of [
				["token", token],
				["revocation", revocation],
			] as const) {
				expect(response.status, `${name}, Origin ${origin}`).toBe(200);
				const cors = [...response.headers.keys()].filter((key) =>
					key.startsWith("access-control-"),
				);
				expect(cors, `${name}, Origin ${origin}`).toStrictEqual([]);
			}
		}
	});
});

test("lifetimes: code 60 s, access token 1 h, refresh token 30 days, grant 90 days, interaction and session 10 min", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const start = epoch();
	const browser = new Browser();
	const started = await startAuthorization(as, browser, client);
	const interaction = await as.provider.Interaction.find(started.uid);
	as.consent.approve(started.uid, started.code);
	const callback = await finish(as, browser, started.uid);
	const code = callback.searchParams.get("code") ?? "";
	const issuedCode = await as.provider.AuthorizationCode.find(code);
	const session = await as.provider.Session.find(browser.cookie("_session") ?? "");
	const { body } = await exchange(as, client, {
		callback,
		code,
		state: started.state,
		verifier: started.verifier,
	});
	const access = await as.provider.AccessToken.find(String(body.access_token));
	const refreshToken = await as.provider.RefreshToken.find(String(body.refresh_token));
	const grant = await as.provider.Grant.find(access?.grantId ?? "");
	const elapsed = epoch() - start;
	const lifetimes: readonly (readonly [string, { readonly exp: number } | undefined, number])[] = [
		["code", issuedCode, 60],
		["access token", access, 60 * 60],
		["refresh token", refreshToken, 30 * DAY],
		["grant", grant, 90 * DAY],
		["interaction", interaction, 10 * 60],
		["session", session, 10 * 60],
	];
	for (const [name, record, seconds] of lifetimes) {
		const lifetime = (record?.exp ?? 0) - start;
		expect(lifetime, name).toBeGreaterThanOrEqual(seconds);
		expect(lifetime, name).toBeLessThanOrEqual(seconds + elapsed);
	}
});

test("a client can't revoke another client's tokens", async () => {
	const [owner, other] = clients;
	if (!owner || !other) throw new Error("two clients needed");
	const { accessToken, refreshToken } = await tokensFor(owner);
	for (const token of [refreshToken, accessToken]) {
		const revoked = await post(as, "/oauth/revoke", other, { token });
		expect(revoked.status).toBe(200);
		expect(revoked.body).toStrictEqual({});
	}
	expect(await callMcp(as, accessToken)).toBe(200);
	expect((await refresh(as, owner, refreshToken)).status).toBe(200);
});

test("an authorization that names no resource gets the one resource", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const authorized = await authorize(as, client, { params: { resource: undefined } });
	const { status, body } = await exchange(as, client, authorized);
	expect(status).toBe(200);
	const stored = await as.provider.AccessToken.find(String(body.access_token));
	expect(stored?.aud).toBe(`${as.origin}/mcp`);
	expect(await callMcp(as, String(body.access_token))).toBe(200);
});

test("a client that states no auth method or grant types is public and gets refresh tokens", async () => {
	const bare: TestClient = {
		id: "spike-bare",
		kind: "public",
		metadata: {
			client_id: "spike-bare",
			client_name: "Spike bare client",
			redirect_uris: [REDIRECT_URI],
		},
	};
	const plain = await startAs([bare]);
	try {
		expect((await plain.provider.Client.find(bare.id))?.clientAuthMethod).toBe("none");
		const { status, body } = await exchange(plain, bare, await authorize(plain, bare));
		expect(status).toBe(200);
		expect(body.refresh_token).toEqual(expect.any(String));
	} finally {
		await plain.close();
	}
});

test("a flood of authorization requests evicts neither tokens nor reuse detection", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const first = await tokensFor(client);
	const second = await refresh(as, client, first.refreshToken);
	expect(second.status).toBe(200);
	const early = new Browser();
	const started = await startAuthorization(as, early, client);
	// Unauthenticated: a public client_id, its redirect URI and a fresh PKCE challenge suffice.
	for (let sent = 0; sent < 2 * MAX_INTERACTIONS + 500; sent += 50) {
		const statuses = await Promise.all(
			Array.from({ length: 50 }, async () => {
				const response = await fetch(authorizeUrl(as, client).url, { redirect: "manual" });
				await response.body?.cancel();
				return response.status;
			}),
		);
		expect(new Set(statuses)).toStrictEqual(new Set([303]));
	}
	// Interactions are capped, so the earliest sign-in is gone; every token stays.
	expect((await early.get(`${as.origin}/oauth/interaction/${started.uid}`)).status).toBe(400);
	expect(await callMcp(as, String(second.body.access_token))).toBe(200);
	expect((await refresh(as, client, first.refreshToken)).body.error).toBe("invalid_grant");
	const revoked = await refresh(as, client, String(second.body.refresh_token));
	expect(revoked.body.error).toBe("invalid_grant");
	expect(await callMcp(as, String(second.body.access_token))).toBe(401);
});

test("a client without the refresh_token grant type gets no refresh token", async () => {
	const codeOnly = publicClient("spike-code-only");
	const plain = await startAs([
		{ ...codeOnly, metadata: { ...codeOnly.metadata, grant_types: ["authorization_code"] } },
	]);
	try {
		const { status, body } = await exchange(plain, codeOnly, await authorize(plain, codeOnly));
		expect(status).toBe(200);
		expect(body.refresh_token).toBeUndefined();
		expect(body.access_token).toEqual(expect.any(String));
	} finally {
		await plain.close();
	}
});

test("one client's refresh token is dead to another client", async () => {
	const [owner, other] = clients;
	if (!owner || !other) throw new Error("two clients needed");
	const { refreshToken } = await tokensFor(owner);
	const stolen = await refresh(as, other, refreshToken);
	expect(stolen.status).toBe(400);
	expect(stolen.body.error).toBe("invalid_grant");
	expect((await refresh(as, owner, refreshToken)).status).toBe(200);
});

test("the token endpoint takes form bodies only and answers well within 10 s", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const json = await fetch(`${as.origin}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant_type: "refresh_token", client_id: client.id }),
	});
	expect(json.status).toBe(400);
	expect(await json.json()).toStrictEqual({
		error: "invalid_request",
		error_description:
			"only application/x-www-form-urlencoded content-type bodies are supported on POST /oauth/token",
	});
	const authorized = await authorize(as, client);
	const started = performance.now();
	expect((await exchange(as, client, authorized)).status).toBe(200);
	expect(performance.now() - started).toBeLessThan(10_000);
});

test("the token request may repeat the resource, but not name another", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const other = await exchange(as, client, await authorize(as, client), {
		resource: "https://evil.example/mcp",
	});
	expect(other.status).toBe(400);
	expect(other.body.error).toBe("invalid_target");
	const same = await exchange(as, client, await authorize(as, client), {
		resource: `${as.origin}/mcp`,
		redirect_uri: REDIRECT_URI,
	});
	expect(same.status).toBe(200);
});

test("openid is never granted, so no ID token is issued", async () => {
	const [client] = clients;
	if (!client) throw new Error("no client");
	const { body } = await tokensFor(client, "openid inbox:read");
	expect(body.id_token).toBeUndefined();
	expect(body.scope).toBe("inbox:read");
	expect((await refresh(as, client, String(body.refresh_token))).body.id_token).toBeUndefined();
});
