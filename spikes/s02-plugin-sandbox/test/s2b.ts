// Shared S2b logic: the production spawn of a fixture, the template-plugin bundle, the probes that
// drive a plugin directly, and the launcher for the stand-in hub (hub-probes.ts), which runs the
// host-channel probes in a process of its own so that a crash shows as that process dying. The host
// tests and docker-runner-s2b.ts both use it, so it imports only node: built-ins and the spike's src.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { buildArgv } from "../src/argv.ts";
import type { ViolationKind } from "../src/host-channel.ts";
import {
	execArgvFor,
	PLUGIN_CHANNEL_ENV,
	PLUGIN_STDIO,
	type SpawnPluginSpec,
	scrubEnv,
	spawnPlugin,
} from "../src/spawn.ts";

export const spikeDir: string = path.resolve(import.meta.dirname, "..");
export const fixturesDir: string = path.join(spikeDir, "fixtures");
export const HUB_PROBES_FILE: string = path.join(spikeDir, "test", "hub-probes.ts");

// The promise's value, or `fallback` after ms; the timer never outlives the race.
export async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

// spikes-run's DRAFTYAK_NODES: both (also when unset), minimum or bundled.
export function selectedNodes(
	versions: { readonly minimum: string; readonly bundled: string },
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const value = env.DRAFTYAK_NODES || "both";
	if (value === "both") return [...new Set([versions.minimum, versions.bundled])];
	if (value === "minimum" || value === "bundled") return [versions[value]];
	throw new Error(`DRAFTYAK_NODES is both, minimum or bundled, not "${value}"`);
}

// A plugin's ctx.fetch targets: the inspector and hub ports on loopback, three other spellings that
// reach loopback, and one ordinary destination. The broker stub contacts nothing.
export interface FetchTarget {
	readonly label: string;
	readonly url: string;
	readonly expect: string;
}
export const FETCH_TARGETS: readonly FetchTarget[] = [
	{ label: "loopback-9229", url: "http://127.0.0.1:9229/json/version", expect: "inspector-port" },
	{ label: "loopback-47613", url: "http://127.0.0.1:47613/", expect: "hub-port" },
	{ label: "loopback-47614", url: "http://127.0.0.1:47614/", expect: "hub-port" },
	{ label: "loopback-47615", url: "http://127.0.0.1:47615/", expect: "hub-port" },
	{
		label: "mapped-9229",
		url: "http://[::ffff:127.0.0.1]:9229/json/version",
		expect: "inspector-port",
	},
	{ label: "unspecified-47613", url: "http://0.0.0.0:47613/", expect: "hub-port" },
	{ label: "localhost-dot-9229", url: "http://localhost.:9229/", expect: "inspector-port" },
	{ label: "external-443", url: "https://example.com/robots.txt", expect: "allowed" },
];

// Node >= 26.11 gates adopting an inherited non-IPC fd as a socket behind --allow-net (plan §4).
export function gatesFdAdoption(nodeVersion: string): boolean {
	const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
	return major > 26 || (major === 26 && minor >= 11);
}

// The hostile host-channel modes (fixtures/s2b/hostile-channel.mjs) and the violation each must
// raise, or null where the attack can't reach the hub on that OS: a POSIX plugin can't adopt the IPC
// fd as a socket (EEXIST), and Windows refuses to pass a pipe handle (ENOTSUP).
export function fuzzModes(platform: NodeJS.Platform): string[] {
	const common = [
		"node-internal",
		"raw-garbage",
		"raw-malformed",
		"raw-socket",
		"oversize",
		"unterminated",
		"handle-send",
		"ignore-sigterm",
	];
	return platform === "win32" ? [...common, "xfer-frame", "bad-header"] : common;
}

export function expectedViolation(mode: string, platform: NodeJS.Platform): ViolationKind | null {
	const windows = platform === "win32";
	const table: Record<string, ViolationKind | null> = {
		"node-internal": "handle",
		"raw-garbage": windows ? "bad-frame" : "parse-error",
		"raw-malformed": "parse-error",
		"raw-socket": windows ? "parse-error" : null,
		oversize: "oversize",
		unterminated: "oversize",
		"handle-send": windows ? null : "handle",
		"ignore-sigterm": "internal-message",
		"xfer-frame": "handle",
		"bad-header": "bad-frame",
	};
	const expected = table[mode];
	if (expected === undefined) throw new Error(`unknown fuzz mode ${mode}`);
	return expected;
}

function packageRoot(entryResolver: NodeJS.Require, name: string): string {
	let start: string;
	try {
		start = entryResolver.resolve(name);
	} catch {
		start = entryResolver.resolve(`${name}/package.json`);
	}
	let dir = path.dirname(start);
	for (;;) {
		if (fs.existsSync(path.join(dir, "package.json"))) return fs.realpathSync(dir);
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`no package root for ${name}`);
		dir = parent;
	}
}

function copyTree(source: string, target: string): void {
	fs.cpSync(source, target, {
		recursive: true,
		dereference: true,
		filter: (item) => item === source || path.basename(item) !== "node_modules",
	});
}

export interface Bundle {
	readonly dir: string;
	readonly entry: string;
}

// A self-contained plugin bundle (plan §4): link-free copies of the MCP server, its core and zod in
// <dir>/node_modules beside the template-plugin files, so the read grant on <dir> alone loads it.
export function bundleTemplatePlugin(destDir: string, sourceDir: string = spikeDir): Bundle {
	fs.mkdirSync(destDir, { recursive: true });
	const fromSource = createRequire(path.join(sourceDir, "noop.js"));
	const serverRoot = packageRoot(fromSource, "@modelcontextprotocol/server");
	const coreRoot = packageRoot(
		createRequire(path.join(serverRoot, "noop.js")),
		"@modelcontextprotocol/core",
	);
	const zodRoot = packageRoot(fromSource, "zod");
	copyTree(serverRoot, path.join(destDir, "node_modules", "@modelcontextprotocol", "server"));
	copyTree(coreRoot, path.join(destDir, "node_modules", "@modelcontextprotocol", "core"));
	copyTree(zodRoot, path.join(destDir, "node_modules", "zod"));
	copyTree(path.join(fixturesDir, "template-plugin"), destDir);
	return { dir: destDir, entry: path.join(destDir, "plugin.mjs") };
}

export type Fd = "pipe" | "ignore" | "inherit" | "ipc" | "overlapped";

export interface FixtureSpawnSpec extends Pick<SpawnPluginSpec, "runtime" | "runtimeDir"> {
	readonly nodeBin: string;
	readonly pluginDir: string;
	readonly dataDir: string;
	readonly grantData?: boolean;
	readonly entry: string;
	readonly entryArgs?: readonly string[];
	// Default: the production layout (PLUGIN_STDIO with the child's IPC channel on fd 3).
	readonly stdio?: readonly Fd[];
	// false: no NODE_CHANNEL_* for the child, as for a plain pipe or Node's own stdio 'ipc'.
	readonly channel?: boolean;
	readonly dropFreezeFlag?: boolean;
}

// A fixture under the hub's exact production argv and scrubbed environment, with a chosen fd 3.
// dropFreezeFlag removes only --freeze-flags-after-init, for the V8 control.
export function spawnFixture(spec: FixtureSpawnSpec): ChildProcess {
	const argvSpec = execArgvFor({
		nodeBin: spec.nodeBin,
		runtime: spec.runtime ?? "node",
		pluginDir: spec.pluginDir,
		dataDir: spec.dataDir,
		grantData: spec.grantData ?? false,
		runtimeDir: spec.runtimeDir,
		pluginId: "s02-s2b",
		instanceId: "s2b",
		entry: spec.entry,
	});
	let argv = buildArgv(argvSpec, spec.entry, spec.entryArgs);
	if (spec.dropFreezeFlag) argv = argv.filter((a) => a !== "--freeze-flags-after-init");
	const env = {
		...scrubEnv({ pluginId: "s02-s2b", instanceId: "s2b", dataDir: spec.dataDir }),
		...(spec.channel === false ? {} : PLUGIN_CHANNEL_ENV),
	};
	return spawn(spec.nodeBin, argv, {
		env,
		cwd: spec.pluginDir,
		stdio: [...(spec.stdio ?? PLUGIN_STDIO)],
		serialization: "json",
		windowsHide: true,
	});
}

export interface Collected {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
}

export function collect(child: ChildProcess, timeoutMs = 20_000): Promise<Collected> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code, signal, timedOut });
		});
	});
}

export function tagged(stdout: string, tag = "##DYS2B##"): Record<string, unknown>[] {
	return stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith(tag))
		.map((line) => JSON.parse(line.slice(tag.length)) as Record<string, unknown>);
}

export interface FdAdoptResult {
	readonly outcome: string;
	readonly code: string | null;
	readonly nodeVersion: string;
	readonly gated: boolean;
	readonly denied: boolean;
}

// fd 3 as a plain pipe that is not the plugin's IPC channel: the 26.11 gate the plan relies on.
export async function runFdAdopt(
	nodeBin: string,
	pluginDir: string,
	dataDir: string,
): Promise<FdAdoptResult> {
	const child = spawnFixture({
		nodeBin,
		pluginDir,
		dataDir,
		grantData: true,
		entry: path.join(pluginDir, "fd3-adopt.mjs"),
		stdio: ["ignore", "pipe", "pipe", "pipe"],
		channel: false,
	});
	const { stdout } = await collect(child, 15_000);
	const report = tagged(stdout).at(-1) ?? { outcome: "no-report", code: null, node: "" };
	const nodeVersion = String(report.node ?? "");
	return {
		outcome: String(report.outcome),
		code: (report.code as string | null) ?? null,
		nodeVersion,
		gated: gatesFdAdoption(nodeVersion),
		denied: report.outcome === "denied",
	};
}

export interface TemplateResult {
	readonly discover: boolean;
	readonly tools: string[];
	readonly echo: { readonly valid: boolean; readonly invalidRefused: boolean };
	readonly count: { readonly valid: boolean; readonly invalidRefused: boolean };
}

type McpReply = {
	id?: unknown;
	result?: {
		capabilities?: { tools?: unknown };
		tools?: { name: string }[];
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
	};
	error?: unknown;
};

// The template plugin over MCP stdio under the production argv: server/discover, tools/list, and
// tools/call with valid and invalid input on the zod tool (echo) and the cf-worker tool (count).
export async function runTemplatePlugin(
	nodeBin: string,
	bundleDir: string,
	dataDir: string,
): Promise<TemplateResult> {
	const child = spawnPlugin({
		nodeBin,
		pluginDir: bundleDir,
		dataDir,
		pluginId: "s02-template",
		instanceId: "template",
		entry: path.join(bundleDir, "plugin.mjs"),
	});
	const meta = {
		"io.modelcontextprotocol/protocolVersion": "2026-07-28",
		"io.modelcontextprotocol/clientCapabilities": {},
	};
	child.stderr?.resume();
	const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream })[
		Symbol.asyncIterator
	]();
	let nextId = 0;
	const ask = async (method: string, params: object = {}): Promise<McpReply> => {
		const id = ++nextId;
		child.stdin?.write(
			`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } })}\n`,
		);
		const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
		try {
			for (;;) {
				const { value, done } = await lines.next();
				if (done) return {};
				const reply = JSON.parse(String(value)) as McpReply;
				if (reply.id === id) return reply;
			}
		} finally {
			clearTimeout(deadline);
		}
	};
	const call = (name: string, args: object): Promise<McpReply> =>
		ask("tools/call", { name, arguments: args });
	const refused = (reply: McpReply): boolean =>
		reply.error != null || reply.result?.isError === true;
	try {
		const discover = await ask("server/discover");
		const list = await ask("tools/list");
		const echo = await call("echo", { text: "hello" });
		const echoBad = await call("echo", { text: "x".repeat(5000) });
		const count = await call("count", { text: "héllo" });
		const countBad = await call("count", { text: 42 });
		return {
			discover: discover.result?.capabilities?.tools != null,
			tools: (list.result?.tools ?? []).map((tool) => tool.name).sort(),
			echo: {
				valid:
					echo.result?.structuredContent?.text === "hello" &&
					echo.result.structuredContent.length === 5,
				invalidRefused: refused(echoBad),
			},
			count: {
				valid: count.result?.structuredContent?.chars === 5,
				invalidRefused: refused(countBad),
			},
		};
	} finally {
		child.kill("SIGKILL");
	}
}

export interface ValidatorControl {
	readonly codeGeneration: unknown;
	readonly defaultValidator: unknown;
	readonly cfWorker: unknown;
	readonly zodJitless: unknown;
}

// Under the production argv: code generation is blocked, the SDK's default validator (Ajv) fails,
// and the cf-worker validator and zod jitless accept valid and reject invalid input.
export async function runValidatorControl(
	nodeBin: string,
	bundleDir: string,
	dataDir: string,
): Promise<ValidatorControl> {
	const child = spawnFixture({
		nodeBin,
		pluginDir: bundleDir,
		dataDir,
		entry: path.join(bundleDir, "validator-control.mjs"),
	});
	const report = tagged((await collect(child, 20_000)).stdout).at(-1) ?? {};
	return {
		codeGeneration: report.codeGeneration ?? null,
		defaultValidator: report.defaultValidator ?? null,
		cfWorker: report.cfWorker ?? null,
		zodJitless: report.zodJitless ?? null,
	};
}

export interface V8Outcome {
	readonly beforePrinted: boolean;
	readonly before: { readonly worked: boolean; readonly error?: string };
	readonly after: { readonly worked: boolean; readonly error?: string } | null;
	readonly aborted: boolean;
	readonly freezeCheckFailed: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
}

export async function runV8(
	nodeBin: string,
	pluginDir: string,
	dataDir: string,
	freeze: boolean,
): Promise<V8Outcome> {
	const child = spawnFixture({
		nodeBin,
		pluginDir,
		dataDir,
		grantData: true,
		entry: path.join(pluginDir, "v8-attacker.mjs"),
		dropFreezeFlag: !freeze,
	});
	const { stdout, stderr, code, signal } = await collect(child, 15_000);
	const lines = tagged(stdout);
	const before = lines.find((line) => line.phase === "before");
	const after = lines.find((line) => line.phase === "after");
	return {
		beforePrinted: before !== undefined,
		before: { worked: before?.worked === true, error: before?.error as string | undefined },
		after: after
			? { worked: after.worked === true, error: after.error as string | undefined }
			: null,
		aborted: after === undefined && (signal != null || (code ?? 0) !== 0),
		freezeCheckFailed: /Check failed: !IsFrozen\(\)/.test(stderr),
		exitCode: code,
		signal,
	};
}

export interface InspectorResult {
	readonly attempts: Record<string, unknown>;
	// Inspector queries the stand-in hub answered after the attack; 0 means it can't be judged.
	readonly answers: number;
	readonly hubInspectorOpened: boolean;
}

export async function runInspector(
	nodeBin: string,
	pluginDir: string,
	dataDir: string,
	disableSigusr1: boolean,
): Promise<InspectorResult> {
	const hubArgs = [
		...(disableSigusr1 ? ["--disable-sigusr1"] : []),
		path.join(pluginDir, "inspector-hub.mjs"),
	];
	const hub = spawn(nodeBin, hubArgs, {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	hub.on("error", () => {});
	hub.stdout?.resume();
	hub.stderr?.resume();
	try {
		const first = once(hub, "message").then(([message]) => message as { pid?: number });
		const hubPid = (await within(first, 10_000, {})).pid ?? 0;
		if (hubPid <= 0) throw new Error("the stand-in hub did not report its pid");
		const attacker = spawnFixture({
			nodeBin,
			pluginDir,
			dataDir,
			grantData: true,
			entry: path.join(pluginDir, "inspector-attacker.mjs"),
			entryArgs: [String(hubPid)],
		});
		const report = tagged((await collect(attacker, 10_000)).stdout).at(-1) ?? {};
		let answers = 0;
		let open = false;
		const onMessage = (message: { event?: string; open?: boolean }): void => {
			if (message.event !== "inspector") return;
			answers += 1;
			if (message.open === true) open = true;
		};
		hub.on("message", onMessage);
		for (let i = 0; i < 8 && hub.connected; i++) {
			hub.send({ ask: "inspector" }, () => {});
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		hub.off("message", onMessage);
		return {
			attempts: (report.attempts as Record<string, unknown>) ?? {},
			answers,
			hubInspectorOpened: open,
		};
	} finally {
		hub.kill("SIGKILL");
	}
}

export interface HubConfig {
	readonly pluginDir: string;
	readonly dataDir: string;
	readonly mode?: string;
}

export interface HubRun<T> {
	// The stand-in hub printed its result and exited 0.
	readonly survived: boolean;
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	// When it died: the error class from its last words, from a fixed list.
	readonly crash: string | null;
	readonly result: T | null;
}

const CRASH =
	/\b(SyntaxError|RangeError|TypeError|ERR_INTERNAL_ASSERTION|AssertionError|ERR_IPC_CHANNEL_CLOSED|EPIPE)\b/;

// Runs one host-channel probe in a fresh stand-in hub on `nodeBin`, which also runs the plugin.
export async function runHubProbe<T>(
	nodeBin: string,
	probe: string,
	config: HubConfig,
	timeoutMs = 60_000,
): Promise<HubRun<T>> {
	const hub = spawn(nodeBin, ["--expose-gc", HUB_PROBES_FILE, probe, JSON.stringify(config)], {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const out = await collect(hub, timeoutMs);
	const result = (tagged(out.stdout, "##DYS2BHUB##").at(-1) as T | undefined) ?? null;
	const survived = out.code === 0 && result !== null;
	return {
		survived,
		exitCode: out.code,
		signal: out.signal,
		timedOut: out.timedOut,
		crash: survived ? null : (CRASH.exec(out.stderr)?.[1] ?? "unknown"),
		result,
	};
}

// --- The stand-in hub's results, and the checks the host and Docker suites share. ---

export interface ViolationRecord {
	readonly kind: ViolationKind;
	readonly detail: string;
}

export interface PluginEnd {
	readonly code: number | null;
	readonly signal: string | null;
	// 'close' fired: every stdio stream of the plugin ended.
	readonly closed: boolean;
}

export interface Fds {
	readonly before: number;
	readonly after: number | null;
}

export interface ChannelResult {
	readonly roundTrip: boolean;
	readonly audit: readonly {
		readonly reason: string;
		readonly port: number | null;
		readonly allow: boolean;
	}[];
	readonly outcomes: readonly { readonly denied: boolean; readonly reason?: string | null }[];
	readonly violations: readonly ViolationRecord[];
	readonly pluginEnded: PluginEnd;
}

export interface FuzzResult {
	readonly mode: string;
	readonly violations: readonly ViolationRecord[];
	readonly killed: boolean;
	readonly pluginEnded: PluginEnd;
	readonly exitMs: number;
	// host/fetch requests the hub dispatched; a violation must stop dispatching.
	readonly auditCount: number;
	readonly fds: Fds | null;
	readonly plugin: readonly Record<string, unknown>[];
}

export interface LateReplyResult {
	readonly asked: number;
	readonly droppedWrites: number;
	readonly violations: readonly ViolationRecord[];
	readonly end: PluginEnd;
}

export interface SendAfterExitResult {
	readonly notified: boolean;
	readonly request: string;
	readonly droppedWrites: number;
	readonly end: PluginEnd;
}

export interface ControlResult {
	readonly mode: string;
	readonly handlesReceived: number;
	readonly closeEmitted: boolean;
	readonly fds: Fds | null;
	readonly plugin: readonly Record<string, unknown>[];
}

const died = (run: HubRun<unknown>): string =>
	`the hub died (${run.crash ?? "unknown"}, exit ${run.exitCode ?? run.signal ?? "?"}${run.timedOut ? ", timed out" : ""})`;

export function channelProblem(run: HubRun<ChannelResult>): string | null {
	const r = run.result;
	if (!run.survived || r === null) return died(run);
	if (!r.roundTrip) return "no JSON-RPC round trip";
	const verdicts = r.audit.map((entry) => entry.reason).join(",");
	const expected = FETCH_TARGETS.map((target) => target.expect).join(",");
	if (verdicts !== expected) return `broker verdicts ${verdicts}, expected ${expected}`;
	const denials = FETCH_TARGETS.filter((target) => target.expect !== "allowed").length;
	const seen = r.outcomes.filter((outcome) => outcome.denied).length;
	if (seen !== denials) return `the plugin saw ${seen} denials, not ${denials}`;
	if (r.violations.length > 0) return "a benign plugin raised a violation";
	return null;
}

export function fuzzProblem(
	mode: string,
	platform: NodeJS.Platform,
	run: HubRun<FuzzResult>,
): string | null {
	const r = run.result;
	if (!run.survived || r === null) return died(run);
	const expected = expectedViolation(mode, platform);
	const first = r.violations[0]?.kind ?? null;
	if (r.fds !== null && r.fds.after !== r.fds.before) {
		return `the hub's open fds went from ${r.fds.before} to ${r.fds.after}`;
	}
	if (expected === null) {
		if (first !== null) return `unexpected violation ${first}`;
		const report = r.plugin.find((line) => "adopted" in line || "failed" in line);
		if (mode === "raw-socket" && report?.adopted !== false) return "the IPC fd was adopted";
		if (mode === "handle-send" && report?.failed !== report?.attempted) return "a handle was sent";
		return null;
	}
	if (first !== expected) return `violation ${first}, expected ${expected}`;
	if (r.pluginEnded.signal !== "SIGKILL") return `the plugin ended by ${r.pluginEnded.signal}`;
	if (r.auditCount !== 0) return `${r.auditCount} requests dispatched after the violation`;
	if (!r.pluginEnded.closed) return "'close' never fired";
	return null;
}

export function lateReplyProblem(run: HubRun<LateReplyResult>): string | null {
	if (!run.survived || run.result === null) return died(run);
	if (run.result.asked !== 1) return "the request never reached the hub";
	if (run.result.droppedWrites < 1) return "the late reply was not dropped";
	return null;
}

export function sendAfterExitProblem(run: HubRun<SendAfterExitResult>): string | null {
	if (!run.survived || run.result === null) return died(run);
	if (run.result.notified) return "a notification to an exited plugin reported success";
	if (run.result.request !== "rejected") return "a request to an exited plugin did not reject";
	return null;
}

export type ControlName = "malformed" | "fakeAck" | "handle";

// Node's own stdio 'ipc' parent, which the hub keeps away from: it dies on the first two, and on
// POSIX it takes the plugin's real handle (on Windows the plugin can't send one).
export function controlProblem(
	name: ControlName,
	platform: NodeJS.Platform,
	run: HubRun<ControlResult>,
): string | null {
	if (name !== "handle") {
		return run.survived ? `Node's IPC parent survived ${name} (re-review for ADR 0003)` : null;
	}
	if (!run.survived || run.result === null) return died(run);
	const received = run.result.handlesReceived;
	if (platform !== "win32" && received === 0) return "no handle reached Node's IPC parent";
	if (platform === "win32" && received !== 0) return "a handle reached Node's IPC parent";
	return null;
}

export function templateProblem(r: TemplateResult): string | null {
	if (!r.discover) return "server/discover went unanswered";
	if (r.tools.join(",") !== "count,echo") return `tools/list gave ${r.tools.join(",")}`;
	if (!r.echo.valid || !r.count.valid) return "a valid tools/call failed";
	if (!r.echo.invalidRefused || !r.count.invalidRefused)
		return "an invalid tools/call went through";
	return null;
}

export function validatorProblem(r: ValidatorControl): string | null {
	const judged = (value: unknown): boolean =>
		JSON.stringify(value) === JSON.stringify({ valid: "accepted", invalid: "rejected" });
	if (r.codeGeneration !== "EvalError") return `code generation: ${String(r.codeGeneration)}`;
	if (r.defaultValidator !== "EvalError") return "the default (Ajv) validator ran without codegen";
	if (!judged(r.cfWorker)) return "the cf-worker validator misjudged";
	if (!judged(r.zodJitless)) return "zod jitless misjudged";
	return null;
}

// The attack failed under the final argv only if V8 aborted at the flag change after the "before"
// probe showed natives blocked; dying any other way (a timeout, an earlier crash) doesn't count.
export function v8Blocked(outcome: V8Outcome): boolean {
	return (
		outcome.beforePrinted &&
		outcome.before.error === "SyntaxError" &&
		outcome.after === null &&
		outcome.aborted &&
		outcome.freezeCheckFailed
	);
}

export function v8Weakened(outcome: V8Outcome): boolean {
	return outcome.after?.worked === true;
}

// The stand-in hub must have answered, or "no inspector" can't be judged.
export function inspectorStayedClosed(result: InspectorResult): boolean {
	return result.answers > 0 && !result.hubInspectorOpened;
}
