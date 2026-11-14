import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import { setImmediate as turn } from "node:timers/promises";
import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPluginInputWriter,
	PluginInputWriteError,
} from "../../src/plugins/supervisor/parent-input-writer.ts";

type Writer = ReturnType<typeof createPluginInputWriter>;
type State = "pending" | "fulfilled" | "rejected";
type Callback = (error?: Error | null) => void;
interface Gate {
	readonly promise: Promise<void>;
	resolve(): void;
}
function gate(): Gate {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
function observe<T>(original: Promise<T>): Promise<T> {
	void Promise.allSettled([original]);
	return original;
}
function status(original: Promise<unknown>): () => State {
	let value: State = "pending";
	observe(
		original.then(
			() => {
				value = "fulfilled";
			},
			() => {
				value = "rejected";
			},
		),
	);
	return () => value;
}
function fixed(error: unknown): void {
	expect(error).toBeInstanceOf(PluginInputWriteError);
	if (!(error instanceof PluginInputWriteError)) throw new Error("Expected fixed input failure");
	expect(error.name).toBe("PluginInputWriteError");
	expect(error.code).toBe("PLUGIN_INPUT_WRITE_FAILED");
	expect(error.message).toBe("Plugin input write failed");
	expect("cause" in error).toBe(false);
}
async function refused(original: Promise<void>): Promise<void> {
	const state = status(original);
	await turn();
	expect(state()).toBe("rejected");
	const results = await Promise.allSettled([original]);
	expect(results[0]?.status).toBe("rejected");
	if (results[0]?.status !== "rejected") throw new Error("Expected rejected write");
	fixed(results[0].reason);
}
const MAX_FRAME = HOST_MAX_FRAME_BYTES + 2;
const MAX_BYTES = 32 * 1024 * 1024;
// Frame content is opaque to this component; these are complete JSON DATA lines.
function frame(length = 192, fill = 65): Buffer {
	const prefix = Buffer.from(
		'{"jsonrpc":"2.0","id":0,"result":{"resultType":"complete","content":[{"type":"text","text":"',
	);
	const suffix = Buffer.from('"}]}}\n');
	if (length < prefix.length + suffix.length) throw new Error("Frame fixture too short");
	const result = Buffer.alloc(length, fill);
	prefix.copy(result);
	suffix.copy(result, result.length - suffix.length);
	return result;
}
interface BackendWrite {
	readonly chunk: Buffer;
	readonly callback: Callback;
	completed: boolean;
}
interface CallbackToken {
	delivered: boolean;
	deliver(): void;
}
interface DrainToken {
	delivered: boolean;
	deliver(): void;
}
class Sink {
	readonly input: Writable;
	readonly actualClose = gate();
	readonly actualFinish = gate();
	readonly backend: BackendWrite[] = [];
	readonly callbackTokens: CallbackToken[] = [];
	readonly drainTokens: DrainToken[] = [];
	readonly invocations: Array<{ receiver: unknown; chunk: Uint8Array }> = [];
	readonly returns: boolean[] = [];
	readonly writes: Promise<void>[] = [];
	readonly writeStates: Array<() => State> = [];
	readonly streamErrors: unknown[] = [];
	deferCallback = false;
	deferDrain = false;
	onBackend: (() => void) | undefined;
	throwBeforeNative = false;
	closeSeen = false;
	endCalls = 0;
	destroyCalls = 0;
	private destruction: { error: Error | null; callback: Callback; delivered: boolean } | undefined;
	private bound: Writer | undefined;
	private cleanupOriginal: Promise<void> | undefined;

	constructor(highWaterMark = 1) {
		this.input = new Writable({
			highWaterMark,
			autoDestroy: false,
			emitClose: true,
			write: (chunk: Buffer, _encoding, callback) => {
				this.backend.push({ chunk, callback, completed: false });
				this.onBackend?.();
			},
			destroy: (error, callback) => {
				this.destruction = { error, callback, delivered: false };
			},
		});
		this.input.once("close", () => {
			this.closeSeen = true;
			this.actualClose.resolve();
		});
		this.input.once("finish", () => {
			this.actualFinish.resolve();
		});
		this.input.on("error", (error) => {
			this.streamErrors.push(error);
		});
		const sink = this;
		const nativeEmit = this.input.emit;
		Object.defineProperty(this.input, "emit", {
			configurable: true,
			value: function (this: unknown, event: string | symbol, ...args: unknown[]): boolean {
				if (event !== "drain") return Reflect.apply(nativeEmit, this, [event, ...args]);
				// Hold only a drain emission actually produced by this real Writable.
				const token: DrainToken = {
					delivered: false,
					deliver() {
						if (token.delivered) return;
						token.delivered = true;
						Reflect.apply(nativeEmit, sink.input, [event, ...args]);
					},
				};
				sink.drainTokens.push(token);
				if (!sink.deferDrain) token.deliver();
				return true;
			},
		});
		const nativeWrite = this.input.write;
		Object.defineProperty(this.input, "write", {
			configurable: true,
			value: function (this: unknown, chunk: Uint8Array, callback: Callback): boolean {
				sink.invocations.push({ receiver: this, chunk });
				if (sink.throwBeforeNative) throw new Error("DYTEST private synchronous write");
				const wrapped = function (this: unknown, ...args: unknown[]): void {
					const receiver = this;
					const token: CallbackToken = {
						delivered: false,
						deliver() {
							if (token.delivered) return;
							token.delivered = true;
							Reflect.apply(callback, receiver, args);
						},
					};
					sink.callbackTokens.push(token);
					if (!sink.deferCallback) token.deliver();
				};
				const result = Reflect.apply(nativeWrite, this, [chunk, wrapped]) as boolean;
				sink.returns.push(result);
				return result;
			},
		});
		const nativeEnd = this.input.end;
		Object.defineProperty(this.input, "end", {
			configurable: true,
			value: function (this: unknown, ...args: unknown[]): unknown {
				sink.endCalls++;
				return Reflect.apply(nativeEnd, this, args);
			},
		});
		const nativeDestroy = this.input.destroy;
		Object.defineProperty(this.input, "destroy", {
			configurable: true,
			value: function (this: unknown, ...args: unknown[]): unknown {
				sink.destroyCalls++;
				return Reflect.apply(nativeDestroy, this, args);
			},
		});
	}
	bind(): void {
		this.bound = createPluginInputWriter(this.input);
		observe(this.bound.drained);
	}
	get writer(): Writer {
		if (!this.bound) throw new Error("Expected bound original input");
		return this.bound;
	}
	send(bytes: Uint8Array): Promise<void> {
		if (tearingDown) throw new Error("Test teardown already started");
		const original = observe(this.writer.write(bytes));
		this.writes.push(original);
		this.writeStates.push(status(original));
		return original;
	}
	complete(index: number, error?: Error): void {
		const original = this.backend[index];
		if (!original || original.completed) throw new Error("Expected one pending backend callback");
		original.completed = true;
		original.callback(error);
	}
	releaseCallbacks(): void {
		for (const token of this.callbackTokens) token.deliver();
	}
	releaseDrains(): void {
		for (const token of this.drainTokens) token.deliver();
	}
	beginOwnerClose(error?: Error): void {
		if (!this.input.destroyed) this.input.destroy(error);
	}
	releaseOwnerClose(): void {
		const original = this.destruction;
		if (!original || original.delivered) return;
		original.delivered = true;
		original.callback(original.error);
	}
	private releaseAll(): void {
		this.deferCallback = false;
		this.deferDrain = false;
		let failed = false;
		let failure: unknown;
		const attempt = (action: () => void): void => {
			try {
				action();
			} catch (error) {
				if (!failed) {
					failed = true;
					failure = error;
				}
			}
		};
		let seen = -1;
		while (seen !== this.backend.length + this.callbackTokens.length + this.drainTokens.length) {
			seen = this.backend.length + this.callbackTokens.length + this.drainTokens.length;
			for (let at = 0; at < this.backend.length; at++)
				if (!this.backend[at]?.completed) attempt(() => this.complete(at));
			for (const token of this.callbackTokens) attempt(() => token.deliver());
			for (const token of this.drainTokens) attempt(() => token.deliver());
		}
		if (failed) throw failure;
	}
	cleanup(): Promise<void> {
		if (this.cleanupOriginal) return this.cleanupOriginal;
		let draining: Promise<void> | undefined;
		let statusAtClose: () => State = () => "fulfilled";
		let initiationFailed = false;
		let initiationError: unknown;
		const attempt = (action: () => void): void => {
			try {
				action();
			} catch (error) {
				if (!initiationFailed) {
					initiationFailed = true;
					initiationError = error;
				}
			}
		};
		this.cleanupOriginal = Promise.resolve().then(async () => {
			await this.actualClose.promise;
			await turn();
			attempt(() => this.releaseAll());
			const states = this.writeStates.map((state) => state());
			const drainState = statusAtClose();
			const canJoin =
				states.every((state) => state !== "pending") && (!draining || drainState !== "pending");
			const results = canJoin
				? await Promise.allSettled([...this.writes, ...(draining ? [draining] : [])])
				: [];
			if (initiationFailed) throw initiationError;
			expect(this.closeSeen).toBe(true);
			for (const state of states) expect(state).not.toBe("pending");
			if (draining) expect(drainState).not.toBe("pending");
			for (const result of results) if (result.status === "rejected") fixed(result.reason);
		});
		observe(this.cleanupOriginal);
		attempt(() => {
			if (this.bound) {
				draining = observe(this.bound.close());
				statusAtClose = status(draining);
			}
		});
		// Real input-owner cancellation precedes joins, including a timed-out body.
		try {
			attempt(() => this.beginOwnerClose());
		} finally {
			try {
				attempt(() => this.releaseAll());
			} finally {
				attempt(() => this.releaseOwnerClose());
			}
		}
		return this.cleanupOriginal;
	}
}
const sinks = new Set<Sink>();
const bodies = new Set<Promise<unknown>>();
let tearingDown = false;
function sink(highWaterMark = 1): Sink {
	if (tearingDown) throw new Error("Test teardown already started");
	const result = new Sink(highWaterMark);
	sinks.add(result);
	result.bind();
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
	const cleanups: Promise<void>[] = [];
	for (const item of sinks) {
		try {
			cleanups.push(item.cleanup());
		} catch (error) {
			cleanups.push(observe(Promise.reject(error)));
		}
	}
	await Promise.allSettled([...bodies]);
	const results = await Promise.allSettled(cleanups);
	sinks.clear();
	bodies.clear();
	for (const result of results) {
		expect(result.status).toBe("fulfilled");
		if (result.status === "rejected") throw result.reason;
	}
});

describe("plugin parent input writer", () => {
	test("requires a successful callback after a true return and still waits for original close", async () => {
		const h = sink(MAX_FRAME * 2);
		const operation = h.send(frame());
		const state = status(operation);
		const drained = status(h.writer.drained);
		await turn();
		expect(h.returns).toEqual([true]);
		expect(state()).toBe("pending");
		await turn();
		expect(h.invocations[0]?.receiver).toBe(h.input);
		await turn();
		h.complete(0);
		await turn();
		expect(h.drainTokens).toHaveLength(0);
		expect(state()).toBe("fulfilled");
		expect(await operation).toBeUndefined();
		expect(h.writer.close()).toBe(h.writer.drained);
		expect(h.writer.close()).toBe(h.writer.drained);
		await turn();
		expect(drained()).toBe("pending");
		expect(h.endCalls).toBe(0);
		expect(h.destroyCalls).toBe(0);
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await h.actualClose.promise;
		expect(await h.writer.drained).toBeUndefined();
	});
	test("waits for an actual drain delivered after callback before dispatching the next frame", async () => {
		const h = sink();
		h.deferDrain = true;
		const first = h.send(frame(192, 65));
		const second = h.send(frame(192, 66));
		const firstState = status(first);
		await turn();
		h.complete(0);
		await turn();
		expect(h.returns).toEqual([false]);
		expect(h.callbackTokens.filter((token) => token.delivered)).toHaveLength(1);
		expect(h.drainTokens.filter((token) => !token.delivered)).toHaveLength(1);
		expect(firstState()).toBe("pending");
		await turn();
		expect(h.invocations).toHaveLength(1);
		h.releaseDrains();
		await turn();
		expect(firstState()).toBe("fulfilled");
		await turn();
		expect(h.invocations).toHaveLength(2);
		await turn();
		h.complete(1);
		await turn();
		h.releaseDrains();
		await Promise.all([first, second]);
	});
	test("waits for the original callback when the actual drain was delivered first", async () => {
		const h = sink();
		h.deferCallback = true;
		const operation = h.send(frame());
		const state = status(operation);
		await turn();
		h.complete(0);
		await turn();
		expect(h.drainTokens.filter((token) => token.delivered)).toHaveLength(1);
		expect(h.callbackTokens.filter((token) => !token.delivered)).toHaveLength(1);
		expect(state()).toBe("pending");
		h.releaseCallbacks();
		await operation;
		expect(state()).toBe("fulfilled");
	});
	test("retains the native view and queued snapshots in FIFO order", async () => {
		const h = sink();
		const firstBytes = frame(192, 65);
		const secondBytes = frame(224, 66);
		const storage = Buffer.concat([Buffer.alloc(8, 120), firstBytes, Buffer.alloc(8, 120)]);
		const view = new Uint8Array(storage.buffer, storage.byteOffset + 8, firstBytes.byteLength);
		const first = h.send(view);
		const second = h.send(secondBytes);
		const expectedSecond = Buffer.from(secondBytes);
		storage.fill(0);
		secondBytes.fill(0);
		await turn();
		expect(Buffer.from(h.backend[0]?.chunk ?? [])).toEqual(firstBytes);
		await turn();
		expect(h.invocations).toHaveLength(1);
		await turn();
		h.complete(0);
		await turn();
		expect(Buffer.from(h.backend[1]?.chunk ?? [])).toEqual(expectedSecond);
		await turn();
		h.complete(1);
		await Promise.all([first, second]);
	});
	test("reserves the in-flight operation before a reentrant write can dispatch", async () => {
		const h = sink(MAX_FRAME * 2);
		let second: Promise<void> | undefined;
		let callsDuringOriginal = -1;
		h.onBackend = () => {
			h.onBackend = undefined;
			second = h.send(frame(192, 66));
			callsDuringOriginal = h.invocations.length;
		};
		const first = h.send(frame(192, 65));
		await turn();
		expect(callsDuringOriginal).toBe(1);
		await turn();
		expect(h.invocations).toHaveLength(1);
		await turn();
		h.complete(0);
		await turn();
		expect(h.invocations).toHaveLength(2);
		await turn();
		h.complete(1);
		await Promise.all([first, second]);
	});
	test("fences new work while accepted frames remain owned and close stays memoized", async () => {
		const h = sink(MAX_FRAME * 2);
		const first = h.send(frame(192, 65));
		const second = h.send(frame(192, 66));
		const closing = h.writer.close();
		const state = status(closing);
		expect(closing).toBe(h.writer.drained);
		expect(h.writer.close()).toBe(closing);
		await refused(h.send(frame(192, 67)));
		await turn();
		h.complete(0);
		await turn();
		h.complete(1);
		await Promise.all([first, second]);
		await turn();
		expect(state()).toBe("pending");
		expect(h.endCalls).toBe(0);
		expect(h.destroyCalls).toBe(0);
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await closing;
	});
	test("bounds combined queued and in-flight slots and admits a neighbor after one settles", async () => {
		const h = sink();
		const bytes = frame();
		const accepted = Array.from({ length: 32 }, () => h.send(bytes));
		await refused(h.send(bytes));
		await turn();
		expect(h.invocations).toHaveLength(1);
		await turn();
		h.complete(0);
		await turn();
		await accepted[0];
		const neighbor = h.send(bytes);
		const neighborState = status(neighbor);
		await turn();
		expect(neighborState()).toBe("pending");
		await turn();
		expect(h.invocations).toHaveLength(2);
	});
	test("bounds retained bytes independently before the thirty-second count slot is filled", async () => {
		const h = sink();
		const maximum = frame(MAX_FRAME);
		for (let at = 0; at < 31; at++) h.send(maximum);
		const room = MAX_BYTES - 31 * MAX_FRAME;
		expect(room).toBe(MAX_FRAME - 64);
		await refused(h.send(frame(room + 1)));
		await turn();
		expect(h.invocations).toHaveLength(1);
		const neighbor = h.send(frame(room));
		const state = status(neighbor);
		await turn();
		expect(state()).toBe("pending");
		await turn();
		expect(h.invocations).toHaveLength(1);
	});
	test("refuses empty and oversized frames without poisoning an exact-size neighbor", async () => {
		const h = sink(MAX_FRAME * 2);
		await refused(h.send(new Uint8Array()));
		await refused(h.send(new Uint8Array(MAX_FRAME + 1)));
		await turn();
		expect(h.invocations).toHaveLength(0);
		const operation = h.send(frame(MAX_FRAME));
		await turn();
		expect(h.backend[0]?.chunk.byteLength).toBe(MAX_FRAME);
		await turn();
		h.complete(0);
		await operation;
	});
	test("uses native byte metadata without hooks and refuses unsupported backings before dispatch", async () => {
		const h = sink(MAX_FRAME * 2);
		const bytes = frame();
		const view = new Uint8Array(bytes);
		let hooks = 0;
		for (const key of [
			"buffer",
			"byteOffset",
			"byteLength",
			"length",
			"constructor",
			Symbol.iterator,
		]) {
			Object.defineProperty(view, key, {
				get() {
					hooks++;
					throw new Error("DYTEST byte hook");
				},
			});
		}
		const operation = h.send(view);
		expect(hooks).toBe(0);
		await turn();
		expect(Buffer.from(h.backend[0]?.chunk ?? [])).toEqual(bytes);
		await turn();
		h.complete(0);
		await operation;
		const proxy = new Proxy(bytes, {
			get() {
				hooks++;
				throw new Error("DYTEST proxy hook");
			},
		});
		await refused(h.send(proxy));
		const shared = new Uint8Array(new SharedArrayBuffer(bytes.byteLength));
		shared.set(bytes);
		await refused(h.send(shared));
		const resizable = new ArrayBuffer(bytes.byteLength, { maxByteLength: bytes.byteLength + 1 });
		new Uint8Array(resizable).set(bytes);
		await refused(h.send(new Uint8Array(resizable)));
		const detached = new Uint8Array(bytes);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		await refused(h.send(detached));
		expect(hooks).toBe(0);
		const neighbor = h.send(frame());
		await turn();
		h.complete(1);
		await neighbor;
	});
	test("contains callback errors privately while retaining ownership until actual close", async () => {
		const h = sink();
		const first = h.send(frame());
		const second = h.send(frame());
		const drained = status(h.writer.drained);
		const firstResult = Promise.allSettled([first]);
		const secondResult = Promise.allSettled([second]);
		await turn();
		h.complete(0, new Error("DYTEST private callback detail"));
		await turn();
		for (const results of [await firstResult, await secondResult]) {
			expect(results[0]?.status).toBe("rejected");
			if (results[0]?.status === "rejected") fixed(results[0].reason);
		}
		expect(h.streamErrors.length).toBeGreaterThan(0);
		expect(h.input.closed).toBe(false);
		expect(drained()).toBe("pending");
		await refused(h.send(frame()));
		const closedResult = Promise.allSettled([h.writer.close()]);
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await refusedResult(closedResult);
		const idle = sink();
		const idleDrained = observe(idle.writer.drained);
		const idleState = status(idleDrained);
		await turn();
		idle.beginOwnerClose(new Error("DYTEST private idle stream error"));
		idle.releaseOwnerClose();
		await idle.actualClose.promise;
		await turn();
		expect(idle.streamErrors.length).toBeGreaterThan(0);
		expect(idleState()).toBe("rejected");
		await refusedResult(Promise.allSettled([idleDrained]));
	});
	test("treats finish as an admission fence rather than an observed close", async () => {
		const h = sink(MAX_FRAME * 2);
		const operation = h.send(frame());
		await turn();
		h.complete(0);
		await operation;
		const state = status(h.writer.drained);
		h.input.end();
		await h.actualFinish.promise;
		await refused(h.send(frame()));
		expect(state()).toBe("pending");
		expect(h.input.closed).toBe(false);
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await h.writer.drained;
	});
	test("rejects pending frames at actual close without inventing a missing callback", async () => {
		const h = sink();
		h.deferCallback = true;
		const first = h.send(frame());
		const second = h.send(frame());
		const outcomes = [
			Promise.allSettled([first]),
			Promise.allSettled([second]),
			Promise.allSettled([h.writer.drained]),
		];
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await h.actualClose.promise;
		await turn();
		expect(h.backend[0]?.completed).toBe(false);
		expect(h.callbackTokens.filter((token) => token.delivered)).toHaveLength(0);
		for (const result of outcomes) await refusedResult(result);
		await turn();
		expect(h.invocations).toHaveLength(1);
		await turn();
		h.complete(0);
		await turn();
		h.releaseCallbacks();
		h.releaseDrains();
		await refused(h.send(frame()));
		await turn();
		expect(h.invocations).toHaveLength(1);
	});
	test("contains synchronous original-write failure and still waits for actual input close", async () => {
		const h = sink();
		h.throwBeforeNative = true;
		const operation = h.send(frame());
		const drained = status(h.writer.drained);
		await refused(operation);
		await turn();
		expect(h.backend).toHaveLength(0);
		expect(h.input.closed).toBe(false);
		expect(drained()).toBe("pending");
		const result = Promise.allSettled([h.writer.close()]);
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await refusedResult(result);
	});
	test("ignores another original stream's drain while preserving the bound input identity", async () => {
		const original = sink();
		original.deferDrain = true;
		const first = original.send(frame());
		const state = status(first);
		await turn();
		original.complete(0);
		await turn();
		expect(original.invocations[0]?.receiver).toBe(original.input);
		const other = sink();
		const unrelated = other.send(frame());
		await turn();
		other.complete(0);
		await unrelated;
		await turn();
		expect(state()).toBe("pending");
		original.releaseDrains();
		await first;
	});
	test("keeps a synchronously reentered close bound to the original return and real close", async () => {
		const h = sink(MAX_FRAME * 2);
		let reentered: Promise<void> | undefined;
		h.onBackend = () => {
			h.onBackend = undefined;
			reentered = h.writer.close();
		};
		const operation = h.send(frame());
		const state = status(h.writer.drained);
		await turn();
		expect(reentered).toBe(h.writer.drained);
		await turn();
		expect(state()).toBe("pending");
		await refused(h.send(frame()));
		await turn();
		h.complete(0);
		await operation;
		expect(state()).toBe("pending");
		expect(h.destroyCalls).toBe(0);
		expect(h.endCalls).toBe(0);
		await turn();
		h.beginOwnerClose();
		h.releaseOwnerClose();
		await reentered;
	});
});
async function refusedResult(result: Promise<PromiseSettledResult<void>[]>): Promise<void> {
	const state = status(result);
	await turn();
	expect(state()).toBe("fulfilled");
	const values = await result;
	expect(values[0]?.status).toBe("rejected");
	if (values[0]?.status !== "rejected") throw new Error("Expected closed writer failure");
	fixed(values[0].reason);
}
