import ICAL from "ical.js";
import { periodKey } from "./calendar-period.ts";
import { CalendarError, invalid } from "./error.ts";

interface Transition {
	readonly at: number;
	readonly from: number;
	readonly to: number;
}

interface Observance {
	readonly start: ICAL.Time;
	readonly from: number;
	readonly to: number;
	readonly rule: ICAL.Recur | null;
	year: number;
	emitted: number;
	done: boolean;
}

export interface FeedZoneBudget {
	work(): void;
	transition(): void;
	dates(count: number): void;
}

const wall = (time: ICAL.Time): number => periodKey(time, "SECONDLY", ICAL.Time.MONDAY);
const numbers = (
	rule: ICAL.Recur,
	name: "BYMONTH" | "BYHOUR" | "BYMINUTE" | "BYSECOND",
	fallback: readonly number[],
): number[] => [...new Set(rule.parts[name] ?? fallback)].sort((a, b) => a - b);

function localTime(raw: unknown): ICAL.Time {
	if (
		typeof raw !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw) ||
		raw.slice(17, 19) === "60"
	)
		invalid();
	const time = ICAL.Time.fromDateTimeString(raw);
	if (
		time.year !== Number(raw.slice(0, 4)) ||
		time.month !== Number(raw.slice(5, 7)) ||
		time.day !== Number(raw.slice(8, 10)) ||
		time.hour !== Number(raw.slice(11, 13)) ||
		time.minute !== Number(raw.slice(14, 16)) ||
		time.second !== Number(raw.slice(17, 19))
	)
		invalid();
	wall(time);
	return time;
}

function offset(component: ICAL.Component, name: string): number {
	if (component.getAllProperties(name).length !== 1) invalid();
	const raw: unknown = component.getFirstProperty(name)?.toJSON()[3];
	if (
		typeof raw !== "string" ||
		!/^[+-]\d{2}:\d{2}(:\d{2})?$/.test(raw) ||
		Number(raw.slice(1, 3)) > 23 ||
		Number(raw.slice(4, 6)) > 59 ||
		Number(raw.slice(7, 9) || 0) > 59 ||
		/^-00:00(:00)?$/.test(raw)
	)
		invalid();
	return (
		(raw.startsWith("-") ? -1 : 1) *
		(Number(raw.slice(1, 3)) * 3600 + Number(raw.slice(4, 6)) * 60 + Number(raw.slice(7, 9) || 0))
	);
}

function matchesDay(time: ICAL.Time, rule: ICAL.Recur): boolean {
	const monthLength = ICAL.Time.daysInMonth(time.month, time.year);
	const yearLength = ICAL.Time.daysInMonth(2, time.year) === 29 ? 366 : 365;
	const monthDays = rule.parts.BYMONTHDAY as number[] | undefined;
	if (monthDays && !monthDays.some((day) => (day > 0 ? day : monthLength + day + 1) === time.day))
		return false;
	const yearDays = rule.parts.BYYEARDAY as number[] | undefined;
	if (
		yearDays &&
		!yearDays.some((day) => (day > 0 ? day : yearLength + day + 1) === time.dayOfYear())
	)
		return false;
	const days = rule.parts.BYDAY as string[] | undefined;
	return (
		!days ||
		days.some((day) => {
			if (ICAL.Recur.icalDayToNumericDay(day.slice(-2)) !== time.dayOfWeek()) return false;
			const position = Number(day.slice(0, -2));
			if (!position) return true;
			const index = rule.parts.BYMONTH ? time.day : time.dayOfYear();
			const length = rule.parts.BYMONTH ? monthLength : yearLength;
			return (
				position ===
				(position > 0 ? Math.floor((index - 1) / 7) + 1 : -Math.floor((length - index) / 7) - 1)
			);
		})
	);
}

/** Feed definitions use RFC 5545 wall-time disambiguation without upstream transition expansion. */
export class FeedZone extends ICAL.Timezone {
	readonly #budget: FeedZoneBudget;
	readonly #observances: Observance[] = [];
	readonly #offsets = new Set<number>();
	readonly #entries = new Map<number, Transition>();
	#transitions: Transition[] = [];
	#dirty = false;

	constructor(component: ICAL.Component, id: string, budget: FeedZoneBudget) {
		super({ tzid: id });
		this.#budget = budget;
		const components = component.getAllSubcomponents();
		if (!components.length) invalid();
		for (const part of components) {
			if (
				!["standard", "daylight"].includes(part.name) ||
				part.getAllProperties("dtstart").length !== 1 ||
				part.getAllProperties("rrule").length > 1
			)
				invalid();
			const start = localTime(part.getFirstProperty("dtstart")?.toJSON()[3]);
			const from = offset(part, "tzoffsetfrom"),
				to = offset(part, "tzoffsetto");
			this.#offsets.add(from);
			this.#offsets.add(to);
			const rule = part.getFirstPropertyValue("rrule");
			if (
				rule !== null &&
				(!(rule instanceof ICAL.Recur) ||
					rule.freq !== "YEARLY" ||
					rule.parts.BYWEEKNO ||
					(rule.until && (rule.until.isDate || rule.until.zone !== ICAL.Timezone.utcTimezone)))
			)
				invalid();
			const observance: Observance = {
				start,
				from,
				to,
				rule: rule as ICAL.Recur | null,
				year: start.year - 1,
				emitted: 1,
				done: false,
			};
			this.#observances.push(observance);
			this.#add(wall(start) - from * 1000, from, to);
			for (const property of part.getAllProperties("rdate")) {
				if (property.type !== "date-time" || property.getParameter("tzid")) invalid();
				const values = property.toJSON().slice(3);
				this.#budget.dates(values.length);
				for (const value of values) this.#add(wall(localTime(value)) - from * 1000, from, to);
			}
		}
	}

	#add(at: number, from: number, to: number): void {
		const prior = this.#entries.get(at);
		if (prior) {
			if (prior.from !== from || prior.to !== to) invalid();
			return;
		}
		this.#budget.transition();
		this.#entries.set(at, { at, from, to });
		this.#dirty = true;
	}

	#expand(observance: Observance, year: number): void {
		const { rule, start, from, to } = observance;
		if (!rule || observance.done) return;
		const until = rule.until ? rule.until.toUnixTime() * 1000 : null;
		const startWall = wall(start);
		while (observance.year < year) {
			this.#budget.work();
			const current = ++observance.year;
			if (rule.count !== null && observance.emitted >= rule.count) {
				observance.done = true;
				return;
			}
			if (until !== null && current > new Date(until).getUTCFullYear() + 1) {
				observance.done = true;
				return;
			}
			if ((current - start.year) % rule.interval) continue;
			const expandDays = rule.parts.BYDAY || rule.parts.BYMONTHDAY || rule.parts.BYYEARDAY;
			const months = numbers(
				rule,
				"BYMONTH",
				expandDays ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [start.month],
			);
			const values: number[] = [];
			for (const month of months) {
				const length = ICAL.Time.daysInMonth(month, current);
				for (
					let day = expandDays ? 1 : start.day;
					day <= (expandDays ? length : start.day);
					day++
				) {
					this.#budget.work();
					if (day > length) continue;
					const time = new ICAL.Time(
						{ year: current, month, day, hour: 0, minute: 0, second: 0, isDate: false },
						ICAL.Timezone.localTimezone,
					);
					if (!matchesDay(time, rule)) continue;
					for (const hour of numbers(rule, "BYHOUR", [start.hour]))
						for (const minute of numbers(rule, "BYMINUTE", [start.minute]))
							for (const second of numbers(rule, "BYSECOND", [start.second])) {
								this.#budget.work();
								time.hour = hour;
								time.minute = minute;
								time.second = second;
								values.push(wall(time));
							}
				}
			}
			const positions = rule.parts.BYSETPOS as number[] | undefined;
			const selected = positions
				? [
						...new Set(
							positions
								.map((position) => values[position > 0 ? position - 1 : values.length + position])
								.filter((value) => value !== undefined),
						),
					].sort((a, b) => a - b)
				: values;
			for (const value of selected) {
				if (value <= startWall) continue;
				const at = value - from * 1000;
				if (until !== null && at > until) continue;
				if (rule.count !== null && observance.emitted >= rule.count) {
					observance.done = true;
					break;
				}
				observance.emitted++;
				this.#add(at, from, to);
			}
		}
	}

	#ensure(year: number): void {
		if (year >= 9999) throw new CalendarError("RESOURCE_LIMIT");
		for (const observance of this.#observances) this.#expand(observance, year + 1);
		if (this.#dirty) {
			this.#transitions = [...this.#entries.values()].sort((a, b) => {
				this.#budget.work();
				return a.at - b.at;
			});
			this.#dirty = false;
		}
	}

	#at(instant: number): number {
		let low = 0,
			high = this.#transitions.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			const transition = this.#transitions[mid];
			if (!transition) invalid();
			if (transition.at <= instant) low = mid + 1;
			else high = mid;
		}
		const transition = this.#transitions[low ? low - 1 : 0];
		if (!transition) invalid();
		return low ? transition.to : transition.from;
	}

	override utcOffset(time: ICAL.Time): number {
		const local = wall(time);
		this.#ensure(time.year);
		let earliest: number | null = null;
		for (const offset of this.#offsets) {
			this.#budget.work();
			const instant = local - offset * 1000;
			if (this.#at(instant) === offset && (earliest === null || instant < earliest))
				earliest = instant;
		}
		if (earliest !== null) return (local - earliest) / 1000;
		let before: number | null = null;
		for (const transition of this.#transitions) {
			this.#budget.work();
			if (
				transition.to > transition.from &&
				local >= transition.at + transition.from * 1000 &&
				local < transition.at + transition.to * 1000
			) {
				if (before !== null && before !== transition.from) invalid();
				before = transition.from;
			}
		}
		if (before === null) invalid();
		return before;
	}
}
