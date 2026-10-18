// S11c allowlist (plan §15 S11 (c)): every candidate from local wheels, each in a fresh plugin under
// the production argv, on this host and in a Linux container (--network none), on the selected
// Nodes. pydantic-core and every wheel on ALLOWLIST, the runtime's list, must pass on each target;
// every failure must say why; a pass must exit cleanly when stopped, unless it is the known Node
// 26.5.1 abort on Windows. What passes, why the rest fail and how each plugin ended are recorded in
// allowlist-<platform>-<arch>.json and allowlist-docker-linux-<arch>.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Fingerprint,
	needDocker,
	nodeBinary,
	runInDocker,
	stageForDocker,
	writeEvidence,
} from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
	fetchRuntime,
	installedDir,
	type RuntimeLock,
	spikeDir,
} from "../scripts/fetch-runtime.ts";
import { copyRuntime, SHIM } from "../src/runtime.ts";
import {
	ALLOWLIST,
	allowlistOf,
	CANDIDATES,
	type CandidateRun,
	LADDER_SHIM,
	LADDER_SHIM_FIXES,
	NO_ANSWER,
	productionArgv,
	REQUIRED,
	runCandidate,
	uncleanExitsOf,
} from "./allowlist.ts";
import { buildBundle } from "./bundle.ts";
import { recordingFingerprint } from "./fingerprint.ts";
import { arch, nodeBin, recording, selectedNodes } from "./host.ts";

const NODES = selectedNodes();
const CONTROL = "allowlist-control.mjs";
// A target's nine candidates take about a minute; one that hangs costs about three minutes with its
// controls, which still leaves its evidence room to land.
const HOST_TIMEOUT_MS = 600_000;
const DOCKER_RUN_MS = 540_000;
const glibcImage = (
	JSON.parse(
		fs.readFileSync(path.join(spikeDir, "..", "..", "tools", "fetch-node", "images.json"), "utf8"),
	) as { glibc: string }
).glibc;

interface Prepared {
	readonly lock: RuntimeLock;
	readonly work: string;
	readonly runtimeDir: string;
}

// The shim bundle, a verified runtime copy, one bundle per candidate (the probe, the candidate's
// wheel closure from runtime.lock.json and ladder step 1's shim) and the unsandboxed control, in a
// fresh temp dir.
async function prepare(): Promise<Prepared> {
	const { lock, pyodideDir, wsDir, shim, wheels } = await fetchRuntime();
	const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11c-")));
	fs.writeFileSync(path.join(work, SHIM), shim);
	const runtimeDir = path.join(work, "runtime");
	copyRuntime(runtimeDir, lock.files, { pyodideDir, wsDir, shim: path.join(work, SHIM) });
	const fixtureDir = path.join(spikeDir, "fixtures", "py-allowlist");
	for (const candidate of CANDIDATES) {
		const target = path.join(work, `allow-${candidate}`);
		const extras = [`../${LADDER_SHIM}`];
		buildBundle({ fixtureDir, target, lock, wheelsDir: wheels, requires: [candidate], extras });
	}
	fs.copyFileSync(path.join(spikeDir, "fixtures", CONTROL), path.join(work, CONTROL));
	fs.mkdirSync(path.join(work, "data"));
	return { lock, work, runtimeDir };
}

// Content-free: names, booleans, exit codes, timings and reasons stripped of paths and values.
function evidenceData(target: string, platform: string, runtime: object, runs: CandidateRun[]) {
	const passing = allowlistOf(runs);
	return {
		target,
		runtime,
		nodes: NODES,
		argv: productionArgv(),
		candidates: CANDIDATES,
		required: REQUIRED,
		allowlist: ALLOWLIST,
		passing,
		notPassing: CANDIDATES.filter((candidate) => !passing.includes(candidate)),
		uncleanExits: uncleanExitsOf(runs, platform),
		runs,
	};
}

const pyodideRuntime = (lock: RuntimeLock) => ({
	pyodide: lock.pyodide,
	abi: lock.abi,
	python: lock.info.python,
	shimSha256: lock.files[SHIM] ?? null,
	wheels: Object.values(lock.wheels).map(({ name, version, sha256 }) => ({
		name,
		version,
		sha256,
	})),
});

// pydantic-core failing is an S11 FAIL (plan §15 S11 (c)); an allowlisted wheel failing on any target
// takes it off the allowlist. A candidate off the list may pass or fail; either way it is recorded,
// and a failure must say why. A pass must exit cleanly once stopped, the known abort aside.
function expectAllowlist(
	runs: readonly CandidateRun[],
	label: string,
	nodes: number,
	platform: string,
): void {
	expect(runs, `${label}: every candidate`).toHaveLength(CANDIDATES.length * nodes);
	const failed = runs.filter((run) => !run.runs);
	const failures = failed.map(
		(run) => `${run.candidate} (${run.node}) at ${run.failedAt}: ${run.reason}`,
	);
	const undiagnosed = failed.filter((run) => run.reason === null || run.reason === NO_ANSWER);
	expect(
		undiagnosed.map((run) => `${run.candidate} (${run.node}) at ${run.failedAt}`),
		`${label}: every failure says why; failures: ${failures.join("; ")}`,
	).toEqual([]);
	const passing = allowlistOf(runs);
	expect(passing, `${label}: ${REQUIRED} must pass; ${failures.join("; ")}`).toContain(REQUIRED);
	expect(
		ALLOWLIST.filter((candidate) => !passing.includes(candidate)),
		`${label}: every ALLOWLIST wheel passes; failures: ${failures.join("; ")}`,
	).toEqual([]);
	const unknownExits = uncleanExitsOf(runs, platform).filter((exit) => !exit.known);
	expect(
		unknownExits.map((exit) => `${exit.candidate} (${exit.node}): ${exit.exitReason}`),
		`${label}: a passing plugin exits cleanly when stopped`,
	).toEqual([]);
	for (const candidate of LADDER_SHIM_FIXES[platform] ?? []) {
		for (const run of runs.filter((item) => item.candidate === candidate)) {
			const fixed = run.runs || run.withLadderShim?.runs === true;
			expect(fixed, `${label}: ${candidate} (${run.node}) runs with ladder step 1's shim`).toBe(
				true,
			);
		}
	}
}

// One fingerprint before any evidence is written: the host file lands before the Docker test runs.
let print: Fingerprint | undefined;
beforeAll(async () => {
	if (recording()) print = await recordingFingerprint();
});

function hostSuite(label: string, capTag: string, platform: NodeJS.Platform): void {
	describe(`S11c allowlist (${label})`, () => {
		let prepared: Prepared | undefined;
		const bins = new Map<string, string>();
		const runs: CandidateRun[] = [];

		beforeAll(async () => {
			if (process.platform !== platform) return;
			prepared = await prepare();
			for (const node of NODES) bins.set(node, await nodeBin(node));
		}, 900_000);

		afterAll(async () => {
			if (prepared === undefined) return;
			fs.rmSync(prepared.work, { recursive: true, force: true });
			if (!recording()) return;
			if (runs.length !== CANDIDATES.length * NODES.length) {
				console.log(`evidence not recorded: ${runs.length} candidate runs of the planned set`);
				return;
			}
			const target = `${platform}-${arch}`;
			const runtime = { ...pyodideRuntime(prepared.lock), kernelVersion: os.release() };
			const file = path.join(spikeDir, "evidence", `allowlist-${target}.json`);
			const data = evidenceData(target, platform, runtime, runs);
			console.log(`evidence: ${await writeEvidence(file, data, { fingerprint: print })}`);
		});

		for (const node of NODES) {
			it(`loads, imports and runs each candidate under the production argv (Node ${node})`, {
				tags: [`requires:${capTag}`],
				timeout: HOST_TIMEOUT_MS,
			}, async (ctx: TestContext) => {
				const p = prepared as Prepared;
				const spec = {
					nodeBin: bins.get(node) as string,
					runtimeDir: p.runtimeDir,
					files: p.lock.files,
					abi: p.lock.abi,
					dataDir: path.join(p.work, "data"),
					signal: ctx.signal,
				};
				const own: CandidateRun[] = [];
				for (const candidate of CANDIDATES) {
					const bundle = path.join(p.work, `allow-${candidate}`);
					const run = await runCandidate(spec, bundle, node, candidate, path.join(p.work, CONTROL));
					runs.push(run);
					own.push(run);
				}
				expectAllowlist(own, `${platform}-${arch}, Node ${node}`, 1, platform);
			});
		}
	});
}

hostSuite("windows", "windows", "win32");
hostSuite("linux", "linux", "linux");
hostSuite("macos", "macos", "darwin");

describe("S11c allowlist in Linux Docker (glibc, --network none)", () => {
	it("loads, imports and runs each candidate on every selected Node", {
		tags: ["requires:docker"],
		timeout: DOCKER_RUN_MS + 60_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const prepared = await prepare();
		const linux = { platform: "linux", arch } as const;
		const nodes: { bin: string; label: string }[] = [];
		const mounts: { source: string; target: string }[] = [];
		for (const [index, node] of NODES.entries()) {
			mounts.push({ source: await nodeBinary(node, linux), target: `/opt/n${index}` });
			nodes.push({ bin: `/opt/n${index}`, label: node });
		}
		using spike = stageForDocker({
			name: "s11c-stage",
			from: spikeDir,
			packages: ["pyodide", "ws"],
			files: [
				"src",
				"test/allowlist.ts",
				"test/rpc.ts",
				"test/channel.ts",
				"test/docker-runner-m035.mjs",
				"runtime.lock.json",
			],
		});
		using sandbox = stageForDocker({
			name: "s11c-s02",
			from: installedDir("@draftyak/spike-s02-plugin-sandbox"),
			files: ["package.json", "src"],
		});
		let staged: ReturnType<typeof stageForDocker>;
		try {
			const bundles = CANDIDATES.map((candidate) => `allow-${candidate}`);
			staged = stageForDocker({
				name: "s11c-bundle",
				from: prepared.work,
				files: [SHIM, CONTROL, ...bundles],
			});
		} finally {
			fs.rmSync(prepared.work, { recursive: true, force: true });
		}
		using bundles = staged;
		mounts.push(
			{ source: spike.dir, target: "/stage" },
			{ source: sandbox.dir, target: "/s02" },
			{ source: bundles.dir, target: "/bundle" },
		);
		const result = await runInDocker({
			image: glibcImage,
			network: "none",
			platform: `linux/${arch === "x64" ? "amd64" : "arm64"}`,
			mounts,
			cmd: [
				nodes.at(-1)?.bin as string,
				"/stage/test/docker-runner-m035.mjs",
				JSON.stringify({ nodes }),
			],
			signal: ctx.signal,
			timeoutMs: DOCKER_RUN_MS,
		});
		const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("##DYM035##"));
		expect(line, `exit ${result.code}; stderr: ${result.stderr.slice(-1_500)}`).toBeDefined();
		const parsed = JSON.parse((line as string).slice("##DYM035##".length)) as {
			runtime: Record<string, string>;
			runs: CandidateRun[];
		};
		if (recording() && parsed.runs.length === CANDIDATES.length * NODES.length) {
			const target = `docker-linux-${arch}`;
			const runtime = { ...pyodideRuntime(prepared.lock), ...parsed.runtime, image: glibcImage };
			const file = path.join(spikeDir, "evidence", `allowlist-${target}.json`);
			const data = evidenceData(target, "linux", runtime, parsed.runs);
			console.log(`evidence: ${await writeEvidence(file, data, { fingerprint: print })}`);
		}
		expectAllowlist(parsed.runs, `docker-linux-${arch}`, NODES.length, "linux");
		expect(result.code).toBe(0);
	});
});
