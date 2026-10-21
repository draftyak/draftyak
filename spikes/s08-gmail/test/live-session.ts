import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	assertContentFree,
	cacheDir,
	deleteEnvLive,
	type EnvLiveOptions,
	envLivePath,
	type Fingerprint,
	fingerprint,
	hashId,
	loadEnvLive,
	newSessionKey,
	redact,
	redactHeaders,
	registerSecret,
	Secret,
	saveEnvLive,
	writeEvidence,
} from "@draftyak/spike-kit";
import { GMAIL_ROOT, Gmail, GmailError, header } from "../src/api.ts";
import { parseGoogleError } from "../src/classify.ts";
import { type HistoryDelta, readHistory, sentIn } from "../src/history.ts";
import {
	type MimeInput,
	newClaimStamp,
	normalizeSubject,
	type Rendered,
	renderMime,
} from "../src/mime.ts";
import {
	authorizationUrl,
	connect,
	GOOGLE,
	type OAuthEndpoints,
	OAuthError,
	openSystemBrowser,
	refreshTokens,
	revokeToken,
	ScopeError,
	scopesFor,
	type TokenClient,
	type TokenSet,
} from "../src/oauth.ts";
import { type Attempt, countsAsSent, type ReconcileResult, reconcile } from "../src/reconcile.ts";
import {
	DATE_AMBIGUITY_MS,
	dateKept,
	readBack,
	type SendResult,
	sendMessage,
} from "../src/send.ts";
import { checkSchema, validate } from "./fake-gmail.ts";
import {
	type Acceptance,
	type AgentResult,
	type Answer,
	buildReport,
	type ConcurrencySummary,
	clientDeletedCode,
	type DropResult,
	describeReconcile,
	grantStatus,
	missingSteps,
	parseObservations,
	type ReconcileShape,
	type RevokeSummary,
	type ScheduledSummary,
	type SendSummary,
	seconds,
} from "./live-report.ts";

// The S8b live procedure (M0.29), one step per run: gmail.live.test.ts runs it against Google, and
// rehearsal.test.ts runs the same code against FakeGmail and the fake OAuth server. Each step keeps
// its content-free result in the session folder's state.json; the report step turns those and the
// owner's observations into evidence/live.json. notes/session.md is the runbook.

export const NAMES = {
	clientId: "DY_LIVE_GMAIL_CLIENT_ID",
	clientSecret: "DY_LIVE_GMAIL_CLIENT_SECRET",
	refreshToken: "DY_LIVE_GMAIL_REFRESH_TOKEN",
	agentClientId: "DY_LIVE_GMAIL_AGENT_CLIENT_ID",
	agentClientSecret: "DY_LIVE_GMAIL_AGENT_CLIENT_SECRET",
} as const;
export const ALL_NAMES: readonly string[] = Object.values(NAMES);

export const STEPS = [
	"agent",
	"drop",
	"connect",
	"send",
	"concurrency",
	"schedule",
	"scheduled",
	"sent",
	"revoke",
	"report",
] as const;
export type Step = (typeof STEPS)[number];
export type ClientKind = "standard" | "agent";

const api = [NAMES.clientId, NAMES.clientSecret, NAMES.refreshToken];
const clients = [NAMES.clientId, NAMES.clientSecret, NAMES.agentClientId, NAMES.agentClientSecret];
export const REQUIRED: Readonly<Record<Step | "preflight", readonly string[]>> = {
	preflight: clients,
	agent: [NAMES.agentClientId, NAMES.agentClientSecret],
	drop: clients,
	connect: [NAMES.clientId, NAMES.clientSecret],
	send: api,
	concurrency: api,
	schedule: api,
	scheduled: api,
	sent: api,
	revoke: api,
	report: [],
};

// The owner's word for what no redirect can show (DRAFTYAK_S8_OUTCOME): Google refused the agent
// client on its own page, or the drop step's consent page offered no Gmail checkbox.
export const DECLARED = { refused: "agent", "no-checkbox": "drop" } as const;
export type Declared = keyof typeof DECLARED;

const MINUTE = 60_000;
// A consent waits up to 5 minutes, then its revocation checks take up to about 3.
export const STEP_TIMEOUT_MS: Readonly<Record<Step | "preflight", number>> = {
	preflight: MINUTE,
	agent: 10 * MINUTE,
	drop: 10 * MINUTE,
	connect: 10 * MINUTE,
	send: 8 * MINUTE,
	concurrency: 3 * MINUTE,
	schedule: 2 * MINUTE,
	scheduled: 5 * MINUTE,
	sent: 12 * MINUTE,
	revoke: 4 * MINUTE,
	report: 2 * MINUTE,
};

export const SEND_SUBJECT = "DY S8 send probe";
export const SCHEDULED_SUBJECT = "DY S8 scheduled probe";
// Back-dated within the 2-minute clock rule, so a Date that Gmail rewrites shows (M0.28 handoff).
export const STAMP_LEAD_MS = 90_000;
// "Mail sending" can lock sending for hours, so the session stays well under 10 sends.
export const MAX_SENDS = 8;
// How far before the claim reconcile's in:sent search starts (its default skew).
const SKEW_MS = 120_000;

export interface Timing {
	readonly pollMs: number;
	readonly indexTimeoutMs: number;
	readonly findTimeoutMs: number;
	readonly sentPollMs: number;
	readonly sentTimeoutMs: number;
	readonly roundPauseMs: number;
	readonly backoffMs: number;
	// Google says a revocation can take a while: refreshes repeat until one fails with invalid_grant.
	readonly revokePollMs: number;
	readonly revokeTimeoutMs: number;
	// How long a consent waits for Google's redirect.
	readonly consentTimeoutMs: number;
	// The scheduled mail's send time is at least scheduleLeadMs ahead, on a whole minute as Gmail's
	// picker takes it, and the scheduled step stops reading sendMarginMs before it.
	readonly scheduleLeadMs: number;
	readonly sendMarginMs: number;
}

export const LIVE_TIMING: Timing = {
	pollMs: 1_000,
	indexTimeoutMs: 90_000,
	findTimeoutMs: 2 * MINUTE,
	sentPollMs: 15_000,
	sentTimeoutMs: 8 * MINUTE,
	roundPauseMs: 2_000,
	backoffMs: 5_000,
	revokePollMs: 5_000,
	revokeTimeoutMs: MINUTE,
	consentTimeoutMs: 5 * MINUTE,
	scheduleLeadMs: 10 * MINUTE,
	sendMarginMs: MINUTE,
};

// Bounded parallel reads for the concurrency 429: 1-unit getProfile calls first, then one burst of
// 5-unit lists, at most 100 at once and 225 in all (about 385 quota units over some seconds).
export interface Burst {
	readonly call: "getProfile" | "messages.list";
	readonly parallel: number;
}
export const BURSTS: readonly Burst[] = [
	{ call: "getProfile", parallel: 10 },
	{ call: "getProfile", parallel: 25 },
	{ call: "getProfile", parallel: 50 },
	{ call: "getProfile", parallel: 100 },
	{ call: "messages.list", parallel: 40 },
];

export interface Session {
	readonly envLive: EnvLiveOptions;
	readonly endpoints: Readonly<Record<ClientKind, OAuthEndpoints>>;
	readonly gmailRoot: string;
	readonly fetch: typeof fetch;
	readonly openBrowser: (url: string) => void | Promise<void>;
	// state.json, input.json and the evidence preview; outside the repository.
	readonly dir: string;
	readonly evidenceDir: string;
	// Where fingerprints and commits are read.
	readonly repoDir: string;
	readonly record: boolean;
	readonly requireClean: boolean;
	readonly timing: Timing;
	readonly bursts?: readonly Burst[];
	readonly sampleMs?: number;
	readonly declared?: Declared;
	readonly log: (line: string) => void;
}

export const spikeDir: string = path.resolve(import.meta.dirname, "..");

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

export function stepFromEnv(env: NodeJS.ProcessEnv = process.env): Step | undefined {
	const value = env.DRAFTYAK_S8_STEP ?? "";
	if (value === "") return undefined;
	if ((STEPS as readonly string[]).includes(value)) return value as Step;
	throw new Error(`DRAFTYAK_S8_STEP is one of ${STEPS.join(", ")}, not "${value}"`);
}

export function declaredFromEnv(env: NodeJS.ProcessEnv = process.env): Declared | undefined {
	const value = env.DRAFTYAK_S8_OUTCOME ?? "";
	if (value === "") return undefined;
	if (Object.hasOwn(DECLARED, value)) return value as Declared;
	throw new Error(
		`DRAFTYAK_S8_OUTCOME is refused (agent step) or no-checkbox (drop step), not "${value}"`,
	);
}

// DRAFTYAK_RECORD_EVIDENCE=1 lets the report step write evidence/live.json; 0 or unset previews it.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (value !== "" && value !== "0" && value !== "1") {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1";
}

// DRAFTYAK_S8_SESSION (absolute), else s08-session in the cache folder (C:/dev/.draftyak-cache).
export function sessionDir(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.DRAFTYAK_S8_SESSION;
	if (dir) {
		if (!path.isAbsolute(dir)) throw new Error("DRAFTYAK_S8_SESSION must be an absolute path");
		return path.resolve(dir);
	}
	return path.join(cacheDir(env), "s08-session");
}

export function liveSession(
	env: NodeJS.ProcessEnv = process.env,
	log: (line: string) => void = (line) => console.log(line),
): Session {
	const declared = declaredFromEnv(env);
	return {
		envLive: {},
		endpoints: { standard: GOOGLE, agent: GOOGLE },
		gmailRoot: GMAIL_ROOT,
		fetch: (input, init) => fetch(input, init),
		openBrowser: (url) => openSystemBrowser(url, log),
		dir: sessionDir(env),
		evidenceDir: path.join(spikeDir, "evidence"),
		repoDir: spikeDir,
		record: recording(env),
		requireClean: true,
		timing: LIVE_TIMING,
		...(declared === undefined ? {} : { declared }),
		log,
	};
}

// The session's state: each step's content-free result, plus the raw Gmail values the schedule
// steps hand on (`work`), which never reach evidence and go with the session folder.
export interface StepRecord {
	readonly at: string;
	readonly commit: string | null;
	readonly dirty: boolean | null;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface Work {
	readonly sends?: number;
	readonly historyStart?: string;
	readonly startedAt?: number;
	// When the owner's scheduled mail goes out (the schedule step's time, or live-cli send-at).
	readonly sendAt?: number;
	readonly baseline?: readonly string[];
	readonly scheduledIds?: readonly string[];
	// The history start for the sent step, from the look that first showed the mail scheduled.
	readonly scheduledHistory?: string;
	readonly scheduledHistoryAt?: number;
}

export interface State {
	readonly version: 1;
	readonly steps: Readonly<Partial<Record<Step, StepRecord>>>;
	readonly work: Work;
}

const stateFile = (dir: string): string => path.join(dir, "state.json");

export function readState(dir: string): State {
	const file = stateFile(dir);
	if (!existsSync(file)) return { version: 1, steps: {}, work: {} };
	const state = JSON.parse(readFileSync(file, "utf8")) as State;
	if (state.version !== 1) throw new Error(`${file} isn't an S8 session state`);
	return state;
}

function writeJson(file: string, value: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} finally {
		rmSync(temp, { force: true });
	}
}

function updateWork(dir: string, change: Partial<Work>): void {
	const state = readState(dir);
	writeJson(stateFile(dir), { ...state, work: { ...state.work, ...change } });
}

const clock = (at: number): string => {
	const date = new Date(at);
	const day = date.toLocaleDateString([], { weekday: "long" });
	return `${day} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

// The next HH:MM (24-hour, or with AM/PM) on this computer's clock after `after`.
export function nextClockTime(time: string, after: number): number {
	const match = /^(\d{1,2}):(\d{2})\s*([ap]m)?$/i.exec(time.trim());
	const hour = Number(match?.[1]);
	const minute = Number(match?.[2]);
	const half = match?.[3]?.toLowerCase();
	if (match === null || minute > 59 || (half === undefined ? hour > 23 : hour < 1 || hour > 12)) {
		throw new Error(`the time is HH:MM, such as 15:47 or 3:47 PM, not "${time}"`);
	}
	const at = new Date(after);
	at.setHours(half === undefined ? hour : (hour % 12) + (half === "pm" ? 12 : 0), minute, 0, 0);
	if (at.getTime() <= after) at.setDate(at.getDate() + 1);
	return at.getTime();
}

// The time the owner actually picked in Gmail's Schedule send, when it isn't the one suggested.
export function setSendAt(dir: string, time: string): string {
	const { startedAt } = readState(dir).work;
	if (startedAt === undefined) throw new Error("run the schedule step first");
	const sendAt = nextClockTime(time, startedAt);
	updateWork(dir, { sendAt });
	return `the scheduled mail goes out ${clock(sendAt)}; the scheduled step reads it until a minute before`;
}

// The commit and whether tracked files outside evidence/ changed, as S1's codeChanged() reads it.
export function codeState(dir: string): {
	readonly commit: string | null;
	readonly dirty: boolean | null;
} {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
	);
	const git = (...args: string[]) =>
		spawnSync("git", args, { cwd: dir, encoding: "utf8", env, windowsHide: true });
	const head = git("rev-parse", "HEAD");
	const status = git(
		"status",
		"--porcelain",
		"--untracked-files=no",
		"--",
		":/",
		":(exclude)evidence",
	);
	const sha = head.status === 0 ? head.stdout.trim() : "";
	return {
		commit: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null,
		dirty: status.status === 0 ? status.stdout.trim() !== "" : null,
	};
}

export function saveStep(
	session: Session,
	step: Step,
	data: Readonly<Record<string, unknown>>,
): void {
	assertContentFree(data, `the ${step} step's result`);
	const state = readState(session.dir);
	const record: StepRecord = { at: new Date().toISOString(), ...codeState(session.repoDir), data };
	writeJson(stateFile(session.dir), { ...state, steps: { ...state.steps, [step]: record } });
}

export interface SessionInput {
	readonly secondAddress?: unknown;
	readonly testAccount?: unknown;
	readonly accountName?: unknown;
	readonly observations?: unknown;
}

const INPUT_FIELDS = new Set(["secondAddress", "testAccount", "accountName", "observations"]);

export function readInput(dir: string): SessionInput {
	const file = path.join(dir, "input.json");
	if (!existsSync(file)) throw new Error(`no ${file}: write it as notes/session.md says`);
	const bytes = readFileSync(file);
	if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
		throw new Error(`${file} is UTF-16: save it as UTF-8`);
	}
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`${file} isn't valid JSON`);
	}
	if (!isRecord(value)) throw new Error(`${file} must hold a JSON object`);
	const extra = Object.keys(value).filter((key) => !INPUT_FIELDS.has(key));
	if (extra.length > 0) throw new Error(`${file}: unknown fields ${extra.join(", ")}`);
	return value;
}

const optionalInput = (dir: string): SessionInput =>
	existsSync(path.join(dir, "input.json")) ? readInput(dir) : {};

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

// The owner's second address, registered as a secret so that evidence can never hold it.
export function secondAddress(input: SessionInput): Secret {
	const value = input.secondAddress;
	if (typeof value !== "string" || !ADDRESS.test(value)) {
		throw new Error("input.json's secondAddress must be the owner's second e-mail address");
	}
	return new Secret(value);
}

// The test account's address, if input.json names it: the consents pass it as login_hint, and
// connect refuses a grant from any other account.
export function testAccount(input: SessionInput): Secret | undefined {
	const value = input.testAccount;
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !ADDRESS.test(value)) {
		throw new Error("input.json's testAccount must be the test Gmail address");
	}
	return new Secret(value);
}

// The test account's name as Google shows it: the report refuses observations that hold it.
export function accountName(input: SessionInput): Secret {
	const value = input.accountName;
	if (typeof value !== "string" || value.trim().length < 2 || value.length > 100) {
		throw new Error("input.json's accountName must be the test account's name as Google shows it");
	}
	return new Secret(value.trim());
}

// Gmail ignores dots and +tags in gmail.com addresses, and googlemail.com is the same domain.
export function sameMailbox(a: string, b: string): boolean {
	const key = (address: string): string => {
		const at = address.lastIndexOf("@");
		const domain = address
			.slice(at + 1)
			.toLowerCase()
			.replace(/^googlemail\.com$/, "gmail.com");
		const local = address.slice(0, at).toLowerCase().replace(/\+.*$/, "");
		return `${domain === "gmail.com" ? local.replaceAll(".", "") : local}@${domain}`;
	};
	return key(a) === key(b);
}

export function shortScope(scope: string): string {
	if (/^(?:openid|email|profile)$/.test(scope)) return scope;
	if (scope === "https://mail.google.com/") return "mail.google.com";
	return /^https:\/\/www\.googleapis\.com\/auth\/([\w.-]+)$/.exec(scope)?.[1] ?? "other";
}

export function shortScopes(scopes: string): string[] {
	const names = scopes.split(/\s+/).filter((scope) => scope !== "");
	return [...new Set(names.map(shortScope))].toSorted();
}

// System labels by name; user labels (Label_<n>) are ids, so they show only as user-label.
export function systemLabels(labels: readonly string[] | undefined): string[] {
	const names = (labels ?? []).map((label) =>
		/^[A-Z][A-Z0-9_]*$/.test(label) ? label : "user-label",
	);
	return [...new Set(names)].toSorted();
}

// A discovery-document problem without the values it may quote (query values, ids in paths).
export function sanitizeProblem(problem: string): string {
	const words = problem
		.replace(/=[^\s,;)]*/g, "=<value>")
		.replace(/[\w-]*\d[\w-]*/g, (word) =>
			word.length >= 8 && word !== "rfc822msgid" ? "<id>" : word,
		);
	return redact(words).slice(0, 200);
}

const cleanText = (text: string): string => redact(text).replace(/\s+/g, " ").trim().slice(0, 120);

export interface TokenShape {
	readonly status: number;
	readonly fields: readonly string[];
	readonly expiresIn?: number;
	readonly refreshTokenExpiresIn?: number;
	readonly tokenType?: string;
	readonly scopes?: readonly string[];
	readonly error?: string;
}

// The token endpoint's answer as names and numbers; the tokens themselves stay in memory.
export function tokenShape(status: number, body: Readonly<Record<string, unknown>>): TokenShape {
	const number = (key: string): number | undefined =>
		typeof body[key] === "number" ? (body[key] as number) : undefined;
	const word = (key: string, pattern: RegExp): string | undefined => {
		const value = body[key];
		if (typeof value !== "string") return undefined;
		return pattern.test(value) ? value : "other";
	};
	const expiresIn = number("expires_in");
	const refreshTokenExpiresIn = number("refresh_token_expires_in");
	const tokenType = word("token_type", /^\w{1,20}$/);
	const error = word("error", /^[a-z_]{1,40}$/);
	return {
		status,
		fields: Object.keys(body).toSorted(),
		...(expiresIn === undefined ? {} : { expiresIn }),
		...(refreshTokenExpiresIn === undefined ? {} : { refreshTokenExpiresIn }),
		...(tokenType === undefined ? {} : { tokenType }),
		...(typeof body.scope === "string" ? { scopes: shortScopes(body.scope) } : {}),
		...(error === undefined ? {} : { error }),
	};
}

interface OAuthSink {
	readonly shapes: TokenShape[];
	readonly revocations: number[];
	// Token requests started: a code came back from Google's consent before the first one.
	tokenRequests: number;
	refreshToken?: string;
	accountEmail?: string;
}

// A cross-check of the token endpoint's TLS response, not independent JWT verification.
// The claim is bounded and stays in memory; no userinfo or key-discovery request is made.
function tokenEmail(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 16_384) return undefined;
	const parts = value.split(".");
	if (parts.length !== 3 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return undefined;
	if ((parts[1]?.length ?? 0) > 8_192) return undefined;
	try {
		const encoded = parts[1] ?? "";
		const decoded = Buffer.from(encoded, "base64url");
		if (decoded.toString("base64url") !== encoded) return undefined;
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded);
		registerSecret(text);
		const payload: unknown = JSON.parse(text);
		const email = isRecord(payload) ? payload.email : undefined;
		if (
			typeof email !== "string" ||
			email.length > 320 ||
			!/^[\x21-\x7e]+$/.test(email) ||
			!ADDRESS.test(email)
		) {
			return undefined;
		}
		registerSecret(email);
		return email;
	} catch {
		return undefined;
	}
}

const urlOf = (input: RequestInfo | URL): string =>
	input instanceof Request ? input.url : String(input);

function oauthFetch(base: typeof fetch, endpoints: OAuthEndpoints, sink: OAuthSink): typeof fetch {
	return async (input, init) => {
		const url = urlOf(input);
		if (url === endpoints.token) sink.tokenRequests++;
		const response = await base(input, init);
		if (url === endpoints.revocation) sink.revocations.push(response.status);
		if (url !== endpoints.token) return response;
		const json: unknown = await response
			.clone()
			.json()
			.catch(() => ({}));
		const body = isRecord(json) ? json : {};
		for (const key of ["access_token", "refresh_token", "id_token"]) {
			const value = body[key];
			if (typeof value === "string") registerSecret(value);
		}
		if (typeof body.refresh_token === "string") sink.refreshToken = body.refresh_token;
		const email = tokenEmail(body.id_token);
		if (email !== undefined) sink.accountEmail = email;
		sink.shapes.push(tokenShape(response.status, body));
		return response;
	};
}

type RedactedHeaders = ReturnType<typeof redactHeaders>;

export interface GmailTraffic {
	requests: number;
	responsesChecked: number;
	readonly problems: string[];
	readonly failures: { readonly status: number; readonly headers: RedactedHeaders }[];
}

export const newTraffic = (): GmailTraffic => ({
	requests: 0,
	responsesChecked: 0,
	problems: [],
	failures: [],
});

// Every Gmail request is checked against the vendored discovery document before it leaves, and
// every JSON answer against its method's response schema, with FakeGmail's own validator.
export function gmailFetch(base: typeof fetch, traffic: GmailTraffic): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const sent: string[] = [];
		const valid = validate(request, Buffer.from(await request.arrayBuffer()), sent);
		traffic.requests++;
		traffic.problems.push(...sent.map(sanitizeProblem));
		const response = await base(input, init);
		if (!response.ok) {
			traffic.failures.push({ status: response.status, headers: redactHeaders(response.headers) });
		}
		const schema = valid?.method.response;
		const json = /json/i.test(response.headers.get("content-type") ?? "");
		if (response.ok && schema !== undefined && json) {
			traffic.responsesChecked++;
			const answered: string[] = [];
			const body: unknown = await response
				.clone()
				.json()
				.catch(() => undefined);
			if (body === undefined) answered.push(`${valid?.method.id}: the answer isn't JSON`);
			else checkSchema(body, schema, "response", undefined, answered);
			traffic.problems.push(...answered.map(sanitizeProblem));
		}
		return response;
	};
}

const discoveryShape = (traffic: GmailTraffic) => ({
	requests: traffic.requests,
	responsesChecked: traffic.responsesChecked,
	problems: [...new Set(traffic.problems)],
});

// One refresh at a time; the access token is renewed two minutes before it ends.
function accessTokens(client: TokenClient, refreshToken: string): () => Promise<string> {
	let current: TokenSet | undefined;
	let pending: Promise<string> | undefined;
	return () => {
		if (current !== undefined && current.expiresAt - Date.now() > 120_000) {
			return Promise.resolve(current.accessToken);
		}
		pending ??= refreshTokens(client, refreshToken)
			.then((set) => {
				registerSecret(set.accessToken);
				current = set;
				return set.accessToken;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
}

export interface Credentials {
	readonly clientId: string;
	readonly clientSecret: string;
}

function credentialsOf(session: Session, kind: ClientKind): Credentials {
	const [id, secret] =
		kind === "agent"
			? ([NAMES.agentClientId, NAMES.agentClientSecret] as const)
			: ([NAMES.clientId, NAMES.clientSecret] as const);
	const secrets = loadEnvLive([id, secret], session.envLive);
	return { clientId: secrets[id].reveal(), clientSecret: secrets[secret].reveal() };
}

function optionalEntry(session: Session, name: string): string | undefined {
	try {
		return loadEnvLive([name], session.envLive)[name]?.reveal();
	} catch {
		return undefined;
	}
}

interface Mailbox {
	readonly gmail: Gmail;
	readonly traffic: GmailTraffic;
	readonly client: TokenClient;
	readonly refreshToken: string;
}

// The standard client's grant from the connect step, through the saved refresh token.
function mailbox(session: Session): Mailbox {
	const refreshToken = loadEnvLive([NAMES.refreshToken], session.envLive)[
		NAMES.refreshToken
	].reveal();
	const client: TokenClient = {
		...credentialsOf(session, "standard"),
		endpoints: session.endpoints.standard,
		fetch: session.fetch,
	};
	const traffic = newTraffic();
	const gmail = new Gmail({
		accessToken: accessTokens(client, refreshToken),
		root: session.gmailRoot,
		fetch: gmailFetch(session.fetch, traffic),
	});
	return { gmail, traffic, client, refreshToken };
}

// Guardrail 5: the disclosure comes right before Google's consent (a stand-in for M5's wizard).
export function disclosure(kind: ClientKind): string[] {
	const client = kind === "agent" ? "AI-powered-agent" : "standard";
	return [
		`Before Google's consent: DraftYak's S8 spike asks this test account for openid, email and gmail.modify through its ${client} Desktop client.`,
		`It reads, labels and sends mail only for this session (at most ${MAX_SENDS} sends), keeps content-free shapes, and revokes the access when the session ends.`,
		"If you schedule a message, its approved text waits, encrypted, in your hub until it is sent.",
	];
}

interface Consented {
	readonly client: TokenClient;
	// The authorization request's parameter names, never their values.
	readonly asked: readonly string[];
	readonly tokenRequests: number;
	readonly tokens?: TokenSet;
	readonly error?: OAuthError;
	readonly shape?: TokenShape;
	// From the token answer, also when connect() refused the grant and revoked it.
	readonly refreshToken?: string;
	readonly accountEmail?: string;
}

async function consent(session: Session, kind: ClientKind, prompt: string): Promise<Consented> {
	const sink: OAuthSink = { shapes: [], revocations: [], tokenRequests: 0 };
	const endpoints = session.endpoints[kind];
	const client: TokenClient = {
		...credentialsOf(session, kind),
		endpoints,
		fetch: oauthFetch(session.fetch, endpoints, sink),
	};
	const loginHint = testAccount(optionalInput(session.dir))?.reveal();
	let asked: readonly string[] = [];
	const openBrowser = async (url: string): Promise<void> => {
		asked = [...new URL(url).searchParams.keys()].toSorted();
		for (const line of [...disclosure(kind), prompt]) session.log(line);
		await session.openBrowser(url);
	};
	const answers = (): Omit<Consented, "client" | "tokens" | "error"> => ({
		asked,
		tokenRequests: sink.tokenRequests,
		...(sink.shapes.at(-1) === undefined ? {} : { shape: sink.shapes.at(-1) }),
		...(sink.refreshToken === undefined ? {} : { refreshToken: sink.refreshToken }),
		...(sink.accountEmail === undefined ? {} : { accountEmail: sink.accountEmail }),
	});
	try {
		const tokens = await connect({
			...client,
			mode: "full",
			accessType: "offline",
			openBrowser,
			timeoutMs: session.timing.consentTimeoutMs,
			...(loginHint === undefined ? {} : { loginHint }),
		});
		return { client, tokens, ...answers() };
	} catch (error) {
		if (!(error instanceof OAuthError)) throw error;
		return { client, error, ...answers() };
	}
}

// The parameter names a consent asks with, for a refusal the owner declares instead.
function askedNames(session: Session): string[] {
	const hint = testAccount(optionalInput(session.dir)) === undefined ? {} : { loginHint: "-" };
	const url = authorizationUrl({
		endpoint: GOOGLE.authorization,
		clientId: "-",
		redirectUri: "http://127.0.0.1",
		scopes: scopesFor("full"),
		state: "-",
		challenge: "-",
		accessType: "offline",
		...hint,
	});
	return [...new URL(url).searchParams.keys()].toSorted();
}

async function refreshOutcome(client: TokenClient, refreshToken: string): Promise<string> {
	try {
		registerSecret((await refreshTokens(client, refreshToken)).accessToken);
		return "ok";
	} catch (error) {
		return error instanceof OAuthError ? error.code : "error";
	}
}

export type Revocation = {
	// Revoke requests the step sent (0 when connect()'s own revoke sufficed), and whether Google
	// accepted one of them, or connect()'s.
	readonly revokes: number;
	readonly accepted: boolean;
	readonly refreshes: number;
	// The last refresh's result: invalid_grant once the grant has ended.
	readonly refreshAfter: string;
	readonly endedAfterMs: number | null;
};

// A refresh that still works, or failed in passing, is tried again.
const unsettled = (code: string): boolean =>
	code === "ok" || code === "network" || code === "error" || /^http_(?:429|5\d\d)$/.test(code);

// Ends a grant: Google's revoke, then refreshes until one fails with invalid_grant (the M0.28
// handoff's check), for up to revokeTimeoutMs, since Google says a revocation can take a while. A
// grant that still refreshes then is revoked once more and checked again.
async function endGrant(
	session: Session,
	client: TokenClient,
	refreshToken: string,
	revoked = false,
): Promise<Revocation> {
	const started = Date.now();
	let revokes = 0;
	let accepted = revoked;
	let refreshes = 0;
	let refreshAfter = "error";
	const revoke = async (): Promise<void> => {
		revokes++;
		accepted = (await revokeToken(client, refreshToken).catch(() => false)) || accepted;
	};
	const check = async (): Promise<void> => {
		const until = Date.now() + session.timing.revokeTimeoutMs;
		for (;;) {
			refreshes++;
			refreshAfter = await refreshOutcome(client, refreshToken);
			if (!unsettled(refreshAfter) || Date.now() >= until) return;
			await sleep(session.timing.revokePollMs);
		}
	};
	if (!revoked) await revoke();
	await check();
	if (unsettled(refreshAfter)) {
		await revoke();
		await check();
	}
	const endedAfterMs = refreshAfter === "invalid_grant" ? Date.now() - started : null;
	return { revokes, accepted, refreshes, refreshAfter, endedAfterMs };
}

const MANUAL_REVOKE =
	"remove the app's access in the test account (Google Account, Security, Your connections to third-party apps)";

// Ends a grant the step won't keep, then stops the step.
async function endLeftover(session: Session, consented: Consented, why: string): Promise<never> {
	let note = "";
	if (consented.refreshToken !== undefined) {
		const revoked = consented.error instanceof ScopeError && consented.error.revoked;
		const ended = await endGrant(session, consented.client, consented.refreshToken, revoked);
		if (ended.refreshAfter !== "invalid_grant") {
			note = `. The grant it left still refreshes (${ended.refreshAfter}): ${MANUAL_REVOKE}`;
		}
	} else if (consented.tokens !== undefined) {
		await revokeToken(consented.client, consented.tokens.accessToken).catch(() => false);
	}
	throw new Error(`${why}${note}`);
}

async function gmailApiCheck(
	session: Session,
	accessToken: string,
): Promise<{ readonly result: string; readonly address?: string }> {
	const gmail = new Gmail({
		accessToken,
		root: session.gmailRoot,
		fetch: gmailFetch(session.fetch, newTraffic()),
	});
	try {
		const address = (await gmail.getProfile()).emailAddress;
		registerSecret(address);
		return { result: "works", address };
	} catch (error) {
		return { result: error instanceof GmailError ? `refused (HTTP ${error.status})` : "failed" };
	}
}

function consentShape(consented: Consented, gmailApi: string): Readonly<Record<string, unknown>> {
	return {
		asked: consented.asked,
		refreshIssued: consented.refreshToken !== undefined,
		scopes: shortScopes(consented.tokens?.scope ?? ""),
		token: consented.shape ?? null,
		gmailApi,
	};
}

interface Run {
	readonly session: Session;
	readonly id: (value: string) => string;
}

interface Done {
	readonly data: Readonly<Record<string, unknown>>;
	readonly lines: readonly string[];
}

// Consents that ended without Google's verdict: the owner's Cancel (access_denied), a page closed
// or left until the timeout, or a redirect without a code. The step is rerun, never recorded.
const UNFINISHED = new Set(["timeout", "aborted", "closed", "no_code", "access_denied"]);

// Google's refusal as its redirect's error code. A failure after a code came back is the token
// endpoint's, so that is a rerun too.
function refusalCode(consented: Consented): string | undefined {
	const code = consented.error?.code;
	if (code === undefined || consented.tokenRequests > 0 || UNFINISHED.has(code)) return undefined;
	return code;
}

// Procedure step 1 with the AI-powered-agent flag: a full consent (wording, Gmail API), then
// Google's revoke, confirmed by refreshes that end in invalid_grant. A refusal is a finding: as
// the redirect's error code, or declared by the owner (s8 agent refused) when Google refused on
// its own page, which never redirects back.
async function agentStep(run: Run): Promise<Done> {
	const { session } = run;
	const record = "Record that page's wording under observations.consent.agent.";
	if (session.declared === "refused") {
		const data: AgentResult = {
			client: "agent",
			consent: {
				asked: askedNames(session),
				error: "refused-on-page",
				redirected: false,
				declared: true,
				token: null,
			},
			fullGrant: null,
		};
		return {
			data,
			lines: ["agent client: Google refused the consent on its own page (declared)", record],
		};
	}
	const full = await consent(
		session,
		"agent",
		"Agent client: allow every permission, and copy the page's wording with your name and address replaced by <account>.",
	);
	if (full.tokens === undefined) {
		const code = refusalCode(full);
		if (code === undefined) {
			const failed = full.error?.code ?? "no tokens";
			return endLeftover(
				session,
				full,
				full.error instanceof ScopeError
					? `the consent left out a permission (${failed}): rerun agent and allow all`
					: full.tokenRequests > 0
						? `the token request failed (${failed}): rerun agent`
						: `the consent didn't finish (${failed}): rerun agent. If Google refused this client on its own page, record that with: s8 agent refused`,
			);
		}
		const data: AgentResult = {
			client: "agent",
			consent: {
				asked: full.asked,
				error: code,
				redirected: true,
				declared: false,
				token: full.shape ?? null,
			},
			fullGrant: null,
		};
		return { data, lines: [`agent client: Google refused the consent (${code})`, record] };
	}
	const api = await gmailApiCheck(session, full.tokens.accessToken);
	const expected = testAccount(optionalInput(session.dir))?.reveal();
	if (expected === undefined || api.address === undefined || !sameMailbox(api.address, expected)) {
		return endLeftover(
			session,
			full,
			"the agent consent's account could not be matched to input.json's testAccount: configure it, then rerun agent and choose that account",
		);
	}
	const fullGrant: Revocation =
		full.refreshToken === undefined
			? {
					revokes: 1,
					accepted: await revokeToken(full.client, full.tokens.accessToken).catch(() => false),
					refreshes: 0,
					refreshAfter: "no-refresh-token",
					endedAfterMs: null,
				}
			: await endGrant(session, full.client, full.refreshToken);
	if (fullGrant.refreshAfter !== "invalid_grant" && fullGrant.refreshAfter !== "no-refresh-token") {
		throw new Error(
			`the agent client's grant still refreshes (${fullGrant.refreshAfter}) after ${fullGrant.revokes} revocations: rerun agent (its revocation ends the client's whole grant), or ${MANUAL_REVOKE}`,
		);
	}
	const data: AgentResult = {
		client: "agent",
		consent: consentShape(full, api.result),
		fullGrant,
	};
	const grant =
		fullGrant.refreshAfter === "invalid_grant"
			? "grant revoked (refresh: invalid_grant)"
			: `no refresh token to check; revoke ${fullGrant.accepted ? "accepted" : "refused"}, and the grant ends when the client is deleted`;
	return {
		data,
		lines: [
			`agent client: Gmail API ${api.result}; ${grant}`,
			"Record the agent client's wording, screens and checkboxes under observations.consent.agent.",
		],
	};
}

const NO_CHECKBOX = "not possible at consent (the page offered no Gmail checkbox)";

function dropBehaviour(error: ScopeError, revocation: Revocation | null): string {
	const missing = error.check.missing.map(shortScope).join(", ") || "none";
	const refused = `refused (${error.code}: ${missing})`;
	if (revocation === null) {
		return `${refused}, connect's revoke ${error.revoked ? "accepted" : "not accepted"} (no refresh token to check)`;
	}
	const by =
		revocation.revokes === 0
			? "connect"
			: error.revoked
				? "connect, then again by the step"
				: "the step";
	return `${refused}, grant revoked by ${by} (refresh: ${revocation.refreshAfter})`;
}

// Procedure step 5 on the standard client before connect, a client without a grant, so that
// Google shows every permission: gmail.modify unticked, connect() refuses the grant and revokes
// it, and refreshes then end in invalid_grant (the M0.28 handoff's check). The agent client's
// consent page, checkboxes included, is the agent step's observation.
async function dropStep(run: Run): Promise<Done> {
	const { session } = run;
	if (optionalEntry(session, NAMES.refreshToken) !== undefined) {
		throw new Error(
			"the standard client holds the session's grant already: drop runs before connect",
		);
	}
	if (session.declared === "no-checkbox") {
		const data: DropResult = {
			client: "standard",
			result: "not possible at consent",
			declared: true,
			revokedByConnect: null,
			revocation: null,
			finalRefresh: "no-grant",
			token: null,
			behaviour: NO_CHECKBOX,
		};
		return { data, lines: [`scope drop: ${NO_CHECKBOX} (declared)`] };
	}
	const drop = await consent(
		session,
		"standard",
		"Scope drop, standard client: untick the Gmail permission (reading, composing and sending email), then continue.",
	);
	const { error } = drop;
	if (!(error instanceof ScopeError)) {
		return endLeftover(
			session,
			drop,
			drop.tokens === undefined
				? `the consent failed (${error?.code ?? "no tokens"}): rerun drop`
				: "the consent kept gmail.modify: rerun drop and untick the Gmail permission. If the page offered no Gmail checkbox, record that with: s8 drop no-checkbox",
		);
	}
	const expected = testAccount(optionalInput(session.dir))?.reveal();
	if (
		expected === undefined ||
		drop.accountEmail === undefined ||
		!sameMailbox(drop.accountEmail, expected)
	) {
		return endLeftover(
			session,
			drop,
			"the drop consent's account could not be matched to input.json's testAccount: configure it, then rerun drop and choose that account",
		);
	}
	const revocation =
		drop.refreshToken === undefined
			? null
			: await endGrant(session, drop.client, drop.refreshToken, error.revoked);
	if (revocation !== null && revocation.refreshAfter !== "invalid_grant") {
		throw new Error(
			`the dropped grant still refreshes (${revocation.refreshAfter}) after the step's ${revocation.revokes} revocations: rerun drop, or ${MANUAL_REVOKE}`,
		);
	}
	const behaviour = dropBehaviour(error, revocation);
	const data: DropResult = {
		client: "standard",
		asked: drop.asked,
		result: "refused",
		declared: false,
		code: error.code,
		missing: error.check.missing.map(shortScope),
		extra: error.check.extra.map(shortScope),
		revokedByConnect: error.revoked,
		revocation,
		finalRefresh: revocation?.refreshAfter ?? "no-refresh-token",
		token: drop.shape ?? null,
		behaviour,
	};
	return { data, lines: [`scope drop: ${behaviour}`] };
}

const standardClient = (session: Session): TokenClient => ({
	...credentialsOf(session, "standard"),
	endpoints: session.endpoints.standard,
	fetch: session.fetch,
});

// Procedure step 1 on the standard client, whose grant the later steps use; a refresh token left
// by an earlier run is revoked first, so the consent starts a fresh grant.
async function connectStep(run: Run): Promise<Done> {
	const { session } = run;
	const earlier = optionalEntry(session, NAMES.refreshToken);
	let replaced: string | null = null;
	if (earlier !== undefined) {
		replaced = (await endGrant(session, standardClient(session), earlier)).refreshAfter;
		deleteEnvLive([NAMES.refreshToken], session.envLive);
	}
	const result = await consent(
		session,
		"standard",
		"Consent, standard client: allow every permission, and copy the page's wording with your name and address replaced by <account>.",
	);
	if (result.tokens === undefined || result.refreshToken === undefined) {
		return endLeftover(
			session,
			result,
			result.tokens === undefined
				? `the consent failed (${result.error?.code ?? "no tokens"}): rerun connect and allow every permission`
				: "Google issued no refresh token: rerun connect",
		);
	}
	const api = await gmailApiCheck(session, result.tokens.accessToken);
	const expected = testAccount(optionalInput(session.dir))?.reveal();
	if (expected !== undefined && api.address !== undefined && !sameMailbox(api.address, expected)) {
		return endLeftover(
			session,
			result,
			"the consent came from another account than input.json's testAccount: rerun connect and choose the test account",
		);
	}
	saveEnvLive(NAMES.refreshToken, result.refreshToken, session.envLive);
	return {
		data: {
			client: "standard",
			consent: consentShape(result, api.result),
			replacedEarlierGrant: replaced,
		},
		lines: [
			`standard client: Gmail API ${api.result}; the refresh token is saved as ${NAMES.refreshToken}`,
			"Record the standard client's wording, screens and checkboxes under observations.consent.standard.",
		],
	};
}

interface Sent {
	readonly rendered: Rendered;
	readonly result: SendResult;
	readonly startedAt: number;
	readonly sentAt: number;
}

async function sendOnce(
	session: Session,
	gmail: Gmail,
	input: MimeInput,
	owner: string,
	threadId?: string,
): Promise<Sent> {
	const sends = readState(session.dir).work.sends ?? 0;
	if (sends >= MAX_SENDS) {
		throw new Error(
			`this session has sent ${sends} messages, its limit: stop and check notes/session.md`,
		);
	}
	updateWork(session.dir, { sends: sends + 1 });
	const rendered = await renderMime(input, newClaimStamp(owner, Date.now() - STAMP_LEAD_MS));
	const startedAt = Date.now();
	const result = await sendMessage(gmail, rendered, threadId === undefined ? {} : { threadId });
	const sentAt = Date.now();
	return {
		rendered,
		result: await readBackAgain(session, gmail, rendered, result),
		startedAt,
		sentAt,
	};
}

const READ_BACK_TRIES = 4;

// send.ts keeps a send whose read-back failed (M5's reconcile fills that gap). The session reads
// it again instead of recording "inconclusive" answers, and stops after READ_BACK_TRIES.
async function readBackAgain(
	session: Session,
	gmail: Gmail,
	rendered: Rendered,
	sent: SendResult,
): Promise<SendResult> {
	let result = sent;
	for (let tries = 1; result.readBack === null; tries++) {
		if (tries >= READ_BACK_TRIES) {
			throw new Error(
				`Gmail accepted the send, but reading it back failed ${tries} times: rerun send (it counts against the limit)`,
			);
		}
		await sleep(session.timing.backoffMs);
		const back = await readBack(gmail, result.id).catch(() => null);
		if (back !== null) {
			result = {
				...result,
				readBack: back,
				messageIdKept: back.messageId === null ? null : back.messageId === rendered.stamp.messageId,
				dateKept: dateKept(back, rendered.stamp.date),
			};
		}
	}
	return result;
}

const parsed = (value: string | null | undefined): number | null => {
	const at = value == null ? Number.NaN : Date.parse(value);
	return Number.isFinite(at) ? at : null;
};

const minus = (a: number | null, b: number | null): number | null =>
	a === null || b === null ? null : a - b;

// Deltas only: never the Date or internalDate values themselves.
function attemptShape(sent: Sent): Readonly<Record<string, unknown>> {
	const stamp = sent.rendered.stamp.date.getTime();
	const back = sent.result.readBack;
	const date = parsed(back?.date);
	const internal = back?.internalDate ?? null;
	return {
		status: sent.result.status,
		labels: systemLabels(sent.result.labelIds),
		readBack: back !== null,
		readBackLabels: systemLabels(back?.labelIds),
		messageIdKept: sent.result.messageIdKept,
		dateKept: sent.result.dateKept,
		threadKept: sent.result.threadKept,
		stampLeadMs: sent.startedAt - stamp,
		readBackDateMinusStampMs: minus(date, stamp),
		readBackDateMinusInternalDateMs: minus(date, internal),
		internalDateMinusStampMs: minus(internal, stamp),
		internalDateMinusSendStartMs: minus(internal, sent.startedAt),
	};
}

export function messageIdAnswer(kept: boolean | null): Answer {
	if (kept === null) return "inconclusive";
	return kept ? "yes" : "no";
}

// send.ts calls a kept Date "inconclusive" when internalDate is within 2 s of it. The stamp is
// back-dated, so an exact match with a send that started later still means Gmail kept our Date
// (and took internalDate from it).
export function dateAnswer(sent: {
	readonly dateKept: SendResult["dateKept"];
	readonly readBackDate: number | null;
	readonly stamp: number;
	readonly startedAt: number;
}): { readonly answer: Answer; readonly internalDateFollowsDate: boolean | null } {
	if (sent.dateKept === true) return { answer: "yes", internalDateFollowsDate: false };
	if (sent.dateKept === false) return { answer: "no", internalDateFollowsDate: null };
	if (
		sent.dateKept === "inconclusive" &&
		sent.readBackDate === sent.stamp &&
		sent.startedAt - sent.stamp > DATE_AMBIGUITY_MS
	) {
		return { answer: "yes", internalDateFollowsDate: true };
	}
	return { answer: "inconclusive", internalDateFollowsDate: null };
}

async function listIds(
	gmail: Gmail,
	query: Parameters<Gmail["listMessages"]>[0],
): Promise<string[]> {
	return ((await gmail.listMessages({ maxResults: 100, ...query })).messages ?? []).map(
		(message) => message.id,
	);
}

const bare = (messageId: string): string => messageId.replace(/^<|>$/g, "");

// How long a just-sent message takes to show in rfc822msgid: and in reconcile's in:sent search.
async function indexDelay(
	gmail: Gmail,
	sent: Sent,
	messageId: string,
	timing: Timing,
): Promise<{
	readonly rfc822msgid: number | null;
	readonly inSent: number | null;
	readonly polls: number;
}> {
	const since = Math.floor((sent.rendered.stamp.date.getTime() - SKEW_MS) / 1000);
	let byId: number | null = null;
	let bySent: number | null = null;
	let polls = 0;
	while ((byId === null || bySent === null) && Date.now() - sent.sentAt < timing.indexTimeoutMs) {
		polls++;
		if (
			byId === null &&
			(await listIds(gmail, { q: `rfc822msgid:${bare(messageId)}` })).includes(sent.result.id)
		) {
			byId = Date.now() - sent.sentAt;
		}
		if (
			bySent === null &&
			(await listIds(gmail, { q: `in:sent after:${since}` })).includes(sent.result.id)
		) {
			bySent = Date.now() - sent.sentAt;
		}
		if (byId === null || bySent === null) await sleep(timing.pollMs);
	}
	return { rfc822msgid: byId, inSent: bySent, polls };
}

function reconcileShape(result: ReconcileResult, sentId: string): ReconcileShape {
	if (result.status === "sent") {
		return { status: "sent", via: result.via, matchesSent: result.id === sentId };
	}
	if (result.status === "ambiguous") {
		return {
			status: "ambiguous",
			matches: result.ids.length,
			includesSent: result.ids.includes(sentId),
		};
	}
	return { status: "not_found", scanned: result.scanned, complete: result.complete };
}

// Procedure step 2 and the M0.28 handoff's extra checks: the probe (To the second address, Bcc the
// test account), its read-back, Bcc, the index delay, then a reply into its thread for threadKept,
// reconcile both ways and threads.get minimal. The probe's Date is already back-dated, so one send
// answers "date preserved" (dateAnswer); a second one couldn't change it.
async function sendStep(run: Run): Promise<Done> {
	const { session } = run;
	const second = secondAddress(readInput(session.dir)).reveal();
	const { gmail, traffic } = mailbox(session);
	const owner = (await gmail.getProfile()).emailAddress;
	registerSecret(owner);
	if (sameMailbox(owner, second)) {
		throw new Error("input.json's secondAddress is the test account itself: use another mailbox");
	}
	const nonce = randomBytes(4).toString("hex");
	const probe: MimeInput = {
		from: { address: owner },
		to: [{ address: second }],
		bcc: [{ address: owner }],
		subject: SEND_SUBJECT,
		text: `DraftYak S8 send probe ${nonce}. Please ignore.\n`,
	};
	const sent = await sendOnce(session, gmail, probe, owner);
	const stamp = sent.rendered.stamp;
	const stored = sent.result.readBack?.messageId ?? stamp.messageId;
	const index = await indexDelay(gmail, sent, stored, session.timing);
	const copy = await gmail.getMessage(sent.result.id, {
		format: "metadata",
		metadataHeaders: ["Bcc"],
	});
	const others = (await listIds(gmail, { q: `rfc822msgid:${bare(stored)}` })).filter(
		(id) => id !== sent.result.id,
	);
	const [other] = others;
	const otherCopy =
		other === undefined
			? undefined
			: await gmail.getMessage(other, { format: "metadata", metadataHeaders: ["Bcc"] });

	const reply = await sendOnce(
		session,
		gmail,
		{
			from: { address: owner },
			to: [{ address: second }],
			subject: `Re: ${SEND_SUBJECT}`,
			text: `DraftYak S8 reply probe ${nonce}. Please ignore.\n`,
			inReplyTo: stored,
			references: [stored],
		},
		owner,
		sent.result.threadId,
	);
	const replyIndex = await indexDelay(
		gmail,
		reply,
		reply.result.readBack?.messageId ?? reply.rendered.stamp.messageId,
		session.timing,
	);
	const attempt: Attempt = {
		messageId: reply.rendered.stamp.messageId,
		threadId: sent.result.threadId,
		to: reply.rendered.to,
		cc: reply.rendered.cc,
		subject: reply.rendered.subject,
		textSha256: reply.rendered.textSha256,
		attemptedAt: reply.rendered.stamp.date.getTime(),
	};
	const byMessageId = reconcileShape(await reconcile(gmail, attempt), reply.result.id);
	const fallback = reconcileShape(
		await reconcile(gmail, attempt, { byMessageId: false }),
		reply.result.id,
	);
	const thread = await gmail.getThread(reply.result.threadId, { format: "minimal" });
	const messages = thread.messages ?? [];
	const threadsGetMinimal = {
		messages: messages.length,
		internalDate:
			messages.length > 0 && messages.every((message) => /^\d+$/.test(message.internalDate ?? "")),
		fields: [...new Set(messages.flatMap((message) => Object.keys(message)))].toSorted(),
	};
	const date = dateAnswer({
		dateKept: sent.result.dateKept,
		readBackDate: parsed(sent.result.readBack?.date),
		stamp: stamp.date.getTime(),
		startedAt: sent.startedAt,
	});
	const messageId = messageIdAnswer(sent.result.messageIdKept);
	const sentCopyHasBcc = header(copy.payload, "Bcc") !== undefined;
	const data: SendSummary = {
		sends: 2,
		probe: {
			...attemptShape(sent),
			messageId,
			date: date.answer,
			internalDateFollowsDate: date.internalDateFollowsDate,
			ids: { message: run.id(sent.result.id), thread: run.id(sent.result.threadId) },
		},
		bcc: {
			sentCopyHasBcc,
			sentLabels: systemLabels(copy.labelIds),
			otherCopies: others.length,
			otherCopyHasBcc:
				otherCopy === undefined ? null : header(otherCopy.payload, "Bcc") !== undefined,
			otherCopyLabels: otherCopy === undefined ? null : systemLabels(otherCopy.labelIds),
		},
		indexDelayMs: {
			rfc822msgid: index.rfc822msgid,
			inSent: index.inSent,
			polls: index.polls,
			messageIdSearched: stored === stamp.messageId ? "ours" : "gmail's",
			pollMs: session.timing.pollMs,
			timeoutMs: session.timing.indexTimeoutMs,
		},
		reply: {
			...attemptShape(reply),
			sameThread: reply.result.threadId === sent.result.threadId,
			indexDelayMs: { rfc822msgid: replyIndex.rfc822msgid, inSent: replyIndex.inSent },
			ids: { message: run.id(reply.result.id), thread: run.id(reply.result.threadId) },
		},
		threadsGetMinimal,
		reconcile: { byMessageId, fallback },
		discovery: discoveryShape(traffic),
	};
	return {
		data,
		lines: [
			`messageId preserved: ${messageId}`,
			`date preserved: ${date.answer}`,
			`bcc: the sent copy keeps it: ${sentCopyHasBcc ? "yes" : "no"}; other copies: ${others.length}`,
			`index delay: rfc822msgid: ${seconds(index.rfc822msgid)}, in:sent: ${seconds(index.inSent)}`,
			`thread kept by the reply: ${reply.result.threadKept === true ? "yes" : "no"}`,
			`threads.get minimal: internalDate ${threadsGetMinimal.internalDate ? "yes" : "no"}`,
			`reconcile: by rfc822msgid ${describeReconcile(byMessageId)}, fallback ${describeReconcile(fallback)}`,
			`discovery document: ${traffic.problems.length} problem(s) in ${traffic.requests} requests`,
			`Owner: open "${SEND_SUBJECT}" in the second mailbox, show the original, and record whether it has a Bcc line (observations.bccInToCopy).`,
		],
	};
}

export interface Limited {
	readonly at: Burst;
	readonly status: number;
	readonly errorStatus: string | null;
	readonly reasons: readonly string[];
	readonly domains: readonly string[];
	readonly message: string;
	readonly classified: {
		readonly kind: string;
		readonly reason?: string;
		readonly retryAt?: boolean;
	};
	readonly headers: RedactedHeaders | null;
}

function describeLimit(error: GmailError, at: Burst, headers: RedactedHeaders | null): Limited {
	const google = parseGoogleError(error.body);
	const body = isRecord(error.body) && isRecord(error.body.error) ? error.body.error : {};
	const items = Array.isArray(body.errors) ? body.errors.filter(isRecord) : [];
	const domains = items.flatMap((item) =>
		typeof item.domain === "string" ? [cleanText(item.domain)] : [],
	);
	const { outcome } = error;
	return {
		at,
		status: error.status,
		errorStatus: google.status === undefined ? null : cleanText(google.status),
		reasons: google.reasons.map(cleanText),
		domains,
		message: cleanText(google.messages[0] ?? ""),
		classified:
			outcome.kind === "retry"
				? { kind: "retry", reason: outcome.reason, retryAt: outcome.retryAt !== undefined }
				: { kind: outcome.kind },
		headers,
	};
}

export function limitedLine(limited: Limited): string {
	const { classified } = limited;
	const outcome =
		classified.reason === undefined ? classified.kind : `${classified.kind}(${classified.reason})`;
	return `${limited.status} ${limited.errorStatus ?? "-"} ${limited.reasons.join("/") || "-"} (${
		limited.domains.join("/") || "-"
	}) "${limited.message}" -> ${outcome} at ${limited.at.parallel} parallel ${limited.at.call}`;
}

// Gmail's answer to too many requests at once: a 429, or a 403 rate limit. A 408 or any other
// failure is not its limit.
const RATE_LIMIT_403 = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const isRateLimit = (error: GmailError): boolean =>
	error.status === 429 ||
	(error.status === 403 &&
		parseGoogleError(error.body).reasons.some((reason) => RATE_LIMIT_403.has(reason)));

// Why a request failed without Gmail's answer: classify.ts's reason for a network failure, the
// code of a token refresh that failed before the request went out, or the error's name.
const whyUnanswered = (error: unknown): string => {
	if (error instanceof GmailError && "reason" in error.outcome) {
		return cleanText(error.outcome.reason);
	}
	if (error instanceof OAuthError) return `token refresh: ${cleanText(error.code)}`;
	return error instanceof Error ? cleanText(error.name) : "error";
};

// Procedure step 4: bursts of parallel reads, within BURSTS' bounds, until Gmail answers with its
// limit. A request that failed without Gmail's answer (status 0: DNS, connection or timeout errors,
// or a failed token refresh) stops the step unrecorded, since its burst can't show the limit.
async function concurrencyStep(run: Run): Promise<Done> {
	const { session } = run;
	const { gmail, traffic } = mailbox(session);
	await gmail.getProfile();
	const bursts = session.bursts ?? BURSTS;
	const rounds: (Burst & { readonly statuses: Readonly<Record<string, number>> })[] = [];
	let limited: Limited | null = null;
	let waitMs = session.timing.backoffMs;
	for (const burst of bursts) {
		const before = traffic.failures.length;
		const results = await Promise.allSettled(
			Array.from({ length: burst.parallel }, () =>
				burst.call === "getProfile" ? gmail.getProfile() : gmail.listMessages({ maxResults: 1 }),
			),
		);
		const statuses: Record<string, number> = {};
		const noAnswer: string[] = [];
		for (const result of results) {
			const status =
				result.status === "fulfilled"
					? 200
					: result.reason instanceof GmailError
						? result.reason.status
						: 0;
			statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
			if (result.status === "rejected" && status === 0) noAnswer.push(whyUnanswered(result.reason));
		}
		if (noAnswer.length > 0) {
			const why = [...new Set(noAnswer)].join(", ");
			throw new Error(
				`${noAnswer.length} of ${burst.parallel} parallel ${burst.call} requests failed without an answer from Gmail (${why}): not Gmail's limit, so nothing was recorded; rerun concurrency`,
			);
		}
		rounds.push({ ...burst, statuses });
		const refused = results.find(
			(result): result is PromiseRejectedResult =>
				result.status === "rejected" &&
				result.reason instanceof GmailError &&
				isRateLimit(result.reason),
		);
		if (refused !== undefined) {
			const error = refused.reason as GmailError;
			const headers = traffic.failures
				.slice(before)
				.find((failure) => failure.status === error.status);
			limited = describeLimit(error, burst, headers?.headers ?? null);
			if (error.outcome.kind === "retry" && error.outcome.retryAt !== undefined) {
				waitMs = Math.max(waitMs, Math.min(MINUTE, error.outcome.retryAt - Date.now()));
			}
			break;
		}
		await sleep(session.timing.roundPauseMs);
	}
	let recovered: boolean | null = null;
	if (limited !== null) {
		await sleep(waitMs);
		recovered = await gmail.getProfile().then(
			() => true,
			() => false,
		);
	}
	const requests = rounds.reduce((sum, round) => sum + round.parallel, 0);
	// The largest burst that ran, and the bound the bursts would have gone up to.
	const maxParallel = Math.max(0, ...rounds.map((round) => round.parallel));
	const boundParallel = Math.max(0, ...bursts.map((burst) => burst.parallel));
	const line =
		limited === null
			? `not provoked (${requests} bounded parallel reads, at most ${maxParallel} at once)`
			: limitedLine(limited);
	const data: ConcurrencySummary = {
		bursts: rounds,
		requests,
		maxParallel,
		boundParallel,
		firstLimit: limited,
		recovered,
		line,
		discovery: discoveryShape(traffic),
	};
	return { data, lines: [`429 concurrent: ${line}`] };
}

interface Listed {
	readonly ok: boolean;
	readonly ids: readonly string[];
	readonly status?: number;
	readonly reason?: string;
}

async function tryList(gmail: Gmail, query: Parameters<Gmail["listMessages"]>[0]): Promise<Listed> {
	try {
		return { ok: true, ids: await listIds(gmail, query) };
	} catch (error) {
		if (!(error instanceof GmailError)) throw error;
		const { outcome } = error;
		const reason = outcome.kind === "ok" ? "ok" : cleanText(outcome.reason);
		return { ok: false, ids: [], status: error.status, reason };
	}
}

const listShape = (listed: Listed) => ({
	ok: listed.ok,
	count: listed.ids.length,
	...(listed.status === undefined ? {} : { status: listed.status }),
	...(listed.reason === undefined ? {} : { reason: listed.reason }),
});

async function labelsOf(gmail: Gmail, id: string): Promise<readonly string[] | null> {
	try {
		return (await gmail.getMessage(id, { format: "minimal" })).labelIds ?? [];
	} catch (error) {
		if (error instanceof GmailError && error.status === 404) return null;
		throw error;
	}
}

// The probe is the owner's scheduled mail, told apart by its subject; other mail never counts.
async function probeOf(
	gmail: Gmail,
	id: string,
): Promise<{
	readonly probe: boolean;
	readonly labels: readonly string[];
	readonly internalDate: number;
} | null> {
	try {
		const message = await gmail.getMessage(id, {
			format: "metadata",
			metadataHeaders: ["Subject"],
		});
		const subject = normalizeSubject(header(message.payload, "Subject"));
		return {
			probe: subject.toLowerCase() === SCHEDULED_SUBJECT.toLowerCase(),
			labels: message.labelIds ?? [],
			internalDate: Number(message.internalDate ?? 0),
		};
	} catch (error) {
		if (error instanceof GmailError && error.status === 404) return null;
		throw error;
	}
}

async function historySince(gmail: Gmail, start: string): Promise<HistoryDelta> {
	const result = await readHistory(gmail, start, { maxPages: 20 });
	if (result.expired) {
		throw new Error("Gmail no longer has the history from the schedule step: rerun schedule");
	}
	return result.delta;
}

const deltaIds = (delta: HistoryDelta): string[] => [
	...new Set([
		...delta.added.map((message) => message.id),
		...delta.labelsAdded.map((change) => change.id),
		...delta.labelsRemoved.map((change) => change.id),
	]),
];

// History events by type, for the probe and for messages gone since (the drafts the web UI saves
// while the owner writes); other mail shows only as a count.
function probeHistory(delta: HistoryDelta, probes: ReadonlySet<string>, gone: ReadonlySet<string>) {
	const changes = (list: HistoryDelta["labelsAdded"], ids: ReadonlySet<string>) =>
		list
			.filter((change) => ids.has(change.id))
			.map((change) => ({
				changed: systemLabels(change.changed),
				labels: systemLabels(change.labelIds),
			}));
	const ours = (id: string): boolean => probes.has(id) || gone.has(id);
	return {
		probe: {
			added: delta.added
				.filter((message) => probes.has(message.id))
				.map((m) => systemLabels(m.labelIds)),
			deleted: delta.deleted.filter((id) => probes.has(id)).length,
			labelsAdded: changes(delta.labelsAdded, probes),
			labelsRemoved: changes(delta.labelsRemoved, probes),
		},
		gone: {
			added: delta.added
				.filter((message) => gone.has(message.id))
				.map((m) => systemLabels(m.labelIds)),
			deleted: delta.deleted.filter((id) => gone.has(id)).length,
			labelsAdded: changes(delta.labelsAdded, gone),
			labelsRemoved: changes(delta.labelsRemoved, gone),
		},
		otherEvents:
			delta.added.filter((m) => !ours(m.id)).length +
			delta.deleted.filter((id) => !ours(id)).length +
			delta.labelsAdded.filter((c) => !ours(c.id)).length +
			delta.labelsRemoved.filter((c) => !ours(c.id)).length,
	};
}

const sentQuery = (startedAt: number): string =>
	`in:sent after:${Math.floor((startedAt - SKEW_MS) / 1000)}`;

const AGAIN = "rerun schedule, and schedule a new mail for the time it prints";

// Procedure step 3, before the owner schedules the mail: the history start point, what the two
// scheduled-mail queries list already (those don't count later), and the send time to pick: at
// least scheduleLeadMs ahead, so that the scheduled step reads the mail well before it goes out
// and the homepage check fills the wait.
async function scheduleStep(run: Run): Promise<Done> {
	const { session } = run;
	const { gmail, traffic } = mailbox(session);
	const profile = await gmail.getProfile();
	const startedAt = Date.now();
	const sendAt = Math.ceil((startedAt + session.timing.scheduleLeadMs) / MINUTE) * MINUTE;
	const inScheduled = await tryList(gmail, { q: "in:scheduled" });
	const labelFilter = await tryList(gmail, { labelIds: ["SCHEDULED"] });
	updateWork(session.dir, {
		historyStart: profile.historyId,
		startedAt,
		sendAt,
		baseline: [...new Set([...inScheduled.ids, ...labelFilter.ids])],
		scheduledIds: [],
		scheduledHistory: undefined,
		scheduledHistoryAt: undefined,
	});
	const minutes = Math.round((sendAt - startedAt) / MINUTE);
	return {
		data: {
			baseline: { inScheduled: listShape(inScheduled), labelFilter: listShape(labelFilter) },
			leadMs: sendAt - startedAt,
			discovery: discoveryShape(traffic),
		},
		lines: [
			`Owner: in the Gmail web UI of the test account, write a new mail to your second address with the subject "${SCHEDULED_SUBJECT}" and one line of text.`,
			`Then open the arrow beside Send, choose Schedule send, Pick date & time, pick ${clock(sendAt)} (in about ${minutes} minutes), and Schedule send.`,
			"If you picked another time, record it first: node spikes/s08-gmail/test/live-cli.ts send-at <HH:MM>.",
			`Once it shows under Scheduled, run the scheduled step; it must start before ${clock(sendAt - session.timing.sendMarginMs)}.`,
		],
	};
}

type LabelList = readonly string[] | null;

// A probe that gained SENT or lost SCHEDULED (or vanished) between two looks: it went out.
function movedOn(before: LabelList, after: LabelList): boolean {
	if (before === null) return false;
	if (after === null) return before.includes("SCHEDULED");
	return (
		countsAsSent(after) ||
		(before.includes("SCHEDULED") && !after.includes("SCHEDULED")) ||
		(!before.includes("SENT") && after.includes("SENT"))
	);
}

// Procedure step 3, after the owner scheduled it: how Gmail shows the scheduled mail (labels,
// in:scheduled, a SCHEDULED label filter, in:sent, in:drafts, history) before it goes out. Every
// read ends sendMarginMs before the send time, and a mail that went out before or during the step
// stops it: nothing it records may describe the mail after the send.
async function scheduledStep(run: Run): Promise<Done> {
	const { session } = run;
	const { work } = readState(session.dir);
	const { historyStart, startedAt, sendAt } = work;
	if (historyStart === undefined || startedAt === undefined || sendAt === undefined) {
		throw new Error("run the schedule step first");
	}
	const deadline = sendAt - session.timing.sendMarginMs;
	if (Date.now() >= deadline) {
		throw new Error(
			`it is too close to the send time (${clock(sendAt)}) to read the mail before it goes out: once it went out, ${AGAIN}`,
		);
	}
	const { gmail, traffic } = mailbox(session);
	const baseline = new Set(work.baseline ?? []);
	const probes = new Set<string>();
	const gone = new Set<string>();
	const checked = new Set<string>();
	const check = async (id: string): Promise<void> => {
		if (checked.has(id) || baseline.has(id)) return;
		checked.add(id);
		const found = await probeOf(gmail, id);
		if (found === null) gone.add(id);
		// A probe that went out before the schedule step is an earlier attempt's.
		else if (found.probe && !(countsAsSent(found.labels) && found.internalDate < startedAt)) {
			probes.add(id);
		}
	};
	let looks = 0;
	let scheduledAnswersOk = true;
	const look = async () => {
		const delta = await historySince(gmail, historyStart);
		for (const id of deltaIds(delta)) await check(id);
		const inScheduled = await tryList(gmail, { q: "in:scheduled" });
		scheduledAnswersOk &&= inScheduled.ok;
		const labelFilter = await tryList(gmail, { labelIds: ["SCHEDULED"] });
		for (const id of [...inScheduled.ids, ...labelFilter.ids]) await check(id);
		const labels = new Map<string, LabelList>();
		for (const id of probes) labels.set(id, await labelsOf(gmail, id));
		if ([...labels.values()].some((list) => list !== null && countsAsSent(list))) {
			const when = looks === 0 ? "already went out" : "went out while the step read it";
			throw new Error(`the scheduled mail ${when}: ${AGAIN}`);
		}
		looks++;
		return { delta, inScheduled, labelFilter, labels, at: Date.now() };
	};
	// The web UI saves drafts while the owner writes: wait for a match that is more than a draft,
	// and at the timeout record whatever Gmail shows.
	const beyondDraft = (labels: LabelList): boolean =>
		labels?.some((label) => label !== "DRAFT") ?? false;
	const started = Date.now();
	const findEnd = Math.min(started + session.timing.findTimeoutMs, deadline);
	let view = await look();
	while (![...view.labels.values()].some(beyondDraft)) {
		if (Date.now() >= findEnd) {
			if (probes.size > 0) break;
			throw new Error(
				Date.now() >= deadline
					? `no mail with the subject "${SCHEDULED_SUBJECT}" before the send time: ${AGAIN}`
					: `no mail with the subject "${SCHEDULED_SUBJECT}" yet: check it, then rerun scheduled`,
			);
		}
		await sleep(session.timing.pollMs);
		view = await look();
	}
	// The look that first showed the mail scheduled: its before-state, and the sent step's history
	// start, so that no later event can fall before it.
	const first = view;
	// Gmail's search index trails its labels, so give both queries the index delay to list it.
	const listedAfterMs: { inScheduled: number | null; labelFilter: number | null } = {
		inScheduled: null,
		labelFilter: null,
	};
	const settling = Date.now();
	const settleEnd = Math.min(settling + session.timing.indexTimeoutMs, deadline);
	const lists = (listed: Listed): boolean => listed.ids.some((id) => probes.has(id));
	let waiting = false;
	for (;;) {
		const elapsed = view.at - settling;
		if (listedAfterMs.inScheduled === null && lists(view.inScheduled)) {
			listedAfterMs.inScheduled = Math.max(0, elapsed);
		}
		if (listedAfterMs.labelFilter === null && lists(view.labelFilter)) {
			listedAfterMs.labelFilter = Math.max(0, elapsed);
		}
		waiting =
			(listedAfterMs.inScheduled === null && view.inScheduled.ok) ||
			(listedAfterMs.labelFilter === null && view.labelFilter.ok);
		if (!waiting || Date.now() >= settleEnd) break;
		await sleep(session.timing.pollMs);
		view = await look();
	}
	const waitedMs = Math.max(0, view.at - settling);
	// Stopped by the send time, before the index delay was up.
	const cutShort =
		listedAfterMs.inScheduled === null && settleEnd < settling + session.timing.indexTimeoutMs;
	const inSent = await tryList(gmail, { q: sentQuery(startedAt) });
	const inDrafts = await tryList(gmail, { q: "in:drafts" });
	const ids = [...probes];
	for (const id of ids) {
		const before = first.labels.get(id) ?? view.labels.get(id) ?? null;
		if (movedOn(before, await labelsOf(gmail, id))) {
			throw new Error(`the scheduled mail went out while the step read it: ${AGAIN}`);
		}
	}
	const messages: {
		readonly exists: boolean;
		readonly labels: readonly string[];
		readonly inScheduled: boolean;
		readonly labelFilter: boolean;
		readonly inSent: boolean;
		readonly inDrafts: boolean;
		readonly countsAsSent: boolean;
	}[] = [];
	for (const id of ids) {
		const labels = view.labels.get(id) ?? null;
		messages.push({
			exists: labels !== null,
			labels: systemLabels(labels ?? []),
			inScheduled: view.inScheduled.ids.includes(id),
			labelFilter: view.labelFilter.ids.includes(id),
			inSent: inSent.ids.includes(id),
			inDrafts: inDrafts.ids.includes(id),
			countsAsSent: labels !== null && countsAsSent(labels),
		});
	}
	const firstSeen = {
		afterMs: first.at - started,
		messages: ids.map((id) => ({
			labels: systemLabels(first.labels.get(id) ?? []),
			inScheduled: first.inScheduled.ids.includes(id),
			labelFilter: first.labelFilter.ids.includes(id),
		})),
	};
	const historyIds = new Set(deltaIds(view.delta));
	const works = listedAfterMs.inScheduled !== null;
	if (
		!works &&
		(cutShort || !scheduledAnswersOk || Date.now() < settling + session.timing.indexTimeoutMs)
	) {
		throw new Error(
			"in:scheduled was not established: rerun schedule, schedule a fresh probe, then rerun scheduled with the full index window before its send time",
		);
	}
	updateWork(session.dir, {
		scheduledIds: ids,
		scheduledHistory: first.delta.historyId,
		scheduledHistoryAt: first.at,
	});
	const data: ScheduledSummary = {
		inScheduled: works ? "works" : "fails",
		found: {
			viaHistory: ids.some((id) => historyIds.has(id)),
			viaInScheduled: works,
			viaLabelFilter: listedAfterMs.labelFilter !== null,
		},
		firstSeen,
		listedAfterMs: {
			...listedAfterMs,
			timeoutMs: session.timing.indexTimeoutMs,
			waitedMs,
			cutShort,
			successfulAnswersThroughout: scheduledAnswersOk,
		},
		probes: ids.length,
		messages,
		history: probeHistory(view.delta, probes, gone),
		countedAsSent: sentIn(view.delta).some((id) => probes.has(id)),
		finishedBeforeSendMs: sendAt - Date.now(),
		queries: {
			inScheduled: listShape(view.inScheduled),
			labelFilter: listShape(view.labelFilter),
			inSent: listShape(inSent),
			inDrafts: listShape(inDrafts),
		},
		discovery: discoveryShape(traffic),
	};
	const shown = messages.map((message) => message.labels.join("+") || "no labels").join("; ");
	const short = cutShort
		? ` (not listed in ${seconds(waitedMs)}: stopped before the send time)`
		: "";
	return {
		data,
		lines: [
			`in:scheduled: ${works ? "works" : "fails"}${short}`,
			`scheduled mail before it goes out: labels ${shown}; in:sent lists it: ${
				messages.some((message) => message.inSent) ? "yes" : "no"
			}; counted as sent: ${data.countedAsSent ? "yes" : "no"}`,
			`After its send time (${clock(sendAt)}), run the sent step.`,
		],
	};
}

// Procedure step 3, after the scheduled time: the sent mail's labels and history, whether it kept
// its id, and whether sentIn() counts it now.
async function sentStep(run: Run): Promise<Done> {
	const { session } = run;
	const { work } = readState(session.dir);
	const { scheduledHistory, scheduledHistoryAt, startedAt, sendAt } = work;
	const scheduled = new Set(work.scheduledIds ?? []);
	if (
		scheduledHistory === undefined ||
		scheduledHistoryAt === undefined ||
		startedAt === undefined ||
		sendAt === undefined ||
		scheduled.size === 0
	) {
		throw new Error("run the scheduled step first");
	}
	if (scheduledHistoryAt >= sendAt) {
		throw new Error(
			`the scheduled step took its history start after the send time, so the send may fall before it: ${AGAIN}`,
		);
	}
	if (Date.now() < sendAt - session.timing.sendMarginMs) {
		throw new Error(`the scheduled mail goes out ${clock(sendAt)}: run the sent step after that`);
	}
	const { gmail, traffic } = mailbox(session);
	const gone = new Set<string>();
	const others = new Set<string>();
	const look = async (): Promise<{
		readonly delta: HistoryDelta;
		readonly id?: string;
		readonly labels?: readonly string[];
	}> => {
		const delta = await historySince(gmail, scheduledHistory);
		for (const id of scheduled) {
			const labels = await labelsOf(gmail, id);
			if (labels === null) gone.add(id);
			else if (countsAsSent(labels)) return { delta, id, labels };
		}
		for (const message of delta.added) {
			if (scheduled.has(message.id) || others.has(message.id) || gone.has(message.id)) continue;
			const found = await probeOf(gmail, message.id);
			if (found === null) gone.add(message.id);
			else if (!found.probe) others.add(message.id);
			else {
				const labels = (await labelsOf(gmail, message.id)) ?? [];
				if (countsAsSent(labels)) return { delta, id: message.id, labels };
			}
		}
		return { delta };
	};
	const started = Date.now();
	const budget = Math.max(0, sendAt - started) + session.timing.sentTimeoutMs;
	let view = await look();
	while (view.id === undefined) {
		const waited = Date.now() - started;
		if (waited > budget) {
			throw new Error("the scheduled mail hasn't gone out yet: rerun sent after its send time");
		}
		session.log(`waiting for the scheduled mail to go out (${Math.round(waited / 1000)} s so far)`);
		await sleep(session.timing.sentPollMs);
		view = await look();
	}
	const sentId = view.id;
	const waitedMs = Date.now() - started;
	// in:sent lists it once Gmail's search index catches up; in:scheduled is read after that.
	const settling = Date.now();
	let inSent = await tryList(gmail, { q: sentQuery(startedAt) });
	while (
		inSent.ok &&
		!inSent.ids.includes(sentId) &&
		Date.now() - settling < session.timing.indexTimeoutMs
	) {
		await sleep(session.timing.pollMs);
		inSent = await tryList(gmail, { q: sentQuery(startedAt) });
	}
	const inSentAfterMs = inSent.ids.includes(sentId) ? Date.now() - settling : null;
	const inScheduled = await tryList(gmail, { q: "in:scheduled" });
	const sameId = scheduled.has(sentId);
	const counted = sentIn(view.delta).includes(sentId);
	return {
		data: {
			waitedMs,
			sameId,
			labels: systemLabels(view.labels),
			countsAsSent: true,
			inScheduled: inScheduled.ids.includes(sentId),
			inSent: inSent.ids.includes(sentId),
			inSentAfterMs,
			history: probeHistory(view.delta, new Set([...scheduled, sentId]), gone),
			sentIn: counted,
			queries: { inScheduled: listShape(inScheduled), inSent: listShape(inSent) },
			discovery: discoveryShape(traffic),
		},
		lines: [
			`scheduled mail after it went out: labels ${systemLabels(view.labels).join("+")}; same id: ${
				sameId ? "yes" : "no"
			}; in:sent lists it: ${inSent.ids.includes(sentId) ? "yes" : "no"}; history counts it as sent: ${
				counted ? "yes" : "no"
			}`,
		],
	};
}

const isSet = (session: Session, name: string): boolean =>
	optionalEntry(session, name) !== undefined;

// Procedure step 6: revoke the standard grant at Google, confirm it with invalid_grant, and delete
// every DY_LIVE_GMAIL_* entry. The agent step and the drop step ended their grants themselves.
async function revokeStep(run: Run): Promise<Done> {
	const { session } = run;
	const { client, refreshToken } = mailbox(session);
	const revocation = await endGrant(session, client, refreshToken);
	const { accepted, refreshAfter } = revocation;
	let cleanupBasis: "owner-confirmed-client-deletion" | undefined;
	if (clientDeletedCode(refreshAfter)) {
		const state = readState(session.dir);
		const input = readInput(session.dir);
		const observations = parseObservations(input.observations, [accountName(input).reveal()]);
		const candidate: State = {
			...state,
			steps: {
				...state.steps,
				revoke: {
					at: new Date().toISOString(),
					commit: null,
					dirty: null,
					data: { refreshAfter, entriesLeft: [], cleanupBasis: "owner-confirmed-client-deletion" },
				},
			},
		};
		if (buildReport(candidate, observations).acceptance.revoked === "yes") {
			cleanupBasis = "owner-confirmed-client-deletion";
		}
	}
	if (refreshAfter !== "invalid_grant" && cleanupBasis === undefined) {
		throw new Error(
			`the standard grant still refreshes (${refreshAfter}) after ${revocation.revokes} revocations, so no entry was deleted: rerun revoke. If it keeps refreshing, ${MANUAL_REVOKE}, then rerun revoke`,
		);
	}
	const deleted = deleteEnvLive(ALL_NAMES, session.envLive);
	const entriesLeft = ALL_NAMES.filter((name) => isSet(session, name));
	const data: RevokeSummary = {
		client: "standard",
		revokeAccepted: accepted,
		revocation,
		refreshAfter,
		entriesDeleted: deleted,
		entriesLeft,
		...(cleanupBasis === undefined ? {} : { cleanupBasis }),
	};
	return {
		data,
		lines: [
			`standard grant: revoke ${accepted ? "accepted" : "refused"}; refresh afterwards: ${refreshAfter}`,
			`.env.live: deleted ${deleted.join(", ") || "nothing"}; left: ${entriesLeft.join(", ") || "none"}`,
			cleanupBasis === undefined
				? "Owner: delete both spike clients in the Cloud project, then record clientsDeleted: true."
				: "Cleanup basis: the owner confirmed both spike clients deleted; token refusal was not proved.",
		],
	};
}

// Deletes every DY_LIVE_GMAIL_* entry without the revoke step: for a session that stopped before
// connect saved a grant, or after the owner removed the app's access.
export function deleteEntries(envLive: EnvLiveOptions): string[] {
	const deleted = deleteEnvLive(ALL_NAMES, envLive);
	return [`deleted ${deleted.join(", ") || "nothing"} from .env.live`];
}

// Recording needs a clean checkout at the commit every step ran on, and a finished revocation.
export function recordProblems(
	print: Pick<Fingerprint, "commit" | "dirty">,
	state: State,
	requireClean: boolean,
	acceptance: Acceptance,
): string[] {
	const problems: string[] = [];
	if (acceptance.revoked !== "yes")
		problems.push("revoked isn't yes: finish the revocation and cleanup");
	if (!requireClean) return problems;
	if (print.commit === null || print.dirty !== false) {
		problems.push("the checkout has tracked changes or no commit");
	}
	const elsewhere = STEPS.filter((step) => {
		const record = state.steps[step];
		return record !== undefined && (record.commit !== print.commit || record.dirty !== false);
	});
	if (elsewhere.length > 0) problems.push(`these steps ran on other code: ${elsewhere.join(", ")}`);
	return problems;
}

async function reportStep(session: Session): Promise<readonly string[]> {
	const state = readState(session.dir);
	const missing = missingSteps(state);
	if (missing.length > 0) throw new Error(`run these steps first: ${missing.join(", ")}`);
	const input = readInput(session.dir);
	const name = accountName(input).reveal();
	const report = buildReport(state, parseObservations(input.observations, [name]));
	const print = await fingerprint({
		cwd: session.repoDir,
		...(session.sampleMs === undefined ? {} : { sampleMs: session.sampleMs }),
	});
	const code = codeState(session.repoDir);
	const shown: Fingerprint = { ...print, dirty: code.dirty ?? print.dirty };
	const problems = recordProblems(shown, state, session.requireClean, report.acceptance);
	const recorded = session.record && problems.length === 0;
	const dir = recorded ? session.evidenceDir : path.join(session.dir, "evidence");
	const file = await writeEvidence(path.join(dir, "live.json"), report.data, {
		fingerprint: shown,
	});
	const why = problems.length > 0 ? problems.join("; ") : "DRAFTYAK_RECORD_EVIDENCE isn't 1";
	return [
		...report.lines,
		recorded ? `evidence: ${file}` : `evidence not recorded (${why}); preview: ${file}`,
	];
}

const RUNNERS: Readonly<Record<Exclude<Step, "report">, (run: Run) => Promise<Done>>> = {
	agent: agentStep,
	drop: dropStep,
	connect: connectStep,
	send: sendStep,
	concurrency: concurrencyStep,
	schedule: scheduleStep,
	scheduled: scheduledStep,
	sent: sentStep,
	revoke: revokeStep,
};

export async function runStep(step: Step, session: Session): Promise<readonly string[]> {
	if (session.declared !== undefined && DECLARED[session.declared] !== step) {
		throw new Error(
			`DRAFTYAK_S8_OUTCOME=${session.declared} is for the ${DECLARED[session.declared]} step only`,
		);
	}
	if (step === "report") return reportStep(session);
	// Ids in evidence are HMACs under a key that lives for this step only (Conventions: Evidence).
	const key = newSessionKey();
	const done = await RUNNERS[step]({ session, id: (value) => hashId(key, value) });
	saveStep(session, step, done.data);
	return done.lines;
}

// Why a step can't run: the .env.live entries it needs.
export function credentialsProblem(step: Step | undefined, session: Session): string | undefined {
	const names = REQUIRED[step ?? "preflight"];
	if (names.length === 0) return undefined;
	try {
		loadEnvLive(names, session.envLive);
		return undefined;
	} catch (error) {
		return `${messageOf(error)} (the S8b session's entries; see spikes/s08-gmail/notes/session.md)`;
	}
}

export function statusLines(session: Session): string[] {
	let file: string;
	try {
		file = envLivePath(session.envLive);
	} catch (error) {
		file = messageOf(error);
	}
	const state = readState(session.dir);
	const done = STEPS.filter((step) => state.steps[step] !== undefined);
	const next = STEPS.find((step) => state.steps[step] === undefined);
	let input: string;
	try {
		const read = readInput(session.dir);
		const fields = (["secondAddress", "testAccount", "accountName"] as const).map(
			(field) => `${field} ${typeof read[field] === "string" ? "set" : "missing"}`,
		);
		const address = fields.join(", ");
		let observations = "no observations yet";
		if (read.observations !== undefined) {
			try {
				parseObservations(read.observations);
				observations = "observations complete";
			} catch (error) {
				observations = `observations incomplete: ${messageOf(error)}`;
			}
		}
		input = `${address}; ${observations}`;
	} catch (error) {
		input = messageOf(error);
	}
	return [
		`.env.live: ${file}`,
		...ALL_NAMES.map((name) => `  ${name}: ${isSet(session, name) ? "set" : "missing"}`),
		`session folder: ${session.dir}`,
		`  input.json: ${input}`,
		`  steps done: ${done.join(", ") || "none"}`,
		`  next step: ${next ?? "none: commit evidence/live.json, then run forget"}`,
		`  sends so far: ${state.work.sends ?? 0} of at most ${MAX_SENDS}`,
		`  grants: ${Object.entries(grantStatus(state))
			.map(([step, status]) => `${step} ${status}`)
			.join("; ")}`,
	];
}

// A Desktop client's JSON from the Cloud console's Download JSON; errors never quote its values.
export function readClientFile(file: string): Credentials {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		throw new Error(`${path.basename(file)} isn't a client JSON file`);
	}
	if (isRecord(json) && "web" in json) {
		throw new Error("that is a Web application client: create a Desktop app client");
	}
	const installed = isRecord(json) && isRecord(json.installed) ? json.installed : undefined;
	const clientId = installed?.client_id;
	const clientSecret = installed?.client_secret;
	if (typeof clientId !== "string" || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
		throw new Error("no Desktop client_id in the file (installed.client_id)");
	}
	if (typeof clientSecret !== "string" || !/^[\w-]{10,200}$/.test(clientSecret)) {
		throw new Error("no client_secret in the file (installed.client_secret)");
	}
	return { clientId, clientSecret };
}

// Saves the client's ID and secret through saveEnvLive, then deletes the download, which holds
// the secret. The same client under both names would record one client's consent as the other's.
export function saveClient(kind: ClientKind, file: string, envLive: EnvLiveOptions): string[] {
	const credentials = readClientFile(file);
	const [id, secret] =
		kind === "agent"
			? ([NAMES.agentClientId, NAMES.agentClientSecret] as const)
			: ([NAMES.clientId, NAMES.clientSecret] as const);
	const other = kind === "agent" ? NAMES.clientId : NAMES.agentClientId;
	let saved: string | undefined;
	try {
		saved = loadEnvLive([other], envLive)[other]?.reveal();
	} catch {}
	if (saved === credentials.clientId) {
		throw new Error(
			`that file is the client already saved as ${other}: download the ${kind} client's JSON`,
		);
	}
	saveEnvLive(id, credentials.clientId, envLive);
	saveEnvLive(secret, credentials.clientSecret, envLive);
	rmSync(file);
	return [id, secret];
}
