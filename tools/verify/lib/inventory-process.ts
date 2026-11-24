import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

export const INVENTORY_TIMEOUT_MS = 300_000;
export const INVENTORY_STOP_RESERVE_MS = 250;
export const INVENTORY_SENTINEL = "WORKTREE_INVENTORY_COMPLETE\n";
export const INVENTORY_STDOUT_MAX = 128;
export const INVENTORY_STDERR_MAX = 4096;

export interface InventoryPipe {
	onData(listener: (chunk: Buffer) => void): void;
	onError(listener: (error: unknown) => void): void;
}

export interface OwnedProcess {
	readonly stdout: InventoryPipe;
	readonly stderr: InventoryPipe;
	onError(listener: (error: unknown) => void): void;
	onClose(listener: (code: number | null) => void): void;
	kill(): void;
}

export interface InventoryChild extends OwnedProcess {
	stop(): void;
}

export interface InventorySpawn {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

export interface InventoryProcessRuntime {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
	spawn(options: InventorySpawn): InventoryChild;
}

const failed = (): Error => new Error("file-name inventory failed");
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const entry = path.join(import.meta.dirname, "worktree-inventory.ts");

export function inventoryEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
		if (source[name] !== undefined) env[name] = source[name];
	}
	return {
		...env,
		// The inventory already admits 16 roots with 4 reads each.
		UV_THREADPOOL_SIZE: "64",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_TERMINAL_PROMPT: "0",
		LC_ALL: "C",
	};
}

export function ownedProcess(child: ChildProcess): OwnedProcess {
	const errors = new Set<(error: unknown) => void>();
	child.on("error", (error) => {
		for (const listener of errors) listener(error);
	});
	if (child.stdout === null || child.stderr === null) {
		child.kill();
		throw failed();
	}
	const pipe = (stream: NonNullable<ChildProcess["stdout"]>): InventoryPipe => ({
		onData: (listener) => {
			stream.on("data", listener);
		},
		onError: (listener) => {
			stream.on("error", listener);
		},
	});
	return {
		stdout: pipe(child.stdout),
		stderr: pipe(child.stderr),
		onError: (listener) => {
			errors.add(listener);
		},
		onClose: (listener) => {
			child.once("close", listener);
		},
		kill: () => {
			child.kill();
		},
	};
}

const runtime: InventoryProcessRuntime = {
	now: () => performance.now(),
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
	spawn: (options) => {
		const child = spawn(options.command, [...options.args], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			shell: false,
			windowsHide: true,
		});
		const owned = ownedProcess(child);
		return {
			...owned,
			stop: () => {
				if (!child.connected) throw failed();
				child.send("stop", (error) => {
					if (error !== undefined && error !== null) child.emit("error", error);
				});
			},
		};
	},
};

// The original test budget includes prechecks, startup, traversal, output and owned close.
export function runInventoryAfter(
	precheck: () => Promise<void>,
	ports: InventoryProcessRuntime = runtime,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let deadline: number;
		try {
			deadline = ports.now() + INVENTORY_TIMEOUT_MS;
		} catch {
			reject(failed());
			return;
		}
		let child: InventoryChild | undefined;
		let closed = false;
		let refused = false;
		let settled = false;
		let stopSent = false;
		let stdout = Buffer.alloc(0);
		let stderrBytes = 0;
		const timers: unknown[] = [];
		const finish = (failure: boolean): void => {
			if (settled) return;
			settled = true;
			for (const timer of timers) {
				try {
					ports.clearTimer(timer);
				} catch {
					failure = true;
				}
			}
			if (failure) reject(failed());
			else resolve();
		};
		const stop = (): void => {
			refused = true;
			if (child === undefined || closed || stopSent) return;
			stopSent = true;
			try {
				child.stop();
			} catch {
				// Failure is latched; retain close/error listeners until the owned process closes.
			}
		};
		const timely = (reserve = 0): boolean => {
			try {
				const now = ports.now();
				return Number.isFinite(now) && now < deadline - reserve;
			} catch {
				return false;
			}
		};
		try {
			if (!Number.isFinite(deadline)) throw failed();
			timers.push(
				ports.setTimer(stop, Math.max(0, deadline - ports.now() - INVENTORY_STOP_RESERVE_MS)),
			);
			timers.push(
				ports.setTimer(
					() => {
						stop();
						if (child !== undefined && !closed) {
							try {
								child.kill();
							} catch {
								// Do not invent a closed/drained receipt when termination is uncertain.
							}
						}
						finish(true);
					},
					Math.max(0, deadline - ports.now()),
				),
			);
		} catch {
			finish(true);
			return;
		}
		// Both handlers stay attached when a hanging precheck outlives the original deadline.
		Promise.resolve()
			.then(precheck)
			.then(
				() => {
					if (settled) return;
					if (refused || !timely(INVENTORY_STOP_RESERVE_MS)) {
						finish(true);
						return;
					}
					try {
						child = ports.spawn({
							command: process.execPath,
							args: [entry],
							cwd: root,
							env: inventoryEnvironment(),
						});
						child.onError(stop);
						child.onClose((code) => {
							if (closed) return;
							closed = true;
							finish(
								refused ||
									!timely() ||
									code !== 0 ||
									!stdout.equals(Buffer.from(INVENTORY_SENTINEL)),
							);
						});
						child.stdout.onError(stop);
						child.stderr.onError(stop);
						child.stdout.onData((chunk) => {
							if (!Buffer.isBuffer(chunk) || stdout.length + chunk.length > INVENTORY_STDOUT_MAX) {
								stop();
								return;
							}
							stdout = Buffer.concat([stdout, chunk]);
						});
						child.stderr.onData((chunk) => {
							if (!Buffer.isBuffer(chunk)) {
								stop();
								return;
							}
							stderrBytes += chunk.length;
							if (stderrBytes > INVENTORY_STDERR_MAX) stop();
						});
						if (!timely()) stop();
					} catch {
						stop();
						if (child === undefined) finish(true);
					}
				},
				() => finish(true),
			);
	});
}
