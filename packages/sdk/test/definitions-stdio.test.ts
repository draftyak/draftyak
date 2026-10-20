import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { canonicalize } from "@draftyak/protocol/jcs";
import {
	canonicalToolsList,
	checkToolResult,
	isCanonicalToolsListResult,
} from "@draftyak/protocol/tool-v1";
import { expect, it } from "vitest";
import { observeStdioFixture } from "./stdio-readiness.ts";

it("serves defined canonical tools over real stdin/stdout with trusted bootstrap and typed-error recovery", async () => {
	const child = spawn(
		process.execPath,
		[
			"--disallow-code-generation-from-strings",
			fileURLToPath(new URL("./fixtures/defined-tool-stdio.ts", import.meta.url)),
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const fixture = observeStdioFixture(child);
	const stopped = fixture.stopped;
	const lines = createInterface({ input: child.stdout });
	const replies = lines[Symbol.asyncIterator]();
	let id = 0;
	const ask = async (
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown> | undefined> => {
		const current = ++id;
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, instance: { id: "forged", config: { topic: "forged" } } } } })}\n`,
		);
		const line = await fixture.nextLine(replies, method, current);
		const reply = JSON.parse(line) as {
			id: number;
			result: Record<string, unknown>;
			error?: unknown;
		};
		fixture.checkId(reply.id, current, method);
		expect(reply.id).toBe(current);
		expect(reply.error).toBeUndefined();
		return reply.result;
	};
	try {
		await fixture.ready();
		const discover = await ask("server/discover");
		expect(discover?.capabilities).toHaveProperty("tools");
		const list = await ask("tools/list");
		expect(isCanonicalToolsListResult(list, ["kb.lookup"])).toBe(true);
		expect(canonicalize(list?.tools)).toBe(canonicalize(canonicalToolsList(["kb.lookup"])));
		expect(
			checkToolResult(
				"kb.lookup",
				await ask("tools/call", { name: "kb.lookup", arguments: { topic: "work" } }),
			),
		).toEqual({ status: "error", error: { code: "RATE_LIMITED", retryAfterMs: 250 } });
		expect(
			checkToolResult(
				"kb.lookup",
				await ask("tools/call", { name: "kb.lookup", arguments: { topic: "work" } }),
			),
		).toMatchObject({
			status: "ok",
			value: { entries: [{ label: "actual-instance", text: "Owner topic" }] },
		});
		expect(fixture.stderrText()).toBe("");
	} finally {
		lines.close();
		child.stdin.end();
		child.kill();
		await stopped;
	}
}, 15_000);
