import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertDestinations,
	createRecorder,
	MAX_CANARY_BYTES,
	type PayloadChunks,
} from "../src/index.ts";
import { hub, required } from "./fixtures.ts";

const coverage = { ...required, canary: true };
const marker = (): Uint8Array => Buffer.from(`DYTEST-${randomUUID()}`);

async function scan(pattern: Uint8Array, chunks: unknown) {
	const recorder = createRecorder({ profile: "test", observers: [hub] });
	const observer = recorder.observer(hub.id);
	const verdict = await observer.scanCanary(pattern, chunks as PayloadChunks);
	// Failed scans poison the observer; preserve their result for the same public consumer path.
	let completionError: unknown;
	try {
		observer.complete();
	} catch (error) {
		completionError = error;
	}
	return { verdict, completionError, raw: recorder.finish() };
}

function source(mode: "sync" | "async", factory: () => unknown): unknown {
	return { [mode === "sync" ? Symbol.iterator : Symbol.asyncIterator]: factory };
}

describe("public canary input refusal", () => {
	it.each(["sync", "async"] as const)(
		"refuses missing %s iterator factory results",
		async (mode) => {
			for (const result of [undefined, null]) {
				const observed = await scan(
					marker(),
					source(mode, () => result),
				);
				expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("OBSERVATION_FAILED");
				expect(observed.verdict).toBe("failed");
			}
		},
	);

	it.each(["sync", "async"] as const)("refuses malformed %s next results", async (mode) => {
		for (const result of [undefined, null, false, 0, "", true, 1, "primitive"]) {
			const observed = await scan(
				marker(),
				source(mode, () => ({ next: () => result })),
			);
			expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("OBSERVATION_FAILED");
			expect(observed.verdict).toBe("failed");
		}
	});

	it("refuses absent or noncallable factories and next operations", async () => {
		for (const chunks of [
			null,
			undefined,
			{},
			{ [Symbol.iterator]: 1 },
			{ [Symbol.asyncIterator]: false },
			{ [Symbol.iterator]: () => ({}) },
			{ [Symbol.iterator]: () => ({ next: 0 }) },
		]) {
			const observed = await scan(marker(), chunks);
			expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("OBSERVATION_FAILED");
		}
	});

	it("accepts explicit clean empty EOF and ordinary done coercion/accessors", async () => {
		for (const chunks of [
			[],
			source("sync", () => ({ next: () => ({ done: true }) })),
			source("async", () => ({ next: async () => ({ done: true }) })),
			source("sync", () => ({ next: () => ({ done: "false" }) })),
			source("sync", () => ({
				next: () => ({
					get done() {
						return true;
					},
				}),
			})),
		]) {
			const observed = await scan(marker(), chunks);
			expect(() => assertDestinations(observed.raw, coverage, [])).not.toThrow();
			expect(observed.verdict).toBe("observed-clean");
			expect(observed.completionError).toBeUndefined();
		}
	});
});

describe("intrinsic canary byte views", () => {
	it("detects present bytes even when a chunk iterator yields nothing", async () => {
		const pattern = marker();
		const chunk = new Uint8Array(pattern);
		Object.defineProperty(chunk, Symbol.iterator, { value: function* () {} });
		const observed = await scan(pattern, [chunk]);
		expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("CANARY_MATCHED");
		expect(observed.verdict).toBe("matched");
	});

	it("does not scan replacement iterator bytes absent from the actual view", async () => {
		const pattern = marker();
		const chunk = new Uint8Array(3);
		Object.defineProperty(chunk, Symbol.iterator, { value: () => pattern.values() });
		const observed = await scan(pattern, [chunk]);
		expect(() => assertDestinations(observed.raw, coverage, [])).not.toThrow();
		expect(observed.verdict).toBe("observed-clean");
	});

	it("refuses the first actual excess byte despite an own zero byteLength", async () => {
		const chunk = new Uint8Array(MAX_CANARY_BYTES + 1);
		Object.defineProperty(chunk, "byteLength", { value: 0 });
		const observed = await scan(marker(), [chunk]);
		expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("OBSERVATION_FAILED");
		expect(observed.verdict).toBe("failed");
	});

	it("accepts exactly the actual byte limit despite a shadow byteLength", async () => {
		const chunk = new Uint8Array(MAX_CANARY_BYTES);
		Object.defineProperty(chunk, "byteLength", { value: MAX_CANARY_BYTES + 1 });
		const observed = await scan(marker(), [chunk]);
		expect(() => assertDestinations(observed.raw, coverage, [])).not.toThrow();
		expect(observed.verdict).toBe("observed-clean");
	});

	it("copies actual pattern bytes rather than replacement iteration", async () => {
		const pattern = marker();
		Object.defineProperty(pattern, Symbol.iterator, {
			value: function* () {
				yield 0;
			},
		});
		const chunk = Buffer.from(`DYTEST-${"not-this-pattern"}`);
		const actual = new Uint8Array(pattern.buffer, pattern.byteOffset, pattern.byteLength);
		const observed = await scan(pattern, [chunk, actual]);
		expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("CANARY_MATCHED");
	});

	it("checks actual empty and first-excess pattern lengths despite own length shadows", async () => {
		for (const pattern of [new Uint8Array(), new Uint8Array(257)]) {
			Object.defineProperty(pattern, "length", { value: 1 });
			const observed = await scan(pattern, []);
			expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("OBSERVATION_FAILED");
		}
	});

	it("does not invoke custom length, buffer, offset, species or iterator accessors", async () => {
		const pattern = marker();
		const chunk = new Uint8Array(pattern);
		let accessed = 0;
		const hostile = {
			get() {
				accessed++;
				throw new Error("Unused view property");
			},
		};
		for (const view of [pattern, chunk]) {
			for (const key of ["length", "byteLength", "buffer", "byteOffset", Symbol.iterator]) {
				Object.defineProperty(view, key, hostile);
			}
			Object.defineProperty(view, "constructor", {
				value: Object.defineProperty({}, Symbol.species, hostile),
			});
		}
		const observed = await scan(pattern, [chunk]);
		expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("CANARY_MATCHED");
		expect(accessed).toBe(0);
	});

	it("respects native Buffer and Uint8Array offsets and subarray boundaries", async () => {
		const pattern = marker();
		const backing = Buffer.concat([pattern, Buffer.from("safe"), pattern]);
		const clean = backing.subarray(pattern.length, pattern.length + 4);
		for (const chunk of [clean, new Uint8Array(clean.buffer, clean.byteOffset, clean.length)]) {
			const observed = await scan(pattern, [chunk]);
			expect(() => assertDestinations(observed.raw, coverage, [])).not.toThrow();
		}
		const offsetPattern = backing.subarray(0, pattern.length);
		const matching = backing.subarray(pattern.length + 4);
		const observed = await scan(offsetPattern, [matching]);
		expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("CANARY_MATCHED");
	});

	it("supports the exact actual256-byte pattern bound", async () => {
		const pattern = new Uint8Array(256).fill(7);
		Object.defineProperty(pattern, "length", { value: 257 });
		const observed = await scan(pattern, [new Uint8Array(256).fill(7)]);
		expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("CANARY_MATCHED");
	});

	it("fails unsupported chunks instead of claiming a clean scan", async () => {
		for (const chunk of [new Uint16Array(4), new Proxy(new Uint8Array(4), {}), {}]) {
			const observed = await scan(marker(), [chunk]);
			expect(() => assertDestinations(observed.raw, coverage, [])).toThrow("OBSERVATION_FAILED");
		}
	});
});
