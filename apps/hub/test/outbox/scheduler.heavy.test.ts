import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { systemClock, type TimerClock } from "../../src/kernel/clock.ts";
import { SchedulerLoop } from "../../src/outbox/scheduler-loop.ts";
import { type PlanRow, planTick } from "../../src/outbox/scheduler-rules.ts";
import { ACCOUNT_A, noHolds, ulidFor } from "./scheduler-fixture.ts";
import { checkSchedulerSimulation } from "./scheduler-rules.cases.ts";

const DAY = 86_400_000;

// Delegates to the native clock and records every armed wait.
function recordingClock(): { readonly clock: TimerClock; readonly waits: number[] } {
	const waits: number[] = [];
	const clock: TimerClock = Object.freeze({
		wallMs: () => systemClock.wallMs(),
		monotonicMs: () => systemClock.monotonicMs(),
		after: (ms: number, signal?: AbortSignal) => {
			waits.push(ms);
			return systemClock.after(ms, signal);
		},
	});
	return { clock, waits };
}

async function until(done: () => boolean, limitMs = 5_000): Promise<void> {
	const started = performance.now();
	while (!done()) {
		if (performance.now() - started > limitMs) throw new Error("Timed out waiting for the loop");
		await sleep(5);
	}
}

describe("scheduler loop on the native clock", () => {
	it("drives planTick over rows 2^31 ms and 30 days ahead with no overflow and no wait over 15 s", {
		timeout: 30_000,
	}, async () => {
		let warnings = 0;
		const listener = (warning: Error): void => {
			if (warning.name === "TimeoutOverflowWarning") warnings++;
		};
		process.on("warning", listener);
		const { clock, waits } = recordingClock();
		const start = systemClock.wallMs();
		const rows: PlanRow[] = [2 ** 31 - 2, 2 ** 31 - 1, 2 ** 31, 30 * DAY].map((ahead, index) => ({
			id: ulidFor(index),
			accountId: ACCOUNT_A,
			kind: "email",
			pacingKey: ACCOUNT_A,
			state: "SCHEDULED",
			notBefore: start + ahead,
			deliverBy: start + ahead + 900_000,
		}));
		const planned: number[] = [];
		const loop = new SchedulerLoop({
			clock,
			gate: { state: () => "running" },
			tick: ({ now }) => {
				const plan = planTick(rows, noHolds, now);
				planned.push(plan.waitMs);
				return plan.waitMs;
			},
		});
		try {
			loop.start();
			for (let forced = 1; forced <= 6; forced++) {
				await until(() => waits.length >= forced);
				loop.wake();
			}
			await until(() => waits.length >= 7);
		} finally {
			await loop.stop();
			await sleep(20);
			process.off("warning", listener);
		}
		expect(planned.length).toBeGreaterThanOrEqual(7);
		expect(planned.every((wait) => wait === 15_000)).toBe(true);
		expect(waits.every((wait) => Number.isSafeInteger(wait) && wait >= 0 && wait <= 15_000)).toBe(
			true,
		);
		expect(warnings).toBe(0);
	});

	it("stops within 1 s during a real 15 s wait, and no tick follows", {
		timeout: 30_000,
	}, async () => {
		const { clock, waits } = recordingClock();
		let ticks = 0;
		const loop = new SchedulerLoop({
			clock,
			gate: { state: () => "running" },
			tick: () => {
				ticks++;
				return 15_000;
			},
		});
		loop.start();
		await until(() => waits.length === 1);
		expect([ticks, waits]).toEqual([1, [15_000]]);
		const started = performance.now();
		await loop.stop();
		expect(performance.now() - started).toBeLessThan(1_000);
		await sleep(500);
		expect(ticks).toBe(1);
		expect(waits).toEqual([15_000]);
	});
});

describe("scheduler simulation", () => {
	it("makes at most one pre-claim read per tick over 10,000 simulated items", {
		timeout: 300_000,
	}, () => {
		checkSchedulerSimulation(10_000);
	});
});
