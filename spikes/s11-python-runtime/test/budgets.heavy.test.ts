// S11c budgets (plan §15 S11 (g)), host-native only, because budgets count on native targets: the
// dev box's Windows x64 here, macOS arm64 and Linux arm64 and x64 on spikes-run's runners. Under the
// kit's bench lock, after its idle check, on the selected Nodes: cold start to the first tools/list
// over 20 runs (p50 ≤1.5 s, p95 ≤3 s) and idle RSS (≤200 MiB) for py-hello and for plugins that
// import pydantic-core or numpy, and a 1 MiB tools/call round trip (p50 ≤50 ms). Between plugins the
// test samples the CPU for 1 s: a leg is unloaded when all its samples stayed under the kit's idle
// threshold. A row counts when its leg was unloaded, and a timing PASS counts anyway, because load
// only slows a plugin. The legs whose rows didn't count are measured once more after a fresh idle
// check, the first numbers kept as provisional; a row that still doesn't count is "not counted:
// machine-busy" and the test fails as machine-busy. A counted FAIL (more than 2× over), a row
// without a number, or a plugin that doesn't exit cleanly when stopped fails the test; a counted MISS
// is reported, and fails it under DRAFTYAK_STRICT_BUDGETS=1. CI's full job runs touched spikes' heavy
// suites side by side, so it skips the timing. Outside the lock: --wasm-max-mem-pages=8192 turns a 1 GiB Python allocation into
// MemoryError, and the RSS watchdog kills a plugin holding 1 GiB on the JS side, or in the Python
// heap without that flag. Writes budgets-<platform>-<arch>.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type BenchLock,
	benchTimeout,
	type Fingerprint,
	type IdleResult,
	MachineBusyError,
	sampleCpu,
	skipOrFail,
	strictSkips,
	waitForIdle,
	writeEvidence,
} from "@draftyak/spike-kit";
import {
	powershellSampler,
	procStatusSampler,
	psSampler,
	type Sampler,
	tasklistSampler,
} from "@draftyak/spike-s02-plugin-sandbox/test/memory.ts";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { fetchRuntime, type RuntimeLock, spikeDir } from "../scripts/fetch-runtime.ts";
import { copyRuntime, SHIM } from "../src/runtime.ts";
import { knownExitAbort, type PluginSpec, productionArgv } from "./allowlist.ts";
import {
	BUDGETS,
	type BudgetRow,
	COLD_START_RUNS,
	judge,
	type LockStatus,
	PYTHON_RSS_LIMIT_MIB,
	percentile,
	ROUND_TRIP_BYTES,
	ROUND_TRIP_RUNS,
	ROW_KIND,
	type RowVerdict,
	strictBudgets,
	unloaded,
	type Verdict,
	WASM_FLAG,
	WASM_PAGES,
} from "./budget-rules.ts";
import {
	ALLOCATION_MIB,
	type Allocation,
	type BusyReport,
	benchLock,
	busyReport,
	type ColdStart,
	coldStart,
	type IdleRss,
	idleRss,
	lockMessage,
	type MemoryArgv,
	type PluginExit,
	type RoundTrip,
	roundTrip,
	v8Lists,
	type WatchdogKill,
	wasmCap,
	watchdogKill,
} from "./budgets.ts";
import { buildBundle } from "./bundle.ts";
import { recordingFingerprint } from "./fingerprint.ts";
import { arch, nodeBin, recording, selectedNodes } from "./host.ts";

const NODES = selectedNodes();
// Measured work under the lock with both Nodes, about 7 minutes on the dev box, plus a second pass
// over the legs that didn't count, with room for a slower runner.
const TIMING_WORK_MS = 1_200_000;
// The idle check before that second pass.
const RETRY_IDLE_MS = 120_000;
// After a failed idle check, how long the provisional run waits for the lock alone.
const PROVISIONAL_LOCK_MS = 60_000;
// A bundle's series on a Node stops after this many cold starts without an answer.
const MAX_FAILED_STARTS = 2;
const SAMPLE_MS = 1_000;

// What the budgets run on. py-hello is M0.33's boot fixture (requests' closure and
// typing-extensions, all pure Python); the next two are py-budget with one C-extension wheel, which
// it imports when it loads: pydantic-core (required; the SDK's pydantic path) and numpy (the
// largest). py-budget alone serves the round trip and the memory cases.
const TIMED = [
	{ bundle: "py-hello", fixture: "py-hello", requires: ["requests", "typing-extensions"] },
	{ bundle: "pydantic-core", fixture: "py-budget", requires: ["pydantic-core"] },
	{ bundle: "numpy", fixture: "py-budget", requires: ["numpy"] },
] as const;
const ECHO = { bundle: "py-budget", fixture: "py-budget", requires: [] } as const;

interface Prepared {
	readonly lock: RuntimeLock;
	readonly work: string;
	readonly runtimeDir: string;
	readonly dirs: ReadonlyMap<string, string>;
	readonly wheels: ReadonlyMap<string, readonly string[]>;
}

async function prepare(): Promise<Prepared> {
	const { lock, pyodideDir, wsDir, shim, wheels } = await fetchRuntime();
	const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11g-")));
	fs.writeFileSync(path.join(work, SHIM), shim);
	const runtimeDir = path.join(work, "runtime");
	copyRuntime(runtimeDir, lock.files, { pyodideDir, wsDir, shim: path.join(work, SHIM) });
	const dirs = new Map<string, string>();
	const bundleWheels = new Map<string, readonly string[]>();
	for (const { bundle, fixture, requires } of [...TIMED, ECHO]) {
		const target = path.join(work, bundle);
		const fixtureDir = path.join(spikeDir, "fixtures", fixture);
		const built = buildBundle({ fixtureDir, target, lock, wheelsDir: wheels, requires }) as {
			packages: Record<string, unknown>;
		};
		dirs.set(bundle, target);
		bundleWheels.set(
			bundle,
			Object.keys(built.packages).filter((name) => name !== fixture),
		);
	}
	fs.mkdirSync(path.join(work, "data"));
	return { lock, work, runtimeDir, dirs, wheels: bundleWheels };
}

// Resident memory for the budget (Windows working set, Linux VmRSS, macOS rss); on Windows also
// private bytes, which the hub's watchdog reads there (ADR 0003) and the kills here use.
function idleSamplers(platform: NodeJS.Platform): Sampler[] {
	if (platform === "win32") return [tasklistSampler(), powershellSampler()];
	return [platform === "linux" ? procStatusSampler() : psSampler()];
}

function watchdogSampler(platform: NodeJS.Platform): Sampler {
	if (platform === "win32") return powershellSampler();
	return platform === "linux" ? procStatusSampler() : psSampler();
}

interface Row {
	readonly bundle: string;
	readonly node: string;
	readonly row: BudgetRow;
	readonly unit: "ms" | "MiB";
	readonly limit: number;
	readonly value: number | null;
	readonly verdict: RowVerdict;
	// For numbers that don't count: what they would give.
	readonly provisional: Verdict | null;
}

interface Timing {
	readonly coldStarts: ColdStart[];
	idle?: IdleRss;
	trip?: RoundTrip;
}

// The CPU samples (% of all cores) taken between plugins, by leg.
interface Load {
	readonly coldStart: number[];
	readonly idleRss: number[];
	readonly roundTrip: number[];
}
type Leg = keyof Load;
type Pass = "first" | "retry";

// The second pass over the legs whose rows didn't count: the plugins it re-measured, after which
// idle check (or why it didn't run), and its CPU samples. Its numbers replace the first pass's.
interface Retry {
	readonly idleBefore: IdleResult | null;
	readonly message: string | null;
	readonly legs: Readonly<Record<Leg, readonly string[]>>;
	readonly samples: Load;
}

interface Memory {
	readonly node: string;
	readonly wasmFlagListed: boolean;
	readonly cap: readonly Allocation[];
	readonly kills: readonly WatchdogKill[];
}

interface LockRecord {
	readonly status: LockStatus;
	readonly waitedMs: number | null;
	readonly idleBefore: IdleResult | null;
	readonly message: string | null;
	readonly busy: BusyReport | null;
}

interface UncleanExit {
	readonly what: string;
	readonly bundle: string;
	readonly node: string;
	readonly exitCode: number | null;
	readonly exitReason: string | null;
	readonly known: boolean;
}

const UNITS: Readonly<Record<BudgetRow, "ms" | "MiB">> = {
	coldStartP50Ms: "ms",
	coldStartP95Ms: "ms",
	idleRssMiB: "MiB",
	roundTripP50Ms: "ms",
};

const LEG: Readonly<Record<BudgetRow, Leg>> = {
	coldStartP50Ms: "coldStart",
	coldStartP95Ms: "coldStart",
	idleRssMiB: "idleRss",
	roundTripP50Ms: "roundTrip",
};

function values(timing: Timing | undefined): Record<BudgetRow, number | null> {
	const totals = (timing?.coldStarts ?? []).map((run) => run.totalMs);
	const answered = totals.filter((total): total is number => total !== null);
	const cold = answered.length === COLD_START_RUNS;
	const resident = timing?.idle?.readings.find((r) => r.metric !== "private-bytes")?.mib ?? null;
	const trips = timing?.trip?.runsMs ?? [];
	return {
		coldStartP50Ms: cold ? percentile(answered, 50) : null,
		coldStartP95Ms: cold ? percentile(answered, 95) : null,
		idleRssMiB: resident,
		roundTripP50Ms: trips.length === ROUND_TRIP_RUNS ? percentile(trips, 50) : null,
	};
}

// One fingerprint before any evidence is written, while the code is clean.
let print: Fingerprint | undefined;
beforeAll(async () => {
	if (recording()) print = await recordingFingerprint();
});

function hostSuite(label: string, capTag: string, platform: NodeJS.Platform): void {
	describe(`S11c budgets (${label})`, () => {
		let prepared: Prepared | undefined;
		const bins = new Map<string, string>();
		const timing = new Map<string, Timing>();
		const firstSpawn: (ColdStart & { bundle: string; node: string })[] = [];
		const load: Load = { coldStart: [], idleRss: [], roundTrip: [] };
		// The first pass's numbers for what the second pass re-measured, kept as provisional.
		const superseded = new Map<string, Timing>();
		const memory: Memory[] = [];
		let threshold = 20;
		let retry: Retry | null = null;
		const busyReports: Record<Pass, BusyReport | null> = { first: null, retry: null };
		let lockStatus: LockStatus = "failed";
		let lockRecord: LockRecord | null = null;
		// A timing run that stopped part way records nothing.
		let measured: "none" | "partial" | "complete" = "none";

		const specFor = (node: string, signal?: AbortSignal): PluginSpec => {
			const p = prepared as Prepared;
			return {
				nodeBin: bins.get(node) as string,
				runtimeDir: p.runtimeDir,
				files: p.lock.files,
				abi: p.lock.abi,
				dataDir: path.join(p.work, "data"),
				signal,
			};
		};
		const dirOf = (bundle: string): string => (prepared as Prepared).dirs.get(bundle) as string;
		const timingOf = (bundle: string, node: string): Timing => {
			const key = `${bundle} ${node}`;
			const own = timing.get(key) ?? { coldStarts: [] };
			timing.set(key, own);
			return own;
		};

		// A row's leg is the second pass's when that pass re-measured its plugin.
		const legSamples = (leg: Leg, bundle: string): number[] =>
			retry !== null && retry.message === null && retry.legs[leg].includes(bundle)
				? retry.samples[leg]
				: load[leg];

		const rows = (): Row[] =>
			NODES.flatMap((node) =>
				[...TIMED, ECHO].flatMap(({ bundle }) => {
					const measuredValues = values(timing.get(`${bundle} ${node}`));
					const own = (Object.keys(BUDGETS) as BudgetRow[]).filter(
						(row) => (row === "roundTripP50Ms") === (bundle === ECHO.bundle),
					);
					return own.map((row) => {
						const value = measuredValues[row];
						const limit = BUDGETS[row];
						const status = lockStatus;
						const leg = unloaded(legSamples(LEG[row], bundle), threshold);
						const judged = judge(value, limit, ROW_KIND[row], status, leg);
						return { bundle, node, row, unit: UNITS[row], limit, value, ...judged };
					});
				}),
			);

		const exits = (): UncleanExit[] => {
			const all: [string, string, string, PluginExit][] = [
				...firstSpawn.map((run): [string, string, string, PluginExit] => [
					"first spawn",
					run.bundle,
					run.node,
					run,
				]),
				...[...timing, ...superseded].flatMap(([key, own]) => {
					const [bundle = "", node = ""] = key.split(" ");
					const legs: [string, string, string, PluginExit][] = own.coldStarts.map((run) => [
						"cold start",
						bundle,
						node,
						run,
					]);
					if (own.idle) legs.push(["idle RSS", bundle, node, own.idle]);
					if (own.trip) legs.push(["round trip", bundle, node, own.trip]);
					return legs;
				}),
			];
			return all
				.filter(([, , , exit]) => !exit.cleanExit)
				.map(([what, bundle, node, { exitCode, exitReason }]) => ({
					what,
					bundle,
					node,
					exitCode,
					exitReason,
					known: knownExitAbort(platform, node, exitReason),
				}));
		};

		const failures = (): string[] =>
			[...timing].flatMap(([key, own]) => [
				...own.coldStarts.flatMap((run) =>
					run.failure ? [`${key} cold start: ${run.failure}`] : [],
				),
				...(own.idle?.failure ? [`${key} idle RSS: ${own.idle.failure}`] : []),
				...(own.trip?.failure ? [`${key} round trip: ${own.trip.failure}`] : []),
			]);

		const between = async (leg: number[], pass: Pass): Promise<void> => {
			const sample = await sampleCpu(SAMPLE_MS);
			leg.push(sample);
			if (sample >= threshold && busyReports[pass] === null) {
				busyReports[pass] = await busyReport([sample]);
			}
		};

		// 20 interleaved cold starts per plugin and Node, so a change in load reaches all alike, the
		// CPU sampled after each plugin, while none runs.
		const coldStartLeg = async (
			ctx: TestContext,
			bundles: readonly string[],
			samples: number[],
			pass: Pass,
		): Promise<void> => {
			for (let round = 0; round < COLD_START_RUNS; round++) {
				for (const bundle of bundles) {
					for (const node of NODES) {
						ctx.signal.throwIfAborted();
						const own = timingOf(bundle, node);
						const failed = own.coldStarts.filter((run) => run.totalMs === null).length;
						if (failed >= MAX_FAILED_STARTS) continue;
						own.coldStarts.push(await coldStart(specFor(node, ctx.signal), dirOf(bundle)));
						await between(samples, pass);
					}
				}
			}
		};

		const idleRssLeg = async (
			ctx: TestContext,
			bundles: readonly string[],
			samples: number[],
			pass: Pass,
		): Promise<void> => {
			// Created after the cold starts, so the PowerShell reader's start-up doesn't overlap them.
			const samplers = idleSamplers(platform);
			try {
				await between(samples, pass);
				for (const node of NODES) {
					for (const bundle of bundles) {
						ctx.signal.throwIfAborted();
						const spec = specFor(node, ctx.signal);
						timingOf(bundle, node).idle = await idleRss(spec, dirOf(bundle), samplers);
						await between(samples, pass);
					}
				}
			} finally {
				for (const sampler of samplers) sampler.close();
			}
		};

		const roundTripLeg = async (ctx: TestContext, samples: number[], pass: Pass): Promise<void> => {
			await between(samples, pass);
			for (const node of NODES) {
				ctx.signal.throwIfAborted();
				const spec = specFor(node, ctx.signal);
				timingOf(ECHO.bundle, node).trip = await roundTrip(spec, dirOf(ECHO.bundle));
				await between(samples, pass);
			}
		};

		// The first spawn after the copy of each plugin, measured apart, then every leg.
		const measure = async (ctx: TestContext): Promise<void> => {
			measured = "partial";
			const first = NODES[0] as string;
			for (const { bundle } of TIMED) {
				ctx.signal.throwIfAborted();
				const run = await coldStart(specFor(first, ctx.signal), dirOf(bundle));
				firstSpawn.push({ bundle, node: first, ...run });
				await between(load.coldStart, "first");
			}
			const all = TIMED.map(({ bundle }) => bundle);
			await coldStartLeg(ctx, all, load.coldStart, "first");
			await idleRssLeg(ctx, all, load.idleRss, "first");
			await roundTripLeg(ctx, load.roundTrip, "first");
			measured = "complete";
		};

		// Once, after a fresh idle check: the legs of the rows that didn't count, for those plugins.
		const remeasure = async (ctx: TestContext): Promise<void> => {
			const open = rows().filter((row) => row.verdict === "not counted: machine-busy");
			if (open.length === 0) return;
			const pick = (leg: Leg): string[] =>
				[...TIMED, ECHO]
					.map(({ bundle }) => bundle)
					.filter((bundle) => open.some((row) => LEG[row.row] === leg && row.bundle === bundle));
			const legs = {
				coldStart: pick("coldStart"),
				idleRss: pick("idleRss"),
				roundTrip: pick("roundTrip"),
			};
			const samples: Load = { coldStart: [], idleRss: [], roundTrip: [] };
			let idleBefore: IdleResult;
			try {
				idleBefore = await waitForIdle({ timeoutMs: RETRY_IDLE_MS, signal: ctx.signal });
			} catch (error) {
				if (!(error instanceof MachineBusyError)) throw error;
				retry = { idleBefore: null, message: lockMessage(error), legs, samples };
				return;
			}
			measured = "partial";
			for (const node of NODES) {
				for (const bundle of new Set([...legs.coldStart, ...legs.idleRss, ...legs.roundTrip])) {
					const own = timingOf(bundle, node);
					const kept: Timing = { coldStarts: [] };
					if (legs.coldStart.includes(bundle)) kept.coldStarts.push(...own.coldStarts.splice(0));
					if (legs.idleRss.includes(bundle)) [kept.idle, own.idle] = [own.idle, undefined];
					if (legs.roundTrip.includes(bundle)) [kept.trip, own.trip] = [own.trip, undefined];
					superseded.set(`${bundle} ${node}`, kept);
				}
			}
			retry = { idleBefore, message: null, legs, samples };
			if (legs.coldStart.length > 0) {
				await coldStartLeg(ctx, legs.coldStart, samples.coldStart, "retry");
			}
			if (legs.idleRss.length > 0) await idleRssLeg(ctx, legs.idleRss, samples.idleRss, "retry");
			if (legs.roundTrip.length > 0) await roundTripLeg(ctx, samples.roundTrip, "retry");
			measured = "complete";
		};

		beforeAll(async () => {
			if (process.platform !== platform) return;
			prepared = await prepare();
			for (const node of NODES) bins.set(node, await nodeBin(node));
		}, 900_000);

		afterAll(async () => {
			if (prepared === undefined) return;
			const p = prepared;
			fs.rmSync(p.work, { recursive: true, force: true });
			if (!recording()) return;
			if (lockRecord === null || measured === "partial") {
				const ran = `timing ${lockRecord?.status ?? "not run"} (${measured})`;
				console.log(`evidence not recorded: ${ran}, memory ${memory.length} Nodes`);
				return;
			}
			const target = `${platform}-${arch}`;
			const legsUnloaded = (samples: Load) => ({
				coldStart: unloaded(samples.coldStart, threshold),
				idleRss: unloaded(samples.idleRss, threshold),
				roundTrip: unloaded(samples.roundTrip, threshold),
			});
			const series = (pick: (run: ColdStart) => number | null) =>
				NODES.flatMap((node) =>
					TIMED.map(({ bundle }) => ({
						bundle,
						node,
						values: (timing.get(`${bundle} ${node}`)?.coldStarts ?? []).map(pick),
					})),
				);
			const data = {
				target,
				native: true,
				nodes: NODES,
				argv: productionArgv(),
				budgets: BUDGETS,
				runs: {
					coldStart: COLD_START_RUNS,
					roundTrip: ROUND_TRIP_RUNS,
					roundTripBytes: ROUND_TRIP_BYTES,
					cpuSampleMs: SAMPLE_MS,
				},
				bundles: [...TIMED, ECHO].map(({ bundle }) => ({
					bundle,
					wheels: p.wheels.get(bundle) ?? [],
				})),
				lock: lockRecord,
				load: {
					thresholdPercent: threshold,
					first: { unloaded: legsUnloaded(load), samples: load, busy: busyReports.first },
					retry:
						retry === null
							? null
							: { ...retry, unloaded: legsUnloaded(retry.samples), busy: busyReports.retry },
				},
				rows: rows(),
				exits: exits(),
				firstSpawn,
				coldStart: {
					totalMs: series((run) => run.totalMs),
					checksMs: series((run) => run.checksMs),
					discoverMs: series((run) => run.discoverMs),
					bootMs: series((run) => run.bootMs),
					exitCodes: series((run) => run.exitCode),
				},
				failures: failures(),
				superseded: [...superseded].map(([key, own]) => {
					const [bundle = "", node = ""] = key.split(" ");
					return {
						bundle,
						node,
						coldStartTotalMs: own.coldStarts.map((run) => run.totalMs),
						idleRss: own.idle?.readings ?? null,
						roundTripMs: own.trip?.runsMs ?? null,
					};
				}),
				idleRss: NODES.flatMap((node) =>
					TIMED.map(({ bundle }) => ({
						bundle,
						node,
						...(timing.get(`${bundle} ${node}`)?.idle ?? {}),
					})),
				),
				roundTrip: NODES.map((node) => ({
					bundle: ECHO.bundle,
					node,
					...(timing.get(`${ECHO.bundle} ${node}`)?.trip ?? {}),
				})),
				memory: {
					wasmFlag: `${WASM_FLAG}=${WASM_PAGES}`,
					allocationMiB: ALLOCATION_MIB,
					rssLimitMiB: PYTHON_RSS_LIMIT_MIB,
					complete: memory.length === NODES.length,
					nodes: memory,
				},
			};
			const file = path.join(spikeDir, "evidence", `budgets-${target}.json`);
			console.log(`evidence: ${await writeEvidence(file, data, { fingerprint: print })}`);
		});

		it("holds cold start, idle RSS and the 1 MiB round trip to the budgets", {
			tags: [`requires:${capTag}`],
			timeout: benchTimeout(TIMING_WORK_MS) + PROVISIONAL_LOCK_MS,
		}, async (ctx: TestContext) => {
			if (process.env.CI && !strictSkips()) {
				skipOrFail(ctx, "CI's full job shares its runner between spikes; spikes-run measures this");
			}
			const idleSamples: number[] = [];
			const sample = async (ms: number): Promise<number> => {
				const value = await sampleCpu(ms);
				idleSamples.push(value);
				return value;
			};
			let lock: BenchLock | null = null;
			let busyMessage: string | null = null;
			let report: BusyReport | null = null;
			try {
				lock = await benchLock(ctx.signal, { idle: { sample } });
			} catch (error) {
				if (!(error instanceof MachineBusyError)) {
					const message = lockMessage(error);
					lockRecord = { status: "failed", waitedMs: null, idleBefore: null, message, busy: null };
					throw error;
				}
				busyMessage = lockMessage(error);
				report = await busyReport(idleSamples);
				const lockOnly = { idle: false, timeoutMs: PROVISIONAL_LOCK_MS } as const;
				lock = await benchLock(ctx.signal, lockOnly).catch(() => null);
			}
			const held = busyMessage === null;
			lockStatus = held ? "held" : "machine-busy";
			threshold = lock?.idle?.thresholdPercent ?? threshold;
			try {
				if (lock !== null) await measure(ctx);
				if (lock !== null && held) await remeasure(ctx);
			} finally {
				lockRecord = {
					status: lockStatus,
					waitedMs: lock?.waitedMs ?? null,
					idleBefore: lock?.idle ?? null,
					message: busyMessage,
					busy: report,
				};
				lock?.release();
			}
			if (!held) {
				const kept = lock === null ? "no provisional run" : "the numbers are provisional";
				throw new MachineBusyError(`${busyMessage}; every budget row is not run (${kept})`);
			}
			const judged = rows();
			const line = (row: Row) =>
				`${row.bundle} ${row.node} ${row.row}: ${row.value} ${row.unit} against ${row.limit}`;
			const missing = judged.filter((row) => row.verdict === "not measured");
			expect
				.soft(
					missing.map(line),
					`a row without a number is a harness problem (rule 4(a)): ${failures().join("; ")}`,
				)
				.toEqual([]);
			const failed = judged.filter((row) => row.verdict === "FAIL");
			expect.soft(failed.map(line), "more than 2x over a budget, unloaded").toEqual([]);
			const unknown = exits().filter((exit) => !exit.known);
			expect
				.soft(
					unknown.map((exit) => `${exit.what} ${exit.bundle} ${exit.node}: ${exit.exitReason}`),
					"every budget plugin exits cleanly when stopped",
				)
				.toEqual([]);
			const missed = judged.filter((row) => row.verdict === "MISS");
			if (missed.length > 0) {
				const text = `budget MISS, up to 2x over on an unloaded run (ladder step 3): ${missed.map(line).join("; ")}`;
				console.warn(text);
				if (process.env.GITHUB_ACTIONS === "true")
					console.log(`::warning title=S11 budgets::${text}`);
				if (strictBudgets()) {
					expect.soft(missed.map(line), "DRAFTYAK_STRICT_BUDGETS=1 fails a MISS").toEqual([]);
				}
			}
			const open = judged.filter((row) => row.verdict === "not counted: machine-busy");
			if (open.length > 0) {
				const which = open.map((row) => `${line(row)} (${row.provisional})`).join(", ");
				const again = retry?.message ?? "in both passes";
				throw new MachineBusyError(
					`machine-busy: a CPU sample between plugins reached ${threshold}% (${again}); only provisional: ${which}`,
				);
			}
		});

		it("caps the Python heap at 512 MiB, and the watchdog kills a plugin holding 1 GiB", {
			tags: [`requires:${capTag}`],
			timeout: 600_000,
		}, async (ctx: TestContext) => {
			const budget = dirOf(ECHO.bundle);
			const sampler = watchdogSampler(platform);
			try {
				for (const node of NODES) {
					const spec = specFor(node, ctx.signal);
					// If V8 dropped the flag, Node would refuse the production argv: the watchdog alone
					// then holds, so the JS side is measured without the flag too.
					const wasmFlagListed = await v8Lists(spec.nodeBin);
					const cap = wasmFlagListed ? await wasmCap(spec, budget) : [];
					const jsArgv: MemoryArgv = wasmFlagListed ? "production" : "without-wasm-flag";
					const kills = [
						await watchdogKill(spec, budget, sampler, "js-side", jsArgv),
						await watchdogKill(spec, budget, sampler, "python-heap", "without-wasm-flag"),
					];
					memory.push({ node, wasmFlagListed, cap, kills });
				}
			} finally {
				sampler.close();
			}
			for (const { node, wasmFlagListed, cap, kills } of memory) {
				if (wasmFlagListed) {
					expect(cap, `${node}: a 1 GiB Python allocation`).toEqual([
						expect.objectContaining({ argv: "production", outcome: "MemoryError" }),
						expect.objectContaining({ argv: "without-wasm-flag", outcome: "allocated" }),
					]);
				}
				for (const kill of kills) {
					const what = `${node} ${kill.growth} (${kill.argv})`;
					expect(kill.killedByWatchdog, `${what}: the watchdog fired`).toBe(true);
					expect(kill.peakMiB, `${what}: above the limit`).toBeGreaterThan(PYTHON_RSS_LIMIT_MIB);
					expect(kill.killSignal, what).toBe("SIGKILL");
				}
			}
		});
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");
