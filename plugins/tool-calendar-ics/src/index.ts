import { runInNewContext } from "node:vm";
import { toolKindsV1 } from "@draftyak/protocol/tool-v1/kinds";
import { compute } from "./engine.ts";
import { CalendarError } from "./error.ts";
import type { CalendarResult, UtcWindow } from "./result.ts";
import { temporal } from "./zones.ts";

export { CalendarError, type CalendarErrorCode } from "./error.ts";
export { type BusyInterval, type CalendarResult, mergeBusy, type UtcWindow } from "./result.ts";

export interface FreeBusyOptions {
	/** Trusted caller passes the time remaining in the ready-instance budget after fetching. */
	readonly timeoutMs?: number;
}

export function freeBusy(
	feed: Uint8Array,
	window: UtcWindow,
	timeZone: string,
	options: FreeBusyOptions = {},
): CalendarResult {
	try {
		temporal();
		if (!options || typeof options !== "object" || Array.isArray(options))
			throw new CalendarError("INVALID_INPUT");
		const timeoutMs =
			options.timeoutMs === undefined
				? toolKindsV1["calendar.freebusy"].timeoutMs
				: options.timeoutMs;
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > toolKindsV1["calendar.freebusy"].timeoutMs
		)
			throw new CalendarError("INVALID_INPUT");
		const argumentsResult = toolKindsV1["calendar.freebusy"].arguments.safeParse({
			window,
			tz: timeZone,
		});
		if (
			!(feed instanceof Uint8Array) ||
			!argumentsResult.success ||
			!Number.isFinite(new Date(window.start).getTime()) ||
			!Number.isFinite(new Date(window.end).getTime())
		)
			throw new CalendarError("INVALID_INPUT");
		if (feed.byteLength > 32 * 1024 * 1024) throw new CalendarError("FEED_TOO_LARGE");
		return runInNewContext(
			"compute()",
			{
				compute: () => compute(feed, argumentsResult.data.window, argumentsResult.data.tz),
			},
			{ timeout: timeoutMs },
		) as CalendarResult;
	} catch (error) {
		if (error instanceof CalendarError) throw error;
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
		)
			throw new CalendarError("RESOURCE_LIMIT");
		throw new CalendarError("INVALID_FEED");
	}
}
