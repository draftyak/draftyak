import { afterEach, describe, expect, it, vi } from "vitest";
import { freeBusy, mergeBusy } from "../src/index.ts";
import { assertOutputSize } from "../src/result.ts";
import {
	canary,
	event,
	expectCode,
	feed,
	privateFields,
	read,
	stamp,
	utf8,
	window,
} from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("input and privacy", () => {
	it("returns the content-free wire shape and clips to the half-open UTC window", () => {
		const log = vi.spyOn(console, "log");
		const warn = vi.spyOn(console, "warn");
		const error = vi.spyOn(console, "error");
		const result = read(
			feed(
				event(
					"UID:clipped",
					"DTSTART:20251231T230000Z",
					"DTEND:20260101T010000Z",
					...privateFields,
				),
				event("UID:touch-left", "DTSTART:20251231T220000Z", "DTEND:20260101T000000Z"),
				event("UID:touch-right", "DTSTART:20260108T000000Z", "DTEND:20260108T010000Z"),
			),
		);
		expect(result).toEqual({
			busy: [
				{
					start: Date.parse("2026-01-01T00:00:00.000Z"),
					end: Date.parse("2026-01-01T01:00:00.000Z"),
					status: "busy",
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain(canary);
		expect(log).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it("accepts an empty calendar", () => expect(read(feed())).toEqual({ busy: [] }));

	it.each([
		{ start: Number.NaN, end: window.end },
		{ start: window.start, end: Number.POSITIVE_INFINITY },
		{ start: window.start, end: window.start },
		{ start: window.end, end: window.start },
	])("rejects an invalid window", (bounds) =>
		expectCode(() => freeBusy(feed(), bounds, "UTC"), "INVALID_INPUT"),
	);

	it("requires Temporal even for UTC events", () => {
		vi.stubGlobal("Temporal", undefined);
		expectCode(() => read(feed()), "TEMPORAL_UNAVAILABLE");
	});

	it("fails closed on unknown owner zones and event TZIDs", () => {
		expectCode(() => read(feed(), "Unknown/Private"), "UNKNOWN_TIME_ZONE");
		expectCode(
			() =>
				read(
					feed(
						event(
							"UID:windows",
							"DTSTART;TZID=Eastern Standard Time:20260101T090000",
							"DURATION:PT1H",
							...privateFields,
						),
					),
				),
			"UNKNOWN_TIME_ZONE",
		);
	});

	it("sanitizes parse errors rather than exposing private property values", () => {
		expectCode(() => read(feed(event(`DTSTART:${canary}`, ...privateFields))), "INVALID_FEED");
	});

	it("unfolds property values and UTF-8 byte sequences split across folds", () => {
		const bytes = Buffer.concat([
			Buffer.from(
				`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:fold\r\nDTSTART:20260101T09\r\n 0000Z\r\nDURATION:PT1H\r\nSUMMARY:${canary} caf`,
			),
			Buffer.from([0xc3, 13, 10, 32, 0xa9]),
			Buffer.from(`\r\n ${canary}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`),
		]);
		const result = read(bytes);
		expect(result.busy).toEqual([
			{
				start: Date.parse("2026-01-01T09:00:00.000Z"),
				end: Date.parse("2026-01-01T10:00:00.000Z"),
				status: "busy",
			},
		]);
		expect(JSON.stringify(result)).not.toContain(canary);
	});
});

describe("event rules", () => {
	it("drops transparent and cancelled events; tentative remains tentative", () => {
		const result = read(
			feed(
				event("UID:transparent", "DTSTART:20260101T010000Z", "DURATION:PT1H", "TRANSP:TRANSPARENT"),
				event("UID:cancelled", "DTSTART:20260101T030000Z", "DURATION:PT1H", "STATUS:CANCELLED"),
				event("UID:tentative", "DTSTART:20260101T050000Z", "DURATION:PT1H", "STATUS:TENTATIVE"),
			),
		);
		expect(result.busy).toEqual([
			{
				start: Date.parse("2026-01-01T05:00:00.000Z"),
				end: Date.parse("2026-01-01T06:00:00.000Z"),
				status: "tentative",
			},
		]);
	});

	it("treats status and transparency tokens case-insensitively", () => {
		expect(
			read(
				feed(
					event(
						"UID:lowercase-cancel",
						"DTSTART:20260101T010000Z",
						"DURATION:PT1H",
						"STATUS:cancelled",
					),
					event(
						"UID:lowercase-transparent",
						"DTSTART:20260101T030000Z",
						"DURATION:PT1H",
						"TRANSP:transparent",
					),
					event(
						"UID:lowercase-tentative",
						"DTSTART:20260101T050000Z",
						"DURATION:PT1H",
						"STATUS:tentative",
					),
				),
			).busy,
		).toEqual([
			{
				start: Date.parse("2026-01-01T05:00:00.000Z"),
				end: Date.parse("2026-01-01T06:00:00.000Z"),
				status: "tentative",
			},
		]);
	});

	it("keeps an opaque override of a transparent recurring master", () => {
		expect(
			read(
				feed(
					event(
						"UID:transparent-master",
						"DTSTART:20260101T090000Z",
						"DURATION:PT1H",
						"RRULE:FREQ=DAILY;COUNT=2",
						"TRANSP:TRANSPARENT",
					),
					event(
						"UID:transparent-master",
						"RECURRENCE-ID:20260102T090000Z",
						"DTSTART:20260102T120000Z",
						"DURATION:PT1H",
						"TRANSP:OPAQUE",
					),
				),
			).busy,
		).toEqual([
			{
				start: Date.parse("2026-01-02T12:00:00.000Z"),
				end: Date.parse("2026-01-02T13:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it("merges touching, overlapping and nested intervals without mutating input", () => {
		const intervals = [
			{ start: 4, end: 8, status: "tentative" as const },
			{ start: 1, end: 4, status: "tentative" as const },
			{ start: 2, end: 3, status: "busy" as const },
			{ start: 9, end: 10, status: "tentative" as const },
		];
		const before = structuredClone(intervals);
		expect(mergeBusy(intervals)).toEqual([
			{ start: 1, end: 8, status: "busy" },
			{ start: 9, end: 10, status: "tentative" },
		]);
		expect(intervals).toEqual(before);
	});

	it("interprets all-day exclusive ends and implicit days in the owner's zone", () => {
		const result = read(
			feed(
				event("UID:two-days", "DTSTART;VALUE=DATE:20260101", "DTEND;VALUE=DATE:20260103"),
				event("UID:one-day", "DTSTART;VALUE=DATE:20260104"),
			),
			"America/New_York",
		);
		expect(result.busy).toEqual([
			{
				start: Date.parse("2026-01-01T05:00:00.000Z"),
				end: Date.parse("2026-01-03T05:00:00.000Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-04T05:00:00.000Z"),
				end: Date.parse("2026-01-05T05:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it("omits zero-length date-time events and uses the owner's zone for floating times", () => {
		expect(
			read(
				feed(
					event("UID:zero", "DTSTART:20260101T010000Z"),
					event("UID:float", "DTSTART:20260101T090000", "DTEND:20260101T100000"),
				),
				"America/New_York",
			).busy,
		).toEqual([
			{
				start: Date.parse("2026-01-01T14:00:00.000Z"),
				end: Date.parse("2026-01-01T15:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it("combines RRULE, RDATE, EXDATE, moved and cancelled overrides", () => {
		const result = read(
			feed(
				event(
					"UID:series",
					"DTSTART:20260101T090000Z",
					"DURATION:PT1H",
					"RRULE:FREQ=DAILY;COUNT=4",
					"RDATE:20260106T090000Z",
					"EXDATE:20260102T090000Z",
				),
				event(
					"UID:series",
					"RECURRENCE-ID:20260103T090000Z",
					"DTSTART:20260103T120000Z",
					"DURATION:PT2H",
					"STATUS:TENTATIVE",
				),
				event(
					"UID:series",
					"RECURRENCE-ID:20260104T090000Z",
					"DTSTART:20260104T090000Z",
					"STATUS:CANCELLED",
				),
			),
		);
		expect(result.busy).toEqual([
			{
				start: Date.parse("2026-01-01T09:00:00.000Z"),
				end: Date.parse("2026-01-01T10:00:00.000Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-03T12:00:00.000Z"),
				end: Date.parse("2026-01-03T14:00:00.000Z"),
				status: "tentative",
			},
			{
				start: Date.parse("2026-01-06T09:00:00.000Z"),
				end: Date.parse("2026-01-06T10:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it("includes overrides moved into the window from later recurrence dates", () => {
		expect(
			read(
				feed(
					event(
						"UID:future",
						"DTSTART:20260110T090000Z",
						"DURATION:PT1H",
						"RRULE:FREQ=DAILY;COUNT=3",
					),
					event(
						"UID:future",
						"RECURRENCE-ID:20260111T090000Z",
						"DTSTART:20260102T090000Z",
						"DURATION:PT1H",
					),
				),
			).busy,
		).toEqual([
			{
				start: Date.parse("2026-01-02T09:00:00.000Z"),
				end: Date.parse("2026-01-02T10:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it("suppresses the original instance when its override moves outside the window", () => {
		expect(
			read(
				feed(
					event(
						"UID:moved-out",
						"DTSTART:20260101T090000Z",
						"DURATION:PT1H",
						"RRULE:FREQ=DAILY;COUNT=1",
					),
					event(
						"UID:moved-out",
						"RECURRENCE-ID:20260101T090000Z",
						"DTSTART:20260110T090000Z",
						"DURATION:PT1H",
					),
				),
			),
		).toEqual({ busy: [] });
	});

	it("includes an overlapping occurrence whose start precedes the window", () => {
		expect(
			read(
				feed(
					event(
						"UID:overlap",
						"DTSTART:20251231T230000Z",
						"DURATION:PT2H",
						"RRULE:FREQ=DAILY;COUNT=2",
					),
				),
			).busy,
		).toEqual([
			{
				start: Date.parse("2026-01-01T00:00:00.000Z"),
				end: Date.parse("2026-01-01T01:00:00.000Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-01T23:00:00.000Z"),
				end: Date.parse("2026-01-02T01:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it("includes DTSTART when recurrence uses only RDATE", () => {
		expect(
			read(
				feed(
					event(
						"UID:rdate-only",
						"DTSTART:20260101T090000Z",
						"DURATION:PT1H",
						"RDATE:20260103T090000Z",
					),
				),
			).busy,
		).toEqual([
			{
				start: Date.parse("2026-01-01T09:00:00.000Z"),
				end: Date.parse("2026-01-01T10:00:00.000Z"),
				status: "busy",
			},
			{
				start: Date.parse("2026-01-03T09:00:00.000Z"),
				end: Date.parse("2026-01-03T10:00:00.000Z"),
				status: "busy",
			},
		]);
	});

	it.each([
		[
			"DTEND exact duration",
			"DTEND;TZID=America/New_York:20260308T120000",
			"2026-03-08T16:00:00.000Z",
			"2026-03-10T15:00:00.000Z",
		],
		[
			"DURATION nominal days",
			"DURATION:P1D",
			"2026-03-08T16:00:00.000Z",
			"2026-03-10T16:00:00.000Z",
		],
		[
			"DURATION elapsed hours",
			"DURATION:PT24H",
			"2026-03-08T17:00:00.000Z",
			"2026-03-10T16:00:00.000Z",
		],
	])("preserves %s across DST", (_name, duration, firstEnd, secondEnd) => {
		const result = freeBusy(
			feed(
				event(
					"UID:duration-dst",
					"DTSTART;TZID=America/New_York:20260307T120000",
					duration,
					"RRULE:FREQ=DAILY;INTERVAL=2;COUNT=2",
				),
			),
			{ start: Date.parse("2026-03-06T00:00:00Z"), end: Date.parse("2026-03-12T00:00:00Z") },
			"America/New_York",
		);
		expect(result.busy).toEqual([
			{ start: Date.parse("2026-03-07T17:00:00.000Z"), end: Date.parse(firstEnd), status: "busy" },
			{ start: Date.parse("2026-03-09T16:00:00.000Z"), end: Date.parse(secondEnd), status: "busy" },
		]);
	});

	it("adds accurate hours across a nonexistent wall time", () => {
		const result = freeBusy(
			feed(
				event("UID:gap-duration", "DTSTART;TZID=America/New_York:20260308T013000", "DURATION:PT2H"),
			),
			{ start: Date.parse("2026-03-08T00:00:00Z"), end: Date.parse("2026-03-09T00:00:00Z") },
			"America/New_York",
		);
		expect(result.busy).toEqual([
			{
				start: Date.parse("2026-03-08T06:30:00.000Z"),
				end: Date.parse("2026-03-08T08:30:00.000Z"),
				status: "busy",
			},
		]);
	});
});

describe("malformed and unsupported feeds", () => {
	it.each(["+9900", "+1260", "-0000", "+123060"])(
		"rejects malformed feed zone offset %s",
		(offset) => {
			const zone = [
				"BEGIN:VTIMEZONE",
				"TZID:Synthetic/Offset",
				"BEGIN:STANDARD",
				"DTSTART:19700101T000000",
				`TZOFFSETFROM:${offset}`,
				`TZOFFSETTO:${offset}`,
				"END:STANDARD",
				"END:VTIMEZONE",
			].join("\r\n");
			expectCode(() => read(feed(zone)), "INVALID_FEED");
		},
	);
	it.each([
		"FREQ=DAILY;COUNT=0",
		"FREQ=DAILY;INTERVAL=0",
		"FREQ=DAILY;FREQ=WEEKLY;COUNT=2",
		"FREQ=DAILY;UNRECOGNIZED=1;COUNT=2",
		"FREQ=DAILY;BYSECOND=61;COUNT=2",
		"FREQ=DAILY;BYMINUTE=60;COUNT=2",
		"FREQ=DAILY;BYHOUR=24;COUNT=2",
		"FREQ=DAILY;BYMONTHDAY=0;COUNT=2",
		"FREQ=DAILY;BYMONTH=13;COUNT=2",
		"FREQ=DAILY;COUNT=2;UNTIL=20260103T090000Z",
	])("rejects invalid recurrence parts: %s", (rule) =>
		expectCode(
			() =>
				read(
					feed(event("UID:raw-rule", "DTSTART:20260101T090000Z", "DURATION:PT1H", `RRULE:${rule}`)),
				),
			"INVALID_FEED",
		),
	);
	it.each([
		["missing calendar", "BEGIN:VEVENT\r\nDTSTART:20260101T090000Z\r\nEND:VEVENT"],
		[
			"unclosed component",
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:20260101T090000Z\r\nEND:VCALENDAR",
		],
		[
			"trailing calendar",
			"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR",
		],
	])("rejects %s framing", (_name, text) => expectCode(() => read(utf8(text)), "INVALID_FEED"));
	it("rejects malformed UTF-8", () =>
		expectCode(() => read(new Uint8Array([0xc0, 0xaf])), "INVALID_FEED"));
	it.each([
		["invalid calendar date", ["DTSTART:20260230T090000Z", "DURATION:PT1H"]],
		["negative duration", ["DTSTART:20260101T090000Z", "DURATION:-PT1H"]],
		["inverted end", ["DTSTART:20260101T100000Z", "DTEND:20260101T090000Z"]],
		["duplicate start", ["DTSTART:20260101T090000Z", "DTSTART:20260101T100000Z"]],
		["end and duration", ["DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", "DURATION:PT1H"]],
		["mixed date types", ["DTSTART;VALUE=DATE:20260101", "DTEND:20260102T000000Z"]],
		[
			"EXRULE",
			[
				"DTSTART:20260101T090000Z",
				"DURATION:PT1H",
				"RRULE:FREQ=DAILY;COUNT=2",
				"EXRULE:FREQ=DAILY;COUNT=1",
			],
		],
		[
			"RDATE PERIOD",
			[
				"DTSTART:20260101T090000Z",
				"DURATION:PT1H",
				"RDATE;VALUE=PERIOD:20260102T090000Z/20260102T100000Z",
			],
		],
		[
			"recurrence RANGE",
			[
				"DTSTART:20260101T090000Z",
				"DURATION:PT1H",
				"RECURRENCE-ID;RANGE=THISANDFUTURE:20260101T090000Z",
			],
		],
	])("rejects %s rather than treating unsupported time as free", (_name, properties) =>
		expectCode(
			() => read(feed(event("UID:invalid", ...properties, ...privateFields))),
			"INVALID_FEED",
		),
	);
});

describe("limits", () => {
	const disjoint = (count: number): Uint8Array =>
		feed(
			...Array.from({ length: count }, (_, i) =>
				event(`UID:limit-${i}`, `DTSTART:${stamp(window.start + i * 120_000)}`, "DURATION:PT1M"),
			),
		);
	it("accepts 200 intervals within the 20,480-byte wire ceiling", () => {
		const result = read(disjoint(200));
		expect(result.busy).toHaveLength(200);
		expect(utf8(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(20_480);
	});
	it("fails instead of truncating the 201st disjoint interval", () =>
		expectCode(() => read(disjoint(201)), "TOO_MANY_EVENTS"));
	it("enforces the byte ceiling independently of the interval ceiling", () => {
		expect(() => assertOutputSize(20_480)).not.toThrow();
		expectCode(() => assertOutputSize(20_481), "TOO_MANY_EVENTS");
	});
	it("rejects input over 32 MiB before parsing", () =>
		expectCode(() => read(new Uint8Array(32 * 1024 * 1024 + 1)), "FEED_TOO_LARGE"));
	it("bounds retained folded logical lines", () => {
		const folded = `UID:${canary}\r\n${" x\r\n".repeat(1_025)}`;
		expectCode(() => read(feed(event("DTSTART:20260101T090000Z", folded))), "RESOURCE_LIMIT");
	});
	it("accepts a 65,536-byte logical line and rejects one more byte", () => {
		const long = (length: number): Uint8Array =>
			feed(event(`UID:${"x".repeat(length - 4)}`, "DTSTART:20260101T090000Z", "DURATION:PT1H"));
		expect(read(long(65_536)).busy).toHaveLength(1);
		expectCode(() => read(long(65_537)), "RESOURCE_LIMIT");
	});
	it("accepts a 262,144-byte retained component and rejects one more byte", () => {
		const exclusions = `EXDATE:${Array.from({ length: 3_000 }, () => "20260102T090000Z").join(",")}`;
		const properties = [
			"DTSTART:20260101T090000Z",
			"DURATION:PT1H",
			...Array.from({ length: 3 }, () => exclusions),
			`STATUS:${"x".repeat(65_529)}`,
		];
		const baseSize = utf8(event(...properties, "UID:")).byteLength + 2;
		const sized = (bytes: number): Uint8Array =>
			feed(event(...properties, `UID:${"x".repeat(bytes - baseSize)}`));
		expect(read(sized(262_144)).busy).toHaveLength(1);
		expectCode(() => read(sized(262_145)), "RESOURCE_LIMIT");
	});
	it("counts 2,000 instances before merging and refuses the 2,001st", () => {
		const recurring = (count: number): Uint8Array =>
			feed(
				event(
					"UID:many-instances",
					"DTSTART:20260101T000000Z",
					"DURATION:PT2M",
					`RRULE:FREQ=MINUTELY;COUNT=${count}`,
				),
			);
		expect(read(recurring(2_000)).busy).toHaveLength(1);
		expectCode(() => read(recurring(2_001)), "TOO_MANY_INSTANCES");
	});
	it("does not spend the instance budget on transparent or cancelled series", () => {
		const bytes = feed(
			...["STATUS:CANCELLED", "TRANSP:TRANSPARENT"].map((drop, i) =>
				event(
					`UID:drop-${i}`,
					"DTSTART:20260101T000000Z",
					"DURATION:PT2M",
					"RRULE:FREQ=MINUTELY;COUNT=3000",
					drop,
				),
			),
		);
		expect(read(bytes)).toEqual({ busy: [] });
	});
});
