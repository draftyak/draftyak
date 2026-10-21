import { readFileSync } from "node:fs";
import { calendarWindow, type OwnerState } from "@draftyak/lookup-core/calendar";
import { OwnerSettings } from "@draftyak/protocol/entities";
import {
	type CalendarFreebusyArguments,
	type CalendarFreebusyResult,
	checkToolResult,
} from "@draftyak/protocol/tool-v1";
import { CalendarError, freeBusy } from "@draftyak/tool-calendar-ics";
import { describe, expect, it } from "vitest";
import { composeCalendar as compose } from "./composition.ts";

interface Golden {
	id: string;
	feed: string;
	zone: string;
	now: string;
	window: [string, string];
	hours: OwnerState["workingHours"];
	horizon?: 3 | 5 | 10;
	busy: [string, string, "busy" | "tentative"][];
	slots: [string, string, string][];
}

const corpus = new URL("../../../security/ics-corpus/free-slots/", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("cases.json", corpus), "utf8")) as Golden[];
const bytesFor = (name: string): Buffer => readFileSync(new URL(name, corpus));
const milliseconds = (value: string): number => {
	const result = Date.parse(value);
	expect(Number.isSafeInteger(result)).toBe(true);
	return result;
};
const complete = (value: unknown): unknown => ({
	resultType: "complete",
	content: [],
	structuredContent: value,
});

describe("real ICS to checked free/busy to exact free-slot goldens", () => {
	it("contains the complete independent positive and negative corpus", () => {
		expect("Temporal" in globalThis).toBe(true);
		expect(cases).toHaveLength(25);
		expect(new Set(cases.map((item) => item.id)).size).toBe(25);
		expect(cases.filter((item) => item.id.startsWith("dst-"))).toHaveLength(6);
		expect(cases.filter((item) => item.slots.length > 0)).toHaveLength(24);
		expect(
			new Set(cases.flatMap((item) => (item.horizon === undefined ? [] : [item.horizon]))),
		).toEqual(new Set([3, 5, 10]));
		const oracle = {
			start: "20260115T090000Z",
			rule: "FREQ=YEARLY;BYHOUR=10,9;COUNT=3",
			times: ["2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z", "2027-01-15T09:00:00Z"],
		};
		const yearly = cases.filter((item) => item.id.startsWith("yearly-"));
		expect(yearly.map((item) => item.id)).toEqual(["yearly-time-expansion", "yearly-count-cutoff"]);
		expect(yearly.map((item) => item.feed)).toEqual(["yearly-count.ics", "yearly-count.ics"]);
		expect(yearly.flatMap((item) => item.busy.map(([start]) => start))).toEqual(oracle.times);
		const feed = bytesFor("yearly-count.ics").toString("utf8");
		expect(feed).toContain(`DTSTART:${oracle.start}\r\n`);
		expect(feed).toContain(`RRULE:${oracle.rule}\r\n`);
		expect(feed).toContain("DURATION:PT30M\r\n");
	});

	it.each(cases)("$id", (golden) => {
		const now = milliseconds(golden.now);
		const owner = OwnerSettings.parse({ zone: golden.zone, workingHours: golden.hours });
		const args: CalendarFreebusyArguments = {
			window: {
				start: milliseconds(golden.window[0]),
				end: milliseconds(golden.window[1]),
			},
			tz: owner.zone,
		};
		if (golden.horizon !== undefined) {
			const actualWindow = calendarWindow(owner, now, golden.horizon);
			expect(actualWindow).toEqual(args.window);
			args.window = actualWindow;
		}
		const { raw, checked, actual } = compose(bytesFor(golden.feed), args, owner, now);
		const expectedBusy: CalendarFreebusyResult = {
			busy: golden.busy.map(([start, end, status]) => ({
				start: milliseconds(start),
				end: milliseconds(end),
				status,
			})),
		};
		expect(raw).toEqual(expectedBusy);
		expect(checked).toEqual(expectedBusy);
		expect(actual).toEqual({
			slots: golden.slots.map(([start, end, label]) => ({
				start: milliseconds(start),
				end: milliseconds(end),
				label,
			})),
		});
		if (golden.slots.length > 0) expect(actual.slots.length).toBeGreaterThan(0);
		expect(actual.slots.length).toBeLessThanOrEqual(12);
		expect(JSON.stringify({ raw, checked, actual })).not.toMatch(/ICS_CANARY|example\.invalid/i);
	});

	it.each([
		["malformed.ics", "INVALID_FEED"],
		["../fixtures/unknown-tzid.ics", "UNKNOWN_TIME_ZONE"],
	] as const)("keeps %s a typed error before rendering", (feed, code) => {
		let reachedRenderer = false;
		expect(() => {
			compose(
				bytesFor(feed),
				{
					window: {
						start: Date.parse("2026-01-01T00:00:00Z"),
						end: Date.parse("2027-01-01T00:00:00Z"),
					},
					tz: "UTC",
				},
				{ zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "17:00" } },
				Date.parse("2026-01-01T00:00:00Z"),
				() => {
					reachedRenderer = true;
				},
			);
		}).toThrow(new CalendarError(code));
		expect(reachedRenderer).toBe(false);
	});

	it("refuses an oversized feed without presenting empty availability", () => {
		let reachedRenderer = false;
		expect(() => {
			compose(
				new Uint8Array(32 * 1024 * 1024 + 1),
				{ window: { start: 0, end: 86_400_000 }, tz: "UTC" },
				{ zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "17:00" } },
				0,
				() => {
					reachedRenderer = true;
				},
			);
		}).toThrow(new CalendarError("FEED_TOO_LARGE"));
		expect(reachedRenderer).toBe(false);
	});

	it("enforces the real wire byte ceiling before the renderer", () => {
		const raw = freeBusy(
			bytesFor("status.ics"),
			{ start: Date.parse("2026-10-19T00:00:00Z"), end: Date.parse("2026-10-20T00:00:00Z") },
			"UTC",
		);
		expect(raw.busy.length).toBeGreaterThan(0);
		expect(checkToolResult("calendar.freebusy", complete(raw), { maxBytes: 1 })).toEqual({
			status: "refused",
			refusal: "TOOL_RESULT_TOO_LARGE",
		});
	});

	it("keeps all event-detail canaries absent across composed outputs", () => {
		const feed = bytesFor("status.ics");
		for (const field of [
			"SUMMARY",
			"DESCRIPTION",
			"LOCATION",
			"ATTENDEE",
			"ORGANIZER",
			"URL",
			"ATTACH",
		])
			expect(feed.toString("utf8")).toContain(`${field}`);
		const args: CalendarFreebusyArguments = {
			window: {
				start: Date.parse("2026-10-19T00:00:00Z"),
				end: Date.parse("2026-10-20T00:00:00Z"),
			},
			tz: "UTC",
		};
		const result = compose(
			feed,
			args,
			{ zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "14:00" } },
			Date.parse("2026-10-19T07:00:00Z"),
		);
		expect(result.raw.busy).toHaveLength(1);
		expect(result.actual.slots).toHaveLength(2);
		for (const value of [result.raw, result.checked, result.actual])
			expect(JSON.stringify(value)).not.toMatch(/ICS_CANARY|example\.invalid/i);
	});

	it("refuses off-schema details and non-UTC-ms intervals at the real shared boundary", () => {
		const raw = freeBusy(
			bytesFor("status.ics"),
			{ start: Date.parse("2026-10-19T00:00:00Z"), end: Date.parse("2026-10-20T00:00:00Z") },
			"UTC",
		);
		expect(checkToolResult("calendar.freebusy", complete(raw)).status).toBe("ok");
		const interval = raw.busy[0];
		if (!interval) throw new Error("Missing occupied positive control");
		for (const changed of [
			{ ...interval, title: "ICS_CANARY_WIRE_DETAIL" },
			{ ...interval, start: interval.start + 0.5 },
			{ ...interval, end: interval.start },
		])
			expect(checkToolResult("calendar.freebusy", complete({ busy: [changed] }))).toEqual({
				status: "refused",
				refusal: "TOOL_RESULT_OFF_SCHEMA",
			});
	});

	it("observes a real feed mutation instead of substituting golden busy data", () => {
		const source = bytesFor("status.ics").toString("utf8");
		expect(source.match(/STATUS:TENTATIVE/g)).toHaveLength(1);
		const args = {
			window: {
				start: Date.parse("2026-10-19T00:00:00Z"),
				end: Date.parse("2026-10-20T00:00:00Z"),
			},
			tz: "UTC",
		};
		const owner: OwnerState = {
			zone: "UTC",
			workingHours: { days: ["mon"], start: "09:00", end: "14:00" },
		};
		const changed = compose(
			Buffer.from(source.replace("STATUS:TENTATIVE", "TRANSP:TRANSPARENT")),
			args,
			owner,
			Date.parse("2026-10-19T07:00:00Z"),
		);
		expect(changed.raw).toEqual({ busy: [] });
		expect(changed.actual.slots).toEqual([
			{
				start: Date.parse("2026-10-19T09:00:00Z"),
				end: Date.parse("2026-10-19T14:00:00Z"),
				label: "Mon 19 Oct 2026, 09:00–14:00 UTC (UTC+00:00)",
			},
		]);
	});
});
