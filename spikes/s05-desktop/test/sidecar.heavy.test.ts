// M0.22. On any OS: stage-sidecar, then the supervisor's and keep-awake's Rust tests, rustfmt and
// clippy without the app feature, which need none of Tauri's system libraries. On Windows, the app
// itself: clippy with the app feature; the stub hub alone; the app with no hooks; then the app with
// a plugin, NODE_OPTIONS=--inspect and a hub that ignores stdin EOF and broken pipes: the ready
// frame, the addon loaded from resources, Temporal, the plugin inside the hub's Job Object, a killed
// hub back within 60 s, nothing of this build left once the app is killed, and no second launch on
// its store. On macOS and Linux (M0.23b, run B1 and xvfb): the same app checks, where the hub's
// process group stands in for the Job Object, and what a hub that ignores stdin EOF does there; on
// Linux also clippy with the app feature, and clippy for aarch64-apple-darwin without it, so the
// macOS code builds once before run B1. Evidence (sidecar-<platform>-<arch>.json) is written only
// when asked (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, after every case this host can run passed.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { skipOrFail, writeEvidence } from "@draftyak/spike-kit";
import { buildArgv, buildExecArgv, flagName } from "@draftyak/spike-s02-plugin-sandbox/src/argv.ts";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { type Staged, stageSidecar, tauriDir } from "../tauri-app/scripts/stage-sidecar.ts";
import {
	codeFingerprint,
	hubNode,
	killAll,
	App as PosixApp,
	goneWithin as posixGoneWithin,
	processes as posixProcesses,
	stillOurs,
} from "./app.ts";

const windows = process.platform === "win32";
const linux = process.platform === "linux";
// ci.json's ubuntu run installs this target's standard library, for the clippy before run B1.
const MACOS_TARGET = "aarch64-apple-darwin";
const spikeDir = path.resolve(import.meta.dirname, "..");
const targetDir = path.join(tauriDir, "target");
const appExe = path.join(targetDir, "debug", "draftyak-spike-desktop.exe");
// The macOS and Linux cases need a desktop session (Linux: an X or Wayland display, as xvfb gives).
const posixDesktop =
	process.platform === "darwin" ||
	(process.platform === "linux" && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
const hubScript = path.join(tauriDir, "resources", "hub.mjs");
const LONG = 1_800_000;
// Would open an inspector in any Node that it reached.
const NODE_OPTIONS = "--inspect=127.0.0.1:0";
const ANY_OS = ["rustfmt", "clippy", "cargoTest"] as const;
const ON_WINDOWS = [
	"build",
	"clippyApp",
	"hub",
	"plainApp",
	"app",
	"restart",
	"appEnded",
	"reuseRefused",
] as const;
const ON_POSIX = ["posixApp", "posixRestart", "posixAppEnded", "posixIgnoredEof"] as const;
const ON_LINUX = ["clippyApp", "macosClippy"] as const;
type Case =
	| (typeof ANY_OS)[number]
	| (typeof ON_WINDOWS)[number]
	| (typeof ON_POSIX)[number]
	| (typeof ON_LINUX)[number];

// Windows flag values, named for the evidence.
const CREATION_FLAGS = { CREATE_SUSPENDED: 0x4, CREATE_NO_WINDOW: 0x0800_0000 };
const JOB_LIMIT_FLAGS = {
	JOB_OBJECT_LIMIT_BREAKAWAY_OK: 0x800,
	JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK: 0x1000,
	JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: 0x2000,
};
const BREAKAWAY = JOB_LIMIT_FLAGS.JOB_OBJECT_LIMIT_BREAKAWAY_OK;
const SILENT_BREAKAWAY = JOB_LIMIT_FLAGS.JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;

function flagNames(value: number, names: Readonly<Record<string, number>>): string[] {
	const set = Object.entries(names).filter(([, bit]) => (value & bit) !== 0);
	const rest = set.reduce((left, [, bit]) => left & ~bit, value);
	return [...set.map(([name]) => name), ...(rest === 0 ? [] : [`0x${rest.toString(16)}`])];
}

// A plugin that reports its exec argv over the IPC channel, then ignores the channel closing and
// stdin EOF, so only a kill ends it; it gives up by itself after ten minutes.
const PLUGIN = `process.send({ execArgv: process.execArgv });
process.on("disconnect", () => {});
process.stdin.on("data", () => {});
process.stdin.on("end", () => {});
setInterval(() => {}, 60_000);
setTimeout(() => process.exit(3), 600_000);
`;

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs do (S1's rule).
function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// The environment with `overrides` in place of any variable of the same name in any letter case.
function withEnv(
	base: NodeJS.ProcessEnv,
	overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
	const names = new Set(Object.keys(overrides).map((name) => name.toUpperCase()));
	const kept = Object.entries(base).filter(([name]) => !names.has(name.toUpperCase()));
	return { ...Object.fromEntries(kept), ...overrides };
}

interface Run {
	readonly code: number;
	readonly output: string;
	readonly ms: number;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Run> {
	const started = performance.now();
	const child = spawn(command, args, {
		cwd: tauriDir,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const output: string[] = [];
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
	return new Promise((resolve, reject) => {
		child.once("error", reject).once("exit", (code) => {
			const ms = Math.round(performance.now() - started);
			const done = (): void => resolve({ code: code ?? -1, output: output.join(""), ms });
			// A process the command left behind could hold its pipes open forever.
			const late = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				output.push("\n(output cut: a leftover process held the pipes open)\n");
				done();
			}, 10_000);
			child.once("close", () => {
				clearTimeout(late);
				done();
			});
		});
	});
}

// Twelve items share the dev box, so cargo gets a quarter of its CPUs there unless
// CARGO_BUILD_JOBS says otherwise; CI runners get all of theirs.
const jobs =
	process.env.CARGO_BUILD_JOBS ??
	(process.env.CI ? undefined : String(Math.max(2, Math.floor(os.availableParallelism() / 4))));
const cargo = (args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Run> =>
	run("cargo", args, {
		CARGO_TARGET_DIR: targetDir,
		CARGO_TERM_COLOR: "never",
		...(jobs === undefined ? {} : { CARGO_BUILD_JOBS: jobs }),
		...env,
	});

function testCounts(output: string): { readonly passed: number; readonly failed: number } {
	const results = [...output.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)];
	const sum = (at: 1 | 2): number => results.reduce((total, match) => total + Number(match[at]), 0);
	return { passed: sum(1), failed: sum(2) };
}

const execFileAsync = promisify(execFile);

// Image name by pid, from tasklist's CSV rows ("image","pid","session","#","memory").
async function processes(): Promise<Map<number, string>> {
	const options = { windowsHide: true, maxBuffer: 16 << 20 };
	const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], options);
	const rows = stdout
		.split(/\r?\n/)
		.map((line) => line.slice(1, -1).split('","'))
		.filter((fields) => fields.length >= 2);
	return new Map(rows.map(([image = "", pid = ""]) => [Number(pid), image]));
}

// The running draftyak-node* processes with their executables, which tasklist doesn't show.
async function draftyakNodes(): Promise<{ readonly pid: number; readonly exe: string }[]> {
	const system = process.env.SystemRoot ?? "C:\\Windows";
	const powershell = path.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const list =
		"Get-Process -Name 'draftyak-node*' -ErrorAction SilentlyContinue | " +
		"ForEach-Object { '{0}|{1}' -f $_.Id, $_.Path }";
	const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", list];
	const { stdout } = await execFileAsync(powershell, args, { windowsHide: true });
	return stdout
		.split(/\r?\n/)
		.filter((line) => line.includes("|"))
		.map((line) => {
			const at = line.indexOf("|");
			return { pid: Number(line.slice(0, at)), exe: line.slice(at + 1) };
		});
}

const inside = (dir: string, file: string): boolean => {
	const relative = path.relative(dir.toLowerCase(), file.toLowerCase());
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// Milliseconds until none of the pids runs, or null after timeoutMs.
async function goneWithin(pids: readonly number[], timeoutMs: number): Promise<number | null> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const running = await processes();
		if (!pids.some((pid) => running.has(pid))) return Date.now() - started;
		await sleep(200);
	}
	return null;
}

const sha256 = (file: string): string =>
	createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function frame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value));
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.length);
	return Buffer.concat([head, body]);
}

// Every complete frame in bytes, and how many bytes are left over.
function frames(bytes: Buffer): { readonly frames: unknown[]; readonly rest: number } {
	const found: unknown[] = [];
	let at = 0;
	while (bytes.length - at >= 4 && bytes.length - at - 4 >= bytes.readUInt32BE(at)) {
		const length = bytes.readUInt32BE(at);
		found.push(JSON.parse(bytes.subarray(at + 4, at + 4 + length).toString("utf8")));
		at += 4 + length;
	}
	return { frames: found, rest: bytes.length - at };
}

interface AppEvent {
	readonly event: string;
	readonly generation?: number;
	readonly pid?: number;
	readonly [field: string]: unknown;
}

interface HubReport {
	readonly temporal: string;
	readonly temporalNow: string;
	readonly execArgv: readonly string[];
	readonly nodeOptions: string | null;
	readonly inspector: string | null;
	readonly env: readonly string[];
	readonly ignoresStdinEof: boolean;
	readonly addon: {
		readonly target: string;
		readonly fromResources: boolean;
		readonly napiVersion: number;
		readonly sqliteVersion: string;
		readonly sqlite3mcVersion: string;
		readonly encrypted: boolean;
	};
	readonly plugin: { readonly pid: number; readonly execArgv: readonly string[] } | null;
}

// The spike app, reading the JSON line it prints for each supervisor event.
class App {
	readonly child: ChildProcess;
	readonly events: AppEvent[] = [];
	readonly otherLines: string[] = [];
	readonly stderr: string[] = [];

	constructor(env: NodeJS.ProcessEnv) {
		this.child = spawn(appExe, [], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		if (!this.child.stdout || !this.child.stderr) throw new Error("the app's output isn't piped");
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			const event = App.parse(line);
			if (event) this.events.push(event);
			else this.otherLines.push(line);
		});
		this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => this.stderr.push(chunk));
	}

	static parse(line: string): AppEvent | null {
		try {
			const value: unknown = JSON.parse(line);
			const event = value as AppEvent | null;
			return typeof event?.event === "string" ? event : null;
		} catch {
			return null;
		}
	}

	private seen(): string {
		const kinds = this.events.map((event) => event.event).join(", ");
		const other =
			this.otherLines.length > 0 ? `\nother stdout:\n${this.otherLines.join("\n")}` : "";
		return `saw ${kinds}${other}\n${this.stderr.join("")}`;
	}

	async next(wanted: (event: AppEvent) => boolean, timeoutMs: number): Promise<AppEvent> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.find(wanted);
			if (found) return found;
			if (Date.now() > deadline || this.child.exitCode !== null) {
				throw new Error(`no such app event in ${timeoutMs} ms; ${this.seen()}`);
			}
			await sleep(50);
		}
	}

	ready(generation: number): Promise<AppEvent> {
		return this.next((event) => event.event === "ready" && event.generation === generation, 60_000);
	}

	report(generation: number): HubReport {
		const prefix = "hub: report ";
		const line = this.events.find(
			(event) =>
				event.event === "log" &&
				event.generation === generation &&
				String(event.line).startsWith(prefix),
		)?.line;
		if (typeof line !== "string") throw new Error(`generation ${generation} sent no report`);
		return JSON.parse(line.slice(prefix.length)) as HubReport;
	}

	pids(): number[] {
		const ids = this.events.flatMap((event) => [
			event.pid,
			...((event.contained as number[]) ?? []),
		]);
		return [...new Set(ids.filter((pid): pid is number => typeof pid === "number"))];
	}

	async exit(timeoutMs: number): Promise<number | null> {
		if (this.child.exitCode !== null) return this.child.exitCode;
		const exited = once(this.child, "exit").then(([code]) => code as number | null);
		const late = sleep(timeoutMs).then(() => {
			throw new Error(`the app didn't exit within ${timeoutMs} ms; ${this.seen()}`);
		});
		return Promise.race([exited, late]);
	}

	async end(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = once(this.child, "exit");
		this.child.kill();
		await exited;
	}
}

let checking: Promise<Run | undefined> | undefined;
let staging: Promise<Staged> | undefined;
let building: Promise<Run> | undefined;
let staged: Staged | undefined;
let root = "";
let pluginDir = "";
let pluginData = "";
let pluginArgv: string[] = [];
let app: App | undefined;
const apps: App[] = [];
const strays: number[] = [];
const results: Partial<Record<Case, Record<string, unknown>>> = {};

// Stages once per run, after checking that cargo is there.
async function stage(ctx: TestContext): Promise<Staged> {
	checking ??= run("cargo", ["--version"], {}).catch(() => undefined);
	if ((await checking)?.code !== 0) {
		skipOrFail(ctx, "no cargo on PATH (Rust from rust-toolchain.toml)");
	}
	staging ??= stageSidecar();
	staged = await staging;
	return staged;
}

// The app with its default features, built once for every Windows case.
async function built(ctx: TestContext): Promise<void> {
	await stage(ctx);
	building ??= cargo(["build", "--locked"]);
	const build = await building;
	expect(build.code, build.output).toBe(0);
	results.build ??= { ms: build.ms };
}

function launch(env: NodeJS.ProcessEnv): App {
	const launched = new App(env);
	apps.push(launched);
	return launched;
}

afterAll(async () => {
	if (!staged || !recording()) return;
	const posix = linux ? [...ON_POSIX, ...ON_LINUX] : ON_POSIX;
	const host = windows ? ON_WINDOWS : posixDesktop ? posix : [];
	const planned: readonly Case[] = [...ANY_OS, ...host];
	const missing = planned.filter((name) => !(name in results));
	if (missing.length > 0) {
		console.warn(`evidence not recorded: ${missing.join(", ")} didn't pass`);
		return;
	}
	const file = path.join(spikeDir, "evidence", `sidecar-${staged.prebuild.target}.json`);
	const written = await writeEvidence(file, evidence(staged), {
		fingerprint: await codeFingerprint(),
	});
	console.log(`evidence: ${path.relative(spikeDir, written)}`);
}, 120_000);

describe("S5b supervisor on any OS, without the app feature", () => {
	it("rustfmt --check is clean", async (ctx) => {
		await stage(ctx);
		const fmt = await cargo(["fmt", "--check"]);
		expect(fmt.code, fmt.output).toBe(0);
		results.rustfmt = { clean: true };
	});

	it("cargo clippy --no-default-features --all-targets -- -D warnings is clean", {
		timeout: LONG,
	}, async (ctx) => {
		await stage(ctx);
		const args = ["clippy", "--locked", "--no-default-features", "--all-targets"];
		const clippy = await cargo([...args, "--", "-D", "warnings"]);
		expect(clippy.code, clippy.output).toBe(0);
		expect(clippy.output).not.toMatch(/^(?:warning|error)/m);
		results.clippy = { clean: true, features: "none", allTargets: true, ms: clippy.ms };
	});

	it("cargo test passes (frames, policy, health probe, environment, restarts, Job Object, keep-awake)", {
		timeout: LONG,
	}, async (ctx) => {
		await stage(ctx);
		const env = { NODE_OPTIONS };
		const tests = await cargo(["test", "--locked", "--no-default-features"], env);
		expect(tests.code, tests.output).toBe(0);
		const { passed, failed } = testCounts(tests.output);
		expect(failed).toBe(0);
		expect(passed).toBeGreaterThanOrEqual(windows ? 23 : 21);
		results.cargoTest = { passed, features: "none", nodeOptionsSet: true, ms: tests.ms };
	});
});

describe("S5b app on Windows", { tags: ["requires:windows"] }, () => {
	beforeAll(() => {
		if (!windows) return;
		// A real path, as on macOS and Linux below: a junction or link above it would deny the plugin.
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s05-")));
		pluginDir = path.join(root, "plugin");
		pluginData = path.join(root, "plugin-data");
		fs.mkdirSync(pluginDir);
		fs.mkdirSync(pluginData);
		const entry = path.join(pluginDir, "plugin.mjs");
		fs.writeFileSync(entry, PLUGIN);
		pluginArgv = buildArgv({ pluginDir, dataDir: pluginData }, entry);
	});

	afterAll(async () => {
		for (const launched of apps) await launched.end();
		const running = windows ? await processes() : new Map<number, string>();
		for (const pid of [...strays, ...apps.flatMap((launched) => launched.pids())]) {
			if (running.get(pid)?.startsWith("draftyak-node")) process.kill(pid);
		}
		if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}, 120_000);

	it("cargo clippy --all-targets -- -D warnings is clean with the app feature", {
		timeout: LONG,
	}, async (ctx) => {
		await built(ctx);
		const clippy = await cargo(["clippy", "--locked", "--all-targets", "--", "-D", "warnings"]);
		expect(clippy.code, clippy.output).toBe(0);
		expect(clippy.output).not.toMatch(/^(?:warning|error)/m);
		results.clippyApp = { clean: true, features: "app", allTargets: true, ms: clippy.ms };
	});

	it("the hub alone writes only frames on stdout and exits on stdin EOF", async (ctx) => {
		await built(ctx);
		const data = path.join(root, "hub-data");
		fs.mkdirSync(data);
		const hub = spawn(staged?.node ?? "", ["--disable-sigusr1", hubScript], {
			env: { ...process.env, DRAFTYAK_DATA_DIR: data },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		if (hub.pid) strays.push(hub.pid);
		const exited = once(hub, "exit");
		let stdout = Buffer.alloc(0);
		hub.stdout.on("data", (chunk: Buffer) => {
			stdout = Buffer.concat([stdout, chunk]);
		});
		const stderr: string[] = [];
		hub.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
		hub.stdin.write(frame({ masterKey: "ab".repeat(32), bootstrapSecret: "cd".repeat(16) }));
		const deadline = Date.now() + 60_000;
		while (frames(stdout).frames.length === 0 && Date.now() < deadline) await sleep(50);
		const [ready] = frames(stdout).frames as Record<string, unknown>[];
		expect(ready).toMatchObject({
			ready: true,
			hubId: expect.stringMatching(/^DYK(-[0-9A-Z]{4}){4}$/),
		});
		expect(ready?.l2Port).toBeGreaterThan(0);
		const closed = Date.now();
		hub.stdin.end();
		const [code] = (await Promise.race([exited, sleep(10_000).then(() => [null])])) as [
			number | null,
		];
		const eofExitMs = Date.now() - closed;
		expect(code).toBe(0);
		const all = frames(stdout);
		expect(all.frames).toHaveLength(1);
		expect(all.rest).toBe(0);
		expect(stderr.join("")).toMatch(/^hub: stopping \(stdin closed\)$/m);
		results.hub = {
			frames: Object.keys(ready ?? {}),
			strayStdoutBytes: all.rest,
			exitCode: code,
			eofExitMs,
		};
	});

	it("with no hooks the app reaches ready, its store in a new folder under the OS temp folder", async (ctx) => {
		await built(ctx);
		const temp = path.join(root, "temp");
		fs.mkdirSync(temp);
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !/^DRAFTYAK_/i.test(name)),
		);
		const plain = launch(withEnv(env, { TEMP: temp, TMP: temp }));
		const ready = await plain.ready(1);
		const report = plain.report(1);
		expect(report.plugin).toBeNull();
		expect(report.addon).toMatchObject({ fromResources: true, encrypted: true });
		expect(report.env.filter((name) => /^DRAFTYAK_/i.test(name))).toEqual(["DRAFTYAK_DATA_DIR"]);
		const stores = fs
			.readdirSync(temp)
			.filter((name) => name.startsWith("draftyak-spike-desktop-"));
		expect(stores).toHaveLength(1);
		expect(fs.existsSync(path.join(temp, stores[0] ?? "", "hub.db"))).toBe(true);
		await plain.end();
		expect(await goneWithin(plain.pids(), 10_000)).not.toBeNull();
		results.plainApp = { readyMs: ready.afterMs, storeFolders: stores.length, hooks: 0 };
	});

	it("the app sends ready; the addon loads from resources; Temporal; the plugin is in the job; no NODE_OPTIONS in the hub", async (ctx) => {
		await built(ctx);
		const appData = path.join(root, "app-data");
		fs.mkdirSync(appData);
		app = launch(
			withEnv(process.env, {
				DRAFTYAK_DATA_DIR: appData,
				DRAFTYAK_SPIKE_PLUGIN_ARGV: JSON.stringify(pluginArgv),
				DRAFTYAK_SPIKE_IGNORE_EOF: "1",
				NODE_OPTIONS,
			}),
		);
		const started = await app.next((event) => event.event === "started", 60_000);
		const spawned = await app.next((event) => event.event === "spawned", 60_000);
		const ready = await app.ready(1);
		const report = app.report(1);
		expect(started).toMatchObject({
			healthEveryMs: 10_000,
			backoffMinMs: 1_000,
			backoffMaxMs: 60_000,
			maxRestarts: 5,
			restartWindowMs: 300_000,
		});
		const { CREATE_SUSPENDED, CREATE_NO_WINDOW } = CREATION_FLAGS;
		const killOnClose = JOB_LIMIT_FLAGS.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
		expect(spawned).toMatchObject({
			creationFlags: CREATE_SUSPENDED | CREATE_NO_WINDOW,
			jobLimitFlags: killOnClose,
			resumedThreads: 1,
			suspendCount: 1,
		});
		expect(ready.hubId).toMatch(/^DYK(-[0-9A-Z]{4}){4}$/);
		expect(ready.l2Port).toBeGreaterThan(0);
		expect(report.temporal).toBe("object");
		expect(report.temporalNow).toBe("function");
		expect(report.execArgv).toEqual(["--disable-sigusr1"]);
		expect([report.nodeOptions, report.inspector]).toEqual([null, null]);
		expect(report.env.filter((name) => /^(?:NODE_|PATH$)/i.test(name))).toEqual([]);
		expect(report.ignoresStdinEof).toBe(true);
		const target = staged?.prebuild.target;
		expect(report.addon).toMatchObject({ target, fromResources: true, encrypted: true });
		const loaded = path.join(targetDir, "debug", "resources", "prebuilds", `${target}.node`);
		expect(sha256(loaded)).toBe(staged?.prebuild.sha256);
		const plugin = report.plugin;
		expect(plugin?.execArgv).toEqual(buildExecArgv({ pluginDir, dataDir: pluginData }));
		const contained = ready.contained as number[];
		expect(contained).toEqual(expect.arrayContaining([ready.pid, plugin?.pid]));
		const running = await processes();
		expect(running.get(ready.pid ?? 0)).toBe("draftyak-node.exe");
		expect(running.get(plugin?.pid ?? 0)).toBe("draftyak-node.exe");
		const jobLimits = Number(spawned.jobLimitFlags);
		results.app = {
			readyMs: ready.afterMs,
			policy: Object.fromEntries(Object.entries(started).filter(([key]) => key !== "event")),
			spawn: {
				creationFlags: flagNames(Number(spawned.creationFlags), CREATION_FLAGS),
				jobLimitFlags: flagNames(jobLimits, JOB_LIMIT_FLAGS),
				breakawayAllowed: (jobLimits & (BREAKAWAY | SILENT_BREAKAWAY)) !== 0,
			},
			resume: {
				method: "Toolhelp32 thread snapshot, then ResumeThread",
				why: "ChildExt::main_thread_handle is unstable in Rust 1.95 (rust-lang/rust#96723)",
				threads: spawned.resumedThreads,
				previousSuspendCount: spawned.suspendCount,
			},
			contained: contained.map((pid) => running.get(pid) ?? "exited").sort(),
			temporal: report.temporal,
			temporalNowInstant: report.temporalNow,
			hubExecArgv: report.execArgv,
			hubEnv: report.env,
			appNodeOptionsFlags: NODE_OPTIONS.split(" ").map(flagName),
			hubNodeOptions: report.nodeOptions,
			hubInspector: report.inspector,
			addon: { ...report.addon, sameBytesAsPackage: true },
			pluginExecArgvFlags: (plugin?.execArgv ?? []).map(flagName),
			pluginExecArgvIsBuildArgv: true,
		};
	});

	it("a killed hub is back within 60 s with the same hubId", { timeout: 120_000 }, async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const first = await app.ready(1);
		const firstPlugin = app.report(1).plugin?.pid ?? 0;
		const killed = Date.now();
		process.kill(first.pid ?? 0);
		const exited = await app.next(
			(event) => event.event === "exited" && event.generation === 1,
			30_000,
		);
		const restarting = await app.next((event) => event.event === "restarting", 30_000);
		const second = await app.ready(2);
		const backMs = Date.now() - killed;
		expect(backMs).toBeLessThan(60_000);
		expect(restarting.delayMs).toBe(1000);
		expect(second.hubId).toBe(first.hubId);
		const firstGoneMs = await goneWithin([firstPlugin, ...(first.contained as number[])], 10_000);
		expect(firstGoneMs).not.toBeNull();
		const report = app.report(2);
		expect(second.contained).toEqual(expect.arrayContaining([second.pid, report.plugin?.pid]));
		results.restart = {
			killedHubExitCode: exited.code,
			delayMs: restarting.delayMs,
			backMs,
			hubIdStable: true,
			firstGenerationGoneMs: firstGoneMs,
		};
	});

	it("killing the app ends its hub, which ignores stdin EOF and broken pipes, and the plugin; nothing of this build is left", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const second = await app.ready(2);
		const report = app.report(2);
		expect(report.ignoresStdinEof).toBe(true);
		const plugin = report.plugin?.pid ?? 0;
		const ours = [...new Set([second.pid ?? 0, plugin, ...(second.contained as number[])])];
		expect((await processes()).get(plugin)).toBe("draftyak-node.exe");
		await app.end();
		const goneMs = await goneWithin(ours, 10_000);
		expect(goneMs).not.toBeNull();
		const left = (await draftyakNodes()).filter(({ exe }) => inside(tauriDir, exe));
		expect(left).toEqual([]);
		results.appEnded = {
			how: "TerminateProcess",
			hubIgnoredStdinEofAndBrokenPipes: true,
			goneMs,
			ourProcessesLeft: 0,
			draftyakNodeOfThisBuildLeft: left.length,
		};
	});

	it("a second launch on the same store folder is refused", async (ctx) => {
		await built(ctx);
		const appData = path.join(root, "app-data");
		expect(fs.existsSync(path.join(appData, "hub.db"))).toBe(true);
		const again = launch(withEnv(process.env, { DRAFTYAK_DATA_DIR: appData }));
		const code = await again.exit(60_000);
		expect(code).not.toBe(0);
		expect(again.stderr.join("")).toMatch(/holds a store from an earlier launch/);
		expect(again.events.filter((event) => event.event === "spawned")).toEqual([]);
		results.reuseRefused = { exitCode: code, hubsSpawned: 0 };
	});
});

// The same checks where there is no Job Object: the hub leads its own process group, which a
// restart and Quit kill, and a hub that sees stdin EOF ends its plugin itself.
describe("S5b app on macOS and Linux", {
	tags: ["requires:posix", "requires:tauri-desktop"],
}, () => {
	const launched: PosixApp[] = [];
	let posixRoot = "";
	let first: PosixApp | undefined;

	function start(env: Readonly<Record<string, string>>): PosixApp {
		const store = fs.mkdtempSync(path.join(posixRoot, "store-"));
		const started = new PosixApp([], {
			...process.env,
			DRAFTYAK_DATA_DIR: store,
			DRAFTYAK_SPIKE_PLUGIN_ARGV: JSON.stringify(pluginArgv),
			NODE_OPTIONS,
			...env,
		});
		launched.push(started);
		return started;
	}

	// Ours: each hub and plugin a launch reported.
	const ours = (app: PosixApp): number[] =>
		app.events.flatMap((event) => {
			if (event.event !== "ready") return [];
			const plugin = app.report(Number(event.generation)).plugin as { pid?: number } | null;
			return [Number(event.pid), ...(plugin?.pid ? [plugin.pid] : [])];
		});

	// This build's draftyak-node processes, by the path they run from.
	const thisBuildsHubs = async (): Promise<number[]> =>
		[...(await posixProcesses())].flatMap(([pid, args]) => (args.startsWith(hubNode) ? [pid] : []));

	beforeAll(() => {
		if (windows) return;
		// A real path: macOS's /var/folders runs through a link, which the plugin's read grant
		// wouldn't cover (ADR 0003).
		posixRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s05-posix-")));
		pluginDir = path.join(posixRoot, "plugin");
		pluginData = path.join(posixRoot, "plugin-data");
		fs.mkdirSync(pluginDir);
		fs.mkdirSync(pluginData);
		const entry = path.join(pluginDir, "plugin.mjs");
		fs.writeFileSync(entry, PLUGIN);
		pluginArgv = buildArgv({ pluginDir, dataDir: pluginData }, entry);
	});

	afterAll(async () => {
		for (const app of launched) await app.end();
		killAll(await stillOurs(launched.flatMap(ours)));
		if (posixRoot) fs.rmSync(posixRoot, { recursive: true, force: true, maxRetries: 10 });
	}, 120_000);

	// The xvfb runner has Tauri's Linux packages; CI's full job, without a display, has none.
	it("cargo clippy --all-targets -- -D warnings is clean with the app feature", {
		tags: ["requires:linux"],
		timeout: LONG,
	}, async (ctx) => {
		await built(ctx);
		const clippy = await cargo(["clippy", "--locked", "--all-targets", "--", "-D", "warnings"]);
		expect(clippy.code, clippy.output).toBe(0);
		expect(clippy.output).not.toMatch(/^(?:warning|error)/m);
		results.clippyApp = { clean: true, features: "app", allTargets: true, ms: clippy.ms };
	});

	// Run B1 bills macOS minutes tenfold, so the code without the app feature (the supervisor and
	// keep-awake with its macOS layer) is first linted for macOS here. Tauri's macOS crates need
	// Apple's SDK, so the app feature first builds for macOS in run B1.
	it(`cargo clippy --no-default-features --all-targets for ${MACOS_TARGET} is clean`, {
		tags: ["requires:linux"],
		timeout: LONG,
	}, async (ctx) => {
		await stage(ctx);
		const libdir = await run("rustc", ["--print", "target-libdir", "--target", MACOS_TARGET], {});
		const dir = libdir.output.trim().split(/\r?\n/).at(-1) ?? "";
		if (libdir.code !== 0 || dir === "" || !fs.existsSync(dir)) {
			skipOrFail(ctx, `Rust's ${MACOS_TARGET} standard library isn't installed (ci.json adds it)`);
		}
		const args = ["clippy", "--locked", "--no-default-features", "--all-targets"];
		const clippy = await cargo([...args, "--target", MACOS_TARGET, "--", "-D", "warnings"]);
		expect(clippy.code, clippy.output).toBe(0);
		expect(clippy.output).not.toMatch(/^(?:warning|error)/m);
		results.macosClippy = {
			clean: true,
			target: MACOS_TARGET,
			features: "none",
			allTargets: true,
			ms: clippy.ms,
		};
	});

	it("the app sends ready; the addon loads from resources; Temporal; the plugin runs; no NODE_OPTIONS in the hub", async (ctx) => {
		await built(ctx);
		first = start({});
		const ready = await first.ready(1);
		const report = first.report(1) as unknown as HubReport;
		expect(ready.hubId).toMatch(/^DYK(-[0-9A-Z]{4}){4}$/);
		expect(report.temporal).toBe("object");
		expect(report.temporalNow).toBe("function");
		expect(report.execArgv).toEqual(["--disable-sigusr1"]);
		expect([report.nodeOptions, report.inspector]).toEqual([null, null]);
		expect(report.env.filter((name) => /^(?:NODE_|PATH$)/.test(name))).toEqual([]);
		const target = staged?.prebuild.target;
		expect(report.addon).toMatchObject({ target, fromResources: true, encrypted: true });
		const loaded = path.join(targetDir, "debug", "resources", "prebuilds", `${target}.node`);
		expect(sha256(loaded)).toBe(staged?.prebuild.sha256);
		expect(report.plugin?.execArgv).toEqual(buildExecArgv({ pluginDir, dataDir: pluginData }));
		const running = await posixProcesses();
		expect(running.get(Number(ready.pid))?.startsWith(hubNode)).toBe(true);
		expect(running.get(report.plugin?.pid ?? 0)?.startsWith(hubNode)).toBe(true);
		results.posixApp = {
			readyMs: ready.afterMs,
			processGroup: "the hub leads its own (process_group(0))",
			temporal: report.temporal,
			temporalNowInstant: report.temporalNow,
			hubExecArgv: report.execArgv,
			hubEnv: report.env,
			hubNodeOptions: report.nodeOptions,
			hubInspector: report.inspector,
			addon: { ...report.addon, sameBytesAsPackage: true },
			pluginExecArgvIsBuildArgv: true,
		};
	});

	it("a killed hub is back within 60 s with the same hubId, and its plugin ends", {
		timeout: 120_000,
	}, async (ctx) => {
		await built(ctx);
		if (!first) throw new Error("the app didn't start");
		const ready = await first.ready(1);
		const plugin = (first.report(1).plugin as { pid: number }).pid;
		const killed = Date.now();
		killAll([Number(ready.pid)]);
		const exited = await first.next((e) => e.event === "exited" && e.generation === 1, 30_000);
		const restarting = await first.next((event) => event.event === "restarting", 30_000);
		const again = await first.ready(2);
		const backMs = Date.now() - killed;
		expect(backMs).toBeLessThan(60_000);
		expect(restarting.delayMs).toBe(1000);
		expect(again.hubId).toBe(ready.hubId);
		const pluginGoneMs = await posixGoneWithin([plugin], 10_000);
		expect(pluginGoneMs).not.toBeNull();
		results.posixRestart = {
			killedHubExit: exited.code ?? "signal",
			delayMs: restarting.delayMs,
			backMs,
			hubIdStable: true,
			firstPluginGoneMs: pluginGoneMs,
		};
	});

	it("killing the app ends its hub on stdin EOF, and the hub ends its plugin; nothing of this build is left", async (ctx) => {
		await built(ctx);
		if (!first) throw new Error("the app didn't start");
		await first.ready(2);
		const pids = ours(first);
		await first.end();
		const goneMs = await posixGoneWithin(pids, 10_000);
		expect(goneMs).not.toBeNull();
		expect(await thisBuildsHubs()).toEqual([]);
		results.posixAppEnded = {
			how: "SIGKILL",
			hubEndedOn: "stdin EOF",
			goneMs,
			ourProcessesLeft: 0,
			draftyakNodeOfThisBuildLeft: 0,
		};
	});

	// Recorded for ADR 0007, not a pass condition: nothing outside the hub ends it when the app dies.
	it("a hub that ignores stdin EOF and broken pipes outlives a killed app here", async (ctx) => {
		await built(ctx);
		const stubborn = start({ DRAFTYAK_SPIKE_IGNORE_EOF: "1" });
		await stubborn.ready(1);
		const pids = ours(stubborn);
		await stubborn.end();
		await sleep(3000);
		const left = await stillOurs(pids);
		killAll(left);
		expect(await posixGoneWithin(pids, 10_000)).not.toBeNull();
		expect(await thisBuildsHubs()).toEqual([]);
		results.posixIgnoredEof = {
			how: "SIGKILL of the app, then 3 s",
			hubOutlivedApp: left.includes(pids[0] ?? -1),
			pluginOutlivedApp: pids.slice(1).some((pid) => left.includes(pid)),
			endedAfterwardsBy: "the test",
		};
	});
});

function locked(crate: string): string {
	const lock = fs.readFileSync(path.join(tauriDir, "Cargo.lock"), "utf8");
	const packages = lock
		.split("[[package]]")
		.map((entry) => /name = "(.+)"\s+version = "(.+)"/.exec(entry));
	return packages.find((match) => match?.[1] === crate)?.[2] ?? "unknown";
}

function evidence(staged: Staged): Record<string, unknown> {
	return {
		target: staged.prebuild.target,
		triple: staged.triple,
		versions: {
			nodeVersion: staged.nodeVersion,
			tauriVersion: locked("tauri"),
			tauriBuildVersion: locked("tauri-build"),
		},
		...results,
	};
}
