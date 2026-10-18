import fs from "node:fs";
import path from "node:path";
import {
	acquireBenchLock,
	benchTimeout,
	hostTarget,
	needDocker,
	nodeBinary,
	nodeVersions,
	runInDocker,
	stageForDocker,
} from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
	FAST_INTERVAL_MS,
	type KillOutcome,
	killSamplerFor,
	makeTree,
	measureRehash,
	measureSamplingCost,
	PLAN_INTERVAL_MS,
	type PluginDirs,
	type RehashCost,
	RSS_LIMIT_MIB,
	runUntouched,
	runWatchdogKill,
	type SamplingCost,
	samplersFor,
	spawnGrower,
	type UntouchedOutcome,
} from "./memory.ts";
import { evidenceFile, missing, recordEvidence, unmet } from "./record.ts";
import { bundleTemplatePlugin, selectedNodes, spikeDir, tempRoot } from "./s2b.ts";

const NODES = selectedNodes(nodeVersions());
const arch = hostTarget().arch;
const MIB = 1_048_576;
// Throttled growers for the kill at the fast interval; unthrottled ones for the plan's 5 s.
const FAST_MODES = ["arraybuffer", "wasm"];
const PLAN_MODES = ["arraybuffer-fast", "wasm-fast"];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function killFindings(kills: readonly KillOutcome[]) {
	const all = (modes: readonly string[], test: (kill: KillOutcome) => boolean): boolean =>
		NODES.every((node) =>
			modes.every((mode) => {
				const kill = kills.find((k) => k.node === node && k.mode === mode);
				return kill !== undefined && test(kill);
			}),
		);
	const every = [...FAST_MODES, ...PLAN_MODES];
	return {
		watchdogSigkillsAboveTheLimit: all(
			every,
			(k) => k.killedByWatchdog && k.peakMiB > RSS_LIMIT_MIB && k.killSignal === "SIGKILL",
		),
		arrayBufferAndWasmEscapeTheHeapCap: all(every, (k) => k.peakMiB > 256),
		planIntervalLetsGrowthPassTheLimit: all(
			PLAN_MODES,
			(k) => k.overshootMiB > 0 && (k.timeToKillMs ?? 0) >= PLAN_INTERVAL_MS,
		),
	};
}

// How far an unthrottled plugin gets between two samples at the plan's interval.
function killObservations(kills: readonly KillOutcome[]) {
	const plan = kills.filter((k) => k.intervalMs === PLAN_INTERVAL_MS);
	const rates = plan.flatMap((k) =>
		k.growerCeilingMiB !== null && k.growerCeilingMs
			? [(k.growerCeilingMiB * 1000) / k.growerCeilingMs]
			: [],
	);
	const fastest = Math.max(0, ...rates);
	return {
		planIntervalMaxOvershootMiB: Math.max(0, ...plan.map((k) => k.overshootMiB)),
		fastestGrowthMiBPerSecond: Math.round(fastest),
		projectedMiBPerPlanInterval: Math.round((fastest * PLAN_INTERVAL_MS) / 1000),
	};
}

// What an untouched 768 MiB allocation looks like to each sampler: on Windows it is committed but
// not in the working set, so only a private-bytes sampler sees it; on POSIX it isn't resident.
function untouchedProblem(platform: NodeJS.Platform, outcome: UntouchedOutcome): string | null {
	const reading = (method: string): number | null =>
		outcome.readings.find((r) => r.method === method)?.mib ?? null;
	if (outcome.allocatedMiB !== 768) return "the plugin did not allocate";
	if (platform === "win32") {
		const workingSet = reading("tasklist-csv");
		const privateBytes = reading("powershell-private-bytes");
		if (workingSet === null || workingSet >= RSS_LIMIT_MIB) return `working set ${workingSet} MiB`;
		if (privateBytes === null || privateBytes <= RSS_LIMIT_MIB)
			return `private ${privateBytes} MiB`;
		return null;
	}
	const resident = outcome.readings.map((r) => r.mib).filter((mib) => mib !== null);
	if (resident.length === 0) return "no sampler read the plugin";
	return resident.every((mib) => mib < RSS_LIMIT_MIB) ? null : "the untouched pages were resident";
}

interface Benchmarks {
	readonly lock: { readonly waitedMs: number; readonly idle: unknown };
	readonly samplingCost: readonly SamplingCost[];
	readonly rehash: readonly RehashCost[];
}

function hostSuite(
	label: string,
	capTag: "windows" | "linux" | "macos",
	platform: NodeJS.Platform,
): void {
	describe(`RSS watchdog, sampler cost and re-hash (${label})`, () => {
		const bins: Record<string, string> = {};
		let root = "";
		let pluginDir = "";
		let dirs = 0;
		const kills: KillOutcome[] = [];
		const untouched = new Map<string, UntouchedOutcome>();
		let benchmarks: Benchmarks | undefined;

		beforeAll(async () => {
			if (process.platform !== platform) return;
			for (const v of NODES) bins[v] = await nodeBinary(v, hostTarget());
			root = tempRoot(`dy-s02-measure-${label}-`);
			pluginDir = path.join(root, "plugin");
			fs.cpSync(path.join(spikeDir, "fixtures", "s2b"), pluginDir, { recursive: true });
		}, 180_000);

		afterAll(async () => {
			if (root) fs.rmSync(root, { recursive: true, force: true });
			if (process.platform !== platform) return;
			const findings = {
				...killFindings(kills),
				untouchedAllocationJudged: NODES.every((v) => {
					const outcome = untouched.get(v);
					return outcome !== undefined && untouchedProblem(platform, outcome) === null;
				}),
				killSamplerCostMeasured:
					benchmarks?.samplingCost.find((c) => c.method === killSamplerFor(platform).method)
						?.available === true,
			};
			await recordEvidence(
				evidenceFile("measure", `${platform}-${arch}`),
				[...missing("untouched", NODES, untouched), ...unmet(findings)],
				{
					target: `${platform}-${arch}`,
					nodes: NODES,
					rssLimitMiB: RSS_LIMIT_MIB,
					intervals: { fastMs: FAST_INTERVAL_MS, planMs: PLAN_INTERVAL_MS },
					killSampler: killSamplerFor(platform).method,
					kills,
					observations: killObservations(kills),
					untouched: [...untouched.values()],
					benchmarks: benchmarks ?? null,
					findings,
				},
			);
		});

		const t = (): { tags: string[] } => ({ tags: [`requires:${capTag}`] });
		const at = (v: string): PluginDirs => {
			const dataDir = path.join(root, `data-${dirs++}`);
			fs.mkdirSync(dataDir, { recursive: true });
			return { nodeBin: bins[v] as string, pluginDir, dataDir };
		};

		it("SIGKILLs ArrayBuffer and WebAssembly.Memory growth above 512 MiB", t(), async () => {
			const sampler = killSamplerFor(platform);
			try {
				for (const v of NODES) {
					for (const mode of FAST_MODES) {
						const kill = await runWatchdogKill(at(v), v, mode, sampler, FAST_INTERVAL_MS);
						kills.push(kill);
						expect(kill.killedByWatchdog, `${v} ${mode}: the watchdog fired`).toBe(true);
						expect(kill.peakMiB, `${v} ${mode}: RSS passed the limit`).toBeGreaterThan(
							RSS_LIMIT_MIB,
						);
						expect(kill.killSignal, `${v} ${mode}`).toBe("SIGKILL");
					}
				}
			} finally {
				sampler.close();
			}
		});

		it("at the plan's 5 s interval an unthrottled grower passes the limit first", t(), async () => {
			const sampler = killSamplerFor(platform);
			try {
				for (const v of NODES) {
					for (const mode of PLAN_MODES) {
						const kill = await runWatchdogKill(at(v), v, mode, sampler, PLAN_INTERVAL_MS);
						kills.push(kill);
						expect(kill.killedByWatchdog, `${v} ${mode}: the watchdog fired`).toBe(true);
						expect(kill.overshootMiB, `${v} ${mode}: overshoot recorded`).toBeGreaterThan(0);
						expect(kill.timeToKillMs ?? 0).toBeGreaterThanOrEqual(PLAN_INTERVAL_MS);
					}
				}
			} finally {
				sampler.close();
			}
		});

		it("records what each sampler sees of an untouched 768 MiB allocation", t(), async () => {
			const samplers = samplersFor(platform);
			try {
				for (const v of NODES) {
					const outcome = await runUntouched(at(v), v, samplers);
					untouched.set(v, outcome);
					expect(untouchedProblem(platform, outcome), v).toBeNull();
				}
			} finally {
				for (const sampler of samplers) sampler.close();
			}
		});

		it("benchmarks the sampler cost and the per-spawn re-hash under the bench lock", {
			...t(),
			timeout: benchTimeout(120_000),
		}, async (ctx: TestContext) => {
			using lock = await acquireBenchLock({ label: "s2b-measure", signal: ctx.signal });
			const samplers = samplersFor(platform);
			const idle = spawnGrower(at(NODES.at(-1) as string), "idle");
			idle.stdout?.resume();
			idle.stderr?.resume();
			try {
				await sleep(500);
				const samplingCost: SamplingCost[] = [];
				for (const sampler of samplers) {
					samplingCost.push(await measureSamplingCost(sampler, idle.pid ?? -1));
				}
				const bundle = bundleTemplatePlugin(path.join(root, "rehash-bundle")).dir;
				const rehash = [
					measureRehash("synthetic-2MiB", makeTree(path.join(root, "tree-2"), 2 * MIB)),
					measureRehash("synthetic-16MiB", makeTree(path.join(root, "tree-16"), 16 * MIB)),
					measureRehash("template-bundle", bundle),
				];
				benchmarks = { lock: { waitedMs: lock.waitedMs, idle: lock.idle }, samplingCost, rehash };
				const killCost = samplingCost.find((c) => c.method === killSamplerFor(platform).method);
				expect(killCost?.available, "the kill sampler read the plugin").toBe(true);
			} finally {
				idle.kill("SIGKILL");
				for (const sampler of samplers) sampler.close();
			}
		});
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");

// The same watchdog in Linux Docker with /proc sampling (both Nodes), and the Linux samplers' cost.
describe("Linux Docker RSS watchdog and sampler cost", () => {
	const images = path.resolve(spikeDir, "..", "..", "tools", "fetch-node", "images.json");
	let image = "";
	let memoryRun: { kills: KillOutcome[]; untouched: UntouchedOutcome[] } | undefined;
	let cost: { lock: Benchmarks["lock"]; samplingCost: SamplingCost[] } | undefined;

	afterAll(async () => {
		if (memoryRun === undefined && cost === undefined) return;
		const kills = memoryRun?.kills ?? [];
		const findings = {
			...killFindings(kills),
			untouchedIsNotResident: NODES.every((v) => {
				const outcome = memoryRun?.untouched.find((u) => u.node === v);
				return outcome !== undefined && untouchedProblem("linux", outcome) === null;
			}),
			killSamplerCostMeasured:
				cost?.samplingCost.find((c) => c.method === killSamplerFor("linux").method)?.available ===
				true,
		};
		const target = `docker-linux-${arch}`;
		await recordEvidence(evidenceFile("measure", target), unmet(findings), {
			target,
			nodes: NODES,
			image,
			native: false,
			rssLimitMiB: RSS_LIMIT_MIB,
			intervals: { fastMs: FAST_INTERVAL_MS, planMs: PLAN_INTERVAL_MS },
			killSampler: killSamplerFor("linux").method,
			kills,
			observations: killObservations(kills),
			untouched: memoryRun?.untouched ?? [],
			samplerCost: cost ?? null,
			findings,
		});
	});

	async function runner<T>(
		ctx: TestContext,
		mode: string,
		labels: readonly string[],
	): Promise<T[]> {
		image = JSON.parse(fs.readFileSync(images, "utf8")).glibc;
		const bins: string[] = [];
		for (const v of labels) bins.push(await nodeBinary(v, { platform: "linux", arch }));
		using stage = stageForDocker({
			name: "s02-s2b-measure",
			from: spikeDir,
			files: ["src", "fixtures/s2b", "test/s2b.ts", "test/memory.ts", "test/docker-runner-s2b.ts"],
		});
		const nodes = labels.map((label, i) => ({ bin: `/opt/n${i}`, label }));
		const result = await runInDocker({
			image,
			network: "none",
			mounts: [
				{ source: stage.dir, target: "/stage" },
				...bins.map((bin, i) => ({ source: bin, target: `/opt/n${i}` })),
			],
			cmd: [
				nodes.at(-1)?.bin as string,
				"/stage/test/docker-runner-s2b.ts",
				mode,
				JSON.stringify({ nodes, workRoot: "/tmp/dywork" }),
			],
			signal: ctx.signal,
			timeoutMs: 240_000,
		});
		expect(result.code, `runner exit ${result.code}; stderr: ${result.stderr.slice(-800)}`).toBe(0);
		const line = result.stdout.split(/\r?\n/).findLast((l) => l.startsWith("##DYS2BMATRIX##"));
		expect(line, `no matrix line; stdout tail: ${result.stdout.slice(-400)}`).toBeDefined();
		return (JSON.parse((line as string).slice("##DYS2BMATRIX##".length)) as { nodes: T[] }).nodes;
	}

	it("SIGKILLs growth at both intervals and reads an untouched allocation in Linux", {
		tags: ["requires:docker"],
		timeout: 280_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const nodes = await runner<{ kills: KillOutcome[]; untouched: UntouchedOutcome }>(
			ctx,
			"memory",
			NODES,
		);
		memoryRun = { kills: nodes.flatMap((n) => n.kills), untouched: nodes.map((n) => n.untouched) };
		for (const kill of memoryRun.kills) {
			const label = `${kill.node} ${kill.mode} @${kill.intervalMs} ms`;
			expect(kill.killedByWatchdog, label).toBe(true);
			expect(kill.peakMiB, label).toBeGreaterThan(RSS_LIMIT_MIB);
			expect(kill.killSignal, label).toBe("SIGKILL");
		}
		for (const outcome of memoryRun.untouched) {
			expect(untouchedProblem("linux", outcome), outcome.node).toBeNull();
		}
	});

	it("benchmarks the Linux samplers under the bench lock", {
		tags: ["requires:docker"],
		timeout: benchTimeout(60_000),
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		using lock = await acquireBenchLock({ label: "s2b-measure-docker", signal: ctx.signal });
		const [node] = await runner<{ costs: SamplingCost[] }>(ctx, "sampler-cost", [
			NODES.at(-1) as string,
		]);
		cost = { lock: { waitedMs: lock.waitedMs, idle: lock.idle }, samplingCost: node?.costs ?? [] };
		const killCost = cost.samplingCost.find((c) => c.method === killSamplerFor("linux").method);
		expect(killCost?.available, "VmRSS read the plugin").toBe(true);
	});
});
