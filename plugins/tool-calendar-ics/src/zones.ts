import ICAL from "ical.js";
import { CalendarError, invalid } from "./error.ts";
import { FeedZone } from "./feed-zone.ts";

export const MAX_DATE_VALUES = 10_000;
export const MAX_ZONE_TRANSITIONS = 10_000;
export const MAX_ZONE_WORK = 100_000;

interface Wall {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

interface NativeTemporal {
	PlainDateTime: {
		from(
			value: Wall | string,
			options?: { overflow: "reject" },
		): {
			toZonedDateTime(
				zone: string,
				options?: { disambiguation: "compatible" },
			): { epochMilliseconds: number };
		};
	};
}

export function temporal(): NativeTemporal {
	const api = (globalThis as unknown as { Temporal?: NativeTemporal }).Temporal;
	if (!api) throw new CalendarError("TEMPORAL_UNAVAILABLE");
	return api;
}

function wall(time: ICAL.Time): Wall {
	return {
		year: time.year,
		month: time.month,
		day: time.day,
		hour: time.hour,
		minute: time.minute,
		second: time.second,
	};
}

class IanaZone extends ICAL.Timezone {
	override utcOffset(time: ICAL.Time): number {
		const fields = wall(time);
		const plain = temporal().PlainDateTime.from(fields, { overflow: "reject" });
		const epoch = plain.toZonedDateTime(this.tzid, {
			disambiguation: "compatible",
		}).epochMilliseconds;
		const utc = new Date(0);
		utc.setUTCFullYear(fields.year, fields.month - 1, fields.day);
		utc.setUTCHours(fields.hour, fields.minute, fields.second, 0);
		return (utc.getTime() - epoch) / 1000;
	}
}

export class Zones {
	readonly feed: Map<string, ICAL.Timezone> = new Map();
	readonly iana: Map<string, ICAL.Timezone> = new Map();
	readonly owner: ICAL.Timezone;
	#work = 0;
	#transitions = 0;
	#dates = 0;

	constructor(owner: string) {
		this.owner = this.native(owner);
	}

	#keepDates(count: number): void {
		this.#dates += count;
		if (this.#dates > MAX_DATE_VALUES) throw new CalendarError("RESOURCE_LIMIT");
	}

	addFeed(component: ICAL.Component, id: string): void {
		this.feed.set(
			id,
			new FeedZone(component, id, {
				work: () => {
					if (++this.#work > MAX_ZONE_WORK) throw new CalendarError("RESOURCE_LIMIT");
				},
				transition: () => {
					if (++this.#transitions > MAX_ZONE_TRANSITIONS) throw new CalendarError("RESOURCE_LIMIT");
				},
				dates: (count) => this.#keepDates(count),
			}),
		);
	}

	native(id: string): ICAL.Timezone {
		const cached = this.iana.get(id);
		if (cached) return cached;
		try {
			if (typeof id !== "string" || !id || /^[+-]/.test(id)) throw new Error();
			temporal().PlainDateTime.from("2026-01-01T00:00:00").toZonedDateTime(id);
		} catch {
			throw new CalendarError("UNKNOWN_TIME_ZONE");
		}
		if (["UTC", "GMT"].includes(id.toUpperCase())) {
			this.iana.set(id, ICAL.Timezone.utcTimezone);
			return ICAL.Timezone.utcTimezone;
		}
		const zone = new IanaZone({ tzid: id });
		this.iana.set(id, zone);
		return zone;
	}

	bind(component: ICAL.Component): void {
		for (const name of ["dtstart", "dtend", "recurrence-id", "rdate", "exdate"]) {
			for (const property of component.getAllProperties(name)) {
				if (property.type !== "date" && property.type !== "date-time") invalid();
				const id = property.getParameter("tzid");
				const values = property.toJSON().slice(3);
				if (name === "rdate" || name === "exdate") this.#keepDates(values.length);
				for (const raw of values) {
					if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z?)?$/.test(raw))
						invalid();
					if (raw.slice(17, 19) === "60") invalid();
					if (id && raw.endsWith("Z")) invalid();
					temporal().PlainDateTime.from(raw.endsWith("Z") ? raw.slice(0, -1) : raw, {
						overflow: "reject",
					});
				}
				for (const value of property.getValues()) {
					if (!(value instanceof ICAL.Time)) invalid();
					if (id && value.isDate) invalid();
					value.zone = value.isDate
						? this.owner
						: id
							? (this.feed.get(String(id)) ?? this.native(String(id)))
							: value.zone === ICAL.Timezone.utcTimezone
								? ICAL.Timezone.utcTimezone
								: this.owner;
				}
			}
		}
	}
}

export function epoch(time: ICAL.Time): number {
	const ms = time.toUnixTime() * 1000;
	if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) invalid();
	return ms;
}
