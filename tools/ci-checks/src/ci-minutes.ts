import { cliArgs, execAsync, runCli } from "./lib.ts";

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

// "2026-10" → the month's first millisecond and the next month's, in UTC.
export function monthBounds(month: string): readonly [number, number] {
	const match = /^(\d{4})-(\d{2})$/.exec(month);
	const [year, index] = [Number(match?.[1]), Number(match?.[2])];
	if (!match || index < 1 || index > 12) throw new Error(`--month must be YYYY-MM, got ${month}`);
	return [Date.UTC(year, index - 1, 1), Date.UTC(year, index, 1)];
}

// gh's output for these arguments; it rejects when gh fails.
export type Gh = (args: readonly string[]) => Promise<string>;

export const jsonLines = <T>(text: string): T[] =>
	text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);

export const jobQuery = ".jobs[] | {labels, status, conclusion, started_at, completed_at}";

// A `created` filter stops the runs listing at 1,000 runs, so the month's runs come from the whole
// listing, newest first, up to the first page that reaches back before the month.
export async function monthRuns(
	repo: string,
	[start, end]: readonly [number, number],
	gh: Gh,
): Promise<number[]> {
	const ids = new Set<number>();
	for (let page = 1; ; page++) {
		const endpoint = `repos/${repo}/actions/runs?per_page=100&page=${page}`;
		const query = ".workflow_runs[] | {id, created_at}";
		const output = await gh(["api", "--method", "GET", endpoint, "--jq", query]);
		const runs = jsonLines<{ id: number; created_at: string }>(output);
		for (const run of runs) {
			const created = Date.parse(run.created_at);
			if (created >= start && created < end) ids.add(run.id);
		}
		const oldest = runs.at(-1)?.created_at;
		if (runs.length < 100 || !oldest || Date.parse(oldest) < start) return [...ids];
	}
}

// Every job of the month's runs, each attempt of a re-run included, eight runs at a time; a failed
// call empties the queue, so no worker asks for more. The REST jobs list (not
// `gh run view --json jobs`) carries each job's runner labels.
export async function monthJobs(
	repo: string,
	month: readonly [number, number],
	gh: Gh,
): Promise<{ readonly runs: number; readonly jobs: readonly Job[] }> {
	const ids = await monthRuns(repo, month, gh);
	const runs = ids.length;
	const jobs: Job[] = [];
	const worker = async (): Promise<void> => {
		try {
			for (let id = ids.pop(); id !== undefined; id = ids.pop()) {
				const endpoint = `repos/${repo}/actions/runs/${id}/jobs?per_page=100&filter=all`;
				const args = ["api", "--paginate", "--method", "GET", endpoint, "--jq", jobQuery];
				jobs.push(...jsonLines<Job>(await gh(args)));
			}
		} catch (error) {
			ids.length = 0;
			throw error;
		}
	};
	await Promise.all(Array.from({ length: 8 }, worker));
	return { runs, jobs };
}

// A repository's visibility as gh printed it; `unknown` says why there is none.
export interface Visibility {
	readonly value?: string;
	readonly unknown?: string;
}

export function visibilityOf(output: string): Visibility {
	const value = output.trim();
	return ["public", "private", "internal"].includes(value)
		? { value }
		: { unknown: `gh gave ${JSON.stringify(value)}` };
}

async function readVisibility(repo: string, gh: Gh): Promise<Visibility> {
	try {
		return visibilityOf(await gh(["api", `repos/${repo}`, "--jq", ".visibility"]));
	} catch (error) {
		return { unknown: error instanceof Error ? error.message : String(error) };
	}
}

export interface MinutesDeps {
	readonly gh: Gh;
	readonly log: (line: string) => void;
}

function visibilityLine({ value, unknown }: Visibility): string {
	if (value === "public") {
		return "ci:minutes: the repository is public; standard runners don't bill public repositories, so this count is runner time, for reference";
	}
	return value
		? `ci:minutes: the repository is ${value}`
		: `ci:minutes: the repository's visibility is unknown (${unknown})`;
}

// The repository's visibility first, then the month's minutes per OS and their total at the rates
// that a private repository pays.
export async function ciMinutes(month: string, { gh, log }: MinutesDeps): Promise<void> {
	const bounds = monthBounds(month);
	const repo = "{owner}/{repo}";
	const visibility = await readVisibility(repo, gh);
	log(visibilityLine(visibility));
	const free = visibility.value === "public";
	const { runs, jobs } = await monthJobs(repo, bounds, gh);
	const { minutes, billed, running } = tally(jobs);
	log(`ci:minutes: ${month} (UTC), ${runs} runs, ${jobs.length} jobs`);
	for (const os of ["linux", "windows", "macos"] as const) {
		log(`  ${os.padEnd(7)} ${String(minutes[os]).padStart(5)} min x ${rates[os]}`);
	}
	log(
		`  ${free ? "at private rates" : "billed "} ${billed} of ${includedMinutes} included minutes`,
	);
	if (running > 0) log(`  ${running} jobs still running aren't counted yet`);
	if (!free && billed >= prChecksOnlyFrom) {
		log(`  ${prChecksOnlyFrom}+ minutes: only PR checks run until next month or the owner's OK`);
	}
}

async function main(argv: readonly string[]): Promise<number> {
	const { month, repo } = cliArgs(argv, ["month", "repo"]);
	if (repo) process.env.GH_REPO = repo;
	const gh: Gh = (args) => execAsync("gh", args);
	await ciMinutes(month ?? new Date().toISOString().slice(0, 7), { gh, log: console.log });
	return 0;
}

if (import.meta.main) await runCli("ci:minutes", () => main(process.argv.slice(2)));
