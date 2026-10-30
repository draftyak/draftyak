// M0.20's rehearsal: the live session's own code (test/live/) driven by M0.19's scripted connectors
// through a loopback HTTPS stand-in for Funnel, offline. It shows the route checks, a row per client
// (ok, fallback or blocked with a reason), the DCR fallback with Codex's portless loopback callback,
// what stays unattributed, the redaction, vendor-guard's evidence rules through pnpm guard's CLI, the
// console's forms, the default scope, the self-check's outcomes and the clean-up. Its evidence goes
// to a temp folder shaped like the repository, never evidence/.
import { spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, stripTypeScriptTypes } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { fingerprint, writeEvidence } from "@draftyak/spike-kit";
import {
	CHARSET,
	cspFor,
	cspMeta,
	DRAFT_VIEW,
	inlineScriptHashes,
	type View,
} from "@draftyak/spike-s03-mcp-sdk/src/apps.ts";
import { GUIDE_URI } from "@draftyak/spike-s03-mcp-sdk/src/resources.ts";
import { headerValue } from "@draftyak/spike-s03-mcp-sdk/test/harness.ts";
import { gitEnv } from "@draftyak/vendor-guard/src/scan.ts";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { requestWindow } from "../src/dcr-window.ts";
import { SCOPES } from "../src/provider.ts";
import { PRM_PATH } from "../src/routes.ts";
import {
	type Connector,
	type Consent,
	chatgpt,
	claudeAi,
	claudeCode,
	codex,
	FakeVendorHost,
	PUBLIC_ADDRESS,
	recorded,
	ScriptedClient,
} from "./connectors.ts";
import { Browser, pkcePair, rawRequest } from "./flow.ts";
import { type ConsoleAction, type ConsoleView, startConsole } from "./live/console.ts";
import { CONVERSATION_ID, DRAFT_ID } from "./live/mcp.ts";
import {
	addressClass,
	CLIENTS,
	type ClientName,
	canaryOutcome,
	contentFree,
	identify,
	type LiveData,
	type OwnerReason,
	Recorder,
	type Row,
	redirectShape,
	SESSION_DCR_RULE,
	UI_EXTENSION,
	WRITE_TOOL_ANSWERS,
	type WriteToolAnswer,
} from "./live/record.ts";
import {
	CLEANUP_CONFIRM_MS,
	CLEANUP_STEPS,
	type Cleanup,
	isCompleteRun,
	LIVE_ACCESS_TOKEN_TTL,
	LIVE_CLEANUP_MS,
	type LiveSession,
	livePlans,
	recordDecision,
	recordingRequested,
	SERVER_NAME,
	type SelfCheck,
	type StepPlan,
	selfCheckMessage,
	startLiveSession,
	summary,
} from "./live/session.ts";
import { type FunnelStandIn, type StandInOptions, startFunnelStandIn } from "./live/standin.ts";

const MINUTE = 60_000;
// vendor-guard's command-line entry, which pnpm guard runs.
const GUARD_CLI = path.join(
	path.dirname(createRequire(import.meta.url).resolve("@draftyak/vendor-guard/package.json")),
	"src",
	"cli.ts",
);
const dirs: string[] = [];
let vendor: FakeVendorHost;
beforeAll(async () => {
	vendor = await FakeVendorHost.start();
});
afterAll(async () => {
	await vendor?.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (): string => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s04-rehearsal-"));
	dirs.push(dir);
	return dir;
};

const guard = () => ({ resolve: vendor.resolve, dial: vendor.dial, ca: vendor.ca });

// A view pinned as views/build.ts pins one, without the Vite build the live session runs.
function stubView(): View {
	const script = 'document.title = "draft";';
	const csp = cspFor(inlineScriptHashes(`<script>${script}</script>`));
	const html = `<!doctype html><html><head>${CHARSET}${cspMeta(csp)}<title>draft</title></head><body><script>${script}</script></body></html>`;
	const sha256 = createHash("sha256").update(html).digest("hex");
	return {
		uri: DRAFT_VIEW,
		file: "draft-v1.html",
		sha256,
		size: Buffer.byteLength(html),
		csp,
		html,
	};
}

// The owner at the session console, posting its forms as a browser does from the page itself: with
// the page's own Origin, which its same-origin Referrer-Policy keeps on every post.
class Owner {
	readonly url: string;
	readonly origin: string;
	constructor(url: string) {
		this.url = url;
		this.origin = new URL(url).origin;
	}

	async view(): Promise<ConsoleView> {
		return (await (await fetch(`${this.url}/state`)).json()) as ConsoleView;
	}

	async until(check: (view: ConsoleView) => boolean): Promise<ConsoleView> {
		for (let waited = 0; waited < 10_000; waited += 20) {
			const view = await this.view();
			if (check(view)) return view;
			await new Promise((done) => setTimeout(done, 20));
		}
		throw new Error("the console never showed what the owner waited for");
	}

	post(action: string, form: Record<string, string>): Promise<Response> {
		return fetch(`${this.url}/${action}`, {
			method: "POST",
			headers: { origin: this.origin },
			body: new URLSearchParams(form),
			redirect: "manual",
		});
	}

	async page(): Promise<string> {
		return (await fetch(`${this.url}/`)).text();
	}

	async notice(): Promise<string> {
		return /<p class="notice">([^<]*)<\/p>/.exec(await this.page())?.[1] ?? "";
	}

	// Types the code the DraftYak page shows, once the sign-in waits in the console.
	readonly approve = async ({ uid, code }: Consent): Promise<void> => {
		await this.until((view) => view.pending.some((item) => item.uid === uid));
		await this.post("approve", { code });
	};

	async step(client: ClientName): Promise<void> {
		await this.until((view) => view.step?.client === client);
	}

	async done(client: ClientName, writeTool?: WriteToolAnswer): Promise<void> {
		await this.post("step", { client, action: "done", ...(writeTool && { writeTool }) });
	}

	async blocked(client: ClientName, reason: OwnerReason): Promise<void> {
		await this.post("step", { client, action: "blocked", reason });
	}
}

interface Reply {
	readonly status: number;
	// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC bodies are inspected loosely in tests.
	readonly body: any;
}

// An MCP client's requests as the real ones send them: 2025-era after initialize, or 2026-era with
// the per-request envelope and SEP-2243's headers.
class McpCalls {
	readonly #url: string;
	readonly #token: string;
	readonly #headers: Record<string, string>;
	#id = 1;

	constructor(url: string, token: string, headers: Record<string, string> = {}) {
		this.#url = url;
		this.#token = token;
		this.#headers = headers;
	}

	async #send(body: unknown, headers: Record<string, string>): Promise<Reply> {
		const response = await fetch(this.#url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${this.#token}`,
				...this.#headers,
				...headers,
			},
			body: JSON.stringify(body),
		});
		const text = await response.text();
		return { status: response.status, body: text ? JSON.parse(text) : undefined };
	}

	legacy(method: string, params: Record<string, unknown>, version?: string): Promise<Reply> {
		const body = { jsonrpc: "2.0", id: this.#id++, method, params };
		return this.#send(body, version ? { "mcp-protocol-version": version } : {});
	}

	notify(method: string, version: string): Promise<Reply> {
		return this.#send({ jsonrpc: "2.0", method }, { "mcp-protocol-version": version });
	}

	modern(
		method: string,
		params: Record<string, unknown>,
		capabilities: Record<string, unknown>,
		clientInfo: Record<string, unknown>,
	): Promise<Reply> {
		const meta = {
			[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
			[CLIENT_CAPABILITIES_META_KEY]: capabilities,
			[CLIENT_INFO_META_KEY]: clientInfo,
		};
		const name = method === "resources/read" ? params.uri : params.name;
		const body = { jsonrpc: "2.0", id: this.#id++, method, params: { ...params, _meta: meta } };
		return this.#send(body, {
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": method,
			...(typeof name === "string" ? { "mcp-name": headerValue(name) } : {}),
		});
	}
}

interface Signed {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly mcp: string;
}

// Adding the connector: discovery, registration where needed, the browser leg with the owner's
// typed code, and the code exchange, whose tokens last the session's 10 minutes.
async function signIn(
	client: ScriptedClient,
	params: Record<string, string | undefined> = {},
): Promise<Signed> {
	const { unmet, resource } = await client.discover();
	expect(unmet).toStrictEqual([]);
	if (client.clientId === undefined) expect((await client.register()).status).toBe(201);
	const exchanged = await client.exchange(await client.authorize(params));
	expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
	expect(exchanged.body.expires_in).toBe(LIVE_ACCESS_TOKEN_TTL);
	return {
		accessToken: String(exchanged.body.access_token),
		refreshToken: String(exchanged.body.refresh_token),
		mcp: resource,
	};
}

// A sign-in started in a browser up to its consent page, as the owner's browser would.
async function startSignIn(
	origin: string,
	connector: Connector,
): Promise<{ uid: string; code: string }> {
	const browser = new Browser();
	const query = new URLSearchParams({
		client_id: connector.clientId ?? "",
		response_type: "code",
		redirect_uri: connector.redirectUri,
		scope: "inbox:read",
		state: "rehearsal",
		code_challenge: pkcePair().challenge,
		code_challenge_method: "S256",
		resource: `${origin}/mcp`,
	});
	const first = await browser.get(`${origin}/oauth/authorize?${query}`);
	const location = first.headers.get("location") ?? "";
	expect(first.status, location).toBe(303);
	const page = await (await browser.get(new URL(location, origin).href)).text();
	const code = /<strong id="code">(\d\d)<\/strong>/.exec(page)?.[1] ?? "";
	return { uid: location.split("/").at(-1) ?? "", code };
}

interface Rehearsal {
	readonly rows: readonly Row[];
	readonly data: LiveData;
	readonly lines: readonly string[];
	readonly secrets: readonly string[];
	readonly selfCheck: SelfCheck;
	readonly origin: string;
	readonly cleanup: Cleanup | undefined;
}

interface Driving {
	readonly origin: string;
	readonly owner: Owner;
	readonly switchFile: string;
	readonly secrets: string[];
}

type Drive = (context: Driving) => Promise<void>;

interface RehearsalOptions {
	readonly standIn?: StandInOptions;
	// The owner's browser check through the stand-in, before the steps (on by default).
	readonly browserCheck?: boolean;
	readonly cleanUp?: (context: {
		readonly session: LiveSession;
		readonly owner: Owner;
		readonly standIn: FunnelStandIn;
	}) => Promise<Cleanup>;
}

async function rehearse(
	plans: readonly StepPlan[],
	drive: Drive,
	options: RehearsalOptions = {},
): Promise<Rehearsal> {
	const switchFile = path.join(tempDir(), "dcr-window");
	await using standIn = await startFunnelStandIn(options.standIn);
	const lines: string[] = [];
	await using session = await startLiveSession({
		publicBaseUrl: standIn.origin,
		views: [stubView()],
		guard: guard(),
		switchFile,
		watchEveryMs: 20,
		consentLimits: { perMinute: 1000, perDay: 1000, denialsToPause: 1000 },
		print: (line) => lines.push(line),
		env: {},
	});
	standIn.target = session.origin;
	const started = Date.now();
	const selfCheck = await session.selfCheck({ budgetMs: 2_000, everyMs: 50 });
	if (options.browserCheck !== false) {
		await (await fetch(`${standIn.origin}${PRM_PATH}?check=browser`)).body?.cancel();
	}
	const owner = new Owner(session.consoleUrl);
	const secrets: string[] = [];
	const running = session.run(plans, undefined, { routeChecksMs: 5_000 });
	await drive({ origin: standIn.origin, owner, switchFile, secrets });
	const rows = await running;
	const cleanup = await options.cleanUp?.({ session, owner, standIn });
	return {
		rows,
		data: session.evidence(plans, started),
		lines,
		secrets,
		selfCheck,
		origin: standIn.origin,
		cleanup,
	};
}

const plan = (client: ClientName, deadlineMs = MINUTE): StepPlan => ({ client, deadlineMs });

const CODE_CAPABILITIES = {
	elicitation: { form: {}, url: {} },
	extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html;profile=mcp-app"] } },
};

// What Codex registers in the DCR window: its loopback callback without the port, which it adds when
// it signs in (learn.chatgpt.com, Codex MCP).
function codexAsRegistered(): Connector {
	const port = randomInt(49_152, 65_536);
	const stock = codex(port);
	return {
		...stock,
		redirectUri: `http://127.0.0.1:${port}/callback`,
		registration: {
			...stock.registration,
			client_name: "Codex",
			redirect_uris: ["http://127.0.0.1/callback"],
		},
	};
}

// The four clients as the live session expects them: claude.ai and ChatGPT on the 2025 era,
// remote Claude Code on 2026 with form elicitation, and Codex through the DCR window.
const fourClients: Drive = async ({ origin, owner, switchFile, secrets }) => {
	const keep = (signed: Signed): Signed => {
		secrets.push(signed.accessToken, signed.refreshToken);
		return signed;
	};

	await owner.step("claude-ai");
	const ai = claudeAi();
	vendor.serveAll(ai.documents);
	const hosted = new ScriptedClient(ai, { origin, approve: owner.approve });
	const aiSigned = keep(await signIn(hosted));
	const claude = new McpCalls(aiSigned.mcp, aiSigned.accessToken, { origin: "https://claude.ai" });
	const init = await claude.legacy("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "claude-ai", version: "0.1.0" },
	});
	expect(init.body.result.protocolVersion).toBe("2025-06-18");
	expect((await claude.notify("notifications/initialized", "2025-06-18")).status).toBe(202);
	for (const method of ["tools/list", "prompts/list", "resources/list"]) {
		expect((await claude.legacy(method, {}, "2025-06-18")).status).toBe(200);
	}
	const guide = await claude.legacy("resources/read", { uri: GUIDE_URI }, "2025-06-18");
	expect(guide.body.result.contents[0].uri).toBe(GUIDE_URI);
	const draft = await claude.legacy(
		"tools/call",
		{ name: "draft_get", arguments: { draftId: DRAFT_ID } },
		"2025-06-18",
	);
	expect(draft.body.result.structuredContent.draftId).toBe(DRAFT_ID);
	const view = await claude.legacy("resources/read", { uri: DRAFT_VIEW }, "2025-06-18");
	expect(view.body.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
	const refreshed = await hosted.refresh(aiSigned.refreshToken);
	expect(refreshed.status).toBe(200);
	expect(refreshed.body.expires_in).toBe(LIVE_ACCESS_TOKEN_TTL);
	secrets.push(String(refreshed.body.access_token), String(refreshed.body.refresh_token));
	await owner.done("claude-ai");

	await owner.step("chatgpt");
	const gpt = chatgpt();
	vendor.serveAll(gpt.documents);
	const gptSigned = keep(await signIn(new ScriptedClient(gpt, { origin, approve: owner.approve })));
	const openai = new McpCalls(gptSigned.mcp, gptSigned.accessToken);
	await openai.legacy("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "openai-mcp", version: "1.0.0" },
	});
	expect((await openai.legacy("tools/list", {}, "2025-11-25")).body.result.tools).toEqual(
		expect.arrayContaining([expect.objectContaining({ name: "draft_create" })]),
	);
	const written = await openai.legacy(
		"tools/call",
		{ name: "draft_create", arguments: { conversationId: CONVERSATION_ID, body: "Thanks!" } },
		"2025-11-25",
	);
	expect(written.body.result.structuredContent).toStrictEqual({
		draftId: DRAFT_ID,
		status: "fake",
		stored: false,
	});
	await openai.legacy("resources/read", { uri: DRAFT_VIEW }, "2025-11-25");
	await owner.done("chatgpt", "allowed");

	await owner.step("claude-code");
	const local = claudeCode();
	vendor.serveAll(local.documents);
	const codeSigned = keep(
		await signIn(new ScriptedClient(local, { origin, approve: owner.approve })),
	);
	const code = new McpCalls(codeSigned.mcp, codeSigned.accessToken);
	const info = { name: "claude-code", version: "2.1.300" };
	const discover = await code.modern("server/discover", {}, CODE_CAPABILITIES, info);
	expect(discover.status).toBe(200);
	await code.modern("tools/list", {}, CODE_CAPABILITIES, info);
	await code.modern("prompts/list", {}, CODE_CAPABILITIES, info);
	const triage = { name: "triage_inbox", arguments: {} };
	const asked = await code.modern("prompts/get", triage, CODE_CAPABILITIES, info);
	expect(asked.body.result.resultType).toBe("input_required");
	const answered = await code.modern(
		"prompts/get",
		{
			...triage,
			requestState: asked.body.result.requestState,
			inputResponses: { account: { action: "accept", content: { account: "gmail-1" } } },
		},
		CODE_CAPABILITIES,
		info,
	);
	expect(answered.body.result.messages[0].content.text).toContain("gmail-1");
	const completed = await code.modern(
		"completion/complete",
		{ ref: { type: "ref/prompt", name: "triage_inbox" }, argument: { name: "window", value: "7" } },
		CODE_CAPABILITIES,
		info,
	);
	expect(completed.body.result.completion.values).toStrictEqual(["72h", "7d"]);
	await code.modern("resources/templates/list", {}, CODE_CAPABILITIES, info);
	const thread = await code.modern(
		"resources/read",
		{ uri: `draftyak://conversation/${CONVERSATION_ID}` },
		CODE_CAPABILITIES,
		info,
	);
	expect(thread.body.result.contents[0].text).toContain("Synthetic conversation");
	await owner.done("claude-code");

	await owner.step("codex");
	const real = codexAsRegistered();
	const cli = new ScriptedClient(real, { origin, approve: owner.approve });
	expect((await cli.discover()).unmet).toStrictEqual(["registration"]);
	const closed = await fetch(`${origin}/oauth/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(real.registration),
	});
	expect(closed.status).toBe(404);
	// The owner's step 3: the dcr-window command, then the CLI's retry.
	expect(await requestWindow(switchFile, 5_000)).toBe(true);
	await cli.rediscover();
	const cliSigned = keep(await signIn(cli));
	const codexCalls = new McpCalls(cliSigned.mcp, cliSigned.accessToken);
	await codexCalls.legacy("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: { elicitation: {} },
		clientInfo: { name: "codex-mcp-client", version: "0.50.0" },
	});
	await codexCalls.legacy("tools/list", {}, "2025-06-18");
	const accounts = await codexCalls.legacy(
		"tools/call",
		{ name: "accounts_list", arguments: {} },
		"2025-06-18",
	);
	expect(accounts.body.result.structuredContent.accounts).toHaveLength(1);
	await owner.done("codex");
};

const rowOf = (rows: readonly Row[], client: ClientName): Row => {
	const row = rows.find((candidate) => candidate.client === client);
	if (!row) throw new Error(`no row for ${client}`);
	return row;
};

const exact = (uri: string) => [redirectShape(uri)];

describe("the live session, rehearsed through a loopback stand-in for Funnel", () => {
	let full: Rehearsal;
	beforeAll(async () => {
		full = await rehearse(
			CLIENTS.map((client) => plan(client)),
			fourClients,
		);
	}, 120_000);

	test("the routes: this machine's check, the browser's and Funnel's public route", () => {
		expect(full.selfCheck).toStrictEqual({ route: "no identity headers" });
		expect(selfCheckMessage(full.selfCheck)).toContain("through Funnel's public ingress");
		expect(full.data.session.routeChecks).toStrictEqual({
			thisMachine: "reached through Funnel's public ingress",
			browser: "reached through Funnel's public ingress",
			publicIngress: "confirmed by this machine's own check",
			startedWith: "every check passed",
		});
	});

	test("records a row per client: ok through CIMD, fallback through the DCR window", () => {
		expect(
			full.rows.map((row) => [row.client, row.outcome, row.dcrFallbackVerified]),
		).toStrictEqual([
			["claude-ai", "ok", "no"],
			["chatgpt", "ok", "no"],
			["claude-code", "ok", "no"],
			["codex", "fallback", "yes"],
		]);
		expect(rowOf(full.rows, "codex")).toMatchObject({
			reason:
				"connected after registering in the DCR window through the session's any-port loopback rule",
			registration: ["dcr"],
			cimd: [],
			dcr: {
				registeredClients: [expect.stringMatching(/^hmac:[\w-]{22}$/)],
				identifiedBy: ["client name"],
				registrationErrors: [],
			},
		});
		for (const row of full.rows) expect(row.owner).toBe("done");
	});

	test("records the CIMD host, status, document hash and auth method, and each client's audience form", () => {
		const ai = rowOf(full.rows, "claude-ai");
		expect(ai.cimd).toStrictEqual([
			{
				kind: "cimd",
				host: "claude.ai",
				fetches: 1,
				statuses: { "200": 1 },
				contentTypes: ["application/json"],
				sha256: recorded("claude-ai").sha256,
				matchesFixture: "yes",
				declaredAuthMethod: "none",
			},
		]);
		expect([ai.authMethods, ai.audience, ai.cimdRefused]).toStrictEqual([["none"], [], []]);
		const gpt = rowOf(full.rows, "chatgpt");
		expect(gpt.cimd).toMatchObject([
			{ host: "chatgpt.com", matchesFixture: "yes", declaredAuthMethod: "private_key_jwt" },
		]);
		// The stand-in's key is made at run time, so its JWKS isn't the recorded one.
		expect(gpt.jwks).toMatchObject([
			{ kind: "jwks", host: "chatgpt.com", statuses: { "200": 1 }, matchesFixture: "no" },
		]);
		expect([gpt.authMethods, gpt.audience]).toStrictEqual([
			["private_key_jwt"],
			["token endpoint"],
		]);
		expect(rowOf(full.rows, "claude-code").cimd).toMatchObject([
			{ host: "claude.ai", matchesFixture: "yes" },
		]);
	});

	test("records redirect URIs as requested, registered and declared, and the rule that let each through", () => {
		const redirects = Object.fromEntries(full.rows.map((row) => [row.client, row.redirectUris]));
		const ai = recorded("claude-ai").document.redirect_uris as string[];
		const gpt = recorded("chatgpt").document.redirect_uris as string[];
		expect(redirects).toStrictEqual({
			"claude-ai": {
				requested: exact(ai[0] ?? ""),
				registered: [],
				declared: ai.map(redirectShape),
				matched: ["exact"],
			},
			chatgpt: {
				requested: exact(gpt[0] ?? ""),
				registered: [],
				declared: gpt.map(redirectShape),
				matched: ["exact"],
			},
			"claude-code": {
				requested: [
					{ scheme: "http", host: "loopback name", port: "loopback port", path: "/callback" },
				],
				registered: [],
				declared: [
					{ scheme: "http", host: "loopback name", port: "none", path: "/callback" },
					{ scheme: "http", host: "loopback IPv4", port: "none", path: "/callback" },
				],
				matched: ["any loopback port (cimd's rule for CIMD clients)"],
			},
			codex: {
				requested: [
					{ scheme: "http", host: "loopback IPv4", port: "loopback port", path: "/callback" },
				],
				registered: [{ scheme: "http", host: "loopback IPv4", port: "none", path: "/callback" }],
				declared: [],
				matched: [SESSION_DCR_RULE],
			},
		});
	});

	test("records era and versions, the surfaces each client used, and what it declared or listed", () => {
		const surfaces = Object.fromEntries(
			full.rows.map((row) => [
				row.client,
				[row.era, row.protocolVersions, row.surfaces, row.declaredOrListed],
			]),
		);
		const none = {
			prompts: false,
			resources: false,
			completion: false,
			elicitation: false,
			apps: false,
		};
		expect(surfaces).toStrictEqual({
			"claude-ai": [
				"2025",
				["2025-06-18"],
				{ ...none, resources: true, apps: true },
				{ ...none, prompts: true, resources: true, apps: true },
			],
			chatgpt: ["2025", ["2025-11-25"], { ...none, apps: true }, { ...none, apps: true }],
			"claude-code": [
				"2026",
				["2026-07-28"],
				{ prompts: true, resources: true, completion: true, elicitation: true, apps: false },
				{ prompts: true, resources: true, completion: true, elicitation: true, apps: true },
			],
			codex: ["2025", ["2025-06-18"], none, { ...none, elicitation: true }],
		});
		expect(rowOf(full.rows, "claude-code").mcp).toMatchObject({
			elicitation: { declared: ["form", "url"], inputRequired: 1, answered: 1 },
			apps: { extensionDeclared: true, mimeTypes: ["text/html;profile=mcp-app"] },
			clientInfo: ["claude-code 2.1.300"],
		});
	});

	test("records hosted Claude's Origin, ChatGPT's write tool, refresh rotation, requesters and the proxy", () => {
		const ai = rowOf(full.rows, "claude-ai");
		expect(ai.mcp).toMatchObject({ origins: ["https://claude.ai"], uiReads: 1, resourceReads: 1 });
		expect(ai.token).toMatchObject({
			codeExchanges: 1,
			refreshes: 1,
			rotations: 1,
			origins: ["none"],
			resource: ["absent"],
		});
		expect(ai.authorization).toMatchObject({ resource: ["MCP resource"], errors: [] });
		// The stand-in names its own peer, as a local proxy does: a class, never the address.
		for (const row of full.rows)
			expect(Object.keys(row.requester), row.client).toStrictEqual(["loopback"]);
		expect(full.data.hostedClaudeOrigin).toStrictEqual(["https://claude.ai"]);
		expect(rowOf(full.rows, "chatgpt").mcp).toMatchObject({
			writeTool: { listed: 1, called: 1, refusedWithoutScope: 0 },
			tokenScopes: ["drafts:write", "inbox:read", "outbox:propose"],
			uiReads: 1,
		});
		expect(full.data.chatgptWriteToolAccess).toStrictEqual({
			owner: WRITE_TOOL_ANSWERS.allowed,
			listed: "yes",
			called: 1,
			refusedWithoutScope: 0,
		});
		expect(full.data.proxy).toStrictEqual({
			"no identity headers": {
				requests: expect.any(Number),
				headers: ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"],
				clientIpHeader: ["x-forwarded-for"],
				forwardedForEntries: { "1": expect.any(Number) },
				nearestUntrustedHop: { loopback: expect.any(Number) },
				host: ["public host"],
				forwardedHost: ["public host"],
				forwardedProto: ["https"],
				// The stand-in drops a client's own forwarding headers and sets X-Forwarded-For itself.
				clientSent: {
					"x-forwarded-for": ["replaced"],
					forwarded: ["dropped"],
					"x-real-ip": ["dropped"],
				},
			},
		});
		expect(full.data.dcrWindow).toStrictEqual({ opened: 1, registrations: 1 });
		expect(full.data.serverErrors).toBe(0);
	});

	test("keeps what no client ID or token names with the step it arrived in, never in a row", () => {
		const traffic = full.data.traffic as Record<
			string,
			{ requests: Record<string, Record<string, number>>; unattributed: Record<string, number> }
		>;
		expect(traffic.codex?.unattributed).toMatchObject({
			"registration while the DCR window was closed": 1,
			"MCP request without a valid token": expect.any(Number),
		});
		expect(traffic["outside steps"]?.requests["no identity headers"]).toMatchObject({
			"route check": 1,
		});
		expect(traffic["claude-ai"]?.requests["no identity headers"]).toMatchObject({
			mcp: expect.any(Number),
			"AS metadata": expect.any(Number),
			token: 2,
		});
		expect(rowOf(full.rows, "codex").dcr).not.toHaveProperty("closedAttempts");
	});

	test("prints each client's steps, the route checks, the DCR hint and the summary, without a token or the public host", () => {
		const text = full.lines.join("\n");
		for (const command of [
			`claude mcp add --transport http ${SERVER_NAME} <DY_LIVE_FUNNEL_BASE_URL>/mcp`,
			`codex mcp login ${SERVER_NAME}`,
			"pnpm --filter @draftyak/spike-s04-oauth-as dcr-window",
			"Customize > Connectors > + Add > Add custom connector",
			"Plugins > + > Add custom MCP server",
			"[session] your browser's check arrived (reached through Funnel's public ingress)",
		]) {
			expect(text).toContain(command);
		}
		expect(text).toContain(
			"[session] a registration request arrived while the DCR window is closed (answered 404). If Codex reports a registration error, open the DCR window",
		);
		expect(text).toMatch(/codex\s+\| fallback/);
		expect(text).toContain(`ChatGPT's draft_create: ${WRITE_TOOL_ANSWERS.allowed}; listed: yes`);
		for (const secret of full.secrets) expect(text).not.toContain(secret);
		expect(text).not.toContain(full.origin);
	});

	test("the evidence has the shape ADR 0006 reads: session facts, a row per client, the proxy, the traffic", () => {
		expect(Object.keys(full.data).sort()).toStrictEqual([
			"chatgptWriteToolAccess",
			"clients",
			"consentRefusedByLimits",
			"dcrWindow",
			"hostedClaudeOrigin",
			"proxy",
			"serverErrors",
			"session",
			"traffic",
		]);
		expect(Object.keys(full.data.session).sort()).toStrictEqual([
			"accessTokenTtlSeconds",
			"adr0005",
			"audienceRule",
			"challengeNamesScopes",
			"cimdHosts",
			"cleanup",
			"clients",
			"complete",
			"consentLimits",
			"consoleApproval",
			"dcrAnyLoopbackPort",
			"defaultScopeWhenNone",
			"durationMinutes",
			"perClientMinutes",
			"revoked",
			"routeChecks",
			"selfCheckRoute",
			"tokenCheckBeforeBodyChecks",
			"valuesReplaced",
		]);
		expect(full.data.session).toMatchObject({
			clients: [...CLIENTS],
			complete: true,
			accessTokenTtlSeconds: 600,
			audienceRule: "endpoints",
			consentLimits: "raised",
			adr0005: {
				eraAndElicitationModes: "recorded per client",
				requestTimeouts: "not measured",
				progressResets: "not measured",
				form2025: "not tested",
			},
			cleanup: "not run",
			revoked: "not run",
			valuesReplaced: 0,
		});
		for (const row of full.rows) {
			expect(Object.keys(row).sort(), row.client).toStrictEqual([
				"audience",
				"authMethods",
				"authorization",
				"cimd",
				"cimdRefused",
				"client",
				"consent",
				"dcr",
				"dcrFallbackVerified",
				"declaredOrListed",
				"era",
				"jwks",
				"mcp",
				"outcome",
				"owner",
				"protocolVersions",
				"reason",
				"redirectUris",
				"registration",
				"requester",
				"routes",
				"surfaces",
				"token",
			]);
		}
	});

	test("the evidence is content-free and pnpm guard passes it, in a temp folder shaped like the repository", async () => {
		const json = JSON.stringify(full.data);
		for (const secret of full.secrets) expect(json).not.toContain(secret);
		for (const shape of [
			new URL(full.origin).host,
			"127.0.0.1",
			PUBLIC_ADDRESS,
			String(recorded("claude-ai").document.client_id),
			String(recorded("chatgpt").document.jwks_uri),
		]) {
			expect(json).not.toContain(shape);
		}
		const relative = "spikes/s04-oauth-as/evidence/live-clients.json";
		const root = tempDir();
		const file = path.join(root, ...relative.split("/"));
		const repoPrint = await fingerprint({ cwd: import.meta.dirname, sampleMs: 100 });
		expect(await writeEvidence(file, full.data, { fingerprint: repoPrint })).toBe(file);
		// vendor-guard's CLI, the command behind pnpm guard, in a throwaway repository with only this file.
		const run = (command: string, args: readonly string[]) =>
			spawnSync(command, args, {
				cwd: root,
				encoding: "utf8",
				env: { ...gitEnv(), DO_NOT_TRACK: "1" },
			});
		expect(run("git", ["init", "-q"]).status).toBe(0);
		expect(run("git", ["config", "maintenance.auto", "false"]).status).toBe(0);
		const clean = run(process.execPath, [GUARD_CLI]);
		expect(clean.stdout.trim(), clean.stderr).toMatch(/^vendor-guard: 0 findings in 1 file \(/);
		expect(clean.status).toBe(0);
		// The control: the same file with an address in it fails the same run.
		writeFileSync(file, readFileSync(file, "utf8").replace('"none"', '"192.0.2.10"'));
		const planted = run(process.execPath, [GUARD_CLI]);
		expect(planted.stdout).toContain("evidence-ipv4");
		expect(planted.status).toBe(1);
		expect(existsSync(path.join(import.meta.dirname, "..", "evidence", "live-clients.json"))).toBe(
			false,
		);
	});
});

describe("authenticated MCP middleware refusals", () => {
	const modern = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "server/discover",
		params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" } },
	});
	test.each([
		{
			refusal: "unsupported media type",
			contentType: "text/plain",
			body: modern,
			status: 415,
			code: -32000,
			version: "2026-07-28",
			era: "none",
		},
		{
			refusal: "body too large",
			contentType: "application/json",
			body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }),
			status: 413,
			code: -32000,
			version: "2026-07-28",
			era: "none",
		},
		{
			refusal: "parse error",
			contentType: "application/json",
			body: "this is not JSON and must not reach the evidence",
			status: 400,
			code: -32700,
			version: "2026-07-28",
			era: "none",
		},
		{
			refusal: "header mismatch",
			contentType: "application/json",
			body: modern,
			status: 400,
			code: -32020,
			version: "2026-07-28",
			era: "2026",
		},
		{
			refusal: "unsupported protocol version",
			contentType: "application/json",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			status: 400,
			code: -32022,
			version: "2024-11-05",
			era: "2025",
		},
	])("$refusal reaches only the authenticated client's row", async (refused) => {
		const run = await rehearse([plan("claude-code")], async ({ origin, owner, secrets }) => {
			await owner.step("claude-code");
			const connector = claudeCode();
			vendor.serveAll(connector.documents);
			const signed = await signIn(
				new ScriptedClient(connector, { origin, approve: owner.approve }),
			);
			secrets.push(signed.accessToken, signed.refreshToken);
			const send = (token: string) =>
				fetch(signed.mcp, {
					method: "POST",
					headers: {
						"content-type": refused.contentType,
						"mcp-protocol-version": refused.version,
						authorization: `Bearer ${token}`,
					},
					body: refused.body,
				});
			const unauthenticated = await send("invalid");
			expect(unauthenticated.status).toBe(401);
			await unauthenticated.body?.cancel();
			const response = await send(signed.accessToken);
			expect(response.status).toBe(refused.status);
			expect(await response.json()).toMatchObject({ error: { code: refused.code } });
			await owner.done("claude-code");
		});
		expect(rowOf(run.rows, "claude-code")).toMatchObject({
			outcome: "blocked",
			reason: `MCP requests failed (HTTP ${refused.status})`,
			era: refused.era,
			protocolVersions: [refused.version],
			mcp: {
				requests: 1,
				ok: 0,
				statuses: { [refused.status]: 1 },
				refusals: { [refused.refusal]: 1 },
				httpMethods: { POST: 1 },
			},
		});
		const evidence = JSON.stringify(run.data);
		for (const secret of run.secrets) expect(evidence).not.toContain(secret);
		expect(evidence).not.toContain("this is not JSON and must not reach the evidence");
	});

	test("hostile parsed resource URIs preserve each middleware 400 and exactly one diagnostic", async () => {
		const uris: unknown[] = [{ toString: null }, { toString: {}, valueOf: null }, {}, [], null, 42];
		const run = await rehearse([plan("claude-code")], async ({ origin, owner, secrets }) => {
			await owner.step("claude-code");
			const connector = claudeCode();
			vendor.serveAll(connector.documents);
			const signed = await signIn(
				new ScriptedClient(connector, { origin, approve: owner.approve }),
			);
			secrets.push(signed.accessToken, signed.refreshToken);
			for (const [id, uri] of uris.entries()) {
				const response = await fetch(signed.mcp, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"mcp-protocol-version": "2026-07-28",
						authorization: `Bearer ${signed.accessToken}`,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id,
						method: "resources/read",
						params: { uri, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" } },
					}),
				});
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code: -32020 } });
			}
			await owner.done("claude-code");
		});
		expect(rowOf(run.rows, "claude-code")).toMatchObject({
			outcome: "blocked",
			era: "2026",
			mcp: {
				requests: uris.length,
				ok: 0,
				statuses: { "400": uris.length },
				refusals: { "header mismatch": uris.length },
				methods: { "resources/read": uris.length },
				handledMethods: {},
				resourceReads: 0,
				uiReads: 0,
			},
		});
		for (const secret of run.secrets) expect(JSON.stringify(run.data)).not.toContain(secret);
	});

	test.each(["initialize", "modern"] as const)(
		"non-object capability metadata in %s preserves each middleware 400 and diagnostic",
		async (placement) => {
			const values: unknown[] = [null, false, true, 0, 42, "not an object", [], [{}]];
			const capabilities = [
				...values,
				...values.map((elicitation) => ({ elicitation })),
				...values.map((extensions) => ({ extensions })),
				...values.map((ui) => ({ extensions: { [UI_EXTENSION]: ui } })),
				{ extensions: {} },
			];
			const run = await rehearse([plan("claude-code")], async ({ origin, owner, secrets }) => {
				await owner.step("claude-code");
				const connector = claudeCode();
				vendor.serveAll(connector.documents);
				const signed = await signIn(
					new ScriptedClient(connector, { origin, approve: owner.approve }),
				);
				secrets.push(signed.accessToken, signed.refreshToken);
				try {
					for (const [id, declared] of capabilities.entries()) {
						const response = await fetch(signed.mcp, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"mcp-protocol-version": "2026-07-28",
								authorization: `Bearer ${signed.accessToken}`,
							},
							body: JSON.stringify({
								jsonrpc: "2.0",
								id,
								method: placement === "initialize" ? "initialize" : "server/discover",
								params:
									placement === "initialize"
										? { protocolVersion: "2025-11-25", capabilities: declared }
										: {
												_meta: {
													[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
													[CLIENT_CAPABILITIES_META_KEY]: declared,
												},
											},
							}),
						});
						expect(response.status, JSON.stringify(declared)).toBe(400);
						expect(await response.json()).toMatchObject({ error: { code: -32020 } });
					}
				} finally {
					await owner.done("claude-code");
				}
			});
			const row = rowOf(run.rows, "claude-code");
			expect(row).toMatchObject({
				outcome: "blocked",
				reason: "MCP requests failed (HTTP 400)",
				declaredOrListed: { apps: false },
				mcp: {
					requests: capabilities.length,
					ok: 0,
					handledMethods: {},
					elicitation: { declared: [] },
					apps: { extensionDeclared: false, mimeTypes: [] },
				},
			});
			expect(row.mcp.statuses).toStrictEqual({ "400": capabilities.length });
			expect(row.mcp.refusals).toStrictEqual({ "header mismatch": capabilities.length });
			expect(row.mcp.capabilityKeys).toStrictEqual(["elicitation", "extensions"]);
			for (const secret of run.secrets) expect(JSON.stringify(run.data)).not.toContain(secret);
		},
	);

	test.each(["initialize", "modern"] as const)(
		"object-shaped capability metadata in %s retains valid declarations after refusal",
		async (placement) => {
			const run = await rehearse([plan("claude-code")], async ({ origin, owner }) => {
				await owner.step("claude-code");
				const connector = claudeCode();
				vendor.serveAll(connector.documents);
				const signed = await signIn(
					new ScriptedClient(connector, { origin, approve: owner.approve }),
				);
				const capabilities = {
					elicitation: { form: {}, url: {} },
					extensions: {
						[UI_EXTENSION]: {
							mimeTypes: [null, false, 42, {}, [], "text/html;profile=mcp-app"],
						},
					},
				};
				const response = await fetch(signed.mcp, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"mcp-protocol-version": "2026-07-28",
						authorization: `Bearer ${signed.accessToken}`,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: placement === "initialize" ? "initialize" : "server/discover",
						params:
							placement === "initialize"
								? { protocolVersion: "2025-11-25", capabilities }
								: {
										_meta: {
											[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
											[CLIENT_CAPABILITIES_META_KEY]: capabilities,
										},
									},
					}),
				});
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code: -32020 } });
				await owner.done("claude-code");
			});
			const row = rowOf(run.rows, "claude-code");
			expect(row.declaredOrListed).toMatchObject({ apps: true, elicitation: true });
			expect(row.mcp.apps).toStrictEqual({
				extensionDeclared: true,
				mimeTypes: ["text/html;profile=mcp-app"],
			});
			expect(row.mcp.elicitation).toMatchObject({ declared: ["form", "url"] });
			expect(row.mcp.statuses).toStrictEqual({ "400": 1 });
			expect(row.mcp.refusals).toStrictEqual({ "header mismatch": 1 });
			expect(row.mcp.handledMethods).toStrictEqual({});
		},
	);

	test("refused surface and write attempts cannot claim handler use after legacy fallback", async () => {
		const attempts = [
			{ method: "prompts/get", params: { name: "draft_reply" } },
			{ method: "resources/read", params: { uri: GUIDE_URI } },
			{ method: "resources/read", params: { uri: DRAFT_VIEW } },
			{ method: "completion/complete", params: {} },
			{ method: "tools/call", params: { name: "triage_inbox", inputResponses: {} } },
			{ method: "tools/call", params: { name: "draft_create", arguments: {} } },
		];
		const run = await rehearse([plan("chatgpt")], async ({ origin, owner, secrets }) => {
			await owner.step("chatgpt");
			const connector = chatgpt();
			vendor.serveAll(connector.documents);
			const signed = await signIn(
				new ScriptedClient(connector, { origin, approve: owner.approve }),
				{ scope: "inbox:read" },
			);
			secrets.push(signed.accessToken, signed.refreshToken);
			for (const [id, attempt] of attempts.entries()) {
				const refused = await fetch(signed.mcp, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"mcp-protocol-version": "2026-07-28",
						authorization: `Bearer ${signed.accessToken}`,
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id,
						...attempt,
						params: { ...attempt.params, _meta: { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" } },
					}),
				});
				expect(refused.status).toBe(400);
				await refused.body?.cancel();
			}
			const calls = new McpCalls(signed.mcp, signed.accessToken);
			expect(
				(
					await calls.legacy("initialize", {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "rehearsal", version: "1.0.0" },
					})
				).status,
			).toBe(200);
			const invalidWrite = await calls.legacy(
				"tools/call",
				{ name: "draft_create", arguments: {} },
				"2025-11-25",
			);
			expect(invalidWrite.body.error ?? invalidWrite.body.result?.isError).toBeTruthy();
			await owner.done("chatgpt", "not-tried");
		});
		const row = rowOf(run.rows, "chatgpt");
		expect(row).toMatchObject({
			outcome: "ok",
			era: "both",
			protocolVersions: ["2025-11-25", "2026-07-28"],
			mcp: {
				requests: 8,
				ok: 2,
				statuses: { "200": 2, "400": 6 },
				refusals: { "header mismatch": 6 },
				handledMethods: { initialize: 1 },
				attemptedTools: { triage_inbox: 1, draft_create: 2 },
				tools: {},
				writeTool: { listed: 0, called: 0, refusedWithoutScope: 0 },
				uiReads: 0,
				resourceReads: 0,
				elicitation: { inputRequired: 0, answered: 0 },
			},
		});
		const none = {
			prompts: false,
			resources: false,
			completion: false,
			elicitation: false,
			apps: false,
		};
		expect(row.surfaces).toStrictEqual(none);
		expect(row.declaredOrListed).toStrictEqual(none);
		for (const secret of run.secrets) expect(JSON.stringify(run.data)).not.toContain(secret);
	});

	test("a refused modern request followed by legacy fallback keeps both eras without double counting", async () => {
		const run = await rehearse([plan("claude-code")], async ({ origin, owner }) => {
			await owner.step("claude-code");
			const connector = claudeCode();
			vendor.serveAll(connector.documents);
			const signed = await signIn(
				new ScriptedClient(connector, { origin, approve: owner.approve }),
			);
			const refused = await fetch(signed.mcp, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"mcp-protocol-version": "2026-07-28",
					authorization: `Bearer ${signed.accessToken}`,
				},
				body: modern,
			});
			expect(refused.status).toBe(400);
			await refused.body?.cancel();
			const calls = new McpCalls(signed.mcp, signed.accessToken);
			expect(
				(
					await calls.legacy("initialize", {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "rehearsal", version: "1.0.0" },
					})
				).status,
			).toBe(200);
			const get = await fetch(signed.mcp, {
				headers: { authorization: `Bearer ${signed.accessToken}` },
			});
			expect(get.status).toBe(405);
			await get.body?.cancel();
			await owner.done("claude-code");
		});
		expect(rowOf(run.rows, "claude-code")).toMatchObject({
			outcome: "ok",
			era: "both",
			protocolVersions: ["2025-06-18", "2026-07-28"],
			mcp: {
				requests: 3,
				ok: 1,
				statuses: { "200": 1, "400": 1, "405": 1 },
				refusals: { "header mismatch": 1 },
				httpMethods: { GET: 1, POST: 2 },
			},
		});
	});
});

describe("blocked clients get a row and a reason too", () => {
	let blocked: Rehearsal;
	beforeAll(async () => {
		blocked = await rehearse(
			[plan("claude-code"), plan("chatgpt"), plan("codex", 1_500)],
			async ({ origin, owner }) => {
				await owner.step("claude-code");
				// Its document answers 404 with an error page, as a bot wall or a moved document might.
				const local = claudeCode();
				vendor.serve(local.clientId ?? "", {
					status: 404,
					headers: { "content-type": "text/html; charset=utf-8" },
					body: "<!doctype html><title>Not found</title>",
				});
				const failing = new ScriptedClient(local, { origin, approve: owner.approve });
				await expect(failing.authorize()).rejects.toThrow("authorization refused");
				await owner.done("claude-code");
				await owner.step("chatgpt");
				await owner.blocked("chatgpt", "unavailable");
				await owner.step("codex");
				// During Codex's step, a CIMD client on a host nobody allowlisted: nothing names Codex.
				const outsider: Connector = {
					...claudeCode(),
					name: "codex",
					clientId: "https://agent.example/codex/client.json",
					documents: new Map(),
				};
				const stranger = new ScriptedClient(outsider, { origin, approve: owner.approve });
				await expect(stranger.authorize()).rejects.toThrow("authorization refused");
			},
		);
	}, 60_000);

	test("by a refused document, by the owner, or by the deadline", () => {
		expect(
			blocked.rows.map((row) => [row.client, row.outcome, row.reason, row.owner]),
		).toStrictEqual([
			[
				"claude-code",
				"blocked",
				"CIMD refused: the client document fetch answered HTTP 404 (text/html)",
				"done",
			],
			[
				"chatgpt",
				"blocked",
				"owner: the client or plan isn't available to the owner",
				"blocked: unavailable",
			],
			["codex", "blocked", "no request that named this client reached the AS", "deadline"],
		]);
		expect(blocked.data.chatgptWriteToolAccess).toMatchObject({
			owner: WRITE_TOOL_ANSWERS["not-tried"],
			listed: "no",
		});
	});

	test("a failed document keeps its status and its first cause, and no hash", () => {
		const code = rowOf(blocked.rows, "claude-code");
		expect(code.cimd).toStrictEqual([
			{
				kind: "cimd",
				host: "claude.ai",
				fetches: 1,
				statuses: { "404": 1 },
				contentTypes: ["text/html"],
			},
		]);
		// The error page's second lookup ("still remembered") is a consequence, not the cause.
		expect(code.cimdRefused).toStrictEqual([
			"the client document fetch answered HTTP 404 (text/html)",
		]);
		expect(code.authorization).toMatchObject({ requests: 0, errors: ["invalid_client"] });
		expect(blocked.lines.join("\n")).toContain(
			"[claude-code] CIMD refused: the client document fetch answered HTTP 404 (text/html). For the DCR fallback, open the DCR window",
		);
	});

	test("what no client ID names stays with the step it happened in", () => {
		const traffic = blocked.data.traffic as Record<
			string,
			{ unattributed: Record<string, number> }
		>;
		expect(traffic.codex?.unattributed).toStrictEqual({
			"CIMD refused: the document's host isn't allowlisted": 1,
			"authorization error: invalid_client": 1,
			"MCP request without a valid token": 1,
		});
		expect(rowOf(blocked.rows, "codex")).toMatchObject({
			cimdRefused: [],
			authorization: { requests: 0, errors: [] },
		});
	});

	test("a run that leaves clients out is never recorded", () => {
		expect(blocked.data.session).toMatchObject({ complete: false });
		expect(
			recordDecision(true, [plan("claude-code"), plan("chatgpt"), plan("codex")]),
		).toStrictEqual({
			record: false,
			reason: "DRAFTYAK_LIVE_CLIENTS left clients out of this run",
		});
	});
});

describe("a sign-in that names no scope, the self-check's failures and the tailnet route", () => {
	test("a request without a scope gets the session's default, and its row says so", async () => {
		let granted = "";
		const run = await rehearse([plan("claude-ai")], async ({ origin, owner, secrets }) => {
			await owner.step("claude-ai");
			const ai = claudeAi();
			vendor.serveAll(ai.documents);
			const hosted = new ScriptedClient(ai, { origin, approve: owner.approve });
			const { resource } = await hosted.discover();
			const exchanged = await hosted.exchange(await hosted.authorize({ scope: undefined }));
			expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
			granted = String(exchanged.body.scope);
			const token = String(exchanged.body.access_token);
			secrets.push(token, String(exchanged.body.refresh_token));
			const calls = new McpCalls(resource, token);
			await calls.legacy("initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "claude-ai", version: "0.1.0" },
			});
			const listed = await calls.legacy("prompts/list", {}, "2025-06-18");
			expect(listed.body.result.prompts.length).toBeGreaterThan(0);
			await owner.done("claude-ai");
		});
		// inbox:organize stays unticked at consent, as for a request that names it.
		expect(granted.split(" ").sort()).toStrictEqual([
			"drafts:write",
			"inbox:read",
			"outbox:propose",
		]);
		expect(rowOf(run.rows, "claude-ai")).toMatchObject({
			outcome: "ok",
			reason: "connected through CIMD with the session's default scope",
			authorization: { requests: 1, withoutScope: 1, scopes: [], errors: [] },
		});
		expect(run.lines.join("\n")).toContain(
			"[claude-ai] the authorization request named no scope: the session's default applied",
		);
	});

	test("a check that never reaches the AS stops the session, and so does one refused with 421", async () => {
		const lines: string[] = [];
		await using unrouted = await startFunnelStandIn();
		await using quiet = await startLiveSession({
			publicBaseUrl: unrouted.origin,
			views: [stubView()],
			guard: guard(),
			switchFile: path.join(tempDir(), "dcr-window"),
			print: (line) => lines.push(line),
			env: {},
		});
		// The stand-in has no target, so it answers 502 itself and nothing reaches the AS.
		const stopped = await quiet.selfCheck({ budgetMs: 300, everyMs: 50 }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(stopped).toBeInstanceOf(Error);
		const message = (stopped as Error).message;
		expect(message).toContain("this machine can't reach <DY_LIVE_FUNNEL_BASE_URL> (HTTP 502)");
		expect(message).not.toContain(unrouted.origin);
		expect(lines.join("\n")).not.toContain(unrouted.origin);

		// A proxy that sends the AS's own Host and no X-Forwarded-Host: every client would get 421.
		await using rewriting = await startFunnelStandIn({ rewriteHost: true });
		await using refused = await startLiveSession({
			publicBaseUrl: rewriting.origin,
			views: [stubView()],
			guard: guard(),
			switchFile: path.join(tempDir(), "dcr-window"),
			print: () => {},
			env: {},
		});
		rewriting.target = refused.origin;
		await expect(refused.selfCheck({ budgetMs: 2_000, everyMs: 50 })).rejects.toThrow(
			"the proxy reached this AS but got HTTP 421",
		);
	});

	test("over the tailnet, Funnel's public route stays unchecked until the owner starts without it", async () => {
		const identity = {
			"tailscale-user-login": "owner@example.com",
			"tailscale-user-name": "Spike Owner",
		};
		const tailnet = await rehearse(
			[plan("claude-ai", 300)],
			async ({ owner }) => {
				const waiting = await owner.until((view) => view.phase === "route checks");
				expect(waiting.routes.publicIngress).toBe("not confirmed yet");
				expect(await owner.page()).toContain("?check=phone");
				await owner.post("start", {});
			},
			{ standIn: { addHeaders: identity } },
		);
		expect(tailnet.selfCheck).toStrictEqual({ route: "tailnet identity headers" });
		expect(selfCheckMessage(tailnet.selfCheck)).toContain(
			"Funnel's public route is still unchecked",
		);
		expect(tailnet.data.session.routeChecks).toStrictEqual({
			thisMachine: "reached over the tailnet",
			browser: "reached over the tailnet",
			publicIngress: "not confirmed yet",
			startedWith: "owner started without Funnel's public route",
		});
		expect(Object.keys(tailnet.data.proxy)).toStrictEqual(["tailnet identity headers"]);
		expect(tailnet.data.proxy["tailnet identity headers"]).toMatchObject({
			headers: [
				"tailscale-user-login",
				"tailscale-user-name",
				"x-forwarded-for",
				"x-forwarded-host",
				"x-forwarded-proto",
			],
		});
		expect(JSON.stringify(tailnet.data)).not.toContain("example.com");
		expect(rowOf(tailnet.rows, "claude-ai").reason).toBe(
			"no request that named this client reached the AS",
		);
	});

	test("the route checks have a deadline: past it, no step runs", async () => {
		await using standIn = await startFunnelStandIn({
			addHeaders: { "tailscale-user-login": "owner@example.com" },
		});
		await using session = await startLiveSession({
			publicBaseUrl: standIn.origin,
			views: [stubView()],
			guard: guard(),
			switchFile: path.join(tempDir(), "dcr-window"),
			print: () => {},
			env: {},
		});
		standIn.target = session.origin;
		await session.selfCheck({ budgetMs: 2_000, everyMs: 50 });
		await expect(session.run([plan("codex")], undefined, { routeChecksMs: 300 })).rejects.toThrow(
			"the route checks didn't finish within 1 min, so no client step ran",
		);
	});

	test("odd forwarding header names never sink the evidence", async () => {
		const odd = await rehearse([plan("claude-ai", 300)], async () => {}, {
			standIn: {
				addHeaders: {
					"x-forwarded-123456789": "1",
					"tailscale-0f8fad5b-d9cb-469f-a165-70867728950e": "1",
					[`x-forwarded-${"a".repeat(260)}`]: "1",
				},
			},
		});
		expect(odd.data.proxy["no identity headers"]).toMatchObject({
			headers: ["other", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"],
		});
		expect(odd.data.session.valuesReplaced).toBe(0);
		// The last line of defence: a value or key that still fails the kit's rules is replaced.
		expect(
			contentFree({ a: "x-forwarded-123456789", "192.0.2.10": 1, b: ["ok", "sam@example.com"] }),
		).toStrictEqual({ value: { a: "other", b: ["ok", "other"] }, replaced: 3 });
	});
});

describe("the session console", () => {
	const baseView = (): ConsoleView => ({
		mcpUrl: "https://spike.example/mcp",
		checkUrl: `https://spike.example${PRM_PATH}`,
		phase: "steps",
		routes: {
			thisMachine: "reached over the tailnet",
			browser: "reached over the tailnet",
			publicIngress: "confirmed by the phone check",
		},
		step: { client: "chatgpt", title: "ChatGPT developer mode", endsAt: Date.now() + MINUTE },
		instructions: ["a step"],
		pending: [],
		dcr: { open: false, closesAt: undefined },
		cleanup: undefined,
		progress: [],
	});

	test("posts carry the page's own Origin; Origin null, another Origin or another Host is refused", async () => {
		const actions: ConsoleAction[] = [];
		const console_ = await startConsole({
			view: baseView,
			act: (action) => {
				actions.push(action);
				return "recorded";
			},
		});
		try {
			const page = await fetch(`${console_.url}/`);
			// no-referrer made browsers send Origin: null on the page's own posts.
			expect(page.headers.get("referrer-policy")).toBe("same-origin");
			const csp = page.headers.get("content-security-policy") ?? "";
			const html = await page.text();
			expect(html).not.toContain("http-equiv");
			const script = /<script>([^<]+)<\/script>/.exec(html)?.[1] ?? "";
			const hash = createHash("sha256").update(script).digest("base64");
			expect(csp).toContain(`script-src 'sha256-${hash}'`);
			const origin = new URL(console_.url).origin;
			const post = (headers: Record<string, string>) =>
				fetch(`${console_.url}/step`, {
					method: "POST",
					headers,
					body: new URLSearchParams({ client: "claude-ai", action: "done" }),
					redirect: "manual",
				});
			expect((await post({ origin: "null" })).status).toBe(403);
			expect((await post({ origin: "https://evil.example" })).status).toBe(403);
			expect(actions).toStrictEqual([]);
			expect((await post({ origin })).status).toBe(303);
			expect(actions).toStrictEqual([
				{ kind: "step", client: "claude-ai", decision: { kind: "done" } },
			]);
			// DNS rebinding: the console answers only its own Host.
			const rebound = await rawRequest(origin, `${new URL(console_.url).pathname}/`, {
				headers: { host: "rebound.example" },
			});
			expect(rebound.status).toBe(403);
			expect((await fetch(`${origin}/elsewhere/`)).status).toBe(404);
		} finally {
			await console_.close();
		}
	});

	test("Blocked needs a reason, ChatGPT's Done needs the write-tool answer, and the notice says what was recorded", async () => {
		const actions: ConsoleAction[] = [];
		const console_ = await startConsole({
			view: baseView,
			act: (action) => {
				actions.push(action);
				return `recorded ${actions.length}`;
			},
		});
		const owner = new Owner(console_.url);
		try {
			await owner.post("step", { client: "chatgpt", action: "blocked", reason: "" });
			expect(await owner.notice()).toBe("Choose the closest reason, then press Blocked.");
			await owner.post("step", { client: "chatgpt", action: "done" });
			expect(await owner.notice()).toBe(
				"Choose what ChatGPT showed for draft_create, then press Done.",
			);
			expect(actions).toStrictEqual([]);
			await owner.post("step", { client: "chatgpt", action: "blocked", reason: "no-time" });
			await owner.post("step", { client: "chatgpt", action: "done", writeTool: "not-offered" });
			expect(actions).toStrictEqual([
				{
					kind: "step",
					client: "chatgpt",
					decision: { kind: "blocked", reason: "no-time" },
					writeTool: "not-tried",
				},
				{ kind: "step", client: "chatgpt", decision: { kind: "done" }, writeTool: "not-offered" },
			]);
			// The notice stays until the next action, however often the page reloads.
			expect(await owner.notice()).toBe("recorded 2");
			expect(await owner.notice()).toBe("recorded 2");
		} finally {
			await console_.close();
		}
	});

	test("a typed code approves the one waiting sign-in that shows it; another code changes nothing", async () => {
		const run = await rehearse([plan("claude-ai")], async ({ origin, owner }) => {
			await owner.step("claude-ai");
			const ai = claudeAi();
			vendor.serveAll(ai.documents);
			const first = await startSignIn(origin, ai);
			const second = await startSignIn(origin, ai);
			const shown = await owner.until((view) => view.pending.length === 2);
			expect(shown.pending.map((item) => item.ref).sort()).toStrictEqual(
				[first.uid.slice(-6), second.uid.slice(-6)].sort(),
			);
			for (const item of shown.pending) {
				expect(item).toMatchObject({
					client: "claude-ai",
					requester: "127.0.0.1 (loopback)",
					userAgent: "spike-browser/1",
				});
			}
			// Newest first, each with the end of its page's address.
			const page = await owner.page();
			expect(page.indexOf(second.uid.slice(-6))).toBeLessThan(page.indexOf(first.uid.slice(-6)));
			const other = String((Number(first.code) + 1) % 100).padStart(2, "0");
			const unused =
				other === second.code ? String((Number(other) + 1) % 100).padStart(2, "0") : other;
			await owner.post("approve", { code: unused });
			expect(await owner.notice()).toContain(`No waiting sign-in shows code ${unused}`);
			expect((await owner.view()).pending).toHaveLength(2);
			if (first.code === second.code) {
				await owner.post("approve", { code: second.code });
				expect(await owner.notice()).toContain(`2 waiting sign-ins show code ${second.code}`);
				await owner.post("deny", { uid: first.uid });
				await owner.post("approve", { code: second.code });
			} else {
				await owner.post("approve", { code: second.code });
				await owner.post("deny", { uid: first.uid });
			}
			expect((await owner.view()).pending).toStrictEqual([]);
			await owner.done("claude-ai");
		});
		expect(rowOf(run.rows, "claude-ai").consent).toStrictEqual({
			pushed: 2,
			approved: 1,
			denied: 1,
			refused: 0,
		});
	});
});

describe("the clean-up", () => {
	test.each([0, 1, 2])(
		"refresh evidence retains %i actual cleanup grants, independently of accounts success and owner confirmation",
		async (count) => {
			let client: ScriptedClient;
			let token = "";
			let finalRows: readonly Row[] = [];
			const run = await rehearse(
				[plan("claude-ai")],
				async ({ origin, owner, secrets }) => {
					await owner.step("claude-ai");
					const connector = claudeAi();
					vendor.serveAll(connector.documents);
					client = new ScriptedClient(connector, { origin, approve: owner.approve });
					const signed = await signIn(client);
					token = signed.refreshToken;
					secrets.push(signed.accessToken, token);
					const mcp = new McpCalls(signed.mcp, signed.accessToken);
					await mcp.legacy("initialize", {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "claude-ai", version: "0.1.0" },
					});
					expect(
						(await mcp.legacy("tools/call", { name: "accounts_list", arguments: {} }, "2025-06-18"))
							.status,
					).toBe(200);
					await owner.done("claude-ai");
				},
				{
					cleanUp: async ({ session, owner, standIn }) => {
						const cleaning = session.cleanUp({
							deleteEntry: () => [],
							confirmMs: 5_000,
							offMs: 5_000,
							everyMs: 20,
						});
						await owner.until((view) => view.cleanup?.awaitingOwner === true);
						expect(session.recorder.active).toBeUndefined();
						for (let i = 0; i < count; i++) {
							const grant = await client.refresh(token);
							expect(grant.status).toBe(200);
							expect(grant.body.refresh_token).not.toBe(token);
							token = String(grant.body.refresh_token);
						}
						await owner.post("cleanup", {});
						await standIn.close();
						const cleanup = await cleaning;
						finalRows = session.recorder.rows(CLIENTS);
						return cleanup;
					},
				},
			);
			expect(run.cleanup.connectors).toBe("removed (owner confirmed)");
			expect(rowOf(run.rows, "claude-ai").token.refreshes).toBe(0);
			expect(rowOf(run.data.clients, "claude-ai").token.refreshes).toBe(count);
			expect(finalRows.map((row) => row.token.refreshes)).toStrictEqual([count, 0, 0, 0]);
			const row = rowOf(finalRows, "claude-ai");
			expect(row.mcp.tools).toMatchObject({ accounts_list: 1 });
			expect(row.authorization.scopes).not.toContain("offline_access");
			expect(row.mcp.tokenScopes).not.toContain("offline_access");
			expect(row.outcome).toBe(rowOf(run.rows, "claude-ai").outcome);
			const text = summary(finalRows).join("\n");
			expect(text).toContain("refresh grants observed");
			expect(text).toContain(`refreshes ${count}${count === 0 ? " (not observed)" : ""}`);
			for (const secret of [...run.secrets, token]) expect(text).not.toContain(secret);
			expect(text).not.toContain(run.origin);
		},
	);

	test("refresh evidence prompt offers one bounded accounts opportunity before removal and retains the hard stop", () => {
		const [opportunity, removal] = CLEANUP_STEPS;
		expect(opportunity).toContain("up to 10 minutes total");
		expect(opportunity).toContain("one further accounts-list ask per client");
		expect(opportunity).toContain("request/observe refresh");
		expect(opportunity).toContain("accounts result alone is not refresh evidence");
		expect(opportunity).toContain("2 h 30 min of its start");
		expect(removal).toContain("Remove");
	});

	test("cleanup deadline defaults to thirty minutes, with no confirmation inferred from elapsed time", async () => {
		const run = await rehearse([plan("codex", 100)], async () => {}, {
			cleanUp: async ({ session, owner, standIn }) => {
				let now = Date.now();
				const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
				const stop = new AbortController();
				const cleaning = session.cleanUp({
					deleteEntry: () => [],
					offMs: 5_000,
					everyMs: 20,
					signal: stop.signal,
				});
				try {
					await owner.until((view) => view.cleanup?.awaitingOwner === true);
					now += 21 * MINUTE;
					await new Promise((done) => setTimeout(done, 150));
					expect((await owner.view()).cleanup?.awaitingOwner).toBe(true);
					now += 9 * MINUTE - 1;
					await new Promise((done) => setTimeout(done, 150));
					expect((await owner.view()).cleanup?.awaitingOwner).toBe(true);
					now += 1;
					await new Promise((done) => setTimeout(done, 150));
					expect((await owner.view()).cleanup?.awaitingOwner).toBe(false);
					await standIn.close();
					return await cleaning;
				} finally {
					stop.abort();
					await cleaning.catch(() => {});
					clock.mockRestore();
				}
			},
		});
		expect(CLEANUP_CONFIRM_MS).toBe(30 * MINUTE);
		expect(run.cleanup).toMatchObject({
			connectors: "not confirmed",
			funnel: "off",
			revoked: "no",
		});
	});

	test("recorded entry prints fresh post-cleanup refresh evidence and retains the 135-minute outer budget", async () => {
		const source = readFileSync(path.join(import.meta.dirname, "connectors.live.test.ts"), "utf8");
		// Evaluate the entry only after replacing every import and external action with a stand-in.
		// Unknown imports fail closed; no real CLI, live environment, build, server or evidence writer runs.
		const stripped = stripTypeScriptTypes(
			source.replaceAll("import.meta.dirname", JSON.stringify(import.meta.dirname)),
			{ mode: "strip" },
		);
		const script = stripped.replace(
			/import\s+(\{[\s\S]*?\}|\w+)\s+from\s+"([^"]+)";/g,
			(_all, binding: string, name: string) =>
				`const ${binding} = imports(${JSON.stringify(name)});`,
		);
		const events: string[] = [];
		const printed: string[] = [];
		const recorder = new Recorder({
			publicOrigin: new URL("https://synthetic.invalid"),
			cimdHosts: new Set(),
			fixtures: new Map(),
		});
		const initial = recorder.rows();
		const final = initial.map((row, i) => ({
			...row,
			token: { ...row.token, refreshes: [1, 0, 2, 0][i] ?? 0 },
		}));
		let cleaned = false;
		let callback:
			| ((ctx: {
					signal: AbortSignal;
					onTestFinished: (done: () => void) => void;
			  }) => Promise<void>)
			| undefined;
		let timeout = 0;
		const session = {
			selfCheck: async () => ({ route: "tailnet identity headers" }),
			run: async () => {
				events.push("run");
				return initial;
			},
			cleanUp: async (options: { deleteEntry: () => readonly string[] }) => {
				events.push("cleanup");
				await Promise.resolve();
				options.deleteEntry();
				cleaned = true;
			},
			recorder: {
				rows: () => {
					events.push("rows");
					expect(cleaned).toBe(true);
					return final;
				},
				notes: () => [],
			},
			evidence: () => {
				events.push("evidence");
				expect(cleaned).toBe(true);
				return { clients: final };
			},
			[Symbol.asyncDispose]: async () => {},
		};
		const modules: Record<string, unknown> = {
			"node:fs": { mkdtempSync: () => "synthetic-views", rmSync: () => {} },
			"node:os": { tmpdir: () => "synthetic-tmp" },
			"node:path": path,
			"@draftyak/spike-kit": {
				acquireBenchLock: async () => ({ [Symbol.dispose]: () => {} }),
				deleteEnvLive: () => {
					events.push("delete");
					return ["DY_LIVE_FUNNEL_BASE_URL"];
				},
				fingerprint: async () => ({ dirty: false }),
				loadEnvLive: () => ({
					DY_LIVE_FUNNEL_BASE_URL: { reveal: () => "https://synthetic.invalid" },
				}),
				skipOrFail: () => {
					throw new Error("unexpected skip");
				},
				writeEvidence: async (_file: string, data: unknown) => {
					events.push("write");
					expect(data).toStrictEqual({ clients: final });
					return "synthetic-evidence";
				},
			},
			"@draftyak/spike-s03-mcp-sdk/src/apps.ts": { loadViews: () => [] },
			"@draftyak/spike-s03-mcp-sdk/views/build.ts": { buildViews: async () => {} },
			vitest: {
				expect,
				it: (_title: string, options: { timeout: number }, run: typeof callback) => {
					timeout = options.timeout;
					callback = run;
				},
			},
			"./live/session.ts": {
				LIVE_PORT: 47615,
				LIVE_CLEANUP_MS,
				livePlans: () => livePlans({}),
				recordDecision,
				recordingRequested: () => true,
				selfCheckMessage,
				startLiveSession: async () => session,
				summary,
			},
		};
		const boundary = {
			imports: (name: string) => {
				if (!Object.hasOwn(modules, name)) throw new Error("unapproved entry import");
				return modules[name];
			},
			process: { stderr: { write: (line: string) => printed.push(line) } },
		};
		const vmOptions = { contextCodeGeneration: { strings: false, wasm: false } };
		for (const name of ["node:child_process", "node:net", "node:dns", "node:https"])
			expect(() => boundary.imports(name)).toThrow("unapproved entry import");
		expect(
			runInNewContext("[typeof fetch, typeof require, typeof process.env]", boundary, vmOptions),
		).toEqual(["undefined", "undefined", "undefined"]);
		expect(() => runInNewContext("Function('return 1')()", boundary, vmOptions)).toThrow(
			/Code generation/,
		);
		runInNewContext(script, boundary, vmOptions);
		expect(timeout).toBe(135 * MINUTE);
		expect(callback).toBeTypeOf("function");
		if (!callback) throw new Error("entry test was not registered");
		await callback({ signal: new AbortController().signal, onTestFinished: () => {} });
		expect(events).toStrictEqual(["run", "cleanup", "delete", "rows", "evidence", "write"]);
		const text = printed.join("\n");
		expect(text).toContain("Final results (after clean-up):");
		expect(text).toMatch(/claude-ai\s+\|[^\n]+refreshes 1/);
		expect(text).toMatch(/claude-code\s+\|[^\n]+refreshes 2/);
		expect(text).toMatch(/chatgpt\s+\|[^\n]+refreshes 0 \(not observed\)/);
		expect(text).not.toContain("https://synthetic.invalid");
	});

	const cleanUp =
		(options: { readonly stopFunnel: boolean; readonly deleted: string[] }) =>
		async ({
			session,
			owner,
			standIn,
		}: {
			readonly session: LiveSession;
			readonly owner: Owner;
			readonly standIn: FunnelStandIn;
		}): Promise<Cleanup> => {
			const cleaning = session.cleanUp({
				deleteEntry: () => {
					options.deleted.push("DY_LIVE_FUNNEL_BASE_URL");
					return ["DY_LIVE_FUNNEL_BASE_URL"];
				},
				confirmMs: 5_000,
				offMs: options.stopFunnel ? 5_000 : 600,
				everyMs: 50,
			});
			await owner.until((view) => view.cleanup?.awaitingOwner === true);
			await owner.post("cleanup", {});
			if (options.stopFunnel) await standIn.close();
			return cleaning;
		};

	test("once the owner removed the connectors and Funnel stopped: the entry goes and revoked is yes", async () => {
		const deleted: string[] = [];
		const run = await rehearse([plan("codex", 200)], async () => {}, {
			cleanUp: cleanUp({ stopFunnel: true, deleted }),
		});
		expect(run.cleanup).toStrictEqual({
			connectors: "removed (owner confirmed)",
			funnel: "off",
			entry: "deleted",
			asState: "in memory only, ended with this run",
			revoked: "yes",
		});
		expect(deleted).toStrictEqual(["DY_LIVE_FUNNEL_BASE_URL"]);
		expect(run.data.session).toMatchObject({ cleanup: run.cleanup, revoked: "yes" });
		expect(run.lines.join("\n")).toContain("Clean-up (the console shows the same):");
	});

	test("while Funnel still forwards to the AS: the entry stays and revoked is no", async () => {
		const deleted: string[] = [];
		const run = await rehearse([plan("codex", 200)], async () => {}, {
			cleanUp: cleanUp({ stopFunnel: false, deleted }),
		});
		expect(run.cleanup).toMatchObject({
			funnel: "still forwarding to this AS",
			entry: "kept",
			revoked: "no",
		});
		expect(deleted).toStrictEqual([]);
		expect(run.lines.join("\n")).toContain("Funnel still forwards to this AS: press Ctrl+C");
	});
});

describe("the session's parts", () => {
	test("livePlans: all four clients for 15 minutes each, or the listed ones", () => {
		expect(livePlans({})).toStrictEqual(CLIENTS.map((client) => plan(client, 15 * MINUTE)));
		expect(
			livePlans({ DRAFTYAK_LIVE_CLIENTS: "codex, chatgpt", DRAFTYAK_LIVE_CLIENT_MINUTES: "5" }),
		).toStrictEqual([plan("codex", 5 * MINUTE), plan("chatgpt", 5 * MINUTE)]);
		for (const env of [
			{ DRAFTYAK_LIVE_CLIENTS: "copilot" },
			{ DRAFTYAK_LIVE_CLIENTS: "codex,codex" },
			{ DRAFTYAK_LIVE_CLIENT_MINUTES: "0" },
			{ DRAFTYAK_LIVE_CLIENT_MINUTES: "1.5" },
		]) {
			expect(() => livePlans(env), JSON.stringify(env)).toThrow();
		}
	});

	test("the recording decision the live test makes: asked for, and all four clients in any order", () => {
		expect(recordingRequested({})).toBe(false);
		expect(recordingRequested({ DRAFTYAK_RECORD_EVIDENCE: "0" })).toBe(false);
		expect(recordingRequested({ DRAFTYAK_RECORD_EVIDENCE: "1" })).toBe(true);
		expect(() => recordingRequested({ DRAFTYAK_RECORD_EVIDENCE: "true" })).toThrow(
			'DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "true"',
		);
		const all = livePlans({});
		const reordered = livePlans({ DRAFTYAK_LIVE_CLIENTS: "codex claude-code chatgpt claude-ai" });
		const subset = livePlans({ DRAFTYAK_LIVE_CLIENTS: "codex" });
		expect([isCompleteRun(all), isCompleteRun(reordered), isCompleteRun(subset)]).toStrictEqual([
			true,
			true,
			false,
		]);
		expect(recordDecision(true, all)).toStrictEqual({
			record: true,
			reason: "all four clients ran",
		});
		expect(recordDecision(true, reordered).record).toBe(true);
		expect(recordDecision(true, subset)).toStrictEqual({
			record: false,
			reason: "DRAFTYAK_LIVE_CLIENTS left clients out of this run",
		});
		expect(recordDecision(false, all)).toStrictEqual({
			record: false,
			reason: "run with DRAFTYAK_RECORD_EVIDENCE=1 to record",
		});
	});

	test("identify: the recorded documents, Codex's on chatgpt.com, then registered names", () => {
		for (const name of ["claude-ai", "claude-code", "chatgpt"] as const) {
			expect(identify(String(recorded(name).document.client_id))).toBe(name);
		}
		expect(identify("https://chatgpt.com/oauth/codex/client.json")).toBe("codex");
		expect(identify("https://chatgpt.com/oauth/abc123/client.json")).toBe("chatgpt");
		expect(identify(recorded("chatgpt-jwks").source, undefined, "codex")).toBe("chatgpt");
		// Another ID on a vendor's host: the vendor's client whose step is active, else the hosted one.
		expect(identify("https://chatgpt.com/oauth/abc123/client.json", undefined, "codex")).toBe(
			"codex",
		);
		const otherOnClaude = "https://claude.ai/clients/other-metadata";
		expect(identify(otherOnClaude, undefined, "claude-code")).toBe("claude-code");
		expect(identify(otherOnClaude, undefined, "chatgpt")).toBe("claude-ai");
		expect(identify("random-id", { clientName: "Codex CLI", redirectUris: [] })).toBe("codex");
		expect(identify("random-id", { clientName: "Claude Code (x)", redirectUris: [] })).toBe(
			"claude-code",
		);
		expect(
			identify("random-id", { clientName: "x", redirectUris: ["https://chatgpt.com/cb"] }),
		).toBe("chatgpt");
		// An unknown ID names no client, whichever step is active.
		expect(identify("random-id", { clientName: "x", redirectUris: [] }, "codex")).toBeUndefined();
		expect(identify("https://agent.example/client.json", undefined, "codex")).toBeUndefined();
	});

	test("redirectShape: loopback hosts by kind, ports by kind, path ids left out", () => {
		expect(redirectShape("https://chatgpt.com/connector/oauth/XuuuHAzzHOni")).toStrictEqual({
			scheme: "https",
			host: "chatgpt.com",
			port: "default",
			path: "/connector/oauth/{id}",
		});
		expect(redirectShape("http://127.0.0.1:61234/callback/AbC_9-xYz")).toStrictEqual({
			scheme: "http",
			host: "loopback IPv4",
			port: "loopback port",
			path: "/callback/{id}",
		});
		expect(redirectShape("http://127.0.0.1/callback")).toMatchObject({ port: "none" });
		expect(redirectShape("http://[::1]:5000/cb")).toMatchObject({ host: "loopback IPv6" });
		expect(redirectShape("https://192.0.2.10:8443/x")).toMatchObject({
			host: "other",
			port: "8443",
		});
		expect(redirectShape("https://box.tail1234.ts.net/x").host).not.toContain("ts.net");
		expect(redirectShape("not a url")).toMatchObject({ host: "other" });
	});

	test("addressClass and canaryOutcome: classes and outcomes, never an address", () => {
		expect(
			[
				"127.0.0.1",
				"::1",
				"100.101.102.103",
				"fd7a:115c:a1e0::1",
				"10.1.2.3",
				"fd00::1",
				"169.254.1.1",
				"192.0.2.7",
				"160.79.104.10",
				"160.79.112.1",
				"::ffff:160.79.104.10",
				"not-an-ip",
				undefined,
			].map(addressClass),
		).toStrictEqual([
			"loopback",
			"loopback",
			"tailnet",
			"tailnet",
			"private",
			"private",
			"link-local",
			"documentation",
			"Anthropic egress",
			"public",
			"Anthropic egress",
			"not an address",
			"none",
		]);
		expect([
			canaryOutcome(undefined, "192.0.2.1"),
			canaryOutcome("192.0.2.1", "192.0.2.1"),
			canaryOutcome("192.0.2.1, 100.64.0.9", "192.0.2.1"),
			canaryOutcome("100.64.0.9", "192.0.2.1"),
			canaryOutcome("for=192.0.2.2;proto=https", "for=192.0.2.2"),
		]).toStrictEqual(["dropped", "passed through", "appended to", "replaced", "passed through"]);
	});

	test("the public base URL: a malformed one is refused without being shown", async () => {
		for (const value of [
			"machine.tailnet-example.ts.net",
			"https://x.example/path",
			"http://x.example",
		]) {
			const error = await startLiveSession({
				publicBaseUrl: value,
				views: [stubView()],
				guard: guard(),
				switchFile: path.join(tempDir(), "dcr-window"),
				print: () => {},
				env: {},
			}).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			expect(error).toBeInstanceOf(Error);
			expect(Object.keys(error as object)).toStrictEqual([]);
			expect((error as Error).message).not.toContain(value);
			expect((error as Error).message).toContain("DY_LIVE_FUNNEL_BASE_URL must be https://<host>");
		}
	});

	test("a port another process holds is named, with how to find that process", async () => {
		const holder = createServer();
		await new Promise<void>((resolve) => holder.listen(0, "127.0.0.1", resolve));
		const port = (holder.address() as AddressInfo).port;
		try {
			await expect(
				startLiveSession({
					publicBaseUrl: "https://spike.example",
					port,
					views: [stubView()],
					guard: guard(),
					switchFile: path.join(tempDir(), "dcr-window"),
					print: () => {},
					env: {},
				}),
			).rejects.toThrow(`127.0.0.1:${port} is already in use: find the process with`);
		} finally {
			await new Promise((done) => holder.close(done));
		}
	});

	test("the write tool needs drafts:write, and the row says when a token lacked it", async () => {
		const run = await rehearse([plan("chatgpt")], async ({ origin, owner, secrets }) => {
			await owner.step("chatgpt");
			const gpt = chatgpt();
			vendor.serveAll(gpt.documents);
			const client = new ScriptedClient(gpt, { origin, approve: owner.approve });
			const signed = await signIn(client, { scope: "inbox:read" });
			secrets.push(signed.accessToken, signed.refreshToken);
			const calls = new McpCalls(signed.mcp, signed.accessToken);
			await calls.legacy("initialize", {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "openai-mcp", version: "1.0.0" },
			});
			await calls.legacy("tools/list", {}, "2025-11-25");
			const refused = await calls.legacy(
				"tools/call",
				{ name: "draft_create", arguments: { conversationId: CONVERSATION_ID } },
				"2025-11-25",
			);
			expect(refused.body.result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "This token lacks drafts:write." }],
			});
			await owner.done("chatgpt", "blocked");
		});
		expect(rowOf(run.rows, "chatgpt").mcp).toMatchObject({
			writeTool: { listed: 1, called: 1, refusedWithoutScope: 1 },
			tokenScopes: ["inbox:read"],
		});
		expect(run.data.chatgptWriteToolAccess).toStrictEqual({
			owner: WRITE_TOOL_ANSWERS.blocked,
			listed: "yes",
			called: 1,
			refusedWithoutScope: 1,
		});
	});

	test("the MCP endpoint takes only the public host and the AS's tokens", async () => {
		await using standIn = await startFunnelStandIn();
		await using session = await startLiveSession({
			publicBaseUrl: standIn.origin,
			views: [stubView()],
			guard: guard(),
			switchFile: path.join(tempDir(), "dcr-window"),
			print: () => {},
			env: {},
		});
		standIn.target = session.origin;
		const unauthenticated = await fetch(`${standIn.origin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		});
		expect(unauthenticated.status).toBe(401);
		expect(unauthenticated.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${standIn.origin}${PRM_PATH}", scope="${SCOPES.join(" ")}"`,
		);
		// Straight to the loopback port, naming the loopback host: neither the AS nor the MCP endpoint.
		for (const target of ["/mcp", PRM_PATH]) {
			expect((await fetch(`${session.origin}${target}`)).status, target).toBe(421);
		}
		const html = await (await fetch(`${session.consoleUrl}/`)).text();
		expect(html).toContain(`${standIn.origin}/mcp`);
		expect(html).toContain(`${standIn.origin}${PRM_PATH}?check=phone`);
	});
});
