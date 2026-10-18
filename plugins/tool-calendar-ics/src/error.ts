export type CalendarErrorCode =
	| "INVALID_INPUT"
	| "INVALID_FEED"
	| "TEMPORAL_UNAVAILABLE"
	| "UNKNOWN_TIME_ZONE"
	| "FEED_TOO_LARGE"
	| "TOO_MANY_COMPONENTS"
	| "TOO_MANY_INSTANCES"
	| "TOO_MANY_EVENTS"
	| "RESOURCE_LIMIT";

export class CalendarError extends Error {
	readonly code: CalendarErrorCode;

	constructor(code: CalendarErrorCode) {
		super(code);
		this.name = "CalendarError";
		this.code = code;
	}
}

export function invalid(): never {
	throw new CalendarError("INVALID_FEED");
}
