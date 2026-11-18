type Caller = "slack" | "gmail";
type Decimal =
	| { readonly kind: "other" }
	| { readonly kind: "decimal"; readonly milliseconds: number | null };

const MAX_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
const DATE_LIMIT = 8_640_000_000_000_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function header(value: unknown, caller: Caller): string | null {
	const limit = caller === "slack" ? 512 : 16_384;
	if (typeof value !== "string" || value.length > limit || !value.isWellFormed()) return null;
	for (let at = 0; at < value.length; at++) {
		const code = value.charCodeAt(at);
		if (caller === "gmail") {
			if (code !== 9 && (code < 0x20 || code > 0x7e)) return null;
		} else if (code === 13 || code === 10) return null;
	}
	if (caller === "slack") return value.trim();
	let first = 0;
	let last = value.length;
	while (first < last && (value[first] === " " || value[first] === "\t")) first++;
	while (last > first && (value[last - 1] === " " || value[last - 1] === "\t")) last--;
	return value.slice(first, last);
}

function decimal(value: string): Decimal {
	if (value.length === 0) return { kind: "other" };
	let seconds = 0;
	let overflow = false;
	for (let at = 0; at < value.length; at++) {
		const digit = value.charCodeAt(at) - 48;
		if (digit < 0 || digit > 9) return { kind: "other" };
		if (!overflow) {
			const next = seconds * 10 + digit;
			if (next > MAX_SECONDS) overflow = true;
			else seconds = next;
		}
	}
	return { kind: "decimal", milliseconds: overflow ? null : seconds * 1000 };
}

/** One UTC calendar conversion for the fixed callers' permitted HTTP-date grammars. */
function dateInstant(value: string, now: number, caller: Caller): number | null {
	const reference = new Date(now);
	const ceiling = reference.getUTCFullYear() + 50;
	let day: number, month: number, year: number, hour: number, minute: number, second: number;
	let weekday: number;
	let obsolete = false;
	const imf =
		/^([A-Z][a-z]{2}), ([0-9]{2}) ([A-Z][a-z]{2}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
			value,
		);
	const rfc850 =
		caller === "gmail"
			? /^([A-Z][a-z]+), ([0-9]{2})-([A-Z][a-z]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
					value,
				)
			: null;
	const asctime =
		caller === "gmail"
			? /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( [0-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
					value,
				)
			: null;
	if (imf || rfc850) {
		const fields = imf ?? rfc850;
		if (!fields) return null;
		weekday = (imf ? DAYS : LONG_DAYS).indexOf(fields[1] ?? "");
		day = Number(fields[2]);
		month = MONTHS.indexOf(fields[3] ?? "");
		year = Number(fields[4]);
		hour = Number(fields[5]);
		minute = Number(fields[6]);
		second = Number(fields[7]);
		if (rfc850) {
			obsolete = true;
			year += Math.floor(ceiling / 100) * 100;
			if (year > ceiling) year -= 100;
		}
	} else if (asctime) {
		weekday = DAYS.indexOf(asctime[1] ?? "");
		month = MONTHS.indexOf(asctime[2] ?? "");
		day = Number(asctime[3]);
		hour = Number(asctime[4]);
		minute = Number(asctime[5]);
		second = Number(asctime[6]);
		year = Number(asctime[7]);
	} else return null;
	if (
		weekday < 0 ||
		month < 0 ||
		day < 1 ||
		day > 31 ||
		year < 0 ||
		year > 9999 ||
		hour > 23 ||
		minute > 59 ||
		second > 60 ||
		(second === 60 && (caller === "slack" || hour !== 23 || minute !== 59)) ||
		// Preserve Slack's Date.parse/toUTCString roundtrip refusals for years 00..99.
		(caller === "slack" && year < 100)
	)
		return null;
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, Math.min(second, 59), 0);
	const leap = second === 60 ? 1000 : 0;
	if (obsolete) {
		const limit = new Date(now);
		limit.setUTCFullYear(ceiling);
		if (date.getTime() + leap > limit.getTime()) {
			year -= 100;
			date.setUTCFullYear(year, month, day);
		}
	}
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCDay() !== weekday
	)
		return null;
	return date.getTime() + leap;
}

/** Slack response/observation DATA. Returns a relative millisecond hint or null; never schedules a retry. */
export function parseRetryAfter(value: unknown, now: number): number | null {
	if (!Number.isSafeInteger(now) || now < 0 || now > DATE_LIMIT) return null;
	const raw = header(value, "slack");
	if (raw === null) return null;
	const parsed = decimal(raw);
	if (parsed.kind === "decimal") return parsed.milliseconds ?? Number.MAX_SAFE_INTEGER;
	const at = dateInstant(raw, now, "slack");
	return at === null ? null : Math.max(0, at - now);
}

/** Gmail response DATA. The offered clock is sampled once only for admitted nondecimal input. */
export function parseGmailRetryAfter(value: unknown, readNow: () => number): number | null {
	const raw = header(value, "gmail");
	if (raw === null) return null;
	const parsed = decimal(raw);
	if (parsed.kind === "decimal") return parsed.milliseconds;
	try {
		if (typeof readNow !== "function") return null;
		const now = readNow();
		if (!Number.isSafeInteger(now) || !Number.isFinite(new Date(now).getTime())) return null;
		const at = dateInstant(raw, now, "gmail");
		if (at === null) return null;
		const milliseconds = Math.max(0, at - now);
		return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
	} catch {
		return null;
	}
}
