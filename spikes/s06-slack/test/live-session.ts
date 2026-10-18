import diagnostics from "node:diagnostics_channel";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type EnvLiveOptions,
	hashId,
	loadEnvLive,
	newSessionKey,
	redact,
	redactHeaders,
} from "@draftyak/spike-kit";
import { refusal, TOKEN_NAMES, tokenState } from "../scripts/tokens.ts";
import { callSlack, type Method, type Params, SlackError } from "../src/api.ts";
import { Poller } from "../src/poller.ts";
import { type ChannelType, id, type Json, obj, type SlackEvent, tsKey } from "../src/reduce.ts";
import { runSocketMode, type SocketState, type StopReason } from "../src/socket-mode.ts";

// M0.25's live procedure (notes/session.md). test/events.live.test.ts runs it against Slack with
// the owner's tokens, and test/rehearsal.test.ts against FakeSlack. It connects over Socket Mode,
// waits for the second user's messages (checking history for any type that sends no event), reads
// the rate-limit headers of conversations.info, .history and .replies, checks the internal-app
// exemption, runs one poller cycle, then watches the owner uninstall and delete the app. Its
// evidence holds counts, timings, Slack's codes and enum values, header names (values only for
// *ratelimit*, retry-after and content-type), and Slack ids and ts only as per-session HMACs.

export type EventType = "message.im" | "message.mpim" | "message.channels" | "message.groups";

export const EVENT_TYPES: Readonly<Record<ChannelType, EventType>> = {
	im: "message.im",
	mpim: "message.mpim",
	channel: "message.channels",
	group: "message.groups",
};

const TYPES: readonly ChannelType[] = ["im", "mpim", "channel", "group"];

// What the second user sends for each type (notes/session.md, owner step 6).
const ASKS: Readonly<Record<ChannelType, string>> = {
	im: "a DM to the owner",
	mpim: "a message in the group DM with the owner and the third member",
	channel: "one in the public test channel",
	group: "one in the private test channel",
};

export const RECEIVED = "received over Socket Mode";
export const NOT_DELIVERED = "not delivered";
export const NOT_SENT = "not sent (no message from others since connect)";
const KEPT = "not done (app kept for M6)";
const REVOCATIONS = ["app_uninstalled", "tokens_revoked"] as const;
// Slackbot's messages aren't the second user's.
const SLACKBOT = "USLACKBOT";
// Conversations of one type whose history a check reads.
const CHECKED = 20;
// Public channels the exemption check tries.
const PROBED = 10;

export interface Tokens {
	readonly appToken: string;
	readonly userToken: string;
}

// Both tokens from the main checkout's .env.live, or the kit's message naming the missing entries.
// Any other problem, such as a .env.live inside a worktree, throws.
export function liveTokens(options: EnvLiveOptions = {}): Tokens | { readonly missing: string } {
	try {
		const tokens = loadEnvLive([TOKEN_NAMES.app, TOKEN_NAMES.user], options);
		return {
			appToken: tokens[TOKEN_NAMES.app]?.reveal() ?? "",
			userToken: tokens[TOKEN_NAMES.user]?.reveal() ?? "",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("not set in ")) return { missing: message };
		throw error;
	}
}

export interface Settings {
	readonly expect: readonly ChannelType[];
	readonly keepApp: boolean;
	readonly debugReconnects: boolean;
	readonly dropAck: boolean;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const value = env[name] ?? "";
	if (value === "") return fallback;
	if (value === "0" || value === "1") return value === "1";
	throw new Error(`${name} is 1 or 0, not "${value}"`);
}

// DRAFTYAK_S6_EXPECT: the message types to wait for (im, mpim, channel, group; unset means all
// four). DRAFTYAK_S6_KEEP_APP=1: no uninstall, the app stays for M6. DRAFTYAK_S6_DEBUG_RECONNECTS=0:
// Slack's hours-long connections instead of a refresh every 360 s. DRAFTYAK_S6_DROP_ACK=0: no
// dropped ack, so Slack retries only by chance (notes open point 7).
export function liveSettings(env: NodeJS.ProcessEnv = process.env): Settings {
	const listed = (env.DRAFTYAK_S6_EXPECT ?? "").split(/[\s,]+/).filter((item) => item !== "");
	const unknown = listed.filter((item) => !(TYPES as readonly string[]).includes(item));
	if (unknown.length > 0) {
		throw new Error(
			`DRAFTYAK_S6_EXPECT lists im, mpim, channel or group, not ${unknown.join(", ")}`,
		);
	}
	return {
		expect: listed.length === 0 ? TYPES : TYPES.filter((type) => listed.includes(type)),
		keepApp: flag(env, "DRAFTYAK_S6_KEEP_APP", false),
		debugReconnects: flag(env, "DRAFTYAK_S6_DEBUG_RECONNECTS", true),
		dropAck: flag(env, "DRAFTYAK_S6_DROP_ACK", true),
	};
}

export interface Waits {
	readonly connectMs: number;
	readonly eventsMs: number;
	readonly remindMs: number;
	// How often the events phase reads history for the types still without an event.
	readonly checkMs: number;
	readonly uninstallMs: number;
	readonly deleteMs: number;
	readonly pollMs: number;
	readonly pollerMs: number;
}

// Session 2's limits: about 38 minutes at most, inside the live test's 45-minute timeout.
export const LIVE_WAITS: Waits = {
	connectMs: 60_000,
	eventsMs: 15 * 60_000,
	remindMs: 60_000,
	checkMs: 3 * 60_000,
	uninstallMs: 10 * 60_000,
	deleteMs: 10 * 60_000,
	pollMs: 10_000,
	pollerMs: 60_000,
};

export type Cue = "send" | "uninstall" | "delete";

export interface LiveOptions extends Settings {
	readonly appToken: string;
	readonly userToken: string;
	readonly waits: Waits;
	// Progress and the owner's prompts, one line each, never holding ids, ts or text.
	readonly say: (line: string) => void;
	// When the second user should send, and the owner uninstall and then delete the app.
	readonly cue?: (step: Cue) => void;
	readonly apiBase?: string;
	readonly fetch?: typeof fetch;
	readonly WebSocket?: typeof WebSocket;
	readonly allowSocketUrl?: (url: URL) => boolean;
	readonly signal?: AbortSignal;
}

export interface LiveResult {
	readonly data: Readonly<Record<string, unknown>>;
	// The acceptance lines: per event type, `received over Socket Mode`, `not delivered` or why
	// neither can be said.
	readonly verdicts: readonly string[];
	// Strings the final pass had to cut or redact: 0 unless Slack sent something unexpected.
	readonly redacted: number;
	// Kept header values replaced because they didn't have their expected shape.
	readonly replaced: number;
}

export interface HeaderNote {
	readonly names: readonly string[];
	readonly values: Readonly<Record<string, string | number>>;
}

// Slack's Date header against this machine's clock (plan §3 Clock rule; ADR 0015's secondNow):
// whether it is an IMF-fixdate that round-trips, and the header minus the request's midpoint. The
// header counts whole seconds, so the skew reads up to a second low.
interface DateNote {
	readonly present: boolean;
	readonly roundTrips: boolean;
	readonly skewMs: number | null;
}

const MAX_TEXT = 200;
const short = (text: string): string => (text.length > MAX_TEXT ? "[redacted:long]" : text);
const HEADER = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORD = /^[a-z][a-z0-9_]{0,39}$/;
const EVENT_ID = /^Ev[A-Z0-9]{2,30}$/;
const ENVELOPE_ID = /^[\w-]{1,128}$/;
const TS = /^\d{1,12}\.\d{1,9}$/;
const INTEGER = /^\d{1,15}$/;

// The kept values' expected shapes. Anything else, such as a Slack id (upper case) in a *ratelimit*
// value, which the kit's patterns don't know, is replaced. Whole numbers are kept as numbers.
const VALUE_SHAPES: readonly (readonly [RegExp, RegExp])[] = [
	[/^content-type$/, /^[\w.+-]+\/[\w.+-]+(?:\s*;\s*[\w-]+=[\w.-]+)*$/],
	[/^retry-after$/, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/],
	[/ratelimit/, /^[a-z0-9 .,;:=/_-]{0,120}$/],
];

const shaped = (name: string, value: string): string =>
	VALUE_SHAPES.some(([names, shape]) => names.test(name) && shape.test(value))
		? value
		: "[redacted:shape]";

// Header names, with values only for *ratelimit*, retry-after and content-type (the kit's rule).
function headerNote(headers: Headers): { readonly note: HeaderNote; readonly replaced: number } {
	const { names, values } = redactHeaders(headers);
	const kept: Record<string, string | number> = {};
	let replaced = 0;
	for (const [name, value] of Object.entries(values)) {
		if (!HEADER.test(name)) continue;
		const raw = headers.get(name) ?? "";
		if (INTEGER.test(raw)) {
			kept[name] = Number(raw);
			continue;
		}
		kept[name] = shaped(name, value);
		if (kept[name] !== value) replaced++;
	}
	return {
		note: { names: names.filter((name) => HEADER.test(name)).slice(0, 80), values: kept },
		replaced,
	};
}

function dateNote(value: string | null, sentAt: number, receivedAt: number): DateNote {
	if (value === null) return { present: false, roundTrips: false, skewMs: null };
	const at = Date.parse(value);
	if (Number.isNaN(at)) return { present: true, roundTrips: false, skewMs: null };
	return {
		present: true,
		roundTrips: new Date(at).toUTCString() === value,
		skewMs: Math.round(at - (sentAt + receivedAt) / 2),
	};
}

interface Seen {
	readonly method: string;
	readonly status: number;
	readonly ms: number;
	readonly headers: HeaderNote;
	readonly replaced: number;
	readonly date: DateNote;
}

// A fetch that notes each response's status, time, headers and Date before its caller reads the
// body.
function watched(base: typeof fetch, note: (seen: Seen) => void): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const started = performance.now();
		const sentAt = Date.now();
		const response = await base(input, init);
		const receivedAt = Date.now();
		const method = url.pathname.split("/").at(-1) ?? "";
		const { note: headers, replaced } = headerNote(response.headers);
		note({
			method: /^[a-z]+(?:\.[a-z]+)+$/i.test(method) ? method : "other",
			status: response.status,
			ms: Math.round(performance.now() - started),
			headers,
			replaced,
			date: dateNote(response.headers.get("date"), sentAt, receivedAt),
		});
		return response;
	}) as typeof fetch;
}

// apps.connections.open's fetch: noted, and with debug_reconnects=true on the socket URL Slack
// returns, so the connection refreshes after 360 s instead of hours (using-socket-mode).
function socketFetch(base: typeof fetch, debugReconnects: boolean, note: (seen: Seen) => void) {
	const fetch = watched(base, note);
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const response = await fetch(input, init);
		if (!debugReconnects || response.status !== 200) return response;
		const init2 = {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		};
		const text = await response.text();
		let body: Json | null = null;
		try {
			body = obj(JSON.parse(text));
		} catch {
			body = null;
		}
		if (body?.ok !== true || typeof body.url !== "string" || !URL.canParse(body.url)) {
			return new Response(text, init2);
		}
		const url = new URL(body.url);
		url.searchParams.set("debug_reconnects", "true");
		return Response.json({ ...body, url: url.href }, init2);
	}) as typeof fetch;
}

export interface CallRecord {
	readonly method: Method;
	readonly purpose: string;
	readonly channel: string | null;
	readonly atMs: number;
	readonly ms: number | null;
	readonly status: number | null;
	readonly ok: boolean;
	readonly error: string | null;
	// messages (history, replies) or channels (users.conversations) in the reply.
	readonly items: number | null;
	readonly hasMore: boolean | null;
	// conversations.info: the field names of the channel object, for M6's pre-claim facts.
	readonly fields: readonly string[] | null;
	readonly headers: HeaderNote | null;
	readonly date: DateNote | null;
}

interface Reply {
	readonly data: Json | null;
	readonly error: SlackError | null;
	readonly record: CallRecord;
}

const refused = (reply: Reply | null): string | null => refusal(reply?.error ?? null);
const stateOf = (reply: Reply | null): string =>
	reply === null ? "not checked" : tokenState(reply.error);
const limited = (reply: Reply): boolean =>
	reply.record.status === 429 || reply.error?.kind === "rate_limited";
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

class Calls {
	readonly records: CallRecord[] = [];
	private readonly base: typeof fetch;
	private readonly apiBase: string | undefined;
	private readonly signal: AbortSignal | undefined;
	private readonly since: () => number;
	private readonly hash: (value: string) => string;
	private readonly seen: (seen: Seen) => void;

	constructor(context: {
		readonly base: typeof fetch;
		readonly apiBase: string | undefined;
		readonly signal: AbortSignal | undefined;
		readonly since: () => number;
		readonly hash: (value: string) => string;
		readonly seen: (seen: Seen) => void;
	}) {
		this.base = context.base;
		this.apiBase = context.apiBase;
		this.signal = context.signal;
		this.since = context.since;
		this.hash = context.hash;
		this.seen = context.seen;
	}

	// One callSlack call; a SlackError becomes the reply's error. `keep` false leaves it out of the
	// records (polls), until keep() adds the one that settled the question.
	async call(
		method: Method,
		token: string,
		params: Params,
		purpose: string,
		keep = true,
	): Promise<Reply> {
		const box: { seen?: Seen } = {};
		const atMs = this.since();
		let data: Json | null = null;
		let error: SlackError | null = null;
		try {
			({ data } = await callSlack(method, token, params, {
				base: this.apiBase,
				fetch: watched(this.base, (seen) => {
					box.seen = seen;
					this.seen(seen);
				}),
				signal: this.signal,
			}));
		} catch (caught) {
			if (!(caught instanceof SlackError)) throw caught;
			error = caught;
		}
		const items = list(data?.messages ?? data?.channels);
		const channel = obj(data?.channel);
		const record: CallRecord = {
			method,
			purpose,
			channel: typeof params.channel === "string" ? this.hash(params.channel) : null,
			atMs,
			ms: box.seen?.ms ?? null,
			status: box.seen?.status ?? null,
			ok: error === null,
			error: error?.code ?? null,
			items: data !== null && (data.messages ?? data.channels) !== undefined ? items.length : null,
			hasMore: typeof data?.has_more === "boolean" ? data.has_more : null,
			fields:
				method === "conversations.info" && channel !== null
					? Object.keys(channel)
							.filter((name) => WORD.test(name))
							.sort()
							.slice(0, 80)
					: null,
			headers: box.seen?.headers ?? null,
			date: box.seen?.date ?? null,
		};
		if (keep) this.records.push(record);
		return { data, error, record };
	}

	keep(record: CallRecord): void {
		this.records.push(record);
	}
}

interface Frame {
	readonly atMs: number;
	readonly type: string;
	readonly retryAttempt: number | null;
	readonly retryReason: string | null;
	readonly eventId: string | null;
	readonly reason: string | null;
	readonly numConnections: number | null;
	readonly connectionTimeS: number | null;
	// In memory only: the envelope_id, and the user of a message event without a subtype.
	readonly envelopeId: string | null;
	readonly user: string | null;
}

const word = (value: unknown): string | null =>
	typeof value === "string" && WORD.test(value) ? value : null;
const whole = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
		? value
		: null;

// A Socket Mode frame reduced to Slack's enum values and counts; its ids stay in memory and leave
// only hashed or compared.
function frameOf(data: unknown, atMs: number): Frame | null {
	if (typeof data !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	const frame = obj(parsed);
	if (frame === null) return null;
	const payload = obj(frame.payload);
	const eventId = payload?.event_id;
	const event = obj(payload?.event);
	const envelopeId = frame.envelope_id;
	return {
		atMs,
		type: word(frame.type) ?? "other",
		retryAttempt: whole(frame.retry_attempt),
		retryReason: word(frame.retry_reason),
		eventId: typeof eventId === "string" && EVENT_ID.test(eventId) ? eventId : null,
		reason: word(frame.reason),
		numConnections: whole(frame.num_connections),
		connectionTimeS: whole(obj(frame.debug_info)?.approximate_connection_time),
		envelopeId: typeof envelopeId === "string" && ENVELOPE_ID.test(envelopeId) ? envelopeId : null,
		user: event?.type === "message" && event.subtype === undefined ? id(event.user) : null,
	};
}

interface SocketHooks {
	readonly receive: (data: unknown) => void;
	// False drops the frame the client sends.
	readonly send: (data: unknown) => boolean;
}

// The WebSocket class runSocketMode constructs: each instance hands its frames to `receive` before
// the client sees them, so retries and repeated event_ids that the client drops still show, and
// passes what the client sends through `send`.
function observed(
	Base: typeof WebSocket,
	sockets: WeakSet<object>,
	hooks: SocketHooks,
): typeof WebSocket {
	return class extends Base {
		constructor(url: string | URL, protocols?: string | string[]) {
			super(url, protocols);
			sockets.add(this);
			this.addEventListener("message", (event) => hooks.receive(event.data));
		}

		send(data: Parameters<WebSocket["send"]>[0]): void {
			if (hooks.send(data)) super.send(data);
		}
	};
}

function stateName(state: SocketState): string {
	switch (state.kind) {
		case "ready":
			return `ready:${state.connections}`;
		case "refreshing":
		case "waiting":
		case "stopped":
			return `${state.kind}:${state.reason}`;
		case "closed":
			return `closed:${state.code}`;
		default:
			return state.kind;
	}
}

interface Stats {
	readonly min: number;
	readonly median: number;
	readonly max: number;
}

function stats(values: readonly number[]): Stats | null {
	const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
	if (sorted.length === 0) return null;
	const at = (index: number): number => sorted[index] ?? 0;
	return {
		min: at(0),
		median: at(Math.floor((sorted.length - 1) / 2)),
		max: at(sorted.length - 1),
	};
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const minutes = (ms: number): string => `${Math.ceil(ms / 60_000)} min`;
const names = (types: readonly ChannelType[]): string =>
	types.map((type) => EVENT_TYPES[type]).join(", ");
// A Slack ts for a time in milliseconds.
const slackTs = (ms: number): string => {
	const at = Math.max(0, Math.floor(ms));
	return `${Math.floor(at / 1000)}.${String(at % 1000).padStart(3, "0")}000`;
};

// Wakes on every event and state change, so waits end as soon as their condition holds.
class Waiter {
	private wake: (() => void) | null = null;

	notify(): void {
		this.wake?.();
	}

	// True once `done` holds; false when `ms` passes first.
	async until(done: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
		const deadline = Date.now() + ms;
		while (!done()) {
			signal?.throwIfAborted();
			const left = deadline - Date.now();
			if (left <= 0) return false;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(left, 1000));
				this.wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.wake = null;
		}
		return true;
	}
}

interface Arrival {
	readonly at: number;
	readonly atMs: number;
	readonly event: SlackEvent;
}

type Message = Extract<SlackEvent, { kind: "message" }>;
type Revocation = (typeof REVOCATIONS)[number];

// conversations.history since the run connected, over every conversation of a type that sent no
// event: messages from users other than the owner and Slackbot, without a subtype.
interface SentNote {
	readonly conversations: number;
	read: number;
	fromOthers: number;
	readonly failed: string[];
	capped: boolean;
}

interface Listing {
	readonly byType: ReadonlyMap<ChannelType, readonly string[]>;
	readonly capped: boolean;
	readonly error: string | null;
}

interface RetryProbe {
	target: Frame | null;
	droppedAtMs: number | null;
	retry: Frame | null;
}

class LiveRun {
	private readonly options: LiveOptions;
	private readonly started = Date.now();
	private readonly key = newSessionKey();
	private readonly calls: Calls;
	private readonly waiter = new Waiter();
	private readonly controller = new AbortController();
	private readonly sockets = new WeakSet<object>();
	private readonly arrivals: Arrival[] = [];
	private readonly frames: Frame[] = [];
	private readonly states: { readonly atMs: number; readonly state: SocketState }[] = [];
	private readonly pings: number[] = [];
	private readonly opens: Seen[] = [];
	private readonly dates: DateNote[] = [];
	private readonly announced = new Set<ChannelType>();
	private readonly probe: RetryProbe = { target: null, droppedAtMs: null, retry: null };
	private replaced = 0;
	private owner = "";
	private readyAt: number | null = null;
	private stopped: StopReason | null = null;
	private crashed: unknown = null;
	private done: Promise<unknown> = Promise.resolve();
	private sent = new Map<ChannelType, SentNote>();
	private sentChecks = 0;
	private exemption: {
		listed: number;
		probes: Reply[];
		chosen: number | null;
		second: Reply | null;
	} = { listed: 0, probes: [], chosen: null, second: null };
	private pollerNote: Readonly<Record<string, unknown>> | null = null;
	private revokeFrom: { arrivals: number; states: number; at: number } | null = null;
	private userAfterUninstall: Reply | null = null;
	private userRefusedAfterMs: number | null = null;
	private appAfterUninstall: Reply | null = null;
	private appAfterDelete: Reply | null = null;
	private deleteWaitMs = 0;
	private finalUser: Reply | null = null;
	private finalApp: Reply | null = null;
	private authPolls = 0;
	private openPolls = 0;

	constructor(options: LiveOptions) {
		this.options = options;
		this.calls = new Calls({
			base: options.fetch ?? globalThis.fetch,
			apiBase: options.apiBase,
			signal: options.signal,
			since: () => this.since(),
			hash: (value) => this.hash(value),
			seen: (seen) => this.noteSeen(seen),
		});
	}

	private since(): number {
		return Date.now() - this.started;
	}

	private hash(value: string): string {
		return hashId(this.key, value);
	}

	private say(line: string): void {
		this.options.say(line);
	}

	private noteSeen(seen: Seen): void {
		this.dates.push(seen.date);
		this.replaced += seen.replaced;
	}

	private other(user: string | null): boolean {
		return user !== null && user !== this.owner && user !== SLACKBOT;
	}

	async run(): Promise<LiveResult> {
		const onPing = (message: unknown): void => {
			const socket = (message as { websocket?: unknown } | null)?.websocket;
			if (typeof socket === "object" && socket !== null && this.sockets.has(socket)) {
				this.pings.push(Date.now());
			}
		};
		const abort = (): void => this.controller.abort();
		this.options.signal?.addEventListener("abort", abort, { once: true });
		diagnostics.subscribe("undici:websocket:ping", onPing);
		try {
			await this.identify();
			await this.connect();
			await this.events();
			await this.reads();
			await this.pollOnce();
			await this.revoke();
		} finally {
			this.controller.abort();
			await Promise.race([this.done, sleep(5000, undefined, { ref: false })]);
			diagnostics.unsubscribe("undici:websocket:ping", onPing);
			this.options.signal?.removeEventListener("abort", abort);
		}
		return this.result();
	}

	private async identify(): Promise<void> {
		const reply = await this.calls.call("auth.test", this.options.userToken, {}, "identity");
		const owner = id(reply.data?.user_id);
		const { error } = reply;
		if (error !== null) {
			const code = error.code;
			throw new Error(
				error.kind === "rate_limited"
					? `auth.test was rate limited (${code}); try again in a minute`
					: error.kind === "transient" || code.startsWith("http_")
						? `couldn't reach Slack: auth.test failed (${code})`
						: `auth.test refused the user token (${code})`,
			);
		}
		if (owner === null) throw new Error("auth.test answered without a user_id");
		this.owner = owner;
		this.say("auth.test accepted the user token; connecting over Socket Mode");
	}

	private async connect(): Promise<void> {
		const { options } = this;
		this.done = runSocketMode({
			appToken: options.appToken,
			apiBase: options.apiBase,
			allowSocketUrl: options.allowSocketUrl,
			fetch: socketFetch(options.fetch ?? globalThis.fetch, options.debugReconnects, (seen) => {
				this.opens.push(seen);
				this.noteSeen(seen);
			}),
			WebSocket: observed(options.WebSocket ?? globalThis.WebSocket, this.sockets, {
				receive: (data) => this.frame(data),
				send: (data) => this.ack(data),
			}),
			signal: this.controller.signal,
			onEvent: (event) => this.arrive(event),
			onState: (state) => {
				this.states.push({ atMs: this.since(), state });
				if (state.kind === "ready") this.readyAt ??= Date.now();
				if (state.kind === "stopped") this.stopped = state.reason;
				this.waiter.notify();
			},
		}).catch((error: unknown) => {
			this.crashed = error;
			this.waiter.notify();
		});
		const settled = () => this.readyAt !== null || this.stopped !== null || this.crashed !== null;
		await this.waiter.until(settled, options.waits.connectMs, options.signal);
		if (this.crashed !== null) throw this.crashed;
		if (this.readyAt === null) {
			const last = this.states.at(-1);
			const why = this.stopped ?? (last ? stateName(last.state) : "no answer");
			throw new Error(
				`Socket Mode didn't connect within ${seconds(options.waits.connectMs)} (${why})`,
			);
		}
	}

	// Every frame, before the client: the first message from another user becomes the envelope
	// whose ack is dropped once (DRAFTYAK_S6_DROP_ACK), and its retry is watched for.
	private frame(data: unknown): void {
		const frame = frameOf(data, this.since());
		if (frame === null) return;
		this.frames.push(frame);
		const { probe } = this;
		if (probe.target === null) {
			if (
				this.options.dropAck &&
				frame.type === "events_api" &&
				(frame.retryAttempt ?? 0) === 0 &&
				frame.envelopeId !== null &&
				this.other(frame.user)
			) {
				probe.target = frame;
			}
			return;
		}
		if (
			probe.droppedAtMs !== null &&
			probe.retry === null &&
			(frame.retryAttempt ?? 0) > 0 &&
			frame.eventId !== null &&
			frame.eventId === probe.target.eventId
		) {
			probe.retry = frame;
			const reason = frame.retryReason === null ? "" : `, ${frame.retryReason}`;
			this.say(
				`Slack redelivered that message after ${seconds(frame.atMs - probe.droppedAtMs)} (retry_attempt ${frame.retryAttempt}${reason})`,
			);
		}
	}

	// What the client sends: false drops the target envelope's ack, once.
	private ack(data: unknown): boolean {
		const { probe } = this;
		if (probe.target === null || probe.droppedAtMs !== null || typeof data !== "string") {
			return true;
		}
		let envelopeId: unknown;
		try {
			envelopeId = obj(JSON.parse(data))?.envelope_id;
		} catch {
			return true;
		}
		if (envelopeId !== probe.target.envelopeId) return true;
		probe.droppedAtMs = this.since();
		this.say(
			"dropped the ack of the first message from another user once, so Slack delivers it again (notes open point 7)",
		);
		return false;
	}

	private fromOther(event: SlackEvent): event is Message {
		return event.kind === "message" && this.other(event.user);
	}

	// A new message without a subtype carries its own ts; an edit, a deletion or a reply
	// notification carries the original's or the parent's.
	private timed(event: SlackEvent): boolean {
		return event.kind === "message" && event.change === "new" && event.subtype === null;
	}

	private latency(arrival: Arrival): number {
		return arrival.event.kind === "message"
			? Math.round(arrival.at - Number(arrival.event.ts) * 1000)
			: Number.NaN;
	}

	private arrive(event: SlackEvent): void {
		const arrival: Arrival = { at: Date.now(), atMs: this.since(), event };
		this.arrivals.push(arrival);
		if (this.fromOther(event) && event.channelType !== null) {
			if (!this.announced.has(event.channelType)) {
				this.announced.add(event.channelType);
				const after = this.timed(event)
					? `${seconds(this.latency(arrival))} after it was sent`
					: `as ${event.change} ${event.subtype ?? "message"}`;
				this.say(`${EVENT_TYPES[event.channelType]}: ${RECEIVED} (${after})`);
			}
		} else if (event.kind !== "message" && this.revokeFrom !== null) {
			this.say(`${event.kind}: ${RECEIVED}`);
		}
		this.waiter.notify();
	}

	private running(phase: string): void {
		if (this.crashed !== null) throw this.crashed;
		if (this.stopped !== null) {
			throw new Error(`Socket Mode stopped (${this.stopped}) during ${phase}`);
		}
	}

	private async events(): Promise<void> {
		const { expect, waits, signal } = this.options;
		const missing = (): ChannelType[] => expect.filter((type) => !this.announced.has(type));
		const asks = expect.map((type) => ASKS[type]).join(", ");
		this.say(
			`connected after ${seconds((this.readyAt ?? this.started) - this.started)}. Second user, send now: ${asks}. Waiting up to ${minutes(waits.eventsMs)} for ${names(missing())}`,
		);
		this.options.cue?.("send");
		const start = Date.now();
		const deadline = start + waits.eventsMs;
		let nextRemind = start + waits.remindMs;
		let nextCheck = start + waits.checkMs;
		while (missing().length > 0) {
			const now = Date.now();
			if (now >= deadline) break;
			if (now >= nextCheck) {
				nextCheck = now + waits.checkMs;
				nextRemind = now + waits.remindMs;
				for (const [type, note] of await this.sentCheck(missing())) {
					if (!this.announced.has(type)) this.say(this.checkLine(type, note));
				}
				this.running("the events phase");
				continue;
			}
			if (now >= nextRemind) {
				nextRemind = now + waits.remindMs;
				this.say(`still waiting for ${names(missing())} (${minutes(deadline - now)} left)`);
			}
			const count = this.arrivals.length;
			await this.waiter.until(
				() => this.arrivals.length !== count || this.stopped !== null || this.crashed !== null,
				Math.max(1, Math.min(deadline, nextRemind, nextCheck) - now),
				signal,
			);
			this.running("the events phase");
		}
		const absent = missing();
		if (absent.length === 0) {
			this.say("every expected message type arrived");
			return;
		}
		this.sent = await this.sentCheck(absent);
		const why = absent.map((type) => `${EVENT_TYPES[type]} ${this.missingVerdict(type)}`);
		this.say(`stopped waiting after ${minutes(waits.eventsMs)}: ${why.join("; ")}`);
	}

	private checkLine(type: ChannelType, note: SentNote): string {
		const name = EVENT_TYPES[type];
		if (note.fromOthers > 0) {
			return `${name}: ${note.fromOthers} message(s) from others since the run connected, but no event yet`;
		}
		if (note.failed.length > 0 || note.capped) {
			return `${name}: no event yet, and the history check is incomplete (${this.gaps(note)})`;
		}
		return `${name}: nothing from others since the run connected. Second user, send ${ASKS[type]} now`;
	}

	private gaps(note: SentNote): string {
		const codes = [...new Set(note.failed)];
		return [...codes, ...(note.capped ? ["more than the run reads"] : [])].join(", ");
	}

	// For an expected type that sent no event: a message from others in its history since the
	// connect means Slack didn't deliver it; none means nobody sent one.
	private missingVerdict(type: ChannelType): string {
		const note = this.sent.get(type);
		if (note === undefined) return `${NOT_DELIVERED} (history not checked)`;
		if (note.fromOthers > 0) return NOT_DELIVERED;
		if (note.failed.length > 0 || note.capped) {
			return `not confirmed (no event; history check incomplete: ${this.gaps(note)})`;
		}
		return NOT_SENT;
	}

	private firstFromOther(type: ChannelType): Message | undefined {
		for (const { event } of this.arrivals) {
			if (this.fromOther(event) && event.channelType === type) return event;
		}
		return undefined;
	}

	// The owner's conversations by type, in Slack's order.
	private async conversations(purpose: string): Promise<Listing> {
		const reply = await this.calls.call(
			"users.conversations",
			this.options.userToken,
			{ types: "im,mpim,public_channel,private_channel", exclude_archived: true, limit: 200 },
			purpose,
		);
		const byType = new Map<ChannelType, string[]>(TYPES.map((type) => [type, []]));
		for (const raw of list(reply.data?.channels)) {
			const channel = obj(raw);
			const key = id(channel?.id);
			if (channel === null || key === null) continue;
			const type: ChannelType =
				channel.is_im === true
					? "im"
					: channel.is_mpim === true
						? "mpim"
						: channel.is_private === true
							? "group"
							: "channel";
			byType.get(type)?.push(key);
		}
		const next = obj(reply.data?.response_metadata)?.next_cursor;
		return {
			byType,
			capped: typeof next === "string" && next !== "",
			error: reply.error?.code ?? null,
		};
	}

	// History since the connect (less 2 s for the clocks) of every conversation of these types.
	// A rate limit ends the check, leaving the rest unread.
	private async sentCheck(types: readonly ChannelType[]): Promise<Map<ChannelType, SentNote>> {
		this.sentChecks++;
		const listing = await this.conversations("sent check");
		const oldest = slackTs((this.readyAt ?? this.started) - 2000);
		const notes = new Map<ChannelType, SentNote>();
		let stop: string | null = null;
		for (const type of types) {
			const channels = listing.byType.get(type) ?? [];
			const note: SentNote = {
				conversations: channels.length,
				read: 0,
				fromOthers: 0,
				failed: listing.error === null ? [] : [listing.error],
				capped: listing.capped || channels.length > CHECKED,
			};
			notes.set(type, note);
			for (const channel of channels.slice(0, CHECKED)) {
				if (stop !== null) {
					note.failed.push(stop);
					break;
				}
				const reply = await this.calls.call(
					"conversations.history",
					this.options.userToken,
					{ channel, oldest, limit: 100 },
					"sent check",
				);
				if (reply.error !== null) {
					note.failed.push(reply.error.code);
					if (limited(reply)) stop = reply.error.code;
					continue;
				}
				note.read++;
				if (reply.record.hasMore === true) note.capped = true;
				note.fromOthers += list(reply.data?.messages).filter((raw) => {
					const message = obj(raw);
					return message !== null && message.subtype === undefined && this.other(id(message.user));
				}).length;
			}
		}
		return notes;
	}

	// conversations.info (with the member count), .history and .replies on one conversation of
	// each type (where the second user's message arrived, else the first the owner belongs to),
	// then the exemption check.
	private async reads(): Promise<void> {
		const user = this.options.userToken;
		this.say("reading conversations.info, .history and .replies for their rate-limit headers");
		const listing = await this.conversations("discovery");
		for (const type of TYPES) {
			const first = this.firstFromOther(type);
			const channel = first?.channel ?? listing.byType.get(type)?.[0];
			if (channel === undefined) continue;
			const purpose = EVENT_TYPES[type];
			await this.calls.call(
				"conversations.info",
				user,
				{ channel, include_num_members: true },
				purpose,
			);
			const history = await this.calls.call(
				"conversations.history",
				user,
				{ channel, limit: 20 },
				purpose,
			);
			const newest = obj(list(history.data?.messages)[0])?.ts;
			const ts = first?.ts ?? (typeof newest === "string" && TS.test(newest) ? newest : null);
			if (ts !== null) {
				await this.calls.call("conversations.replies", user, { channel, ts, limit: 20 }, purpose);
			}
		}
		await this.exemptionCheck(listing.byType.get("channel") ?? []);
		this.say(`exemption: ${this.exemptionVerdict()}`);
	}

	// notes/rate-limits.md, open point 2: conversations.history with limit 100 on the owner's public
	// channels in turn, until one returns more than 15 messages (or shows the 15-object cap), then a
	// second call on that channel within the same minute.
	private async exemptionCheck(publics: readonly string[]): Promise<void> {
		const user = this.options.userToken;
		this.exemption.listed = publics.length;
		let fullest: { channel: string; index: number; count: number } | null = null;
		for (const channel of publics.slice(0, PROBED)) {
			const reply = await this.calls.call(
				"conversations.history",
				user,
				{ channel, limit: 100 },
				"exemption",
			);
			const index = this.exemption.probes.push(reply) - 1;
			if (reply.error !== null) {
				if (limited(reply)) return;
				continue;
			}
			const count = reply.record.items ?? 0;
			if (fullest === null || count > fullest.count) fullest = { channel, index, count };
			if (count > 15 || reply.record.hasMore === true) break;
		}
		if (fullest === null || fullest.count <= 15) return;
		this.exemption.chosen = fullest.index;
		this.exemption.second = await this.calls.call(
			"conversations.history",
			user,
			{ channel: fullest.channel, limit: 100 },
			"exemption",
		);
	}

	private exemptionVerdict(): string {
		const reads = this.calls.records.filter(
			(record) =>
				(record.method === "conversations.history" || record.method === "conversations.replies") &&
				(record.status === 429 || record.error === "ratelimited"),
		);
		const [first] = reads;
		if (first !== undefined) {
			return `does not hold (${first.method} rate limited: HTTP ${first.status ?? "none"}, ${first.error})`;
		}
		const { listed, probes, second } = this.exemption;
		if (listed === 0) return "not checked (no public channel)";
		const answered = probes.filter((reply) => reply.error === null);
		if (answered.length === 0) return `not checked (${probes[0]?.error?.code ?? "no call"})`;
		const capped = answered.find(
			(reply) => (reply.record.items ?? 0) <= 15 && reply.record.hasMore === true,
		);
		if (capped !== undefined) {
			return `does not hold (capped at ${capped.record.items ?? 0} objects with limit 100)`;
		}
		const most = Math.max(...answered.map((reply) => reply.record.items ?? 0));
		if (most <= 15) {
			return `inconclusive (${most} messages with limit 100 in the fullest public channel; more than 15 are needed)`;
		}
		if (second === null) return "inconclusive (no second call)";
		if (second.error !== null) return `inconclusive (second call: ${second.error.code})`;
		return "holds";
	}

	// One cycle of the budgeted fallback with the owner's token, no retries, at most pollerMs.
	private async pollOnce(): Promise<void> {
		const { options } = this;
		const seen: Seen[] = [];
		const since = tsKey(slackTs((this.readyAt ?? this.started) - 2000));
		const fromOthers = Object.fromEntries(TYPES.map((type) => [EVENT_TYPES[type], 0]));
		const signal = AbortSignal.any([
			this.controller.signal,
			AbortSignal.timeout(options.waits.pollerMs),
		]);
		const poller = new Poller({
			userToken: options.userToken,
			apiBase: options.apiBase,
			fetch: watched(options.fetch ?? globalThis.fetch, (each) => {
				seen.push(each);
				this.noteSeen(each);
			}),
			maxAttempts: 1,
			signal,
			onMessage: (ref) => {
				if (ref.channelType === null || ref.subtype !== null || !this.other(ref.user)) return;
				if (tsKey(ref.ts) <= since) return;
				const type = EVENT_TYPES[ref.channelType];
				fromOthers[type] = (fromOthers[type] ?? 0) + 1;
			},
		});
		const started = performance.now();
		const calls = () => seen.slice(0, 50).map(({ method, status, ms }) => ({ method, status, ms }));
		try {
			const report = await poller.cycle();
			this.pollerNote = {
				ok: true,
				ms: Math.round(performance.now() - started),
				conversations: report.history.length,
				threads: report.replies.length,
				messages: report.messages,
				fromOthersSinceConnect: fromOthers,
				failed: report.failed,
				truncated: report.truncated,
				calls: calls(),
			};
			this.say(
				`poller: one cycle read ${report.history.length} conversations, ${report.failed} failed`,
			);
		} catch (error) {
			const code =
				error instanceof SlackError ? error.code : signal.aborted ? "timed_out" : "failed";
			this.pollerNote = {
				ok: false,
				ms: Math.round(performance.now() - started),
				error: code,
				fromOthersSinceConnect: fromOthers,
				calls: calls(),
			};
			this.say(`poller: the cycle ended early (${code})`);
		}
	}

	private revocations(kind: Revocation): Arrival[] {
		const from = this.revokeFrom?.arrivals ?? this.arrivals.length;
		return this.arrivals.slice(from).filter((arrival) => arrival.event.kind === kind);
	}

	private async revoke(): Promise<void> {
		if (this.options.keepApp) {
			this.say("the app stays installed for M6 (DRAFTYAK_S6_KEEP_APP=1)");
			return;
		}
		await this.uninstall();
		await this.remove();
		const { options } = this;
		this.finalUser = await this.calls.call("auth.test", options.userToken, {}, "final check");
		this.finalApp = await this.calls.call(
			"apps.connections.open",
			options.appToken,
			{},
			"final check",
		);
		this.say(
			`final check: user token ${stateOf(this.finalUser)}, app-level token ${stateOf(this.finalApp)}`,
		);
	}

	// The owner uninstalls the app: app_uninstalled and tokens_revoked over Socket Mode (if Slack
	// accepted them as user events), and auth.test refusing the user token, which the hub checks
	// itself (plan §3 Revocation). It waits for all three, however late, until uninstallMs.
	private async uninstall(): Promise<void> {
		const { options } = this;
		const { waits, signal } = options;
		const at = Date.now();
		this.revokeFrom = { arrivals: this.arrivals.length, states: this.states.length, at };
		this.say(
			`Owner: uninstall the app now. Waiting up to ${minutes(waits.uninstallMs)} for app_uninstalled, tokens_revoked and auth.test refusing the user token`,
		);
		options.cue?.("uninstall");
		const deadline = at + waits.uninstallMs;
		let probe: Reply | null = null;
		const pending = (): string[] => [
			...REVOCATIONS.filter((kind) => this.revocations(kind).length === 0),
			...(refused(probe) === null ? ["auth.test refusing the user token"] : []),
		];
		let lastPoll = Number.NEGATIVE_INFINITY;
		let nextRemind = at + waits.remindMs;
		while (pending().length > 0) {
			const now = Date.now();
			if (now >= deadline) break;
			if (refused(probe) === null && now - lastPoll >= waits.pollMs) {
				lastPoll = now;
				this.authPolls++;
				probe = await this.calls.call("auth.test", options.userToken, {}, "after uninstall", false);
				const code = refused(probe);
				if (code !== null) {
					this.userRefusedAfterMs = Date.now() - at;
					this.say(`auth.test refuses the user token now (${code})`);
				}
				continue;
			}
			if (now >= nextRemind) {
				nextRemind = now + waits.remindMs;
				this.say(`still waiting for ${pending().join(", ")} (${minutes(deadline - now)} left)`);
			}
			const count = this.arrivals.length;
			const poll = refused(probe) === null ? lastPoll + waits.pollMs : deadline;
			await this.waiter.until(
				() => this.arrivals.length !== count,
				Math.max(1, Math.min(deadline, poll, nextRemind) - now),
				signal,
			);
		}
		if (probe !== null) this.calls.keep(probe.record);
		this.userAfterUninstall = probe;
		// Does the app-level token outlive the uninstall? It belongs to the app, not the install.
		this.appAfterUninstall = await this.calls.call(
			"apps.connections.open",
			options.appToken,
			{},
			"after uninstall",
		);
	}

	// The owner deletes the app: apps.connections.open refusing the app-level token. If Slack
	// already refused it after the uninstall, the run can't see the delete, so it waits deleteMs.
	private async remove(): Promise<void> {
		const { options } = this;
		const { waits, signal } = options;
		const already = refused(this.appAfterUninstall);
		this.say(
			already === null
				? `Owner: now delete the app. Waiting up to ${minutes(waits.deleteMs)} for apps.connections.open to refuse the app-level token`
				: `Owner: now delete the app. apps.connections.open already refuses the app-level token (${already}), so the run can't see the delete: it waits ${minutes(waits.deleteMs)}, then checks both tokens again`,
		);
		options.cue?.("delete");
		const at = Date.now();
		const until = at + waits.deleteMs;
		let nextRemind = at + waits.remindMs;
		let check: Reply | null = null;
		while (Date.now() < until) {
			if (already === null) {
				this.openPolls++;
				check = await this.calls.call(
					"apps.connections.open",
					options.appToken,
					{},
					"after delete",
					false,
				);
				if (refused(check) !== null) break;
			}
			const now = Date.now();
			if (now >= nextRemind) {
				nextRemind = now + waits.remindMs;
				this.say(`waiting for the owner to delete the app (${minutes(until - now)} left)`);
			}
			const next = already === null ? now + waits.pollMs : nextRemind;
			await sleep(Math.max(1, Math.min(next, until) - now), undefined, { signal });
		}
		this.deleteWaitMs = Date.now() - at;
		if (check !== null) this.calls.keep(check.record);
		this.appAfterDelete = check;
		if (already !== null) return;
		const code = refused(check);
		this.say(
			code === null
				? `apps.connections.open didn't refuse the app-level token (${stateOf(check)})`
				: `apps.connections.open refuses the app-level token now (${code})`,
		);
	}

	// Sent before the first connection said hello, allowing for 2 s between Slack's clock and this
	// machine's: its latency includes the wait, so the latency figures leave it out.
	private early(event: SlackEvent): boolean {
		return (
			event.kind === "message" && Number(event.ts) * 1000 < (this.readyAt ?? this.started) - 2000
		);
	}

	private sample(arrival: Arrival): Readonly<Record<string, unknown>> {
		const event = arrival.event as Message;
		const frame = this.frames.find(
			(each) => each.eventId !== null && each.eventId === event.eventId,
		);
		return {
			atMs: arrival.atMs,
			latencyMs: this.timed(event) ? this.latency(arrival) : null,
			sentBeforeConnect: this.early(event),
			change: event.change,
			subtype: event.subtype,
			thread: event.threadTs !== null,
			retryAttempt: frame?.retryAttempt ?? null,
			channel: this.hash(event.channel),
			ts: this.hash(event.ts),
			eventId: event.eventId === null ? null : this.hash(event.eventId),
		};
	}

	private typeNote(type: ChannelType): Readonly<Record<string, unknown>> {
		const messages = this.arrivals.filter(
			({ event }) => event.kind === "message" && event.channelType === type,
		);
		const others = messages.filter(({ event }) => this.fromOther(event));
		const timed = others.filter(({ event }) => this.timed(event) && !this.early(event));
		const expected = this.options.expect.includes(type);
		const sent = this.sent.get(type);
		return {
			expected,
			verdict: others.length > 0 ? RECEIVED : expected ? this.missingVerdict(type) : "not checked",
			fromOthers: others.length,
			fromOwner: messages.filter(
				({ event }) => event.kind === "message" && event.user === this.owner,
			).length,
			latencyMs: stats(timed.map((arrival) => this.latency(arrival))),
			historySinceConnect:
				sent === undefined
					? null
					: {
							conversations: sent.conversations,
							read: sent.read,
							fromOthers: sent.fromOthers,
							failed: [...new Set(sent.failed)].slice(0, 10),
							capped: sent.capped,
						},
			samples: others.slice(0, 10).map((arrival) => this.sample(arrival)),
		};
	}

	// The dropped envelope's retry: the first frame after the drop with its event_id and a
	// retry_attempt, else the first retried frame after the drop at all.
	private probeNote(): Readonly<Record<string, unknown>> {
		const { target, droppedAtMs } = this.probe;
		const after =
			droppedAtMs === null
				? []
				: this.frames.filter((frame) => frame.atMs >= droppedAtMs && (frame.retryAttempt ?? 0) > 0);
		const retry = this.probe.retry ?? after[0] ?? null;
		return {
			enabled: this.options.dropAck,
			dropped: droppedAtMs !== null,
			droppedAtMs,
			retried: retry !== null,
			retryAfterMs: retry === null || droppedAtMs === null ? null : retry.atMs - droppedAtMs,
			retryAttempt: retry?.retryAttempt ?? null,
			retryReason: retry?.retryReason ?? null,
			newEnvelopeId:
				retry === null || target === null ? null : retry.envelopeId !== target.envelopeId,
			sameEventId:
				retry === null || target === null
					? null
					: target.eventId !== null && retry.eventId === target.eventId,
			retriesAfterDrop: after.length,
		};
	}

	private socketNote(): Readonly<Record<string, unknown>> {
		const byType = new Map<string, number>();
		const seenIds = new Set<string>();
		let repeats = 0;
		for (const frame of this.frames) {
			byType.set(frame.type, (byType.get(frame.type) ?? 0) + 1);
			if (frame.eventId === null) continue;
			if (seenIds.has(frame.eventId)) repeats++;
			seenIds.add(frame.eventId);
		}
		const intervals = this.pings.slice(1).map((at, index) => at - (this.pings[index] ?? at));
		const statuses = new Map<number, number>();
		for (const { status } of this.opens) statuses.set(status, (statuses.get(status) ?? 0) + 1);
		return {
			debugReconnects: this.options.debugReconnects,
			connectMs: this.readyAt === null ? null : this.readyAt - this.started,
			opens: {
				count: this.opens.length,
				statuses: Object.fromEntries([...statuses].map(([status, n]) => [String(status), n])),
				headers: this.opens[0]?.headers ?? null,
			},
			hellos: this.frames
				.filter((frame) => frame.type === "hello")
				.slice(0, 20)
				.map(({ atMs, numConnections, connectionTimeS }) => ({
					atMs,
					numConnections,
					connectionTimeS,
				})),
			disconnects: this.frames
				.filter((frame) => frame.type === "disconnect")
				.slice(0, 20)
				.map(({ atMs, reason }) => ({ atMs, reason })),
			frames: Object.fromEntries(byType),
			retries: this.frames
				.filter((frame) => (frame.retryAttempt ?? 0) > 0)
				.slice(0, 20)
				.map(({ atMs, retryAttempt, retryReason, eventId }) => ({
					atMs,
					retryAttempt,
					retryReason,
					eventId: eventId === null ? null : this.hash(eventId),
				})),
			repeatedEventIds: repeats,
			retryProbe: this.probeNote(),
			pings: { count: this.pings.length, intervalMs: stats(intervals) },
			states: this.states
				.slice(0, 100)
				.map(({ atMs, state }) => ({ atMs, state: stateName(state) })),
			stopped: this.stopped,
		};
	}

	private revocationNote(kind: Revocation): Readonly<Record<string, unknown>> {
		const [first] = this.revocations(kind);
		if (first === undefined) return { verdict: NOT_DELIVERED, count: 0 };
		const { event } = first;
		const lag = event.eventTime === null ? null : first.at / 1000 - event.eventTime;
		return {
			verdict: RECEIVED,
			count: this.revocations(kind).length,
			afterCueMs: first.at - (this.revokeFrom?.at ?? first.at),
			eventTimeLagS: lag === null ? null : Math.round(lag * 10) / 10,
			...(event.kind === "tokens_revoked"
				? {
						userTokens: event.userTokens.length,
						botTokens: event.botTokens.length,
						ownerListed: event.userTokens.includes(this.owner),
					}
				: {}),
		};
	}

	private revocationData(): Readonly<Record<string, unknown>> {
		if (this.revokeFrom === null) return { uninstall: KEPT, revoked: KEPT };
		const user = stateOf(this.finalUser);
		const app = stateOf(this.finalApp);
		const already = refused(this.appAfterUninstall);
		return {
			uninstall: "done",
			app_uninstalled: this.revocationNote("app_uninstalled"),
			tokens_revoked: this.revocationNote("tokens_revoked"),
			userTokenAfterUninstall: stateOf(this.userAfterUninstall),
			userRefusedAfterMs: this.userRefusedAfterMs,
			authChecks: this.authPolls,
			appTokenAfterUninstall: stateOf(this.appAfterUninstall),
			appTokenAfterDelete:
				already === null
					? stateOf(this.appAfterDelete)
					: `refused already after the uninstall (${already})`,
			connectionChecks: this.openPolls,
			deleteWaitMs: this.deleteWaitMs,
			finalCheck: { userToken: user, appToken: app },
			socketStates: this.states
				.slice(this.revokeFrom.states, this.revokeFrom.states + 40)
				.map(({ atMs, state }) => ({ atMs, state: stateName(state) })),
			revoked:
				refused(this.finalUser) !== null && refused(this.finalApp) !== null
					? "yes"
					: `no (user token: ${user}; app-level token: ${app})`,
		};
	}

	private clockNote(): Readonly<Record<string, unknown>> {
		const present = this.dates.filter((date) => date.present);
		return {
			responses: this.dates.length,
			withDate: present.length,
			roundTrips: present.filter((date) => date.roundTrips).length,
			skewMs: stats(present.flatMap((date) => (date.skewMs === null ? [] : [date.skewMs]))),
		};
	}

	private result(): LiveResult {
		const events = Object.fromEntries(
			TYPES.map((type) => [EVENT_TYPES[type], this.typeNote(type)]),
		);
		const revocation = this.revocationData();
		const verdicts = [
			...TYPES.map((type) => `${EVENT_TYPES[type]}: ${events[EVENT_TYPES[type]]?.verdict}`),
			`exemption: ${this.exemptionVerdict()}`,
			...REVOCATIONS.map((kind) => {
				const note = obj(revocation[kind]);
				return `${kind}: ${note === null ? KEPT : String(note.verdict)}`;
			}),
			`revoked: ${String(revocation.revoked)}`,
		];
		const { listed, probes, chosen, second } = this.exemption;
		const counts = (reply: Reply) => ({
			status: reply.record.status,
			error: reply.record.error,
			items: reply.record.items,
			hasMore: reply.record.hasMore,
			atMs: reply.record.atMs,
		});
		const clock = this.clockNote();
		const data = {
			procedure: {
				expected: this.options.expect.map((type) => EVENT_TYPES[type]),
				keepApp: this.options.keepApp,
				debugReconnects: this.options.debugReconnects,
				dropAck: this.options.dropAck,
				waitsMs: this.options.waits,
			},
			verdicts,
			events,
			sentChecks: this.sentChecks,
			unknownTypeEvents: this.arrivals.filter(
				({ event }) => event.kind === "message" && event.channelType === null,
			).length,
			socketMode: this.socketNote(),
			rateLimits: {
				calls: this.calls.records.slice(0, 200),
				headerValuesReplaced: this.replaced,
				exemption: {
					verdict: this.exemptionVerdict(),
					limit: 100,
					publicChannels: listed,
					probes: probes.map(counts),
					chosen,
					second: second === null ? null : counts(second),
				},
			},
			clock,
			poller: this.pollerNote,
			revocation,
		};
		const skew = obj(clock.skewMs);
		this.say(
			`Slack's Date header: on ${clock.withDate} of ${clock.responses} responses, round-tripping on ${clock.roundTrips}${skew === null ? "" : `; skew ${skew.min} to ${skew.max} ms (median ${skew.median})`}`,
		);
		const clean = redact(sanitize(data)) as Readonly<Record<string, unknown>>;
		const marks = (value: unknown): number => JSON.stringify(value).split("[redacted:").length - 1;
		return { data: clean, verdicts, redacted: marks(clean) - marks(data), replaced: this.replaced };
	}
}

// Strings cut to 200 characters and non-finite numbers made null, so writeEvidence() never refuses
// a session's evidence at the end; redact() then replaces any content-shaped string.
function sanitize(value: unknown): unknown {
	if (typeof value === "string") return short(value);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return value.map(sanitize);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([name, item]) => [short(name), sanitize(item)]),
		);
	}
	return value;
}

export function runLive(options: LiveOptions): Promise<LiveResult> {
	return new LiveRun(options).run();
}
