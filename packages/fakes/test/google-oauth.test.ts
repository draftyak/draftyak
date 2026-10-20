import { createHash, webcrypto } from "node:crypto";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../src/faults.ts";
import {
	createGoogleOAuthFake,
	GOOGLE_OAUTH_CLIENT_ID,
	GOOGLE_OAUTH_HOST,
	GOOGLE_OAUTH_REDIRECT_URI,
	type GoogleOAuthFake,
} from "../src/google-oauth.ts";
import { createRecorder } from "../src/recorder.ts";
import { json, listeners } from "./helpers.ts";

const START = Date.UTC(2026, 9, 19, 8);
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const FULL = ["openid", "email", MODIFY];
const READ = ["openid", "email", READONLY];
const VERIFIER = "DYTEST-verifier-".padEnd(43, "x");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const STATE = "DYTEST-state";

function present<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("DYTEST fixture value missing");
	return value;
}

function authorization(overrides: Record<string, string> = {}): string {
	return `/o/oauth2/v2/auth?${new URLSearchParams({
		response_type: "code",
		client_id: GOOGLE_OAUTH_CLIENT_ID,
		redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		state: STATE,
		code_challenge: CHALLENGE,
		code_challenge_method: "S256",
		scope: FULL.join(" "),
		access_type: "offline",
		prompt: "consent",
		...overrides,
	})}`;
}

async function code(
	fake: GoogleOAuthFake,
	overrides: Record<string, string> = {},
): Promise<string> {
	const result = await fake.fetch(authorization(overrides), { redirect: "manual" });
	expect(result.status).toBe(302);
	const location = new URL(present(result.headers.get("location")));
	expect(location.origin + location.pathname).toBe(
		overrides.redirect_uri ?? GOOGLE_OAUTH_REDIRECT_URI,
	);
	expect(location.searchParams.get("state")).toBe(overrides.state ?? STATE);
	return present(location.searchParams.get("code"));
}

function post(
	fake: GoogleOAuthFake,
	path: string,
	form: Record<string, string>,
): Promise<Response> {
	return fake.fetch(path, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form),
	});
}

function exchange(
	fake: GoogleOAuthFake,
	value: string,
	overrides: Record<string, string> = {},
): Promise<Response> {
	return post(fake, "/token", {
		grant_type: "authorization_code",
		client_id: GOOGLE_OAUTH_CLIENT_ID,
		code: value,
		code_verifier: VERIFIER,
		redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		...overrides,
	});
}

function refresh(
	fake: GoogleOAuthFake,
	value: string,
	overrides: Record<string, string> = {},
): Promise<Response> {
	return post(fake, "/token", {
		grant_type: "refresh_token",
		client_id: GOOGLE_OAUTH_CLIENT_ID,
		refresh_token: value,
		...overrides,
	});
}

interface Tokens {
	access_token: string;
	refresh_token: string;
	token_type: string;
	expires_in: number;
	scope: string;
	refresh_token_expires_in?: number;
}

describe("Google OAuth fake", () => {
	const open = listeners();
	afterEach(open.closeAll);
	afterEach(() => vi.restoreAllMocks());

	it("returns deterministic synthetic tokens and the requested bound callback state", async () => {
		const clock = manualClock(START);
		const fake = createGoogleOAuthFake({ clock });
		const issued = await code(fake);
		expect(issued).toBe("DYTEST-code-000001");
		const response = await exchange(fake, issued);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("pragma")).toBe("no-cache");
		expect(response.headers.get("date")).toBe(new Date(START).toUTCString());
		const tokens = await json<Tokens>(response);
		expect(tokens).toEqual({
			access_token: "DYTEST-access-000002",
			refresh_token: "DYTEST-refresh-000003",
			token_type: "Bearer",
			expires_in: 3600,
			scope: `openid ${EMAIL} ${MODIFY}`,
		});
		expect(fake.accessGrant(tokens.access_token)).toEqual({
			clientId: GOOGLE_OAUTH_CLIENT_ID,
			scopes: FULL,
			expiresAt: START + 3_600_000,
		});
		expect(fake.accessGrant(tokens.refresh_token)).toBeUndefined();
		expect(fake.endpoints.token).toBe(`https://${GOOGLE_OAUTH_HOST}/token`);
		const another = createGoogleOAuthFake({ clock });
		expect(await json(exchange(another, await code(another)))).toEqual(tokens);
	});

	it("does not issue refresh credentials for online-only authorization", async () => {
		const fake = createGoogleOAuthFake();
		const tokens = await json<Tokens>(exchange(fake, await code(fake, { access_type: "online" })));
		expect(tokens.refresh_token).toBeUndefined();
	});

	it("records scope, prompt and state for caller disclosure/scope assertions without storing header secrets", async () => {
		const fake = createGoogleOAuthFake();
		const issued = await code(fake);
		await exchange(fake, issued);
		const records = fake.recorder.takeRequests();
		expect(records).toHaveLength(2);
		const query = new URLSearchParams(records[0]?.query);
		expect(query.get("scope")).toBe(FULL.join(" "));
		expect(query.get("prompt")).toBe("consent");
		expect(query.get("state")).toBe(STATE);
		expect(records[1]?.headers).toEqual({});
		expect(
			new URLSearchParams(Buffer.from(present(records[1]).body).toString()).get("code_verifier"),
		).toBe(VERIFIER);
	});

	it("keeps granular consent separate from the caller's required gmail.modify check", async () => {
		const fake = createGoogleOAuthFake();
		const granted = ["email"];
		fake.enqueueConsent({ kind: "grant", scopes: granted });
		granted.push(MODIFY);
		const tokens = await json<Tokens>(exchange(fake, await code(fake)));
		expect(tokens.scope).toBe("https://www.googleapis.com/auth/userinfo.email");
		expect(tokens.scope).not.toContain(MODIFY);
		fake.enqueueConsent({ kind: "grant", scopes: [] });
		expect((await json<Tokens>(exchange(fake, await code(fake)))).scope).toBe("");
	});

	it("supports a read-only grant without inventing send authorization", async () => {
		const fake = createGoogleOAuthFake();
		const tokens = await json<Tokens>(exchange(fake, await code(fake, { scope: READONLY })));
		expect(tokens.scope).toBe(READONLY);
		expect(fake.accessGrant(tokens.access_token)?.scopes).toEqual([READONLY]);
	});

	it("denies consent with the same state and never makes an outbound callback request", async () => {
		const fake = createGoogleOAuthFake();
		fake.enqueueConsent({ kind: "deny" });
		const result = await fake.fetch(authorization(), { redirect: "manual" });
		const back = new URL(present(result.headers.get("location")));
		expect(back.searchParams.get("error")).toBe("access_denied");
		expect(back.searchParams.get("state")).toBe(STATE);
		expect(back.searchParams.has("code")).toBe(false);
		expect(fake.recorder.takeRequests()).toHaveLength(1);
	});

	it.each<Record<string, string>>([
		{ client_id: "DYTEST-unknown" },
		{ redirect_uri: "http://127.0.0.1:54322/oauth/google/callback" },
		{ redirect_uri: "https://outside.example/callback" },
		{ response_type: "token" },
		{ code_challenge_method: "plain" },
		{ code_challenge: "short" },
		{ code_challenge: `${CHALLENGE}\n` },
		{ state: "" },
		{ scope: "" },
		{ access_type: "unexpected" },
	])("refuses invalid authorization without redirecting: %j", async (overrides) => {
		const fake = createGoogleOAuthFake();
		const response = await fake.fetch(authorization(overrides), { redirect: "manual" });
		expect(response.status).toBe(400);
		expect(response.headers.has("location")).toBe(false);
	});

	it("does not consume queued consent for an invalid request or a wrong host", async () => {
		const fake = createGoogleOAuthFake();
		fake.enqueueConsent({ kind: "deny" });
		expect((await fake.fetch(authorization({ state: "" }))).status).toBe(400);
		expect((await fake.fetch(`https://other.example${authorization()}`)).status).toBe(421);
		const response = await fake.fetch(authorization(), { redirect: "manual" });
		expect(new URL(present(response.headers.get("location"))).searchParams.get("error")).toBe(
			"access_denied",
		);
	});

	it("rejects repeated authorization parameters and raw route aliases", async () => {
		const fake = createGoogleOAuthFake();
		expect(
			(await fake.fetch(`${authorization()}&state=another`, { redirect: "manual" })).status,
		).toBe(400);
		expect((await fake.fetch(`/x/../token`, { method: "POST" })).status).toBe(404);
		expect((await fake.fetch(`${authorization()}#fragment`, { redirect: "manual" })).status).toBe(
			400,
		);
	});

	it.each<Record<string, string>>([
		{ code_verifier: "wrong".padEnd(43, "x") },
		{ redirect_uri: "http://127.0.0.1:54322/oauth/google/callback" },
		{ code_verifier: "x".repeat(42) },
		{ code_verifier: "x".repeat(129) },
		{ code_verifier: `${VERIFIER}\n` },
	])("consumes an authenticated code attempt with a wrong binding: %j", async (overrides) => {
		const fake = createGoogleOAuthFake();
		const issued = await code(fake);
		expect(await json(exchange(fake, issued, overrides))).toEqual({ error: "invalid_grant" });
		expect(await json(exchange(fake, issued))).toEqual({ error: "invalid_grant" });
	});

	it("exchanges an authorization code only once, including concurrent replay", async () => {
		const fake = createGoogleOAuthFake();
		const issued = await code(fake);
		const responses = await Promise.all([exchange(fake, issued), exchange(fake, issued)]);
		expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
	});

	it("enforces client secret and code client binding", async () => {
		const fake = createGoogleOAuthFake({
			clients: [
				{
					clientId: GOOGLE_OAUTH_CLIENT_ID,
					clientSecret: "DYTEST-secret",
					redirectUris: [GOOGLE_OAUTH_REDIRECT_URI],
				},
				{ clientId: "DYTEST-other", redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
			],
		});
		const issued = await code(fake);
		expect((await exchange(fake, issued)).status).toBe(401);
		expect((await exchange(fake, issued, { client_secret: "DYTEST-wrong" })).status).toBe(401);
		expect((await exchange(fake, issued, { client_secret: "DYTEST-secret" })).status).toBe(200);
		const second = await code(fake);
		expect(await json(exchange(fake, second, { client_id: "DYTEST-other" }))).toEqual({
			error: "invalid_grant",
		});
	});

	it("expires codes and access/refresh tokens exactly at injected deadlines", async () => {
		const clock = manualClock(START);
		const fake = createGoogleOAuthFake({
			clock,
			codeTtlMs: 1000,
			accessTtlSeconds: 2,
			refreshTtlSeconds: 3,
		});
		const expired = await code(fake);
		clock.advance(1000);
		expect(await json(exchange(fake, expired))).toEqual({ error: "invalid_grant" });
		const tokens = await json<Tokens>(exchange(fake, await code(fake)));
		expect(tokens.refresh_token_expires_in).toBe(3);
		clock.advance(1999);
		expect(fake.accessGrant(tokens.access_token)).toBeDefined();
		clock.advance(1);
		expect(fake.accessGrant(tokens.access_token)).toBeUndefined();
		clock.advance(1000);
		expect(await json(refresh(fake, tokens.refresh_token))).toEqual({ error: "invalid_grant" });
	});

	it("rotates refresh tokens once and isolates their client binding", async () => {
		const fake = createGoogleOAuthFake({
			clients: [
				{ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
				{ clientId: "DYTEST-other", redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
			],
		});
		const first = await json<Tokens>(exchange(fake, await code(fake)));
		expect((await refresh(fake, first.refresh_token, { client_id: "DYTEST-other" })).status).toBe(
			400,
		);
		const second = await json<Tokens>(refresh(fake, first.refresh_token));
		expect(second.refresh_token).not.toBe(first.refresh_token);
		expect(await json(refresh(fake, first.refresh_token))).toEqual({ error: "invalid_grant" });
		expect((await refresh(fake, second.refresh_token)).status).toBe(200);
	});

	it("allows nonrotating refresh scripts without replacing the existing token", async () => {
		const fake = createGoogleOAuthFake({ rotateRefreshTokens: false });
		const first = await json<Tokens>(exchange(fake, await code(fake)));
		expect((await json<Tokens>(refresh(fake, first.refresh_token))).refresh_token).toBeUndefined();
		expect((await refresh(fake, first.refresh_token)).status).toBe(200);
	});

	it("revokes earlier consents and rotated tokens for one client, leaving the next consent fresh", async () => {
		const fake = createGoogleOAuthFake();
		const first = await json<Tokens>(exchange(fake, await code(fake)));
		const rotated = await json<Tokens>(refresh(fake, first.refresh_token));
		const second = await json<Tokens>(exchange(fake, await code(fake)));
		const pending = await code(fake);
		expect((await post(fake, "/revoke", { token: first.refresh_token })).status).toBe(200);
		expect(fake.accessGrant(rotated.access_token)).toBeUndefined();
		expect(fake.accessGrant(second.access_token)).toBeUndefined();
		expect((await refresh(fake, second.refresh_token)).status).toBe(400);
		expect((await exchange(fake, pending)).status).toBe(400);
		expect((await post(fake, "/revoke", { token: first.refresh_token })).status).toBe(400);
		const fresh = await json<Tokens>(exchange(fake, await code(fake)));
		expect(fake.accessGrant(fresh.access_token)).toBeDefined();
	});

	it("ignores empty form stream chunks without retaining them as buffered input", async () => {
		const fake = createGoogleOAuthFake();
		const issued = await code(fake);
		const form = new URLSearchParams({
			client_id: GOOGLE_OAUTH_CLIENT_ID,
			grant_type: "authorization_code",
			code: issued,
			code_verifier: VERIFIER,
			redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		});
		let empty = 64;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (empty-- > 0) controller.enqueue(new Uint8Array());
				else {
					controller.enqueue(new TextEncoder().encode(form.toString()));
					controller.close();
				}
			},
		});
		const response = await fake.fetch("/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			duplex: "half",
		} as RequestInit);
		expect(response.status).toBe(200);
	});

	it("scripts scoped token errors without consuming grants and reuses the common fault script", async () => {
		const fake = createGoogleOAuthFake();
		fake.enqueueTokenError(
			{ error: "invalid_grant", grantType: "refresh_token" },
			{ error: "temporarily_unavailable", grantType: "authorization_code" },
		);
		const issued = await code(fake);
		expect((await exchange(fake, issued)).status).toBe(503);
		const tokens = await json<Tokens>(exchange(fake, issued));
		expect(await json(refresh(fake, tokens.refresh_token))).toEqual({ error: "invalid_grant" });
		fake.faults.add({ kind: "rate-limit", retryAfter: 30, path: "/token" });
		const limited = await refresh(fake, tokens.refresh_token);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("30");
		expect((await refresh(fake, tokens.refresh_token)).status).toBe(200);
	});

	it("does not permit duplicate token parameters, wrong media types, oversized forms or grant types", async () => {
		const fake = createGoogleOAuthFake();
		expect((await fake.fetch("/token", { method: "POST", body: "x" })).status).toBe(415);
		expect(
			(
				await fake.fetch("/token", {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "client_id=a&client_id=b",
				})
			).status,
		).toBe(400);
		expect(
			(
				await fake.fetch("/token", {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: `x=${"x".repeat(16_384)}`,
				})
			).status,
		).toBe(413);
		expect(
			await json(
				post(fake, "/token", { client_id: GOOGLE_OAUTH_CLIENT_ID, grant_type: "password" }),
			),
		).toEqual({ error: "unsupported_grant_type" });
	});

	it("records refused received bytes and consumes the arrival fault without admitting the form", async () => {
		const fake = createGoogleOAuthFake();
		fake.faults.add({ kind: "server-error", path: "/token" });
		let cancelled = false;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				controller.enqueue(new Uint8Array(8192));
			},
			cancel() {
				cancelled = true;
			},
		});
		const response = await fake.fetch("/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			duplex: "half",
		} as RequestInit);
		expect(response.status).toBe(503);
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(4);
		expect(fake.recorder.takeRequests()).toMatchObject([
			{
				bodyLength: 24_576,
				bodySha256: createHash("sha256").update(new Uint8Array(24_576)).digest("hex"),
				refused: "request_body_too_large",
			},
		]);
		expect(fake.faults.pending()).toHaveLength(0);
	});

	it("validates and copies client registration and consent/error queue entries atomically", async () => {
		expect(() => createGoogleOAuthFake({ clients: [] })).toThrow();
		expect(() =>
			createGoogleOAuthFake({
				clients: [{ clientId: "DYTEST-client", redirectUris: ["https://outside.example/"] }],
			}),
		).toThrow();
		expect(() => createGoogleOAuthFake({ codeTtlMs: -1 })).toThrow();
		expect(() => createGoogleOAuthFake({ accessTtlSeconds: 0.5 })).toThrow();
		expect(() => createGoogleOAuthFake({ refreshTtlSeconds: Infinity })).toThrow();
		const uris = [GOOGLE_OAUTH_REDIRECT_URI];
		const fake = createGoogleOAuthFake({
			clients: [{ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUris: uris }],
		});
		uris[0] = "http://127.0.0.1:54322/changed";
		expect(() => fake.enqueueConsent({ kind: "deny" }, { kind: "grant", scopes: [""] })).toThrow();
		expect(() =>
			fake.enqueueTokenError({ error: "invalid_grant" }, { error: "bad" } as never),
		).toThrow();
		expect((await exchange(fake, await code(fake))).status).toBe(200);
		expect(() =>
			fake.enqueueConsent(...Array.from({ length: 257 }, () => ({ kind: "deny" as const }))),
		).toThrow();
	});

	it("serves the same protocol over its loopback listener and records an allowlisted synthetic header", async () => {
		const fake = createGoogleOAuthFake({
			recorder: createRecorder({ headerValues: ["x-dytest"] }),
		});
		const server = open.keep(await fake.listen());
		const response = await fetch(`${server.origin}${authorization()}`, {
			redirect: "manual",
			headers: { "x-dytest": "DYTEST-probe" },
		});
		expect(response.status).toBe(302);
		expect(fake.recorder.takeRequests()[0]?.headers).toEqual({ "x-dytest": "DYTEST-probe" });
		const issued = present(
			new URL(present(response.headers.get("location"))).searchParams.get("code"),
		);
		const result = await fetch(`${server.origin}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
			body: new URLSearchParams({
				client_id: GOOGLE_OAUTH_CLIENT_ID,
				grant_type: "authorization_code",
				code: issued,
				code_verifier: VERIFIER,
				redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
			}),
		});
		expect(result.status).toBe(200);
	});
});

describe("Google OAuth finite fixture budgets", () => {
	const issue = async (fake: GoogleOAuthFake, overrides: Record<string, string> = {}) =>
		json<Tokens>(
			exchange(
				fake,
				await code(fake, overrides),
				overrides.client_id ? { client_id: overrides.client_id } : {},
			),
		);
	it("accepts every configured lifetime boundary and rejects adjacent invalid settings", () => {
		for (const key of ["codeTtlMs", "accessTtlSeconds", "refreshTtlSeconds"] as const) {
			for (const value of [1, 31_536_000])
				expect(() => createGoogleOAuthFake({ [key]: value })).not.toThrow();
			for (const value of [0, -1, 1.5, 31_536_001, NaN, Infinity])
				expect(() => createGoogleOAuthFake({ [key]: value })).toThrow(RangeError);
		}
		expect(() => createGoogleOAuthFake({ rotateRefreshTokens: "yes" as never })).toThrow(TypeError);
	});
	it("bounds client count, callback count and credential text while detaching registrations", async () => {
		const clients = Array.from({ length: 32 }, (_, index) => ({
			clientId: `DYTEST-client-${index}`,
			redirectUris: [GOOGLE_OAUTH_REDIRECT_URI],
		}));
		const fake = createGoogleOAuthFake({ clients });
		expect((await issue(fake, { client_id: "DYTEST-client-31" })).token_type).toBe("Bearer");
		expect(() =>
			createGoogleOAuthFake({
				clients: [
					...clients,
					{ clientId: "DYTEST-extra", redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
				],
			}),
		).toThrow();
		expect(() => createGoogleOAuthFake({ clients: [clients[0], clients[0]] as never })).toThrow();
		const redirects = Array.from(
			{ length: 16 },
			(_, index) => `http://127.0.0.1:${54000 + index}/cb`,
		);
		const registered = createGoogleOAuthFake({
			clients: [{ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUris: redirects }],
		});
		expect(
			(
				await exchange(
					registered,
					await code(registered, { redirect_uri: present(redirects[15]) }),
					{ redirect_uri: present(redirects[15]) },
				)
			).status,
		).toBe(200);
		expect(() =>
			createGoogleOAuthFake({
				clients: [
					{ clientId: "DYTEST-client", redirectUris: [...redirects, "http://127.0.0.1:55000/cb"] },
				],
			}),
		).toThrow();
		for (const field of ["clientId", "clientSecret"] as const) {
			const accepted = {
				clientId: GOOGLE_OAUTH_CLIENT_ID,
				clientSecret: "DYTEST-secret",
				redirectUris: [GOOGLE_OAUTH_REDIRECT_URI],
				[field]: "x".repeat(512),
			};
			expect(() => createGoogleOAuthFake({ clients: [accepted] })).not.toThrow();
			for (const bad of ["", "x".repeat(513), "x\n", "x y", "é"])
				expect(() => createGoogleOAuthFake({ clients: [{ ...accepted, [field]: bad }] })).toThrow();
		}
		const source = {
			clientId: GOOGLE_OAUTH_CLIENT_ID,
			clientSecret: "DYTEST-secret",
			redirectUris: [GOOGLE_OAUTH_REDIRECT_URI],
		};
		const detached = createGoogleOAuthFake({ clients: [source] });
		source.clientSecret = "DYTEST-changed";
		source.redirectUris[0] = "http://127.0.0.1:55555/changed";
		expect(
			(await exchange(detached, await code(detached), { client_secret: "DYTEST-secret" })).status,
		).toBe(200);
	});
	it("enforces scope count, individual length and aggregate request length independently", async () => {
		for (const [valid, bad] of [
			[
				Array.from({ length: 16 }, (_, i) => `DYTEST-${i}`),
				Array.from({ length: 17 }, (_, i) => `DYTEST-${i}`),
			],
			[["x".repeat(256)], ["x".repeat(257)]],
		] as const) {
			const fake = createGoogleOAuthFake();
			expect((await issue(fake, { scope: valid.join(" ") })).scope.split(" ")).toEqual(valid);
			expect(
				(await fake.fetch(authorization({ scope: bad.join(" ") }), { redirect: "manual" })).status,
			).toBe(400);
			fake.enqueueConsent({ kind: "unexpected-grant", scopes: valid });
			expect(() => fake.enqueueConsent({ kind: "unexpected-grant", scopes: bad })).toThrow();
			expect((await issue(fake)).scope.split(" ")).toEqual(valid);
		}
		const chunks = Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(254)}`);
		chunks[0] += "x";
		const exact = chunks.join(" ");
		expect(exact).toHaveLength(2048);
		const fake = createGoogleOAuthFake();
		expect((await issue(fake, { scope: exact })).scope).toBe(exact);
		chunks[1] += "x";
		expect(chunks.every((chunk) => chunk.length <= 256)).toBe(true);
		expect(
			(await fake.fetch(authorization({ scope: chunks.join(" ") }), { redirect: "manual" })).status,
		).toBe(400);
	});
	it("bounds state length, parameter count and authorization-query length at their exact limits", async () => {
		const fake = createGoogleOAuthFake();
		expect((await issue(fake, { state: "x".repeat(512) })).access_token).toMatch(/^DYTEST-/);
		expect(
			(await fake.fetch(authorization({ state: "x".repeat(513) }), { redirect: "manual" })).status,
		).toBe(400);
		const query = new URLSearchParams(authorization().split("?")[1]);
		while (query.size < 32) query.set(`dytest${query.size}`, "x");
		expect((await fake.fetch(`/o/oauth2/v2/auth?${query}`, { redirect: "manual" })).status).toBe(
			302,
		);
		query.set("extra", "x");
		expect((await fake.fetch(`/o/oauth2/v2/auth?${query}`, { redirect: "manual" })).status).toBe(
			400,
		);
		const base = `${authorization()}&padding=`;
		const length = base.slice(base.indexOf("?") + 1).length;
		const exact = base + "x".repeat(16_384 - length);
		expect((await fake.fetch(exact, { redirect: "manual" })).status).toBe(302);
		expect((await fake.fetch(`${exact}x`, { redirect: "manual" })).status).toBe(400);
	});
	it("measures the authorization-query cap in UTF-8 bytes rather than UTF-16 units", async () => {
		const fake = createGoogleOAuthFake();
		const base = `${authorization()}&padding=`;
		const available = 16_384 - Buffer.byteLength(present(base.split("?")[1]));
		const exact = base + "é".repeat(Math.floor(available / 2)) + "x".repeat(available % 2);
		expect(Buffer.byteLength(present(exact.split("?")[1]))).toBe(16_384);
		expect((await fake.fetch(exact, { redirect: "manual" })).status).toBe(302);
		expect((await fake.fetch(`${exact}x`, { redirect: "manual" })).status).toBe(400);
	});
	it("bounds token forms at 32 unique fields without consuming the refused code", async () => {
		const fake = createGoogleOAuthFake();
		const pending = await code(fake);
		const values = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: GOOGLE_OAUTH_CLIENT_ID,
			code: pending,
			code_verifier: VERIFIER,
			redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		});
		while (values.size < 32) values.set(`dytest${values.size}`, "x");
		const exact = values.toString();
		values.set("extra", "x");
		const send = (body: string) =>
			fake.fetch("/token", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body,
			});
		expect((await send(values.toString())).status).toBe(400);
		expect((await send(exact)).status).toBe(200);
	});
	it("bounds each script queue at 256 and preserves atomic invalid-batch rejection", async () => {
		const fake = createGoogleOAuthFake();
		fake.enqueueConsent(...Array.from({ length: 256 }, () => ({ kind: "deny" as const })));
		expect(() => fake.enqueueConsent({ kind: "deny" })).toThrow(RangeError);
		for (let index = 0; index < 256; index++) {
			const response = await fake.fetch(authorization(), { redirect: "manual" });
			expect(new URL(present(response.headers.get("location"))).searchParams.get("error")).toBe(
				"access_denied",
			);
			fake.recorder.takeRequests();
		}
		expect(() =>
			fake.enqueueConsent({ kind: "deny" }, { kind: "unexpected-grant", scopes: [""] }),
		).toThrow();
		const pending = await code(fake);
		fake.enqueueTokenError(
			...Array.from({ length: 256 }, () => ({ error: "temporarily_unavailable" as const })),
		);
		expect(() => fake.enqueueTokenError({ error: "invalid_grant" })).toThrow(RangeError);
		for (let index = 0; index < 256; index++) {
			expect((await exchange(fake, pending)).status).toBe(503);
			fake.recorder.takeRequests();
		}
		expect(() =>
			fake.enqueueTokenError({ error: "invalid_grant" }, { error: "wrong" } as never),
		).toThrow();
		expect((await exchange(fake, pending)).status).toBe(200);
	});
	it("reserves 4096 pending codes, refuses overflow and frees only an exchanged entry", async () => {
		const fake = createGoogleOAuthFake();
		let first = "";
		for (let index = 0; index < 4096; index++) {
			const pending = await code(fake);
			if (index === 0) first = pending;
			fake.recorder.takeRequests();
		}
		expect((await fake.fetch(authorization(), { redirect: "manual" })).status).toBe(503);
		expect((await exchange(fake, first)).status).toBe(200);
		expect(await code(fake)).toMatch(/^DYTEST-code-/);
	}, 15_000);
	it("bounds token state at 4096 and preserves a refresh token when rotation cannot allocate", async () => {
		const fake = createGoogleOAuthFake();
		let first!: Tokens;
		for (let index = 0; index < 2048; index++) {
			const tokens = await issue(fake);
			if (index === 0) first = tokens;
			fake.recorder.takeRequests();
		}
		expect((await exchange(fake, await code(fake))).status).toBe(503);
		expect((await refresh(fake, first.refresh_token)).status).toBe(503);
		expect((await refresh(fake, first.refresh_token)).status).toBe(503);
		expect(fake.accessGrant(first.access_token)).toBeDefined();
	}, 15_000);
	it("scripts every token error after client authentication without consuming unrelated errors", async () => {
		const fake = createGoogleOAuthFake();
		const pending = await code(fake);
		const next = { error: "invalid_client" as const, grantType: "authorization_code" as const };
		fake.enqueueTokenError(next, { error: "invalid_grant", grantType: "refresh_token" });
		next.error = "temporarily_unavailable" as never;
		expect((await exchange(fake, pending, { client_id: "DYTEST-unknown" })).status).toBe(401);
		expect((await exchange(fake, pending)).status).toBe(401);
		const tokens = await json<Tokens>(exchange(fake, pending));
		expect((await refresh(fake, tokens.refresh_token)).status).toBe(400);
		expect((await refresh(fake, tokens.refresh_token)).status).toBe(200);
	});
});

describe("Google OAuth bounded reusable fixture controls", () => {
	const open = listeners();
	afterEach(open.closeAll);
	afterEach(() => vi.restoreAllMocks());
	const issued = async (fake: GoogleOAuthFake, scopes: readonly string[] = FULL) =>
		json<Tokens>(exchange(fake, await code(fake, { scope: scopes.join(" ") })));
	const scopeRoundTrip = async (
		fake: GoogleOAuthFake,
		requested: string,
		expectedWire: string,
		expectedGrant = expectedWire,
	) => {
		const response = await fake.fetch(authorization({ scope: requested }), { redirect: "manual" });
		expect(response.status).toBe(302);
		const callback = new URL(present(response.headers.get("location")));
		expect.soft(callback.searchParams.get("scope")).toBe(expectedWire);
		const tokens = await json<Tokens>(exchange(fake, present(callback.searchParams.get("code"))));
		expect.soft(tokens.scope).toBe(expectedWire);
		expect.soft(fake.accessGrant(tokens.access_token)?.scopes).toEqual([expectedGrant]);
	};
	const form = (value: string) =>
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: GOOGLE_OAUTH_CLIENT_ID,
			code: value,
			code_verifier: VERIFIER,
			redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		}).toString();
	const upload = (body: BodyInit, signal?: AbortSignal): RequestInit =>
		({
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
			signal,
			duplex: "half",
		}) as RequestInit;

	it("exports the same usable factory from the root and public subpath", async () => {
		const root = await import("@draftyak/fakes"),
			subpath = await import("@draftyak/fakes/google-oauth");
		expect(root.createGoogleOAuthFake).toBe(createGoogleOAuthFake);
		expect(subpath.createGoogleOAuthFake).toBe(createGoogleOAuthFake);
	});
	it("uses an independent S256 known answer and WebCrypto oracle without outbound fetch", async () => {
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
		expect(
			Buffer.from(
				await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
			).toString("base64url"),
		).toBe(challenge);
		const outgoing = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST no egress"));
		const fake = createGoogleOAuthFake();
		const value = await code(fake, { code_challenge: challenge });
		expect((await exchange(fake, value, { code_verifier: verifier })).status).toBe(200);
		const wrong = await code(fake, { code_challenge: challenge });
		expect(
			(await exchange(fake, wrong, { code_verifier: `${verifier.slice(0, -1)}z` })).status,
		).toBe(400);
		expect(outgoing).not.toHaveBeenCalled();
	});
	it("accepts the 128-character verifier boundary using an independent digest", async () => {
		const verifier = "DYTEST-".padEnd(128, "x");
		const challenge = Buffer.from(
			await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
		).toString("base64url");
		const fake = createGoogleOAuthFake();
		expect(
			(
				await exchange(fake, await code(fake, { code_challenge: challenge }), {
					code_verifier: verifier,
				})
			).status,
		).toBe(200);
	});
	for (const path of ["requested", "ordinary", "unexpected"] as const) {
		it.each(["constructor", "toString", "__proto__"])(
			`preserves literal scope %s through the ${path} grant path`,
			async (literal) => {
				const fake = createGoogleOAuthFake();
				if (path !== "requested")
					fake.enqueueConsent({
						kind: path === "ordinary" ? "grant" : "unexpected-grant",
						scopes: [literal],
					});
				await scopeRoundTrip(fake, path === "unexpected" ? "DYTEST-requested" : literal, literal);
			},
		);
		it(`preserves an unknown literal scope through the ${path} grant path`, async () => {
			const fake = createGoogleOAuthFake();
			const literal = "DYTEST-unknown-scope";
			if (path !== "requested")
				fake.enqueueConsent({
					kind: path === "ordinary" ? "grant" : "unexpected-grant",
					scopes: [literal],
				});
			await scopeRoundTrip(fake, path === "unexpected" ? "DYTEST-requested" : literal, literal);
		});
	}
	it.each([
		["email", EMAIL],
		["profile", "https://www.googleapis.com/auth/userinfo.profile"],
	])(
		"expands only the documented %s scope alias in either consent spelling",
		async (short, long) => {
			for (const [requested, granted] of [
				[short, long],
				[long, short],
			] as const) {
				const fake = createGoogleOAuthFake();
				fake.enqueueConsent({ kind: "grant", scopes: [granted] });
				await scopeRoundTrip(fake, requested, long, granted);
			}
		},
	);
	it("rejects an ordinary unrequested literal scope and preserves the queued grant", async () => {
		const fake = createGoogleOAuthFake();
		fake.enqueueConsent({ kind: "grant", scopes: ["DYTEST-unrequested"] });
		expect(
			(await fake.fetch(authorization({ scope: "DYTEST-requested" }), { redirect: "manual" }))
				.status,
		).toBe(400);
		await scopeRoundTrip(fake, "DYTEST-unrequested", "DYTEST-unrequested");
	});
	it.each([[FULL], [READ]])(
		"scripts complete, missing, empty and equivalent email grants for %j",
		async (required) => {
			for (const grant of [
				required,
				...required.map((_, index) => required.filter((_, at) => at !== index)),
				[],
			]) {
				const fake = createGoogleOAuthFake();
				fake.enqueueConsent({ kind: "grant", scopes: grant });
				const tokens = await issued(fake, required);
				expect(tokens.scope.split(" ").filter(Boolean)).toEqual(
					grant.map((scope) => (scope === "email" ? EMAIL : scope)),
				);
				expect(fake.accessGrant(tokens.access_token)?.scopes).toEqual(grant);
			}
			for (const [request, grant] of [
				[required, required.map((scope) => (scope === "email" ? EMAIL : scope))],
				[required.map((scope) => (scope === "email" ? EMAIL : scope)), required],
			]) {
				const fake = createGoogleOAuthFake();
				fake.enqueueConsent({ kind: "grant", scopes: grant });
				expect((await issued(fake, request)).scope.split(" ")).toEqual(
					required.map((scope) => (scope === "email" ? EMAIL : scope)),
				);
			}
		},
	);
	it("scripts every permitted companion and forbidden returned Gmail scope without deciding caller admission", async () => {
		const companions = ["readonly", "metadata", "labels", "compose", "send", "insert"].map(
			(name) => `https://www.googleapis.com/auth/gmail.${name}`,
		);
		const forbidden = [
			"https://mail.google.com/",
			...["settings.basic", "settings.sharing", "unexpected"].map(
				(name) => `https://www.googleapis.com/auth/gmail.${name}`,
			),
		];
		for (const [required, additional] of [
			[FULL, companions],
			[READ, ["https://www.googleapis.com/auth/gmail.metadata"]],
		] as const) {
			for (const extra of additional) {
				const normal = createGoogleOAuthFake();
				normal.enqueueConsent({ kind: "grant", scopes: [...required, extra] });
				expect((await issued(normal, [...required, extra])).scope.split(" ")).toContain(extra);
				const fake = createGoogleOAuthFake();
				fake.enqueueConsent({ kind: "unexpected-grant", scopes: [...required, extra] });
				const tokens = await issued(fake, required);
				expect(tokens.scope.split(" ")).toContain(extra);
				expect(fake.accessGrant(tokens.access_token)?.scopes).toEqual([...required, extra]);
			}
			for (const extra of [
				...forbidden,
				...(required === READ
					? [
							MODIFY,
							...companions.filter(
								(scope) =>
									![READONLY, "https://www.googleapis.com/auth/gmail.metadata"].includes(scope),
							),
						]
					: []),
			]) {
				const fake = createGoogleOAuthFake();
				fake.enqueueConsent({ kind: "unexpected-grant", scopes: [...required, extra] });
				expect((await issued(fake, required)).scope.split(" ")).toContain(extra);
			}
		}
	});
	it("requires an explicit hostile step for unrequested grants and keeps rejected consent queued", async () => {
		const fake = createGoogleOAuthFake();
		fake.enqueueConsent({ kind: "grant", scopes: [...FULL, READONLY] });
		expect((await fake.fetch(authorization(), { redirect: "manual" })).status).toBe(400);
		expect((await issued(fake, [...FULL, READONLY])).scope.split(" ")).toContain(READONLY);
		const unexpected = [...FULL, "https://mail.google.com/"];
		fake.enqueueConsent({ kind: "unexpected-grant", scopes: unexpected });
		unexpected.pop();
		expect((await issued(fake)).scope.split(" ")).toContain("https://mail.google.com/");
	});
	it.each([false, true])(
		"provides confirmed/unconfirmed initial rejected-grant cleanup traces (fault=%s)",
		async (fault) => {
			const fake = createGoogleOAuthFake();
			fake.enqueueConsent({
				kind: "unexpected-grant",
				scopes: [...FULL, "https://mail.google.com/"],
			});
			const replacement = await issued(fake);
			expect(fake.recorder.takeRequests().filter((record) => record.path === "/revoke")).toEqual(
				[],
			);
			if (fault) fake.faults.add({ kind: "server-error", path: "/revoke" });
			const result = await post(fake, "/revoke", { token: replacement.refresh_token });
			expect(result.status).toBe(fault ? 503 : 200);
			expect(fake.accessGrant(replacement.access_token) !== undefined).toBe(fault);
			const traces = fake.recorder.takeRequests();
			expect(traces.map((record) => record.path)).toEqual(["/revoke"]);
			expect(Buffer.from(present(traces[0]).body).toString()).toBe(
				new URLSearchParams({ token: replacement.refresh_token }).toString(),
			);
		},
	);
	it.each([
		[FULL, READ],
		[READ, FULL],
	])(
		"leaves existing fixture grants usable when replacement scopes are unacceptable: %j",
		async (before, after) => {
			const fake = createGoogleOAuthFake();
			const old = await issued(fake, before);
			fake.enqueueConsent({
				kind: "unexpected-grant",
				scopes: [...after, "https://mail.google.com/"],
			});
			const replacement = await issued(fake, after);
			expect(replacement.scope).toContain("https://mail.google.com/");
			expect(fake.accessGrant(old.access_token)?.scopes).toEqual(before);
			expect((await refresh(fake, old.refresh_token)).status).toBe(200);
			expect(fake.recorder.takeRequests().some((record) => record.path === "/revoke")).toBe(false);
		},
	);
	it("returns immutable detached grant metadata and isolates clients and instances during revoke", async () => {
		const fake = createGoogleOAuthFake({
			clients: [
				{ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
				{ clientId: "DYTEST-other", redirectUris: [GOOGLE_OAUTH_REDIRECT_URI] },
			],
		});
		const a = await issued(fake);
		const b = await json<Tokens>(
			exchange(fake, await code(fake, { client_id: "DYTEST-other" }), {
				client_id: "DYTEST-other",
			}),
		);
		const grant = present(fake.accessGrant(a.access_token));
		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant.scopes)).toBe(true);
		expect(() => (grant.scopes as string[]).push("DYTEST-changed")).toThrow(TypeError);
		expect(fake.accessGrant(a.access_token)).not.toBe(grant);
		const other = createGoogleOAuthFake();
		const separate = await issued(other);
		expect(fake.revoke(a.refresh_token)).toBe(true);
		expect(fake.accessGrant(a.access_token)).toBeUndefined();
		expect(fake.accessGrant(b.access_token)?.clientId).toBe("DYTEST-other");
		expect((await refresh(fake, b.refresh_token, { client_id: "DYTEST-other" })).status).toBe(200);
		expect(other.accessGrant(separate.access_token)).toBeDefined();
	});
	it("admits just-before-expiry codes/refresh and serializes concurrent refresh rotation", async () => {
		const clock = manualClock(START);
		const fake = createGoogleOAuthFake({ clock, codeTtlMs: 1000 });
		const pending = await code(fake);
		clock.advance(999);
		const first = await json<Tokens>(exchange(fake, pending));
		const results = await Promise.all([
			refresh(fake, first.refresh_token),
			refresh(fake, first.refresh_token),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
		const short = createGoogleOAuthFake({
			clock,
			refreshTtlSeconds: 3,
			rotateRefreshTokens: false,
		});
		const tokens = await issued(short);
		clock.advance(2999);
		expect((await refresh(short, tokens.refresh_token)).status).toBe(200);
		clock.advance(1);
		expect((await refresh(short, tokens.refresh_token)).status).toBe(400);
	});
	it("distinguishes before-effect failure from lost replies after code exchange and refresh", async () => {
		const fake = createGoogleOAuthFake();
		const pending = await code(fake);
		fake.faults.add({ kind: "server-error", path: "/token" });
		expect((await exchange(fake, pending)).status).toBe(503);
		fake.faults.add({ kind: "drop", path: "/token", after: true });
		await expect(exchange(fake, pending)).rejects.toThrow("fetch failed");
		expect((await exchange(fake, pending)).status).toBe(400);
		const first = await issued(fake);
		fake.faults.add({ kind: "drop", path: "/token", after: true });
		await expect(refresh(fake, first.refresh_token)).rejects.toThrow("fetch failed");
		expect((await refresh(fake, first.refresh_token)).status).toBe(400);
		expect(fake.accessGrant(first.access_token)).toBeDefined();
	});
	it.each([
		"http://127.0.0.1:1/callback",
		"http://127.0.0.1:65535/callback",
		"http://[::1]:54321/callback",
	])("supports an exact registered numeric loopback callback %s", async (uri) => {
		const fake = createGoogleOAuthFake({
			clients: [{ clientId: GOOGLE_OAUTH_CLIENT_ID, redirectUris: [uri] }],
		});
		expect(
			(await exchange(fake, await code(fake, { redirect_uri: uri }), { redirect_uri: uri })).status,
		).toBe(200);
	});
	it.each([
		"http://localhost:54321/cb",
		"http://127.1:54321/cb",
		"http://2130706433:54321/cb",
		"http://127.0.0.1:0/cb",
		"http://127.0.0.1:65536/cb",
		"http://127.0.0.1:01/cb",
		"http://127.0.0.1:54321/cb?x=1",
		"http://127.0.0.1:54321/cb#x",
		"http://user@127.0.0.1:54321/cb",
		"http://[::2]:54321/cb",
		"https://127.0.0.1:54321/cb",
		"http://127.0.0.1:54321/a/../cb",
		"http://127.0.0.1:54321/cb\n",
	])("refuses noncanonical or unregistered-loopback syntax %s", (uri) => {
		expect(() =>
			createGoogleOAuthFake({ clients: [{ clientId: "DYTEST-client", redirectUris: [uri] }] }),
		).toThrow();
	});
	it("enforces the literal 16 KiB boundary with received-prefix/hash refusal evidence", async () => {
		const fake = createGoogleOAuthFake({ recorder: createRecorder({ maxBodyBytes: 7 }) });
		const pending = await code(fake);
		const base = `${form(pending)}&padding=`;
		const exact = base + "x".repeat(16_384 - Buffer.byteLength(base));
		expect(Buffer.byteLength(exact)).toBe(16_384);
		expect((await fake.fetch("/token", upload(exact))).status).toBe(200);
		fake.recorder.takeRequests();
		const oversized = `${exact}x`;
		const clone = vi.spyOn(Request.prototype, "clone");
		const result = await fake.fetch("/token", upload(oversized));
		expect(result.status).toBe(413);
		expect(await result.json()).toEqual({ error: "request_body_too_large" });
		expect(clone).not.toHaveBeenCalled();
		const trace = present(fake.recorder.takeRequests()[0]);
		expect(trace.bodyLength).toBe(16_385);
		expect(trace.bodySha256).toBe(createHash("sha256").update(oversized).digest("hex"));
		expect(Buffer.from(trace.body).toString()).toBe(oversized.slice(0, 7));
		expect(trace.refused).toBe("request_body_too_large");
	});
	it("requires custom begin for capped intake and binds its receiver", async () => {
		const delegate = createRecorder();
		expect(() =>
			createGoogleOAuthFake({
				recorder: {
					record: (request) => delegate.record(request),
					takeRequests: () => delegate.takeRequests(),
				},
			}),
		).toThrow("requires recorder.begin");
		const recorder = {
			begin(request: Request) {
				expect(this).toBe(recorder);
				return delegate.begin(request);
			},
			record: (request: Request) => delegate.record(request),
			takeRequests: () => delegate.takeRequests(),
		};
		expect((await issued(createGoogleOAuthFake({ recorder }))).token_type).toBe("Bearer");
	});
	it("discards malformed or aborted incomplete intake without consuming the code", async () => {
		for (const kind of ["malformed", "abort", "source-error"] as const) {
			const fake = createGoogleOAuthFake();
			const pending = await code(fake);
			fake.recorder.takeRequests();
			const controller = new AbortController();
			const reason = new Error(`DYTEST-${kind}`);
			let reading!: () => void;
			const started = new Promise<void>((resolve) => {
				reading = resolve;
			});
			let cancelled = false;
			const body = new ReadableStream<Uint8Array>({
				pull(stream) {
					reading();
					if (kind === "malformed") stream.enqueue("DYTEST-nonbytes" as never);
					else if (kind === "source-error") stream.error(reason);
					else return new Promise(() => {});
				},
				cancel() {
					cancelled = true;
				},
			});
			const response = fake.fetch("/token", upload(body, controller.signal));
			await started;
			if (kind === "abort") controller.abort(reason);
			await expect(response).rejects.toThrow(
				kind === "malformed" ? "Invalid request body chunk" : reason.message,
			);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(fake.recorder.takeRequests()).toEqual([]);
			if (kind !== "source-error") expect(cancelled).toBe(true);
			expect((await exchange(fake, pending)).status).toBe(200);
		}
	});
	it.each([
		"client_id=a&client_id=b",
		"client_id=a&%63lient_id=b",
		"client_id=%FF",
		"client_id=%ZZ",
		"client_id=a&grant_type=authorization_code&code=x&code=x",
	])("refuses ambiguous or malformed form encoding %s", async (raw) => {
		expect((await createGoogleOAuthFake().fetch("/token", upload(raw))).status).toBe(400);
	});
	it("refuses malformed UTF-8, unsupported media parameters and raw route aliases", async () => {
		const fake = createGoogleOAuthFake();
		expect((await fake.fetch("/token", upload(new Uint8Array([0xff])))).status).toBe(400);
		for (const type of [
			"text/plain",
			"application/x-www-form-urlencoded; charset=latin1",
			"application/x-www-form-urlencoded; extra=yes",
		])
			expect(
				(await fake.fetch("/token", { ...upload("x=y"), headers: { "content-type": type } }))
					.status,
			).toBe(415);
		for (const target of ["/to%6ben", "/x/../token", "/token/", "/token?x=1", "/token#x"])
			expect((await fake.fetch(target, upload("x=y"))).status).not.toBe(200);
		fake.enqueueConsent({ kind: "deny" });
		expect(
			(await fake.fetch(`${authorization()}&%73tate=duplicate`, { redirect: "manual" })).status,
		).toBe(400);
		expect(
			new URL(
				present(
					(await fake.fetch(authorization(), { redirect: "manual" })).headers.get("location"),
				),
			).searchParams.get("error"),
		).toBe("access_denied");
	});
	it("preserves raw targets and complete admitted/refused evidence over real loopback", async () => {
		const fake = createGoogleOAuthFake({ recorder: createRecorder({ maxBodyBytes: 2 }) });
		const server = open.keep(await fake.listen());
		const response = await fetch(`${server.origin}${authorization()}`, { redirect: "manual" });
		const pending = present(
			new URL(present(response.headers.get("location"))).searchParams.get("code"),
		);
		const exactBase = `${form(pending)}&padding=`;
		const exact = exactBase + "x".repeat(16_384 - Buffer.byteLength(exactBase));
		expect((await fetch(`${server.origin}/token`, upload(exact))).status).toBe(200);
		fake.recorder.takeRequests();
		expect((await fetch(`${server.origin}/to%6ben`, upload("x=y"))).status).toBe(404);
		expect(fake.recorder.takeRequests()[0]?.target).toBe("/to%6ben");
		const large = "x".repeat(16_385);
		expect((await fetch(`${server.origin}/token`, upload(large))).status).toBe(413);
		expect(fake.recorder.takeRequests()).toMatchObject([
			{
				bodyLength: 16_385,
				bodySha256: createHash("sha256").update(large).digest("hex"),
				refused: "request_body_too_large",
			},
		]);
		const socket = createConnection({ host: "127.0.0.1", port: server.port });
		try {
			const answer = new Promise<string>((resolve, reject) => {
				let bytes = "";
				socket.setTimeout(2000, () => reject(new Error("DYTEST stalled intake")));
				socket.on("error", reject);
				socket.on("data", (part) => {
					bytes += part;
					if (bytes.includes("request_body_too_large")) resolve(bytes);
				});
				socket.once("connect", () =>
					socket.write(
						`POST /token HTTP/1.1\r\nHost: ${GOOGLE_OAUTH_HOST}\r\nContent-Length: 33554432\r\nContent-Type: application/x-www-form-urlencoded\r\nConnection: close\r\n\r\n${large}`,
					),
				);
			});
			expect(await answer).toMatch(/^HTTP\/1\.1 413 /);
			expect(fake.recorder.takeRequests()[0]?.refused).toBe("request_body_too_large");
		} finally {
			socket.destroy();
		}
	});
});
