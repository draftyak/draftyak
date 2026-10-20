import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";
import {
	beginCapture,
	CaptureError,
	type CaptureFailure,
	type EvidenceDirectory,
	type NativeCaptureResult,
	sealCapture,
} from "./evidence.ts";

export type { NativeCaptureResult } from "./evidence.ts";
export const MAX_CAPTURE_MS = 600_000;
export interface NativeCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly deadlineMs: number;
}
const ENVIRONMENT = new Set([
	"SystemRoot",
	"SYSTEMROOT",
	"PATH",
	"HOME",
	"USERPROFILE",
	"TEMP",
	"TMP",
	"TMPDIR",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"RUSTUP_TOOLCHAIN",
	"CARGO_NET_OFFLINE",
	"CARGO_TERM_COLOR",
	"NO_COLOR",
]);
// Node supplies these Windows defaults from its own environment when keys are absent.
// Explicit empty values prevent that fallback; only reviewed caller entries override them.
const WINDOWS_DEFAULTS = [
	"HOMEDRIVE",
	"HOMEPATH",
	"LOGONSERVER",
	"PATH",
	"SYSTEMDRIVE",
	"SYSTEMROOT",
	"TEMP",
	"USERDOMAIN",
	"USERNAME",
	"USERPROFILE",
	"WINDIR",
];
function spawnEnvironment(env: Readonly<Record<string, string>>): Record<string, string> {
	const result: Record<string, string> = {};
	if (process.platform === "win32") {
		for (const key of WINDOWS_DEFAULTS) result[key] = "";
	}
	for (const [key, value] of Object.entries(env)) {
		result[process.platform === "win32" ? key.toUpperCase() : key] = value;
	}
	return result;
}
const SIGNALS = new Set([
	"SIGABRT",
	"SIGALRM",
	"SIGBUS",
	"SIGFPE",
	"SIGHUP",
	"SIGILL",
	"SIGINT",
	"SIGKILL",
	"SIGPIPE",
	"SIGQUIT",
	"SIGSEGV",
	"SIGSYS",
	"SIGTERM",
	"SIGTRAP",
	"SIGUSR1",
	"SIGUSR2",
	"SIGXCPU",
	"SIGXFSZ",
	"SIGBREAK",
]);
const refuse = (): never => {
	throw new CaptureError("INVALID_INPUT");
};

async function nativeExecutable(executable: string): Promise<string> {
	if (
		!path.isAbsolute(executable) ||
		executable.includes("\0") ||
		/\.(?:cmd|bat|ps1|sh|js|mjs|cjs|py)$/i.test(executable) ||
		(process.platform === "win32" && path.extname(executable).toLowerCase() !== ".exe")
	)
		return refuse();
	if (
		/^(?:cmd|powershell|pwsh|sh|bash|dash|zsh|fish|csh|ksh)(?:\.exe)?$/i.test(
			path.basename(executable),
		)
	)
		return refuse();
	const resolved = await realpath(executable);
	const info = await stat(resolved);
	if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o111) === 0))
		return refuse();
	const file = await open(resolved, "r");
	try {
		const magic = Buffer.alloc(4);
		const read = await file.read(magic, 0, 4, 0);
		const header = magic.toString("hex");
		if (
			read.bytesRead !== 4 ||
			!(
				header.startsWith("4d5a") ||
				[
					"7f454c46",
					"feedface",
					"feedfacf",
					"cefaedfe",
					"cffaedfe",
					"cafebabe",
					"bebafeca",
					"cafebabf",
					"bfbafeca",
				].includes(header)
			)
		)
			return refuse();
	} finally {
		await file.close();
	}
	return executable;
}
async function validated(command: NativeCommand): Promise<NativeCommand> {
	try {
		const {
			executable: requested,
			args: requestedArgs,
			cwd: requestedCwd,
			env: requestedEnv,
			deadlineMs,
		} = command;
		const executable = await nativeExecutable(requested);
		if (!Array.isArray(requestedArgs) || requestedArgs.length > 64) return refuse();
		const args = [...requestedArgs];
		let bytes = 0;
		for (const arg of args) {
			if (typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 8192)
				return refuse();
			bytes += Buffer.byteLength(arg);
		}
		if (
			bytes > 65_536 ||
			!Number.isSafeInteger(deadlineMs) ||
			deadlineMs < 50 ||
			deadlineMs > MAX_CAPTURE_MS ||
			!path.isAbsolute(requestedCwd)
		)
			return refuse();
		const cwd = await realpath(requestedCwd);
		if (
			!(await stat(cwd)).isDirectory() ||
			typeof requestedEnv !== "object" ||
			requestedEnv === null ||
			Array.isArray(requestedEnv)
		)
			return refuse();
		const env: Record<string, string> = {};
		let envBytes = 0;
		for (const [key, value] of Object.entries(requestedEnv)) {
			if (
				!ENVIRONMENT.has(key) ||
				typeof value !== "string" ||
				value.includes("\0") ||
				Buffer.byteLength(value) > 8192
			)
				return refuse();
			envBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
			if (
				process.platform === "win32" &&
				Object.keys(env).some((existing) => existing.toUpperCase() === key.toUpperCase())
			)
				return refuse();
			env[key] = value;
		}
		if (envBytes > 32_768) return refuse();
		return Object.freeze({
			executable,
			args: Object.freeze(args),
			cwd,
			env: Object.freeze(env),
			deadlineMs,
		});
	} catch (error) {
		if (error instanceof CaptureError) throw error;
		return refuse();
	}
}

function killOwnedTree(
	child: ChildProcess,
	exited: () => boolean,
	deadline: number,
): Promise<boolean> {
	if (!child.pid || exited() || child.exitCode !== null || child.signalCode !== null)
		return Promise.resolve(false);
	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return Promise.resolve(true);
		} catch {
			return Promise.resolve(false);
		}
	}
	return new Promise((resolve) => {
		const root = process.env.SystemRoot;
		if (
			!root ||
			!path.isAbsolute(root) ||
			exited() ||
			child.exitCode !== null ||
			child.signalCode !== null
		) {
			resolve(false);
			return;
		}
		let killer: ChildProcess;
		try {
			killer = spawn(
				path.join(root, "System32", "taskkill.exe"),
				["/PID", String(child.pid), "/T", "/F"],
				{
					shell: false,
					windowsHide: true,
					stdio: "ignore",
					env: spawnEnvironment({ SystemRoot: root }),
				},
			);
		} catch {
			resolve(false);
			return;
		}
		let settled = false;
		const finish = (value: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(
			() => {
				if (killer.exitCode === null && killer.signalCode === null) killer.kill();
				finish(false);
			},
			Math.max(1, deadline - performance.now()),
		);
		killer.once("error", () => finish(false));
		killer.once("close", (code) => finish(code === 0));
	});
}

/** Executes a fixed caller-owned command, capturing content only in exclusive external files. */
export async function captureNativeProcess(
	evidence: EvidenceDirectory,
	id: string,
	input: NativeCommand,
): Promise<NativeCaptureResult> {
	const command = await validated(input);
	const session = await beginCapture(evidence, id);
	const started = performance.now();
	const deadline = started + command.deadlineMs;
	const teardown = Math.min(2000, Math.floor(command.deadlineMs / 2));
	let child: ChildProcessByStdio<null, Readable, Readable>;
	try {
		child = spawn(command.executable, [...command.args], {
			cwd: command.cwd,
			env: spawnEnvironment(command.env),
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return sealCapture(session, { exitCode: null, signal: null, failure: "SPAWN_FAILED" });
	}
	let exited = false;
	let closed = false;
	let exitCode: number | null = null;
	let signal: string | null = null;
	let failure: CaptureFailure | null = null;
	let termination: Promise<boolean> | undefined;
	let terminationConfirmed = false;
	let hardExpired = false;
	const abort = (code: CaptureFailure): void => {
		failure ??= code;
		termination ??= killOwnedTree(child, () => exited, deadline).then((value) => {
			terminationConfirmed = value;
			return value;
		});
	};
	const completion = new Promise<void>((resolve) => {
		child.once("error", () => {
			failure ??= "SPAWN_FAILED";
		});
		child.once("exit", (code, reason) => {
			exited = true;
			exitCode = code;
			signal = reason;
		});
		child.once("close", () => {
			closed = true;
			resolve();
		});
	});
	const pump = async (stream: "stdout" | "stderr"): Promise<void> => {
		try {
			for await (const chunk of child[stream]) await session[stream].append(chunk);
		} catch (error) {
			if (!hardExpired) abort(error instanceof CaptureError ? error.code : "CAPTURE_IO");
		}
	};
	const pumps = Promise.all([pump("stdout"), pump("stderr")]);
	const timer = setTimeout(() => abort("TIMED_OUT"), command.deadlineMs - teardown);
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	const hardDeadline = new Promise<void>((resolve) => {
		hardTimer = setTimeout(() => {
			hardExpired = true;
			failure = "TREE_UNCONFIRMED";
			child.stdout.destroy();
			child.stderr.destroy();
			resolve();
		}, command.deadlineMs);
	});
	try {
		await Promise.race([Promise.all([completion, pumps]).then(() => undefined), hardDeadline]);
		if (termination) await Promise.race([termination, hardDeadline]);
		if (!closed || (failure === "TIMED_OUT" && !terminationConfirmed)) failure = "TREE_UNCONFIRMED";
		if (
			exitCode !== null &&
			(!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 0xffff_ffff)
		) {
			exitCode = null;
			failure = "COMPLETION_INVALID";
		}
		if (signal !== null && !SIGNALS.has(signal)) {
			signal = null;
			failure = "COMPLETION_INVALID";
		}
		if (
			(exitCode !== null && signal !== null) ||
			(exitCode === null && signal === null && failure === null)
		)
			failure = "COMPLETION_INVALID";
		return await sealCapture(session, { exitCode, signal, failure });
	} finally {
		clearTimeout(timer);
		if (hardTimer) clearTimeout(hardTimer);
	}
}
