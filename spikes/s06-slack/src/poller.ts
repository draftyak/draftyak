import {
	assertToken,
	type Clock,
	callSlack,
	METHODS,
	type Method,
	type Params,
	retryWait,
	SlackError,
	type SlackResponse,
	systemClock,
	type Tier,
} from "./api.ts";
import {
	type ChannelType,
	id,
	ids,
	type Json,
	type MessageRef,
	messageRef,
	obj,
	tsKey,
} from "./reduce.ts";

// The budgeted fallback when Socket Mode delivers nothing (plan §3 Sync engine, Slack): one token
// bucket per method tier, Slack's Retry-After honoured per method, conversations read DMs and
// MPIMs first, then recently active channels, then the rest in turn, and conversations.replies
// only for threads whose reply_count changed or where the owner took part. Quiet DMs and MPIMs
// take turns too, so a cycle's work follows recent activity, not the number of conversations.
// Messages leave as MessageRefs (ids and timestamps).

// The floor of each tier (https://docs.slack.dev/apis/web-api/rate-limits, read 2026-10-17):
// Tier 1 "1+ per minute", Tier 2 "20+", Tier 3 "50+", Tier 4 "100+"; auth.test, the only
// special-tier method here, "allows hundreds of requests per minute".
export const TIER_PER_MINUTE: Readonly<Record<Tier, number>> = {
	1: 1,
	2: 20,
	3: 50,
	4: 100,
	special: 100,
};

// Slack suggests designing for about one request per second, with bursts tolerated: a bucket
// holds a tenth of its minute's budget.
export class TokenBucket {
	readonly burst: number;
	private readonly perMinute: number;
	private readonly now: () => number;
	private tokens: number;
	private at: number;

	constructor(perMinute: number, now: () => number, burst: number = Math.floor(perMinute / 10)) {
		this.burst = Math.max(1, burst);
		this.perMinute = perMinute;
		this.now = now;
		this.tokens = this.burst;
		this.at = now();
	}

	// Takes a token and returns 0, or returns the milliseconds until one is free (taking none).
	take(): number {
		const now = this.now();
		this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) * this.perMinute) / 60_000);
		this.at = now;
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return 0;
		}
		return Math.max(1, Math.ceil(((1 - this.tokens) * 60_000) / this.perMinute));
	}
}

export interface Conversation {
	readonly id: string;
	// users.conversations reports a conversion between public and private.
	type: ChannelType;
	newest: string | null;
	activity: number | null;
	// History read at least once.
	synced: boolean;
}

interface Thread {
	readonly conversation: Conversation;
	readonly ts: string;
	replyCount: number | null;
	latest: string | null;
	owner: boolean;
}

export type ReplyReason = "reply_count" | "owner";

// A thread to read this cycle, with the parent's reply_count when the history window showed it.
interface Due {
	readonly why: ReplyReason;
	readonly count: number | null;
}

export interface CycleReport {
	readonly history: string[];
	readonly replies: { readonly channel: string; readonly ts: string; readonly why: ReplyReason }[];
	messages: number;
	failed: number;
	// Reads cut off at MAX_PAGES pages: the conversation list, a history window or a thread.
	truncated: number;
}

export interface PollerOptions {
	readonly userToken: string;
	readonly onMessage: (ref: MessageRef) => void;
	readonly apiBase?: string;
	readonly fetch?: typeof fetch;
	readonly clock?: Clock;
	readonly perMinute?: Partial<Record<Tier, number>>;
	readonly recentMs?: number;
	readonly quietPerCycle?: number;
	readonly historyLimit?: number;
	readonly maxAttempts?: number;
	readonly refreshEvery?: number;
	readonly signal?: AbortSignal;
}

const TYPES = "im,mpim,public_channel,private_channel";
export const MAX_PAGES = 10;

const cursorOf = (data: Json): string | undefined => {
	const next = obj(data.response_metadata)?.next_cursor;
	return typeof next === "string" && next !== "" ? next : undefined;
};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const later = (a: string, b: string | null): boolean => b === null || tsKey(a) > tsKey(b);
const fatal = (error: unknown): boolean => !(error instanceof SlackError) || error.kind === "auth";
const byId = (a: Conversation, b: Conversation): number => (a.id < b.id ? -1 : 1);
const byActivity = (a: Conversation, b: Conversation): number =>
	(b.activity ?? -1) - (a.activity ?? -1) || byId(a, b);

export class Poller {
	owner: string | null = null;
	private readonly options: PollerOptions;
	private readonly clock: Clock;
	private readonly buckets: Record<Tier, TokenBucket>;
	private readonly holds = new Map<Method, number>();
	private readonly threads = new Map<string, Thread>();
	private readonly lastQuiet = { direct: "", channels: "" };
	private conversations = new Map<string, Conversation>();
	private cycles = 0;

	constructor(options: PollerOptions) {
		assertToken("user", options.userToken);
		this.options = options;
		const clock = options.clock ?? systemClock;
		this.clock = clock;
		const bucket = (tier: Tier): TokenBucket =>
			new TokenBucket(options.perMinute?.[tier] ?? TIER_PER_MINUTE[tier], () => clock.now());
		this.buckets = {
			1: bucket(1),
			2: bucket(2),
			3: bucket(3),
			4: bucket(4),
			special: bucket("special"),
		};
	}

	// One call within the budget. A 429 holds that method (Slack scopes it to the method and the
	// workspace) for its Retry-After, at least the backoff step and at most 15 minutes, after which
	// the same request is sent again. A transient failure backs off 1, 2, 4 s.
	async call(method: Method, params: Params = {}): Promise<SlackResponse> {
		const attempts = this.options.maxAttempts ?? 4;
		for (let attempt = 1; ; attempt++) {
			await this.admit(method);
			try {
				return await callSlack(method, this.options.userToken, params, {
					...(this.options.apiBase ? { base: this.options.apiBase } : {}),
					...(this.options.fetch ? { fetch: this.options.fetch } : {}),
					...(this.options.signal ? { signal: this.options.signal } : {}),
					now: () => this.clock.now(),
				});
			} catch (error) {
				if (!(error instanceof SlackError)) throw error;
				const step = 1000 * 2 ** (attempt - 1);
				const limited = error.kind === "rate_limited";
				if (limited) this.holds.set(method, this.clock.now() + retryWait(error, step));
				if (attempt >= attempts || !(limited || error.kind === "transient")) throw error;
				if (!limited) await this.clock.delay(step, this.options.signal);
			}
		}
	}

	private async admit(method: Method): Promise<void> {
		const bucket = this.buckets[METHODS[method].tier];
		for (;;) {
			const held = (this.holds.get(method) ?? 0) - this.clock.now();
			const ms = held > 0 ? held : bucket.take();
			if (ms <= 0) return;
			await this.clock.delay(ms, this.options.signal);
		}
	}

	// The owner's user id, so direction and participation come from the hub's own auth.test.
	async identify(): Promise<string> {
		const { data } = await this.call("auth.test");
		const owner = id(data.user_id);
		if (owner === null) throw new SlackError("auth.test", 200, "malformed");
		this.owner = owner;
		return owner;
	}

	// Returns false when the list was cut off at MAX_PAGES pages.
	async loadConversations(): Promise<boolean> {
		const fresh = new Map<string, Conversation>();
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const params = { types: TYPES, exclude_archived: true, limit: 200, cursor };
			const { data } = await this.call("users.conversations", params);
			for (const raw of list(data.channels)) {
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
				const known = this.conversations.get(key);
				if (known !== undefined) known.type = type;
				fresh.set(key, known ?? { id: key, type, newest: null, activity: null, synced: false });
			}
			cursor = cursorOf(data);
			if (cursor === undefined) break;
		}
		this.conversations = fresh;
		return cursor === undefined;
	}

	// This cycle's order: DMs and MPIMs active within recentMs or never read (newest first), then
	// the next quietPerCycle of the other DMs and MPIMs, then channels active within recentMs, then
	// the next quietPerCycle of the other channels. Quiet ones take turns by id.
	plan(): Conversation[] {
		const since = this.clock.now() - (this.options.recentMs ?? 86_400_000);
		const all = [...this.conversations.values()];
		const direct = all.filter((each) => each.type === "im" || each.type === "mpim");
		const channels = all.filter((each) => each.type === "channel" || each.type === "group");
		const recent = (each: Conversation): boolean =>
			each.activity !== null && each.activity >= since;
		const due = (each: Conversation): boolean => recent(each) || !each.synced;
		return [
			...direct.filter(due).sort(byActivity),
			...this.turn(
				"direct",
				direct.filter((each) => !due(each)),
			),
			...channels.filter(recent).sort(byActivity),
			...this.turn(
				"channels",
				channels.filter((each) => !recent(each)),
			),
		];
	}

	private turn(group: "direct" | "channels", quiet: Conversation[]): Conversation[] {
		const sorted = quiet.sort(byId);
		const start = Math.max(
			0,
			sorted.findIndex((each) => each.id > this.lastQuiet[group]),
		);
		const turn = [...sorted.slice(start), ...sorted.slice(0, start)].slice(
			0,
			this.options.quietPerCycle ?? 5,
		);
		this.lastQuiet[group] = turn.at(-1)?.id ?? this.lastQuiet[group];
		return turn;
	}

	async cycle(): Promise<CycleReport> {
		const report: CycleReport = { history: [], replies: [], messages: 0, failed: 0, truncated: 0 };
		await this.refresh(report);
		const due = new Map<Thread, Due>();
		const seen = new Set<Thread>();
		const read = new Set<Conversation>();
		for (const conversation of this.plan()) {
			report.history.push(conversation.id);
			try {
				if (!(await this.readHistory(conversation, report, due, seen))) report.truncated++;
				read.add(conversation);
			} catch (error) {
				if (fatal(error)) throw error;
				report.failed++;
			}
		}
		// A thread whose parent fell out of the history window shows no reply_count, so only the
		// owner's threads are still read, in the cycles that read their conversation.
		for (const thread of this.threads.values()) {
			if (thread.owner && read.has(thread.conversation) && !seen.has(thread)) {
				due.set(thread, { why: "owner", count: null });
			}
		}
		for (const [thread, { why, count }] of due) {
			report.replies.push({ channel: thread.conversation.id, ts: thread.ts, why });
			try {
				// A thread cut off at MAX_PAGES keeps its old count, so it is read on from there next time.
				if (!(await this.readReplies(thread, report))) report.truncated++;
				else if (count !== null) thread.replyCount = count;
			} catch (error) {
				if (fatal(error)) throw error;
				report.failed++;
			}
		}
		return report;
	}

	// The owner's id once, and the conversation list every refreshEvery cycles. A failure other
	// than auth keeps what is known, counts in the report and is retried on the next cycle.
	private async refresh(report: CycleReport): Promise<void> {
		try {
			if (this.owner === null) await this.identify();
			if (this.cycles % (this.options.refreshEvery ?? 10) === 0) {
				if (!(await this.loadConversations())) report.truncated++;
			}
			this.cycles++;
		} catch (error) {
			if (fatal(error)) throw error;
			report.failed++;
		}
	}

	private emit(conversation: Conversation, ref: MessageRef, report: CycleReport): void {
		const ms = Number(tsKey(ref.ts) / 1_000_000n);
		conversation.activity = Math.max(conversation.activity ?? 0, ms);
		report.messages++;
		try {
			this.options.onMessage(ref);
		} catch {
			// The consumer's failure doesn't stop the cycle.
		}
	}

	// The newest window of top-level messages: new ones are emitted, and each thread parent's
	// reply_count is compared with the count when its replies were last read. Returns false when
	// MAX_PAGES pages didn't reach the newest message of the last read.
	private async readHistory(
		conversation: Conversation,
		report: CycleReport,
		due: Map<Thread, Due>,
		seen: Set<Thread>,
	): Promise<boolean> {
		const known = conversation.newest;
		let newest = known;
		const limit = this.options.historyLimit ?? 100;
		let cursor: string | undefined;
		let complete = false;
		for (let page = 0; page < MAX_PAGES && !complete; page++) {
			const params = { channel: conversation.id, limit, cursor };
			const { data } = await this.call("conversations.history", params);
			let caughtUp = known === null;
			for (const raw of list(data.messages)) {
				const ref = messageRef(conversation.id, conversation.type, raw);
				if (ref === null) continue;
				if (later(ref.ts, known)) {
					this.emit(conversation, ref, report);
					if (later(ref.ts, newest)) newest = ref.ts;
				} else {
					caughtUp = true;
				}
				const count = obj(raw)?.reply_count;
				const thread = this.parent(conversation, ref, obj(raw));
				if (thread === null || typeof count !== "number") continue;
				seen.add(thread);
				if (thread.replyCount !== count) due.set(thread, { why: "reply_count", count });
			}
			cursor = cursorOf(data);
			complete = caughtUp || cursor === undefined || data.has_more !== true;
		}
		conversation.newest = newest;
		conversation.synced = true;
		return complete;
	}

	private parent(conversation: Conversation, ref: MessageRef, raw: Json | null): Thread | null {
		const count = raw?.reply_count;
		if (ref.threadTs !== null || typeof count !== "number" || count < 1) return null;
		const key = `${conversation.id}:${ref.ts}`;
		const thread = this.threads.get(key) ?? {
			conversation,
			ts: ref.ts,
			replyCount: null,
			latest: null,
			owner: false,
		};
		this.threads.set(key, thread);
		const owner = this.owner;
		if (owner !== null && (ref.user === owner || ids(raw?.reply_users).includes(owner))) {
			thread.owner = true;
		}
		return thread;
	}

	// Replies after the newest one read before, in pages of one query: the cursor belongs to the
	// first page's arguments, so `oldest` stays fixed for the whole walk. Returns false when
	// MAX_PAGES pages didn't reach the end of the thread.
	private async readReplies(thread: Thread, report: CycleReport): Promise<boolean> {
		const { conversation } = thread;
		const oldest = thread.latest ?? undefined;
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const { data } = await this.call("conversations.replies", {
				channel: conversation.id,
				ts: thread.ts,
				oldest,
				limit: this.options.historyLimit ?? 100,
				cursor,
			});
			for (const raw of list(data.messages)) {
				const ref = messageRef(conversation.id, conversation.type, raw);
				if (ref === null || ref.threadTs !== thread.ts) continue;
				if (ref.user !== null && ref.user === this.owner) thread.owner = true;
				if (later(ref.ts, thread.latest)) {
					this.emit(conversation, ref, report);
					thread.latest = ref.ts;
				}
			}
			cursor = cursorOf(data);
			if (cursor === undefined) return true;
		}
		return false;
	}
}

// Cycles at least minCycleMs apart until the signal aborts. Only an auth failure rejects (the hub
// then runs its own auth.test, plan §3 Revocation); other failures count in that cycle's report
// and are retried.
export async function runPoller(
	options: PollerOptions & { readonly minCycleMs?: number },
): Promise<void> {
	const poller = new Poller(options);
	const clock = options.clock ?? systemClock;
	try {
		while (!options.signal?.aborted) {
			const started = clock.now();
			await poller.cycle();
			const rest = Math.max(0, (options.minCycleMs ?? 30_000) - (clock.now() - started));
			await clock.delay(rest, options.signal);
		}
	} catch (error) {
		if (!options.signal?.aborted) throw error;
	}
}
