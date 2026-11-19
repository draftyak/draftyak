import childProcess, { type ChildProcess, execFile, spawn } from "node:child_process";
import {
	chmodSync,
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getSystemErrorMap, isDeepStrictEqual } from "node:util";
import * as pluginStdio from "@draftyak/protocol/plugin-stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { systemClock } from "../../src/kernel/clock.ts";
import {
	createPluginSupervisor,
	type PluginSupervisor,
	PluginSupervisorError,
	type SupervisedProcess,
	type SupervisorEvent,
} from "../../src/plugins/supervisor/index.ts";
import {
	createSampler,
	parseProcStatus,
	parseTasklistCsv,
} from "../../src/plugins/supervisor/memory.ts";
import {
	epoch,
	generation,
	isAlive,
	lineBundle,
	makeRoots,
	manifest,
	type Roots,
	recordingHost,
	ulid,
	until,
} from "./supervisor-helpers.ts";

let roots: Roots;
let supervisor: PluginSupervisor | undefined;
let events: SupervisorEvent[];
let pids: Set<number>;

beforeEach(() => {
	roots = makeRoots();
	supervisor = undefined;
	events = [];
	pids = new Set();
});

afterEach(async () => {
	await supervisor?.close();
	vi.restoreAllMocks();
	for (const pid of pids) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
		await until(() => !isAlive(pid));
	}
	roots.cleanup();
});

async function open(): Promise<PluginSupervisor> {
	supervisor = await createPluginSupervisor({
		dataRoot: roots.dataRoot,
		stdioRoot: roots.stdioRoot,
		host: recordingHost(),
		onEvent: (event) => events.push(event),
	});
	return supervisor;
}

let count = 0;
async function instance(
	directory = path.join(roots.bundles, `b${++count}`),
): Promise<SupervisedProcess> {
	const opened = supervisor ?? (await open());
	const activation = await opened.activate(
		generation(lineBundle(directory), { pluginId: `dytest-p${count}` }),
		{
			epoch: epoch(),
		},
	);
	return activation.instance(ulid());
}

async function pidOf(handle: SupervisedProcess): Promise<number> {
	const counts = (await handle.callTool("run", { do: "count" })) as { pid: number };
	pids.add(counts.pid);
	return counts.pid;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof PluginSupervisorError ? error.code : `other:${String(error)}`;
	}
}

const crashed = () =>
	events
		.filter((event) => event.type === "crashed")
		.map((event) => ("reason" in event ? event.reason : undefined));

function descriptorCount(): number {
	return readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
}

type NativeCompletion = (this: unknown, ...args: unknown[]) => unknown;
interface NativeWriteRequest {
	oncomplete?: NativeCompletion;
}
interface NativeWriteChannel {
	writeUtf8String(this: unknown, ...args: unknown[]): number;
}
interface NativeWriteObservation {
	hooked: boolean;
	writes: number;
	phase: string;
	completions: number;
	returned: number | null;
	completed: number | null;
	status: string;
}
const { observeNativeHandleWrite } = (await import(
	new URL("./fixtures/supervisor/line-plugin.mjs", import.meta.url).href
)) as {
	observeNativeHandleWrite(
		channel: NativeWriteChannel | undefined,
		submit: () => unknown,
		settle: (pending: Promise<void>) => Promise<unknown>,
	): Promise<NativeWriteObservation>;
};

function systemErrorNumber(name: string): number {
	for (const [code, [label]] of getSystemErrorMap()) if (label === name) return code;
	throw new Error(`Missing system error ${name}`);
}
const enotsock = systemErrorNumber("ENOTSOCK");

function expectNativeRefusal(value: unknown, fd: number): void {
	const completion =
		typeof value === "object" && value !== null && Reflect.get(value, "phase") === "completion";
	expect(value).toEqual({
		probe: "fifo-handle-write",
		fd,
		hooked: true,
		writes: 1,
		phase: completion ? "completion" : "immediate",
		completions: completion ? 1 : 0,
		returned: completion ? 0 : enotsock,
		completed: completion ? enotsock : null,
		status: "ENOTSOCK",
	});
}

// Controlled callback cases exercise the same export as the native probe, not OS acceptance.
describe("FIFO write completion observer controls", () => {
	it("accepts a direct native refusal without inventing a completion", async () => {
		const request: NativeWriteRequest = {};
		const handle = {};
		const write = vi.fn(function (this: unknown, ...args: unknown[]) {
			expect(this).toBe(channel);
			expect(args).toEqual([request, "wire", handle]);
			expect(request.oncomplete).toBeUndefined();
			return enotsock;
		});
		const channel: NativeWriteChannel = { writeUtf8String: write };
		const observed = await observeNativeHandleWrite(
			channel,
			() => channel.writeUtf8String(request, "wire", handle),
			(pending) => pending,
		);
		expectNativeRefusal({ probe: "fifo-handle-write", fd: 1, ...observed }, 1);
		expect(observed.phase).toBe("immediate");
		expect(channel.writeUtf8String).toBe(write);
		expect(request.oncomplete).toBeUndefined();
	});

	it("waits for native completion and preserves the assigned handler's receiver, arguments and return", async () => {
		const request: NativeWriteRequest = {};
		const handle = {};
		const nativeArgs = [enotsock, { tag: "stream" }, "native detail"];
		const complete = vi.fn(function (this: unknown, ..._args: unknown[]) {
			return "original return";
		});
		const write = vi.fn(() => {
			expect(request.oncomplete).toBeUndefined();
			return 0;
		});
		const channel: NativeWriteChannel = { writeUtf8String: write };
		const pending = observeNativeHandleWrite(
			channel,
			() => {
				expect(channel.writeUtf8String(request, "wire", handle)).toBe(0);
				request.oncomplete = complete;
			},
			(completion) => completion,
		);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(complete).not.toHaveBeenCalled();
		const observedComplete = request.oncomplete;
		if (observedComplete === undefined) throw new Error("Missing completion observer");
		expect(Reflect.apply(observedComplete, request, nativeArgs)).toBe("original return");
		const observed = await pending;
		expectNativeRefusal({ probe: "fifo-handle-write", fd: 1, ...observed }, 1);
		expect(observed.phase).toBe("completion");
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.contexts[0]).toBe(request);
		expect(complete.mock.calls[0]).toEqual(nativeArgs);
		for (const [index, value] of nativeArgs.entries())
			expect(complete.mock.calls[0]?.[index]).toBe(value);
		expect(channel.writeUtf8String).toBe(write);
		expect(request.oncomplete).toBe(complete);
	});

	it.each([
		"zero completion",
		"other completion",
		"other errno",
		"missing write",
		"missing handler",
	] as const)("does not accept %s as a native FIFO refusal", async (kind) => {
		const request: NativeWriteRequest = {};
		const complete = vi.fn();
		const write = vi.fn(() => (kind === "other errno" ? systemErrorNumber("EPIPE") : 0));
		const channel: NativeWriteChannel = { writeUtf8String: write };
		const pending = observeNativeHandleWrite(
			channel,
			() => {
				if (kind === "missing write") return;
				const code = channel.writeUtf8String(request, "wire", {});
				if (code === 0 && kind !== "missing handler") request.oncomplete = complete;
			},
			(completion) => completion,
		);
		if (kind === "zero completion") request.oncomplete?.call(request, 0, {}, undefined);
		if (kind === "other completion")
			request.oncomplete?.call(request, systemErrorNumber("EPIPE"), {}, undefined);
		const observed = await pending;
		expect(() =>
			expectNativeRefusal({ probe: "fifo-handle-write", fd: 1, ...observed }, 1),
		).toThrow();
		expect(channel.writeUtf8String).toBe(write);
	});

	it("rejects a throwing write and restores its method", async () => {
		const marker = new Error("Synthetic write failure");
		const write = vi.fn(() => {
			throw marker;
		});
		const channel: NativeWriteChannel = { writeUtf8String: write };
		await expect(
			observeNativeHandleWrite(
				channel,
				() => channel.writeUtf8String({}, "wire", {}),
				(pending) => pending,
			),
		).rejects.toBe(marker);
		expect(channel.writeUtf8String).toBe(write);
	});

	it("rejects an expired completion wait instead of accepting queued zero", async () => {
		const marker = new Error("Synthetic completion deadline");
		const request: NativeWriteRequest = {};
		const complete = vi.fn();
		const write = vi.fn(() => 0);
		const channel: NativeWriteChannel = { writeUtf8String: write };
		await expect(
			observeNativeHandleWrite(
				channel,
				() => {
					channel.writeUtf8String(request, "wire", {});
					request.oncomplete = complete;
				},
				() => Promise.reject(marker),
			),
		).rejects.toBe(marker);
		expect(complete).not.toHaveBeenCalled();
		expect(channel.writeUtf8String).toBe(write);
		expect(request.oncomplete).toBe(complete);
	});

	it("rejects a throwing native handler and preserves its original throw", async () => {
		const marker = new Error("Synthetic native callback failure");
		const request: NativeWriteRequest = {};
		const complete = vi.fn(() => {
			throw marker;
		});
		const write = vi.fn(() => 0);
		const channel: NativeWriteChannel = { writeUtf8String: write };
		const pending = observeNativeHandleWrite(
			channel,
			() => {
				channel.writeUtf8String(request, "wire", {});
				request.oncomplete = complete;
			},
			(completion) => completion,
		);
		const refused = expect(pending).rejects.toBe(marker);
		expect(() => request.oncomplete?.call(request, enotsock, {}, undefined)).toThrow(marker);
		await refused;
		expect(complete).toHaveBeenCalledTimes(1);
		expect(complete.mock.contexts[0]).toBe(request);
		expect(channel.writeUtf8String).toBe(write);
		expect(request.oncomplete).toBe(complete);
	});
});

describe("Windows", () => {
	it("samples real tasklist after a controlled owned-reader failure", {
		tags: ["requires:windows"],
	}, async () => {
		const systemRoot = process.env.SystemRoot;
		if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot))
			throw new Error("Missing Windows SystemRoot");
		const powershell = path.join(
			systemRoot,
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		const tasklist = path.join(systemRoot, "System32", "tasklist.exe");
		const target = process.pid;
		const readerArgs = [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"$ErrorActionPreference='Stop';while($true){$l=[Console]::In.ReadLine();if($null -eq $l){break};$v='x';try{$v=[string](Get-Process -Id ([int]$l)).PrivateMemorySize64}catch{$v='x'};[Console]::Out.WriteLine($v);[Console]::Out.Flush()}",
		];
		const readerOptions = {
			env: { SystemRoot: systemRoot },
			stdio: ["pipe", "pipe", "ignore"],
			windowsHide: true,
			shell: false,
		};
		const tasklistArgs = ["/fi", `PID eq ${target}`, "/fo", "csv", "/nh"];
		const tasklistOptions = {
			env: { SystemRoot: systemRoot },
			timeout: 2_000,
			maxBuffer: 65_536,
			shell: false,
			windowsHide: true,
		};
		type Owned = {
			child: ChildProcess;
			exited: boolean;
			closed: boolean;
			inputClosed: boolean;
		};
		const owned = new Map<ChildProcess, Owned>();
		const readers: Owned[] = [];
		const calls: { args: unknown[]; replies: unknown[][] }[] = [];
		const track = (child: ChildProcess): Owned => {
			const existing = owned.get(child);
			if (existing !== undefined) return existing;
			const state: Owned = {
				child,
				exited: child.exitCode !== null || child.signalCode !== null,
				closed: false,
				inputClosed: false,
			};
			child.once("exit", () => {
				state.exited = true;
			});
			child.once("close", () => {
				state.closed = true;
			});
			owned.set(child, state);
			return state;
		};
		const realSpawn = childProcess.spawn;
		const spawned = vi.spyOn(childProcess, "spawn").mockImplementation(function (
			this: unknown,
			...args: unknown[]
		) {
			const child = Reflect.apply(realSpawn, this, args) as ChildProcess;
			if (isDeepStrictEqual(args, [powershell, readerArgs, readerOptions])) {
				const state = track(child);
				readers.push(state);
				// Close real input before the sampler can write its self-check pid, then stop only this child.
				// This is a controlled IO failure, not an AppLocker or language-mode assertion.
				child.stdin?.destroy();
				state.inputClosed = child.stdin?.destroyed === true;
				if (child.pid !== undefined) child.kill();
			}
			return child;
		} as typeof childProcess.spawn);
		const realExecFile = childProcess.execFile;
		const executed = vi.spyOn(childProcess, "execFile").mockImplementation(function (
			this: unknown,
			...args: unknown[]
		) {
			if (
				args.length !== 4 ||
				args[0] !== tasklist ||
				!isDeepStrictEqual(args[1], tasklistArgs) ||
				!isDeepStrictEqual(args[2], tasklistOptions) ||
				typeof args[3] !== "function"
			)
				return Reflect.apply(realExecFile, this, args) as ChildProcess;
			const call = { args, replies: [] as unknown[][] };
			calls.push(call);
			const callback = args[3];
			const forwarded = [...args];
			forwarded[3] = function (this: unknown, ...reply: unknown[]) {
				call.replies.push(reply);
				return Reflect.apply(callback, this, reply);
			};
			const child = Reflect.apply(realExecFile, this, forwarded) as ChildProcess;
			track(child);
			return child;
		} as typeof childProcess.execFile);
		const fallback = vi.fn();
		let sampler: ReturnType<typeof createSampler> | undefined;
		try {
			sampler = createSampler("win32", systemRoot, systemClock, fallback);
			for (let sample = 0; sample < 2; sample++) {
				const reading = (await sampler.sample([target])).get(target);
				expect(calls).toHaveLength(sample + 1);
				const call = calls[sample] as { args: unknown[]; replies: unknown[][] };
				expect(call.args.slice(0, 3)).toEqual([tasklist, tasklistArgs, tasklistOptions]);
				expect(call.replies).toHaveLength(1);
				expect(call.replies[0]?.[0]).toBeNull();
				const stdout = call.replies[0]?.[1];
				expect(typeof stdout).toBe("string");
				expect(Number.isSafeInteger(reading)).toBe(true);
				expect(reading).toBeGreaterThan(0);
				expect(reading).toBe(parseTasklistCsv(stdout as string, target));
				expect(fallback).toHaveBeenCalledTimes(1);
				expect(readers).toHaveLength(1);
			}
			const reader = readers[0] as Owned;
			expect(reader.child.pid).toBeGreaterThan(0);
			expect(reader.inputClosed).toBe(true);
			sampler.close();
			const starts = spawned.mock.calls.length;
			const executions = executed.mock.calls.length;
			expect(await sampler.sample([target])).toEqual(new Map([[target, undefined]]));
			expect(spawned).toHaveBeenCalledTimes(starts);
			expect(executed).toHaveBeenCalledTimes(executions);
		} finally {
			sampler?.close();
			for (const state of owned.values()) {
				if (state.child.pid === undefined) continue;
				if (!state.exited) state.child.kill("SIGKILL");
				await until(() => state.exited && state.closed);
			}
		}
	});

	it("a _forkChild(1) handle send aborts the plugin before sending", {
		tags: ["requires:windows"],
	}, async () => {
		const handle = await instance();
		const pid = await pidOf(handle);
		expect(await code(handle.callTool("run", { do: "probe", what: "fork-child", sends: 1 }))).toBe(
			"PLUGIN_EXITED",
		);
		await until(() => !isAlive(pid));
		await until(() => crashed().length > 0);
		expect(crashed()).toEqual(["exit"]);
		expect(await pidOf(handle)).not.toBe(pid);
	});

	it("close() ends every plugin, and a killed hub takes its plugins with it", {
		tags: ["requires:windows"],
	}, async () => {
		const handles = [await instance(), await instance()];
		const running = [
			await pidOf(handles[0] as SupervisedProcess),
			await pidOf(handles[1] as SupervisedProcess),
		];
		await (supervisor as PluginSupervisor).close();
		for (const pid of running) expect(isAlive(pid)).toBe(false);
		const { hub, plugin } = await standInHub(false);
		expect(isAlive(plugin)).toBe(true);
		hub.kill("SIGKILL");
		// A non-detached child shares the spawning process's kill-on-close job object.
		await until(() => !isAlive(plugin), 10_000);
	});
});

describe("Linux and macOS", () => {
	it("gives the plugin only unlinked FIFOs and leaves nothing in the stdio root", {
		tags: ["requires:posix"],
	}, async () => {
		const real = pluginStdio.openPluginStdio;
		const facts: { fifo: boolean; nlink: number }[][] = [];
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			facts.push(
				(stdio.stdio as readonly number[]).map((fd) => {
					const stat = fstatSync(fd);
					return { fifo: stat.isFIFO(), nlink: stat.nlink };
				}),
			);
			expect(readdirSync(roots.stdioRoot)).toEqual([]);
			return stdio;
		});
		const handle = await instance();
		await pidOf(handle);
		expect(facts).toEqual([
			[
				{ fifo: true, nlink: 0 },
				{ fifo: true, nlink: 0 },
				{ fifo: true, nlink: 0 },
			],
		]);
		await handle.stop();
		expect(readdirSync(roots.stdioRoot)).toEqual([]);
		await pidOf(handle);
		expect(
			await code(
				handle.callTool("run", { do: "raw", lines: [Buffer.from("[1]\n").toString("base64")] }),
			),
		).toBe("PLUGIN_VIOLATION");
		await until(() => crashed().length > 0);
		expect(readdirSync(roots.stdioRoot)).toEqual([]);
	});

	it("refuses handle sends on both reinstated FIFO descriptors with ENOTSOCK", {
		tags: ["requires:posix"],
	}, async () => {
		const before = descriptorCount();
		const prefix = "DYTEST-FIFO-WRITE ";
		const reports = new Map<
			number,
			{
				bytes: number;
				pending: string;
				value: unknown;
				failed: boolean;
			}
		>();
		const real = pluginStdio.openPluginStdio;
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			return {
				...stdio,
				attach(child) {
					const io = stdio.attach(child);
					const report = { bytes: 0, pending: "", value: undefined as unknown, failed: false };
					if (child.pid !== undefined) reports.set(child.pid, report);
					// Only the fd1 attack reports here; the real supervisor still consumes this output.
					io.outputs[1].on("data", (chunk: Buffer) => {
						report.bytes += chunk.byteLength;
						if (report.bytes > 1024) {
							report.failed = true;
							return;
						}
						report.pending += chunk.toString("utf8");
						while (true) {
							const newline = report.pending.indexOf("\n");
							if (newline === -1) break;
							const line = report.pending.slice(0, newline);
							report.pending = report.pending.slice(newline + 1);
							if (!line.startsWith(prefix)) continue;
							if (report.value !== undefined) {
								report.failed = true;
								continue;
							}
							try {
								report.value = JSON.parse(line.slice(prefix.length));
							} catch {
								report.failed = true;
							}
						}
					});
					return io;
				},
			};
		});
		for (const fd of [1, 2] as const) {
			const statuses: string[] = [];
			for (let attempt = 0; attempt < 10; attempt++) {
				// Reinitializing IPC changes a descriptor: no later attempt reuses that process.
				const handle = await instance();
				const pid = await pidOf(handle);
				const report = reports.get(pid);
				if (report === undefined) throw new Error("Missing owned stdio observation");
				let settled = false;
				const pending = handle.callTool("run", { do: "probe", what: "fork-child-write", fd });
				void pending.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				try {
					let witness: unknown;
					if (fd === 1) {
						// stdout is the attacked descriptor; accept only the bounded stderr witness.
						await until(() => report.value !== undefined || report.failed);
						expect(report.failed).toBe(false);
						witness = report.value;
					} else {
						await until(() => settled);
						witness = ((await pending) as { result: unknown }).result;
					}
					expectNativeRefusal(witness, fd);
					statuses.push((witness as { status: string }).status);
				} finally {
					await handle.stop();
					await until(() => !isAlive(pid));
					await until(() => settled);
				}
				expect(report.failed).toBe(false);
			}
			expect(statuses).toEqual(Array(10).fill("ENOTSOCK"));
		}
		expect(descriptorCount()).toBeLessThanOrEqual(before);
		expect(await pidOf(await instance())).toBeGreaterThan(0);
	});

	it("bounds the exit drain when another writer holds the stdout FIFO", {
		tags: ["requires:posix"],
	}, async () => {
		const real = pluginStdio.openPluginStdio;
		let extra: number | undefined;
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			const fd = (stdio.stdio as readonly number[])[1] as number;
			extra = openSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : `/dev/fd/${fd}`, "w");
			return stdio;
		});
		const handle = await instance();
		const pid = await pidOf(handle);
		const started = Date.now();
		await handle.stop();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(isAlive(pid)).toBe(false);
		expect(events.some((event) => event.type === "held-writer")).toBe(true);
		closeSync(extra as number);
	});

	it("keeps the plugin in the hub's process group", { tags: ["requires:posix"] }, async () => {
		const handle = await instance();
		const pid = await pidOf(handle);
		const group = async (target: number) =>
			(
				await new Promise<string>((resolve, reject) =>
					execFile(
						"/bin/ps",
						["-o", "pgid=", "-p", String(target)],
						{ env: {} },
						(error, stdout) => (error ? reject(error) : resolve(String(stdout))),
					),
				)
			).trim();
		expect(await group(pid)).toBe(await group(process.pid));
		const { hub, plugin } = await standInHub(true);
		process.kill(-(hub.pid as number), "SIGKILL");
		await until(() => !isAlive(plugin));
	});

	it("does not promise parent-death cleanup when only its POSIX parent is killed", {
		tags: ["requires:posix"],
	}, async () => {
		const { hub, plugin } = await standInHub(true);
		const exited = new Promise<void>((resolve) => hub.once("exit", () => resolve()));
		hub.kill("SIGKILL");
		await exited;
		// POSIX has no Windows job-object equivalent here: the launcher owns process-group cleanup.
		expect(isAlive(plugin)).toBe(true);
		process.kill(plugin, "SIGKILL");
		await until(() => !isAlive(plugin));
	});
});

describe("Linux", () => {
	it("samples real VmRSS and VmSwap and drains exited FIFOs to EOF", {
		tags: ["requires:linux"],
	}, async () => {
		const completions: Promise<pluginStdio.PluginStdioResult>[] = [];
		const real = pluginStdio.openPluginStdio;
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			return {
				...stdio,
				attach(child) {
					const io = stdio.attach(child);
					completions.push(io.completion);
					return io;
				},
			};
		});
		const handle = await instance();
		const pid = await pidOf(handle);
		const status = readFileSync(`/proc/${pid}/status`, "latin1");
		expect(status).toMatch(/^VmRSS:\s+\d+ kB$/m);
		expect(status).toMatch(/^VmSwap:\s+\d+ kB$/m);
		expect(parseProcStatus(status)).toBeGreaterThan(0);
		const sampler = createSampler("linux", undefined, systemClock, () => {});
		expect((await sampler.sample([pid])).get(pid)).toBeGreaterThan(0);
		sampler.close();
		await handle.stop();
		expect((await completions[0])?.drains.map((drain) => drain.result)).toEqual(["eof", "eof"]);
	});
});

describe("macOS", () => {
	it("drains exited stdout and stderr FIFOs to EOF", {
		tags: ["requires:macos"],
	}, async () => {
		const completions: Promise<pluginStdio.PluginStdioResult>[] = [];
		const real = pluginStdio.openPluginStdio;
		vi.spyOn(pluginStdio, "openPluginStdio").mockImplementation(async (options) => {
			const stdio = await real(options);
			return {
				...stdio,
				attach(child) {
					const io = stdio.attach(child);
					completions.push(io.completion);
					return io;
				},
			};
		});
		const handle = await instance();
		const pid = await pidOf(handle);
		expect(await handle.callTool("run", { do: "stderr", text: "DYTEST drain\n" })).toEqual({
			written: true,
		});
		await handle.stop();
		expect(completions).toHaveLength(1);
		const completion = await completions[0];
		expect(completion?.error).toBeNull();
		expect(completion?.drains.map((drain) => drain.result)).toEqual(["eof", "eof"]);
		expect(isAlive(pid)).toBe(false);
	});

	it("refuses the /var alias and grants only the canonical /private/var bundle", {
		tags: ["requires:macos"],
	}, async () => {
		const opened = await open();
		const directory = path.join(roots.bundles, "canonical");
		const bundle = lineBundle(directory);
		expect(directory.startsWith("/private/var/")).toBe(true);
		const alias = directory.replace(/^\/private\/var\//, "/var/");
		expect(
			await code(opened.activate(generation({ ...bundle, directory: alias }), { epoch: epoch() })),
		).toBe("BUNDLE_REFUSED");
		const activation = await opened.activate(generation(bundle), { epoch: epoch() });
		const handle = activation.instance(ulid());
		const facts = (await handle.callTool("run", { do: "facts" })) as {
			pid: number;
			entry: string;
			envNames: string[];
		};
		pids.add(facts.pid);
		expect(facts.entry).toBe(path.join(directory, "main.mjs"));
		expect(facts.envNames.filter((name) => name.startsWith("__CF_"))).toEqual([
			"__CF_USER_TEXT_ENCODING",
		]);
	});
});

describe("all platforms", () => {
	it("starts a verified plugin staged from a read-only application bundle", async () => {
		const opened = await open();
		const bundle = lineBundle(path.join(roots.bundles, "readonly"));
		for (const file of bundle.inventory.files)
			chmodSync(path.join(bundle.directory, file.path), 0o444);
		chmodSync(bundle.directory, 0o555);
		const activation = await opened.activate(generation(bundle), { epoch: epoch() });
		const handle = activation.instance(ulid());
		expect(await pidOf(handle)).toBeGreaterThan(0);
		await handle.stop();
	});

	it("refuses a bundle reached through a linked parent and runs it at its real path", async () => {
		const real = path.join(roots.base, "real-parent");
		mkdirSync(real, { mode: 0o700 });
		const directory = path.join(real, "bundle");
		const bundle = lineBundle(directory, {}, [{ path: "data.txt", content: "DYTEST second file" }]);
		const alias = path.join(roots.base, "alias-parent");
		symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
		const opened = await open();
		const aliased = { ...bundle, directory: path.join(alias, "bundle") };
		expect(
			await code(
				opened.activate(generation(aliased, { pluginId: "dytest-alias" }), { epoch: epoch() }),
			),
		).toBe("BUNDLE_REFUSED");
		const activation = await opened.activate(generation(bundle, { pluginId: "dytest-real" }), {
			epoch: epoch(),
		});
		const handle = activation.instance(ulid());
		await pidOf(handle);
		expect(
			await handle.callTool("run", { do: "read-file", path: path.join(directory, "data.txt") }),
		).toEqual({ ok: true });
	});

	it("processes a flood of small notifications with bounded hub memory", async () => {
		const handle = await instance();
		await pidOf(handle);
		const before = process.memoryUsage().heapUsed;
		expect(await handle.callTool("run", { do: "flood", count: 50_000 })).toEqual({
			flooded: 50_000,
		});
		expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 << 20);
		expect(await pidOf(handle)).toBeGreaterThan(0);
	});
});

/** A separate process running the supervisor, so the test can kill it without its plugin. */
async function standInHub(
	detached: boolean,
): Promise<{ hub: ReturnType<typeof spawn>; plugin: number }> {
	const directory = path.join(roots.bundles, "stand-in");
	const bundle = lineBundle(directory);
	const script = path.join(roots.base, "stand-in-hub.mjs");
	const supervisorModule = pathToFileURL(
		fileURLToPath(new URL("../../src/plugins/supervisor/index.ts", import.meta.url)),
	).href;
	const data = path.join(roots.base, "stand-in-data");
	const run = path.join(roots.base, "stand-in-run");
	mkdirSync(data, { mode: 0o700 });
	mkdirSync(run, { mode: 0o700 });
	writeFileSync(
		script,
		[
			`import { createPluginSupervisor } from ${JSON.stringify(supervisorModule)};`,
			`const supervisor = await createPluginSupervisor({ dataRoot: ${JSON.stringify(data)}, stdioRoot: ${JSON.stringify(run)}, host: { request: async () => null } });`,
			`const activation = await supervisor.activate({ pluginId: "dytest-stand-in", generation: "g1", bundle: ${JSON.stringify(bundle)}, manifest: ${JSON.stringify(manifest("dytest-stand-in"))}, acceptSurface: () => true }, { epoch: { id: "e1", signal: new AbortController().signal } });`,
			`const counts = await activation.instance(${JSON.stringify(ulid())}).callTool("run", { do: "count" });`,
			`process.stdout.write(JSON.stringify({ plugin: counts.pid }) + "\\n");`,
			`setInterval(() => {}, 1 << 30);`,
		].join("\n"),
	);
	const hub = spawn(process.execPath, [script], {
		stdio: ["ignore", "pipe", "ignore"],
		detached,
		windowsHide: true,
	});
	const plugin = await new Promise<number>((resolve, reject) => {
		let text = "";
		hub.stdout?.on("data", (chunk: Buffer) => {
			text += chunk.toString("utf8");
			if (text.includes("\n"))
				resolve((JSON.parse(text.slice(0, text.indexOf("\n"))) as { plugin: number }).plugin);
		});
		hub.once("exit", () => reject(new Error("Stand-in hub ended early")));
	});
	pids.add(plugin);
	return { hub, plugin };
}
