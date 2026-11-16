import { describe, expect, it } from "vitest";
import { writeMbox } from "../src/index.ts";

const message = (raw: Uint8Array) => ({
	raw,
	envelopeFrom: "sender@example.invalid",
	receivedAtMs: 0,
});

describe("mbox raw-message size", () => {
	it.each([
		["Uint8Array", () => Uint8Array.from([0x41, 0x42])],
		["Buffer", () => Buffer.from([0x41, 0x42])],
		["subarray", () => Uint8Array.from([0xff, 0x41, 0x42, 0xff]).subarray(1, 3)],
	] as const)("rejects an oversized %s with an understated byteLength", async (_kind, make) => {
		const raw = make();
		Object.defineProperty(raw, "byteLength", { value: 0 });
		const output = writeMbox([message(raw)], { maxMessageBytes: 1 });
		await expect(output.next()).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
	});

	it("does not invoke a shadowed byteLength getter when checking the limit", async () => {
		const raw = Uint8Array.from([0x41, 0x42]);
		let reads = 0;
		Object.defineProperty(raw, "byteLength", {
			get() {
				reads++;
				throw new Error("DYTEST size getter must not run");
			},
		});
		const output = writeMbox([message(raw)], { maxMessageBytes: 1 });
		await expect(output.next()).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
		expect(reads).toBe(0);
	});

	it("rejects a proxy that has no actual typed-array view", async () => {
		const raw = new Proxy(Uint8Array.from([0x41, 0x42]), {});
		const output = writeMbox([message(raw)]);
		await expect(output.next()).rejects.toMatchObject({ code: "BAD_INPUT" });
	});

	it("accepts the actual bounded view when a shadowed byteLength overstates its size", async () => {
		const raw = Uint8Array.from([0xff, 0x41, 0x42, 0xff]).subarray(1, 3);
		Object.defineProperty(raw, "byteLength", { value: 100 });
		const chunks: Uint8Array[] = [];
		for await (const chunk of writeMbox([message(raw)], { maxMessageBytes: 2 })) {
			chunks.push(chunk);
		}
		expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(-3)).toEqual(
			Buffer.from([0x41, 0x42, 0x0a]),
		);
	});
});
