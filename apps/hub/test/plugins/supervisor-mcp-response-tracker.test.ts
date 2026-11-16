import { setImmediate as turn } from "node:timers/promises";
import {
	Client,
	InMemoryTransport,
	type JSONRPCMessage,
	type MessageExtraInfo,
	parseJSONRPCMessage,
	type Transport,
} from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPluginResponseTracker,
	PluginResponseError,
} from "../../src/plugins/supervisor/mcp-response-tracker.ts";

type Tracker = ReturnType<typeof createPluginResponseTracker>;
type Receipt = NonNullable<ReturnType<Tracker["trackOutgoing"]>>;
type State = "pending" | "fulfilled" | "rejected";
interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly state: State;
	resolve(value: T): void;
	reject(reason: unknown): void;
}
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	let state: State = "pending";
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void Promise.allSettled([promise]);
	return {
		promise,
		get state() {
			return state;
		},
		resolve(value) {
			if (state === "pending") {
				state = "fulfilled";
				resolve(value);
			}
		},
		reject(reason) {
			if (state === "pending") {
				state = "rejected";
				reject(reason);
			}
		},
	};
}
function observe<T>(original: Promise<T>): Promise<T> {
	void Promise.allSettled([original]);
	return original;
}
function status(original: Promise<unknown>): () => State {
	let state: State = "pending";
	observe(
		original.then(
			() => {
				state = "fulfilled";
			},
			() => {
				state = "rejected";
			},
		),
	);
	return () => state;
}
function fixed(error: unknown): void {
	expect(error).toBeInstanceOf(PluginResponseError);
	if (!(error instanceof PluginResponseError)) throw new Error("Expected response tracker refusal");
	expect(error.name).toBe("PluginResponseError");
	expect(error.code).toBe("PLUGIN_RESPONSE_UNAVAILABLE");
	expect(error.message).toBe("Plugin response unavailable");
	expect("cause" in error).toBe(false);
}
function throwsFixed(action: () => unknown): void {
	let error: unknown;
	try {
		action();
	} catch (caught) {
		error = caught;
	}
	fixed(error);
}
async function rejectsFixed(result: Promise<PromiseSettledResult<unknown>[]>): Promise<void> {
	const values = await result;
	expect(values[0]?.status).toBe("rejected");
	if (values[0]?.status !== "rejected") throw new Error("Expected rejected tracker promise");
	fixed(values[0].reason);
}
const request = (id: string | number) =>
	parseJSONRPCMessage({
		jsonrpc: "2.0",
		id,
		method: "tools/list",
		params: {},
	});
const reply = (id: string | number) =>
	parseJSONRPCMessage({
		jsonrpc: "2.0",
		id,
		result: { DYTEST: true },
	});
interface Unit {
	readonly end: Deferred<void>;
	readonly tracker: Tracker;
	readonly receipts: Receipt[];
	track(raw: unknown): Receipt;
	retire(): Promise<void>;
	finish(): Promise<void>;
}
const units = new Set<Unit>();
const sdks = new Set<SdkFixture>();
const bodies = new Set<Promise<unknown>>();
let tearingDown = false;
function unit(): Unit {
	if (tearingDown) throw new Error("Test cleanup already started");
	const end = deferred<void>();
	const tracker = createPluginResponseTracker(end.promise);
	const receipts: Receipt[] = [];
	const result: Unit = {
		end,
		tracker,
		receipts,
		track(raw) {
			const receipt = tracker.trackOutgoing(raw);
			if (!receipt) throw new Error("Expected an actual request receipt");
			observe(receipt.response);
			receipts.push(receipt);
			return receipt;
		},
		retire: () => observe(tracker.retire()),
		async finish() {
			tracker.fence();
			end.resolve(undefined);
			const retiring = observe(tracker.retire());
			const results = await Promise.allSettled([end.promise, retiring]);
			// An unknown rejected producer cannot be converted into known terminal cleanup.
			if (end.state !== "rejected") {
				await Promise.allSettled(receipts.map((receipt) => receipt.response));
				expect(results[1]?.status).toBe("fulfilled");
				if (results[1]?.status === "rejected") throw results[1].reason;
			}
		},
	};
	units.add(result);
	return result;
}
interface HeldRead {
	readonly seen: Deferred<void>;
	readonly release: Deferred<void>;
	captured: boolean;
}
class SdkFixture {
	readonly handlerEntered = deferred<void>();
	readonly handlerRelease = deferred<void>();
	readonly transportClosed = deferred<void>();
	readonly triggerClose = deferred<void>();
	readonly tracker: Tracker;
	readonly originalRetired: Promise<void>;
	readonly originals = new Set<Promise<unknown>>();
	readonly reads = new Set<Promise<unknown>>();
	readonly receipts: Receipt[] = [];
	readonly responses: Array<string | number> = [];
	readonly heldReads: HeldRead[] = [];
	readonly closeFailures: unknown[] = [];
	readonly readFailures: unknown[] = [];
	client: Client | undefined;
	server: Server | undefined;
	adapter: StdioServerHandle | undefined;
	clientWire: Transport | undefined;
	serverWire: Transport | undefined;
	handlerOriginal: Promise<unknown> | undefined;
	serverSignal: AbortSignal | undefined;
	toolReceipt: Receipt | undefined;
	closing: Promise<void> | undefined;
	private hold: HeldRead | undefined;

	constructor() {
		// This original producer combines actual logical closes and every owned read suffix.
		// The fixture does not represent an OS process, descriptor, or Native lifetime.
		this.originalRetired = this.own(
			Promise.resolve().then(async () => {
				await this.triggerClose.promise;
				const closes: Promise<unknown>[] = [];
				for (const object of [
					this.adapter,
					this.client,
					this.server,
					this.clientWire,
					this.serverWire,
				]) {
					if (!object) continue;
					try {
						closes.push(this.own(object.close()));
					} catch (error) {
						this.closeFailures.push(error);
					}
				}
				const results = await Promise.allSettled(closes);
				for (const result of results)
					if (result.status === "rejected") this.closeFailures.push(result.reason);
				this.transportClosed.resolve(undefined);
				await this.join(this.reads);
				if (this.closeFailures.length || this.readFailures.length)
					throw new Error("Logical transport cleanup failed");
			}),
		);
		this.tracker = createPluginResponseTracker(this.originalRetired);
	}
	private own<T>(original: Promise<T>): Promise<T> {
		this.originals.add(original);
		return observe(original);
	}
	private async join(tasks: Set<Promise<unknown>>): Promise<void> {
		let size = -1;
		while (size !== tasks.size) {
			const originals = [...tasks];
			size = originals.length;
			await Promise.allSettled(originals);
		}
	}
	start(): Promise<void> {
		const original = Promise.resolve().then(async () => {
			if (tearingDown || this.triggerClose.state !== "pending")
				throw new Error("Logical fixture already closing");
			const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
			this.clientWire = clientWire;
			this.serverWire = serverWire;
			const send = clientWire.send;
			clientWire.send = (message, options) => {
				const receipt = this.tracker.trackOutgoing(message);
				if (receipt) {
					observe(receipt.response);
					this.receipts.push(receipt);
					if ("method" in message && message.method === "tools/call") this.toolReceipt = receipt;
				}
				return this.own(Reflect.apply(send, clientWire, [message, options]));
			};
			let receiver: Transport["onmessage"];
			Object.defineProperty(clientWire, "onmessage", {
				configurable: true,
				get: () =>
					receiver
						? (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
								const originalReceiver = receiver;
								const hold =
									!("method" in message) && "id" in message && this.hold && !this.hold.captured
										? this.hold
										: undefined;
								if (hold) {
									hold.captured = true;
									hold.seen.resolve(undefined);
								}
								const read = Promise.resolve().then(async () => {
									if (hold) await hold.release.promise;
									if (
										!("method" in message) &&
										"id" in message &&
										(typeof message.id === "string" || typeof message.id === "number")
									)
										this.responses.push(message.id);
									try {
										this.tracker.receiveIncoming(message);
									} finally {
										if (originalReceiver)
											Reflect.apply(originalReceiver, clientWire, [message, extra]);
									}
								});
								this.reads.add(read);
								this.own(read);
								this.own(
									read.then(
										() => {},
										(error) => {
											this.readFailures.push(error);
										},
									),
								);
							}
						: undefined,
				set: (listener: Transport["onmessage"]) => {
					receiver = listener;
				},
			});
			this.client = new Client(
				{ name: "DYTEST_tracker_client", version: "0.0.0" },
				{ versionNegotiation: { mode: "auto" }, supportedProtocolVersions: ["2026-07-28"] },
			);
			this.server = new Server(
				{ name: "DYTEST_tracker_server", version: "0.0.0" },
				{
					supportedProtocolVersions: ["2026-07-28"],
					capabilities: { tools: { listChanged: false } },
				},
			);
			this.server.setRequestHandler("tools/list", async () => ({
				tools: [
					{
						name: "DYTEST_tracker",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
				resultType: "complete",
			}));
			this.server.setRequestHandler("tools/call", (_request, context) => {
				this.serverSignal = context.mcpReq.signal;
				const originalHandler = Promise.resolve().then(async () => {
					this.handlerEntered.resolve(undefined);
					await this.handlerRelease.promise;
					return { content: [{ type: "text" as const, text: "DYTEST_tracker_result" }] };
				});
				this.handlerOriginal = this.own(originalHandler);
				return originalHandler;
			});
			const server = this.server;
			this.adapter = serveStdio(() => server, { legacy: "reject", transport: serverWire });
			await this.own(this.client.connect(clientWire));
		});
		return this.own(original);
	}
	waitFor(event: Promise<void>, originalCall: Promise<unknown>): Promise<void> {
		// Failed observation is not an entry, read, or retirement receipt.
		const endedCall = this.own(
			originalCall.then(
				() => {
					throw new Error("SDK call ended before the expected observation");
				},
				() => {
					throw new Error("SDK call ended before the expected observation");
				},
			),
		);
		const endedTransport = this.own(
			this.transportClosed.promise.then(() => {
				throw new Error("Transport closed before the expected observation");
			}),
		);
		return this.own(Promise.race([event, endedCall, endedTransport]));
	}
	call(signal?: AbortSignal): Promise<unknown> {
		if (!this.client) throw new Error("Expected an actual connected client");
		return this.own(
			this.client.callTool(
				{ name: "DYTEST_tracker", arguments: {} },
				signal ? { signal } : undefined,
			),
		);
	}
	receipt(): Receipt {
		if (!this.toolReceipt) throw new Error("Expected an actual outgoing tools/call ID");
		return this.toolReceipt;
	}
	holdNextReply(): HeldRead {
		const hold = { seen: deferred<void>(), release: deferred<void>(), captured: false };
		this.heldReads.push(hold);
		this.hold = hold;
		return hold;
	}
	startRetirement(): Promise<void> {
		const original = observe(this.tracker.retire());
		this.triggerClose.resolve(undefined);
		return original;
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closing = Promise.resolve().then(async () => {
			let retiring: Promise<void>;
			try {
				retiring = observe(this.tracker.retire());
			} catch (error) {
				retiring = observe(Promise.reject(error));
			}
			const results = await Promise.allSettled([this.originalRetired, retiring]);
			await this.join(this.originals);
			if (
				results.some((result) => result.status === "rejected") ||
				this.closeFailures.length ||
				this.readFailures.length
			)
				throw new Error("Logical fixture cleanup failed");
		});
		observe(this.closing);
		// Cancel first so cleanup can settle an original body waiting on real SDK work.
		try {
			this.tracker.fence();
		} catch (error) {
			this.closeFailures.push(error);
		}
		this.handlerRelease.resolve(undefined);
		for (const hold of this.heldReads) hold.release.resolve(undefined);
		this.triggerClose.resolve(undefined);
		return this.closing;
	}
}
async function sdk(): Promise<SdkFixture> {
	if (tearingDown) throw new Error("Test cleanup already started");
	const result = new SdkFixture();
	sdks.add(result);
	await result.start();
	return result;
}
function test(name: string, body: () => void | Promise<void>): void {
	it(name, () => {
		const original = Promise.resolve().then(body);
		bodies.add(original);
		return observe(original);
	});
}
beforeEach(() => {
	tearingDown = false;
});
afterEach(async () => {
	tearingDown = true;
	const cleanups = [...sdks].map((fixture) => fixture.close());
	cleanups.push(...[...units].map((fixture) => fixture.finish()));
	await Promise.allSettled([...bodies]);
	const results = await Promise.allSettled(cleanups);
	sdks.clear();
	units.clear();
	bodies.clear();
	for (const result of results) {
		expect(result.status).toBe("fulfilled");
		if (result.status === "rejected") throw result.reason;
	}
});

describe("plugin MCP response tracker", () => {
	test("keeps numeric zero and string zero as distinct frozen metadata-only receipts", async () => {
		const h = unit();
		const numeric = h.track(request(0));
		const textual = h.track(request("0"));
		const numericState = status(numeric.response);
		const textualState = status(textual.response);
		expect(Object.isFrozen(numeric)).toBe(true);
		expect(Object.keys(numeric).sort()).toEqual(["id", "response"]);
		expect(numeric.id).toBe(0);
		expect(textual.id).toBe("0");
		expect(h.tracker.receiveIncoming(reply("0"))).toBe(true);
		await turn();
		expect(textualState()).toBe("fulfilled");
		expect(numericState()).toBe("pending");
		expect(await textual.response).toBeUndefined();
		expect(h.tracker.receiveIncoming(reply(0))).toBe(true);
		expect(await numeric.response).toBeUndefined();
	});
	test("does not treat reverse requests or notifications with colliding IDs as responses", async () => {
		const h = unit();
		const receipt = h.track(request(7));
		const state = status(receipt.response);
		expect(
			h.tracker.trackOutgoing(
				parseJSONRPCMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
			),
		).toBeUndefined();
		expect(h.tracker.trackOutgoing(reply(7))).toBeUndefined();
		expect(
			h.tracker.receiveIncoming(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id: 7,
					method: "roots/list",
					params: {},
				}),
			),
		).toBe(false);
		expect(
			h.tracker.receiveIncoming(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: 7, progress: 1 },
				}),
			),
		).toBe(false);
		await turn();
		expect(state()).toBe("pending");
		expect(h.tracker.receiveIncoming(reply(7))).toBe(true);
		await receipt.response;
	});
	test("refuses an active duplicate while preserving the original and allowing settled-ID reuse", async () => {
		const h = unit();
		const first = h.track(request("DYTEST_id"));
		throwsFixed(() => h.tracker.trackOutgoing(request("DYTEST_id")));
		expect(h.tracker.receiveIncoming(reply("DYTEST_id"))).toBe(true);
		await first.response;
		const next = h.track(request("DYTEST_id"));
		expect(next.response).not.toBe(first.response);
		expect(h.tracker.receiveIncoming(reply("DYTEST_id"))).toBe(true);
		await next.response;
	});
	test("admits sixty-four active requests and releases one actual slot before a valid neighbor", async () => {
		const h = unit();
		const first = h.track(request(0));
		const firstState = status(first.response);
		const uncorrelated = parseJSONRPCMessage({
			jsonrpc: "2.0",
			error: { code: -32603, message: "DYTEST_uncorrelated" },
		});
		expect(uncorrelated).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 } });
		expect("id" in uncorrelated ? uncorrelated.id : undefined).toBeUndefined();
		expect(h.tracker.receiveIncoming(uncorrelated)).toBe(false);
		await turn();
		expect(firstState()).toBe("pending");
		const receipts = [first, ...Array.from({ length: 63 }, (_, id) => h.track(request(id + 1)))];
		throwsFixed(() => h.tracker.trackOutgoing(request(64)));
		expect(h.tracker.receiveIncoming(reply(0))).toBe(true);
		await receipts[0]?.response;
		const neighbor = h.track(request(64));
		expect(h.tracker.receiveIncoming(reply(64))).toBe(true);
		await neighbor.response;
		h.end.resolve(undefined);
		await h.retire();
		const results = await Promise.allSettled(receipts.map((receipt) => receipt.response));
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		for (const result of results) if (result.status === "rejected") fixed(result.reason);
	});
	test("ignores unknown and duplicate replies without ending another reservation", async () => {
		const h = unit();
		const receipt = h.track(request(2));
		const state = status(receipt.response);
		expect(h.tracker.receiveIncoming(reply("DYTEST_unknown"))).toBe(false);
		expect(h.tracker.receiveIncoming(reply("2"))).toBe(false);
		await turn();
		expect(state()).toBe("pending");
		expect(h.tracker.receiveIncoming(reply(2))).toBe(true);
		await receipt.response;
		expect(h.tracker.receiveIncoming(reply(2))).toBe(false);
	});
	test("refuses actual schema-invalid inputs in both directions and accepts valid neighbors", async () => {
		const h = unit();
		for (const invalid of [
			null,
			[],
			{},
			{ jsonrpc: "1.0", id: 1, method: "tools/list" },
			{ jsonrpc: "2.0", id: {}, result: {} },
		]) {
			expect(() => parseJSONRPCMessage(invalid)).toThrow();
			throwsFixed(() => h.tracker.trackOutgoing(invalid));
			throwsFixed(() => h.tracker.receiveIncoming(invalid));
		}
		const receipt = h.track(request("DYTEST_valid"));
		expect(h.tracker.receiveIncoming(reply("DYTEST_valid"))).toBe(true);
		await receipt.response;
	});
	test("fences new requests while preserving an already admitted late matching response", async () => {
		const h = unit();
		const receipt = h.track(request(3));
		h.tracker.fence();
		h.tracker.fence();
		throwsFixed(() => h.tracker.trackOutgoing(request(4)));
		expect(h.tracker.receiveIncoming(reply(3))).toBe(true);
		await receipt.response;
		expect(
			h.tracker.trackOutgoing(
				parseJSONRPCMessage({ jsonrpc: "2.0", method: "notifications/initialized" }),
			),
		).toBeUndefined();
	});
	test("memoizes retirement and waits for the original producer even after every response", async () => {
		const h = unit();
		const receipt = h.track(request(4));
		expect(h.tracker.receiveIncoming(reply(4))).toBe(true);
		await receipt.response;
		const retiring = h.retire();
		const state = status(retiring);
		expect(h.retire()).toBe(retiring);
		await turn();
		expect(state()).toBe("pending");
		throwsFixed(() => h.tracker.trackOutgoing(request(5)));
		h.end.resolve(undefined);
		await retiring;
	});
	test("distinguishes a known end refusal from an actual matching error response", async () => {
		const h = unit();
		const answered = h.track(request(5));
		const unanswered = h.track(request(6));
		const refused = Promise.allSettled([unanswered.response]);
		expect(
			h.tracker.receiveIncoming(
				parseJSONRPCMessage({
					jsonrpc: "2.0",
					id: 5,
					error: { code: -32603, message: "DYTEST_reply" },
				}),
			),
		).toBe(true);
		expect(await answered.response).toBeUndefined();
		h.end.resolve(undefined);
		await h.retire();
		await rejectsFixed(refused);
	});
	test("retains an unanswered receipt after unknown retirement and accepts its later match", async () => {
		const h = unit();
		const receipt = h.track(request(8));
		const state = status(receipt.response);
		const retiring = h.retire();
		const rejected = Promise.allSettled([retiring]);
		h.end.reject(new Error("DYTEST_original_terminal_unknown"));
		await rejectsFixed(rejected);
		expect(h.retire()).toBe(retiring);
		await turn();
		expect(state()).toBe("pending");
		throwsFixed(() => h.tracker.trackOutgoing(request(9)));
		expect(h.tracker.receiveIncoming(reply(8))).toBe(true);
		await turn();
		expect(state()).toBe("fulfilled");
		await receipt.response;
		await rejectsFixed(Promise.allSettled([h.retire()]));
	});
	test("refuses root and nested passive input hooks without consuming a request slot", async () => {
		const h = unit();
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error("DYTEST_input_hook");
		};
		const traps = {
			get: hook,
			getPrototypeOf: hook,
			ownKeys: hook,
			getOwnPropertyDescriptor: hook,
		};
		const valid = () => ({ jsonrpc: "2.0", id: "DYTEST_guard", method: "tools/list", params: {} });
		const rootProxy = new Proxy(valid(), traps);
		const nestedProxy = { ...valid(), params: { DYTEST: new Proxy({}, traps) } };
		const rootAccessor = valid();
		Object.defineProperty(rootAccessor, "params", { enumerable: true, get: hook });
		const nestedAccessor = {};
		Object.defineProperty(nestedAccessor, "DYTEST", { enumerable: true, get: hook });
		for (const raw of [
			rootProxy,
			nestedProxy,
			rootAccessor,
			{ ...valid(), params: { nested: nestedAccessor } },
		]) {
			throwsFixed(() => h.tracker.trackOutgoing(raw));
			throwsFixed(() => h.tracker.receiveIncoming(raw));
			expect(hooks).toBe(0);
		}
		const neighbors = Array.from({ length: 64 }, (_, id) => h.track(request(id)));
		expect(h.tracker.receiveIncoming(reply(0))).toBe(true);
		expect(await neighbors[0]?.response).toBeUndefined();
		expect(hooks).toBe(0);
	});
	test("rejects invalid retirement originals without invoking their hooks and accepts a genuine promise", async () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error("DYTEST_retirement_hook");
		};
		const thenable = {};
		// biome-ignore lint/suspicious/noThenProperty: This fixture verifies rejection of a hostile thenable without invoking its getter.
		Object.defineProperty(thenable, "then", { get: hook });
		const base = deferred<void>();
		const proxied = new Proxy(base.promise, {
			get: hook,
			getPrototypeOf: hook,
			ownKeys: hook,
			getOwnPropertyDescriptor: hook,
		});
		const ownConstructor = deferred<void>();
		Object.defineProperty(ownConstructor.promise, "constructor", { configurable: true, get: hook });
		let resolveDerived!: () => void;
		class DerivedPromise extends Promise<void> {
			static override get [Symbol.species](): PromiseConstructor {
				hooks++;
				return Promise;
			}
		}
		const derived = new DerivedPromise((resolve) => {
			resolveDerived = () => resolve(undefined);
		});
		const unexpected: Tracker[] = [];
		try {
			for (const raw of [thenable, proxied, derived, ownConstructor.promise]) {
				let error: unknown;
				try {
					unexpected.push(createPluginResponseTracker(raw as Promise<void>));
				} catch (caught) {
					error = caught;
				}
				fixed(error);
				expect(hooks).toBe(0);
			}
		} finally {
			// Restore test-owned hooks before independently joining the actual underlying promises.
			Reflect.deleteProperty(ownConstructor.promise, "constructor");
			Object.defineProperty(DerivedPromise, Symbol.species, { configurable: true, value: Promise });
			base.resolve(undefined);
			ownConstructor.resolve(undefined);
			resolveDerived();
			const retiring = unexpected.map((tracker) => {
				try {
					return observe(tracker.retire());
				} catch (error) {
					return observe(Promise.reject(error));
				}
			});
			await Promise.allSettled([base.promise, ownConstructor.promise, derived, ...retiring]);
		}
		expect(hooks).toBe(0);
		const accepted = unit();
		const retiring = accepted.retire();
		expect(accepted.retire()).toBe(retiring);
		accepted.end.resolve(undefined);
		await retiring;
	});
	test("tracks a genuine SDK response before forwarding it to ordinary Client dispatch", async () => {
		const h = await sdk();
		const call = h.call();
		await h.waitFor(h.handlerEntered.promise, call);
		const receipt = h.receipt();
		const state = status(receipt.response);
		expect(state()).toBe("pending");
		h.handlerRelease.resolve(undefined);
		expect(await call).toMatchObject({
			content: [{ type: "text", text: "DYTEST_tracker_result" }],
		});
		await turn();
		expect(state()).toBe("fulfilled");
		expect(await receipt.response).toBeUndefined();
		expect(h.responses.filter((id) => id === receipt.id)).toHaveLength(1);
		await h.close();
	});
	test("keeps a genuine cancelled SDK call reserved until its actual post-read producer ends", async () => {
		const h = await sdk();
		const controller = new AbortController();
		const call = h.call(controller.signal);
		const callerState = status(call);
		const callerResult = Promise.allSettled([call]);
		await h.waitFor(h.handlerEntered.promise, call);
		const receipt = h.receipt();
		const state = status(receipt.response);
		await turn();
		expect(callerState()).toBe("pending");
		expect(controller.signal.aborted).toBe(false);
		expect(h.serverSignal?.aborted).toBe(false);
		controller.abort();
		const results = await callerResult;
		expect(results[0]?.status).toBe("rejected");
		if (results[0]?.status !== "rejected") throw new Error("Expected original SDK cancellation");
		expect(callerState()).toBe("rejected");
		expect(controller.signal.aborted).toBe(true);
		await turn();
		expect(h.serverSignal?.aborted).toBe(true);
		expect(state()).toBe("pending");
		expect(h.responses.filter((id) => id === receipt.id)).toHaveLength(0);
		h.handlerRelease.resolve(undefined);
		await h.handlerOriginal;
		const endRefusal = Promise.allSettled([receipt.response]);
		await h.close();
		await rejectsFixed(endRefusal);
	});
	test("keeps a genuine buffered response through close until the original read suffix joins", async () => {
		const h = await sdk();
		const held = h.holdNextReply();
		const call = h.call();
		await h.waitFor(h.handlerEntered.promise, call);
		const receipt = h.receipt();
		const responseState = status(receipt.response);
		h.handlerRelease.resolve(undefined);
		await h.waitFor(held.seen.promise, call);
		const retiring = h.startRetirement();
		const retireState = status(retiring);
		await h.transportClosed.promise;
		await turn();
		expect(responseState()).toBe("pending");
		expect(retireState()).toBe("pending");
		expect(h.responses.filter((id) => id === receipt.id)).toHaveLength(0);
		held.release.resolve(undefined);
		await turn();
		expect(responseState()).toBe("fulfilled");
		expect(await receipt.response).toBeUndefined();
		await retiring;
		expect(h.responses.filter((id) => id === receipt.id)).toHaveLength(1);
		await h.close();
	});
});
