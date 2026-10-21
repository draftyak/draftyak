import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
	observeStdioFixture,
	STDIO_FIXTURE_READY,
	stdioFixtureRequestDeadline,
} from "./stdio-readiness.ts";

export function createProviderCaller(
	child: Pick<ChildProcessWithoutNullStreams, "stdin">,
	fixture: ReturnType<typeof observeStdioFixture>,
	output: AsyncIterator<string>,
	host: unknown[] = [],
	notifications: unknown[] = [],
) {
	let id = 0;
	return async (
		method: string,
		params: Record<string, unknown> = {},
	): Promise<Record<string, unknown> | undefined> => {
		const current = ++id;
		const deadline = stdioFixtureRequestDeadline();
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
}

it("retains the provider request budget across progress frames and wall-clock rollback", async () => {
	vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
	const child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null,
		signalCode: null,
	});
	const fixture = observeStdioFixture(child as unknown as ChildProcessWithoutNullStreams);
	const hostFrame = Promise.withResolvers<IteratorResult<string>>();
	const progressFrame = Promise.withResolvers<IteratorResult<string>>();
	const finalFrame = Promise.withResolvers<IteratorResult<string>>();
	const pending = [hostFrame, progressFrame, finalFrame];
	let read = 0;
	const host: unknown[] = [],
		notifications: unknown[] = [];
	const ask = createProviderCaller(
		child,
		fixture,
		{
			next: () => {
				const frame = pending[read++];
				if (!frame) throw new Error("Unexpected synthetic frame read");
				return frame.promise;
			},
		},
		host,
		notifications,
	);
	try {
		await vi.advanceTimersByTimeAsync(3_500);
		child.stderr.write(`${STDIO_FIXTURE_READY}\n`);
		await fixture.ready();
		let failure: Error | undefined;
		const result = ask("tools/call", { name: "test" }).catch((error: Error) => {
			failure = error;
		});
		for (const [frame, value] of [
			[hostFrame, `\u001e${JSON.stringify({ id: "host-1", method: "host/progress" })}`],
			[progressFrame, JSON.stringify({ method: "notifications/progress" })],
		] as const) {
			await vi.advanceTimersByTimeAsync(1_000);
			vi.setSystemTime(Date.now() - 5_000);
			frame.resolve({ done: false, value });
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(host).toHaveLength(1);
		expect(notifications).toHaveLength(1);
		expect(read).toBe(3);
		await vi.advanceTimersByTimeAsync(999);
		expect(failure).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		await result;
		expect(failure?.message).toMatch(/response timeout; method=tools\/call; id=1; elapsedMs=6500/);
		await vi.advanceTimersByTimeAsync(500);
		finalFrame.resolve({ done: false, value: JSON.stringify({ id: 1, result: { late: true } }) });
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		for (const frame of pending) frame.resolve({ done: true, value: undefined });
		child.emit("close", 0, null);
		await fixture.stopped;
		child.stdin.destroy();
		child.stdout.destroy();
		child.stderr.destroy();
		vi.useRealTimers();
	}
});

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
	const ask = createProviderCaller(child, fixture, output, host, notifications);
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
