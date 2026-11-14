import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { HOST_FRAME_TAG, HostMessage } from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPluginOutputPump,
	PluginOutputReadError,
} from "../../src/plugins/supervisor/output-pump.ts";
import type { PluginWireFrame } from "../../src/plugins/supervisor/tagged-wire.ts";

type State = "pending" | "fulfilled" | "rejected";
interface Gate {
	readonly promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
}
function gate(): Gate {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function observe<T>(original: Promise<T>): Promise<T> {
	void original.catch(() => {});
	return original;
}
function status(original: Promise<unknown>): () => State {
	let current: State = "pending";
	observe(
		original.then(
			() => {
				current = "fulfilled";
			},
			() => {
				current = "rejected";
			},
		),
	);
	return () => current;
}
const turn = async (): Promise<void> => {
	await nextTurn();
	await nextTurn();
};
function fixed(error: unknown): void {
	expect(error).toBeInstanceOf(PluginOutputReadError);
	if (!(error instanceof PluginOutputReadError)) throw new Error("Expected fixed output error");
	expect(error.name).toBe("PluginOutputReadError");
	expect(error.code).toBe("PLUGIN_OUTPUT_READ_FAILED");
	expect(error.message).toBe("Plugin output read failed");
	expect("cause" in error).toBe(false);
}
async function rejected(original: Promise<unknown>): Promise<void> {
	const state = status(original);
	await turn();
	expect(state()).toBe("rejected");
	const [result] = await Promise.allSettled([original]);
	expect(result?.status).toBe("rejected");
	if (result?.status === "rejected") fixed(result.reason);
}
const request = HostMessage.parse({
	jsonrpc: "2.0",
	id: "DYTEST-output",
	method: "host/kv.set",
	params: { key: "DYTEST-key", value: "DYTEST-Å-🐂" },
});
const cancel = HostMessage.parse({
	jsonrpc: "2.0",
	method: "host/cancel",
	params: { requestId: "DYTEST-output" },
});
function line(value: unknown, tagged = false): Buffer {
	return Buffer.from(`${tagged ? HOST_FRAME_TAG : ""}${canonicalize(value)}\n`, "utf8");
}

class Source {
	readonly input: Readable;
	readonly originalClose = gate();
	readonly errors: unknown[] = [];
	closeSeen = false;
	endSeen = false;
	ownerDestroyCalls = 0;
	readsWhileHeld = 0;
	retiredBytes = 0;
	holdReadUntilClose = false;
	private endRequested = false;
	private destruction: { error: Error | null; callback: (error: Error | null) => void } | undefined;
	constructor() {
		const source = this;
		this.input = new Readable({
			autoDestroy: false,
			emitClose: true,
			read() {},
			destroy(error, callback) {
				source.destruction = { error, callback };
			},
		});
		this.input.once("close", () => {
			this.closeSeen = true;
			this.originalClose.resolve();
		});
		this.input.once("end", () => {
			this.endSeen = true;
		});
		this.input.on("error", (error) => {
			this.errors.push(error);
		});
		const originalRead = this.input.read;
		Object.defineProperty(this.input, "read", {
			value: function (this: Readable, ...args: unknown[]): unknown {
				if (source.holdReadUntilClose && !source.closeSeen) {
					source.readsWhileHeld++;
					return null;
				}
				const value: unknown = Reflect.apply(originalRead, this, args);
				if (source.closeSeen && Buffer.isBuffer(value)) source.retiredBytes += value.byteLength;
				return value;
			},
		});
	}
	push(bytes: Uint8Array): void {
		this.input.push(bytes);
	}
	end(): void {
		if (this.endRequested) return;
		this.endRequested = true;
		this.input.push(null);
	}
	beginOwnerClose(error?: Error): void {
		if (this.input.destroyed) return;
		this.ownerDestroyCalls++;
		this.input.destroy(error);
	}
	releaseOwnerClose(): void {
		const original = this.destruction;
		if (!original) return;
		this.destruction = undefined;
		original.callback(original.error);
	}
}

let tearingDown = false;
const fixtures: Harness[] = [];
const bodies = new Set<Promise<void>>();
class Harness {
	readonly stdout = new Source();
	readonly stderr = new Source();
	readonly frames: PluginWireFrame[] = [];
	readonly gates: Gate[] = [];
	readonly originals: Promise<unknown>[] = [];
	private boundPump: ReturnType<typeof createPluginOutputPump> | undefined;
	drainState: () => State = () => "pending";
	private cleanupOriginal: Promise<void> | undefined;
	get pump(): ReturnType<typeof createPluginOutputPump> {
		if (!this.boundPump) throw new Error("Output fixture producer not bound");
		return this.boundPump;
	}
	start(deliver?: (frame: PluginWireFrame) => void): void {
		this.boundPump = createPluginOutputPump(
			[this.stdout.input, this.stderr.input],
			deliver ??
				((frame) => {
					this.frames.push(frame);
				}),
		);
		observe(this.pump.failure);
		observe(this.pump.drained);
		this.drainState = status(this.pump.drained);
	}
	hold(): Gate {
		const original = gate();
		observe(original.promise);
		this.gates.push(original);
		this.originals.push(original.promise);
		return original;
	}
	closeBoth(): void {
		for (const source of [this.stdout, this.stderr]) {
			try {
				source.beginOwnerClose();
			} finally {
				source.releaseOwnerClose();
			}
		}
	}
	async finish(): Promise<void> {
		this.stdout.end();
		this.stderr.end();
		await turn();
		this.closeBoth();
		await Promise.all([this.stdout.originalClose.promise, this.stderr.originalClose.promise]);
		await turn();
	}
	cleanup(): Promise<void> {
		if (this.cleanupOriginal) return this.cleanupOriginal;
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
		this.cleanupOriginal = Promise.resolve().then(async () => {
			await Promise.all([this.stdout.originalClose.promise, this.stderr.originalClose.promise]);
			await Promise.allSettled(this.originals);
			await turn();
			if (this.boundPump) {
				expect(this.drainState()).not.toBe("pending");
				await Promise.allSettled([this.boundPump.failure, this.boundPump.drained]);
			}
			if (failed) throw failure;
		});
		observe(this.cleanupOriginal);
		for (const source of [this.stdout, this.stderr]) {
			try {
				attempt(() => source.beginOwnerClose());
			} finally {
				attempt(() => source.releaseOwnerClose());
			}
		}
		for (const original of this.gates) attempt(() => original.resolve());
		return this.cleanupOriginal;
	}
}
function acquire(deliver?: (frame: PluginWireFrame) => void): Harness {
	if (tearingDown) throw new Error("Output fixture teardown already reserved");
	const h = new Harness();
	fixtures.push(h);
	h.start(deliver);
	return h;
}
function test(title: string, body: () => void | Promise<void>): void {
	it(title, () => {
		const original = Promise.resolve().then(body);
		bodies.add(original);
		return observe(original);
	});
}
async function failure(h: Harness): Promise<void> {
	const state = status(h.pump.failure);
	await turn();
	expect(state()).toBe("fulfilled");
	fixed(await h.pump.failure);
}
beforeEach(() => {
	tearingDown = false;
});
afterEach(async () => {
	tearingDown = true;
	const cleanups = fixtures.map((h) => h.cleanup());
	await Promise.allSettled([...bodies]);
	const results = await Promise.allSettled(cleanups);
	for (const result of results) if (result.status === "rejected") throw result.reason;
	fixtures.length = 0;
	bodies.clear();
});

describe("plugin output pump", () => {
	test("delivers split UTF-8 tagged and coalesced untagged frames in source order", async () => {
		const h = acquire();
		const first = line(request, true);
		const split = first.indexOf(Buffer.from("🐂")) + 1;
		expect(split).toBeGreaterThan(0);
		h.stdout.push(first.subarray(0, split));
		await turn();
		expect(h.frames).toEqual([]);
		h.stdout.push(
			Buffer.concat([first.subarray(split), line(cancel, true), line({ id: 0, data: "DYTEST" })]),
		);
		h.stderr.push(Buffer.from([0xff, 0x1e, 0x00, 0x0a]));
		await turn();
		expect(h.frames).toEqual([
			{ kind: "host", message: request },
			{ kind: "host", message: cancel },
			{ kind: "untagged", value: { id: 0, data: "DYTEST" } },
		]);
		expect(h.stdout.ownerDestroyCalls + h.stderr.ownerDestroyCalls).toBe(0);
		await h.finish();
		expect(await h.pump.failure).toBeUndefined();
		expect(h.drainState()).toBe("fulfilled");
		await expect(h.pump.drained).resolves.toBeUndefined();
	});

	test("real EOF validates framing but both original close events remain required", async () => {
		const h = acquire();
		h.stdout.push(line("DYTEST"));
		h.stdout.end();
		h.stderr.end();
		await turn();
		expect(h.stdout.endSeen && h.stderr.endSeen).toBe(true);
		expect(h.drainState()).toBe("pending");
		h.stdout.beginOwnerClose();
		h.stdout.releaseOwnerClose();
		await h.stdout.originalClose.promise;
		await turn();
		expect(h.drainState()).toBe("pending");
		h.stderr.beginOwnerClose();
		await turn();
		expect(h.stderr.closeSeen).toBe(false);
		expect(h.drainState()).toBe("pending");
		h.stderr.releaseOwnerClose();
		await h.stderr.originalClose.promise;
		await turn();
		expect(h.drainState()).toBe("fulfilled");
		await expect(h.pump.drained).resolves.toBeUndefined();
		expect(await h.pump.failure).toBeUndefined();
	});

	test("processes original buffered suffix after close before refusing missing EOF", async () => {
		const h = acquire();
		h.stdout.holdReadUntilClose = true;
		const bytes = line({ suffix: "DYTEST-buffered" });
		h.stdout.push(bytes);
		await turn();
		expect(h.stdout.readsWhileHeld).toBeGreaterThan(0);
		expect(h.stdout.input.readableLength).toBe(bytes.byteLength);
		expect(h.frames).toEqual([]);
		h.stdout.beginOwnerClose();
		h.stdout.releaseOwnerClose();
		await h.stdout.originalClose.promise;
		await turn();
		expect(h.stdout.retiredBytes).toBe(bytes.byteLength);
		// No genuine end was observed; buffered DATA is not a clean EOF receipt.
		expect(h.stdout.endSeen).toBe(false);
		await failure(h);
		expect(h.drainState()).toBe("pending");
		h.stderr.end();
		await turn();
		h.stderr.beginOwnerClose();
		h.stderr.releaseOwnerClose();
		await h.stderr.originalClose.promise;
		await rejected(h.pump.drained);
	});

	test("truncated stdout fails at actual end while independent stderr remains owned", async () => {
		const h = acquire();
		h.stdout.push(Buffer.from('{"DYTEST":'));
		h.stdout.end();
		await failure(h);
		expect(h.stdout.endSeen).toBe(true);
		expect(h.drainState()).toBe("pending");
		h.stderr.push(Buffer.alloc(128 * 1024, 255));
		await turn();
		expect(h.stderr.input.readableLength).toBe(0);
		expect(h.frames).toEqual([]);
		await h.finish();
		await rejected(h.pump.drained);
	});

	test("malformed framing stops delivery but continues reading both byte sources", async () => {
		const h = acquire();
		h.stdout.push(Buffer.concat([Buffer.from("{bad}\n"), line("DYTEST-never-delivered")]));
		await failure(h);
		h.stdout.push(line("DYTEST-later"));
		h.stderr.push(Buffer.alloc(128 * 1024, 42));
		await turn();
		expect(h.frames).toEqual([]);
		expect(h.stdout.input.readableLength).toBe(0);
		expect(h.stderr.input.readableLength).toBe(0);
		expect(h.stdout.ownerDestroyCalls + h.stderr.ownerDestroyCalls).toBe(0);
		await h.finish();
		await rejected(h.pump.drained);
	});

	test("contains synchronous delivery failure and discards the same-chunk suffix", async () => {
		let calls = 0;
		const h = acquire(() => {
			calls++;
			throw new Error("DYTEST-private-callback");
		});
		h.stdout.push(Buffer.concat([line(1), line(2)]));
		await failure(h);
		expect(calls).toBe(1);
		expect(h.drainState()).toBe("pending");
		h.stdout.push(line(3));
		await turn();
		expect(calls).toBe(1);
		await h.finish();
		await rejected(h.pump.drained);
	});

	test("rejects a non-undefined synchronous callback return without extra delivery", async () => {
		let calls = 0;
		const h = acquire(() => {
			calls++;
			return 0;
		});
		h.stdout.push(Buffer.concat([line(1), line(2)]));
		await failure(h);
		expect(calls).toBe(1);
		await h.finish();
		await rejected(h.pump.drained);
	});

	test("joins one unexpected original native promise after both readers close", async () => {
		let calls = 0;
		let original!: Gate;
		const h = acquire(() => {
			calls++;
			return original.promise;
		});
		original = h.hold();
		h.stdout.push(Buffer.concat([line(1), line(2)]));
		await failure(h);
		await h.finish();
		expect(calls).toBe(1);
		expect(h.stdout.closeSeen && h.stderr.closeSeen).toBe(true);
		expect(h.drainState()).toBe("pending");
		original.resolve();
		await rejected(h.pump.drained);
	});

	test("observes an unexpected native promise rejection without losing reader ownership", async () => {
		let original!: Gate;
		const h = acquire(() => original.promise);
		original = h.hold();
		h.stdout.push(line(1));
		await failure(h);
		original.reject(new Error("DYTEST-private-rejection"));
		await turn();
		expect(h.drainState()).toBe("pending");
		await h.finish();
		await rejected(h.pump.drained);
	});

	test("refuses unknown thenables and proxies without assimilating caller hooks", async () => {
		let hooks = 0;
		// biome-ignore lint/suspicious/noThenProperty: This fixture verifies that a hostile thenable getter is never invoked.
		const thenable = Object.defineProperty({}, "then", {
			get() {
				hooks++;
				throw new Error("DYTEST then");
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					hooks++;
					throw new Error("DYTEST proxy");
				},
			},
		);
		for (const value of [thenable, proxy]) {
			let calls = 0;
			const h = acquire(() => {
				calls++;
				return value;
			});
			h.stdout.push(Buffer.concat([line(1), line(2)]));
			await failure(h);
			expect(hooks).toBe(0);
			expect(calls).toBe(1);
			await h.finish();
			await rejected(h.pump.drained);
			expect(hooks).toBe(0);
		}
	});

	test("premature stdout close is refused while stderr still drains independently", async () => {
		const h = acquire();
		h.stdout.beginOwnerClose();
		h.stdout.releaseOwnerClose();
		await h.stdout.originalClose.promise;
		await failure(h);
		expect(h.stdout.endSeen).toBe(false);
		h.stderr.push(Buffer.alloc(128 * 1024, 255));
		await turn();
		expect(h.stderr.input.readableLength).toBe(0);
		expect(h.stderr.ownerDestroyCalls).toBe(0);
		expect(h.drainState()).toBe("pending");
		h.stderr.end();
		await turn();
		h.stderr.beginOwnerClose();
		h.stderr.releaseOwnerClose();
		await h.stderr.originalClose.promise;
		await rejected(h.pump.drained);
	});

	test("premature stderr close refuses observation and fences future stdout delivery", async () => {
		const h = acquire();
		h.stderr.beginOwnerClose();
		h.stderr.releaseOwnerClose();
		await h.stderr.originalClose.promise;
		await failure(h);
		h.stdout.push(line("DYTEST-fenced"));
		await turn();
		expect(h.frames).toEqual([]);
		expect(h.stdout.input.readableLength).toBe(0);
		expect(h.drainState()).toBe("pending");
		h.stdout.end();
		await turn();
		h.stdout.beginOwnerClose();
		h.stdout.releaseOwnerClose();
		await h.stdout.originalClose.promise;
		await rejected(h.pump.drained);
	});

	test("actual reader error stays fatal after prior genuine EOF and waits both closes", async () => {
		const h = acquire();
		h.stdout.push(line("DYTEST-before-error"));
		h.stdout.end();
		await turn();
		expect(h.stdout.endSeen).toBe(true);
		h.stdout.beginOwnerClose(new Error("DYTEST-private-stream"));
		await turn();
		// The original _destroy callback still owns the error/close publication.
		expect(h.stdout.errors).toEqual([]);
		expect(h.stdout.closeSeen).toBe(false);
		h.stdout.releaseOwnerClose();
		await h.stdout.originalClose.promise;
		await failure(h);
		expect(h.stdout.errors).toHaveLength(1);
		expect(h.stdout.endSeen).toBe(true);
		expect(h.drainState()).toBe("pending");
		h.stderr.end();
		await turn();
		h.stderr.beginOwnerClose();
		h.stderr.releaseOwnerClose();
		await h.stderr.originalClose.promise;
		await rejected(h.pump.drained);
	});
});
