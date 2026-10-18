import ICAL from "ical.js";
import { expect, it } from "vitest";
import { CalendarError } from "../src/error.ts";
import { freeBusy } from "../src/index.ts";
import { recurrenceIterator } from "../src/recurrence.ts";
import { event, expectCode, feed } from "./helpers.ts";

interface Case {
	readonly name: string;
	readonly start: string;
	readonly rule: string;
	readonly from: string;
	readonly to: string;
	readonly times: readonly string[];
}

const cases: readonly Case[] = [
	{
		name: "monthly unsorted hours retain a narrow early occurrence",
		start: "20260115T090000Z",
		rule: "FREQ=MONTHLY;BYHOUR=10,9;COUNT=4",
		from: "2026-02-15T08:00:00Z",
		to: "2026-02-15T09:30:00Z",
		times: ["2026-02-15T09:00:00Z"],
	},
	{
		name: "monthly numeric order is applied before COUNT",
		start: "20260115T090000Z",
		rule: "FREQ=MONTHLY;BYHOUR=10,9,9;COUNT=3",
		from: "2026-01-15T00:00:00Z",
		to: "2026-02-16T00:00:00Z",
		times: ["2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z", "2026-02-15T09:00:00Z"],
	},
	{
		name: "yearly numeric order is applied before COUNT",
		start: "20260115T090000Z",
		rule: "FREQ=YEARLY;BYHOUR=10,9;COUNT=3",
		from: "2026-01-15T00:00:00Z",
		to: "2027-01-16T00:00:00Z",
		times: ["2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z", "2027-01-15T09:00:00Z"],
	},
	{
		name: "nonadjacent hourly replay does not consume COUNT",
		start: "20260101T070000Z",
		rule: "FREQ=HOURLY;BYHOUR=0,7,9;BYMINUTE=0,30;COUNT=3",
		from: "2026-01-01T06:00:00Z",
		to: "2026-01-01T10:00:00Z",
		times: ["2026-01-01T07:00:00Z", "2026-01-01T07:30:00Z", "2026-01-01T09:00:00Z"],
	},
	{
		// RFC 5545 sets start at the natural interval, then apply BYMONTH before BYSETPOS.
		// This literal control intentionally does not use dateutil's partial-first-week result.
		name: "weekly limiting parts filter the complete first bucket before positions",
		start: "20250101T090000Z",
		rule: "FREQ=WEEKLY;BYMONTH=1;BYDAY=MO,WE,FR;BYSETPOS=1,2;COUNT=4",
		from: "2025-01-01T00:00:00Z",
		to: "2025-01-14T00:00:00Z",
		times: [
			"2025-01-01T09:00:00Z",
			"2025-01-03T09:00:00Z",
			"2025-01-06T09:00:00Z",
			"2025-01-08T09:00:00Z",
		],
	},
];

it.each(cases)("$name", ({ start, rule, from, to, times }) => {
	const result = freeBusy(
		feed(event("UID:review", `DTSTART:${start}`, "DURATION:PT10M", `RRULE:${rule}`)),
		{ start: Date.parse(from), end: Date.parse(to) },
		"UTC",
	);
	expect(result).toEqual({
		busy: times.map((time) => ({
			start: Date.parse(time),
			end: Date.parse(time) + 600_000,
			status: "busy",
		})),
	});
});

it.each([
	"FREQ=DAILY;BYMONTHDAY=-1,15;COUNT=3",
	"FREQ=HOURLY;BYMONTHDAY=-1;COUNT=3",
	"FREQ=MONTHLY;BYHOUR=7,8;BYSETPOS=1;COUNT=3",
	"FREQ=YEARLY;BYMONTH=2;BYMINUTE=0,30;BYSETPOS=1;COUNT=3",
	"FREQ=YEARLY;BYDAY=MO;BYSETPOS=1;COUNT=3",
])("refuses unsupported recurrence rather than returning incomplete busy time: %s", (rule) => {
	expectCode(
		() =>
			freeBusy(
				feed(
					event("UID:unsupported", "DTSTART:20260214T070000Z", "DURATION:PT10M", `RRULE:${rule}`),
				),
				{ start: Date.parse("2026-02-01T00:00:00Z"), end: Date.parse("2026-04-01T00:00:00Z") },
				"UTC",
			),
		"INVALID_FEED",
	);
});

it.each(["BYHOUR=13", "BYMINUTE=37", "BYSECOND=41"])(
	"ignores %s on a DATE-valued DTSTART",
	(part) => {
		expect(
			freeBusy(
				feed(
					event(
						"UID:date-parts",
						"DTSTART;VALUE=DATE:20260101",
						`RRULE:FREQ=DAILY;COUNT=2;${part}`,
					),
				),
				{ start: Date.parse("2026-01-01T00:00Z"), end: Date.parse("2026-01-04T00:00Z") },
				"UTC",
			),
		).toEqual({
			busy: [
				{
					start: Date.parse("2026-01-01T00:00Z"),
					end: Date.parse("2026-01-03T00:00Z"),
					status: "busy",
				},
			],
		});
	},
);

function yearlyStarts(properties: readonly string[], from: string, to: string): readonly number[] {
	const result = freeBusy(
		feed(event("UID:yearly-time", "DURATION:PT1S", ...properties)),
		{ start: Date.parse(from), end: Date.parse(to) },
		"UTC",
	);
	expect(result.busy.every((busy) => busy.end - busy.start === 1000)).toBe(true);
	return result.busy.map((busy) => busy.start);
}

it("expands the sorted YEARLY time cartesian product before COUNT", () => {
	expect(
		yearlyStarts(
			[
				"DTSTART:20260115T091507Z",
				"RRULE:FREQ=YEARLY;BYHOUR=10,9,9;BYMINUTE=45,15;BYSECOND=37,7,7;COUNT=10",
			],
			"2026-01-01T00:00Z",
			"2028-01-01T00:00Z",
		),
	).toEqual(
		[
			"2026-01-15T09:15:07Z",
			"2026-01-15T09:15:37Z",
			"2026-01-15T09:45:07Z",
			"2026-01-15T09:45:37Z",
			"2026-01-15T10:15:07Z",
			"2026-01-15T10:15:37Z",
			"2026-01-15T10:45:07Z",
			"2026-01-15T10:45:37Z",
			"2027-01-15T09:15:07Z",
			"2027-01-15T09:15:37Z",
		].map(Date.parse),
	);
});

it("preserves absent YEARLY lower defaults", () => {
	expect(
		yearlyStarts(
			["DTSTART:20260115T091537Z", "RRULE:FREQ=YEARLY;BYHOUR=10,9;COUNT=3"],
			"2026-01-01T00:00Z",
			"2028-01-01T00:00Z",
		),
	).toEqual(
		["2026-01-15T09:15:37Z", "2026-01-15T10:15:37Z", "2027-01-15T09:15:37Z"].map(Date.parse),
	);
});

it("checks YEARLY UNTIL on expanded times and keeps RDATE independent", () => {
	expect(
		yearlyStarts(
			[
				"DTSTART:20260115T090000Z",
				"RRULE:FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15,16;BYHOUR=9,7;UNTIL=20260116T080000Z",
				"EXDATE:20260115T090000Z",
				"RDATE:20260117T120000Z",
			],
			"2026-01-01T00:00Z",
			"2026-02-01T00:00Z",
		),
	).toEqual(["2026-01-16T07:00:00Z", "2026-01-17T12:00:00Z"].map(Date.parse));
});

it("deduplicates compatible-gap YEARLY instants before COUNT", () => {
	expect(
		yearlyStarts(
			[
				"DTSTART;TZID=America/New_York:20260308T021500",
				"RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=8;BYHOUR=2,3;BYMINUTE=15,30;COUNT=4",
			],
			"2026-01-01T00:00Z",
			"2028-01-01T00:00Z",
		),
	).toEqual(
		[
			"2026-03-08T07:15:00Z",
			"2026-03-08T07:30:00Z",
			"2027-03-08T07:15:00Z",
			"2027-03-08T07:30:00Z",
		].map(Date.parse),
	);
});

it("preserves YEARLY INTERVAL while expanding each date", () => {
	expect(
		yearlyStarts(
			["DTSTART:20260115T090000Z", "RRULE:FREQ=YEARLY;INTERVAL=2;BYHOUR=10,9;COUNT=3"],
			"2026-01-01T00:00Z",
			"2029-01-01T00:00Z",
		),
	).toEqual(
		["2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z", "2028-01-15T09:00:00Z"].map(Date.parse),
	);
});

it("charges YEARLY periods, calendar days and each expanded tuple to the shared budget", () => {
	const source = new ICAL.Event(
		new ICAL.Component(
			ICAL.parse(event("DTSTART:20260101T000000Z", "RRULE:FREQ=YEARLY;BYHOUR=0,1,2;COUNT=3")),
		),
	);
	let calls = 0;
	const iterator = recurrenceIterator(source, () => {
		if (++calls > 4) throw new CalendarError("RESOURCE_LIMIT");
	});
	expect(iterator.next()?.toString()).toBe("2026-01-01T00:00:00Z");
	expect(calls).toBe(3);
	expect(iterator.next()?.toString()).toBe("2026-01-01T01:00:00Z");
	expect(calls).toBe(4);
	expectCode(() => iterator.next(), "RESOURCE_LIMIT");
	expect(calls).toBe(5);
});
