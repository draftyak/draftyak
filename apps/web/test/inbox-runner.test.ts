// @vitest-environment node

import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate as turn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const doubles = vi.hoisted(() => ({ build: vi.fn(), preview: vi.fn(), spawn: vi.fn() }));
vi.mock("vite", () => ({ build: doubles.build, preview: doubles.preview }));
vi.mock("node:child_process", () => ({ spawn: doubles.spawn }));

class Child extends EventEmitter {
	readonly kill = vi.fn(() => true);
	closed = false;
	close(code: number): void {
		if (this.closed) return;
		this.closed = true;
		this.emit("close", code, null);
	}
}
let child: Child | undefined;
let finishServer: (() => void) | undefined;
let running: Promise<unknown> | undefined;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalSignals: Map<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;
const closeServer = vi.fn();

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	originalArgv = process.argv;
	originalExitCode = process.exitCode;
	originalSignals = new Map(
		["SIGINT", "SIGTERM"].map((signal) => [
			signal as "SIGINT" | "SIGTERM",
			process.listeners(signal),
		]),
	);
	process.argv = [process.execPath, "DYTEST-inbox-runner", "--project=chromium"];
	process.exitCode = undefined;
	child = undefined;
	finishServer = undefined;
	running = undefined;
	doubles.build.mockResolvedValue({
		output: [{ fileName: "inbox-workspace.html" }, { fileName: "DYTEST.js" }],
	});
	closeServer.mockImplementation((callback: (error?: Error) => void) => {
		finishServer = callback;
	});
	doubles.preview.mockResolvedValue({
		httpServer: { address: () => ({ address: "127.0.0.1", port: 32123 }), close: closeServer },
	});
	doubles.spawn.mockImplementation(
		(_executable: string, _args: readonly string[], _options: SpawnOptions) => {
			child = new Child();
			return child as unknown as ChildProcess;
		},
	);
});

async function flush(): Promise<void> {
	await turn();
	await turn();
}
function start(): Promise<unknown> {
	running = import("../e2e/run-inbox.ts");
	void running.catch(() => {});
	return running;
}
afterEach(async () => {
	child?.close(1);
	await flush();
	finishServer?.();
	await running?.catch(() => {});
	try {
		for (const [signal, before] of originalSignals)
			expect(process.listeners(signal)).toEqual(before);
	} finally {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	}
});

it("runs only the inbox fixture with exact project/catalogue and joins child and server", async () => {
	const run = start();
	await vi.waitFor(() => expect(doubles.spawn).toHaveBeenCalledTimes(1));
	const [executable, args, options] = doubles.spawn.mock.calls[0] as [
		string,
		string[],
		SpawnOptions,
	];
	expect(executable).toBe(process.execPath);
	expect(args.at(-1)).toBe("--project=chromium");
	expect(args.join("/")).toContain("inbox-workspace.playwright.config.ts");
	expect(JSON.parse(options.env?.DRAFTYAK_E2E_ALLOWED_PATHS ?? "null")).toEqual([
		"/DYTEST.js",
		"/inbox-workspace.html",
	]);
	expect(options.env?.DRAFTYAK_E2E_BASE_URL).toBe("http://127.0.0.1:32123");
	let settled = false;
	void run.then(() => {
		settled = true;
	});
	await flush();
	expect(closeServer).not.toHaveBeenCalled();
	child?.close(0);
	await flush();
	expect(closeServer).toHaveBeenCalledTimes(1);
	expect(settled).toBe(false);
	finishServer?.();
	await run;
	expect(process.exitCode).toBe(0);
	expect(doubles.build).toHaveBeenCalledTimes(1);
});

it("reports cancellation during the final server cleanup", async () => {
	const run = start();
	await vi.waitFor(() => expect(child).toBeDefined());
	child?.close(0);
	await flush();
	expect(closeServer).toHaveBeenCalledTimes(1);
	const stop = process
		.listeners("SIGTERM")
		.find((listener) => !originalSignals.get("SIGTERM")?.includes(listener));
	if (!stop) throw new Error("DYTEST missing own stop callback");
	Reflect.apply(stop, process, []);
	finishServer?.();
	await run;
	expect(process.exitCode).toBe(1);
});

it("retains an async spawn error until close before closing the fixture server", async () => {
	const run = start();
	await vi.waitFor(() => expect(child).toBeDefined());
	child?.emit("error", new Error("DYTEST spawn unavailable"));
	await flush();
	expect(closeServer).not.toHaveBeenCalled();
	child?.close(0);
	await flush();
	expect(closeServer).toHaveBeenCalledTimes(1);
	finishServer?.();
	await run;
	expect(process.exitCode).toBe(1);
});

it("joins the child and server after interruption", async () => {
	const run = start();
	await vi.waitFor(() => expect(child).toBeDefined());
	const stop = process
		.listeners("SIGTERM")
		.find((listener) => !originalSignals.get("SIGTERM")?.includes(listener));
	if (!stop) throw new Error("DYTEST missing own stop callback");
	Reflect.apply(stop, process, []);
	expect(child?.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
	expect(closeServer).not.toHaveBeenCalled();
	child?.close(0);
	await flush();
	finishServer?.();
	await run;
	expect(process.exitCode).toBe(1);
});

it.each([["--project=firefox"], ["--project=chromium", "--project=chromium"], ["--unknown"]])(
	"refuses unsupported selection %j before building",
	async (...args) => {
		process.argv = [process.execPath, "DYTEST-inbox-runner", ...args];
		await expect(start()).rejects.toThrow(
			"Browser tests accept only explicit chromium/webkit project selections",
		);
		expect(doubles.build).not.toHaveBeenCalled();
		expect(doubles.preview).not.toHaveBeenCalled();
		expect(doubles.spawn).not.toHaveBeenCalled();
	},
);
