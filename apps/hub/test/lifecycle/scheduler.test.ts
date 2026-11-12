import { describe, expect, it, vi } from "vitest";
import { createLifecycleScheduler } from "../../src/lifecycle/scheduler.ts";
import {
	createHubLifecycle,
	type HubLifecycle,
	type HubLifecycleSession,
} from "../../src/lifecycle/state.ts";
import {
	SchedulerLoop,
	type SchedulerTick,
	type TickContext,
} from "../../src/outbox/scheduler-loop.ts";
import { SchedulerError } from "../../src/outbox/scheduler-ports.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";

const CANARY = "DYTEST-PRIVATE-SCHEDULER-REGISTRATION";
const concreteStop = SchedulerLoop.prototype.stop;

function fixture(work: SchedulerTick = () => 15_000) {
	const clock = new FakeClock();
	const lifecycle = createHubLifecycle({ clock });
	const ticks: TickContext[] = [];
	const errors: string[] = [];
	const tick: SchedulerTick = (context) => {
		ticks.push(context);
		return work(context);
	};
	const onError = (code: string): void => {
		errors.push(code);
	};
	const options = { lifecycle, clock, tick, onError };
	return { lifecycle, clock, tick, onError, options, ticks, errors };
}

function caught(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
}

function fixed(error: unknown, code: "SCHEDULER_CONFIG" | "SCHEDULER_STATE"): void {
	expect(error).toBeInstanceOf(SchedulerError);
	expect(error).toMatchObject({ name: "SchedulerError", code, message: code });
	expect((error as Error).cause).toBeUndefined();
	expect(JSON.stringify(error)).not.toContain(CANARY);
}

async function stop(loop: SchedulerLoop, lifecycle: HubLifecycle): Promise<void> {
	await Reflect.apply(concreteStop, loop, []);
	await lifecycle.stop("shutdown");
}

describe("lifecycle-owned scheduler", () => {
	it("stays paused while locked and opening, then needs an explicit wake after unlock", async () => {
		const h = fixture();
		const opened = Promise.withResolvers<HubLifecycleSession>();
		const session = { close: vi.fn() };
		const loop = createLifecycleScheduler(h.options);
		let unlocking: Promise<HubLifecycleSession> | undefined;
		try {
			await settle();
			expect(h.lifecycle.state).toBe("locked");
			expect(loop.status().state).toBe("paused");
			expect(h.ticks).toEqual([]);
			unlocking = h.lifecycle.unlock(() => opened.promise);
			void unlocking.catch(() => {});
			loop.wake();
			await settle();
			expect(h.lifecycle.state).toBe("opening");
			expect(loop.status().state).toBe("paused");
			expect(h.ticks).toEqual([]);
			opened.resolve(session);
			await unlocking;
			await settle();
			expect(h.ticks).toEqual([]);
			loop.wake();
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			expect(loop.status().state).toBe("running");
			expect(h.lifecycle.state).toBe("ready");
			h.lifecycle.beginClaim().release();
			expect(h.errors).toEqual([]);
		} finally {
			opened.resolve(session);
			await stop(loop, h.lifecycle);
			await unlocking?.catch(() => {});
		}
	});

	it("keeps maintenance closed and resumes only after release and an explicit wake", async () => {
		const h = fixture();
		await h.lifecycle.unlock(async () => ({ close() {} }));
		const loop = createLifecycleScheduler(h.options);
		try {
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			const lease = await h.lifecycle.enterMaintenance();
			loop.wake();
			await settle();
			expect(loop.status().state).toBe("paused");
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			expect(() => h.lifecycle.beginClaim()).toThrowError("HUB_MAINTENANCE");
			lease.release();
			await settle();
			expect(h.ticks).toHaveLength(1);
			loop.wake();
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start", "wake"]);
			expect(h.lifecycle.state).toBe("ready");
			h.lifecycle.beginClaim().release();
		} finally {
			await stop(loop, h.lifecycle);
		}
	});

	it("closes the tick gate immediately even while a newer stop step delays loop cleanup", async () => {
		const h = fixture();
		await h.lifecycle.unlock(async () => ({ close() {} }));
		const loop = createLifecycleScheduler(h.options);
		const blocking = Promise.withResolvers<void>();
		h.lifecycle.addStopStep(() => blocking.promise);
		try {
			await settle();
			const stopping = h.lifecycle.stop("shutdown");
			loop.wake();
			await settle();
			expect(h.lifecycle.state).toBe("stopping");
			expect(() => h.lifecycle.beginClaim()).toThrowError("HUB_STOPPING");
			expect(loop.status().state).toBe("paused");
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			blocking.resolve();
			await stopping;
			expect(loop.status().state).toBe("stopped");
		} finally {
			blocking.resolve();
			await stop(loop, h.lifecycle);
		}
	});

	it("drains permits, awaits the captured concrete tick stop, then closes the session and reports stopped", async () => {
		const order: string[] = [];
		const ticking = Promise.withResolvers<number>();
		const closing = Promise.withResolvers<void>();
		const h = fixture(async ({ signal }) => {
			order.push("tick-start");
			signal.addEventListener("abort", () => order.push("tick-aborted"), { once: true });
			try {
				return await ticking.promise;
			} finally {
				order.push("tick-settled");
			}
		});
		await h.lifecycle.unlock(async () => ({
			async close() {
				order.push("session-close");
				await closing.promise;
				order.push("session-closed");
			},
		}));
		h.lifecycle.addStopStep(() => {
			order.push("earlier-stop-step");
		});
		const loop = createLifecycleScheduler(h.options);
		const replacement = vi.fn(async () => {});
		Object.defineProperty(loop, "stop", { value: replacement });
		const permit = h.lifecycle.beginClaim();
		let reported = false;
		void h.lifecycle.stopped.then(() => {
			reported = true;
			order.push("stopped");
		});
		try {
			await settle();
			expect(order).toEqual(["tick-start"]);
			const stopping = h.lifecycle.stop("shutdown");
			expect(h.lifecycle.state).toBe("stopping");
			expect(() => h.lifecycle.beginClaim()).toThrowError("HUB_STOPPING");
			await settle();
			expect(h.ticks[0]?.signal.aborted).toBe(false);
			expect(reported).toBe(false);
			expect(order).toEqual(["tick-start"]);
			permit.release();
			order.push("permit-released");
			await settle();
			expect(h.ticks[0]?.signal.aborted).toBe(true);
			expect(order).toEqual(["tick-start", "permit-released", "tick-aborted"]);
			expect(replacement).not.toHaveBeenCalled();
			expect(reported).toBe(false);
			ticking.resolve(15_000);
			await settle();
			expect(order).toEqual([
				"tick-start",
				"permit-released",
				"tick-aborted",
				"tick-settled",
				"earlier-stop-step",
				"session-close",
			]);
			expect(reported).toBe(false);
			closing.resolve();
			expect(await stopping).toEqual({
				reason: "shutdown",
				drained: true,
				outstanding: 0,
				failures: 0,
			});
			expect(order.slice(-2)).toEqual(["session-closed", "stopped"]);
			expect(loop.status().state).toBe("stopped");
		} finally {
			permit.release();
			ticking.resolve(15_000);
			closing.resolve();
			await stop(loop, h.lifecycle);
		}
	});

	it("registers once for identical bindings and refuses every conflicting collaborator", async () => {
		const h = fixture();
		const register = vi.fn((step: () => void | Promise<void>) => h.lifecycle.addStopStep(step));
		const lifecycle: HubLifecycle = {
			...h.lifecycle,
			get state() {
				return h.lifecycle.state;
			},
			addStopStep: register,
		};
		const options = { ...h.options, lifecycle };
		const loop = createLifecycleScheduler(options);
		try {
			expect(createLifecycleScheduler({ ...options })).toBe(loop);
			expect(register).toHaveBeenCalledTimes(1);
			for (const conflict of [
				{ clock: new FakeClock() },
				{ tick: () => 15_000 },
				{ onError: () => {} },
			])
				fixed(
					caught(() => createLifecycleScheduler({ ...options, ...conflict })),
					"SCHEDULER_STATE",
				);
			expect(register).toHaveBeenCalledTimes(1);
			await h.lifecycle.unlock(async () => ({ close() {} }));
			loop.wake();
			await settle();
			expect(h.ticks).toHaveLength(1);
			await h.lifecycle.stop("shutdown");
			expect(createLifecycleScheduler(options)).toBe(loop);
			await settle();
			expect(loop.status().state).toBe("stopped");
			expect(h.ticks).toHaveLength(1);
			expect(register).toHaveBeenCalledTimes(1);
		} finally {
			await stop(loop, h.lifecycle);
		}
	});

	it("captures the lifecycle getter and registrar without running a getter before registration", async () => {
		const h = fixture();
		const order: string[] = [];
		const lifecycle: HubLifecycle = {
			...h.lifecycle,
			get state() {
				order.push("state");
				return h.lifecycle.state;
			},
			addStopStep(step) {
				expect(this).toBe(lifecycle);
				order.push("register");
				h.lifecycle.addStopStep(step);
			},
		};
		const loop = createLifecycleScheduler({ ...h.options, lifecycle });
		const replacedState = vi.fn(() => {
			throw new Error(CANARY);
		});
		const replacedRegistrar = vi.fn(() => {
			throw new Error(CANARY);
		});
		Object.defineProperty(lifecycle, "state", { get: replacedState });
		Object.defineProperty(lifecycle, "addStopStep", { value: replacedRegistrar });
		try {
			expect(order).toEqual(["register"]);
			await h.lifecycle.unlock(async () => ({ close() {} }));
			loop.wake();
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			expect(order[0]).toBe("register");
			expect(order.slice(1)).toContain("state");
			expect(order.slice(1).every((event) => event === "state")).toBe(true);
			expect(replacedState).not.toHaveBeenCalled();
			expect(replacedRegistrar).not.toHaveBeenCalled();
		} finally {
			await stop(loop, h.lifecycle);
		}
	});

	it("maps a throwing lifecycle getter to paused without exposing its private detail", async () => {
		const h = fixture();
		await h.lifecycle.unlock(async () => ({ close() {} }));
		let failing = true;
		const lifecycle: HubLifecycle = {
			...h.lifecycle,
			get state() {
				if (failing) throw new Error(CANARY);
				return h.lifecycle.state;
			},
		};
		const loop = createLifecycleScheduler({ ...h.options, lifecycle });
		try {
			await settle();
			expect(loop.status().state).toBe("paused");
			expect(h.ticks).toEqual([]);
			expect(h.errors).toEqual([]);
			failing = false;
			loop.wake();
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
		} finally {
			await stop(loop, h.lifecycle);
		}
	});

	it("starts no work after a throwing registration and permits a later valid retry", async () => {
		const h = fixture();
		let failing = true;
		const readState = vi.fn(() => h.lifecycle.state);
		const lifecycle: HubLifecycle = {
			...h.lifecycle,
			get state() {
				return readState();
			},
			addStopStep(step) {
				if (failing) throw new Error(CANARY);
				h.lifecycle.addStopStep(step);
			},
		};
		const options = { ...h.options, lifecycle };
		fixed(
			caught(() => createLifecycleScheduler(options)),
			"SCHEDULER_CONFIG",
		);
		await settle();
		expect(readState).not.toHaveBeenCalled();
		expect(h.ticks).toEqual([]);
		expect(h.clock.waits).toEqual([]);
		failing = false;
		const loop = createLifecycleScheduler(options);
		try {
			await h.lifecycle.unlock(async () => ({ close() {} }));
			loop.wake();
			await settle();
			expect(h.ticks).toHaveLength(1);
		} finally {
			await stop(loop, h.lifecycle);
		}
	});

	it("refuses a reentrant registration without creating a second loop", async () => {
		const h = fixture();
		let entered = false;
		let innerError: unknown;
		let registrations = 0;
		const lifecycle: HubLifecycle = {
			...h.lifecycle,
			get state() {
				return h.lifecycle.state;
			},
			addStopStep(step) {
				registrations++;
				if (!entered) {
					entered = true;
					innerError = caught(() => createLifecycleScheduler(options));
				}
				h.lifecycle.addStopStep(step);
			},
		};
		const options = { ...h.options, lifecycle };
		const loop = createLifecycleScheduler(options);
		try {
			fixed(innerError, "SCHEDULER_STATE");
			expect(registrations).toBe(1);
			await h.lifecycle.unlock(async () => ({ close() {} }));
			loop.wake();
			await settle();
			expect(h.ticks).toHaveLength(1);
		} finally {
			await stop(loop, h.lifecycle);
		}
	});

	it("refuses a declared asynchronous registrar before invoking it", async () => {
		const h = fixture();
		let registrations = 0;
		const lifecycle: HubLifecycle = {
			...h.lifecycle,
			get state() {
				return h.lifecycle.state;
			},
			async addStopStep(_step) {
				registrations++;
			},
		};
		fixed(
			caught(() => createLifecycleScheduler({ ...h.options, lifecycle })),
			"SCHEDULER_CONFIG",
		);
		await settle();
		expect(registrations).toBe(0);
		expect(h.ticks).toEqual([]);
		expect(h.clock.waits).toEqual([]);
		await h.lifecycle.stop("shutdown");
	});

	it.each(["number", "rejected promise", "thenable"] as const)(
		"starts no work for a synchronous registrar returning a %s",
		async (returned) => {
			const h = fixture();
			const then = vi.fn(() => {
				throw new Error(CANARY);
			});
			const thenable = {
				then,
			};
			const value =
				returned === "number"
					? 1
					: returned === "thenable"
						? thenable
						: Promise.reject(new Error(CANARY));
			if (returned === "rejected promise") {
				// biome-ignore lint/suspicious/noThenProperty: Refusal must observe rejection without consulting an own override.
				Object.defineProperty(value, "then", { get: then });
			}
			const lifecycle: HubLifecycle = {
				...h.lifecycle,
				get state() {
					return h.lifecycle.state;
				},
				addStopStep() {
					return value;
				},
			};
			fixed(
				caught(() => createLifecycleScheduler({ ...h.options, lifecycle })),
				"SCHEDULER_CONFIG",
			);
			await settle();
			expect(then).not.toHaveBeenCalled();
			expect(h.ticks).toEqual([]);
			expect(h.clock.waits).toEqual([]);
			await h.lifecycle.stop("shutdown");
		},
	);

	it("does not invoke accessor configuration or a replacement registrar getter", async () => {
		const h = fixture();
		const getter = vi.fn(() => {
			throw new Error(CANARY);
		});
		const options = Object.defineProperty({ ...h.options }, "tick", { get: getter });
		fixed(
			caught(() => createLifecycleScheduler(options)),
			"SCHEDULER_CONFIG",
		);
		const lifecycle = {
			...h.lifecycle,
			get state() {
				return h.lifecycle.state;
			},
		};
		Object.defineProperty(lifecycle, "addStopStep", { get: getter });
		fixed(
			caught(() => createLifecycleScheduler({ ...h.options, lifecycle })),
			"SCHEDULER_CONFIG",
		);
		await settle();
		expect(getter).not.toHaveBeenCalled();
		expect(h.ticks).toEqual([]);
		expect(h.clock.waits).toEqual([]);
		await h.lifecycle.stop("shutdown");
	});

	it("refuses an already stopped lifecycle without starting any scheduler work", async () => {
		const h = fixture();
		await h.lifecycle.stop("shutdown");
		fixed(
			caught(() => createLifecycleScheduler(h.options)),
			"SCHEDULER_CONFIG",
		);
		await settle();
		expect(h.lifecycle.state).toBe("stopped");
		expect(h.ticks).toEqual([]);
		expect(h.clock.waits).toEqual([]);
	});
});
