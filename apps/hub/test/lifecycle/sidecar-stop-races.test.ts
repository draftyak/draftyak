import { describe, expect, it, vi } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import type { SidecarStop } from "../../src/kernel/sidecar-input.ts";
import {
	bindSidecarShutdown,
	type SidecarShutdownOptions,
} from "../../src/lifecycle/sidecar-stop.ts";
import { createHubLifecycle, type HubStopReport } from "../../src/lifecycle/state.ts";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function manualClock() {
	const waits: { ms: number; signal: AbortSignal | undefined; fire(): void }[] = [];
	const clock: TimerClock = {
		wallMs: () => 0,
		monotonicMs: () => 0,
		after: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				waits.push({ ms, signal, fire: resolve });
				signal?.addEventListener("abort", () => reject(new Error("DYTEST-ABORTED")), {
					once: true,
				});
			}),
	};
	return { clock, waits };
}

function input() {
	const terminal = Promise.withResolvers<SidecarStop>();
	const closed = Promise.withResolvers<void>();
	return { terminal, closed, input: { terminal: terminal.promise, closed: closed.promise } };
}

describe("sidecar shutdown races", () => {
	it("waits for the real asynchronous session close before requesting a clean exit", async () => {
		const receiver = input();
		const timer = manualClock();
		const hub = createHubLifecycle({ clock: timer.clock });
		const closing = Promise.withResolvers<void>();
		const close = vi.fn(() => closing.promise);
		await hub.unlock(async () => ({ close }));
		const exit = vi.fn((_code: 0 | 1) => {});
		const result = bindSidecarShutdown({
			input: receiver.input,
			lifecycle: hub,
			clock: timer.clock,
			exit,
		});
		receiver.terminal.resolve({ kind: "stop", reason: "shutdown" });
		receiver.closed.resolve();
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(hub.state).toBe("stopping");
		expect(exit).not.toHaveBeenCalled();
		expect(() => hub.beginClaim()).toThrowError("HUB_STOPPING");
		closing.resolve();
		expect(await result).toEqual({ reason: "shutdown", outcome: "clean", exitCode: 0 });
		expect(hub.state).toBe("stopped");
		expect(close).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(timer.waits).toHaveLength(1);
		expect(timer.waits[0]?.signal?.aborted).toBe(true);
	});

	it.each(["resolve", "reject"] as const)(
		"keeps lifecycle authority closed when a timed-out session close later %ss",
		async (late) => {
			const receiver = input();
			const timer = manualClock();
			const hub = createHubLifecycle({ clock: timer.clock });
			const closing = Promise.withResolvers<void>();
			const close = vi.fn(() => closing.promise);
			await hub.unlock(async () => ({ close }));
			const exit = vi.fn((_code: 0 | 1) => {});
			const result = bindSidecarShutdown({
				input: receiver.input,
				lifecycle: hub,
				clock: timer.clock,
				exit,
			});
			receiver.terminal.resolve({ kind: "stop", reason: "eof" });
			receiver.closed.resolve();
			await settle();
			expect(close).toHaveBeenCalledTimes(1);
			expect(timer.waits).toHaveLength(1);
			expect(timer.waits[0]?.ms).toBe(10_000);
			timer.waits[0]?.fire();
			expect(await result).toEqual({ reason: "eof", outcome: "deadline", exitCode: 1 });
			expect(hub.state).toBe("stopping");
			expect(() => hub.beginClaim()).toThrowError("HUB_STOPPING");
			expect(close).toHaveBeenCalledTimes(1);
			expect(timer.waits[0]?.signal?.aborted).toBe(true);
			if (late === "reject") closing.reject(new Error("DYTEST-PRIVATE-LATE-CLOSE"));
			else closing.resolve();
			const stop = await hub.stopped;
			expect(stop).toEqual({
				reason: "eof",
				drained: true,
				outstanding: 0,
				failures: late === "reject" ? 1 : 0,
			});
			expect(hub.state).toBe("stopped");
			expect(() => hub.beginClaim()).toThrowError("HUB_STOPPING");
			expect(close).toHaveBeenCalledTimes(1);
			await settle();
			expect(exit).toHaveBeenCalledExactlyOnceWith(1);
		},
	);

	it("does not turn an earlier fatal lifecycle stop into a successful EOF exit", async () => {
		const receiver = input();
		const timer = manualClock();
		const hub = createHubLifecycle({ clock: timer.clock });
		const close = vi.fn();
		await hub.unlock(async () => ({ close }));
		expect(await hub.stop("fatal")).toEqual({
			reason: "fatal",
			drained: true,
			outstanding: 0,
			failures: 0,
		});
		const exit = vi.fn((_code: 0 | 1) => {});
		const result = bindSidecarShutdown({
			input: receiver.input,
			lifecycle: hub,
			clock: timer.clock,
			exit,
		});
		receiver.terminal.resolve({ kind: "stop", reason: "eof" });
		receiver.closed.resolve();
		expect(await result).toEqual({ reason: "eof", outcome: "failed", exitCode: 1 });
		expect((await hub.stopped).reason).toBe("fatal");
		expect(close).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it("does not release an in-flight claim or cancel its lifecycle drain at the exit deadline", async () => {
		const receiver = input();
		const drainTimer = manualClock();
		const exitTimer = manualClock();
		const hub = createHubLifecycle({ clock: drainTimer.clock });
		const close = vi.fn();
		await hub.unlock(async () => ({ close }));
		const permit = hub.beginClaim();
		const exit = vi.fn((_code: 0 | 1) => {});
		const result = bindSidecarShutdown({
			input: receiver.input,
			lifecycle: hub,
			clock: exitTimer.clock,
			exit,
		});
		receiver.terminal.resolve({ kind: "stop", reason: "shutdown" });
		receiver.closed.resolve();
		await settle();
		expect(drainTimer.waits).toHaveLength(1);
		expect(exitTimer.waits).toHaveLength(1);
		exitTimer.waits[0]?.fire();
		expect(await result).toEqual({ reason: "shutdown", outcome: "deadline", exitCode: 1 });
		expect(hub.state).toBe("stopping");
		expect(() => hub.beginClaim()).toThrowError("HUB_STOPPING");
		expect(close).not.toHaveBeenCalled();
		expect(drainTimer.waits[0]?.signal?.aborted).toBe(false);
		permit.release();
		expect(await hub.stopped).toEqual({
			reason: "shutdown",
			drained: true,
			outstanding: 0,
			failures: 0,
		});
		expect(close).toHaveBeenCalledTimes(1);
		expect(drainTimer.waits[0]?.signal?.aborted).toBe(true);
		await settle();
		expect(exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it.each(["stop", "clock"] as const)(
		"keeps one binding when the %s callback reenters with matching and conflicting options",
		async (reenterAt) => {
			const receiver = input();
			const timer = manualClock();
			const stopped = Promise.withResolvers<HubStopReport>();
			const exit = vi.fn((_code: 0 | 1) => {});
			let reentered = false;
			let same: ReturnType<typeof bindSidecarShutdown> | undefined;
			let conflict: unknown;
			let options: SidecarShutdownOptions;
			const reenter = (): void => {
				if (reentered) return;
				reentered = true;
				same = bindSidecarShutdown({ ...options });
				try {
					bindSidecarShutdown({ ...options, exit: () => {} });
				} catch (error) {
					conflict = error;
				}
			};
			const lifecycle = {
				stop: vi.fn((_reason: string) => {
					if (reenterAt === "stop") reenter();
					return stopped.promise;
				}),
			};
			const clock: TimerClock = {
				...timer.clock,
				after: vi.fn((ms: number, signal?: AbortSignal) => {
					if (reenterAt === "clock") reenter();
					return timer.clock.after(ms, signal);
				}),
			};
			options = { input: receiver.input, lifecycle, clock, exit };
			const result = bindSidecarShutdown(options);
			receiver.terminal.resolve({ kind: "stop", reason: "eof" });
			await settle();
			expect(reentered).toBe(true);
			expect(same).toBe(result);
			expect(conflict).toMatchObject({
				name: "SidecarShutdownError",
				code: "SIDECAR_SHUTDOWN_BOUND",
				message: "SIDECAR_SHUTDOWN_BOUND",
			});
			expect(lifecycle.stop).toHaveBeenCalledExactlyOnceWith("eof");
			expect(clock.after).toHaveBeenCalledTimes(1);
			expect(timer.waits).toHaveLength(1);
			expect(exit).not.toHaveBeenCalled();
			receiver.closed.resolve();
			stopped.resolve({ reason: "eof", drained: true, outstanding: 0, failures: 0 });
			expect(await result).toEqual({ reason: "eof", outcome: "clean", exitCode: 0 });
			expect(exit).toHaveBeenCalledExactlyOnceWith(0);
			expect(timer.waits[0]?.signal?.aborted).toBe(true);
			await settle();
			expect(lifecycle.stop).toHaveBeenCalledTimes(1);
			expect(exit).toHaveBeenCalledTimes(1);
		},
	);
});
