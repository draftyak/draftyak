import { describe, expect, it } from "vitest";
import { type MboxMessage, writeMbox } from "../src/index.ts";

const message: MboxMessage = {
	raw: Buffer.from("From: owner@example.test\r\nSubject: Synthetic cleanup\r\n\r\nBody\r\n"),
	envelopeFrom: "owner@example.test",
	receivedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5),
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function settled<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ kind: "value" as const, value }),
		(error: unknown) => ({ kind: "error" as const, error }),
	);
}

async function withinTurn<T>(promise: Promise<T>) {
	return Promise.race([promise, turn().then(() => ({ kind: "still pending" as const }))]);
}

describe("cancellation after mbox cleanup has started", () => {
	it("settles consumer return after abort without waiting for an uncooperative source return", async () => {
		const cleanup = deferred<IteratorResult<MboxMessage>>();
		const cleanupStarted = deferred<void>();
		let cleanupCalls = 0;
		const source: AsyncIterable<MboxMessage> = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<MboxMessage>> {
						return { done: false, value: message };
					},
					return(): Promise<IteratorResult<MboxMessage>> {
						cleanupCalls++;
						cleanupStarted.resolve(undefined);
						return cleanup.promise;
					},
				};
			},
		};
		const controller = new AbortController();
		const stream = writeMbox(source, { signal: controller.signal });
		expect((await stream.next()).done).toBe(false);
		const completion = settled(stream.return(undefined));
		try {
			expect((await withinTurn(settled(cleanupStarted.promise))).kind).toBe("value");
			expect(cleanupCalls).toBe(1);
			controller.abort();
			const result = await withinTurn(completion);
			expect(result.kind).toBe("value");
			if (result.kind === "value") expect(result.value.done).toBe(true);
			expect(cleanupCalls).toBe(1);
		} finally {
			// Release the synthetic source even if a liveness assertion fails.
			// Do not catch cleanup.promise here: the writer must handle its late rejection.
			if (cleanupCalls) cleanup.reject(new Error("Synthetic late consumer cleanup failure"));
			else cleanup.resolve({ done: true, value: undefined });
			await completion;
			await turn();
		}
		expect(cleanupCalls).toBe(1);
	});

	it("preserves a source read error when abort interrupts cleanup that is already pending", async () => {
		const primary = new Error("Synthetic primary source read failure");
		const cleanup = deferred<IteratorResult<MboxMessage>>();
		const cleanupStarted = deferred<void>();
		let reads = 0;
		let cleanupCalls = 0;
		const source: AsyncIterable<MboxMessage> = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<MboxMessage>> {
						reads++;
						throw primary;
					},
					return(): Promise<IteratorResult<MboxMessage>> {
						cleanupCalls++;
						cleanupStarted.resolve(undefined);
						return cleanup.promise;
					},
				};
			},
		};
		const controller = new AbortController();
		const stream = writeMbox(source, { signal: controller.signal });
		const completion = settled(stream.next());
		try {
			expect((await withinTurn(settled(cleanupStarted.promise))).kind).toBe("value");
			expect(reads).toBe(1);
			expect(cleanupCalls).toBe(1);
			controller.abort();
			const result = await withinTurn(completion);
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.error).toBe(primary);
			expect(cleanupCalls).toBe(1);
		} finally {
			if (cleanupCalls) cleanup.reject(new Error("Synthetic secondary source cleanup failure"));
			else cleanup.resolve({ done: true, value: undefined });
			await completion;
			await turn();
		}
		expect(reads).toBe(1);
		expect(cleanupCalls).toBe(1);
	});
});
