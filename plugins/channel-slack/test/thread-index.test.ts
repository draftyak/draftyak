import type { HostMethod } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackThreadIndex, type SlackThreadObservation } from "../src/thread-index.ts";

const SCOPE = "DYTEST account/instance \u{1f680}";
const CHANNEL = "CDYTEST1";
const TS = "1800000001.000000001";
const ROOT = "1800000000.123456789";
const OBSERVED: SlackThreadObservation = { channelId: CHANNEL, ts: TS, threadTs: ROOT };
const ref = (ts = TS, channelId = CHANNEL) => ({ kind: "chat" as const, channelId, ts });
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
type KvMethod = "host/kv.get" | "host/kv.set" | "host/kv.delete";
interface Gate {
	readonly promise: Promise<void>;
	release(): void;
}
const gates: Gate[] = [];
function gate(): Gate {
	let release = (): void => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const result = { promise, release };
	gates.push(result);
	return result;
}
interface Trace {
	readonly method: KvMethod;
	readonly params: { key: string; value?: unknown };
}
interface Fixture {
	readonly context: PluginContext;
	readonly shared: AbortController;
	readonly store: Map<string, unknown>;
	readonly calls: Trace[];
	readonly unexpected: HostMethod[];
	hold(method: KvMethod): { entered: Gate; release: Gate };
	failNext(method: KvMethod): void;
	close(): void;
}
const fixtures: Fixture[] = [],
	pending = new Set<Promise<unknown>>();
const network = vi.fn<typeof fetch>();
function track<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise);
	void promise.then(
		() => pending.delete(promise),
		() => pending.delete(promise),
	);
	return promise;
}

/** The backend is an owned Map; every ordinary operation crosses the real SDK KV schemas. */
function sdk(): Fixture {
	const shared = new AbortController(),
		store = new Map<string, unknown>();
	const calls: Trace[] = [],
		unexpected: HostMethod[] = [];
	const holds: { method: KvMethod; entered: Gate; release: Gate; used: boolean }[] = [];
	const failures: KvMethod[] = [];
	const host = memoryHost(async (method, raw, signal) => {
		if (method !== "host/kv.get" && method !== "host/kv.set" && method !== "host/kv.delete") {
			unexpected.push(method);
			throw new Error("DYTEST unexpected host method");
		}
		const params = raw as { key: string; value?: unknown };
		calls.push({ method, params: structuredClone(params) });
		const held = holds.find((item) => !item.used && item.method === method);
		if (held) {
			held.used = true;
			held.entered.release();
			await held.release.promise;
		}
		if (signal.aborted) throw new Error("DYTEST owned backend cancelled");
		const fail = failures.indexOf(method);
		if (fail >= 0) {
			failures.splice(fail, 1);
			throw new Error("DYTEST private backend detail");
		}
		if (method === "host/kv.get")
			return { value: store.has(params.key) ? store.get(params.key) : null };
		if (method === "host/kv.set") store.set(params.key, params.value);
		else store.delete(params.key);
		return null;
	});
	const context = createPluginContext(
		{ plugin: "channel-slack", account: "dytest" },
		host,
		shared.signal,
	);
	const result: Fixture = {
		context,
		shared,
		store,
		calls,
		unexpected,
		hold(method) {
			const entry = { method, entered: gate(), release: gate(), used: false };
			holds.push(entry);
			return entry;
		},
		failNext(method) {
			failures.push(method);
		},
		close() {
			shared.abort();
			host.close();
		},
	};
	fixtures.push(result);
	return result;
}
function writtenKey(fixture: Fixture): string {
	const written = fixture.calls.find((call) => call.method === "host/kv.set");
	if (!written) throw new Error("DYTEST expected stored routing record");
	return written.params.key;
}

beforeEach(() => {
	network.mockReset();
	network.mockRejectedValue(new Error("DYTEST network forbidden"));
	vi.stubGlobal("fetch", network);
});
afterEach(async () => {
	try {
		for (const held of gates.splice(0)) held.release();
		for (const fixture of fixtures.splice(0)) {
			fixture.close();
			expect(fixture.unexpected).toEqual([]);
		}
		await Promise.allSettled([...pending]);
		expect(network).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("Slack advisory thread index", () => {
	it("round-trips only detached routing data through genuine SDK get/set/delete", async () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		expect(Object.isFrozen(index)).toBe(true);
		expect(owned.calls).toEqual([]);
		let hooks = 0;
		const input = Object.defineProperty({ ...OBSERVED }, "text", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST unread message body");
			},
		});
		const saving = index.remember(input);
		input.threadTs = "1799999999.0";
		await saving;
		const key = writtenKey(owned);
		expect(key).toMatch(/^slack:thread:v1:[0-9a-f]{64}$/);
		expect(key).toHaveLength(80);
		expect(key).not.toContain(SCOPE);
		expect(key).not.toContain(CHANNEL);
		expect(key).not.toContain(TS);
		expect(owned.calls[0]?.params.value).toEqual({ v: 1, scope: SCOPE, ...OBSERVED });
		expect(Object.keys(owned.calls[0]?.params.value as object).sort()).toEqual([
			"channelId",
			"scope",
			"threadTs",
			"ts",
			"v",
		]);
		const found = await index.find(ref());
		expect(found).toEqual(OBSERVED);
		expect(found === input).toBe(false);
		expect(Object.isFrozen(found)).toBe(true);
		const stored = owned.store.get(key) as Record<string, unknown>;
		stored.threadTs = "1799999998.0";
		expect(found?.threadTs).toBe(ROOT);
		await index.forget(ref());
		expect(owned.store.has(key)).toBe(false);
		expect(owned.calls.map((call) => call.method)).toEqual([
			"host/kv.set",
			"host/kv.get",
			"host/kv.delete",
		]);
		expect(hooks).toBe(0);
		expect(owned.shared.signal.aborted).toBe(false);
	});

	it("separates advisory keys by scope, channel and byte-exact nanosecond ID", async () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		await index.remember(OBSERVED);
		const otherScope = createSlackThreadIndex(owned.context, `${SCOPE}-other`);
		expect(await otherScope.find(ref())).toBeUndefined();
		expect(await index.find(ref(TS, "CDYTEST2"))).toBeUndefined();
		expect(await index.find(ref("1800000001.000000002"))).toBeUndefined();
		const keys = owned.calls.map((call) => call.params.key);
		expect(new Set(keys).size).toBe(4);
		expect(owned.store.size).toBe(1);
	});

	it("bounds keys for the actual maximum scope and opaque channel sizes", async () => {
		const owned = sdk(),
			scope = "\u{1f680}".repeat(2048),
			channelId = "C".repeat(256);
		const index = createSlackThreadIndex(owned.context, scope);
		const observed = { channelId, ts: "9007199254740.991999999", threadTs: ROOT };
		await index.remember(observed);
		expect(writtenKey(owned)).toHaveLength(80);
		expect(await index.find(ref(observed.ts, channelId))).toEqual(observed);
	});

	it("treats a genuine null miss as advisory and never repairs or deletes it", async () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		expect(await index.find(ref())).toBeUndefined();
		expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.get"]);
		expect(owned.store.size).toBe(0);
	});

	it("also accepts a local undefined projection after a genuine SDK null miss", async () => {
		const owned = sdk();
		const kv = {
			...owned.context.kv,
			async get(key: string) {
				expect(await owned.context.kv.get(key)).toBeNull();
				return undefined;
			},
		};
		const index = createSlackThreadIndex({ kv, signal: owned.context.signal }, SCOPE);
		expect(await index.find(ref())).toBeUndefined();
		expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.get"]);
	});

	it.each([
		{ stored: { v: 2, scope: SCOPE, ...OBSERVED } },
		{ stored: { v: 1, scope: "DYTEST other scope", ...OBSERVED } },
		{ stored: { v: 1, scope: SCOPE, ...OBSERVED, channelId: "CDYTEST2" } },
		{ stored: { v: 1, scope: SCOPE, ...OBSERVED, ts: "1800000001.000000002" } },
		{ stored: { v: 1, scope: SCOPE, channelId: CHANNEL, ts: TS } },
		{ stored: { v: 1, scope: SCOPE, ...OBSERVED, body: "DYTEST unexpected field" } },
		{ stored: false },
		{ stored: 0 },
		{ stored: "DYTEST malformed" },
		{ stored: [] },
	])(
		"refuses malformed or differently bound present records without deleting them",
		async ({ stored }) => {
			const owned = sdk(),
				index = createSlackThreadIndex(owned.context, SCOPE);
			await index.remember(OBSERVED);
			const key = writtenKey(owned);
			owned.store.set(key, stored);
			await expect(index.find(ref())).rejects.toMatchObject({
				message: "TRANSIENT",
				result: { code: "TRANSIENT" },
			});
			expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set", "host/kv.get"]);
			expect(owned.store.has(key)).toBe(true);
		},
	);

	it("serializes remember, find and explicit forget, capturing inputs before the wait", async () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		const held = owned.hold("host/kv.set"),
			observed = { ...OBSERVED },
			message = ref();
		const remembering = track(index.remember(observed));
		const finding = track(index.find(message));
		const forgetting = track(index.forget(message));
		const finished = track(Promise.all([remembering, finding, forgetting]));
		observed.channelId = "CDYTEST2";
		message.ts = "1800000001.000000002";
		await held.entered.promise;
		await turn();
		expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set"]);
		held.release.release();
		expect(await finished).toEqual([undefined, OBSERVED, undefined]);
		expect(owned.calls.map((call) => call.method)).toEqual([
			"host/kv.set",
			"host/kv.get",
			"host/kv.delete",
		]);
		expect(new Set(owned.calls.map((call) => call.params.key)).size).toBe(1);
		expect(owned.store.size).toBe(0);
	});

	it("recovers its own serial queue after a host failure without exposing its detail", async () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		owned.failNext("host/kv.set");
		await expect(index.remember(OBSERVED)).rejects.toMatchObject({
			message: "TRANSIENT",
			result: { code: "TRANSIENT" },
		});
		await index.remember(OBSERVED);
		expect(await index.find(ref())).toEqual(OBSERVED);
		expect(owned.calls.map((call) => call.method)).toEqual([
			"host/kv.set",
			"host/kv.set",
			"host/kv.get",
		]);
	});

	it("captures public KV methods and preserves their receiver while delegating to the SDK", async () => {
		const owned = sdk(),
			original = owned.context.kv,
			receivers: unknown[] = [];
		const kv: PluginContext["kv"] = {
			get: function (this: unknown, key: string) {
				receivers.push(this);
				return Reflect.apply(original.get, original, [key]);
			},
			set: function (this: unknown, key: string, value: unknown) {
				receivers.push(this);
				return Reflect.apply(original.set, original, [key, value]);
			},
			delete: function (this: unknown, key: string) {
				receivers.push(this);
				return Reflect.apply(original.delete, original, [key]);
			},
		};
		const index = createSlackThreadIndex({ kv, signal: owned.context.signal }, SCOPE);
		kv.get = () => {
			throw new Error("DYTEST replaced get");
		};
		kv.set = () => {
			throw new Error("DYTEST replaced set");
		};
		kv.delete = () => {
			throw new Error("DYTEST replaced delete");
		};
		await index.remember(OBSERVED);
		expect(await index.find(ref())).toEqual(OBSERVED);
		await index.forget(ref());
		expect(receivers).toHaveLength(3);
		for (const receiver of receivers) expect(receiver).toBe(kv);
		expect(owned.calls.map((call) => call.method)).toEqual([
			"host/kv.set",
			"host/kv.get",
			"host/kv.delete",
		]);
	});

	it("does not return a stored tuple released after the genuine SDK get and caller abort", async () => {
		const owned = sdk();
		await createSlackThreadIndex(owned.context, SCOPE).remember(OBSERVED);
		const entered = gate(),
			released = gate(),
			original = owned.context.kv;
		const kv = {
			...original,
			async get(key: string) {
				const value = await original.get(key);
				entered.release();
				await released.promise;
				return value;
			},
		};
		const index = createSlackThreadIndex({ kv, signal: owned.context.signal }, SCOPE);
		const finding = track(index.find(ref()));
		const refused = track(
			expect(finding).rejects.toMatchObject({
				message: "TRANSIENT",
				result: { code: "TRANSIENT" },
			}),
		);
		await entered.promise;
		owned.shared.abort(new Error("DYTEST private cancellation reason"));
		released.release();
		await refused;
		await expect(index.find(ref())).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set", "host/kv.get"]);
		expect(owned.store.size).toBe(1);
	});

	it("refuses invalid caller data synchronously before any host request", () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		expect(() => index.remember({ ...OBSERVED, threadTs: "bad" })).toThrow("INVALID_INPUT");
		expect(() => index.find(ref("bad"))).toThrow("INVALID_INPUT");
		expect(() => index.forget(ref(TS, ""))).toThrow("INVALID_INPUT");
		for (const scope of ["", "D".repeat(4097), "\ud800"])
			expect(() => createSlackThreadIndex(owned.context, scope)).toThrow("INVALID_INPUT");
		expect(owned.calls).toEqual([]);
	});

	it("refuses caller getters and proxies without invoking their hooks or doing I/O", () => {
		const owned = sdk(),
			index = createSlackThreadIndex(owned.context, SCOPE);
		let hooks = 0;
		const accessor = Object.defineProperty({ ...OBSERVED }, "threadTs", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST getter");
			},
		});
		const proxy = new Proxy(
			{ ...OBSERVED },
			{
				get() {
					hooks++;
					throw new Error("DYTEST proxy");
				},
				getPrototypeOf() {
					hooks++;
					throw new Error("DYTEST prototype");
				},
				getOwnPropertyDescriptor() {
					hooks++;
					throw new Error("DYTEST descriptor");
				},
			},
		);
		for (const input of [accessor, proxy])
			expect(() => index.remember(input)).toThrow("INVALID_INPUT");
		const context = Object.defineProperty(
			{ kv: owned.context.kv, signal: owned.context.signal },
			"kv",
			{
				enumerable: true,
				get() {
					hooks++;
					throw new Error("DYTEST KV getter");
				},
			},
		);
		expect(() => createSlackThreadIndex(context, SCOPE)).toThrow("INVALID_INPUT");
		expect(hooks).toBe(0);
		expect(owned.calls).toEqual([]);
	});
});
