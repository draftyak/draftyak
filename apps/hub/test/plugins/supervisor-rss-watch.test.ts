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
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const childSource = "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));";

interface ObservationState {
	valid: boolean;
	origin: number;
	cleanup: boolean;
	fault: boolean;
	timer: boolean;
	restoreFailed: boolean;
	registered: number;
	fired: number;
	firstRegisteredMs: number | null;
	firstFireMs: number | null;
	tokens: ReturnType<typeof originalSetTimeout>[];
}

interface ChildFacts {
	spawn: boolean;
	error: boolean;
	exit: boolean;
	close: boolean;
	exitCode: number | null;
	signal: "none" | "SIGKILL" | "SIGTERM" | "other";
	stdoutBytes: number;
	stderrBytes: number;
	numericValid: boolean;
	rssBytes: number | null;
	stdoutEnd: boolean;
	stdoutClose: boolean;
	stdoutError: boolean;
	stderrEnd: boolean;
	stderrClose: boolean;
	stderrError: boolean;
	spawnMs: number | null;
	errorMs: number | null;
	exitMs: number | null;
	closeMs: number | null;
	stdoutFirstMs: number | null;
	stderrFirstMs: number | null;
	stdoutEndMs: number | null;
	stdoutCloseMs: number | null;
	stderrEndMs: number | null;
	stderrCloseMs: number | null;
	killCalls: number;
	firstKillMs: number | null;
	firstKillDuringTimer: boolean;
	firstKillDuringFault: boolean;
	firstKillDuringCleanup: boolean;
}

function observationState(): ObservationState {
	const state: ObservationState = {
		valid: true,
		origin: 0,
		cleanup: false,
		fault: false,
		timer: false,
		restoreFailed: false,
		registered: 0,
		fired: 0,
		firstRegisteredMs: null,
		firstFireMs: null,
		tokens: [],
	};
	try {
		state.origin = performance.now();
		if (!Number.isFinite(state.origin) || state.origin < 0) state.valid = false;
	} catch {
		state.valid = false;
	}
	return state;
}

function stamp(state: ObservationState): number | null {
	try {
		const elapsed = performance.now() - state.origin;
		if (Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
	} catch {
		/* Only fixed invalid-observation DATA is retained. */
	}
	state.valid = false;
	return null;
}

function boundedIncrement(value: number): number {
	return Math.min(32, value + 1);
}

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
	readonly facts: () => Readonly<ChildFacts>;
	stop(): void;
}

function retainChild(
	child: ChildProcess,
	observation: ObservationState,
	wrapKill = false,
): OriginalChild {
	const facts: ChildFacts = {
		spawn: false,
		error: false,
		exit: false,
		close: false,
		exitCode: null,
		signal: "none",
		stdoutBytes: 0,
		stderrBytes: 0,
		numericValid: false,
		rssBytes: null,
		stdoutEnd: false,
		stdoutClose: false,
		stdoutError: false,
		stderrEnd: false,
		stderrClose: false,
		stderrError: false,
		spawnMs: null,
		errorMs: null,
		exitMs: null,
		closeMs: null,
		stdoutFirstMs: null,
		stderrFirstMs: null,
		stdoutEndMs: null,
		stdoutCloseMs: null,
		stderrEndMs: null,
		stderrCloseMs: null,
		killCalls: 0,
		firstKillMs: null,
		firstKillDuringTimer: false,
		firstKillDuringFault: false,
		firstKillDuringCleanup: false,
	};
	const closed = deferred<void>(),
		spawned = deferred<boolean>(),
		exited = deferred<void>();
	let sawSpawn = false,
		sawClose = false;
	let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let numericText = "",
		invalidOutput = false,
		stderrSeen = false;
	let restoreKill: (() => void) | undefined;
	child.stdout?.on("data", (chunk: unknown) => {
		facts.stdoutFirstMs ??= stamp(observation);
		facts.stdoutBytes = Buffer.isBuffer(chunk)
			? Math.min(257, facts.stdoutBytes + chunk.length)
			: 257;
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
	child.stderr?.on("data", (chunk: unknown) => {
		facts.stderrFirstMs ??= stamp(observation);
		facts.stderrBytes = Buffer.isBuffer(chunk)
			? Math.min(257, facts.stderrBytes + chunk.length)
			: 257;
	});
	child.stdout?.once("end", () => {
		facts.stdoutEnd = true;
		facts.stdoutEndMs = stamp(observation);
	});
	child.stdout?.once("close", () => {
		facts.stdoutClose = true;
		facts.stdoutCloseMs = stamp(observation);
	});
	child.stdout?.on("error", () => {
		facts.stdoutError = true;
	});
	child.stderr?.once("end", () => {
		facts.stderrEnd = true;
		facts.stderrEndMs = stamp(observation);
	});
	child.stderr?.once("close", () => {
		facts.stderrClose = true;
		facts.stderrCloseMs = stamp(observation);
	});
	child.stderr?.on("error", () => {
		facts.stderrError = true;
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
		facts.spawn = true;
		facts.spawnMs = stamp(observation);
		spawned.resolve(true);
	});
	child.on("error", () => {
		facts.error = true;
		facts.errorMs ??= stamp(observation);
		spawned.resolve(false);
	});
	child.once("exit", (code, signal) => {
		exit = { code, signal };
		facts.exit = true;
		facts.exitMs = stamp(observation);
		facts.exitCode = code !== null && Number.isSafeInteger(code) && code >= 0 ? code : null;
		facts.signal =
			signal === null ? "none" : signal === "SIGKILL" || signal === "SIGTERM" ? signal : "other";
		exited.resolve();
	});
	child.once("close", () => {
		sawClose = true;
		facts.close = true;
		facts.closeMs = stamp(observation);
		closed.resolve();
	});
	const joined = observe(
		(async () => {
			await closed.promise;
			if (sawSpawn) await exited.promise;
			await Promise.all(pipes);
			restoreKill?.();
		})(),
	);
	if (wrapKill) {
		const kill = child.kill;
		const ownKill = Object.getOwnPropertyDescriptor(child, "kill");
		try {
			Object.defineProperty(child, "kill", {
				configurable: true,
				value: function (this: ChildProcess, ...args: Parameters<ChildProcess["kill"]>) {
					try {
						if (facts.killCalls === 0) {
							facts.firstKillMs = stamp(observation);
							facts.firstKillDuringTimer = observation.timer;
							facts.firstKillDuringFault = observation.fault;
							facts.firstKillDuringCleanup = observation.cleanup;
						}
						facts.killCalls = boundedIncrement(facts.killCalls);
					} catch {
						observation.valid = false;
					}
					return Reflect.apply(kill, this, args);
				},
			});
			restoreKill = () => {
				try {
					if (ownKill) Object.defineProperty(child, "kill", ownKill);
					else if (!Reflect.deleteProperty(child, "kill")) {
						observation.valid = false;
						observation.restoreFailed = true;
					}
				} catch {
					observation.valid = false;
					observation.restoreFailed = true;
				}
			};
		} catch {
			observation.valid = false;
		}
	}
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
		facts() {
			const raw = numericText.trim();
			const value = Number(raw) * (process.platform === "win32" ? 1 : 1024);
			facts.numericValid =
				!invalidOutput &&
				!stderrSeen &&
				/^[0-9]+$/.test(raw) &&
				Number.isSafeInteger(value) &&
				value >= 0;
			facts.rssBytes = facts.numericValid ? value : null;
			return Object.freeze({ ...facts });
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
	readonly observation: ObservationState;
	readonly original: OriginalChild;
	readonly probes: OriginalChild[];
	readonly watches: PluginRssWatch[];
	readonly closeDelivery: CloseDelivery;
	readonly firstProbe: Promise<OriginalChild>;
	readonly faultKillAccepted: () => boolean;
	readonly invocations: ProbeInvocation[];
	sampleState(watch: PluginRssWatch): "pending" | "fulfilled" | "rejected";
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
let restoreTimer: () => void;
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
	const observation = observationState();
	const child = originalSpawn(process.execPath, ["-e", childSource], {
		stdio: ["pipe", "pipe", "pipe"],
		env: {},
		windowsHide: true,
	});
	const original = retainChild(child, observation);
	child.stdout?.resume();
	child.stderr?.resume();
	const probes: OriginalChild[] = [],
		watches: PluginRssWatch[] = [];
	const invocations: ProbeInvocation[] = [];
	const observations: Promise<unknown>[] = [];
	const sampleStates = new WeakMap<PluginRssWatch, () => "pending" | "fulfilled" | "rejected">();
	const firstProbe = deferred<OriginalChild>(),
		closeDelivery = new CloseDelivery();
	let cleanup: Promise<void> | undefined;
	let cleanupFailed = false;
	let faultKillAccepted = false;
	const h: Harness = {
		observation,
		original,
		probes,
		watches,
		closeDelivery,
		firstProbe: firstProbe.promise,
		invocations,
		faultKillAccepted: () => faultKillAccepted,
		sampleState(watch) {
			const state = sampleStates.get(watch);
			if (!state) observation.valid = false;
			return state?.() ?? "pending";
		},
		captureProbe(actual, args) {
			const probe = retainChild(actual, observation, true);
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
				const wasFault = observation.fault;
				observation.fault = true;
				try {
					faultKillAccepted = actual.kill("SIGKILL");
				} catch {
					faultKillAccepted = false;
				} finally {
					observation.fault = wasFault;
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
			sampleStates.set(watch, stateOf(watch.firstSample));
			observe(watch.firstSample);
			observe(watch.stopped);
			return watch;
		},
		cancel() {
			observation.cleanup = true;
			for (const watch of watches) {
				try {
					observe(watch.stop());
				} catch {
					cleanupFailed = true;
				}
			}
			for (const token of observation.tokens) {
				try {
					originalClearTimeout(token);
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
					if (
						cleanupFailed ||
						observation.restoreFailed ||
						outcomes.some((result) => result.status === "rejected")
					) {
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

function probeFacts(h: Harness, watch: PluginRssWatch) {
	const state = h.observation;
	const sampleState = h.sampleState(watch);
	const watched = h.original.facts();
	const probe = h.probes[0]?.facts() ?? null;
	const reason: unknown = watch.signal.reason;
	const watchCode = !watch.signal.aborted
		? "none"
		: reason instanceof PluginRssError &&
				(reason.code === "RSS_LIMIT" || reason.code === "RSS_UNAVAILABLE")
			? reason.code
			: "other";
	return Object.freeze({
		schema: "rss-probe-facts-r1",
		valid: state.valid,
		sampleState,
		watchAborted: watch.signal.aborted,
		watchCode,
		cleanup: state.cleanup,
		fault: state.fault,
		watched,
		probe,
		timers: Object.freeze({
			registered: state.registered,
			fired: state.fired,
			firstRegisteredMs: state.firstRegisteredMs,
			firstFireMs: state.firstFireMs,
		}),
	});
}

function assertProbeSuccess(
	h: Harness,
	watch: PluginRssWatch,
	code: "none" | "RSS_LIMIT" = "none",
): void {
	const facts = probeFacts(h, watch);
	expect(facts, `RSS_PROBE_FACTS=${JSON.stringify(facts)}`).toMatchObject({
		valid: true,
		cleanup: false,
		watchAborted: code !== "none",
		watchCode: code,
		watched: { spawn: true, error: false, exit: false, close: false },
		probe: {
			spawn: true,
			error: false,
			exit: true,
			close: true,
			exitCode: 0,
			signal: "none",
			stdoutEnd: true,
			stdoutClose: true,
			stdoutError: false,
			stderrEnd: true,
			stderrClose: true,
			stderrError: false,
			stderrBytes: 0,
			numericValid: true,
		},
	});
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
	const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(function (
		this: unknown,
		...args: Parameters<typeof originalSetTimeout>
	) {
		const current = scope.getStore();
		if (!current || args[1] !== 5000) return Reflect.apply(originalSetTimeout, this, args);
		const observation = current.harness.observation;
		const callback = args[0];
		const wrapped = function (this: unknown, ...callbackArgs: unknown[]) {
			const wasTimer = observation.timer;
			try {
				observation.timer = true;
				observation.fired = boundedIncrement(observation.fired);
				observation.firstFireMs ??= stamp(observation);
			} catch {
				observation.valid = false;
			}
			try {
				return Reflect.apply(callback, this, callbackArgs);
			} finally {
				observation.timer = wasTimer;
			}
		};
		const token: ReturnType<typeof originalSetTimeout> = Reflect.apply(originalSetTimeout, this, [
			wrapped,
			args[1],
			...args.slice(2),
		]);
		try {
			observation.tokens.push(token);
			observation.registered = boundedIncrement(observation.registered);
			observation.firstRegisteredMs ??= stamp(observation);
		} catch {
			observation.valid = false;
		}
		return token;
	});
	restoreTimer = () => {
		timerSpy.mockRestore();
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
		try {
			restoreTimer();
		} finally {
			try {
				restoreSpawn();
			} finally {
				scope.disable();
			}
		}
	}
});

describe("plugin RSS watch", () => {
	it("samples the original live child without terminating it", () =>
		body(async () => {
			const h = harness();
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const sample = await watch.firstSample;
			assertProbeSuccess(h, watch);
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
			assertProbeSuccess(h, watch, "RSS_LIMIT");
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

	it("waits for genuine probe-close delivery after the original deadline fires", () =>
		body(async () => {
			const h = harness(true);
			expect(await h.original.spawned).toBe(true);
			const watch = h.watch();
			const sampled = stateOf(watch.firstSample);
			const stopped = stateOf(watch.stopped);
			const probe = await h.waitForProbe(watch);
			await probe.joined;
			await turn();
			assertProbeSuccess(h, watch);
			expect(h.closeDelivery.callbacks.length).toBeGreaterThan(0);
			expect(sampled()).toBe("pending");
			expect(watch.signal.aborted).toBe(false);
			const anchor = performance.now();
			await observe(
				new Promise<void>((resolve) => {
					originalSetTimeout(resolve, 5_100);
				}),
			);
			expect(performance.now() - anchor).toBeGreaterThanOrEqual(5_000);
			expect(watch.signal.aborted, `RSS_PROBE_FACTS=${JSON.stringify(probeFacts(h, watch))}`).toBe(
				true,
			);
			fixed(watch.signal.reason, "RSS_UNAVAILABLE");
			expect(h.observation.fired).toBeGreaterThan(0);
			expect(await watch.firstSample).toBeUndefined();
			expect(stopped()).toBe("pending");
			h.closeDelivery.release();
			await watch.stopped;
			await probe.joined;
			expect(stopped()).toBe("fulfilled");
			expect(h.original.child.exitCode).toBeNull();
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
			assertProbeSuccess(h, watch);
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
			const sample = await valid.firstSample;
			assertProbeSuccess(h, valid);
			expect(sample).toBeGreaterThan(0);
			expect(valid.signal.aborted).toBe(false);
			await valid.stop();
		}));
});
