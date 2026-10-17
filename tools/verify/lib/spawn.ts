import { spawn } from "node:child_process";

export interface Invocation {
	readonly command: string;
	readonly args: readonly string[];
}

export interface RunOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
}

export interface Captured {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export class SpawnRefusedError extends Error {
	override name = "SpawnRefusedError";
}

// Node can't start these without a shell (ENOENT, EINVAL), and shell: true re-parses arguments
// and is deprecated (DEP0190). Windows ignores trailing dots and spaces in file names.
const SHELL_SHIM = /\.(?:bat|cmd|ps1)$/i;

export function assertSpawnable(command: string): void {
	if (SHELL_SHIM.test(command.replace(/[\s.]+$/, ""))) {
		throw new SpawnRefusedError(
			`refusing to spawn ${command}: shell shims need a shell; spawn the native executable, or process.execPath with the script`,
		);
	}
}

export async function run(invocation: Invocation, options: RunOptions = {}): Promise<number> {
	return (await start(invocation, options, false)).code;
}

export function capture(invocation: Invocation, options: RunOptions = {}): Promise<Captured> {
	return start(invocation, options, true);
}

function start(invocation: Invocation, options: RunOptions, piped: boolean): Promise<Captured> {
	return new Promise((resolve, reject) => {
		assertSpawnable(invocation.command);
		const child = spawn(invocation.command, [...invocation.args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: piped ? ["ignore", "pipe", "pipe"] : "inherit",
			shell: false,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}
