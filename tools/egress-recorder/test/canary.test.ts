import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanCanary } from "../src/canary.ts";
import { createRecorder, MAX_CANARY_BYTES, MAX_CANARY_CHUNKS, readResult } from "../src/index.ts";
import { hub, required } from "./fixtures.ts";

function generated(): Uint8Array {
	return Buffer.from(`DYTEST-${randomUUID()}`);
}

describe("content-free canary observation", () => {
	it("matches an independent byte-search oracle across overlapping prefixes and chunk splits", async () => {
		for (const word of ["ababac", "aaaaab", "abcab"]) {
			for (const text of [
				"",
				"safe",
				word,
				`prefix${word}suffix`,
				`a${word}`,
				`aba${word}`,
				`${word.slice(0, -1)}${word}`,
				"ababababacaaaaaab",
			]) {
				const bytes = Buffer.from(text);
				const pattern = Buffer.from(word);
				for (const width of [1, 2, 3, 5, 8]) {
					const chunks: Uint8Array[] = [];
					for (let index = 0; index < bytes.length; index += width)
						chunks.push(bytes.subarray(index, index + width));
					expect(await scanCanary(pattern, chunks, new AbortController().signal)).toBe(
						bytes.includes(pattern) ? "matched" : "observed-clean",
					);
				}
			}
		}
	});
	it("detects a generated canary across chunk boundaries without persisting bytes", async () => {
		const marker = generated();
		const text = Buffer.from(marker).toString();
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		expect(
			await observer.scanCanary(marker, [
				Buffer.from("safe prefix"),
				marker.subarray(0, 7),
				marker.subarray(7),
				Buffer.from("safe suffix"),
			]),
		).toBe("matched");
		observer.complete();
		const raw = recorder.finish();
		expect(raw).not.toContain(text);
		expect(raw).not.toContain(Buffer.from(marker).toString("hex"));
		expect(raw).not.toContain(Buffer.from(marker).toString("base64"));
		expect(readResult(raw, required).observers[0]?.canary).toBe("matched");
		expect(() => readResult(raw, { ...required, canary: true })).toThrow("CANARY_MATCHED");
	});
	it("requires actual scanning and keeps a match sticky across later clean scans", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		const marker = generated();
		expect(await observer.scanCanary(marker, [marker])).toBe("matched");
		expect(await observer.scanCanary(marker, [Buffer.from("safe")])).toBe("matched");
		observer.complete();
		expect(() => readResult(recorder.finish(), { ...required, canary: true })).toThrow(
			"CANARY_MATCHED",
		);
		const unobserved = createRecorder({ profile: "test", observers: [hub] });
		unobserved.observer(hub.id).complete();
		expect(() => readResult(unobserved.finish(), { ...required, canary: true })).toThrow(
			"CANARY_UNOBSERVED",
		);
	});
	it("accepts a completely observed clean stream and an explicitly observed empty stream", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		const marker = generated();
		expect(await observer.scanCanary(marker, [Buffer.from("safe")])).toBe("observed-clean");
		expect(await observer.scanCanary(marker, [])).toBe("observed-clean");
		observer.complete();
		expect(readResult(recorder.finish(), { ...required, canary: true }).observers[0]?.canary).toBe(
			"observed-clean",
		);
	});
	it("accepts the fixed byte budget and refuses its first excess byte", async () => {
		expect(MAX_CANARY_BYTES).toBe(1_048_576);
		const chunk = new Uint8Array(65_536);
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		expect(
			await observer.scanCanary(
				generated(),
				Array.from({ length: 16 }, () => chunk),
			),
		).toBe("observed-clean");
		observer.complete();
		expect(() => readResult(recorder.finish(), { ...required, canary: true })).not.toThrow();
		const excess = createRecorder({ profile: "test", observers: [hub] });
		const failed = excess.observer(hub.id);
		expect(
			await failed.scanCanary(generated(), [
				...Array.from({ length: 16 }, () => chunk),
				new Uint8Array(1),
			]),
		).toBe("failed");
		expect(() => readResult(excess.finish(), { ...required, canary: true })).toThrow(
			"OBSERVATION_FAILED",
		);
	});
	it("bounds empty chunks independently of bytes and does not infer clean on overflow", async () => {
		expect(MAX_CANARY_CHUNKS).toBe(4096);
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		expect(
			await observer.scanCanary(
				generated(),
				Array.from({ length: 4097 }, () => new Uint8Array()),
			),
		).toBe("failed");
		expect(() => readResult(recorder.finish(), { ...required, canary: true })).toThrow(
			"OBSERVATION_FAILED",
		);
	});
	it("fails a stalled scan and invokes cleanup without awaiting an untrusted return", async () => {
		let returned = false;
		const stream: AsyncIterable<Uint8Array> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise(() => {}),
					return: () => {
						returned = true;
						return new Promise(() => {});
					},
				};
			},
		};
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		expect(await observer.scanCanary(generated(), stream, 5)).toBe("failed");
		expect(returned).toBe(true);
		expect(() => readResult(recorder.finish(), { ...required, canary: true })).toThrow(
			"OBSERVATION_FAILED",
		);
	});
});
