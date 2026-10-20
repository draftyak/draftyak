import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOST_FRAME_TAG } from "@draftyak/protocol/host-channel";
import { describe, expect, it } from "vitest";

describe("synthetic child framing adapter", () => {
	it("round trips every host family through a real child without an IPC channel", async () => {
		// Synthetic byte transport only; platform-safe production spawn is plugin-stdio's contract.
		const child = spawn(
			process.execPath,
			[
				"--disallow-code-generation-from-strings",
				fileURLToPath(new URL("./fixtures/host-roundtrip.ts", import.meta.url)),
			],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		const methods: string[] = [];
		let data = "";
		let diagnostics = "";
		let done = false;
		child.stderr.on("data", (value: Buffer) => {
			diagnostics += value.toString();
		});
		child.stdout.on("data", (value: Buffer) => {
			data += value.toString();
			let boundary = data.indexOf("\n");
			while (boundary >= 0) {
				const line = data.slice(0, boundary);
				data = data.slice(boundary + 1);
				if (!line.startsWith(HOST_FRAME_TAG)) done = JSON.parse(line).id === "done";
				else {
					const request = JSON.parse(line.slice(1));
					methods.push(request.method);
					const result =
						request.method === "host/fetch"
							? { status: 200, headers: [], body: { base64: "" } }
							: request.method === "host/ws.open"
								? { socketId: "s" }
								: request.method === "host/kv.get"
									? { value: null }
									: null;
					child.stdin.write(
						`${HOST_FRAME_TAG}${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
					);
				}
				boundary = data.indexOf("\n");
			}
		});
		const exit = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill();
				reject(new Error("Synthetic child timeout"));
			}, 10_000);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		expect(diagnostics).toBe("");
		expect(exit).toBe(0);
		expect(done).toBe(true);
		expect(methods).toHaveLength(10);
		expect(new Set(methods).size).toBe(10);
	});
});
