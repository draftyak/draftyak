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
interface Server {
	readonly close: ReturnType<typeof vi.fn>;
	finish(): void;
}
interface Invocation {
	readonly child: Child;
	readonly args: readonly string[];
	readonly paths: readonly string[];
}
let servers: Server[];
let invocations: Invocation[];
let running: Promise<unknown> | undefined;
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalSignals: Map<"SIGINT" | "SIGTERM", ReturnType<typeof process.listeners>>;

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
	process.argv = [process.execPath, "DYTEST-browser-runner", "--project=chromium"];
	process.exitCode = undefined;
	servers = [];
	invocations = [];
	running = undefined;
	doubles.build.mockImplementation(async ({ configFile }: { readonly configFile: string }) => ({
		output: [
			{
				fileName: configFile.endsWith("vite.virtual-list-e2e.config.ts")
					? "virtual-list.html"
					: "index.html",
			},
			{ fileName: "DYTEST.js" },
		],
	}));
	doubles.preview.mockImplementation(async () => {
		let done: ((error?: Error) => void) | undefined;
		const server: Server = {
			close: vi.fn((callback: (error?: Error) => void) => {
				done = callback;
			}),
			finish() {
				const callback = done;
				done = undefined;
				callback?.();
			},
		};
		servers.push(server);
		return {
			httpServer: { address: () => ({ address: "127.0.0.1", port: 32123 }), close: server.close },
		};
	});
	doubles.spawn.mockImplementation(
		(_executable: string, args: readonly string[], options: SpawnOptions) => {
			const child = new Child();
			const paths: unknown = JSON.parse(options.env?.DRAFTYAK_E2E_ALLOWED_PATHS ?? "null");
			if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string"))
				throw new Error("DYTEST invalid catalogue");
			invocations.push({ child, args, paths });
			return child as unknown as ChildProcess;
		},
	);
});

async function flush(): Promise<void> {
	await turn();
	await turn();
}
function start(): Promise<unknown> {
	running = import("../e2e/run.ts");
	void running.catch(() => {});
	return running;
}
afterEach(async () => {
	// Drain only these synthetic children/servers before restoring this test process.
	for (let pass = 0; pass < 4; pass++) {
		for (const invocation of invocations) invocation.child.close(1);
		await flush();
		for (const server of servers) server.finish();
		await flush();
	}
	await running?.catch(() => {});
	try {
		for (const [signal, before] of originalSignals)
			expect(process.listeners(signal)).toEqual(before);
	} finally {
		process.argv = originalArgv;
		process.exitCode = originalExitCode;
	}
});

it("runs flags then virtual with exact project/catalogues after child close and server join", async () => {
	const run = start();
	await vi.waitFor(() => expect(invocations).toHaveLength(1));
	expect(invocations[0]?.args.slice(-1)).toEqual(["--project=chromium"]);
	expect(invocations[0]?.args.join("/")).toContain("playwright.config.ts");
	expect(invocations[0]?.paths).toEqual(["/", "/DYTEST.js", "/index.html"]);
	invocations[0]?.child.close(0);
	await flush();
	expect(servers[0]?.close).toHaveBeenCalledTimes(1);
	expect(doubles.build).toHaveBeenCalledTimes(1);
	servers[0]?.finish();
	await vi.waitFor(() => expect(invocations).toHaveLength(2));
	expect(invocations[1]?.args.join("/")).toContain("virtual-list.playwright.config.ts");
	expect(invocations[1]?.args.slice(-1)).toEqual(["--project=chromium"]);
	expect(invocations[1]?.paths).toEqual(["/DYTEST.js", "/virtual-list.html"]);
	invocations[1]?.child.close(0);
	await flush();
	servers[1]?.finish();
	await run;
	expect(process.exitCode).toBeUndefined();
	expect(doubles.build).toHaveBeenCalledTimes(2);
});

it("reports cancellation during the final server cleanup", async () => {
	const run = start();
	await vi.waitFor(() => expect(invocations).toHaveLength(1));
	invocations[0]?.child.close(0);
	await flush();
	servers[0]?.finish();
	await vi.waitFor(() => expect(invocations).toHaveLength(2));
	invocations[1]?.child.close(0);
	await flush();
	expect(servers[1]?.close).toHaveBeenCalledTimes(1);
	const stop = process
		.listeners("SIGTERM")
		.find((listener) => !originalSignals.get("SIGTERM")?.includes(listener));
	if (!stop) throw new Error("DYTEST missing own stop callback");
	Reflect.apply(stop, process, []);
	servers[1]?.finish();
	await run;
	expect(process.exitCode).toBe(1);
});

it("retains an async spawn error until close and refuses the next fixture", async () => {
	const run = start();
	await vi.waitFor(() => expect(invocations).toHaveLength(1));
	invocations[0]?.child.emit("error", new Error("DYTEST spawn unavailable"));
	await flush();
	expect(servers[0]?.close).not.toHaveBeenCalled();
	expect(doubles.build).toHaveBeenCalledTimes(1);
	invocations[0]?.child.close(0);
	await flush();
	expect(servers[0]?.close).toHaveBeenCalledTimes(1);
	servers[0]?.finish();
	await run;
	expect(process.exitCode).toBe(1);
	expect(doubles.build).toHaveBeenCalledTimes(1);
});

it("joins the current child/server after interruption and starts no next fixture", async () => {
	const run = start();
	await vi.waitFor(() => expect(invocations).toHaveLength(1));
	const stop = process
		.listeners("SIGTERM")
		.find((listener) => !originalSignals.get("SIGTERM")?.includes(listener));
	if (!stop) throw new Error("DYTEST missing own stop callback");
	Reflect.apply(stop, process, []);
	expect(invocations[0]?.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
	expect(servers[0]?.close).not.toHaveBeenCalled();
	invocations[0]?.child.close(0);
	await flush();
	servers[0]?.finish();
	await run;
	expect(process.exitCode).toBe(1);
	expect(doubles.build).toHaveBeenCalledTimes(1);
});

it.each([["--project=firefox"], ["--project=chromium", "--project=chromium"], ["--unknown"]])(
	"refuses unsupported selection %j before any fixture starts",
	async (...args) => {
		process.argv = [process.execPath, "DYTEST-browser-runner", ...args];
		await expect(start()).rejects.toThrow(
			"Browser tests accept only explicit chromium/webkit project selections",
		);
		expect(doubles.build).not.toHaveBeenCalled();
		expect(doubles.preview).not.toHaveBeenCalled();
		expect(doubles.spawn).not.toHaveBeenCalled();
	},
);
