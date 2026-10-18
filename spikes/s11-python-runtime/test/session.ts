// One S11a boot case, the same on the host and inside the Linux container: a fresh link-free runtime
// copy before each spawn, the (a) control without and with the binding stub, then a shim session
// over stdio MCP with the fd-3 host channel answering host/fetch as a broker stub would. Imports only
// node: built-ins, ../src, ./channel.ts and M0.11/M0.12's src, so docker-runner.mjs can load it.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	assertExecArgvAllowed,
	buildArgv,
	buildExecArgv,
} from "@draftyak/spike-s02-plugin-sandbox/src/argv.ts";
import {
	PLUGIN_CHANNEL_ENV,
	PLUGIN_STDIO,
	preSpawnLinkScan,
	scrubEnv,
	spawnPlugin,
} from "@draftyak/spike-s02-plugin-sandbox/src/spawn.ts";
import { checkBundle, spawnPythonPlugin } from "../src/launch.ts";
import {
	copyRuntime,
	RuntimeRefusedError,
	type RuntimeSources,
	SHIM,
	verifyRuntime,
} from "../src/runtime.ts";
import { serveHostChannel } from "./channel.ts";

export const FREEZE = "--freeze-flags-after-init";
export const BROKER = "https://broker.example";
export const FETCH_URL: string = `${BROKER}/status`;
export const BROKER_BODY = "broker ok";
// Bytes that aren't UTF-8, so a text round trip would change them.
export const BINARY: Buffer = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const ENVELOPE = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};

export interface Variant {
	readonly name: "base" | "freeze";
	readonly extra: readonly string[];
}

// M0.12 may add --freeze-flags-after-init to the shared argv, so every case also runs with it.
export const VARIANTS: readonly Variant[] = [
	{ name: "base", extra: [] },
	{ name: "freeze", extra: [FREEZE] },
];

export interface CaseSpec {
	readonly node: string;
	readonly nodeBin: string;
	readonly variant: Variant;
	// The installed packages and the built shim bundle.
	readonly sources: RuntimeSources;
	// The runtime's hash list (runtime.lock.json's files).
	readonly files: Readonly<Record<string, string>>;
	readonly abi: string;
	readonly pluginDir: string;
	readonly controlDir: string;
	readonly workRoot: string;
	readonly timeoutMs?: number;
}

export interface ControlResult {
	readonly mode: "none" | "stub";
	readonly outcome: string;
	readonly code: string | null;
	readonly binding: boolean;
	readonly python: string | null;
	readonly exitCode: number | null;
}

export interface SessionResult {
	readonly exitCode: number | null;
	readonly ready: Readonly<Record<string, unknown>> | null;
	readonly bootFailure: Readonly<Record<string, unknown>> | null;
	readonly discoverMs: number | null;
	readonly firstToolsListMs: number | null;
	readonly supportedVersions: readonly string[];
	readonly tools: readonly string[];
	readonly hello: string | null;
	readonly fetch: Readonly<Record<string, unknown>> | null;
	readonly http: Readonly<Record<string, unknown>> | null;
	readonly info: Readonly<Record<string, unknown>> | null;
	readonly hostPathsInPython: boolean;
	readonly legacyCode: number | null;
	readonly brokerRequests: readonly string[];
	readonly wireProblems: readonly string[];
	readonly printLogged: boolean;
	readonly stdoutLines: number;
	readonly stdoutFramesOnly: boolean;
	readonly stderrTail: string;
}

export interface CaseResult {
	readonly node: string;
	readonly variant: Variant["name"];
	readonly argv: readonly string[];
	readonly controls: readonly ControlResult[];
	readonly session: SessionResult;
}

interface Run {
	readonly spec: CaseSpec;
	readonly runtimeDir: string;
	readonly pluginDir: string;
	readonly entry: string;
	readonly entryArgs: readonly string[];
	readonly signal: AbortSignal;
}

// The production path when the shared argv already has the variant's flags; otherwise the same
// steps with the flags added, which is what M0.12's argv would spawn: runtime and bundle checks, the
// link scan, the scrubbed env, the fd-3 host channel, cwd at the plugin dir, no shell.
function launch(run: Run): ChildProcess {
	const { spec, runtimeDir, pluginDir, entry, entryArgs, signal } = run;
	const ids = { pluginId: "py-hello", instanceId: "s11-boot" };
	const dataDir = path.join(spec.workRoot, "data");
	fs.mkdirSync(dataDir, { recursive: true });
	const shim = entry === path.join(runtimeDir, SHIM);
	const finding = verifyRuntime(runtimeDir, spec.files);
	if (finding !== null) throw new RuntimeRefusedError(finding);
	const argvSpec = { runtime: "python", pluginDir, runtimeDir } as const;
	const execArgv = buildExecArgv(argvSpec);
	if (spec.variant.extra.every((flag) => execArgv.includes(flag))) {
		const common = { nodeBin: spec.nodeBin, runtimeDir, pluginDir, dataDir, ...ids, signal };
		if (shim) return spawnPythonPlugin({ ...common, expected: spec.files, abi: spec.abi });
		return spawnPlugin({ ...common, runtime: "python", entry, entryArgs });
	}
	if (shim) checkBundle(pluginDir, spec.abi);
	assertExecArgvAllowed(execArgv);
	const link = preSpawnLinkScan([pluginDir, runtimeDir]);
	if (link !== null) throw new Error(`refusing to spawn: ${link.kind} (${link.path})`);
	const argv = buildArgv(argvSpec, entry, entryArgs);
	argv.splice(execArgv.length, 0, ...spec.variant.extra.filter((flag) => !execArgv.includes(flag)));
	return spawn(spec.nodeBin, argv, {
		env: { ...scrubEnv({ ...ids, dataDir }), ...PLUGIN_CHANNEL_ENV },
		cwd: pluginDir,
		stdio: [...PLUGIN_STDIO],
		windowsHide: true,
		signal,
	});
}

// A fresh link-free copy of the runtime for every spawn; launch checks it against the hash list.
function freshRuntime(spec: CaseSpec): string {
	const dir = path.join(spec.workRoot, `runtime-${randomBytes(4).toString("hex")}`);
	copyRuntime(dir, spec.files, spec.sources);
	return dir;
}

interface Output {
	readonly lines: string[];
	readonly stderr: () => string;
	readonly exit: Promise<number | null>;
}

function watch(child: ChildProcess, onLine: (line: string) => void = () => {}): Output {
	const lines: string[] = [];
	let stderr = "";
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
		lines.push(line);
		onLine(line);
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4_000);
	});
	// "close" comes after the exit and after stdout and the IPC channel have drained.
	const exit = (once(child, "close") as Promise<[number | null]>).then(
		([code]) => code,
		() => null,
	);
	return { lines, stderr: () => stderr, exit };
}

async function runControl(
	spec: CaseSpec,
	mode: ControlResult["mode"],
	signal: AbortSignal,
): Promise<ControlResult> {
	const runtimeDir = freshRuntime(spec);
	try {
		const child = launch({
			spec,
			runtimeDir,
			pluginDir: spec.controlDir,
			entry: path.join(spec.controlDir, "boot-control.mjs"),
			entryArgs: [runtimeDir, spec.controlDir, mode],
			signal,
		});
		const output = watch(child);
		const exitCode = await output.exit;
		const line = output.lines.find((item) => item.startsWith("##DY##"));
		const data = line === undefined ? {} : (JSON.parse(line.slice(6)) as Partial<ControlResult>);
		return {
			mode,
			outcome: data.outcome ?? "crashed",
			code: data.code ?? null,
			binding: data.binding ?? false,
			python: data.python ?? null,
			exitCode,
		};
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
}

export interface Frame {
	readonly jsonrpc?: string;
	readonly id?: unknown;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message?: unknown };
}

const CACHEABLE = new Set(["server/discover", "tools/list"]);

// The 2026-07-28 wire rules the SDK's client enforces when it decodes a result: every result names
// its resultType, server/discover and tools/list carry ttlMs and cacheScope, and each result has
// its method's fields. Returns the rules a frame breaks.
export function wireProblems(method: string, frame: Frame | null): string[] {
	if (frame === null) return [`${method}: no answer`];
	const problems = frame.jsonrpc === "2.0" ? [] : [`${method}: jsonrpc`];
	if (frame.error !== undefined) {
		const { code, message } = frame.error;
		if (!Number.isInteger(code) || typeof message !== "string") problems.push(`${method}: error`);
		return problems;
	}
	const result = frame.result;
	if (result === null || typeof result !== "object" || Array.isArray(result)) {
		return [...problems, `${method}: result`];
	}
	if (result.resultType !== "complete") problems.push(`${method}: resultType`);
	if (CACHEABLE.has(method)) {
		const { ttlMs, cacheScope } = result;
		if (!Number.isInteger(ttlMs) || (ttlMs as number) < 0) problems.push(`${method}: ttlMs`);
		if (cacheScope !== "public" && cacheScope !== "private") problems.push(`${method}: cacheScope`);
	}
	const field = { "server/discover": "supportedVersions", "tools/list": "tools" }[method];
	const list = method === "tools/call" ? "content" : field;
	if (list !== undefined && !Array.isArray(result[list])) problems.push(`${method}: ${list}`);
	return problems;
}

// The broker stub: host/fetch with base64 bodies, as the shim sends and expects them.
function brokerReply(params: Record<string, unknown>): Record<string, unknown> {
	const text = (status: number, body: Buffer, type: string) => ({
		status,
		headers: { "content-type": type },
		bodyBase64: body.toString("base64"),
	});
	const url = String(params.url);
	if (url === FETCH_URL) return text(200, Buffer.from(BROKER_BODY), "text/plain");
	if (url === `${BROKER}/binary`) return text(200, BINARY, "application/octet-stream");
	if (url === `${BROKER}/empty`) return { status: 204, headers: {} };
	if (url === `${BROKER}/echo` && params.method === "POST") {
		return text(
			200,
			Buffer.from(String(params.bodyBase64 ?? ""), "base64"),
			"application/octet-stream",
		);
	}
	return text(403, Buffer.alloc(0), "text/plain");
}

async function runSession(
	spec: CaseSpec,
	signal: AbortSignal,
): Promise<{ argv: string[]; session: SessionResult }> {
	const runtimeDir = freshRuntime(spec);
	try {
		const started = performance.now();
		const child = launch({
			spec,
			runtimeDir,
			pluginDir: spec.pluginDir,
			entry: path.join(runtimeDir, SHIM),
			entryArgs: [spec.pluginDir],
			signal,
		});
		const hide = (arg: string): string =>
			arg.replaceAll(runtimeDir, "<runtimeDir>").replaceAll(spec.pluginDir, "<pluginDir>");
		const argv = child.spawnargs.slice(1).map(hide);
		const waiters = new Map<number, (frame: Frame) => void>();
		const output = watch(child, (line) => {
			try {
				const frame = JSON.parse(line) as Frame;
				if (typeof frame.id === "number") waiters.get(frame.id)?.(frame);
			} catch {
				// a non-frame line; stdoutFramesOnly reports it
			}
		});
		let ready: Record<string, unknown> | null = null;
		let bootFailure: Record<string, unknown> | null = null;
		const brokerRequests: string[] = [];
		const logs: string[] = [];
		serveHostChannel(child, {
			fetch: (params) => {
				brokerRequests.push(`${params.method} ${String(params.url).replace(BROKER, "")}`);
				return brokerReply(params);
			},
			notify: (method, params) => {
				if (method !== "host/log") return;
				logs.push(String(params.message));
				if (params.message === "ready") ready = params.data as Record<string, unknown>;
				if (params.message === "boot failed") bootFailure = params.data as Record<string, unknown>;
			},
		});
		let next = 0;
		const problems: string[] = [];
		const ask = async (method: string, params: object, raw = false): Promise<Frame | null> => {
			const id = ++next;
			const answer = new Promise<Frame>((resolve) => waiters.set(id, resolve));
			const body = raw ? params : { ...params, _meta: ENVELOPE };
			child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: body })}\n`);
			const frame = await Promise.race([answer, output.exit.then(() => null)]);
			problems.push(...wireProblems(method, frame));
			return frame;
		};
		const call = (name: string, args: object) => ask("tools/call", { name, arguments: args });
		const discover = await ask("server/discover", {});
		const discoverMs = discover ? Math.round(performance.now() - started) : null;
		const list = await ask("tools/list", {});
		const firstToolsListMs = list ? Math.round(performance.now() - started) : null;
		const hello = await call("hello", { name: "S11" });
		const fetched = await call("fetch_status", { url: FETCH_URL });
		const http = await call("http_clients", { url: BROKER });
		const info = await call("runtime_info", {});
		const opening = {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "s11", version: "1" },
		};
		const legacy = await ask("initialize", opening, true);
		child.stdin?.end();
		const exitCode = await output.exit;
		const lines = output.lines.filter((line) => line.trim() !== "");
		const isFrame = (line: string): boolean => {
			try {
				const frame = JSON.parse(line) as Frame;
				return frame.jsonrpc === "2.0" && typeof frame.id === "number" && frame.id <= next;
			} catch {
				return false;
			}
		};
		const text = (frame: Frame | null): string | null =>
			(frame?.result?.content as { text?: string }[] | undefined)?.[0]?.text ?? null;
		const structured = (frame: Frame | null): Record<string, unknown> | null =>
			(frame?.result?.structuredContent as Record<string, unknown> | undefined) ?? null;
		const pythonInfo = structured(info);
		const seen = [
			...Object.values((pythonInfo?.environ as Record<string, unknown> | undefined) ?? {}),
			pythonInfo?.executable,
		].map((value) => String(value).toLowerCase());
		const hostPaths = [runtimeDir, spec.pluginDir, spec.workRoot]
			.flatMap((dir) => [dir, dir.replaceAll("\\", "/")])
			.map((dir) => dir.toLowerCase());
		const session: SessionResult = {
			exitCode,
			ready,
			bootFailure,
			discoverMs,
			firstToolsListMs,
			supportedVersions: (discover?.result?.supportedVersions as string[] | undefined) ?? [],
			tools: ((list?.result?.tools as { name: string }[] | undefined) ?? []).map((t) => t.name),
			hello: text(hello),
			fetch: structured(fetched),
			http: structured(http),
			info: pythonInfo,
			hostPathsInPython: seen.some((value) => hostPaths.some((dir) => value.includes(dir))),
			legacyCode: legacy?.error?.code ?? null,
			brokerRequests,
			wireProblems: problems,
			printLogged: logs.some((line) => line.startsWith("hello called for")),
			stdoutLines: lines.length,
			stdoutFramesOnly: lines.every(isFrame),
			stderrTail: output.stderr(),
		};
		return { argv, session };
	} finally {
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
}

export async function runCase(spec: CaseSpec, outer?: AbortSignal): Promise<CaseResult> {
	const timeout = AbortSignal.timeout(spec.timeoutMs ?? 120_000);
	const signal = outer === undefined ? timeout : AbortSignal.any([outer, timeout]);
	const controls: ControlResult[] = [];
	for (const mode of ["none", "stub"] as const) controls.push(await runControl(spec, mode, signal));
	const { argv, session } = await runSession(spec, signal);
	return { node: spec.node, variant: spec.variant.name, argv, controls, session };
}

export interface RefusalResult {
	readonly damage: "missing" | "corrupt";
	readonly exitCode: number | null;
	readonly bootFailure: Readonly<Record<string, unknown>> | null;
	readonly answered: boolean;
}

// Step 3 fails closed on its own: with a lock wheel missing or corrupt and the hub's bundle check
// skipped (spawnPlugin straight away), Pyodide only logs the failure, and the shim must exit
// before serving instead of answering on fd 1.
export async function runRefusal(
	spec: CaseSpec,
	damage: RefusalResult["damage"],
	outer?: AbortSignal,
): Promise<RefusalResult> {
	const signal = AbortSignal.any([
		AbortSignal.timeout(spec.timeoutMs ?? 120_000),
		...(outer ? [outer] : []),
	]);
	const runtimeDir = freshRuntime(spec);
	const pluginDir = path.join(spec.workRoot, `damaged-${randomBytes(4).toString("hex")}`);
	try {
		fs.cpSync(spec.pluginDir, pluginDir, { recursive: true });
		const wheels = path.join(pluginDir, "wheels");
		const victim = path.join(
			wheels,
			fs.readdirSync(wheels).find((name) => !name.startsWith("py_hello")) ?? "",
		);
		if (damage === "missing") fs.rmSync(victim);
		else fs.writeFileSync(victim, "not a wheel");
		const child = spawnPlugin({
			nodeBin: spec.nodeBin,
			runtime: "python",
			runtimeDir,
			pluginDir,
			dataDir: path.join(spec.workRoot, "data"),
			pluginId: "py-hello",
			instanceId: "s11-refusal",
			entry: path.join(runtimeDir, SHIM),
			entryArgs: [pluginDir],
			signal,
		});
		const output = watch(child);
		let bootFailure: Record<string, unknown> | null = null;
		serveHostChannel(child, {
			fetch: brokerReply,
			notify: (_method, params) => {
				if (params.message === "boot failed") bootFailure = params.data as Record<string, unknown>;
			},
		});
		const discover = {
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: { _meta: ENVELOPE },
		};
		child.stdin?.write(`${JSON.stringify(discover)}\n`);
		const exitCode = await output.exit;
		return {
			damage,
			exitCode,
			bootFailure,
			answered: output.lines.some((line) => line.trim() !== ""),
		};
	} finally {
		fs.rmSync(pluginDir, { recursive: true, force: true });
		fs.rmSync(runtimeDir, { recursive: true, force: true });
	}
}
