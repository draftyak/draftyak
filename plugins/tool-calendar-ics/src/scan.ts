import { CalendarError, invalid } from "./error.ts";

const eventFields = new Set([
	"UID",
	"DTSTART",
	"DTEND",
	"DURATION",
	"RRULE",
	"RDATE",
	"EXDATE",
	"RECURRENCE-ID",
	"STATUS",
	"TRANSP",
]);
const zoneFields = new Set(["TZID", "DTSTART", "TZOFFSETFROM", "TZOFFSETTO", "RRULE", "RDATE"]);

interface Line {
	readonly name: string;
	readonly text?: string;
}

function* lines(bytes: Uint8Array, keepField: (name: string) => boolean): Generator<Line> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let parts: Uint8Array[] = [];
	let at = 0;
	let size = 0;
	let segments = 0;
	let active = false;
	let name = "";
	let nameLength = 0;
	let named = false;
	let kept = false;
	let colon = false;
	const finish = (): Line | null => {
		if (!active || size === 0) return null;
		if (!named && nameLength === 0 && parts.every((part) => part.length === 0)) return null;
		if (!named || !colon) invalid();
		return kept ? { name, text: decode(parts, decoder) } : { name };
	};
	while (at < bytes.length) {
		let end = bytes.indexOf(10, at);
		if (end < 0) end = bytes.length;
		const stop = end > at && bytes[end - 1] === 13 ? end - 1 : end;
		const folded = bytes[at] === 32 || bytes[at] === 9;
		if (!folded) {
			const previous = finish();
			if (previous) yield previous;
			parts = [];
			size = 0;
			segments = 0;
			name = "";
			nameLength = 0;
			named = false;
			kept = false;
			colon = false;
			active = true;
		} else if (!active) invalid();
		size += stop - at;
		segments++;
		const piece = bytes.subarray(at + (folded ? 1 : 0), stop);
		colon ||= piece.includes(58);
		if (!named) {
			if (nameLength <= 13 && parts.length < 1024) parts.push(piece);
			for (const byte of piece) {
				if (byte === 59 || byte === 58) {
					if (nameLength === 0) invalid();
					named = true;
					kept = nameLength <= 13 && keepField(name);
					if (!kept) parts = [];
					break;
				}
				if (
					!(byte >= 65 && byte <= 90) &&
					!(byte >= 97 && byte <= 122) &&
					!(byte >= 48 && byte <= 57) &&
					byte !== 45
				)
					invalid();
				if (++nameLength <= 13) name += String.fromCharCode(byte).toUpperCase();
				else parts = [];
			}
		} else if (kept) parts.push(piece);
		if (kept && (segments > 1024 || size > 65_536)) throw new CalendarError("RESOURCE_LIMIT");
		at = end + 1;
	}
	const last = finish();
	if (last) yield last;
}

function decode(parts: Uint8Array[], decoder: TextDecoder): string {
	if (parts.length === 1) return decoder.decode(parts[0]);
	let value = "";
	for (const part of parts) value += decoder.decode(part, { stream: true });
	return value + decoder.decode();
}

export function* components(bytes: Uint8Array, wanted: "VEVENT" | "VTIMEZONE"): Generator<string> {
	const stack: string[] = [];
	let opened = false;
	let closed = false;
	let kept: string[] = [];
	let size = 0;
	const encoder = new TextEncoder();
	const keep = (line: string): void => {
		size += encoder.encode(line).byteLength + 2;
		if (size > 262_144) throw new CalendarError("RESOURCE_LIMIT");
		kept.push(line);
	};
	const keepField = (name: string): boolean =>
		name === "BEGIN" ||
		name === "END" ||
		(stack[1] === wanted &&
			(wanted === "VEVENT"
				? stack.length === 2 && (eventFields.has(name) || name === "EXRULE")
				: zoneFields.has(name)));
	for (const record of lines(bytes, keepField)) {
		const { name, text: line } = record;
		if (line === undefined) {
			if (!stack.length || closed) invalid();
			continue;
		}
		if (line.includes("\r") || line.includes("\0")) invalid();
		if (name === "BEGIN") {
			const kind = line.slice(6).toUpperCase();
			if (line[5] !== ":" || closed || stack.length >= 4) invalid();
			if (stack.length === 0) {
				if (opened || kind !== "VCALENDAR") invalid();
				opened = true;
			} else if (stack.length === 1) {
				if (!["VEVENT", "VTIMEZONE", "VTODO", "VJOURNAL"].includes(kind)) invalid();
			} else if (stack.length === 2) {
				if (
					!(["VEVENT", "VTODO"].includes(stack[1] ?? "")
						? kind === "VALARM"
						: stack[1] === "VTIMEZONE" && (kind === "STANDARD" || kind === "DAYLIGHT"))
				)
					invalid();
			} else invalid();
			stack.push(kind);
			if (stack[1] === wanted && (stack.length === 2 || wanted === "VTIMEZONE"))
				keep(`BEGIN:${kind}`);
		} else if (name === "END") {
			const kind = line.slice(4).toUpperCase();
			if (line[3] !== ":" || stack.pop() !== kind) invalid();
			if (kind === wanted && stack.length === 1) {
				keep(`END:${kind}`);
				yield kept.join("\r\n");
				kept = [];
				size = 0;
			} else if (stack[1] === wanted && wanted === "VTIMEZONE") keep(`END:${kind}`);
			if (stack.length === 0) closed = true;
		} else {
			if (!stack.length || closed) invalid();
			if (stack[1] !== wanted) continue;
			if (wanted === "VEVENT" && stack.length === 2) {
				if (name === "EXRULE") invalid();
				if (eventFields.has(name)) keep(line);
			} else if (wanted === "VTIMEZONE" && zoneFields.has(name)) {
				keep(line);
			}
		}
	}
	if (!opened || !closed || stack.length) invalid();
}
