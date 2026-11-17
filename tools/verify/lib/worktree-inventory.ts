import { isUtf8 } from "node:buffer";
import { spawn } from "node:child_process";
import path from "node:path";
import {
	type InventoryDirectory,
	type OpenInventoryDirectory,
	openInventoryDirectory,
} from "./inventory-directory.ts";
import {
	INVENTORY_DIRECTORY_READ_BUDGET,
	INVENTORY_SENTINEL,
	inventoryEnvironment,
	type OwnedProcess,
	ownedProcess,
} from "./inventory-process.ts";
import {
	createInventoryProgress,
	type InventoryProgress,
	type InventoryProgressCounters,
} from "./inventory-progress.ts";
import {
	listedWorktrees,
	namedWorktreeFiles,
	type ReadDirectory,
	type StatPath,
} from "./workspace-policy.ts";

export interface InventoryGitResult {
	readonly code: number;
	readonly stdout: string;
}

export interface InventoryIo {
	readDirectory: ReadDirectory;
	statPath: StatPath;
	openDirectory?: OpenInventoryDirectory;
	spawnGit(args: readonly string[], cwd: string): OwnedProcess;
	write(bytes: string, ack: (error?: Error | null) => void): void;
}

export interface InventoryHost {
	git(args: readonly string[]): Promise<InventoryGitResult>;
	readDirectory: ReadDirectory;
	statPath: StatPath;
	openDirectory?: OpenInventoryDirectory;
	stopped(): boolean;
	stop(): void;
	drain(): Promise<void>;
	drained(): boolean;
	write(bytes: string, ack: (error?: Error | null) => void): void;
}

export interface ObservedInventoryHost extends InventoryHost {
	snapshot(): InventoryProgressCounters;
}

const failed = (): Error => new Error("file-name inventory failed");
const GIT_PIPE_MAX = 4 * 1024 * 1024;
const io: InventoryIo = {
	// Production has no pathname traversal fallback. Raw ports remain only for synthetic hosts.
	readDirectory: async () => {
		throw failed();
	},
	statPath: async () => {
		throw failed();
	},
	openDirectory: openInventoryDirectory,
	spawnGit: (args, cwd) =>
		ownedProcess(
			spawn("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
				cwd,
				env: inventoryEnvironment(),
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
			}),
		),
	write: (bytes, ack) => {
		process.stdout.write(bytes, ack);
	},
};

export function createInventoryHost(
	root: string,
	ports: InventoryIo = io,
	onStop?: () => void,
): ObservedInventoryHost {
	let stopped = false;
	let activeFs = 0;
	let directoryVisits = 0;
	let entries = 0;
	const fsWaiters = new Set<() => void>();
	const children = new Map<OwnedProcess, Promise<void>>();
	const directories = new Set<InventoryDirectory>();
	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		for (const directory of directories) {
			try {
				directory.stop();
			} catch {
				/* Retain custody through close. */
			}
		}
		try {
			onStop?.();
		} catch {
			/* Observation cannot prevent stopping the original children. */
		}
		for (const child of children.keys()) {
			try {
				child.kill();
			} catch {
				/* Retain ownership until actual close. */
			}
		}
	};
	const releaseFs = (): void => {
		activeFs -= 1;
		if (activeFs === 0) {
			for (const resolve of fsWaiters) resolve();
			fsWaiters.clear();
		}
	};
	const track = async <T>(work: () => Promise<T>): Promise<T> => {
		if (stopped) throw failed();
		activeFs += 1;
		try {
			const result = await work();
			if (stopped) throw failed();
			return result;
		} finally {
			releaseFs();
		}
	};
	const openDirectory: OpenInventoryDirectory | undefined =
		ports.openDirectory === undefined
			? undefined
			: async (target) =>
					track(async () => {
						const original = await ports.openDirectory?.(target);
						if (original === undefined) throw failed();
						let closure: Promise<void> | undefined;
						let sealed = false;
						const trackScope = <T>(work: () => Promise<T>): Promise<T> =>
							sealed ? Promise.reject(failed()) : track(work);
						const directory: InventoryDirectory = {
							read: (components) =>
								trackScope(async () => {
									directoryVisits += 1;
									const found = await original.read(components);
									entries += found.length;
									return found;
								}),
							stat: (components) => trackScope(() => original.stat(components)),
							current: () => trackScope(() => original.current()),
							stop: () => {
								sealed = true;
								original.stop();
							},
							close: () => {
								sealed = true;
								// Close is admitted after stop and is owned until the original close succeeds.
								closure ??= Promise.resolve()
									.then(() => original.close())
									.then(() => {
										directories.delete(directory);
									});
								return closure;
							},
						};
						directories.add(directory);
						if (stopped) {
							try {
								directory.stop();
							} finally {
								await directory.close();
							}
							throw failed();
						}
						return directory;
					});
	return {
		...(openDirectory === undefined ? {} : { openDirectory }),
		readDirectory: async (directory) => {
			if (stopped) throw failed();
			activeFs += 1;
			try {
				directoryVisits += 1;
				const found = await ports.readDirectory(directory);
				entries += found.length;
				if (stopped) throw failed();
				return found;
			} finally {
				releaseFs();
			}
		},
		statPath: (target) => track(() => ports.statPath(target)),
		snapshot: () => ({
			pendingGit: children.size,
			pendingFs: activeFs + directories.size,
			directoryVisits,
			entries,
		}),
		stopped: () => stopped,
		stop,
		drained: () => activeFs === 0 && children.size === 0 && directories.size === 0,
		drain: async () => {
			while (children.size > 0) await Promise.allSettled([...children.values()]);
			if (activeFs > 0) await new Promise<void>((resolve) => fsWaiters.add(resolve));
			await Promise.allSettled([...directories].map((directory) => directory.close()));
			if (directories.size !== 0) throw failed();
		},
		write: (bytes, ack) => ports.write(bytes, ack),
		git: (args) =>
			new Promise<InventoryGitResult>((resolve, reject) => {
				if (stopped) {
					reject(failed());
					return;
				}
				let child: OwnedProcess;
				try {
					child = ports.spawnGit(args, root);
				} catch {
					stop();
					reject(failed());
					return;
				}
				const closed = Promise.withResolvers<void>();
				children.set(child, closed.promise);
				let refused = false;
				let stdoutBytes = 0;
				let stderrBytes = 0;
				const chunks: Buffer[] = [];
				const refuse = (): void => {
					refused = true;
					stop();
				};
				child.onError(refuse);
				child.stdout.onError(refuse);
				child.stderr.onError(refuse);
				child.stdout.onData((chunk) => {
					if (!Buffer.isBuffer(chunk)) {
						refuse();
						return;
					}
					stdoutBytes += chunk.length;
					if (stdoutBytes > GIT_PIPE_MAX) {
						refuse();
						return;
					}
					chunks.push(chunk);
				});
				child.stderr.onData((chunk) => {
					if (!Buffer.isBuffer(chunk)) {
						refuse();
						return;
					}
					stderrBytes += chunk.length;
					if (stderrBytes > GIT_PIPE_MAX) refuse();
				});
				child.onClose((code) => {
					children.delete(child);
					closed.resolve();
					const bytes = Buffer.concat(chunks);
					if (refused || stopped || code === null || !isUtf8(bytes)) reject(failed());
					else resolve({ code, stdout: bytes.toString("utf8") });
				});
			}),
	};
}

export async function inventoryWorktrees(
	root: string,
	host: InventoryHost,
	progress?: InventoryProgress,
): Promise<void> {
	try {
		progress?.phase(1);
		if (!path.isAbsolute(root)) throw failed();
		const common = await host.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		if (common.code !== 0) throw failed();
		const commonDirectory = common.stdout.trim();
		if (
			!path.isAbsolute(commonDirectory) ||
			!commonDirectory.isWellFormed() ||
			commonDirectory.includes("\uFFFD")
		)
			throw failed();
		const key = (directory: string): string => {
			const resolved = path.resolve(directory);
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		const main = key(path.dirname(commonDirectory));
		const refreshWorktrees = async () => {
			const result = await host.git(["worktree", "list", "--porcelain", "-z"]);
			if (result.code !== 0) throw failed();
			return listedWorktrees(result.stdout);
		};
		const roots = (await refreshWorktrees())
			.map(({ directory }) => directory)
			.filter((directory) => key(directory) !== main);
		progress?.roots(roots.length);
		progress?.phase(2);
		let next = 0;
		let refused = false;
		let liveWorkerCount = Math.min(16, roots.length);
		const workerCount = liveWorkerCount;
		const readCapacity = (): number => {
			if (liveWorkerCount < 1) throw failed();
			// Keep each walk's existing validated maximum while sharing the larger
			// process-wide filesystem capacity across the same sixteen root workers.
			return Math.min(64, Math.floor(INVENTORY_DIRECTORY_READ_BUDGET / liveWorkerCount));
		};
		const worker = async (): Promise<void> => {
			try {
				while (!refused && !host.stopped() && next < roots.length) {
					const directory = roots[next++];
					if (directory === undefined) continue;
					try {
						const found = await namedWorktreeFiles(
							".env.live",
							directory,
							refreshWorktrees,
							process.platform === "win32",
							host.readDirectory,
							host.statPath,
							readCapacity,
							host.openDirectory,
						);
						if (found.length !== 0) throw failed();
					} catch {
						refused = true;
						host.stop();
					}
				}
			} finally {
				// A worker releases its share only after its final scan and root checks settle.
				liveWorkerCount -= 1;
			}
		};
		progress?.phase(3);
		await Promise.allSettled(Array.from({ length: workerCount }, worker));
		if (refused || host.stopped() || next !== roots.length) throw failed();
	} catch {
		progress?.phase(5);
		host.stop();
		await host.drain();
		throw failed();
	}
}

export async function completeInventory(
	host: InventoryHost,
	progress?: InventoryProgress,
): Promise<void> {
	await host.drain();
	if (host.stopped() || !host.drained()) throw failed();
	progress?.phase(4);
	await new Promise<void>((resolve, reject) => {
		try {
			host.write(INVENTORY_SENTINEL, (error) => {
				if (error !== undefined && error !== null) reject(failed());
				else resolve();
			});
		} catch {
			reject(failed());
		}
	});
	if (host.stopped() || !host.drained()) throw failed();
}

export async function runWorktreeInventory(
	root: string,
	host: InventoryHost,
	progress?: InventoryProgress,
): Promise<void> {
	try {
		progress?.phase(0);
		await inventoryWorktrees(root, host, progress);
		await completeInventory(host, progress);
	} catch {
		progress?.phase(5);
		host.stop();
		await host.drain();
		throw failed();
	}
}

if (import.meta.main) {
	if (process.argv.length !== 2 || !process.connected) {
		process.stderr.write("file-name inventory failed\n");
		process.exitCode = 1;
	} else {
		let progress: InventoryProgress | undefined;
		const host = createInventoryHost(path.resolve(import.meta.dirname, "..", "..", ".."), io, () =>
			progress?.phase(5),
		);
		process.stdout.on("error", () => host.stop());
		process.stderr.on("error", () => host.stop());
		process.on("message", () => host.stop());
		process.on("disconnect", () => host.stop());
		try {
			progress = createInventoryProgress(
				() => host.snapshot(),
				() => host.stop(),
			);
			await runWorktreeInventory(
				path.resolve(import.meta.dirname, "..", "..", ".."),
				host,
				progress,
			);
			process.exitCode = 0;
		} catch {
			process.stderr.write("file-name inventory failed\n");
			process.exitCode = 1;
		} finally {
			if (progress !== undefined && !(await progress.finish())) process.exitCode = 1;
			if (process.connected) process.disconnect?.();
		}
	}
}
