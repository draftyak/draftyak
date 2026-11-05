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
	readonly ipc?: boolean;
}

export type InventoryGitCheck = (...args: string[]) => Promise<{ code: number }>;

export interface InventoryProcessRuntime {
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
	spawn(options: InventorySpawn): InventoryChild;
}

const failed = (diagnostic?: string): Error =>
	new Error(`file-name inventory failed${diagnostic === undefined ? "" : ` [${diagnostic}]`}`);
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
			stdio: options.ipc === false ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
			shell: false,
			windowsHide: true,
		});
		const owned = ownedProcess(child);
		return {
			...owned,
			stop: () => {
				if (options.ipc === false) {
					owned.kill();
					return;
				}
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
	precheck: (git: InventoryGitCheck) => Promise<void>,
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
		// Keep work admission's original 250ms reserve. Report failure halfway through that
		// reserve so an outer 300000ms test can observe it; this is not a close receipt.
		const completionReserve = Math.floor(INVENTORY_STOP_RESERVE_MS / 2);
		type Handle = {
			readonly child: InventoryChild;
			readonly kind: "git" | "worker";
			closed: boolean;
			stopSent: boolean;
			killSent: boolean;
		};
		const handles = new Map<InventoryChild, Handle>();
		let phase: "precheck" | "worker" = "precheck";
		let prechecking = true;
		let refused = false;
		let settled = false;
		let stdout = Buffer.alloc(0);
		let stderrBytes = 0;
		const timers: unknown[] = [];
		const drained = (): boolean => {
			for (const handle of handles.values()) if (!handle.closed) return false;
			return true;
		};
		const own = (child: InventoryChild, kind: Handle["kind"]): Handle => {
			if (handles.has(child)) throw failed();
			const handle = { child, kind, closed: false, stopSent: false, killSent: false };
			handles.set(child, handle);
			return handle;
		};
		const diagnostic = (): string => {
			let gitOwned = 0;
			let gitClosed = 0;
			let workerOwned = 0;
			let workerClosed = 0;
			let pending = 0;
			let stopRequests = 0;
			let killRequests = 0;
			for (const handle of handles.values()) {
				if (handle.kind === "git") {
					gitOwned++;
					if (handle.closed) gitClosed++;
				} else {
					workerOwned++;
					if (handle.closed) workerClosed++;
				}
				if (!handle.closed) pending++;
				if (handle.stopSent) stopRequests++;
				if (handle.killSent) killRequests++;
			}
			let elapsedMs = -1;
			try {
				const elapsed = Math.floor(ports.now() - (deadline - INVENTORY_TIMEOUT_MS));
				if (Number.isSafeInteger(elapsed) && elapsed >= 0) elapsedMs = elapsed;
			} catch {
				// Unknown timing remains unknown, never a successful deadline receipt.
			}
			return [
				`phase=${phase}`,
				`cleanup=${handles.size === 0 ? "none" : pending === 0 ? "closed" : "pending"}`,
				`pending=${pending}`,
				`gitOwned=${gitOwned}`,
				`gitClosed=${gitClosed}`,
				`workerOwned=${workerOwned}`,
				`workerClosed=${workerClosed}`,
				`stopRequests=${stopRequests}`,
				`killRequests=${killRequests}`,
				`elapsedMs=${elapsedMs}`,
			].join(",");
		};
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
			if (failure) reject(failed(diagnostic()));
			else resolve();
		};
		const stop = (): void => {
			refused = true;
			for (const handle of handles.values()) {
				if (handle.closed || handle.stopSent) continue;
				handle.stopSent = true;
				try {
					handle.child.stop();
				} catch {
					// Retain ownership and listeners until actual close, even when stopping throws.
				}
			}
		};
		const force = (): void => {
			stop();
			for (const handle of handles.values()) {
				if (handle.closed || handle.killSent) continue;
				handle.killSent = true;
				try {
					handle.child.kill();
				} catch {
					// A submitted or throwing kill is never an original close callback.
				}
			}
		};
		const timely = (reserve = completionReserve): boolean => {
			try {
				const now = ports.now();
				return Number.isFinite(now) && now < deadline - reserve;
			} catch {
				return false;
			}
		};
		const git: InventoryGitCheck = (...args) =>
			new Promise<{ code: number }>((resolveGit, rejectGit) => {
				if (settled || refused || !prechecking || !timely(INVENTORY_STOP_RESERVE_MS)) {
					rejectGit(failed());
					return;
				}
				let stdoutBytes = 0;
				let gitStderrBytes = 0;
				try {
					const original = own(
						ports.spawn({ command: "git", args, cwd: root, env: process.env, ipc: false }),
						"git",
					);
					original.child.onClose((code) => {
						if (original.closed) return;
						original.closed = true;
						if (settled || refused || !timely() || code === null || !Number.isFinite(code)) {
							stop();
							rejectGit(failed());
							if (drained()) finish(true);
						} else resolveGit({ code });
					});
					original.child.onError(stop);
					original.child.stdout.onError(stop);
					original.child.stderr.onError(stop);
					original.child.stdout.onData((chunk) => {
						if (!Buffer.isBuffer(chunk)) {
							stop();
							return;
						}
						stdoutBytes += chunk.length;
						if (stdoutBytes > INVENTORY_STDOUT_MAX) stop();
					});
					original.child.stderr.onData((chunk) => {
						if (!Buffer.isBuffer(chunk)) {
							stop();
							return;
						}
						gitStderrBytes += chunk.length;
						if (gitStderrBytes > INVENTORY_STDERR_MAX) stop();
					});
					if (!timely(INVENTORY_STOP_RESERVE_MS)) stop();
				} catch {
					stop();
					rejectGit(failed());
					if (drained()) finish(true);
				}
			});
		try {
			if (!Number.isFinite(deadline)) throw failed();
			timers.push(
				ports.setTimer(stop, Math.max(0, deadline - ports.now() - INVENTORY_STOP_RESERVE_MS)),
			);
			timers.push(
				ports.setTimer(
					() => {
						force();
						// Failure is observable before the outer deadline. Pending originals
						// retain their handlers; rejection does not assert physical cleanup.
						finish(true);
					},
					Math.max(0, deadline - ports.now() - completionReserve),
				),
			);
		} catch {
			finish(true);
			return;
		}
		// Precheck promises and every original handle retain their handlers after deadline failure.
		Promise.resolve()
			.then(() => {
				if (settled || refused || !timely(INVENTORY_STOP_RESERVE_MS)) throw failed();
				return precheck(git);
			})
			.then(
				() => {
					prechecking = false;
					if (settled) return;
					if (refused || !timely(INVENTORY_STOP_RESERVE_MS) || !drained()) {
						stop();
						if (drained()) finish(true);
						return;
					}
					try {
						phase = "worker";
						const original = own(
							ports.spawn({
								command: process.execPath,
								args: [entry],
								cwd: root,
								env: inventoryEnvironment(),
							}),
							"worker",
						);
						original.child.onClose((code) => {
							if (original.closed) return;
							original.closed = true;
							finish(
								refused ||
									!timely() ||
									!drained() ||
									code !== 0 ||
									!stdout.equals(Buffer.from(INVENTORY_SENTINEL)),
							);
						});
						original.child.onError(stop);
						original.child.stdout.onError(stop);
						original.child.stderr.onError(stop);
						original.child.stdout.onData((chunk) => {
							if (!Buffer.isBuffer(chunk) || stdout.length + chunk.length > INVENTORY_STDOUT_MAX) {
								stop();
								return;
							}
							stdout = Buffer.concat([stdout, chunk]);
						});
						original.child.stderr.onData((chunk) => {
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
						if (drained()) finish(true);
					}
				},
				() => {
					prechecking = false;
					stop();
					if (drained()) finish(true);
				},
			);
	});
}
