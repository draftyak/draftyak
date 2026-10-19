import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	ciMinutes,
	type Gh,
	type Job,
	jobMinutes,
	jobQuery,
	monthBounds,
	monthJobs,
	monthRuns,
	tally,
} from "./ci-minutes.ts";

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

	it("bounds a month in UTC", () => {
		const at = (time: string): number => Date.parse(time);
		expect(monthBounds("2026-10")).toEqual([
			at("2026-10-01T00:00:00Z"),
			at("2026-11-01T00:00:00Z"),
		]);
		expect(monthBounds("2028-12")).toEqual([
			at("2028-12-01T00:00:00Z"),
			at("2029-01-01T00:00:00Z"),
		]);
		expect(() => monthBounds("2026-13")).toThrow("--month must be YYYY-MM");
	});
});

interface Listed {
	readonly id: number;
	readonly created_at: string;
}

// Newest first, as GitHub lists runs: 30 in November, the last at the month's end; 1,150 in
// October, beyond the 1,000 that a `created` filter returns, the last at the month's start; then
// 250 in September.
function listing(): Listed[] {
	const runs: Listed[] = [];
	const add = (count: number, newest: string, step: number): void => {
		for (let at = 0; at < count; at++) {
			const time = new Date(Date.parse(newest) - at * step * 1000).toISOString();
			runs.push({ id: 5000 - runs.length, created_at: time.replace(".000Z", "Z") });
		}
	};
	add(30, "2026-11-01T00:00:29Z", 1);
	add(1149, "2026-10-31T23:59:59Z", 2000);
	add(1, "2026-10-01T00:00:00Z", 1);
	add(250, "2026-09-30T23:59:59Z", 2000);
	return runs;
}

// A gh for `repos/{owner}/{repo}`, its runs 100 a page and one job per run. A run that starts
// after the first page moves every later run down a place, so the next page repeats one.
function fakeGh(runs: readonly Listed[], visibility: string | Error = "private", seconds = 90) {
	let listed = [...runs];
	const calls: string[][] = [];
	const gh: Gh = async (args) => {
		calls.push([...args]);
		const endpoint = args.find((arg) => arg.startsWith("repos/")) ?? "";
		if (endpoint === "repos/{owner}/{repo}") {
			if (visibility instanceof Error) throw visibility;
			return `${visibility}\n`;
		}
		const page = /^repos\/\{owner\}\/\{repo\}\/actions\/runs\?per_page=100&page=(\d+)$/.exec(
			endpoint,
		);
		if (page) {
			const from = (Number(page[1]) - 1) * 100;
			const lines = listed.slice(from, from + 100).map((run) => JSON.stringify(run));
			if (from === 0) listed = [{ id: 9999, created_at: "2026-11-02T00:00:00Z" }, ...listed];
			return lines.join("\n");
		}
		if (/^repos\/\{owner\}\/\{repo\}\/actions\/runs\/\d+\/jobs\?/.test(endpoint)) {
			return `${JSON.stringify(job(seconds))}\n`;
		}
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};
	return { gh, calls };
}

const endpointOf = (args: readonly string[]): string =>
	args.find((arg) => arg.startsWith("repos/")) ?? "";

describe("the month's runs, past the 1,000 a created filter returns", () => {
	const runs = listing();
	const october = runs.filter((run) => run.created_at.startsWith("2026-10-")).map((run) => run.id);

	it("pages newest first, stops at the month's start and keeps only the month's runs", async () => {
		const { gh, calls } = fakeGh(runs);
		const ids = await monthRuns("{owner}/{repo}", monthBounds("2026-10"), gh);
		expect(october).toHaveLength(1150);
		expect(ids).toHaveLength(1150);
		expect(new Set(ids)).toEqual(new Set(october));
		// Page 12 reaches September, so pages 13 to 15 are never read.
		expect(calls).toEqual(
			Array.from({ length: 12 }, (_, at) => [
				"api",
				"--method",
				"GET",
				`repos/{owner}/{repo}/actions/runs?per_page=100&page=${at + 1}`,
				"--jq",
				".workflow_runs[] | {id, created_at}",
			]),
		);
	});

	it("stops on a short page, and keeps an earlier month's end bound", async () => {
		const { gh, calls } = fakeGh(runs.slice(0, 150));
		const ids = await monthRuns("{owner}/{repo}", monthBounds("2026-10"), gh);
		expect(ids).toHaveLength(120);
		expect(calls).toHaveLength(2);
		const september = await monthRuns("{owner}/{repo}", monthBounds("2026-09"), fakeGh(runs).gh);
		expect(september).toHaveLength(250);
	});

	it("lists every attempt's jobs of the month's runs, and of no other run", async () => {
		const { gh, calls } = fakeGh(runs);
		const result = await monthJobs("{owner}/{repo}", monthBounds("2026-10"), gh);
		expect(result.runs).toBe(1150);
		expect(result.jobs).toHaveLength(1150);
		const asked = calls.map(endpointOf).flatMap((endpoint) => {
			const id = /\/runs\/(\d+)\/jobs\?per_page=100&filter=all$/.exec(endpoint)?.[1];
			return id === undefined ? [] : [Number(id)];
		});
		expect(asked).toHaveLength(1150);
		expect(new Set(asked)).toEqual(new Set(october));
		const first = calls.find((args) => endpointOf(args).includes("/jobs?")) ?? [];
		expect(first).toEqual([
			"api",
			"--paginate",
			"--method",
			"GET",
			endpointOf(first),
			"--jq",
			jobQuery,
		]);
	});

	it("asks for no more jobs once a jobs call fails", async () => {
		const { gh } = fakeGh(runs);
		let asked = 0;
		const failing: Gh = async (args) => {
			if (!endpointOf(args).includes("/jobs?")) return gh(args);
			asked++;
			if (asked === 20) throw new Error("HTTP 502");
			return gh(args);
		};
		await expect(monthJobs("{owner}/{repo}", monthBounds("2026-10"), failing)).rejects.toThrow(
			"HTTP 502",
		);
		await setImmediate();
		// The other seven workers each finish only the call they had started.
		expect(asked).toBeGreaterThanOrEqual(20);
		expect(asked).toBeLessThanOrEqual(20 + 7);
	});
});

describe("ciMinutes", () => {
	const runs = listing();
	async function report(visibility: string | Error) {
		const { gh, calls } = fakeGh(runs, visibility);
		const lines: string[] = [];
		await ciMinutes("2026-10", { gh, log: (line) => lines.push(line) });
		return { calls, lines };
	}
	const count = [
		"ci:minutes: 2026-10 (UTC), 1150 runs, 1150 jobs",
		"  linux    2300 min x 1",
		"  windows     0 min x 2",
		"  macos       0 min x 10",
	];
	const billed = [
		"  billed  2300 of 2000 included minutes",
		"  1500+ minutes: only PR checks run until next month or the owner's OK",
	];

	it("reads the visibility first and calls a public repository's count runner time, for reference", async () => {
		const { calls, lines } = await report("public");
		expect(calls[0]).toEqual(["api", "repos/{owner}/{repo}", "--jq", ".visibility"]);
		expect(calls.filter((args) => endpointOf(args) === "repos/{owner}/{repo}")).toHaveLength(1);
		expect(lines).toEqual([
			"ci:minutes: the repository is public; standard runners don't bill public repositories, so this count is runner time, for reference",
			...count,
			"  at private rates 2300 of 2000 included minutes",
		]);
	});

	it("prints a private repository's count as billed minutes, with the 1,500 limit", async () => {
		const { lines } = await report("private");
		expect(lines).toEqual(["ci:minutes: the repository is private", ...count, ...billed]);
	});

	it("says why the visibility is unknown and counts as for a private repository", async () => {
		const failed = await report(
			new Error("gh api repos/{owner}/{repo} --jq .visibility: HTTP 403"),
		);
		expect(failed.lines).toEqual([
			"ci:minutes: the repository's visibility is unknown (gh api repos/{owner}/{repo} --jq .visibility: HTTP 403)",
			...count,
			...billed,
		]);
		const odd = await report("null");
		expect(odd.lines[0]).toBe(
			`ci:minutes: the repository's visibility is unknown (gh gave "null")`,
		);
		expect(odd.lines.slice(1)).toEqual([...count, ...billed]);
	});

	it("refuses a malformed month before it calls gh", async () => {
		const { gh, calls } = fakeGh(runs);
		await expect(ciMinutes("2026-1", { gh, log: () => {} })).rejects.toThrow(
			"--month must be YYYY-MM",
		);
		expect(calls).toEqual([]);
	});
});
