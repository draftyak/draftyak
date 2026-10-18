// Shared S11b drivers, used by the host suites (Windows/Linux/macOS) and, staged into a Linux
// container, by runner-m034.mjs. It imports only node: built-ins, the spike's own src and test/bundle,
// and M0.11's argv/spawn, never the kit, so it runs unchanged inside the container. The host suites add
// the kit (node binaries, evidence, Docker). Every plugin here is spawned exactly as the hub spawns a
// python plugin (src/launch.ts spawnPythonPlugin), under the production flags; the audit run adds
// --permission-audit and an --import instrument, which is not a production spawn.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { buildExecArgv } from "@draftyak/spike-s02-plugin-sandbox/src/argv.ts";
import {
	PLUGIN_CHANNEL_ENV,
	PLUGIN_STDIO,
	scrubEnv,
} from "@draftyak/spike-s02-plugin-sandbox/src/spawn.ts";
import { BundleRefusedError, spawnPythonPlugin } from "../src/launch.ts";
import { copyRuntime, RuntimeRefusedError, SHIM } from "../src/runtime.ts";
import { serveHostChannel } from "./channel.ts";

// A master-key stand-in and a home canary, written to a fake profile outside every grant. The markers
// are compared against, never recorded; the suite also greps all output for them.
export const MK_CANARY = "DRAFTYAK-MK-STANDIN-DO-NOT-LEAK";
export const HOME_CANARY = "DRAFTYAK-HOME-CANARY-DO-NOT-LEAK";
export const BROKER = "https://broker.example";
export const OFF_PROFILE = "https://off-profile.example/secret";

// The 2026-07-28 opening envelope the shim's MCP transport expects on every request.
const ENVELOPE = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};

// Every hostile attempt (§9.2 Python rows), in fixtures/hostile-py. Each runs in its own freshly
// spawned plugin, because a Node permission denial on a synchronous Emscripten syscall (os.system ->
// spawnSync) is a fatal Pyodide error that ends the runtime: that is itself a denial, but it leaves no
// usable process, so attempts can't share one.
export const ATTACKS: readonly string[] = [
	"os_system",
	"subprocess",
	"socket",
	"off_profile_request",
	"open_canaries",
	"js_require_child_process",
	"process_binding_fs",
	"run_js",
	"codegen",
	"write_plugin_dir",
	"write_runtime_dir",
];

// The permission-model scopes that must never fire an audit event for a legitimate python plugin. A
// FileSystemRead event is allowed (the post-drop runtime probe is one); a FileSystemWrite is not.
export const FORBIDDEN_SCOPES: readonly string[] = [
	"net",
	"child",
	"worker",
	"wasi",
	"addon",
	"ffi",
	"inspector",
	"openssl-store",
];
// A Node permission refusal, however it surfaces (a caught error code, or a fatal-error log line).
const PERMISSION_DENIED =
	/ERR_ACCESS_DENIED|Access to this API has been restricted|ERR_DLOPEN_DISABLED/;

export interface PluginSpec {
	readonly nodeBin: string;
	// A verified, link-free runtime copy; reused across spawns (the hub makes a fresh copy per spawn,
	// but the copy is read-only and re-verified on every spawn, so sharing one is equivalent here).
	readonly runtimeDir: string;
	readonly files: Readonly<Record<string, string>>;
	readonly abi: string;
	readonly dataDir: string;
	readonly signal?: AbortSignal;
}

export type Broker = (params: Record<string, unknown>) => Record<string, unknown>;

// The broker stub the host channel answers (host/fetch). The allowed path returns 200; an off-profile
// host or any other path returns 403, which is how the egress profile refuses it. Bodies are base64.
export function broker(params: Record<string, unknown>): Record<string, unknown> {
	const text = (status: number, body: Buffer) => ({
		status,
		headers: { "content-type": "text/plain" },
		bodyBase64: body.toString("base64"),
	});
	const url = String(params.url ?? "");
	if (url === `${BROKER}/status`) return text(200, Buffer.from("broker ok"));
	if (url === `${BROKER}/binary`) {
		return {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
			bodyBase64: Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("base64"),
		};
	}
	if (url === `${BROKER}/empty`) return { status: 204, headers: {} };
	if (url === `${BROKER}/echo` && params.method === "POST") {
		return {
			status: 200,
			headers: { "content-type": "application/octet-stream" },
			bodyBase64: String(params.bodyBase64 ?? ""),
		};
	}
	return text(403, Buffer.alloc(0));
}

interface Frame {
	readonly jsonrpc?: string;
	readonly id?: unknown;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message?: unknown };
}

interface Attached {
	readonly ask: (method: string, params: object, raw?: boolean) => Promise<Frame | null>;
	readonly ready: () => Record<string, unknown> | null;
	readonly logs: () => readonly string[];
	readonly stdoutLines: () => readonly string[];
	readonly brokerUrls: () => readonly string[];
	readonly allOutput: () => string;
	readonly exit: Promise<number | null>;
}

// Attaches to a spawned plugin: answers host/fetch from the broker, records host/log and stdout, and
// correlates request ids. Since M0.12 the hub reads fd 3 as a plain pipe through S2b's decoder
// (serveHostChannel), never Node parent-side IPC: a plugin that writes a hostile byte there is
// killed. Content from the broker crosses as base64, as the shim sends it.
function attach(child: ChildProcess, brokerImpl: Broker = broker): Attached {
	const waiters = new Map<number, (frame: Frame) => void>();
	let nextId = 0;
	let ready: Record<string, unknown> | null = null;
	const logs: string[] = [];
	const stdoutLines: string[] = [];
	const brokerUrls: string[] = [];
	let all = "";
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		all += `${line}\n`;
		stdoutLines.push(line);
		try {
			const frame = JSON.parse(line) as Frame;
			if (typeof frame.id === "number") waiters.get(frame.id)?.(frame);
		} catch {
			// a non-frame line; the prints suite checks fd 1 holds frames only
		}
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		all += chunk;
	});
	serveHostChannel(child, {
		fetch: (params) => {
			brokerUrls.push(String(params.url ?? ""));
			return brokerImpl(params);
		},
		notify: (method, params) => {
			if (method !== "host/log") return;
			const text = String(params.message ?? "");
			logs.push(text);
			if (text === "ready") ready = (params.data as Record<string, unknown>) ?? null;
		},
	});
	const exit = (once(child, "close") as Promise<[number | null]>).then(
		([code]) => code,
		() => null,
	);
	const ask = (method: string, params: object, raw = false): Promise<Frame | null> => {
		const id = ++nextId;
		const answer = new Promise<Frame>((resolve) => waiters.set(id, resolve));
		const body = raw ? params : { ...params, _meta: ENVELOPE };
		child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: body })}\n`);
		return Promise.race([answer, exit.then(() => null)]);
	};
	return {
		ask,
		ready: () => ready,
		logs: () => logs,
		stdoutLines: () => stdoutLines,
		brokerUrls: () => brokerUrls,
		allOutput: () => all,
		exit,
	};
}

function spawnPlugin(spec: PluginSpec, pluginDir: string, instanceId: string): ChildProcess {
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

const structured = (frame: Frame | null): Record<string, unknown> | null =>
	(frame?.result?.structuredContent as Record<string, unknown> | undefined) ?? null;

export interface AttackResult {
	readonly name: string;
	readonly node: string;
	readonly outcome: string;
	readonly code: string | null;
	readonly escaped: boolean;
	readonly denied: boolean;
	readonly permissionDenied: boolean;
	readonly canaryLeak: boolean;
	readonly hostFileCreated: boolean;
	// The socket attack only: whether the harness's live loopback listener accepted a connection
	// (netTested is true when a listener was run). An accepted connection is a true escape; 0
	// accepted under the production flags is the authoritative denial, even if the plugin crashed.
	readonly netTested: boolean;
	readonly netConnected: boolean;
}

// A loopback TCP listener with an accept counter, for the socket attack. Running it in the driver
// means it works the same on the host (Vitest) and inside the --network none container (the runner is
// unpermissioned and loopback is available there), so the socket row tests the permission boundary on
// both legs. Returns the port, the accept count and a close().
async function netListener(): Promise<{
	host: string;
	port: number;
	accepted: () => number;
	close: () => void;
}> {
	let accepted = 0;
	const server = net.createServer((socket) => {
		socket.on("error", () => {});
		socket.on("data", () => {});
	});
	server.on("connection", () => {
		accepted += 1;
	});
	server.on("error", () => {});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	return { host: "127.0.0.1", port, accepted: () => accepted, close: () => server.close() };
}

export interface CanaryArgs {
	readonly fakeDir: string;
	readonly pluginDir: string;
	readonly runtimeDir: string;
	readonly canaries: readonly { name: string; marker: string }[];
	readonly offProfileUrl: string;
}

// Runs one hostile attempt in its own plugin and classifies it. escaped is true only on a positive
// escape signal (the fixture self-reports "escaped", a canary leaks, or a host file appears); every
// other ending is a denial, including a fatal permission crash.
export async function runHostile(
	spec: PluginSpec,
	hostilePluginDir: string,
	node: string,
	name: string,
	canaries: CanaryArgs,
): Promise<AttackResult> {
	const listener = name === "socket" ? await netListener() : undefined;
	try {
		const child = spawnPlugin(spec, hostilePluginDir, `hostile-${name}`);
		const io = attach(child);
		await io.ask("server/discover", {});
		await io.ask("tools/list", {});
		const frame = await io.ask("tools/call", {
			name,
			arguments: {
				fakeDir: canaries.fakeDir,
				pluginDir: canaries.pluginDir,
				runtimeDir: canaries.runtimeDir,
				canaries: canaries.canaries,
				offProfileUrl: canaries.offProfileUrl,
				...(listener ? { connectHost: listener.host, connectPort: listener.port } : {}),
			},
		});
		const sc = structured(frame);
		child.stdin?.end();
		await Promise.race([io.exit, new Promise((r) => setTimeout(r, 8000)).then(() => child.kill())]);
		// A synchronous permission denial (os.system -> spawnSync) is a fatal Pyodide error whose
		// message reaches host/log over the fd-3 channel, not fds 1/2, so scan the logs too.
		const combined = `${io.allOutput()}\n${io.logs().join("\n")}`;
		const permissionDenied = PERMISSION_DENIED.test(combined);
		const canaryLeak = combined.includes(MK_CANARY) || combined.includes(HOME_CANARY);
		const hostFileCreated =
			fs.existsSync(path.join(canaries.pluginDir, "dy_pwned.txt")) ||
			fs.existsSync(path.join(canaries.runtimeDir, "dy_pwned.txt"));
		const netTested = listener !== undefined;
		// The listener's accept count is out of band: it stands even if the plugin crashed on denial.
		const netConnected = (listener?.accepted() ?? 0) > 0;
		const selfOutcome =
			typeof sc?.outcome === "string" ? sc.outcome : frame?.result?.isError ? "error" : "no-result";
		const escaped = sc?.outcome === "escaped" || canaryLeak || hostFileCreated || netConnected;
		const denied =
			!escaped && (sc?.outcome === "denied" || permissionDenied || (netTested && !netConnected));
		return {
			name,
			node,
			outcome: selfOutcome,
			code: typeof sc?.code === "string" ? sc.code : null,
			escaped,
			denied,
			permissionDenied,
			canaryLeak,
			hostFileCreated,
			netTested,
			netConnected,
		};
	} finally {
		listener?.close();
	}
}

export function hostileProblem(result: AttackResult): string | null {
	const label = `${result.name} (${result.node})`;
	if (result.canaryLeak) return `${label}: a canary leaked`;
	if (result.hostFileCreated) return `${label}: a host file was created`;
	if (result.netConnected) return `${label}: a socket connected to the harness listener`;
	if (result.escaped) return `${label}: ESCAPED [${result.outcome}/${result.code}]`;
	if (!result.denied) return `${label}: no denial observed [${result.outcome}/${result.code}]`;
	return null;
}

export interface ContractResult {
	readonly node: string;
	readonly toolsCount: number;
	readonly supportedVersions: readonly string[];
	readonly pingOk: boolean;
	readonly legacyRejected: boolean;
	readonly readAfterDrop: boolean | null;
}

// The contract suite after the grants drop: the plugin still answers server/discover and tools/list,
// a benign tool works, and a 2025-era opening is rejected (defence in depth).
export async function runContract(
	spec: PluginSpec,
	hostilePluginDir: string,
	node: string,
): Promise<ContractResult> {
	const child = spawnPlugin(spec, hostilePluginDir, "contract");
	const io = attach(child);
	const discover = await io.ask("server/discover", {});
	const list = await io.ask("tools/list", {});
	const ping = await io.ask("tools/call", { name: "ping", arguments: {} });
	const legacy = await io.ask(
		"initialize",
		{ protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "s11", version: "1" } },
		true,
	);
	child.stdin?.end();
	await Promise.race([io.exit, new Promise((r) => setTimeout(r, 8000)).then(() => child.kill())]);
	const pingText = (ping?.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
	const ready = io.ready();
	return {
		node,
		toolsCount: ((list?.result?.tools as unknown[] | undefined) ?? []).length,
		supportedVersions: (discover?.result?.supportedVersions as string[] | undefined) ?? [],
		pingOk: pingText === "pong",
		legacyRejected: legacy?.error?.code === -32022,
		readAfterDrop: typeof ready?.readAfterDrop === "boolean" ? ready.readAfterDrop : null,
	};
}

export function contractProblem(result: ContractResult): string | null {
	const label = `contract (${result.node})`;
	if (result.toolsCount < ATTACKS.length) return `${label}: tools/list is short`;
	if (!result.supportedVersions.includes("2026-07-28")) return `${label}: no 2026-07-28`;
	if (!result.pingOk) return `${label}: ping did not answer after the drop`;
	if (!result.legacyRejected) return `${label}: a 2025 initialize was not rejected`;
	if (result.readAfterDrop !== false) return `${label}: read access remained after the drop`;
	return null;
}

export interface PrintsResult {
	readonly node: string;
	readonly printed: number;
	readonly stdoutFrameLines: number;
	readonly nonFrameStdoutLines: number;
	readonly forgedIdOnFd1: boolean;
	readonly forgedTextOnFd1: boolean;
	readonly contractIntactAfter: boolean;
}

// 10k JSON-RPC-shaped prints and input() calls: none may reach fds 0/1. print() is diverted to
// host/log and input() raises, so fd 1 keeps only real MCP frames and the forged id never appears
// there. After the flood the plugin still answers, proving input() never consumed fd 0.
export async function runPrints(
	spec: PluginSpec,
	hostilePluginDir: string,
	node: string,
	count = 10_000,
): Promise<PrintsResult> {
	const child = spawnPlugin(spec, hostilePluginDir, "prints");
	const io = attach(child);
	await io.ask("server/discover", {});
	await io.ask("tools/list", {});
	const flood = await io.ask("tools/call", { name: "flood", arguments: { count } });
	const forgedId = (structured(flood)?.forgedId as number | undefined) ?? 987654321;
	// If input() had consumed fd 0 our frames would be lost; a working ping here proves it did not.
	const after = await io.ask("tools/call", { name: "ping", arguments: {} });
	child.stdin?.end();
	await Promise.race([io.exit, new Promise((r) => setTimeout(r, 8000)).then(() => child.kill())]);
	const lines = io.stdoutLines().filter((line) => line.trim() !== "");
	let frameLines = 0;
	let forgedIdOnFd1 = false;
	for (const line of lines) {
		try {
			const frame = JSON.parse(line) as Frame;
			if (frame.jsonrpc === "2.0" && typeof frame.id === "number") frameLines += 1;
			if ((frame as { id?: unknown }).id === forgedId) forgedIdOnFd1 = true;
		} catch {
			// counted as a non-frame line below
		}
	}
	const afterText = (after?.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
	return {
		node,
		printed: (structured(flood)?.printed as number | undefined) ?? 0,
		stdoutFrameLines: frameLines,
		nonFrameStdoutLines: lines.length - frameLines,
		forgedIdOnFd1,
		forgedTextOnFd1: io.stdoutLines().some((line) => line.includes(`"forged":true`)),
		contractIntactAfter: afterText === "pong",
	};
}

export function printsProblem(result: PrintsResult): string | null {
	const label = `prints (${result.node})`;
	if (result.nonFrameStdoutLines > 0)
		return `${label}: ${result.nonFrameStdoutLines} non-frame lines on fd 1`;
	if (result.forgedIdOnFd1 || result.forgedTextOnFd1)
		return `${label}: a forged frame reached fd 1`;
	if (!result.contractIntactAfter) return `${label}: the stream was broken after the fuzz`;
	if (result.printed < 10_000) return `${label}: the fuzz did not run (${result.printed})`;
	return null;
}

export interface TimeoutResult {
	readonly node: string;
	readonly callTimeoutMs: number;
	readonly graceMs: number;
	readonly answered: boolean;
	// The call did not answer within its timeout (the handler is genuinely stuck).
	readonly timedOut: boolean;
	// The process was still alive when the grace expired (it did not crash or exit on its own).
	readonly aliveBeforeKill: boolean;
	// The supervisor killed the process, and only because it was stuck past timeout + grace.
	readonly killed: boolean;
	readonly killSignal: string;
	readonly timeToKillMs: number;
	readonly restarted: boolean;
}

// A busy-loop handler blocks the single Pyodide thread, so the call never answers and the plugin can't
// even see the abort: the hub's only recourse is to kill the process (call timeout + 5 s). A fresh
// plugin then boots and answers, proving a clean restart.
export async function runTimeout(
	spec: PluginSpec,
	hostilePluginDir: string,
	node: string,
	callTimeoutMs = 2_000,
	graceMs = 5_000,
): Promise<TimeoutResult> {
	const child = spawnPlugin(spec, hostilePluginDir, "timeout-busy");
	const io = attach(child);
	await io.ask("server/discover", {});
	await io.ask("tools/list", {});
	let answered = false;
	io.ask("tools/call", { name: "busy", arguments: {} }).then((frame) => {
		if (frame !== null) answered = true;
	});
	const started = performance.now();
	// A supervisor drives the kill off the call's non-completion, as the hub's health loop does
	// (plan §4 Health): at the call timeout the hub cancels through the signal — which the busy loop,
	// blocking the single Pyodide thread, cannot observe — and 5 s later, if the call still has not
	// answered, it kills the process. The kill is thus conditional on the handler being stuck, not
	// unconditional.
	await new Promise((r) => setTimeout(r, callTimeoutMs));
	const timedOut = !answered;
	if (timedOut) await new Promise((r) => setTimeout(r, graceMs));
	const aliveBeforeKill = child.exitCode === null && child.signalCode === null;
	const killSignal = process.platform === "win32" ? "SIGTERM" : "SIGKILL";
	let killTriggered = false;
	if (!answered && aliveBeforeKill) {
		child.kill(killSignal);
		killTriggered = true;
	}
	const code = await Promise.race([
		io.exit,
		new Promise<number | null>((r) => setTimeout(() => r(null), 10_000)),
	]);
	const timeToKillMs = Math.round(performance.now() - started);
	// Killed only because the handler was stuck past timeout + grace and the process was still alive.
	const killed = killTriggered && !answered && code !== 0;

	const fresh = spawnPlugin(spec, hostilePluginDir, "timeout-restart");
	const freshIo = attach(fresh);
	const discover = await freshIo.ask("server/discover", {});
	const ping = await freshIo.ask("tools/call", { name: "ping", arguments: {} });
	fresh.stdin?.end();
	await Promise.race([
		freshIo.exit,
		new Promise((r) => setTimeout(r, 8000)).then(() => fresh.kill()),
	]);
	const pingText = (ping?.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? "";
	const restarted =
		(discover?.result?.supportedVersions as string[] | undefined)?.includes("2026-07-28") ===
			true && pingText === "pong";
	return {
		node,
		callTimeoutMs,
		graceMs,
		answered,
		timedOut,
		aliveBeforeKill,
		killed,
		killSignal,
		timeToKillMs,
		restarted,
	};
}

export function timeoutProblem(result: TimeoutResult): string | null {
	const label = `timeout (${result.node})`;
	if (result.answered) return `${label}: the busy loop answered instead of hanging`;
	if (!result.timedOut) return `${label}: the call did not exceed its timeout`;
	if (!result.aliveBeforeKill) return `${label}: the plugin exited on its own, not by the kill`;
	if (!result.killed) return `${label}: the stuck plugin was not killed`;
	if (!result.restarted) return `${label}: the plugin did not restart cleanly`;
	return null;
}

export interface AuditResult {
	readonly node: string;
	readonly counts: Readonly<Record<string, number>>;
	readonly fsPermissions: Readonly<Record<string, number>>;
	readonly forbiddenEvents: number;
	readonly fsWriteEvents: number;
	readonly fsReadEvents: number;
	readonly brokerRequestCount: number;
	readonly offBrokerRequest: boolean;
	// null when there is no host watcher (Docker --network none); -1 when the watcher was
	// inconclusive (a timeout or an unparseable result), which must fail the audit, not read as clean.
	readonly tcpConnections: number | null;
	readonly complete: boolean;
}

// The audit run (plan §15 S11 (b)). Spawns a legitimate py-hello session under the production flags
// plus --permission-audit and the --import instrument, which subscribes to every permission-model
// channel in the plugin process. A clean plugin must raise no forbidden event (fs-write, net, child,
// worker, WASI, addon, FFI, inspector) and reach no host but the broker. watchTcp, when given, is the
// host connection watcher; Docker uses --network none instead.
export async function runAudit(
	spec: PluginSpec,
	auditPluginDir: string,
	preloadFileName: string,
	node: string,
	watchTcp?: (pid: number) => Promise<number>,
): Promise<AuditResult> {
	const exec = buildExecArgv({
		runtime: "python",
		pluginDir: auditPluginDir,
		runtimeDir: spec.runtimeDir,
	});
	const preloadUrl = pathToFileURL(path.join(auditPluginDir, preloadFileName)).href;
	const argv = [
		exec[0] as string,
		"--permission-audit",
		...exec.slice(1),
		"--import",
		preloadUrl,
		path.join(spec.runtimeDir, SHIM),
		auditPluginDir,
	];
	const child = spawn(spec.nodeBin, argv, {
		env: {
			...scrubEnv({ pluginId: "py-hello", instanceId: "audit", dataDir: spec.dataDir }),
			...PLUGIN_CHANNEL_ENV,
		},
		cwd: auditPluginDir,
		stdio: [...PLUGIN_STDIO],
		windowsHide: true,
		signal: spec.signal,
	});
	const io = attach(child);
	await io.ask("server/discover", {});
	await io.ask("tools/list", {});
	await io.ask("tools/call", { name: "hello", arguments: { name: "A" } });
	await io.ask("tools/call", { name: "fetch_status", arguments: { url: `${BROKER}/status` } });
	await io.ask("tools/call", { name: "http_clients", arguments: { url: BROKER } });
	await io.ask("tools/call", { name: "runtime_info", arguments: {} });
	const tcpConnections = watchTcp && child.pid !== undefined ? await watchTcp(child.pid) : null;
	child.stdin?.end();
	await Promise.race([io.exit, new Promise((r) => setTimeout(r, 10_000)).then(() => child.kill())]);
	// The instrument writes its one ##DYAUDIT## line to fd 2 at exit; attach() captured it in allOutput.
	const match = /##DYAUDIT##(.*)/.exec(io.allOutput());
	const auditPayload = match
		? (JSON.parse(match[1] as string) as {
				counts?: Record<string, number>;
				fsPermissions?: Record<string, number>;
			})
		: null;
	const counts = auditPayload?.counts ?? {};
	const fsPermissions = auditPayload?.fsPermissions ?? {};
	const forbiddenEvents = FORBIDDEN_SCOPES.reduce(
		(total, scope) => total + (counts[scope] ?? 0),
		0,
	);
	const urls = io.brokerUrls();
	return {
		node,
		counts,
		fsPermissions,
		forbiddenEvents,
		fsWriteEvents: fsPermissions.FileSystemWrite ?? 0,
		fsReadEvents: fsPermissions.FileSystemRead ?? 0,
		brokerRequestCount: urls.length,
		offBrokerRequest: urls.some((url) => !url.startsWith(`${BROKER}/`)),
		tcpConnections,
		complete: auditPayload !== null,
	};
}

export function auditProblem(result: AuditResult): string | null {
	const label = `audit (${result.node})`;
	if (!result.complete) return `${label}: the audit instrument reported nothing`;
	// Positive control: the shim's post-drop runtime-dir probe and boot reads must register fs-read
	// events under --permission-audit. Zero means the permission-model channels were never observed
	// (a renamed/dropped channel), so "0 forbidden events" would be vacuous.
	if (result.fsReadEvents === 0) {
		return `${label}: no fs-read events — the audit instrument observed nothing`;
	}
	if (result.forbiddenEvents > 0)
		return `${label}: ${result.forbiddenEvents} forbidden permission events`;
	if (result.fsWriteEvents > 0) return `${label}: ${result.fsWriteEvents} fs-write events`;
	if (result.offBrokerRequest) return `${label}: a request reached a non-broker host`;
	// A host watcher that timed out or returned an unparseable result reports -1: inconclusive, not
	// clean. Only an exact 0 (or null, meaning Docker --network none, no host watcher) passes.
	if (result.tcpConnections !== null && result.tcpConnections !== 0) {
		return result.tcpConnections < 0
			? `${label}: the TCP connection watcher was inconclusive`
			: `${label}: ${result.tcpConnections} TCP connections owned by the plugin`;
	}
	return null;
}

export interface NetControlResult {
	readonly node: string;
	readonly netEvents: number;
	readonly complete: boolean;
}

// Positive control for the net channel (plan §15 S11 (b)): a net attempt under --permission-audit must
// raise a node:permission-model:net event, so the clean run's net === 0 is a measurement and not the
// silent no-op of a renamed/dropped channel. The hostile plugin's socket tool reaches Node's net
// through useNodeSockFS; the permission check fires whether audit enforces (26.5.1) or observes
// (26.12.0), and the audit instrument's exit line reports the count even if the attempt crashes.
export async function runAuditNetControl(
	spec: PluginSpec,
	hostilePluginDir: string,
	preloadFileName: string,
	node: string,
): Promise<NetControlResult> {
	const exec = buildExecArgv({
		runtime: "python",
		pluginDir: hostilePluginDir,
		runtimeDir: spec.runtimeDir,
	});
	const preloadUrl = pathToFileURL(path.join(hostilePluginDir, preloadFileName)).href;
	const argv = [
		exec[0] as string,
		"--permission-audit",
		...exec.slice(1),
		"--import",
		preloadUrl,
		path.join(spec.runtimeDir, SHIM),
		hostilePluginDir,
	];
	const child = spawn(spec.nodeBin, argv, {
		env: {
			...scrubEnv({ pluginId: "dy-hostile", instanceId: "audit-net", dataDir: spec.dataDir }),
			...PLUGIN_CHANNEL_ENV,
		},
		cwd: hostilePluginDir,
		stdio: [...PLUGIN_STDIO],
		windowsHide: true,
		signal: spec.signal,
	});
	const io = attach(child);
	await io.ask("server/discover", {});
	await io.ask("tools/list", {});
	// connectPort drives the attack's useNodeSockFS path (net.connect); the port need not be live,
	// since the permission check fires before any connection.
	await io.ask("tools/call", {
		name: "socket",
		arguments: { connectHost: "127.0.0.1", connectPort: 9 },
	});
	child.stdin?.end();
	await Promise.race([io.exit, new Promise((r) => setTimeout(r, 10_000)).then(() => child.kill())]);
	const match = /##DYAUDIT##(.*)/.exec(io.allOutput());
	const payload = match
		? (JSON.parse(match[1] as string) as { counts?: Record<string, number> })
		: null;
	return { node, netEvents: payload?.counts?.net ?? 0, complete: payload !== null };
}

export function netControlProblem(result: NetControlResult): string | null {
	const label = `audit net control (${result.node})`;
	if (!result.complete) return `${label}: the audit instrument reported nothing`;
	if (result.netEvents === 0) {
		return `${label}: a net attempt raised no net event — the net channel is not observed`;
	}
	return null;
}

export type TamperKind =
	| "extra"
	| "modified"
	| "symlink"
	| "symlink-samecontent"
	| "junction"
	| "hardlink"
	| "hardlink-samecontent";

// The verifyRuntime finding each tamper kind must produce, so a regression in the symlink/nlink
// checks is caught instead of masked by the content-hash or entry-type fallback. A same-content hard
// link matches the hash, so only the nlink > 1 check can catch it; a same-content symlink matches the
// hash, so only the isSymbolicLink() check (not isFile()) can catch it.
const TAMPER_FINDING: Readonly<Record<TamperKind, string>> = {
	extra: "extra",
	modified: "modified",
	symlink: "symlink",
	"symlink-samecontent": "symlink",
	junction: "symlink",
	hardlink: "hardlink",
	"hardlink-samecontent": "hardlink",
};

export interface TamperResult {
	readonly kind: TamperKind;
	readonly node: string;
	readonly refused: boolean;
	readonly code: string | null;
	readonly findingKind: string | null;
}

// Damages a fresh runtime copy, then confirms the spawn is refused before any child starts. symlink,
// junction and hard link, plus an extra and a modified file, each caught by the hash-list verify that
// runs before every spawn (src/launch.ts -> src/runtime.ts verifyRuntime).
export function runTamper(
	spec: Omit<PluginSpec, "runtimeDir">,
	sources: { pyodideDir: string; wsDir: string; shim: string },
	workRoot: string,
	hostilePluginDir: string,
	node: string,
	kind: TamperKind,
): TamperResult {
	const runtimeDir = path.join(workRoot, `tamper-${kind}-${randomBytes(3).toString("hex")}`);
	copyRuntime(runtimeDir, spec.files, sources);
	const victim = Object.keys(spec.files).find((rel) => rel !== SHIM) ?? SHIM;
	const victimPath = path.join(runtimeDir, ...victim.split("/"));
	const victimBytes = fs.readFileSync(victimPath);
	if (kind === "extra") fs.writeFileSync(path.join(runtimeDir, "dy_extra.js"), "1;\n");
	else if (kind === "modified") fs.appendFileSync(victimPath, "\n// tampered\n");
	else if (kind === "hardlink") {
		const outside = path.join(workRoot, `hl-${randomBytes(3).toString("hex")}.js`);
		fs.writeFileSync(outside, "1;\n");
		fs.rmSync(victimPath);
		fs.linkSync(outside, victimPath);
	} else if (kind === "hardlink-samecontent") {
		// The outside file holds the victim's exact bytes, so the sha256 still matches: only the
		// nlink > 1 check can refuse this one.
		const outside = path.join(workRoot, `hl-${randomBytes(3).toString("hex")}.bin`);
		fs.writeFileSync(outside, victimBytes);
		fs.rmSync(victimPath);
		fs.linkSync(outside, victimPath);
	} else if (kind === "junction") {
		fs.rmSync(victimPath);
		fs.symlinkSync(sources.pyodideDir, victimPath, "junction");
	} else if (kind === "symlink-samecontent") {
		// The symlink target holds the victim's exact bytes, so the sha256 still matches: only the
		// isSymbolicLink() check can refuse this one.
		const outside = path.join(workRoot, `sl-${randomBytes(3).toString("hex")}.bin`);
		fs.writeFileSync(outside, victimBytes);
		fs.rmSync(victimPath);
		fs.symlinkSync(outside, victimPath, "file");
	} else {
		fs.rmSync(victimPath);
		fs.symlinkSync(sources.shim, victimPath, "file");
	}
	let refused = false;
	let code: string | null = null;
	let findingKind: string | null = null;
	try {
		spawnPythonPlugin({
			nodeBin: spec.nodeBin,
			runtimeDir,
			expected: spec.files,
			abi: spec.abi,
			pluginDir: hostilePluginDir,
			dataDir: spec.dataDir,
			pluginId: "dy-hostile",
			instanceId: `tamper-${kind}`,
		}).kill();
	} catch (error) {
		refused = true;
		code = (error as { code?: string }).code ?? null;
		if (error instanceof RuntimeRefusedError) findingKind = error.finding.kind;
		else if (error instanceof BundleRefusedError) findingKind = "bundle";
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
	return { kind, node, refused, code, findingKind };
}

export function tamperProblem(result: TamperResult): string | null {
	const label = `tamper ${result.kind} (${result.node})`;
	if (!result.refused) return `${label}: the spawn was not refused`;
	if (result.code !== "DY_REFUSED_SPAWN") return `${label}: wrong refusal code ${result.code}`;
	const want = TAMPER_FINDING[result.kind];
	if (result.findingKind !== want) {
		return `${label}: finding ${result.findingKind}, expected ${want}`;
	}
	return null;
}
