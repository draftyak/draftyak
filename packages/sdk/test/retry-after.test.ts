import { HOST_MAX_HEADER_BYTES } from "@draftyak/protocol/host-channel";
import { describe, expect, it, vi } from "vitest";
import { parseGmailRetryAfter, parseRetryAfter } from "../src/retry-after.ts";

describe("bounded Retry-After response data", () => {
	const now = Date.parse("2026-10-17T12:00:00Z");

	it("retains delta-seconds, surrounding whitespace, leading zeroes and zero", () => {
		expect(parseRetryAfter(" 30 ", now)).toBe(30_000);
		expect(parseRetryAfter("0003", now)).toBe(3000);
		expect(parseRetryAfter("0", now)).toBe(0);
	});

	it("preserves the last exact safe seconds value and saturates its next neighbor", () => {
		const seconds = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
		expect(parseRetryAfter(String(seconds), now)).toBe(seconds * 1000);
		expect(parseRetryAfter(String(seconds + 1), now)).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("accepts the existing header-length boundary and refuses the next byte", () => {
		expect(parseRetryAfter("9".repeat(512), now)).toBe(Number.MAX_SAFE_INTEGER);
		expect(parseRetryAfter("9".repeat(513), now)).toBeNull();
	});

	it("uses canonical IMF-fixdate and preserves past and exactly-current dates as zero", () => {
		expect(parseRetryAfter("Sat, 17 Oct 2026 12:00:45 GMT", now)).toBe(45_000);
		expect(parseRetryAfter("Sat, 17 Oct 2026 12:00:00 GMT", now)).toBe(0);
		expect(parseRetryAfter("Sat, 17 Oct 2026 11:59:00 GMT", now)).toBe(0);
	});

	it.each([
		undefined,
		null,
		"",
		"-1",
		"1.5",
		"soon",
		"2026-10-17T12:00:45Z",
		"Sun, 17 Oct 2026 12:00:45 GMT",
		"\ud800",
		"30\n",
		"30\r",
		30,
	])("treats malformed response data as an absent hint: %s", (value) => {
		expect(parseRetryAfter(value, now)).toBeNull();
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001])(
		"refuses an invalid observation time without reading another clock: %s",
		(value) => {
			expect(parseRetryAfter("30", value)).toBeNull();
			expect(parseRetryAfter("Sat, 17 Oct 2026 12:00:45 GMT", value)).toBeNull();
		},
	);

	it("uses only the supplied observation time and never samples Date.now", () => {
		const clock = vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("DYTEST unexpected clock read");
		});
		try {
			expect(parseRetryAfter("30", now)).toBe(30_000);
			expect(parseRetryAfter("Sat, 17 Oct 2026 12:00:45 GMT", now)).toBe(45_000);
			expect(parseRetryAfter("30", Number.NaN)).toBeNull();
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});
});

describe("fixed Retry-After caller policies", () => {
	const now = Date.UTC(2026, 9, 17, 12);

	it("keeps decimal hints clock-independent for Gmail while preserving Slack bounds", () => {
		const readNow = vi.fn(() => {
			throw new Error("DYTEST unexpected offered clock read");
		});
		for (const [header, slack, gmail] of [
			["0", 0, 0],
			[" \t30\t ", 30_000, 30_000],
			[`${"0".repeat(8000)}1`, null, 1000],
			[
				String(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
				Math.floor(Number.MAX_SAFE_INTEGER / 1000) * 1000,
				Math.floor(Number.MAX_SAFE_INTEGER / 1000) * 1000,
			],
			["9007199254741", Number.MAX_SAFE_INTEGER, null],
		] as const) {
			expect(parseRetryAfter(header, now)).toBe(slack);
			expect(parseGmailRetryAfter(header, readNow)).toBe(gmail);
		}
		expect(parseGmailRetryAfter("30", readNow)).toBe(30_000);
		expect(parseRetryAfter("30", Number.NaN)).toBeNull();
		expect(readNow).not.toHaveBeenCalled();
	});

	it("uses Gmail's exact host header boundary and ASCII whitespace policy", () => {
		const readNow = vi.fn(() => now);
		expect(parseGmailRetryAfter(`${"0".repeat(HOST_MAX_HEADER_BYTES - 1)}1`, readNow)).toBe(1000);
		expect(parseGmailRetryAfter(`${"0".repeat(HOST_MAX_HEADER_BYTES)}1`, readNow)).toBeNull();
		for (const header of ["\u00a030\u00a0", "30\r", "30\n", "\v30", "\ud800"]) {
			expect(parseGmailRetryAfter(header, readNow)).toBeNull();
		}
		expect(parseRetryAfter("\u00a030\u00a0", now)).toBe(30_000);
		expect(readNow).not.toHaveBeenCalled();
	});

	it("checks a whole digit prefix before choosing overflow or nondecimal behavior", () => {
		const readNow = vi.fn(() => now);
		const digits = "9".repeat(500);
		expect(parseGmailRetryAfter(`${digits}x`, readNow)).toBeNull();
		expect(readNow).toHaveBeenCalledTimes(1);
		expect(parseRetryAfter(`${digits}x`, now)).toBeNull();
		readNow.mockClear();
		expect(parseGmailRetryAfter(digits, readNow)).toBeNull();
		expect(parseRetryAfter(digits, now)).toBe(Number.MAX_SAFE_INTEGER);
		expect(readNow).not.toHaveBeenCalled();
	});

	it.each([
		["IMF", "Sat, 17 Oct 2026 12:00:45 GMT", 45_000],
		["RFC850", "Saturday, 17-Oct-26 12:00:45 GMT", null],
		["asctime", "Sat Oct 17 12:00:45 2026", null],
	] as const)(
		"uses one offered clock for Gmail %s dates and keeps Slack's date policy",
		(_name, header, slack) => {
			const readNow = vi.fn(() => now);
			expect(parseGmailRetryAfter(header, readNow)).toBe(45_000);
			expect(readNow).toHaveBeenCalledTimes(1);
			expect(parseRetryAfter(header, now)).toBe(slack);
		},
	);

	it("samples once even for admitted nondecimal invalid or empty Gmail data", () => {
		const readNow = vi.fn(() => now);
		for (const header of ["", " \t", "+1", "1.5", "not a date"]) {
			readNow.mockClear();
			expect(parseGmailRetryAfter(header, readNow)).toBeNull();
			expect(readNow).toHaveBeenCalledTimes(1);
		}
		expect(parseGmailRetryAfter(undefined, readNow)).toBeNull();
		expect(readNow).toHaveBeenCalledTimes(1);
	});

	it("uses only the offered clock and retains representable negative observation times", () => {
		const clock = vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("DYTEST unexpected ambient clock read");
		});
		try {
			const readNow = vi.fn(() => -1);
			const header = "Thu, 01 Jan 1970 00:00:00 GMT";
			expect(parseGmailRetryAfter(header, readNow)).toBe(1);
			expect(readNow).toHaveBeenCalledTimes(1);
			expect(parseRetryAfter(header, -1)).toBeNull();
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	it("omits a Gmail date hint for unavailable, unsafe or unrepresentable offered time", () => {
		const header = "Sat, 17 Oct 2026 12:00:45 GMT";
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			0.5,
			8_640_000_000_000_001,
			-8_640_000_000_000_001,
		]) {
			const readNow = vi.fn(() => value);
			expect(parseGmailRetryAfter(header, readNow)).toBeNull();
			expect(readNow).toHaveBeenCalledTimes(1);
		}
		const unavailable = vi.fn(() => {
			throw new Error("DYTEST unavailable clock");
		});
		expect(parseGmailRetryAfter(header, unavailable)).toBeNull();
		expect(unavailable).toHaveBeenCalledTimes(1);
	});

	it("uses the full UTC date at the RFC850 fifty-year boundary", () => {
		function rfc850(date: Date): string {
			const [, day, month, , time] = date.toUTCString().split(" ");
			const weekday = [
				"Sunday",
				"Monday",
				"Tuesday",
				"Wednesday",
				"Thursday",
				"Friday",
				"Saturday",
			][date.getUTCDay()];
			return `${weekday}, ${day}-${month}-${String(date.getUTCFullYear()).slice(-2)} ${time} GMT`;
		}
		const near = new Date(Date.UTC(2076, 9, 15, 12));
		const past = new Date(Date.UTC(1976, 9, 19, 12));
		for (const [date, delay] of [
			[near, near.getTime() - now],
			[past, 0],
		] as const) {
			const readNow = vi.fn(() => now);
			expect(parseGmailRetryAfter(rfc850(date), readNow)).toBe(delay);
			expect(readNow).toHaveBeenCalledTimes(1);
		}
	});

	it("preserves present zero for past dates and Gmail's leap-second mapping", () => {
		const beforeLeap = Date.UTC(2016, 11, 31, 23, 59, 59);
		const header = "Sat, 31 Dec 2016 23:59:60 GMT";
		expect(parseGmailRetryAfter(header, () => beforeLeap)).toBe(1000);
		expect(parseRetryAfter(header, beforeLeap)).toBeNull();
		for (const past of [
			"Sat, 17 Oct 2026 11:59:00 GMT",
			"Saturday, 17-Oct-26 11:59:00 GMT",
			"Sat Oct 17 11:59:00 2026",
		]) {
			expect(parseGmailRetryAfter(past, () => now)).toBe(0);
		}
	});

	it.each([
		"2026-11-18T00:00:00Z",
		"Sun, 31 Feb 2027 00:00:00 GMT",
		"Sun, 00 Nov 2026 00:00:00 GMT",
		"Sun, 06 Nov 1994 24:00:00 GMT",
		"Sun, 06 Nov 1994 08:60:00 GMT",
		"Sun, 06 Nov 1994 08:49:61 GMT",
		"Sun, 06 Nov 1994 08:49:60 GMT",
		"Mon, 06 Nov 1994 08:49:37 GMT",
		"Sun, 06 Nov 1994 08:49:37 UTC",
		"sun, 06 Nov 1994 08:49:37 GMT",
		"Sun Nov 6 08:49:37 1994",
		"Sun, 06 Nov 1994 08:49:37 GMT, 2",
	])("refuses malformed calendar data %# for both fixed callers", (header) => {
		const readNow = vi.fn(() => now);
		expect(parseGmailRetryAfter(header, readNow)).toBeNull();
		expect(readNow).toHaveBeenCalledTimes(1);
		expect(parseRetryAfter(header, now)).toBeNull();
	});

	it("retains low-year Gmail calendar dates and the Slack native IMF round-trip contract", () => {
		for (const year of [0, 99]) {
			const date = new Date(0);
			date.setUTCFullYear(year, 0, 1);
			date.setUTCHours(0, 0, 0, 0);
			const header = date.toUTCString(),
				parsed = Date.parse(header);
			const legacy =
				Number.isFinite(parsed) && new Date(parsed).toUTCString() === header
					? Math.max(0, parsed - now)
					: null;
			expect(parseRetryAfter(header, now)).toBe(legacy);
			expect(parseGmailRetryAfter(header, () => date.getTime() - 1000)).toBe(1000);
		}
	});
});
