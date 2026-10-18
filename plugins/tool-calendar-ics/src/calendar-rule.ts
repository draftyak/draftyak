import ICAL from "ical.js";
import { CalendarError } from "./error.ts";

const DAY = 86_400_000;
const MAX_CANDIDATES = 100_000;

// UTC is only a coordinate for Gregorian wall dates here, never a zone conversion.
function dayNumber(year: number, month: number, day: number): number {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	return date.getTime() / DAY;
}

function firstWeek(year: number, wkst: number): number {
	const fourth = dayNumber(year, 1, 4);
	const weekday = new Date(fourth * DAY).getUTCDay() + 1;
	return fourth - ((weekday - wkst + 7) % 7);
}

function numbered(values: readonly number[] | undefined, value: number, length: number): boolean {
	return !values || values.some((item) => (item > 0 ? item : length + item + 1) === value);
}

function matchesDate(date: Date, start: ICAL.Time, rule: ICAL.Recur): boolean {
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 1;
	const day = date.getUTCDate();
	const months = rule.parts.BYMONTH as number[] | undefined;
	const monthDays = rule.parts.BYMONTHDAY as number[] | undefined;
	const yearDays = rule.parts.BYYEARDAY as number[] | undefined;
	const weeks = rule.parts.BYWEEKNO as number[] | undefined;
	const days = rule.parts.BYDAY as string[] | undefined;
	if (months && !months.includes(month)) return false;
	const coordinate = date.getTime() / DAY;
	const yearStart = dayNumber(year, 1, 1);
	const yearLength = dayNumber(year + 1, 1, 1) - yearStart;
	const monthLength = ICAL.Time.daysInMonth(month, year);
	if (!numbered(monthDays, day, monthLength)) return false;
	if (!numbered(yearDays, coordinate - yearStart + 1, yearLength)) return false;
	if (weeks) {
		// A calendar year can contain days of the previous year's last week or
		// the following year's first week. WKST and the four-day rule define both.
		let weekYear = year;
		if (coordinate < firstWeek(year, rule.wkst)) weekYear--;
		else if (coordinate >= firstWeek(year + 1, rule.wkst)) weekYear++;
		const first = firstWeek(weekYear, rule.wkst);
		const length = (firstWeek(weekYear + 1, rule.wkst) - first) / 7;
		if (!numbered(weeks, Math.floor((coordinate - first) / 7) + 1, length)) return false;
	}
	if (days) {
		const weekday = date.getUTCDay() + 1;
		const monthScope = rule.freq === "MONTHLY" || !!months;
		const ordinal = monthScope ? day : coordinate - yearStart + 1;
		const length = monthScope ? monthLength : yearLength;
		if (
			!days.some((entry) => {
				if (ICAL.Recur.icalDayToNumericDay(entry.slice(-2)) !== weekday) return false;
				const rank = Number(entry.slice(0, -2));
				return (
					!rank ||
					(rank > 0 ? Math.ceil(ordinal / 7) : -Math.ceil((length - ordinal + 1) / 7)) === rank
				);
			})
		)
			return false;
	}
	// Only information not expanded by a day selector is inherited from DTSTART.
	if (!monthDays && !yearDays && !weeks && !days) {
		if (day !== start.day) return false;
		if (rule.freq === "YEARLY" && !months && month !== start.month) return false;
	}
	return true;
}

/** Valid, ordered MONTHLY/YEARLY candidates, before DTSTART/COUNT/UNTIL filtering. */
export function* calendarRuleCandidates(
	start: ICAL.Time,
	rule: ICAL.Recur,
	spend: () => void,
): Generator<ICAL.Time, null> {
	const monthly = rule.freq === "MONTHLY";
	const hours = start.isDate ? [0] : ((rule.parts.BYHOUR as number[] | undefined) ?? [start.hour]);
	const minutes = start.isDate
		? [0]
		: ((rule.parts.BYMINUTE as number[] | undefined) ?? [start.minute]);
	const seconds = start.isDate
		? [0]
		: ((rule.parts.BYSECOND as number[] | undefined) ?? [start.second]);
	const positions = rule.parts.BYSETPOS as number[] | undefined;
	let period = monthly ? start.year * 12 + start.month - 1 : start.year;
	for (;;) {
		spend();
		const year = monthly ? Math.floor(period / 12) : period;
		const month = monthly ? (period % 12) + 1 : 1;
		if (!Number.isSafeInteger(period) || year < 0 || year > 9999)
			throw new CalendarError("RESOURCE_LIMIT");
		const end = monthly ? dayNumber(year, month + 1, 1) : dayNumber(year + 1, 1, 1);
		const values: ICAL.Time[] = [];
		for (let day = dayNumber(year, month, 1); day < end; day++) {
			spend();
			const date = new Date(day * DAY);
			if (!matchesDate(date, start, rule)) continue;
			for (const hour of hours) {
				for (const minute of minutes) {
					for (const second of seconds) {
						spend();
						const value = new ICAL.Time(
							{
								year,
								month: date.getUTCMonth() + 1,
								day: date.getUTCDate(),
								hour,
								minute,
								second,
								isDate: start.isDate,
							},
							start.zone,
						);
						if (!positions) yield value;
						else {
							if (values.length >= MAX_CANDIDATES) throw new CalendarError("RESOURCE_LIMIT");
							values.push(value);
						}
					}
				}
			}
		}
		if (positions) {
			const selected = new Set<number>();
			for (const position of positions) {
				const index = position > 0 ? position - 1 : values.length + position;
				if (index >= 0 && index < values.length) selected.add(index);
			}
			for (const index of [...selected].sort((a, b) => a - b)) {
				const value = values[index];
				if (value) yield value;
			}
		}
		period += rule.interval;
	}
}
