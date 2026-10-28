import { afterEach, expect, it, vi } from "vitest";
import type { PinWallClock } from "../../src/identity/pin.ts";
import { type Clock, systemClock } from "../../src/kernel/clock.ts";

afterEach(() => vi.restoreAllMocks());

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
