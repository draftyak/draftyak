import { execFile } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { type Credential, discover, newHostId, signIn } from "../src/auth.ts";
import { transferText } from "../src/session.ts";
import { type FakeAuth, type FakeAuthOptions, startFakeAuth } from "./fake-auth.ts";
import {
	type FakeResponses,
	type Received,
	type Reply,
	startFakeResponses,
	structured,
} from "./fake-responses.ts";
import {
	answer,
	endAfterForcedRefresh,
	MODEL,
	memoryStore,
	refreshAnswers,
	shortLivedRefresh,
} from "./harness.ts";
import { AFTER_EXPIRY_MS } from "./live-record.ts";

// The documented transfer across two processes (plan §4 step 2; Self-hosted VMs): this test signs
// in as the desktop with the hub's host ID, hands the text to test/transfer-child.ts as the hub and
// forgets it. M0.27 runs the same child against OpenAI.

let auth: FakeAuth | undefined;
afterEach(async () => {
	await auth?.close();
	auth = undefined;
});

interface ChildRun {
	readonly exitCode: number;
	readonly result: unknown;
}

function child(args: readonly string[], input: string, signal: AbortSignal): Promise<ChildRun> {
	const script = path.join(import.meta.dirname, "transfer-child.ts");
	return new Promise((resolve, reject) => {
		const run = execFile(process.execPath, [script, ...args], { signal }, (error, stdout) => {
			const exitCode = typeof error?.code === "number" ? error.code : error ? -1 : 0;
			try {
				resolve({ exitCode, result: JSON.parse(stdout) });
			} catch {
				reject(error ?? new Error("the child printed no JSON"));
			}
		});
		run.stdin?.end(input);
	});
}

async function desktopSignIn(hostId: string): Promise<{ auth: FakeAuth; credential: Credential }> {
	auth = await startFakeAuth();
	const endpoints = await discover(auth.url);
	const credential = await signIn({ hostId, endpoints, port: 0, openBrowser: auth.browse });
	return { auth, credential };
}

it("the hub process takes the session over and revokes it on request; the desktop forgets it", async ({
	signal,
}) => {
	const hubHostId = newHostId();
	const { auth, credential } = await desktopSignIn(hubHostId);
	const desktop = memoryStore(credential);
	const text = transferText(credential);
	await desktop.write(null);
	const run = await child([auth.url, hubHostId, "--revoke"], text, signal);
	expect(run).toEqual({
		exitCode: 0,
		result: {
			accepted: true,
			refreshed: true,
			rotated: true,
			planUsage: "enabled",
			revoked: true,
		},
	});
	expect(await desktop.read()).toBeNull();
	const refreshes = auth.tokenForms.filter((form) => form.get("grant_type") === "refresh_token");
	expect(refreshes.map((form) => form.get("refresh_token"))).toEqual([
		credential.tokens?.refreshToken,
	]);
	const revoked = auth.revocations.map((form) => form.get("token") ?? "");
	expect(revoked).toHaveLength(1);
	expect(revoked[0]).not.toBe(credential.tokens?.refreshToken);
	expect(auth.refresh.get(revoked[0] ?? "")?.family.revoked).toBe(true);
	expect(auth.problems).toEqual([]);
	expect(JSON.stringify(run)).not.toContain(credential.tokens?.accessToken ?? "-");
});

it("a hub with another host ID refuses the credential and touches nothing", async ({ signal }) => {
	const { auth, credential } = await desktopSignIn(newHostId());
	const run = await child([auth.url, newHostId(), "--revoke"], transferText(credential), signal);
	expect(run).toEqual({
		exitCode: 1,
		result: { accepted: false, refreshed: false, code: "TRANSFER_REFUSED", detail: "hostId" },
	});
	expect(auth.tokenForms.map((form) => form.get("grant_type"))).toEqual(["authorization_code"]);
	expect(auth.revocations).toEqual([]);
});

// The step after expiry (--deferred, M0.27): the desktop signs in with tokens that last an hour, as
// live; the hub's forced refresh gets tokens that last EXPIRES_IN seconds, so its access token
// expires within seconds, and the refresh after expiry gets an hour again. --after-expiry-ms, which
// only a test passes, has the hub draft again AFTER_MS after that expiry.
const EXPIRES_IN = 3;
const AFTER_MS = 300;
const WAIT = { timeout: 120_000 };

// biome-ignore lint/suspicious/noExplicitAny: the hub's result is read back as plain JSON
type Data = Record<string, any>;

interface Handover {
	readonly auth: FakeAuth;
	readonly api: FakeResponses;
	readonly hostId: string;
	readonly text: string;
}

async function handover(
	ctx: TestContext,
	options: {
		readonly after?: Partial<FakeAuthOptions>;
		readonly script?: (request: Received) => Reply;
	} = {},
): Promise<Handover> {
	const auth = await startFakeAuth();
	const api = await startFakeResponses(auth.access, options.script ?? answer);
	ctx.onTestFinished(async () => {
		await Promise.all([auth.close(), api.close()]);
	});
	const hostId = newHostId();
	const endpoints = await discover(auth.url);
	const credential = await signIn({ hostId, endpoints, port: 0, openBrowser: auth.browse });
	const { expiresIn = EXPIRES_IN, ...after } = options.after ?? {};
	Object.assign(auth.options, after);
	shortLivedRefresh(auth, expiresIn);
	return { auth, api, hostId, text: transferText(credential) };
}

const deferred = (hub: Handover, ...extra: string[]): string[] => [
	hub.auth.url,
	hub.hostId,
	"--revoke",
	"--live",
	hub.api.url,
	...extra,
	"--deferred",
	"1",
	"--after-expiry-ms",
	String(AFTER_MS),
];
const DRAFTING = ["--draft", MODEL, "text-format"];

const refreshForms = (auth: FakeAuth): (string | null)[] =>
	auth.tokenForms
		.filter((form) => form.get("grant_type") === "refresh_token")
		.map((form) => form.get("refresh_token"));

// No token or client ID the fake issued is in what the hub printed.
function expectNoToken(hub: Handover, run: ChildRun): void {
	const output = JSON.stringify(run);
	const { access, refresh, clients } = hub.auth;
	const issued = [...access.keys(), ...refresh.keys(), ...clients.keys()];
	expect(issued.filter((value) => output.includes(value))).toEqual([]);
}

// A run the hub process refuses before it reads anything: its exit code and stderr.
function refused(args: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
	const script = path.join(import.meta.dirname, "transfer-child.ts");
	return new Promise((resolve) => {
		const run = execFile(process.execPath, [script, ...args], (error, _stdout, stderr) => {
			resolve({ exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0, stderr });
		});
		run.stdin?.end();
	});
}

describe.concurrent("the step after expiry (--deferred)", WAIT, () => {
	it("refreshes through Session.accessToken() only once the access token has expired, drafts, and revokes the newest tokens", async (ctx) => {
		const hub = await handover(ctx);
		const run = await child(deferred(hub, ...DRAFTING), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				accepted: true,
				draft: { outcome: "draft" },
				refreshed: true,
				rotated: true,
				refresh: { status: 200, shape: { expiresIn: EXPIRES_IN } },
				deferred: {
					ran: true,
					refreshed: true,
					rotated: true,
					refresh: { status: 200, shape: { expiresIn: 3600 } },
					draft: { outcome: "draft", via: "text" },
				},
				revoked: true,
				revocation: [200],
				afterRevoke: {
					refresh: { accepted: false, apiCode: "invalid_grant" },
					models: { status: 401 },
				},
			},
		});
		const step = (run.result as Data).deferred;
		expect(step).not.toHaveProperty("code");
		expect(step.msAfterExpiry).toBeGreaterThanOrEqual(AFTER_MS);
		expect(step.idleMs).toBeGreaterThanOrEqual(EXPIRES_IN * 1000 + AFTER_MS);
		// At the fake: the forced refresh, the one after expiry with the token the forced one issued,
		// then the revoked token tried again, and nothing else. The first draft needed no refresh.
		const issued = [...hub.auth.refresh.keys()];
		expect(refreshForms(hub.auth)).toEqual(issued);
		expect(hub.auth.revocations.map((form) => form.get("token"))).toEqual([issued[2]]);
		// The fake issued the later tokens after the forced refresh's access token had expired.
		const [, forced, later] = [...hub.auth.access.values()];
		expect((later?.expiresAt ?? 0) - 3600_000).toBeGreaterThan(forced?.expiresAt ?? 0);
		expectNoToken(hub, run);
	});

	it("an earliest_refresh_at after expiry doesn't hold the refresh after expiry back", async (ctx) => {
		const hourAhead = Math.floor(Date.now() / 1000) + 3600;
		const hub = await handover(ctx, { after: { earliestRefreshAt: hourAhead } });
		const run = await child(deferred(hub, ...DRAFTING), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				refresh: { shape: { earliestRefreshAt: { type: "number", unit: "s" } } },
				deferred: { ran: true, refreshed: true, rotated: true, draft: { outcome: "draft" } },
				revoked: true,
			},
		});
		const result = run.result as Data;
		expect(result.refresh.shape.earliestRefreshAt.inS).toBeGreaterThan(3000);
		expect(result.deferred.msAfterExpiry).toBeGreaterThanOrEqual(AFTER_MS);
		expectNoToken(hub, run);
	});

	it("without --draft, the step still refreshes after expiry through Session.accessToken()", async (ctx) => {
		const hub = await handover(ctx);
		const run = await child(deferred(hub), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				deferred: {
					ran: true,
					refreshed: true,
					rotated: true,
					refresh: { status: 200 },
					draft: null,
				},
				revoked: true,
			},
		});
		expect(run.result).not.toHaveProperty("draft");
		expect(hub.api.received.map((request) => request.path)).toEqual(["/v1/models"]);
		expectNoToken(hub, run);
	});

	it("the token after expiry comes from Session.accessToken(): its plan check refuses a token without plan usage before any draft is sent", async (ctx) => {
		const hub = await handover(ctx);
		refreshAnswers(hub.auth, (body, n) =>
			n === 2 ? { ...body, scope: "offline_access resource.invoke" } : body,
		);
		const run = await child(deferred(hub, ...DRAFTING), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				draft: { outcome: "draft" },
				planUsage: "enabled",
				deferred: {
					ran: true,
					refreshed: true,
					rotated: true,
					code: "PLAN_USAGE_DISABLED",
					draft: { outcome: "error", code: "PLAN_USAGE_DISABLED" },
				},
				revoked: true,
			},
		});
		const drafts = hub.api.received.filter((request) => request.path === "/v1/responses");
		expect(drafts).toHaveLength(1);
		expectNoToken(hub, run);
	});

	it("a refresh after expiry answered without a new refresh token is recorded as not rotated, and the kept token revoked", async (ctx) => {
		const hub = await handover(ctx);
		refreshAnswers(hub.auth, (body, n) => {
			if (n !== 2) return body;
			const { refresh_token: _dropped, ...kept } = body;
			return kept;
		});
		const run = await child(deferred(hub, ...DRAFTING), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				rotated: true,
				deferred: { ran: true, refreshed: true, rotated: false, draft: { outcome: "draft" } },
				revoked: true,
				afterRevoke: { refresh: { accepted: false, apiCode: "invalid_grant" } },
			},
		});
		expect((run.result as Data).deferred).not.toHaveProperty("code");
		const [, forced] = [...hub.auth.refresh.keys()];
		expect(hub.auth.revocations.map((form) => form.get("token"))).toEqual([forced]);
		expectNoToken(hub, run);
	});

	it("tokens that outlast the cap: the step doesn't run, and the hub revokes as without it", async (ctx) => {
		const hub = await handover(ctx, { after: { expiresIn: 3600 } });
		const run = await child(deferred(hub, ...DRAFTING).slice(0, -2), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				refreshed: true,
				deferred: { ran: false },
				revoked: true,
				revocation: [200],
				afterRevoke: { refresh: { accepted: false, apiCode: "invalid_grant" } },
			},
		});
		const { dueInMs } = (run.result as Data).deferred;
		expect(dueInMs).toBeGreaterThan(3600_000);
		expect(dueInMs).toBeLessThanOrEqual(3600_000 + AFTER_EXPIRY_MS);
		expect(refreshForms(hub.auth)).toHaveLength(2);
		expectNoToken(hub, run);
	});

	it("a refresh after expiry refused as unusable is recorded, and the hub still revokes the newest refresh token it holds", async (ctx) => {
		const hub = await handover(ctx);
		endAfterForcedRefresh(hub.auth);
		const run = await child(deferred(hub, ...DRAFTING), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 1,
			result: {
				refreshed: true,
				deferred: {
					ran: true,
					refreshed: false,
					rotated: false,
					code: "REAUTH_REQUIRED",
					status: 400,
					apiCode: "invalid_grant",
					refresh: { status: 400, shape: { error: { code: "invalid_grant" } } },
					draft: { outcome: "error", code: "REAUTH_REQUIRED" },
				},
				revoked: true,
				revocation: [200],
				afterRevoke: { refresh: { accepted: false, apiCode: "invalid_grant" } },
			},
		});
		expect(run.result).not.toHaveProperty("code");
		const [, forced] = [...hub.auth.refresh.keys()];
		expect(hub.auth.refresh.size).toBe(2);
		expect(hub.auth.revocations.map((form) => form.get("token"))).toEqual([forced]);
		expectNoToken(hub, run);
	});

	it("a draft after expiry that fails is recorded, and the hub still revokes", async (ctx) => {
		let drafts = 0;
		const hub = await handover(ctx, {
			script: (request) =>
				++drafts === 1
					? answer(request)
					: structured(429, "subscription_sharing_usage_limit_exceeded"),
		});
		const run = await child(deferred(hub, ...DRAFTING), hub.text, ctx.signal);
		expect(run).toMatchObject({
			exitCode: 0,
			result: {
				draft: { outcome: "draft" },
				deferred: {
					ran: true,
					refreshed: true,
					rotated: true,
					refresh: { status: 200 },
					draft: { outcome: "error", code: "USAGE_LIMIT", status: 429 },
				},
				revoked: true,
			},
		});
		expect((run.result as Data).deferred).not.toHaveProperty("code");
		expectNoToken(hub, run);
	});

	it("--deferred takes whole minutes from 1 to 120, only with --live and --revoke; --after-expiry-ms only with it", async () => {
		const live = ["--live", "http://127.0.0.1:9"];
		const cases = [
			["--deferred", "1"],
			["--deferred", "1", ...live],
			["--deferred", "1", "--revoke"],
			["--revoke", ...live, "--deferred", "0"],
			["--revoke", ...live, "--deferred", "121"],
			["--revoke", ...live, "--deferred", "1.5"],
			["--revoke", ...live, "--after-expiry-ms", "300"],
		];
		const runs = await Promise.all(
			cases.map((args) => refused(["http://127.0.0.1:9", newHostId(), ...args])),
		);
		expect(runs.map((run) => run.exitCode)).toEqual(cases.map(() => 2));
		expect(runs[0]?.stderr).toContain("[--deferred <minutes> [--after-expiry-ms <ms>]]");
	});
});
