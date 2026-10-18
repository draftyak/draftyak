import { expect, it } from "vitest";
import { freeBusy } from "../src/index.ts";
import { event, expectCode, feed, stamp, window } from "./helpers.ts";

it.each([0, -1, 15_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
	"refuses invalid trusted remaining deadline %s",
	(timeoutMs) => expectCode(() => freeBusy(feed(), window, "UTC", { timeoutMs }), "INVALID_INPUT"),
);
it("preserves the three-argument API and accepts the full tool deadline", () => {
	expect(freeBusy(feed(), window, "UTC")).toEqual({ busy: [] });
	expect(freeBusy(feed(), window, "UTC", { timeoutMs: 15_000 })).toEqual({ busy: [] });
});

const dateList = (name: "EXDATE" | "RDATE", count: number): string[] =>
	Array.from(
		{ length: Math.ceil(count / 3000) },
		(_, index) =>
			`${name}:${Array.from({ length: Math.min(3000, count - index * 3000) }, () => "20260102T090000Z").join(",")}`,
	);
it.each(["EXDATE", "RDATE"] as const)("counts %s scalar values before deduplication", (name) => {
	const bytes = (count: number) =>
		feed(event("UID:dates", "DTSTART:20260101T090000Z", "DURATION:PT1H", ...dateList(name, count)));
	expect(freeBusy(bytes(10_000), window, "UTC").busy.length).toBe(name === "RDATE" ? 2 : 1);
	expectCode(() => freeBusy(bytes(10_001), window, "UTC"), "RESOURCE_LIMIT");
});
it("shares the retained date-list budget across components and both list kinds", () => {
	const bytes = (extra: number) =>
		feed(
			event("UID:first", "DTSTART:20260101T090000Z", "DURATION:PT1H", ...dateList("EXDATE", 6000)),
			event(
				"UID:second",
				"DTSTART:20260101T090000Z",
				"DURATION:PT1H",
				...dateList("RDATE", 4000 + extra),
			),
		);
	expect(freeBusy(bytes(0), window, "UTC").busy).toHaveLength(2);
	expectCode(() => freeBusy(bytes(1), window, "UTC"), "RESOURCE_LIMIT");
});

it("rejects impossible month/day rules before an unbounded library step", () => {
	for (const frequency of ["DAILY", "MONTHLY", "YEARLY"])
		expectCode(
			() =>
				freeBusy(
					feed(
						event(
							"UID:impossible",
							"DTSTART:20260101T090000Z",
							"DURATION:PT1H",
							`RRULE:FREQ=${frequency};BYMONTH=4;BYMONTHDAY=31`,
						),
					),
					window,
					"UTC",
				),
			"INVALID_FEED",
		);
});

const transitionFeed = (count: number): Uint8Array => {
	const dates = Array.from({ length: count - 1 }, (_, index) =>
		stamp(Date.parse("1970-01-01T00:00:00Z") + (index + 1) * 60_000).slice(0, -1),
	);
	const rows = Array.from(
		{ length: Math.ceil(dates.length / 3000) },
		(_, index) => `RDATE:${dates.slice(index * 3000, (index + 1) * 3000).join(",")}`,
	);
	const definition = [
		"BEGIN:VTIMEZONE",
		"TZID:Bounded/Zone",
		"BEGIN:STANDARD",
		"DTSTART:19700101T000000",
		"TZOFFSETFROM:+0100",
		"TZOFFSETTO:+0100",
		...rows,
		"END:STANDARD",
		"END:VTIMEZONE",
	].join("\r\n");
	return feed(definition, event("DTSTART;TZID=Bounded/Zone:20260102T090000", "DURATION:PT1H"));
};
it("bounds actual distinct feed transitions independently from retained date values", () => {
	expect(freeBusy(transitionFeed(10_000), window, "UTC").busy[0]?.start).toBe(
		Date.parse("2026-01-02T08:00Z"),
	);
	expectCode(() => freeBusy(transitionFeed(10_001), window, "UTC"), "RESOURCE_LIMIT");
});

it("counts dense YEARLY observance work before building an unbounded transition table", () => {
	const definition = [
		"BEGIN:VTIMEZONE",
		"TZID:Dense/Zone",
		"BEGIN:STANDARD",
		"DTSTART:19700101T000000",
		"TZOFFSETFROM:+0000",
		"TZOFFSETTO:+0100",
		`RRULE:FREQ=YEARLY;UNTIL=19700101T000000Z;BYMONTH=1;BYMONTHDAY=1;BYHOUR=${Array.from({ length: 24 }, (_, i) => i).join(",")};BYMINUTE=${Array.from({ length: 60 }, (_, i) => i).join(",")};BYSECOND=${Array.from({ length: 60 }, (_, i) => i).join(",")}`,
		"END:STANDARD",
		"END:VTIMEZONE",
	].join("\r\n");
	expectCode(
		() =>
			freeBusy(
				feed(definition, event("DTSTART;TZID=Dense/Zone:20260102T090000", "DURATION:PT1H")),
				window,
				"UTC",
			),
		"RESOURCE_LIMIT",
	);
});
