import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("emits real MCP progress for the requesting caller token alongside host progress", async () => {
	const child = spawn(
		process.execPath,
		[
			"--disallow-code-generation-from-strings",
			fileURLToPath(new URL("./fixtures/provider-progress-stdio.ts", import.meta.url)),
		],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const stopped = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => resolve());
	});
	const lines = createInterface({ input: child.stdout });
	const output = lines[Symbol.asyncIterator]();
	const host: unknown[] = [],
		notifications: unknown[] = [];
	let stderr = "",
		id = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(0, 65_536);
	});
	const ask = async (
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown> | undefined> => {
		const current = ++id;
		child.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: current, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, ...(params._meta as object) } } })}\n`,
		);
		const response = async (): Promise<Record<string, unknown> | undefined> => {
			while (true) {
				const next = await output.next();
				if (next.done) return undefined;
				const tagged = next.value.startsWith("\u001e");
				const frame = JSON.parse(tagged ? next.value.slice(1) : next.value) as Record<
					string,
					unknown
				>;
				if (tagged) {
					host.push(frame);
					child.stdin.write(
						`\u001e${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: null })}\n`,
					);
				} else if (frame.method) notifications.push(frame);
				else {
					expect(frame.id).toBe(current);
					expect(frame.error).toBeUndefined();
					return frame.result as Record<string, unknown>;
				}
			}
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				response(),
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 3000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};
	try {
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
		expect(stderr).toBe("");
	} finally {
		lines.close();
		child.stdin.end();
		child.kill();
		await stopped;
	}
}, 15_000);
