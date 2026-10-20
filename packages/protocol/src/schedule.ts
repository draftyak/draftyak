import { UtcMs } from "./scalars.ts";
import { IanaZone } from "./tool-v1/kinds.ts";

export type ScheduleErrorCode =
	| "INVALID_INPUT"
	| "SCHEDULING_UNAVAILABLE"
	| "NONEXISTENT_LOCAL_TIME"
	| "AMBIGUOUS_LOCAL_TIME";
export class ScheduleError extends Error {
	readonly code: ScheduleErrorCode;
	constructor(code: ScheduleErrorCode) {
		super(code);
		this.code = code;
	}
}
interface PlainWall {
	toZonedDateTime(zone: string, options: { disambiguation: "earlier" | "later" }): ZonedWall;
	equals(other: PlainWall): boolean;
}
interface ZonedWall {
	readonly epochMilliseconds: number;
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly offset: string;
	toPlainDateTime(): PlainWall;
}
interface TemporalApi {
	readonly PlainDateTime: { from(text: string, options: { overflow: "reject" }): PlainWall };
	readonly Instant: {
		fromEpochMilliseconds(instant: number): { toZonedDateTimeISO(zone: string): ZonedWall };
	};
}
function temporal(): TemporalApi {
	const api = Reflect.get(globalThis, "Temporal") as TemporalApi | undefined;
	if (api === undefined) throw new ScheduleError("SCHEDULING_UNAVAILABLE");
	return api;
}
// The pinned Jiff timestamp range reserves room for every legal UTC offset.
export const MAX_SCHEDULE_UTC_MS = 253_402_207_200_999;
function checkedInstant(instant: number): void {
	if (!UtcMs.safeParse(instant).success || instant > MAX_SCHEDULE_UTC_MS)
		throw new ScheduleError("INVALID_INPUT");
}
const WALL = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/;
function checkedZone(zone: string): void {
	if (typeof zone !== "string" || zone.length > 64 || !IanaZone.safeParse(zone).success)
		throw new ScheduleError("INVALID_INPUT");
}

/** A strict minute wall time with no offset. Gaps and overlaps are never silently adjusted. */
export function resolveLocalTime(wall: string, zone: string): number {
	if (typeof wall !== "string" || wall.length !== 16 || !WALL.test(wall))
		throw new ScheduleError("INVALID_INPUT");
	checkedZone(zone);
	const api = temporal();
	try {
		const plain = api.PlainDateTime.from(wall, { overflow: "reject" });
		const earlier = plain.toZonedDateTime(zone, { disambiguation: "earlier" });
		const later = plain.toZonedDateTime(zone, { disambiguation: "later" });
		if (earlier.epochMilliseconds !== later.epochMilliseconds) {
			throw new ScheduleError(
				earlier.toPlainDateTime().equals(plain) ? "AMBIGUOUS_LOCAL_TIME" : "NONEXISTENT_LOCAL_TIME",
			);
		}
		checkedInstant(earlier.epochMilliseconds);
		// Refuse instants whose local offset cannot fit the frozen snapshot's minute format.
		renderLocalWallTime(earlier.epochMilliseconds, zone);
		return earlier.epochMilliseconds;
	} catch (error) {
		if (error instanceof ScheduleError) throw error;
		throw new ScheduleError("INVALID_INPUT");
	}
}

/** Render the existing snapshot format at minute precision, without consulting a clock. */
export function renderLocalWallTime(notBefore: number, zone: string): string {
	checkedInstant(notBefore);
	checkedZone(zone);
	const api = temporal();
	try {
		const value = api.Instant.fromEpochMilliseconds(notBefore).toZonedDateTimeISO(zone);
		if (value.year < 0 || value.year > 9999 || !/^[+-][0-9]{2}:[0-9]{2}$/.test(value.offset))
			throw new ScheduleError("INVALID_INPUT");
		const pad = (part: number, width = 2): string => String(part).padStart(width, "0");
		return `${pad(value.year, 4)}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}${value.offset}`;
	} catch (error) {
		if (error instanceof ScheduleError) throw error;
		throw new ScheduleError("INVALID_INPUT");
	}
}
