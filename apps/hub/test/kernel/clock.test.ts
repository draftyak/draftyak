import { createHook } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinWallClock } from "../../src/identity/pin.ts";
import {
	type Clock,
	checkWait,
	isAbortError,
	MAX_WAIT_MS,
	nextTick,
	systemClock,
	type TimerClock,
	timeoutSignal,
	withDeadline,
} from "../../src/kernel/clock.ts";
import { FakeClock, settle } from "./fake-clock.ts";

afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const WAIT_REFUSAL = "Clock wait must be whole milliseconds from 0 to 15000";
const SIGNAL_REFUSAL = "Clock wait signal must be an AbortSignal";
const WORK_REFUSAL = "Clock deadline work must be a function";

// The parent signals clock-adversarial.test.ts refuses for systemClock.after.
const fakeSignals = (): readonly [string, unknown][] => [
	["plain", { aborted: false }],
	["null-prototype", Object.assign(Object.create(null), { aborted: false })],
	[
		"throwing-addEventListener",
		{
			aborted: false,
			addEventListener() {
				throw new Error("Synthetic listener failure");
			},
		},
	],
	["prototype fake", Object.create(AbortSignal.prototype)],
	["prototype proxy", new Proxy({}, { getPrototypeOf: () => AbortSignal.prototype })],
	["native signal proxy", new Proxy(new AbortController().signal, {})],
	["null", null],
];

// Counts native Timeouts created while run executes, and clears any so none is left behind.
function nativeTimeouts(run: () => void): number {
	const handles: ReturnType<typeof setTimeout>[] = [];
	const hook = createHook({
		init(_id, type, _trigger, resource) {
			if (type === "Timeout") handles.push(resource as ReturnType<typeof setTimeout>);
		},
	});
	hook.enable();
	try {
		run();
	} finally {
		hook.disable();
		for (const handle of handles) clearTimeout(handle);
	}
	return handles.length;
}

function refusal(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

it("reads the native wall clock each time", () => {
	const wall = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(500);
	expect(systemClock.wallMs()).toBe(1_000);
	expect(systemClock.wallMs()).toBe(500);
	expect(wall).toHaveBeenCalledTimes(2);
});

it("reads the separate native monotonic clock without rounding", () => {
	const monotonic = vi
		.spyOn(performance, "now")
		.mockReturnValueOnce(12.5)
		.mockReturnValueOnce(13.25);
	expect(systemClock.monotonicMs()).toBe(12.5);
	expect(systemClock.monotonicMs()).toBe(13.25);
	expect(monotonic).toHaveBeenCalledTimes(2);
});

it("keeps the shared native provider frozen", () => {
	const original = systemClock.after;
	expect(Object.isFrozen(systemClock)).toBe(true);
	expect(Reflect.set(systemClock, "after", () => Promise.resolve())).toBe(false);
	expect(systemClock.after).toBe(original);
});

// The assignments are the check: the typecheck fails if systemClock stops fitting either interface.
it("is assignable to the wall-only PIN clock and reads the native wall clock through it", () => {
	const clock: Clock = systemClock;
	const pinWall: PinWallClock = clock;
	const wall = vi.spyOn(Date, "now").mockReturnValueOnce(42);
	expect(pinWall.wallMs()).toBe(42);
	expect(wall).toHaveBeenCalledTimes(1);
});

describe("nextTick", () => {
	it("ticks through items 2^31-2, 2^31-1, 2^31 ms and 30 days ahead, reaching each exactly", () => {
		const start = Date.UTC(2026, 9, 17);
		for (const ahead of [2 ** 31 - 2, 2 ** 31 - 1, 2 ** 31, 30 * DAY]) {
			const due = start + ahead;
			let now = start;
			let ticks = 0;
			let longest = 0;
			while (now < due) {
				const wait = checkWait(nextTick(now, due));
				longest = Math.max(longest, wait);
				now += wait;
				ticks++;
			}
			expect(now).toBe(due);
			expect(ticks).toBe(Math.ceil(ahead / 15_000));
			expect(longest).toBe(15_000);
		}
	});

	it("waits whole ms up to a full tick, at once when due, and a full tick without a usable time", () => {
		const start = Date.UTC(2026, 9, 17);
		const table: [now: unknown, due: unknown, wait: number][] = [
			[start, start + 1, 1],
			[start, start + 14_999, 14_999],
			[start, start + 15_000, 15_000],
			[start, start + 15_001, 15_000],
			[start, start, 0],
			[start, start - 1, 0],
			[start, start - 30 * DAY, 0],
			[start + 0.5, start + 10, 10],
			[start, start + 0.25, 1],
			[start + 0.75, start + 1, 1],
			[-Number.MAX_VALUE, Number.MAX_VALUE, 15_000],
			[start, undefined, 15_000],
			[start, Number.NaN, 15_000],
			[start, Number.POSITIVE_INFINITY, 15_000],
			[start, Number.NEGATIVE_INFINITY, 15_000],
			[Number.NaN, start, 15_000],
			[Number.POSITIVE_INFINITY, start, 15_000],
			[start, String(start), 15_000],
			[start, BigInt(start), 15_000],
			[start, null, 15_000],
		];
		for (const [now, due, wait] of table) {
			const result = nextTick(now as number, due as number);
			expect(result, `${String(now)} ${String(due)}`).toBe(wait);
			expect(checkWait(result)).toBe(result);
		}
		expect(Object.is(nextTick(start, start - 0.5), 0)).toBe(true);
	});

	it("never coerces a boxed or object time", () => {
		let hooks = 0;
		const poison = {
			valueOf() {
				hooks++;
				return 0;
			},
			[Symbol.toPrimitive]() {
				hooks++;
				return 0;
			},
		};
		expect(nextTick(poison as unknown as number, 5)).toBe(MAX_WAIT_MS);
		expect(nextTick(0, poison as unknown as number)).toBe(MAX_WAIT_MS);
		expect(nextTick(new Number(0) as number, 5)).toBe(MAX_WAIT_MS);
		expect(hooks).toBe(0);
	});
});

describe("timeoutSignal", () => {
	it("aborts with the fixed timeout reason after exactly one bounded wait", async () => {
		const clock = new FakeClock();
		const parent = new AbortController();
		const timeout = timeoutSignal(clock, 500, parent.signal);
		expect(Object.isFrozen(timeout)).toBe(true);
		expect(clock.waits).toHaveLength(1);
		const [wait] = clock.waits;
		expect(wait?.ms).toBe(500);
		expect(wait?.signal).not.toBe(parent.signal);
		expect(wait?.signal).not.toBe(timeout.signal);
		clock.advance(499);
		await settle();
		expect(timeout.signal.aborted).toBe(false);
		clock.advance(1);
		await settle();
		expect(timeout.signal.aborted).toBe(true);
		expect(timeout.signal.reason).toBeInstanceOf(DOMException);
		expect(timeout.signal.reason).toMatchObject({
			name: "TimeoutError",
			message: "Clock deadline elapsed",
		});
		expect(isAbortError(timeout.signal.reason)).toBe(true);
		parent.abort(new Error("Synthetic late parent"));
		expect(timeout.signal.reason).toMatchObject({ name: "TimeoutError" });
	});

	it("disarms its wait on cancel and never aborts afterwards", async () => {
		const clock = new FakeClock();
		const parent = new AbortController();
		const timeout = timeoutSignal(clock, 500, parent.signal);
		timeout.cancel();
		timeout.cancel();
		await settle();
		expect(clock.last().state).toBe("aborted");
		clock.advance(1_000);
		parent.abort();
		await settle();
		expect(timeout.signal.aborted).toBe(false);
		expect(clock.waits).toHaveLength(1);
	});

	it("follows its parent's abort and reason, and ends its wait", async () => {
		const clock = new FakeClock();
		const parent = new AbortController();
		const timeout = timeoutSignal(clock, 15_000, parent.signal);
		const reason = new Error("Synthetic parent reason");
		parent.abort(reason);
		expect(timeout.signal.aborted).toBe(true);
		expect(timeout.signal.reason).toBe(reason);
		await settle();
		expect(clock.last().state).toBe("aborted");
		clock.advance(15_000);
		await settle();
		expect(timeout.signal.reason).toBe(reason);
	});

	it("returns an aborted signal for an aborted parent without arming a wait", () => {
		const clock = new FakeClock();
		const reason = new Error("Synthetic earlier abort");
		const timeout = timeoutSignal(clock, 500, AbortSignal.abort(reason));
		expect(Object.isFrozen(timeout)).toBe(true);
		expect(timeout.signal.aborted).toBe(true);
		expect(timeout.signal.reason).toBe(reason);
		expect(clock.waits).toEqual([]);
		expect(nativeTimeouts(() => timeoutSignal(systemClock, 500, AbortSignal.abort()))).toBe(0);
	});

	it("ends at once, as if elapsed, when the clock cannot keep the wait", async () => {
		const failing: TimerClock = {
			wallMs: () => 0,
			monotonicMs: () => 0,
			after: () => Promise.reject(new Error("Synthetic clock failure")),
		};
		const timeout = timeoutSignal(failing, 500);
		await settle();
		expect(timeout.signal.aborted).toBe(true);
		expect(timeout.signal.reason).toMatchObject({ name: "TimeoutError" });
	});
});

describe("withDeadline", () => {
	it("returns the work's value before the deadline and disarms the wait", async () => {
		const clock = new FakeClock();
		const parent = new AbortController();
		const signals: AbortSignal[] = [];
		const result = withDeadline(
			clock,
			1_000,
			(signal) => {
				signals.push(signal);
				return Promise.resolve(42);
			},
			parent.signal,
		);
		expect(signals).toHaveLength(1);
		expect(signals[0]).not.toBe(parent.signal);
		expect(clock.waits.map((wait) => wait.ms)).toEqual([1_000]);
		await expect(result).resolves.toEqual({ ok: true, value: 42 });
		expect(Object.isFrozen(await result)).toBe(true);
		expect(clock.last().state).toBe("aborted");
		expect(signals[0]?.aborted).toBe(false);
		await expect(withDeadline(clock, 0, () => 7)).resolves.toEqual({ ok: true, value: 7 });
	});

	it("reports a failing work, thrown or rejected, and disarms the wait", async () => {
		const clock = new FakeClock();
		await expect(
			withDeadline(clock, 1_000, () => {
				throw new Error("Synthetic work failure");
			}),
		).resolves.toEqual({ ok: false, reason: "failed" });
		await expect(
			withDeadline(clock, 1_000, () => Promise.reject(new Error("Synthetic work failure"))),
		).resolves.toEqual({ ok: false, reason: "failed" });
		expect(clock.waits.map((wait) => wait.state)).toEqual(["aborted", "aborted"]);
	});

	it("times out a work that outlives the deadline, aborts it and drops its late result", async () => {
		const unhandled: unknown[] = [];
		const listener = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", listener);
		try {
			const clock = new FakeClock();
			const settles: ((ok: boolean) => void)[] = [];
			const signals: AbortSignal[] = [];
			const results = [0, 1].map(() =>
				withDeadline(clock, 2_000, (signal) => {
					signals.push(signal);
					return new Promise<string>((resolve, reject) => {
						settles.push((ok) =>
							ok ? resolve("late") : reject(new Error("Synthetic late failure")),
						);
					});
				}),
			);
			clock.advance(1_999);
			await settle();
			expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
			clock.advance(1);
			for (const result of results)
				await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
			for (const signal of signals)
				expect(signal.reason).toMatchObject({
					name: "TimeoutError",
					message: "Clock deadline elapsed",
				});
			settles[0]?.(true);
			settles[1]?.(false);
			await settle();
			for (const result of results)
				await expect(result).resolves.toEqual({ ok: false, reason: "timeout" });
		} finally {
			process.off("unhandledRejection", listener);
		}
		expect(unhandled).toEqual([]);
	});

	it("reports aborted on parent abort, passing the parent's reason to the work", async () => {
		const clock = new FakeClock();
		const parent = new AbortController();
		let workSignal: AbortSignal | undefined;
		const result = withDeadline(
			clock,
			15_000,
			(signal) => {
				workSignal = signal;
				return new Promise<never>(() => undefined);
			},
			parent.signal,
		);
		const reason = new Error("Synthetic stop");
		parent.abort(reason);
		await expect(result).resolves.toEqual({ ok: false, reason: "aborted" });
		expect(workSignal?.reason).toBe(reason);
		await settle();
		expect(clock.last().state).toBe("aborted");
	});

	it("neither arms a wait nor calls the work for an aborted parent", async () => {
		const clock = new FakeClock();
		let calls = 0;
		await expect(
			withDeadline(
				clock,
				500,
				() => {
					calls++;
					return 1;
				},
				AbortSignal.abort(),
			),
		).resolves.toEqual({ ok: false, reason: "aborted" });
		expect([calls, clock.waits.length]).toEqual([0, 0]);
	});

	it("returns frozen timeout, aborted and failed results", async () => {
		const clock = new FakeClock();
		const late = withDeadline(clock, 10, () => new Promise<never>(() => undefined));
		clock.advance(10);
		const results = [
			await late,
			await withDeadline(clock, 10, () => 1, AbortSignal.abort()),
			await withDeadline(clock, 10, () => Promise.reject(new Error("Synthetic work failure"))),
		];
		expect(results).toEqual([
			{ ok: false, reason: "timeout" },
			{ ok: false, reason: "aborted" },
			{ ok: false, reason: "failed" },
		]);
		for (const result of results) expect(Object.isFrozen(result)).toBe(true);
	});

	it("reports failed, and stops the work, when the clock cannot keep the wait", async () => {
		let workSignal: AbortSignal | undefined;
		const failing: TimerClock = {
			wallMs: () => 0,
			monotonicMs: () => 0,
			after: () => Promise.reject(new Error("Synthetic clock failure")),
		};
		await expect(
			withDeadline(failing, 500, (signal) => {
				workSignal = signal;
				return new Promise<never>(() => undefined);
			}),
		).resolves.toEqual({ ok: false, reason: "failed" });
		expect(workSignal?.aborted).toBe(true);
	});
});

describe("bounded helper admission", () => {
	it("refuses a bad wait synchronously before any timer, work or signal check", () => {
		for (const ms of [15_001, 2 ** 31, -1, 0.5, Number.NaN, "0", undefined]) {
			let calls = 0;
			const work = () => {
				calls++;
			};
			let timeoutError: unknown;
			let deadlineError: unknown;
			const created = nativeTimeouts(() => {
				timeoutError = refusal(() => timeoutSignal(systemClock, ms as number, null as never));
				deadlineError = refusal(() => withDeadline(systemClock, ms as number, work, null as never));
			});
			for (const error of [timeoutError, deadlineError]) {
				expect(error).toBeInstanceOf(RangeError);
				expect((error as Error).message).toBe(WAIT_REFUSAL);
			}
			expect([created, calls]).toEqual([0, 0]);
		}
	});

	it("refuses work that is not a plain function before any timer", () => {
		const fake = new FakeClock();
		for (const work of [undefined, null, 1, "work", {}, new Proxy(() => 1, {})]) {
			let thrown: unknown;
			const created = nativeTimeouts(() => {
				thrown = refusal(() => withDeadline(systemClock, 100, work as never));
			});
			expect(thrown).toBeInstanceOf(TypeError);
			expect((thrown as Error).message).toBe(WORK_REFUSAL);
			expect(created).toBe(0);
			expect(refusal(() => withDeadline(fake, 100, work as never))).toBeInstanceOf(TypeError);
		}
		expect(fake.waits).toEqual([]);
	});

	it("throws a clock's synchronous failure before any work and ends the wait it handed out", () => {
		const failure = new Error("Synthetic clock failure");
		for (const [after, expected] of [
			[
				() => {
					throw failure;
				},
				(error: unknown) => error === failure,
			],
			[() => undefined, (error: unknown) => error instanceof TypeError],
		] as const) {
			const handed: AbortSignal[] = [];
			const clock = {
				wallMs: () => 0,
				monotonicMs: () => 0,
				after: (_ms: number, signal: AbortSignal) => {
					handed.push(signal);
					return after();
				},
			} as unknown as TimerClock;
			let calls = 0;
			const errors = [
				refusal(() => timeoutSignal(clock, 500, new AbortController().signal)),
				refusal(() =>
					withDeadline(clock, 500, () => {
						calls++;
					}),
				),
			];
			expect(errors.map(expected)).toEqual([true, true]);
			expect(calls).toBe(0);
			expect(handed.map((signal) => signal.aborted)).toEqual([true, true]);
		}
	});

	it.each(fakeSignals())("refuses a %s parent signal before any timer or work", (_name, signal) => {
		let calls = 0;
		const thrown: unknown[] = [];
		const created = nativeTimeouts(() => {
			thrown.push(refusal(() => timeoutSignal(systemClock, 100, signal as AbortSignal)));
			thrown.push(
				refusal(() =>
					withDeadline(
						systemClock,
						100,
						() => {
							calls++;
						},
						signal as AbortSignal,
					),
				),
			);
		});
		for (const error of thrown) {
			expect(error).toBeInstanceOf(TypeError);
			expect((error as Error).message).toBe(SIGNAL_REFUSAL);
		}
		expect([created, calls]).toEqual([0, 0]);
	});

	it("listens only to an isolated copy of a real parent with patched listeners", async () => {
		const clock = new FakeClock();
		const controller = new AbortController();
		let listeners = 0;
		const poisoned = (): never => {
			listeners++;
			throw new Error("Synthetic listener failure");
		};
		Object.defineProperties(controller.signal, {
			addEventListener: { value: poisoned },
			removeEventListener: { value: poisoned },
		});
		const timeout = timeoutSignal(clock, 1_000, controller.signal);
		let workSignal: AbortSignal | undefined;
		const result = withDeadline(
			clock,
			1_000,
			(signal) => {
				workSignal = signal;
				return new Promise<never>(() => undefined);
			},
			controller.signal,
		);
		const reason = new Error("Synthetic parent reason");
		controller.abort(reason);
		await expect(result).resolves.toEqual({ ok: false, reason: "aborted" });
		expect(timeout.signal.reason).toBe(reason);
		expect(workSignal?.reason).toBe(reason);
		expect(listeners).toBe(0);
		await settle();
		expect(clock.waits.map((wait) => wait.state)).toEqual(["aborted", "aborted"]);
	});
});

describe("isAbortError", () => {
	it("recognizes Node's AbortError and DOMException AbortError and TimeoutError", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const nodeAbort = await sleep(1, undefined, { signal: aborted.signal }).catch(
			(error: unknown) => error,
		);
		for (const error of [
			nodeAbort,
			aborted.signal.reason,
			new DOMException("x", "AbortError"),
			new DOMException("x", "TimeoutError"),
		])
			expect(isAbortError(error)).toBe(true);
		for (const error of [
			new DOMException("x", "NotFoundError"),
			new DOMException("x"),
			new Error("AbortError"),
			Object.assign(new Error("x"), { name: "AbortError" }),
			Object.assign(new Error("x"), { code: "ABORT_ERR" }),
			{ name: "AbortError", code: "ABORT_ERR" },
			Object.defineProperty(Object.create(DOMException.prototype), "name", { value: "AbortError" }),
			"AbortError",
			null,
			undefined,
			0,
		])
			expect(isAbortError(error)).toBe(false);
	});

	it("never runs a proxy trap or a caller getter", () => {
		let hooks = 0;
		const hook = (): never => {
			hooks++;
			throw new Error("Synthetic hook ran");
		};
		const traps = { get: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook, has: hook };
		const accessors = Object.defineProperties(new Error("x"), {
			name: { get: hook },
			code: { get: hook },
		});
		for (const error of [
			new Proxy(new DOMException("x", "AbortError"), traps),
			new Proxy(new Error("x"), traps),
			Object.create(new Proxy({}, traps)),
			accessors,
		])
			expect(isAbortError(error)).toBe(false);
		expect(hooks).toBe(0);
	});
});
