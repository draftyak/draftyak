import { spawn } from "node:child_process";
import path from "node:path";
import type { Outcome } from "./outcome.ts";

export interface Command {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly timeoutMs: number;
}
export type Runner = (command: Command) => Promise<Outcome>;
const OUTPUT_BYTES = 1024 * 1024;

/** One owned native child; timeout failure is retained even if termination returns exit zero. */
export const run: Runner = async (command) => {
	if (
		!path.isAbsolute(command.executable) ||
		/\.(?:cmd|bat|ps1)$/i.test(command.executable) ||
		!path.isAbsolute(command.cwd) ||
		!Number.isSafeInteger(command.timeoutMs) ||
		command.timeoutMs < 1 ||
		command.timeoutMs > 300_000 ||
		command.args.some((argument) => typeof argument !== "string" || argument.includes("\0"))
	)
		throw new Error("Invalid native-store test command");
	return new Promise<Outcome>((resolve) => {
		const child = spawn(command.executable, [...command.args], {
			cwd: command.cwd,
			env: command.env,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let started = false,
			settled = false,
			stopping = false;
		let childClosed = false,
			killerPending = false;
		let timedOut = false,
			overflow = false,
			processError = false,
			terminationFailed = false;
		let code: number | null = null,
			signal: string | null = null;
		let bytes = 0;
		const stdout: Buffer[] = [],
			stderr: Buffer[] = [];
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (settled || !childClosed || killerPending) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(cleanupTimer);
			resolve({
				started,
				code,
				signal,
				timedOut,
				overflow,
				processError,
				terminationFailed,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		};
		const stop = (): void => {
			if (stopping) return;
			stopping = true;
			const pid = child.pid;
			if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
				if (process.platform === "win32") {
					const systemRoot = command.env.SystemRoot ?? command.env.SYSTEMROOT;
					if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot))
						terminationFailed = true;
					else {
						killerPending = true;
						const killer = spawn(
							path.win32.join(systemRoot, "System32", "taskkill.exe"),
							["/PID", String(pid), "/T", "/F"],
							{ shell: false, windowsHide: true, stdio: "ignore" },
						);
						killer.once("error", () => {
							terminationFailed = true;
						});
						killer.once("close", (status) => {
							if (status !== 0) terminationFailed = true;
							killerPending = false;
							finish();
						});
						const killDeadline = setTimeout(() => {
							terminationFailed = true;
							killer.kill();
							killer.unref();
							killerPending = false;
							finish();
						}, 4000);
						killer.once("close", () => clearTimeout(killDeadline));
					}
				} else {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						terminationFailed = true;
					}
				}
			} else terminationFailed = true;
			cleanupTimer = setTimeout(() => {
				terminationFailed = true;
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
				childClosed = true;
				finish();
			}, 5000);
		};
		const receive = (target: Buffer[], chunk: Buffer): void => {
			bytes += chunk.length;
			if (bytes > OUTPUT_BYTES) {
				overflow = true;
				stop();
			} else target.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => receive(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => receive(stderr, chunk));
		child.once("spawn", () => {
			started = true;
		});
		child.once("error", () => {
			processError = true;
		});
		child.once("exit", (status, sig) => {
			code = status;
			signal = sig;
		});
		child.once("close", () => {
			childClosed = true;
			finish();
		});
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, command.timeoutMs);
	});
};
