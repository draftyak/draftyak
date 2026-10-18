import ICAL from "ical.js";
import { CalendarError, invalid } from "./error.ts";
import { eventUid, outsideWindow, rawEvent, ruleOutsideWindow } from "./raw-event.ts";
import { MAX_OFFSET_SPAN_MS, MAX_RECURRENCE_WORK, recurrenceIterator } from "./recurrence.ts";
import { type BusyInterval, type CalendarResult, toResult, type UtcWindow } from "./result.ts";
import { validateRule } from "./rules.ts";
import { components } from "./scan.ts";
import { epoch, temporal, Zones } from "./zones.ts";

function parse(text: string): ICAL.Component {
	return new ICAL.Component(ICAL.parse(text));
}

function validateRules(text: string): void {
	for (const line of text.split("\r\n")) if (/^RRULE[;:]/i.test(line)) validateRule(line);
}

function validate(component: ICAL.Component, zones: Zones): ICAL.Event {
	for (const field of [
		"uid",
		"dtstart",
		"dtend",
		"duration",
		"rrule",
		"recurrence-id",
		"status",
		"transp",
	]) {
		if (component.getAllProperties(field).length > 1) invalid();
	}
	if (component.hasProperty("dtend") && component.hasProperty("duration")) invalid();
	if (component.getFirstProperty("recurrence-id")?.getParameter("range")) invalid();
	for (const name of ["status", "transp"]) {
		const value = component.getFirstPropertyValue(name);
		if (value !== null) {
			if (typeof value !== "string") invalid();
			component.updatePropertyWithValue(name, value.toUpperCase());
		}
	}
	zones.bind(component);
	const event = new ICAL.Event(component, { exceptions: [] });
	const dropped = skip(event);
	if (!event.startDate) {
		if (!dropped || !event.isRecurrenceException()) invalid();
		event.startDate = event.recurrenceId.clone();
	}
	if (
		event.startDate.isDate !== event.endDate.isDate ||
		epoch(eventEnd(event, event.startDate)) < epoch(event.startDate)
	)
		invalid();
	if (
		component.hasProperty("duration") &&
		(event.duration.isNegative ||
			(event.startDate.isDate &&
				(event.duration.hours || event.duration.minutes || event.duration.seconds)))
	)
		invalid();
	const rule = component.getFirstPropertyValue("rrule");
	if (rule) {
		if (!(rule instanceof ICAL.Recur)) invalid();
		if (
			rule.interval < 1 ||
			!Number.isSafeInteger(rule.interval) ||
			(rule.count !== null && (!Number.isSafeInteger(rule.count) || rule.count < 1))
		)
			invalid();
		if (rule.until) {
			if (rule.until.isDate !== event.startDate.isDate) invalid();
			if (rule.until.zone === ICAL.Timezone.localTimezone) rule.until.zone = event.startDate.zone;
		}
	}
	if (event.isRecurring() && (!event.uid || event.isRecurrenceException())) invalid();
	return event;
}

function skip(event: ICAL.Event): boolean {
	return (
		event.component.getFirstPropertyValue("status") === "CANCELLED" ||
		event.component.getFirstPropertyValue("transp") === "TRANSPARENT"
	);
}

function eventEnd(event: ICAL.Event, start: ICAL.Time): ICAL.Time {
	const end = start.clone();
	if (event.component.hasProperty("duration")) {
		const duration = event.duration;
		end.day += duration.weeks * 7 + duration.days;
		return ICAL.Time.fromJSDate(
			new Date(
				epoch(end) + (duration.hours * 3600 + duration.minutes * 60 + duration.seconds) * 1000,
			),
			true,
		);
	}
	if (start.isDate) {
		// Calendar days remain calendar days across offset changes.
		end.addDuration(event.endDate.subtractDate(event.startDate));
	} else {
		return ICAL.Time.fromJSDate(
			new Date(epoch(start) + epoch(event.endDate) - epoch(event.startDate)),
			true,
		);
	}
	return end;
}

function recurrenceOffsetSpan(event: ICAL.Event): number {
	const utc = ICAL.Timezone.utcTimezone;
	const allUtc =
		event.startDate.zone === utc &&
		event.component
			.getAllProperties("rdate")
			.every((property) =>
				property.getValues().every((value) => value instanceof ICAL.Time && value.zone === utc),
			);
	// Temporal offsets and validated feed offsets are strictly within +/-24 hours.
	// Each pending head is >= the selected UTC instant; later wall fields cannot decrease.
	// A later offset can therefore move any stream back by less than 48 hours, even
	// across a skipped day or when a UTC RDATE precedes a named-zone recurrence head.
	return allUtc ? 0 : MAX_OFFSET_SPAN_MS;
}

export function compute(feed: Uint8Array, window: UtcWindow, timeZone: string): CalendarResult {
	const zones = new Zones(timeZone);
	let kept = 0;
	const retain = (): void => {
		if (++kept > 5000) throw new CalendarError("TOO_MANY_COMPONENTS");
	};
	for (const text of components(feed, "VTIMEZONE")) {
		retain();
		validateRules(text);
		const component = parse(text);
		const id = component.getFirstPropertyValue("tzid");
		if (typeof id !== "string" || !id || zones.feed.has(id)) invalid();
		const observances = component.getAllSubcomponents();
		if (!observances.length) invalid();
		for (const observance of observances) {
			if (
				!["dtstart", "tzoffsetfrom", "tzoffsetto"].every(
					(key) => observance.getAllProperties(key).length === 1,
				)
			)
				invalid();
			const start = observance.getFirstProperty("dtstart");
			const raw: unknown = start?.toJSON()[3];
			if (
				typeof raw !== "string" ||
				!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw) ||
				raw.slice(17, 19) === "60"
			)
				invalid();
			temporal().PlainDateTime.from(raw, { overflow: "reject" });
			for (const key of ["tzoffsetfrom", "tzoffsetto"]) {
				const offset: unknown = observance.getFirstProperty(key)?.toJSON()[3];
				if (
					typeof offset !== "string" ||
					!/^[+-]\d{2}:\d{2}(:\d{2})?$/.test(offset) ||
					Number(offset.slice(1, 3)) > 23 ||
					Number(offset.slice(4, 6)) > 59 ||
					Number(offset.slice(7, 9) || 0) > 59 ||
					/^-00:00(:00)?$/.test(offset)
				)
					invalid();
			}
		}
		zones.addFeed(component, id);
	}
	const masterIds = new Set<string>();
	for (const text of components(feed, "VEVENT")) {
		const raw = rawEvent(text);
		if (raw.exception || !raw.recurring || outsideWindow(raw, window)) continue;
		const uid = eventUid(raw);
		if (uid && !masterIds.has(uid)) {
			if (masterIds.size + kept >= 5000) throw new CalendarError("TOO_MANY_COMPONENTS");
			masterIds.add(uid);
		}
	}
	const events: ICAL.Event[] = [];
	const standalone: ICAL.Event[] = [];
	const standaloneIds = new Map<string, Set<number>>();
	for (const text of components(feed, "VEVENT")) {
		const raw = rawEvent(text);
		const orphan = raw.exception && !masterIds.has(eventUid(raw) ?? "");
		if ((!raw.exception || orphan) && outsideWindow(raw, window)) continue;
		const relevant =
			raw.fields.has("RDATE") && ruleOutsideWindow(raw, window)
				? text
						.split("\r\n")
						.filter((line) => !/^RRULE[;:]/i.test(line))
						.join("\r\n")
				: text;
		validateRules(relevant);
		const event = validate(parse(relevant), zones);
		if (orphan) {
			if (!event.uid) invalid();
			if (
				!skip(event) &&
				epoch(event.startDate) < window.end &&
				epoch(eventEnd(event, event.startDate)) > window.start
			) {
				retain();
				const ids = standaloneIds.get(event.uid) ?? new Set<number>();
				const id = epoch(event.recurrenceId);
				if (ids.has(id)) invalid();
				ids.add(id);
				standaloneIds.set(event.uid, ids);
				standalone.push(event);
			}
			continue;
		}
		if (
			event.isRecurring() ||
			event.isRecurrenceException() ||
			(!skip(event) &&
				epoch(event.startDate) < window.end &&
				epoch(eventEnd(event, event.startDate)) > window.start)
		) {
			retain();
			events.push(event);
		}
	}
	const masters = new Map<string, ICAL.Event>();
	const overrides = new Map<string, Map<number, ICAL.Event>>();
	for (const event of events) {
		if (event.isRecurrenceException()) {
			if (!event.uid) invalid();
			const group = overrides.get(event.uid) ?? new Map<number, ICAL.Event>();
			const id = epoch(event.recurrenceId);
			if (group.has(id)) invalid();
			group.set(id, event);
			overrides.set(event.uid, group);
		} else if (event.uid) {
			if (masters.has(event.uid)) invalid();
			masters.set(event.uid, event);
		}
	}
	for (const uid of overrides.keys()) if (!masters.has(uid)) invalid();
	for (const [uid, group] of overrides) {
		for (const exception of group.values())
			if (exception.recurrenceId.isDate !== masters.get(uid)?.startDate.isDate) invalid();
	}
	const busy: BusyInterval[] = [];
	let instances = 0;
	let work = 0;
	const add = (event: ICAL.Event, start: ICAL.Time, end: ICAL.Time): void => {
		if (skip(event)) return;
		const from = Math.max(window.start, epoch(start));
		const to = Math.min(window.end, epoch(end));
		if (from >= to) return;
		if (++instances > 2000) throw new CalendarError("TOO_MANY_INSTANCES");
		busy.push({
			start: from,
			end: to,
			status:
				event.component.getFirstPropertyValue("status") === "TENTATIVE" ? "tentative" : "busy",
		});
	};
	for (const event of standalone) add(event, event.startDate, eventEnd(event, event.startDate));
	for (const master of events) {
		if (master.isRecurrenceException()) continue;
		const exceptions = overrides.get(master.uid);
		// Detached moves can enter the window from an original occurrence outside it.
		for (const exception of exceptions?.values() ?? [])
			add(exception, exception.startDate, eventEnd(exception, exception.startDate));
		if (skip(master)) continue;
		if (!master.isRecurring()) {
			if (overrides.has(master.uid)) invalid();
			add(master, master.startDate, eventEnd(master, master.startDate));
			continue;
		}
		const excluded = new Set<number>();
		for (const property of master.component.getAllProperties("exdate")) {
			for (const value of property.getValues())
				if (value instanceof ICAL.Time) excluded.add(epoch(value));
		}
		const first = epoch(master.startDate);
		if (!excluded.has(first) && !exceptions?.has(first))
			add(master, master.startDate, eventEnd(master, master.startDate));
		const iterator = recurrenceIterator(master, () => {
			if (++work > MAX_RECURRENCE_WORK) throw new CalendarError("RESOURCE_LIMIT");
		});
		const offsetSpan = recurrenceOffsetSpan(master);
		const seen = new Set<number>([first]);
		while (true) {
			const occurrence = iterator.next();
			if (!occurrence) break;
			const id = epoch(occurrence);
			if (id - offsetSpan >= window.end) break;
			if (seen.has(id)) continue;
			seen.add(id);
			if (!excluded.has(id) && !exceptions?.has(id))
				add(master, occurrence, eventEnd(master, occurrence));
		}
	}
	return toResult(busy);
}
