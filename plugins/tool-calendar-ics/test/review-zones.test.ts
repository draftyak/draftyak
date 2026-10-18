import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { freeBusy } from "../src/index.ts";
import { event, expectCode, feed, utf8, window } from "./helpers.ts";

const zone = (
	id: string,
	daylight: readonly [string, string, string, string],
	standard: readonly [string, string, string, string],
	year: string,
): string =>
	[
		"BEGIN:VTIMEZONE",
		`TZID:${id}`,
		...[daylight, standard].flatMap(([start, from, to, rule], index) => [
			`BEGIN:${index ? "STANDARD" : "DAYLIGHT"}`,
			`DTSTART:${year}${start}`,
			`TZOFFSETFROM:${from}`,
			`TZOFFSETTO:${to}`,
			`RRULE:FREQ=YEARLY;${rule}`,
			`END:${index ? "STANDARD" : "DAYLIGHT"}`,
		]),
		"END:VTIMEZONE",
	].join("\r\n");

const definitions: Readonly<
	Record<
		string,
		{
			readonly windows: string;
			readonly outlookStarts: readonly [string, string];
			readonly daylight: readonly [string, string, string, string];
			readonly standard: readonly [string, string, string, string];
		}
	>
> = {
	"America/New_York": {
		windows: "Eastern Standard Time",
		outlookStarts: ["0311T020000", "1104T020000"],
		daylight: ["0308T020000", "-0500", "-0400", "BYMONTH=3;BYDAY=2SU"],
		standard: ["1101T020000", "-0400", "-0500", "BYMONTH=11;BYDAY=1SU"],
	},
	"Europe/London": {
		windows: "GMT Standard Time",
		outlookStarts: ["0325T010000", "1028T020000"],
		daylight: ["0329T010000", "+0000", "+0100", "BYMONTH=3;BYDAY=-1SU"],
		standard: ["1025T020000", "+0100", "+0000", "BYMONTH=10;BYDAY=-1SU"],
	},
	"Australia/Lord_Howe": {
		windows: "Lord Howe Standard Time",
		outlookStarts: ["1007T020000", "0401T020000"],
		daylight: ["1004T020000", "+1030", "+1100", "BYMONTH=10;BYDAY=1SU"],
		standard: ["0405T020000", "+1100", "+1030", "BYMONTH=4;BYDAY=1SU"],
	},
};
interface DstCase {
	feed: string;
	timeZone: string;
	window: { start: string; end: string };
	expected: ReturnType<typeof freeBusy>;
}
const directory = new URL("../../../security/ics-corpus/", import.meta.url);
const cases = readdirSync(directory).filter((name) => /^dst-.*\.json$/.test(name));
it("has all six independent DST corpus goldens", () => expect(cases).toHaveLength(6));
for (const name of cases) {
	const item = JSON.parse(readFileSync(new URL(name, directory), "utf8")) as DstCase;
	const text = readFileSync(new URL(item.feed, directory), "utf8");
	it.each(["Google", "Outlook"] as const)(
		`resolves ${name} using a %s-style feed zone`,
		(provider) => {
			const definition = definitions[item.timeZone];
			if (!definition) throw new Error("missing fixture definition");
			const id = provider === "Google" ? item.timeZone : definition.windows;
			const daylight =
				provider === "Google"
					? definition.daylight
					: ([
							definition.outlookStarts[0],
							definition.daylight[1],
							definition.daylight[2],
							definition.daylight[3],
						] as const);
			const standard =
				provider === "Google"
					? definition.standard
					: ([
							definition.outlookStarts[1],
							definition.standard[1],
							definition.standard[2],
							definition.standard[3],
						] as const);
			const injected = text
				.replaceAll(`TZID=${item.timeZone}`, `TZID=${id}`)
				.replace(
					"BEGIN:VEVENT",
					`${zone(id, daylight, standard, provider === "Google" ? "1970" : "1601")}\r\nBEGIN:VEVENT`,
				);
			expect(
				freeBusy(
					utf8(injected),
					{ start: Date.parse(item.window.start), end: Date.parse(item.window.end) },
					item.timeZone,
				),
			).toEqual(item.expected);
		},
	);
}

const fixedZone = (id: string): string =>
	[
		"BEGIN:VTIMEZONE",
		`TZID:${id}`,
		"BEGIN:STANDARD",
		"DTSTART:19700101T000000",
		"TZOFFSETFROM:+0100",
		"TZOFFSETTO:+0100",
		"END:STANDARD",
		"END:VTIMEZONE",
	].join("\r\n");
it.each(["UTC", "GMT"])("resolves %s from Temporal when no feed definition exists", (id) => {
	expect(
		freeBusy(feed(event(`DTSTART;TZID=${id}:20260102T090000`, "DURATION:PT1H")), window, "UTC"),
	).toEqual({
		busy: [
			{
				start: Date.parse("2026-01-02T09:00Z"),
				end: Date.parse("2026-01-02T10:00Z"),
				status: "busy",
			},
		],
	});
});
it.each(["UTC", "GMT"])("prefers a feed %s definition while bare Z remains UTC", (id) => {
	const result = freeBusy(
		feed(
			fixedZone(id),
			event(`DTSTART;TZID=${id}:20260102T090000`, "DURATION:PT1H"),
			event("DTSTART:20260102T100000Z", "DURATION:PT1H"),
		),
		window,
		"UTC",
	);
	expect(result.busy.map((item) => item.start)).toEqual([
		Date.parse("2026-01-02T08:00Z"),
		Date.parse("2026-01-02T10:00Z"),
	]);
});
it("rejects an actually contradictory TZID plus UTC Z", () =>
	expectCode(
		() =>
			freeBusy(feed(event("DTSTART;TZID=UTC:20260102T090000Z", "DURATION:PT1H")), window, "UTC"),
		"INVALID_FEED",
	));

it.each([
	"FREQ=SECONDLY",
	"FREQ=DAILY",
	"FREQ=YEARLY;BYWEEKNO=1",
	"FREQ=YEARLY;UNTIL=20270101T000000",
])("refuses unsupported observance rule %s without upstream expansion", (rule) => {
	const definition = fixedZone("Custom/Zone").replace(
		"END:STANDARD",
		`RRULE:${rule}\r\nEND:STANDARD`,
	);
	expectCode(
		() =>
			freeBusy(
				feed(definition, event("DTSTART;TZID=Custom/Zone:20260102T090000", "DURATION:PT1H")),
				window,
				"UTC",
			),
		"INVALID_FEED",
	);
});
