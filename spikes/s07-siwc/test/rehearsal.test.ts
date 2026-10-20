import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
	type EnvLiveOptions,
	type Fingerprint,
	fingerprint,
	freePort,
	saveEnvLive,
} from "@draftyak/spike-kit";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type TestContext,
	vi,
} from "vitest";
import { discover, newHostId, signIn } from "../src/auth.ts";
import {
	MODELS,
	type Received,
	type Reply,
	requestId,
	structured,
	toolEvents,
} from "./fake-responses.ts";
import {
	answer,
	endAfterForcedRefresh,
	MODEL,
	refreshAnswers,
	SAMPLE_DRAFT,
	shortLivedRefresh,
} from "./harness.ts";
import { DEFERRED_BUDGET_MS, DRAFT_TIMEOUT_MS, HUB_BUDGET_MS } from "./live-record.ts";
import {
	type ChildRunner,
	childTimeoutMs,
	deferredExtraMs,
	deferredMinutes,
	gate,
	liveTimeoutMs,
	type PortHold,
	runTransferChild,
} from "./live-session.ts";
import { keyModels, type Rehearsal, type RehearsalOptions, rehearsal } from "./rehearse.ts";
import { API_KEY, main, OPT_IN, readEntry, SAVED } from "./session-env.ts";

// The live procedure (test/live-session.ts) against M0.26's fakes on OS-assigned ports, with a
// temporary .env.live and evidence folder: the lines, the evidence's shape and content, the transfer
// and forget path, revocation and every way a session can end short. test/rehearsal.heavy.test.ts
// runs it once more on 127.0.0.1:1455 and puts its evidence through vendor-guard.

let print: Fingerprint;
beforeAll(async () => {
	print = await fingerprint({ sampleMs: 50 });
});

// Each rehearsal has its own fakes, .env.live and evidence folder, so they run side by side.
async function setUp(ctx: TestContext, options: RehearsalOptions = {}): Promise<Rehearsal> {
	const item = await rehearsal(options);
	ctx.onTestFinished(() => item.close());
	return item;
}

// biome-ignore lint/suspicious/noExplicitAny: evidence is read back as plain JSON
type Data = Record<string, any>;
const evidenceOf = (item: Rehearsal): Data =>
	(JSON.parse(item.evidenceText()) as { data: Data }).data;

// No token, ID, account detail or synthetic prompt or draft text is in the evidence, and every
// request ID in it is an HMAC.
function expectContentFree(item: Rehearsal): void {
	const text = item.evidenceText();
	expect(text).not.toBe("");
	expect(item.secrets().filter((secret) => text.includes(secret))).toEqual([]);
	const ids = [...text.matchAll(/"requestId": "([^"]*)"/g)].map((match) => match[1] ?? "");
	expect(ids.length).toBeGreaterThan(0);
	expect(ids.filter((id) => !/^hmac:[\w-]{22}$/.test(id))).toEqual([]);
}

// Tokens from an earlier sign-in at the same fake, left in .env.live as a run that died leaves them.
async function leaveTokens(item: Rehearsal): Promise<string> {
	const endpoints = await discover(item.auth.url);
	const earlier = await signIn({
		hostId: newHostId(),
		endpoints,
		port: 0,
		openBrowser: item.auth.browse,
	});
	const refreshToken = earlier.tokens?.refreshToken ?? "";
	saveEnvLive(SAVED.client, earlier.clientId, item.envLive);
	saveEnvLive(SAVED.refresh, refreshToken, item.envLive);
	saveEnvLive(SAVED.access, earlier.tokens?.accessToken ?? "", item.envLive);
	return refreshToken;
}

// A hub process that refuses the credential: it was signed in for another host ID.
const refusingHub: ChildRunner = (args, input, signal) =>
	runTransferChild([args[0] ?? "", newHostId(), ...args.slice(2)], input, signal);

const ALL_OK = [
	"signin: ok",
	"text.format: ok",
	"submit_draft: ok",
	"transfer: ok",
	"revoked: yes",
];
const notRun = (why: string): string[] =>
	["text.format", "submit_draft", "transfer"].map((name) => `${name}: not-run(${why})`);
// The loopback fakes' hosts fail the name rule, and only they.
const LOOPBACK_HOSTS = 6;
// A rehearsal starts its own fakes and child processes: about 9 s, but past 30 s on a loaded machine and
// past 80 s during a full parallel verify. Its sign-in may wait 90 s (rehearse.ts), so a slow one still ends
// as a readable signin: blocked(…) line before this limit.
const REHEARSAL = { timeout: 240_000 };

describe.concurrent("a whole session", REHEARSAL, () => {
	it("prints the five lines, keeps tokens only in .env.live, and the desktop forgets them before the hub revokes", async (ctx) => {
		const item = await setUp(ctx, { envLines: ["DY_LIVE_GMAIL_CLIENT_ID=unrelated-value"] });
		let whileDrafting = "";
		item.api.script = (request) => {
			if (request.path === "/v1/responses" && whileDrafting === "") whileDrafting = item.envText();
			return answer(request);
		};
		let atHandover = "";
		const runChild: ChildRunner = (args, input, signal) => {
			atHandover = item.envText();
			return runTransferChild(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		expect(result.revoked).toBe(true);

		const [signInAccess] = [...item.auth.access.keys()];
		expect(whileDrafting).toContain(`${SAVED.access}=${signInAccess}\n`);
		expect(whileDrafting).toMatch(new RegExp(`^${SAVED.client}=oaiapp_fake`, "m"));
		expect(atHandover).not.toMatch(/DY_LIVE_SIWC_/);
		expect(item.envText()).toBe("DY_LIVE_GMAIL_CLIENT_ID=unrelated-value\n");

		const grants = item.auth.tokenForms.map((form) => form.get("grant_type"));
		expect(grants).toEqual(["authorization_code", "refresh_token", "refresh_token"]);
		const [hubRefresh, retried] = item.auth.tokenForms.slice(1).map((f) => f.get("refresh_token"));
		const revoked = item.auth.revocations.map((form) => form.get("token"));
		expect(revoked).toHaveLength(1);
		expect(revoked[0]).not.toBe(hubRefresh);
		expect(retried).toBe(revoked[0]);
		expect(item.auth.refresh.get(revoked[0] ?? "")?.family.revoked).toBe(true);
		expect(item.auth.problems).toEqual(["token: refresh_token"]);
		const routes = item.api.received.map((request) => `${request.method} ${request.path}`);
		expect(routes).toEqual([
			"GET /v1/models",
			...Array(5).fill("POST /v1/responses"),
			"GET /v1/models",
		]);
		expect(item.api.problems).toEqual(["tools[0]"]);

		const data = evidenceOf(item);
		expect(data.lines).toEqual(ALL_OK);
		expect([data.run, data.port, data.withheld]).toEqual(["rehearsal", 0, LOOPBACK_HOSTS]);
		expect([data.issuerHost, data.apiHost]).toEqual(["(withheld)", "(withheld)"]);
		expect(data.signIn.planScope).toEqual({ name: "chatgpt.tokens.use.direct", granted: true });
		expect(data.signIn.planCheck).toBe("ok");
		expect(data.signIn.clientId).toEqual({ prefix: "oaiapp_", length: expect.any(Number) });
		expect(data.signIn.token).toMatchObject({
			tokenType: "Bearer",
			expiresIn: 3600,
			scopes: expect.arrayContaining(["chatgpt.tokens.use.direct", "offline_access"]),
			refreshToken: { format: "opaque", length: expect.any(Number) },
			idToken: {
				format: "jwt",
				alg: "RS256",
				claims: ["aud", "email", "exp", "iat", "iss", "nonce", "sub"],
				facts: {
					audHasClientId: true,
					audHasDynamicAgentClient: false,
					audHasResource: false,
					azpIsClientId: false,
					issIsIssuer: true,
				},
			},
		});
		expect(data.discovery.endpoints.revocation_endpoint).toMatchObject({
			sameOrigin: true,
			path: "/oauth/revoke",
		});
		expect(data.jwks).toEqual({ keys: 1, kty: ["RSA"], alg: ["RS256"], use: ["sig"] });
		expect(data.model).toEqual({ slug: "gpt-fake-plan", source: "models" });
		expect(data.models).toMatchObject({
			shape: "models",
			count: 2,
			listed: 1,
			listedSlugs: ["gpt-fake-plan"],
			chosen: "gpt-fake-plan",
		});
		const drafts = data.drafts.map((d: Data) => [d.structure, d.outcome, d.toolChoice]);
		expect(drafts).toEqual([
			["text-format", "draft", null],
			["tool-namespace", "draft", "required"],
			["tool-item", "draft", "required"],
			["tool-top-level", "error", "function:submit_draft"],
		]);
		const calls = data.drafts.map((d: Data) => d.events.completed?.functionCalls);
		const fields = ["arguments", "call_id", "id", "name", "status", "type"];
		expect(calls).toEqual([
			[],
			[{ name: "submit_draft", namespace: "draftyak", fields: [...fields, "namespace"].sort() }],
			[{ name: "submit_draft", namespace: "absent", fields }],
			undefined,
		]);
		expect(data.drafts[3].error).toMatchObject({
			code: "UNSUPPORTED_CAPABILITY",
			status: 400,
			apiCode: "subscription_sharing_unsupported_capability",
			param: "tools[0]",
		});
		for (const draft of data.drafts.slice(0, 3)) {
			expect(draft.draft).toMatchObject({ bodyChars: expect.any(Number), needsOwnerInput: 0 });
			expect(draft.events.deltas).toBeGreaterThan(1);
			expect(draft.events.completed).toMatchObject({ status: "completed", repeatsOutput: true });
			const [upstream] = draft.upstream;
			expect(upstream).toMatchObject({ method: "POST", path: "/v1/responses", status: 200 });
			expect(upstream.chunks.count).toBeGreaterThan(0);
			expect(upstream.chunks.bytes).toBe(
				upstream.chunks.sizes.reduce((sum: number, size: number) => sum + size, 0),
			);
			expect(upstream.values["content-type"]).toBe("text/event-stream; charset=utf-8");
		}
		expect(data.drafts[3].upstream[0].errorBody).toEqual({
			fields: ["error"],
			error: {
				fields: ["code", "message", "param", "type"],
				code: "subscription_sharing_unsupported_capability",
				type: "invalid_request_error",
				param: "tools[0]",
			},
		});
		expect(data.transfer).toMatchObject({
			exitCode: 0,
			result: true,
			desktopForgot: true,
			childStructure: "text-format",
			accepted: true,
			refreshed: true,
			rotated: true,
			planUsage: "enabled",
			draft: { outcome: "draft", via: "text" },
			refresh: { status: 200, shape: { refreshToken: { format: "opaque" } } },
			revoked: true,
			revocation: [200],
			afterRevoke: {
				refresh: {
					accepted: false,
					code: "REAUTH_REQUIRED",
					status: 400,
					apiCode: "invalid_grant",
				},
				models: { status: 401, code: "ADMISSION_REFUSED" },
				refreshShape: { error: { code: "invalid_grant" } },
			},
		});
		expect(data.revocation).toEqual({
			issued: true,
			orphan: null,
			accessOnly: false,
			transfer: "yes",
			fallback: null,
			deleted: [],
			remaining: [],
		});
		expect(data.apiKey).toEqual({ present: false });
		const brokered = data.brokered.map((r: Data) => [r.method, r.path, r.verdict, r.status]);
		expect(brokered).toEqual([
			["GET", "/v1/models", "ok", 200],
			...[200, 200, 200, 400].map((status) => ["POST", "/v1/responses", "ok", status]),
		]);
		expect(data.brokered[1].fields).toEqual([
			"input",
			"instructions",
			"model",
			"store",
			"stream",
			"text",
		]);
		expect(data.brokered[1].frames).toBeGreaterThan(0);
		expectContentFree(item);
		const said = item.said.join("\n");
		expect(said).toContain("copy the consent screen's wording");
		expect(said).toContain(`open this address: ${item.auth.url}/api/accounts/authorize?`);
		expect(said).toContain("Model: gpt-fake-plan (models).");
		const listedAt = item.said.indexOf("Listed models, in the server's order: gpt-fake-plan");
		expect(listedAt).toBeGreaterThan(-1);
		expect(listedAt).toBeLessThan(item.said.indexOf("Drafting with text-format."));
		expect(result.details).toEqual([
			"chatgpt.tokens.use.direct: granted; model gpt-fake-plan",
			"desktop drafts: text-format ok; tool-namespace ok; tool-item ok; tool-top-level unsupported (UNSUPPORTED_CAPABILITY:tools[0])",
			"hub process: accepted true, draft ok, refreshed true, revoked true",
			"after revocation: the refresh token is refused (invalid_grant); the access token gets 401",
			"api-key mode: not run (DY_LIVE_RESPONSES_API_KEY isn't set)",
			`${LOOPBACK_HOSTS} recorded values read (withheld): see evidence/live.json`,
		]);
	});

	it("records API-key mode's two drafts without the key, from the key's own model list", async (ctx) => {
		const item = await setUp(ctx, { apiKey: true });
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		const bearer = `Bearer ${item.apiKey}`;
		const withKey = item.api.received.filter((r) => r.headers.get("authorization") === bearer);
		expect(withKey.map((r) => [r.method, r.path, "text" in r.body, "tools" in r.body])).toEqual([
			["GET", "/v1/models", false, false],
			["POST", "/v1/responses", true, false],
			["POST", "/v1/responses", false, true],
		]);
		const data = evidenceOf(item);
		expect(data.apiKey).toMatchObject({
			present: true,
			model: { slug: "gpt-fake-plan", source: "plan" },
			models: { shape: "data", count: 2, fields: ["created", "id", "object", "owned_by"] },
		});
		expect(data.apiKey.drafts.map((d: Data) => [d.structure, d.outcome])).toEqual([
			["text-format", "draft"],
			["tool-namespace", "draft"],
		]);
		expect(result.details).toContain("api-key mode: text-format ok; tool-namespace ok");
		expect(item.said).toContain(
			"API-key mode: two drafts with gpt-fake-plan (plan), billed to the key.",
		);
		expect(item.envText()).toBe(`${API_KEY}=${item.apiKey}\n`);
		expectContentFree(item);
	});

	it("API-key mode takes the docs' example model when the key lists it and not the plan's", async (ctx) => {
		const item = await setUp(ctx, {
			apiKey: true,
			keyModels: keyModels(["gpt-6.1-sol", "gpt-x-pro"]),
		});
		const result = await item.run({ fingerprint: print });
		expect(evidenceOf(item).apiKey.model).toEqual({ slug: "gpt-6.1-sol", source: "docs example" });
		expect(result.details).toContain(
			"api-key mode: text-format fails(UNSUPPORTED_CAPABILITY:model); tool-namespace fails(UNSUPPORTED_CAPABILITY:model)",
		);
	});

	it("API-key mode never guesses a model: with neither listed it doesn't draft", async (ctx) => {
		const item = await setUp(ctx, {
			apiKey: true,
			keyModels: keyModels(["gpt-x-pro", "gpt-x-mini"]),
		});
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		expect(evidenceOf(item).apiKey).toMatchObject({ model: null, drafts: [] });
		const keyed = item.api.received.filter((r) =>
			r.headers.get("authorization")?.endsWith(item.apiKey ?? "-"),
		);
		expect(keyed.map((r) => r.path)).toEqual(["/v1/models"]);
		expect(result.details).toContain(
			"api-key mode: not run (no model: the key lists neither the plan's model nor gpt-6.1-sol; set DRAFTYAK_S7_API_MODEL)",
		);
	});

	it("API-key mode takes DRAFTYAK_S7_API_MODEL over the key's list", async (ctx) => {
		const item = await setUp(ctx, { apiKey: true, keyModels: keyModels(["gpt-x-pro"]) });
		await item.run({ fingerprint: print, env: { DRAFTYAK_S7_API_MODEL: "gpt-fake-plan" } });
		expect(evidenceOf(item).apiKey).toMatchObject({
			model: { slug: "gpt-fake-plan", source: "DRAFTYAK_S7_API_MODEL" },
			drafts: [{ outcome: "draft" }, { outcome: "draft" }],
		});
	});
});

describe.concurrent("drafts the route refuses", REHEARSAL, () => {
	it("text.format refused: submit_draft through the namespace, the hub drafts that way, a model override holds", async (ctx) => {
		const item = await setUp(ctx, {
			script: (request) =>
				"text" in request.body
					? structured(400, "subscription_sharing_unsupported_capability", "text.format")
					: answer(request),
		});
		const env = { DRAFTYAK_S7_MODEL: "gpt-fake-plan" };
		const result = await item.run({ fingerprint: print, env });
		expect(result.lines).toEqual([
			"signin: ok",
			"text.format: unsupported",
			"submit_draft: ok",
			"transfer: ok",
			"revoked: yes",
		]);
		const data = evidenceOf(item);
		expect(data.transfer).toMatchObject({
			childStructure: "tool-namespace",
			draft: { outcome: "draft", via: "tool" },
		});
		expect(data.model).toEqual({ slug: "gpt-fake-plan", source: "DRAFTYAK_S7_MODEL" });
	});

	it.for<[string, Reply, string]>([
		[
			"a refused model",
			structured(400, "subscription_sharing_unsupported_capability", "model"),
			"fails(UNSUPPORTED_CAPABILITY:model)",
		],
		[
			"a refused route",
			structured(403, "subscription_sharing_route_not_supported"),
			"fails(ROUTE_NOT_SUPPORTED)",
		],
		[
			"a usage limit",
			structured(429, "subscription_sharing_usage_limit_exceeded"),
			"fails(USAGE_LIMIT)",
		],
	])(
		"%s reads as a failed draft, not an unsupported structure",
		async ([, reply, verdict], ctx) => {
			const item = await setUp(ctx, { script: () => reply });
			const result = await item.run({ fingerprint: print });
			expect(result.lines).toEqual([
				"signin: ok",
				`text.format: ${verdict}`,
				`submit_draft: ${verdict}`,
				"transfer: ok",
				"revoked: yes",
			]);
			expect(result.details[1]).toBe(
				`desktop drafts: text-format ${verdict}; tool-namespace ${verdict}; tool-item ${verdict}; tool-top-level unsupported (UNSUPPORTED_CAPABILITY:tools[0])`,
			);
		},
	);

	it("a namespaced call that comes back under another name reads fails(invalid), and the evidence names it", async (ctx) => {
		const args = JSON.stringify(SAMPLE_DRAFT);
		const inNamespace = (request: Received): boolean =>
			Array.isArray(request.body.tools) &&
			request.body.tools.some((tool) => (tool as { type?: unknown }).type === "namespace");
		const qualified = toolEvents(MODEL, args, undefined, "draftyak.submit_draft");
		const item = await setUp(ctx, {
			script: (request) =>
				inNamespace(request) ? { kind: "events", events: qualified } : answer(request),
		});
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		expect(result.details[1]).toBe(
			"desktop drafts: text-format ok; tool-namespace fails(invalid); tool-item ok; tool-top-level unsupported (UNSUPPORTED_CAPABILITY:tools[0])",
		);
		const namespaced = evidenceOf(item).drafts[1];
		expect(namespaced).toMatchObject({
			structure: "tool-namespace",
			outcome: "invalid",
			problems: ["output: unexpected tool call"],
		});
		expect(namespaced.events.completed.functionCalls).toEqual([
			{
				name: "draftyak.submit_draft",
				namespace: "absent",
				fields: ["arguments", "call_id", "id", "name", "status", "type"],
			},
		]);
		expectContentFree(item);
	});

	it("a refused model: the run prints the plan's listed models in the server's order before drafting, and records them", async (ctx) => {
		const retired = { slug: "gpt-fake-retired", display_name: "Retired", visibility: "list" };
		let lists = 0;
		const item = await setUp(ctx, {
			intercept: ({ url }) =>
				url.pathname === "/v1/models" && ++lists === 1
					? Response.json(
							{ models: [retired, ...MODELS] },
							{ headers: { "x-request-id": requestId() } },
						)
					: undefined,
		});
		const result = await item.run({ fingerprint: print });
		expect(result.lines.slice(1, 3)).toEqual([
			"text.format: fails(UNSUPPORTED_CAPABILITY:model)",
			"submit_draft: fails(UNSUPPORTED_CAPABILITY:model)",
		]);
		const line = "Listed models, in the server's order: gpt-fake-retired, gpt-fake-plan";
		expect(item.said.indexOf(line)).toBeGreaterThan(-1);
		expect(item.said.indexOf(line)).toBeLessThan(item.said.indexOf("Drafting with text-format."));
		expect(item.said).toContain("Model: gpt-fake-retired (models).");
		expect(evidenceOf(item).models).toMatchObject({
			count: 3,
			listed: 2,
			listedSlugs: ["gpt-fake-retired", "gpt-fake-plan"],
			chosen: "gpt-fake-retired",
		});
	});
});

describe.concurrent("sessions that end short", REHEARSAL, () => {
	it("a declined consent blocks the sign-in; nothing else runs and nothing needs revoking", async (ctx) => {
		const item = await setUp(ctx, { auth: { consent: "decline" } });
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual([
			"signin: blocked(SIGN_IN_FAILED:access_denied)",
			...notRun("signin blocked"),
			"revoked: yes",
		]);
		expect([item.auth.tokenForms, item.api.received]).toEqual([[], []]);
		const data = evidenceOf(item);
		expect(data.signIn.attempts).toEqual([
			{
				outcome: "error",
				registration: "new",
				ms: expect.any(Number),
				error: expect.objectContaining({ code: "SIGN_IN_FAILED", apiCode: "access_denied" }),
			},
		]);
		expect(data.revocation).toMatchObject({ issued: false, orphan: null, transfer: null });
	});

	it("without plan usage nothing drafts, and the hub still takes the session over and revokes it", async (ctx) => {
		const item = await setUp(ctx, { auth: { consent: "no-plan" } });
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual([
			"signin: ok",
			"text.format: not-run(plan usage off)",
			"submit_draft: not-run(plan usage off)",
			"transfer: ok",
			"revoked: yes",
		]);
		expect(item.api.received.map((request) => request.path)).toEqual(["/v1/models"]);
		const data = evidenceOf(item);
		expect(data.signIn.planScope.granted).toBe(false);
		expect(data.signIn.planCheck).toBe("PLAN_USAGE_DISABLED");
		expect(data.brokered).toEqual([]);
		expect(data.transfer).toMatchObject({ draft: null, planUsage: "disabled", revoked: true });
		expect(result.details[0]).toBe("chatgpt.tokens.use.direct: missing; model none");
	});

	it("a sign-in that issued no refresh token can't be revoked, and says so", async (ctx) => {
		const item = await setUp(ctx, { auth: { consent: "identity-only" } });
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual([
			"signin: ok",
			...notRun("no refresh token"),
			"revoked: no(no refresh token; remove DraftYak in ChatGPT)",
		]);
		expect(result.revoked).toBe(false);
		expect([item.auth.access.size, item.auth.revocations.length]).toEqual([1, 0]);
		expect(evidenceOf(item).revocation).toMatchObject({ issued: true, accessOnly: true });
	});

	it("after invalid_grant the second sign-in reuses the client issued to the first", async (ctx) => {
		const item = await setUp(ctx, { auth: { codeErrors: ["invalid_grant"] } });
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		const [first, second] = item.auth.authorizations;
		const [issued] = [...item.auth.clients.keys()];
		expect(first?.get("client_id")).toBe("dynamic_agent_client");
		expect([second?.get("client_id"), second?.has("agent_name_hint")]).toEqual([issued, false]);
		expect(item.auth.clients.size).toBe(1);
		const attempts = evidenceOf(item).signIn.attempts;
		expect(attempts.map((a: Data) => [a.outcome, a.registration, a.error?.apiCode])).toEqual([
			["error", "new", "invalid_grant"],
			["ok", "issued-client", undefined],
		]);
		expect(item.said.join("\n")).toContain("invalid_grant");
	});

	it("an ID token the spike refuses still has its tokens revoked, and the revocation checked", async (ctx) => {
		const item = await setUp(ctx, {
			auth: { idClaims: (claims) => ({ ...claims, aud: "another" }) },
		});
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual([
			"signin: blocked(ID_TOKEN_INVALID:audience)",
			...notRun("signin blocked"),
			"revoked: yes",
		]);
		const [issued] = [...item.auth.refresh.values()];
		expect(issued?.family.revoked).toBe(true);
		const data = evidenceOf(item);
		expect(data.revocation.orphan).toEqual({
			revoked: true,
			probe: { accepted: false, code: "REAUTH_REQUIRED", status: 400, apiCode: "invalid_grant" },
			verdict: "yes",
		});
		expect(data.signIn.token.idToken.facts).toEqual({
			audHasClientId: false,
			audHasDynamicAgentClient: false,
			audHasResource: false,
			azpIsClientId: false,
			issIsIssuer: true,
		});
		expect(result.details).toContain("the code exchange's tokens: revoked yes");
		expectContentFree(item);
	});

	it.for<
		[
			string,
			(claims: Record<string, unknown>) => Record<string, unknown>,
			string,
			Record<string, boolean>,
		]
	>([
		[
			"two audiences and no azp",
			(claims) => ({ ...claims, aud: [claims.aud, "https://api.openai.com/v1"] }),
			"authorized party",
			{
				audHasClientId: true,
				audHasDynamicAgentClient: false,
				audHasResource: true,
				azpIsClientId: false,
				issIsIssuer: true,
			},
		],
		[
			"dynamic_agent_client as its audience",
			(claims) => ({ ...claims, aud: "dynamic_agent_client", azp: claims.aud }),
			"audience",
			{
				audHasClientId: false,
				audHasDynamicAgentClient: true,
				audHasResource: false,
				azpIsClientId: true,
				issIsIssuer: true,
			},
		],
		[
			"another issuer",
			(claims) => ({ ...claims, iss: "https://elsewhere.invalid" }),
			"issuer",
			{
				audHasClientId: true,
				audHasDynamicAgentClient: false,
				audHasResource: false,
				azpIsClientId: false,
				issIsIssuer: false,
			},
		],
	])(
		"an ID token with %s is refused, and the evidence says why in yes/no facts",
		async ([, idClaims, reason, facts], ctx) => {
			const item = await setUp(ctx, { auth: { idClaims } });
			const result = await item.run({ fingerprint: print });
			expect(result.lines[0]).toBe(`signin: blocked(ID_TOKEN_INVALID:${reason})`);
			expect(evidenceOf(item).signIn.token.idToken.facts).toEqual(facts);
			expectContentFree(item);
		},
	);

	it("tokens an earlier run left in .env.live are revoked and checked before the sign-in", async (ctx) => {
		const item = await setUp(ctx);
		const earlier = await leaveTokens(item);
		const result = await item.run({ fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		expect(item.auth.refresh.get(earlier)?.family.revoked).toBe(true);
		expect(evidenceOf(item).leftovers).toEqual({
			found: true,
			revoked: true,
			probe: { accepted: false, code: "REAUTH_REQUIRED", status: 400, apiCode: "invalid_grant" },
		});
		expect(result.details).toContain(
			"an earlier run's tokens: revoked, and refused when tried again",
		);
		expect(item.envText()).toBe("");
		expectContentFree(item);
	});

	it("an earlier run's tokens whose revocation isn't confirmed stay, and the run stops before signing in", async (ctx) => {
		const item = await setUp(ctx, { auth: { revocationStatuses: [400] } });
		const earlier = await leaveTokens(item);
		const left = item.envText();
		await expect(item.run({ fingerprint: print })).rejects.toMatchObject({
			name: "SessionStopped",
			code: "LEFTOVER_TOKENS",
			message: expect.stringContaining("weren't revoked: no(revocation unconfirmed)"),
		});
		expect(item.envText()).toBe(left);
		expect(item.auth.refresh.get(earlier)?.family.revoked).toBe(false);
		expect([item.auth.authorizations.length, existsSync(item.evidenceFile)]).toEqual([1, false]);
	});

	it("an issuer that doesn't answer stops the run with nothing written, an earlier run's tokens kept", async (ctx) => {
		const item = await setUp(ctx);
		await leaveTokens(item);
		const left = item.envText();
		const issuer = `http://127.0.0.1:${await freePort()}`;
		await expect(item.run({ issuer })).rejects.toMatchObject({
			code: "UNREACHABLE",
			message: expect.stringContaining("stay for that run"),
		});
		expect(existsSync(item.evidenceFile)).toBe(false);
		expect(item.envText()).toBe(left);
		expect(item.auth.revocations).toEqual([]);
	});

	it("a stop request ends a waiting sign-in as blocked(stopped)", async (ctx) => {
		const item = await setUp(ctx);
		const result = await item.run({
			fingerprint: print,
			openBrowser: () => saveEnvLive(OPT_IN, "stop", item.envLive),
		});
		expect(result.lines).toEqual([
			"signin: blocked(stopped)",
			...notRun("signin blocked"),
			"revoked: yes",
		]);
		expect(item.auth.authorizations).toEqual([]);
		expect(item.envText()).toBe("");
	});

	// A lock that waits until the stop aborts it, and one granted at once, before the poller looks.
	it.for<[string, boolean]>([
		["ends the wait for the port's lock", true],
		["is read again once the lock is held", false],
	])("a stop request during the lock wait %s; no browser opens", async ([, honoursSignal], ctx) => {
		const item = await setUp(ctx);
		let opened = 0;
		const holdPort = async (signal: AbortSignal): Promise<PortHold> => {
			saveEnvLive(OPT_IN, "stop", item.envLive);
			if (honoursSignal) await sleep(10_000, undefined, { signal });
			return { waitedMs: 0, release: () => {} };
		};
		const result = await item.run({
			fingerprint: print,
			holdPort,
			openBrowser: () => {
				opened++;
			},
		});
		expect(result.lines[0]).toBe("signin: blocked(stopped)");
		expect([opened, item.auth.authorizations.length]).toEqual([0, 0]);
		const data = evidenceOf(item);
		expect(data.signIn.attempts).toEqual([
			{ outcome: "stopped", registration: "new", ms: expect.any(Number) },
		]);
		expect(data.lock).toEqual(honoursSignal ? null : { waitedMs: 0, idle: null });
	});

	it("a port another program holds stops the run before any browser opens, with nothing written", async (ctx) => {
		const item = await setUp(ctx);
		const holder: Server = createServer((socket) => socket.destroy());
		await new Promise<void>((resolve) => holder.listen({ host: "127.0.0.1", port: 0 }, resolve));
		try {
			const port = (holder.address() as { port: number }).port;
			let opened = false;
			const openBrowser = (): void => {
				opened = true;
			};
			const run = item.run({ port, openBrowser });
			await expect(run).rejects.toMatchObject({ name: "SessionStopped", code: "PORT_IN_USE" });
			expect([opened, existsSync(item.evidenceFile), item.auth.authorizations]).toEqual([
				false,
				false,
				[],
			]);
		} finally {
			await new Promise((resolve) => holder.close(resolve));
		}
	});
});

describe.concurrent("the transfer and the revocation check", REHEARSAL, () => {
	it("a hub that refuses the credential: the transfer fails and this process revokes the session", async (ctx) => {
		const item = await setUp(ctx);
		const result = await item.run({ runChild: refusingHub, fingerprint: print });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(TRANSFER_REFUSED:hostId)",
			"revoked: yes",
		]);
		const [signInRefresh] = [...item.auth.refresh.keys()];
		expect(item.auth.revocations.map((form) => form.get("token"))).toEqual([signInRefresh]);
		expect(evidenceOf(item).revocation).toMatchObject({
			transfer: "yes",
			fallback: {
				revoked: true,
				after: { refresh: { accepted: false, apiCode: "invalid_grant" } },
			},
		});
	});

	it("a revocation answered 200 that revoked nothing: the revoked refresh token still works", async (ctx) => {
		const item = await setUp(ctx, {
			intercept: ({ url }) =>
				url.pathname === "/oauth/revoke" ? new Response(null, { status: 200 }) : undefined,
		});
		const result = await item.run({ runChild: refusingHub, fingerprint: print });
		expect(result.lines.at(-1)).toBe("revoked: no(the revoked refresh token still works)");
		expect(result.revoked).toBe(false);
		expect(evidenceOf(item).revocation.fallback).toMatchObject({
			revoked: true,
			after: { refresh: { accepted: true, revokedAgain: true }, models: { status: 200 } },
		});
		expect(result.details).toContain(
			"after revocation: the refresh token is still accepted; the access token gets 200",
		);
	});

	it.for<[string, () => Response, string]>([
		[
			"a 503",
			() => Response.json({ error: "temporarily_unavailable" }, { status: 503 }),
			"UNAVAILABLE:temporarily_unavailable",
		],
		["a 429", () => new Response(null, { status: 429 }), "UNAVAILABLE"],
		[
			"a dropped connection",
			() => {
				throw new TypeError("fetch failed");
			},
			"UNAVAILABLE",
		],
		[
			"a 200 without tokens",
			() => Response.json({ token_type: "Bearer" }, { status: 200 }),
			"SIGN_IN_FAILED",
		],
	])(
		"a 200 that revoked nothing, then %s when the token is tried again: unconfirmed",
		async ([, fail, probe], ctx) => {
			const item = await setUp(ctx, {
				intercept: ({ url, form }) => {
					if (url.pathname === "/oauth/revoke") return new Response(null, { status: 200 });
					return form.get("grant_type") === "refresh_token" ? fail() : undefined;
				},
			});
			const result = await item.run({ runChild: refusingHub, fingerprint: print });
			expect(result.lines.at(-1)).toBe(`revoked: no(revocation unconfirmed: probe ${probe})`);
			const [live] = [...item.auth.refresh.values()];
			expect(live?.family.revoked).toBe(false);
		},
	);

	it("a revocation OpenAI doesn't confirm makes the revoked line say no", async (ctx) => {
		const item = await setUp(ctx, { auth: { revocationStatuses: [400] } });
		const result = await item.run({ fingerprint: print });
		expect(result.lines.at(-1)).toBe("revoked: no(revocation unconfirmed)");
		expect(result.revoked).toBe(false);
		expect(evidenceOf(item).transfer).toMatchObject({
			revoked: false,
			revocation: [400],
			afterRevoke: { refresh: { accepted: true, revokedAgain: true } },
		});
	});

	it("a hub process that ends without a result after its refresh: never yes, whatever the check says", async (ctx) => {
		const item = await setUp(ctx);
		const runChild: ChildRunner = async (args, input, signal) => {
			await runTransferChild(
				args.filter((arg) => arg !== "--revoke"),
				input,
				signal,
			);
			return { exitCode: -1, output: undefined, stderr: "" };
		};
		const result = await item.run({ runChild, fingerprint: print });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(exit -1)",
			"revoked: no(hub process ended without a result)",
		]);
		const data = evidenceOf(item);
		expect(data.transfer).toMatchObject({ result: false, accepted: false });
		expect(data.revocation).toMatchObject({
			transfer: "no(hub process ended without a result)",
			fallback: { revoked: true },
		});
		expect(item.said.join("\n")).toContain("the hub process may have refreshed it first");
	});

	it("a hub that took the session but couldn't discover the issuer: this process revokes its copy", async (ctx) => {
		let discoveries = 0;
		const item = await setUp(ctx, {
			auth: {
				discovery: (doc) =>
					++discoveries === 2 ? { ...doc, issuer: "https://elsewhere.invalid" } : doc,
			},
		});
		const result = await item.run({ fingerprint: print });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(SIGN_IN_FAILED:discovery: issuer)",
			"revoked: yes",
		]);
		const [signInRefresh] = [...item.auth.refresh.keys()];
		expect(item.auth.revocations.map((form) => form.get("token"))).toEqual([signInRefresh]);
		expect(evidenceOf(item).transfer).toMatchObject({
			accepted: true,
			refreshed: false,
			refresh: null,
			revoked: null,
		});
		expect(result.details).toContain(
			"hub process: accepted true, refreshed false, revoked null; this process revoked its copy",
		);
	});

	it("a hub draft that fails while the desktop's worked fails the transfer", async (ctx) => {
		let drafted = 0;
		const item = await setUp(ctx, {
			script: (request) =>
				++drafted <= 3
					? answer(request)
					: structured(429, "subscription_sharing_usage_limit_exceeded"),
		});
		const result = await item.run({ fingerprint: print });
		expect(result.lines.slice(3)).toEqual(["transfer: fails(draft:USAGE_LIMIT)", "revoked: yes"]);
		expect(evidenceOf(item).transfer.draft).toMatchObject({
			outcome: "error",
			code: "USAGE_LIMIT",
		});
	});

	it("a hub refresh refused as unusable: the hub still revokes the tokens it was given", async (ctx) => {
		const item = await setUp(ctx);
		let handed = "";
		const runChild: ChildRunner = async (args, input, signal) => {
			// The session ends elsewhere first (the owner removes DraftYak, say).
			const { credential } = JSON.parse(input);
			handed = credential.tokens.refreshToken;
			const form = new URLSearchParams({
				token: handed,
				token_type_hint: "refresh_token",
				client_id: credential.clientId,
			});
			await fetch(`${item.auth.url}/oauth/revoke`, { method: "POST", body: form });
			return runTransferChild(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(draft:ADMISSION_REFUSED)",
			"revoked: yes",
		]);
		expect(item.auth.revocations.map((form) => form.get("token"))).toEqual([handed, handed]);
		expect(evidenceOf(item).transfer).toMatchObject({
			refreshed: false,
			code: "REAUTH_REQUIRED",
			apiCode: "invalid_grant",
			revoked: true,
			revocation: [200],
			afterRevoke: { refresh: { accepted: false, apiCode: "invalid_grant" } },
		});
	});

	it("a hub refresh refused as reused: another holder refreshed first, so revocation is unconfirmed", async (ctx) => {
		const item = await setUp(ctx);
		const runChild: ChildRunner = async (args, input, signal) => {
			const { credential } = JSON.parse(input);
			const form = new URLSearchParams({
				grant_type: "refresh_token",
				client_id: credential.clientId,
				refresh_token: credential.tokens.refreshToken,
				resource: "https://api.openai.com/v1",
			});
			await fetch(`${item.auth.url}/api/accounts/oauth/token`, { method: "POST", body: form });
			return runTransferChild(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(refresh:REAUTH_REQUIRED)",
			"revoked: no(revocation unconfirmed: refresh_token_reused)",
		]);
		expect(evidenceOf(item).transfer).toMatchObject({
			draft: { outcome: "draft" },
			apiCode: "refresh_token_reused",
			revoked: true,
		});
	});

	it("an entry left in .env.live after the cleanup makes the revoked line say no", async (ctx) => {
		const item = await setUp(ctx);
		const result = await item.run({
			fingerprint: print,
			say: (text) => {
				item.said.push(text);
				if (text.startsWith(".env.live: ")) saveEnvLive(OPT_IN, "stop", item.envLive);
			},
		});
		expect(result.lines.at(-1)).toBe("revoked: no(entries left in .env.live)");
		expect(evidenceOf(item).revocation.remaining).toEqual([OPT_IN]);
	});

	it("a failure after the handover revokes the session and says how that went", async (ctx) => {
		const item = await setUp(ctx);
		const runChild: ChildRunner = () => Promise.reject(new Error("the hub process didn't start"));
		await expect(item.run({ runChild, fingerprint: print })).rejects.toThrow(
			"the hub process didn't start",
		);
		const [signInRefresh] = [...item.auth.refresh.keys()];
		expect(item.auth.refresh.get(signInRefresh ?? "")?.family.revoked).toBe(true);
		expect(item.envText()).not.toMatch(/DY_LIVE_SIWC_/);
		expect(item.said).toContain(
			"After the failure, the tokens handed to the hub process: revoked no(the hub process may have refreshed them).",
		);
		expect(existsSync(item.evidenceFile)).toBe(false);
	});

	it.for<[string, number[], string, boolean]>([
		["deletes them once that is confirmed", [], "yes", false],
		["keeps them for the next run when it isn't", [400], "no(revocation unconfirmed)", true],
	])(
		"a run stopped while .env.live holds its tokens revokes them there and %s",
		async ([, statuses, verdict, kept], ctx) => {
			const item = await setUp(ctx, { auth: { revocationStatuses: statuses } });
			const stop = new AbortController();
			item.api.script = (request) => {
				stop.abort(new Error("the run was stopped"));
				return answer(request);
			};
			await expect(item.run({ fingerprint: print, signal: stop.signal })).rejects.toThrow(
				"the run was stopped",
			);
			const [signInRefresh] = [...item.auth.refresh.keys()];
			expect(item.auth.revocations.map((form) => form.get("token"))).toEqual([signInRefresh]);
			expect(item.said).toContain(
				`After the failure, the tokens in .env.live: revoked ${verdict}.`,
			);
			expect(item.envText().includes(`${SAVED.refresh}=${signInRefresh}`)).toBe(kept);
			expect(existsSync(item.evidenceFile)).toBe(false);
		},
	);
});

// The step after expiry: the hub's forced refresh gets tokens that last 3 s, so its access token
// expires within seconds (the refresh after expiry gets an hour again), and the hub drafts again
// AFTER_EXPIRY_TEST_MS after that expiry (--after-expiry-ms, which only a test passes).
const AFTER_EXPIRY_TEST_MS = 500;
const shortLived =
	(item: Rehearsal): ChildRunner =>
	(args, input, signal) => {
		shortLivedRefresh(item.auth, 3);
		const shortened = [...args, "--after-expiry-ms", String(AFTER_EXPIRY_TEST_MS)];
		return runTransferChild(shortened, input, signal);
	};

const exec = promisify(execFile);
const GUARD = path.resolve(import.meta.dirname, "../../../tools/vendor-guard/src/cli.ts");
// git acts on the throwaway repository, not on one a hook or `rebase -x` exported.
const gitEnv = (): NodeJS.ProcessEnv =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|PREFIX)$/i.test(key),
		),
	);

// A throwaway repository for a rehearsal's evidence, as test/rehearsal.heavy.test.ts makes one, and
// vendor-guard's answer on it as `pnpm guard` runs it.
async function guarded(ctx: TestContext): Promise<{ root: string; guard(): Promise<unknown> }> {
	const root = mkdtempSync(path.join(os.tmpdir(), "draftyak-s07-guard-"));
	ctx.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const env = gitEnv();
	await exec("git", ["-c", "init.defaultBranch=main", "init", "-q", root], { env });
	await exec("git", ["-C", root, "config", "maintenance.auto", "false"], { env });
	const guard = async (): Promise<unknown> => {
		const found = await exec(process.execPath, [GUARD, "--json"], { cwd: root, env }).catch(
			(error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
		);
		return JSON.parse(found.stdout);
	};
	return { root, guard };
}

describe.concurrent("the step after expiry (DRAFTYAK_S7_DEFERRED_MIN)", REHEARSAL, () => {
	it("the hub refreshes on the product path only after its access token has expired, drafts and revokes; the evidence holds the step and no token", async (ctx) => {
		const { root, guard } = await guarded(ctx);
		const item = await setUp(ctx, { root });
		// The hub waits without the machine-wide lock (and port 1455: test/port.heavy.test.ts).
		let locked = false;
		let lockedWhileHubRuns: boolean | undefined;
		let saidBeforeHub: string[] = [];
		const hub = shortLived(item);
		// The limit the run sets just before it starts the hub. The spy's own calls won't do: Vitest
		// clears them whenever another test starts.
		let latest: number | undefined;
		let hubLimit: number | undefined;
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			latest = ms;
			return timeout(ms);
		});
		ctx.onTestFinished(() => spy.mockRestore());
		const result = await item.run({
			holdPort: async () => {
				locked = true;
				return {
					waitedMs: 0,
					release: () => {
						locked = false;
					},
				};
			},
			runChild: (args, input, signal) => {
				hubLimit = latest;
				lockedWhileHubRuns = locked;
				saidBeforeHub = [...item.said];
				return hub(args, input, signal);
			},
			fingerprint: print,
			env: { DRAFTYAK_S7_DEFERRED_MIN: "70" },
		});
		expect(result.lines).toEqual(ALL_OK);
		expect(lockedWhileHubRuns).toBe(false);
		// The hub's limit grows by the cap and the step's own requests.
		expect(hubLimit).toBe(childTimeoutMs(70));
		const data = evidenceOf(item);
		const step = data.transfer.deferred;
		expect(step).toMatchObject({
			ran: true,
			refreshed: true,
			rotated: true,
			refresh: { status: 200, shape: { expiresIn: 3600, refreshToken: { format: "opaque" } } },
			draft: { outcome: "draft", via: "text" },
		});
		expect(data.transfer.refresh).toMatchObject({ status: 200, shape: { expiresIn: 3 } });
		expect(Object.keys(step).sort()).toEqual([
			"draft",
			"idleMs",
			"msAfterExpiry",
			"ran",
			"refresh",
			"refreshed",
			"rotated",
		]);
		expect(step.msAfterExpiry).toBeGreaterThanOrEqual(AFTER_EXPIRY_TEST_MS);
		expect(step.idleMs).toBeGreaterThanOrEqual(3_000 + AFTER_EXPIRY_TEST_MS);
		// The desktop never refreshed; the hub did once when forced and once after expiry, then the
		// revoked refresh token was tried again.
		const grants = item.auth.tokenForms.map((form) => form.get("grant_type"));
		expect(grants).toEqual([
			"authorization_code",
			"refresh_token",
			"refresh_token",
			"refresh_token",
		]);
		const seconds = Math.round(step.msAfterExpiry / 1000);
		const after = `refreshed true (rotated true, ${seconds} s after expiry, idle 0 min), draft ok`;
		expect(result.details.slice(2, 5)).toEqual([
			"hub process: accepted true, draft ok, refreshed true, revoked true",
			`after expiry: ${after}`,
			"after revocation: the refresh token is refused (invalid_grant); the access token gets 401",
		]);
		// The expected wait is said before the hub starts, the outcome once it has ended.
		expect(saidBeforeHub).toContain(
			"After expiry: the hub process keeps the session until 3 minutes after its access token expires, about 63 minutes (the tokens last 60 minutes; the cap is 70), then drafts once more, refreshing first, and revokes it. Nothing to do meanwhile: keep this PC on mains power and awake.",
		);
		expect(item.said).toContain(`The hub process has ended. After expiry: ${after}.`);
		expect(data.withheld).toBe(LOOPBACK_HOSTS);
		expectContentFree(item);
		expect(await guard()).toEqual({ findings: [], files: 1, commits: null });
	});

	it("tokens that outlast the cap: the step doesn't run, and the session ends as without it", async (ctx) => {
		const item = await setUp(ctx);
		const result = await item.run({ fingerprint: print, deferredMinutes: 1 });
		expect(result.lines).toEqual(ALL_OK);
		const step = evidenceOf(item).transfer.deferred;
		expect(step).toEqual({ ran: false, dueInMs: expect.any(Number) });
		expect(step.dueInMs).toBeGreaterThan(62 * 60_000);
		const grants = item.auth.tokenForms.map((form) => form.get("grant_type"));
		expect(grants).toEqual(["authorization_code", "refresh_token", "refresh_token"]);
		const skipped = "not run (due in 63 min, over the 1-minute cap)";
		expect(result.details).toContain(`after expiry: ${skipped}`);
		expect(item.said).toContain(
			"After expiry: the tokens last 60 minutes, so the hub process would wait about 63 minutes, past the 1-minute cap. It revokes the session without that step.",
		);
		expect(item.said).toContain(`The hub process has ended. After expiry: ${skipped}.`);
		expectContentFree(item);
	});

	it("a refresh after expiry refused as unusable fails the transfer; the hub still revokes the newest tokens it holds", async (ctx) => {
		const item = await setUp(ctx);
		const hub = shortLived(item);
		const runChild: ChildRunner = (args, input, signal) => {
			endAfterForcedRefresh(item.auth);
			return hub(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print, deferredMinutes: 70 });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(deferred-refresh:REAUTH_REQUIRED)",
			"revoked: yes",
		]);
		expect(evidenceOf(item).transfer).toMatchObject({
			exitCode: 1,
			refreshed: true,
			code: null,
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
		});
		const forced = [...item.auth.refresh.keys()].at(-1);
		expect(item.auth.revocations.map((form) => form.get("token"))).toEqual([forced]);
		expect(result.details).toContainEqual(
			expect.stringMatching(
				/^after expiry: refreshed false \(rotated false, \d+ s after expiry, idle 0 min\), draft REAUTH_REQUIRED$/,
			),
		);
		expectContentFree(item);
	});

	it("a refused refresh after expiry is the transfer's verdict even when the hub's first draft failed", async (ctx) => {
		let drafted = 0;
		const item = await setUp(ctx, {
			script: (request) =>
				++drafted === 4
					? structured(429, "subscription_sharing_usage_limit_exceeded")
					: answer(request),
		});
		const hub = shortLived(item);
		const runChild: ChildRunner = (args, input, signal) => {
			endAfterForcedRefresh(item.auth);
			return hub(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print, deferredMinutes: 70 });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(deferred-refresh:REAUTH_REQUIRED)",
			"revoked: yes",
		]);
		expect(evidenceOf(item).transfer).toMatchObject({
			draft: { outcome: "error", code: "USAGE_LIMIT" },
			deferred: { ran: true, refreshed: false, code: "REAUTH_REQUIRED" },
		});
		expectContentFree(item);
	});

	it("a refresh after expiry refused as reused: another holder refreshed first, so revocation is unconfirmed", async (ctx) => {
		const item = await setUp(ctx);
		const hub = shortLived(item);
		const runChild: ChildRunner = (args, input, signal) => {
			// Another holder uses the forced refresh's refresh token during the wait.
			refreshAnswers(item.auth, (body, n) => {
				const held = n === 1 ? item.auth.refresh.get(String(body.refresh_token)) : undefined;
				if (held) held.used = true;
				return body;
			});
			return hub(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print, deferredMinutes: 70 });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(deferred-refresh:REAUTH_REQUIRED)",
			"revoked: no(revocation unconfirmed: refresh_token_reused)",
		]);
		expect(evidenceOf(item).transfer).toMatchObject({
			refreshed: true,
			deferred: {
				ran: true,
				refreshed: false,
				code: "REAUTH_REQUIRED",
				status: 400,
				apiCode: "refresh_token_reused",
			},
			revoked: true,
			afterRevoke: { refresh: { accepted: false, apiCode: "invalid_grant" } },
		});
		expectContentFree(item);
	});

	it("a refresh after expiry answered 200 with tokens the hub can't keep: revocation unconfirmed", async (ctx) => {
		const item = await setUp(ctx);
		const hub = shortLived(item);
		const runChild: ChildRunner = (args, input, signal) => {
			// The answer after expiry lacks token_type, so the session refuses it as incomplete.
			refreshAnswers(item.auth, (body, n) => {
				if (n !== 2) return body;
				const { token_type: _dropped, ...kept } = body;
				return kept;
			});
			return hub(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print, deferredMinutes: 70 });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(deferred-refresh:SIGN_IN_FAILED)",
			"revoked: no(revocation unconfirmed: the hub's refresh after expiry was answered but not kept)",
		]);
		expect(evidenceOf(item).transfer).toMatchObject({
			deferred: {
				ran: true,
				refreshed: false,
				code: "SIGN_IN_FAILED",
				detail: "token response incomplete",
				refresh: { status: 200, shape: { refreshToken: { format: "opaque" } } },
			},
			revoked: true,
		});
		expectContentFree(item);
	});

	it("a refresh after expiry that got no answer: revocation unconfirmed", async (ctx) => {
		const item = await setUp(ctx);
		const hub = shortLived(item);
		// The hub's record, edited as it reads when the refresh after expiry got no answer.
		const runChild: ChildRunner = async (args, input, signal) => {
			const run = await hub(args, input, signal);
			Object.assign((run.output as Data).deferred, {
				refreshed: false,
				rotated: false,
				refresh: { status: 0, ms: 0 },
				draft: { outcome: "error", ms: 0, deltas: 0, code: "UNAVAILABLE" },
				code: "UNAVAILABLE",
				detail: "token endpoint unreachable",
			});
			return run;
		};
		const result = await item.run({ runChild, fingerprint: print, deferredMinutes: 70 });
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(deferred-refresh:UNAVAILABLE)",
			"revoked: no(revocation unconfirmed: the hub's refresh after expiry got no answer)",
		]);
		expectContentFree(item);
	});

	it("a draft after expiry that fails while the hub's first worked fails the transfer", async (ctx) => {
		let drafted = 0;
		const item = await setUp(ctx, {
			script: (request) =>
				++drafted <= 4
					? answer(request)
					: structured(429, "subscription_sharing_usage_limit_exceeded"),
		});
		const result = await item.run({
			runChild: shortLived(item),
			fingerprint: print,
			deferredMinutes: 70,
		});
		expect(result.lines.slice(3)).toEqual([
			"transfer: fails(deferred-draft:USAGE_LIMIT)",
			"revoked: yes",
		]);
		expect(evidenceOf(item).transfer.deferred).toMatchObject({
			refreshed: true,
			rotated: true,
			draft: { outcome: "error", code: "USAGE_LIMIT" },
		});
		expect(result.details).toContainEqual(
			expect.stringMatching(
				/^after expiry: refreshed true \(rotated true, \d+ s after expiry, idle 0 min\), draft USAGE_LIMIT$/,
			),
		);
		expectContentFree(item);
	});

	it("a deferredMinutes or DRAFTYAK_S7_DEFERRED_MIN outside 1 to 120 stops the run before anything is sent", async (ctx) => {
		const item = await setUp(ctx);
		for (const deferredMinutes of [0, 121, 1.5]) {
			await expect(item.run({ fingerprint: print, deferredMinutes })).rejects.toThrow(
				/^refusing to start: deferredMinutes must be whole minutes from 1 to 120$/,
			);
		}
		for (const overrides of [{}, { deferredMinutes: 70 }]) {
			const env = { DRAFTYAK_S7_DEFERRED_MIN: "0" };
			await expect(item.run({ fingerprint: print, env, ...overrides })).rejects.toThrow(
				/^refusing to start: DRAFTYAK_S7_DEFERRED_MIN must be whole minutes from 1 to 120; unset it/,
			);
		}
		expect([item.auth.authorizations, item.auth.tokenForms, item.said]).toEqual([[], [], []]);
		expect(existsSync(item.evidenceFile)).toBe(false);
	});

	it("without the setting the hub gets no --deferred, and the evidence and what the run says are as before the step", async (ctx) => {
		const item = await setUp(ctx);
		let hubArgs: readonly string[] = [];
		const runChild: ChildRunner = (args, input, signal) => {
			hubArgs = args;
			return runTransferChild(args, input, signal);
		};
		const result = await item.run({ runChild, fingerprint: print });
		expect(result.lines).toEqual(ALL_OK);
		expect(hubArgs).not.toContain("--deferred");
		const data = evidenceOf(item);
		expect(data.transfer).not.toHaveProperty("deferred");
		expect(Object.keys(data.transfer)).toEqual([
			"exitCode",
			"result",
			"desktopForgot",
			"childStructure",
			"accepted",
			"refreshed",
			"rotated",
			"planUsage",
			"code",
			"detail",
			"status",
			"apiCode",
			"draft",
			"refresh",
			"revoked",
			"revocation",
			"afterRevoke",
		]);
		const stepSaid = /^(?:After expiry|The hub process has ended)/;
		expect(item.said.filter((line) => stepSaid.test(line))).toEqual([]);
		expect(result.details.filter((line) => line.startsWith("after expiry"))).toEqual([]);
		expectContentFree(item);
	});
});

describe("before a live run starts (gate) and the session commands (session-env.ts)", () => {
	let dir = "";
	let options: EnvLiveOptions = {};
	let evidence = "";
	beforeEach(() => {
		dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s07-gate-"));
		options = { env: { DRAFTYAK_ENV_LIVE: path.join(dir, ".env.live") } };
		evidence = path.join(dir, "evidence", "live.json");
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	it("skips until the owner opts in, and after a stop request", () => {
		const skipped = gate(evidence, options, {});
		expect(skipped).toEqual({
			run: false,
			reason: expect.stringContaining("DY_LIVE_SIWC_SESSION isn't set in .env.live"),
		});
		saveEnvLive(OPT_IN, "stop", options);
		expect(gate(evidence, options, {})).toMatchObject({
			reason: expect.stringContaining('is "stop"'),
		});
		saveEnvLive(OPT_IN, "yes", options);
		expect(gate(evidence, options, {})).toEqual({ run: true, again: false });
	});

	it("refuses an earlier session's evidence unless the opt-in says again", () => {
		writeFileSync(path.join(dir, "live.json"), "{}\n");
		const earlier = path.join(dir, "live.json");
		saveEnvLive(OPT_IN, "yes", options);
		expect(() => gate(earlier, options, {})).toThrow(
			/live\.json holds an earlier session's evidence/,
		);
		saveEnvLive(OPT_IN, "again", options);
		expect(gate(earlier, options, {})).toEqual({ run: true, again: true });
	});

	it("refuses to start while any OPENAI_* variable is set, naming the variables only", () => {
		saveEnvLive(OPT_IN, "yes", options);
		const env = { OPENAI_BASE_URL: "http://example.invalid", openai_custom_headers: "x-a: b" };
		expect(() => gate(evidence, options, env)).toThrow(
			/^refusing to start: OPENAI_BASE_URL, openai_custom_headers set in this shell/,
		);
		expect(() => gate(evidence, options, env)).not.toThrow(/example\.invalid|x-a/);
	});

	it("takes DRAFTYAK_S7_DEFERRED_MIN as whole minutes from 1 to 120 and refuses anything else, keeping the opt-in", () => {
		const withMinutes = (value: string) => ({ DRAFTYAK_S7_DEFERRED_MIN: value });
		saveEnvLive(OPT_IN, "stop", options);
		expect(gate(evidence, options, withMinutes("seventy"))).toMatchObject({ run: false });
		saveEnvLive(OPT_IN, "yes", options);
		for (const value of ["70", "1", "120"]) {
			expect(gate(evidence, options, withMinutes(value))).toEqual({ run: true, again: false });
			expect(deferredMinutes(withMinutes(value))).toBe(Number(value));
		}
		expect(deferredMinutes({})).toBeUndefined();
		for (const value of ["0", "121", "70.5", "070", " 70", "1e2", "", "seventy"]) {
			expect(() => gate(evidence, options, withMinutes(value))).toThrow(
				/^refusing to start: DRAFTYAK_S7_DEFERRED_MIN must be whole minutes from 1 to 120; unset it/,
			);
		}
		expect(readEntry(OPT_IN, options)).toBe("yes");
		expect(gate(evidence, options, {})).toEqual({ run: true, again: false });
	});

	it("the step after expiry lengthens the hub process's and the live test's limits by its cap and one more refresh, draft and revocation", () => {
		const extra = 70 * 60_000 + 30_000 + DRAFT_TIMEOUT_MS + (3 * 30_000 + 3_000);
		expect([DEFERRED_BUDGET_MS, deferredExtraMs(70)]).toEqual([extra - 70 * 60_000, extra]);
		expect(childTimeoutMs()).toBe(HUB_BUDGET_MS + 60_000);
		expect(childTimeoutMs(70)).toBe(HUB_BUDGET_MS + 60_000 + extra);
		expect(liveTimeoutMs({})).toBe(60 * 60_000);
		expect(liveTimeoutMs({ DRAFTYAK_S7_DEFERRED_MIN: "70" })).toBe(60 * 60_000 + extra);
		// gate() refuses a value it can't read, so the run never starts and needs no more time.
		expect(liveTimeoutMs({ DRAFTYAK_S7_DEFERRED_MIN: "0" })).toBe(60 * 60_000);
		// No offline tier loads the live test, so its limit is checked in its source.
		const live = readFileSync(path.join(import.meta.dirname, "siwc.live.test.ts"), "utf8");
		expect(live).toContain("const LIMIT = { timeout: liveTimeoutMs() };");
		expect(live).toMatch(/^it\("S7b: [^"]+", LIMIT, async/m);
	});

	it("opt-in, stop, status and forget print names and states, never values", () => {
		const logs: string[] = [];
		vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const file = path.join(dir, ".env.live");
		expect(main(["opt-in"], options)).toBe(0);
		expect(gate(evidence, options, {})).toEqual({ run: true, again: false });
		expect(main(["--", "opt-in", "--again"], options)).toBe(0);
		expect(gate(evidence, options, {})).toEqual({ run: true, again: true });
		expect(main(["stop"], options)).toBe(0);
		saveEnvLive(SAVED.refresh, "refresh-value-not-to-print", options);
		saveEnvLive(API_KEY, "key-value-not-to-print", options);
		logs.length = 0;
		expect(main(["status"], options)).toBe(0);
		expect(logs).toEqual([
			`.env.live: ${file} (not in a repository)`,
			"DY_LIVE_SIWC_SESSION: stop",
			"DY_LIVE_SIWC_ACCESS_TOKEN: not set",
			"DY_LIVE_SIWC_REFRESH_TOKEN: set",
			"DY_LIVE_SIWC_CLIENT_ID: not set",
			"DY_LIVE_RESPONSES_API_KEY: set",
		]);
		expect(main(["forget", "api-key"], options)).toBe(0);
		expect(logs.at(-1)).toBe(`deleted from ${file}: ${API_KEY}`);
		expect(main(["forget", "tokens"], options)).toBe(0);
		expect(logs.at(-1)).toBe(`deleted from ${file}: ${OPT_IN}, ${SAVED.refresh}`);
		expect(main(["forget", "tokens"], options)).toBe(0);
		expect(logs.at(-1)).toBe("none was set");
		expect(main(["forget", "constructor"], options)).toBe(2);
		expect(main(["opt-in", "--force"], options)).toBe(2);
		expect(main([], options)).toBe(2);
	});
});
