import { access } from "node:fs/promises";
import { createFake, type Fake } from "@draftyak/fakes/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub } from "../src/mock-hub.ts";
import { bindProcessPlugin } from "../src/process.ts";
import type { MockCallOptions, MockHub } from "../src/types.ts";
import {
	bundleCallerInput,
	type CallerInputBundle,
} from "./fixtures/mock-hub-caller-input/bundle.ts";
import {
	CALLER_INPUT_ACCOUNT,
	CALLER_INPUT_ENTERED,
	CALLER_INPUT_URL,
	callerInputPlugin,
} from "./fixtures/mock-hub-caller-input/plugin.ts";

type Observation = Awaited<NonNullable<MockHub["process"]>["whenClosed"]>;
let packed: CallerInputBundle;
const hubs: MockHub[] = [];
const releases: (() => void)[] = [];
let parentCalls = 0;

beforeAll(async () => {
	packed = await bundleCallerInput();
}, 30_000);
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	const results = await Promise.allSettled(hubs.splice(0).map((hub) => hub.close()));
	expect(results.filter((result) => result.status === "rejected")).toEqual([]);
	expect(parentCalls).toBe(0);
});
afterAll(async () => {
	if (!packed) return;
	await packed.close();
	await expect(access(packed.files.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

function fixture(upstreams: readonly Fake[] = []): MockHub {
	const parent = callerInputPlugin(() => {
		parentCalls++;
		throw new Error("DYTEST parent handler called");
	});
	const hub = createMockHub({
		mode: "process",
		plugin: bindProcessPlugin(parent, packed.files),
		account: { id: CALLER_INPUT_ACCOUNT, mode: "full" },
		upstreams,
	});
	hubs.push(hub);
	return hub;
}
function processHandle(hub: MockHub): NonNullable<MockHub["process"]> {
	if (!hub.process) throw new Error("DYTEST expected process observations");
	return hub.process;
}
async function neverStarted(hub: MockHub): Promise<void> {
	await hub.close();
	const value = await processHandle(hub).whenClosed;
	expect(value.started).toBe(false);
	expect(value.originalExit.observed).toBe(false);
	expect(value.originalClose.observed).toBe(false);
	expect(value.stdio).toBeNull();
	expect(value.forcedSignals).toEqual([]);
}
function closedOriginal(value: Observation): void {
	expect(value.started).toBe(true);
	expect(value.originalExit.observed).toBe(true);
	expect(value.originalClose.observed).toBe(true);
	expect(value.stdio).not.toBeNull();
}
async function cancelEnteredProvider(reason?: unknown): Promise<void> {
	const entered = Promise.withResolvers<void>(),
		response = Promise.withResolvers<void>();
	releases.push(() => response.resolve());
	const provider = createFake(
		{
			async fetch(request) {
				if (request.url !== CALLER_INPUT_URL || request.method !== "GET")
					throw new Error("DYTEST unexpected provider request");
				entered.resolve();
				await response.promise;
				return new Response("DYTEST complete", { headers: { "content-type": "text/plain" } });
			},
		},
		{ host: "caller.draftyak.example" },
	);
	const hub = fixture([provider]),
		cancel = new AbortController();
	const running = hub.call("channel_probe", {}, {}, { signal: cancel.signal });
	const outcome = running.then(
		() => ({ code: "DYTEST unexpected success" }),
		(error: unknown) => error,
	);
	await entered.promise;
	expect(hub.host.logs.some((row) => row.message === CALLER_INPUT_ENTERED)).toBe(true);
	cancel.abort(reason);
	response.resolve();
	expect(await outcome).toMatchObject({ code: "DENIED" });
	await hub.close();
	closedOriginal(await processHandle(hub).whenClosed);
}

describe("MockHub caller input and process termination", () => {
	it.each(["plain", "null-prototype"] as const)(
		"accepts a native caller signal in %s own-data options",
		async (kind) => {
			const hub = fixture(),
				signal = new AbortController().signal;
			const options: MockCallOptions =
				kind === "plain" ? { signal } : Object.assign(Object.create(null), { signal });
			const result = await hub.call("channel_describe", {}, {}, options);
			expect(result.structuredContent).toEqual({
				channel: "chat",
				mutations: [],
				attachments: false,
				listen: false,
			});
			expect(Object.isFrozen(processHandle(hub))).toBe(true);
			expect(Object.keys(processHandle(hub)).sort()).toEqual(["endInput", "whenClosed"]);
		},
	);

	it("accepts a native composite with existing abort listeners without invoking them during capture", async () => {
		const hub = fixture(),
			source = new AbortController();
		const signal = AbortSignal.any([source.signal]);
		let callbacks = 0;
		const listener = (): void => {
			callbacks++;
		};
		signal.addEventListener("abort", listener);
		signal.onabort = () => {
			callbacks++;
		};
		try {
			const result = await hub.call("channel_describe", {}, {}, { signal });
			expect(result.structuredContent).toEqual({
				channel: "chat",
				mutations: [],
				attachments: false,
				listen: false,
			});
			expect(callbacks).toBe(0);
			source.abort();
			expect(callbacks).toBe(2);
		} finally {
			signal.removeEventListener("abort", listener);
			signal.onabort = null;
		}
	});

	it("reuses the same native caller signal across forty sequential completed process calls", async () => {
		const hub = fixture(),
			caller = new AbortController();
		for (let index = 0; index < 40; index++) {
			const result = await hub.call("channel_describe", {}, {}, { signal: caller.signal });
			expect(result.isError).not.toBe(true);
			expect(result.structuredContent).toEqual({
				channel: "chat",
				mutations: [],
				attachments: false,
				listen: false,
			});
		}
		expect(caller.signal.aborted).toBe(false);
		expect(parentCalls).toBe(0);
		await hub.close();
		closedOriginal(await processHandle(hub).whenClosed);
	});

	it.each(["iterator", "property-proxy"] as const)(
		"refuses poisoned composite %s DATA before invoking hooks or dispatching",
		async (kind) => {
			const hub = fixture(),
				source = new AbortController();
			const signal = AbortSignal.any([source.signal]);
			const keys = Object.getOwnPropertySymbols(signal).filter(
				(key) => key.description === "kSourceSignals",
			);
			const key = keys[0];
			if (keys.length !== 1 || !key) throw new Error("DYTEST native composite DATA unavailable");
			const original = Object.getOwnPropertyDescriptor(signal, key);
			if (!original || !("value" in original))
				throw new Error("DYTEST native composite descriptor unavailable");
			let hooks = 0;
			const poison =
				kind === "iterator"
					? {
							[Symbol.iterator]() {
								hooks++;
								return [][Symbol.iterator]();
							},
						}
					: new Proxy(original.value, {
							get(target, property) {
								hooks++;
								return Reflect.get(target, property, target);
							},
						});
			try {
				Object.defineProperty(signal, key, { ...original, value: poison });
				await expect(hub.call("channel_describe", {}, {}, { signal })).rejects.toMatchObject({
					code: "PROCESS_SIGNAL_INVALID",
				});
				expect(hooks).toBe(0);
				await neverStarted(hub);
			} finally {
				Object.defineProperty(signal, key, original);
			}
			expect(Object.getOwnPropertyDescriptor(signal, key)).toEqual(original);
		},
	);

	it("refuses a signal accessor without invoking it or starting a child", async () => {
		const hub = fixture();
		let hooks = 0;
		const options = Object.defineProperty({}, "signal", {
			enumerable: true,
			get() {
				hooks++;
				return new AbortController().signal;
			},
		});
		await expect(hub.call("channel_describe", {}, {}, options)).rejects.toMatchObject({
			code: "PROCESS_SIGNAL_INVALID",
		});
		expect(hooks).toBe(0);
		await neverStarted(hub);
	});

	it.each(["options", "signal"] as const)(
		"refuses the %s proxy without invoking its hooks",
		async (kind) => {
			const hub = fixture();
			let hooks = 0;
			const proxy = new Proxy(kind === "signal" ? new AbortController().signal : {}, {
				get() {
					hooks++;
					throw new Error("DYTEST proxy get invoked");
				},
				ownKeys() {
					hooks++;
					throw new Error("DYTEST proxy keys invoked");
				},
				getOwnPropertyDescriptor() {
					hooks++;
					throw new Error("DYTEST proxy descriptor invoked");
				},
			});
			const options = kind === "signal" ? { signal: proxy } : proxy;
			await expect(
				hub.call("channel_describe", {}, {}, options as MockCallOptions),
			).rejects.toMatchObject({
				code: kind === "signal" ? "PROCESS_SIGNAL_INVALID" : "PROCESS_PROGRESS_INVALID",
			});
			expect(hooks).toBe(0);
			await neverStarted(hub);
		},
	);

	it("refuses a signal-shaped object without reading its properties", async () => {
		const hub = fixture();
		let hooks = 0;
		const signal = Object.defineProperties(
			{},
			{
				aborted: {
					get() {
						hooks++;
						return false;
					},
				},
				addEventListener: {
					get() {
						hooks++;
						throw new Error("DYTEST signal hook invoked");
					},
				},
			},
		);
		await expect(
			hub.call("channel_describe", {}, {}, { signal } as unknown as MockCallOptions),
		).rejects.toMatchObject({ code: "PROCESS_SIGNAL_INVALID" });
		expect(hooks).toBe(0);
		await neverStarted(hub);
	});

	it("refuses shadowed native signal properties without invoking them", async () => {
		const hub = fixture(),
			signal = new AbortController().signal;
		let hooks = 0;
		Object.defineProperty(signal, "aborted", {
			get() {
				hooks++;
				throw new Error("DYTEST shadowed signal read");
			},
		});
		await expect(hub.call("channel_describe", {}, {}, { signal })).rejects.toMatchObject({
			code: "PROCESS_SIGNAL_INVALID",
		});
		expect(hooks).toBe(0);
		await neverStarted(hub);
	});

	it("refuses an already-aborted caller before child startup", async () => {
		const hub = fixture(),
			cancel = new AbortController();
		cancel.abort();
		await expect(
			hub.call("channel_describe", {}, {}, { signal: cancel.signal }),
		).rejects.toMatchObject({ code: "PROCESS_CALL_ABORTED" });
		expect(hub.host.logs).toEqual([]);
		await neverStarted(hub);
	});

	it("cancels an actually entered child request and joins its original process", async () => {
		await cancelEnteredProvider();
	});

	it("does not inspect the caller's abort reason while canceling an entered provider request", async () => {
		let hooks = 0;
		const reason = new Proxy(
			{},
			{
				getPrototypeOf() {
					hooks++;
					return Object.prototype;
				},
				get() {
					hooks++;
					return undefined;
				},
			},
		);
		await cancelEnteredProvider(reason);
		expect(hooks).toBe(0);
	});

	it("observes natural input EOF independently from exit, close and physical drains", async () => {
		const hub = fixture();
		await hub.call("channel_describe", {});
		const handle = processHandle(hub);
		const value = await handle.endInput();
		closedOriginal(value);
		expect(await handle.whenClosed).toEqual(value);
		expect(value.outputEnd).toEqual([true, true]);
		expect(value.inputEndRequested).toBe(true);
		expect(value.inputFinished).toBe(true);
		expect(value.kind).toBe(process.platform === "win32" ? "pipe" : "fifo");
		expect(value.originalExit).toMatchObject({ code: 0, signal: null });
		expect(value.originalClose).toMatchObject({ code: 0, signal: null });
		expect(value.stdio?.error).toBeNull();
		expect(value.stdio?.drains.map((drain) => drain.result)).toEqual(["eof", "eof"]);
		expect(value.forcedSignals).toEqual([]);
		await expect(hub.call("channel_describe", {})).rejects.toBeInstanceOf(Error);
	});

	it("reports forced cleanup without relabeling it as requested input EOF", async () => {
		const hub = fixture();
		await hub.call("channel_describe", {});
		await hub.close();
		const value = await processHandle(hub).whenClosed;
		closedOriginal(value);
		expect(value.inputEndRequested).toBe(false);
		expect(value.forcedSignals.length).toBeGreaterThan(0);
	});

	it("seals a never-started process before issuing its final observation", async () => {
		const hub = fixture(),
			handle = processHandle(hub);
		const value = await handle.endInput();
		expect(value.started).toBe(false);
		expect(value.originalExit.observed).toBe(false);
		expect(value.originalClose.observed).toBe(false);
		expect(value.outputEnd).toEqual([false, false]);
		expect(value.stdio).toBeNull();
		expect(value.forcedSignals).toEqual([]);
		await expect(hub.call("channel_describe", {})).rejects.toBeInstanceOf(Error);
		expect(await handle.whenClosed).toEqual(value);
	});
});
