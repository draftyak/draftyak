import type { SyncRequest } from "@draftyak/protocol/channel-v1";
import { createPluginContext } from "@draftyak/sdk/context";
import { type MemoryHost, memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	createSlackLegacySyncStore,
	type SlackLegacyCheckpoint,
	type SlackLegacySyncStore,
	type SlackLegacyWork,
} from "../src/legacy-sync-state.ts";
import { digestSlackCursor } from "../src/sync-state.ts";

const SCOPE = "DYTEST account/instance";
const CHANNEL = "CDYTEST1";
const ROOT = "1800000000.000000001";
type KvMethod = "host/kv.get" | "host/kv.set" | "host/kv.delete";
interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}
interface Rpc {
	readonly controller: AbortController;
	readonly store: Readonly<SlackLegacySyncStore>;
}
interface Fixture {
	readonly host: MemoryHost;
	readonly values: Map<string, unknown>;
	readonly calls: { method: KvMethod; key: string }[];
	rpc(scope?: string): Rpc;
	hold(method: KvMethod): { entered: Gate; release: Gate };
	fail(method: KvMethod): void;
}
const fixtures: Fixture[] = [],
	gates: Gate[] = [],
	pending: Promise<unknown>[] = [];
const network = vi.fn<typeof fetch>();
function gate(): Gate {
	const value = Promise.withResolvers<void>();
	const result = { promise: value.promise, release: (): void => value.resolve() };
	gates.push(result);
	return result;
}
function track<T>(promise: Promise<T>): Promise<T> {
	pending.push(promise);
	void promise.catch(() => undefined);
	return promise;
}
function fixture(): Fixture {
	const values = new Map<string, unknown>();
	const calls: Fixture["calls"] = [];
	const holds: { method: KvMethod; entered: Gate; release: Gate; used: boolean }[] = [];
	const failures: KvMethod[] = [];
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/kv.get" && method !== "host/kv.set" && method !== "host/kv.delete")
			throw new Error("DYTEST unexpected host method");
		const params = raw as { key: string; value?: unknown };
		calls.push({ method, key: params.key });
		const held = holds.find((item) => item.method === method && !item.used);
		if (held) {
			held.used = true;
			held.entered.release();
			await held.release.promise;
		}
		if (signal.aborted) throw new Error("DYTEST backend cancelled");
		const fault = failures.indexOf(method);
		if (fault >= 0) {
			failures.splice(fault, 1);
			throw new Error("DYTEST backend private detail");
		}
		if (method === "host/kv.get") return { value: values.get(params.key) ?? null };
		if (method === "host/kv.set") values.set(params.key, params.value);
		else values.delete(params.key);
		return null;
	});
	const result: Fixture = {
		host,
		values,
		calls,
		rpc(scope = SCOPE) {
			const controller = new AbortController();
			const context = createPluginContext(
				{ plugin: "channel-slack", account: "dytest" },
				host,
				controller.signal,
			);
			return { controller, store: createSlackLegacySyncStore(context, scope) };
		},
		hold(method) {
			const entry = { method, entered: gate(), release: gate(), used: false };
			holds.push(entry);
			return entry;
		},
		fail(method) {
			failures.push(method);
		},
	};
	fixtures.push(result);
	return result;
}
function state(overrides: Partial<SlackLegacyCheckpoint> = {}): SlackLegacyCheckpoint {
	return {
		mode: "initial",
		since: 42,
		work: [{ kind: "replies", channelId: CHANNEL, threadTs: ROOT, seen: [] }],
		snapshot: [{ id: JSON.stringify(["chat.message", CHANNEL, ROOT]), sha256: "a".repeat(64) }],
		...overrides,
	};
}
const initial = (cursor?: string): SyncRequest => ({
	mode: "initial",
	since: 42,
	...(cursor === undefined ? {} : { cursor }),
});
const delta = (cursor: string): SyncRequest => ({ mode: "delta", cursor });
function rootKey(ref: string): string {
	return `slack:legacy:state:v1:${ref.slice(4)}`;
}
async function transient(promise: Promise<unknown>): Promise<void> {
	await expect(promise).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
}
beforeEach(() => {
	network.mockReset();
	network.mockImplementation(async () => {
		throw new Error("DYTEST no global network");
	});
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	for (const value of gates.splice(0)) value.release();
	await Promise.allSettled(pending.splice(0));
	for (const value of fixtures.splice(0)) value.host.close();
	expect(network).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

it("roundtrips a no-count replies frontier as detached immutable data", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const input = state();
	const ref = await store.save(input);
	const value = await store.load(ref, initial(ref));
	expect(value).toEqual(input);
	expect(value === input).toBe(false);
	expect(value.work[0]).not.toHaveProperty("replyCount");
	expect(Object.isFrozen(value)).toBe(true);
	expect(Object.isFrozen(value.work)).toBe(true);
	expect(Object.isFrozen(value.work[0])).toBe(true);
	expect(Object.isFrozen(value.snapshot)).toBe(true);
	expect(Object.isFrozen(value.snapshot[0])).toBe(true);
	expect([...f.values.keys()].every((key) => key.startsWith("slack:legacy:"))).toBe(true);
});

it("chunks a real large metadata index and frontier instead of imposing a flat KV cap", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const input = state({
		work: Array.from({ length: 600 }, (_, at) => ({
			kind: "info" as const,
			channelId: `CDYTEST${at}`,
		})),
		snapshot: Array.from({ length: 1_600 }, (_, at) => ({
			id: JSON.stringify([
				"chat.message",
				`C${"x".repeat(140)}`,
				`1800000000.${String(at).padStart(9, "0")}`,
			]),
			sha256: "b".repeat(64),
		})),
	});
	expect(Buffer.byteLength(JSON.stringify(input.snapshot))).toBeGreaterThan(256 * 1_024);
	const ref = await store.save(input);
	const value = await store.load(ref, initial(ref));
	expect(value.work).toEqual(input.work);
	expect(value.snapshot).toHaveLength(1_600);
	expect(f.calls.filter((call) => call.method === "host/kv.set").length).toBeGreaterThan(4);
	expect(
		[...f.values.values()].every((value) => Buffer.byteLength(JSON.stringify(value)) <= 131_072),
	).toBe(true);
});

it.each(["initial", "resync", "delta"] as const)(
	"allows delta from a complete %s observational position",
	async (mode) => {
		const { store } = fixture().rpc();
		const input = state({ mode, work: [] });
		const ref = await store.save(input);
		expect(await store.load(ref, delta(ref))).toEqual(input);
		expect(await store.save(await store.load(ref, delta(ref)))).toBe(ref);
	},
);

it("retains the original terminal base during a delta pass without wall-clock fields", async () => {
	const { store } = fixture().rpc();
	const base = await store.save(state({ work: [] }));
	const next = await store.save(state({ mode: "delta", base }));
	const current = await store.load(next, delta(next));
	expect(current.base).toBe(base);
	expect(await store.load(base, delta(base))).toEqual(state({ work: [] }));
	expect(current).not.toHaveProperty("now");
	expect(current).not.toHaveProperty("expiresAt");
});

it("captures both KV and signal from a fresh RPC after the earlier RPC ends", async () => {
	const f = fixture(),
		first = f.rpc();
	const ref = await first.store.save(state({ work: [] }));
	first.controller.abort();
	const before = f.calls.length;
	await transient(first.store.load(ref, delta(ref)));
	expect(f.calls).toHaveLength(before);
	const second = f.rpc();
	expect(await second.store.load(ref, delta(ref))).toEqual(state({ work: [] }));
});

it.each([
	{ mode: "resync", since: 42 },
	{ mode: "initial", since: 43 },
	{ mode: "delta" },
] as const)("refuses an incompatible inflight request $mode before chunk use", async (query) => {
	const f = fixture(),
		{ store } = f.rpc();
	const ref = await store.save(state());
	const before = f.calls.length;
	await transient(store.load(ref, { ...query, cursor: ref }));
	expect(f.calls.slice(before)).toEqual([{ method: "host/kv.get", key: rootKey(ref) }]);
});

it("requires matching mode and original since for a completed same-mode resume", async () => {
	const { store } = fixture().rpc();
	const ref = await store.save(state({ mode: "resync", work: [] }));
	expect(await store.load(ref, { mode: "resync", since: 42, cursor: ref })).toEqual(
		state({ mode: "resync", work: [] }),
	);
	await transient(store.load(ref, initial(ref)));
	await transient(store.load(ref, { mode: "resync", since: 43, cursor: ref }));
});

it("binds a request cursor to the exact loaded ref before any KV operation", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const ref = await store.save(state({ work: [] }));
	const other = await store.save(state({ since: 43, work: [] }));
	const before = f.calls.length;
	await transient(store.load(ref, delta(other)));
	await transient(store.release(ref, delta(other)));
	expect(f.calls).toHaveLength(before);
});

it("keeps pending provider cursors separate from consumed digests", async () => {
	const { store } = fixture().rpc();
	const input = state({
		work: [{ kind: "history", channelId: CHANNEL, cursor: "B", seen: [digestSlackCursor("A")] }],
	});
	const ref = await store.save(input);
	expect(await store.load(ref, initial(ref))).toEqual(input);
	for (const seen of [
		[digestSlackCursor("B")],
		[digestSlackCursor("A"), digestSlackCursor("A")],
		[`${"a".repeat(64)}\n`],
	])
		expect(() =>
			store.save(state({ work: [{ kind: "history", channelId: CHANNEL, cursor: "B", seen }] })),
		).toThrow("INVALID_INPUT");
});

it("requires a terminal base only for inflight delta and forbids it on completed state", async () => {
	const { store } = fixture().rpc();
	const base = await store.save(state({ work: [] }));
	expect(() => store.save(state({ mode: "delta" }))).toThrow("INVALID_INPUT");
	expect(() => store.save(state({ base }))).toThrow("INVALID_INPUT");
	expect(() => store.save(state({ mode: "delta", base, work: [] }))).toThrow("INVALID_INPUT");
});

it("refuses an absent, unfinished or different-query delta base before writing a state", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const unfinished = await store.save(state());
	const different = await store.save(state({ since: 43, work: [] }));
	const before = f.calls.filter((call) => call.method === "host/kv.set").length;
	for (const base of [`la1.${"a".repeat(64)}`, unfinished, different])
		await transient(store.save(state({ mode: "delta", base })));
	expect(f.calls.filter((call) => call.method === "host/kv.set")).toHaveLength(before);
});

it("canonicalizes snapshot order and refuses duplicate object identities", async () => {
	const { store } = fixture().rpc();
	const one = { id: JSON.stringify(["chat.conversation", CHANNEL]), sha256: "b".repeat(64) };
	const two = { id: JSON.stringify(["chat.message", CHANNEL, ROOT]), sha256: "c".repeat(64) };
	expect(await store.save(state({ snapshot: [two, one] }))).toBe(
		await store.save(state({ snapshot: [one, two] })),
	);
	expect(() => store.save(state({ snapshot: [one, { ...one, sha256: "d".repeat(64) }] }))).toThrow(
		"INVALID_INPUT",
	);
});

it("refuses well-typed root tampering even with a matching changed request", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const ref = await store.save(state());
	const key = rootKey(ref);
	f.values.set(key, { ...(f.values.get(key) as object), since: 43 });
	await transient(store.load(ref, { mode: "initial", since: 43, cursor: ref }));
});

it("refuses well-typed snapshot chunk tampering without deleting anything", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const ref = await store.save(state());
	const key = [...f.values.keys()].find((value) => value.includes(":snapshot:"));
	if (key === undefined) throw new Error("DYTEST missing snapshot chunk");
	const original = f.values.get(key) as { items: readonly { id: string; sha256: string }[] };
	f.values.set(key, {
		...original,
		items: original.items.map((item) => ({ ...item, sha256: "d".repeat(64) })),
	});
	await transient(store.load(ref, initial(ref)));
	await transient(store.release(ref, initial(ref)));
	expect(f.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
});

it("verifies scope and state before outer-only release, retaining shared immutable chunks", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	const first = await store.save(state({ work: [] }));
	const second = await store.save(state({ mode: "resync", work: [] }));
	await transient(f.rpc("DYTEST other scope").store.release(first, delta(first)));
	expect(f.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
	await store.release(first, delta(first));
	expect(f.calls.filter((call) => call.method === "host/kv.delete")).toEqual([
		{ method: "host/kv.delete", key: rootKey(first) },
	]);
	expect(await store.load(second, delta(second))).toEqual(state({ mode: "resync", work: [] }));
	await transient(store.load(first, delta(first)));
});

it("refuses missing, foreign-format and corrupt state without inventing provider expiry", async () => {
	const { store } = fixture().rpc();
	for (const ref of [`la1.${"a".repeat(64)}`, `s1.${"a".repeat(64)}`, "not-a-state"])
		await transient(store.load(ref, delta(ref)));
});

it("does not return partial refs when a current RPC aborts during a KV write", async () => {
	const f = fixture(),
		rpc = f.rpc(),
		held = f.hold("host/kv.set");
	const operation = track(rpc.store.save(state()));
	const refused = transient(operation);
	try {
		await held.entered.promise;
		rpc.controller.abort();
		held.release.release();
		await refused;
		expect([...f.values.keys()].some((key) => key.includes(":state:"))).toBe(false);
	} finally {
		held.release.release();
		await refused;
	}
});

it("settles its local queue after a fixed backend refusal and sanitizes the failure", async () => {
	const f = fixture(),
		{ store } = f.rpc();
	f.fail("host/kv.set");
	await transient(store.save(state()));
	const ref = await store.save(state());
	expect(await store.load(ref, initial(ref))).toEqual(state());
});

it("captures no getter, proxy, sparse array or unsupported count metadata", () => {
	const f = fixture(),
		{ store } = f.rpc();
	let hooks = 0;
	const accessor = Object.defineProperty(state(), "snapshot", {
		enumerable: true,
		get() {
			hooks++;
			return [];
		},
	});
	const proxy = new Proxy(state(), {
		ownKeys() {
			hooks++;
			return [];
		},
	});
	const sparse = state({ work: new Array<SlackLegacyWork>(1) });
	const counted = state({
		work: [
			{
				kind: "replies",
				channelId: CHANNEL,
				threadTs: ROOT,
				seen: [],
				replyCount: 1,
			} as unknown as SlackLegacyCheckpoint["work"][number],
		],
	});
	for (const input of [accessor, proxy, sparse, counted])
		expect(() => store.save(input)).toThrow("INVALID_INPUT");
	expect(hooks).toBe(0);
	expect(f.calls).toEqual([]);
});
