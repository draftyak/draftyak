import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PluginCallKind,
	type PluginCallWatch,
	PluginCallWatchdogError,
	watchPluginCall,
} from "../../src/plugins/supervisor/call-watchdog.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
interface Fixture {
	readonly controller: AbortController;
	readonly terminal: ReturnType<typeof deferred<unknown>>;
	readonly stopped: ReturnType<typeof deferred<void>>;
	readonly state: { calls: number; callback: () => Promise<unknown> };
	readonly watch: PluginCallWatch<unknown>;
}
const fixtures = new Set<Fixture>();
function fixture(kind: PluginCallKind = "lookup", controller = new AbortController()): Fixture {
	const terminal = deferred<unknown>();
	const stopped = deferred<void>();
	const state = { calls: 0, callback: (): Promise<unknown> => stopped.promise };
	const watch = watchPluginCall(controller, terminal.promise, kind, () => {
		state.calls++;
		return state.callback();
	});
	const result = { controller, terminal, stopped, state, watch };
	fixtures.add(result);
	return result;
}
const tick = (milliseconds: number) => vi.advanceTimersByTimeAsync(milliseconds);
function fixed(error: unknown): void {
	expect(error).toBeInstanceOf(PluginCallWatchdogError);
	if (!(error instanceof PluginCallWatchdogError)) throw new Error("Expected watchdog failure");
	expect(error.code).toBe("PLUGIN_CALL_WATCHDOG_FAILED");
	expect(error.message).toBe("Plugin call watchdog failed");
	expect("cause" in error).toBe(false);
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => {
	try {
		for (const f of fixtures) f.watch.close();
		for (const f of fixtures) {
			f.terminal.resolve(undefined);
			f.stopped.resolve(undefined);
		}
		await Promise.allSettled(
			[...fixtures].flatMap((f) => [f.terminal.promise, f.stopped.promise, f.watch.drained]),
		);
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		fixtures.clear();
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

describe("original plugin call lifetime", () => {
	for (const [kind, milliseconds] of [
		["call", 30_000],
		["sync", 120_000],
		["lookup", 5_000],
		["calendar.freebusy", 15_000],
	] as const) {
		it("soft-cancels " + kind + " at its actual fixed call deadline", async () => {
			const f = fixture(kind);
			await tick(milliseconds - 1);
			expect(f.controller.signal.aborted).toBe(false);
			await tick(1);
			expect(f.controller.signal.aborted).toBe(true);
			expect(f.state.calls).toBe(0);
			f.terminal.resolve("DYTEST answered");
			await f.watch.drained;
			await tick(5_000);
			expect(f.state.calls).toBe(0);
		});
	}

	it("preserves the exact terminal and clears timers before releasing its separate drain", async () => {
		const f = fixture();
		expect(f.watch.terminal).toBe(f.terminal.promise);
		expect(Object.isFrozen(f.watch)).toBe(true);
		let timersOnRelease = -1;
		const release = f.watch.drained.then(() => {
			timersOnRelease = vi.getTimerCount();
		});
		f.terminal.resolve("DYTEST-value");
		expect(await f.watch.terminal).toBe("DYTEST-value");
		await release;
		expect(timersOnRelease).toBe(0);
		expect(f.controller.signal.aborted).toBe(false);
		await tick(120_000);
		expect(f.state.calls).toBe(0);
	});

	it("treats a rejected original terminal during grace as an answer without replacing its rejection", async () => {
		const f = fixture();
		await tick(5_000);
		const reason = new Error("DYTEST original terminal rejection");
		const originalRejection = expect(f.watch.terminal).rejects.toBe(reason);
		f.terminal.reject(reason);
		await originalRejection;
		await f.watch.drained;
		await tick(5_000);
		expect(f.state.calls).toBe(0);
	});

	it("does not shut down a call that fulfills at the last grace neighbor", async () => {
		const f = fixture();
		await tick(9_999);
		expect(f.controller.signal.aborted).toBe(true);
		expect(f.state.calls).toBe(0);
		f.terminal.resolve(undefined);
		await f.watch.drained;
		await tick(1);
		expect(f.state.calls).toBe(0);
	});

	it("starts shutdown once at grace expiry and still joins a held original terminal", async () => {
		const f = fixture();
		let drained = false;
		void f.watch.drained.then(() => {
			drained = true;
		});
		await tick(9_999);
		expect(f.state.calls).toBe(0);
		await tick(1);
		expect(f.state.calls).toBe(1);
		f.stopped.resolve(undefined);
		await tick(0);
		expect(drained).toBe(false);
		await tick(30_000);
		expect(f.state.calls).toBe(1);
		f.terminal.resolve(undefined);
		await f.watch.drained;
		expect(drained).toBe(true);
	});

	it("joins a started shutdown even when the original terminal has already answered", async () => {
		const f = fixture();
		let drained = false;
		void f.watch.drained.then(() => {
			drained = true;
		});
		await tick(10_000);
		f.terminal.resolve(undefined);
		await tick(0);
		expect(drained).toBe(false);
		f.stopped.resolve(undefined);
		await f.watch.drained;
		expect(drained).toBe(true);
	});

	for (const prior of [false, true]) {
		it(
			"uses one immediate grace for an " +
				(prior ? "already aborted" : "externally aborted") +
				" original controller",
			async () => {
				const controller = new AbortController();
				if (prior) controller.abort();
				const f = fixture("sync", controller);
				if (!prior) controller.abort();
				await tick(4_999);
				expect(f.state.calls).toBe(0);
				await tick(1);
				expect(f.state.calls).toBe(1);
				f.terminal.resolve(undefined);
				f.stopped.resolve(undefined);
				await f.watch.drained;
			},
		);
	}

	it("survives synchronous close and answer reentry from the original abort listener", async () => {
		const f = fixture();
		let returned: Promise<void> | undefined;
		f.controller.signal.addEventListener("abort", () => {
			returned = f.watch.close();
			f.terminal.resolve(undefined);
		});
		await tick(5_000);
		expect(returned).toBe(f.watch.drained);
		await f.watch.drained;
		await tick(5_000);
		expect(f.state.calls).toBe(0);
	});

	it("clears reserved grace when an abort listener synchronously answers", async () => {
		const f = fixture();
		f.controller.signal.addEventListener("abort", () => {
			f.terminal.resolve(undefined);
		});
		await tick(5_000);
		await f.watch.drained;
		await tick(5_000);
		expect(f.state.calls).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reserves started shutdown before synchronous close reentry", async () => {
		const f = fixture();
		let returned: Promise<void> | undefined;
		f.state.callback = () => {
			returned = f.watch.close();
			return f.stopped.promise;
		};
		await tick(10_000);
		expect(f.state.calls).toBe(1);
		expect(returned).toBe(f.watch.drained);
		let done = false;
		void f.watch.drained.then(() => {
			done = true;
		});
		f.terminal.resolve(undefined);
		await tick(0);
		expect(done).toBe(false);
		f.stopped.resolve(undefined);
		await f.watch.drained;
	});

	it("fences timers on close but does not release a held original terminal", async () => {
		const f = fixture();
		const closing = f.watch.close();
		expect(f.watch.close()).toBe(closing);
		expect(closing).toBe(f.watch.drained);
		let done = false;
		void closing.then(() => {
			done = true;
		});
		await tick(120_000);
		expect(f.controller.signal.aborted).toBe(false);
		expect(f.state.calls).toBe(0);
		expect(done).toBe(false);
		f.terminal.resolve(undefined);
		await closing;
		expect(done).toBe(true);
	});

	for (const failure of ["throw", "rejection"] as const) {
		it(
			"contains shutdown " + failure + " while retaining the actual original terminal",
			async () => {
				const f = fixture();
				let released = false;
				void f.watch.drained.then(
					() => {
						released = true;
					},
					() => {
						released = true;
					},
				);
				if (failure === "throw")
					f.state.callback = () => {
						throw new Error("DYTEST shutdown failure");
					};
				await tick(10_000);
				if (failure === "rejection") f.stopped.reject(new Error("DYTEST shutdown rejection"));
				await tick(0);
				expect(released).toBe(false);
				f.terminal.resolve(undefined);
				// The module's own observer must contain rejection even before a caller awaits drain.
				await tick(0);
				const result = await Promise.allSettled([f.watch.drained]);
				expect(result[0]?.status).toBe("rejected");
				if (result[0]?.status !== "rejected") throw new Error("Expected sticky drain failure");
				fixed(result[0].reason);
				expect(f.watch.close()).toBe(f.watch.drained);
			},
		);
	}

	it("rechecks its original monotonic deadline when a timer wakes early", async () => {
		const f = fixture("call");
		const early = vi.spyOn(performance, "now").mockReturnValue(0);
		await tick(30_000);
		expect(f.controller.signal.aborted).toBe(false);
		early.mockRestore();
		await tick(30_000);
		expect(f.controller.signal.aborted).toBe(true);
		f.terminal.resolve(undefined);
		await f.watch.drained;
	});

	it("rejects invalid kinds and simple input types without dispatching callbacks or arming timers", () => {
		const controller = new AbortController();
		const terminal = deferred<unknown>();
		let callbacks = 0;
		controller.signal.addEventListener("abort", () => {
			callbacks++;
		});
		const shutdown = () => {
			callbacks++;
			return Promise.resolve();
		};
		for (const kind of ["constructor", "__proto__", "DYTEST", null, {}]) {
			let error: unknown;
			try {
				watchPluginCall(controller, terminal.promise, kind as PluginCallKind, shutdown);
			} catch (caught) {
				error = caught;
			}
			fixed(error);
		}
		for (const args of [
			[{}, terminal.promise, "call", shutdown],
			[controller, {}, "call", shutdown],
			[controller, terminal.promise, "call", 7],
		] as const) {
			let error: unknown;
			try {
				watchPluginCall(...(args as unknown as Parameters<typeof watchPluginCall>));
			} catch (caught) {
				error = caught;
			}
			fixed(error);
		}
		expect(callbacks).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		terminal.resolve(undefined);
	});
});
