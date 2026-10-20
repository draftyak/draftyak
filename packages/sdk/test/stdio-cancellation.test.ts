import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { HostError } from "../src/host.ts";
import { stdioHost } from "../src/stdio.ts";

function emittedRequest(output: PassThrough): { id: string; method: string } {
	const frame = output.read() as Buffer | null;
	expect(frame).not.toBeNull();
	expect(frame?.[0]).toBe(0x1e);
	return JSON.parse(frame?.subarray(1).toString("utf8") ?? "") as {
		id: string;
		method: string;
	};
}

describe("stdio request cancellation", () => {
	it("keeps a cancelled request denied after late success without closing another request", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const host = stdioHost({ input, output });
		try {
			const controller = new AbortController();
			const cancelled = host
				.request("host/kv.get", { key: "cancelled" }, { signal: controller.signal })
				.then(
					() => "ACCEPTED",
					(error: HostError) => error.code,
				);
			const first = emittedRequest(output);
			const independent = host.request("host/kv.get", { key: "independent" });
			const second = emittedRequest(output);
			expect(first.method).toBe("host/kv.get");
			expect(second.method).toBe("host/kv.get");
			expect(second.id).not.toBe(first.id);

			controller.abort();
			input.write(
				`\x1e${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { value: "late" } })}\n` +
					`\x1e${JSON.stringify({ jsonrpc: "2.0", id: second.id, result: { value: "working" } })}\n`,
			);
			await expect(independent).resolves.toEqual({ value: "working" });
			await expect(cancelled).resolves.toBe("DENIED");
		} finally {
			host.close();
			input.destroy();
			output.destroy();
		}
	});
});
