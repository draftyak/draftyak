import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { observeStdioFixture, STDIO_FIXTURE_REQUEST_MS } from "./stdio-readiness.ts";

it("emits real MCP progress for the requesting caller token alongside host progress", async () => {
	const child = spawn(
		process.execPath,
		[
			"--disallow-code-generation-from-strings",
			fileURLToPath(new URL("./fixtures/provider-progress-stdio.ts", import.meta.url)),
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const fixture = observeStdioFixture(child);
	const stopped = fixture.stopped;
	const lines = createInterface({ input: child.stdout });
	const output = lines[Symbol.asyncIterator]();
	const host: unknown[] = [],
		notifications: unknown[] = [];
	let id = 0;
	const ask = async (
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown> | undefined> => {
		const current = ++id;
		const deadline = Date.now() + STDIO_FIXTURE_REQUEST_MS;
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, ...(params._meta as object) } } })}\n`,
		);
		const response = async (): Promise<Record<string, unknown> | undefined> => {
			while (true) {
				const line = await fixture.nextLine(output, method, current, deadline);
				const tagged = line.startsWith("\u001e");
				const frame = JSON.parse(tagged ? line.slice(1) : line) as Record<string, unknown>;
				if (tagged) {
					host.push(frame);
					child.stdin.write(
						`\u001e${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: null })}\n`,
					);
				} else if (frame.method) notifications.push(frame);
				else {
					fixture.checkId(frame.id, current, method);
					expect(frame.id).toBe(current);
					expect(frame.error).toBeUndefined();
					return frame.result as Record<string, unknown>;
				}
			}
		};
		return response();
	};
	try {
		await fixture.ready();
		expect((await ask("server/discover"))?.capabilities).toHaveProperty("tools");
		expect(
			(await ask("tools/call", { name: "ai_probe", arguments: {} }))?.structuredContent,
		).toEqual({ status: "ok" });
		const result = await ask("tools/call", {
			name: "ai_draft_generate",
			arguments: { model: "test-model", system: "Instructions", prompt: "Message", contextIds: [] },
			_meta: { progressToken: "caller-token" },
		});
		expect(result?.structuredContent).toMatchObject({ kind: "unexpected" });
		expect(host).toHaveLength(1);
		expect(host[0]).toMatchObject({
			method: "host/progress",
			params: { token: "legacy-host-label", progress: 1, total: 2 },
		});
		expect(notifications).toEqual([
			expect.objectContaining({
				method: "notifications/progress",
				params: expect.objectContaining({ progressToken: "caller-token", progress: 1, total: 2 }),
			}),
		]);
		expect(fixture.stderrText()).toBe("");
	} finally {
		lines.close();
		child.stdin.end();
		child.kill();
		await stopped;
	}
}, 15_000);
