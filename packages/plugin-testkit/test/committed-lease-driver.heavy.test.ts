import { access } from "node:fs/promises";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { createFake } from "@draftyak/fakes/server";
import type { HostMethod, HostMethods } from "@draftyak/protocol/host-channel";
import type { HostRequestOptions } from "@draftyak/sdk/host";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMockHub } from "../src/mock-hub.ts";
import { createMockSocketUpstream } from "../src/mock-socket-upstream.ts";
import { bindProcessPlugin } from "../src/process.ts";
import type { MockCallOptions, MockHub } from "../src/types.ts";
import {
	bundleCommittedLease,
	type CommittedLeaseBundle,
} from "./fixtures/committed-lease-driver/bundle.ts";
import {
	committedLeasePlugin,
	LEASE_ACCOUNT,
	LEASE_KV_ALLOWED,
	LEASE_KV_DENIED,
	LEASE_PROBE_ENTERED,
	LEASE_URL,
	type LeaseScenario,
} from "./fixtures/committed-lease-driver/plugin.ts";

const FIRST = "00000000-0000-4000-8000-000000000201";
const SECOND = "00000000-0000-4000-8000-000000000202";
interface Backend {
	onData(data: string): void;
	readonly signal: AbortSignal;
	readonly closed: PromiseWithResolvers<void>;
	readonly closeEntered: PromiseWithResolvers<void>;
	closeCalls: number;
}
interface State {
	readonly hub: MockHub;
	readonly backends: Backend[];
	readonly acks: string[];
	readonly changed: string[][];
	readonly acceptedKv: string[];
	readonly probeEntered: Promise<void>;
	readonly ackGate: PromiseWithResolvers<void>;
	readonly ackWaiters: Map<string, PromiseWithResolvers<void>>;
	readonly changedWaiters: PromiseWithResolvers<void>[];
	readonly holdClosed: boolean;
}
let packed: CommittedLeaseBundle;
const states: State[] = [];
let parentCalls = 0;

beforeAll(async () => {
	packed = await bundleCommittedLease();
}, 30_000);
afterEach(async () => {
	for (const state of states) {
		state.ackGate.resolve();
		for (const backend of state.backends) backend.closed.resolve();
	}
	const results = await Promise.allSettled(states.splice(0).map((state) => state.hub.close()));
	vi.restoreAllMocks();
	expect(results.filter((result) => result.status === "rejected")).toEqual([]);
	expect(parentCalls).toBe(0);
});
afterAll(async () => {
	if (!packed) return;
	await packed.close();
	await expect(access(packed.files.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

function processHandle(hub: MockHub): NonNullable<MockHub["process"]> {
	if (!hub.process) throw new Error("DYTEST expected process observations");
	return hub.process;
}
function fixture(
	scenario: LeaseScenario = "normal",
	options: { readonly holdAck?: boolean; readonly holdClosed?: boolean } = {},
): State {
	const backends: Backend[] = [],
		acks: string[] = [],
		changed: string[][] = [],
		acceptedKv: string[] = [];
	const ackGate = Promise.withResolvers<void>(),
		probeEntered = Promise.withResolvers<void>();
	const ackWaiters = new Map<string, PromiseWithResolvers<void>>();
	const changedWaiters: PromiseWithResolvers<void>[] = [];
	if (!options.holdAck) ackGate.resolve();
	const http = createFake(
		{
			fetch() {
				throw new Error("DYTEST unexpected HTTP request");
			},
		},
		{ host: "slack.com" },
	);
	const upstream = createMockSocketUpstream(http, {
		url: LEASE_URL,
		open({ signal, onData }) {
			const closed = Promise.withResolvers<void>(),
				closeEntered = Promise.withResolvers<void>();
			const backend: Backend = { onData, signal, closed, closeEntered, closeCalls: 0 };
			backends.push(backend);
			return {
				async ack(envelopeId) {
					acks.push(envelopeId);
					ackWaiters.get(envelopeId)?.resolve();
					await ackGate.promise;
				},
				close() {
					backend.closeCalls++;
					closeEntered.resolve();
					if (!options.holdClosed) closed.resolve();
				},
				closed: closed.promise,
			};
		},
	});
	const parent = committedLeasePlugin(() => {
		parentCalls++;
		throw new Error("DYTEST parent handler called");
	});
	const hub = createMockHub({
		mode: "process",
		plugin: bindProcessPlugin(
			parent,
			Object.freeze({ ...packed.files, args: Object.freeze([scenario]) }),
		),
		account: { id: LEASE_ACCOUNT, mode: "full" },
		instance: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", config: {} },
		upstreams: [http],
		socketUpstreams: [upstream],
	});
	const original = hub.host.request.bind(hub.host);
	vi.spyOn(hub.host, "request").mockImplementation(
		async <M extends HostMethod>(
			method: M,
			params: HostMethods[M]["params"],
			requestOptions?: HostRequestOptions,
		): Promise<HostMethods[M]["result"]> => {
			const result = await original(method, params, requestOptions);
			if (method === "host/changed") {
				changed.push([...acks]);
				for (const waiter of changedWaiters.splice(0)) waiter.resolve();
			}
			if (method === "host/kv.set")
				acceptedKv.push((params as HostMethods["host/kv.set"]["params"]).key);
			if (
				method === "host/log" &&
				(params as HostMethods["host/log"]["params"]).message === LEASE_PROBE_ENTERED
			)
				probeEntered.resolve();
			return result;
		},
	);
	const state = {
		hub,
		backends,
		acks,
		changed,
		acceptedKv,
		probeEntered: probeEntered.promise,
		ackGate,
		ackWaiters,
		changedWaiters,
		holdClosed: options.holdClosed === true,
	};
	states.push(state);
	return state;
}
function firstBackend(state: State): Backend {
	const backend = state.backends[0];
	if (!backend) throw new Error("DYTEST expected actual backend open");
	return backend;
}
async function listen(state: State, leaseMs = 5_000, options?: MockCallOptions): Promise<void> {
	const result = await state.hub.call("channel_listen", { leaseMs }, {}, options);
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toEqual({ leaseMs });
}
function send(state: State, envelopeId: string): void {
	firstBackend(state).onData(JSON.stringify({ action: "ack", envelopeId }));
}
async function actualAck(state: State, envelopeId: string): Promise<void> {
	const waiter = state.ackWaiters.get(envelopeId) ?? Promise.withResolvers<void>();
	state.ackWaiters.set(envelopeId, waiter);
	if (state.acks.includes(envelopeId)) waiter.resolve();
	const outcome = await Promise.race([
		waiter.promise.then(() => "ack"),
		processHandle(state.hub).whenClosed.then(
			() => "closed",
			() => "closed",
		),
	]);
	expect(outcome).toBe("ack");
}
async function actualChanged(state: State, count: number): Promise<void> {
	if (state.changed.length >= count) return;
	const waiter = Promise.withResolvers<void>();
	state.changedWaiters.push(waiter);
	const outcome = await Promise.race([
		waiter.promise.then(() => "changed"),
		processHandle(state.hub).whenClosed.then(
			() => "closed",
			() => "closed",
		),
	]);
	expect(outcome).toBe("changed");
	expect(state.changed).toHaveLength(count);
}

describe("Committed channel-listen process ownership", () => {
	it("forwards an owned ACK and changed after the originating RPC has returned", async () => {
		const state = fixture();
		await listen(state);
		expect(state.acceptedKv).toEqual(["DYTEST-during-origin"]);
		send(state, FIRST);
		await actualAck(state, FIRST);
		await actualChanged(state, 1);
		expect(state.changed).toEqual([[FIRST]]);
		expect(firstBackend(state).signal.aborted).toBe(false);
	});

	it("keeps a committed lease independent from its initial caller's later abort", async () => {
		const state = fixture(),
			caller = new AbortController();
		await listen(state, 5_000, { signal: caller.signal });
		caller.abort();
		send(state, FIRST);
		await actualAck(state, FIRST);
		await actualChanged(state, 1);
		expect(firstBackend(state).closeCalls).toBe(0);
		expect(firstBackend(state).signal.aborted).toBe(false);
	});

	it("refuses unrelated KV work while retaining only the committed socket operations", async () => {
		const state = fixture();
		await listen(state);
		const acknowledged = Promise.withResolvers<void>();
		state.ackWaiters.set(LEASE_KV_DENIED, acknowledged);
		state.ackWaiters.set(LEASE_KV_ALLOWED, acknowledged);
		firstBackend(state).onData(JSON.stringify({ action: "kv" }));
		const outcome = await Promise.race([
			acknowledged.promise.then(() => "ack"),
			processHandle(state.hub).whenClosed.then(
				() => "closed",
				() => "unqualified",
			),
		]);
		expect(outcome).toBe("ack");
		expect(state.acks).toEqual([LEASE_KV_DENIED]);
		expect(state.acceptedKv).toEqual(["DYTEST-during-origin"]);
	});

	it("refuses a schema-valid lease result exceeding its actual originating request", async () => {
		const state = fixture("overlong");
		await state.hub.call("channel_describe", {});
		await expect(state.hub.call("channel_listen", { leaseMs: 1_000 })).rejects.toMatchObject({
			code: "PROCESS_LEASE_REFUSED",
		});
		expect(state.backends).toHaveLength(1);
		await firstBackend(state).closeEntered.promise;
		expect(state.acks).toEqual([]);
	});

	it("does not promote a valid lease payload marked as an actual error response", async () => {
		const state = fixture("error-flag");
		const result = await state.hub.call("channel_listen", { leaseMs: 5_000 });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({ leaseMs: 5_000 });
		expect(state.backends).toHaveLength(1);
		await firstBackend(state).closeEntered.promise;
		expect(state.acks).toEqual([]);
	});

	it("does not grant background authority to a socket opened by another RPC operation", async () => {
		const state = fixture("probe-open");
		expect((await state.hub.call("channel_probe", {})).structuredContent).toEqual({ status: "ok" });
		expect(state.backends).toHaveLength(1);
		send(state, FIRST);
		const ack = Promise.withResolvers<void>();
		state.ackWaiters.set(FIRST, ack);
		if (state.acks.includes(FIRST)) ack.resolve();
		const result = await Promise.race([
			ack.promise.then(() => "ack"),
			processHandle(state.hub).whenClosed.then(
				() => "closed",
				() => "unqualified",
			),
		]);
		expect(result).toBe("closed");
		expect((await processHandle(state.hub).whenClosed).originalExit).toMatchObject({
			observed: true,
			code: 23,
			signal: null,
		});
		expect(state.acks).toEqual([]);
		expect(state.changed).toEqual([]);
	});

	it("keeps a maximum-duration committed lease usable beyond the originating RPC budget", async () => {
		const state = fixture();
		await listen(state, 600_000);
		const backend = firstBackend(state),
			watchdog = new AbortController();
		try {
			const result = await Promise.race([
				backend.closed.promise.then(() => "closed"),
				delay(30_100, undefined, { signal: watchdog.signal }).then(() => "deadline"),
			]);
			expect(result).toBe("deadline");
			expect(backend.signal.aborted).toBe(false);
			send(state, FIRST);
			await actualAck(state, FIRST);
			await actualChanged(state, 1);
			expect(state.changed).toEqual([[FIRST]]);
			expect(backend.closeCalls).toBe(0);
		} finally {
			watchdog.abort();
		}
	});

	it("keeps an older owned ACK independent from an overlapping ordinary RPC", async () => {
		const state = fixture("probe-held", { holdAck: true });
		await listen(state);
		const probe = state.hub.call("channel_probe", {});
		await state.probeEntered;
		send(state, FIRST);
		await actualAck(state, FIRST);
		firstBackend(state).onData(JSON.stringify({ action: "release-probe" }));
		expect((await probe).structuredContent).toEqual({ status: "ok" });
		expect(firstBackend(state).signal.aborted).toBe(false);
		expect(firstBackend(state).closeCalls).toBe(0);
		state.ackGate.resolve();
		await actualChanged(state, 1);
		send(state, SECOND);
		await actualAck(state, SECOND);
		await actualChanged(state, 2);
	});

	it("transfers the same socket while an earlier admitted ACK settles under its original owner", async () => {
		const state = fixture("normal", { holdAck: true });
		await state.hub.call("channel_describe", {});
		const started = performance.now();
		await listen(state, 1_000);
		send(state, FIRST);
		await actualAck(state, FIRST);
		await listen(state, 3_000);
		expect(state.backends).toHaveLength(1);
		state.ackGate.resolve();
		await actualChanged(state, 1);
		await delay(Math.max(0, started + 1_100 - performance.now()));
		send(state, SECOND);
		await actualAck(state, SECOND);
		await actualChanged(state, 2);
		expect(firstBackend(state).closeCalls).toBe(0);
	});

	it("keeps older owned work runnable when a later RPC caller is canceled", async () => {
		const state = fixture("probe-held", { holdAck: true });
		await listen(state);
		const caller = new AbortController();
		const probe = state.hub.call("channel_probe", {}, {}, { signal: caller.signal });
		const outcome = probe.then(
			() => ({ code: "DYTEST unexpected success" }),
			(error: unknown) => error,
		);
		await state.probeEntered;
		send(state, FIRST);
		await actualAck(state, FIRST);
		caller.abort();
		expect(await outcome).toMatchObject({ code: "DENIED" });
		expect(firstBackend(state).signal.aborted).toBe(false);
		expect(firstBackend(state).closeCalls).toBe(0);
		state.ackGate.resolve();
		await actualChanged(state, 1);
		send(state, SECOND);
		await actualAck(state, SECOND);
		await actualChanged(state, 2);
	});

	it("does not refresh an admitted ACK's original deadline when its socket is renewed", async () => {
		const state = fixture("normal", { holdAck: true });
		await state.hub.call("channel_describe", {});
		const started = performance.now();
		await listen(state, 1_000);
		send(state, FIRST);
		await actualAck(state, FIRST);
		await listen(state, 3_000);
		expect(state.backends).toHaveLength(1);
		const watchdog = new AbortController();
		try {
			const result = await Promise.race([
				processHandle(state.hub).whenClosed.then((observation) => ({
					kind: "closed",
					observation,
				})),
				delay(Math.max(0, started + 1_600 - performance.now()), undefined, {
					signal: watchdog.signal,
				}).then(() => ({ kind: "deadline", observation: undefined })),
			]);
			expect(result.kind).toBe("closed");
			expect(result.observation?.originalExit).toMatchObject({
				observed: true,
				code: 23,
				signal: null,
			});
			expect(result.observation?.originalClose.observed).toBe(true);
			expect(state.changed).toEqual([]);
		} finally {
			watchdog.abort();
			state.ackGate.resolve();
		}
	});

	it("retains expired socket capacity until the actual backend termination witnesses settle", async () => {
		const state = fixture("capacity", { holdClosed: true });
		await state.hub.call("channel_describe", {});
		await listen(state, 1_000);
		expect(state.backends).toHaveLength(16);
		await Promise.all(state.backends.map((backend) => backend.closeEntered.promise));
		const refused = await state.hub.call("channel_listen", { leaseMs: 1_000 });
		expect(refused.isError).toBe(true);
		expect(state.backends).toHaveLength(16);
		expect(state.backends.every((backend) => backend.closeCalls === 1)).toBe(true);
	});

	it("joins owned backend termination and pending ACK work after ending process input", async () => {
		const state = fixture("normal", { holdAck: true, holdClosed: true });
		await listen(state);
		send(state, FIRST);
		await actualAck(state, FIRST);
		const handle = processHandle(state.hub);
		const ended = handle.endInput();
		await firstBackend(state).closeEntered.promise;
		const observation = await ended;
		expect(observation.inputEndRequested).toBe(true);
		expect(observation.originalExit).toMatchObject({ observed: true, code: 0, signal: null });
		expect(observation.originalClose).toMatchObject({ observed: true, code: 0, signal: null });
		expect(observation.outputEnd).toEqual([true, true]);
		expect(observation.stdio?.error).toBeNull();
		expect(observation.stdio?.drains.map((drain) => drain.result)).toEqual(["eof", "eof"]);
		expect(observation.forcedSignals).toEqual([]);
		let joined = false;
		const close = state.hub.close().then(() => {
			joined = true;
		});
		firstBackend(state).closed.resolve();
		await nextTurn();
		expect(joined).toBe(false);
		state.ackGate.resolve();
		await close;
		expect(joined).toBe(true);
	});
});
