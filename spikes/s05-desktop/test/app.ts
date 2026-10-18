// What the M0.23b heavy cases share: the app built once per file, the app with its spike-only
// control (--spike-control), the stub hub's L2 port, this OS's processes, and the recording rule.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Fingerprint, fingerprint, skipOrFail } from "@draftyak/spike-kit";
import { expect, type TestContext } from "vitest";
import { type Staged, stageSidecar, tauriDir } from "../tauri-app/scripts/stage-sidecar.ts";

export const spikeDir: string = path.resolve(import.meta.dirname, "..");
export const windows: boolean = process.platform === "win32";
export const targetDir: string = path.join(tauriDir, "target");
const exe = windows ? ".exe" : "";
export const appExe: string = path.join(targetDir, "debug", `draftyak-spike-desktop${exe}`);
/** The bundled Node as Tauri places it beside the app (externalBin, triple removed). */
export const hubNode: string = path.join(targetDir, "debug", `draftyak-node${exe}`);
const execFileAsync = promisify(execFile);

/** Runs a program without a shell and returns its stdout. */
export async function capture(
	command: string,
	args: readonly string[],
	env: Readonly<Record<string, string>> = {},
): Promise<string> {
	const options = {
		env: { ...process.env, ...env },
		timeout: 30_000,
		windowsHide: true,
		maxBuffer: 16 << 20,
	};
	return (await execFileAsync(command, [...args], options)).stdout;
}

// DRAFTYAK_RECORD_EVIDENCE=1 records and 0 doesn't; unset, only CI runs do (S1's rule).
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" || (value === "" && !!env.CI);
}

// One heavy run writes several evidence files, and those written before this one aren't code
// changes, so the tree counts as dirty only outside evidence/ (S1's rule).
export async function codeFingerprint(): Promise<Fingerprint> {
	const print = await fingerprint({ cwd: spikeDir });
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)),
	);
	const args = ["status", "--porcelain", "--untracked-files=no", "--", ":/", ":(exclude)evidence"];
	const status = await execFileAsync("git", args, { cwd: spikeDir, env, windowsHide: true }).catch(
		() => null,
	);
	return { ...print, dirty: status === null ? print.dirty : status.stdout.trim() !== "" };
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
let staging: Promise<Staged> | undefined;

/** Stages and builds the app once per file (cargo finds it up to date after the first). */
export async function built(ctx: TestContext): Promise<Staged> {
	checking ??= run("cargo", ["--version"]).catch(() => undefined);
	if ((await checking)?.code !== 0) {
		skipOrFail(ctx, "no cargo on PATH (Rust from rust-toolchain.toml)");
	}
	staging ??= stageSidecar();
	const staged = await staging;
	building ??= run("cargo", ["build", "--locked"], {
		CARGO_TARGET_DIR: targetDir,
		CARGO_TERM_COLOR: "never",
		...(jobs === undefined ? {} : { CARGO_BUILD_JOBS: jobs }),
	});
	const build = await building;
	expect(build.code, build.output).toBe(0);
	return staged;
}

export interface AppEvent {
	readonly event: string;
	readonly [field: string]: unknown;
}

/** The spike app, reading the JSON line it prints for each event, report and control reply. */
export class App {
	readonly child: ChildProcess;
	readonly events: AppEvent[] = [];
	readonly stderr: string[] = [];
	// Set once the app has exited and its output has ended: no event can come after that.
	private closed = false;

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
		this.child.once("close", () => {
			this.closed = true;
		});
	}

	seen(): string {
		const kinds = this.events.map((event) => event.event).join(", ");
		return `saw ${kinds}\n${this.stderr.join("")}`;
	}

	/** How often `line` appears on stderr once it has appeared `count` times (or 10 s passed). */
	async logged(line: string, count = 1): Promise<number> {
		const times = (): number => this.stderr.join("").split(line).length - 1;
		const deadline = Date.now() + 10_000;
		while (times() < count && Date.now() < deadline) await sleep(50);
		return times();
	}

	async next(wanted: (event: AppEvent) => boolean, timeoutMs: number, from = 0): Promise<AppEvent> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const found = this.events.slice(from).find(wanted);
			if (found) return found;
			if (Date.now() > deadline || this.closed) {
				throw new Error(`no such app event in ${timeoutMs} ms; ${this.seen()}`);
			}
			await sleep(50);
		}
	}

	ready(generation: number): Promise<AppEvent> {
		return this.next((event) => event.event === "ready" && event.generation === generation, 60_000);
	}

	/** The next power report with this action, after event index `from`. */
	power(action: string, from: number, timeoutMs = 30_000): Promise<AppEvent> {
		const wanted = (event: AppEvent): boolean => event.event === "power" && event.action === action;
		return this.next(wanted, timeoutMs, from);
	}

	/** Sends one control command and returns its reply; an error reply fails unless `allowError`. */
	async call(
		command: Readonly<Record<string, string | boolean>>,
		allowError = false,
	): Promise<AppEvent> {
		const from = this.events.length;
		this.child.stdin?.write(`${JSON.stringify(command)}\n`);
		const reply = (event: AppEvent): boolean =>
			event.event === "control" && event.cmd === command.cmd;
		const answer = await this.next(reply, 120_000, from);
		if (!allowError && answer.error !== undefined) {
			throw new Error(`${String(command.cmd)}: ${String(answer.error)}`);
		}
		return answer;
	}

	/** The JSON of a generation's "hub: report" log line. */
	report(generation: number): Record<string, unknown> {
		const prefix = "hub: report ";
		const line = this.events.find(
			(event) =>
				event.event === "log" &&
				event.generation === generation &&
				String(event.line).startsWith(prefix),
		)?.line;
		if (typeof line !== "string") throw new Error(`generation ${generation} sent no report`);
		return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
	}

	/** The exit code, once the app has exited and its last lines are read (at most 5 s later). */
	async exit(timeoutMs: number): Promise<number | null> {
		if (this.child.exitCode === null) {
			const exited = once(this.child, "exit");
			const late = sleep(timeoutMs).then(() => {
				throw new Error(`the app didn't exit within ${timeoutMs} ms; ${this.seen()}`);
			});
			await Promise.race([exited, late]);
		}
		const deadline = Date.now() + 5000;
		while (!this.closed && Date.now() < deadline) await sleep(20);
		return this.child.exitCode;
	}

	/** Ends the app as a crash would: TerminateProcess on Windows, SIGKILL elsewhere. */
	async end(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = once(this.child, "exit");
		this.child.kill("SIGKILL");
		await exited;
	}
}

/** What the stub hub's L2 port answers to one line. */
export function l2(port: number, line: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		const chunks: Buffer[] = [];
		socket.setTimeout(10_000, () => socket.destroy(new Error("the hub's L2 port didn't answer")));
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.once("error", reject).once("close", () => resolve(Buffer.concat(chunks).toString()));
		socket.write(line);
	});
}

/** The running processes by pid, with their command lines (posix) or image names (Windows). */
export async function processes(): Promise<Map<number, string>> {
	if (windows) {
		const stdout = await capture("tasklist", ["/FO", "CSV", "/NH"]);
		const rows = stdout
			.split(/\r?\n/)
			.map((line) => line.slice(1, -1).split('","'))
			.filter((fields) => fields.length >= 2);
		return new Map(rows.map(([image = "", pid = ""]) => [Number(pid), image]));
	}
	const stdout = await capture("ps", ["-A", "-o", "pid=,args="]);
	const rows = stdout.split("\n").map((line) => /^\s*(\d+)\s+(.*)$/.exec(line));
	return new Map(rows.flatMap((row) => (row ? [[Number(row[1]), row[2] ?? ""] as const] : [])));
}

/** Milliseconds until none of the pids runs, or null after timeoutMs. */
export async function goneWithin(
	pids: readonly number[],
	timeoutMs: number,
): Promise<number | null> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const running = await processes();
		if (!pids.some((pid) => running.has(pid))) return Date.now() - started;
		await sleep(200);
	}
	return null;
}

const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const powershell = path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");
const PS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"];

/**
 * Those of `pids` that still run this build's bundled Node (its hubs and their plugins), so a
 * sweep never kills a process that the OS has since given one of their pids.
 */
export async function stillOurs(pids: readonly number[]): Promise<number[]> {
	if (pids.length === 0) return [];
	if (!windows) {
		const running = await processes();
		return pids.filter((pid) => running.get(pid)?.startsWith(hubNode) === true);
	}
	// A wildcard: an exact name that matches nothing makes PowerShell exit 1.
	const list =
		"Get-Process -Name 'draftyak-node*' -ErrorAction SilentlyContinue | " +
		"ForEach-Object { '{0}|{1}' -f $_.Id, $_.Path }";
	const stdout = await capture(powershell, [...PS, list]);
	const node = path.resolve(hubNode).toLowerCase();
	const ours = stdout.split(/\r?\n/).flatMap((line) => {
		const at = line.indexOf("|");
		const exe = line.slice(at + 1).trim();
		return at > 0 && exe !== "" && path.resolve(exe).toLowerCase() === node
			? [Number(line.slice(0, at))]
			: [];
	});
	return pids.filter((pid) => ours.includes(pid));
}

/** Kills what's left of `pids`, ignoring any that already ended; sweeps pass only stillOurs'. */
export function killAll(pids: readonly number[]): void {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}
