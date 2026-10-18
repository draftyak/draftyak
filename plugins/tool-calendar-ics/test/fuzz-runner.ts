import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toolKindsV1 } from "@draftyak/protocol/tool-v1/kinds";
import fc from "fast-check";
import { CalendarError, freeBusy } from "../src/index.ts";

const canary = "CALENDAR_PRIVATE_CANARY_7X9";
const bounds = {
	start: Date.parse("2026-01-01T00:00:00Z"),
	end: Date.parse("2026-01-08T00:00:00Z"),
};
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const clean = (bytes: Uint8Array, window = bounds, zone = "UTC"): void => {
	try {
		const result = freeBusy(bytes, window, zone);
		assert(toolKindsV1["calendar.freebusy"].result.safeParse(result).success);
		for (const item of result.busy) assert(item.start >= window.start && item.end <= window.end);
		assert(!/canary/i.test(JSON.stringify(result)));
	} catch (error) {
		assert(error instanceof CalendarError);
		assert(!/canary/i.test(JSON.stringify(error, Object.getOwnPropertyNames(error))));
	}
};
fc.assert(
	fc.property(fc.uint8Array({ maxLength: 1_024 }), (bytes) => clean(bytes)),
	{ numRuns: 150, seed: 7_111 },
);
fc.assert(
	fc.property(fc.string({ maxLength: 512 }), (text) =>
		clean(
			encode(
				`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:${canary}\r\n${text}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
			),
		),
	),
	{ numRuns: 150, seed: 7_112 },
);
// Mutate timing structure in otherwise valid feeds so parsing reaches recurrence and zones.
const corpus = new URL("../../../security/ics-corpus/", import.meta.url);
const samples = ["provider-google.json", "provider-outlook.json", "dst-new-york-gap.json"].map(
	(name) => {
		const item = JSON.parse(readFileSync(new URL(name, corpus), "utf8")) as {
			feed: string;
			window: { start: string; end: string };
			timeZone: string;
			expected: unknown;
		};
		return {
			item,
			text: readFileSync(new URL(item.feed, corpus), "utf8"),
			window: { start: Date.parse(item.window.start), end: Date.parse(item.window.end) },
		};
	},
);
for (const sample of samples)
	assert.deepEqual(
		freeBusy(encode(sample.text), sample.window, sample.item.timeZone),
		sample.item.expected,
	);
fc.assert(
	fc.property(
		fc.integer({ min: 0, max: samples.length - 1 }),
		fc.integer({ min: 0, max: 12 }),
		(index, mutation) => {
			const sample = samples[index];
			assert(sample);
			let text = sample.text.replace("BEGIN:VEVENT", `BEGIN:VEVENT\r\nDESCRIPTION:${canary}`);
			if (mutation === 1) text = text.replace(/DTSTART[^\r\n]*/, "$&\r\nDTSTART:20260230T090000Z");
			if (mutation === 2)
				text = text.replace("END:VEVENT", "RRULE:FREQ=DAILY;COUNT=4;BYHOUR=9,8,9\r\nEND:VEVENT");
			if (mutation === 3) text = text.replace(/TZOFFSETTO:[^\r\n]*/, "TZOFFSETTO:+2460");
			if (mutation === 4)
				text = text.replace("END:VEVENT", "RDATE:20260102T090000Z,20260102T090000Z\r\nEND:VEVENT");
			if (mutation === 5) text = text.replace(/DTSTART/, "DTST\r\n ART");
			if (mutation === 6)
				text = text.replace(
					"END:VEVENT",
					"EXDATE;VALUE=PERIOD:20260101T000000Z/PT1H\r\nEND:VEVENT",
				);
			if (mutation === 7) text = text.replace("END:VEVENT", "DTEND:20260102T100000Z\r\nEND:VEVENT");
			if (mutation === 8) text = text.replace("END:VEVENT", "DURATION:-PT1H\r\nEND:VEVENT");
			if (mutation === 9) text = text.replace(/TZID=[^;:\r\n]*/, "TZID=Unknown/Private");
			if (mutation === 10)
				text = text.replace("END:VEVENT", "RECURRENCE-ID:20260102T090000Z\r\nEND:VEVENT");
			if (mutation === 11)
				text = text.replace("END:STANDARD", "RRULE:FREQ=SECONDLY\r\nEND:STANDARD");
			if (mutation === 12)
				text = text.replace("END:DAYLIGHT", "RDATE:20260230T090000\r\nEND:DAYLIGHT");
			clean(encode(text), sample.window, sample.item.timeZone);
		},
	),
	{ numRuns: 150, seed: 7_113 },
);
const impossible = encode(
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:impossible\r\nDTSTART:20260101T000000Z\r\nDURATION:PT1M\r\nRRULE:FREQ=SECONDLY;INTERVAL=2;BYSECOND=1\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
);
assert.throws(
	() => freeBusy(impossible, bounds, "UTC"),
	(error: unknown) =>
		error instanceof CalendarError && ["RESOURCE_LIMIT", "TOO_MANY_INSTANCES"].includes(error.code),
);
const ancient = encode(
	"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ancient\r\nDTSTART:19000101T000000Z\r\nRRULE:FREQ=SECONDLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
);
assert.throws(
	() => freeBusy(ancient, bounds, "UTC"),
	(error: unknown) => error instanceof CalendarError && error.code === "RESOURCE_LIMIT",
);
assert(process.execArgv.includes("--disallow-code-generation-from-strings"));
assert(process.execArgv.includes("--max-old-space-size=256"));
console.log(
	JSON.stringify({
		bytes: 150,
		malformed: 150,
		structural: 150,
		positiveCorpus: samples.length,
		denseRefusals: 2,
	}),
);
