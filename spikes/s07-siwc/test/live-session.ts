import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	assertContentFree,
	deleteEnvLive,
	type EnvLiveOptions,
	type Fingerprint,
	hashId,
	loadEnvLive,
	newSessionKey,
	redact,
	registerSecret,
	saveEnvLive,
	writeEvidence,
} from "@draftyak/spike-kit";
import type OpenAI from "openai";
import {
	CALLBACK_PORT,
	type Credential,
	discover,
	type Endpoints,
	newHostId,
	PLAN_SCOPE,
	planUsage,
	signIn,
	type Tokens,
} from "../src/auth.ts";
import { type Broker, createBroker } from "../src/broker.ts";
import { classifyError, SiwcError } from "../src/errors.ts";
import { createClient, STRUCTURES, type Structure } from "../src/responses.ts";
import { type CredentialStore, Session, transferText } from "../src/session.ts";
import {
	AFTER_EXPIRY_MS,
	type AuthCall,
	afterRevocation,
	authRecorder,
	type Confirmation,
	chunkStats,
	DEFERRED_BUDGET_MS,
	DEFERRED_MAX_MIN,
	DRAFT_TIMEOUT_MS,
	type DraftRecord,
	detailText,
	draftOnce,
	type ErrorRecord,
	errorRecord,
	HUB_BUDGET_MS,
	isDeferredMinutes,
	isRecord,
	liveJob,
	MODEL_SLUG,
	name,
	pathName,
	type Revoked,
	revocationVerdict,
	revokeAndConfirm,
	revokeRefreshToken,
	type UpstreamCall,
	upstreamRecorder,
	WITHHELD,
} from "./live-record.ts";
import { API_KEY, OPT_IN, OPT_IN_VALUES, readEntry, SAVED, SIWC_NAMES } from "./session-env.ts";

// M0.27's live procedure (notes/session.md), shared by test/siwc.live.test.ts and the rehearsals,
// which run it against M0.26's fakes: sign-in, drafts, the documented transfer to a second process,
// optional API-key mode, revocation and the evidence. Tokens reach disk only through saveEnvLive;
// what is recorded comes from test/live-record.ts, request IDs hashed with a key that is never stored,
// and passes the kit's content check before writeEvidence.

export interface PortHold {
	readonly waitedMs: number;
	release(): void;
}

export interface ChildRun {
	readonly exitCode: number;
	// The hub process's JSON result, or undefined when it printed none.
	readonly output: unknown;
	readonly stderr: string;
}

export type ChildRunner = (
	args: readonly string[],
	input: string,
	signal: AbortSignal,
) => Promise<ChildRun>;

export interface LiveDeps {
	readonly run: "live" | "rehearsal";
	readonly issuer: string;
	readonly apiOrigin: string;
	readonly evidenceFile: string;
	readonly openBrowser: (url: string) => void | Promise<void>;
	// Progress for the owner and the orchestrator; never a value from .env.live.
	readonly say: (text: string) => void;
	readonly envLive?: EnvLiveOptions;
	// Model overrides (DRAFTYAK_S7_MODEL, DRAFTYAK_S7_API_MODEL); process.env by default.
	readonly env?: NodeJS.ProcessEnv;
	// undefined: 127.0.0.1:1455, as live.
	readonly port?: number;
	// The kit's lock around each sign-in that binds port 1455; a stop request aborts the wait.
	readonly holdPort?: (signal: AbortSignal) => Promise<PortHold>;
	readonly runChild?: ChildRunner;
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
	readonly signInTimeoutMs?: number;
	readonly pollMs?: number;
	readonly fingerprint?: Fingerprint;
	// DRAFTYAK_S7_DEFERRED_MIN (gate()): the hub process keeps the session until its access token has
	// expired, then drafts once more, waiting at most this many minutes. Off when undefined.
	readonly deferredMinutes?: number;
}

export interface LiveResult {
	// The backlog's acceptance lines, in order: signin, text.format, submit_draft, transfer, revoked.
	readonly lines: readonly string[];
	readonly details: readonly string[];
	readonly revoked: boolean;
	readonly data: Readonly<Record<string, unknown>>;
	readonly file: string;
}

type StopCode = "PORT_IN_USE" | "UNREACHABLE" | "LEFTOVER_TOKENS";

// Ends a run before it holds a token of its own, with nothing recorded: a held port, an issuer that
// doesn't answer, or an earlier run's tokens whose revocation isn't confirmed (they stay).
export class SessionStopped extends Error {
	override name = "SessionStopped";
	readonly code: StopCode;

	constructor(code: StopCode, message: string) {
		super(message);
		this.code = code;
	}
}

const SIGN_IN_TIMEOUT_MS = 8 * 60_000;
// Longer than the hub process's worst case, so it ends with its result rather than killed.
const CHILD_TIMEOUT_MS = HUB_BUDGET_MS + 60_000;
// test/siwc.live.test.ts's limit without the step after expiry.
const LIVE_TIMEOUT_MS = 60 * 60_000;
const CHILD = path.join(import.meta.dirname, "transfer-child.ts");
const TOOL_STRUCTURES: readonly Structure[] = STRUCTURES.filter((s) => s !== "text-format");
// The model in the docs' example (Models and inference): the plan drafts' model when the list can't
// be read, and API-key mode's when the key lists it but not the plan's model.
const DOCS_MODEL = "gpt-6.1-sol";
const IN_CHATGPT =
	"remove DraftYak in ChatGPT's settings (Settings > Security and login > Sign in with ChatGPT)";
const FORGET = "node spikes/s07-siwc/test/session-env.ts forget tokens";
export const DEFERRED_MIN = "DRAFTYAK_S7_DEFERRED_MIN";

// DRAFTYAK_S7_DEFERRED_MIN, read like DRAFTYAK_S7_MODEL from the shell: whole minutes from 1 to
// 120, or undefined when unset. Any other value is refused before the sign-in.
export function deferredMinutes(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const value = env[DEFERRED_MIN];
	if (value === undefined) return undefined;
	if (!isDeferredMinutes(value)) {
		throw new Error(
			`refusing to start: ${DEFERRED_MIN} must be whole minutes from 1 to ${DEFERRED_MAX_MIN}; unset it to leave the step after expiry off`,
		);
	}
	return Number(value);
}

// The step after expiry lengthens the hub process's limit and the live test's by its cap and its
// own requests. A value deferredMinutes() refuses adds nothing: the run won't start.
export const deferredExtraMs = (minutes: number): number => minutes * 60_000 + DEFERRED_BUDGET_MS;
export const childTimeoutMs = (minutes?: number): number =>
	CHILD_TIMEOUT_MS + (minutes === undefined ? 0 : deferredExtraMs(minutes));
export function liveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const value = env[DEFERRED_MIN];
	const minutes = value !== undefined && isDeferredMinutes(value) ? Number(value) : undefined;
	return LIVE_TIMEOUT_MS + (minutes === undefined ? 0 : deferredExtraMs(minutes));
}

export const openaiVariables = (env: NodeJS.ProcessEnv): string[] =>
	Object.keys(env)
		.filter((key) => key.toUpperCase().startsWith("OPENAI_"))
		.sort();

export type Gate =
	| { readonly run: true; readonly again: boolean; readonly deferredMinutes?: number }
	| { readonly run: false; readonly reason: string };

// The opt-in first (a run without it skips), then the refusals: OPENAI_* in the shell, which the SDK
// would read, a DRAFTYAK_S7_DEFERRED_MIN deferredMinutes() refuses, and evidence from an earlier run
// that only an opt-in with --again may replace.
export function gate(
	evidenceFile: string,
	options: EnvLiveOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Gate {
	const value = readEntry(OPT_IN, options);
	if (value !== OPT_IN_VALUES.run && value !== OPT_IN_VALUES.again) {
		const state = value === undefined ? "isn't set" : value === "stop" ? 'is "stop"' : "isn't yes";
		const how = "node spikes/s07-siwc/test/session-env.ts opt-in (notes/session.md)";
		return {
			run: false,
			reason: `the owner hasn't opted in: ${OPT_IN} ${state} in .env.live; run ${how}`,
		};
	}
	const set = openaiVariables(env);
	if (set.length > 0) {
		throw new Error(
			`refusing to start: ${set.join(", ")} set in this shell, and the OpenAI SDK reads OPENAI_* variables; unset them and run again`,
		);
	}
	const minutes = deferredMinutes(env);
	if (value === OPT_IN_VALUES.run && existsSync(evidenceFile)) {
		throw new Error(
			`refusing to start: ${path.basename(evidenceFile)} holds an earlier session's evidence; commit or move it, or opt in with --again to replace it`,
		);
	}
	const again = value === OPT_IN_VALUES.again;
	return { run: true, again, ...(minutes !== undefined && { deferredMinutes: minutes }) };
}

// The system browser, without a shell.
export function openSystemBrowser(url: string): Promise<void> {
	if (!/^https?:\/\//.test(url)) return Promise.reject(new Error("only http(s) addresses open"));
	const windows = process.platform === "win32";
	const rundll = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "rundll32.exe");
	const command = windows ? rundll : process.platform === "darwin" ? "open" : "xdg-open";
	const args = windows ? ["url.dll,FileProtocolHandler", url] : [url];
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "ignore", detached: !windows, windowsHide: false });
		child.once("error", reject).once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

// The hub process, test/transfer-child.ts, started like any Node script: no shell.
export const runTransferChild: ChildRunner = (args, input, signal) =>
	new Promise((resolve) => {
		const options = { signal, maxBuffer: 1 << 20, windowsHide: true };
		const child = execFile(process.execPath, [CHILD, ...args], options, (error, stdout, stderr) => {
			const exitCode = typeof error?.code === "number" ? error.code : error ? -1 : 0;
			let output: unknown;
			try {
				output = JSON.parse(stdout);
			} catch {
				output = undefined;
			}
			resolve({ exitCode, output, stderr });
		});
		child.stdin?.end(input);
	});

// The desktop's credential store: the tokens and the issued client ID go to .env.live through
// saveEnvLive and are read back from it; the rest of the credential stays in memory.
function envLiveStore(options: EnvLiveOptions): CredentialStore {
	let held: Credential | null = null;
	return {
		read: async () => {
			if (!held?.tokens) return held;
			const saved = loadEnvLive([SAVED.access, SAVED.refresh], options);
			const accessToken = saved[SAVED.access].reveal();
			const refreshToken = saved[SAVED.refresh].reveal();
			return { ...held, tokens: { ...held.tokens, accessToken, refreshToken } };
		},
		write: async (next) => {
			if (next?.tokens) {
				saveEnvLive(SAVED.client, next.clientId, options);
				saveEnvLive(SAVED.refresh, next.tokens.refreshToken, options);
				saveEnvLive(SAVED.access, next.tokens.accessToken, options);
				held = { ...next, tokens: { ...next.tokens, accessToken: "", refreshToken: "" } };
			} else {
				deleteEnvLive([SAVED.access, SAVED.refresh, SAVED.client], options);
				held = next;
			}
		},
	};
}

interface Issued {
	readonly refreshToken: string;
	readonly clientId: string;
}

// The code exchange's tokens, kept in memory until .env.live holds them, so a sign-in that fails
// after the exchange (an ID token the spike refuses, say) or a save that fails can still revoke what
// OpenAI issued. All three become kit secrets. An access token without a refresh token is only
// noted: the documented revocation takes a refresh token.
function issuedTokens(base: typeof fetch): {
	readonly fetch: typeof fetch;
	take(): Issued | undefined;
	accessOnly(): boolean;
} {
	let held: Issued | undefined;
	let accessOnly = false;
	const watched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const response = await base(input, init);
		const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined;
		if (response.ok && form?.get("grant_type") === "authorization_code") {
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => undefined);
			const text = (key: string): string | undefined =>
				isRecord(body) && typeof body[key] === "string" ? body[key] : undefined;
			for (const key of ["access_token", "refresh_token", "id_token"]) {
				const token = text(key);
				if (token) registerSecret(token);
			}
			const refreshToken = text("refresh_token");
			const clientId = form.get("client_id");
			if (refreshToken && clientId) held = { refreshToken, clientId };
			else if (text("access_token")) accessOnly = true;
		}
		return response;
	};
	return {
		fetch: watched as typeof fetch,
		take: () => {
			const taken = held;
			held = undefined;
			return taken;
		},
		accessOnly: () => accessOnly,
	};
}

// Every string and key passes the kit's content rules, or is replaced and counted.
export function scrub(value: unknown, count: { withheld: number }): unknown {
	const clean = (text: string): string => {
		try {
			assertContentFree(text);
			return text;
		} catch {
			count.withheld++;
			return WITHHELD;
		}
	};
	if (typeof value === "string") return clean(value);
	if (typeof value === "number" && !Number.isFinite(value)) {
		count.withheld++;
		return null;
	}
	if (Array.isArray(value)) return value.map((item) => scrub(item, count));
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [clean(key), scrub(item, count)]),
	);
}

// The values and keys recorded as WITHHELD before the final check (name(), pathName(), detailText()).
export function withheldIn(value: unknown): number {
	if (value === WITHHELD) return 1;
	if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + withheldIn(item), 0);
	if (!isRecord(value)) return 0;
	return Object.entries(value).reduce(
		(sum, [key, item]) => sum + (key === WITHHELD ? 1 : 0) + withheldIn(item),
		0,
	);
}

const SIGN_IN_PROMPT = [
	"A browser window opens at OpenAI. Sign in with the ChatGPT account whose plan DraftYak should use.",
	"Before you allow access, copy the consent screen's wording as text, without your name or e-mail.",
	"If OpenAI shows an error page instead, note its wording and run:",
	"  node spikes/s07-siwc/test/session-env.ts stop",
].join("\n");

// The authorization URL without the hints a reauthorization could carry (never sent here).
function printable(url: string): string {
	const shown = new URL(url);
	shown.searchParams.delete("id_token_hint");
	shown.searchParams.delete("login_hint");
	return shown.href;
}

function blockedReason(error: unknown): string {
	if (!(error instanceof SiwcError)) return "error";
	const { apiCode, detail } = error.facts;
	const said =
		apiCode !== undefined ? name(apiCode) : detail !== undefined ? detailText(detail) : "";
	return said === "" ? error.code : `${error.code}:${said}`;
}

type Verdict = "ok" | "unsupported" | `fails(${string})`;

// The request fields each structure adds (src/responses.ts buildRequest). A refusal that names one of
// them refused the structure; one that names anything else, such as the model, refused the draft.
const OWN_FIELDS: Readonly<Record<Structure, RegExp>> = {
	"text-format": /^text(?:[.[]|$)/,
	"tool-namespace": /^(?:tools|tool_choice)(?:[.[]|$)/,
	"tool-item": /^(?:input\[0\](?:[.[]|$)|input$|tool_choice(?:[.[]|$))/,
	"tool-top-level": /^(?:tools|tool_choice)(?:[.[]|$)/,
};

const codeParam = (error: ErrorRecord): string =>
	[error.code, error.param].filter(Boolean).join(":");

// ok; unsupported, when the route refused the structure's own fields (UNSUPPORTED_CAPABILITY or a
// 400, with a param naming one of them); or fails(<why>), such as fails(UNSUPPORTED_CAPABILITY:model)
// or fails(ROUTE_NOT_SUPPORTED).
export function draftVerdict(
	record: Pick<DraftRecord, "structure" | "outcome" | "error" | "reason">,
): Verdict {
	if (record.outcome === "draft") return "ok";
	const error = record.error;
	if (record.outcome === "error" && error) {
		const refused =
			error.code === "UNSUPPORTED_CAPABILITY" ||
			(error.code === "API_ERROR" && error.status === 400);
		const own = error.param !== undefined && OWN_FIELDS[record.structure].test(error.param);
		return refused && own ? "unsupported" : `fails(${codeParam(error)})`;
	}
	if (record.outcome === "aborted") return "fails(timeout)";
	if (record.outcome === "incomplete") return `fails(incomplete:${record.reason ?? "unknown"})`;
	return `fails(${record.outcome})`;
}

// A structure's verdict, with the code and param behind an unsupported one.
function draftDetail(record: DraftRecord): string {
	const verdict = draftVerdict(record);
	const why = verdict === "unsupported" && record.error ? ` (${codeParam(record.error)})` : "";
	return `${record.structure} ${verdict}${why}`;
}

function combined(records: readonly DraftRecord[]): string {
	const verdicts = records.map(draftVerdict);
	if (verdicts.includes("ok")) return "ok";
	if (verdicts.length > 0 && verdicts.every((verdict) => verdict === "unsupported")) {
		return "unsupported";
	}
	return verdicts.find((verdict) => verdict !== "unsupported") ?? "not-run(no draft)";
}

const sortedNames = (values: readonly unknown[]): string[] => [...new Set(values.map(name))].sort();
const validSlug = (value: string | undefined): string | undefined =>
	value !== undefined && MODEL_SLUG.test(value) ? value : undefined;

interface Models {
	readonly record: Record<string, unknown>;
	// Every usable slug, and the one a plan draft takes.
	readonly slugs: readonly string[];
	readonly chosen?: string;
	// A plan's list only: the usable slugs it marks visibility "list", in the server's order.
	readonly listed?: readonly string[];
}

const slugsOf = (values: readonly unknown[]): string[] =>
	values.filter((value): value is string => typeof value === "string" && MODEL_SLUG.test(value));

// GET /v1/models: plan usage answers {"models": [{slug, display_name, visibility}]}, to be shown in
// the server's order (Models and inference), so the first listed slug is taken. An API key answers
// {"object": "list", "data": [{id, ...}]}, and nothing is picked from it by name or date.
function pickModel(body: unknown): Models {
	if (isRecord(body) && Array.isArray(body.models)) {
		const models = body.models.filter(isRecord);
		const visible = models.filter((model) => model.visibility === "list");
		const listed = slugsOf(visible.map((model) => model.slug));
		const [chosen] = listed;
		const record = {
			shape: "models",
			count: models.length,
			listed: visible.length,
			listedSlugs: listed.map(name),
			visibilities: sortedNames(models.map((model) => model.visibility)),
			fields: sortedNames(models.flatMap((model) => Object.keys(model))),
			chosen: chosen === undefined ? null : name(chosen),
		};
		const slugs = slugsOf(models.map((model) => model.slug));
		return { record, slugs, listed, ...(chosen !== undefined && { chosen }) };
	}
	if (isRecord(body) && Array.isArray(body.data)) {
		const items = body.data.filter(isRecord);
		const record = {
			shape: "data",
			count: items.length,
			fields: sortedNames(items.flatMap((item) => Object.keys(item))),
		};
		return { record, slugs: slugsOf(items.map((item) => item.id)) };
	}
	const fields = isRecord(body) ? sortedNames(Object.keys(body)) : [];
	return { record: { shape: "unknown", fields }, slugs: [] };
}

type Drafted = DraftRecord & { readonly upstream: readonly Record<string, unknown>[] };

// The hub process's result, field by field: nothing it prints is copied in whole.
interface TransferRecord {
	readonly exitCode: number;
	// Whether it printed a result at all.
	readonly result: boolean;
	readonly desktopForgot: boolean;
	readonly childStructure: Structure | null;
	readonly accepted: boolean;
	readonly refreshed: boolean;
	readonly rotated: boolean | null;
	readonly planUsage: string | null;
	readonly code: string | null;
	readonly detail: string | null;
	readonly status: number | null;
	readonly apiCode: string | null;
	readonly draft: Readonly<Record<string, unknown>> | null;
	// Its first refresh request, if it sent one.
	readonly refresh: Readonly<Record<string, unknown>> | null;
	// The step after expiry, when it was asked for and the forced refresh worked.
	readonly deferred: Readonly<Record<string, unknown>> | null;
	readonly revoked: boolean | null;
	readonly revocation: readonly number[];
	readonly afterRevoke: Readonly<Record<string, unknown>> | null;
}

// This process's own revocation of the session it handed over, and the check after it.
interface Fallback {
	readonly revoked: boolean;
	readonly after: Readonly<Record<string, unknown>> | null;
}

// The hub's revocation, unless one of its refreshes may have left a newer token it never saw: a
// refresh that got no answer, or one refused as reused, which says another holder refreshed first.
function hubVerdict(transfer: TransferRecord): Revoked {
	if (transfer.refresh?.status === 0) {
		return "no(revocation unconfirmed: the hub's refresh got no answer)";
	}
	if (!transfer.refreshed && transfer.apiCode === "refresh_token_reused") {
		return "no(revocation unconfirmed: refresh_token_reused)";
	}
	const later = transfer.deferred;
	const laterRefresh = later && isRecord(later.refresh) ? later.refresh : undefined;
	if (laterRefresh?.status === 0) {
		return "no(revocation unconfirmed: the hub's refresh after expiry got no answer)";
	}
	if (later?.refreshed === false && later.apiCode === "refresh_token_reused") {
		return "no(revocation unconfirmed: refresh_token_reused)";
	}
	return revocationVerdict(transfer.revoked === true, transfer.afterRevoke?.refresh);
}

// Before the hub process starts: what the step after expiry will do, from the lifetime of the tokens
// handed over (the hub's forced refresh gets the same, presumably).
function deferredPlan(tokens: Tokens, cap: number): string {
	const lifetime = tokens.expiresAt - tokens.savedAt;
	const life = Math.round(lifetime / 60_000);
	const wait = Math.ceil((lifetime + AFTER_EXPIRY_MS) / 60_000);
	const after = AFTER_EXPIRY_MS / 60_000;
	return wait > cap
		? `After expiry: the tokens last ${life} minutes, so the hub process would wait about ${wait} minutes, past the ${cap}-minute cap. It revokes the session without that step.`
		: `After expiry: the hub process keeps the session until ${after} minutes after its access token expires, about ${wait} minutes (the tokens last ${life} minutes; the cap is ${cap}), then drafts once more, refreshing first, and revokes it. Nothing to do meanwhile: keep this PC on mains power and awake.`;
}

// The step after expiry as the details say it.
function deferredText(record: Readonly<Record<string, unknown>>, cap: number): string {
	const count = (key: string): number | null => {
		const value = record[key];
		return typeof value === "number" ? value : null;
	};
	const due = count("dueInMs");
	if (record.ran !== true) {
		return due === null
			? "not run"
			: `not run (due in ${Math.ceil(due / 60_000)} min, over the ${cap}-minute cap)`;
	}
	const after = count("msAfterExpiry");
	const idle = count("idleMs");
	const timing =
		after === null || idle === null
			? "no refresh sent"
			: `${Math.round(after / 1000)} s after expiry, idle ${Math.round(idle / 60_000)} min`;
	const draft = isRecord(record.draft) ? record.draft : null;
	const said = draft && (draft.outcome === "draft" ? "ok" : name(draft.code ?? draft.outcome));
	const drafted = said ? `draft ${said}` : "no draft";
	return `refreshed ${record.refreshed === true} (rotated ${record.rotated === true}, ${timing}), ${drafted}`;
}

export async function runLiveSession(deps: LiveDeps): Promise<LiveResult> {
	const deferred = deps.deferredMinutes;
	if (deferred !== undefined && !isDeferredMinutes(String(deferred))) {
		throw new Error(
			`refusing to start: deferredMinutes must be whole minutes from 1 to ${DEFERRED_MAX_MIN}`,
		);
	}
	const began = performance.now();
	const since = (from: number): number => Math.round(performance.now() - from);
	const key = newSessionKey();
	const hashed = (id: string): string => hashId(key, id);
	const base = deps.fetch ?? fetch;
	const issued = issuedTokens(base);
	const auth = authRecorder(issued.fetch, deps.issuer);
	const api = upstreamRecorder(base);
	const envLive = deps.envLive ?? {};
	const env = deps.env ?? process.env;
	const signal = deps.signal ?? new AbortController().signal;
	const say = deps.say;
	const ms: Record<string, number> = {};
	const data: Record<string, unknown> = {
		procedure: "s07b-live",
		run: deps.run,
		issuerHost: name(new URL(deps.issuer).host),
		apiHost: name(new URL(deps.apiOrigin).host),
		port: deps.port ?? CALLBACK_PORT,
		lock: null,
	};
	let endpoints: Endpoints | undefined;
	let blocked: string | undefined;
	// The credential between its handover and the hub's answer, revoked here if the hub never kept it.
	let handedOver: Credential | undefined;

	const withHash = (error: ErrorRecord): ErrorRecord =>
		error.requestId === undefined ? error : { ...error, requestId: hashed(error.requestId) };
	const upstreamEvidence = (call: UpstreamCall): Record<string, unknown> => {
		const { sizes: _sizes, firstChunkMs: _first, requestId, ...rest } = call;
		const chunks = chunkStats(call);
		return {
			...rest,
			...(requestId !== undefined && { requestId: hashed(requestId) }),
			...(chunks && { chunks }),
		};
	};
	const brokers: Broker[] = [];
	const clientFor = (token: () => Promise<string>): OpenAI => {
		const broker = createBroker({ token, upstream: deps.apiOrigin, fetch: api.fetch });
		brokers.push(broker);
		return createClient(broker.fetch);
	};

	async function listModels(client: OpenAI): Promise<Models> {
		const before = api.calls.length;
		const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
		const answer = await client.get<unknown>("/models", { signal: timeout }).then(
			(body) => pickModel(body),
			(error: unknown): Models => ({
				record: { error: withHash(errorRecord(classifyError(error))) },
				slugs: [],
			}),
		);
		const upstream = api.calls.slice(before).map(upstreamEvidence);
		return { ...answer, record: { ...answer.record, upstream } };
	}

	async function draftWith(client: OpenAI, model: string, structure: Structure): Promise<Drafted> {
		const before = api.calls.length;
		const timeout = AbortSignal.any([signal, AbortSignal.timeout(DRAFT_TIMEOUT_MS)]);
		const record = await draftOnce(client, liveJob(model, structure), timeout);
		const upstream = api.calls.slice(before).map(upstreamEvidence);
		return { ...record, ...(record.error && { error: withHash(record.error) }), upstream };
	}

	async function revokeHere(credential: Credential): Promise<Fallback> {
		if (!endpoints || !credential.tokens) return { revoked: false, after: null };
		const { clientId, tokens } = credential;
		const revoked = await revokeRefreshToken(endpoints, clientId, tokens.refreshToken, auth.fetch);
		const after = await afterRevocation(
			tokens,
			clientId,
			endpoints,
			deps.apiOrigin,
			auth.fetch,
			api.fetch,
		);
		return { revoked, after };
	}

	// After an unexpected failure: what this run still holds is revoked, and each outcome is said.
	// The entries in .env.live stay unless their revocation is confirmed, so the next opted-in run
	// revokes them first.
	async function emergency(): Promise<void> {
		const saved = readEntry(SAVED.refresh, envLive);
		const savedClient = readEntry(SAVED.client, envLive);
		const held: { label: string; token: Issued; kept: boolean; handed: boolean }[] = [];
		if (saved !== undefined && savedClient !== undefined) {
			const token = { refreshToken: saved, clientId: savedClient };
			held.push({ label: "the tokens in .env.live", token, kept: true, handed: false });
		}
		const exchanged = issued.take();
		if (exchanged && exchanged.refreshToken !== saved) {
			held.push({
				label: "the code exchange's tokens",
				token: exchanged,
				kept: false,
				handed: false,
			});
		}
		const handed = handedOver?.tokens;
		if (handedOver && handed && handed.refreshToken !== saved) {
			const token = { refreshToken: handed.refreshToken, clientId: handedOver.clientId };
			held.push({
				label: "the tokens handed to the hub process",
				token,
				kept: false,
				handed: true,
			});
		}
		let keep = false;
		let lost = false;
		for (const item of held) {
			const { clientId, refreshToken } = item.token;
			let verdict: Revoked = "no(no endpoints to revoke at)";
			if (endpoints) {
				verdict = await revokeAndConfirm(endpoints, clientId, refreshToken, base).then(
					(check) => check.verdict,
					(): Revoked => "no(revocation failed)",
				);
			}
			// The hub process may have refreshed them first, so their refusal proves nothing.
			if (item.handed && verdict === "yes") verdict = "no(the hub process may have refreshed them)";
			say(`After the failure, ${item.label}: revoked ${verdict}.`);
			if (verdict !== "yes" && item.kept) keep = true;
			if (verdict !== "yes" && !item.kept) lost = true;
		}
		if (keep) {
			say(
				`They stay in .env.live, and the next opted-in run revokes them first. If no run follows, ${IN_CHATGPT}, then run ${FORGET}.`,
			);
		} else {
			deleteEnvLive([SAVED.access, SAVED.refresh, SAVED.client], envLive);
		}
		if (lost) say(`Tokens this run no longer holds may still work: ${IN_CHATGPT}.`);
	}

	async function signInOnce(
		at: Endpoints,
		hostId: string,
		registration: { readonly clientId: string } | undefined,
	): Promise<{
		credential?: Credential;
		error?: SiwcError;
		stopped: boolean;
		record: Record<string, unknown>;
	}> {
		const started = performance.now();
		const kind = registration ? "issued-client" : "new";
		const stop = new AbortController();
		const check = (): void => {
			try {
				if (readEntry(OPT_IN, envLive) === OPT_IN_VALUES.stop) stop.abort();
			} catch {}
		};
		// A stop request counts from before the port's lock is taken until the sign-in ends.
		const poll = setInterval(check, deps.pollMs ?? 2_000);
		const halt = AbortSignal.any([signal, stop.signal]);
		let hold: PortHold | undefined;
		try {
			if (deps.holdPort) {
				hold = await deps.holdPort(halt).catch((error: unknown) => {
					if (stop.signal.aborted && !signal.aborted) return undefined;
					throw error;
				});
			}
			if (hold) data.lock = { waitedMs: hold.waitedMs, idle: null };
			check();
			if (stop.signal.aborted) {
				const record = { outcome: "stopped", registration: kind, ms: since(started) };
				return { stopped: true, record };
			}
			const credential = await signIn({
				hostId,
				endpoints: at,
				fetch: auth.fetch,
				...(registration && { registration }),
				...(deps.port !== undefined && { port: deps.port }),
				timeoutMs: deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
				signal: halt,
				openBrowser: async (url) => {
					say(SIGN_IN_PROMPT);
					say(`If no browser window opens, open this address: ${printable(url)}`);
					try {
						await deps.openBrowser(url);
					} catch {
						say("The browser didn't open; use the address above.");
					}
				},
			});
			return {
				credential,
				stopped: false,
				record: { outcome: "ok", registration: kind, ms: since(started) },
			};
		} catch (error) {
			if (!(error instanceof SiwcError)) throw error;
			if (error.code === "PORT_IN_USE") {
				throw new SessionStopped(
					"PORT_IN_USE",
					`127.0.0.1:${deps.port ?? CALLBACK_PORT} is held by another program (a Codex sign-in, perhaps); close it, opt in again and run again`,
				);
			}
			const record = {
				outcome: "error",
				registration: kind,
				ms: since(started),
				error: withHash(errorRecord(error)),
			};
			return { error, stopped: stop.signal.aborted, record };
		} finally {
			clearInterval(poll);
			hold?.release();
		}
	}

	try {
		try {
			endpoints = await discover(deps.issuer, auth.fetch);
		} catch (error) {
			const answered = auth.calls.some((call) => call.kind === "discovery" && call.status !== 0);
			if (!answered) {
				const kept =
					readEntry(SAVED.refresh, envLive) === undefined
						? ""
						: "; the tokens an earlier run left in .env.live stay for that run";
				throw new SessionStopped(
					"UNREACHABLE",
					`${new URL(deps.issuer).host} didn't answer; check the network and run again${kept}`,
				);
			}
			blocked = blockedReason(error);
		}
		data.discovery = auth.calls.find((call) => call.kind === "discovery")?.shape ?? null;

		// A run that ended holding tokens left them in .env.live: they are revoked before anything
		// else. Unless that is confirmed, they stay and the run stops before signing in.
		const leftover = readEntry(SAVED.refresh, envLive);
		const leftoverClient = readEntry(SAVED.client, envLive);
		data.leftovers = { found: false };
		if (leftover !== undefined) {
			say("An earlier run left tokens in .env.live; revoking them first.");
			const check =
				endpoints && leftoverClient !== undefined
					? await revokeAndConfirm(endpoints, leftoverClient, leftover, auth.fetch)
					: undefined;
			if (check?.verdict !== "yes") {
				const why =
					check?.verdict ??
					(endpoints ? "no(no client ID saved with them)" : "no(discovery failed)");
				throw new SessionStopped(
					"LEFTOVER_TOKENS",
					`an earlier run's tokens in .env.live weren't revoked: ${why}. They stay there: run again later, or ${IN_CHATGPT}, run ${FORGET}, then opt in and run again`,
				);
			}
			deleteEnvLive([SAVED.access, SAVED.refresh, SAVED.client], envLive);
			data.leftovers = { found: true, revoked: check.revoked, probe: check.probe };
		}

		const signInStarted = performance.now();
		const hostId = newHostId();
		const attempts: Record<string, unknown>[] = [];
		let credential: Credential | undefined;
		let registration: { readonly clientId: string } | undefined;
		while (endpoints && !credential && blocked === undefined) {
			const attempt = await signInOnce(endpoints, hostId, registration);
			attempts.push(attempt.record);
			signal.throwIfAborted();
			if (attempt.credential) {
				credential = attempt.credential;
			} else {
				const error = attempt.error;
				const clientId = error?.facts.clientId;
				const retry = !attempt.stopped && !registration && error?.facts.apiCode === "invalid_grant";
				if (retry && clientId) {
					say(
						"The code exchange failed with invalid_grant: a second sign-in opens for the same registration.",
					);
					registration = { clientId };
				} else {
					blocked = attempt.stopped ? "stopped" : blockedReason(error);
				}
			}
		}
		ms.signIn = since(signInStarted);
		// Tokens OpenAI issued to a sign-in that then failed are revoked at once.
		const exchanged = credential ? undefined : issued.take();
		let orphan: Confirmation | null = null;
		if (exchanged && endpoints) {
			say("OpenAI issued tokens before the sign-in failed; revoking them.");
			orphan = await revokeAndConfirm(
				endpoints,
				exchanged.clientId,
				exchanged.refreshToken,
				auth.fetch,
			);
		}
		const orphanVerdict: Revoked | undefined = exchanged
			? (orphan?.verdict ?? "no(revocation unconfirmed)")
			: undefined;
		// The tokens go to .env.live, and Session.accessToken() is the plan-usage check: it refuses with
		// PLAN_USAGE_DISABLED without chatgpt.tokens.use.direct, before anything is sent.
		const store = envLiveStore(envLive);
		let session: Session | undefined;
		let planCheck: string | null = null;
		if (credential?.tokens && endpoints) {
			await store.write(credential);
			// Saved: from here a failure revokes them from .env.live.
			issued.take();
			session = new Session(store, endpoints, { fetch: auth.fetch });
			planCheck = await session.accessToken().then(
				() => "ok",
				(error: unknown) => (error instanceof SiwcError ? error.code : "ERROR"),
			);
		}
		const planOn = planCheck === "ok";
		const tokenCall = auth.calls.find((call) => call.kind === "token" && call.status === 200);
		const clientId = credential?.clientId;
		data.jwks = auth.calls.find((call) => call.kind === "jwks")?.shape ?? null;
		data.signIn = {
			attempts,
			token: tokenCall?.shape ?? null,
			clientId: clientId
				? { prefix: name(/^[A-Za-z]+_/.exec(clientId)?.[0] ?? ""), length: clientId.length }
				: null,
			planScope: credential
				? { name: PLAN_SCOPE, granted: planUsage(credential) === "enabled" }
				: null,
			planCheck,
			tokensKept: Boolean(credential?.tokens),
		};
		if (credential) say(`Signed in. ${PLAN_SCOPE}: ${planOn ? "granted" : "not granted"}.`);

		// The desktop's drafts: one with text.format, then submit_draft in each place a tool can go.
		const drafts: Drafted[] = [];
		let model: string | undefined;
		let modelSource: string | null = null;
		const draftsStarted = performance.now();
		if (planOn && session) {
			const owner = session;
			const client = clientFor(() => owner.accessToken());
			const list = await listModels(client);
			data.models = list.record;
			if (list.listed) {
				say(`Listed models, in the server's order: ${list.listed.join(", ") || "none"}`);
			}
			const override = validSlug(env.DRAFTYAK_S7_MODEL);
			model = override ?? list.chosen ?? DOCS_MODEL;
			modelSource = override ? "DRAFTYAK_S7_MODEL" : list.chosen ? "models" : "docs example";
			say(`Model: ${model} (${modelSource}).`);
			for (const structure of STRUCTURES) {
				say(`Drafting with ${structure}.`);
				drafts.push(await draftWith(client, model, structure));
				signal.throwIfAborted();
			}
		}
		data.model = { slug: model === undefined ? null : name(model), source: modelSource };
		data.drafts = drafts;
		ms.drafts = since(draftsStarted);

		// The documented transfer: the desktop hands the session to the hub process and forgets it.
		let transfer: TransferRecord | null = null;
		let fallback: Fallback | null = null;
		let transferVerdict: Revoked | undefined;
		const transferStarted = performance.now();
		if (credential?.tokens && endpoints) {
			const full = await store.read();
			if (!full?.tokens) throw new Error("the saved tokens didn't read back from .env.live");
			const text = transferText(full);
			handedOver = full;
			await store.write(null);
			const desktopForgot = [SAVED.access, SAVED.refresh, SAVED.client].every(
				(entry) => readEntry(entry, envLive) === undefined,
			);
			const ok = (structure: Structure) =>
				drafts.some((d) => d.structure === structure && d.outcome === "draft");
			const childStructure: Structure | undefined =
				model && planOn ? (STRUCTURES.find(ok) ?? "text-format") : undefined;
			const args = [deps.issuer, hostId, "--revoke", "--live", deps.apiOrigin];
			if (model && childStructure) args.push("--draft", model, childStructure);
			if (deferred !== undefined) args.push("--deferred", String(deferred));
			say(
				"Transfer: a second local process takes the session over, drafts once, refreshes it, revokes it and forgets it.",
			);
			if (deferred !== undefined) say(deferredPlan(full.tokens, deferred));
			const timeout = AbortSignal.any([signal, AbortSignal.timeout(childTimeoutMs(deferred))]);
			const run = await (deps.runChild ?? runTransferChild)(args, text, timeout);
			const out = isRecord(run.output) ? run.output : undefined;
			if (out === undefined) {
				const last = run.stderr.trim().split(/\r?\n/).at(-1) ?? "";
				say(`The hub process gave no result (exit ${run.exitCode}): ${redact(last)}`);
			}
			const field = out ?? {};
			const nested = (key: string): Record<string, unknown> | null =>
				isRecord(field[key]) ? (field[key] as Record<string, unknown>) : null;
			transfer = {
				exitCode: run.exitCode,
				result: out !== undefined,
				desktopForgot,
				childStructure: childStructure ?? null,
				accepted: field.accepted === true,
				refreshed: field.refreshed === true,
				rotated: typeof field.rotated === "boolean" ? field.rotated : null,
				planUsage: typeof field.planUsage === "string" ? name(field.planUsage) : null,
				code: typeof field.code === "string" ? name(field.code) : null,
				detail: typeof field.detail === "string" ? detailText(field.detail) : null,
				status: typeof field.status === "number" ? field.status : null,
				apiCode: typeof field.apiCode === "string" ? name(field.apiCode) : null,
				draft: nested("draft"),
				refresh: nested("refresh"),
				deferred: nested("deferred"),
				revoked: typeof field.revoked === "boolean" ? field.revoked : null,
				revocation: Array.isArray(field.revocation)
					? field.revocation.filter((status): status is number => typeof status === "number")
					: [],
				afterRevoke: nested("afterRevoke"),
			};
			if (deferred !== undefined) {
				const step = transfer.deferred;
				say(
					step
						? `The hub process has ended. After expiry: ${deferredText(step, deferred)}.`
						: "The hub process has ended, with no record of the step after expiry.",
				);
			}
			// The hub kept the session once it revoked it or sent a refresh, which may have rotated the
			// desktop's copy away. Otherwise this process revokes its copy itself.
			const hubKept = transfer.accepted && (transfer.revoked === true || transfer.refresh !== null);
			if (!hubKept) {
				say(
					transfer.result
						? "The hub process didn't keep the session; this process revokes it."
						: "This process revokes the session it handed over, though the hub process may have refreshed it first.",
				);
				fallback = await revokeHere(full);
			}
			handedOver = undefined;
			transferVerdict = !transfer.result
				? "no(hub process ended without a result)"
				: fallback
					? revocationVerdict(fallback.revoked, fallback.after?.refresh)
					: hubVerdict(transfer);
		}
		ms.transfer = since(transferStarted);
		data.transfer = transfer;

		// Optional API-key mode: the same requests through the same broker, billed to the owner's key.
		// Its model is DRAFTYAK_S7_API_MODEL, else the plan's model or else the docs' example if the key
		// lists it. It never picks one by name or date: without one of these, it doesn't draft.
		const keyStarted = performance.now();
		const apiKey = readEntry(API_KEY, envLive);
		const keyDrafts: Drafted[] = [];
		let keyNotRun: string | undefined;
		if (apiKey !== undefined) {
			const client = clientFor(async () => apiKey);
			const listed = await listModels(client);
			const override = validSlug(env.DRAFTYAK_S7_API_MODEL);
			const plan = model !== undefined && listed.slugs.includes(model) ? model : undefined;
			const docs = listed.slugs.includes(DOCS_MODEL) ? DOCS_MODEL : undefined;
			const keyModel = override ?? plan ?? docs;
			const keySource = override
				? "DRAFTYAK_S7_API_MODEL"
				: plan
					? "plan"
					: docs
						? "docs example"
						: null;
			if (keyModel === undefined) {
				keyNotRun = `no model: the key lists neither the plan's model nor ${DOCS_MODEL}; set DRAFTYAK_S7_API_MODEL`;
				say(`API-key mode: not run (${keyNotRun}).`);
			} else {
				say(`API-key mode: two drafts with ${keyModel} (${keySource}), billed to the key.`);
				const tool = TOOL_STRUCTURES.find((s) =>
					drafts.some((d) => d.structure === s && d.outcome === "draft"),
				);
				for (const structure of ["text-format", tool ?? "tool-top-level"] as const) {
					keyDrafts.push(await draftWith(client, keyModel, structure));
					signal.throwIfAborted();
				}
			}
			data.apiKey = {
				present: true,
				model: keyModel === undefined ? null : { slug: name(keyModel), source: keySource },
				models: listed.record,
				drafts: keyDrafts,
			};
		} else {
			data.apiKey = { present: false };
		}
		ms.apiKey = since(keyStarted);

		// Cleanup: every DY_LIVE_SIWC_* entry goes, the opt-in included.
		const deleted = deleteEnvLive(SIWC_NAMES, envLive);
		const gone = deleted.length > 0 ? `deleted ${deleted.join(", ")}` : "no DY_LIVE_SIWC_* entry";
		say(`.env.live: ${gone}.`);
		const remaining = SIWC_NAMES.filter((entry) => readEntry(entry, envLive) !== undefined);
		const accessOnly = issued.accessOnly();
		const verdicts: Revoked[] = [];
		if (orphanVerdict) verdicts.push(orphanVerdict);
		if (accessOnly) verdicts.push("no(no refresh token; remove DraftYak in ChatGPT)");
		if (transferVerdict) verdicts.push(transferVerdict);
		const revoked: Revoked =
			remaining.length > 0
				? "no(entries left in .env.live)"
				: (verdicts.find((verdict) => verdict !== "yes") ?? "yes");
		data.revocation = {
			issued: exchanged !== undefined || accessOnly || Boolean(credential?.tokens),
			orphan,
			accessOnly,
			transfer: transferVerdict ?? null,
			fallback,
			deleted,
			remaining,
		};

		const tools = drafts.filter((d) => d.structure !== "text-format");
		const notRun = !credential
			? "signin blocked"
			: !credential.tokens
				? "no refresh token"
				: !planOn
					? "plan usage off"
					: undefined;
		const transferLine = (): string => {
			if (!transfer) return `not-run(${!credential ? "signin blocked" : "no refresh token"})`;
			if (!transfer.result) return `fails(exit ${transfer.exitCode})`;
			if (transfer.accepted !== true) {
				const why = [transfer.code ?? `exit ${transfer.exitCode}`, transfer.detail].filter(Boolean);
				return `fails(${why.join(":")})`;
			}
			const hubDraft = transfer.draft;
			// The step after expiry, which runs only once the hub's own refresh worked.
			const later = transfer.deferred;
			if (later?.ran === true && later.refreshed !== true) {
				return `fails(deferred-refresh:${name(later.code ?? "unknown")})`;
			}
			const second = later && isRecord(later.draft) ? later.draft : null;
			if (second && second.outcome !== "draft" && hubDraft?.outcome === "draft") {
				return `fails(deferred-draft:${name(second.code ?? second.outcome)})`;
			}
			const desktop = drafts.find((d) => d.structure === transfer?.childStructure);
			if (hubDraft && hubDraft.outcome !== "draft" && desktop?.outcome === "draft") {
				return `fails(draft:${name(hubDraft.code ?? hubDraft.outcome)})`;
			}
			if (transfer.refreshed !== true) {
				const why = transfer.refresh
					? ["refresh", transfer.code ?? "unknown"]
					: [transfer.code ?? "unknown", transfer.detail];
				return `fails(${why.filter(Boolean).join(":")})`;
			}
			return "ok";
		};
		const lines = [
			`signin: ${credential ? "ok" : `blocked(${blocked ?? "unknown"})`}`,
			`text.format: ${notRun ? `not-run(${notRun})` : combined(drafts.filter((d) => d.structure === "text-format"))}`,
			`submit_draft: ${notRun ? `not-run(${notRun})` : combined(tools)}`,
			`transfer: ${transferLine()}`,
			`revoked: ${revoked}`,
		];
		data.lines = lines;

		const details: string[] = [];
		if (credential)
			details.push(`${PLAN_SCOPE}: ${planOn ? "granted" : "missing"}; model ${model ?? "none"}`);
		if (drafts.length > 0) details.push(`desktop drafts: ${drafts.map(draftDetail).join("; ")}`);
		if (transfer) {
			const hubDraft = transfer.draft;
			const said = hubDraft?.outcome === "draft" ? "ok" : name(hubDraft?.code ?? hubDraft?.outcome);
			const draft = hubDraft ? `draft ${said}, ` : "";
			const how = transfer.result
				? `accepted ${transfer.accepted}, ${draft}refreshed ${transfer.refreshed}, revoked ${transfer.revoked}`
				: `no result (exit ${transfer.exitCode})`;
			details.push(`hub process: ${how}${fallback ? "; this process revoked its copy" : ""}`);
			if (transfer.deferred && deferred !== undefined) {
				details.push(`after expiry: ${deferredText(transfer.deferred, deferred)}`);
			}
		}
		const after = fallback ? fallback.after : transfer?.afterRevoke;
		if (isRecord(after) && isRecord(after.refresh) && isRecord(after.models)) {
			const probe = after.refresh;
			const refresh =
				probe.accepted === true
					? "still accepted"
					: `refused (${name(probe.apiCode ?? probe.code)})`;
			const status = typeof after.models.status === "number" ? after.models.status : "no answer";
			details.push(
				`after revocation: the refresh token is ${refresh}; the access token gets ${status}`,
			);
		}
		if (orphanVerdict) details.push(`the code exchange's tokens: revoked ${orphanVerdict}`);
		if (apiKey === undefined) details.push(`api-key mode: not run (${API_KEY} isn't set)`);
		else if (keyNotRun) details.push(`api-key mode: not run (${keyNotRun})`);
		else details.push(`api-key mode: ${keyDrafts.map(draftDetail).join("; ")}`);
		if (leftover !== undefined) {
			details.push("an earlier run's tokens: revoked, and refused when tried again");
		}

		ms.total = since(began);
		data.ms = ms;
		// Discovery, the JWKS and the code exchange's answer are above; refusals, refreshes and
		// revocations keep their shapes here.
		const shaped = (call: AuthCall): boolean =>
			call.status >= 400 || call.kind === "refresh" || call.kind === "revocation";
		data.authCalls = auth.calls.map((call) => ({
			kind: call.kind,
			status: call.status,
			ms: call.ms,
			headers: call.headers ?? [],
			...(call.requestId !== undefined && { requestId: hashed(call.requestId) }),
			...(shaped(call) && call.shape && { shape: call.shape }),
		}));
		// Every request the plugin side made, as the broker verified it: names and verdicts only.
		data.brokered = brokers
			.flatMap((broker) => broker.requests)
			.map((request) => ({
				method: request.method,
				path: URL.canParse(request.url) ? pathName(new URL(request.url).pathname) : WITHHELD,
				fields: [...request.fields].sort().map(name),
				headerNames: request.headerNames.map(name),
				verdict: request.verdict.ok ? "ok" : request.verdict.problems,
				...(request.credential !== undefined && { credential: request.credential }),
				...(request.status !== undefined && { status: request.status }),
				...(request.frames !== undefined && { frames: request.frames }),
			}));
		// Every value that reads WITHHELD, from the recorders and from the final content check.
		const count = { withheld: withheldIn(data) };
		const clean = scrub(data, count) as Record<string, unknown>;
		clean.withheld = count.withheld;
		if (count.withheld > 0) {
			details.push(`${count.withheld} recorded values read ${WITHHELD}: see evidence/live.json`);
		}
		const file = await writeEvidence(
			deps.evidenceFile,
			clean,
			deps.fingerprint ? { fingerprint: deps.fingerprint } : {},
		);
		return { lines, details, revoked: revoked === "yes", data: clean, file };
	} catch (error) {
		// A stop comes before this run holds a token; what an earlier run left stays for the next one.
		if (!(error instanceof SessionStopped)) await emergency().catch(() => undefined);
		throw error;
	}
}
