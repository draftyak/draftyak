import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export interface ExecOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface ExecResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

// Never a shell: Node can't start .cmd/.bat/.ps1 shims without one, and shell: true re-parses args.
function spawnable(command: string): string {
	if (/\.(?:bat|cmd|ps1)[\s.]*$/i.test(command)) throw new Error(`refusing to spawn ${command}`);
	return command;
}

export function exec(
	command: string,
	args: readonly string[],
	options: ExecOptions = {},
): Promise<ExecResult> {
	const { cwd, env, timeoutMs, signal } = options;
	const stdio: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];
	const child = spawn(spawnable(command), args, { cwd, env, signal, stdio, windowsHide: true });
	const stdout: string[] = [];
	const stderr: string[] = [];
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
	const timer = timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), timeoutMs);
	return new Promise((resolve, reject) => {
		child
			.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			})
			.once("close", (code) => {
				clearTimeout(timer);
				const [out, err] = [stdout.join(""), stderr.join("")];
				resolve({ code: code ?? -1, stdout: out, stderr: err, timedOut: child.killed });
			});
	});
}

export function execSync(
	command: string,
	args: readonly string[],
	options: ExecOptions = {},
): ExecResult {
	const { cwd, env, timeoutMs: timeout } = options;
	const spawnOptions = { cwd, env, timeout, encoding: "utf8", windowsHide: true } as const;
	const result = spawnSync(spawnable(command), args, spawnOptions);
	if (result.error) throw result.error;
	return {
		code: result.status ?? -1,
		stdout: result.stdout,
		stderr: result.stderr,
		timedOut: false,
	};
}

// Rejects with the signal's reason, such as Vitest's test timeout.
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	try {
		await delay(ms, undefined, { signal });
	} catch (error) {
		throw signal?.reason ?? error;
	}
}
