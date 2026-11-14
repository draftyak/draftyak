import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PluginRssError,
	type PluginRssWatch,
	watchPluginRss,
} from "../../src/plugins/supervisor/rss-watch.ts";

const originalSpawn = childProcess.spawn;
const childSource = "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function observe<T>(promise: Promise<T>): Promise<T> {
	void promise.then(
		() => undefined,
		() => undefined,
	);
	return promise;
}

function stateOf(promise: Promise<unknown>) {
	let state: "pending" | "fulfilled" | "rejected" = "pending";
	void promise.then(
		() => {
			state = "fulfilled";
		},
		() => {
			state = "rejected";
		},
	);
	return () => state;
}

function turn(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

interface OriginalChild {
	readonly child: ChildProcess;
	readonly closed: Promise<void>;
	readonly joined: Promise<void>;
	readonly spawned: Promise<boolean>;
	readonly exit: () => { code: number | null; signal: NodeJS.Signals | null } | undefined;
	readonly sawClose: () => boolean;
	readonly rssBytes: () => number | undefined;
	stop(): void;
}

function retainChild(child: ChildProcess): OriginalChild {
	const closed = deferred<void>(),
		spawned = deferred<boolean>(),
		exited = deferred<void>();
	let sawSpawn = false,
		sawClose = false;
	let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let numericText = "",
		invalidOutput = false,
		stderrSeen = false;
	child.stdout?.on("data", (chunk: unknown) => {
		if (!Buffer.isBuffer(chunk) || chunk.length > 256 - numericText.length) {
			invalidOutput = true;
			return;
		}
		for (const byte of chunk) {
			if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32 && (byte < 48 || byte > 57)) {
				invalidOutput = true;
				return;
			}
		}
		numericText += chunk.toString("ascii");
	});
	child.stderr?.on("data", () => {
		stderrSeen = true;
	});
	const pipes = child.stdio.flatMap((stream) => {
		if (!stream) return [];
		const done = deferred<void>();
		stream.on("error", () => undefined);
		stream.once("close", () => done.resolve());
		return [done.promise];
	});
	child.once("spawn", () => {
		sawSpawn = true;
		spawned.resolve(true);
	});
	child.once("error", () => spawned.resolve(false));
	child.once("exit", (code, signal) => {
		exit = { code, signal };
		exited.resolve();
	});
	child.once("close", () => {
		sawClose = true;
		closed.resolve();
	});
	const joined = observe(
		(async () => {
			await closed.promise;
			if (sawSpawn) await exited.promise;
			await Promise.all(pipes);
		})(),
	);
	return {
		child,
		closed: closed.promise,
		joined,
		spawned: spawned.promise,
		exit: () => exit,
		sawClose: () => sawClose,
		rssBytes() {
			const raw = numericText.trim();
			if (invalidOutput || stderrSeen || !/^[0-9]+$/.test(raw)) return undefined;
			const value = Number(raw) * (process.platform === "win32" ? 1 : 1024);
			return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
		},
		stop() {
			if (!sawClose && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		},
	};
}

class CloseDelivery {
	readonly callbacks: (() => void)[] = [];
	released = false;
	intercept(child: ChildProcess): void {
		const once = child.once;
		const thisDelivery = this;
		Object.defineProperty(child, "once", {
			configurable: true,
			value: function (
				this: ChildProcess,
				event: string | symbol,
				listener: (...args: unknown[]) => unknown,
			) {
				if (event !== "close") return Reflect.apply(once, this, [event, listener]);
				return Reflect.apply(once, this, [
					event,
					function (this: ChildProcess, ...args: unknown[]) {
						const deliver = () => {
							Reflect.apply(listener, this, args);
						};
						if (thisDelivery.released) deliver();
						else thisDelivery.callbacks.push(deliver);
					},
				]);
			},
		});
	}
	release(): void {
		this.released = true;
		let failed = false;
		while (this.callbacks.length) {
			try {
				this.callbacks.shift()?.();
			} catch {
				failed = true;
			}
		}
		if (failed) throw new Error("Test close delivery failed");
	}
}

interface Harness {
	readonly original: OriginalChild;
	readonly probes: OriginalChild[];
	readonly watches: PluginRssWatch[];
	readonly closeDelivery: CloseDelivery;
	readonly firstProbe: Promise<OriginalChild>;
	readonly faultKillAccepted: () => boolean;
	readonly invocations: ProbeInvocation[];
	captureProbe(actual: ChildProcess, args: Parameters<typeof originalSpawn>): void;
	waitForProbe(watch: PluginRssWatch): Promise<OriginalChild>;
	watch(maxBytes?: number): PluginRssWatch;
	retain(watch: PluginRssWatch): PluginRssWatch;
	cancel(): void;
	join(): Promise<void>;
}

interface ProbeInvocation {
	readonly command: string;
	readonly args: readonly string[];
	readonly envKeys: readonly string[];
	readonly shell: boolean | undefined;
	readonly windowsHide: boolean | undefined;
	readonly stdio: readonly string[] | undefined;
}

let scope: AsyncLocalStorage<{ readonly harness: Harness; readonly holdClose: boolean }>;
let restoreSpawn: () => void;
let teardown = false;
const harnesses: Harness[] = [];
const bodies: Promise<unknown>[] = [];

function body(work: () => Promise<void>): Promise<void> {
	const original = observe(Promise.resolve().then(work));
	bodies.push(original);
	return original;
}

function harness(holdClose = false, killProbe = false): Harness {
	if (teardown) throw new Error("Test acquisition closed");
	const child = originalSpawn(process.execPath, ["-e", childSource], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {},
		windowsHide: true,
	});
	const original = retainChild(child);
	child.stdout?.resume();
	child.stderr?.resume();
	const probes: OriginalChild[] = [],
		watches: PluginRssWatch[] = [];
	const invocations: ProbeInvocation[] = [];
	const observations: Promise<unknown>[] = [];
	const firstProbe = deferred<OriginalChild>(),
		closeDelivery = new CloseDelivery();
	let cleanup: Promise<void> | undefined;
	let cleanupFailed = false;
	let faultKillAccepted = false;
	const h: Harness = {
		original,
		probes,
		watches,
		closeDelivery,
		firstProbe: firstProbe.promise,
		invocations,
		faultKillAccepted: () => faultKillAccepted,
		captureProbe(actual, args) {
			const probe = retainChild(actual);
			probes.push(probe);
			try {
				const options = args[2];
				invocations.push({
					command: args[0],
					args: Array.isArray(args[1]) ? [...args[1]] : [],
					envKeys: Object.keys(options?.env ?? {}).sort(),
					shell: typeof options?.shell === "boolean" ? options.shell : undefined,
					windowsHide: options?.windowsHide,
					stdio: Array.isArray(options?.stdio)
						? options.stdio.map((entry) => (typeof entry === "string" ? entry : "non-string"))
						: undefined,
				});
			} catch {
				cleanupFailed = true;
			}
			if (holdClose) closeDelivery.intercept(actual);
			if (killProbe) {
				try {
					faultKillAccepted = actual.kill("SIGKILL");
				} catch {
					faultKillAccepted = false;
				}
			}
			firstProbe.resolve(probe);
		},
		waitForProbe(watch) {
			const answered = observe(
				watch.firstSample.then(() => {
					throw new Error("Test probe precondition missing");
				}),
			);
			const arrival = observe(Promise.race([firstProbe.promise, answered]));
			observations.push(answered, arrival);
			return arrival;
		},
		watch(maxBytes = Number.MAX_SAFE_INTEGER) {
			if (teardown) throw new Error("Test acquisition closed");
			return h.retain(scope.run({ harness: h, holdClose }, () => watchPluginRss(child, maxBytes)));
		},
		retain(watch) {
			watches.push(watch);
			observe(watch.firstSample);
			observe(watch.stopped);
			return watch;
		},
		cancel() {
			for (const watch of watches) {
				try {
					observe(watch.stop());
				} catch {
					cleanupFailed = true;
				}
			}
			try {
				closeDelivery.release();
			} catch {
				cleanupFailed = true;
			}
			for (const resource of [...probes, original]) {
				try {
					resource.stop();
				} catch {
					cleanupFailed = true;
				}
			}
		},
		join() {
			cleanup ??= observe(
				Promise.resolve().then(async () => {
					const outcomes = await Promise.allSettled(
						watches.flatMap((watch) => [watch.firstSample, watch.stopped]),
					);
					await Promise.allSettled(observations);
					let joined = 0;
					while (joined < probes.length) {
						const batch = probes.slice(joined);
						joined = probes.length;
						await Promise.all(batch.map((probe) => probe.joined));
					}
					await original.joined;
					if (cleanupFailed || outcomes.some((result) => result.status === "rejected")) {
						throw new Error("Test original cleanup failed");
					}
				}),
			);
			return cleanup;
		},
	};
	harnesses.push(h);
	return h;
}

function fixed(error: unknown, code: "RSS_LIMIT" | "RSS_UNAVAILABLE"): void {
	expect(error).toBeInstanceOf(PluginRssError);
	expect(error).toMatchObject({ name: "PluginRssError", message: "Plugin RSS watch failed", code });
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

beforeEach(() => {
	teardown = false;
	scope = new AsyncLocalStorage();
	const spy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
		const actual: ChildProcess = Reflect.apply(originalSpawn, childProcess, args);
		const current = scope.getStore();
		if (current) {
			current.harness.captureProbe(actual, args);
		}
		return actual;
	});
	syncBuiltinESMExports();
	restoreSpawn = () => {
		spy.mockRestore();
		syncBuiltinESMExports();
	};
});

afterEach(async () => {
	teardown = true;
	try {
		for (const h of harnesses) h.cancel();
		await Promise.allSettled(bodies);
		const outcomes = await Promise.allSettled(harnesses.map((h) => h.join()));
		expect(outcomes.every((result) => result.status === "fulfilled")).toBe(true);
	} finally {
		restoreSpawn();
		scope.disable();
	}
});

describe("plugin RSS watch", () => {
	it("samples the original live child without terminating it", () =>
		body(async () => {
			const h = harness();
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const sample = await watch.firstSample;
			expect(Number.isSafeInteger(sample)).toBe(true);
			expect(sample).toBeGreaterThan(0);
			expect(sample).toBe(h.probes[0]?.rssBytes());
			const invocation = h.invocations[0];
			expect(invocation?.command).toBe(
				process.platform === "win32"
					? path.join(
							process.env.SystemRoot ?? "",
							"System32",
							"WindowsPowerShell",
							"v1.0",
							"powershell.exe",
						)
					: "/bin/ps",
			);
			expect(invocation?.args).toEqual(
				process.platform === "win32"
					? [
							"-NoLogo",
							"-NoProfile",
							"-NonInteractive",
							"-Command",
							`$p=Get-Process -Id ${h.original.child.pid} -ErrorAction Stop;[Console]::Out.Write($p.WorkingSet64.ToString([Globalization.CultureInfo]::InvariantCulture))`,
						]
					: ["-o", "rss=", "-p", String(h.original.child.pid)],
			);
			expect(invocation?.shell).toBe(false);
			expect(invocation?.windowsHide).toBe(true);
			expect(invocation?.stdio).toEqual(["ignore", "pipe", "pipe"]);
			expect(invocation?.envKeys).toEqual(
				process.platform === "win32" ? ["PATH", "SystemRoot", "WINDIR"] : ["LANG", "LC_ALL"],
			);
			expect(watch.signal.aborted).toBe(false);
			expect(h.original.child.exitCode).toBeNull();
			expect(h.original.child.signalCode).toBeNull();
			expect(h.probes.length).toBeGreaterThan(0);
			expect(watch.stop()).toBe(watch.stopped);
			expect(watch.stop()).toBe(watch.stopped);
			await watch.stopped;
			await Promise.all(h.probes.map((probe) => probe.joined));
			expect(h.probes.every((probe) => probe.sawClose())).toBe(true);
			expect(h.original.child.exitCode).toBeNull();
		}));

	it("signals a one-byte limit immediately after the actual sample", () =>
		body(async () => {
			const h = harness();
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch(1);
			const sample = await watch.firstSample;
			expect(sample).toBeGreaterThan(1);
			expect(watch.signal.aborted).toBe(true);
			fixed(watch.signal.reason, "RSS_LIMIT");
			await watch.stopped;
			await Promise.all(h.probes.map((probe) => probe.joined));
			expect(h.original.child.exitCode).toBeNull();
			expect(h.original.child.signalCode).toBeNull();
		}));

	it("joins a genuine delayed probe-close callback before reporting stopped", () =>
		body(async () => {
			const h = harness(true);
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const stopped = stateOf(watch.stopped);
			const sample = stateOf(watch.firstSample);
			const probe = await h.waitForProbe(watch);
			expect(watch.stop()).toBe(watch.stopped);
			expect(watch.stop()).toBe(watch.stopped);
			await probe.closed;
			await turn();
			expect(h.closeDelivery.callbacks.length).toBeGreaterThan(0);
			expect(stopped()).toBe("pending");
			expect(sample()).toBe("fulfilled");
			expect(await watch.firstSample).toBeUndefined();
			expect(watch.signal.aborted).toBe(false);
			h.closeDelivery.release();
			await watch.stopped;
			await probe.joined;
			expect(stopped()).toBe("fulfilled");
			expect(h.original.child.exitCode).toBeNull();
		}));

	it("stops cleanly when the original watched child exits naturally", () =>
		body(async () => {
			const h = harness(true);
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const sampled = stateOf(watch.firstSample);
			const stopped = stateOf(watch.stopped);
			const probe = await h.waitForProbe(watch);
			h.original.child.stdin?.end();
			await h.original.joined;
			await probe.closed;
			await turn();
			expect(sampled()).toBe("fulfilled");
			expect(await watch.firstSample).toBeUndefined();
			expect(stopped()).toBe("pending");
			expect(watch.signal.aborted).toBe(false);
			h.closeDelivery.release();
			await watch.stopped;
			await probe.joined;
			expect(h.original.exit()).toEqual({ code: 0, signal: null });
			expect(watch.signal.aborted).toBe(false);
			expect(watch.stop()).toBe(watch.stopped);
		}));

	it("refuses a genuinely terminated OS probe while leaving the watched child live", () =>
		body(async () => {
			const h = harness(false, true);
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const sampled = stateOf(watch.firstSample);
			const probe = await h.waitForProbe(watch);
			await probe.joined;
			await turn();
			expect(h.faultKillAccepted()).toBe(true);
			expect(probe.exit()).toBeDefined();
			expect(probe.exit()).not.toEqual({ code: 0, signal: null });
			expect(sampled()).toBe("fulfilled");
			expect(watch.signal.aborted).toBe(true);
			fixed(watch.signal.reason, "RSS_UNAVAILABLE");
			expect(await watch.firstSample).toBeUndefined();
			await watch.stopped;
			expect(h.original.child.exitCode).toBeNull();
			expect(h.original.child.signalCode).toBeNull();
		}));

	it("refuses a late real sample before the due deadline timer can run", () =>
		body(async () => {
			const h = harness(true);
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const sampled = stateOf(watch.firstSample);
			const stopped = stateOf(watch.stopped);
			const probe = await h.waitForProbe(watch);
			await probe.joined;
			await turn();
			expect(h.closeDelivery.callbacks.length).toBeGreaterThan(0);
			expect(probe.exit()).toEqual({ code: 0, signal: null });
			expect(probe.rssBytes()).toBeGreaterThan(0);
			expect(sampled()).toBe("pending");
			expect(watch.signal.aborted).toBe(false);
			const anchor = performance.now();
			expect(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_100)).toBe("timed-out");
			expect(performance.now() - anchor).toBeGreaterThanOrEqual(5_000);
			h.closeDelivery.release();
			expect(watch.signal.aborted).toBe(true);
			fixed(watch.signal.reason, "RSS_UNAVAILABLE");
			expect(await watch.firstSample).toBeUndefined();
			await watch.stopped;
			await probe.joined;
			expect(sampled()).toBe("fulfilled");
			expect(stopped()).toBe("fulfilled");
			expect(h.original.child.exitCode).toBeNull();
		}));

	it("fences an immediate stop before dispatching a queued first probe", () =>
		body(async () => {
			const h = harness();
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			expect(watch.stop()).toBe(watch.stopped);
			await watch.stopped;
			await turn();
			expect(await watch.firstSample).toBeUndefined();
			expect(h.probes).toHaveLength(0);
			expect(watch.signal.aborted).toBe(false);
			expect(h.original.child.exitCode).toBeNull();
		}));

	it("refuses invalid limits and copied child data while preserving a real positive neighbor", () =>
		body(async () => {
			const h = harness();
			expect(await h.original.spawned).toBe(true);
			for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				let failure: unknown;
				try {
					h.watch(limit);
				} catch (error) {
					failure = error;
				}
				fixed(failure, "RSS_UNAVAILABLE");
			}
			for (const candidate of [null, { pid: h.original.child.pid }]) {
				let failure: unknown;
				try {
					h.retain(
						scope.run({ harness: h, holdClose: false }, () =>
							watchPluginRss(candidate as ChildProcess, Number.MAX_SAFE_INTEGER),
						),
					);
				} catch (error) {
					failure = error;
				}
				fixed(failure, "RSS_UNAVAILABLE");
			}
			const valid = h.watch();
			expect(await valid.firstSample).toBeGreaterThan(0);
			expect(valid.signal.aborted).toBe(false);
			await valid.stop();
		}));
});
