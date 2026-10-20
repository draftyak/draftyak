import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import {
	canonicalToolsV1,
	checkToolResult,
	TOOL_ERROR_META_KEY,
	TOOL_EXTENSION_ID,
	toolExtensionDeclaration,
} from "@draftyak/protocol/tool-v1";
import { describe, expect, it } from "vitest";

interface Reply {
	readonly id: number;
	readonly result?: Record<string, unknown>;
	readonly error?: unknown;
}
const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};

describe("real stdio plugin serving", () => {
	it("discovers, lists absent optional properties, and calls a canonical tool after a typed error", async () => {
		// Synthetic child stdio only; production parent launch is a separate contract.
		const child = spawn(
			process.execPath,
			[
				"--disallow-code-generation-from-strings",
				fileURLToPath(new URL("./fixtures/stdio-serving.ts", import.meta.url)),
			],
			{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
		);
		const stopped = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", () => resolve());
		});
		let diagnostics = "";
		child.stderr.on("data", (chunk: Buffer) => {
			diagnostics = (diagnostics + chunk.toString()).slice(0, 65_536);
		});
		const lines = createInterface({ input: child.stdout });
		const replies = lines[Symbol.asyncIterator]();
		let nextId = 0;
		const ask = async (
			method: string,
			params: Record<string, unknown> = {},
		): Promise<Reply | undefined> => {
			const id = ++nextId;
			child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: metadata } })}\n`,
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const reply = await Promise.race([
					replies.next(),
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => resolve(undefined), 3_000);
					}),
				]);
				if (!reply || reply.done) return undefined;
				const value = JSON.parse(reply.value) as Reply;
				expect(value.id).toBe(id);
				return value;
			} finally {
				clearTimeout(timer);
			}
		};
		try {
			const discovery = await ask("server/discover");
			expect(discovery?.error).toBeUndefined();
			expect(discovery?.result?.capabilities).toEqual({
				tools: { listChanged: false },
				extensions: { [TOOL_EXTENSION_ID]: toolExtensionDeclaration },
			});
			const listed = await ask("tools/list");
			expect(listed?.result?.tools).toMatchObject([
				{
					name: "tool_describe",
					description: canonicalToolsV1.tool_describe.entry.description,
					inputSchema: canonicalToolsV1.tool_describe.entry.inputSchema,
					outputSchema: canonicalToolsV1.tool_describe.entry.outputSchema,
				},
			]);
			expect(listed?.error).toBeUndefined();
			const tools = listed?.result?.tools as Record<string, unknown>[];
			expect(tools).toHaveLength(1);
			for (const absent of ["title", "annotations", "icons", "_meta"])
				expect(tools[0]).not.toHaveProperty(absent);

			const limited = await ask("tools/call", { name: "tool_describe", arguments: {} });
			expect(limited?.error).toBeUndefined();
			expect(checkToolResult("tool_describe", limited?.result)).toEqual({
				status: "error",
				error: { code: "RATE_LIMITED", retryAfterMs: 250, detail: "Try later" },
			});
			expect(limited?.result).not.toHaveProperty("structuredContent");
			expect(limited?.result?._meta).toMatchObject({
				[TOOL_ERROR_META_KEY]: { code: "RATE_LIMITED", retryAfterMs: 250 },
			});

			const recovered = await ask("tools/call", { name: "tool_describe", arguments: {} });
			expect(recovered?.error).toBeUndefined();
			expect(checkToolResult("tool_describe", recovered?.result)).toMatchObject({
				status: "ok",
				value: { kinds: ["kb.lookup"] },
			});
			expect(recovered?.result).toMatchObject({ structuredContent: { kinds: ["kb.lookup"] } });
			expect(diagnostics).toBe("");
		} finally {
			lines.close();
			child.stdin.end();
			child.kill();
			await stopped;
		}
	}, 20_000);
});
