import { describe, expect, it } from "vitest";
import {
	MAX_BYTES,
	MBOX_CHUNK_BYTES,
	MboxError,
	type MboxMessage,
	writeMbox,
} from "../src/index.ts";

const raw = Buffer.from("From: owner@example.test\r\nSubject: Synthetic\r\n\r\nBody\r\n");
const message = (bytes: Uint8Array = raw): MboxMessage => ({
	raw: bytes,
	envelopeFrom: "owner@example.test",
	receivedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5),
});
const frame = (bytes: Uint8Array = raw): Buffer =>
	Buffer.concat([
		Buffer.from("From owner@example.test Fri Jan  2 03:04:05 2026\n"),
		Buffer.from(bytes),
		Buffer.from("\n"),
	]);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function tracked(values: readonly MboxMessage[]) {
	const counts = { acquired: 0, next: 0, returned: 0 };
	const source: AsyncIterable<MboxMessage> = {
		[Symbol.asyncIterator]() {
			counts.acquired++;
			let at = 0;
			return {
				async next(): Promise<IteratorResult<MboxMessage>> {
					counts.next++;
					return at < values.length
						? { done: false, value: values[at++] as MboxMessage }
						: { done: true, value: undefined };
				},
				async return(): Promise<IteratorResult<MboxMessage>> {
					counts.returned++;
					return { done: true, value: undefined };
				},
			};
		},
	};
	return { source, counts };
}

async function collect(stream: AsyncIterable<Uint8Array>, seen: Buffer[] = []): Promise<Buffer> {
	for await (const chunk of stream) seen.push(Buffer.from(chunk));
	return Buffer.concat(seen);
}

async function code(promise: Promise<unknown>, expected: MboxError["code"]): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(MboxError);
	await expect(promise).rejects.toMatchObject({ code: expected });
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("bounded mbox streaming", () => {
	it.each([
		{ name: "message count above its hard maximum", options: { maxMessages: 10_001 } },
		{
			name: "raw message bytes above their hard maximum",
			options: { maxMessageBytes: MAX_BYTES + 1 },
		},
		{ name: "archive bytes above their hard maximum", options: { maxOutputBytes: 2 ** 30 + 1 } },
		{ name: "negative count", options: { maxMessages: -1 } },
		{ name: "fractional byte count", options: { maxMessageBytes: 0.5 } },
		{ name: "NaN archive bound", options: { maxOutputBytes: Number.NaN } },
		{ name: "infinite count", options: { maxMessages: Number.POSITIVE_INFINITY } },
	])("refuses $name before acquiring the source", async ({ options }) => {
		const input = tracked([message()]);
		await code(writeMbox(input.source, options).next(), "BAD_INPUT");
		expect(input.counts).toEqual({ acquired: 0, next: 0, returned: 0 });
	});

	it("rejects non-byte raw content and closes the acquired iterator", async () => {
		const invalid = { ...message(), raw: "Synthetic invalid raw bytes" } as unknown as MboxMessage;
		const input = tracked([invalid]);
		await code(writeMbox(input.source).next(), "BAD_INPUT");
		expect(input.counts).toEqual({ acquired: 1, next: 1, returned: 1 });
	});

	it("exports an empty source with all limits zero", async () => {
		const input = tracked([]);
		expect(
			await collect(
				writeMbox(input.source, {
					maxMessages: 0,
					maxMessageBytes: 0,
					maxOutputBytes: 0,
				}),
			),
		).toEqual(Buffer.alloc(0));
		expect(input.counts.next).toBe(1);
	});

	it("does not acquire or read the source until output is requested", async () => {
		const input = tracked([message()]);
		const stream = writeMbox(input.source);
		await turn();
		expect(input.counts).toEqual({ acquired: 0, next: 0, returned: 0 });
		await stream.return(undefined);
		expect(input.counts).toEqual({ acquired: 0, next: 0, returned: 0 });
	});

	it("keeps backpressure while a message spans several output chunks", async () => {
		const large = Buffer.from(`Subject: Synthetic\r\n\r\n${"a".repeat(MBOX_CHUNK_BYTES * 3)}\r\n`);
		const input = tracked([message(large), message()]);
		const stream = writeMbox(input.source);
		try {
			for (let n = 0; n < 3; n++) {
				const next = await stream.next();
				expect(next.done).toBe(false);
				expect(next.value).toBeInstanceOf(Uint8Array);
				expect(next.value.byteLength).toBeGreaterThan(0);
				expect(next.value.byteLength).toBeLessThanOrEqual(65_536);
				await turn();
				expect(input.counts.next).toBe(1);
			}
		} finally {
			await stream.return(undefined);
		}
		expect(input.counts.returned).toBe(1);
	});

	it("accepts the exact raw-message byte limit", async () => {
		expect(await collect(writeMbox([message()], { maxMessageBytes: raw.byteLength }))).toEqual(
			frame(),
		);
	});

	it.each([
		{ name: "Uint8Array", bytes: Uint8Array.of(65, 66) },
		{ name: "Buffer offset subarray", bytes: Buffer.from([0, 65, 66, 0]).subarray(1, 3) },
	])("accepts exactly two native bytes from a $name", async ({ bytes }) => {
		expect(await collect(writeMbox([message(bytes)], { maxMessageBytes: 2 }))).toEqual(
			frame(Buffer.from("AB")),
		);
	});

	it.each(["ordinary", "data shadow", "accessor shadow"] as const)(
		"refuses three native bytes with %s byteLength before output and closes the source",
		async (kind) => {
			const bytes = Uint8Array.of(65, 66, 67);
			let reads = 0;
			if (kind === "data shadow") Object.defineProperty(bytes, "byteLength", { value: 0 });
			if (kind === "accessor shadow")
				Object.defineProperty(bytes, "byteLength", {
					get() {
						reads++;
						throw new Error("Synthetic shadow byte length getter");
					},
				});
			const input = tracked([message(bytes), message(Uint8Array.of(68, 69))]);
			const seen: Buffer[] = [];
			await code(
				collect(writeMbox(input.source, { maxMessageBytes: 2 }), seen),
				"MESSAGE_TOO_LARGE",
			);
			expect(seen).toHaveLength(0);
			expect(input.counts).toEqual({ acquired: 1, next: 1, returned: 1 });
			expect(reads).toBe(0);
		},
	);

	it.each([0, raw.byteLength - 1])(
		"refuses raw bytes beyond cap %i before yielding the record",
		async (limit) => {
			const input = tracked([message()]);
			await code(writeMbox(input.source, { maxMessageBytes: limit }).next(), "MESSAGE_TOO_LARGE");
			expect(input.counts.next).toBe(1);
			expect(input.counts.returned).toBe(1);
		},
	);

	it("allows exactly the message-count cap followed by EOF", async () => {
		const input = tracked([message()]);
		expect(await collect(writeMbox(input.source, { maxMessages: 1 }))).toEqual(frame());
		expect(input.counts.next).toBe(2);
	});

	it("does not silently truncate a nonempty source at a zero count cap", async () => {
		const input = tracked([message()]);
		await code(writeMbox(input.source, { maxMessages: 0 }).next(), "TOO_MANY_MESSAGES");
		expect(input.counts.returned).toBe(1);
	});

	it("rejects the first record beyond the count cap without emitting any of it", async () => {
		const input = tracked([message(), message()]);
		const seen: Buffer[] = [];
		await code(collect(writeMbox(input.source, { maxMessages: 1 }), seen), "TOO_MANY_MESSAGES");
		expect(Buffer.concat(seen)).toEqual(frame());
		expect(input.counts.next).toBe(2);
		expect(input.counts.returned).toBe(1);
	});

	it("counts envelope, exact raw bytes and framing at the archive-byte boundary", async () => {
		expect(await collect(writeMbox([message()], { maxOutputBytes: frame().byteLength }))).toEqual(
			frame(),
		);
	});

	it.each([0, frame().byteLength - 1])(
		"refuses wire cap %i before yielding a partial first record",
		async (limit) => {
			const input = tracked([message()]);
			await code(writeMbox(input.source, { maxOutputBytes: limit }).next(), "OUTPUT_TOO_LARGE");
			expect(input.counts.returned).toBe(1);
		},
	);

	it("applies the archive byte budget cumulatively before the next record", async () => {
		const input = tracked([message(), message()]);
		const seen: Buffer[] = [];
		await code(
			collect(writeMbox(input.source, { maxOutputBytes: frame().byteLength * 2 - 1 }), seen),
			"OUTPUT_TOO_LARGE",
		);
		expect(Buffer.concat(seen)).toEqual(frame());
		expect(input.counts.next).toBe(2);
		expect(input.counts.returned).toBe(1);
	});

	it.each(["sync", "async"] as const)(
		"closes a %s source when its consumer stops",
		async (kind) => {
			let closed = 0;
			function* sync() {
				try {
					yield message();
					yield message();
				} finally {
					closed++;
				}
			}
			async function* asynchronous() {
				try {
					yield message();
					yield message();
				} finally {
					closed++;
				}
			}
			const stream = writeMbox(kind === "sync" ? sync() : asynchronous());
			expect((await stream.next()).done).toBe(false);
			await stream.return(undefined);
			expect(closed).toBe(1);
		},
	);

	it("closes a source whose next read fails after a complete record", async () => {
		let reads = 0,
			closed = 0;
		const source: AsyncIterable<MboxMessage> = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<MboxMessage>> {
						if (++reads === 1) return { done: false, value: message() };
						throw new Error("Synthetic source read failure");
					},
					async return(): Promise<IteratorResult<MboxMessage>> {
						closed++;
						return { done: true, value: undefined };
					},
				};
			},
		};
		const seen: Buffer[] = [];
		await expect(collect(writeMbox(source), seen)).rejects.toBeInstanceOf(Error);
		expect(Buffer.concat(seen)).toEqual(frame());
		expect(reads).toBe(2);
		expect(closed).toBe(1);
	});

	it("refuses an already aborted export without acquiring its source", async () => {
		const input = tracked([message()]),
			controller = new AbortController();
		controller.abort();
		await code(writeMbox(input.source, { signal: controller.signal }).next(), "ABORTED");
		expect(input.counts).toEqual({ acquired: 0, next: 0, returned: 0 });
	});

	it("observes cancellation between chunks without pulling another message", async () => {
		const input = tracked([message(Buffer.alloc(MBOX_CHUNK_BYTES * 2, 65)), message()]);
		const controller = new AbortController(),
			stream = writeMbox(input.source, { signal: controller.signal });
		expect((await stream.next()).done).toBe(false);
		controller.abort();
		await code(stream.next(), "ABORTED");
		expect(input.counts.next).toBe(1);
		expect(input.counts.returned).toBe(1);
	});

	it("aborts a pending read without waiting for source return and handles late rejections", async () => {
		const next = deferred<IteratorResult<MboxMessage>>(),
			closing = deferred<IteratorResult<MboxMessage>>();
		const started = deferred<void>();
		let returns = 0;
		const source: AsyncIterable<MboxMessage> = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						started.resolve(undefined);
						return next.promise;
					},
					return() {
						returns++;
						return closing.promise;
					},
				};
			},
		};
		const controller = new AbortController(),
			stream = writeMbox(source, { signal: controller.signal });
		const pending = stream.next().then(
			(value) => ({ kind: "value" as const, value }),
			(error: unknown) => ({ kind: "error" as const, error }),
		);
		await started.promise;
		controller.abort();
		try {
			const result = await Promise.race([
				pending,
				turn().then(() => ({ kind: "waiting" as const })),
			]);
			expect(result.kind).toBe("error");
			if (result.kind === "error") {
				expect(result.error).toBeInstanceOf(MboxError);
				expect(result.error).toMatchObject({ code: "ABORTED" });
			}
			expect(returns).toBe(1);
		} finally {
			next.reject(new Error("Synthetic late source rejection"));
			if (returns) closing.reject(new Error("Synthetic late cleanup rejection"));
			else closing.resolve({ done: true, value: undefined });
			await pending;
			await turn();
			await stream.return(undefined);
		}
	});
});
