import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Clock, MAX_RETRY_AFTER_MS, SlackError } from "../src/api.ts";
import {
	type CycleReport,
	MAX_PAGES,
	Poller,
	type PollerOptions,
	runPoller,
	TokenBucket,
} from "../src/poller.ts";
import type { MessageRef } from "../src/reduce.ts";
import {
	type FakeConversation,
	type FakeMessage,
	FakeSlack,
	fakeToken,
	OWNER,
} from "./fake-slack.ts";

const CANARY = "canary-text-9d2e";
const START = Date.UTC(2026, 9, 17, 12);
const OTHER = "U0OTHER01";
const THIRD = "U0THIRD01";

// A virtual clock: delays advance it at once and are recorded.
function virtualClock(): Clock & { readonly waits: number[] } {
	const waits: number[] = [];
	let now = START;
	return {
		waits,
		now: () => now,
		delay: async (ms, signal) => {
			signal?.throwIfAborted();
			waits.push(ms);
			now += ms;
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

// A Slack timestamp `seconds` before the clock's start.
const ago = (seconds: number, micro = 100): string =>
	`${Math.floor(START / 1000) - seconds}.${String(micro).padStart(6, "0")}`;

const message = (ts: string, user = OTHER, replies?: FakeMessage[]): FakeMessage => ({
	ts,
	user,
	text: `${CANARY} ${ts}`,
	...(replies ? { replies } : {}),
});

let fake: FakeSlack;
let clock: ReturnType<typeof virtualClock>;
let refs: MessageRef[];
let log: { method: string; params: URLSearchParams; at: number }[];

beforeEach(async () => {
	fake = await new FakeSlack().start();
	clock = virtualClock();
	refs = [];
	log = [];
});

afterEach(async () => {
	await fake.close();
});

function poller(overrides: Partial<PollerOptions> = {}): Poller {
	return new Poller({
		userToken: fake.userToken,
		apiBase: fake.apiBase,
		clock,
		onMessage: (ref) => refs.push(ref),
		fetch: (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input);
			log.push({ method: url.pathname.slice(5), params: url.searchParams, at: clock.now() });
			return globalThis.fetch(input, init);
		},
		...overrides,
	});
}

const add = (...conversations: FakeConversation[]): void => {
	fake.conversations.push(...conversations);
};
const historyOrder = (): string[] =>
	log
		.filter((entry) => entry.method === "conversations.history")
		.map((entry) => entry.params.get("channel") ?? "");

describe("the poller", () => {
	it("reads DMs and MPIMs first, then recently active channels, then the rest in turn", async () => {
		add(
			{ id: "D0DM00001", type: "im", messages: [message(ago(3600))] },
			{ id: "D0DM00002", type: "im", messages: [message(ago(300))] },
			{ id: "G0MPIM001", type: "mpim", messages: [message(ago(2 * 86_400))] },
			{ id: "C0CHAN001", type: "channel", messages: [message(ago(3600))] },
			{ id: "C0CHAN002", type: "channel", messages: [message(ago(10 * 86_400))] },
			{ id: "C0CHAN003", type: "channel", messages: [] },
			{ id: "C0CHAN004", type: "channel", messages: [message(ago(3 * 86_400))] },
			{ id: "G0GROUP01", type: "group", messages: [message(ago(7200))] },
		);
		const cycles: string[][] = [];
		const subject = poller({ quietPerCycle: 2 });
		for (let index = 0; index < 4; index++) cycles.push((await subject.cycle()).history);
		const direct = ["D0DM00002", "D0DM00001", "G0MPIM001"];
		expect(cycles).toEqual([
			["D0DM00001", "D0DM00002", "G0MPIM001", "C0CHAN001", "C0CHAN002"],
			[...direct, "C0CHAN001", "C0CHAN003", "C0CHAN004"],
			[...direct, "C0CHAN001", "G0GROUP01", "C0CHAN002"],
			[...direct, "C0CHAN001", "G0GROUP01", "C0CHAN003", "C0CHAN004"],
		]);
		expect(historyOrder()).toEqual(cycles.flat());
		const [list] = fake.calls("users.conversations");
		expect(list?.params).toMatchObject({
			types: "im,mpim,public_channel,private_channel",
			exclude_archived: "true",
		});
		expect(fake.calls("auth.test")).toHaveLength(1);
		expect(subject.owner).toBe(OWNER);
	});

	it("reads replies only for threads whose reply_count changed or where the owner took part", async () => {
		const quiet = message(ago(400), OTHER, [message(ago(390), OTHER)]);
		const growing = message(ago(300), OTHER, [message(ago(290), THIRD)]);
		const ownParent = message(ago(200), OWNER, [message(ago(190), OTHER)]);
		const ownReply = message(ago(500), OTHER, [message(ago(490), OWNER)]);
		const channel: FakeConversation = {
			id: "C0CHAN001",
			type: "channel",
			messages: [ownReply, quiet, growing, ownParent],
		};
		add(channel);
		const subject = poller({ historyLimit: 4 });
		const first = await subject.cycle();
		expect(first.replies.map(({ ts, why }) => [ts, why])).toEqual([
			[ownParent.ts, "reply_count"],
			[growing.ts, "reply_count"],
			[quiet.ts, "reply_count"],
			[ownReply.ts, "reply_count"],
		]);
		expect(refs.filter((ref) => ref.threadTs !== null)).toHaveLength(4);

		// One more reply in `growing`; a new top-level message pushes `ownReply` out of the window.
		growing.replies?.push(message(ago(100), OTHER));
		channel.messages.push(message(ago(50)));
		refs.length = 0;
		const repliesBefore = fake.calls("conversations.replies").length;
		const second = await subject.cycle();
		expect(second.replies).toEqual([
			{ channel: "C0CHAN001", ts: growing.ts, why: "reply_count" },
			{ channel: "C0CHAN001", ts: ownReply.ts, why: "owner" },
		]);
		const reads = fake.calls("conversations.replies").slice(repliesBefore);
		expect(reads.map((read) => [read.params.ts, read.params.oldest])).toEqual([
			[growing.ts, ago(290)],
			[ownReply.ts, ago(490)],
		]);
		expect(refs.map((ref) => [ref.ts, ref.threadTs])).toEqual([
			[ago(50), null],
			[ago(100), growing.ts],
		]);

		// Nothing changed: the owner's thread outside the window is the only one read.
		refs.length = 0;
		const third = await subject.cycle();
		expect(third.replies.map(({ ts, why }) => [ts, why])).toEqual([[ownReply.ts, "owner"]]);
		expect(refs).toEqual([]);
	});

	it("re-reads an owner's thread only in the cycles that read its conversation", async () => {
		const days = 3 * 86_400;
		for (let index = 1; index <= 5; index++) {
			const own = message(ago(days), OWNER, [message(ago(days - 60))]);
			add({
				id: `C0CHAN00${index}`,
				type: "channel",
				messages: [index === 5 ? own : message(ago(days))],
			});
		}
		const subject = poller({ quietPerCycle: 1 });
		const reports: CycleReport[] = [];
		for (let index = 0; index < 7; index++) reports.push(await subject.cycle());
		expect(reports.map((report) => report.history)).toEqual(
			[1, 2, 3, 4, 5, 1, 2].map((index) => [`C0CHAN00${index}`]),
		);
		expect(reports.map((report) => report.replies.map(({ why }) => why))).toEqual([
			[],
			[],
			[],
			[],
			["reply_count"],
			[],
			[],
		]);
	});

	it("reads a thread longer than a page as one query, so no reply is skipped", async () => {
		const replies = Array.from({ length: 250 }, (_, index) => message(ago(5000 - index)));
		const parent = message(ago(6000), OTHER, replies);
		add({ id: "C0CHAN001", type: "channel", messages: [parent] });
		const subject = poller();
		await subject.cycle();
		const reads = (): (string | null)[][] =>
			fake
				.calls("conversations.replies")
				.map((read) => [read.params.oldest ?? null, read.params.cursor ? "cursor" : null]);
		expect(reads()).toEqual([
			[null, null],
			[null, "cursor"],
			[null, "cursor"],
		]);
		expect(refs.filter((ref) => ref.threadTs === parent.ts)).toHaveLength(250);
		replies.push(message(ago(100)));
		const second = await subject.cycle();
		expect(second.replies).toEqual([{ channel: "C0CHAN001", ts: parent.ts, why: "reply_count" }]);
		expect(reads().at(-1)).toEqual([ago(4751), null]);
		expect(refs.filter((ref) => ref.threadTs === parent.ts)).toHaveLength(251);
	});

	it("reports reads cut off at 10 pages, and reads a cut-off thread on from there", async () => {
		const many = (count: number, from: number): FakeMessage[] =>
			Array.from({ length: count }, (_, index) => message(ago(from - index)));
		const channel: FakeConversation = {
			id: "C0CHAN001",
			type: "channel",
			messages: [message(ago(9000), OTHER, many(25, 8000))],
		};
		add(channel);
		const subject = poller({ historyLimit: 2 });
		const replies = (): number => refs.filter((ref) => ref.threadTs !== null).length;
		// Pages of two: the parent and 19 replies fit in 10 pages, the other 6 replies don't.
		expect(await subject.cycle()).toMatchObject({ truncated: 1, failed: 0 });
		expect(replies()).toBe(2 * MAX_PAGES - 1);
		const second = await subject.cycle();
		expect(second).toMatchObject({ truncated: 0, replies: [{ why: "reply_count" }] });
		expect(replies()).toBe(25);
		expect(await subject.cycle()).toMatchObject({ truncated: 0, replies: [] });

		// 25 new messages: the window reads the newest 20 and stops.
		channel.messages.push(...many(25, 7000));
		expect(await subject.cycle()).toMatchObject({ truncated: 1, messages: 2 * MAX_PAGES });

		// More conversations than 10 pages of 200 hold.
		fake.conversations.length = 0;
		add(
			...Array.from({ length: 200 * MAX_PAGES + 1 }, (_, index) => ({
				id: `C0LIST${String(index).padStart(5, "0")}`,
				type: "channel" as const,
				messages: [],
			})),
		);
		expect(await poller().cycle()).toMatchObject({ truncated: 1, failed: 0 });
	});

	it("follows a channel converted to private: its messages carry the new type", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		const subject = poller({ refreshEvery: 1 });
		await subject.cycle();
		fake.conversations[0] = {
			id: "C0CHAN001",
			type: "group",
			messages: [message(ago(60)), message(ago(30))],
		};
		await subject.cycle();
		expect(refs.map((ref) => [ref.ts, ref.channelType])).toEqual([
			[ago(60), "channel"],
			[ago(30), "group"],
		]);
	});

	it("reads quiet DMs and MPIMs in turn once each has been read, and a new one at once", async () => {
		add(
			{ id: "D0DM00001", type: "im", messages: [message(ago(300))] },
			{ id: "D0DM00002", type: "im", messages: [message(ago(3 * 86_400))] },
			{ id: "D0DM00003", type: "im", messages: [] },
			{ id: "G0MPIM001", type: "mpim", messages: [message(ago(5 * 86_400))] },
		);
		const subject = poller({ quietPerCycle: 1, refreshEvery: 1 });
		const cycles: string[][] = [];
		for (let index = 0; index < 4; index++) cycles.push((await subject.cycle()).history);
		add({ id: "D0DM00004", type: "im", messages: [message(ago(9 * 86_400))] });
		for (let index = 0; index < 2; index++) cycles.push((await subject.cycle()).history);
		expect(cycles).toEqual([
			["D0DM00001", "D0DM00002", "D0DM00003", "G0MPIM001"],
			["D0DM00001", "D0DM00002"],
			["D0DM00001", "D0DM00003"],
			["D0DM00001", "G0MPIM001"],
			["D0DM00001", "D0DM00004", "D0DM00002"],
			["D0DM00001", "D0DM00003"],
		]);
	});

	it("honours Retry-After: the method waits, then the same request is sent again", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		const subject = poller();
		await subject.identify();
		fake.rateLimit("conversations.history", 1, "30");
		const { data } = await subject.call("conversations.history", { channel: "C0CHAN001" });
		expect(data.messages).toHaveLength(1);
		const calls = log.filter((entry) => entry.method === "conversations.history");
		expect(calls.map((entry) => entry.params.get("channel"))).toEqual(["C0CHAN001", "C0CHAN001"]);
		expect((calls[1]?.at ?? 0) - (calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(30_000);
		expect(clock.waits).toEqual([30_000]);
	});

	it("holds only the rate-limited method, and reads Retry-After as seconds or an HTTP-date", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		const subject = poller({ maxAttempts: 1 });
		fake.rateLimit("conversations.history", 1, "20");
		const limited = await subject
			.call("conversations.history", { channel: "C0CHAN001" })
			.catch((e) => e);
		expect(limited).toBeInstanceOf(SlackError);
		expect(limited).toMatchObject({ kind: "rate_limited", retryAfterMs: 20_000 });
		await subject.call("auth.test");
		expect(clock.waits).toEqual([]);
		await subject.call("conversations.history", { channel: "C0CHAN001" });
		expect(clock.waits).toEqual([20_000]);

		fake.rateLimit("conversations.history", 1, new Date(clock.now() + 45_000).toUTCString());
		await subject.call("conversations.history", { channel: "C0CHAN001" }).catch(() => undefined);
		fake.rateLimit("conversations.history", 1, null);
		await subject.call("conversations.history", { channel: "C0CHAN001" }).catch(() => undefined);
		await subject.call("conversations.history", { channel: "C0CHAN001" });
		expect(clock.waits).toEqual([20_000, 45_000, 60_000]);
	});

	it("holds a method at least its backoff step and at most 15 minutes, whatever Retry-After says", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		const subject = poller();
		fake.rateLimit("conversations.history", 1, "0");
		fake.rateLimit("conversations.history", 1, new Date(clock.now() - 5000).toUTCString());
		fake.rateLimit("conversations.history", 1, "999999999");
		await subject.call("conversations.history", { channel: "C0CHAN001" });
		expect(clock.waits).toEqual([1000, 2000, MAX_RETRY_AFTER_MS]);
	});

	it("backs off 1 s, then 2 s, while a read fails transiently, then sends it again", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		const subject = poller();
		fake.fail("conversations.history", 2, "service_unavailable", 503);
		const { data } = await subject.call("conversations.history", { channel: "C0CHAN001" });
		expect(data.messages).toHaveLength(1);
		expect(clock.waits).toEqual([1000, 2000]);
		expect(fake.calls("conversations.history")).toHaveLength(3);
	});

	it("keeps one token bucket per tier", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [] });
		const subject = poller();
		for (let index = 0; index < 12; index++) {
			await subject.call("conversations.history", { channel: "C0CHAN001" });
		}
		// Tier 3: a burst of 5, then one call per 1.2 s (50 a minute).
		expect(clock.waits).toEqual(Array(7).fill(1200));
		const times = log.map((entry) => entry.at - START);
		expect(times).toEqual([0, 0, 0, 0, 0, 1200, 2400, 3600, 4800, 6000, 7200, 8400]);
		// auth.test has a bucket of its own.
		await subject.call("auth.test");
		expect(clock.waits).toHaveLength(7);

		let now = 0;
		const tier1 = new TokenBucket(1, () => now);
		expect([tier1.burst, tier1.take(), tier1.take()]).toEqual([1, 0, 60_000]);
		const tier4 = new TokenBucket(100, () => now);
		expect(Array.from({ length: 11 }, () => tier4.take())).toEqual([...Array(10).fill(0), 600]);
		now += 600;
		expect(tier4.take()).toBe(0);
	});

	it("stops on an auth failure but carries on past a failed conversation", async () => {
		add(
			{ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] },
			{ id: "C0CHAN002", type: "channel", messages: [message(ago(30))] },
		);
		fake.fail("conversations.history", 1, "channel_not_found");
		const subject = poller();
		const report = await subject.cycle();
		expect(report).toMatchObject({ history: ["C0CHAN001", "C0CHAN002"], failed: 1, messages: 1 });
		fake.fail("conversations.history", 1, "token_revoked");
		await expect(subject.cycle()).rejects.toMatchObject({ kind: "auth", code: "token_revoked" });
		fake.fail("auth.test", 1, "invalid_auth");
		await expect(poller().cycle()).rejects.toMatchObject({ kind: "auth", code: "invalid_auth" });
	});

	it("rides out a failing auth.test or conversation list: the cycle counts it, the next retries", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		fake.fail("auth.test", 4, "service_unavailable", 503);
		const subject = poller();
		expect(await subject.cycle()).toMatchObject({ history: [], failed: 1 });
		expect(clock.waits).toEqual([1000, 2000, 4000]);
		fake.fail("users.conversations", 4, "internal_error", 500);
		expect(await subject.cycle()).toMatchObject({ history: [], failed: 1 });
		const third = await subject.cycle();
		expect(third).toMatchObject({ history: ["C0CHAN001"], failed: 0, messages: 1 });
		const counts = (): number[] =>
			["auth.test", "users.conversations"].map((method) => fake.calls(method).length);
		expect(counts()).toEqual([5, 5]);

		// runPoller keeps cycling through them until it is aborted.
		fake.fail("auth.test", 4, "service_unavailable", 503);
		fake.fail("users.conversations", 4, "service_unavailable", 503);
		const controller = new AbortController();
		let reads = 0;
		await runPoller({
			userToken: fake.userToken,
			apiBase: fake.apiBase,
			clock,
			onMessage: () => {},
			signal: controller.signal,
			fetch: (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes("conversations.history") && ++reads === 1) controller.abort();
				return globalThis.fetch(input, init);
			},
		});
		expect(reads).toBe(1);
		expect(counts()).toEqual([10, 10]);
	});

	it("uses only the owner's user token, and sends only GETs with documented arguments for reads", async () => {
		for (const userToken of [fakeToken("xapp"), fakeToken("xoxb"), ""]) {
			expect(() => poller({ userToken })).toThrow("expected a user token");
		}
		add({ id: "D0DM00001", type: "im", messages: [message(ago(60), OTHER, [message(ago(30))])] });
		const report = await poller().cycle();
		expect(report).toMatchObject({ failed: 0, messages: 2, truncated: 0 });
		expect(refs).toHaveLength(2);
		for (const request of fake.requests) {
			expect(request.verb).toBe(request.method === "auth.test" ? "POST" : "GET");
			expect(request.params).not.toHaveProperty("token");
		}
		expect(JSON.stringify(refs)).not.toContain(CANARY);
		expect(refs.map((ref) => Object.keys(ref).sort())).toEqual(
			refs.map(() => ["change", "channel", "channelType", "subtype", "threadTs", "ts", "user"]),
		);
	});

	it("cycles at least minCycleMs apart until aborted, and rejects on an auth failure", async () => {
		add({ id: "C0CHAN001", type: "channel", messages: [message(ago(60))] });
		const controller = new AbortController();
		let cycles = 0;
		const options = {
			userToken: fake.userToken,
			apiBase: fake.apiBase,
			clock,
			minCycleMs: 30_000,
			onMessage: () => {},
		};
		await runPoller({
			...options,
			signal: controller.signal,
			fetch: (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.includes("conversations.history") && ++cycles === 3) controller.abort();
				return globalThis.fetch(input, init);
			},
		});
		expect(cycles).toBe(3);
		expect(clock.waits).toEqual([30_000, 30_000]);
		fake.fail("auth.test", 1, "invalid_auth");
		await expect(runPoller(options)).rejects.toMatchObject({ kind: "auth" });
	});
});
