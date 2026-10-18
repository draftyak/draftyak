import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type Fingerprint,
	fingerprint,
	hostTarget,
	needDocker,
	nodeBinary,
	nodeVersions,
	runInDocker,
	stageForDocker,
	writeEvidence,
} from "@draftyak/spike-kit";
import { buildExecArgv } from "@draftyak/spike-s02-plugin-sandbox/src/argv.ts";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import {
	fetchRuntime,
	installedDir,
	type RuntimeLock,
	spikeDir,
} from "../scripts/fetch-runtime.ts";
import { SHIM } from "../src/runtime.ts";
import { buildBundle } from "./bundle.ts";
import {
	BROKER_BODY,
	type CaseResult,
	type CaseSpec,
	FREEZE,
	type RefusalResult,
	runCase,
	runRefusal,
	VARIANTS,
	type Variant,
} from "./session.ts";

// spikes-run's DRAFTYAK_NODES (M0.8): both (also when unset), minimum or bundled.
function selectedNodes(env: NodeJS.ProcessEnv = process.env): string[] {
	const { minimum, bundled } = nodeVersions();
	const value = env.DRAFTYAK_NODES || "both";
	if (value === "both") return [...new Set([minimum, bundled])];
	if (value === "minimum") return [minimum];
	if (value === "bundled") return [bundled];
	throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
}

// As S1 does: DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs record.
function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value))
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	return value === "1" || (value === "" && !!env.CI);
}

const NODES = selectedNodes();
const { arch } = hostTarget();
const glibcImage = (
	JSON.parse(
		fs.readFileSync(path.join(spikeDir, "..", "..", "tools", "fetch-node", "images.json"), "utf8"),
	) as { glibc: string }
).glibc;
const fixture = path.join(spikeDir, "fixtures", "py-hello");
const REQUIRES = ["requests", "typing-extensions"];
// M0.11's argv for a python plugin, with placeholders: every case spawns exactly this plus its
// variant's flags, so the cases follow the shared argv when M0.12 changes it.
const [pluginStandIn, runtimeStandIn] = [path.resolve("/s11-plugin"), path.resolve("/s11-runtime")];
const SHARED = buildExecArgv({
	runtime: "python",
	pluginDir: pluginStandIn,
	runtimeDir: runtimeStandIn,
}).map((arg) => arg.replace(pluginStandIn, "<pluginDir>").replace(runtimeStandIn, "<runtimeDir>"));
// Python's `js` module: plan §4's curated jsglobals plus AbortSignal and Object, which pyfetch,
// urllib3 and requests import.
const JS_GLOBALS = [
	"AbortController",
	"AbortSignal",
	"Headers",
	"Object",
	"Request",
	"Response",
	"TextDecoder",
	"TextEncoder",
	"URL",
	"clearInterval",
	"clearTimeout",
	"console",
	"fetch",
	"setInterval",
	"setTimeout",
];
// os.environ: Emscripten's and Pyodide's defaults with a fixed LANG; no host variable or path.
const ENVIRON = {
	HOME: "/home/pyodide",
	LANG: "C.UTF-8",
	LD_LIBRARY_PATH: "/usr/lib:/lib/python3.14/site-packages",
	LOGNAME: "web_user",
	PATH: "/",
	PWD: "/",
	PYTHONINSPECT: "1",
	USER: "web_user",
	_: "./this.program",
};
// pyfetch, urllib3 and requests, all through js.fetch and the broker stub.
const HTTP = {
	pyfetch: { status: 200, body: BROKER_BODY },
	pyfetchBinary: { status: 200, same: true },
	pyfetchEmpty: { status: 204, bodyLength: 0 },
	pyfetchEcho: { status: 200, same: true },
	urllib3: { status: 200, body: BROKER_BODY },
	requests: { status: 200, body: BROKER_BODY },
};
const BROKER_REQUESTS = [
	"GET /status",
	"GET /status",
	"GET /binary",
	"GET /empty",
	"POST /echo",
	"GET /status",
	"GET /status",
];
// The production flags plus the runtime-dir grant and the wasm heap cap (plan §4 Flags).
const PRODUCTION = [
	"--permission",
	"--allow-fs-read=<pluginDir>",
	"--allow-fs-read=<runtimeDir>",
	"--no-experimental-sqlite",
	"--disable-sigusr1",
	"--disallow-code-generation-from-strings",
	"--max-old-space-size=256",
	"--wasm-max-mem-pages=8192",
];

interface Prepared {
	readonly lock: RuntimeLock;
	readonly pyodideDir: string;
	readonly wsDir: string;
	readonly work: string;
}

// The runtime and the shim bundle checked against runtime.lock.json, its wheels cached, and under a
// fresh temp dir the bundle file, the py-hello bundle and a control bundle (the same files and
// boot-control.mjs).
async function prepare(): Promise<Prepared> {
	const { lock, pyodideDir, wsDir, shim, wheels } = await fetchRuntime();
	const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11-")));
	fs.writeFileSync(path.join(work, SHIM), shim);
	const spec = { fixtureDir: fixture, lock, wheelsDir: wheels, requires: REQUIRES };
	buildBundle({ ...spec, target: path.join(work, "plugin") });
	buildBundle({ ...spec, target: path.join(work, "control"), extras: ["../boot-control.mjs"] });
	return { lock, pyodideDir, wsDir, work };
}

function expectCase(result: CaseResult): void {
	const label = `Node ${result.node}, ${result.variant}`;
	const { controls, session } = result;
	expect(controls, `${label}: (a) control`).toEqual([
		expect.objectContaining({
			mode: "none",
			outcome: "failed",
			code: "ERR_ACCESS_DENIED",
			binding: true,
		}),
		expect.objectContaining({ mode: "stub", outcome: "booted", python: "3.14.2" }),
	]);
	expect(session.bootFailure, `${label}: ${session.stderrTail}`).toBeNull();
	const flags = result.argv.filter((arg) => arg.startsWith("--"));
	const withoutFreeze = (list: readonly string[]) => list.filter((flag) => flag !== FREEZE);
	expect(withoutFreeze(flags), `${label}: the shared argv`).toEqual(withoutFreeze(SHARED));
	expect(flags[0], label).toBe("--permission");
	expect(flags, `${label}: production flags`).toEqual(expect.arrayContaining(PRODUCTION));
	expect(
		flags.filter((flag) => /^--allow-(?!fs-read=)/.test(flag)),
		label,
	).toEqual([]);
	const freeze = result.variant === "freeze" || SHARED.includes(FREEZE);
	expect(flags.includes(FREEZE), `${label}: ${FREEZE}`).toBe(freeze);
	expect(session.ready, label).toMatchObject({
		pyodide: "314.0.7",
		python: "3.14.2",
		jspi: "function",
		packages: [
			"certifi",
			"charset-normalizer",
			"idna",
			"py-hello",
			"requests",
			"typing-extensions",
			"urllib3",
		],
		grantsDropped: 2,
		readAfterDrop: false,
	});
	expect(session.wireProblems, `${label}: 2026-07-28 frames`).toEqual([]);
	expect(session.supportedVersions, label).toEqual(["2026-07-28"]);
	expect(session.tools, `${label}: tools/list`).toEqual([
		"hello",
		"fetch_status",
		"http_clients",
		"runtime_info",
	]);
	expect(session.hello, label).toBe("Hello, S11!");
	const fetched = { status: 200, bodyLength: BROKER_BODY.length, canRunSync: true };
	expect(session.fetch, `${label}: (d) run_sync(ctx.fetch(...))`).toEqual(fetched);
	expect(session.http, `${label}: pyfetch, urllib3 and requests`).toEqual(HTTP);
	expect(session.brokerRequests, label).toEqual(BROKER_REQUESTS);
	expect(session.info, label).toMatchObject({
		inputRaises: "OSError",
		canRunSync: true,
		hostApi: 1,
		jsGlobals: JS_GLOBALS,
		environ: ENVIRON,
		executable: "/home/pyodide/this.program",
		readAtImport: "denied",
		readAtCall: "denied",
	});
	expect(session.hostPathsInPython, `${label}: host paths in os.environ`).toBe(false);
	expect(session.legacyCode, `${label}: a 2025 initialize`).toBe(-32022);
	expect(session.printLogged, `${label}: print() reaches host/log`).toBe(true);
	expect(session.stdoutFramesOnly, `${label}: fd 1 holds frames only`).toBe(true);
	expect(session.exitCode, label).toBe(0);
}

const passes = (check: () => void): boolean => {
	try {
		check();
		return true;
	} catch {
		return false;
	}
};

type Recorded = CaseResult & { readonly passed: boolean };

// Content-free: flags with placeholders, outcomes, codes, names, timings and booleans.
function evidenceData(target: string, results: readonly Recorded[], runtime: object) {
	return {
		target,
		runtime,
		nodes: NODES,
		variants: VARIANTS.map((variant) => variant.name),
		argv: results.find((result) => result.variant === "base")?.argv ?? [],
		cases: results.map(({ node, variant, controls, session, passed }) => ({
			node,
			variant,
			passed,
			controls: controls.map(({ mode, outcome, code, binding }) => ({
				mode,
				outcome,
				code,
				binding,
			})),
			ready: session.ready,
			bootFailure: session.bootFailure,
			discoverMs: session.discoverMs,
			firstToolsListMs: session.firstToolsListMs,
			supportedVersions: session.supportedVersions,
			wireProblems: session.wireProblems,
			tools: session.tools,
			runSyncFetch: session.fetch,
			httpClients: session.http,
			brokerRequests: session.brokerRequests,
			python: {
				...Object.fromEntries(
					["python", "platform", "canRunSync", "inputRaises", "hostApi", "jsGlobals"].map((key) => [
						key,
						session.info?.[key] ?? null,
					]),
				),
				environKeys: Object.keys((session.info?.environ as object | undefined) ?? {}).toSorted(),
				readAtImport: session.info?.readAtImport ?? null,
				readAtCall: session.info?.readAtCall ?? null,
				hostPathsInPython: session.hostPathsInPython,
			},
			legacyCode: session.legacyCode,
			printLogged: session.printLogged,
			stdoutLines: session.stdoutLines,
			stdoutFramesOnly: session.stdoutFramesOnly,
			exitCode: session.exitCode,
		})),
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

// One fingerprint before any evidence is written: the host file lands before the Docker test
// runs, and the tree is clean only until then.
let print: Fingerprint | undefined;
beforeAll(async () => {
	if (recording()) print = await fingerprint({ cwd: spikeDir });
});

describe(`host boot (${process.platform}-${arch})`, () => {
	let prepared: Prepared | undefined;
	const bins = new Map<string, string>();
	const results: Recorded[] = [];
	const refusals: (RefusalResult & { node: string; passed: boolean })[] = [];

	beforeAll(async () => {
		prepared = await prepare();
		for (const node of NODES) bins.set(node, await nodeBinary(node));
	}, 900_000);

	const caseSpec = (node: string, variant: (typeof VARIANTS)[number]): CaseSpec => {
		const ready = prepared as Prepared;
		return {
			node,
			nodeBin: bins.get(node) as string,
			variant,
			sources: {
				pyodideDir: ready.pyodideDir,
				wsDir: ready.wsDir,
				shim: path.join(ready.work, SHIM),
			},
			files: ready.lock.files,
			abi: ready.lock.abi,
			pluginDir: path.join(ready.work, "plugin"),
			controlDir: path.join(ready.work, "control"),
			workRoot: ready.work,
		};
	};

	afterAll(async () => {
		if (prepared !== undefined) fs.rmSync(prepared.work, { recursive: true, force: true });
		if (!recording() || prepared === undefined) return;
		const planned = NODES.length * VARIANTS.length;
		if (results.length !== planned || refusals.length !== NODES.length * 2) {
			console.log(`evidence not recorded: ${results.length} of ${planned} cases ran`);
			return;
		}
		const target = `${process.platform}-${arch}`;
		const runtime = { ...pyodideRuntime(prepared.lock), kernelVersion: os.release() };
		const data = { ...evidenceData(target, results, runtime), refusals };
		const file = path.join(spikeDir, "evidence", `boot-${target}.json`);
		console.log(`evidence: ${await writeEvidence(file, data, { fingerprint: print })}`);
	});

	const REFUSED = {
		exitCode: 1,
		bootFailure: { step: "packages", code: "ERR_LOADER" },
		answered: false,
	};

	for (const node of NODES) {
		for (const variant of VARIANTS) {
			it(`(a), (d) and tools/list under the production flags (Node ${node}, ${variant.name})`, async (ctx) => {
				const result = await runCase(caseSpec(node, variant), ctx.signal);
				let passed = false;
				try {
					expectCase(result);
					passed = true;
				} finally {
					results.push({ ...result, passed });
				}
			});
		}
		it(`exits before serving when a lock wheel is missing or corrupt (Node ${node})`, async (ctx) => {
			const ran: RefusalResult[] = [];
			for (const damage of ["missing", "corrupt"] as const) {
				const refusal = await runRefusal(
					caseSpec(node, VARIANTS[0] as Variant),
					damage,
					ctx.signal,
				);
				const passed = passes(() => expect(refusal).toEqual({ damage, ...REFUSED }));
				refusals.push({ node, ...refusal, passed });
				ran.push(refusal);
			}
			for (const refusal of ran) {
				expect(refusal, `${refusal.damage} wheel`).toEqual({ damage: refusal.damage, ...REFUSED });
			}
		});
	}
});

describe("Linux Docker boot (glibc, --network none)", () => {
	it("(a), (d) and tools/list for the selected Nodes and both argv variants", {
		tags: ["requires:docker"],
		timeout: 290_000,
	}, async (ctx: TestContext) => {
		await needDocker(ctx);
		const ready = await prepare();
		const linux = { platform: "linux", arch } as const;
		const nodes: { bin: string; label: string }[] = [];
		const mounts: { source: string; target: string }[] = [];
		for (const [index, node] of NODES.entries()) {
			mounts.push({ source: await nodeBinary(node, linux), target: `/opt/n${index}` });
			nodes.push({ bin: `/opt/n${index}`, label: node });
		}
		const files = ["src", "test/session.ts", "test/docker-runner.mjs", "runtime.lock.json"];
		using spike = stageForDocker({
			name: "s11-boot",
			from: spikeDir,
			packages: ["pyodide", "ws"],
			files,
		});
		const s02 = installedDir("@draftyak/spike-s02-plugin-sandbox");
		using sandbox = stageForDocker({ name: "s11-s02", from: s02, files: ["package.json", "src"] });
		let staged: ReturnType<typeof stageForDocker>;
		try {
			staged = stageForDocker({
				name: "s11-bundle",
				from: ready.work,
				files: [SHIM, "plugin", "control"],
			});
		} finally {
			fs.rmSync(ready.work, { recursive: true, force: true });
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
				"/stage/test/docker-runner.mjs",
				JSON.stringify({ nodes }),
			],
			signal: ctx.signal,
			timeoutMs: 280_000,
		});
		const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith("##DYBOOT##"));
		expect(line, `exit ${result.code}; stderr: ${result.stderr.slice(-1_500)}`).toBeDefined();
		const parsed = JSON.parse((line as string).slice(10)) as {
			runtime: Record<string, string>;
			results: CaseResult[];
		};
		const recorded = parsed.results.map((item) => ({
			...item,
			passed: passes(() => expectCase(item)),
		}));
		if (recording() && recorded.length === NODES.length * VARIANTS.length) {
			const target = `docker-linux-${arch}`;
			const runtime = { ...pyodideRuntime(ready.lock), ...parsed.runtime, image: glibcImage };
			const file = path.join(spikeDir, "evidence", `boot-${target}.json`);
			const data = evidenceData(target, recorded, runtime);
			console.log(`evidence: ${await writeEvidence(file, data, { fingerprint: print })}`);
		}
		expect(parsed.results).toHaveLength(NODES.length * VARIANTS.length);
		for (const caseResult of parsed.results) expectCase(caseResult);
		expect(result.code).toBe(0);
	});
});
