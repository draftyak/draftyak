import { OwnerSettings } from "@draftyak/protocol/entities";
import { describe, expect, it, vi } from "vitest";
import { validateOwner } from "../src/clock.ts";
import {
	calendarWindow,
	LookupError,
	LookupRunner,
	type OwnerState,
	planLookups,
	renderFreeSlots,
	workingIntervals,
} from "../src/index.ts";
import { config, host, item, meta, now } from "./helpers.ts";

const allDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

describe("working-day clock and hub-rendered calendar slots", () => {
	it("uses the merged single working-hours object and refuses invalid or legacy shapes", () => {
		const owner = config().owner;
		expect(OwnerSettings.safeParse(owner).success).toBe(true);
		expect(() => validateOwner(owner)).not.toThrow();
		for (const workingHours of [
			[],
			{ ...owner.workingHours, days: [] },
			{ ...owner.workingHours, days: ["mon", "mon"] },
			{ ...owner.workingHours, days: ["monday"] },
			{ ...owner.workingHours, start: "9:00" },
			{ ...owner.workingHours, end: "24:01" },
			{ ...owner.workingHours, start: "17:00", end: "09:00" },
			{ ...owner.workingHours, enabled: true },
		]) {
			const changed = { ...owner, workingHours };
			expect(OwnerSettings.safeParse(changed).success).toBe(false);
			expect(() => validateOwner(changed as OwnerState)).toThrow("INVALID_OWNER_STATE");
		}
		const endOfDay: OwnerState = {
			...owner,
			workingHours: { days: ["mon"], start: "00:00", end: "24:00" },
		};
		expect(OwnerSettings.safeParse(endOfDay).success).toBe(true);
		expect(() => validateOwner(endOfDay)).not.toThrow();
	});
	it("counts remaining working days and skips weekends and completed days", () => {
		const owner = config().owner;
		expect(calendarWindow(owner, Date.parse("2026-10-17T12:00:00Z"), 3).end).toBe(
			Date.parse("2026-10-22T00:00:00Z"),
		);
		expect(calendarWindow(owner, Date.parse("2026-10-19T18:00:00Z"), 3).end).toBe(
			Date.parse("2026-10-23T00:00:00Z"),
		);
	});
	it("uses local calendar days through DST with a half-hour zone offset", () => {
		const owner = { ...config().owner, zone: "Australia/Lord_Howe" };
		const start = Date.parse("2026-10-02T00:00:00Z");
		expect(calendarWindow(owner, start, 3).end).toBe(Date.parse("2026-10-06T13:00:00Z"));
	});
	it("subtracts busy and tentative intervals, starts an hour ahead, and keeps at least thirty minutes", () => {
		const args = { window: { start: now, end: Date.parse("2026-10-20T00:00:00Z") }, tz: "UTC" };
		const hour = 3_600_000;
		const slots = renderFreeSlots(
			{
				busy: [
					{ start: now + 2 * hour, end: now + 3 * hour, status: "busy" },
					{ start: now + 5 * hour, end: now + 6 * hour, status: "tentative" },
				],
			},
			args,
			config().owner,
			now + hour / 2,
		).slots;
		expect(slots.map(({ start, end }) => [start, end])).toEqual([
			[now + 1.5 * hour, now + 2 * hour],
			[now + 3 * hour, now + 5 * hour],
			[now + 6 * hour, now + 9 * hour],
		]);
		expect(slots.every(({ label }) => label.includes("UTC+00:00"))).toBe(true);
	});
	it("caps slots at twelve, clips out-of-window busy times and refuses invalid owner settings", () => {
		const args = { window: { start: now, end: now + 16 * 86_400_000 }, tz: "UTC" };
		const owner: OwnerState = {
			zone: "UTC",
			workingHours: { days: allDays, start: "09:00", end: "17:00" },
		};
		expect(renderFreeSlots({ busy: [] }, args, owner, now).slots).toHaveLength(12);
		expect(
			renderFreeSlots(
				{ busy: [{ start: now - 1, end: now + 1, status: "busy" }] },
				args,
				owner,
				now,
			).slots,
		).toHaveLength(12);
		expect(() =>
			calendarWindow({ ...owner, workingHours: { ...owner.workingHours, days: [] } }, now, 3),
		).toThrow(LookupError);
	});
	it("validates direct renderer calls instead of assuming the caller used the runner", () => {
		const args = { window: { start: now, end: now + 86_400_000 }, tz: "UTC" };
		const unsorted = {
			busy: [
				{ start: now + 10_000, end: now + 20_000, status: "busy" as const },
				{ start: now, end: now + 5_000, status: "busy" as const },
			],
		};
		expect(() => renderFreeSlots(unsorted, args, config().owner, now)).toThrow(LookupError);
		expect(() =>
			renderFreeSlots(
				{ busy: [] },
				{ ...args, window: { start: now, end: now } },
				config().owner,
				now,
			),
		).toThrow(LookupError);
	});
	it("fails closed when Temporal is unavailable", () => {
		vi.stubGlobal("Temporal", undefined);
		expect(() => calendarWindow(config().owner, now, 3)).toThrow(LookupError);
		vi.unstubAllGlobals();
	});
	it("reuses one calendar fetch within a ten-minute bucket while rendering against the fresh lead time", async () => {
		let clock = now;
		const base = host(),
			adapter = { ...base, now: () => clock },
			call = vi.spyOn(adapter, "call"),
			discover = vi.spyOn(adapter, "discover"),
			runner = new LookupRunner(adapter);
		const firstPlan = planLookups(
			meta,
			config([item("calendar.freebusy")]),
			{ kind: "on-demand", jobId: "calendar-one" },
			clock,
		);
		const first = await runner.run(firstPlan);
		clock += 180_000;
		const secondPlan = planLookups(
			meta,
			config([item("calendar.freebusy")]),
			{ kind: "on-demand", jobId: "calendar-two" },
			clock,
		);
		const second = await runner.run(secondPlan);
		expect(firstPlan.calls[0]?.arguments).toEqual(secondPlan.calls[0]?.arguments);
		expect(first.contexts).toHaveLength(1);
		expect(second.contexts).toHaveLength(1);
		expect(call).toHaveBeenCalledTimes(1);
		expect(discover).toHaveBeenCalledTimes(2);
		const firstContext = first.contexts[0],
			secondContext = second.contexts[0];
		if (!firstContext || !secondContext) throw new Error("missing calendar context");
		expect(firstContext.fetchedAt).toBe(secondContext.fetchedAt);
		expect((firstContext.data as { slots: { start: number }[] }).slots[0]?.start).toBe(
			now + 3_600_000,
		);
		expect((secondContext.data as { slots: { start: number }[] }).slots[0]?.start).toBe(
			now + 4_500_000,
		);
	});
	it("keeps the entire window stable across a working-day end inside the same bucket", () => {
		const owner = {
			...config().owner,
			workingHours: { ...config().owner.workingHours, end: "17:05" },
		};
		const first = calendarWindow(owner, Date.parse("2026-10-19T17:01:00Z"), 3);
		expect(calendarWindow(owner, Date.parse("2026-10-19T17:09:59Z"), 3)).toEqual(first);
		expect(first).toEqual({
			start: Date.parse("2026-10-19T17:00:00Z"),
			end: Date.parse("2026-10-22T00:00:00Z"),
		});
		expect(calendarWindow(owner, Date.parse("2026-10-19T17:10:00Z"), 3).end).toBe(
			Date.parse("2026-10-23T00:00:00Z"),
		);
	});
	it.each([
		["America/Santiago", "2026-09-04", "2026-09-08", "2026-09-07T12:00:00Z"],
		["Africa/Cairo", "2026-04-22", "2026-04-27", "2026-04-24T06:00:00Z"],
		["America/Havana", "2026-03-06", "2026-03-10", "2026-03-09T13:00:00Z"],
		["America/Havana", "2026-10-30", "2026-11-03", "2026-11-02T14:00:00Z"],
		["Asia/Beirut", "2026-03-27", "2026-03-31", "2026-03-30T06:00:00Z"],
		["Atlantic/Azores", "2026-03-27", "2026-03-31", "2026-03-30T09:00:00Z"],
		["Atlantic/Azores", "2026-10-23", "2026-10-27", "2026-10-26T10:00:00Z"],
	])("uses actual day starts across %s from %s", (zone, start, end, expected) => {
		const intervals = workingIntervals(
			{ ...config().owner, zone },
			Date.parse(`${start}T00:00:00Z`),
			Date.parse(`${end}T00:00:00Z`),
		);
		expect(intervals.some((interval) => interval.start === Date.parse(expected))).toBe(true);
		expect(intervals.every((interval) => interval.end - interval.start === 8 * 3_600_000)).toBe(
			true,
		);
	});
	it.each([
		["America/Santiago", "2026-09-03T15:00:00Z", "2026-09-06T04:00:00Z"],
		["America/Havana", "2026-10-29T12:00:00Z", "2026-11-01T04:00:00Z"],
	])("ends the horizon at the first valid instant of the day in %s", (zone, start, expected) => {
		const owner: OwnerState = {
			zone,
			workingHours: { days: allDays, start: "09:00", end: "17:00" },
		};
		expect(calendarWindow(owner, Date.parse(start), 3).end).toBe(Date.parse(expected));
	});
	it.each([
		["2026-03-08", 150],
		["2026-11-01", 90],
	] as const)("still refuses a gap or fold working-hour boundary on %s", (date, startMinute) => {
		const owner: OwnerState = {
			zone: "America/New_York",
			workingHours: {
				days: ["sun"],
				start: `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}`,
				end: "04:00",
			},
		};
		const start = Date.parse(`${date}T00:00:00Z`);
		expect(() => workingIntervals(owner, start, start + 86_400_000)).toThrow(LookupError);
		expect(() => workingIntervals(owner, start, start + 86_400_000)).toThrow("TIME_UNAVAILABLE");
	});
	it.each([
		{
			zone: "America/New_York",
			instant: "2026-10-19T12:01:12Z",
			start: "2026-10-19T13:15:00Z",
			end: "2026-10-19T21:00:00Z",
			label: "Mon 19 Oct 2026, 09:15–17:00 America/New_York (UTC-04:00)",
		},
		{
			zone: "America/New_York",
			instant: "2026-12-07T13:00:00Z",
			start: "2026-12-07T14:00:00Z",
			end: "2026-12-07T22:00:00Z",
			label: "Mon 07 Dec 2026, 09:00–17:00 America/New_York (UTC-05:00)",
		},
		{
			zone: "Australia/Lord_Howe",
			instant: "2026-05-18T22:01:12Z",
			start: "2026-05-18T23:15:00Z",
			end: "2026-05-19T06:30:00Z",
			label: "Tue 19 May 2026, 09:45–17:00 Australia/Lord_Howe (UTC+10:30)",
		},
		{
			zone: "Pacific/Chatham",
			instant: "2026-05-18T19:16:01Z",
			start: "2026-05-18T20:30:00Z",
			end: "2026-05-19T04:15:00Z",
			label: "Tue 19 May 2026, 09:15–17:00 Pacific/Chatham (UTC+12:45)",
		},
	])("renders local quarter-hour golden slots in $zone at $instant", (golden) => {
		const instant = Date.parse(golden.instant);
		const slots = renderFreeSlots(
			{ busy: [] },
			{ window: { start: instant, end: instant + 86_400_000 }, tz: golden.zone },
			{ ...config().owner, zone: golden.zone },
			instant,
		).slots;
		expect(slots[0]).toEqual({
			start: Date.parse(golden.start),
			end: Date.parse(golden.end),
			label: golden.label,
		});
	});
	it.each([
		[
			"2026-03-08T04:00:00Z",
			"Sun 08 Mar 2026, 00:00–04:00 America/New_York (UTC-05:00 → UTC-04:00)",
		],
		[
			"2026-11-01T03:00:00Z",
			"Sun 01 Nov 2026, 00:00–04:00 America/New_York (UTC-04:00 → UTC-05:00)",
		],
	])("labels both offsets when a slot crosses a clock change at %s", (start, label) => {
		const instant = Date.parse(start);
		const slots = renderFreeSlots(
			{ busy: [] },
			{ window: { start: instant, end: instant + 86_400_000 }, tz: "America/New_York" },
			{ zone: "America/New_York", workingHours: { days: ["sun"], start: "00:00", end: "04:00" } },
			instant,
		).slots;
		expect(slots[0]?.label).toBe(label);
	});
	it("clips crossing busy intervals before subtracting and rounds the remaining start upward", () => {
		const instant = Date.parse("2026-10-19T08:00:00Z"),
			end = Date.parse("2026-10-19T20:00:00Z");
		const slots = renderFreeSlots(
			{
				busy: [
					{ start: instant - 3_600_000, end: Date.parse("2026-10-19T10:31:00Z"), status: "busy" },
					{ start: Date.parse("2026-10-19T16:00:00Z"), end: end + 3_600_000, status: "tentative" },
				],
			},
			{ window: { start: instant, end }, tz: "UTC" },
			config().owner,
			instant,
		).slots;
		expect(slots).toEqual([
			{
				start: Date.parse("2026-10-19T10:45:00Z"),
				end: Date.parse("2026-10-19T16:00:00Z"),
				label: "Mon 19 Oct 2026, 10:45–16:00 UTC (UTC+00:00)",
			},
		]);
	});
	it("drops fully outside intervals and returns no slot for an interval covering the whole window", () => {
		const args = { window: { start: now, end: now + 12 * 3_600_000 }, tz: "UTC" };
		const outside = renderFreeSlots(
			{
				busy: [
					{ start: now - 7_200_000, end: now - 3_600_000, status: "busy" },
					{ start: args.window.end + 3_600_000, end: args.window.end + 7_200_000, status: "busy" },
				],
			},
			args,
			config().owner,
			now,
		).slots;
		expect(outside).toEqual(renderFreeSlots({ busy: [] }, args, config().owner, now).slots);
		expect(
			renderFreeSlots(
				{ busy: [{ start: now - 1, end: args.window.end + 1, status: "busy" }] },
				args,
				config().owner,
				now,
			).slots,
		).toEqual([]);
	});
	it.each([
		["2026-10-19T16:14:59Z", 1],
		["2026-10-19T16:15:01Z", 0],
	] as const)("applies the thirty-minute minimum after rounding a busy end at %s", (end, count) => {
		const slots = renderFreeSlots(
			{ busy: [{ start: now + 3_600_000, end: Date.parse(end), status: "busy" }] },
			{ window: { start: now, end: now + 43_200_000 }, tz: "UTC" },
			{ zone: "UTC", workingHours: { days: ["mon"], start: "09:00", end: "16:50" } },
			now,
		).slots;
		expect(slots).toHaveLength(count);
		expect(slots.every((slot) => slot.end - slot.start >= 1_800_000)).toBe(true);
		if (count) expect(slots[0]?.start).toBe(Date.parse("2026-10-19T16:15:00Z"));
	});
});
