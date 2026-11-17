import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertUnexpiredReleaseBounds } from "../lib/inventory-release-expiry.ts";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 1_000;
const REFUSAL = /^Inventory release expiry refused$/;

describe("release metadata expiry bounds", () => {
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("accepts a finite bound strictly after the current clock", () => {
		expect(assertUnexpiredReleaseBounds([FUTURE])).toBeUndefined();
	});

	it("refuses a bound equal to the current clock", () => {
		expect(() => assertUnexpiredReleaseBounds([NOW])).toThrow(REFUSAL);
	});

	it("refuses an expired finite bound", () => {
		expect(() => assertUnexpiredReleaseBounds([NOW - 1])).toThrow(REFUSAL);
	});

	it("accepts null as an absent expiry bound", () => {
		expect(assertUnexpiredReleaseBounds([null])).toBeUndefined();
	});

	it("accepts an empty bound list without asserting freshness", () => {
		expect(assertUnexpiredReleaseBounds([])).toBeUndefined();
	});

	it("accepts several absent expiry bounds", () => {
		expect(assertUnexpiredReleaseBounds([null, null])).toBeUndefined();
	});

	it("accepts mixed future and absent bounds", () => {
		expect(assertUnexpiredReleaseBounds([null, FUTURE, FUTURE + 1, null])).toBeUndefined();
	});

	it("refuses a mixed vector when any present bound has expired", () => {
		expect(() => assertUnexpiredReleaseBounds([null, FUTURE, NOW - 1, null])).toThrow(REFUSAL);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses nonfinite bound %s",
		(bound) => {
			expect(() => assertUnexpiredReleaseBounds([bound])).toThrow(REFUSAL);
		},
	);

	it.each([String(FUTURE), "", undefined])("refuses malformed present bound %s", (bound) => {
		const bounds = [bound] as unknown as readonly (number | null)[];
		expect(() => assertUnexpiredReleaseBounds(bounds)).toThrow(REFUSAL);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"refuses a nonfinite current clock %s",
		(now) => {
			vi.mocked(Date.now).mockReturnValue(now);
			expect(() => assertUnexpiredReleaseBounds([FUTURE])).toThrow(REFUSAL);
		},
	);

	it("rechecks a retained vector against the current clock on every invocation", () => {
		const bounds = Object.freeze([null, FUTURE, FUTURE + 1]);
		expect(assertUnexpiredReleaseBounds(bounds)).toBeUndefined();
		vi.mocked(Date.now).mockReturnValue(FUTURE);
		expect(() => assertUnexpiredReleaseBounds(bounds)).toThrow(REFUSAL);
	});
});
