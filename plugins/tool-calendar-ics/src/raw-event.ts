import ICAL from "ical.js";
import type { UtcWindow } from "./result.ts";

const SLACK = 26 * 60 * 60 * 1000;

export interface RawEvent {
	readonly fields: ReadonlyMap<string, readonly string[]>;
	readonly exception: boolean;
	readonly recurring: boolean;
}

export function rawEvent(text: string): RawEvent {
	const fields = new Map<string, string[]>();
	for (const line of text.split("\r\n")) {
		const name = /^([A-Za-z0-9-]+)/.exec(line)?.[1]?.toUpperCase();
		if (!name || name === "BEGIN" || name === "END") continue;
		const values = fields.get(name) ?? [];
		values.push(line);
		fields.set(name, values);
	}
	return {
		fields,
		exception: fields.has("RECURRENCE-ID"),
		recurring: fields.has("RRULE") || fields.has("RDATE"),
	};
}

const value = (line: string): string => line.slice(line.lastIndexOf(":") + 1);
const single = (event: RawEvent, name: string): string | null => {
	const lines = event.fields.get(name);
	return lines?.length === 1 ? value(lines[0] ?? "") : null;
};

function nominal(raw: string | null): { value: number; date: boolean } | null {
	if (raw === null || !/^\d{8}(T\d{6}Z?)?$/.test(raw)) return null;
	const date = raw.length === 8;
	const fields = [
		Number(raw.slice(0, 4)),
		Number(raw.slice(4, 6)),
		Number(raw.slice(6, 8)),
		date ? 0 : Number(raw.slice(9, 11)),
		date ? 0 : Number(raw.slice(11, 13)),
		date ? 0 : Number(raw.slice(13, 15)),
	];
	const time = new Date(0);
	time.setUTCFullYear(fields[0] ?? 0, (fields[1] ?? 1) - 1, fields[2]);
	time.setUTCHours(fields[3] ?? 0, fields[4] ?? 0, fields[5] ?? 0, 0);
	const actual = [
		time.getUTCFullYear(),
		time.getUTCMonth() + 1,
		time.getUTCDate(),
		time.getUTCHours(),
		time.getUTCMinutes(),
		time.getUTCSeconds(),
	];
	return Number.isSafeInteger(time.getTime()) &&
		fields.every((field, index) => field === actual[index])
		? { value: time.getTime(), date }
		: null;
}

function duration(raw: string | null): number | null {
	if (raw === null) return null;
	const parts = /^([+-])?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(raw);
	if (!parts?.slice(2).some((part) => part !== undefined)) return null;
	const total =
		((Number(parts[2] ?? 0) * 7 + Number(parts[3] ?? 0)) * 86400 +
			Number(parts[4] ?? 0) * 3600 +
			Number(parts[5] ?? 0) * 60 +
			Number(parts[6] ?? 0)) *
		1000 *
		(parts[1] === "-" ? -1 : 1);
	return Number.isSafeInteger(total) ? total : null;
}

function rawBounds(event: RawEvent): { start: number; end: number; duration: number } | null {
	const start = nominal(single(event, "DTSTART"));
	if (!start || (event.fields.has("DTEND") && event.fields.has("DURATION"))) return null;
	if (event.fields.has("DTEND")) {
		const end = nominal(single(event, "DTEND"));
		if (!end) return null;
		return {
			start: start.value,
			end: end.value,
			duration: Math.max(0, end.value - start.value + 2 * SLACK),
		};
	}
	const length = event.fields.has("DURATION")
		? duration(single(event, "DURATION"))
		: start.date
			? 86_400_000
			: 0;
	if (length === null || !Number.isSafeInteger(start.value + length)) return null;
	return {
		start: start.value,
		end: start.value + length,
		duration: Math.max(0, length) + 2 * SLACK,
	};
}

/** Discard only when raw wall bounds plus conservative offset slack prove irrelevance. */
export function outsideWindow(event: RawEvent, window: UtcWindow): boolean {
	const bounds = rawBounds(event);
	if (!bounds) return false;
	if (!event.recurring)
		return bounds.start - SLACK >= window.end || bounds.end + SLACK <= window.start;
	if (event.fields.has("RDATE")) return false;
	return ruleOutsideWindow(event, window);
}

/** An ended RRULE may be removed while independent RDATE values remain relevant. */
export function ruleOutsideWindow(event: RawEvent, window: UtcWindow): boolean {
	if (!event.fields.has("RRULE")) return false;
	const bounds = rawBounds(event);
	if (!bounds) return false;
	if (bounds.start - SLACK >= window.end) return true;
	const rule = single(event, "RRULE");
	if (rule === null) return false;
	const parts = new Map<string, string>();
	for (const part of rule.toUpperCase().split(";")) {
		const pair = /^([A-Z]+)=(.+)$/.exec(part);
		if (!pair?.[1] || !pair[2] || parts.has(pair[1])) return false;
		parts.set(pair[1], pair[2]);
	}
	if (Number(parts.get("COUNT")) === 1) return bounds.end + SLACK <= window.start;
	const until = nominal(parts.get("UNTIL") ?? null);
	if (!until) return false;
	const end = until.value + (until.date ? 86_400_000 : 0) + bounds.duration + SLACK;
	return Number.isSafeInteger(end) && end <= window.start;
}

/** Parse only UID text when indexing potentially relevant recurrence masters. */
export function eventUid(event: RawEvent): string | null {
	const lines = event.fields.get("UID");
	if (lines?.length !== 1) return null;
	const component = new ICAL.Component(ICAL.parse(`BEGIN:VEVENT\r\n${lines[0]}\r\nEND:VEVENT`));
	const uid = component.getFirstPropertyValue("uid");
	return typeof uid === "string" && uid ? uid : null;
}
