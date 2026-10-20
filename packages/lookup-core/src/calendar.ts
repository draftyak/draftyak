import {
	type CalendarFreebusyArguments,
	type CalendarFreebusyResult,
	toolKindsV1,
} from "@draftyak/protocol/tool-v1";
import { ceilQuarterHour, slotLabel, workingIntervals } from "./clock.ts";
import { LookupError, type OwnerState } from "./model.ts";

export interface FreeSlot {
	readonly start: number;
	readonly end: number;
	readonly label: string;
}
export function renderFreeSlots(
	result: CalendarFreebusyResult,
	args: CalendarFreebusyArguments,
	owner: OwnerState,
	now: number,
): { slots: FreeSlot[] } {
	result = structuredClone(result);
	args = structuredClone(args);
	owner = structuredClone(owner);
	if (
		!toolKindsV1["calendar.freebusy"].arguments.safeParse(args).success ||
		!toolKindsV1["calendar.freebusy"].result.safeParse(result).success
	)
		throw new LookupError("RESULT_REFUSED");
	if (args.tz !== owner.zone) throw new LookupError("RESULT_REFUSED");
	const busy = result.busy
		.map((interval) => ({
			start: Math.max(args.window.start, interval.start),
			end: Math.min(args.window.end, interval.end),
		}))
		.filter((interval) => interval.start < interval.end);
	const slots: FreeSlot[] = [];
	const offer = (start: number, end: number): void => {
		if (start >= end || slots.length >= 12) return;
		const rounded = ceilQuarterHour(start, args.tz);
		if (end - rounded >= 1_800_000)
			slots.push({ start: rounded, end, label: slotLabel(rounded, end, args.tz) });
	};
	for (const working of workingIntervals(
		owner,
		Math.max(args.window.start, now + 3_600_000),
		args.window.end,
	).sort((a, b) => a.start - b.start)) {
		let start = working.start;
		for (const interval of busy) {
			if (interval.end <= start || interval.start >= working.end) continue;
			offer(start, Math.min(interval.start, working.end));
			start = Math.max(start, interval.end);
		}
		offer(start, working.end);
		if (slots.length === 12) break;
	}
	return { slots };
}
