import { describe, expect, it } from "vitest";
import { hostFetch } from "../src/fetch.ts";
import { type HostError, type MemoryHost, memoryHost } from "../src/host.ts";

const encodedChunk = Buffer.alloc(65_536, 0x5a).toString("base64url");

async function readThroughBoundary(
	host: MemoryHost,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	finishAtBoundary: boolean,
): Promise<number> {
	let received = 0;
	let sequence = 0;
	while (received < 33_554_432) {
		host.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: {
				streamId: "bounded-response",
				sequence: sequence++,
				base64: encodedChunk,
				done: finishAtBoundary && received + 65_536 === 33_554_432,
			},
		});
		const next = await reader.read();
		expect(next.done).toBe(false);
		if (next.done) throw new Error("Response ended before the accepted boundary");
		expect(next.value.byteLength).toBe(65_536);
		expect(next.value[0]).toBe(0x5a);
		expect(next.value[next.value.byteLength - 1]).toBe(0x5a);
		received += next.value.byteLength;
	}
	expect(received).toBe(33_554_432);
	return sequence;
}

describe("streamed response byte boundary", () => {
	it("accepts exactly 33,554,432 bytes without buffering the whole response", async () => {
		const host = memoryHost(() => ({ status: 200, headers: [], streamId: "bounded-response" }));
		const response = await hostFetch(host)("https://example.invalid/", { stream: true });
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) throw new Error("Expected streamed response");
		try {
			await readThroughBoundary(host, reader, true);
			await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
		} finally {
			host.close();
			reader.releaseLock();
		}
	}, 15_000);

	it("refuses the first byte beyond 33,554,432 before exposing it", async () => {
		const host = memoryHost(() => ({ status: 200, headers: [], streamId: "bounded-response" }));
		const response = await hostFetch(host)("https://example.invalid/", { stream: true });
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		if (!reader) throw new Error("Expected streamed response");
		try {
			const sequence = await readThroughBoundary(host, reader, false);
			const excess = reader.read().then(
				(next) => (next.done ? "ENDED" : next.value.byteLength),
				(error: HostError) => error.code,
			);
			host.notify({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: { streamId: "bounded-response", sequence, base64: "Wg", done: true },
			});
			await expect(excess).resolves.toBe("TOO_LARGE");
		} finally {
			host.close();
			reader.releaseLock();
		}
	}, 15_000);
});
