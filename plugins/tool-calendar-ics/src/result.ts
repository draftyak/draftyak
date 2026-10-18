import {
	type BusyInterval,
	type CalendarFreebusyArguments,
	type CalendarFreebusyResult,
	mergeBusy,
	toolKindsV1,
} from "@draftyak/protocol/tool-v1/kinds";
import { CalendarError } from "./error.ts";

export { type BusyInterval, mergeBusy } from "@draftyak/protocol/tool-v1/kinds";
export type UtcWindow = CalendarFreebusyArguments["window"];
/** Compatibility name for the exact merged tool-v1 result; all instants are UTC milliseconds. */
export type CalendarResult = CalendarFreebusyResult;

const contract = toolKindsV1["calendar.freebusy"];

export function assertOutputSize(bytes: number): void {
	if (bytes > contract.maxBytes) throw new CalendarError("TOO_MANY_EVENTS");
}

export function toResult(intervals: readonly BusyInterval[]): CalendarResult {
	const parsed = contract.result.safeParse({ busy: mergeBusy(intervals) });
	if (!parsed.success) throw new CalendarError("TOO_MANY_EVENTS");
	const result = parsed.data;
	assertOutputSize(new TextEncoder().encode(JSON.stringify(result)).byteLength);
	return result;
}
