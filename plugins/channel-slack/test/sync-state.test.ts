import { createHash } from "node:crypto";
import type { HostMethod } from "@draftyak/protocol/host-channel";
import { createPluginContext, type PluginContext } from "@draftyak/sdk/context";
import { memoryHost } from "@draftyak/sdk/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSlackSyncStore,
	digestSlackCursor,
	type SlackProviderWork,
	type SlackSyncBinding,
	type SlackSyncCheckpoint,
	type SlackSyncProviderCheckpoint,
	type SlackSyncWork,
} from "../src/sync-state.ts";

const SCOPE = "DYTEST sync account \u{1f680}";
const CHANNEL = "CDYTEST1",
	ROOT = "1800000000.123456789";
const BINDING: SlackSyncBinding = { mode: "delta", since: 1_800_000_000_000 };
const MAX_BYTES = 256 * 1024;
const position = (cursor?: string) =>
	cursor === undefined ? { seen: [] } : { cursor, seen: [digestSlackCursor(cursor)] };
const work = (): SlackProviderWork[] => [
	{ kind: "conversations", ...position("opaque-list+/&=") },
	{ kind: "info", channelId: CHANNEL },
	{ kind: "history", channelId: CHANNEL, ...position("opaque-history") },
	{
		kind: "replies",
		channelId: CHANNEL,
		threadTs: ROOT,
		replyCount: 2,
		...position("opaque-replies"),
	},
];
const checkpoint = (jobs: readonly SlackSyncWork[] = work()): SlackSyncCheckpoint => ({
	...BINDING,
	work: jobs,
});
const providerCheckpoint = (
	jobs: readonly SlackProviderWork[] = work(),
): SlackSyncProviderCheckpoint => ({ ...BINDING, work: jobs });
const key = (ref: string): string =>
	`${ref.startsWith("b1.") ? "slack:sync:block:v1:" : "slack:sync:v1:"}${ref.slice(3)}`;
const envelope = (scope: string, value: SlackSyncCheckpoint) => ({
	v: 1,
	scope,
	mode: value.mode,
	since: value.since,
	work: value.work,
});
const bytes = (scope: string, value: SlackSyncCheckpoint) =>
	Buffer.byteLength(JSON.stringify(envelope(scope, value)), "utf8");
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
	readonly values: Map<string, unknown>;
	readonly calls: Trace[];
	readonly unexpected: HostMethod[];
	hold(method: KvMethod): { entered: Gate; release: Gate };
	failAfter(method: KvMethod, successfulCalls: number): void;
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

/** Owned Map backend only; operations cross the real SDK host KV schemas. */
function sdk(): Fixture {
	const shared = new AbortController(),
		values = new Map<string, unknown>();
	const calls: Trace[] = [],
		unexpected: HostMethod[] = [];
	const holds: { method: KvMethod; entered: Gate; release: Gate; used: boolean }[] = [];
	const failures: { method: KvMethod; remaining: number }[] = [];
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
		const failure = failures.find((item) => item.method === method);
		if (failure) {
			if (failure.remaining === 0) {
				failures.splice(failures.indexOf(failure), 1);
				throw new Error("DYTEST private KV failure");
			}
			failure.remaining--;
		}
		if (method === "host/kv.get")
			return { value: values.has(params.key) ? values.get(params.key) : null };
		if (method === "host/kv.set") values.set(params.key, params.value);
		else values.delete(params.key);
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
		values,
		calls,
		unexpected,
		hold(method) {
			const item = { method, entered: gate(), release: gate(), used: false };
			holds.push(item);
			return item;
		},
		failAfter(method, successfulCalls) {
			failures.push({ method, remaining: successfulCalls });
		},
		close() {
			shared.abort();
			host.close();
		},
	};
	fixtures.push(result);
	return result;
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

describe("Slack scoped checkpoints and flat work blocks", () => {
	it("captures and round-trips every root work kind as frozen detached data", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const [block] = await state.saveBlocks(providerCheckpoint());
		if (block === undefined) throw new Error("DYTEST missing block");
		const jobs: SlackSyncWork[] = [...work(), { kind: "resume", block }];
		const input = checkpoint(jobs),
			expected = structuredClone(input);
		expect(Object.isFrozen(state)).toBe(true);
		const saving = state.save(input);
		jobs.length = 0;
		const cursor = await saving;
		expect(cursor).toMatch(/^s1\.[a-f0-9]{64}$/);
		expect(cursor).toHaveLength(67);
		expect(owned.calls.at(-1)?.params).toEqual({
			key: key(cursor),
			value: envelope(SCOPE, expected),
		});
		const loaded = await state.load(cursor);
		expect(loaded).toEqual(expected);
		expect(Object.isFrozen(loaded)).toBe(true);
		expect(Object.isFrozen(loaded.work)).toBe(true);
		for (const job of loaded.work) {
			expect(Object.isFrozen(job)).toBe(true);
			if ("seen" in job) expect(Object.isFrozen(job.seen)).toBe(true);
		}
		(owned.values.get(key(cursor)) as { work: unknown[] }).work.length = 0;
		expect(loaded.work).toHaveLength(5);
	});

	it.each([{ mode: "initial" as const }, { mode: "resync" as const }, { mode: "delta" as const }])(
		"retains $mode and its interval in an empty completed checkpoint",
		async ({ mode }) => {
			const owned = sdk(),
				state = createSlackSyncStore(owned.context, SCOPE);
			const input = { mode, since: Number.MAX_SAFE_INTEGER, work: [] };
			const cursor = await state.save(input);
			expect(await state.load(cursor)).toEqual(input);
			expect(await state.saveBlocks(input)).toEqual([]);
			expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set", "host/kv.get"]);
		},
	);

	it("pins independent fixed-schema root, block and exact provider-cursor byte identities", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, "DYTEST");
		const digest = createHash("sha256")
			.update(
				'draftyak/slack/sync-checkpoint/v1\0{"v":1,"scope":"DYTEST","mode":"delta","since":1800000000000,"work":[]}',
			)
			.digest("hex");
		const cursor = await state.save(checkpoint([]));
		expect(cursor).toBe(`s1.${digest}`);
		const [block] = await state.saveBlocks(
			providerCheckpoint([{ kind: "info", channelId: CHANNEL }]),
		);
		const blockDigest = createHash("sha256")
			.update(
				'draftyak/slack/sync-work-block/v1\0{"v":1,"scope":"DYTEST","mode":"delta","since":1800000000000,"work":[{"kind":"info","channelId":"CDYTEST1"}]}',
			)
			.digest("hex");
		expect(block).toBe(`b1.${blockDigest}`);
		const opaque = "DYTEST+/&=exact";
		expect(digestSlackCursor(opaque)).toBe(
			createHash("sha256")
				.update("draftyak/slack/provider-cursor/v1\0")
				.update(opaque)
				.digest("hex"),
		);
		expect(digestSlackCursor(opaque)).not.toBe(digestSlackCursor(`${opaque}!`));
	});

	it("canonicalizes property order and optional absence while retaining order and exact timestamps", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const a: SlackSyncCheckpoint = {
			work: [
				{
					replyCount: 2,
					seen: [],
					threadTs: ROOT,
					channelId: CHANNEL,
					kind: "replies",
					cursor: undefined,
				},
			],
			since: BINDING.since,
			mode: "delta",
		};
		const b = checkpoint([
			{ kind: "replies", channelId: CHANNEL, threadTs: ROOT, replyCount: 2, seen: [] },
		]);
		const cursor = await state.save(a);
		expect(await state.save(b)).toBe(cursor);
		const changed = checkpoint([
			{
				kind: "replies",
				channelId: CHANNEL,
				threadTs: "1800000000.123456788",
				replyCount: 2,
				seen: [],
			},
		]);
		expect(await state.save(changed)).not.toBe(cursor);
		const ordered = work();
		expect(await state.save(checkpoint(ordered))).not.toBe(
			await state.save(checkpoint([...ordered].reverse())),
		);
		expect(owned.calls.every((call) => call.method === "host/kv.set")).toBe(true);
	});

	it("preserves an ordered 128-cursor history but refuses A to B to A and exhaustion before writes", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const a = digestSlackCursor("A"),
			b = digestSlackCursor("B");
		const first = await state.save(
			checkpoint([{ kind: "history", channelId: CHANNEL, cursor: "A", seen: [a] }]),
		);
		const second = await state.save(
			checkpoint([{ kind: "history", channelId: CHANNEL, cursor: "B", seen: [a, b] }]),
		);
		expect(await state.load(second)).toEqual(
			checkpoint([{ kind: "history", channelId: CHANNEL, cursor: "B", seen: [a, b] }]),
		);
		const seen = Array.from({ length: 128 }, (_, at) => digestSlackCursor(`DYTEST-${at}`));
		const full = checkpoint([{ kind: "conversations", cursor: "DYTEST-127", seen }]);
		expect(await state.load(await state.save(full))).toEqual(full);
		const before = owned.calls.length;
		expect(() =>
			state.save(
				checkpoint([{ kind: "history", channelId: CHANNEL, cursor: "A", seen: [a, b, a] }]),
			),
		).toThrow("INVALID_INPUT");
		expect(() =>
			state.save(
				checkpoint([
					{
						kind: "conversations",
						cursor: "DYTEST-128",
						seen: [...seen, digestSlackCursor("DYTEST-128")],
					},
				]),
			),
		).toThrow("INVALID_INPUT");
		expect(owned.calls).toHaveLength(before);
		expect(owned.values.has(key(first))).toBe(true);
	});

	it.each([
		{ name: "missing history", value: { kind: "conversations" } },
		{ name: "unbound cursor", value: { kind: "conversations", cursor: "A", seen: [] } },
		{
			name: "wrong last digest",
			value: { kind: "conversations", cursor: "B", seen: [digestSlackCursor("A")] },
		},
		{
			name: "initial nonempty history",
			value: { kind: "conversations", seen: [digestSlackCursor("A")] },
		},
		{
			name: "upper-case digest",
			value: { kind: "conversations", cursor: "A", seen: [digestSlackCursor("A").toUpperCase()] },
		},
		{ name: "body", value: { kind: "conversations", seen: [], body: "DYTEST" } },
		{ name: "info pagination", value: { kind: "info", channelId: CHANNEL, seen: [] } },
		{
			name: "zero observed count",
			value: { kind: "replies", channelId: CHANNEL, threadTs: ROOT, replyCount: 0, seen: [] },
		},
		{
			name: "invalid root",
			value: { kind: "replies", channelId: CHANNEL, threadTs: "bad", replyCount: 1, seen: [] },
		},
		{ name: "missing channel", value: { kind: "history", seen: [] } },
		{ name: "empty cursor", value: { kind: "conversations", cursor: "", seen: [] } },
		{ name: "cursor newline", value: { kind: "conversations", cursor: "A\n", seen: [] } },
		{ name: "unknown kind", value: { kind: "other" } },
	])("refuses $name at intake without host work", ({ value }) => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const input = checkpoint([value as SlackSyncWork]);
		expect(() => state.save(input)).toThrow("INVALID_INPUT");
		expect(() => state.saveBlocks(input as SlackSyncProviderCheckpoint)).toThrow("INVALID_INPUT");
		expect(owned.calls).toEqual([]);
	});

	it("rejects all invalid jobs before the first block PUT and forbids nested block references", () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const large = Array.from(
			{ length: 999 },
			(_, at): SlackProviderWork => ({ kind: "info", channelId: `${at}`.padEnd(256, "D") }),
		);
		expect(() =>
			state.saveBlocks(
				providerCheckpoint([...large, { kind: "history", channelId: "", seen: [] }]),
			),
		).toThrow("INVALID_INPUT");
		const nested = checkpoint([{ kind: "resume", block: `b1.${"a".repeat(64)}` }]);
		expect(() => state.saveBlocks(nested as SlackSyncProviderCheckpoint)).toThrow("INVALID_INPUT");
		expect(owned.calls).toEqual([]);
	});

	it("accepts 1024 typed jobs and rejects 1025 at both root and block intake", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const jobs: SlackProviderWork[] = Array.from({ length: 1024 }, () => ({
			kind: "conversations",
			seen: [],
		}));
		expect((await state.load(await state.save(checkpoint(jobs)))).work).toHaveLength(1024);
		const refs = await state.saveBlocks(providerCheckpoint(jobs));
		expect(refs).toHaveLength(1);
		expect(await state.loadBlock(refs[0] as string, BINDING)).toHaveLength(1024);
		const before = owned.calls.length,
			excess = [...jobs, { kind: "info" as const, channelId: CHANNEL }];
		expect(() => state.save(checkpoint(excess))).toThrow("INVALID_INPUT");
		expect(() => state.saveBlocks(providerCheckpoint(excess))).toThrow("INVALID_INPUT");
		expect(owned.calls).toHaveLength(before);
	});

	it("enforces the exact UTF-8 envelope ceiling without tightening a 4096-character cursor", async () => {
		const owned = sdk(),
			scope = "\u754c".repeat(4096),
			state = createSlackSyncStore(owned.context, scope);
		const item = (length: number): SlackProviderWork => ({
			kind: "conversations",
			...position("D".repeat(length)),
		});
		const jobs: SlackProviderWork[] = [];
		while (bytes(scope, checkpoint([...jobs, item(4096)])) <= MAX_BYTES) jobs.push(item(4096));
		const length = MAX_BYTES - bytes(scope, checkpoint([...jobs, item(1)])) + 1;
		expect(length).toBeGreaterThan(0);
		expect(length).toBeLessThan(4096);
		jobs.push(item(length));
		expect(bytes(scope, checkpoint(jobs))).toBe(MAX_BYTES);
		expect(JSON.stringify(envelope(scope, checkpoint(jobs))).length).toBeLessThan(MAX_BYTES);
		expect((await state.load(await state.save(checkpoint(jobs)))).work).toEqual(jobs);
		const excess = [...jobs.slice(0, -1), item(length + 1)];
		expect(bytes(scope, checkpoint(excess))).toBe(MAX_BYTES + 1);
		expect(() => state.save(checkpoint(excess))).toThrow("INVALID_INPUT");
		const refs = await state.saveBlocks(providerCheckpoint(excess));
		expect(refs).toHaveLength(2);
		expect(Object.isFrozen(refs)).toBe(true);
		const decoded = await Promise.all(refs.map((ref) => state.loadBlock(ref, BINDING)));
		expect(decoded.flat()).toEqual(excess);
	});

	it.each([{ fanout: "999 channels" }, { fanout: "500 thread roots" }])(
		"packs $fanout into real bounded FIFO blocks without losing jobs",
		async ({ fanout }) => {
			const owned = sdk(),
				state = createSlackSyncStore(owned.context, SCOPE);
			const jobs: SlackProviderWork[] =
				fanout === "999 channels"
					? Array.from({ length: 999 }, (_, at) => ({
							kind: "info",
							channelId: `${at}`.padEnd(256, "D"),
						}))
					: Array.from({ length: 500 }, (_, at) => ({
							kind: "replies",
							channelId: `${at}`.padEnd(256, "D"),
							threadTs: `1800000000.${`${at}`.padStart(9, "0")}`,
							replyCount: 1,
							...position("P".repeat(512)),
						}));
			const refs = await state.saveBlocks(providerCheckpoint(jobs));
			expect(refs.length).toBeGreaterThan(1);
			expect(Object.isFrozen(refs)).toBe(true);
			const writes = owned.calls.filter((call) => call.method === "host/kv.set");
			expect(writes.map((call) => call.params.key)).toEqual(refs.map(key));
			const chunks: (readonly SlackProviderWork[])[] = [];
			for (let at = 0; at < refs.length; at++) {
				const ref = refs[at];
				if (ref === undefined) throw new Error("DYTEST block");
				const chunk = await state.loadBlock(ref, BINDING);
				chunks.push(chunk);
				expect(chunk.length).toBeGreaterThan(0);
				expect(chunk.length).toBeLessThanOrEqual(1024);
				expect(bytes(SCOPE, checkpoint(chunk))).toBeLessThanOrEqual(MAX_BYTES);
				expect(Object.isFrozen(chunk)).toBe(true);
				for (const job of chunk) expect(Object.isFrozen(job)).toBe(true);
				const next = writes[at + 1]?.params.value as { work: SlackProviderWork[] } | undefined;
				if (next?.work[0])
					expect(bytes(SCOPE, checkpoint([...chunk, next.work[0]]))).toBeGreaterThan(MAX_BYTES);
			}
			expect(chunks.flat()).toEqual(jobs);
			const frontier = checkpoint(refs.map((block) => ({ kind: "resume", block })));
			expect((await state.load(await state.save(frontier))).work).toEqual(frontier.work);
			expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
		},
	);

	it("refuses hooks, proxies, holes and extra fields without invoking them or writing", () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		let hooks = 0;
		const getter = Object.defineProperty({ kind: "conversations", seen: [] }, "cursor", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("DYTEST getter");
			},
		});
		const proxy = new Proxy(work(), {
			get() {
				hooks++;
				throw new Error("DYTEST get");
			},
			ownKeys() {
				hooks++;
				throw new Error("DYTEST keys");
			},
			getPrototypeOf() {
				hooks++;
				throw new Error("DYTEST prototype");
			},
		});
		const accessor = Object.defineProperty(new Array(1), "0", {
			enumerable: true,
			get() {
				hooks++;
				return getter;
			},
		});
		const cases = [
			{ jobs: new Array(1) },
			{ jobs: Object.assign(work(), { extra: true }) },
			{ jobs: [getter] },
			{ jobs: proxy },
			{ jobs: accessor },
			{ jobs: [{ kind: "conversations", seen: new Array(1) }] },
		];
		for (const { jobs } of cases) {
			expect(() => state.save(checkpoint(jobs as readonly SlackSyncWork[]))).toThrow(
				"INVALID_INPUT",
			);
			expect(() =>
				state.saveBlocks(providerCheckpoint(jobs as readonly SlackProviderWork[])),
			).toThrow("INVALID_INPUT");
		}
		const input = Object.defineProperty(checkpoint(), "mode", {
			enumerable: true,
			get() {
				hooks++;
				return "delta";
			},
		});
		expect(() => state.save(input)).toThrow("INVALID_INPUT");
		const context = Object.defineProperty(
			{ kv: owned.context.kv, signal: owned.context.signal },
			"kv",
			{
				enumerable: true,
				get() {
					hooks++;
					return owned.context.kv;
				},
			},
		);
		expect(() => createSlackSyncStore(context, SCOPE)).toThrow("INVALID_INPUT");
		expect(hooks).toBe(0);
		expect(owned.calls).toEqual([]);
	});

	it.each([
		{ value: { mode: "other", since: 0, work: [] } },
		{ value: { mode: "delta", since: -1, work: [] } },
		{ value: { mode: "delta", since: Number.MAX_SAFE_INTEGER + 1, work: [] } },
		{ value: { mode: "delta", since: 0.5, work: [] } },
		{ value: { mode: "delta", work: [] } },
		{ value: { mode: "delta", since: 0, work: [], body: "DYTEST" } },
	])("rejects an invalid checkpoint binding before any host call", ({ value }) => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		expect(() => state.save(value as SlackSyncCheckpoint)).toThrow("INVALID_INPUT");
		expect(() => state.saveBlocks(value as SlackSyncProviderCheckpoint)).toThrow("INVALID_INPUT");
		expect(owned.calls).toEqual([]);
	});

	it("rejects root/block tag substitution before I/O and does not infer block completion from a root", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const root = await state.save(checkpoint()),
			[block] = await state.saveBlocks(providerCheckpoint());
		if (!block) throw new Error("DYTEST block");
		const before = owned.calls.length;
		expect(() => state.load(block)).toThrow("INVALID_INPUT");
		expect(() => state.release(block)).toThrow("INVALID_INPUT");
		expect(() => state.loadBlock(root, BINDING)).toThrow("INVALID_INPUT");
		expect(() => state.releaseBlock(root)).toThrow("INVALID_INPUT");
		expect(owned.calls).toHaveLength(before);
		// A forged tag with a well-typed record still fails the independent content domain.
		const forged = `b1.${root.slice(3)}`;
		owned.values.set(key(forged), owned.values.get(key(root)));
		await expect(state.loadBlock(forged, BINDING)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		await expect(state.releaseBlock(forged)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
	});

	it.each([
		{ expected: { ...BINDING, mode: "resync" as const } },
		{ expected: { ...BINDING, since: BINDING.since + 1 } },
	])("refuses a valid block under a different interval or mode", async ({ expected }) => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE),
			[block] = await state.saveBlocks(providerCheckpoint());
		if (!block) throw new Error("DYTEST block");
		await expect(state.loadBlock(block, expected)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(owned.values.has(key(block))).toBe(true);
		expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
	});

	it.each([{ kind: "root" as const }, { kind: "block" as const }])(
		"never resets a missing $kind to empty work",
		async ({ kind }) => {
			const owned = sdk(),
				state = createSlackSyncStore(owned.context, SCOPE);
			const ref =
				kind === "root"
					? await state.save(checkpoint())
					: (await state.saveBlocks(providerCheckpoint()))[0];
			if (!ref) throw new Error("DYTEST ref");
			owned.values.delete(key(ref));
			await expect(
				kind === "root" ? state.load(ref) : state.loadBlock(ref, BINDING),
			).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			await expect(
				kind === "root" ? state.release(ref) : state.releaseBlock(ref),
			).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			expect(owned.calls.map((call) => call.method)).toEqual([
				"host/kv.set",
				"host/kv.get",
				"host/kv.get",
			]);
		},
	);

	it.each([
		{ name: "null", value: null },
		{ name: "array", value: [] },
		{ name: "scalar", value: 42 },
		{ name: "wrong version", value: { ...envelope(SCOPE, checkpoint([])), v: 2 } },
		{
			name: "malformed work",
			value: envelope(SCOPE, checkpoint([{ kind: "other" } as unknown as SlackSyncWork])),
		},
		{ name: "extra field", value: { ...envelope(SCOPE, checkpoint([])), body: "DYTEST" } },
	])("retains and refuses corrupt present $name for both record kinds", async ({ value }) => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		const root = await state.save(checkpoint()),
			[block] = await state.saveBlocks(providerCheckpoint());
		if (!block) throw new Error("DYTEST block");
		for (const ref of [root, block]) owned.values.set(key(ref), value);
		await expect(state.load(root)).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await expect(state.release(root)).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await expect(state.loadBlock(block, BINDING)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		await expect(state.releaseBlock(block)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
		expect(owned.values.size).toBe(2);
	});

	it.each([{ kind: "root" as const }, { kind: "block" as const }])(
		"rehashes a well-typed same-scope $kind before load or release",
		async ({ kind }) => {
			const owned = sdk(),
				state = createSlackSyncStore(owned.context, SCOPE);
			const a = providerCheckpoint([{ kind: "info", channelId: "DYTEST-a" }]),
				b = providerCheckpoint([{ kind: "info", channelId: "DYTEST-b" }]);
			const refs =
				kind === "root"
					? [await state.save(a), await state.save(b)]
					: [...(await state.saveBlocks(a)), ...(await state.saveBlocks(b))];
			const [first, second] = refs;
			if (!first || !second) throw new Error("DYTEST refs");
			owned.values.set(key(first), structuredClone(owned.values.get(key(second))));
			await expect(
				kind === "root" ? state.load(first) : state.loadBlock(first, BINDING),
			).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			await expect(
				kind === "root" ? state.release(first) : state.releaseBlock(first),
			).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
		},
	);

	it("refuses real other-scope root and block releases without deleting either valid record", async () => {
		const owned = sdk(),
			first = createSlackSyncStore(owned.context, "DYTEST-a"),
			other = createSlackSyncStore(owned.context, "DYTEST-b");
		const root = await first.save(checkpoint()),
			[block] = await first.saveBlocks(providerCheckpoint());
		if (!block) throw new Error("DYTEST block");
		await expect(other.release(root)).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		await expect(other.releaseBlock(block)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		await expect(other.loadBlock(block, BINDING)).rejects.toMatchObject({
			result: { code: "TRANSIENT" },
		});
		expect(await first.load(root)).toEqual(checkpoint());
		expect(await first.loadBlock(block, BINDING)).toEqual(work());
		expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
	});

	it("verifies exact cells before explicit deletion and never traverses a root's block references", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE),
			[block] = await state.saveBlocks(providerCheckpoint());
		if (!block) throw new Error("DYTEST block");
		const root = await state.save(checkpoint([{ kind: "resume", block }])),
			next = await state.save(checkpoint([]));
		await state.release(root);
		expect(owned.calls.slice(-2).map((call) => [call.method, call.params.key])).toEqual([
			["host/kv.get", key(root)],
			["host/kv.delete", key(root)],
		]);
		expect(owned.values.has(key(block))).toBe(true);
		expect(owned.values.has(key(next))).toBe(true);
		await state.releaseBlock(block);
		expect(owned.calls.slice(-2).map((call) => [call.method, call.params.key])).toEqual([
			["host/kv.get", key(block)],
			["host/kv.delete", key(block)],
		]);
		expect(await state.load(next)).toEqual(checkpoint([]));
	});

	it("serializes mixed operations and captures every queued job before waiting", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE),
			jobs = work();
		const cursor = await state.save(checkpoint(jobs)),
			expected = structuredClone(jobs),
			held = owned.hold("host/kv.set");
		const saving = track(state.save(checkpoint(jobs))),
			blocks = track(state.saveBlocks(providerCheckpoint(jobs)));
		const loading = track(state.load(cursor)),
			releasing = track(state.release(cursor));
		const finished = track(Promise.all([saving, blocks, loading, releasing]));
		jobs.length = 0;
		await held.entered.promise;
		await turn();
		expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set", "host/kv.set"]);
		held.release.release();
		const [saved, refs, loaded] = await finished;
		expect(saved).toBe(cursor);
		expect(loaded).toEqual(checkpoint(expected));
		expect(refs).toHaveLength(1);
		expect(owned.calls.map((call) => call.method)).toEqual([
			"host/kv.set",
			"host/kv.set",
			"host/kv.set",
			"host/kv.get",
			"host/kv.get",
			"host/kv.delete",
		]);
		expect(await state.loadBlock(refs[0] as string, BINDING)).toEqual(expected);
	});

	it("does not return partial refs on a later block PUT failure and keeps the old checkpoint usable", async () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE),
			old = await state.save(checkpoint([]));
		const jobs: SlackProviderWork[] = Array.from({ length: 150 }, (_, at) => ({
			kind: "history",
			channelId: `${at}`,
			...position("D".repeat(4096)),
		}));
		owned.failAfter("host/kv.set", 1);
		let returned: readonly string[] | undefined;
		await expect(
			state.saveBlocks(providerCheckpoint(jobs)).then((refs) => {
				returned = refs;
			}),
		).rejects.toMatchObject({ message: "TRANSIENT", result: { code: "TRANSIENT" } });
		expect(returned).toBeUndefined();
		expect(owned.values.size).toBe(2);
		expect(await state.load(old)).toEqual(checkpoint([]));
		expect(owned.calls.filter((call) => call.method === "host/kv.delete")).toEqual([]);
		// The first unacknowledged block can remain; this backend is not a transaction.
		expect(owned.calls.filter((call) => call.method === "host/kv.set")).toHaveLength(3);
	});

	it.each([
		{ operation: "load" as const },
		{ operation: "release" as const },
		{ operation: "loadBlock" as const },
		{ operation: "releaseBlock" as const },
	])(
		"refuses $operation after a genuine SDK get completes but caller aborts before return",
		async ({ operation }) => {
			const owned = sdk(),
				initial = createSlackSyncStore(owned.context, SCOPE);
			const ref =
				operation === "load" || operation === "release"
					? await initial.save(checkpoint())
					: (await initial.saveBlocks(providerCheckpoint()))[0];
			if (!ref) throw new Error("DYTEST ref");
			const entered = gate(),
				released = gate(),
				original = owned.context.kv;
			const kv = {
				...original,
				async get(location: string) {
					const value = await original.get(location);
					entered.release();
					await released.promise;
					return value;
				},
			};
			const state = createSlackSyncStore({ kv, signal: owned.context.signal }, SCOPE);
			const result = track<unknown>(
				operation === "loadBlock" ? state.loadBlock(ref, BINDING) : state[operation](ref),
			);
			const refused = track(
				expect(result).rejects.toMatchObject({ result: { code: "TRANSIENT" } }),
			);
			await entered.promise;
			owned.shared.abort();
			released.release();
			await refused;
			expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set", "host/kv.get"]);
			expect(owned.values.has(key(ref))).toBe(true);
		},
	);

	it.each([{ operation: "save" as const }, { operation: "saveBlocks" as const }])(
		"returns no $operation result after an acknowledged SDK write is released following abort",
		async ({ operation }) => {
			const owned = sdk(),
				entered = gate(),
				released = gate(),
				original = owned.context.kv;
			const kv = {
				...original,
				async set(location: string, value: unknown) {
					await original.set(location, value);
					entered.release();
					await released.promise;
				},
			};
			const state = createSlackSyncStore({ kv, signal: owned.context.signal }, SCOPE);
			const result = track<unknown>(state[operation](providerCheckpoint()));
			const refused = track(
				expect(result).rejects.toMatchObject({ result: { code: "TRANSIENT" } }),
			);
			await entered.promise;
			expect(owned.values.size).toBe(1);
			owned.shared.abort();
			released.release();
			await refused;
			expect(owned.calls.map((call) => call.method)).toEqual(["host/kv.set"]);
		},
	);

	it("captures SDK-delegating methods and their receiver instead of later method replacements", async () => {
		const owned = sdk(),
			original = owned.context.kv,
			receivers: unknown[] = [];
		const kv: PluginContext["kv"] = {
			get: function (this: unknown, location: string) {
				receivers.push(this);
				return Reflect.apply(original.get, original, [location]);
			},
			set: function (this: unknown, location: string, value: unknown) {
				receivers.push(this);
				return Reflect.apply(original.set, original, [location, value]);
			},
			delete: function (this: unknown, location: string) {
				receivers.push(this);
				return Reflect.apply(original.delete, original, [location]);
			},
		};
		const state = createSlackSyncStore({ kv, signal: owned.context.signal }, SCOPE);
		kv.get = () => {
			throw new Error("DYTEST replaced get");
		};
		kv.set = () => {
			throw new Error("DYTEST replaced set");
		};
		kv.delete = () => {
			throw new Error("DYTEST replaced delete");
		};
		const root = await state.save(checkpoint());
		expect(await state.load(root)).toEqual(checkpoint());
		await state.release(root);
		const [block] = await state.saveBlocks(providerCheckpoint());
		if (!block) throw new Error("DYTEST block");
		expect(await state.loadBlock(block, BINDING)).toEqual(work());
		await state.releaseBlock(block);
		expect(receivers).toHaveLength(8);
		for (const receiver of receivers) expect(receiver).toBe(kv);
	});

	it("rejects malformed references, bindings and scopes before host I/O", () => {
		const owned = sdk(),
			state = createSlackSyncStore(owned.context, SCOPE);
		for (const ref of [
			"",
			`s1.${"a".repeat(63)}`,
			`s1.${"A".repeat(64)}`,
			`s1.${"a".repeat(64)}\n`,
		]) {
			expect(() => state.load(ref)).toThrow("INVALID_INPUT");
			expect(() => state.release(ref)).toThrow("INVALID_INPUT");
		}
		for (const ref of [
			"",
			`b1.${"a".repeat(63)}`,
			`b1.${"A".repeat(64)}`,
			`b1.${"a".repeat(64)}\n`,
		]) {
			expect(() => state.loadBlock(ref, BINDING)).toThrow("INVALID_INPUT");
			expect(() => state.releaseBlock(ref)).toThrow("INVALID_INPUT");
		}
		for (const scope of ["", "D".repeat(4097), "\ud800"])
			expect(() => createSlackSyncStore(owned.context, scope)).toThrow("INVALID_INPUT");
		const ref = `b1.${"a".repeat(64)}`;
		expect(() => state.loadBlock(ref, { mode: "delta", since: -1 })).toThrow("INVALID_INPUT");
		for (const cursor of ["", "D".repeat(4097), "A\n"])
			expect(() => digestSlackCursor(cursor)).toThrow("INVALID_INPUT");
		expect(owned.calls).toEqual([]);
	});
});
