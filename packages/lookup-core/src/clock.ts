import { IanaZone } from "@draftyak/protocol/tool-v1";
import { LookupError, type OwnerState } from "./model.ts";

interface LocalDate {
	readonly dayOfWeek: number;
	add(value: { days: number }): LocalDate;
	toZonedDateTime(zone: string): Zoned;
	toString(): string;
}
interface Zoned {
	readonly epochMilliseconds: number;
	readonly offset: string;
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly dayOfWeek: number;
	readonly hour: number;
	readonly minute: number;
	round(options: { smallestUnit: "minute"; roundingIncrement: 15; roundingMode: "ceil" }): Zoned;
	toPlainDate(): LocalDate;
}
interface TemporalApi {
	Instant: { fromEpochMilliseconds(value: number): { toZonedDateTimeISO(zone: string): Zoned } };
	PlainDateTime: {
		from(value: string): {
			toZonedDateTime(zone: string, options: { disambiguation: "reject" }): Zoned;
		};
	};
}
function temporal(): TemporalApi {
	const api = (globalThis as unknown as { Temporal?: TemporalApi }).Temporal;
	if (!api) throw new LookupError("TIME_UNAVAILABLE");
	return api;
}
function clockValue<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		throw error instanceof LookupError ? error : new LookupError("TIME_UNAVAILABLE");
	}
}
const workingDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const hourMinute = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const worksOn = (owner: OwnerState, date: LocalDate): boolean => {
	const day = workingDays[date.dayOfWeek - 1];
	return day !== undefined && owner.workingHours.days.includes(day);
};
export function validateOwner(owner: OwnerState): void {
	try {
		owner = structuredClone(owner);
		const hours = owner.workingHours;
		if (
			!IanaZone.safeParse(owner.zone).success ||
			/^[+-]/.test(owner.zone) ||
			Object.keys(owner).sort().join(",") !== "workingHours,zone" ||
			!hours ||
			Array.isArray(hours) ||
			Object.keys(hours).sort().join(",") !== "days,end,start" ||
			!Array.isArray(hours.days) ||
			hours.days.length < 1 ||
			new Set(hours.days).size !== hours.days.length ||
			!hours.days.every((day) => (workingDays as readonly string[]).includes(day)) ||
			!hourMinute.test(hours.start) ||
			!(hourMinute.test(hours.end) || hours.end === "24:00") ||
			hours.start >= hours.end
		)
			throw new Error();
		temporal().Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(owner.zone);
	} catch {
		throw new LookupError("INVALID_OWNER_STATE");
	}
}
function at(date: LocalDate, minute: number, zone: string): number {
	if (minute === 1440) return at(date.add({ days: 1 }), 0, zone);
	const hour = String(Math.floor(minute / 60)).padStart(2, "0");
	const minutes = String(minute % 60).padStart(2, "0");
	return temporal()
		.PlainDateTime.from(`${date}T${hour}:${minutes}:00`)
		.toZonedDateTime(zone, { disambiguation: "reject" }).epochMilliseconds;
}
export function workingIntervals(
	owner: OwnerState,
	start: number,
	end: number,
): { start: number; end: number }[] {
	return clockValue(() => {
		owner = structuredClone(owner);
		validateOwner(owner);
		let date = temporal()
			.Instant.fromEpochMilliseconds(start)
			.toZonedDateTimeISO(owner.zone)
			.toPlainDate();
		const intervals: { start: number; end: number }[] = [];
		for (let days = 0; days < 76; days++, date = date.add({ days: 1 })) {
			if (date.toZonedDateTime(owner.zone).epochMilliseconds >= end) return intervals;
			if (worksOn(owner, date)) {
				const from = Math.max(start, at(date, minutesOf(owner.workingHours.start), owner.zone));
				const to = Math.min(end, at(date, minutesOf(owner.workingHours.end), owner.zone));
				if (from < to) intervals.push({ start: from, end: to });
			}
		}
		throw new LookupError("TIME_WINDOW_TOO_LARGE");
	});
}
export function calendarWindow(
	owner: OwnerState,
	now: number,
	horizon: 3 | 5 | 10,
): { start: number; end: number } {
	return clockValue(() => {
		owner = structuredClone(owner);
		validateOwner(owner);
		const start = Math.floor(now / 600_000) * 600_000;
		let date = temporal()
			.Instant.fromEpochMilliseconds(start)
			.toZonedDateTimeISO(owner.zone)
			.toPlainDate();
		let remaining: number = horizon;
		for (let days = 0; days < 76; days++, date = date.add({ days: 1 })) {
			if (
				worksOn(owner, date) &&
				at(date, minutesOf(owner.workingHours.end), owner.zone) > start &&
				--remaining === 0
			)
				return { start, end: date.add({ days: 1 }).toZonedDateTime(owner.zone).epochMilliseconds };
		}
		throw new LookupError("TIME_WINDOW_TOO_LARGE");
	});
}
export function ceilQuarterHour(value: number, zone: string): number {
	return clockValue(() => {
		const rounded = temporal().Instant.fromEpochMilliseconds(value).toZonedDateTimeISO(zone).round({
			smallestUnit: "minute",
			roundingIncrement: 15,
			roundingMode: "ceil",
		}).epochMilliseconds;
		if (rounded < value) throw new LookupError("TIME_UNAVAILABLE");
		return rounded;
	});
}
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const padded = (value: number): string => String(value).padStart(2, "0");
const wallClock = (value: Zoned): string => `${padded(value.hour)}:${padded(value.minute)}`;
function localLabel(value: Zoned): string {
	return `${weekdays[value.dayOfWeek - 1]} ${padded(value.day)} ${months[value.month - 1]} ${value.year}, ${wallClock(value)}`;
}
export function slotLabel(start: number, end: number, zone: string): string {
	return clockValue(() => {
		const api = temporal();
		const from = api.Instant.fromEpochMilliseconds(start).toZonedDateTimeISO(zone),
			to = api.Instant.fromEpochMilliseconds(end).toZonedDateTimeISO(zone);
		const sameDay = from.year === to.year && from.month === to.month && from.day === to.day;
		const offset =
			from.offset === to.offset ? `UTC${from.offset}` : `UTC${from.offset} → UTC${to.offset}`;
		return `${localLabel(from)}–${sameDay ? wallClock(to) : localLabel(to)} ${zone} (${offset})`;
	});
}
