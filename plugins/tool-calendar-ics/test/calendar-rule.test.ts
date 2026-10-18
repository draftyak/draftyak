import ICAL from "ical.js";
import { expect, it } from "vitest";
import { calendarRuleCandidates } from "../src/calendar-rule.ts";
import { CalendarError } from "../src/error.ts";
import { recurrenceIterator } from "../src/recurrence.ts";
import { event, expectCode } from "./helpers.ts";

it.each(["MONTHLY", "YEARLY"])("keeps %s time expansion lazy under COUNT", (frequency) => {
	const source = new ICAL.Event(
		new ICAL.Component(
			ICAL.parse(
				event(
					"DTSTART:20260101T000000Z",
					`RRULE:FREQ=${frequency};COUNT=1;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(",")};BYMINUTE=${Array.from({ length: 60 }, (_, i) => i).join(",")};BYSECOND=${Array.from({ length: 60 }, (_, i) => i).join(",")}`,
				),
			),
		),
	);
	let work = 0;
	const stream = recurrenceIterator(source, () => {
		if (++work > 3) throw new CalendarError("RESOURCE_LIMIT");
	});
	expect(stream.next()?.toString()).toBe("2026-01-01T00:00:00Z");
	expect(stream.next()).toBeNull();
	expect(work).toBe(3);
});

it("charges rejected calendar dates before any candidate can be returned", () => {
	let work = 0;
	const stream = calendarRuleCandidates(
		ICAL.Time.fromString("2026-01-01T09:00:00Z", undefined),
		ICAL.Recur.fromString("FREQ=MONTHLY;INTERVAL=12;BYMONTH=2;BYDAY=MO"),
		() => {
			if (++work > 10) throw new CalendarError("RESOURCE_LIMIT");
		},
	);
	expectCode(() => stream.next(), "RESOURCE_LIMIT");
	expect(work).toBe(11);
});

it.each(["MONTHLY", "YEARLY"])(
	"selects positions from the complete first natural %s interval",
	(frequency) => {
		const stream = calendarRuleCandidates(
			ICAL.Time.fromString("2026-01-15T09:00:00Z", undefined),
			ICAL.Recur.fromString(`FREQ=${frequency};BYMONTH=1;BYDAY=TH;BYSETPOS=1,-1`),
			() => {},
		);
		expect(stream.next().value?.toString()).toBe("2026-01-01T09:00:00Z");
		expect(stream.next().value?.toString()).toBe("2026-01-29T09:00:00Z");
	},
);

it.each(["MONTHLY", "YEARLY"])("refuses %s arithmetic outside the supported date range", (freq) => {
	const source = new ICAL.Event(
		new ICAL.Component(ICAL.parse(event("DTSTART:99991231T090000Z", `RRULE:FREQ=${freq};COUNT=2`))),
	);
	const stream = recurrenceIterator(source, () => {});
	expect(stream.next()?.toString()).toBe("9999-12-31T09:00:00Z");
	expectCode(() => stream.next(), "RESOURCE_LIMIT");
});
