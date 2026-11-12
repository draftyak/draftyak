import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { openPluginStdio } from "../src/plugin-stdio.ts";

it("reports unread native pipe output cancelled after exit completion begins", {
	tags: ["requires:windows"],
}, async () => {
	const arrangement = await openPluginStdio();
	const child = spawn(
		process.execPath,
		[
			"-e",
			"process.stdout.end('unread'); process.stderr.end(); setTimeout(() => process.exit(0), 100);",
		],
		{ env: {}, stdio: [...arrangement.stdio] },
	);
	const io = arrangement.attach(child);
	io.outputs[1].resume();
	const outputClosed = io.outputs.map((output) =>
		output.closed ? Promise.resolve() : once(output, "close"),
	);
	let timer: NodeJS.Timeout | undefined;
	try {
		expect(arrangement.kind).toBe("pipe");
		if (!child.stdout || !child.stderr || !child.stdin) throw new Error("Missing native pipes");
		let cancellation:
			| {
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
					readonly unread: number;
					readonly rawEof: boolean;
					readonly consumedEof: boolean;
			  }
			| undefined;
		// Attachment registered its exit handler first; this listener runs after completion starts.
		child.once("exit", (code, signal) => {
			cancellation = {
				code,
				signal,
				unread: io.outputs[0].readableLength,
				rawEof: child.stdout?.readableEnded === true,
				consumedEof: io.outputs[0].readableEnded,
			};
			io.outputs[0].destroy();
		});
		const result = await Promise.race([
			io.completion,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Child completion deadline")), 5000);
			}),
		]);
		expect(cancellation).toEqual({
			code: 0,
			signal: null,
			unread: 6,
			rawEof: true,
			consumedEof: false,
		});
		expect(result).toMatchObject({ code: 0, signal: null, error: "streams" });
		expect(result.drains.map(({ result }) => result)).toEqual(["closed", "eof"]);
		expect([child.stdin.closed, child.stdout.closed, child.stderr.closed]).toEqual([
			true,
			true,
			true,
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGKILL");
			await exited;
		}
		await arrangement.destroy();
		await Promise.all(outputClosed);
		expect(io.outputs.every((output) => output.closed)).toBe(true);
	}
});
