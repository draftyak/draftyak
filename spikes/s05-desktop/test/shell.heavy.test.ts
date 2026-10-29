// M0.23a on Windows, through the app's spike-only control (`--spike-control`): the tray holds Open
// and Quit (in Tauri, in the native menu and in the shell); Open, picked with the WM_COMMAND the
// tray menu sends, shows the main window, and closing it keeps the hub running; enabling autostart
// creates the HKCU Run value named after the spike's identifier and disabling removes it (with the
// Task Manager entry the plugin leaves behind), and enabling while elevated is refused; the
// Rust-driven approval-window checks pass; Quit stops the hub and the app, and nothing of the
// approval origin reaches the disk; on a normal launch, Quit closes the windows at once and removes
// the launch's store. On macOS and Linux (M0.23b's run B1 and xvfb run): the tray with Open and
// Quit in Tauri's menu (the native menu belongs to the OS), Open's main window on the app's own
// origin, closing it keeping the hub running, Quit stopping the hub, and autostart's LaunchAgents
// plist or autostart .desktop file. The approval window's checks and the store's removal at Quit
// run on WebView2 only. Evidence (shell-<platform>-<arch>.json) is written only when asked
// (DRAFTYAK_RECORD_EVIDENCE=1) or in CI, after every case this host plans passed.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { acquireBenchLock, cacheDir, skipOrFail } from "@draftyak/spike-kit";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { type Staged, stageSidecar, tauriDir } from "../tauri-app/scripts/stage-sidecar.ts";
import { goneWithin, App as Launched, stillOurs, writeCodeEvidence } from "./app.ts";

const spikeDir = path.resolve(import.meta.dirname, "..");
const targetDir = path.join(tauriDir, "target");
const windows = process.platform === "win32";
const appExe = path.join(targetDir, "debug", `draftyak-spike-desktop${windows ? ".exe" : ""}`);
const IDENTIFIER = "com.draftyak.spike.desktop";
const LONG = 1_800_000;
const CASES = [
	"tray",
	"mainWindow",
	"closeKeepsHub",
	"autostart",
	"approval",
	"quit",
	"quitRemovesStore",
] as const;
type Case = (typeof CASES)[number];
// The approval checks and the store's removal run on WebView2 only.
const PLANNED: readonly Case[] = windows
	? CASES
	: ["tray", "mainWindow", "closeKeepsHub", "autostart", "quit"];
// A Quit that leaves WebView2 holding the store waits out the store removal's 5 s deadline.
const QUIT_WITHIN_MS = 4000;

const execFileAsync = promisify(execFile);
const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
const PS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs do (S1's rule).
function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

interface Run {
	readonly code: number;
	readonly output: string;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Run> {
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
		child.once("error", reject).once("close", (code) => {
			resolve({ code: code ?? -1, output: output.join("") });
		});
	});
}

// Twelve items share the dev box, so cargo gets a quarter of its CPUs there unless
// CARGO_BUILD_JOBS says otherwise; CI runners get all of theirs.
const jobs =
	process.env.CARGO_BUILD_JOBS ??
	(process.env.CI ? undefined : String(Math.max(2, Math.floor(os.availableParallelism() / 4))));

let checking: Promise<Run | undefined> | undefined;
let building: Promise<Run> | undefined;
let staged: Staged | undefined;

// Stages and builds the app once per run (sidecar.heavy.test.ts may have built it already).
async function built(ctx: TestContext): Promise<void> {
	checking ??= run("cargo", ["--version"]).catch(() => undefined);
	if ((await checking)?.code !== 0) {
		skipOrFail(ctx, "no cargo on PATH (Rust from rust-toolchain.toml)");
	}
	staged ??= await stageSidecar();
	building ??= run("cargo", ["build", "--locked"], {
		CARGO_TARGET_DIR: targetDir,
		CARGO_TERM_COLOR: "never",
		...(jobs === undefined ? {} : { CARGO_BUILD_JOBS: jobs }),
	});
	const build = await building;
	expect(build.code, build.output).toBe(0);
}

// The registry keys that can hold a value named after the identifier.
const RUN = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
const APPROVED = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`;
const MACHINE_RUN = String.raw`HKLM\Software\Microsoft\Windows\CurrentVersion\Run`;
const KEYS = [RUN, APPROVED, MACHINE_RUN] as const;
// What auto-launch 0.6.0 writes under StartupApproved: "enabled" in Task Manager's format.
const APPROVED_DATA = `02${"0".repeat(22)}`;

interface Value {
	readonly type: string;
	readonly data: string;
}

const KINDS: Readonly<Record<string, string>> = {
	String: "REG_SZ",
	ExpandString: "REG_EXPAND_SZ",
	Binary: "REG_BINARY",
};
// For each key, the value named after the identifier as "<kind> <base64 of its bytes>", or "-".
// reg.exe prints in the console's code page, which garbles a path outside ASCII.
const READ_VALUES = [
	"foreach ($key in $env:DY_KEYS.Split('|')) {",
	"$item = Get-Item -LiteralPath ('Registry::' + $key) -ErrorAction SilentlyContinue;",
	"if ($null -eq $item -or $item.GetValueNames() -notcontains $env:DY_NAME) { '-'; continue };",
	"$raw = $item.GetValue($env:DY_NAME, $null, 'DoNotExpandEnvironmentNames');",
	"$bytes = if ($raw -is [byte[]]) { $raw } else { [Text.Encoding]::UTF8.GetBytes([string]$raw) };",
	"$item.GetValueKind($env:DY_NAME).ToString() + ' ' + [Convert]::ToBase64String($bytes) }",
].join(" ");

// The value named after the identifier under each key, read through .NET's registry API.
async function regValues(keys: readonly string[] = KEYS): Promise<(Value | null)[]> {
	const env = { ...process.env, DY_KEYS: keys.join("|"), DY_NAME: IDENTIFIER };
	const options = { windowsHide: true, env };
	const { stdout } = await execFileAsync(powershell, [...PS, READ_VALUES], options);
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	if (lines.length !== keys.length) throw new Error(`can't read the registry: ${stdout}`);
	return lines.map((line) => {
		if (line === "-") return null;
		const [kind = "", base64 = ""] = line.split(" ");
		const bytes = Buffer.from(base64, "base64");
		const type = KINDS[kind] ?? `REG_${kind.toUpperCase()}`;
		const data = type === "REG_BINARY" ? bytes.toString("hex").toUpperCase() : bytes.toString();
		return { type, data };
	});
}

async function regDelete(key: string): Promise<void> {
	const reg = path.join(system32, "reg.exe");
	await execFileAsync(reg, ["delete", key, "/v", IDENTIFIER, "/f"], { windowsHide: true });
}

// The Run value this build's autostart writes: the unquoted path and the argument.
const ourRun = (value: Value | null | undefined): boolean =>
	value?.type === "REG_SZ" && value.data.toLowerCase() === `${appExe} --minimized`.toLowerCase();
const ourApproval = (value: Value | null | undefined): boolean =>
	value?.type === "REG_BINARY" && value.data === APPROVED_DATA;

// Removes the two values this test creates, and only if they hold what it writes.
async function forgetOurAutostart(): Promise<string[]> {
	const removed: string[] = [];
	const [run, approved] = await regValues([RUN, APPROVED]);
	if (ourRun(run)) {
		await regDelete(RUN);
		removed.push("Run");
	}
	if (ourApproval(approved) && (ourRun(run) || !run)) {
		await regDelete(APPROVED);
		removed.push("StartupApproved");
	}
	return removed;
}

// Image name by pid, from tasklist's CSV rows.
async function processes(): Promise<Map<number, string>> {
	const options = { windowsHide: true, maxBuffer: 16 << 20 };
	const { stdout } = await execFileAsync("tasklist", ["/FO", "CSV", "/NH"], options);
	const rows = stdout
		.split(/\r?\n/)
		.map((line) => line.slice(1, -1).split('","'))
		.filter((fields) => fields.length >= 2);
	return new Map(rows.map(([image = "", pid = ""]) => [Number(pid), image]));
}

// Ids of the running processes named `image` whose command line contains `needle`.
async function processesWith(image: string, needle: string): Promise<number[]> {
	const list =
		"Get-CimInstance Win32_Process -Filter \"Name = '$env:DY_IMAGE'\" | " +
		"Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:DY_NEEDLE) } | " +
		"ForEach-Object { $_.ProcessId }";
	const env = { ...process.env, DY_IMAGE: image, DY_NEEDLE: needle };
	const { stdout } = await execFileAsync(powershell, [...PS, list], { windowsHide: true, env });
	return stdout.split(/\r?\n/).filter(Boolean).map(Number);
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms: number): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (ok(value) || Date.now() > deadline) return value;
		await sleep(250);
	}
}

interface Traces {
	readonly paths: string[];
	readonly files: string[];
}

// What below `dir` names `host` in its path (Chromium names per-origin folders after the origin, as
// in IndexedDB/http_approval.localhost_0.indexeddb.leveldb), and the files whose bytes hold it as
// UTF-8, UTF-16LE or UTF-16BE. Compressed or encrypted bytes can still hide it, so the second
// approval window's empty stores remain the stronger check.
function traces(dir: string, host: string): Traces {
	if (!fs.existsSync(dir)) return { paths: [], files: [] };
	const names = [host, host.replaceAll(".", "_")];
	const utf16 = Buffer.from(host, "utf16le");
	const needles = [Buffer.from(host), utf16, Buffer.from(utf16).swap16()];
	const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
		const full = path.join(entry.parentPath, entry.name);
		return { entry, full, relative: path.relative(dir, full) };
	});
	const holds = (file: string): boolean => {
		try {
			const bytes = fs.readFileSync(file);
			return needles.some((needle) => bytes.includes(needle));
		} catch {
			return false;
		}
	};
	return {
		paths: entries
			.filter(({ relative }) => names.some((name) => relative.toLowerCase().includes(name)))
			.map(({ relative }) => relative),
		files: entries
			.filter(({ entry, full }) => entry.isFile() && holds(full))
			.map(({ relative }) => relative),
	};
}

interface AppEvent {
	readonly event: string;
	readonly [field: string]: unknown;
}

interface Command {
	readonly cmd: string;
	readonly [field: string]: string | boolean;
}

// The spike app with its test control, reading the JSON line it prints for each event and reply.
class App {
	readonly child: ChildProcess;
	readonly events: AppEvent[] = [];
	readonly stderr: string[] = [];

	constructor(args: readonly string[], env: NodeJS.ProcessEnv) {
		this.child = spawn(appExe, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		if (!this.child.stdout || !this.child.stderr) throw new Error("the app's output isn't piped");
		createInterface({ input: this.child.stdout }).on("line", (line) => {
			try {
				const value = JSON.parse(line) as AppEvent;
				if (typeof value?.event === "string") this.events.push(value);
			} catch {
				// Not one of the app's JSON lines.
			}
		});
		this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => this.stderr.push(chunk));
	}

	private seen(): string {
		const kinds = this.events.map((event) => event.event).join(", ");
		return `saw ${kinds}\n${this.stderr.join("")}`;
	}

	async next(wanted: (event: AppEvent) => boolean, timeoutMs: number, from = 0): Promise<AppEvent> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.slice(from).find(wanted);
			if (found) return found;
			if (Date.now() > deadline || this.child.exitCode !== null) {
				throw new Error(`no such app event in ${timeoutMs} ms; ${this.seen()}`);
			}
			await sleep(50);
		}
	}

	// Sends one control command and returns its reply, the next "control" line for that command.
	async send(command: Command, timeoutMs = 120_000): Promise<AppEvent> {
		const from = this.events.length;
		this.child.stdin?.write(`${JSON.stringify(command)}\n`);
		const reply = (event: AppEvent): boolean =>
			event.event === "control" && event.cmd === command.cmd;
		return this.next(reply, timeoutMs, from);
	}

	// As send, for a command that must succeed.
	async call(command: Command, timeoutMs = 120_000): Promise<AppEvent> {
		const reply = await this.send(command, timeoutMs);
		if (reply.error !== undefined) throw new Error(`${command.cmd}: ${String(reply.error)}`);
		return reply;
	}

	async windows(): Promise<Record<string, unknown>[]> {
		return (await this.call({ cmd: "windows" })).windows as Record<string, unknown>[];
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

let root = "";
let data = "";
let app: App | undefined;
const apps: App[] = [];
let appDataExisted = true;
const results: Partial<Record<Case, Record<string, unknown>>> = {};
const localAppData = path.join(process.env.LOCALAPPDATA ?? os.homedir(), IDENTIFIER);

function launch(args: readonly string[], env: NodeJS.ProcessEnv): App {
	const launched = new App(args, env);
	apps.push(launched);
	return launched;
}

afterAll(async () => {
	if (!staged || !recording()) return;
	const missing = PLANNED.filter((name) => !(name in results));
	if (missing.length > 0) {
		console.warn(`evidence not recorded: ${missing.join(", ")} didn't pass`);
		return;
	}
	const file = path.join(spikeDir, "evidence", `shell-${staged.prebuild.target}.json`);
	const data = {
		target: staged.prebuild.target,
		versions: {
			tauriVersion: locked("tauri"),
			tauriPluginAutostartVersion: locked("tauri-plugin-autostart"),
			autoLaunchVersion: locked("auto-launch"),
			trayIconVersion: locked("tray-icon"),
			npmPluginAutostartVersion: "2.7.0",
			npmApiVersion: "2.12.4",
		},
		...results,
	};
	const written = await writeCodeEvidence(file, data);
	console.log(`evidence: ${path.relative(spikeDir, written)}`);
}, 120_000);

describe("S5c tray, autostart and approval window on Windows", {
	tags: ["requires:windows", "requires:tauri-desktop"],
}, () => {
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s05-shell-"));
		data = path.join(root, "app-data");
		appDataExisted = fs.existsSync(localAppData);
	});

	// The autostart case removes its registry values itself, even when it fails.
	afterAll(async () => {
		for (const launched of apps) await launched.end();
		const running = await processes();
		const pids = apps.flatMap((launched) =>
			launched.events.flatMap((event) => [event.pid, ...((event.contained as number[]) ?? [])]),
		);
		for (const pid of pids) {
			if (typeof pid === "number" && running.get(pid)?.startsWith("draftyak-node"))
				process.kill(pid);
		}
		if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	}, 120_000);

	it("starts in the tray, as autostart starts it, with Open and Quit in Tauri, the native menu and the shell", {
		timeout: LONG,
	}, async (ctx) => {
		await built(ctx);
		const temp = path.join(root, "temp");
		fs.mkdirSync(temp);
		app = launch(["--minimized", "--spike-control"], {
			...process.env,
			DRAFTYAK_DATA_DIR: data,
			TEMP: temp,
			TMP: temp,
		});
		await app.next((event) => event.event === "ready", 60_000);
		expect((await app.windows()).length).toBe(0);
		const tray = await app.call({ cmd: "tray" });
		expect(tray).toMatchObject({
			id: "draftyak",
			items: [
				{ id: "open", text: "Open" },
				{ id: "quit", text: "Quit" },
			],
			shellHoldsIcon: true,
		});
		const native = tray.native as { text: string; command: number }[];
		expect(native.map((item) => item.text)).toEqual(["Open", "Quit"]);
		expect(native.every((item) => Number.isInteger(item.command) && item.command > 0)).toBe(true);
		results.tray = {
			startedWithWindows: 0,
			items: ["Open", "Quit"],
			nativeMenuItems: native.map((item) => item.text),
			shellHoldsIcon: true,
			rectReported: tray.rect,
		};
	});

	it("Open, picked from the tray menu, shows the main window on the app's own origin", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const click = await app.call({ cmd: "click", item: "open" });
		expect(click.via).toBe("WM_COMMAND");
		const windows = await until(
			() => app?.windows() ?? Promise.resolve([]),
			(found) => found.some((window) => window.label === "main" && window.visible === true),
			30_000,
		);
		expect(windows).toEqual([
			{ label: "main", visible: true, origin: "http://tauri.localhost", path: "/" },
		]);
		expect(fs.existsSync(path.join(data, "webview", "main", "EBWebView"))).toBe(true);
		const version = (await app.call({ cmd: "windows" })).webviewVersion;
		results.mainWindow = {
			openedVia: "tray menu WM_COMMAND",
			origin: "http://tauri.localhost",
			webviewDataInLaunchStore: true,
			webviewVersion: version,
		};
	});

	it("closing the main window keeps the app and the hub running; Open brings it back", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const ready = await app.next((event) => event.event === "ready", 1000);
		const from = app.events.length;
		await app.call({ cmd: "close", label: "main" });
		expect(await app.windows()).toEqual([]);
		await sleep(2000);
		expect(app.child.exitCode).toBeNull();
		expect((await processes()).get(Number(ready.pid))).toBe("draftyak-node.exe");
		const ended = app.events
			.slice(from)
			.filter((event) => /^(exited|restarting|stopped)$/.test(event.event));
		expect(ended).toEqual([]);
		await app.call({ cmd: "click", item: "open" });
		const back = await until(
			() => app?.windows() ?? Promise.resolve([]),
			(found) => found.some((window) => window.label === "main" && window.visible === true),
			30_000,
		);
		expect(back.map((window) => window.label)).toEqual(["main"]);
		results.closeKeepsHub = { appRunning: true, hubGenerationUnchanged: true, reopened: true };
	});

	it("enabling autostart creates the HKCU Run value named after the identifier; disabling removes it", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		// One autostart test at a time on this machine, whichever worktree runs it.
		using _lock = await acquireBenchLock({
			path: path.join(cacheDir(), "locks", "s05-autostart.lock"),
			label: "s05 autostart (HKCU Run)",
			idle: false,
			signal: ctx.signal,
		});
		const leftovers = await forgetOurAutostart();
		const before = await regValues();
		expect(before, "values of that name that this test didn't create are left alone").toEqual([
			null,
			null,
			null,
		]);
		try {
			const status = await app.call({ cmd: "autostart", action: "status" });
			expect(status).toMatchObject({ enabled: false });
			// The guard's refusal, which a box that isn't elevated reaches only by pretending.
			const enable = { cmd: "autostart", action: "enable" };
			const refused = await app.send({ ...enable, pretendElevated: status.elevated !== true });
			expect(String(refused.error)).toMatch(/^refused: the app runs elevated/);
			expect(await regValues()).toEqual([null, null, null]);
			expect(await app.call({ cmd: "autostart", action: "status" })).toMatchObject({
				enabled: false,
			});
			const guard = { refusedWhileElevated: true, registryUnchanged: true };
			if (status.elevated === true) {
				results.autostart = { elevated: true, guard: { ...guard, elevationPretended: false } };
				return;
			}
			const enabled = await app.call(enable);
			expect(enabled).toMatchObject({ enabled: true, elevated: false });
			const [run, approved, machineRun] = await regValues();
			expect(run?.type).toBe("REG_SZ");
			expect(ourRun(run), run?.data).toBe(true);
			expect(machineRun).toBeNull();
			const npmEnabled = await app.call({ cmd: "npm-autostart" });
			expect(npmEnabled.enabled).toBe(true);

			const disabled = await app.call({ cmd: "autostart", action: "disable" });
			expect(disabled).toMatchObject({ enabled: false });
			expect(await regValues()).toEqual([null, null, null]);
			const npmDisabled = await app.call({ cmd: "npm-autostart" });
			expect(npmDisabled.enabled).toBe(false);
			results.autostart = {
				elevated: false,
				guard: { ...guard, elevationPretended: true },
				leftoversOfEarlierRunsRemoved: leftovers.length,
				enabled: {
					runValue: "HKCU Run",
					valueName: IDENTIFIER,
					valueType: run?.type,
					pointsToThisBuild: true,
					argument: "--minimized",
					pathQuoted: run?.data.startsWith('"') ?? false,
					startupApprovedWritten: ourApproval(approved),
					machineRunValue: false,
					readThroughNpmPackage: true,
				},
				disabled: {
					runValueRemoved: true,
					startupApprovedLeftByPlugin: disabled.leftBehind,
					startupApprovedRemoved: true,
					readThroughNpmPackage: false,
				},
			};
		} finally {
			// Every value of that name was absent before, so whatever is there now is this test's.
			const left = await regValues();
			for (const [index, key] of KEYS.entries()) {
				if (left[index] !== null) await regDelete(key);
			}
		}
	});

	it("the approval window passes the Rust-driven checks: origin, service worker, storage, capability, CSP", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const report = await app.call({ cmd: "approval" });
		const checks = report.checks as Record<string, boolean>;
		expect(checks).toEqual({
			originsDiffer: true,
			noServiceWorker: true,
			noStorage: true,
			onlyItsCapability: true,
			cspEnforced: true,
			servedOnlyToItself: true,
			navigationPinned: true,
		});
		expect(report.pass).toBe(true);
		expect(report.origins).toEqual({
			main: "http://tauri.localhost",
			approval: "http://approval.localhost",
		});
		const first = report.firstWindow as Record<string, Record<string, unknown>>;
		const second = report.secondWindow as Record<string, Record<string, unknown>>;
		const main = report.mainPage as Record<string, Record<string, unknown>>;
		const worker = first.page?.serviceWorker as Record<string, unknown>;
		expect(worker).toMatchObject({ api: true, registrations: 0, controlled: false });
		// What refused a probe, from the browser's or Tauri's message.
		const refusedBy = (outcome: unknown): string => {
			const message = (outcome as { refused?: string } | undefined)?.refused;
			if (message === undefined) return "allowed";
			if (/requires 'Trusted\w+' assignment/.test(message)) return "trusted-types";
			if (/Content Security Policy/.test(message)) return "csp";
			if (/not allowed/.test(message)) return "capability";
			if (/Failed to fetch/.test(message)) return "fetch-blocked";
			return "other";
		};
		const empty = { localStorage: 0, sessionStorage: 0, cookie: "", indexedDB: [], caches: 0 };
		expect(first.page?.storage).toEqual(empty);
		expect(second.page?.storage).toEqual(empty);
		expect(first.written).toMatchObject({ localStorage: 1, indexedDB: 1, cookie: true });
		expect(main.autostartViaNpm).toEqual({ ok: false });
		expect(String(main.approvalReady?.refused)).toMatch(
			/approval_ready not allowed on window "main"/,
		);
		const approvalAutostart = first.page?.autostart as { refused?: string } | undefined;
		expect(String(approvalAutostart?.refused)).toMatch(/not allowed on window "approval"/);
		expect(refusedBy(worker.register)).toBe("trusted-types");
		expect(refusedBy(first.page?.trustedTypes)).toBe("trusted-types");
		expect(refusedBy(first.page?.eval)).toBe("csp");
		expect(refusedBy(main.autostartDisable)).toBe("capability");
		expect(report.readyCallers).toEqual(Array(4).fill("approval"));
		const served = report.served as { label: string; path: string; status: number }[];
		const answered = (label: string): string[] =>
			served
				.filter((entry) => entry.label === label)
				.map((entry) => `${entry.path} ${entry.status}`);
		expect(new Set(answered("approval"))).toEqual(
			new Set(["/approval.html 200", "/approval.js 200"]),
		);
		expect(answered("foreign")).toContain("/approval.html 403");
		expect(answered("foreign").every((entry) => entry.endsWith(" 403"))).toBe(true);
		expect(served.every((entry) => ["approval", "foreign"].includes(entry.label))).toBe(true);
		expect(report.refusedNavigations).toEqual(["http://tauri.localhost/index.html"]);
		results.approval = {
			checks,
			origins: report.origins,
			secureContext: first.page?.secureContext,
			serviceWorker: {
				api: true,
				registerRefusedBy: refusedBy(worker.register),
				registrations: 0,
				controlled: false,
			},
			storage: {
				firstWindowEmpty: true,
				writtenInFirstWindow: first.written,
				secondWindowEmpty: true,
				rustCookies: [first.cookies, second.cookies],
				incognito: true,
				ownDataFolder: true,
			},
			capability: {
				approvalReadyFromApproval: refusedBy(first.page?.approvalReady),
				approvalReadyFromMain: refusedBy(main.approvalReady),
				autostartReadFromApproval: refusedBy(first.page?.autostart),
				autostartDisableFromMain: refusedBy(main.autostartDisable),
				autostartReadFromMainViaNpm: refusedBy(main.autostartViaNpm),
			},
			csp: {
				innerHtmlRefusedBy: refusedBy(first.page?.trustedTypes),
				evalRefusedBy: refusedBy(first.page?.eval),
				mainFetchOfApprovalPage: refusedBy(main.fetchApproval),
				mainFetchReachedProtocol: served.some((entry) => entry.label === "main"),
			},
			protocol: {
				status200OnlyTo: "approval",
				otherLabel: { label: "foreign", navigationPinned: false, ownCsp: false, status: 403 },
			},
			navigation: {
				toMainOrigin: "refused by on_navigation",
				refusedOrigin: "http://tauri.localhost",
				stayedOnApprovalOrigin: true,
			},
			mainCookiesSet: main.cookies,
			served: served.length,
		};
	});

	it("Quit, picked from the tray menu, stops the hub and exits; nothing of the approval origin reached the disk", async (ctx) => {
		await built(ctx);
		if (!app) throw new Error("the app didn't start");
		const ready = await app.next((event) => event.event === "ready", 1000);
		const click = await app.call({ cmd: "click", item: "quit" });
		expect(click.via).toBe("WM_COMMAND");
		const code = await app.exit(60_000);
		expect(code).toBe(0);
		const exited = await app.next((event) => event.event === "exited", 1000);
		expect(exited).toMatchObject({ generation: 1, code: 0 });
		await app.next((event) => event.event === "stopped", 1000);
		const stopping = app.events.some(
			(event) => event.event === "log" && event.line === "hub: stopping (shutdown frame)",
		);
		expect(stopping).toBe(true);
		const ours = [Number(ready.pid), ...((ready.contained as number[]) ?? [])];
		const running = await processes();
		expect(ours.filter((pid) => running.get(pid)?.startsWith("draftyak-node"))).toEqual([]);
		const webviews = await until(
			() => processesWith("msedgewebview2.exe", path.join(data, "webview")),
			(pids) => pids.length === 0,
			30_000,
		);
		expect(webviews).toEqual([]);
		const approvalDir = path.join(data, "webview", "approval");
		expect(fs.existsSync(approvalDir)).toBe(true);
		expect(traces(approvalDir, "approval.localhost")).toEqual({ paths: [], files: [] });
		// The positive control: the main window's own origin does reach its folder.
		const main = traces(path.join(data, "webview", "main"), "tauri.localhost");
		expect(main.paths.length + main.files.length).toBeGreaterThan(0);
		expect(fs.existsSync(localAppData)).toBe(appDataExisted);
		results.quit = {
			pickedVia: "tray menu WM_COMMAND",
			appExitCode: code,
			hubExitCode: exited.code,
			hubStoppedOnShutdownFrame: true,
			draftyakNodeLeft: 0,
			webviewProcessesLeft: 0,
			approvalOriginOnDisk: {
				pathsNamingIt: 0,
				filesHoldingIt: 0,
				searched: "paths, and file bytes as UTF-8, UTF-16LE and UTF-16BE",
			},
			mainOriginOnDisk: { pathsNamingIt: main.paths.length, filesHoldingIt: main.files.length },
			appDataFolderCreated: false,
		};
	});

	it("on a normal launch, Quit closes both windows at once and removes the launch's store", async (ctx) => {
		await built(ctx);
		const temp = path.join(root, "plain-temp");
		fs.mkdirSync(temp);
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !/^DRAFTYAK_/i.test(name)),
		);
		const plain = launch(["--spike-control"], { ...env, TEMP: temp, TMP: temp });
		const ready = await plain.next((event) => event.event === "ready", 60_000);
		const stores = (): string[] =>
			fs.readdirSync(temp).filter((name) => name.startsWith("draftyak-spike-desktop-"));
		expect(stores()).toHaveLength(1);
		const store = path.join(temp, stores()[0] ?? "");
		await plain.call({ cmd: "click", item: "open" });
		await until(
			() => plain.windows(),
			(found) => found.some((window) => window.label === "main" && window.visible === true),
			30_000,
		);
		await plain.call({ cmd: "open", label: "approval" });
		expect((await plain.windows()).map((window) => window.label)).toEqual(["approval", "main"]);
		const folders = fs.readdirSync(path.join(store, "webview")).toSorted();
		expect(folders).toEqual(["approval", "main"]);
		const picked = Date.now();
		await plain.call({ cmd: "click", item: "quit" });
		const code = await plain.exit(60_000);
		const exitMs = Date.now() - picked;
		expect(code).toBe(0);
		expect(stores()).toEqual([]);
		expect(exitMs).toBeLessThan(QUIT_WITHIN_MS);
		const webviews = await until(
			() => processesWith("msedgewebview2.exe", store),
			(pids) => pids.length === 0,
			10_000,
		);
		expect(webviews).toEqual([]);
		expect((await processes()).get(Number(ready.pid))?.startsWith("draftyak-node")).not.toBe(true);
		results.quitRemovesStore = {
			store: "new folder under the OS temp folder",
			windowsOpen: folders,
			pickedVia: "tray menu WM_COMMAND",
			appExitCode: code,
			exitMs,
			storeLeft: false,
			webviewProcessesLeft: 0,
		};
	});
});

describe("S5c tray, Open and Quit on macOS and Linux", {
	tags: ["requires:posix", "requires:tauri-desktop"],
}, () => {
	let posix: Launched | undefined;
	let home = "";
	const windowsOf = async (app?: Launched): Promise<Record<string, unknown>[]> =>
		app ? ((await app.call({ cmd: "windows" })).windows as Record<string, unknown>[]) : [];

	beforeAll(() => {
		if (windows) return;
		home = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s05-tray-"));
	});

	afterAll(async () => {
		await posix?.end();
		if (home) fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}, 120_000);

	it("starts in the tray, as autostart starts it, with Open and Quit", {
		timeout: LONG,
	}, async (ctx) => {
		await built(ctx);
		posix = new Launched(["--minimized", "--spike-control"], {
			...process.env,
			DRAFTYAK_DATA_DIR: path.join(home, "app-data"),
		});
		await posix.next((event) => event.event === "ready", 60_000);
		expect(await windowsOf(posix)).toEqual([]);
		const tray = await posix.call({ cmd: "tray" });
		expect(tray).toMatchObject({
			id: "draftyak",
			items: [
				{ id: "open", text: "Open" },
				{ id: "quit", text: "Quit" },
			],
			native: null,
			shellHoldsIcon: null,
		});
		results.tray = {
			startedWithWindows: 0,
			items: ["Open", "Quit"],
			rectReported: tray.rect,
		};
	});

	it("Open shows the main window on the app's own origin", async (ctx) => {
		await built(ctx);
		if (!posix) throw new Error("the app didn't start");
		const click = await posix.call({ cmd: "click", item: "open" });
		expect(click.via).toBe("handler");
		const opened = await until(
			() => windowsOf(posix),
			(found) => found.some((window) => window.label === "main" && window.visible === true),
			30_000,
		);
		// tauri://localhost has no path of its own, so the path is whatever the webview reports.
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatchObject({ label: "main", visible: true, origin: "tauri://localhost" });
		const version = (await posix.call({ cmd: "windows" })).webviewVersion;
		results.mainWindow = {
			openedVia: "tray menu handler",
			origin: "tauri://localhost",
			path: opened[0]?.path,
			webviewVersion: version,
		};
	});

	it("closing the main window keeps the app and the hub running; Open brings it back", async (ctx) => {
		await built(ctx);
		if (!posix) throw new Error("the app didn't start");
		const ready = await posix.next((event) => event.event === "ready", 1000);
		const from = posix.events.length;
		await posix.call({ cmd: "close", label: "main" });
		expect(await windowsOf(posix)).toEqual([]);
		await sleep(2000);
		expect(posix.child.exitCode).toBeNull();
		expect(await stillOurs([Number(ready.pid)])).toEqual([Number(ready.pid)]);
		const ended = posix.events
			.slice(from)
			.filter((event) => /^(exited|restarting|stopped)$/.test(event.event));
		expect(ended).toEqual([]);
		await posix.call({ cmd: "click", item: "open" });
		const back = await until(
			() => windowsOf(posix),
			(found) => found.some((window) => window.label === "main" && window.visible === true),
			30_000,
		);
		expect(back.map((window) => window.label)).toEqual(["main"]);
		results.closeKeepsHub = { appRunning: true, hubGenerationUnchanged: true, reopened: true };
	});

	it("Quit stops the hub and exits", async (ctx) => {
		await built(ctx);
		if (!posix) throw new Error("the app didn't start");
		const ready = await posix.next((event) => event.event === "ready", 1000);
		await posix.call({ cmd: "click", item: "quit" });
		expect(await posix.exit(60_000)).toBe(0);
		const exited = await posix.next((event) => event.event === "exited", 1000);
		expect(exited).toMatchObject({ generation: 1, code: 0 });
		await posix.next((event) => event.event === "stopped", 1000);
		const stopping = posix.events.some(
			(event) => event.event === "log" && event.line === "hub: stopping (shutdown frame)",
		);
		expect(stopping).toBe(true);
		expect(await goneWithin([Number(ready.pid)], 10_000)).not.toBeNull();
		results.quit = {
			pickedVia: "tray menu handler",
			appExitCode: 0,
			hubExitCode: exited.code,
			hubStoppedOnShutdownFrame: true,
			draftyakNodeLeft: 0,
		};
	});

	// auto-launch 0.6.0 writes below $HOME, so a temporary HOME keeps the user's own LaunchAgents and
	// autostart folders out of reach.
	it("enabling autostart writes the plist or .desktop file named after the identifier; disabling removes it", {
		timeout: LONG,
	}, async (ctx) => {
		await built(ctx);
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "dy-s05-home-"));
		const macos = process.platform === "darwin";
		// A real home always has ~/Library, and auto-launch 0.6.0 creates only LaunchAgents below
		// it (a single-level fs::create_dir).
		if (macos) fs.mkdirSync(path.join(home, "Library"));
		const entry = macos
			? path.join(home, "Library", "LaunchAgents", `${IDENTIFIER}.plist`)
			: path.join(home, ".config", "autostart", `${IDENTIFIER}.desktop`);
		const posix = new App(["--minimized", "--spike-control"], {
			...process.env,
			HOME: home,
			DRAFTYAK_DATA_DIR: path.join(home, "app-data"),
		});
		try {
			await posix.next((event) => event.event === "ready", 60_000);
			expect(await posix.call({ cmd: "autostart", action: "status" })).toMatchObject({
				enabled: false,
			});
			const enabled = await posix.call({ cmd: "autostart", action: "enable" });
			expect(enabled).toMatchObject({ enabled: true, elevated: false, leftBehind: null });
			const text = fs.readFileSync(entry, "utf8");
			const exe = fs.realpathSync(appExe);
			if (macos) {
				expect(text).toContain(`<key>Label</key>\n  <string>${IDENTIFIER}</string>`);
				const args = `<array><string>${exe}</string><string>--minimized</string></array>`;
				expect(text).toContain(args);
			} else {
				expect(text.split("\n")).toContain(`Exec=${exe} --minimized`);
			}
			const disabled = await posix.call({ cmd: "autostart", action: "disable" });
			expect(disabled).toMatchObject({ enabled: false, leftBehind: null });
			expect(fs.existsSync(entry)).toBe(false);
			await posix.call({ cmd: "click", item: "quit" });
			expect(await posix.exit(60_000)).toBe(0);
			results.autostart = {
				entry: macos ? "LaunchAgents plist" : "XDG autostart .desktop file",
				namedAfterIdentifier: true,
				argument: "--minimized",
				removedOnDisable: true,
			};
		} finally {
			await posix.end();
			fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	});
});

function locked(crate: string): string {
	const lock = fs.readFileSync(path.join(tauriDir, "Cargo.lock"), "utf8");
	const packages = lock
		.split("[[package]]")
		.map((entry) => /name = "(.+)"\s+version = "(.+)"/.exec(entry));
	return packages.find((match) => match?.[1] === crate)?.[2] ?? "unknown";
}
