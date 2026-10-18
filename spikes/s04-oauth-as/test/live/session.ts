// The live session (M0.20): the spike AS and the fake-data MCP endpoint on loopback behind a proxy
// (Tailscale Funnel live, a loopback stand-in in the rehearsal), composed as M0.19's handoff says,
// with the route checks, a console for the owner's typed codes, one step per client, the recorder's
// rows, the clean-up and the evidence. The live test and the rehearsal drive this same code.
import type { IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { View } from "@draftyak/spike-s03-mcp-sdk/src/apps.ts";
import { Hono } from "hono";
import type { Client, Provider } from "oidc-provider";
import { CIMD_HOSTS, cimd, type GuardOptions, withoutLoopbackPort } from "../../src/cimd.ts";
import {
	type ConsentEntry,
	type ConsentRequest,
	ConsentStub,
	type Limits,
} from "../../src/consent.ts";
import { DcrWindow, dcrWindowRequested, switchFile } from "../../src/dcr-window.ts";
import { createProvider, MCP_PATH, ROUTES, SCOPES } from "../../src/provider.ts";
import { behindProxy, ProxyTrust, serveBehindProxy } from "../../src/proxy.ts";
import { createApp, type Env, PRM_PATH, type Running } from "../../src/routes.ts";
import {
	type ConsoleAction,
	type ConsoleView,
	type PendingSignIn,
	type Phase,
	type SessionConsole,
	startConsole,
} from "./console.ts";
import { CONVERSATION_ID, DRAFT_ID, liveMcp } from "./mcp.ts";
import {
	addressClass,
	CANARIES,
	CLIENTS,
	type ClientName,
	type Decision,
	type LiveData,
	OWNER_REASONS,
	Recorder,
	type Route,
	type Row,
	routeOf,
	SELF_CHECK_HEADER,
	SESSION_DCR_RULE,
	TITLES,
	WRITE_TOOL,
	WRITE_TOOL_ANSWERS,
	type WriteToolAnswer,
} from "./record.ts";

// Plan §1: L3 listens on 127.0.0.1:47615 behind the owner's TLS proxy; Funnel forwards there.
export const LIVE_PORT = 47615;
export const SERVER_NAME = "draftyak-spike";
// Short-lived access tokens, so a client's refresh and the rotation show within its step.
export const LIVE_ACCESS_TOKEN_TTL: number = 10 * 60;
const MINUTE = 60_000;

export interface StepPlan {
	readonly client: ClientName;
	readonly deadlineMs: number;
}

export interface LiveOptions {
	// https://<host> with no path: the issuer and the MCP server's public origin.
	readonly publicBaseUrl: string;
	readonly port?: number;
	readonly views: readonly View[];
	// The rehearsal's fake vendor host; live runs use DNS and Node's bundled roots.
	readonly guard?: Pick<GuardOptions, "resolve" | "dial" | "ca">;
	readonly switchFile?: string;
	readonly watchEveryMs?: number;
	readonly accessTokenTtl?: number;
	readonly consentLimits?: Partial<Limits>;
	readonly print?: (line: string) => void;
	readonly env?: NodeJS.ProcessEnv;
}

export interface SelfCheck {
	readonly route: Route;
}

export interface SelfCheckOptions {
	readonly budgetMs?: number;
	readonly everyMs?: number;
	readonly reportEveryMs?: number;
	readonly signal?: AbortSignal;
}

export interface RunOptions {
	// How long the route checks may take before the session stops.
	readonly routeChecksMs?: number;
}

export interface CleanUpOptions {
	// Removes DY_LIVE_FUNNEL_BASE_URL (deleteEnvLive); returns the names that were present.
	readonly deleteEntry: () => readonly string[];
	readonly signal?: AbortSignal;
	readonly confirmMs?: number;
	readonly offMs?: number;
	readonly everyMs?: number;
}

export interface Cleanup {
	readonly connectors: "removed (owner confirmed)" | "not confirmed";
	readonly funnel: "off" | "still forwarding to this AS";
	readonly entry: "deleted" | "absent" | "kept";
	readonly asState: "in memory only, ended with this run";
	readonly revoked: "yes" | "no";
}

export interface LiveSession extends AsyncDisposable {
	readonly origin: string;
	readonly publicOrigin: URL;
	readonly consoleUrl: string;
	readonly recorder: Recorder;
	readonly window: DcrWindow;
	selfCheck(options?: SelfCheckOptions): Promise<SelfCheck>;
	run(plans: readonly StepPlan[], signal?: AbortSignal, options?: RunOptions): Promise<Row[]>;
	cleanUp(options: CleanUpOptions): Promise<Cleanup>;
	evidence(plans: readonly StepPlan[], startedAt: number): LiveData;
	close(): Promise<void>;
}

// What the owner does in each client. Menu paths and commands follow the vendors' docs as checked
// on 2026-10-18 (notes/session.md cites them); the terminal shows the URL as a placeholder.
export function instructions(client: ClientName, mcpUrl: string): string[] {
	const try_ = [
		`ask it to list the DraftYak accounts (tool accounts_list)`,
		`ask it to show DraftYak draft ${DRAFT_ID} (tool draft_get; a view may render)`,
	];
	const steps: Record<ClientName, string[]> = {
		"claude-ai": [
			"In claude.ai: Customize > Connectors > + Add > Add custom connector. (Team or Enterprise: an Owner adds it under Organization settings > Connectors > Add > Custom > Web, then you Connect it from Customize > Connectors.)",
			`Name: DraftYak S4 spike. URL: ${mcpUrl}. Continue.`,
			"Authentication: Sign in now. OAuth client: Use Claude's published identity (Recommended). Add. (A one-screen dialog with Advanced settings: leave them empty and Add.)",
			"A DraftYak sign-in page shows a 2-digit code: type it in this session's console.",
			"In a new chat, + > Connectors: turn on DraftYak S4 spike, then:",
			...try_.map((line) => `  - ${line}`),
			"  - from the + menu, add the triage_inbox prompt and the agents guide resource, if offered",
			"If sign-in fails at client registration: open the DCR window, remove the connector and add it again with OAuth client: Register automatically.",
		],
		chatgpt: [
			"In ChatGPT: Plugins > + > Add custom MCP server (turn developer mode on first if ChatGPT asks).",
			`Name and description: DraftYak S4 spike. Connection: Public endpoint, URL: ${mcpUrl}. Authentication: OAuth.`,
			'Review the warning ("I understand and want to continue"), then Create as a plugin, review the tools and install it.',
			"Sign in: type the 2-digit code from the DraftYak page in this session's console.",
			"In a new chat, type @ and pick the plugin, then:",
			...try_.map((line) => `  - ${line}`),
			`  - ask it to create a DraftYak draft reply in conversation ${CONVERSATION_ID} (the write tool ${WRITE_TOOL})`,
			`In the console, choose what ChatGPT showed for ${WRITE_TOOL}: offered and ran, offered but blocked, or not offered.`,
			"If sign-in fails at client registration: open the DCR window, remove the plugin and add it again, choosing DCR if ChatGPT offers the choice.",
		],
		"claude-code": [
			"In your own terminal, in an empty folder:",
			`  claude mcp add --transport http ${SERVER_NAME} ${mcpUrl}`,
			`  claude mcp login ${SERVER_NAME}`,
			"  (or start claude there, open /mcp and follow its browser sign-in)",
			"Type the 2-digit code from the DraftYak page in this session's console.",
			"Then start claude in that folder and:",
			`  - run /mcp__${SERVER_NAME}__triage_inbox (a prompt; an account form there is elicitation)`,
			`  - mention @${SERVER_NAME}:draftyak://guide/agents (a resource)`,
			...try_.map((line) => `  - ${line}`),
		],
		codex: [
			"In your own terminal (codex mcp add --help shows the flags, if one is refused):",
			`  codex mcp add ${SERVER_NAME} --url ${mcpUrl}`,
			`  codex mcp login ${SERVER_NAME}`,
			"Type the 2-digit code from the DraftYak page in this session's console.",
			`Then start codex and ${try_[0]}.`,
			`If login fails at client registration: open the DCR window, then run codex mcp login ${SERVER_NAME} --oauth-client-registration dcr`,
		],
	};
	return [
		...steps[client],
		"When you're done, press Done in the console (or Blocked, with the closest reason).",
	];
}

// The owner's clean-up, while the AS still runs: a client that revokes its tokens reaches it.
export const CLEANUP_STEPS: readonly string[] = [
	"1. claude.ai: Customize > Connectors, then Remove on DraftYak S4 spike (or its three-dot menu).",
	"2. ChatGPT: remove the DraftYak S4 spike plugin.",
	`3. Your terminal, in the folder you used: claude mcp remove ${SERVER_NAME}`,
	`4. Your terminal: codex mcp logout ${SERVER_NAME}, then codex mcp remove ${SERVER_NAME} (codex mcp --help confirms both).`,
	'5. Press "I removed the connectors" in the console.',
	"6. Stop Funnel: Ctrl+C in its terminal. The test then checks that the public address no longer reaches this AS.",
];

// M0.17's handoff asks this session for each local client's era and elicitation modes, its request
// timeouts, whether progress resets them, and whether a 2025-06-18 host takes the 2026-shaped form.
// The endpoint has no slow tool and its 2025 leg never sends a form, so only the first is recorded.
const ADR_0005: Readonly<Record<string, string>> = {
	eraAndElicitationModes: "recorded per client",
	requestTimeouts: "not measured",
	progressResets: "not measured",
	form2025: "not tested",
};

// Which clients a run covers (DRAFTYAK_LIVE_CLIENTS, default all four) and each one's deadline
// (DRAFTYAK_LIVE_CLIENT_MINUTES, default 15).
export function livePlans(env: NodeJS.ProcessEnv = process.env): StepPlan[] {
	const minutes = Number(env.DRAFTYAK_LIVE_CLIENT_MINUTES || "15");
	if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
		throw new Error("DRAFTYAK_LIVE_CLIENT_MINUTES is a whole number of minutes from 1 to 60");
	}
	const listed = (env.DRAFTYAK_LIVE_CLIENTS ?? "").split(/[\s,]+/).filter(Boolean);
	const unknown = listed.filter((name) => !CLIENTS.includes(name as ClientName));
	if (unknown.length > 0 || new Set(listed).size !== listed.length) {
		throw new Error(`DRAFTYAK_LIVE_CLIENTS lists each of ${CLIENTS.join(", ")} at most once`);
	}
	const clients = listed.length > 0 ? (listed as ClientName[]) : [...CLIENTS];
	return clients.map((client) => ({ client, deadlineMs: minutes * MINUTE }));
}

// All four clients, in any order.
export const isCompleteRun = (plans: readonly StepPlan[]): boolean =>
	plans.length === CLIENTS.length &&
	CLIENTS.every((client) => plans.some((p) => p.client === client));

export function recordingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1";
}

// Evidence comes only from a run asked to record that covered all four clients; such a run also
// does the clean-up.
export function recordDecision(
	requested: boolean,
	plans: readonly StepPlan[],
): { readonly record: boolean; readonly reason: string } {
	if (!requested) return { record: false, reason: "run with DRAFTYAK_RECORD_EVIDENCE=1 to record" };
	if (!isCompleteRun(plans)) {
		return { record: false, reason: "DRAFTYAK_LIVE_CLIENTS left clients out of this run" };
	}
	return { record: true, reason: "all four clients ran" };
}

export function selfCheckMessage(check: SelfCheck): string {
	return check.route === "tailnet identity headers"
		? "This machine reaches the AS over the tailnet (Tailscale serve's identity headers). Funnel's public route is still unchecked: the console asks for the phone check."
		: "This machine reaches the AS through Funnel's public ingress (no identity headers).";
}

export function summary(rows: readonly Row[], notes: readonly string[] = []): string[] {
	const yes = (value: boolean): string => (value ? "yes" : "no");
	const lines = rows.map((row) =>
		[
			row.client.padEnd(12),
			row.outcome.padEnd(9),
			row.era.padEnd(5),
			(row.registration.join("+") || "-").padEnd(9),
			`prompts ${yes(row.surfaces.prompts)}, resources ${yes(row.surfaces.resources)}, completion ${yes(row.surfaces.completion)}, elicitation ${yes(row.surfaces.elicitation)}, apps ${yes(row.surfaces.apps)}`,
			`DCR fallback verified: ${row.dcrFallbackVerified}`,
			row.reason,
		].join(" | "),
	);
	return [
		"client       | outcome   | era   | via       | surfaces used | DCR | reason",
		...lines,
		...notes,
	];
}

// RFC 6749 §3.3 leaves a request without a scope to a default or an invalid_scope error; the spike
// AS has neither, and finishes such a sign-in with access_denied after the owner's approval. For
// this session only, such a request gets §6's scopes, as the MCP endpoint's challenge names them;
// the recorder counts it per client, for M9 to set the AS's own rule.
function defaultScope(provider: Provider, recorder: Recorder): void {
	provider.use(async (ctx, next) => {
		// Koa's query string, which src/oidc-provider.d.ts leaves out.
		const request = ctx as typeof ctx & { querystring: string };
		if (ctx.method === "GET" && ctx.path === ROUTES.authorization) {
			const query = new URLSearchParams(request.querystring);
			if (!query.get("scope")?.trim()) {
				query.set("scope", SCOPES.join(" "));
				request.querystring = query.toString();
				recorder.scopeDefaulted(ctx.req);
			}
		}
		await next();
	});
}

// Session only (RFC 8252 §7.3): any loopback port for a client registered in the DCR window whose
// redirect URIs are all loopback. Codex registers http://127.0.0.1/callback without its port and
// adds its listener's port when it signs in (learn.chatgpt.com, Codex MCP), while plan §6 and cimd's
// rule give port-free matching to allowlisted CIMD clients only, so its DCR fallback would be
// refused. The recorder notes which rule let each redirect through, for M9 to decide.
function loopbackForRegistered(provider: Provider, recorder: Recorder): void {
	const prototype = provider.Client.prototype;
	const cimdRule = prototype.redirectUriAllowed;
	prototype.redirectUriAllowed = function (this: Client, value: string): boolean {
		if (this.redirectUris.includes(value)) {
			recorder.redirectMatched(this.clientId, "exact");
			return true;
		}
		if (cimdRule.call(this, value)) {
			recorder.redirectMatched(this.clientId, "any loopback port (cimd's rule for CIMD clients)");
			return true;
		}
		const portless = withoutLoopbackPort(value);
		const allowed =
			this.clientIdMetadataDocument !== true &&
			portless !== undefined &&
			this.redirectUris.length > 0 &&
			this.redirectUris.every((uri) => withoutLoopbackPort(uri) !== undefined) &&
			this.redirectUris.some((uri) => withoutLoopbackPort(uri) === portless);
		if (allowed) recorder.redirectMatched(this.clientId, SESSION_DCR_RULE);
		return allowed;
	};
}

// The consent stub, also keeping each pending sign-in's code, so the owner's typed code approves the
// one sign-in whose page shows it, and never denies another by mistake.
class SessionConsent extends ConsentStub {
	readonly codes = new Map<string, string>();

	override open(request: ConsentRequest, ttlMs: number): ConsentEntry {
		const entry = super.open(request, ttlMs);
		if (entry.state === "pending") this.codes.set(request.uid, entry.code);
		return entry;
	}
}

async function waitFor(ready: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
	const until = Date.now() + ms;
	while (!ready()) {
		if (Date.now() >= until) return false;
		await sleep(100, undefined, signal ? { signal } : {});
	}
	return true;
}

export async function startLiveSession(options: LiveOptions): Promise<LiveSession> {
	const publicOrigin = URL.parse(options.publicBaseUrl);
	if (
		publicOrigin?.protocol !== "https:" ||
		publicOrigin.username !== "" ||
		publicOrigin.password !== "" ||
		publicOrigin.origin !== options.publicBaseUrl.replace(/\/$/, "")
	) {
		// The value itself never goes into an error, a log or the evidence.
		throw new Error(
			"DY_LIVE_FUNNEL_BASE_URL must be https://<host>, with no path, query or credentials",
		);
	}
	const print = options.print ?? ((line: string) => process.stderr.write(`${line}\n`));
	const ttl = options.accessTokenTtl ?? LIVE_ACCESS_TOKEN_TTL;
	const trust = new ProxyTrust(["127.0.0.1", "::1"]);
	const policy = cimd({
		...options.guard,
		hosts: [...CIMD_HOSTS],
		onAssertion: (form) => recorder.assertion(form),
	});
	const recorder = new Recorder({
		publicOrigin,
		cimdHosts: policy.hosts,
		clientIp: (incoming) => trust.clientIp(incoming),
	});
	const progress: string[] = [];
	recorder.onProgress((client, text) => {
		const line = `[${client ?? "session"}] ${text}`;
		progress.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
		print(line);
	});

	const window = new DcrWindow();
	const open = window.open.bind(window);
	let windowClosesAt = 0;
	window.open = () => {
		windowClosesAt = open();
		recorder.dcrOpened();
		return windowClosesAt;
	};
	if (dcrWindowRequested(options.env)) window.open();

	const pushed = new Map<string, { readonly request: ConsentRequest; readonly at: number }>();
	const consent = new SessionConsent({
		...(options.consentLimits ? { limits: options.consentLimits } : {}),
		onPush: (request) => {
			pushed.set(request.uid, { request, at: Date.now() });
			recorder.consentPushed(request);
		},
	});

	let phase: Phase = "route checks";
	const routes = {
		thisMachine: "not checked yet",
		browser: "not checked yet",
		publicIngress: "not confirmed yet",
	};
	let browserChecked = false;
	let publicConfirmed = false;
	let startedWithout: string | undefined;
	let routeChecks = "not run";
	let selfCheckArrivals = 0;
	let selfCheckRoute: Route | undefined;
	let cleanedUp = false;
	let cleanupView: ConsoleView["cleanup"];
	let cleanupResult: Cleanup | undefined;

	const tell = (text: string): void => {
		progress.push(`${new Date().toISOString().slice(11, 19)} [session] ${text}`);
		print(`[session] ${text}`);
	};
	// The browser and phone checks, and whether anything came through Funnel's public ingress: no
	// identity headers, with the public host named, from the trusted proxy.
	const routeCheck = (incoming: IncomingMessage, selfCheck: boolean): void => {
		const route = routeOf(incoming.headers);
		const named = incoming.headers["x-forwarded-host"] ?? incoming.headers.host;
		const viaPublic = route === "no identity headers" && named === publicOrigin.host;
		const check = new URLSearchParams((incoming.url ?? "").split("?")[1] ?? "").get("check");
		if (check === "browser" && !browserChecked) {
			browserChecked = true;
			routes.browser = viaPublic
				? "reached through Funnel's public ingress"
				: route === "tailnet identity headers"
					? "reached over the tailnet"
					: "reached";
			tell(`your browser's check arrived (${routes.browser})`);
		}
		if (check === "phone" && route === "tailnet identity headers") {
			tell(
				"the phone's check came over the tailnet: turn Tailscale off on the phone, use mobile data and open the address again",
			);
		}
		if (viaPublic && !publicConfirmed) {
			publicConfirmed = true;
			routes.publicIngress =
				check === "phone"
					? "confirmed by the phone check"
					: selfCheck
						? "confirmed by this machine's own check"
						: "confirmed by a request through Funnel's public ingress";
			tell(`Funnel's public route: ${routes.publicIngress}`);
		}
	};

	const switching = window.watch(options.switchFile ?? switchFile(), options.watchEveryMs);
	let running: Running;
	try {
		running = await serveBehindProxy(
			() => {
				const provider = createProvider({
					issuer: publicOrigin.origin,
					configure: (configuration) => {
						policy.configure(configuration);
						window.configure(configuration);
						recorder.configure(configuration);
						configuration.ttl = { ...(configuration.ttl as object), AccessToken: ttl };
					},
				});
				policy.install(provider);
				window.install(provider);
				loopbackForRegistered(provider, recorder);
				recorder.attach(provider);
				defaultScope(provider, recorder);
				const as = createApp({
					provider,
					consent,
					routes: [window.route],
					...behindProxy(provider, trust),
				});
				const mcp = liveMcp({ provider, publicOrigin, views: options.views, recorder });
				return new Hono<Env>()
					.all(MCP_PATH, (c) => mcp.fetch(c.req.raw, c.env))
					.all("*", (c) => as.fetch(c.req.raw, c.env));
			},
			{
				trust,
				...(options.port === undefined ? {} : { port: options.port }),
				observe: (incoming) => {
					const trusted = trust.trusts(incoming.socket.remoteAddress);
					const selfCheck = incoming.headers[SELF_CHECK_HEADER] !== undefined;
					if (trusted && selfCheck) {
						selfCheckArrivals += 1;
						selfCheckRoute = routeOf(incoming.headers);
						recorder.selfCheckArrival(incoming);
					}
					recorder.arrival(incoming, trusted);
					if (trusted) routeCheck(incoming, selfCheck);
					const target = (incoming.url ?? "").split("?")[0];
					if (incoming.method === "POST" && target === ROUTES.registration && !window.isOpen) {
						recorder.registrationRefused();
					}
				},
			},
		);
	} catch (error) {
		switching[Symbol.dispose]();
		if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
			throw new Error(
				`127.0.0.1:${options.port} is already in use: find the process with \`netstat -ano | findstr :${options.port}\`, stop it, then start the test again`,
			);
		}
		throw error;
	}

	let step:
		| {
				client: ClientName;
				endsAt: number;
				settle: (decision: Decision, writeTool?: WriteToolAnswer) => void;
		  }
		| undefined;
	const mcpUrl = new URL(MCP_PATH, publicOrigin).href;
	const checkUrl = new URL(PRM_PATH, publicOrigin).href;
	const pending = (): PendingSignIn[] =>
		[...pushed.values()]
			.filter(({ request }) => consent.state(request.uid) === "pending")
			.map(({ request, at }) => ({
				uid: request.uid,
				ref: request.uid.slice(-6),
				client: recorder.nameOf(request.clientId) ?? "no client of this session",
				clientName: request.clientName,
				redirectHost: request.redirectHost,
				scopes: request.scopes,
				startedAt: at,
				requester:
					request.ip === undefined ? "unknown" : `${request.ip} (${addressClass(request.ip)})`,
				userAgent: request.userAgent ?? "no user agent",
			}));
	const clientOf = (uid: string): string => pushed.get(uid)?.request.clientId ?? "";
	const missingChecks = (): string[] => [
		...(browserChecked ? [] : ["your browser's check"]),
		...(publicConfirmed ? [] : ["Funnel's public route"]),
	];
	const view = (): ConsoleView => ({
		mcpUrl,
		checkUrl,
		phase,
		routes: { ...routes },
		step: step && { client: step.client, title: TITLES[step.client], endsAt: step.endsAt },
		instructions: step ? instructions(step.client, mcpUrl) : [],
		pending: pending(),
		dcr: { open: window.isOpen, closesAt: window.isOpen ? windowClosesAt : undefined },
		cleanup: cleanupView,
		progress,
	});
	const approve = (code: string): string => {
		const matches = pending().filter((item) => consent.codes.get(item.uid) === code);
		const [match] = matches;
		if (match === undefined) {
			return `No waiting sign-in shows code ${code}: check the DraftYak page, or deny the sign-ins you didn't start.`;
		}
		if (matches.length > 1) {
			return `${matches.length} waiting sign-ins show code ${code}: deny the ones you didn't start, then type it again.`;
		}
		const state = consent.approve(match.uid, code);
		recorder.consentDecided(clientOf(match.uid), state);
		return state === "approved"
			? `Approved the sign-in from ${match.clientName} (${match.ref}).`
			: `Not approved: ${state ?? "it expired"}.`;
	};
	const act = (action: ConsoleAction): string => {
		switch (action.kind) {
			case "approve":
				return approve(action.code);
			case "deny": {
				const state = consent.deny(action.uid);
				recorder.consentDecided(clientOf(action.uid), state);
				return state === "denied"
					? `Denied the sign-in ${action.uid.slice(-6)}.`
					: "That sign-in isn't waiting any more.";
			}
			case "step": {
				if (step?.client !== action.client)
					return `${TITLES[action.client]} isn't the active step.`;
				step.settle(action.decision, action.writeTool);
				const how =
					action.decision.kind === "blocked"
						? `blocked (${OWNER_REASONS[action.decision.reason]})`
						: action.decision.kind;
				const tool = action.writeTool
					? `; ${WRITE_TOOL}: ${WRITE_TOOL_ANSWERS[action.writeTool]}`
					: "";
				return `Step ${TITLES[action.client]}: ${how}${tool}.`;
			}
			case "start": {
				if (phase !== "route checks") return "The steps have already started.";
				const missing = missingChecks();
				startedWithout = missing.length > 0 ? missing.join(" and ") : "nothing";
				return `Starting the steps without ${startedWithout}.`;
			}
			case "cleaned-up": {
				if (cleanupView?.awaitingOwner !== true) return "The clean-up isn't waiting for you.";
				cleanedUp = true;
				return "Noted. Now stop Funnel (Ctrl+C in its terminal): the test checks that the public address no longer reaches this AS.";
			}
		}
	};
	let console_: SessionConsole;
	try {
		console_ = await startConsole({ view, act });
	} catch (error) {
		switching[Symbol.dispose]();
		await running.close();
		throw error;
	}

	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		switching[Symbol.dispose]();
		await Promise.all([console_.close(), running.close()]);
	};

	// One request through the proxy, marked as the session's own: whether it came back with this
	// AS's metadata, and what failed otherwise. It also carries the forwarding canaries.
	const probe = async (
		mark: string,
		timeoutMs: number,
	): Promise<{ status: number; resource: unknown; last: string }> => {
		try {
			const response = await fetch(new URL(PRM_PATH, publicOrigin), {
				headers: { [SELF_CHECK_HEADER]: mark, ...CANARIES },
				signal: AbortSignal.timeout(Math.min(10_000, Math.max(1_000, timeoutMs))),
			});
			const body = (await response.json().catch(() => ({}))) as { resource?: unknown };
			return { status: response.status, resource: body.resource, last: `HTTP ${response.status}` };
		} catch (error) {
			// A new name or certificate may still be on its way; fetch names the cause's code.
			const code = (error as { cause?: { code?: unknown } }).cause?.code;
			const last =
				typeof code === "string" ? code : error instanceof Error ? error.name : "an error";
			return { status: 0, resource: undefined, last };
		}
	};

	// Through the proxy from this machine: the public URL must serve this AS's metadata. Every
	// client needs this machine's route (the consent pages open in its browser, the CLIs run on it),
	// so a request refused there (a 421: neither Host nor X-Forwarded-Host named the public host) or
	// none arriving at all stops the session.
	const selfCheck = async (check: SelfCheckOptions = {}): Promise<SelfCheck> => {
		const { budgetMs = 10 * MINUTE, everyMs = 3_000, reportEveryMs = MINUTE, signal } = check;
		const expected = new URL(MCP_PATH, publicOrigin).href;
		const until = Date.now() + budgetMs;
		let reported = Date.now();
		let last = "no answer";
		for (let attempt = 1; ; attempt++) {
			const before = selfCheckArrivals;
			const answer = await probe(String(attempt), until - Date.now());
			last = answer.last;
			if (selfCheckArrivals > before && selfCheckRoute !== undefined) {
				if (answer.status !== 200 || answer.resource !== expected) {
					throw new Error(
						`the proxy reached this AS but got ${last}: a 421 means neither Host nor X-Forwarded-Host named the public host`,
					);
				}
				routes.thisMachine =
					selfCheckRoute === "tailnet identity headers"
						? "reached over the tailnet"
						: "reached through Funnel's public ingress";
				return { route: selfCheckRoute };
			}
			if (Date.now() + everyMs >= until) break;
			if (Date.now() - reported >= reportEveryMs) {
				reported = Date.now();
				print(
					`still trying <DY_LIVE_FUNNEL_BASE_URL> from this machine (${last}); a new name can take up to 10 minutes to reach public DNS`,
				);
			}
			await sleep(everyMs, undefined, signal ? { signal } : {});
		}
		const port = new URL(running.origin).port;
		throw new Error(
			`this machine can't reach <DY_LIVE_FUNNEL_BASE_URL> (${last}). Every client needs that route: the consent pages open in this machine's browser and the CLIs run here. Check that Funnel runs and forwards to http://127.0.0.1:${port} (tailscale funnel status), then start the test again.`,
		);
	};

	const routeGate = async (signal: AbortSignal | undefined, budgetMs: number): Promise<void> => {
		phase = "route checks";
		if (missingChecks().length > 0) {
			print(
				[
					"",
					"Before the steps, in the session console:",
					"  - open the public check in your browser on this machine;",
					"  - on a phone with Tailscale off, on mobile data, open the address the console shows under Funnel's public route.",
					"  The steps start once both arrive, or when you press Start in the console.",
				].join("\n"),
			);
		}
		const ready = await waitFor(
			() => missingChecks().length === 0 || startedWithout !== undefined,
			budgetMs,
			signal,
		);
		if (!ready) {
			throw new Error(
				`the route checks didn't finish within ${Math.ceil(budgetMs / MINUTE)} min, so no client step ran and nothing was recorded. Check Funnel (tailscale funnel status), then start the test again`,
			);
		}
		const missing = missingChecks();
		routeChecks =
			missing.length === 0
				? "every check passed"
				: `owner started without ${missing.join(" and ")}`;
	};

	const run = async (
		plans: readonly StepPlan[],
		signal?: AbortSignal,
		runOptions: RunOptions = {},
	): Promise<Row[]> => {
		print(`session console (open it in your browser on this machine): ${console_.url}/`);
		await routeGate(signal, runOptions.routeChecksMs ?? 15 * MINUTE);
		phase = "steps";
		for (const [index, plan] of plans.entries()) {
			const endsAt = Date.now() + plan.deadlineMs;
			recorder.begin(plan.client);
			const minutes = Math.round(plan.deadlineMs / MINUTE);
			const steps = instructions(plan.client, "<DY_LIVE_FUNNEL_BASE_URL>/mcp");
			print(
				[
					"",
					`Step ${index + 1} of ${plans.length}: ${TITLES[plan.client]} (up to ${minutes} minute${minutes === 1 ? "" : "s"})`,
					...steps.map((line) => `  ${line}`),
				].join("\n"),
			);
			const [decision, writeTool] = await new Promise<[Decision, WriteToolAnswer | undefined]>(
				(resolve, reject) => {
					const timer = setTimeout(() => finish({ kind: "deadline" }), plan.deadlineMs);
					const abort = (): void => {
						clearTimeout(timer);
						step = undefined;
						reject(signal?.reason ?? new Error("aborted"));
					};
					const finish = (decision: Decision, answer?: WriteToolAnswer): void => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", abort);
						step = undefined;
						resolve([decision, answer]);
					};
					step = { client: plan.client, endsAt, settle: finish };
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				},
			);
			recorder.end(plan.client, decision, writeTool);
			print(
				`Step ${index + 1} ended: ${decision.kind === "blocked" ? `blocked (${OWNER_REASONS[decision.reason]})` : decision.kind}`,
			);
		}
		phase = "finished";
		const rows = recorder.rows(plans.map((plan) => plan.client));
		print(["", ...summary(rows, recorder.notes())].join("\n"));
		return rows;
	};

	// After the steps: the owner removes the connectors while the AS still runs, then stops Funnel;
	// the session checks that the public address no longer reaches it and removes the .env.live entry.
	const funnelOff = async ({
		offMs = 10 * MINUTE,
		everyMs = 3_000,
		signal,
	}: CleanUpOptions): Promise<boolean> => {
		const until = Date.now() + offMs;
		let quiet = 0;
		let told = false;
		for (;;) {
			const before = selfCheckArrivals;
			await probe("clean-up", until - Date.now());
			if (selfCheckArrivals > before) {
				quiet = 0;
				if (!told) {
					told = true;
					print(
						"Funnel still forwards to this AS: press Ctrl+C in its terminal, then check that tailscale funnel status lists no server",
					);
				}
			} else if (++quiet >= 2) {
				return true;
			}
			if (Date.now() + everyMs >= until) return false;
			await sleep(everyMs, undefined, signal ? { signal } : {});
		}
	};

	const cleanUp = async (cleanup: CleanUpOptions): Promise<Cleanup> => {
		phase = "clean-up";
		recorder.cleaningUp();
		cleanupView = {
			steps: CLEANUP_STEPS,
			awaitingOwner: true,
			status: "Waiting for you to remove the connectors.",
		};
		const steps = CLEANUP_STEPS.map((line) => `  ${line}`);
		print(["", "Clean-up (the console shows the same):", ...steps].join("\n"));
		const confirmed = await waitFor(
			() => cleanedUp,
			cleanup.confirmMs ?? 20 * MINUTE,
			cleanup.signal,
		);
		cleanupView = {
			...cleanupView,
			awaitingOwner: false,
			status: "Checking that the public address no longer reaches this AS.",
		};
		const off = await funnelOff(cleanup);
		const entry = off ? (cleanup.deleteEntry().length > 0 ? "deleted" : "absent") : "kept";
		const result: Cleanup = {
			connectors: confirmed ? "removed (owner confirmed)" : "not confirmed",
			funnel: off ? "off" : "still forwarding to this AS",
			entry,
			asState: "in memory only, ended with this run",
			revoked: confirmed && off ? "yes" : "no",
		};
		cleanupResult = result;
		cleanupView = {
			...cleanupView,
			status: `Done: connectors ${result.connectors}; Funnel ${result.funnel}; the .env.live entry ${result.entry}; revoked: ${result.revoked}.`,
		};
		phase = "finished";
		print(`clean-up: ${cleanupView.status}`);
		return result;
	};

	const evidence = (plans: readonly StepPlan[], startedAt: number): LiveData =>
		recorder.data(
			{
				clients: plans.map((plan) => plan.client),
				complete: isCompleteRun(plans),
				perClientMinutes: Math.round((plans[0]?.deadlineMs ?? 0) / MINUTE),
				durationMinutes: Math.round((Date.now() - startedAt) / MINUTE),
				accessTokenTtlSeconds: ttl,
				audienceRule: "endpoints",
				cimdHosts: [...policy.hosts],
				consentLimits: options.consentLimits ? "raised" : "plan defaults",
				consoleApproval: "a typed code approves the one waiting sign-in that shows it",
				challengeNamesScopes: true,
				defaultScopeWhenNone: true,
				dcrAnyLoopbackPort: true,
				tokenCheckBeforeBodyChecks: true,
				selfCheckRoute: selfCheckRoute ?? "not run",
				routeChecks: { ...routes, startedWith: routeChecks },
				adr0005: ADR_0005,
				cleanup: cleanupResult ?? "not run",
				revoked: cleanupResult?.revoked ?? "not run",
			},
			plans.map((plan) => plan.client),
		);

	return {
		origin: running.origin,
		publicOrigin,
		consoleUrl: console_.url,
		recorder,
		window,
		selfCheck,
		run,
		cleanUp,
		evidence,
		close,
		[Symbol.asyncDispose]: close,
	};
}
