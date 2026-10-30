import { describe, expect, it, vi } from "vitest";
import { MAX_WAIT_MS, type TimerClock } from "../../src/kernel/clock.ts";
import { SchedulerLoop, type TickContext } from "../../src/outbox/scheduler-loop.ts";
import { SchedulerError } from "../../src/outbox/scheduler-ports.ts";
import { type PlanRow, planTick } from "../../src/outbox/scheduler-rules.ts";
import { ACCOUNT_A, FakeClock, FakeGate, noHolds, settle, ulidFor } from "./scheduler-fixture.ts";

const DAY = 86_400_000;

interface Harness {
	readonly clock: FakeClock;
	readonly gate: FakeGate;
	readonly loop: SchedulerLoop;
	readonly ticks: TickContext[];
	readonly errors: string[];
}

function harness(
	tick: (context: TickContext) => unknown = () => MAX_WAIT_MS,
	clock: TimerClock = new FakeClock(),
	gate: FakeGate = new FakeGate(),
): Harness & { readonly clock: FakeClock } {
	const ticks: TickContext[] = [];
	const errors: string[] = [];
	const loop = new SchedulerLoop({
		clock,
		gate,
		tick: (context) => {
			ticks.push(context);
			return tick(context) as number;
		},
		onError: (code) => errors.push(code),
	});
	return { clock: clock as FakeClock, gate, loop, ticks, errors };
}

const reasons = (h: Harness): string[] => h.ticks.map((context) => context.reason);
const waits = (h: Harness): number[] => h.clock.waits.map((wait) => wait.ms);

// Lets the loop run until it arms its next wait, without leaving the current macrotask.
async function untilWait(clock: FakeClock, armed: number): Promise<void> {
	for (let turn = 0; turn < 200 && clock.waits.length === armed; turn++) await Promise.resolve();
}

class FlakyClock extends FakeClock {
	failing = false;

	override wallMs(): number {
		if (this.failing) throw new Error("Synthetic clock failure");
		return super.wallMs();
	}
}

export function schedulerLoopCases(): void {
	describe("scheduler loop", () => {
		it("runs one start tick on validated readings, then waits the tick's result", async () => {
			const h = harness(() => 7_000);
			expect(h.loop.status()).toEqual({
				state: "new",
				schedulingAvailable: true,
				lastTickWall: null,
			});
			h.loop.start();
			expect(h.ticks).toEqual([]);
			await settle();
			expect(reasons(h)).toEqual(["start"]);
			const [first] = h.ticks;
			expect(first?.now).toEqual({ wall: h.clock.wall, mono: h.clock.mono });
			expect(Object.isFrozen(first) && Object.isFrozen(first?.now)).toBe(true);
			expect(first?.signal.aborted).toBe(false);
			expect(waits(h)).toEqual([7_000]);
			expect(h.gate.reads).toBe(1);
			expect(h.loop.status()).toEqual({
				state: "running",
				schedulingAvailable: true,
				lastTickWall: h.clock.wall,
			});
			h.clock.advance(6_999);
			await settle();
			expect(reasons(h)).toEqual(["start"]);
			h.clock.advance(1);
			await settle();
			expect(reasons(h)).toEqual(["start", "timer"]);
			expect(h.ticks[1]?.now).toEqual({ wall: h.clock.wall, mono: h.clock.mono });
			expect(h.gate.reads).toBe(2);
			await h.loop.stop();
			expect(h.errors).toEqual([]);
			// stop() aborts only a tick in flight, never a finished one.
			expect(h.ticks.map((context) => context.signal.aborted)).toEqual([false, false]);
		});

		it("refuses a second start and a start after stop with SCHEDULER_STATE", async () => {
			const h = harness();
			h.loop.start();
			expect(() => h.loop.start()).toThrowError(
				expect.objectContaining({ name: "SchedulerError", code: "SCHEDULER_STATE" }),
			);
			await h.loop.stop();
			expect(() => h.loop.start()).toThrow(SchedulerError);
			const never = harness();
			never.loop.wake();
			never.loop.resumed();
			await never.loop.stop();
			expect(() => never.loop.start()).toThrowError(
				expect.objectContaining({ code: "SCHEDULER_STATE" }),
			);
			await settle();
			expect(never.ticks).toEqual([]);
			expect(never.clock.waits).toEqual([]);
		});

		it("lets resumed() and wake() end a pending 15 s wait with one immediate tick each", async () => {
			const h = harness();
			h.loop.start();
			await settle();
			const first = h.clock.last();
			expect(first).toMatchObject({ ms: 15_000, state: "pending" });
			h.loop.resumed();
			await settle();
			expect(first.state).toBe("aborted");
			expect(reasons(h)).toEqual(["start", "resumed"]);
			const second = h.clock.last();
			h.loop.wake();
			await settle();
			expect(second.state).toBe("aborted");
			expect(reasons(h)).toEqual(["start", "resumed", "wake"]);
			expect(waits(h)).toEqual([15_000, 15_000, 15_000]);
			await h.loop.stop();
			expect(h.clock.last().state).toBe("aborted");
		});

		it("runs one tick at a time and queues exactly one re-tick for wakes during a tick", async () => {
			let release: (wait: number) => void = () => undefined;
			const h = harness(
				() =>
					new Promise<number>((resolve) => {
						release = resolve;
					}),
			);
			h.loop.start();
			await settle();
			h.loop.wake();
			h.loop.wake();
			h.loop.resumed();
			h.loop.wake();
			await settle();
			expect(reasons(h)).toEqual(["start"]);
			expect(h.clock.waits).toEqual([]);
			release(15_000);
			await settle();
			expect(waits(h)).toEqual([0]);
			expect(reasons(h)).toEqual(["start"]);
			h.clock.advance(0);
			await settle();
			expect(reasons(h)).toEqual(["start", "resumed"]);
			release(15_000);
			await settle();
			expect(waits(h)).toEqual([0, 15_000]);
			expect(reasons(h)).toHaveLength(2);
			await h.loop.stop();
		});

		it("marks the next tick divergence only past 5,000 ms between wall and monotonic elapsed", async () => {
			const h = harness();
			h.loop.start();
			await settle();
			const step = async (wall: number, mono: number, end: () => void = () => h.clock.elapse()) => {
				h.clock.wall += wall;
				h.clock.mono += mono;
				end();
				await settle();
			};
			await step(20_000, 15_000);
			await step(20_001, 15_000);
			await step(10_000, 15_000);
			await step(9_999, 15_000);
			// Linux suspend: the monotonic clock paused while the wall clock ran on.
			await step(2 * 3_600_000, 15_000);
			// macOS and Windows: both clocks ran through the sleep.
			await step(2 * 3_600_000, 2 * 3_600_000);
			await step(60_000, 0, () => h.loop.wake());
			await step(60_000, 0, () => h.loop.resumed());
			expect(reasons(h)).toEqual([
				"start",
				"timer",
				"divergence",
				"timer",
				"divergence",
				"divergence",
				"timer",
				"divergence",
				"resumed",
			]);
			await h.loop.stop();
			expect(h.errors).toEqual([]);
		});

		it("skips the tick on invalid readings and reports SCHEDULER_DATA once per episode", async () => {
			const clock = new FlakyClock();
			const h = harness(undefined, clock);
			h.loop.start();
			await settle();
			const good = { wall: clock.wall, mono: clock.mono };
			const bad: (() => void)[] = [
				() => {
					clock.wall = -1;
				},
				() => {
					clock.wall = good.wall + 0.5;
				},
				() => {
					clock.wall = Number.NaN;
				},
				() => {
					clock.wall = Number.POSITIVE_INFINITY;
				},
				() => {
					clock.wall = String(good.wall) as unknown as number;
				},
				() => {
					clock.mono = Number.NaN;
				},
				() => {
					clock.mono = Number.POSITIVE_INFINITY;
				},
				() => {
					clock.failing = true;
				},
			];
			for (const [index, spoil] of bad.entries()) {
				clock.wall = good.wall;
				clock.mono = good.mono;
				spoil();
				h.loop.wake();
				await settle();
				expect(h.ticks, `case ${index}`).toHaveLength(index + 1);
				expect(clock.last()).toMatchObject({ ms: 15_000, state: "pending" });
				h.loop.wake();
				await settle();
				expect(h.errors).toEqual(bad.slice(0, index + 1).map(() => "SCHEDULER_DATA"));
				clock.failing = false;
				good.wall += 30_000;
				good.mono += 30_000;
				clock.wall = good.wall;
				clock.mono = good.mono;
				h.loop.wake();
				await settle();
				expect(h.ticks).toHaveLength(index + 2);
				expect(h.ticks.at(-1)?.reason).toBe("wake");
			}
			await h.loop.stop();
		});

		it("replaces a tick result outside 0..15,000 with 15,000 and reports it once per episode", async () => {
			const results: unknown[] = [
				-1,
				15_001,
				0.5,
				Number.NaN,
				"0",
				undefined,
				2 ** 31,
				7,
				15_001,
				0,
			];
			let index = 0;
			const h = harness(() => results[index++]);
			h.loop.start();
			await settle();
			while (index < results.length) {
				h.clock.advance(h.clock.last().ms);
				await settle();
			}
			expect(waits(h)).toEqual([
				15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 7, 15_000, 0,
			]);
			expect(h.errors).toEqual(["SCHEDULER_DATA", "SCHEDULER_DATA"]);
			await h.loop.stop();
		});

		it("reports a throwing tick once per episode as SCHEDULER_STORE and waits 15 s", async () => {
			const outcomes = ["throw", "reject", "ok", "reject"];
			let index = 0;
			const h = harness(() => {
				const outcome = outcomes[index++];
				if (outcome === "throw") throw new Error("Synthetic store failure");
				if (outcome === "reject") return Promise.reject(new Error("Synthetic store failure"));
				return 3_000;
			});
			h.loop.start();
			await settle();
			while (index < outcomes.length) {
				h.clock.advance(h.clock.last().ms);
				await settle();
			}
			expect(waits(h)).toEqual([15_000, 15_000, 3_000, 15_000]);
			expect(h.errors).toEqual(["SCHEDULER_STORE", "SCHEDULER_STORE"]);
			await h.loop.stop();
		});

		for (const reason of ["start", "resumed"] as const) {
			it(`retries a failed ${reason} tick with its reason only after each bounded retry wait`, async () => {
				let failures = 2;
				const h = harness((context) => {
					if (context.reason === reason && failures-- > 0)
						throw new Error("Synthetic store failure");
					return MAX_WAIT_MS;
				});
				try {
					h.loop.start();
					await settle();
					if (reason === "resumed") {
						h.loop.resumed();
						await settle();
					}
					for (let retry = 0; retry < 2; retry++) {
						const before = h.ticks.length;
						expect(h.ticks.at(-1)?.reason).toBe(reason);
						expect(h.clock.last()).toMatchObject({ ms: MAX_WAIT_MS, state: "pending" });
						await settle();
						expect(h.ticks).toHaveLength(before);
						h.clock.advance(MAX_WAIT_MS - 1);
						await settle();
						expect(h.ticks).toHaveLength(before);
						h.clock.advance(1);
						await settle();
						expect(h.ticks).toHaveLength(before + 1);
					}
					expect(h.ticks.at(-1)?.reason).toBe(reason);
					expect(h.errors).toEqual(["SCHEDULER_STORE"]);
					h.clock.advance(MAX_WAIT_MS);
					await settle();
					expect(h.ticks.at(-1)?.reason).toBe("timer");
					expect(waits(h).every((ms) => ms === MAX_WAIT_MS)).toBe(true);
				} finally {
					await h.loop.stop();
				}
			});
		}

		it("keeps a failed start reason stronger than a resume arriving during its retry wait", async () => {
			let fail = true;
			const h = harness(() => {
				if (fail) {
					fail = false;
					throw new Error("Synthetic store failure");
				}
				return MAX_WAIT_MS;
			});
			try {
				h.loop.start();
				await settle();
				h.loop.resumed();
				await settle();
				expect(reasons(h)).toEqual(["start", "start"]);
				h.clock.advance(MAX_WAIT_MS);
				await settle();
				expect(reasons(h)).toEqual(["start", "start", "timer"]);
				expect(h.errors).toEqual(["SCHEDULER_STORE"]);
			} finally {
				await h.loop.stop();
			}
		});

		for (const nudge of ["wake", "resumed"] as const) {
			it(`lets a ${nudge} arriving during its retry wait win over a failed timer tick`, async () => {
				let fail = false;
				const h = harness(() => {
					if (fail) {
						fail = false;
						throw new Error("Synthetic store failure");
					}
					return MAX_WAIT_MS;
				});
				try {
					h.loop.start();
					await settle();
					fail = true;
					h.clock.advance(MAX_WAIT_MS);
					await settle();
					expect(reasons(h)).toEqual(["start", "timer"]);
					const retry = h.clock.last();
					expect(retry).toMatchObject({ ms: MAX_WAIT_MS, state: "pending" });
					h.loop[nudge]();
					await settle();
					expect(retry.state).toBe("aborted");
					expect(reasons(h)).toEqual(["start", "timer", nudge]);
					expect(h.errors).toEqual(["SCHEDULER_STORE"]);
				} finally {
					await h.loop.stop();
				}
			});
		}

		it("refuses a backward reading once and re-baselines after one finite far-ahead reading", async () => {
			const h = harness();
			try {
				h.loop.start();
				await settle();
				const initial = h.clock.mono;
				h.clock.mono = 1e15;
				h.clock.wall += MAX_WAIT_MS;
				h.clock.elapse();
				await settle();
				expect(reasons(h)).toEqual(["start", "divergence"]);
				h.clock.mono = initial + 2 * MAX_WAIT_MS;
				h.clock.wall += MAX_WAIT_MS;
				h.clock.elapse();
				await settle();
				expect(h.ticks).toHaveLength(2);
				expect(h.errors).toEqual(["SCHEDULER_DATA"]);
				h.clock.advance(MAX_WAIT_MS - 1);
				await settle();
				expect(h.ticks).toHaveLength(2);
				h.clock.advance(1);
				await settle();
				expect(reasons(h)).toEqual(["start", "divergence", "timer"]);
				h.clock.advance(MAX_WAIT_MS);
				await settle();
				expect(reasons(h)).toEqual(["start", "divergence", "timer", "timer"]);
				expect(h.errors).toEqual(["SCHEDULER_DATA"]);
			} finally {
				await h.loop.stop();
			}
		});

		for (const [wait, elapsed] of [
			[15_000, 0],
			[10, 8.999],
			[1, 0],
		] as const) {
			it(`parks after repeated early waits (${elapsed} ms of ${wait} ms), without starving other work`, async () => {
				const fake = new FakeClock();
				let calls = 0;
				const clock: TimerClock = {
					wallMs: () => fake.wall,
					monotonicMs: () => fake.mono,
					after: (ms, signal) => {
						calls++;
						// Bound the faulty fixture even if the early-wake guard is removed.
						if (calls > 12) return fake.after(ms, signal);
						fake.wall += Math.ceil(elapsed);
						fake.mono += elapsed;
						return Promise.resolve();
					},
				};
				const h = harness(() => wait, clock);
				try {
					h.loop.start();
					await settle();
					expect([h.ticks.length, calls, h.errors]).toEqual([3, 3, ["SCHEDULER_DATA"]]);
					await settle();
					expect([h.ticks.length, calls]).toEqual([3, 3]);
					h.loop.resumed();
					await settle();
					expect(h.ticks.at(-1)?.reason).toBe("resumed");
					expect([h.ticks.length, calls, h.errors]).toEqual([4, 4, ["SCHEDULER_DATA"]]);
				} finally {
					await h.loop.stop();
				}
			});
		}

		for (const fault of ["string", "throw"] as const) {
			it(`parks safely when monotonic wait readings ${fault === "string" ? "are not numbers" : "throw"}`, async () => {
				const fake = new FakeClock();
				let readings = 0;
				let calls = 0;
				const clock: TimerClock = {
					wallMs: () => fake.wall,
					monotonicMs: () => {
						if (++readings % 3 === 0) {
							if (fault === "throw") throw new Error("Synthetic clock failure");
							return String(fake.mono) as unknown as number;
						}
						return fake.mono;
					},
					after: (ms, signal) => {
						if (++calls > 12) return fake.after(ms, signal);
						fake.advance(ms);
						return Promise.resolve();
					},
				};
				const h = harness(undefined, clock);
				try {
					h.loop.start();
					await settle();
					expect([h.ticks.length, calls, h.errors]).toEqual([3, 3, ["SCHEDULER_DATA"]]);
				} finally {
					await h.loop.stop();
				}
			});
		}

		it("allows a wait to complete exactly one millisecond early", async () => {
			const fake = new FakeClock();
			let calls = 0;
			const clock: TimerClock = {
				wallMs: () => fake.wall,
				monotonicMs: () => fake.mono,
				after: (ms, signal) => {
					if (++calls > 3) return fake.after(ms, signal);
					fake.advance(ms - 1);
					return Promise.resolve();
				},
			};
			const h = harness(() => 10, clock);
			try {
				h.loop.start();
				await settle();
				expect([reasons(h), calls, h.errors]).toEqual([
					["start", "timer", "timer", "timer"],
					4,
					[],
				]);
			} finally {
				await h.loop.stop();
			}
		});

		it("keeps explicitly elapsed zero waits legal without counting them as early", async () => {
			const h = harness(() => 0);
			try {
				h.loop.start();
				await settle();
				for (let elapsed = 0; elapsed < 4; elapsed++) {
					h.clock.advance(0);
					await settle();
				}
				expect([h.ticks.length, waits(h), h.errors]).toEqual([5, [0, 0, 0, 0, 0], []]);
			} finally {
				await h.loop.stop();
			}
		});

		it("resets consecutive early wakes only after a fully elapsed wait, and can recover from parking", async () => {
			const h = harness();
			try {
				h.loop.start();
				await settle();
				for (let phase = 0; phase < 2; phase++) {
					h.clock.elapse();
					await settle();
					h.clock.elapse();
					await settle();
					expect(h.errors).toEqual([]);
					h.clock.advance(MAX_WAIT_MS);
					await settle();
				}
				h.clock.elapse();
				await settle();
				h.clock.elapse();
				await settle();
				const ticks = h.ticks.length;
				h.clock.elapse();
				await settle();
				expect(h.ticks).toHaveLength(ticks);
				expect(h.errors).toEqual(["SCHEDULER_DATA"]);
				h.loop.wake();
				await settle();
				expect(h.ticks).toHaveLength(ticks + 1);
				h.clock.advance(MAX_WAIT_MS);
				await settle();
				expect(h.errors).toEqual(["SCHEDULER_DATA"]);
				for (let early = 0; early < 3; early++) {
					h.clock.elapse();
					await settle();
				}
				expect(h.errors).toEqual(["SCHEDULER_DATA", "SCHEDULER_DATA"]);
			} finally {
				await h.loop.stop();
			}
		});

		it("reads the gate at every tick start and never ticks while it is paused", async () => {
			const gate = new FakeGate();
			gate.value = "paused";
			const h = harness(undefined, new FakeClock(), gate);
			h.loop.start();
			await settle();
			expect(h.ticks).toEqual([]);
			expect(h.loop.status().state).toBe("paused");
			expect(gate.reads).toBe(1);
			expect(h.clock.last()).toMatchObject({ ms: 15_000, state: "pending" });
			h.clock.advance(15_000);
			await settle();
			expect([h.ticks.length, gate.reads]).toEqual([0, 2]);
			gate.value = "running";
			h.loop.wake();
			await settle();
			// The first tick that runs is still the start tick.
			expect(reasons(h)).toEqual(["start"]);
			expect([h.loop.status().state, gate.reads]).toEqual(["running", 3]);
			gate.value = "paused";
			h.clock.advance(15_000);
			await settle();
			expect([reasons(h), h.loop.status().state]).toEqual([["start"], "paused"]);
			h.loop.resumed();
			await settle();
			expect(reasons(h)).toEqual(["start"]);
			gate.value = "running";
			h.clock.advance(15_000);
			await settle();
			expect(reasons(h)).toEqual(["start", "resumed"]);
			expect(gate.reads).toBe(6);
			await h.loop.stop();
			expect(h.errors).toEqual([]);
		});

		it("treats a gate that throws or answers anything but running as paused", async () => {
			for (const state of [
				() => {
					throw new Error("Synthetic gate failure");
				},
				() => "RUNNING",
				() => true,
				() => undefined,
			]) {
				const h = harness(undefined, new FakeClock(), { state } as unknown as FakeGate);
				h.loop.start();
				await settle();
				expect(h.ticks).toEqual([]);
				expect(h.loop.status().state).toBe("paused");
				await h.loop.stop();
			}
		});

		it("aborts the tick signal on stop and resolves only after the tick settles", async () => {
			let release: () => void = () => undefined;
			const h = harness(
				() =>
					new Promise<number>((resolve) => {
						release = () => resolve(15_000);
					}),
			);
			h.loop.start();
			await settle();
			const [context] = h.ticks;
			let stopped = false;
			const stopping = h.loop.stop().then(() => {
				stopped = true;
			});
			expect(context?.signal.aborted).toBe(true);
			expect(h.loop.status().state).toBe("stopped");
			await settle();
			expect(stopped).toBe(false);
			release();
			await stopping;
			expect(h.clock.waits).toEqual([]);
			h.loop.wake();
			h.loop.resumed();
			await settle();
			expect(h.ticks).toHaveLength(1);
			await expect(h.loop.stop()).resolves.toBeUndefined();
		});

		it("ends a pending wait on stop, idempotently, and starts no tick afterwards", async () => {
			const h = harness();
			h.loop.start();
			await settle();
			const pending = h.clock.last();
			await Promise.all([h.loop.stop(), h.loop.stop()]);
			expect(pending.state).toBe("aborted");
			h.clock.advance(60_000);
			h.loop.wake();
			await settle();
			expect(h.ticks).toHaveLength(1);
			expect(h.clock.waits).toHaveLength(1);
			const disposed = harness();
			disposed.loop.start();
			await settle();
			await disposed.loop[Symbol.asyncDispose]();
			expect(disposed.loop.status().state).toBe("stopped");
		});

		it("reports new, running, paused, running and stopped, with scheduling availability", async () => {
			const gate = new FakeGate();
			const h = harness(undefined, new FakeClock(), gate);
			const states = [h.loop.status().state];
			h.loop.start();
			await settle();
			states.push(h.loop.status().state);
			gate.value = "paused";
			h.loop.wake();
			await settle();
			states.push(h.loop.status().state);
			gate.value = "running";
			h.loop.wake();
			await settle();
			states.push(h.loop.status().state);
			vi.stubGlobal("Temporal", undefined);
			try {
				expect(h.loop.status().schedulingAvailable).toBe(false);
			} finally {
				vi.unstubAllGlobals();
			}
			await h.loop.stop();
			states.push(h.loop.status().state);
			expect(states).toEqual(["new", "running", "paused", "running", "stopped"]);
			expect(Object.isFrozen(h.loop.status())).toBe(true);
		});

		it("parks on a clock that cannot wait until woken, reporting SCHEDULER_DATA once", async () => {
			for (const after of [
				() => Promise.reject(new Error("Synthetic clock failure")),
				() => undefined,
				// A thenable that is not a promise is refused, even one that never settles.
				() => ({
					// biome-ignore lint/suspicious/noThenProperty: deliberate non-promise thenable fixture.
					then: () => new Promise<void>(() => undefined),
				}),
				() => {
					throw new Error("Synthetic clock failure");
				},
			]) {
				const fake = new FakeClock();
				const clock = {
					wallMs: () => fake.wall,
					monotonicMs: () => fake.mono,
					after,
				} as unknown as TimerClock;
				const h = harness(undefined, clock);
				h.loop.start();
				await settle(10);
				expect(h.ticks).toHaveLength(1);
				expect(h.errors).toEqual(["SCHEDULER_DATA"]);
				h.loop.wake();
				await settle(10);
				expect(h.ticks).toHaveLength(2);
				expect(h.errors).toEqual(["SCHEDULER_DATA"]);
				await h.loop.stop();
			}
		});

		it("refuses options that are not inert data without running getters or traps", () => {
			let hooks = 0;
			const hook = (): never => {
				hooks++;
				throw new Error("Synthetic hook ran");
			};
			const clock = new FakeClock();
			const gate = new FakeGate();
			const tick = () => 0;
			const good = { clock, gate, tick };
			const refused: unknown[] = [
				null,
				undefined,
				[clock, gate, tick],
				{ ...good, extra: 1 },
				{ clock, gate },
				{ ...good, tick: "tick" },
				{ ...good, tick: new Proxy(tick, {}) },
				{ ...good, onError: 1 },
				{ ...good, clock: undefined },
				{ ...good, clock: { wallMs: () => 0, monotonicMs: () => 0 } },
				{
					...good,
					clock: Object.defineProperty({ wallMs: () => 0, monotonicMs: () => 0 }, "after", {
						get: hook,
					}),
				},
				{ ...good, clock: new Proxy(clock, { get: hook, getOwnPropertyDescriptor: hook }) },
				{
					...good,
					clock: Object.create(new Proxy({}, { get: hook, getOwnPropertyDescriptor: hook })),
				},
				{ ...good, gate: {} },
				{ ...good, gate: { state: "running" } },
				Object.defineProperty({ gate, tick }, "clock", { enumerable: true, get: hook }),
				new Proxy(good, { ownKeys: hook, get: hook }),
			];
			for (const options of refused)
				expect(() => new SchedulerLoop(options as never)).toThrowError(
					expect.objectContaining({ name: "SchedulerError", code: "SCHEDULER_CONFIG" }),
				);
			expect(hooks).toBe(0);
		});

		it("pins the clock and gate methods it was given", async () => {
			const fake = new FakeClock();
			const clock = {
				wallMs: () => fake.wall,
				monotonicMs: () => fake.mono,
				after: (ms: number, signal?: AbortSignal) => fake.after(ms, signal),
			};
			const gate = { state: (): "running" | "paused" => "running" };
			const ticks: string[] = [];
			const loop = new SchedulerLoop({
				clock,
				gate,
				tick: ({ reason }) => {
					ticks.push(reason);
					return 15_000;
				},
			});
			let swapped = 0;
			clock.after = () => {
				swapped++;
				return Promise.resolve();
			};
			gate.state = () => {
				swapped++;
				return "paused";
			};
			loop.start();
			await settle();
			loop.wake();
			await settle();
			expect([ticks, swapped, fake.waits.length]).toEqual([["start", "wake"], 0, 2]);
			await loop.stop();
		});

		it("starts no tick and arms no wait once a gate read has stopped the loop", async () => {
			for (const answer of ["running", "paused"] as const) {
				const holder: { loop?: SchedulerLoop; stopping?: Promise<void> } = {};
				const gate = {
					state: (): "running" | "paused" => {
						holder.stopping ??= holder.loop?.stop();
						return answer;
					},
				};
				const h = harness(undefined, new FakeClock(), gate as unknown as FakeGate);
				holder.loop = h.loop;
				h.loop.start();
				await settle();
				let stopped = false;
				void holder.stopping?.then(() => {
					stopped = true;
				});
				await settle();
				expect([stopped, h.ticks.length, h.clock.waits.length, h.loop.status().state]).toEqual([
					true,
					0,
					0,
					"stopped",
				]);
			}
		});

		it("arms no wait once an error listener has stopped the loop", async () => {
			for (const failure of ["reading", "store", "result"] as const) {
				const clock = new FakeClock();
				if (failure === "reading") clock.wall = -1;
				const holder: { loop?: SchedulerLoop; stopping?: Promise<void> } = {};
				const errors: string[] = [];
				const loop = new SchedulerLoop({
					clock,
					gate: new FakeGate(),
					tick: () => {
						if (failure === "store") throw new Error("Synthetic store failure");
						return failure === "result" ? -1 : MAX_WAIT_MS;
					},
					onError: (code) => {
						errors.push(code);
						holder.stopping ??= holder.loop?.stop();
					},
				});
				holder.loop = loop;
				loop.start();
				await settle();
				let stopped = false;
				void holder.stopping?.then(() => {
					stopped = true;
				});
				await settle();
				expect([errors.length, stopped, clock.waits.length, loop.status().state]).toEqual([
					1,
					true,
					0,
					"stopped",
				]);
			}
		});

		it("reports nothing for a tick that fails or answers badly after stop", async () => {
			for (const outcome of ["reject", "invalid"] as const) {
				const h = harness(
					({ signal }) =>
						new Promise<number>((resolve, reject) =>
							signal.addEventListener(
								"abort",
								() => (outcome === "reject" ? reject(signal.reason) : resolve(-1)),
								{ once: true },
							),
						),
				);
				h.loop.start();
				await settle();
				await h.loop.stop();
				expect([h.ticks.length, h.errors, h.clock.waits.length]).toEqual([1, [], 0]);
			}
		});

		it("reports a failing clock wait once per episode, ended only by a wait that elapses", async () => {
			const fake = new FakeClock();
			let failing = true;
			const clock = {
				wallMs: () => fake.wall,
				monotonicMs: () => fake.mono,
				after: (ms: number, signal?: AbortSignal) =>
					failing ? Promise.reject(new Error("Synthetic clock failure")) : fake.after(ms, signal),
			} as unknown as TimerClock;
			const h = harness(undefined, clock);
			const step = async (fail: boolean, end: () => void): Promise<void> => {
				failing = fail;
				end();
				await settle();
			};
			h.loop.start();
			await settle();
			// A wait that wake() ends early does not end the episode.
			await step(false, () => h.loop.wake());
			await step(true, () => h.loop.wake());
			expect([h.ticks.length, h.errors]).toEqual([3, ["SCHEDULER_DATA"]]);
			// A wait that elapses does.
			await step(false, () => h.loop.wake());
			await step(false, () => fake.advance(15_000));
			await step(true, () => h.loop.wake());
			expect([h.ticks.length, h.errors]).toEqual([6, ["SCHEDULER_DATA", "SCHEDULER_DATA"]]);
			await h.loop.stop();
		});

		it("reports nothing for a wait that fails after wake or stop already ended it", async () => {
			for (const end of ["wake", "stop"] as const) {
				const fake = new FakeClock();
				const holder: { loop?: SchedulerLoop } = {};
				let calls = 0;
				const clock = {
					wallMs: () => fake.wall,
					monotonicMs: () => fake.mono,
					after: (ms: number, signal?: AbortSignal) => {
						calls++;
						if (calls > 1) return fake.after(ms, signal);
						if (end === "wake") holder.loop?.wake();
						else void holder.loop?.stop();
						throw new Error("Synthetic clock failure");
					},
				} as unknown as TimerClock;
				const h = harness(undefined, clock);
				holder.loop = h.loop;
				h.loop.start();
				await settle();
				expect([h.ticks.length, h.errors]).toEqual([end === "wake" ? 2 : 1, []]);
				await h.loop.stop();
			}
		});

		it("ends a wait on wake and on stop even when the clock ignores its signal", async () => {
			const fake = new FakeClock();
			const releases: (() => void)[] = [];
			const clock = {
				wallMs: () => fake.wall,
				monotonicMs: () => fake.mono,
				after: () => new Promise<void>((resolve) => releases.push(resolve)),
			} as unknown as TimerClock;
			const h = harness(undefined, clock);
			h.loop.start();
			await settle();
			h.loop.wake();
			await settle();
			expect(reasons(h)).toEqual(["start", "wake"]);
			let stopped = false;
			void h.loop.stop().then(() => {
				stopped = true;
			});
			await settle();
			expect([stopped, releases.length]).toEqual([true, 2]);
			for (const release of releases) release();
			await settle();
			expect(h.ticks).toHaveLength(2);
		});

		it("keeps ticking when the error listener throws", async () => {
			const clock = new FakeClock();
			const results = [-1, MAX_WAIT_MS];
			let reports = 0;
			const loop = new SchedulerLoop({
				clock,
				gate: new FakeGate(),
				tick: () => results.shift() ?? MAX_WAIT_MS,
				onError: () => {
					reports++;
					throw new Error("Synthetic listener failure");
				},
			});
			loop.start();
			await settle();
			clock.advance(15_000);
			await settle();
			expect([results.length, reports]).toEqual([0, 1]);
			await expect(loop.stop()).resolves.toBeUndefined();
		});

		it("finds clock and gate methods at most 15 prototypes up", () => {
			const nested = (levels: number, methods: object): object => {
				let value = methods;
				for (let level = 0; level < levels; level++) value = Object.create(value);
				return value;
			};
			const clock = { wallMs: () => 0, monotonicMs: () => 0, after: () => Promise.resolve() };
			const gate = { state: (): "running" => "running" };
			const tick = () => 0;
			expect(
				() =>
					new SchedulerLoop({ clock: nested(15, clock), gate: nested(15, gate), tick } as never),
			).not.toThrow();
			for (const options of [
				{ clock: nested(16, clock), gate, tick },
				{ clock, gate: nested(16, gate), tick },
			])
				expect(() => new SchedulerLoop(options as never)).toThrowError(
					expect.objectContaining({ name: "SchedulerError", code: "SCHEDULER_CONFIG" }),
				);
		});

		it("drives planTick over rows 2^31 ms and 30 days ahead, ticking exactly at notBefore", async () => {
			const clock = new FakeClock();
			const start = clock.wall;
			let rows: PlanRow[] = [2 ** 31 - 2, 2 ** 31 - 1, 2 ** 31, 30 * DAY].map((ahead, index) => ({
				id: ulidFor(index),
				accountId: ACCOUNT_A,
				kind: "email",
				pacingKey: ACCOUNT_A,
				state: "SCHEDULED",
				notBefore: start + ahead,
				deliverBy: start + ahead + 900_000,
			}));
			const late: number[] = [];
			const h = harness(({ now }) => {
				const plan = planTick(rows, noHolds, now);
				for (const row of plan.eligible) late.push(now.wall - row.notBefore);
				rows = rows.filter((row) => !plan.eligible.includes(row));
				return planTick(rows, noHolds, now).waitMs;
			}, clock);
			h.loop.start();
			await untilWait(clock, 0);
			while (rows.length > 0) {
				const armed = clock.waits.length;
				clock.advance(clock.last().ms);
				await untilWait(clock, armed);
				expect(clock.waits.length).toBe(armed + 1);
			}
			expect(late).toEqual([0, 0, 0, 0]);
			const longest = clock.waits.reduce((max, wait) => Math.max(max, wait.ms), 0);
			expect(longest).toBe(15_000);
			expect(clock.waits.every((wait) => wait.ms >= 0 && wait.ms <= 15_000)).toBe(true);
			expect(h.errors).toEqual([]);
			await h.loop.stop();
		});
	});
}
