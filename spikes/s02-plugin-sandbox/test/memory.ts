// The RSS watchdog's parts for S2b (plan §4 Health: sample every plugin, kill above 512 MiB):
// samplers per OS, the kill, the untouched-allocation case and the per-spawn re-hash. Used by the
// host tests and, staged, by docker-runner-s2b.ts, so it imports only node: built-ins and ./s2b.ts.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { spawnFixture, tagged, within } from "./s2b.ts";

export const RSS_LIMIT_MIB = 512;
// The plan's sampling period, and the fast one that shows the kill itself works.
export const PLAN_INTERVAL_MS = 5_000;
export const FAST_INTERVAL_MS = 150;

const MIB = 1_048_576;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface Sampler {
	readonly method: string;
	// What the number is: a working set, resident pages, or committed private bytes.
	readonly metric: "working-set" | "resident" | "private-bytes";
	sample(pid: number): Promise<number | null>;
	close(): void;
}

function run(command: string, args: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 }, (e, out) =>
			resolve(e ? null : out),
		);
	});
}

// Digits only, so a localized thousands separator ("12,345 K", "12.345 K") can't skew the value.
const kibToMib = (text: string | undefined): number | null => {
	const digits = text?.replace(/\D/g, "") ?? "";
	return digits === "" ? null : Math.round(Number(digits) / 1024);
};

// Windows: the working set, one tasklist process per sample.
export function tasklistSampler(): Sampler {
	return {
		method: "tasklist-csv",
		metric: "working-set",
		async sample(pid) {
			const out = await run("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"]);
			return kibToMib(out?.trim().split('","').at(-1));
		},
		close() {},
	};
}

// Windows: committed private bytes, from one long-lived PowerShell that answers a pid per line.
export function powershellSampler(): Sampler {
	const exe = path.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const script = [
		"$in = [Console]::In",
		"while ($null -ne ($line = $in.ReadLine())) {",
		"  try { $p = [Diagnostics.Process]::GetProcessById([int]$line);",
		"    [Console]::Out.WriteLine([string]$p.PrivateMemorySize64) }",
		"  catch { [Console]::Out.WriteLine('x') }",
		"  [Console]::Out.Flush()",
		"}",
	].join("\n");
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
	const child = spawn(exe, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
	child.on("error", () => {});
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	let queue: Promise<unknown> = Promise.resolve();
	return {
		method: "powershell-private-bytes",
		metric: "private-bytes",
		sample(pid) {
			const next = queue.then(async () => {
				child.stdin.write(`${pid}\n`);
				const { value, done } = await lines.next();
				const digits = done ? "" : String(value).replace(/\D/g, "");
				return digits === "" ? null : Math.round(Number(digits) / MIB);
			});
			queue = next.catch(() => null);
			return next.catch(() => null);
		},
		close() {
			child.stdin.end();
			child.kill("SIGKILL");
		},
	};
}

// Linux: VmRSS from /proc/<pid>/status (kB, whatever the page size).
export function procStatusSampler(): Sampler {
	return {
		method: "proc-status",
		metric: "resident",
		async sample(pid) {
			try {
				const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
				const kib = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
				return kib === undefined ? null : Math.round(Number(kib) / 1024);
			} catch {
				return null;
			}
		},
		close() {},
	};
}

// Linux: resident pages from /proc/<pid>/statm, scaled by this machine's page size.
export function procStatmSampler(): Sampler {
	let pageSize = 0;
	return {
		method: "proc-statm",
		metric: "resident",
		async sample(pid) {
			try {
				if (pageSize === 0) {
					const pages = Number(fs.readFileSync("/proc/self/statm", "utf8").split(" ")[1]);
					const kib = /^VmRSS:\s+(\d+)/m.exec(fs.readFileSync("/proc/self/status", "utf8"))?.[1];
					const ratio = (Number(kib) * 1024) / pages;
					pageSize = 2 ** Math.round(Math.log2(ratio));
				}
				const resident = Number(fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
				return Number.isFinite(resident) ? Math.round((resident * pageSize) / MIB) : null;
			} catch {
				return null;
			}
		},
		close() {},
	};
}

// POSIX: ps, one process per sample (absent from slim images, which then read null).
export function psSampler(): Sampler {
	return {
		method: "ps-rss",
		metric: "resident",
		async sample(pid) {
			return kibToMib((await run("ps", ["-o", "rss=", "-p", String(pid)]))?.trim());
		},
		close() {},
	};
}

export function samplersFor(platform: NodeJS.Platform): Sampler[] {
	if (platform === "win32") return [tasklistSampler(), powershellSampler()];
	if (platform === "linux") return [procStatmSampler(), procStatusSampler(), psSampler()];
	return [psSampler()];
}

// The sampler the kill cases use: tasklist's working set (the plan's), VmRSS, or ps.
export function killSamplerFor(platform: NodeJS.Platform): Sampler {
	if (platform === "win32") return tasklistSampler();
	return platform === "linux" ? procStatusSampler() : psSampler();
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}
const ms3 = (value: number): number => Math.round(value * 1000) / 1000;

export interface SamplingCost {
	readonly method: string;
	readonly metric: string;
	readonly available: boolean;
	readonly firstMs: number;
	readonly reads: number;
	readonly medianMs: number;
	readonly minMs: number;
	readonly maxMs: number;
	readonly lastMiB: number | null;
}

// Times `reads` samples of a live idle plugin, after one first (warm-up) sample.
export async function measureSamplingCost(
	sampler: Sampler,
	pid: number,
	reads = 25,
): Promise<SamplingCost> {
	let begun = performance.now();
	let last = await sampler.sample(pid);
	const firstMs = performance.now() - begun;
	const durations: number[] = [];
	for (let i = 0; i < reads; i++) {
		begun = performance.now();
		last = await sampler.sample(pid);
		durations.push(performance.now() - begun);
	}
	return {
		method: sampler.method,
		metric: sampler.metric,
		available: last !== null,
		firstMs: ms3(firstMs),
		reads,
		medianMs: ms3(median(durations)),
		minMs: ms3(Math.min(...durations)),
		maxMs: ms3(Math.max(...durations)),
		lastMiB: last,
	};
}

// The busiest processes in `ps -A -o pcpu= -o comm=` output, by name only, and the share of them
// all. Two `-o` options, not one `-o pcpu=,comm=`: a BSD/macOS ps reads the `=string` of the last
// keyword as spanning the rest of the argument, so the comma form yields a single unnamed column.
export function busiestProcesses(psOutput: string, count = 8): string {
	const rows = psOutput
		.split(/\r?\n/)
		.map((line) => /^\s*(\d+(?:[.,]\d+)?)\s+(\S.*?)\s*$/.exec(line))
		.filter((match) => match !== null)
		.map(([, cpu = "0", name = ""]) => ({
			cpu: Number(cpu.replace(",", ".")),
			name: path.basename(name),
		}))
		.sort((a, b) => b.cpu - a.cpu);
	const total = rows.reduce((sum, row) => sum + row.cpu, 0);
	const top = rows.slice(0, count).map((row) => `${row.name} ${row.cpu}%`);
	return `${Math.round(total * 10) / 10}% in all; ${top.join(", ")}`;
}

// What the machine showed when the bench lock's idle check gave up: every CPU sample it took, the
// load average, the not-free memory and the busiest processes by ps's %cpu (on macOS a decaying
// average over the last minute), which says what kept the CPU busy without changing the check. The
// memory figure is what os.freemem() reports as not free, which on macOS counts the file cache and
// other reclaimable memory and so reads close to full on an ordinary runner; swap use (macOS) is the
// real pressure signal, so it is reported too.
export async function busyReport(samples: readonly number[]): Promise<string> {
	const load = os.loadavg().map((value) => value.toFixed(2));
	const notFree = Math.round(100 * (1 - os.freemem() / os.totalmem()));
	const lines = [
		`CPU samples (%, 1 s each, oldest first): ${samples.join(" ")}`,
		`load average ${load.join(" ")} on ${os.availableParallelism()} CPUs; memory not free ${notFree}% (includes cache)`,
	];
	if (process.platform !== "win32") {
		const ps = await run("ps", ["-A", "-o", "pcpu=", "-o", "comm="]);
		lines.push(`busiest processes (ps %cpu): ${ps === null ? "not listed" : busiestProcesses(ps)}`);
	}
	if (process.platform === "darwin") {
		const swap = await run("sysctl", ["-n", "vm.swapusage"]);
		lines.push(`swap: ${swap === null ? "not listed" : swap.trim()}`);
	}
	return lines.join("\n");
}

export interface PluginDirs {
	readonly nodeBin: string;
	readonly pluginDir: string;
	readonly dataDir: string;
}

export function spawnGrower(dirs: PluginDirs, mode: string): ChildProcess {
	return spawnFixture({
		...dirs,
		grantData: true,
		entry: path.join(dirs.pluginDir, "mem-grow.mjs"),
		entryArgs: [mode],
	});
}

export interface KillOutcome {
	readonly mode: string;
	readonly node: string;
	readonly method: string;
	readonly intervalMs: number;
	readonly killedByWatchdog: boolean;
	readonly killSignal: string | null;
	readonly peakMiB: number;
	readonly overshootMiB: number;
	readonly timeToKillMs: number | null;
	// The grower's own report (fast modes): how quickly it reached its 1536 MiB ceiling.
	readonly growerCeilingMiB: number | null;
	readonly growerCeilingMs: number | null;
}

// The watchdog: sample every intervalMs; above the limit, SIGKILL.
export async function runWatchdogKill(
	dirs: PluginDirs,
	node: string,
	mode: string,
	sampler: Sampler,
	intervalMs: number,
): Promise<KillOutcome> {
	const started = performance.now();
	const child = spawnGrower(dirs, mode);
	let stdout = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.resume();
	const closed = new Promise<string | null>((resolve) => {
		child.once("close", (_code, signal) => resolve(signal));
	});
	let stopped = false;
	let peak = 0;
	let killedAt: number | null = null;
	const watchdog = (async () => {
		while (!stopped) {
			await sleep(intervalMs);
			if (stopped || child.pid === undefined) return;
			const rss = await sampler.sample(child.pid);
			if (rss === null) continue;
			peak = Math.max(peak, rss);
			if (rss > RSS_LIMIT_MIB) {
				killedAt = performance.now();
				child.kill("SIGKILL");
				return;
			}
		}
	})();
	const killSignal = await within(closed, 60_000, null);
	stopped = true;
	await watchdog;
	if (killedAt === null) child.kill("SIGKILL");
	const ceiling = tagged(stdout).find((line) => line.event === "ceiling");
	return {
		mode,
		node,
		method: sampler.method,
		intervalMs,
		killedByWatchdog: killedAt !== null,
		killSignal,
		peakMiB: peak,
		overshootMiB: Math.max(0, peak - RSS_LIMIT_MIB),
		timeToKillMs: killedAt === null ? null : Math.round(killedAt - started),
		growerCeilingMiB: typeof ceiling?.grownMiB === "number" ? ceiling.grownMiB : null,
		growerCeilingMs: typeof ceiling?.ms === "number" ? ceiling.ms : null,
	};
}

export interface UntouchedOutcome {
	readonly node: string;
	readonly allocatedMiB: number;
	// Each sampler's reading of a plugin holding 768 MiB it never touched.
	readonly readings: {
		readonly method: string;
		readonly metric: string;
		readonly mib: number | null;
	}[];
}

export async function runUntouched(
	dirs: PluginDirs,
	node: string,
	samplers: readonly Sampler[],
): Promise<UntouchedOutcome> {
	const child = spawnGrower(dirs, "untouched");
	let stdout = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.resume();
	try {
		for (let waited = 0; waited < 10_000 && !stdout.includes('"allocated"'); waited += 50) {
			await sleep(50);
		}
		await sleep(300);
		const readings = [];
		for (const sampler of samplers) {
			const mib = child.pid === undefined ? null : await sampler.sample(child.pid);
			readings.push({ method: sampler.method, metric: sampler.metric, mib });
		}
		const allocated = tagged(stdout).find((line) => line.event === "allocated");
		return { node, allocatedMiB: Number(allocated?.untouchedMiB ?? 0), readings };
	} finally {
		child.kill("SIGKILL");
	}
}

// The hub's per-spawn check (plan §4): lstat every entry, refuse any link, hash every file.
export function hashTree(root: string): { files: number; bytes: number } {
	let files = 0;
	let bytes = 0;
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of fs.readdirSync(dir)) {
			const full = path.join(dir, entry);
			const stats = fs.lstatSync(full);
			if (stats.isSymbolicLink() || (stats.isFile() && stats.nlink > 1)) {
				throw new Error(`a link in the bundle: ${entry}`);
			}
			if (stats.isDirectory()) {
				stack.push(full);
			} else if (stats.isFile()) {
				const data = fs.readFileSync(full);
				createHash("sha256").update(data).digest();
				files += 1;
				bytes += data.length;
			} else {
				throw new Error(`not a file or directory: ${entry}`);
			}
		}
	}
	return { files, bytes };
}

export function makeTree(root: string, totalBytes: number, fileCount = 16): string {
	fs.mkdirSync(root, { recursive: true });
	const per = Math.floor(totalBytes / fileCount);
	for (let i = 0; i < fileCount; i++) {
		fs.writeFileSync(path.join(root, `file-${i}.bin`), Buffer.alloc(per, i + 1));
	}
	return root;
}

export interface RehashCost {
	readonly label: string;
	readonly files: number;
	readonly bytes: number;
	readonly runs: number;
	readonly medianMs: number;
	readonly minMs: number;
}

export function measureRehash(label: string, dir: string, runs = 7): RehashCost {
	const durations: number[] = [];
	let tree = { files: 0, bytes: 0 };
	for (let i = 0; i < runs; i++) {
		const begun = performance.now();
		tree = hashTree(dir);
		durations.push(performance.now() - begun);
	}
	return {
		label,
		...tree,
		runs,
		medianMs: Math.round(median(durations) * 100) / 100,
		minMs: Math.round(Math.min(...durations) * 100) / 100,
	};
}
