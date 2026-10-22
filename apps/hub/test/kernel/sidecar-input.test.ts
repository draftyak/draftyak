import { randomBytes } from "node:crypto";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	type InitialMaterial,
	receiveSidecarInput,
	SIDECAR_INPUT_BOUNDS,
	SIDECAR_INPUT_CONSUMER,
	SIDECAR_INPUT_FORMAT,
	SIDECAR_INPUT_IO,
	SIDECAR_INPUT_OPTIONS,
	SIDECAR_INPUT_ORDER,
	SIDECAR_INPUT_SOURCE,
	SIDECAR_INPUT_STATE,
	SIDECAR_INPUT_STOPPED,
	SIDECAR_INPUT_TRUNCATED,
	type SidecarControl,
	type SidecarInput,
	type SidecarInputCode,
	SidecarInputError,
	type SidecarInputOptions,
	type SidecarStop,
} from "../../src/kernel/sidecar-input.ts";

const RESUME = '{"power":"resumed"}';
const SHUTDOWN = '{"shutdown":true}';
const RESUMED: SidecarControl = { kind: "resumed" };
const MIB = 1_048_576;
const SIZES = [4, MIB, 32, 16, 32];

const stop = (reason: SidecarStop["reason"], code?: SidecarStop["code"]): SidecarStop =>
	code === undefined ? { kind: "stop", reason } : { kind: "stop", reason, code };

const lengthHeader = (length: number): Buffer =>
	Buffer.from([length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);

function frame(payload: string | Uint8Array): Buffer {
	const body = typeof payload === "string" ? Buffer.from(payload, "latin1") : Buffer.from(payload);
	return Buffer.concat([lengthHeader(body.length), body]);
}

interface Synthetic {
	readonly key: Buffer;
	readonly bootstrap: Buffer;
	readonly mk: string;
	readonly bs: string;
	/** The kept sender's compact serialization, keys in sorted order. */
	readonly payload: string;
	readonly keyFirst: string;
}

function synthetic(): Synthetic {
	const key = randomBytes(32);
	const bootstrap = randomBytes(16);
	const mk = key.toString("hex");
	const bs = bootstrap.toString("hex");
	return {
		key,
		bootstrap,
		mk,
		bs,
		payload: `{"bootstrapSecret":"${bs}","masterKey":"${mk}"}`,
		keyFirst: `{"masterKey":"${mk}","bootstrapSecret":"${bs}"}`,
	};
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const quietSource = (): Readable => new Readable({ read() {} });
const zero = (data: Uint8Array): boolean => data.every((byte) => byte === 0);

interface Harness {
	readonly input: SidecarInput;
	readonly source: Readable;
	/** Every chunk fed, kept to inspect the receiver's erasure of consumed views. */
	readonly fed: Buffer[];
	feed(...chunks: Buffer[]): Promise<void>;
}

function open(options?: SidecarInputOptions, source: Readable = quietSource()): Harness {
	const input = receiveSidecarInput(source, options);
	const fed: Buffer[] = [];
	return {
		input,
		source,
		fed,
		async feed(...chunks) {
			for (const chunk of chunks) {
				fed.push(chunk);
				source.push(chunk);
				await tick();
			}
		},
	};
}

async function opened(options?: SidecarInputOptions): Promise<Harness & { values: Synthetic }> {
	const values = synthetic();
	const harness = open(options);
	await harness.feed(frame(values.payload));
	await harness.input.initialReady;
	return { ...harness, values };
}

interface Tracked<T> {
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	error?: unknown;
}

function track<T>(promise: Promise<T>): Tracked<T> {
	const tracked: Tracked<T> = { status: "pending" };
	promise.then(
		(value) => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		(error: unknown) => {
			tracked.status = "rejected";
			tracked.error = error;
		},
	);
	return tracked;
}

const refusal = (error: unknown): string | undefined =>
	error instanceof SidecarInputError && error.message === error.code && error.cause === undefined
		? error.code
		: undefined;

function expectThrown(run: () => unknown, code: SidecarInputCode): void {
	let thrown: unknown;
	try {
		run();
	} catch (error) {
		thrown = error;
	}
	expect(refusal(thrown)).toBe(code);
}

async function expectRejected(promise: Promise<unknown>, code: SidecarInputCode): Promise<void> {
	let thrown: unknown;
	try {
		await promise;
	} catch (error) {
		thrown = error;
	}
	expect(refusal(thrown)).toBe(code);
}

// Compares through booleans so a failure never prints synthetic key bytes.
function expectMaterial(material: InitialMaterial | undefined, values: Synthetic): void {
	expect(material?.masterKey).toBeInstanceOf(MasterKey);
	expect(material?.bootstrapSecret.length).toBe(16);
	expect(material?.bootstrapSecret.equals(values.bootstrap)).toBe(true);
	const expected = new MasterKey(values.key);
	const want = expected.derive("db");
	let got: Buffer | undefined;
	try {
		got = material?.masterKey.derive("db");
		expect(got?.equals(want)).toBe(true);
	} finally {
		want.fill(0);
		got?.fill(0);
		expected.destroy();
	}
}

function release(material: InitialMaterial | undefined): void {
	material?.bootstrapSecret.fill(0);
	material?.masterKey.destroy();
}

interface Observation {
	readonly owned: Buffer[];
	others: number;
}

const RECEIVER_STACK = /kernel[\\/]sidecar-(?:input|frame)\.ts/;
const WATCHED = ["allocUnsafe", "allocUnsafeSlow", "from", "concat"] as const;

/**
 * Observe the real native Buffers the receiver allocates while still calling the original
 * allocators. Keeps at most eight references, counts any other receiver allocation and restores
 * every allocator in finally.
 */
async function observeAllocations(
	run: (observation: Observation) => Promise<void>,
	refuse?: (size: number, index: number) => boolean,
): Promise<Observation> {
	const observation: Observation = { owned: [], others: 0 };
	const fromReceiver = (): boolean => RECEIVER_STACK.test(new Error().stack ?? "");
	const buffer = Buffer as unknown as Record<string, unknown>;
	const alloc = Buffer.alloc;
	const originals = WATCHED.map((name) => [name, buffer[name]] as const);
	let index = 0;
	Buffer.alloc = ((...args: Parameters<typeof Buffer.alloc>): Buffer => {
		if (!fromReceiver()) return alloc(...args);
		if (refuse?.(args[0], index++)) throw new RangeError("Synthetic allocation refusal");
		const allocated = alloc(...args);
		if (observation.owned.length < 8) observation.owned.push(allocated);
		else observation.others++;
		return allocated;
	}) as typeof Buffer.alloc;
	for (const [name, original] of originals) {
		buffer[name] = function (this: unknown, ...args: unknown[]): unknown {
			if (fromReceiver()) observation.others++;
			return Reflect.apply(original as (...values: unknown[]) => unknown, this, args);
		};
	}
	try {
		await run(observation);
	} finally {
		Buffer.alloc = alloc;
		for (const [name, original] of originals) buffer[name] = original;
	}
	return observation;
}

function roles(observation: Observation): {
	readonly keyInput: Buffer | undefined;
	readonly bootstrap: Buffer | undefined;
	readonly keyCopy: Buffer | undefined;
} {
	const [, , keyInput, bootstrap, keyCopy] = observation.owned;
	return { keyInput, bootstrap, keyCopy };
}

describe("sidecar input admission", () => {
	const errored = (): Readable => {
		const source = quietSource();
		source.on("error", () => {});
		return source.destroy(new Error("synthetic"));
	};
	const sources: readonly (readonly [string, () => unknown])[] = [
		["undefined", () => undefined],
		["null", () => null],
		["a plain object", () => ({ read: () => null, on: () => undefined, readableLength: 0 })],
		["a writable stream", () => new Writable({ write: (_chunk, _encoding, done) => done() })],
		["a web stream", () => new ReadableStream()],
		["an object-mode readable", () => new Readable({ objectMode: true, read() {} })],
		["an iterable readable", () => Readable.from([Buffer.from("x")])],
		["a readable with an encoding", () => quietSource().setEncoding("utf8")],
		[
			"a flowing readable",
			() => {
				const source = quietSource();
				source.on("data", () => {});
				return source;
			},
		],
		["a paused readable", () => quietSource().pause()],
		["a resumed readable", () => quietSource().resume()],
		[
			"a readable that was read",
			() => {
				const source = quietSource();
				source.push(Buffer.from("x"));
				source.read();
				return source;
			},
		],
		[
			"a readable with a readable listener",
			() => {
				const source = quietSource();
				source.on("readable", () => {});
				return source;
			},
		],
		[
			"a readable with a prepended readable listener",
			() => quietSource().prependListener("readable", () => {}),
		],
		[
			"a readable with a prepended data listener",
			() => quietSource().prependListener("data", () => {}),
		],
		[
			"a readable holding buffered bytes",
			() => {
				const source = quietSource();
				source.push(Buffer.from("x"));
				return source;
			},
		],
		["a destroyed readable", () => quietSource().destroy()],
		["an errored readable", errored],
		[
			"an ended readable",
			async () => {
				const source = quietSource();
				source.push(null);
				source.read(0);
				await tick();
				return source;
			},
		],
		[
			"a readable whose state getter throws",
			() =>
				new Proxy(quietSource(), {
					get(target, property) {
						if (property === "readableFlowing") throw new Error("synthetic");
						return Reflect.get(target, property);
					},
				}),
		],
	];

	it.each(sources)("refuses %s before reading it", async (_label, make) => {
		const candidate = await make();
		const events = ["data", "readable", "end", "error", "close"];
		const listeners = (): number[] =>
			candidate instanceof Readable ? events.map((event) => candidate.listenerCount(event)) : [];
		const before = listeners();
		const destroyed = candidate instanceof Readable && candidate.destroyed;
		expectThrown(() => receiveSidecarInput(candidate as Readable), SIDECAR_INPUT_SOURCE);
		expect(listeners()).toEqual(before);
		expect(candidate instanceof Readable && candidate.destroyed).toBe(destroyed);
	});

	it.each([
		["a number", 1],
		["a string", "signal"],
		["true", true],
		["null", null],
		["a plain signal object", { signal: { aborted: false } }],
		["a string signal", { signal: "abort" }],
		["a null signal", { signal: null }],
		["a forged signal", { signal: Object.create(AbortSignal.prototype) }],
		[
			"a throwing signal getter",
			{
				get signal(): never {
					throw new Error("synthetic");
				},
			},
		],
	])("refuses %s as options without touching the input", (_label, options) => {
		const source = quietSource();
		expectThrown(
			() => receiveSidecarInput(source, options as SidecarInputOptions),
			SIDECAR_INPUT_OPTIONS,
		);
		const events = ["readable", "end", "error", "close"];
		expect(events.map((event) => source.listenerCount(event))).toEqual([0, 0, 0, 0]);
		expect(source.destroyed).toBe(false);
	});

	it("accepts absent options, an empty object and a live signal", async () => {
		const live = new AbortController();
		for (const options of [undefined, {}, { signal: undefined }, { signal: live.signal }]) {
			const { input, source } = open(options);
			expect(input.state).toBe("awaiting-initial");
			await input.dispose();
			expect(source.destroyed).toBe(true);
		}
	});

	it.each([
		["a data listener", (source: Readable, seen: () => void) => source.on("data", seen)],
		["an encoding", (source: Readable) => source.setEncoding("latin1")],
		["a second readable listener", (source: Readable) => source.on("readable", () => {})],
	])("stops with a source fault when %s appears after transfer", async (_label, intrude) => {
		const values = synthetic();
		const { input, source } = open();
		let seen = 0;
		intrude(source, () => {
			seen++;
		});
		source.push(frame(values.payload));
		await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_SOURCE));
		await expectRejected(input.initialReady, SIDECAR_INPUT_SOURCE);
		expect(seen).toBe(0);
		expect(source.destroyed).toBe(true);
		await input.closed;
	});

	it("keeps reading through the read method it was handed", async () => {
		const values = synthetic();
		const { input, source } = open();
		let diverted = 0;
		source.read = function (this: Readable, size?: number) {
			if (size !== 0) {
				diverted++;
				return null;
			}
			return Readable.prototype.read.call(this, size);
		};
		source.push(frame(values.payload));
		await expect(input.initialReady).resolves.toBeUndefined();
		const material = input.takeInitial();
		expectMaterial(material, values);
		expect(diverted).toBe(0);
		await input.dispose();
		release(material);
	});
});

describe("sidecar input initial transfer", () => {
	it("settles readiness on the final initial byte while the input stays open", async () => {
		const values = synthetic();
		const bytes = frame(values.payload);
		const { input, feed } = open();
		const ready = track(input.initialReady);
		await feed(Buffer.from(bytes.subarray(0, bytes.length - 1)));
		expect(ready.status).toBe("pending");
		expect(input.state).toBe("awaiting-initial");
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_STATE);
		await feed(Buffer.from(bytes.subarray(bytes.length - 1)));
		expect(ready.status).toBe("fulfilled");
		expect(ready.value).toBeUndefined();
		expect(input.state).toBe("initial-available");
		await input.dispose();
	});

	it.each([
		["sorted", (values: Synthetic) => values.payload],
		["master-key-first", (values: Synthetic) => values.keyFirst],
		[
			"spaced",
			(values: Synthetic) =>
				` {\r\n\t"masterKey" : "${values.mk}" ,\n "bootstrapSecret":\t"${values.bs}"\t} \n`,
		],
	])("transfers a %s initial frame exactly once", async (_label, payload) => {
		const values = synthetic();
		const { input, feed, source } = open();
		expect(input.state).toBe("awaiting-initial");
		await feed(frame(payload(values)));
		await expect(input.initialReady).resolves.toBeUndefined();
		const material = input.takeInitial();
		expect(input.state).toBe("initial-taken");
		expectMaterial(material, values);
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_STATE);
		expect(source.destroyed).toBe(false);
		await input.dispose();
		expectMaterial(material, values);
		release(material);
	});

	it("allows the take from a readiness callback, once", async () => {
		const values = synthetic();
		const { input, feed } = open();
		let first: InitialMaterial | undefined;
		let second: unknown;
		const done = input.initialReady.then(() => {
			first = input.takeInitial();
			try {
				input.takeInitial();
			} catch (error) {
				second = error;
			}
		});
		await feed(frame(values.payload));
		await done;
		expectMaterial(first, values);
		expect(refusal(second)).toBe(SIDECAR_INPUT_STATE);
		await input.dispose();
		release(first);
	});

	it("does not consume controls when the initial material is taken", async () => {
		const values = synthetic();
		const { input, feed } = open();
		await feed(Buffer.concat([frame(values.payload), frame(RESUME)]));
		const material = input.takeInitial();
		expectMaterial(material, values);
		const control = track(input.nextControl());
		await tick();
		expect(control.value).toEqual(RESUMED);
		await input.dispose();
		release(material);
	});
});

describe("sidecar input framing", () => {
	it("accepts every two-part split of initial and control frames", async () => {
		const values = synthetic();
		const wire = Buffer.concat([frame(values.payload), frame(RESUME), frame(RESUME)]);
		for (let split = 1; split < wire.length; split++) {
			const { input, feed } = open();
			const first = input.nextControl();
			await feed(Buffer.from(wire.subarray(0, split)), Buffer.from(wire.subarray(split)));
			await expect(input.initialReady).resolves.toBeUndefined();
			const material = input.takeInitial();
			expectMaterial(material, values);
			await expect(first).resolves.toEqual(RESUMED);
			await expect(input.nextControl()).resolves.toEqual(RESUMED);
			const later = track(input.nextControl());
			await tick();
			expect(later.status).toBe("pending");
			await input.dispose();
			expect(later.value).toEqual(stop("disposed"));
			release(material);
		}
	});

	it("delivers byte-at-a-time and short reads with the same values and order", async () => {
		const values = synthetic();
		const wire = Buffer.concat([frame(values.payload), frame(RESUME), frame(SHUTDOWN)]);
		for (const sizes of [[1], [2, 3, 5, 7], [4], [61, 1, 50]]) {
			const { input, feed } = open();
			let taken: InitialMaterial | undefined;
			const ready = input.initialReady.then(() => {
				taken = input.takeInitial();
			});
			const first = input.nextControl();
			for (let at = 0, step = 0; at < wire.length; step++) {
				const size = sizes[step % sizes.length] ?? 1;
				await feed(Buffer.from(wire.subarray(at, at + size)));
				at += size;
			}
			await ready;
			await expect(first).resolves.toEqual(RESUMED);
			await expect(input.nextControl()).resolves.toEqual(stop("shutdown"));
			await input.closed;
			expectMaterial(taken, values);
			release(taken);
		}
	});

	it("keeps coalesced controls and a partial following frame after the initial frame", async () => {
		const values = synthetic();
		const tail = frame(SHUTDOWN);
		const { input, feed } = open();
		await feed(
			Buffer.concat([frame(values.payload), frame(RESUME), frame(RESUME), tail.subarray(0, 6)]),
		);
		const material = input.takeInitial();
		await expect(input.nextControl()).resolves.toEqual(RESUMED);
		const waiting = track(input.nextControl());
		await tick();
		expect(waiting.status).toBe("pending");
		await feed(Buffer.from(tail.subarray(6)));
		expect(waiting.value).toEqual(stop("shutdown"));
		await expect(input.nextControl()).resolves.toEqual(stop("shutdown"));
		await input.closed;
		expectMaterial(material, values);
		release(material);
	});

	it("lets a shutdown coalesced with the initial frame win before the take", async () => {
		const values = synthetic();
		const { input, feed } = open();
		await feed(Buffer.concat([frame(values.payload), frame(SHUTDOWN)]));
		await expect(input.initialReady).resolves.toBeUndefined();
		await expect(input.terminal).resolves.toEqual(stop("shutdown"));
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_STOPPED);
		await input.closed;
	});

	it("ignores and wipes every byte after a shutdown frame in the same read", async () => {
		const values = synthetic();
		const { input, feed, fed, source } = open();
		await feed(
			Buffer.concat([
				frame(values.payload),
				frame(RESUME),
				frame(SHUTDOWN),
				frame(RESUME),
				frame(synthetic().keyFirst),
				lengthHeader(MIB + 1),
			]),
		);
		const terminal = await input.terminal;
		expect(terminal).toEqual(stop("shutdown"));
		expect(await input.nextControl()).toBe(terminal);
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_STOPPED);
		expect(fed.every(zero)).toBe(true);
		expect(source.destroyed).toBe(true);
		await input.closed;
	});

	it.each([
		["a zero", 0],
		["a one past 1 MiB", MIB + 1],
		["the largest", 0xffff_ffff],
		["a little-endian", 0x1300_0000],
	])("refuses %s payload length from its header alone", async (_label, length) => {
		const { input, feed, source } = open();
		const terminal = track(input.terminal);
		await feed(lengthHeader(length));
		expect(terminal.value).toEqual(stop("fault", SIDECAR_INPUT_BOUNDS));
		await expectRejected(input.initialReady, SIDECAR_INPUT_BOUNDS);
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_BOUNDS);
		expect(source.destroyed).toBe(true);
		await input.closed;
	});

	it("refuses a legal one-byte payload by its grammar", async () => {
		const { input, feed } = open();
		await feed(frame("{"));
		await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_FORMAT));
		await input.closed;
	});

	it("accepts exact 1 MiB frames in one chunk or odd chunks", async () => {
		for (const size of [MIB + 4, 65_537, 9_999]) {
			const values = synthetic();
			const wire = frame(values.payload + " ".repeat(MIB - values.payload.length));
			expect(wire.length).toBe(MIB + 4);
			const { input, feed } = open();
			for (let at = 0; at < wire.length; at += size)
				await feed(Buffer.from(wire.subarray(at, at + size)));
			await expect(input.initialReady).resolves.toBeUndefined();
			const material = input.takeInitial();
			expectMaterial(material, values);
			await feed(frame(RESUME + " ".repeat(MIB - RESUME.length)));
			await expect(input.nextControl()).resolves.toEqual(RESUMED);
			const terminal = track(input.terminal);
			await feed(lengthHeader(MIB + 1));
			expect(terminal.value).toEqual(stop("fault", SIDECAR_INPUT_BOUNDS));
			await input.closed;
			release(material);
		}
	});

	it.each([
		[
			"upper-case key digits",
			(v: Synthetic) => `{"masterKey":"${v.mk.toUpperCase()}","bootstrapSecret":"${v.bs}"}`,
		],
		[
			"an extra field",
			(v: Synthetic) => `{"bootstrapSecret":"${v.bs}","masterKey":"${v.mk}","extra":true}`,
		],
		[
			"a duplicate key",
			(v: Synthetic) => `{"masterKey":"${v.mk}","bootstrapSecret":"${v.bs}","masterKey":"${v.mk}"}`,
		],
		["a missing bootstrap secret", (v: Synthetic) => `{"masterKey":"${v.mk}"}`],
		["a nested value", () => '{"power":{"resumed":true}}'],
		["a byte order mark", (v: Synthetic) => `${String.fromCharCode(0xef, 0xbb, 0xbf)}${v.payload}`],
	])("ends with a format fault and no material for %s", async (_label, payload) => {
		const values = synthetic();
		const { input, feed, source } = open();
		await feed(frame(payload(values)));
		await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_FORMAT));
		await expectRejected(input.initialReady, SIDECAR_INPUT_FORMAT);
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_FORMAT);
		expect(source.destroyed).toBe(true);
		await input.closed;
	});

	it("keeps one fixed arena and bounded slices across more than 1 MiB of frames", async () => {
		const values = synthetic();
		const frames = [frame(values.payload)];
		for (let i = 0; i < 40; i++) frames.push(frame(RESUME + " ".repeat(30_000 + i * 997)));
		const wire = Buffer.concat(frames);
		expect(wire.length).toBeGreaterThan(MIB);
		const pattern = [1, 7, 4_096, 65_535, 65_536, 65_537, 100_000, 3, 250_000];
		const chunks: Buffer[] = [];
		for (let at = 0, step = 0; at < wire.length; step++) {
			const size = pattern[step % pattern.length] ?? 1;
			chunks.push(Buffer.from(wire.subarray(at, at + size)));
			at += size;
		}
		const slices: number[] = [];
		class Recording extends Readable {
			override read(size?: number): unknown {
				const view: unknown = super.read(size);
				if (view instanceof Uint8Array) slices.push(view.length);
				return view;
			}
		}
		let delivered = 0;
		let taken: InitialMaterial | undefined;
		const observation = await observeAllocations(async () => {
			const source = new Recording({ read() {} });
			const input = receiveSidecarInput(source);
			// Ends after one delivery too many, so a resume that never clears fails instead of hanging.
			const consumer = (async () => {
				while (delivered <= 40) {
					const control = await input.nextControl();
					if (control.kind === "stop") return;
					delivered++;
				}
			})();
			const ready = input.initialReady.then(() => {
				taken = input.takeInitial();
			});
			for (const chunk of chunks) {
				source.push(chunk);
				await tick();
			}
			await ready;
			await input.dispose();
			await consumer;
		});
		expect(observation.owned.map((owned) => owned.length)).toEqual(SIZES);
		expect(observation.others).toBe(0);
		expect(slices.reduce((sum, size) => sum + size, 0)).toBe(wire.length);
		const largest = Math.max(...slices);
		expect(largest).toBeLessThanOrEqual(65_536);
		expect(SIZES.reduce((sum, size) => sum + size, 0) + largest).toBeLessThanOrEqual(1_114_196);
		expect(delivered).toBeGreaterThanOrEqual(1);
		expect(delivered).toBeLessThanOrEqual(40);
		expect(chunks.every(zero)).toBe(true);
		expectMaterial(taken, values);
		release(taken);
	});
});

describe("sidecar input controls", () => {
	it("coalesces any number of undelivered resumes into one delivery", async () => {
		const { input, feed } = await opened();
		for (let i = 0; i < 5; i++) await feed(frame(RESUME));
		await expect(input.nextControl()).resolves.toEqual(RESUMED);
		const next = track(input.nextControl());
		await tick();
		expect(next.status).toBe("pending");
		await feed(frame(RESUME));
		expect(next.value).toEqual(RESUMED);
		await feed(Buffer.concat(Array.from({ length: 50_000 }, () => frame(RESUME))));
		await expect(input.nextControl()).resolves.toEqual(RESUMED);
		const after = track(input.nextControl());
		await tick();
		expect(after.status).toBe("pending");
		await feed(frame(RESUME), frame(RESUME));
		expect(after.value).toEqual(RESUMED);
		await expect(input.nextControl()).resolves.toEqual(RESUMED);
		await input.dispose();
	});

	it("lets a later stop dominate undelivered resumes", async () => {
		const { input, feed } = await opened();
		await feed(frame(RESUME), frame(RESUME), frame(SHUTDOWN));
		const terminal = await input.terminal;
		expect(terminal).toEqual(stop("shutdown"));
		expect(await input.nextControl()).toBe(terminal);
		await input.closed;
	});

	it("observes EOF behind undelivered resumes without a consumer", async () => {
		const { input, feed, source } = await opened();
		await feed(frame(RESUME), frame(RESUME));
		source.push(null);
		const terminal = await input.terminal;
		expect(terminal).toEqual(stop("eof"));
		expect(await input.nextControl()).toBe(terminal);
		await input.closed;
	});

	it("refuses a second pending consumer without losing or duplicating a resume", async () => {
		const { input, feed } = await opened();
		const first = track(input.nextControl());
		await expectRejected(input.nextControl(), SIDECAR_INPUT_CONSUMER);
		expect(input.state).toBe("initial-available");
		await feed(frame(RESUME));
		expect(first.value).toEqual(RESUMED);
		const second = track(input.nextControl());
		await tick();
		expect(second.status).toBe("pending");
		await feed(frame(RESUME));
		expect(second.value).toEqual(RESUMED);
		await input.dispose();
	});

	it.each([
		["a resume", RESUME, SIDECAR_INPUT_ORDER],
		["a shutdown", SHUTDOWN, SIDECAR_INPUT_ORDER],
		["an unknown frame", '{"ping":true}', SIDECAR_INPUT_FORMAT],
	] as const)("refuses %s before the initial frame", async (_label, payload, code) => {
		const { input, feed } = open();
		const control = track(input.nextControl());
		const terminal = track(input.terminal);
		await feed(frame(payload));
		expect(terminal.value).toEqual(stop("fault", code));
		expect(control.value).toBe(terminal.value);
		await expectRejected(input.initialReady, code);
		await input.closed;
	});

	it.each([
		["the same", (values: Synthetic) => values.keyFirst],
		["different", () => synthetic().payload],
	])("refuses a repeated initial frame with %s values", async (_label, repeat) => {
		const before = await opened();
		const untaken = track(before.input.terminal);
		await before.feed(frame(repeat(before.values)));
		expect(untaken.value).toEqual(stop("fault", SIDECAR_INPUT_ORDER));
		expectThrown(() => before.input.takeInitial(), SIDECAR_INPUT_ORDER);
		await before.input.closed;

		const after = await opened();
		const material = after.input.takeInitial();
		const taken = track(after.input.terminal);
		await after.feed(frame(repeat(after.values)));
		expect(taken.value).toEqual(stop("fault", SIDECAR_INPUT_ORDER));
		expectThrown(() => after.input.takeInitial(), SIDECAR_INPUT_STATE);
		await after.input.closed;
		expectMaterial(material, after.values);
		release(material);
	});
});

describe("sidecar input stops", () => {
	it("treats EOF before any byte as a missing initial frame", async () => {
		const { input, source } = open();
		const control = input.nextControl();
		source.push(null);
		await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_TRUNCATED));
		await expect(control).resolves.toEqual(stop("fault", SIDECAR_INPUT_TRUNCATED));
		await expectRejected(input.initialReady, SIDECAR_INPUT_TRUNCATED);
		expectThrown(() => input.takeInitial(), SIDECAR_INPUT_TRUNCATED);
		await input.closed;
		expect(input.state).toBe("closed");
	});

	it("treats EOF inside every header and payload byte of the initial frame as truncation", async () => {
		const values = synthetic();
		const wire = frame(values.payload);
		for (let at = 1; at < wire.length; at++) {
			const { input, feed, source } = open();
			await feed(Buffer.from(wire.subarray(0, at)));
			source.push(null);
			await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_TRUNCATED));
			await expectRejected(input.initialReady, SIDECAR_INPUT_TRUNCATED);
			await input.closed;
		}
	});

	it("ends cleanly at a frame boundary after the initial frame, taken or not", async () => {
		const untaken = await opened();
		untaken.source.push(null);
		await expect(untaken.input.terminal).resolves.toEqual(stop("eof"));
		expectThrown(() => untaken.input.takeInitial(), SIDECAR_INPUT_STOPPED);
		await untaken.input.closed;

		const taken = await opened();
		const material = taken.input.takeInitial();
		await taken.feed(frame(RESUME));
		taken.source.push(null);
		await expect(taken.input.terminal).resolves.toEqual(stop("eof"));
		await expect(taken.input.nextControl()).resolves.toEqual(stop("eof"));
		await taken.input.closed;
		expectMaterial(material, taken.values);
		release(material);
	});

	it("treats EOF inside every byte of a later frame as truncation, taken or not", async () => {
		const wire = frame(RESUME);
		for (const take of [true, false]) {
			for (let at = 1; at < wire.length; at++) {
				const { input, feed, source, values } = await opened();
				const material = take ? input.takeInitial() : undefined;
				await feed(Buffer.from(wire.subarray(0, at)));
				source.push(null);
				await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_TRUNCATED));
				expectThrown(
					() => input.takeInitial(),
					take ? SIDECAR_INPUT_STATE : SIDECAR_INPUT_TRUNCATED,
				);
				await input.closed;
				if (material !== undefined) {
					expectMaterial(material, values);
					release(material);
				}
			}
		}
	});

	it.each([
		["a shutdown frame", (h: Harness) => h.source.push(frame(SHUTDOWN)), stop("shutdown")],
		[
			"a stream error",
			(h: Harness) => h.source.destroy(new Error("synthetic failure reading C:/private/path")),
			stop("fault", SIDECAR_INPUT_IO),
		],
		[
			"cancellation",
			(_h: Harness, controller: AbortController) => controller.abort(),
			stop("cancelled"),
		],
		["disposal", (h: Harness) => void h.input.dispose(), stop("disposed")],
	])("lets %s dominate undelivered and pending controls", async (_label, trigger, expected) => {
		for (const pending of [false, true]) {
			const controller = new AbortController();
			const harness = await opened({ signal: controller.signal });
			const { input, feed, source } = harness;
			const waiting = pending ? input.nextControl() : undefined;
			if (!pending) await feed(frame(RESUME), frame(RESUME));
			trigger(harness, controller);
			const terminal = await input.terminal;
			expect(terminal).toEqual(expected);
			expect(Object.isFrozen(terminal)).toBe(true);
			if (waiting) expect(await waiting).toBe(terminal);
			expect(await input.nextControl()).toBe(terminal);
			controller.abort();
			await input.dispose().catch(() => undefined);
			expect(await input.terminal).toBe(terminal);
			expect(await input.nextControl()).toBe(terminal);
			expect(source.destroyed).toBe(true);
		}
	});

	it("normalizes a stream error into fixed codes without its cause or text", async () => {
		const { input, source } = await opened();
		source.destroy(new Error("synthetic failure reading C:/private/path"));
		await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_IO));
		let closedError: unknown;
		try {
			await input.closed;
		} catch (error) {
			closedError = error;
		}
		expect(refusal(closedError)).toBe(SIDECAR_INPUT_IO);
		expect(inspect(closedError)).not.toContain("private");
		expect(input.state).toBe("closed");
	});

	it("treats a close without end as an input fault", async () => {
		const { input, source } = await opened();
		source.destroy();
		await expect(input.terminal).resolves.toEqual(stop("fault", SIDECAR_INPUT_IO));
		await expectRejected(input.closed, SIDECAR_INPUT_IO);
		expect(input.state).toBe("closed");
	});

	const stages: readonly (readonly [
		string,
		(harness: Harness) => Promise<{ readonly waiting?: Promise<SidecarControl> }>,
	])[] = [
		["no bytes", async () => ({})],
		[
			"a partial header",
			async (h) => {
				await h.feed(Buffer.from([0, 0]));
				return {};
			},
		],
		[
			"a partial payload",
			async (h) => {
				await h.feed(Buffer.from(frame(synthetic().payload).subarray(0, 40)));
				return {};
			},
		],
		[
			"an untaken initial frame",
			async (h) => {
				await h.feed(frame(synthetic().payload));
				return {};
			},
		],
		[
			"a pending control after the take",
			async (h) => {
				await h.feed(frame(synthetic().payload));
				release(h.input.takeInitial());
				return { waiting: h.input.nextControl() };
			},
		],
	];

	for (const [action, reason] of [
		["cancellation", "cancelled"],
		["disposal", "disposed"],
	] as const) {
		it.each(stages)(`stops once on ${action} at %s`, async (_label, stage) => {
			const controller = new AbortController();
			const harness = open({ signal: controller.signal });
			const { input, source } = harness;
			const ready = track(input.initialReady);
			const waiting = (await stage(harness)).waiting ?? input.nextControl();
			if (action === "cancellation") controller.abort();
			else void input.dispose();
			const terminal = await input.terminal;
			expect(terminal).toEqual(stop(reason));
			expect(input.state).toBe("closing");
			expect(await waiting).toBe(terminal);
			expect(await input.nextControl()).toBe(terminal);
			await input.closed;
			expect(ready.status).not.toBe("pending");
			if (ready.status === "rejected") expect(refusal(ready.error)).toBe(SIDECAR_INPUT_STOPPED);
			expect(source.destroyed).toBe(true);
			expect(input.state).toBe("closed");
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
			const events = ["readable", "end", "error", "close"];
			expect(events.map((event) => source.listenerCount(event))).toEqual([0, 0, 0, 0]);
		});
	}

	it("returns one closed promise from repeated disposal without replacing the first stop", async () => {
		for (const shutdownFirst of [true, false]) {
			let destroys = 0;
			class Counting extends Readable {
				override destroy(error?: Error): this {
					destroys++;
					return super.destroy(error);
				}
			}
			const { input, feed } = open(undefined, new Counting({ read() {} }));
			await feed(frame(synthetic().payload));
			if (shutdownFirst) await feed(frame(SHUTDOWN));
			const first = input.dispose();
			const second = input.dispose();
			expect(first).toBe(second);
			expect(first).toBe(input.closed);
			await first;
			const expected = stop(shutdownFirst ? "shutdown" : "disposed");
			await expect(input.terminal).resolves.toEqual(expected);
			expect(input.dispose()).toBe(first);
			await expect(input.nextControl()).resolves.toEqual(expected);
			expect(destroys).toBe(1);
		}
	});

	it("settles closed only after the input actually closes", async () => {
		let finishClose: (() => void) | undefined;
		const source = new Readable({
			read() {},
			destroy(error, callback) {
				finishClose = () => callback(error);
			},
		});
		const { input } = open(undefined, source);
		const closed = track(input.closed);
		const disposed = input.dispose();
		await expect(input.terminal).resolves.toEqual(stop("disposed"));
		await tick();
		expect(closed.status).toBe("pending");
		expect(input.state).toBe("closing");
		expect(finishClose).toBeDefined();
		finishClose?.();
		await disposed;
		expect(input.state).toBe("closed");
	});

	it("rejects closed when the input cannot be destroyed", async () => {
		class Stubborn extends Readable {
			override destroy(): this {
				throw new Error("synthetic destroy failure");
			}
		}
		const source = new Stubborn({ read() {} });
		const { input } = open(undefined, source);
		await expectRejected(input.dispose(), SIDECAR_INPUT_IO);
		await expect(input.terminal).resolves.toEqual(stop("disposed"));
		expect(input.state).toBe("closed");
		Readable.prototype.destroy.call(source);
		await tick();
		expect(source.listenerCount("error") + source.listenerCount("close")).toBe(0);
	});

	it("stops at once for an already aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const { input, source } = open({ signal: controller.signal });
		await expect(input.terminal).resolves.toEqual(stop("cancelled"));
		await expectRejected(input.initialReady, SIDECAR_INPUT_STOPPED);
		await input.closed;
		expect(source.destroyed).toBe(true);
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
	});
});

describe("sidecar input ownership and erasure", () => {
	it.each([
		["disposal", (h: Harness) => void h.input.dispose()],
		["a shutdown frame", (h: Harness) => h.source.push(frame(SHUTDOWN))],
		["a format fault", (h: Harness) => h.source.push(frame("{"))],
		["a stream error", (h: Harness) => h.source.destroy(new Error("synthetic"))],
	])("leaves taken material with the caller through %s", async (_label, end) => {
		const values = synthetic();
		const harness = open();
		const wire = frame(values.payload);
		await harness.feed(wire);
		const material = harness.input.takeInitial();
		wire.fill(0xff);
		end(harness);
		await harness.input.terminal;
		await harness.input.closed.catch(() => undefined);
		expectMaterial(material, values);
		material.masterKey.destroy();
		expect(() => material.masterKey.derive("db")).toThrow("locked");
		material.bootstrapSecret.fill(0);
	});

	it("erases arenas, views and the key input while the caller keeps taken material", async () => {
		const values = synthetic();
		let fed: Buffer[] = [];
		let atReady: boolean[] = [];
		let afterControl: boolean[] = [];
		let material: InitialMaterial | undefined;
		const observation = await observeAllocations(async (seen) => {
			const harness = open();
			fed = harness.fed;
			const [header, arena] = seen.owned;
			const wiped = (): boolean[] => [
				header !== undefined && zero(header),
				arena !== undefined && zero(arena),
				fed.every(zero),
			];
			await harness.feed(frame(values.payload));
			await harness.input.initialReady;
			const { keyInput, bootstrap, keyCopy } = roles(seen);
			atReady = [
				...wiped(),
				keyInput !== undefined && zero(keyInput),
				bootstrap?.equals(values.bootstrap) === true,
				keyCopy?.equals(values.key) === true,
			];
			material = harness.input.takeInitial();
			await harness.feed(frame(RESUME));
			await harness.input.nextControl();
			afterControl = wiped();
			await harness.feed(frame(SHUTDOWN));
			await harness.input.closed;
		});
		expect(atReady).toEqual([true, true, true, true, true, true]);
		expect(afterControl).toEqual([true, true, true]);
		expect(observation.owned.map((owned) => owned.length)).toEqual(SIZES);
		expect(observation.others).toBe(0);
		const [header, arena] = observation.owned;
		const { keyInput, bootstrap, keyCopy } = roles(observation);
		expect([header, arena, keyInput].map((owned) => owned !== undefined && zero(owned))).toEqual([
			true,
			true,
			true,
		]);
		expect(fed.every(zero)).toBe(true);
		expect(bootstrap === material?.bootstrapSecret).toBe(true);
		expect([bootstrap?.equals(values.bootstrap), keyCopy?.equals(values.key)]).toEqual([
			true,
			true,
		]);
		release(material);
		expect([bootstrap, keyCopy].map((owned) => owned !== undefined && zero(owned))).toEqual([
			true,
			true,
		]);
	});

	it.each([
		[
			"a format fault",
			(h: Harness) => {
				const other = synthetic();
				return h.feed(
					frame(`{"masterKey":"${other.mk.toUpperCase()}","bootstrapSecret":"${other.bs}"}`),
				);
			},
			stop("fault", SIDECAR_INPUT_FORMAT),
		],
		[
			"a partial payload at EOF",
			async (h: Harness) => {
				await h.feed(Buffer.from(frame(synthetic().payload).subarray(0, 70)));
				h.source.push(null);
			},
			stop("fault", SIDECAR_INPUT_TRUNCATED),
		],
		[
			"an oversized header",
			(h: Harness) => h.feed(lengthHeader(MIB + 1)),
			stop("fault", SIDECAR_INPUT_BOUNDS),
		],
		[
			"a stream error",
			async (h: Harness) => {
				await h.feed(Buffer.from(frame(synthetic().payload).subarray(0, 70)));
				h.source.destroy(new Error("synthetic"));
			},
			stop("fault", SIDECAR_INPUT_IO),
		],
		[
			"cancellation with a partial header",
			async (h: Harness, controller: AbortController) => {
				await h.feed(Buffer.from([0x00, 0x01, 0x02]));
				controller.abort();
			},
			stop("cancelled"),
		],
		[
			"disposal with a partial payload",
			async (h: Harness) => {
				await h.feed(Buffer.from(frame(synthetic().payload).subarray(0, 90)));
				void h.input.dispose();
			},
			stop("disposed"),
		],
		[
			"a repeated initial frame",
			(h: Harness, _controller: AbortController, values: Synthetic) =>
				h.feed(frame(values.keyFirst)),
			stop("fault", SIDECAR_INPUT_ORDER),
		],
		["a shutdown before the take", (h: Harness) => h.feed(frame(SHUTDOWN)), stop("shutdown")],
	])("erases every receiver-owned byte after %s", async (_label, end, expected) => {
		const values = synthetic();
		let fed: Buffer[] = [];
		let terminal: SidecarStop | undefined;
		let late: unknown;
		const observation = await observeAllocations(async () => {
			const controller = new AbortController();
			const harness = open({ signal: controller.signal });
			fed = harness.fed;
			await harness.feed(frame(values.payload));
			await end(harness, controller, values);
			terminal = await harness.input.terminal;
			await harness.input.closed.catch(() => undefined);
			try {
				harness.input.takeInitial();
			} catch (error) {
				late = error;
			}
		});
		expect(terminal).toEqual(expected);
		expect(refusal(late)).toBe(expected.code ?? SIDECAR_INPUT_STOPPED);
		expect(observation.owned.map((owned) => owned.length)).toEqual(SIZES);
		expect(observation.others).toBe(0);
		expect(observation.owned.map(zero)).toEqual([true, true, true, true, true]);
		expect(fed.every(zero)).toBe(true);
	});

	it("erases partial arenas when it stops before any initial frame", async () => {
		let fed: Buffer[] = [];
		const observation = await observeAllocations(async () => {
			const harness = open();
			fed = harness.fed;
			await harness.feed(Buffer.from(frame(synthetic().payload).subarray(0, 50)));
			await harness.input.dispose();
		});
		expect(observation.owned.map((owned) => owned.length)).toEqual([4, MIB]);
		expect(observation.owned.map(zero)).toEqual([true, true]);
		expect(fed.every(zero)).toBe(true);
	});

	it("erases decoded bytes when the key cannot be constructed", async () => {
		const values = synthetic();
		let terminal: SidecarStop | undefined;
		let ready: unknown;
		const observation = await observeAllocations(
			async () => {
				const harness = open();
				await harness.feed(frame(values.payload));
				terminal = await harness.input.terminal;
				ready = await harness.input.initialReady.catch((error: unknown) => refusal(error));
				await harness.input.closed;
			},
			(_size, index) => index === 4,
		);
		expect(terminal).toEqual(stop("fault", SIDECAR_INPUT_IO));
		expect(ready).toBe(SIDECAR_INPUT_IO);
		expect(observation.owned.map((owned) => owned.length)).toEqual([4, MIB, 32, 16]);
		expect(observation.owned.map(zero)).toEqual([true, true, true, true]);
	});

	it.each([
		["disposal", (h: Harness) => void h.input.dispose(), stop("disposed")],
		[
			"cancellation",
			(_h: Harness, controller: AbortController) => controller.abort(),
			stop("cancelled"),
		],
		[
			"a stream error",
			(h: Harness) => h.source.destroy(new Error("synthetic")),
			stop("fault", SIDECAR_INPUT_IO),
		],
	])("wipes every chunk the input still buffers on %s", async (_label, end, expected) => {
		const controller = new AbortController();
		const harness = open({ signal: controller.signal });
		const chunks = [frame(synthetic().payload), frame(RESUME)];
		for (const chunk of chunks) harness.source.push(chunk);
		end(harness, controller);
		await expect(harness.input.terminal).resolves.toEqual(expected);
		await harness.input.closed.catch(() => undefined);
		expect(chunks.every(zero)).toBe(true);
		expect(harness.source.readableLength).toBe(0);
		expect(harness.source.destroyed).toBe(true);
	});

	it("wipes what the input still buffers past the read that stopped it", async () => {
		const values = synthetic();
		const { input, feed, fed, source } = open();
		await feed(
			Buffer.concat([
				frame(values.payload),
				frame(SHUTDOWN),
				Buffer.alloc(65_536, 0x20),
				frame(synthetic().keyFirst),
			]),
		);
		await expect(input.terminal).resolves.toEqual(stop("shutdown"));
		await input.closed;
		expect(fed.every(zero)).toBe(true);
		expect(source.readableLength).toBe(0);
	});

	it("rejects closed when what the input still buffers cannot be read", async () => {
		let failing = false;
		class Failing extends Readable {
			override read(size?: number): unknown {
				if (!failing) return super.read(size);
				failing = false;
				throw new Error("synthetic read failure");
			}
		}
		const source = new Failing({ read() {} });
		const { input } = open(undefined, source);
		source.push(frame(RESUME));
		failing = true;
		await expectRejected(input.dispose(), SIDECAR_INPUT_IO);
		await expect(input.terminal).resolves.toEqual(stop("disposed"));
		expect(failing).toBe(false);
		expect(source.destroyed).toBe(true);
		expect(input.state).toBe("closed");
	});
});

describe("sidecar input boundary", () => {
	it("redacts the receiver, its material, stops and refusals", async () => {
		const { input, values } = await opened();
		const secrets = [values.key, values.bootstrap].flatMap((bytes) => {
			const hex = bytes.toString("hex");
			return [hex, hex.toUpperCase(), bytes.toString("base64")];
		});
		const leaks = (text: string | undefined): boolean =>
			secrets.some((secret) => text?.includes(secret) === true);
		expect(inspect(input) === "[REDACTED]").toBe(true);
		expect(JSON.stringify(input) === '"[REDACTED]"').toBe(true);
		expect(leaks(inspect(input, { showHidden: true, depth: 8, customInspect: false }))).toBe(false);
		const material = input.takeInitial();
		expect(Object.isFrozen(material)).toBe(true);
		expect(Object.keys(material)).toEqual(["masterKey", "bootstrapSecret"]);
		expect(inspect(material) === "[REDACTED]").toBe(true);
		expect(inspect({ material }, { depth: 8 }) === "{ material: [REDACTED] }").toBe(true);
		expect(JSON.stringify({ material }) === '{"material":"[REDACTED]"}').toBe(true);
		let refused: unknown;
		try {
			input.takeInitial();
		} catch (error) {
			refused = error;
		}
		expect(refusal(refused)).toBe(SIDECAR_INPUT_STATE);
		expect(leaks(inspect(refused))).toBe(false);
		expect(leaks(JSON.stringify(refused))).toBe(false);
		await input.dispose();
		const terminal = await input.terminal;
		expect(JSON.stringify(terminal)).toBe('{"kind":"stop","reason":"disposed"}');
		release(material);
	});

	it("exposes only the transport surface and no authority", async () => {
		const { input } = open();
		expect(Object.keys(input).sort()).toEqual(["closed", "initialReady", "terminal"]);
		const prototype = Object.getPrototypeOf(input) as object;
		expect(Object.getOwnPropertyNames(prototype).sort()).toEqual([
			"constructor",
			"dispose",
			"nextControl",
			"state",
			"takeInitial",
			"toJSON",
		]);
		expect(Object.getOwnPropertySymbols(prototype)).toEqual([inspect.custom]);
		await input.dispose();
	});

	it("never turns payload bytes into strings or adopts ambient input", () => {
		const forbidden: readonly (readonly [string, RegExp])[] = [
			["JSON parsing", /JSON\s*\.\s*parse/],
			["text decoding", /TextDecoder|StringDecoder/],
			["string conversion", /\btoString\b|\bString\s*\(|fromCharCode|fromCodePoint/],
			["buffer string slices", /[a-z0-9]Slice\b|\.write\s*\(|\btoLocaleString\b/],
			["buffer growth", /\bconcat\b|Buffer\s*\.\s*from\b|allocUnsafe/],
			["template strings", /`/],
			["ambient process input", /\bprocess\b|\benv\b|node:fs|require\s*\(|setEncoding/],
		];
		const found: string[] = [];
		for (const file of ["sidecar-input.ts", "sidecar-frame.ts"]) {
			const source = readFileSync(new URL(`../../src/kernel/${file}`, import.meta.url), "utf8");
			for (const [label, pattern] of forbidden)
				if (pattern.test(source)) found.push(`${file}: ${label}`);
		}
		expect(found).toEqual([]);
	});
});
