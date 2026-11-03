import type { SyncPage, SyncRequest } from "@draftyak/protocol/channel-v1";
import type { PluginChange } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollConversationListPages } from "../src/catalog.ts";
import { syncSlackAccount } from "../src/legacy-sync.ts";
import { createSlackLegacySyncStore } from "../src/legacy-sync-state.ts";
import { reduceMessagesPage } from "../src/reduce.ts";
import { digestSlackCursor } from "../src/sync-state.ts";
import {
	LEGACY_SYNC_CHANNEL as CHANNEL,
	createLegacySyncFixture,
	type LegacySyncFixture,
	legacySyncConversation,
} from "./helpers/legacy-sync-fake.ts";

const SCOPE = "dytest-legacy-account";
const SINCE = 1_800_000_000_000;
const OLD_ROOT = "1799999900.000000001";
const ROOT = "1800000000.000000001";
const REPLY = "1800000000.000000002";
const NEXT = "1800000001.000000001";
const fixtures: LegacySyncFixture[] = [];
let networkCalls = 0;

function fixture(options?: Parameters<typeof createLegacySyncFixture>[0]): LegacySyncFixture {
	const owned = createLegacySyncFixture(options);
	fixtures.push(owned);
	return owned;
}
function add(f: LegacySyncFixture, ts: string, threadTs?: string): void {
	f.fake.addMessage(CHANNEL, {
		ts,
		user: "UDYTEST1",
		text: `DYTEST ${ts}`,
		...(threadTs === undefined ? {} : { threadTs }),
	});
}
function initial(cursor?: string): SyncRequest {
	return { mode: "initial", since: SINCE, ...(cursor === undefined ? {} : { cursor }) };
}
function messages(changes: readonly PluginChange[]) {
	return changes.filter((change) => change.kind === "chat.message");
}
async function drain(f: LegacySyncFixture, first: SyncRequest) {
	let input = first;
	const pages: SyncPage[] = [];
	for (let step = 0; step < 512; step++) {
		const rpc = f.rpc();
		const before = f.requests.length;
		const page = await syncSlackAccount(rpc.context, SCOPE, input);
		// A returned checkpoint carries DATA into a fresh invocation, never its old live signal.
		rpc.shared.abort();
		expect(f.requests.length - before).toBeLessThanOrEqual(1);
		expect(page.changes.length).toBeLessThanOrEqual(500);
		pages.push(page);
		if (!page.more)
			return { pages, changes: pages.flatMap((item) => item.changes), cursor: page.cursor };
		input = { ...first, cursor: page.cursor };
	}
	throw new Error("DYTEST legacy fixture did not finish");
}

beforeEach(() => {
	networkCalls = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		networkCalls++;
		throw new Error("DYTEST network forbidden");
	});
});
afterEach(async () => {
	try {
		for (const f of fixtures.splice(0).reverse()) {
			await f.close();
			expect(f.unexpected).toEqual([]);
			expect(f.pumpErrors).toEqual([]);
		}
		expect(networkCalls).toBe(0);
	} finally {
		vi.restoreAllMocks();
	}
});

describe("ordinary Slack account sync", () => {
	it("drains real provider work, reads old roots without count shortcuts, and resumes delta honestly", async () => {
		const f = fixture();
		add(f, OLD_ROOT);
		add(f, ROOT); // The kept provider reports zero replies for this root.
		add(f, REPLY, OLD_ROOT);
		f.omitReplyCounts.add(OLD_ROOT); // Explicitly labelled missing-count wire case.
		const start = await drain(f, initial());
		expect(
			messages(start.changes)
				.map((row) => row.ts)
				.sort(),
		).toEqual([ROOT, REPLY].sort());
		expect(start.changes.filter((row) => row.kind === "chat.conversation")).toHaveLength(1);
		expect(start.pages.slice(0, -1).every((page) => page.more)).toBe(true);
		const replies = f.requests
			.map(({ params }) => new URL(params.url))
			.filter((url) => url.pathname === "/api/conversations.replies");
		expect(new Set(replies.map((url) => url.searchParams.get("ts")))).toEqual(
			new Set([ROOT, OLD_ROOT]),
		);
		for (const url of replies) {
			expect(url.searchParams.get("oldest")).toBe("1800000000.000");
			expect(url.searchParams.get("inclusive")).toBe("true");
		}
		const beforeQuiet = f.requests.length;
		const quiet = await drain(f, { mode: "delta", cursor: start.cursor });
		expect(f.requests.length).toBeGreaterThan(beforeQuiet);
		expect(quiet.changes).toEqual([]);
		expect(quiet.cursor).toBe(start.cursor);
		add(f, NEXT, OLD_ROOT);
		const delta = await drain(f, { mode: "delta", cursor: start.cursor });
		expect(messages(delta.changes).map((row) => row.ts)).toEqual([NEXT]);
		expect(delta.cursor).not.toBe(start.cursor);
		const resync = await drain(f, { mode: "resync", since: SINCE });
		expect(
			messages(resync.changes)
				.map((row) => row.ts)
				.sort(),
		).toEqual([ROOT, REPLY, NEXT].sort());
		expect(await drain(f, { mode: "delta", cursor: delta.cursor })).toMatchObject({
			changes: [],
			cursor: delta.cursor,
		});
		const encoded = JSON.stringify([...f.values.values()]);
		expect(encoded).not.toContain("DYTEST 1800000000");
		expect(encoded).not.toContain('"text"');
	});

	it("continues real history pagination and queries all 101 roots before terminal completion", async () => {
		const f = fixture();
		for (let at = 1; at <= 101; at++) add(f, `1800000000.${String(at).padStart(9, "0")}`);
		const result = await drain(f, initial());
		expect(messages(result.changes)).toHaveLength(101);
		expect(new Set(messages(result.changes).map((row) => row.ts)).size).toBe(101);
		const urls = f.requests.map(({ params }) => new URL(params.url));
		expect(urls.filter((url) => url.pathname === "/api/conversations.history")).toHaveLength(2);
		expect(urls.filter((url) => url.pathname === "/api/conversations.replies")).toHaveLength(101);
		expect(result.pages.at(-1)?.more).toBe(false);
	});

	it("returns an honest terminal cursor for an empty account and keeps a quiet delta stable", async () => {
		const f = fixture({ conversations: [] });
		const start = await drain(f, initial());
		expect(start.changes).toEqual([]);
		expect(start.pages).toHaveLength(1);
		const delta = await drain(f, { mode: "delta", cursor: start.cursor });
		expect(delta.changes).toEqual([]);
		expect(delta.cursor).toBe(start.cursor);
		expect(f.requests).toHaveLength(2);
	});

	it("binds initial continuation to its original since, mode and scope without restarting", async () => {
		const f = fixture();
		const page = await syncSlackAccount(f.rpc().context, SCOPE, initial());
		expect(page.more).toBe(true);
		const before = f.requests.length;
		for (const args of [
			{ mode: "initial", since: SINCE + 1, cursor: page.cursor },
			{ mode: "resync", since: SINCE, cursor: page.cursor },
			{ mode: "delta", cursor: page.cursor },
		] as const)
			await expect(syncSlackAccount(f.rpc().context, SCOPE, args)).rejects.toMatchObject({
				result: { code: "TRANSIENT" },
			});
		await expect(
			syncSlackAccount(f.rpc().context, "dytest-other", initial(page.cursor)),
		).rejects.toThrow();
		expect(f.requests).toHaveLength(before);
		const saved = [...f.values];
		f.values.clear();
		await expect(syncSlackAccount(f.rpc().context, SCOPE, initial(page.cursor))).rejects.toThrow();
		expect(f.requests).toHaveLength(before);
		for (const [key, value] of saved) f.values.set(key, value);
		const continued = await syncSlackAccount(f.rpc().context, SCOPE, initial(page.cursor));
		expect(continued.changes[0]?.kind).toBe("chat.conversation");
	});

	it("captures the ordinary request before a genuine SDK body await", async () => {
		const f = fixture();
		const args = { mode: "initial", since: SINCE } as const;
		const mutable = { ...args } as { mode: "initial"; since: number };
		const gate = f.gateNextBody();
		const rpc = f.rpc();
		const pending = syncSlackAccount(rpc.context, SCOPE, mutable);
		void pending.catch(() => undefined);
		try {
			await gate.entered;
			mutable.since = 0;
			gate.release();
			const page = await pending;
			const state = await createSlackLegacySyncStore(f.rpc().context, SCOPE).load(
				page.cursor,
				args,
			);
			expect(state.since).toBe(SINCE);
		} finally {
			gate.release();
			await pending.catch(() => undefined);
		}
	});

	it.each([{ stage: "body" }, { stage: "cleanup" }] as const)(
		"refuses cancellation during real $stage without publishing a continuation",
		async ({ stage }) => {
			const f = fixture();
			const gate = stage === "body" ? f.gateNextBody() : f.gateNextCleanup();
			const rpc = f.rpc();
			const pending = syncSlackAccount(rpc.context, SCOPE, initial());
			void pending.catch(() => undefined);
			try {
				await gate.entered;
				if (stage === "cleanup") expect(f.requests.at(-1)?.signal?.aborted).toBe(true);
				rpc.shared.abort();
				gate.release();
				await expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
				expect(f.values.size).toBe(0);
				expect(f.requests).toHaveLength(1);
			} finally {
				gate.release();
				await pending.catch(() => undefined);
			}
		},
	);

	it("retains genuine provider cursor expiry instead of resetting initial work", async () => {
		const f = fixture({
			conversations: Array.from({ length: 101 }, (_, at) => legacySyncConversation(`CDYTEST${at}`)),
		});
		const first = await syncSlackAccount(f.rpc().context, SCOPE, initial());
		const store = createSlackLegacySyncStore(f.rpc().context, SCOPE);
		const state = await store.load(first.cursor, initial(first.cursor));
		const resumed = state.work.find((work) => work.kind === "conversations" && work.cursor);
		if (!resumed) throw new Error("DYTEST genuine discovery continuation absent");
		const cursor = await store.save({ ...state, work: [resumed] });
		f.fake.clock.advance(60_000);
		const before = f.requests.length;
		await expect(syncSlackAccount(f.rpc().context, SCOPE, initial(cursor))).rejects.toMatchObject({
			result: { code: "CURSOR_EXPIRED" },
		});
		expect(f.requests).toHaveLength(before + 1);
		expect(new URL(f.requests.at(-1)?.params.url ?? "").searchParams.has("cursor")).toBe(true);
	});

	it.each([{ ts: ROOT }, { ts: REPLY }])(
		"refuses contradictory root routing for returned $ts without advancing its checkpoint",
		async ({ ts }) => {
			const f = fixture();
			add(f, ROOT);
			add(f, REPLY, ROOT);
			const other = "1799999999.000000001";
			expect(
				reduceMessagesPage(CHANNEL, {
					ok: true,
					messages: [{ type: "message", ts, user: "UDYTEST1", text: "DYTEST", thread_ts: other }],
					has_more: false,
				}).changes[0],
			).toMatchObject({ ts, threadTs: other });
			f.replyThreadOverrides.set(ts, other);
			const cursor = await createSlackLegacySyncStore(f.rpc().context, SCOPE).save({
				mode: "initial",
				since: SINCE,
				work: [{ kind: "replies", channelId: CHANNEL, threadTs: ROOT, seen: [] }],
				snapshot: [],
			});
			const before = [...f.values];
			await expect(syncSlackAccount(f.rpc().context, SCOPE, initial(cursor))).rejects.toMatchObject(
				{
					result: { code: "TRANSIENT" },
				},
			);
			expect([...f.values]).toEqual(before);
			expect(f.requests).toHaveLength(1);
		},
	);

	it("rejects cancellation after genuine KV writes and leaves the old cursor usable", async () => {
		const f = fixture();
		const first = await syncSlackAccount(f.rpc().context, SCOPE, initial());
		const rpc = f.rpc();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = rpc.context.kv;
		const kv = Object.freeze({
			...original,
			async set(...args: Parameters<typeof original.set>) {
				const result = await Reflect.apply(original.set, original, args);
				entered.resolve();
				await release.promise;
				return result;
			},
		});
		const pending = syncSlackAccount({ ...rpc.context, kv }, SCOPE, initial(first.cursor));
		void pending.catch(() => undefined);
		try {
			await entered.promise;
			rpc.shared.abort();
			release.resolve();
			await expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			const retried = await syncSlackAccount(f.rpc().context, SCOPE, initial(first.cursor));
			expect(retried.changes[0]?.kind).toBe("chat.conversation");
			// Unpublished immutable writes can remain; no rollback or transaction is claimed.
			expect(f.values.size).toBeGreaterThan(0);
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("refuses a genuinely returned cursor consumed in a previous RPC before any new checkpoint", async () => {
		const f = fixture({
			conversations: Array.from({ length: 201 }, (_, at) => legacySyncConversation(`CDYTEST${at}`)),
		});
		const iterator = pollConversationListPages(f.rpc().context, { maxPages: 2 });
		const a = await iterator.next();
		const b = await iterator.next();
		await iterator.return(undefined);
		if (a.done || b.done || !a.value.nextCursor || !b.value.nextCursor)
			throw new Error("DYTEST genuine cursor pair absent");
		const store = createSlackLegacySyncStore(f.rpc().context, SCOPE);
		const cursor = await store.save({
			mode: "initial",
			since: SINCE,
			work: [
				{
					kind: "conversations",
					cursor: a.value.nextCursor,
					seen: [digestSlackCursor(b.value.nextCursor)],
				},
			],
			snapshot: [],
		});
		const before = [...f.values];
		await expect(syncSlackAccount(f.rpc().context, SCOPE, initial(cursor))).rejects.toThrow();
		expect([...f.values]).toEqual(before);
	});

	it("refuses getters, proxies and malformed ordinary input before any host work", () => {
		const f = fixture();
		let hooks = 0;
		const accessor = Object.defineProperty({}, "mode", {
			enumerable: true,
			get() {
				hooks++;
				return "initial";
			},
		});
		const proxy = new Proxy(initial(), {
			getOwnPropertyDescriptor() {
				hooks++;
				throw new Error("DYTEST hook");
			},
		});
		for (const args of [
			accessor,
			proxy,
			{},
			{ mode: "delta" },
			{ mode: "initial", since: -1 },
			{ ...initial(), selected: true },
		])
			expect(() => syncSlackAccount(f.rpc().context, SCOPE, args as SyncRequest)).toThrow(
				"INVALID_INPUT",
			);
		expect(hooks).toBe(0);
		expect(f.requests).toHaveLength(0);
		expect(f.kvRequests).toHaveLength(0);
	});
});
