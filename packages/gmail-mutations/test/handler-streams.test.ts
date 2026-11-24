import { Buffer } from "node:buffer";
import { setImmediate as nextTurn } from "node:timers/promises";
import { type PluginContext, PluginError } from "@draftyak/sdk";
import { describe, expect, it } from "vitest";
import { MAX_MUTATION_RESPONSE_READS, mutateGmail } from "../src/mutate.ts";
import { MAX_OBSERVATION_BYTES } from "../src/observe.ts";

const encoder = new TextEncoder();
const input = () => ({
	op: "archive" as const,
	messages: [{ kind: "email" as const, providerId: "a1" }],
});
const payload = () =>
	encoder.encode(JSON.stringify({ id: "a1", threadId: "c1", labelIds: ["STARRED"] }));
function padded(size: number): Uint8Array {
	const value = payload();
	const result = new Uint8Array(size).fill(32);
	result.set(value);
	return result;
}
function context(
	fetch: PluginContext["fetch"],
	signal = new AbortController().signal,
): PluginContext {
	return {
		plugin: "DYTEST-gmail-streams",
		signal,
		fetch,
		ws: {
			async open() {
				throw new Error("Unexpected socket call");
			},
		},
		kv: {
			async get() {
				return undefined;
			},
			async set() {},
			async delete() {},
		},
		async changed() {},
		async log() {},
		async progress() {},
	};
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function streamed(chunks: readonly unknown[], cancel?: () => void | Promise<void>) {
	const facts = { pulls: 0, cancels: 0 };
	let index = 0;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				facts.pulls++;
				if (index === chunks.length) controller.close();
				else controller.enqueue(chunks[index++] as Uint8Array);
			},
			cancel() {
				facts.cancels++;
				return cancel?.();
			},
		},
		{ highWaterMark: 0 },
	);
	return { response: new Response(body, { status: 200 }), facts };
}
async function transient(work: unknown): Promise<void> {
	let caught: unknown;
	try {
		await work;
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PluginError);
	if (!(caught instanceof PluginError)) throw new Error("Expected fixed handler refusal");
	expect(caught.message).toBe("TRANSIENT");
	expect(caught.result).toEqual({ code: "TRANSIENT" });
	expect(String(caught)).not.toContain("DYTEST-unselected");
	expect(JSON.stringify(caught)).not.toContain("DYTEST-unselected");
}

describe("bounded Gmail mutation response streams", () => {
	it("accepts exactly 16 KiB split into native one-byte chunks and EOF", async () => {
		const bytes = padded(MAX_OBSERVATION_BYTES);
		const source = streamed(Array.from(bytes, (byte) => new Uint8Array([byte])));
		await expect(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		).resolves.toEqual({});
		expect(source.facts.pulls).toBe(MAX_OBSERVATION_BYTES + 1);
		expect(source.response.body?.locked).toBe(false);
	});

	it("copies the bounded Buffer view without reading caller byte hooks or its backing pool", async () => {
		const bytes = payload();
		const backing = Buffer.alloc(MAX_OBSERVATION_BYTES + 1_024, 0xff);
		backing.set(bytes, 64);
		const view = backing.subarray(64, 64 + bytes.byteLength);
		const hooks = { length: 0, offset: 0, buffer: 0, iterator: 0 };
		Object.defineProperties(view, {
			byteLength: {
				get() {
					hooks.length++;
					throw new Error("DYTEST-unselected-length");
				},
			},
			byteOffset: {
				get() {
					hooks.offset++;
					throw new Error("DYTEST-unselected-offset");
				},
			},
			buffer: {
				get() {
					hooks.buffer++;
					throw new Error("DYTEST-unselected-buffer");
				},
			},
			[Symbol.iterator]: {
				get() {
					hooks.iterator++;
					throw new Error("DYTEST-unselected-iterator");
				},
			},
		});
		const source = streamed([view]);
		await expect(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		).resolves.toEqual({});
		expect(hooks).toEqual({ length: 0, offset: 0, buffer: 0, iterator: 0 });
	});

	it("bounds an oversized native chunk before shadowed extent and copy hooks", async () => {
		const bytes = padded(MAX_OBSERVATION_BYTES + 1);
		const hooks = { length: 0, buffer: 0, iterator: 0 };
		Object.defineProperties(bytes, {
			byteLength: {
				get() {
					hooks.length++;
					return 0;
				},
			},
			buffer: {
				get() {
					hooks.buffer++;
					throw new Error("DYTEST-unselected-buffer");
				},
			},
			[Symbol.iterator]: {
				get() {
					hooks.iterator++;
					throw new Error("DYTEST-unselected-iterator");
				},
			},
		});
		const source = streamed([bytes, payload()]);
		await transient(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		);
		expect(source.facts).toEqual({ pulls: 1, cancels: 1 });
		expect(hooks).toEqual({ length: 0, buffer: 0, iterator: 0 });
		expect(source.response.body?.locked).toBe(false);
	});

	it("refuses cumulative overflow before reading a later replacement chunk", async () => {
		const bytes = padded(MAX_OBSERVATION_BYTES + 1);
		const source = streamed([
			bytes.subarray(0, MAX_OBSERVATION_BYTES - 1),
			bytes.subarray(MAX_OBSERVATION_BYTES - 1),
			payload(),
		]);
		await transient(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		);
		expect(source.facts).toEqual({ pulls: 2, cancels: 1 });
		expect(source.response.body?.locked).toBe(false);
	});

	it.each([
		["DataView", () => new DataView(new ArrayBuffer(8))],
		["Uint16Array", () => new Uint16Array(8)],
		[
			"proxy view",
			() =>
				new Proxy(payload(), {
					get() {
						throw new Error("DYTEST-unselected-proxy");
					},
				}),
		],
		["shared view", () => new Uint8Array(new SharedArrayBuffer(8))],
	] as const)("refuses a %s chunk with the same fixed error", async (_name, make) => {
		const source = streamed([make(), payload()]);
		await transient(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		);
		expect(source.facts).toEqual({ pulls: 1, cancels: 1 });
		expect(source.response.body?.locked).toBe(false);
	});

	it("does not recover response bytes from a detached native chunk", async () => {
		const buffer = new ArrayBuffer(payload().byteLength);
		const bytes = new Uint8Array(buffer);
		bytes.set(payload());
		structuredClone(buffer, { transfer: [buffer] });
		const source = streamed([bytes]);
		await transient(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		);
		expect(source.facts.pulls).toBe(2);
		expect(source.response.body?.locked).toBe(false);
	});

	it("bounds zero-byte reads before a later valid payload and cancels them", async () => {
		const facts = { pulls: 0, cancels: 0 };
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					facts.pulls++;
					if (facts.pulls <= MAX_MUTATION_RESPONSE_READS + 1) controller.enqueue(new Uint8Array(0));
					else if (facts.pulls === MAX_MUTATION_RESPONSE_READS + 2) controller.enqueue(payload());
					else controller.close();
				},
				cancel() {
					facts.cancels++;
				},
			},
			{ highWaterMark: 0 },
		);
		const response = new Response(body);
		await transient(
			mutateGmail(
				input(),
				context(async () => response),
			),
		);
		expect(facts.pulls).toBeGreaterThan(0);
		expect(facts.pulls).toBeLessThanOrEqual(MAX_MUTATION_RESPONSE_READS);
		expect(facts.cancels).toBe(1);
		expect(body.locked).toBe(false);
	});

	it("maps a rejected body read to the fixed error without continuing to another message", async () => {
		let fetches = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					throw new Error("DYTEST-unselected-read-failure");
				},
			},
			{ highWaterMark: 0 },
		);
		const response = new Response(body);
		const args = {
			op: "archive" as const,
			messages: [
				{ kind: "email" as const, providerId: "a1" },
				{ kind: "email" as const, providerId: "b2" },
			],
		};
		await transient(
			mutateGmail(
				args,
				context(async () => {
					fetches++;
					return response;
				}),
			),
		);
		expect(fetches).toBe(1);
		expect(body.locked).toBe(false);
	});

	it("refuses promptly when cancellation itself rejects", async () => {
		const source = streamed([padded(MAX_OBSERVATION_BYTES + 1)], () =>
			Promise.reject(new Error("DYTEST-unselected-cancel-failure")),
		);
		await transient(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		);
		await nextTurn();
		expect(source.facts.cancels).toBe(1);
		expect(source.response.body?.locked).toBe(false);
	});

	it("does not await an unresolved cancellation hook before refusing", async () => {
		const entered = deferred();
		const cancellation = deferred();
		let releasedBeforeRefusal = false;
		const source = streamed([padded(MAX_OBSERVATION_BYTES + 1)], () => {
			entered.resolve();
			return cancellation.promise;
		});
		const refusal = transient(
			mutateGmail(
				input(),
				context(async () => source.response),
			),
		);
		await entered.promise;
		const release = setImmediate(() => {
			releasedBeforeRefusal = true;
			cancellation.resolve();
		});
		try {
			await refusal;
			expect(releasedBeforeRefusal).toBe(false);
			expect(source.facts.cancels).toBe(1);
			expect(source.response.body?.locked).toBe(false);
		} finally {
			clearImmediate(release);
			cancellation.resolve();
		}
	});

	it("cancels a pending body read when the original context signal aborts", async () => {
		const started = deferred();
		const signal = new AbortController();
		let cancels = 0;
		const body = new ReadableStream<Uint8Array>(
			{
				pull() {
					started.resolve();
				},
				cancel() {
					cancels++;
				},
			},
			{ highWaterMark: 0 },
		);
		const refusal = transient(
			mutateGmail(
				input(),
				context(async () => new Response(body), signal.signal),
			),
		);
		await started.promise;
		signal.abort(new Error("DYTEST-unselected-abort-reason"));
		await refusal;
		expect(cancels).toBe(1);
		expect(body.locked).toBe(false);
	});
});
