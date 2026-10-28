import fs from "node:fs";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { readEnd } from "../src/plugin-stdio/fifo.ts";
import { DRAIN_LIMIT } from "../src/plugin-stdio/limits.ts";

const CHUNK = 64 << 10;
const pattern = (length: number): Buffer => {
	const bytes = Buffer.alloc(length);
	for (let i = 0; i < length; i++) bytes[i] = i % 251;
	return bytes;
};

// Exercise the actual private drain over controlled reads on every platform.
// Native FIFO and descriptor behavior remains covered by the POSIX-routed tests.
function drainFixture(total: number, first: number, prefix = Buffer.alloc(0)) {
	const socket = new net.Socket();
	const reader = readEnd(900_001, socket);
	const requests: number[] = [];
	let produced = 0;
	const read = vi.spyOn(fs, "readSync").mockImplementation((...args: unknown[]) => {
		const buffer = args[1] as Uint8Array;
		const offset = args[2] as number;
		const requested = args[3] as number;
		requests.push(requested);
		const count = Math.min(requested, requests.length === 1 ? first : CHUNK, total - produced);
		for (let i = 0; i < count; i++) buffer[offset + i] = (produced + i) % 251;
		produced += count;
		return count;
	});
	try {
		if (prefix.length) socket.emit("data", prefix);
		const result = reader.drain();
		const chunks: Buffer[] = [];
		for (;;) {
			const chunk = reader.output.read() as Buffer | null;
			if (chunk === null) break;
			chunks.push(Buffer.from(chunk));
		}
		const bytes = Buffer.concat(chunks);
		return { result, bytes, requests, produced };
	} finally {
		read.mockRestore();
		reader.finish();
		reader.output.destroy();
		socket.destroy();
	}
}

describe("FIFO final drain byte boundary", () => {
	it("clamps a read after a one-byte partial read to the remaining budget", () => {
		const { result, bytes, requests, produced } = drainFixture(DRAIN_LIMIT + CHUNK, 1);
		expect(result).toEqual({ bytes: DRAIN_LIMIT, result: "limit" });
		expect(produced).toBe(DRAIN_LIMIT);
		expect(bytes.length).toBe(DRAIN_LIMIT);
		expect(requests.at(-1)).toBe(CHUNK - 1);
		expect(bytes.equals(pattern(DRAIN_LIMIT))).toBe(true);
	});
	it.each([DRAIN_LIMIT - 1, DRAIN_LIMIT, DRAIN_LIMIT + 1])(
		"preserves exact neighboring payload boundary %i after a partial read",
		(total) => {
			const { result, bytes } = drainFixture(total, 1);
			const kept = Math.min(total, DRAIN_LIMIT);
			expect(result).toEqual({ bytes: kept, result: total < DRAIN_LIMIT ? "eof" : "limit" });
			expect(bytes.length).toBe(kept);
			expect(bytes.equals(pattern(kept))).toBe(true);
		},
	);
	it("retains the full-chunk positive control at the exact ceiling", () => {
		const { result, bytes, requests } = drainFixture(DRAIN_LIMIT + 1, CHUNK);
		expect(result).toEqual({ bytes: DRAIN_LIMIT, result: "limit" });
		expect(requests).toHaveLength(DRAIN_LIMIT / CHUNK);
		expect(requests.every((length) => length === CHUNK)).toBe(true);
		expect(bytes.equals(pattern(DRAIN_LIMIT))).toBe(true);
	});
	it("preserves an already delivered prefix before the partial-read tail", () => {
		const prefix = Buffer.from("before-drain:");
		const total = 3 * CHUNK + 31;
		const { result, bytes } = drainFixture(total, 1, prefix);
		expect(result).toEqual({ bytes: total, result: "eof" });
		expect(bytes.equals(Buffer.concat([prefix, pattern(total)]))).toBe(true);
	});
});
