import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface Invocation {
	readonly command: string;
	readonly args: readonly string[];
}

export type ChildSpawnErrorCode =
	| "EACCES"
	| "EAGAIN"
	| "EBADF"
	| "EMFILE"
	| "ENFILE"
	| "ENOENT"
	| "ENOEXEC"
	| "ENOMEM"
	| "ENOTDIR"
	| "EPERM"
	| "EINVAL"
	| "ABORT_ERR"
	| "UNKNOWN";

interface ChildLifecycleIdentity {
	readonly invocationId: string;
	readonly pid: number | null;
}

export type ChildLifecycleEvent =
	| (ChildLifecycleIdentity & { readonly type: "start" })
	| (ChildLifecycleIdentity & { readonly type: "spawn" })
	| (ChildLifecycleIdentity & {
			readonly type: "exit";
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
	  })
	| (ChildLifecycleIdentity & {
			readonly type: "close";
			readonly code: number | null;
			readonly signal: NodeJS.Signals | null;
	  })
	| (ChildLifecycleIdentity & {
			readonly type: "error";
			readonly errorCode: ChildSpawnErrorCode | null;
	  });

export interface RunOptions {
	readonly cwd?: string;
	readonly env?: NodeJS.ProcessEnv;
	/** Direct-child observations only. A thrown observer fails the invocation after close. */
	readonly onLifecycle?: (event: ChildLifecycleEvent) => void;
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
const ERROR_CODES: readonly ChildSpawnErrorCode[] = [
	"EACCES",
	"EAGAIN",
	"EBADF",
	"EMFILE",
	"ENFILE",
	"ENOENT",
	"ENOEXEC",
	"ENOMEM",
	"ENOTDIR",
	"EPERM",
	"EINVAL",
	"ABORT_ERR",
	"UNKNOWN",
];

function errorCode(error: Error): ChildSpawnErrorCode | null {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
		return ERROR_CODES.find((known) => known === code) ?? null;
	} catch {
		return null;
	}
}

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
		const invocationId = randomUUID();
		const child = spawn(invocation.command, [...invocation.args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: piped ? ["ignore", "pipe", "pipe"] : "inherit",
			shell: false,
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let originalError: Error | undefined;
		let observerFailed = false;
		const identity = (): ChildLifecycleIdentity => ({ invocationId, pid: child.pid ?? null });
		const notify = (event: ChildLifecycleEvent): void => {
			try {
				options.onLifecycle?.(Object.freeze(event));
			} catch {
				observerFailed = true;
			}
		};
		child.once("error", (error) => {
			originalError = error;
			notify({ ...identity(), type: "error", errorCode: errorCode(error) });
		});
		child.once("spawn", () => {
			notify({ ...identity(), type: "spawn" });
		});
		child.once("exit", (code, signal) => {
			notify({ ...identity(), type: "exit", code, signal });
		});
		child.once("close", (code, signal) => {
			notify({ ...identity(), type: "close", code, signal });
			if (originalError) reject(originalError);
			else if (observerFailed) reject(new Error("Child lifecycle observer failed"));
			else resolve({ code: code ?? 1, stdout, stderr });
		});
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		// The original spawn call returned a handle; only its "spawn" event proves launch.
		notify({ ...identity(), type: "start" });
	});
}
