import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toolKindsV1 } from "@draftyak/protocol/tool-v1/kinds";
import { describe, expect, it } from "vitest";
import { CalendarError, freeBusy } from "../src/index.ts";

interface CorpusCase {
	id?: string;
	feed: string;
	window: { start: string; end: string };
	timeZone: string;
	expected?: ReturnType<typeof freeBusy>;
	expectedError?: string;
}

const directory = new URL("../../../security/ics-corpus/", import.meta.url);
const cases = readdirSync(directory)
	.filter((name) => name.endsWith(".json"))
	.map(
		(name) =>
			[name, JSON.parse(readFileSync(new URL(name, directory), "utf8")) as CorpusCase] as const,
	);

describe("shared calendar corpus", () => {
	it("loads the shared synthetic golden cases", () =>
		expect(cases.length).toBeGreaterThanOrEqual(10));
	it.each(cases)("%s", (_name, item) => {
		const bounds = { start: Date.parse(item.window.start), end: Date.parse(item.window.end) };
		const bytes = readFileSync(fileURLToPath(new URL(item.feed, directory)));
		let value: unknown;
		try {
			value = freeBusy(bytes, bounds, item.timeZone);
		} catch (error) {
			expect(error).toBeInstanceOf(CalendarError);
			value = error;
		}
		const serialized =
			value instanceof CalendarError
				? JSON.stringify(value, Object.getOwnPropertyNames(value))
				: JSON.stringify(value);
		expect(serialized).not.toMatch(/canary/i);
		if (item.expectedError !== undefined) {
			expect(value).toBeInstanceOf(CalendarError);
			expect((value as CalendarError).code).toBe(item.expectedError);
		} else {
			expect(value).toEqual(item.expected);
			expect(toolKindsV1["calendar.freebusy"].result.parse(value)).toEqual(item.expected);
			expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(
				20_480,
			);
		}
	});
});
