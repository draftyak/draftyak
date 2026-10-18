import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import ICAL from "ical.js";
import { compute } from "../src/engine.ts";
import { FeedZone } from "../src/feed-zone.ts";
import { CalendarError, freeBusy } from "../src/index.ts";

const window = {
	start: Date.parse("2026-01-01T00:00:00Z"),
	end: Date.parse("2026-01-08T00:00:00Z"),
};
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const feed = (...parts: string[]) =>
	new TextEncoder().encode(
		["BEGIN:VCALENDAR", "VERSION:2.0", ...parts, "END:VCALENDAR", ""].join("\r\n"),
	);
const errorCode = (code: string) => (error: unknown) =>
	error instanceof CalendarError && error.code === code;
const results: { id: string; elapsedMs: number; calls?: number; bytes?: number }[] = [];
const run = (id: string, action: () => { calls?: number; bytes?: number } | undefined): void => {
	const start = performance.now();
	const detail = action();
	results.push({ id, elapsedMs: performance.now() - start, ...detail });
};

const zone = [
	"BEGIN:VTIMEZONE",
	"TZID:Unused/Fixed",
	"BEGIN:STANDARD",
	"DTSTART:19700101T000000",
	"TZOFFSETFROM:+0000",
	"TZOFFSETTO:+0000",
	"END:STANDARD",
	"END:VTIMEZONE",
].join("\r\n");
const components = (count: number): Uint8Array =>
	feed(
		zone,
		...Array.from({ length: count - 1 }, (_, index) =>
			event(
				`UID:kept-${index}`,
				"DTSTART:20251225T090000Z",
				"DURATION:PT1H",
				"RRULE:FREQ=WEEKLY;COUNT=2",
				"EXDATE:20260101T090000Z",
			),
		),
	);
run("public-5000-kept", () => {
	const bytes = components(5000);
	assert.deepEqual(freeBusy(bytes, window, "UTC"), { busy: [] });
	return { bytes: bytes.byteLength };
});
run("public-5001-refuses", () => {
	assert.throws(() => freeBusy(components(5001), window, "UTC"), errorCode("TOO_MANY_COMPONENTS"));
	return undefined;
});

// A provider-shaped long history is mostly discarded descriptions and obsolete events.
const privateText = "CALENDAR_PRIVATE_CANARY_7X9 ".repeat(105);
const privateHistory = Array.from({ length: 10_360 }, (_, index) =>
	event(
		`UID:old-${index}`,
		"DTSTART:20150101T090000Z",
		"DURATION:PT1H",
		`DESCRIPTION:${privateText}`,
		"SUMMARY:CALENDAR_PRIVATE_CANARY_7X9",
		"LOCATION:CALENDAR_PRIVATE_CANARY_7X9",
	),
);
const large = feed(
	...privateHistory,
	event("UID:current", "DTSTART:20260102T090000Z", "DURATION:PT1H"),
);
assert(large.byteLength >= 29 * 1024 * 1024 && large.byteLength < 32 * 1024 * 1024);
run("public-large-history", () => {
	assert.deepEqual(freeBusy(large, window, "UTC"), {
		busy: [
			{
				start: Date.parse("2026-01-02T09:00:00Z"),
				end: Date.parse("2026-01-02T10:00:00Z"),
				status: "busy",
			},
		],
	});
	return { bytes: large.byteLength };
});
run("remaining-deadline-independent-of-counts", () => {
	assert.throws(
		() => freeBusy(large, window, "UTC", { timeoutMs: 1 }),
		errorCode("RESOURCE_LIMIT"),
	);
	return { bytes: large.byteLength };
});

run("deadline-interrupts-single-library-call", () => {
	const next = ICAL.RecurIterator.prototype.next;
	ICAL.RecurIterator.prototype.next = () => {
		for (;;) Math.random();
	};
	try {
		assert.throws(
			() =>
				freeBusy(
					feed(
						event(
							"UID:stuck",
							"DTSTART:20260101T090000Z",
							"DURATION:PT1H",
							"RRULE:FREQ=DAILY;COUNT=2",
						),
					),
					window,
					"UTC",
					{ timeoutMs: 25 },
				),
			errorCode("RESOURCE_LIMIT"),
		);
	} finally {
		ICAL.RecurIterator.prototype.next = next;
	}
	return undefined;
});
run("deadline-interrupts-single-zone-call", () => {
	const offset = FeedZone.prototype.utcOffset;
	FeedZone.prototype.utcOffset = () => {
		for (;;) Math.random();
	};
	try {
		assert.throws(
			() =>
				freeBusy(
					feed(zone, event("DTSTART;TZID=Unused/Fixed:20260101T090000", "DURATION:PT1H")),
					window,
					"UTC",
					{ timeoutMs: 25 },
				),
			errorCode("RESOURCE_LIMIT"),
		);
	} finally {
		FeedZone.prototype.utcOffset = offset;
	}
	return undefined;
});

// Direct computation removes the VM deadline from this exact raw-call boundary proof.
for (const count of [100_000, 100_001])
	run(`raw-call-boundary-${count}`, () => {
		let calls = 0;
		const next = ICAL.RecurIterator.prototype.next;
		ICAL.RecurIterator.prototype.next = function () {
			calls++;
			return next.call(this);
		};
		try {
			const bytes = feed(
				event(
					"UID:work",
					"DTSTART:19000101T000000Z",
					"DURATION:PT0S",
					`RRULE:FREQ=SECONDLY;COUNT=${count}`,
				),
			);
			if (count === 100_000) assert.deepEqual(compute(bytes, window, "UTC"), { busy: [] });
			else assert.throws(() => compute(bytes, window, "UTC"), errorCode("RESOURCE_LIMIT"));
			assert.equal(calls, 100_000);
		} finally {
			ICAL.RecurIterator.prototype.next = next;
		}
		return { calls };
	});
assert.equal(results.length, 8);
assert(process.execArgv.includes("--disallow-code-generation-from-strings"));
assert(process.execArgv.includes("--max-old-space-size=256"));
console.log(
	JSON.stringify({
		cases: results.length,
		results,
		node: process.version,
		execArgv: process.execArgv,
	}),
);
