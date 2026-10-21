import { type FreeSlot, type OwnerState, renderFreeSlots } from "@draftyak/lookup-core/calendar";
import {
	type CalendarFreebusyArguments,
	type CalendarFreebusyResult,
	checkToolResult,
} from "@draftyak/protocol/tool-v1";
import { type CalendarResult, freeBusy } from "@draftyak/tool-calendar-ics";

export interface CalendarComposition {
	raw: CalendarResult;
	checked: CalendarFreebusyResult;
	actual: { slots: FreeSlot[] };
}

export function composeCalendar(
	feed: Uint8Array,
	args: CalendarFreebusyArguments,
	owner: OwnerState,
	now: number,
	beforeRender: () => void = () => {},
): CalendarComposition {
	const raw = freeBusy(feed, args.window, args.tz);
	const checked = checkToolResult("calendar.freebusy", {
		resultType: "complete",
		content: [],
		structuredContent: raw,
	});
	if (checked.status !== "ok") throw new Error("Calendar wire result refused.");
	beforeRender();
	const actual = renderFreeSlots(checked.value, args, owner, now);
	return { raw, checked: checked.value, actual };
}
