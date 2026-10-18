import { expect, it } from "vitest";
import { freeBusy } from "../src/index.ts";
import { event, feed } from "./helpers.ts";

it.each([
	{
		name: "monthly ordinal weekday and expanded hours",
		start: "20260105T090000Z",
		rule: "FREQ=MONTHLY;BYDAY=1MO;BYHOUR=9,10;COUNT=4",
		from: "2026-02-02T10:00:00Z",
		to: "2026-02-02T11:00:00Z",
	},
	{
		name: "monthly interval phase with a month filter",
		start: "20260105T090000Z",
		rule: "FREQ=MONTHLY;INTERVAL=2;BYMONTH=1,2;BYDAY=1MO;COUNT=3",
		from: "2028-01-03T09:00:00Z",
		to: "2028-01-03T10:00:00Z",
	},
	{
		name: "yearly week-number filtering",
		start: "20260105T090000Z",
		rule: "FREQ=YEARLY;BYWEEKNO=2;BYDAY=MO;COUNT=3",
		from: "2027-01-11T09:00:00Z",
		to: "2027-01-11T10:00:00Z",
	},
	{
		name: "invalid February dates do not consume yearly count",
		start: "20240229T090000Z",
		rule: "FREQ=YEARLY;BYMONTH=2,3;BYMONTHDAY=29;COUNT=4",
		from: "2026-03-29T09:00:00Z",
		to: "2026-03-29T10:00:00Z",
	},
	{
		name: "yearly negative month-day normalization",
		start: "20260131T090000Z",
		rule: "FREQ=YEARLY;BYMONTH=1,2;BYMONTHDAY=-1;COUNT=4",
		from: "2027-01-31T09:00:00Z",
		to: "2027-01-31T10:00:00Z",
	},
])("retains the occupied hour for $name", ({ start, rule, from, to }) => {
	const window = { start: Date.parse(from), end: Date.parse(to) };
	expect(
		freeBusy(
			feed(event("UID:review-rule", `DTSTART:${start}`, "DURATION:PT1H", `RRULE:${rule}`)),
			window,
			"UTC",
		),
	).toEqual({ busy: [{ start: Date.parse(from), end: Date.parse(to), status: "busy" }] });
});
