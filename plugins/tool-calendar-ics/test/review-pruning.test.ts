import { expect, it } from "vitest";
import { freeBusy } from "../src/index.ts";
import { event, expectCode, feed, utf8, window } from "./helpers.ts";

const current = event("UID:current", "DTSTART:20260102T090000Z", "DURATION:PT1H");
const expected = {
	busy: [
		{
			start: Date.parse("2026-01-02T09:00:00Z"),
			end: Date.parse("2026-01-02T10:00:00Z"),
			status: "busy",
		},
	],
};
const read = (...items: string[]) => freeBusy(feed(...items, current), window, "UTC");

it.each([
	["unknown past TZID", event("DTSTART;TZID=Unknown/Private:20150101T090000", "DURATION:PT1H")],
	["inverted past interval", event("DTSTART:20150102T090000Z", "DTEND:20150101T090000Z")],
	[
		"oversized discarded description",
		event("DTSTART:20150101T090000Z", "DURATION:PT1H", `DESCRIPTION:${"x".repeat(70_000)}`),
	],
	["future unknown TZID", event("DTSTART;TZID=Unknown/Private:20350101T090000", "DURATION:PT1H")],
	[
		"ended rule with unknown old TZID",
		event(
			"UID:ended",
			"DTSTART;TZID=Unknown/Private:20150101T090000",
			"DURATION:PT1H",
			"RRULE:FREQ=SECONDLY;UNTIL=20150102T090000Z",
		),
	],
	[
		"single ancient occurrence",
		event(
			"UID:once",
			"DTSTART;TZID=Unknown/Private:19000101T090000",
			"DURATION:PT1H",
			"RRULE:FREQ=SECONDLY;COUNT=1",
		),
	],
	[
		"old orphan override",
		event(
			"UID:orphan",
			"RECURRENCE-ID:20150101T090000Z",
			"DTSTART;TZID=Unknown/Private:20150102T090000",
			"DURATION:PT1H",
		),
	],
] as const)("prunes provably irrelevant %s before zone/strict event validation", (_name, item) => {
	expect(read(item)).toEqual(expected);
});

it.each(["VTODO", "VJOURNAL"])(
	"ignores %s properties without assembling discarded values",
	(kind) => {
		const ignored = [
			`BEGIN:${kind}`,
			`DTSTART:${"x".repeat(70_000)}`,
			`DESCRIPTION:${"y".repeat(70_000)}`,
			`END:${kind}`,
		].join("\r\n");
		expect(read(ignored)).toEqual(expected);
	},
);

it("ignores VALARM values and arbitrarily many folds in discarded properties", () => {
	const ignored = ["BEGIN:VALARM", `DTSTART:${"x".repeat(70_000)}`, "END:VALARM"].join("\r\n");
	const description = `DESCRIPTION:private${"\r\n private".repeat(2000)}`;
	expect(
		freeBusy(
			feed(event("DTSTART:20260102T090000Z", "DURATION:PT1H", description, ignored)),
			window,
			"UTC",
		),
	).toEqual(expected);
});

it("retains an orphan override as an actual standalone busy event", () => {
	expect(
		freeBusy(
			feed(
				event(
					"UID:orphan",
					"RECURRENCE-ID:20150101T090000Z",
					"DTSTART:20260102T090000Z",
					"DURATION:PT1H",
				),
			),
			window,
			"UTC",
		),
	).toEqual(expected);
});

it.each(["STATUS:CANCELLED", "TRANSP:TRANSPARENT"])("an orphan %s contributes nothing", (drop) => {
	expect(read(event("UID:orphan", "RECURRENCE-ID:20260101T090000Z", drop))).toEqual(expected);
});

it("refuses duplicate relevant orphan recurrence identifiers", () => {
	const item = event(
		"UID:orphan",
		"RECURRENCE-ID:20260101T090000Z",
		"DTSTART:20260102T090000Z",
		"DURATION:PT1H",
	);
	expectCode(() => read(item, item), "INVALID_FEED");
});

it("retains a moved-out override to suppress its still-relevant master occurrence", () => {
	expect(
		freeBusy(
			feed(
				event(
					"UID:series",
					"DTSTART:20260101T090000Z",
					"DURATION:PT1H",
					"RRULE:FREQ=DAILY;COUNT=2",
				),
				event(
					"UID:series",
					"RECURRENCE-ID:20260101T090000Z",
					"DTSTART:20150101T090000Z",
					"DURATION:PT1H",
				),
			),
			window,
			"UTC",
		),
	).toEqual(expected);
});

it("keeps RDATE after an ended RRULE without expanding its ancient dense stream", () => {
	expect(
		freeBusy(
			feed(
				event(
					"UID:dates",
					"DTSTART:19000101T090000Z",
					"DURATION:PT1H",
					"RRULE:FREQ=SECONDLY;UNTIL=19000102T090000Z",
					"RDATE:20260102T090000Z",
				),
			),
			window,
			"UTC",
		),
	).toEqual(expected);
});

it("does not prune a long recurrence duration reaching the current window", () => {
	const result = freeBusy(
		feed(
			event(
				"UID:long",
				"DTSTART:20150101T000000Z",
				"DURATION:P5000D",
				"RRULE:FREQ=DAILY;UNTIL=20150101T000000Z",
			),
		),
		window,
		"UTC",
	);
	expect(result).toEqual({ busy: [{ start: window.start, end: window.end, status: "busy" }] });
});

it("retains unknown zones within the conservative overlap slack and rejects malformed structure", () => {
	expectCode(
		() => read(event("DTSTART;TZID=Unknown/Private:20251231T000000", "DURATION:PT1H")),
		"UNKNOWN_TIME_ZONE",
	);
	expectCode(
		() =>
			freeBusy(utf8("DESCRIPTION:outside\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"), window, "UTC"),
		"INVALID_FEED",
	);
});
