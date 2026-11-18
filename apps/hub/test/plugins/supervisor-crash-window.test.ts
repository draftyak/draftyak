import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginCrashBudget } from "../../src/plugins/supervisor/crash-window.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("plugin crash window", () => {
	it("freezes one original budget and reads status without recording a crash", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		const budget = createPluginCrashBudget();
		expect(now).not.toHaveBeenCalled();
		expect(Object.isFrozen(budget)).toBe(true);
		const calls = now.mock.calls.length;
		for (let at = 0; at < 8; at++) expect(budget.disabled).toBe(false);
		expect(now).toHaveBeenCalledTimes(calls);
		expect(budget.recordCrash()).toBe(false);
		expect(now).toHaveBeenCalledTimes(calls + 1);
	});

	it("counts equal-time crashes separately and disables exactly on the fifth", () => {
		vi.spyOn(performance, "now").mockReturnValue(1234);
		const budget = createPluginCrashBudget();
		for (let crash = 1; crash <= 4; crash++) {
			expect(budget.recordCrash()).toBe(false);
			expect(budget.disabled).toBe(false);
		}
		expect(budget.recordCrash()).toBe(true);
		expect(budget.disabled).toBe(true);
	});

	it("expires the exact ten-minute boundary while retaining newer crashes", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const budget = createPluginCrashBudget();
		for (const value of [0, 1, 2, 3]) {
			now.mockReturnValue(value);
			expect(budget.recordCrash()).toBe(false);
		}
		now.mockReturnValue(600_000);
		// The crash at zero expires; the three positive timestamps remain.
		expect(budget.recordCrash()).toBe(false);
		expect(budget.disabled).toBe(false);
		expect(budget.recordCrash()).toBe(true);
		expect(budget.disabled).toBe(true);
	});

	it("retains crashes just inside the ten-minute window", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const budget = createPluginCrashBudget();
		for (const value of [0, 1, 2, 3]) {
			now.mockReturnValue(value);
			expect(budget.recordCrash()).toBe(false);
		}
		now.mockReturnValue(599_999);
		expect(budget.recordCrash()).toBe(true);
		expect(budget.disabled).toBe(true);
	});

	it("counts only the rolling window rather than all previous crashes", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const budget = createPluginCrashBudget();
		for (const value of [0, 600_000, 1_200_000, 1_800_000, 2_400_000]) {
			now.mockReturnValue(value);
			expect(budget.recordCrash()).toBe(false);
			expect(budget.disabled).toBe(false);
		}
		for (const value of [2_400_001, 2_400_002, 2_400_003]) {
			now.mockReturnValue(value);
			expect(budget.recordCrash()).toBe(false);
		}
		now.mockReturnValue(2_400_004);
		expect(budget.recordCrash()).toBe(true);
		expect(budget.disabled).toBe(true);
	});

	it("never reenables a disabled budget after old crashes expire", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const budget = createPluginCrashBudget();
		for (let crash = 0; crash < 5; crash++) budget.recordCrash();
		const calls = now.mock.calls.length;
		expect(budget.disabled).toBe(true);
		for (const value of [600_000, 600_001, 1_000_000_000]) {
			now.mockReturnValue(value);
			expect(budget.recordCrash()).toBe(true);
			expect(budget.disabled).toBe(true);
		}
		expect(now).toHaveBeenCalledTimes(calls);
	});

	it("fails closed on non-finite host time and retains that refusal", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			now.mockReturnValue(0);
			const budget = createPluginCrashBudget();
			now.mockReturnValue(invalid);
			expect(budget.recordCrash()).toBe(true);
			expect(budget.disabled).toBe(true);
			now.mockReturnValue(100);
			expect(budget.recordCrash()).toBe(true);
			expect(budget.disabled).toBe(true);
		}
	});

	it("fails closed on a backward clock even after prior entries expired", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const budget = createPluginCrashBudget();
		expect(budget.recordCrash()).toBe(false);
		now.mockReturnValue(600_000);
		expect(budget.recordCrash()).toBe(false);
		now.mockReturnValue(599_999);
		expect(budget.recordCrash()).toBe(true);
		expect(budget.disabled).toBe(true);
		now.mockReturnValue(600_001);
		expect(budget.recordCrash()).toBe(true);
	});

	it("contains a throwing host clock without publishing its error", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(0);
		const budget = createPluginCrashBudget();
		expect(budget.recordCrash()).toBe(false);
		now.mockImplementation(() => {
			throw new Error("DYTEST-private-clock");
		});
		expect(budget.recordCrash()).toBe(true);
		expect(budget.disabled).toBe(true);
		now.mockReturnValue(1);
		expect(budget.recordCrash()).toBe(true);
	});

	it("keeps different original budgets independent", () => {
		vi.spyOn(performance, "now").mockReturnValue(100);
		const first = createPluginCrashBudget();
		const second = createPluginCrashBudget();
		expect(first).not.toBe(second);
		for (let crash = 0; crash < 5; crash++) first.recordCrash();
		expect(first.disabled).toBe(true);
		expect(second.disabled).toBe(false);
		expect(second.recordCrash()).toBe(false);
		expect(second.disabled).toBe(false);
	});
});
