// S11c (plan §15 S11 (c)): each C-extension candidate from local wheels, in a fresh plugin under the
// production argv, which includes --disallow-code-generation-from-strings. A candidate passes on a
// target when its wheels load at boot, its native extension module imports and a small call returns
// the known answer. A failure gets diagnostic controls that only say why: the same spawn without the
// codegen flag (is the flag the cause?), the production spawn with ladder step 1's narrow shim
// preloaded (does a shim fix it?), and plain Node with no flags (does it fail in Pyodide anyway?).
// A pass whose plugin doesn't exit cleanly when stopped gets the plain-Node control and the same run
// with a pause before the stop. The allowlist never drops the flag (plan §4 Packages). Shared by the
// host suites and, staged, by docker-runner-m035.mjs, so it imports only node: built-ins, ../src,
// ./rpc.ts, ./channel.ts and M0.11's argv and spawn.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { buildExecArgv } from "@draftyak/spike-s02-plugin-sandbox/src/argv.ts";
import {
	PLUGIN_CHANNEL_ENV,
	PLUGIN_STDIO,
	scrubEnv,
} from "@draftyak/spike-s02-plugin-sandbox/src/spawn.ts";
import { checkBundle, spawnPythonPlugin } from "../src/launch.ts";
import { RuntimeRefusedError, SHIM, verifyRuntime } from "../src/runtime.ts";
import { exitReasonOf, openSession, reasonOf, structured, within } from "./rpc.ts";

// The backlog's candidates, by their names in Pyodide's lock.
export const CANDIDATES: readonly string[] = [
	"pydantic-core",
	"orjson",
	"regex",
	"pyyaml",
	"rpds-py",
	"msgspec",
	"lxml",
	"cryptography",
	"numpy",
];
// Plan §15 S11 (c): the allowlist must include it.
export const REQUIRED = "pydantic-core";
// The runtime's C-extension allowlist (ADR 0013): the candidates that pass under the production
// argv on every target and Node. Bundles are the same on every hub OS, so a wheel that fails on one
// stays off. cryptography 47.0.0 aborts at import on Windows (Pyodide's getuid syscall calls
// process.getuid, which Windows Node lacks) and passes on Linux; it joins when the shim fix lands.
export const ALLOWLIST: readonly string[] = [
	"pydantic-core",
	"orjson",
	"regex",
	"pyyaml",
	"rpds-py",
	"msgspec",
	"lxml",
	"numpy",
];
// Candidates that fail under the production argv on a platform and run with ladder step 1's shim.
// ADR 0013's getuid plan change rests on this, so the tests hold it.
export const LADDER_SHIM_FIXES: Readonly<Record<string, readonly string[]>> = {
	win32: ["cryptography"],
};
const CODEGEN_FLAG = "--disallow-code-generation-from-strings";
// Ladder step 1's narrow shim, which each candidate bundle holds beside its files.
export const LADDER_SHIM = "allowlist-shim.mjs";
// A probe's discover, import and call share this deadline (a boot takes about 1.5 s), and the
// plain-Node control gets as long, so a candidate that hangs costs bounded time and is recorded.
export const PROBE_MS = 30_000;
const STOP_GRACE_MS = 5_000;
// The reason of a plugin that neither answered nor said why.
export const NO_ANSWER = "no answer";
// The paused-stop control waits this long between the call's answer and the stop.
export const STOP_PAUSE_MS = 1_000;

// Node 26.5.1's libuv on Windows fails an assertion in uv_async_send on a closing handle when a
// plugin is stopped just after it ran code from some wheels (pyyaml, lxml): exit 0xC0000409, plain
// Node too, and not on 26.12.0 (ADR 0013). Any other unclean exit fails the tests.
export function knownExitAbort(platform: string, node: string, reason: string | null): boolean {
	return platform === "win32" && node === "26.5.1" && /UV_HANDLE_CLOSING/.test(reason ?? "");
}

export interface PluginSpec {
	readonly nodeBin: string;
	// A verified, link-free runtime copy, re-verified before every spawn as the hub does.
	readonly runtimeDir: string;
	readonly files: Readonly<Record<string, string>>;
	readonly abi: string;
	readonly dataDir: string;
	readonly signal?: AbortSignal;
}

export type Argv = "production" | "without-codegen-flag" | "with-ladder-shim";

export interface CandidateResult {
	readonly candidate: string;
	readonly node: string;
	readonly argv: Argv;
	readonly loads: boolean;
	readonly imports: boolean;
	readonly runs: boolean;
	readonly failedAt: "boot" | "import" | "call" | null;
	readonly reason: string | null;
	readonly packages: readonly string[];
	readonly moduleVersion: string | null;
	readonly cExtension: boolean | null;
	readonly bootMs: number | null;
	// How the plugin ended once the probe closed its stdin, the hub's stop.
	readonly exitCode: number | null;
	readonly cleanExit: boolean;
	readonly exitReason: string | null;
	// Between the call's answer and the stop.
	readonly pauseMs: number;
}

// Plain Node with neither --permission nor any production flag, loading Pyodide directly.
export interface UnsandboxedResult {
	readonly failedAt: "boot" | "import" | "call" | null;
	readonly reason: string | null;
	readonly exitCode: number | null;
	readonly exitReason: string | null;
}

export interface CandidateRun extends CandidateResult {
	// Only when the production run failed.
	readonly withoutCodegenFlag: CandidateResult | null;
	readonly withLadderShim: CandidateResult | null;
	// When the production run failed, or passed without a clean exit.
	readonly unsandboxed: UnsandboxedResult | null;
	// Only when the production run passed without a clean exit: the same run, paused before the stop.
	readonly pausedStop: CandidateResult | null;
}

export function spawnProduction(
	spec: PluginSpec,
	pluginDir: string,
	instanceId: string,
): ChildProcess {
	return spawnPythonPlugin({
		nodeBin: spec.nodeBin,
		runtimeDir: spec.runtimeDir,
		expected: spec.files,
		abi: spec.abi,
		pluginDir,
		dataDir: spec.dataDir,
		pluginId: path.basename(pluginDir),
		instanceId,
		signal: spec.signal,
	});
}

// A control spawn: the runtime and bundle checks, the scrubbed env, the fd-3 channel and the plugin
// dir as cwd, as spawnPythonPlugin does, with an exec argv that isn't the production one.
function spawnControl(spec: PluginSpec, pluginDir: string, execArgv: readonly string[]) {
	const finding = verifyRuntime(spec.runtimeDir, spec.files);
	if (finding !== null) throw new RuntimeRefusedError(finding);
	checkBundle(pluginDir, spec.abi);
	const ids = { pluginId: path.basename(pluginDir), instanceId: "control", dataDir: spec.dataDir };
	return spawn(spec.nodeBin, [...execArgv, path.join(spec.runtimeDir, SHIM), pluginDir], {
		env: { ...scrubEnv(ids), ...PLUGIN_CHANNEL_ENV },
		cwd: pluginDir,
		stdio: [...PLUGIN_STDIO],
		windowsHide: true,
		signal: spec.signal,
	});
}

const productionFlags = (spec: PluginSpec, pluginDir: string): string[] =>
	buildExecArgv({ runtime: "python", pluginDir, runtimeDir: spec.runtimeDir });

// The production exec argv with placeholders for the dirs, as the evidence records it.
export function productionArgv(): string[] {
	const [plugin, runtime] = [path.resolve("/s11-plugin"), path.resolve("/s11-runtime")];
	return buildExecArgv({ runtime: "python", pluginDir: plugin, runtimeDir: runtime }).map((arg) =>
		arg.replace(plugin, "<pluginDir>").replace(runtime, "<runtimeDir>"),
	);
}

// The production spawn less one flag.
export function spawnWithoutFlag(spec: PluginSpec, pluginDir: string, flag: string): ChildProcess {
	const flags = productionFlags(spec, pluginDir);
	if (!flags.includes(flag)) throw new Error(`the production argv has no ${flag}`);
	return spawnControl(
		spec,
		pluginDir,
		flags.filter((arg) => arg !== flag),
	);
}

// The production spawn with a module from the plugin dir preloaded (--import), before the shim.
export function spawnWithPreload(spec: PluginSpec, pluginDir: string, file: string): ChildProcess {
	const preload = pathToFileURL(path.join(pluginDir, file)).href;
	return spawnControl(spec, pluginDir, [...productionFlags(spec, pluginDir), "--import", preload]);
}

function spawnArgv(spec: PluginSpec, pluginDir: string, argv: Argv, candidate: string) {
	if (argv === "production") return spawnProduction(spec, pluginDir, `allowlist-${candidate}`);
	if (argv === "without-codegen-flag") return spawnWithoutFlag(spec, pluginDir, CODEGEN_FLAG);
	return spawnWithPreload(spec, pluginDir, LADDER_SHIM);
}

const canonical = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

async function probe(
	spec: PluginSpec,
	pluginDir: string,
	node: string,
	candidate: string,
	argv: Argv,
	pauseMs = 0,
): Promise<CandidateResult> {
	const session = openSession(spawnArgv(spec, pluginDir, argv, candidate));
	const deadline = performance.now() + PROBE_MS;
	const left = (): number => Math.max(1, deadline - performance.now());
	const call = async (name: string) =>
		structured(await session.ask("tools/call", { name, arguments: { candidate } }, left()));
	const discover = await session.ask("server/discover", {}, left());
	const imported = discover === null ? null : await call("import_candidate");
	const ran = imported?.imported === true ? await call("run_candidate") : null;
	if (pauseMs > 0) await sleep(pauseMs);
	const exitCode = await session.close(STOP_GRACE_MS);
	const ready = session.ready();
	const packages = ((ready?.packages as string[] | undefined) ?? []).map(canonical);
	const loads = ready !== null && packages.includes(canonical(candidate));
	const imports = loads && imported?.imported === true;
	const runs = imports && ran?.ran === true;
	const failedAt = !loads ? "boot" : !imports ? "import" : !runs ? "call" : null;
	const errors = session
		.logs()
		.filter((line) => line.level === "error" || line.level === "warn")
		.map((line) => line.message);
	const pythonError = [imported?.error, ran?.error].find((name) => typeof name === "string");
	const bootStep = session.bootFailure();
	const reason =
		failedAt === null
			? null
			: (reasonOf([session.stderr(), ...errors]) ??
				(typeof pythonError === "string" ? pythonError : null) ??
				(bootStep === null ? NO_ANSWER : `boot failed at ${String(bootStep.step)}`));
	return {
		candidate,
		node,
		argv,
		loads,
		imports,
		runs,
		failedAt,
		reason,
		packages: packages.toSorted(),
		moduleVersion: typeof imported?.moduleVersion === "string" ? imported.moduleVersion : null,
		cExtension: typeof ran?.cExtension === "boolean" ? ran.cExtension : null,
		bootMs: typeof ready?.bootMs === "number" ? ready.bootMs : null,
		exitCode,
		cleanExit: exitCode === 0,
		exitReason: exitReasonOf(exitCode, session.child.signalCode, session.stderr()),
		pauseMs,
	};
}

async function unsandboxed(
	spec: PluginSpec,
	pluginDir: string,
	candidate: string,
	controlScript: string,
): Promise<UnsandboxedResult> {
	const child = spawn(spec.nodeBin, [controlScript, spec.runtimeDir, pluginDir, candidate], {
		env: scrubEnv({ pluginId: "py-allowlist", instanceId: "unsandboxed", dataDir: spec.dataDir }),
		cwd: pluginDir,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		signal: spec.signal,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-8_000);
	});
	const closed = (once(child, "close") as Promise<[number | null]>).then(
		([code]) => code,
		() => null,
	);
	let exitCode = await within(closed, PROBE_MS, undefined);
	if (exitCode === undefined) {
		child.kill("SIGKILL");
		exitCode = await within(closed, 10_000, null);
	}
	const exitReason = exitReasonOf(exitCode, child.signalCode, stderr);
	const line = stdout.split(/\r?\n/).find((item) => item.startsWith("##DY##"));
	const data = line === undefined ? null : (JSON.parse(line.slice(6)) as Record<string, unknown>);
	if (data === null) {
		return { failedAt: "boot", reason: reasonOf([stderr]) ?? "no report", exitCode, exitReason };
	}
	const failedAt = (data.failedAt ?? null) as UnsandboxedResult["failedAt"];
	const output = Array.isArray(data.output) ? data.output.map(String) : [];
	const error = typeof data.error === "string" ? data.error : null;
	const reason = failedAt === null ? null : (reasonOf([...output, stderr]) ?? error);
	return { failedAt, reason, exitCode, exitReason };
}

const NO_CONTROLS = {
	withoutCodegenFlag: null,
	withLadderShim: null,
	unsandboxed: null,
	pausedStop: null,
} as const;

export async function runCandidate(
	spec: PluginSpec,
	pluginDir: string,
	node: string,
	candidate: string,
	controlScript: string,
): Promise<CandidateRun> {
	const result = await probe(spec, pluginDir, node, candidate, "production");
	if (result.runs && result.cleanExit) return { ...result, ...NO_CONTROLS };
	if (result.runs) {
		return {
			...result,
			...NO_CONTROLS,
			unsandboxed: await unsandboxed(spec, pluginDir, candidate, controlScript),
			pausedStop: await probe(spec, pluginDir, node, candidate, "production", STOP_PAUSE_MS),
		};
	}
	return {
		...result,
		...NO_CONTROLS,
		withoutCodegenFlag: await probe(spec, pluginDir, node, candidate, "without-codegen-flag"),
		withLadderShim: await probe(spec, pluginDir, node, candidate, "with-ladder-shim"),
		unsandboxed: await unsandboxed(spec, pluginDir, candidate, controlScript),
	};
}

// The candidates that loaded, imported and ran under the production argv in every given run.
export function allowlistOf(runs: readonly CandidateRun[]): string[] {
	return CANDIDATES.filter((candidate) => {
		const own = runs.filter((run) => run.candidate === candidate);
		return own.length > 0 && own.every((run) => run.argv === "production" && run.runs);
	});
}

export interface UncleanExit {
	readonly candidate: string;
	readonly node: string;
	readonly exitCode: number | null;
	readonly exitReason: string | null;
	readonly known: boolean;
}

// The passes whose plugin didn't exit cleanly when stopped, each marked known (knownExitAbort) or not.
export function uncleanExitsOf(runs: readonly CandidateRun[], platform: string): UncleanExit[] {
	return runs
		.filter((run) => run.runs && !run.cleanExit)
		.map(({ candidate, node, exitCode, exitReason }) => ({
			candidate,
			node,
			exitCode,
			exitReason,
			known: knownExitAbort(platform, node, exitReason),
		}));
}
