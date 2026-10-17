import { cliArgs, exec, runCli } from "./lib.ts";

export interface Job {
	readonly labels: readonly string[];
	readonly status: string;
	readonly conclusion: string | null;
	readonly started_at: string | null;
	readonly completed_at: string | null;
}

export type RunnerOs = "linux" | "windows" | "macos";

// Included-minute multipliers on GitHub Free for private repos; arm64 runners bill like x64.
export const rates: Readonly<Record<RunnerOs, number>> = { linux: 1, windows: 2, macos: 10 };
export const includedMinutes = 2000;
export const prChecksOnlyFrom = 1500;

export function runnerOs(labels: readonly string[]): RunnerOs {
	if (labels.some((label) => /macos/i.test(label))) return "macos";
	return labels.some((label) => /windows/i.test(label)) ? "windows" : "linux";
}

// GitHub rounds each job up to a whole minute; skipped and unfinished jobs count nothing.
export function jobMinutes(job: Job): number {
	if (job.status !== "completed" || job.conclusion === "skipped") return 0;
	if (!job.started_at || !job.completed_at) return 0;
	const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
	return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export interface Tally {
	readonly minutes: Readonly<Record<RunnerOs, number>>;
	readonly billed: number;
	readonly running: number;
}

export function tally(jobs: readonly Job[]): Tally {
	const minutes: Record<RunnerOs, number> = { linux: 0, windows: 0, macos: 0 };
	let running = 0;
	for (const job of jobs) {
		if (job.status !== "completed") running++;
		minutes[runnerOs(job.labels)] += jobMinutes(job);
	}
	const billed =
		minutes.linux * rates.linux + minutes.windows * rates.windows + minutes.macos * rates.macos;
	return { minutes, billed, running };
}

// "2026-10" → "2026-10-01..2026-10-31", GitHub's `created` range syntax.
export function monthRange(month: string): string {
	const match = /^(\d{4})-(\d{2})$/.exec(month);
	const [year, index] = [Number(match?.[1]), Number(match?.[2])];
	if (!match || index < 1 || index > 12) throw new Error(`--month must be YYYY-MM, got ${month}`);
	const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
	return `${month}-01..${month}-${String(last).padStart(2, "0")}`;
}

// The REST jobs list (not `gh run view --json jobs`) carries each job's runner labels and,
// with filter=all, every attempt of a re-run.
function ghLines<T>(endpoint: string, jq: string): T[] {
	const output = exec("gh", ["api", "--paginate", "--method", "GET", endpoint, "--jq", jq]);
	return output
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);
}

function main(argv: readonly string[]): number {
	const args = cliArgs(argv, ["month", "repo"]);
	if (args.repo) process.env.GH_REPO = args.repo;
	const month = args.month ?? new Date().toISOString().slice(0, 7);
	const runs = ghLines<{ id: number }>(
		`repos/{owner}/{repo}/actions/runs?per_page=100&created=${monthRange(month)}`,
		".workflow_runs[] | {id}",
	);
	const jobs = runs.flatMap((run) =>
		ghLines<Job>(
			`repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100&filter=all`,
			".jobs[] | {labels, status, conclusion, started_at, completed_at}",
		),
	);
	const { minutes, billed, running } = tally(jobs);
	console.log(`ci:minutes: ${month} (UTC), ${runs.length} runs, ${jobs.length} jobs`);
	for (const os of ["linux", "windows", "macos"] as const) {
		console.log(`  ${os.padEnd(7)} ${String(minutes[os]).padStart(5)} min x ${rates[os]}`);
	}
	console.log(`  billed  ${billed} of ${includedMinutes} included minutes`);
	if (running > 0) console.log(`  ${running} jobs still running aren't counted yet`);
	if (billed >= prChecksOnlyFrom) {
		console.log(
			`  ${prChecksOnlyFrom}+ minutes: only PR checks run until next month or the owner's OK`,
		);
	}
	return 0;
}

if (import.meta.main) await runCli("ci:minutes", () => main(process.argv.slice(2)));
