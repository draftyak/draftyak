import ICAL from "ical.js";
import { CalendarError } from "./error.ts";

export type PositionedFrequency = "SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";

function refused(): never {
	throw new CalendarError("RESOURCE_LIMIT");
}

function unit(frequency: PositionedFrequency): number {
	switch (frequency) {
		case "SECONDLY":
			return 1000;
		case "MINUTELY":
			return 60_000;
		case "HOURLY":
			return 3_600_000;
		case "DAILY":
			return 86_400_000;
		case "WEEKLY":
			return 604_800_000;
		default:
			return refused();
	}
}

// Set the full year explicitly: Date.UTC interprets years 0..99 as 1900..1999.
// UTC here is an arithmetic coordinate for wall fields, never a zone conversion.
function nominal(time: ICAL.Time): Date {
	const date = new Date(0);
	date.setUTCFullYear(time.year, time.month - 1, time.day);
	date.setUTCHours(time.hour, time.minute, time.second, 0);
	if (
		!Number.isSafeInteger(date.getTime()) ||
		time.year < 0 ||
		time.year > 9999 ||
		date.getUTCFullYear() !== time.year ||
		date.getUTCMonth() + 1 !== time.month ||
		date.getUTCDate() !== time.day ||
		date.getUTCHours() !== time.hour ||
		date.getUTCMinutes() !== time.minute ||
		date.getUTCSeconds() !== time.second
	)
		refused();
	return date;
}

/** Natural FREQ interval for BYSETPOS; compatible DST instants do not define this bucket. */
export function periodKey(time: ICAL.Time, frequency: PositionedFrequency, wkst: number): number {
	const date = nominal(time);
	if (frequency !== "WEEKLY") {
		const width = unit(frequency);
		return Math.floor(date.getTime() / width) * width;
	}
	if (!Number.isInteger(wkst) || wkst < 1 || wkst > 7) refused();
	const day = Math.floor(date.getTime() / 86_400_000) * 86_400_000;
	return day - ((date.getUTCDay() + 1 - wkst + 7) % 7) * 86_400_000;
}

/** Start of the natural wall interval, retaining zone and DATE identity. */
export function periodStart(
	time: ICAL.Time,
	frequency: PositionedFrequency,
	wkst: number,
): ICAL.Time {
	if (time.isDate && unit(frequency) < 86_400_000) refused();
	const date = new Date(periodKey(time, frequency, wkst));
	if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999)
		refused();
	return new ICAL.Time(
		{
			year: date.getUTCFullYear(),
			month: date.getUTCMonth() + 1,
			day: date.getUTCDate(),
			hour: date.getUTCHours(),
			minute: date.getUTCMinutes(),
			second: date.getUTCSeconds(),
			isDate: time.isDate,
		},
		time.zone,
	);
}

/** Whether a complete natural interval belongs to DTSTART's original INTERVAL phase. */
export function inPeriodPhase(
	time: ICAL.Time,
	start: ICAL.Time,
	frequency: PositionedFrequency,
	wkst: number,
	interval: number,
): boolean {
	if (!Number.isSafeInteger(interval) || interval < 1) refused();
	const distance =
		(periodKey(time, frequency, wkst) - periodKey(start, frequency, wkst)) / unit(frequency);
	if (!Number.isSafeInteger(distance)) refused();
	return distance % interval === 0;
}
