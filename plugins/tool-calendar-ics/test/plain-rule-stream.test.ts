import ICAL from "ical.js";
import { expect, it } from "vitest";
import { CalendarError, freeBusy } from "../src/index.ts";
import { recurrenceIterator } from "../src/recurrence.ts";
import { event, feed } from "./helpers.ts";

interface RuleCase {
	readonly name: string;
	readonly start: string;
	readonly rule: string;
	readonly times: readonly string[];
	readonly extra?: readonly string[];
	readonly from?: string;
	readonly to?: string;
}
const cases: readonly RuleCase[] = [
	{
		name: "hourly-interval-two",
		start: "20260101T000000Z",
		rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=0,1,2,3,4;COUNT=3",
		times: ["2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z", "2026-01-01T04:00:00Z"],
	},
	{
		name: "secondly-interval-thirty",
		start: "20260101T000000Z",
		rule: "FREQ=SECONDLY;INTERVAL=30;BYSECOND=0,15,30,45;COUNT=3",
		times: ["2026-01-01T00:00:00Z", "2026-01-01T00:00:30Z", "2026-01-01T00:01:00Z"],
	},
	{
		name: "minutely-interval-default-seconds",
		start: "20260101T001537Z",
		rule: "FREQ=MINUTELY;INTERVAL=90;BYMINUTE=15,45;COUNT=3",
		times: ["2026-01-01T00:15:37Z", "2026-01-01T01:45:37Z", "2026-01-01T03:15:37Z"],
	},
	{
		name: "hourly-interval-default-lower",
		start: "20260101T001737Z",
		rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=0,1,2,3,4;COUNT=3",
		times: ["2026-01-01T00:17:37Z", "2026-01-01T02:17:37Z", "2026-01-01T04:17:37Z"],
	},
	{
		name: "hourly-interval-until-inclusive",
		start: "20260101T000000Z",
		rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=0,1,2,3,4;UNTIL=20260101T040000Z",
		times: ["2026-01-01T00:00:00Z", "2026-01-01T02:00:00Z", "2026-01-01T04:00:00Z"],
	},
	{
		name: "count-exdate-rdate",
		start: "20260101T000000Z",
		rule: "FREQ=HOURLY;INTERVAL=2;BYHOUR=0,1,2,3,4;COUNT=3",
		times: ["2026-01-01T00:00:00Z", "2026-01-01T04:00:00Z", "2026-01-01T07:00:00Z"],
		extra: ["EXDATE:20260101T020000Z", "RDATE:20260101T070000Z"],
	},
	{
		name: "unsorted-later-day-window",
		start: "20260101T020000Z",
		rule: "FREQ=DAILY;BYHOUR=3,2;COUNT=4",
		times: ["2026-01-02T02:00:00Z"],
		from: "2026-01-02T02:00Z",
		to: "2026-01-02T02:01Z",
	},
	{
		name: "daily-phase-defaults-control",
		start: "20260101T091737Z",
		rule: "FREQ=DAILY;INTERVAL=2;COUNT=3",
		times: ["2026-01-01T09:17:37Z", "2026-01-03T09:17:37Z", "2026-01-05T09:17:37Z"],
		to: "2026-01-06T00:00Z",
	},
	{
		name: "monthly-native-control",
		start: "20260115T091737Z",
		rule: "FREQ=MONTHLY;INTERVAL=2;COUNT=3",
		times: ["2026-01-15T09:17:37Z", "2026-03-15T09:17:37Z", "2026-05-15T09:17:37Z"],
		to: "2026-06-01T00:00Z",
	},
	{
		name: "yearly-native-control",
		start: "20260115T091737Z",
		rule: "FREQ=YEARLY;INTERVAL=2;COUNT=3",
		times: ["2026-01-15T09:17:37Z", "2028-01-15T09:17:37Z", "2030-01-15T09:17:37Z"],
		to: "2031-01-01T00:00Z",
	},
	{
		name: "secondly-nondivisor-minute-subset",
		start: "20260101T000000Z",
		rule: "FREQ=SECONDLY;INTERVAL=17;BYSECOND=0,8,17,25,34,42,51,59;COUNT=8",
		times: [
			"2026-01-01T00:00:00Z",
			"2026-01-01T00:00:17Z",
			"2026-01-01T00:00:34Z",
			"2026-01-01T00:00:51Z",
			"2026-01-01T00:01:08Z",
			"2026-01-01T00:01:25Z",
			"2026-01-01T00:01:42Z",
			"2026-01-01T00:01:59Z",
		],
	},
	{
		name: "minutely-nondivisor-hour-subset",
		start: "20260101T000037Z",
		rule: "FREQ=MINUTELY;INTERVAL=7;BYMINUTE=0,15,30,45;COUNT=5",
		times: [
			"2026-01-01T00:00:37Z",
			"2026-01-01T01:45:37Z",
			"2026-01-01T03:30:37Z",
			"2026-01-01T05:15:37Z",
			"2026-01-01T07:00:37Z",
		],
	},
	{
		name: "hourly-nondivisor-day-subset",
		start: "20260101T091737Z",
		rule: "FREQ=HOURLY;INTERVAL=25;BYHOUR=9,10;COUNT=3",
		times: ["2026-01-01T09:17:37Z", "2026-01-02T10:17:37Z", "2026-01-26T09:17:37Z"],
		to: "2026-01-27T00:00Z",
	},
	{
		name: "weekly-phase-weekstart-control",
		start: "20260104T091737Z",
		rule: "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SU,SA;COUNT=4",
		times: [
			"2026-01-04T09:17:37Z",
			"2026-01-10T09:17:37Z",
			"2026-01-18T09:17:37Z",
			"2026-01-24T09:17:37Z",
		],
		to: "2026-01-25T00:00Z",
	},
];

it.each(cases)("plain RRULE $name", (test) => {
	const actual = freeBusy(
		feed(
			event(
				"UID:plain-rule",
				`DTSTART:${test.start}`,
				"DURATION:PT1S",
				`RRULE:${test.rule}`,
				...(test.extra ?? []),
			),
		),
		{
			start: Date.parse(test.from ?? "2026-01-01T00:00Z"),
			end: Date.parse(test.to ?? "2026-01-02T00:00Z"),
		},
		"UTC",
	);
	expect(actual).toEqual({
		busy: test.times.map((start) => ({
			start: Date.parse(start),
			end: Date.parse(start) + 1000,
			status: "busy",
		})),
	});
});

it("charges rejected plain-rule phase candidates to the raw global-work callback", () => {
	const component = new ICAL.Component(
		ICAL.parse(
			event(
				"UID:plain-budget",
				"DTSTART:20260101T000000Z",
				"RRULE:FREQ=SECONDLY;INTERVAL=17;BYSECOND=0,1,2,3,17;COUNT=2",
			),
		),
	);
	let calls = 0;
	const iterator = recurrenceIterator(new ICAL.Event(component), () => {
		if (++calls > 3) throw new CalendarError("RESOURCE_LIMIT");
	});
	expect(iterator.next()?.toString()).toBe("2026-01-01T00:00:00Z");
	expect(() => iterator.next()).toThrow(new CalendarError("RESOURCE_LIMIT"));
	expect(calls).toBe(4);
});

it("keeps private fields out of plain-rule public freebusy results", () => {
	const canary = "PRIVATE CALENDAR DETAILS";
	const result = freeBusy(
		feed(
			event(
				"UID:plain-private",
				"DTSTART:20260101T000000Z",
				"DURATION:PT1S",
				"RRULE:FREQ=HOURLY;INTERVAL=2;BYHOUR=0,1,2;COUNT=2",
				`SUMMARY:${canary}`,
				`DESCRIPTION:${canary}`,
				`LOCATION:${canary}`,
				"ATTENDEE:mailto:synthetic@example.test",
			),
		),
		{ start: Date.parse("2026-01-01T00:00Z"), end: Date.parse("2026-01-01T03:00Z") },
		"UTC",
	);
	expect(result).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-01T00:00Z"),
				end: Date.parse("2026-01-01T00:00:01Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-01T02:00Z"),
				end: Date.parse("2026-01-01T02:00:01Z"),
				status: "busy",
			},
		],
	});
	expect(JSON.stringify(result)).not.toContain(canary);
	expect(JSON.stringify(result)).not.toContain("example.test");
});
