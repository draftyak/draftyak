import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it } from "vitest";
import { startStdio } from "../src/stdio.ts";

const envelope = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
const initialize = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "old", version: "1" },
	},
};
const discover = { jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: envelope } };

interface Reply {
	readonly id: number;
	readonly error?: { readonly code: number; readonly message: string; readonly data: unknown };
	readonly result?: { readonly capabilities: { readonly extensions: unknown } };
}

// Newline-delimited JSON-RPC, one reply per request.
function client(input: Writable, output: Readable): (message: object) => Promise<Reply> {
	const lines = createInterface({ input: output })[Symbol.asyncIterator]();
	return async (message) => {
		input.write(`${JSON.stringify(message)}\n`);
		const { value } = await lines.next();
		return JSON.parse(String(value)) as Reply;
	};
}

async function expectLegacyRejectedThenModernServed(ask: (message: object) => Promise<Reply>) {
	const rejected = await ask(initialize);
	expect(rejected.id).toBe(1);
	expect(rejected.error).toEqual({
		code: -32022,
		message: "Unsupported protocol version: 2025-11-25",
		data: { supported: ["2026-07-28"], requested: "2025-11-25" },
	});
	const served = await ask(discover);
	expect(served.result?.capabilities.extensions).toEqual({ "io.modelcontextprotocol/ui": {} });
}

describe("serveStdio(…, {legacy:'reject'})", () => {
	it("refuses a 2025 initialize readably and still serves a 2026 opening on the same connection", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const handle = startStdio(new StdioServerTransport(input, output));
		try {
			await expectLegacyRejectedThenModernServed(client(input, output));
		} finally {
			await handle.close();
		}
	});

	it("does the same as a process, and exits when stdin closes", async () => {
		const entry = fileURLToPath(new URL("../src/stdio.ts", import.meta.url));
		const child = spawn(process.execPath, [entry], {
			stdio: ["pipe", "pipe", "inherit"],
			windowsHide: true,
		});
		try {
			await expectLegacyRejectedThenModernServed(client(child.stdin, child.stdout));
			child.stdin.end();
			const [code] = await once(child, "exit");
			expect(code).toBe(0);
		} finally {
			child.kill();
		}
	});
});
