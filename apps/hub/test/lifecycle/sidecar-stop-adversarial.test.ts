import { describe, expect, it, vi } from "vitest";
import type { TimerClock } from "../../src/kernel/clock.ts";
import type { SidecarStop } from "../../src/kernel/sidecar-input.ts";
import { bindSidecarShutdown, SIDECAR_SHUTDOWN_MS } from "../../src/lifecycle/sidecar-stop.ts";
import { createHubLifecycle, type HubStopReport } from "../../src/lifecycle/state.ts";

const clock: TimerClock = {
	wallMs: () => 0,
	monotonicMs: () => 0,
	after: (_ms, signal) =>
		new Promise<void>((_resolve, reject) =>
			signal?.addEventListener("abort", () => reject(new Error("DYTEST-DISARMED")), {
				once: true,
			}),
		),
};
const clean = (reason: string): HubStopReport => ({
	reason,
	drained: true,
	outstanding: 0,
	failures: 0,
});

function fixture() {
	const terminal = Promise.withResolvers<SidecarStop>();
	const closed = Promise.withResolvers<void>();
	const exit = vi.fn((_code: 0 | 1) => {});
	const stop = vi.fn(async (reason: string) => clean(reason));
	const options = {
		input: { terminal: terminal.promise, closed: closed.promise },
		lifecycle: { stop },
		clock,
		exit,
	};
	return { terminal, closed, exit, stop, options };
}

describe("sidecar shutdown fixed boundaries", () => {
	it("keeps the asynchronous grace at the required ten seconds", () => {
		expect(SIDECAR_SHUTDOWN_MS).toBe(10_000);
	});

	it("closes the real claim gate in the first terminal reaction", async () => {
		const f = fixture();
		const hub = createHubLifecycle({ clock });
		const cleanup = Promise.withResolvers<void>();
		await hub.unlock(async () => ({ close() {} }));
		hub.addStopStep(() => cleanup.promise);
		const done = bindSidecarShutdown({ ...f.options, lifecycle: hub });
		const observed = f.terminal.promise.then(() => {
			expect(hub.state).toBe("stopping");
			expect(() => hub.beginClaim()).toThrow("HUB_STOPPING");
		});
		f.terminal.resolve({ kind: "stop", reason: "eof" });
		try {
			await observed;
		} finally {
			cleanup.resolve();
			f.closed.resolve();
			await done;
		}
		expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("captures a changing terminal reason once without copying a later private value", async () => {
		const f = fixture();
		const values = ["eof", "fault", "DYTEST-PRIVATE-TERMINAL"];
		const reason = vi.fn(() => values.shift());
		const done = bindSidecarShutdown(f.options);
		f.terminal.resolve({
			kind: "stop",
			get reason() {
				return reason();
			},
		} as SidecarStop);
		f.closed.resolve();
		const report = await done;
		expect(reason).toHaveBeenCalledTimes(1);
		expect(f.stop).toHaveBeenCalledExactlyOnceWith("eof");
		expect(report).toEqual({ reason: "eof", outcome: "clean", exitCode: 0 });
		expect(JSON.stringify(report)).not.toContain("DYTEST-PRIVATE");
	});

	it("never validates a later graceful value from a changing fatal stop reason", async () => {
		const f = fixture();
		const reason = vi.fn().mockReturnValueOnce("fatal").mockReturnValue("shutdown");
		f.stop.mockResolvedValue({
			...clean("fatal"),
			get reason() {
				return reason();
			},
		});
		const done = bindSidecarShutdown(f.options);
		f.terminal.resolve({ kind: "stop", reason: "eof" });
		f.closed.resolve();
		expect(await done).toEqual({ reason: "eof", outcome: "failed", exitCode: 1 });
		expect(reason).toHaveBeenCalledTimes(1);
		expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it.each(["terminal", "closed"] as const)(
		"refuses an altered %s promise constructor without invoking it",
		(property) => {
			const f = fixture();
			const readConstructor = vi.fn(() => {
				throw new Error("DYTEST-PRIVATE-CONSTRUCTOR");
			});
			Object.defineProperty(f.options.input[property], "constructor", { get: readConstructor });
			expect(() => bindSidecarShutdown(f.options)).toThrow("SIDECAR_SHUTDOWN_OPTIONS");
			expect(readConstructor).not.toHaveBeenCalled();
			expect(f.stop).not.toHaveBeenCalled();
			expect(f.exit).not.toHaveBeenCalled();
		},
	);

	it("normalizes an EOF carrying an invalid fault code", async () => {
		const f = fixture();
		const done = bindSidecarShutdown(f.options);
		f.terminal.resolve({
			kind: "stop",
			reason: "eof",
			code: "DYTEST-PRIVATE-CODE",
		} as unknown as SidecarStop);
		f.closed.resolve();
		expect(await done).toEqual({ reason: "fault", outcome: "failed", exitCode: 1 });
		expect(f.stop).toHaveBeenCalledExactlyOnceWith("fault");
	});
});
