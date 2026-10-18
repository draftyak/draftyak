import ICAL from "ical.js";
import {
	inPeriodPhase,
	type PositionedFrequency,
	periodKey,
	periodStart,
} from "./calendar-period.ts";
import { calendarRuleCandidates } from "./calendar-rule.ts";
import { CalendarError } from "./error.ts";
import { epoch } from "./zones.ts";

export const MAX_RECURRENCE_WORK = 100_000;
export const MAX_OFFSET_SPAN_MS: number = 48 * 60 * 60 * 1000;
const positionedFrequencies = new Set(["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY"]);
type Next = () => ICAL.Time | null;
const nominal = (time: ICAL.Time): number => periodKey(time, "SECONDLY", ICAL.Time.MONDAY);
const dateKey = (time: ICAL.Time): number => time.year * 10_000 + time.month * 100 + time.day;

function matchesLimits(time: ICAL.Time, rule: ICAL.Recur): boolean {
	for (const [name, value] of [
		["BYSECOND", time.second],
		["BYMINUTE", time.minute],
		["BYHOUR", time.hour],
		["BYMONTHDAY", time.day],
		["BYMONTH", time.month],
	] as const) {
		if (time.isDate && ["BYSECOND", "BYMINUTE", "BYHOUR"].includes(name)) continue;
		const values = rule.parts[name] as number[] | undefined;
		if (values && !values.includes(value)) return false;
	}
	const days = rule.parts.BYDAY as string[] | undefined;
	if (days && !days.some((day) => ICAL.Recur.icalDayToNumericDay(day) === time.dayOfWeek()))
		return false;
	const yearDays = rule.parts.BYYEARDAY as number[] | undefined;
	const yearLength = ICAL.Time.daysInMonth(2, time.year) === 29 ? 366 : 365;
	return !yearDays?.every((day) => (day > 0 ? day : yearLength + day + 1) !== time.dayOfYear());
}

function ruleStream(event: ICAL.Event, original: ICAL.Recur, spend: () => void): Next {
	const until = original.until?.clone() ?? null;
	const untilEpoch = until && !until.isDate ? epoch(until) : null;
	const count = original.count;
	const rule = original.clone();
	rule.until = null;
	rule.count = null;
	const positions = [...new Set((original.parts.BYSETPOS ?? []) as number[])];
	// Enforce wall-period phase for sub-month frequencies independently of the pinned iterator.
	const frequency = positionedFrequencies.has(rule.freq)
		? (rule.freq as PositionedFrequency)
		: null;
	const positioned = positions.length ? frequency : null;
	if (positioned) delete rule.parts.BYSETPOS;
	const start = event.startDate;
	if (start.isDate) {
		// RFC 5545 ignores time-of-day parts on DATE-valued DTSTART.
		delete rule.parts.BYSECOND;
		delete rule.parts.BYMINUTE;
		delete rule.parts.BYHOUR;
	}
	const startNominal = nominal(start);
	// Numeric list order has no meaning for any frequency, including the pinned paths.
	for (const name of [
		"BYSECOND",
		"BYMINUTE",
		"BYHOUR",
		"BYMONTHDAY",
		"BYYEARDAY",
		"BYWEEKNO",
		"BYMONTH",
		"BYSETPOS",
	] as const) {
		const values = rule.parts[name] as number[] | undefined;
		if (values) rule.parts[name] = [...new Set(values)].sort((a, b) => a - b);
	}
	// Only set positions need the complete first natural interval.
	// Retain original lower defaults when flooring that seed.
	if (positioned) {
		const rank = [...positionedFrequencies].indexOf(positioned);
		if (rank >= 1) rule.parts.BYSECOND ??= [start.second];
		if (rank >= 2) rule.parts.BYMINUTE ??= [start.minute];
		if (rank >= 3) rule.parts.BYHOUR ??= [start.hour];
		if (positioned === "WEEKLY")
			rule.parts.BYDAY ??= [ICAL.Recur.numericDayToIcalDay(start.dayOfWeek())];
	}
	const calendar =
		rule.freq === "MONTHLY" || rule.freq === "YEARLY"
			? calendarRuleCandidates(start, rule, spend)
			: null;
	const iterator = calendar
		? null
		: new ICAL.RecurIterator({
				rule,
				dtstart: positioned ? periodStart(start, positioned, rule.wkst) : start,
			});
	const raw: Next = () => {
		spend();
		return iterator?.next()?.clone() ?? null;
	};
	let pending: ICAL.Time | null = null,
		initialized = false;
	let selected: ICAL.Time[] = [],
		selectedAt = 0;
	const candidate: Next = calendar
		? () => calendar.next().value ?? null
		: positioned
			? () => {
					while (selectedAt >= selected.length) {
						const first = initialized ? pending : raw();
						initialized = true;
						if (!first) return null;
						const key = periodKey(first, positioned, rule.wkst);
						const values = new Map<number, ICAL.Time>();
						let value: ICAL.Time | null = first;
						while (value && periodKey(value, positioned, rule.wkst) === key) {
							const id = nominal(value);
							if (matchesLimits(value, rule)) {
								if (!values.has(id) && values.size >= MAX_RECURRENCE_WORK)
									throw new CalendarError("RESOURCE_LIMIT");
								values.set(id, value);
							}
							value = raw();
						}
						pending = value;
						// Same-frequency BY lists make the pinned iterator a superset of INTERVAL buckets.
						if (!inPeriodPhase(first, start, positioned, rule.wkst, rule.interval)) continue;
						const sorted = [...values.entries()].sort(([a], [b]) => a - b);
						const chosen = new Map<number, ICAL.Time>();
						for (const position of positions) {
							const entry = sorted[position > 0 ? position - 1 : sorted.length + position];
							if (entry && entry[0] >= startNominal) chosen.set(entry[0], entry[1]);
						}
						selected = [...chosen.entries()].sort(([a], [b]) => a - b).map(([, time]) => time);
						selectedAt = 0;
					}
					return selected[selectedAt++] ?? null;
				}
			: () => {
					// Without positions, retain the original seed/defaults and avoid bucket lookahead.
					for (;;) {
						const value = raw();
						if (
							!value ||
							!frequency ||
							(matchesLimits(value, rule) &&
								inPeriodPhase(value, start, frequency, rule.wkst, rule.interval))
						)
							return value;
					}
				};
	let emitted = 0;
	const seen = new Set<number>();
	let done = false;
	const offsetSpan = start.zone === ICAL.Timezone.utcTimezone ? 0 : MAX_OFFSET_SPAN_MS;
	return () => {
		if (done || (count !== null && emitted >= count)) return null;
		for (;;) {
			const value = candidate();
			if (!value) {
				done = true;
				return null;
			}
			const key = nominal(value);
			const instant = epoch(value);
			if (key < startNominal || seen.has(instant)) continue;
			if (until) {
				if (until.isDate) {
					if (dateKey(value) > dateKey(until)) {
						done = true;
						return null;
					}
				} else if (untilEpoch !== null && epoch(value) > untilEpoch) {
					// UNTIL is inclusive. A gap can move a later nominal value backwards in UTC.
					if (epoch(value) - offsetSpan > untilEpoch) {
						done = true;
						return null;
					}
					continue;
				}
			}
			if (seen.size >= MAX_RECURRENCE_WORK) throw new CalendarError("RESOURCE_LIMIT");
			seen.add(instant);
			emitted++;
			return value;
		}
	};
}

/** Independently bounded RRULE and RDATE streams; exclusions remain with the caller. */
export function recurrenceIterator(event: ICAL.Event, spend: () => void): { next: Next } {
	const original = event.component.getFirstPropertyValue("rrule");
	const nextRule = original instanceof ICAL.Recur ? ruleStream(event, original, spend) : () => null;
	const dates: ICAL.Time[] = [];
	for (const property of event.component.getAllProperties("rdate")) {
		for (const value of property.getValues())
			if (value instanceof ICAL.Time) dates.push(value.clone());
	}
	dates.sort((a, b) => epoch(a) - epoch(b));
	let at = 0;
	let head: ICAL.Time | null = null;
	let refresh = true;
	return {
		next() {
			if (refresh) {
				head = nextRule();
				refresh = false;
			}
			const date = dates[at];
			if (head && (!date || epoch(head) <= epoch(date))) {
				refresh = true;
				return head;
			}
			if (!date) return null;
			spend();
			at++;
			return date;
		},
	};
}
