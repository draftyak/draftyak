import ICAL from "ical.js";
import { afterEach, expect, it, vi } from "vitest";
import { freeBusy } from "../src/index.ts";
import { event, feed } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());
const bounds = (start: string, end: string) => ({ start: Date.parse(start), end: Date.parse(end) });

it.each([
	[
		"New York hour gap",
		"America/New_York",
		"20260308T014500",
		45,
		"2026-03-08T07:10:00Z",
		"2026-03-08T07:20:00Z",
		"2026-03-08T07:15:00Z",
	],
	[
		"Berlin hour gap",
		"Europe/Berlin",
		"20260329T014500",
		45,
		"2026-03-29T01:10:00Z",
		"2026-03-29T01:20:00Z",
		"2026-03-29T01:15:00Z",
	],
	[
		"Lord Howe half-hour gap",
		"Australia/Lord_Howe",
		"20261004T015500",
		20,
		"2026-10-03T15:35:00Z",
		"2026-10-03T15:40:00Z",
		"2026-10-03T15:35:00Z",
	],
] as const)(
	"retains a later wall occurrence that moves back into the UTC window: %s",
	(_name, zone, start, interval, from, to, busyStart) => {
		const result = freeBusy(
			feed(
				event(
					"UID:gap-cutoff",
					`DTSTART;TZID=${zone}:${start}`,
					"DURATION:PT10M",
					`RRULE:FREQ=MINUTELY;INTERVAL=${interval};COUNT=4`,
				),
			),
			bounds(from, to),
			zone,
		);
		expect(result).toEqual({
			busy: [{ start: Date.parse(busyStart), end: Date.parse(to), status: "busy" }],
		});
	},
);

it("does not terminate at a UTC RDATE while a pending named-zone rule can move back into the window", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:mixed-cutoff",
				"DTSTART;TZID=America/New_York:20260308T014500",
				"DURATION:PT10M",
				"RRULE:FREQ=MINUTELY;INTERVAL=45;COUNT=4",
				"RDATE:20260308T072000Z",
			),
		),
		bounds("2026-03-08T07:10:00Z", "2026-03-08T07:20:00Z"),
		"America/New_York",
	);
	expect(result).toEqual({
		busy: [
			{
				start: Date.parse("2026-03-08T07:15:00Z"),
				end: Date.parse("2026-03-08T07:20:00Z"),
				status: "busy",
			},
		],
	});
});

it("covers a full skipped local day without assuming an hour-sized transition", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:skipped-day",
				"DTSTART;TZID=Pacific/Apia:20111229T230000",
				"DURATION:PT10M",
				"RRULE:FREQ=HOURLY;INTERVAL=18;COUNT=4",
			),
		),
		bounds("2011-12-30T20:55:00Z", "2011-12-30T21:05:00Z"),
		"Pacific/Apia",
	);
	expect(result).toEqual({
		busy: [
			{
				start: Date.parse("2011-12-30T21:00:00Z"),
				end: Date.parse("2011-12-30T21:05:00Z"),
				status: "busy",
			},
		],
	});
});

it("retains named-zone RDATEs in an otherwise UTC recurrence set", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:named-rdate",
				"DTSTART:20260308T060000Z",
				"DURATION:PT10M",
				"RRULE:FREQ=HOURLY;COUNT=1",
				"RDATE;TZID=America/New_York:20260308T023000,20260308T031500",
			),
		),
		bounds("2026-03-08T07:10:00Z", "2026-03-08T07:20:00Z"),
		"UTC",
	);
	expect(result).toEqual({
		busy: [
			{
				start: Date.parse("2026-03-08T07:15:00Z"),
				end: Date.parse("2026-03-08T07:20:00Z"),
				status: "busy",
			},
		],
	});
});

it("keeps exact early termination for an unbounded UTC-only recurrence", () => {
	const next = vi.spyOn(ICAL.RecurIterator.prototype, "next");
	const from = "2026-01-01T00:00:00Z",
		to = "2026-01-01T00:00:03Z";
	const result = freeBusy(
		feed(
			event("UID:utc-cutoff", "DTSTART:20260101T000000Z", "DURATION:PT1S", "RRULE:FREQ=SECONDLY"),
		),
		bounds(from, to),
		"UTC",
	);
	expect(result).toEqual({
		busy: [{ start: Date.parse(from), end: Date.parse(to), status: "busy" }],
	});
	expect(next).toHaveBeenCalledTimes(4);
});
