import { invalid } from "./error.ts";
import { temporal } from "./zones.ts";

export function validateRule(line: string): void {
	const fields = new Map<string, string>();
	for (const part of line
		.slice(line.indexOf(":") + 1)
		.toUpperCase()
		.split(";")) {
		const pair = /^([A-Z]+)=(.+)$/.exec(part);
		if (!pair?.[1] || !pair[2] || fields.has(pair[1])) invalid();
		fields.set(pair[1], pair[2]);
	}
	const frequency = fields.get("FREQ") ?? "";
	if (!/^(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(frequency)) invalid();
	if (fields.has("COUNT") && fields.has("UNTIL")) invalid();
	if (fields.has("BYMONTHDAY") && frequency === "WEEKLY") invalid();
	if (fields.has("BYYEARDAY") && ["DAILY", "WEEKLY", "MONTHLY"].includes(frequency)) invalid();
	if (fields.has("BYWEEKNO") && frequency !== "YEARLY") invalid();
	if (frequency === "YEARLY" && fields.has("BYMONTHDAY") && !fields.has("BYMONTH")) invalid();
	if (
		!["MONTHLY", "YEARLY"].includes(frequency) &&
		fields
			.get("BYMONTHDAY")
			?.split(",")
			.some((day) => Number(day) < 0)
	)
		invalid();
	if (fields.has("BYSETPOS") && ["MONTHLY", "YEARLY"].includes(frequency)) {
		if (["BYHOUR", "BYMINUTE", "BYSECOND"].some((part) => fields.has(part))) invalid();
		// Admission remains limited to day-only set positions within one month.
		if (
			!fields.has("BYDAY") ||
			["BYMONTHDAY", "BYYEARDAY", "BYWEEKNO"].some((part) => fields.has(part))
		)
			invalid();
		if (frequency === "YEARLY" && new Set(fields.get("BYMONTH")?.split(",").map(Number)).size !== 1)
			invalid();
	}
	if (
		fields.has("BYSETPOS") &&
		![...fields.keys()].some((name) => name.startsWith("BY") && name !== "BYSETPOS")
	)
		invalid();
	const bounds: Readonly<Record<string, number>> = {
		BYSECOND: 59,
		BYMINUTE: 59,
		BYHOUR: 23,
		BYMONTHDAY: 31,
		BYYEARDAY: 366,
		BYWEEKNO: 53,
		BYMONTH: 12,
		BYSETPOS: 366,
	};
	for (const [name, value] of fields) {
		if (name === "FREQ") continue;
		if (name === "COUNT" || name === "INTERVAL") {
			if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)
				invalid();
		} else if (name === "UNTIL") {
			if (!/^\d{8}(T\d{6}Z?)?$/.test(value) || value.slice(13, 15) === "60") invalid();
			const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
			const time =
				value.length > 8
					? `T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`
					: "T00:00:00";
			temporal().PlainDateTime.from(date + time, { overflow: "reject" });
		} else if (name === "WKST") {
			if (!/^(SU|MO|TU|WE|TH|FR|SA)$/.test(value)) invalid();
		} else if (name === "BYDAY") {
			for (const day of value.split(",")) {
				const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(day);
				if (
					!match ||
					(match[1] &&
						(Math.abs(Number(match[1])) > 53 ||
							Number(match[1]) === 0 ||
							!["MONTHLY", "YEARLY"].includes(frequency) ||
							(frequency === "YEARLY" && fields.has("BYWEEKNO"))))
				)
					invalid();
			}
		} else {
			const bound = bounds[name];
			if (!bound) invalid();
			for (const item of value.split(",")) {
				if (!/^[+-]?\d+$/.test(item) || Math.abs(Number(item)) > bound) invalid();
				if (
					["BYSECOND", "BYMINUTE", "BYHOUR"].includes(name) ? Number(item) < 0 : Number(item) === 0
				)
					invalid();
				if (name === "BYMONTH" && Number(item) < 1) invalid();
			}
		}
	}
	const months = fields.get("BYMONTH")?.split(",").map(Number);
	const days = fields.get("BYMONTHDAY")?.split(",").map(Number);
	if (months && days) {
		const maximumDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
		if (!months.some((month) => days.some((day) => Math.abs(day) <= (maximumDays[month - 1] ?? 0))))
			invalid();
	}
}
