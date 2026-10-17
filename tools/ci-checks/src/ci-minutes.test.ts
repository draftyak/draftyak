import { describe, expect, it } from "vitest";
import { type Job, jobMinutes, monthRange, tally } from "./ci-minutes.ts";

const start = Date.parse("2026-10-17T10:00:00Z");
const job = (seconds: number, labels = ["ubuntu-24.04"], extra: Partial<Job> = {}): Job => ({
	labels,
	status: "completed",
	conclusion: "success",
	started_at: new Date(start).toISOString(),
	completed_at: new Date(start + seconds * 1000).toISOString(),
	...extra,
});

describe("ci:minutes", () => {
	it.each([
		[0, 0],
		[1, 1],
		[60, 1],
		[61, 2],
		[3599, 60],
	])("rounds a %i s job up to %i min", (seconds, minutes) => {
		expect(jobMinutes(job(seconds))).toBe(minutes);
	});

	it("counts nothing for skipped or unfinished jobs", () => {
		expect(jobMinutes(job(90, undefined, { conclusion: "skipped" }))).toBe(0);
		expect(jobMinutes(job(90, undefined, { status: "in_progress", completed_at: null }))).toBe(0);
	});

	it("multiplies each OS's minutes by its rate", () => {
		const result = tally([
			job(61),
			job(30, ["ubuntu-24.04-arm"]),
			job(61, ["windows-2025"]),
			job(1, ["macos-15"]),
			job(5, ["macos-15"], { conclusion: "skipped" }),
			job(10, undefined, { status: "in_progress", completed_at: null }),
		]);
		expect(result).toEqual({ minutes: { linux: 3, windows: 2, macos: 1 }, billed: 17, running: 1 });
	});

	it("turns a month into GitHub's created range", () => {
		expect(monthRange("2026-10")).toBe("2026-10-01..2026-10-31");
		expect(monthRange("2028-02")).toBe("2028-02-01..2028-02-29");
		expect(() => monthRange("2026-13")).toThrow("--month must be YYYY-MM");
	});
});
