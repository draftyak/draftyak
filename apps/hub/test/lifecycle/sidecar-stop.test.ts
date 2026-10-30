import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import {
	type InitialMaterial,
	receiveSidecarInput,
	type SidecarStop,
} from "../../src/kernel/sidecar-input.ts";
import {
	bindSidecarShutdown,
	SIDECAR_SHUTDOWN_MS,
	SidecarShutdownError,
} from "../../src/lifecycle/sidecar-stop.ts";
import { createHubLifecycle, type HubStopReport } from "../../src/lifecycle/state.ts";

const CANARY = "DYTEST-PRIVATE-SIDECAR-FAILURE";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
type Options = Parameters<typeof bindSidecarShutdown>[0];

function manualClock() {
	const waits: {
		ms: number;
		signal: AbortSignal | undefined;
		fire(): void;
		fail(error: unknown): void;
	}[] = [];
	const clock: TimerClock = {
		wallMs: () => 0,
		monotonicMs: () => 0,
		after: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				waits.push({ ms, signal, fire: resolve, fail: reject });
				signal?.addEventListener("abort", () => reject(new Error("DYTEST-ABORTED")), {
					once: true,
				});
			}),
	};
	return { clock, waits };
}

const stopReport = (reason = "eof"): HubStopReport => ({
	reason,
	drained: true,
	outstanding: 0,
	failures: 0,
});

function harness() {
	const terminal = Promise.withResolvers<SidecarStop>();
	const closed = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<HubStopReport>();
	const input = { terminal: terminal.promise, closed: closed.promise };
	const lifecycle = { stop: vi.fn((_reason: string) => stopped.promise) };
	const timer = manualClock();
	const exit = vi.fn((_code: 0 | 1) => {});
	const options = { input, lifecycle, clock: timer.clock, exit };
	return { terminal, closed, stopped, input, lifecycle, ...timer, exit, options };
}

function thrown(action: () => unknown, code: "OPTIONS" | "BOUND"): void {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(SidecarShutdownError);
	expect(caught).toMatchObject({
		name: "SidecarShutdownError",
		code: `SIDECAR_SHUTDOWN_${code}`,
		message: `SIDECAR_SHUTDOWN_${code}`,
	});
	expect((caught as Error).cause).toBeUndefined();
}

describe("sidecar shutdown lifecycle binding", () => {
	it("closes the real claim gate before cleanup and waits for that cleanup", async () => {
		const h = harness();
		const hub = createHubLifecycle({ clock: h.clock });
		const cleanup = Promise.withResolvers<void>();
		await hub.unlock(async () => ({ close() {} }));
		let claimsRefusedDuringCleanup = false;
		hub.addStopStep(() => {
			try {
				hub.beginClaim();
			} catch {
				claimsRefusedDuringCleanup = true;
			}
			return cleanup.promise;
		});
		const result = bindSidecarShutdown({ ...h.options, lifecycle: hub });
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		await settle();
		expect(hub.state).toBe("stopping");
		expect(claimsRefusedDuringCleanup).toBe(true);
		expect(() => hub.beginClaim()).toThrowError("HUB_STOPPING");
		h.closed.resolve();
		await settle();
		expect(h.exit).not.toHaveBeenCalled();
		cleanup.resolve();
		expect(await result).toEqual({ reason: "eof", outcome: "clean", exitCode: 0 });
		expect(hub.state).toBe("stopped");
		expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(h.waits).toHaveLength(1);
		expect(h.waits[0]?.ms).toBe(10_000);
		expect(h.waits[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(h.waits[0]?.signal?.aborted).toBe(true);
	});

	it.each(["eof", "shutdown"] as const)(
		"waits for receiver closure after a successful %s stop",
		async (reason) => {
			const h = harness();
			const result = bindSidecarShutdown(h.options);
			h.terminal.resolve({ kind: "stop", reason });
			h.stopped.resolve(stopReport(reason));
			await settle();
			expect(h.lifecycle.stop).toHaveBeenCalledExactlyOnceWith(reason);
			expect(h.exit).not.toHaveBeenCalled();
			h.closed.resolve();
			const report = await result;
			expect(report).toEqual({ reason, outcome: "clean", exitCode: 0 });
			expect(Object.isFrozen(report)).toBe(true);
			expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
			expect(h.waits[0]?.signal?.aborted).toBe(true);
		},
	);

	it.each(["fault", "cancelled", "disposed"] as const)(
		"fails closed for the receiver's %s terminal reason",
		async (reason) => {
			const h = harness();
			const result = bindSidecarShutdown(h.options);
			h.terminal.resolve({ kind: "stop", reason });
			h.closed.resolve();
			h.stopped.resolve(stopReport(reason));
			expect(await result).toEqual({ reason, outcome: "failed", exitCode: 1 });
			expect(h.lifecycle.stop).toHaveBeenCalledExactlyOnceWith(reason);
			expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
		},
	);

	it.each(["stop", "receiver"] as const)(
		"bounds an unsettled %s and observes its late rejection without a second exit",
		async (pending) => {
			const h = harness();
			const result = bindSidecarShutdown(h.options);
			h.terminal.resolve({ kind: "stop", reason: "shutdown" });
			if (pending === "stop") h.closed.resolve();
			else h.stopped.resolve(stopReport("shutdown"));
			await settle();
			expect(h.exit).not.toHaveBeenCalled();
			expect(SIDECAR_SHUTDOWN_MS).toBe(10_000);
			expect(h.waits[0]?.ms).toBe(10_000);
			h.waits[0]?.fire();
			expect(await result).toEqual({ reason: "shutdown", outcome: "deadline", exitCode: 1 });
			expect(h.waits[0]?.signal?.aborted).toBe(true);
			if (pending === "stop") h.stopped.reject(new Error(CANARY));
			else h.closed.reject(new Error(CANARY));
			await settle();
			expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
		},
	);

	it("does not exit again when a timed-out stop later succeeds", async () => {
		const h = harness();
		const result = bindSidecarShutdown(h.options);
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		h.closed.resolve();
		await settle();
		h.waits[0]?.fire();
		expect((await result).outcome).toBe("deadline");
		h.stopped.resolve(stopReport());
		await settle();
		expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it.each(["stop throws", "stop rejects", "receiver rejects", "timer rejects", "timer throws"])(
		"redacts a failure when %s",
		async (failure) => {
			const h = harness();
			if (failure === "stop throws")
				h.lifecycle.stop.mockImplementation(() => {
					throw new Error(CANARY);
				});
			if (failure === "timer throws")
				h.clock.after = () => {
					throw new Error(CANARY);
				};
			const result = bindSidecarShutdown(h.options);
			h.terminal.resolve({ kind: "stop", reason: "shutdown" });
			if (failure === "stop rejects") h.stopped.reject(new Error(CANARY));
			else if (failure !== "timer rejects") h.stopped.resolve(stopReport("shutdown"));
			if (failure === "receiver rejects") h.closed.reject(new Error(CANARY));
			else h.closed.resolve();
			if (failure === "timer rejects") {
				await settle();
				h.waits[0]?.fail(new Error(CANARY));
			}
			const report = await result;
			expect(report).toEqual({ reason: "shutdown", outcome: "failed", exitCode: 1 });
			expect(JSON.stringify(report)).not.toContain(CANARY);
			expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
			for (const wait of h.waits) expect(wait.signal?.aborted).toBe(true);
		},
	);

	it.each([null, {}, { kind: "resumed", reason: "eof" }, { kind: "stop", reason: CANARY }])(
		"treats malformed terminal data as a fault",
		async (terminal) => {
			const h = harness();
			const result = bindSidecarShutdown(h.options);
			h.terminal.resolve(terminal as SidecarStop);
			h.closed.resolve();
			h.stopped.resolve(stopReport("fault"));
			expect(await result).toEqual({ reason: "fault", outcome: "failed", exitCode: 1 });
			expect(h.lifecycle.stop).toHaveBeenCalledExactlyOnceWith("fault");
			expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
		},
	);

	it("still requests a fault stop when the terminal promise rejects", async () => {
		const h = harness();
		const result = bindSidecarShutdown(h.options);
		h.terminal.reject(new Error(CANARY));
		h.closed.resolve();
		h.stopped.resolve(stopReport("fault"));
		expect(await result).toEqual({ reason: "fault", outcome: "failed", exitCode: 1 });
		expect(h.lifecycle.stop).toHaveBeenCalledExactlyOnceWith("fault");
	});

	it.each([
		{ ...stopReport(), drained: false },
		{ ...stopReport(), outstanding: 1 },
		{ ...stopReport(), failures: 1 },
		{ ...stopReport(), failures: Number.NaN },
		{ drained: true, outstanding: 0 },
		null,
	])("does not report a failed or malformed lifecycle stop as clean", async (stopped) => {
		const h = harness();
		const result = bindSidecarShutdown(h.options);
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		h.closed.resolve();
		h.stopped.resolve(stopped as HubStopReport);
		expect(await result).toEqual({ reason: "eof", outcome: "failed", exitCode: 1 });
		expect(h.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it("returns one binding and refuses to replace any of its execution dependencies", async () => {
		const h = harness();
		const result = bindSidecarShutdown(h.options);
		expect(bindSidecarShutdown({ ...h.options })).toBe(result);
		for (const replacement of [
			{ lifecycle: { stop: vi.fn(async () => stopReport()) } },
			{ clock: manualClock().clock },
			{ exit: vi.fn() },
		])
			thrown(() => bindSidecarShutdown({ ...h.options, ...replacement }), "BOUND");
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		h.closed.resolve();
		h.stopped.resolve(stopReport());
		expect((await result).exitCode).toBe(0);
		expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(bindSidecarShutdown(h.options)).toBe(result);
	});

	it("captures functions and promise properties once and preserves their receivers", async () => {
		const h = harness();
		const readTerminal = vi.fn(() => h.terminal.promise);
		const readClosed = vi.fn(() => h.closed.promise);
		const stop = vi.fn(function (this: object, reason: string) {
			expect(this).toBe(lifecycle);
			expect(reason).toBe("eof");
			return h.stopped.promise;
		});
		const readStop = vi.fn(() => stop);
		const readAfter = vi.fn(() => h.clock.after);
		const input = {
			get terminal() {
				return readTerminal();
			},
			get closed() {
				return readClosed();
			},
		};
		const lifecycle = {
			get stop() {
				return readStop();
			},
		};
		const clock = {
			...h.clock,
			get after() {
				return readAfter();
			},
		};
		const reads = {
			input: vi.fn(() => input),
			lifecycle: vi.fn(() => lifecycle),
			clock: vi.fn(() => clock),
			exit: vi.fn(() => h.exit),
		};
		const result = bindSidecarShutdown({
			get input() {
				return reads.input();
			},
			get lifecycle() {
				return reads.lifecycle();
			},
			get clock() {
				return reads.clock();
			},
			get exit() {
				return reads.exit();
			},
		});
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		h.closed.resolve();
		h.stopped.resolve(stopReport());
		expect((await result).exitCode).toBe(0);
		for (const read of [readTerminal, readClosed, readStop, readAfter, ...Object.values(reads)])
			expect(read).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("uses native promise reactions without invoking overridden then properties", async () => {
		const h = harness();
		const then = vi.fn(() => {
			throw new Error(CANARY);
		});
		for (const promise of [h.terminal.promise, h.closed.promise]) {
			// biome-ignore lint/suspicious/noThenProperty: Native promise overrides must not run during observation.
			Object.defineProperty(promise, "then", { get: then });
		}
		const result = bindSidecarShutdown(h.options);
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		h.closed.resolve();
		h.stopped.resolve(stopReport());
		expect((await result).exitCode).toBe(0);
		expect(then).not.toHaveBeenCalled();
	});

	it.each([
		(options: Options) => ({ ...options, input: null }),
		(options: Options) => ({ ...options, input: { terminal: {}, closed: Promise.resolve() } }),
		(options: Options) => ({
			...options,
			input: {
				terminal: Promise.resolve(),
				closed: {
					// biome-ignore lint/suspicious/noThenProperty: A thenable must not substitute for the native cleanup promise.
					then() {},
				},
			},
		}),
		(options: Options) => ({ ...options, lifecycle: { stop: null } }),
		(options: Options) => ({ ...options, clock: { after: null } }),
		(options: Options) => ({ ...options, clock: null }),
		(options: Options) => ({ ...options, exit: 1 }),
		(options: Options) => ({ ...options, exit: null }),
		() => null,
	])("refuses malformed options without calling stop or exit", (make) => {
		const h = harness();
		thrown(() => bindSidecarShutdown(make(h.options) as Options), "OPTIONS");
		expect(h.lifecycle.stop).not.toHaveBeenCalled();
		expect(h.exit).not.toHaveBeenCalled();
	});

	it("redacts a throwing options getter", () => {
		thrown(
			() =>
				bindSidecarShutdown({
					get input() {
						throw new Error(CANARY);
					},
				} as unknown as Options),
			"OPTIONS",
		);
	});

	it("rejects a throwing exit hook with only the fixed exit error", async () => {
		const h = harness();
		h.exit.mockImplementation(() => {
			throw new Error(CANARY);
		});
		const result = bindSidecarShutdown(h.options);
		h.terminal.resolve({ kind: "stop", reason: "eof" });
		h.closed.resolve();
		h.stopped.resolve(stopReport());
		const error = await result.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SidecarShutdownError);
		expect(error).toMatchObject({
			code: "SIDECAR_SHUTDOWN_EXIT",
			message: "SIDECAR_SHUTDOWN_EXIT",
		});
		expect((error as Error).cause).toBeUndefined();
		expect(h.exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(h.waits[0]?.signal?.aborted).toBe(true);
	});
});

function frame(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	return Buffer.concat([header, body]);
}

describe("sidecar receiver and lifecycle composition", () => {
	it.each(["eof", "shutdown", "fault"] as const)("stops on a real receiver %s", async (reason) => {
		const key = randomBytes(32);
		const bootstrap = randomBytes(16);
		const source = new Readable({ read() {} });
		const input = receiveSidecarInput(source);
		const timer = manualClock();
		const hub = createHubLifecycle({ clock: timer.clock });
		const exit = vi.fn((_code: 0 | 1) => {});
		const result = bindSidecarShutdown({ input, lifecycle: hub, clock: timer.clock, exit });
		let material: InitialMaterial | undefined;
		try {
			source.push(
				frame(
					JSON.stringify({
						masterKey: key.toString("hex"),
						bootstrapSecret: bootstrap.toString("hex"),
					}),
				),
			);
			await input.initialReady;
			material = input.takeInitial();
			key.fill(0);
			bootstrap.fill(0);
			const owned = material;
			await hub.unlock(async () => ({
				close() {
					owned.masterKey.destroy();
					owned.bootstrapSecret.fill(0);
				},
			}));
			if (reason === "eof") source.push(null);
			else
				source.push(
					frame(reason === "shutdown" ? '{"shutdown":true}' : JSON.stringify({ private: CANARY })),
				);
			const exitCode = reason === "fault" ? 1 : 0;
			expect(await result).toEqual({
				reason,
				outcome: reason === "fault" ? "failed" : "clean",
				exitCode,
			});
			expect(exit).toHaveBeenCalledExactlyOnceWith(exitCode);
			expect(hub.state).toBe("stopped");
			expect(input.state).toBe("closed");
			expect(material.bootstrapSecret.every((byte) => byte === 0)).toBe(true);
			expect(() => material?.masterKey.derive("audit")).toThrowError("Hub is locked");
		} finally {
			key.fill(0);
			bootstrap.fill(0);
			material?.masterKey.destroy();
			material?.bootstrapSecret.fill(0);
			await input.dispose().catch(() => undefined);
		}
	});
});
