import { calendarWindow, type OwnerState } from "@draftyak/lookup-core/calendar";
import { type CalendarFreebusyArguments, checkToolResult } from "@draftyak/protocol/tool-v1";
import { CalendarError, freeBusy } from "@draftyak/tool-calendar-ics";
import { describe, expect, it, vi } from "vitest";
import { composeCalendar } from "./composition.ts";
import { independentCases, syntheticCalendar } from "./independent-cases.ts";

vi.mock("@draftyak/tool-calendar-ics", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@draftyak/tool-calendar-ics")>();
	return { ...actual, freeBusy: vi.fn(actual.freeBusy) };
});

const ms = (value: string): number => Date.parse(value);
function argumentsFor(window: readonly [string, string], zone: string): CalendarFreebusyArguments {
	return { window: { start: ms(window[0]), end: ms(window[1]) }, tz: zone };
}

describe("independent offline ICS composition controls", () => {
	it.each(independentCases)("$id", (golden) => {
		const now = ms(golden.now);
		const args = argumentsFor(golden.window, golden.owner.zone);
		if (golden.horizon !== undefined)
			expect(calendarWindow(golden.owner, now, golden.horizon)).toEqual(args.window);
		const { raw, checked, actual } = composeCalendar(
			Buffer.from(golden.feed),
			args,
			golden.owner,
			now,
		);
		const busy = golden.busy.map(([start, end, status]) => ({
			start: ms(start),
			end: ms(end),
			status,
		}));
		const slots = golden.slots.map(([start, end, label]) => ({
			start: ms(start),
			end: ms(end),
			label,
		}));
		expect(busy.length).toBeGreaterThan(0);
		expect(slots.length).toBeGreaterThan(0);
		expect(raw).toEqual({ busy });
		expect(checked).toEqual({ busy });
		expect(actual).toEqual({ slots });
		expect(JSON.stringify({ raw, checked, actual })).not.toMatch(/ICS_CANARY|example\.invalid/);
	});

	it("keeps a cached window but reapplies current lead across a quarter-hour boundary", () => {
		const owner: OwnerState = {
			zone: "UTC",
			workingHours: { days: ["mon", "tue", "wed"], start: "09:00", end: "12:00" },
		};
		const args = argumentsFor(["2026-10-19T09:10:00Z", "2026-10-22T00:00:00Z"], "UTC");
		const feed = Buffer.from(syntheticCalendar("DTSTART:20261019T110000Z\nDTEND:20261019T113000Z"));
		const earlier = ms("2026-10-19T09:11:00Z"),
			later = ms("2026-10-19T09:19:00Z");
		const expectedBusy = {
			busy: [
				{ start: ms("2026-10-19T11:00:00Z"), end: ms("2026-10-19T11:30:00Z"), status: "busy" },
			],
		};
		const tail = [
			{
				start: ms("2026-10-19T11:30:00Z"),
				end: ms("2026-10-19T12:00:00Z"),
				label: "Mon 19 Oct 2026, 11:30–12:00 UTC (UTC+00:00)",
			},
			{
				start: ms("2026-10-20T09:00:00Z"),
				end: ms("2026-10-20T12:00:00Z"),
				label: "Tue 20 Oct 2026, 09:00–12:00 UTC (UTC+00:00)",
			},
			{
				start: ms("2026-10-21T09:00:00Z"),
				end: ms("2026-10-21T12:00:00Z"),
				label: "Wed 21 Oct 2026, 09:00–12:00 UTC (UTC+00:00)",
			},
		];
		expect(calendarWindow(owner, earlier, 3)).toEqual(args.window);
		expect(calendarWindow(owner, later, 3)).toEqual(args.window);
		const first = composeCalendar(feed, args, owner, earlier);
		const next = composeCalendar(feed, args, owner, later);
		expect(first.raw).toEqual(expectedBusy);
		expect(next.raw).toEqual(expectedBusy);
		expect(first.actual.slots).toEqual([
			{
				start: ms("2026-10-19T10:15:00Z"),
				end: ms("2026-10-19T11:00:00Z"),
				label: "Mon 19 Oct 2026, 10:15–11:00 UTC (UTC+00:00)",
			},
			...tail,
		]);
		expect(next.actual.slots).toEqual([
			{
				start: ms("2026-10-19T10:30:00Z"),
				end: ms("2026-10-19T11:00:00Z"),
				label: "Mon 19 Oct 2026, 10:30–11:00 UTC (UTC+00:00)",
			},
			...tail,
		]);
	});

	it.each([
		["spring-gap-unambiguous-working-hours-positive", "02:15"],
		["fold-spanning-free-slot-labels-both-offsets", "01:30"],
		["skipped-midnight-with-valid-one-am-working-boundary", "00:00"],
	])("refuses invalid working boundary for %s instead of empty availability", (id, start) => {
		const golden = independentCases.find((item) => item.id === id);
		if (!golden) throw new Error("Missing independent positive");
		const args = argumentsFor(golden.window, golden.owner.zone);
		const owner = { ...golden.owner, workingHours: { ...golden.owner.workingHours, start } };
		let reachedRenderer = false;
		expect(() =>
			composeCalendar(Buffer.from(golden.feed), args, owner, ms(golden.now), () => {
				reachedRenderer = true;
			}),
		).toThrow(/^TIME_UNAVAILABLE$/);
		expect(reachedRenderer).toBe(true);
	});

	it("distinguishes a clean empty feed from a malformed feed before rendering", () => {
		const owner: OwnerState = {
			zone: "UTC",
			workingHours: { days: ["mon"], start: "09:00", end: "12:00" },
		};
		const args = argumentsFor(["2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z"], "UTC");
		const clean = composeCalendar(
			Buffer.from(syntheticCalendar()),
			args,
			owner,
			ms("2026-10-19T07:00:00Z"),
		);
		expect(clean.raw).toEqual({ busy: [] });
		expect(clean.checked).toEqual({ busy: [] });
		expect(clean.actual.slots).toEqual([
			{
				start: ms("2026-10-19T09:00:00Z"),
				end: ms("2026-10-19T12:00:00Z"),
				label: "Mon 19 Oct 2026, 09:00–12:00 UTC (UTC+00:00)",
			},
		]);
		let reachedRenderer = false;
		let failure: unknown;
		try {
			composeCalendar(
				Buffer.from("not a calendar\r\n"),
				args,
				owner,
				ms("2026-10-19T07:00:00Z"),
				() => {
					reachedRenderer = true;
				},
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(CalendarError);
		expect(failure).toMatchObject({ code: "INVALID_FEED", message: "INVALID_FEED" });
		expect(String(failure)).not.toContain("not a calendar");
		expect(reachedRenderer).toBe(false);
	});

	it("retains a nonempty engine result while a lower declared wire cap refuses it", () => {
		const golden = independentCases[0];
		if (!golden) throw new Error("Missing independent positive");
		const { raw } = composeCalendar(
			Buffer.from(golden.feed),
			argumentsFor(golden.window, golden.owner.zone),
			golden.owner,
			ms(golden.now),
		);
		expect(raw.busy).toHaveLength(2);
		expect(
			checkToolResult(
				"calendar.freebusy",
				{ resultType: "complete", content: [], structuredContent: raw },
				{ maxBytes: 1 },
			),
		).toEqual({ status: "refused", refusal: "TOOL_RESULT_TOO_LARGE" });
	});

	it("refuses an altered real engine result at the composition gate before rendering", () => {
		const golden = independentCases[0];
		if (!golden) throw new Error("Missing independent positive");
		const feed = Buffer.from(golden.feed);
		const args = argumentsFor(golden.window, golden.owner.zone);
		const valid = composeCalendar(feed, args, golden.owner, ms(golden.now));
		expect(valid.raw.busy.length).toBeGreaterThan(0);
		expect(valid.actual.slots.length).toBeGreaterThan(0);
		const first = valid.raw.busy[0];
		if (!first) throw new Error("Missing actual engine interval");
		const engine = vi.mocked(freeBusy);
		const normal = engine.getMockImplementation();
		if (!normal) throw new Error("Missing real engine delegate");
		let reachedRenderer = false;
		let failure: unknown;
		try {
			engine.mockReturnValueOnce({ busy: [{ ...first, start: first.start + 0.5 }] });
			composeCalendar(feed, args, golden.owner, ms(golden.now), () => {
				reachedRenderer = true;
			});
		} catch (error) {
			failure = error;
		} finally {
			engine.mockReset();
			engine.mockImplementation(normal);
		}
		expect(reachedRenderer).toBe(false);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({ message: "Calendar wire result refused." });
	});
});
