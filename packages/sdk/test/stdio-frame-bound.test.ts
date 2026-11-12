import { PassThrough } from "node:stream";
import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { describe, expect, it } from "vitest";
import { stdioHost } from "../src/stdio.ts";

function frameAtBytes(size: number): Buffer {
	const empty = JSON.stringify({ jsonrpc: "2.0", method: "frame", params: { text: "" } });
	const text = "a".repeat(size - Buffer.byteLength(empty));
	const frame = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "frame", params: { text } }));
	expect(frame.byteLength).toBe(size);
	return frame;
}

describe.each(["whole", "split"] as const)("untagged inbound frame bound (%s)", (chunking) => {
	function writeFrame(input: PassThrough, frame: Buffer): void {
		if (chunking === "split") {
			input.write(frame.subarray(0, frame.length - 1));
			input.write(frame.subarray(frame.length - 1));
			input.write("\n");
		} else input.write(Buffer.concat([frame, Buffer.from("\n")]));
	}

	it("delivers a valid MCP frame at the exact byte bound", () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		let delivered = 0;
		let errors = 0;
		let closed = 0;
		host.transport.onmessage = () => delivered++;
		host.transport.onerror = () => errors++;
		host.transport.onclose = () => closed++;
		try {
			writeFrame(input, frameAtBytes(HOST_MAX_FRAME_BYTES));
			expect(delivered).toBe(1);
			expect(errors).toBe(0);
			expect(closed).toBe(0);
		} finally {
			host.close();
			input.destroy();
			output.destroy();
		}
	});

	it("refuses a valid MCP frame one byte over the bound and retires the channel", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		let delivered = 0;
		let errors = 0;
		let closed = 0;
		host.transport.onmessage = () => delivered++;
		host.transport.onerror = () => errors++;
		host.transport.onclose = () => closed++;
		try {
			writeFrame(input, frameAtBytes(HOST_MAX_FRAME_BYTES + 1));
			expect(delivered).toBe(0);
			expect(errors).toBe(1);
			expect(closed).toBe(1);
			input.write('{"jsonrpc":"2.0","method":"ping"}\n');
			expect(delivered).toBe(0);
			expect(errors).toBe(1);
			expect(closed).toBe(1);
			await expect(host.request("host/kv.get", { key: "key" })).rejects.toMatchObject({
				code: "DENIED",
			});
		} finally {
			host.close();
			input.destroy();
			output.destroy();
		}
	});
});
