import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { createInventoryObservation } from "./inventory-observation.ts";

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
	// A throw guarantees no child was created. After creation, return the original
	// owned handle, including a failed handle whose pipes could not be established.
	spawn(options: InventorySpawn): InventoryChild;
}

export interface InventoryClosure {
	readonly kind: "no-child" | "closed";
	readonly originals: number;
	readonly closedAt: number | null;
}

export interface InventoryExecution {
	readonly reported: Promise<void>;
	readonly closed: Promise<InventoryClosure>;
	readonly prechecked: Promise<"not-started" | "settled">;
	readonly deadline: number;
}

interface InventoryJoinTiming {
	readonly ports: InventoryProcessRuntime;
	readonly deadline: number;
	readonly diagnostic: () => string;
	joined?: Promise<void>;
}

const executions = new WeakMap<InventoryExecution, InventoryJoinTiming>();

const failed = (diagnostic?: string): Error =>
	new Error(`file-name inventory failed${diagnostic === undefined ? "" : ` [${diagnostic}]`}`);
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const entry = path.join(import.meta.dirname, "worktree-inventory.ts");
const UNKNOWN_WORKER_DIAGNOSTIC =
	"workerPhase=-1,workerRoots=-1,workerPendingGit=-1,workerPendingFs=-1," +
	"workerDirectories=-1,workerEntries=-1,workerElapsedMs=-1";

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
	const closes = new Set<(code: number | null) => void>();
	let errorSeen = false;
	let originalError: unknown;
	let closeSeen = false;
	let originalCode: number | null = null;
	const rememberError = (error: unknown): void => {
		if (!errorSeen) {
			errorSeen = true;
			originalError = error;
		}
		for (const listener of errors) listener(error);
	};
	child.on("error", rememberError);
	child.once("close", (code) => {
		closeSeen = true;
		originalCode = code;
		for (const listener of closes) listener(code);
		closes.clear();
	});
	// A created child remains owned even if its requested pipes were unavailable.
	// Replay that refusal only after the caller can register its original-close listener.
	const missingPipe = failed();
	if (child.stdout === null || child.stderr === null) rememberError(missingPipe);
	const pipe = (stream: ChildProcess["stdout"]): InventoryPipe => ({
		onData: (listener) => {
			stream?.on("data", listener);
		},
		onError: (listener) => {
			if (stream === null) listener(missingPipe);
			else stream.on("error", listener);
		},
	});
	return {
		stdout: pipe(child.stdout),
		stderr: pipe(child.stderr),
		onError: (listener) => {
			errors.add(listener);
			if (errorSeen) listener(originalError);
		},
		onClose: (listener) => {
			if (closeSeen) listener(originalCode);
			else closes.add(listener);
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

// Reporting, precheck settlement and physical closure share one original budget.
export function startInventoryAfter(
	precheck: (git: InventoryGitCheck) => Promise<void>,
	ports: InventoryProcessRuntime = runtime,
): InventoryExecution {
	let deadline = Number.NaN;
	const physical = Promise.withResolvers<InventoryClosure>();
	const prechecked = Promise.withResolvers<"not-started" | "settled">();
	let precheckStarted = false;
	let joinTiming: InventoryJoinTiming | undefined;
	const reported = new Promise<void>((resolve, reject) => {
		try {
			deadline = ports.now() + INVENTORY_TIMEOUT_MS;
		} catch {
			physical.resolve(Object.freeze({ kind: "no-child", originals: 0, closedAt: null }));
			prechecked.resolve("not-started");
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
		let admissionSealed = false;
		let registering = 0;
		let closurePublished = false;
		let stdout = Buffer.alloc(0);
		let stderrBytes = 0;
		const observation = createInventoryObservation();
		let observationFailed = false;
		const timers: unknown[] = [];
		const drained = (): boolean => {
			for (const handle of handles.values()) if (!handle.closed) return false;
			return true;
		};
		const publishClosure = (): void => {
			if (closurePublished || !admissionSealed || registering !== 0 || !drained()) return;
			closurePublished = true;
			let closedAt: number | null = null;
			if (handles.size > 0) {
				try {
					const now = ports.now();
					if (Number.isFinite(now)) closedAt = now;
				} catch {
					// Physical close is known even when its timing cannot be qualified.
				}
			}
			physical.resolve(
				Object.freeze({
					kind: handles.size === 0 ? "no-child" : "closed",
					originals: handles.size,
					closedAt,
				}),
			);
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
			let workerDiagnostic = UNKNOWN_WORKER_DIAGNOSTIC;
			if (!observationFailed) {
				try {
					const worker = observation.snapshot();
					if (worker !== null)
						workerDiagnostic = [
							`workerPhase=${worker.phase}`,
							`workerRoots=${worker.roots}`,
							`workerPendingGit=${worker.pendingGit}`,
							`workerPendingFs=${worker.pendingFs}`,
							`workerDirectories=${worker.directoryVisits}`,
							`workerEntries=${worker.entries}`,
							`workerElapsedMs=${worker.elapsedMs}`,
						].join(",");
				} catch {
					// Observation cannot replace the original failure or its close receipt.
					observationFailed = true;
				}
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
				workerDiagnostic,
			].join(",");
		};
		joinTiming = { ports, deadline, diagnostic };
		const finish = (failure: boolean): void => {
			if (settled) return;
			settled = true;
			admissionSealed = true;
			if (!precheckStarted) prechecked.resolve("not-started");
			publishClosure();
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
			admissionSealed = true;
			if (!precheckStarted) prechecked.resolve("not-started");
			for (const handle of handles.values()) {
				if (handle.closed || handle.stopSent) continue;
				handle.stopSent = true;
				try {
					handle.child.stop();
				} catch {
					// Retain ownership and listeners until actual close, even when stopping throws.
				}
			}
			publishClosure();
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
				registering += 1;
				try {
					const original = own(
						ports.spawn({ command: "git", args, cwd: root, env: process.env, ipc: false }),
						"git",
					);
					original.child.onClose((code) => {
						if (original.closed) return;
						original.closed = true;
						publishClosure();
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
				} finally {
					registering -= 1;
					publishClosure();
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
				precheckStarted = true;
				return precheck(git);
			})
			.then(
				() => {
					prechecked.resolve("settled");
					prechecking = false;
					if (settled) return;
					if (refused || !timely(INVENTORY_STOP_RESERVE_MS) || !drained()) {
						stop();
						if (drained()) finish(true);
						return;
					}
					registering += 1;
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
							publishClosure();
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
								observationFailed = true;
								stop();
								return;
							}
							stderrBytes += chunk.length;
							if (stderrBytes > INVENTORY_STDERR_MAX) {
								observationFailed = true;
								stop();
							} else if (!observationFailed) {
								try {
									observation.push(chunk);
								} catch {
									observationFailed = true;
								}
							}
						});
						if (!timely()) stop();
					} catch {
						stop();
						if (drained()) finish(true);
					} finally {
						registering -= 1;
						admissionSealed = true;
						publishClosure();
					}
				},
				() => {
					prechecked.resolve(precheckStarted ? "settled" : "not-started");
					prechecking = false;
					stop();
					if (drained()) finish(true);
				},
			);
	});
	const execution = Object.freeze({
		reported,
		closed: physical.promise,
		prechecked: prechecked.promise,
		deadline,
	});
	executions.set(
		execution,
		joinTiming ?? {
			ports,
			deadline,
			diagnostic: () =>
				"phase=precheck,cleanup=none,pending=0,gitOwned=0,gitClosed=0,workerOwned=0,workerClosed=0,stopRequests=0,killRequests=0,elapsedMs=-1," +
				UNKNOWN_WORKER_DIAGNOSTIC,
		},
	);
	return execution;
}

// Reporting keeps its earlier deadline; caller completion additionally requires the
// actual precheck settlement and physical closure within the original deadline.
export function joinInventoryExecution(execution: InventoryExecution): Promise<void> {
	const timing = executions.get(execution);
	if (timing === undefined) return Promise.reject(failed());
	if (timing.joined !== undefined) return timing.joined;
	timing.joined = new Promise<void>((resolve, reject) => {
		let settled = false;
		let timer: unknown;
		let timerSet = false;
		// Observe reporting rejection even when the original deadline/clock refuses
		// before a physical-close wait can be installed.
		const report = execution.reported.then(
			() => ({ failed: false as const }),
			(error: unknown) => ({ failed: true as const, error }),
		);
		const finish = (error?: unknown): void => {
			if (settled) return;
			settled = true;
			if (timerSet) {
				try {
					timing.ports.clearTimer(timer);
				} catch {
					error = failed(timing.diagnostic());
				}
			}
			if (error === undefined) resolve();
			else reject(error);
		};
		try {
			const remaining = timing.deadline - timing.ports.now();
			if (!Number.isFinite(remaining) || remaining <= 0) throw failed(timing.diagnostic());
			timer = timing.ports.setTimer(() => finish(failed(timing.diagnostic())), remaining);
			timerSet = true;
		} catch {
			finish(failed(timing.diagnostic()));
			return;
		}
		void Promise.all([report, execution.closed, execution.prechecked]).then(
			([outcome, closure]) => {
				if (settled) return;
				try {
					const now = timing.ports.now();
					if (!Number.isFinite(now) || now >= timing.deadline) throw failed(timing.diagnostic());
					if (closure.kind === "closed") {
						if (
							closure.originals <= 0 ||
							closure.closedAt === null ||
							!Number.isFinite(closure.closedAt) ||
							closure.closedAt >= timing.deadline
						)
							throw failed(timing.diagnostic());
					} else if (closure.originals !== 0 || closure.closedAt !== null || !outcome.failed) {
						throw failed(timing.diagnostic());
					}
					finish(outcome.failed ? outcome.error : undefined);
				} catch {
					finish(failed(timing.diagnostic()));
				}
			},
		);
	});
	return timing.joined;
}

// Compatibility: existing consumers may still observe the reporting result alone.
export function runInventoryAfter(
	precheck: (git: InventoryGitCheck) => Promise<void>,
	ports: InventoryProcessRuntime = runtime,
): Promise<void> {
	return startInventoryAfter(precheck, ports).reported;
}
