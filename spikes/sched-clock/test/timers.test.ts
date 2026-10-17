// Plan section 3: Node fires a delay over 2^31-1 ms (about 24.9 days) after 1 ms, so no timer may
// be derived from notBefore. Each of Node's delay APIs below does it, which is why the GritQL rule
// (grit-check/) keeps them out of outbox code and clock.after(ms) refuses anything over 15 s.
import { scheduler, setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { checkDelay, MAX_AFTER_MS, nextTick, systemClock } from "../src/clock.ts";

const TIMEOUT_MAX = 2 ** 31 - 1;
const DAY = 86_400_000;

// Each arms one timer for `ms` and resolves when it fires.
const delays: Record<string, (ms: number) => Promise<unknown>> = {
	setTimeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	setInterval: (ms) =>
		new Promise((resolve) => {
			const id = setInterval(() => resolve(clearInterval(id)), ms);
		}),
	"timers/promises setTimeout": (ms) => sleep(ms),
	"timers/promises scheduler.wait": (ms) => scheduler.wait(ms),
	"AbortSignal.timeout": (ms) =>
		new Promise((resolve) => AbortSignal.timeout(ms).addEventListener("abort", resolve)),
};

function overflowWarnings(): { readonly count: () => number; readonly stop: () => void } {
	let count = 0;
	const listener = (warning: Error): void => {
		if (warning.name === "TimeoutOverflowWarning") count++;
	};
	process.on("warning", listener);
	return { count: () => count, stop: () => process.off("warning", listener) };
}

describe("Node timers past 2^31-1 ms", () => {
	for (const [name, arm] of Object.entries(delays)) {
		it(`${name}(2**31) fires almost at once, with a TimeoutOverflowWarning`, async () => {
			const warnings = overflowWarnings();
			try {
				const started = performance.now();
				const fired = await Promise.race([
					arm(2 ** 31).then(() => true),
					sleep(5_000).then(() => false),
				]);
				expect(fired).toBe(true);
				expect(performance.now() - started).toBeLessThan(1_000);
				await sleep(10);
				expect(warnings.count()).toBeGreaterThanOrEqual(1);
			} finally {
				warnings.stop();
			}
		});
	}

	it("setTimeout(fn, 2**31 - 1) waits, without a warning", async () => {
		const warnings = overflowWarnings();
		let fired = false;
		const id = setTimeout(() => {
			fired = true;
		}, TIMEOUT_MAX);
		try {
			await sleep(200);
			expect(fired).toBe(false);
			expect(warnings.count()).toBe(0);
		} finally {
			clearTimeout(id);
			warnings.stop();
		}
	});
});

describe("clock.after(ms)", () => {
	it("throws above 15 s, before arming anything, and for every non-whole or negative delay", () => {
		expect(MAX_AFTER_MS).toBe(15_000);
		const refused = [15_001, TIMEOUT_MAX - 1, TIMEOUT_MAX, 2 ** 31, 30 * DAY];
		for (const ms of [...refused, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => systemClock.after(ms), String(ms)).toThrow(RangeError);
		}
		expect([checkDelay(0), checkDelay(15_000)]).toEqual([0, 15_000]);
	});

	it("waits up to 15 s", async () => {
		const started = performance.now();
		await systemClock.after(20);
		expect(performance.now() - started).toBeGreaterThanOrEqual(19);
		const controller = new AbortController();
		const longest = systemClock.after(15_000, controller.signal);
		controller.abort();
		await expect(longest).rejects.toMatchObject({ name: "AbortError" });
		await systemClock.after(0);
	});

	// Plan section 13, Timers: items 2^31-2, 2^31-1 and 2^31 ms and 30 days ahead never fire early.
	it("ticks through items 2^31-2, 2^31-1, 2^31 ms and 30 days ahead, never firing early", () => {
		const start = Date.UTC(2026, 9, 17);
		for (const ahead of [TIMEOUT_MAX - 1, TIMEOUT_MAX, 2 ** 31, 30 * DAY]) {
			const due = start + ahead;
			let now = start;
			let ticks = 0;
			let longest = 0;
			while (now < due) {
				const wait = checkDelay(nextTick(now, due));
				longest = Math.max(longest, wait);
				now += wait;
				ticks++;
			}
			expect(now).toBe(due);
			expect(ticks).toBe(Math.ceil(ahead / 15_000));
			expect(longest).toBe(15_000);
		}
		expect(nextTick(start + 0.5, start + 10)).toBe(10);
		// A row due and not yet tried ticks at once; a held row passes its retry time instead
		// (two-clock.test.ts), so it never does twice. Nothing due, or no usable time: a full tick.
		expect(nextTick(start, start - 1)).toBe(0);
		const idle: [number, number | undefined][] = [
			[start, undefined],
			[start, Number.NaN],
			[start, Number.POSITIVE_INFINITY],
			[start, Number.NEGATIVE_INFINITY],
			[Number.NaN, start],
		];
		for (const [now, due] of idle) expect(nextTick(now, due), `${now} ${due}`).toBe(15_000);
	});
});
