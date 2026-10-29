import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gmail } from "../src/api.ts";
import {
	authorizationUrl,
	browserCommand,
	checkScopes,
	connect,
	GMAIL_MODIFY,
	GMAIL_READONLY,
	GOOGLE,
	grantCovers,
	listenLoopback,
	newPkce,
	OAuthError,
	refreshTokens,
	revokeToken,
	ScopeError,
	scopesFor,
	TESTING_GRANT_MS,
} from "../src/oauth.ts";
import { type FakeGmail, startFakeGmail } from "./fake-gmail.ts";
import { type FakeOAuth, fakeBrowser, startFakeOAuth, TokenRegistry } from "./fake-google-oauth.ts";
import { liveSession } from "./live-session.ts";

vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: vi.fn(),
}));

// Synthetic credentials made at run time; nothing shaped like a Google client ID or secret.
const clientId = `client-${randomBytes(6).toString("hex")}.test.invalid`;
const clientSecret = `secret-${randomBytes(12).toString("hex")}`;

function get(url: string, host?: string, method = "GET"): Promise<number> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const request = httpRequest(
			{
				host: target.hostname,
				port: target.port,
				path: `${target.pathname}${target.search}`,
				method,
				headers: { host: host ?? target.host },
			},
			(response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			},
		);
		request.once("error", reject).end();
	});
}

describe("PKCE and the authorization request", () => {
	it("makes a 43-character verifier with its S256 challenge", () => {
		const pkce = newPkce();
		expect(pkce.verifier).toMatch(/^[\w-]{43}$/);
		expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
		expect(newPkce().verifier).not.toBe(pkce.verifier);
	});

	it("asks Google for openid, email and gmail.modify with PKCE on a loopback redirect", () => {
		const url = new URL(
			authorizationUrl({
				endpoint: GOOGLE.authorization,
				clientId,
				redirectUri: "http://127.0.0.1:50123",
				scopes: scopesFor("full"),
				state: "s",
				challenge: "c",
			}),
		);
		expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: clientId,
			redirect_uri: "http://127.0.0.1:50123",
			response_type: "code",
			scope: `openid email ${GMAIL_MODIFY}`,
			state: "s",
			code_challenge: "c",
			code_challenge_method: "S256",
		});
		expect(scopesFor("read_only")).toEqual(["openid", "email", GMAIL_READONLY]);
		expect(GOOGLE).toEqual({
			authorization: "https://accounts.google.com/o/oauth2/v2/auth",
			token: "https://oauth2.googleapis.com/token",
			revocation: "https://oauth2.googleapis.com/revoke",
		});
	});
});

describe("scope check", () => {
	const longEmail = "https://www.googleapis.com/auth/userinfo.email";

	it("accepts Google's long names for the sign-in scopes", () => {
		expect(checkScopes(`${GMAIL_MODIFY} ${longEmail} openid`, "full")).toEqual({
			ok: true,
			missing: [],
			extra: [],
		});
		expect(checkScopes(`openid ${longEmail} ${GMAIL_READONLY}`, "read_only").ok).toBe(true);
	});

	it("fails without gmail.modify, the scope granular consent lets the owner untick", () => {
		expect(checkScopes(`openid ${longEmail}`, "full")).toEqual({
			ok: false,
			missing: [GMAIL_MODIFY],
			extra: [],
		});
	});

	it("fails on a Gmail scope that reaches beyond the mode, and allows other sign-in scopes", () => {
		const full = `openid ${longEmail} ${GMAIL_MODIFY}`;
		const settings = "https://www.googleapis.com/auth/gmail.settings.sharing";
		expect(checkScopes(`${full} https://mail.google.com/ ${settings}`, "full").extra).toEqual([
			"https://mail.google.com/",
			settings,
		]);
		expect(
			checkScopes(`openid ${longEmail} ${GMAIL_READONLY} ${GMAIL_MODIFY}`, "read_only"),
		).toEqual({
			ok: false,
			missing: [],
			extra: [GMAIL_MODIFY],
		});
		expect(checkScopes(`${full} https://www.googleapis.com/auth/userinfo.profile`, "full").ok).toBe(
			true,
		);
	});

	it("accepts narrower Gmail scopes granted beside the mode's own", () => {
		const metadata = "https://www.googleapis.com/auth/gmail.metadata";
		expect(checkScopes(`openid ${longEmail} ${GMAIL_MODIFY} ${GMAIL_READONLY}`, "full")).toEqual({
			ok: true,
			missing: [],
			extra: [],
		});
		expect(checkScopes(`openid ${longEmail} ${GMAIL_READONLY} ${metadata}`, "read_only").ok).toBe(
			true,
		);
	});
});

describe("the loopback listener", () => {
	it("takes only GET / with its own Host and state, once", async () => {
		const loopback = await listenLoopback("the-state");
		const port = new URL(loopback.redirectUri).port;
		expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(await get(`${loopback.redirectUri}/?state=other&code=x`)).toBe(400);
		expect(await get(`${loopback.redirectUri}/?state=the-state&code=x`, `localhost:${port}`)).toBe(
			404,
		);
		expect(await get(`${loopback.redirectUri}/cb?state=the-state&code=x`)).toBe(404);
		expect(await get(`${loopback.redirectUri}/?state=the-state&code=x`, undefined, "POST")).toBe(
			404,
		);
		expect(await get(`${loopback.redirectUri}/?state=the-state&code=the-code`)).toBe(200);
		await expect(loopback.code).resolves.toBe("the-code");
		await expect(get(`${loopback.redirectUri}/?state=the-state&code=again`)).rejects.toThrow();
	});

	it("reports a refusal, a timeout and an abort", async () => {
		const denied = await listenLoopback("s");
		expect(await get(`${denied.redirectUri}/?state=s&error=access_denied`)).toBe(400);
		await expect(denied.code).rejects.toMatchObject({ code: "access_denied" });
		const slow = await listenLoopback("s", { timeoutMs: 20 });
		await expect(slow.code).rejects.toMatchObject({ code: "timeout" });
		const controller = new AbortController();
		const aborted = await listenLoopback("s", { signal: controller.signal });
		controller.abort();
		await expect(aborted.code).rejects.toMatchObject({ code: "aborted" });
		await expect(get(`${aborted.redirectUri}/?state=s&code=c`)).rejects.toThrow();
		const started = Date.now();
		await expect(
			listenLoopback("s", { signal: AbortSignal.abort(), timeoutMs: 5_000 }),
		).rejects.toMatchObject({ code: "aborted" });
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});

describe("connect, against fake Google OAuth and fake Gmail", () => {
	let tokens: TokenRegistry;
	let oauth: FakeOAuth;
	let gmail: FakeGmail;
	let consent: (requested: readonly string[]) => readonly string[] | "deny";

	beforeEach(async () => {
		tokens = new TokenRegistry();
		consent = (requested) => requested;
		oauth = await startFakeOAuth({ clientId, clientSecret, tokens, consent: (r) => consent(r) });
		gmail = await startFakeGmail({ tokens });
	});

	afterEach(async () => {
		expect(oauth.problems).toEqual([]);
		expect(gmail.violations).toEqual([]);
		expect(gmail.unimplemented).toEqual([]);
		await Promise.all([oauth.close(), gmail.close()]);
	});

	const options = () => ({
		clientId,
		clientSecret,
		endpoints: oauth.endpoints,
		openBrowser: fakeBrowser,
	});

	it("runs the Desktop-client flow and gets tokens that work for Gmail", async () => {
		const set = await connect(options());
		expect(set.refreshToken).toBeDefined();
		expect(checkScopes(set.scope, "full").ok).toBe(true);
		const request = oauth.authorizations[0];
		expect(request?.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(request?.get("code_challenge_method")).toBe("S256");
		const profile = await new Gmail({ accessToken: set.accessToken, root: gmail.url }).getProfile();
		expect(profile.emailAddress).toBe("owner@example.com");
	});

	it("fails and revokes the grant when gmail.modify was unticked", async () => {
		consent = (requested) => requested.filter((scope) => scope !== GMAIL_MODIFY);
		const failure = await connect(options()).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ScopeError);
		expect(failure).toMatchObject({
			code: "scope_missing",
			check: { missing: [GMAIL_MODIFY] },
			revoked: true,
		});
		expect(oauth.revocations).toHaveLength(1);
		const [revoked = ""] = oauth.revocations;
		expect(tokens.lookup(revoked, "refresh") ?? tokens.lookup(revoked, "access")).toBeUndefined();
	});

	it("ends the account's earlier grant too, as Google's revoke does", async () => {
		const first = await connect(options());
		consent = (requested) => requested.filter((scope) => scope !== GMAIL_MODIFY);
		await expect(connect(options())).rejects.toMatchObject({ revoked: true });
		await expect(refreshTokens(options(), first.refreshToken ?? "")).rejects.toMatchObject({
			code: "invalid_grant",
		});
	});

	it("says so when the revocation fails, and the grant stays live", async () => {
		consent = (requested) => requested.filter((scope) => scope !== GMAIL_MODIFY);
		const sent: string[] = [];
		const revokeDown: typeof fetch = async (input, init) => {
			if (!String(input).endsWith("/revoke")) return fetch(input, init);
			sent.push(new URLSearchParams(String(init?.body)).get("token") ?? "");
			return new Response(null, { status: 503 });
		};
		const failure = await connect({ ...options(), fetch: revokeDown }).catch((e: unknown) => e);
		expect(failure).toMatchObject({ code: "scope_missing", revoked: false });
		expect((failure as Error).message).toContain("not revoked");
		expect(sent).toHaveLength(2);
		expect(tokens.lookup(sent[0] ?? "", "refresh")).toBeDefined();
	});

	it("opens no browser for a sign-in already aborted", async () => {
		const openBrowser = vi.fn(fakeBrowser);
		const signal = AbortSignal.abort();
		await expect(connect({ ...options(), openBrowser, signal })).rejects.toMatchObject({
			code: "aborted",
		});
		expect(openBrowser).not.toHaveBeenCalled();
		expect(oauth.authorizations).toEqual([]);
	});

	it("reports a refused consent", async () => {
		consent = () => "deny";
		await expect(connect(options())).rejects.toMatchObject({ code: "access_denied" });
	});

	it("refreshes, then fails with invalid_grant once revoked, without the token in the error", async () => {
		const set = await connect(options());
		const refresh = set.refreshToken ?? "";
		const renewed = await refreshTokens(options(), refresh);
		expect(renewed.accessToken).not.toBe(set.accessToken);
		expect(renewed.refreshToken).toBeUndefined();
		expect(await revokeToken(options(), refresh)).toBe(true);
		expect(await revokeToken(options(), refresh)).toBe(false);
		const error = await refreshTokens(options(), refresh).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OAuthError);
		expect(error).toMatchObject({ code: "invalid_grant" });
		expect(String((error as Error).message)).not.toContain(refresh);
	});

	it("refuses a wrong client secret at the token endpoint", async () => {
		await expect(connect({ ...options(), clientSecret: "wrong" })).rejects.toMatchObject({
			code: "invalid_client",
		});
	});
});

describe("the system browser and the Testing-mode horizon", () => {
	it("reports a launcher error once with fixed wording and never its secret-bearing details", () => {
		const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
		vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
		const lines: string[] = [];
		const url = "https://accounts.google.com/o/oauth2/v2/auth?private=planted-secret";
		const session = liveSession(
			{ DRAFTYAK_S8_SESSION: path.resolve("synthetic-session") },
			(line) => lines.push(line),
		);
		session.openBrowser(url);
		expect(lines).toEqual([]);
		expect(spawn).toHaveBeenLastCalledWith(browserCommand(url).command, browserCommand(url).args, {
			detached: true,
			stdio: "ignore",
		});
		expect(child.unref).toHaveBeenCalledOnce();
		child.emit("error", new Error(`${url} owner@example.invalid planted-secret`));
		expect(lines).toEqual(["couldn't open the browser"]);
		expect(child.listenerCount("error")).toBe(0);
	});

	it("opens https URLs with a native program by its full path and no shell", () => {
		const url = "https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2";
		const windows = browserCommand(url, "win32");
		expect(windows.args).toEqual(["url.dll,FileProtocolHandler", url]);
		expect(path.win32.isAbsolute(windows.command)).toBe(true);
		expect(windows.command).toMatch(/\\System32\\rundll32\.exe$/i);
		if (process.platform === "win32") {
			const root = process.env.SystemRoot ?? "";
			expect(windows.command.toLowerCase()).toBe(`${root}\\system32\\rundll32.exe`.toLowerCase());
		}
		expect(browserCommand(url, "darwin")).toEqual({ command: "/usr/bin/open", args: [url] });
		expect(browserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
		expect(() => browserCommand("http://127.0.0.1:1/x", "win32")).toThrow(OAuthError);
		expect(() => browserCommand("file:///C:/Windows/notepad.exe", "win32")).toThrow(OAuthError);
	});

	it("knows a Testing grant ends 7 days after consent", () => {
		const consented = Date.parse("2026-10-17T12:00:00Z");
		expect(TESTING_GRANT_MS).toBe(604_800_000);
		expect(grantCovers("testing", consented, consented + TESTING_GRANT_MS)).toBe(true);
		expect(grantCovers("testing", consented, consented + TESTING_GRANT_MS + 1)).toBe(false);
		expect(grantCovers("production", consented, consented + 30 * 86_400_000)).toBe(true);
	});
});
