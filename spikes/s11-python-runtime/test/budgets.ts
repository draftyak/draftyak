// S11c budget drivers (plan §15 S11 (g)), run on the host only: budgets count on native targets. Every
// plugin is spawned as the hub spawns a python plugin (spawnPythonPlugin: the runtime re-hash and the
// bundle check, then the production argv); the two memory controls drop one flag. Readings of a
// plugin's memory reuse S2b's samplers (M0.12): Windows tasklist (working set) and a long-lived
// PowerShell (private bytes), Linux /proc/<pid>/status (VmRSS), macOS ps (rss).
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	acquireBenchLock,
	type BenchLock,
	type BenchLockOptions,
	MachineBusyError,
	strictSkips,
} from "@draftyak/spike-kit";
import type { Sampler } from "@draftyak/spike-s02-plugin-sandbox/test/memory.ts";
import { type PluginSpec, spawnProduction, spawnWithoutFlag } from "./allowlist.ts";
import {
	PYTHON_RSS_LIMIT_MIB,
	percentile,
	ROUND_TRIP_BYTES,
	ROUND_TRIP_RUNS,
	WASM_FLAG,
	WASM_PAGES,
} from "./budget-rules.ts";
import {
	contentFree,
	exitReasonOf,
	firstText,
	openSession,
	type Session,
	structured,
	within,
} from "./rpc.ts";

const round = (value: number): number => Math.round(value * 10) / 10;
// Each request of a budget plugin; a boot takes about 1.5 s.
const ASK_MS = 30_000;

// spikes-run (CI with strict skips) runs one spike per job and S11's heavy files one at a time, so
// nothing else takes the lock there: having to wait for it means the lock path failed, and the test
// stops at once, naming the lock file. Elsewhere it waits for the holder.
export function lockFailsFast(env: NodeJS.ProcessEnv = process.env): boolean {
	return !!env.CI && strictSkips(env);
}

// The kit's lock, with its idle check unless options say otherwise.
export async function benchLock(
	signal: AbortSignal,
	options: BenchLockOptions = {},
	env: NodeJS.ProcessEnv = process.env,
): Promise<BenchLock> {
	const stop = new AbortController();
	try {
		return await acquireBenchLock({
			...options,
			label: "s11-budgets",
			signal: AbortSignal.any([signal, stop.signal]),
			onWait: (holder, file) => {
				const who = holder ? `${holder.label} (pid ${holder.pid})` : "no holder recorded";
				if (lockFailsFast(env)) {
					stop.abort(
						new Error(
							`the bench lock ${file} is held on this ${process.platform} runner (${who}), where nothing else takes it: the lock path failed`,
						),
					);
				} else {
					process.stderr.write(`bench lock: waiting for ${who} to release ${file}\n`);
				}
			},
		});
	} catch (error) {
		if (error instanceof MachineBusyError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`bench lock on ${process.platform}: ${message}`, { cause: error });
	}
}

// A lock failure as evidence may hold it: the lock file's path and any other path go.
export function lockMessage(error: unknown): string {
	return contentFree(error instanceof Error ? error.message : String(error));
}

export interface BusyProcess {
	readonly name: string;
	readonly cpuPercent: number;
}

export interface BusyReport {
	// CPU samples (% of all cores, 1 s each, oldest first): those of the failed idle check, or the
	// leg's sample that went over the threshold.
	readonly samples: readonly number[];
	readonly loadAverage: readonly number[];
	readonly cpuCount: number;
	readonly memoryUsedPercent: number;
	// Generic names only, in % of one core: ps's %cpu on macOS (a decaying average) and Linux (since
	// the process started), a 1 s CPU-time delta on Windows; null when the listing failed.
	readonly busiest: readonly BusyProcess[] | null;
}

const run = (file: string, args: readonly string[]): Promise<string | null> =>
	new Promise((resolve) => {
		execFile(file, args, { encoding: "utf8", windowsHide: true, timeout: 20_000 }, (error, out) =>
			resolve(error ? null : out),
		);
	});

// Windows has no ps %cpu: the CPU time each process used over one second.
const WINDOWS_BUSY = [
	"$a = @{}",
	"foreach ($p in Get-Process) { try { $a[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {} }",
	"Start-Sleep -Milliseconds 1000",
	"$c = [Globalization.CultureInfo]::InvariantCulture",
	"foreach ($p in Get-Process) { try { if ($a.ContainsKey($p.Id)) {",
	"  $d = $p.TotalProcessorTime.TotalMilliseconds - $a[$p.Id]",
	"  if ($d -gt 0) { [Console]::Out.WriteLine(([math]::Round($d / 10, 1)).ToString($c) + ' ' + $p.ProcessName) }",
	"} } catch {} }",
].join("\n");

// Generic build, container and OS process names. Evidence names only these, so it never lists the
// apps someone runs; every other process counts as "<other>".
const KNOWN_PROCESSES = new Set(
	[
		"cargo rustc cl link msbuild clang gcc cc1 cc1plus ld java gradle tsc esbuild node python",
		"python3 pnpm npm git make cmake ninja docker dockerd containerd com.docker.backend vmmem",
		"vmmemwsl wsl wslhost qemu-system-x86_64 qemu-system-aarch64 system registry msmpeng",
		"mpdefendercoreservice searchindexer searchprotocolhost svchost csrss dwm explorer tiworker",
		"trustedinstaller wmiprvse compattelrunner conhost powershell pwsh cmd bash sh mds",
		"mds_stores mdworker mdworker_shared kernel_task windowserver xprotectservice syspolicyd",
		"softwareupdated launchd systemd journald runner.worker runner.listener provjobd",
	]
		.join(" ")
		.split(" "),
);

function processName(raw: string): string {
	const name = path
		.basename(raw.trim())
		.replace(/\.exe$/i, "")
		.toLowerCase();
	return KNOWN_PROCESSES.has(name) ? name : "<other>";
}

// Lines of "<% of one core> <name or path>", summed by name, busiest first.
export function busiestOf(listing: string, count = 8): BusyProcess[] {
	const totals = new Map<string, number>();
	for (const line of listing.split(/\r?\n/)) {
		const match = /^\s*(\d+(?:[.,]\d+)?)\s+(\S.*?)\s*$/.exec(line);
		if (match === null) continue;
		const name = processName(match[2] ?? "");
		totals.set(name, (totals.get(name) ?? 0) + Number((match[1] ?? "0").replace(",", ".")));
	}
	return [...totals]
		.map(([name, cpu]) => ({ name, cpuPercent: round(cpu) }))
		.filter((item) => item.cpuPercent > 0)
		.toSorted((a, b) => b.cpuPercent - a.cpuPercent)
		.slice(0, count);
}

// What the machine showed when it was too busy to measure, without changing the check: the CPU
// samples, the load average, the memory in use and the busiest processes by name.
export async function busyReport(samples: readonly number[]): Promise<BusyReport> {
	const powershell = path.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const listing =
		process.platform === "win32"
			? await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_BUSY])
			: await run("ps", ["-A", "-o", "pcpu=,comm="]);
	return {
		samples: samples.slice(-60),
		loadAverage: os.loadavg().map(round),
		cpuCount: os.availableParallelism(),
		memoryUsedPercent: round(100 * (1 - os.freemem() / os.totalmem())),
		busiest: listing === null ? null : busiestOf(listing),
	};
}

// How a plugin ended once its stdin closed, the hub's stop.
export interface PluginExit {
	readonly exitCode: number | null;
	readonly cleanExit: boolean;
	readonly exitReason: string | null;
}

async function stop(session: Session, graceMs?: number): Promise<PluginExit> {
	const exitCode = await session.close(graceMs);
	const exitReason = exitReasonOf(exitCode, session.child.signalCode, session.stderr());
	return { exitCode, cleanExit: exitCode === 0, exitReason };
}

export interface ColdStart extends PluginExit {
	// From before the hub's pre-spawn checks to the answer to the first tools/list; null when the
	// plugin didn't answer it (failure says why).
	readonly totalMs: number | null;
	// The runtime re-hash and the bundle check before the spawn.
	readonly checksMs: number;
	readonly discoverMs: number | null;
	// The shim's own boot time, from its first line to serving.
	readonly bootMs: number | null;
	readonly tools: number;
	readonly failure: string | null;
}

// One cold start: a fresh process, server/discover, then the first tools/list.
export async function coldStart(spec: PluginSpec, pluginDir: string): Promise<ColdStart> {
	const started = performance.now();
	const child = spawnProduction(spec, pluginDir, "budget-cold");
	const checksMs = performance.now() - started;
	const session = openSession(child);
	const discover = await session.ask("server/discover", {}, ASK_MS);
	const discoverMs = performance.now() - started;
	const list = discover === null ? null : await session.ask("tools/list", {}, ASK_MS);
	const totalMs = performance.now() - started;
	const tools = (list?.result?.tools as unknown[] | undefined)?.length ?? 0;
	const exit = await stop(session);
	const answered = discover !== null && list !== null && tools > 0;
	const bootMs = session.ready()?.bootMs;
	return {
		totalMs: answered ? round(totalMs) : null,
		checksMs: round(checksMs),
		discoverMs: discover === null ? null : round(discoverMs),
		bootMs: typeof bootMs === "number" ? bootMs : null,
		tools,
		failure: answered ? null : (exit.exitReason ?? "no answer"),
		...exit,
	};
}

export interface Reading {
	readonly method: string;
	readonly metric: string;
	readonly mib: number | null;
}

// Each sampler's median over `count` readings, taken `everyMs` apart.
async function readMemory(
	pid: number,
	samplers: readonly Sampler[],
	count = 3,
	everyMs = 500,
): Promise<Reading[]> {
	const readings: Reading[] = [];
	for (const sampler of samplers) {
		const values: number[] = [];
		for (let i = 0; i < count; i++) {
			const mib = await sampler.sample(pid);
			if (mib !== null) values.push(mib);
			if (i < count - 1) await sleep(everyMs);
		}
		const mib = values.length === 0 ? null : percentile(values, 50);
		readings.push({ method: sampler.method, metric: sampler.metric, mib });
	}
	return readings;
}

export interface IdleRss extends PluginExit {
	readonly idleMs: number;
	readonly readings: readonly Reading[];
	// The machine's memory in use when the readings were taken: a resident reading can come out
	// smaller under memory pressure.
	readonly memoryUsedPercent: number | null;
	readonly failure: string | null;
}

// The plugin after boot and the first tools/list, left idle for idleMs.
export async function idleRss(
	spec: PluginSpec,
	pluginDir: string,
	samplers: readonly Sampler[],
	idleMs = 5_000,
): Promise<IdleRss> {
	const session = openSession(spawnProduction(spec, pluginDir, "budget-idle"));
	const discover = await session.ask("server/discover", {}, ASK_MS);
	const list = discover === null ? null : await session.ask("tools/list", {}, ASK_MS);
	const pid = session.child.pid;
	let readings: Reading[] = [];
	let memoryUsedPercent: number | null = null;
	if (list !== null && pid !== undefined) {
		await sleep(idleMs);
		readings = await readMemory(pid, samplers);
		memoryUsedPercent = round(100 * (1 - os.freemem() / os.totalmem()));
	}
	const exit = await stop(session);
	const failure = list === null ? (exit.exitReason ?? "no answer") : null;
	return { idleMs, readings, memoryUsedPercent, failure, ...exit };
}

export interface RoundTrip extends PluginExit {
	readonly bytes: number;
	readonly warmupMs: readonly number[];
	readonly runsMs: readonly number[];
	readonly failure: string | null;
}

// tools/call echo with a 1 MiB string and its 1 MiB answer, on a booted plugin: from writing the
// request to the parsed answer.
export async function roundTrip(
	spec: PluginSpec,
	pluginDir: string,
	runs: number = ROUND_TRIP_RUNS,
	warmups = 3,
): Promise<RoundTrip> {
	const session = openSession(spawnProduction(spec, pluginDir, "budget-echo"));
	const warmupMs: number[] = [];
	const runsMs: number[] = [];
	let failure: string | null = null;
	const discover = await session.ask("server/discover", {}, ASK_MS);
	if (discover === null) failure = "no answer";
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const data = Array.from({ length: ROUND_TRIP_BYTES }, (_, i) => alphabet[i % 36]).join("");
	for (let i = 0; failure === null && i < warmups + runs; i++) {
		const begun = performance.now();
		const frame = await session.ask("tools/call", { name: "echo", arguments: { data } }, ASK_MS);
		const ms = round(performance.now() - begun);
		if (firstText(frame) !== data) failure = "the echo didn't return the 1 MiB unchanged";
		else (i < warmups ? warmupMs : runsMs).push(ms);
	}
	const exit = await stop(session);
	return { bytes: ROUND_TRIP_BYTES, warmupMs, runsMs, failure, ...exit };
}

// Whether `node --v8-options` lists the flag: if V8 dropped or renamed it, the watchdog alone holds.
export function v8Lists(nodeBin: string, flag: string = WASM_FLAG): Promise<boolean> {
	return new Promise((resolve, reject) => {
		execFile(
			nodeBin,
			["--v8-options"],
			{ encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 16 << 20 },
			(error, stdout) =>
				error
					? reject(error)
					: resolve(stdout.split(/\r?\n/).some((l) => l.trim().startsWith(flag))),
		);
	});
}

// The production argv, or the production argv without --wasm-max-mem-pages=8192 (the control, and
// the only argv left if V8 dropped the flag).
export type MemoryArgv = "production" | "without-wasm-flag";

function spawnMemory(spec: PluginSpec, pluginDir: string, argv: MemoryArgv, id: string) {
	return argv === "production"
		? spawnProduction(spec, pluginDir, id)
		: spawnWithoutFlag(spec, pluginDir, `${WASM_FLAG}=${WASM_PAGES}`);
}

export interface Allocation {
	readonly argv: MemoryArgv;
	readonly outcome: string;
	readonly exitCode: number | null;
}

async function pythonAllocation(session: Session, mib: number): Promise<string> {
	await session.ask("server/discover", {}, 120_000);
	const frame = await session.ask("tools/call", { name: "py_alloc", arguments: { mib } }, 120_000);
	const outcome = structured(frame)?.outcome;
	return typeof outcome === "string" ? outcome : frame === null ? "no answer" : "error";
}

// Plan §15 S11 (g): a 1 GiB Python allocation, under the production argv (512 MiB wasm heap) and,
// as the control, without --wasm-max-mem-pages=8192.
export const ALLOCATION_MIB = 1_024;

export async function wasmCap(
	spec: PluginSpec,
	pluginDir: string,
	mib: number = ALLOCATION_MIB,
): Promise<Allocation[]> {
	const results: Allocation[] = [];
	for (const argv of ["production", "without-wasm-flag"] as const) {
		const session = openSession(spawnMemory(spec, pluginDir, argv, "budget-wasm"));
		const outcome = await pythonAllocation(session, mib);
		results.push({ argv, outcome, exitCode: await session.close() });
	}
	return results;
}

// What the watchdog has to stop: JS typed arrays, which no flag bounds, or the Python heap when
// --wasm-max-mem-pages isn't there to cap it.
export type Growth = "js-side" | "python-heap";

export interface WatchdogKill {
	readonly growth: Growth;
	readonly argv: MemoryArgv;
	readonly allocatedMiB: number;
	readonly limitMiB: number;
	readonly intervalMs: number;
	readonly method: string;
	readonly metric: string;
	readonly heldMiB: number | null;
	readonly killedByWatchdog: boolean;
	readonly killSignal: string | null;
	readonly samples: number;
	readonly peakMiB: number;
	readonly overshootMiB: number;
	readonly timeToKillMs: number | null;
}

// Plan §4 Health for python plugins: sample every intervalMs and SIGKILL above 1 GiB. The plugin
// allocates 1 GiB (plan §15 S11 (g)) and holds it, so its baseline carries it over the limit.
export async function watchdogKill(
	spec: PluginSpec,
	pluginDir: string,
	sampler: Sampler,
	growth: Growth,
	argv: MemoryArgv,
	mib: number = ALLOCATION_MIB,
	intervalMs = 5_000,
	limitMiB: number = PYTHON_RSS_LIMIT_MIB,
): Promise<WatchdogKill> {
	const child = spawnMemory(spec, pluginDir, argv, "budget-watchdog");
	const session = openSession(child);
	await session.ask("server/discover", {}, 120_000);
	const started = performance.now();
	let stopped = false;
	let peak = 0;
	let samples = 0;
	let killedAt: number | null = null;
	const watchdog = (async () => {
		while (!stopped) {
			await sleep(intervalMs);
			if (stopped || child.pid === undefined) return;
			const reading = await sampler.sample(child.pid);
			if (reading === null) continue;
			samples += 1;
			peak = Math.max(peak, reading);
			if (reading > limitMiB) {
				killedAt = performance.now();
				child.kill("SIGKILL");
				return;
			}
		}
	})();
	const call =
		growth === "js-side"
			? { name: "js_alloc", arguments: { mib, chunkMiB: 64 } }
			: { name: "py_alloc", arguments: { mib, hold: true } };
	const frame = await session.ask("tools/call", call, 120_000);
	const held = structured(frame)?.mib;
	const exited = await within(
		session.exit.then(() => true),
		intervalMs * 3 + 20_000,
		false,
	);
	stopped = true;
	await watchdog;
	if (!exited) await session.close(0);
	return {
		growth,
		argv,
		allocatedMiB: mib,
		limitMiB,
		intervalMs,
		method: sampler.method,
		metric: sampler.metric,
		heldMiB: typeof held === "number" ? held : null,
		killedByWatchdog: killedAt !== null,
		killSignal: child.signalCode,
		samples,
		peakMiB: peak,
		overshootMiB: Math.max(0, peak - limitMiB),
		timeToKillMs: killedAt === null ? null : Math.round(killedAt - started),
	};
}
