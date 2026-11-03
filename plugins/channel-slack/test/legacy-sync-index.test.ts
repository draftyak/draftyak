import type { SyncPage, SyncRequest } from "@draftyak/protocol/channel-v1";
import type { PluginContext } from "@draftyak/sdk/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSlackMessageBody } from "../src/body.ts";
import { syncSlackAccount } from "../src/legacy-sync.ts";
import { createSlackLegacySyncStore, type SlackLegacyWork } from "../src/legacy-sync-state.ts";
import { createSlackThreadIndex } from "../src/thread-index.ts";
import {
	LEGACY_SYNC_CHANNEL as CHANNEL,
	createLegacySyncFixture,
	type LegacySyncFixture,
} from "./helpers/legacy-sync-fake.ts";

const SCOPE = "dytest-legacy-index";
const SINCE = 1_800_000_000_000;
const OLD_ROOT = "1799999900.000000001";
const ROOT = "1800000000.000000001";
const REPLY = "1800000000.000000002";
const THREAD_PREFIX = "slack:thread:v1:";
const fixtures: LegacySyncFixture[] = [];
let networkCalls = 0;

function fixture(): LegacySyncFixture {
	const owned = createLegacySyncFixture();
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
function message(ts: string) {
	return { kind: "chat" as const, channelId: CHANNEL, ts };
}
function checkpointValues(f: LegacySyncFixture) {
	return [...f.values].filter(([key]) => !key.startsWith(THREAD_PREFIX));
}
async function cursorFor(f: LegacySyncFixture, work: SlackLegacyWork): Promise<string> {
	return createSlackLegacySyncStore(f.rpc().context, SCOPE).save({
		mode: "initial",
		since: SINCE,
		work: [work],
		snapshot: [],
	});
}
async function drain(f: LegacySyncFixture, first: SyncRequest) {
	let input = first;
	const pages: SyncPage[] = [];
	for (let step = 0; step < 32; step++) {
		const rpc = f.rpc();
		const page = await syncSlackAccount(rpc.context, SCOPE, input);
		rpc.shared.abort();
		pages.push(page);
		if (!page.more)
			return { cursor: page.cursor, changes: pages.flatMap((entry) => entry.changes) };
		input = { ...first, cursor: page.cursor };
	}
	throw new Error("DYTEST index fixture did not finish");
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

describe("ordinary sync thread-index integration", () => {
	it("indexes older validated history context before filtering or checkpoint acknowledgement", async () => {
		const f = fixture();
		add(f, OLD_ROOT);
		const cursor = await cursorFor(f, { kind: "history", channelId: CHANNEL, seen: [] });
		const before = f.kvRequests.length;
		const page = await syncSlackAccount(f.rpc().context, SCOPE, initial(cursor));
		expect(page.changes).toEqual([]);
		expect(page.more).toBe(true);
		const writes = f.kvRequests.slice(before).filter(({ method }) => method === "host/kv.set");
		expect(writes[0]?.key.startsWith(THREAD_PREFIX)).toBe(true);
		expect(writes.slice(1).some(({ key }) => !key.startsWith(THREAD_PREFIX))).toBe(true);
		expect(await createSlackThreadIndex(f.rpc().context, SCOPE).find(message(OLD_ROOT))).toEqual({
			channelId: CHANNEL,
			ts: OLD_ROOT,
			threadTs: OLD_ROOT,
		});
	});

	it("routes a newly observed reply under its older root in a fresh body RPC", async () => {
		const f = fixture();
		add(f, OLD_ROOT);
		add(f, REPLY, OLD_ROOT);
		const synced = await drain(f, initial());
		expect(
			synced.changes.filter((row) => row.kind === "chat.message").map((row) => row.ts),
		).toEqual([REPLY]);
		const rpc = f.rpc();
		const index = createSlackThreadIndex(rpc.context, SCOPE);
		const observed = await index.find(message(REPLY));
		expect(observed).toEqual({ channelId: CHANNEL, ts: REPLY, threadTs: OLD_ROOT });
		const before = f.requests.length;
		expect(await fetchSlackMessageBody(rpc.context, message(REPLY), observed)).toMatchObject({
			kind: "chat.message",
			ts: REPLY,
			threadTs: OLD_ROOT,
		});
		const url = new URL(f.requests[before]?.params.url ?? "");
		expect(url.pathname).toBe("/api/conversations.replies");
		expect(url.searchParams.get("ts")).toBe(OLD_ROOT);
		expect(
			await createSlackThreadIndex(f.rpc().context, "dytest-other-scope").find(message(REPLY)),
		).toBeUndefined();
	});

	it("repairs lost thread cells on a quiet delta even when fingerprints suppress every change", async () => {
		const f = fixture();
		add(f, OLD_ROOT);
		add(f, REPLY, OLD_ROOT);
		const start = await drain(f, initial());
		let removed = 0;
		for (const key of f.values.keys()) {
			if (!key.startsWith(THREAD_PREFIX)) continue;
			f.values.delete(key);
			removed++;
		}
		expect(removed).toBe(2);
		expect(
			await createSlackThreadIndex(f.rpc().context, SCOPE).find(message(REPLY)),
		).toBeUndefined();
		const quiet = await drain(f, { mode: "delta", cursor: start.cursor });
		expect(quiet.changes).toEqual([]);
		expect(quiet.cursor).toBe(start.cursor);
		const index = createSlackThreadIndex(f.rpc().context, SCOPE);
		expect(await index.find(message(REPLY))).toEqual({
			channelId: CHANNEL,
			ts: REPLY,
			threadTs: OLD_ROOT,
		});
		expect(await index.find(message(OLD_ROOT))).toEqual({
			channelId: CHANNEL,
			ts: OLD_ROOT,
			threadTs: OLD_ROOT,
		});
	});

	it("refuses an index write failure without acknowledging a new checkpoint", async () => {
		const f = fixture();
		add(f, ROOT);
		add(f, REPLY);
		const cursor = await cursorFor(f, { kind: "history", channelId: CHANNEL, seen: [] });
		const before = checkpointValues(f);
		const rpc = f.rpc();
		const original = rpc.context.kv;
		let indexWrites = 0;
		const kv: PluginContext["kv"] = {
			...original,
			async set(key, value) {
				if (key.startsWith(THREAD_PREFIX) && ++indexWrites === 2)
					throw new Error("DYTEST index storage unavailable");
				return Reflect.apply(original.set, original, [key, value]);
			},
		};
		await expect(
			syncSlackAccount({ ...rpc.context, kv }, SCOPE, initial(cursor)),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(indexWrites).toBe(2);
		expect([...f.values.keys()].filter((key) => key.startsWith(THREAD_PREFIX))).toHaveLength(1);
		expect(checkpointValues(f)).toEqual(before);
		const retried = await syncSlackAccount(f.rpc().context, SCOPE, initial(cursor));
		expect(retried.changes).toHaveLength(2);
		expect(retried.more).toBe(true);
	});

	it("refuses cancellation while an index write settles and leaves the prior cursor resumable", async () => {
		const f = fixture();
		add(f, ROOT);
		const cursor = await cursorFor(f, { kind: "history", channelId: CHANNEL, seen: [] });
		const before = checkpointValues(f);
		const rpc = f.rpc();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = rpc.context.kv;
		const kv: PluginContext["kv"] = {
			...original,
			async set(key, value) {
				const result = await Reflect.apply(original.set, original, [key, value]);
				if (key.startsWith(THREAD_PREFIX)) {
					entered.resolve();
					await release.promise;
				}
				return result;
			},
		};
		const pending = syncSlackAccount({ ...rpc.context, kv }, SCOPE, initial(cursor));
		void pending.catch(() => undefined);
		try {
			await entered.promise;
			rpc.shared.abort();
			release.resolve();
			await expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			expect(checkpointValues(f)).toEqual(before);
			expect(await createSlackThreadIndex(f.rpc().context, SCOPE).find(message(ROOT))).toEqual({
				channelId: CHANNEL,
				ts: ROOT,
				threadTs: ROOT,
			});
			expect(await syncSlackAccount(f.rpc().context, SCOPE, initial(cursor))).toMatchObject({
				more: true,
			});
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
		}
	});

	it("captures the current RPC's KV receiver and signal when resuming a prior checkpoint", async () => {
		const old = fixture();
		add(old, ROOT);
		add(old, REPLY, ROOT);
		const start = await cursorFor(old, { kind: "history", channelId: CHANNEL, seen: [] });
		const previousRpc = old.rpc();
		const first = await syncSlackAccount(previousRpc.context, SCOPE, initial(start));
		previousRpc.shared.abort();
		const oldCalls = old.kvRequests.length;
		const current = fixture();
		add(current, ROOT);
		add(current, REPLY, ROOT);
		for (const [key, value] of old.values)
			if (!key.startsWith(THREAD_PREFIX)) current.values.set(key, structuredClone(value));
		const rpc = current.rpc();
		const original = rpc.context.kv;
		let indexWrites = 0;
		const kv: PluginContext["kv"] = {
			...original,
			async set(key, value) {
				expect(this).toBe(kv);
				if (key.startsWith(THREAD_PREFIX)) indexWrites++;
				return Reflect.apply(original.set, original, [key, value]);
			},
		};
		const page = await syncSlackAccount({ ...rpc.context, kv }, SCOPE, initial(first.cursor));
		expect(page.more).toBe(false);
		expect(indexWrites).toBe(2);
		expect(old.kvRequests).toHaveLength(oldCalls);
		expect(await createSlackThreadIndex(rpc.context, SCOPE).find(message(REPLY))).toEqual({
			channelId: CHANNEL,
			ts: REPLY,
			threadTs: ROOT,
		});
	});

	it("keeps a missing cache entry advisory instead of guessing a reply's root", async () => {
		const f = fixture();
		add(f, OLD_ROOT);
		add(f, REPLY, OLD_ROOT);
		const rpc = f.rpc();
		const observed = await createSlackThreadIndex(rpc.context, SCOPE).find(message(REPLY));
		expect(observed).toBeUndefined();
		await expect(
			fetchSlackMessageBody(rpc.context, message(REPLY), observed),
		).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(f.requests).toHaveLength(1);
		const url = new URL(f.requests[0]?.params.url ?? "");
		expect(url.pathname).toBe("/api/conversations.history");
		expect(url.searchParams.has("ts")).toBe(false);
		expect([...f.values.keys()].filter((key) => key.startsWith(THREAD_PREFIX))).toEqual([]);
	});

	it("validates all reply correlations before writing any index or new checkpoint", async () => {
		const f = fixture();
		add(f, ROOT);
		add(f, REPLY, ROOT);
		f.replyThreadOverrides.set(REPLY, OLD_ROOT);
		const cursor = await cursorFor(f, {
			kind: "replies",
			channelId: CHANNEL,
			threadTs: ROOT,
			seen: [],
		});
		const before = [...f.values];
		await expect(syncSlackAccount(f.rpc().context, SCOPE, initial(cursor))).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect([...f.values]).toEqual(before);
	});
});
