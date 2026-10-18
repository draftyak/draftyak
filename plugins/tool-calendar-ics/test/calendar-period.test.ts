import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import {
	inPeriodPhase,
	type PositionedFrequency,
	periodKey,
	periodStart,
} from "../src/calendar-period.ts";
import { CalendarError } from "../src/error.ts";

const noOffset = new ICAL.Timezone({ tzid: "Synthetic/WallOnly" });
noOffset.utcOffset = () => {
	throw new Error("wall-period helpers must not resolve an offset");
};

function time(text: string): ICAL.Time {
	const value = ICAL.Time.fromString(text, undefined);
	value.zone = noOffset;
	return value;
}

describe("nominal recurrence periods", () => {
	it.each([
		["SECONDLY", "2026-03-08T02:30:45Z"],
		["MINUTELY", "2026-03-08T02:30:00Z"],
		["HOURLY", "2026-03-08T02:00:00Z"],
		["DAILY", "2026-03-08T00:00:00Z"],
		["WEEKLY", "2026-03-02T00:00:00Z"],
	] as const)(
		"buckets %s in wall fields without consulting zone offsets",
		(frequency, expected) => {
			expect(periodKey(time("2026-03-08T02:30:45"), frequency, ICAL.Time.MONDAY)).toBe(
				Date.parse(expected),
			);
		},
	);
	it("uses WKST across a year boundary and keeps a Sunday start distinct", () => {
		const first = time("2021-01-01T23:59:59");
		expect(periodKey(first, "WEEKLY", ICAL.Time.MONDAY)).toBe(Date.parse("2020-12-28T00:00:00Z"));
		expect(periodKey(first, "WEEKLY", ICAL.Time.SUNDAY)).toBe(Date.parse("2020-12-27T00:00:00Z"));
		expect(periodKey(time("2021-01-03T00:00:00"), "WEEKLY", ICAL.Time.SUNDAY)).toBe(
			Date.parse("2021-01-03T00:00:00Z"),
		);
		expect(periodKey(time("2021-01-03T23:59:59"), "WEEKLY", ICAL.Time.MONDAY)).toBe(
			periodKey(first, "WEEKLY", ICAL.Time.MONDAY),
		);
	});
	it("does not remap four-digit years below 100 into the twentieth century", () => {
		expect(periodKey(time("0004-02-29T13:14:15"), "DAILY", ICAL.Time.MONDAY)).toBe(
			Date.parse("0004-02-29T00:00:00Z"),
		);
	});
	it.each([0, 8, -1, 1.5, NaN, Infinity])("refuses invalid week start %s", (wkst) => {
		expect(() => periodKey(time("2026-01-01T00:00:00"), "WEEKLY", wkst)).toThrowError(
			new CalendarError("RESOURCE_LIMIT"),
		);
	});
});

describe("natural period seed", () => {
	it.each([
		["SECONDLY", "2026-03-08T02:30:45"],
		["MINUTELY", "2026-03-08T02:30:00"],
		["HOURLY", "2026-03-08T02:00:00"],
		["DAILY", "2026-03-08T00:00:00"],
		["WEEKLY", "2026-03-02T00:00:00"],
	] as const)(
		"starts %s in the same nominal bucket without resolving a zone",
		(frequency, expected) => {
			const start = time("2026-03-08T02:30:45");
			const seed = periodStart(start, frequency, ICAL.Time.MONDAY);
			expect(seed.toString()).toBe(expected);
			expect(seed.zone).toBe(noOffset);
			expect(seed.isDate).toBe(false);
			expect(seed).not.toBe(start);
			expect(start.toString()).toBe("2026-03-08T02:30:45");
		},
	);
	it("uses the requested week start across a year boundary", () => {
		const start = time("2021-01-01T23:59:59");
		expect(periodStart(start, "WEEKLY", ICAL.Time.MONDAY).toString()).toBe("2020-12-28T00:00:00");
		expect(periodStart(start, "WEEKLY", ICAL.Time.SUNDAY).toString()).toBe("2020-12-27T00:00:00");
	});
	it("keeps a nominal gap bucket instead of applying compatible disambiguation", () => {
		expect(periodStart(time("2026-03-08T02:30:45"), "HOURLY", ICAL.Time.MONDAY).toString()).toBe(
			"2026-03-08T02:00:00",
		);
	});
	it("preserves DATE identity and the original zone when a week crosses leap day", () => {
		const start = time("2024-03-01");
		const seed = periodStart(start, "WEEKLY", ICAL.Time.MONDAY);
		expect(seed.isDate).toBe(true);
		expect(seed.zone).toBe(noOffset);
		expect(seed.toString()).toBe("2024-02-26");
		expect(start.toString()).toBe("2024-03-01");
	});

	it("keeps early-year fields and allows the first representable daily bucket", () => {
		for (const [text, year, month, day] of [
			["0004-02-29T13:14:15", 4, 2, 29],
			["0000-01-01T13:14:15", 0, 1, 1],
		] as const) {
			const seed = periodStart(time(text), "DAILY", ICAL.Time.MONDAY);
			expect([seed.year, seed.month, seed.day, seed.hour, seed.minute, seed.second]).toEqual([
				year,
				month,
				day,
				0,
				0,
				0,
			]);
			expect(seed.zone).toBe(noOffset);
		}
	});
	it("fails closed if the complete week starts before the parser's four-digit year range", () => {
		expect(() => periodStart(time("0000-01-01T00:00:00"), "WEEKLY", ICAL.Time.MONDAY)).toThrowError(
			new CalendarError("RESOURCE_LIMIT"),
		);
	});
	it("refuses an out-of-range wall year", () => {
		const start = time("9999-01-01T00:00:00");
		start.year = 10000;
		expect(() => periodStart(start, "DAILY", ICAL.Time.MONDAY)).toThrowError(
			new CalendarError("RESOURCE_LIMIT"),
		);
	});
	it.each(["SECONDLY", "MINUTELY", "HOURLY"] as const)(
		"refuses %s expansion of a date-only start",
		(frequency) => {
			expect(() => periodStart(time("2026-01-01"), frequency, ICAL.Time.MONDAY)).toThrowError(
				new CalendarError("RESOURCE_LIMIT"),
			);
		},
	);
	it("refuses an unsupported runtime frequency with a closed error", () => {
		expect(() =>
			periodStart(
				time("2026-01-01T00:00:00"),
				"PRIVATE_CANARY" as PositionedFrequency,
				ICAL.Time.MONDAY,
			),
		).toThrowError(new CalendarError("RESOURCE_LIMIT"));
	});
});

describe("nominal interval phase", () => {
	it.each([
		["SECONDLY", "2026-01-01T00:00:15", "2026-01-01T00:00:45", "2026-01-01T00:00:46", 30],
		["MINUTELY", "2026-01-01T00:15:37", "2026-01-01T01:45:59", "2026-01-01T00:45:59", 90],
		["HOURLY", "2026-01-01T09:17:37", "2026-01-02T10:00:00", "2026-01-01T10:00:00", 25],
		["DAILY", "2026-01-01T09:17:37", "2026-01-03T00:00:00", "2026-01-02T00:00:00", 2],
		["WEEKLY", "2026-01-07T09:17:37", "2026-01-21T00:00:00", "2026-01-14T00:00:00", 2],
	] as const)(
		"preserves %s phase in wall fields without resolving offsets",
		(frequency, original, match, miss, interval) => {
			expect(
				inPeriodPhase(time(match), time(original), frequency, ICAL.Time.MONDAY, interval),
			).toBe(true);
			expect(inPeriodPhase(time(miss), time(original), frequency, ICAL.Time.MONDAY, interval)).toBe(
				false,
			);
		},
	);
	it("uses WKST buckets for weekly phase across the year boundary", () => {
		const start = time("2026-01-03T09:00:00");
		expect(inPeriodPhase(time("2026-01-11T00:00:00"), start, "WEEKLY", ICAL.Time.SUNDAY, 2)).toBe(
			true,
		);
		expect(inPeriodPhase(time("2026-01-11T00:00:00"), start, "WEEKLY", ICAL.Time.MONDAY, 2)).toBe(
			false,
		);
	});
	it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"refuses invalid interval %s",
		(interval) => {
			expect(() =>
				inPeriodPhase(
					time("2026-01-03T00:00:00"),
					time("2026-01-01T00:00:00"),
					"DAILY",
					ICAL.Time.MONDAY,
					interval,
				),
			).toThrowError(new CalendarError("RESOURCE_LIMIT"));
		},
	);
});
