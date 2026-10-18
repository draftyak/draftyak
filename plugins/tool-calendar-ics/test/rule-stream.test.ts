import ICAL from "ical.js";
import { expect, it } from "vitest";
import { CalendarError, freeBusy } from "../src/index.ts";
import { recurrenceIterator } from "../src/recurrence.ts";
import { event, expectCode, feed } from "./helpers.ts";

const bounds = (from: string, to: string) => ({ start: Date.parse(from), end: Date.parse(to) });
const intervals = (starts: readonly string[], seconds = 60) => ({
	busy: starts.map((start) => ({
		start: Date.parse(start),
		end: Date.parse(start) + seconds * 1000,
		status: "busy",
	})),
});
const read = (start: string, rule: string, from: string, to: string, ...extra: string[]) =>
	freeBusy(
		feed(event("UID:positioned", `DTSTART:${start}`, "DURATION:PT1M", `RRULE:${rule}`, ...extra)),
		bounds(from, to),
		"UTC",
	);

it("does not let UNTIL stop a named-zone rule before a later compatible occurrence moves back in UTC", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:until-gap",
				"DTSTART;TZID=America/New_York:20260308T014500",
				"DURATION:PT10M",
				"RRULE:FREQ=MINUTELY;INTERVAL=45;UNTIL=20260308T072000Z",
			),
		),
		bounds("2026-03-08T07:10Z", "2026-03-08T07:20Z"),
		"America/New_York",
	);
	expect(result).toEqual({
		busy: [
			{
				start: Date.parse("2026-03-08T07:15Z"),
				end: Date.parse("2026-03-08T07:20Z"),
				status: "busy",
			},
		],
	});
});

it("keeps inclusive RRULE UNTIL separate from later RDATE, EXDATE and cancelled overrides", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:until-union",
				"DTSTART:20260101T090000Z",
				"DURATION:PT1M",
				"RRULE:FREQ=DAILY;UNTIL=20260103T090000Z",
				"RDATE:20260104T090000Z",
				"EXDATE:20260102T090000Z",
			),
			event("UID:until-union", "RECURRENCE-ID:20260103T090000Z", "STATUS:CANCELLED"),
		),
		bounds("2026-01-01T00:00Z", "2026-01-06T00:00Z"),
		"UTC",
	);
	expect(result).toEqual(intervals(["2026-01-01T09:00Z", "2026-01-04T09:00Z"]));
});

it("applies a DATE UNTIL to nominal dates and still accepts independent dates after it", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:date-until",
				"DTSTART;VALUE=DATE:20260101",
				"RRULE:FREQ=DAILY;UNTIL=20260103",
				"EXDATE;VALUE=DATE:20260102",
				"RDATE;VALUE=DATE:20260104",
			),
		),
		bounds("2026-01-01T00:00Z", "2026-01-06T00:00Z"),
		"UTC",
	);
	expect(result).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:00Z"),
				end: Date.parse("2026-01-02T00:00Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-03T00:00Z"),
				end: Date.parse("2026-01-05T00:00Z"),
				status: "busy",
			},
		],
	});
});

it("applies DAILY set positions before COUNT, including a complete first interval before DTSTART", () => {
	expect(
		read(
			"20260101T023000Z",
			"FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30;BYSETPOS=2,3;COUNT=6",
			"2026-01-01T00:00Z",
			"2026-01-04T00:00Z",
		),
	).toEqual(
		intervals([
			"2026-01-01T02:30Z",
			"2026-01-01T03:00Z",
			"2026-01-02T02:30Z",
			"2026-01-02T03:00Z",
			"2026-01-03T02:30Z",
			"2026-01-03T03:00Z",
		]),
	);
});

it("sorts and deduplicates multiple positive/negative positions before COUNT", () => {
	expect(
		read(
			"20260101T023000Z",
			"FREQ=DAILY;BYHOUR=2,3;BYMINUTE=0,30;BYSETPOS=-1,2,2;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-01-04T00:00Z",
		),
	).toEqual(
		intervals(["2026-01-01T02:30Z", "2026-01-01T03:30Z", "2026-01-02T02:30Z", "2026-01-02T03:30Z"]),
	);
});

it("applies MINUTELY positions within each minute", () => {
	expect(
		read(
			"20260101T000015Z",
			"FREQ=MINUTELY;BYSECOND=0,15,30,45;BYSETPOS=2,-1;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-01-01T00:03Z",
		),
	).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:00:15Z"),
				end: Date.parse("2026-01-01T00:02:45Z"),
				status: "busy",
			},
		],
	});
});

it("applies HOURLY positions while preserving DTSTART's default seconds", () => {
	expect(
		read(
			"20260101T001537Z",
			"FREQ=HOURLY;BYMINUTE=0,15,30,45;BYSETPOS=2,-1;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-01-01T03:00Z",
		),
	).toEqual(
		intervals([
			"2026-01-01T00:15:37Z",
			"2026-01-01T00:45:37Z",
			"2026-01-01T01:15:37Z",
			"2026-01-01T01:45:37Z",
		]),
	);
});

it("handles SECONDLY's single candidate with duplicate positive/negative positions", () => {
	expect(
		read(
			"20260101T000015Z",
			"FREQ=SECONDLY;BYSECOND=15,45;BYSETPOS=1,-1,1;COUNT=2",
			"2026-01-01T00:00Z",
			"2026-01-01T00:03Z",
		),
	).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:00:15Z"),
				end: Date.parse("2026-01-01T00:01:45Z"),
				status: "busy",
			},
		],
	});
});

it("uses natural WEEKLY sets with WKST and keeps the INTERVAL phase and defaults", () => {
	expect(
		read(
			"20260107T091729Z",
			"FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=MO,WE,FR;BYSETPOS=2,-1;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-02-01T00:00Z",
		),
	).toEqual(
		intervals([
			"2026-01-07T09:17:29Z",
			"2026-01-09T09:17:29Z",
			"2026-01-21T09:17:29Z",
			"2026-01-23T09:17:29Z",
		]),
	);
});

it.each([
	["SU", "20260103T090000Z", ["2026-01-03T09:00Z", "2026-01-10T09:00Z"]],
	["MO", "20260104T090000Z", ["2026-01-04T09:00Z", "2026-01-11T09:00Z"]],
] as const)("ranks weekly positions relative to WKST=%s", (wkst, start, expected) => {
	expect(
		read(
			start,
			`FREQ=WEEKLY;WKST=${wkst};BYDAY=SU,TU,SA;BYSETPOS=-1;COUNT=2`,
			"2026-01-01T00:00Z",
			"2026-01-20T00:00Z",
		),
	).toEqual(intervals(expected));
});

it.each([
	[
		"MONTHLY",
		"20260130T090000Z",
		"FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3",
		"2026-01-01T00:00Z",
		"2026-04-01T00:00Z",
		["2026-01-30T09:00Z", "2026-02-27T09:00Z", "2026-03-31T09:00Z"],
	],
	[
		"YEARLY",
		"20260130T090000Z",
		"FREQ=YEARLY;BYMONTH=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2",
		"2026-01-01T00:00Z",
		"2028-01-01T00:00Z",
		["2026-01-30T09:00Z", "2027-01-29T09:00Z"],
	],
] as const)("preserves the pinned %s BYSETPOS path", (_name, start, rule, from, to, expected) => {
	expect(read(start, rule, from, to)).toEqual(intervals(expected));
});

it("does not refund COUNT for EXDATE and does not apply it to independent RDATE", () => {
	expect(
		read(
			"20260101T090000Z",
			"FREQ=DAILY;BYHOUR=9,10;BYSETPOS=1;COUNT=2",
			"2026-01-01T00:00Z",
			"2026-01-06T00:00Z",
			"EXDATE:20260101T090000Z",
			"RDATE:20260104T090000Z",
		),
	).toEqual(intervals(["2026-01-02T09:00Z", "2026-01-04T09:00Z"]));
});

it("refuses BYSETPOS without another BY rule instead of partially interpreting it", () => {
	expectCode(
		() =>
			read(
				"20260101T090000Z",
				"FREQ=DAILY;BYSETPOS=1;COUNT=2",
				"2026-01-01T00:00Z",
				"2026-01-06T00:00Z",
			),
		"INVALID_FEED",
	);
});

it("charges the expansion budget before emitting any partial set-position interval", () => {
	const component = new ICAL.Component(
		ICAL.parse(
			event(
				"UID:bounded-set",
				"DTSTART:20260101T090007Z",
				"RRULE:FREQ=DAILY;BYSECOND=0,1,2,3,4,5,6,7;BYSETPOS=-1;COUNT=2",
			),
		),
	);
	let calls = 0;
	const iterator = recurrenceIterator(new ICAL.Event(component), () => {
		if (++calls > 5) throw new CalendarError("RESOURCE_LIMIT");
	});
	expect(() => iterator.next()).toThrow(new CalendarError("RESOURCE_LIMIT"));
	expect(calls).toBe(6);
});

it("preserves the first MINUTELY bucket when BYMINUTE contracts the rule", () => {
	expect(
		read(
			"20260101T001515Z",
			"FREQ=MINUTELY;BYMINUTE=15,45;BYSECOND=0,15,30,45;BYSETPOS=2,-1;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-01-01T02:00Z",
		),
	).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:15:15Z"),
				end: Date.parse("2026-01-01T00:16:45Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-01T00:45:15Z"),
				end: Date.parse("2026-01-01T00:46:45Z"),
				status: "busy",
			},
		],
	});
});

it.each([
	[
		"MINUTELY",
		"20260101T001537Z",
		"FREQ=MINUTELY;BYMINUTE=15,45;BYSETPOS=1;COUNT=2",
		["2026-01-01T00:15:37Z", "2026-01-01T00:45:37Z"],
	],
	[
		"HOURLY",
		"20260101T001737Z",
		"FREQ=HOURLY;BYHOUR=0,1;BYSETPOS=1;COUNT=2",
		["2026-01-01T00:17:37Z", "2026-01-01T01:17:37Z"],
	],
	[
		"DAILY",
		"20260101T091737Z",
		"FREQ=DAILY;INTERVAL=2;BYHOUR=9,10;BYSETPOS=1;COUNT=2",
		["2026-01-01T09:17:37Z", "2026-01-03T09:17:37Z"],
	],
	[
		"WEEKLY",
		"20260107T091737Z",
		"FREQ=WEEKLY;INTERVAL=2;BYHOUR=9,10;BYSETPOS=1;COUNT=2",
		["2026-01-07T09:17:37Z", "2026-01-21T09:17:37Z"],
	],
] as const)(
	"preserves missing %s lower defaults and original INTERVAL phase",
	(_name, start, rule, expected) => {
		expect(read(start, rule, "2026-01-01T00:00Z", "2026-02-01T00:00Z")).toEqual(
			intervals(expected),
		);
	},
);

it("treats numeric BY list order as immaterial before set-position COUNT", () => {
	expect(
		read(
			"20260101T001515Z",
			"FREQ=MINUTELY;BYMINUTE=45,15;BYSECOND=0,15,30,45;BYSETPOS=2,-1;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-01-01T06:00Z",
		),
	).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:15:15Z"),
				end: Date.parse("2026-01-01T00:16:45Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-01T00:45:15Z"),
				end: Date.parse("2026-01-01T00:46:45Z"),
				status: "busy",
			},
		],
	});
});
it("retains same-frequency INTERVAL before counting positioned occurrences", () => {
	expect(
		read(
			"20260101T000000Z",
			"FREQ=HOURLY;INTERVAL=2;BYHOUR=0,1,2,3,4;BYMINUTE=0,30;BYSETPOS=1;COUNT=3",
			"2026-01-01T00:00Z",
			"2026-01-01T06:00Z",
		),
	).toEqual(intervals(["2026-01-01T00:00Z", "2026-01-01T02:00Z", "2026-01-01T04:00Z"]));
});
it("keeps later candidates when DTSTART is in the middle of a numeric contraction list", () => {
	expect(
		read(
			"20260101T003015Z",
			"FREQ=MINUTELY;BYMINUTE=0,15,30,45;BYSECOND=0,15,30,45;BYSETPOS=2,-1;COUNT=4",
			"2026-01-01T00:00Z",
			"2026-01-01T06:00Z",
		),
	).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:30:15Z"),
				end: Date.parse("2026-01-01T00:31:45Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-01T00:45:15Z"),
				end: Date.parse("2026-01-01T00:46:45Z"),
				status: "busy",
			},
		],
	});
});
it.each([
	[
		"SECONDLY",
		"20260101T000000Z",
		"FREQ=SECONDLY;INTERVAL=30;BYSECOND=0,15,30,45;BYSETPOS=1;COUNT=3",
		["2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z", "2026-01-01T00:01:00Z"],
	],
	[
		"MINUTELY",
		"20260101T001500Z",
		"FREQ=MINUTELY;INTERVAL=90;BYMINUTE=15,45;BYSECOND=0,15;BYSETPOS=1;COUNT=3",
		["2026-01-01T00:15Z", "2026-01-01T01:45Z", "2026-01-01T03:15Z"],
	],
	[
		"HOURLY",
		"20260101T001500Z",
		`FREQ=HOURLY;INTERVAL=25;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(",")};BYMINUTE=15,45;BYSETPOS=1;COUNT=3`,
		["2026-01-01T00:15Z", "2026-01-02T01:15Z", "2026-01-03T02:15Z"],
	],
] as const)(
	"does not omit %s phase matches across larger units",
	(_name, start, rule, expected) => {
		const result = freeBusy(
			feed(event("UID:phase-crossing", `DTSTART:${start}`, "DURATION:PT1S", `RRULE:${rule}`)),
			bounds("2026-01-01T00:00Z", "2026-01-05T00:00Z"),
			"UTC",
		);
		expect(result).toEqual(intervals(expected, 1));
	},
);
it("sorts and deduplicates lower numeric expansions without changing their set positions", () => {
	expect(
		read(
			"20260101T004530Z",
			"FREQ=HOURLY;BYHOUR=2,0,1;BYMINUTE=45,15,45;BYSECOND=30,0;BYSETPOS=-1;COUNT=3",
			"2026-01-01T00:00Z",
			"2026-01-01T04:00Z",
		),
	).toEqual(intervals(["2026-01-01T00:45:30Z", "2026-01-01T01:45:30Z", "2026-01-01T02:45:30Z"]));
});
