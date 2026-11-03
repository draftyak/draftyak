import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventoryPipe, OwnedProcess } from "./inventory-process.ts";
import type { ReadDirectory, StatPath } from "./workspace-policy.ts";
import {
	completeInventory,
	createInventoryHost,
	type InventoryGitResult,
	type InventoryHost,
	type InventoryIo,
	inventoryWorktrees,
	runWorktreeInventory,
} from "./worktree-inventory.ts";

const sentinel = "WORKTREE_INVENTORY_COMPLETE\n";
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const directory = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
const entry = (name: string, folder = false, link = false) => ({
	name,
	isDirectory: () => folder,
	isSymbolicLink: () => link,
});

interface State {
	stopped: boolean;
	stopCalls: number;
	read: ReadDirectory;
	stat: StatPath;
	git: (args: readonly string[]) => Promise<InventoryGitResult>;
	drain: () => Promise<void>;
	drained: () => boolean;
	write: (bytes: string, ack: (error?: Error | null) => void) => void;
}

function virtual(count = 18) {
	const base = path.resolve("dytest-inventory");
	const main = path.join(base, "main");
	const roots = Array.from({ length: count }, (_, i) => path.join(base, `root${i}`));
	const listed = [main, ...roots]
		.map((root) => `worktree ${root}\0HEAD ${"a".repeat(40)}\0\0`)
		.join("");
	const writes: string[] = [];
	const state: State = {
		stopped: false,
		stopCalls: 0,
		read: async () => [],
		stat: async () => directory(),
		git: async (args) => {
			if (args[0] === "rev-parse") return { code: 0, stdout: `${path.join(main, ".git")}\n` };
			if (args[0] === "worktree") return { code: 0, stdout: listed };
			throw new Error("Unexpected synthetic Git operation");
		},
		drain: async () => {},
		drained: () => true,
		write: (_bytes, ack) => ack(),
	};
	const host: InventoryHost = {
		git: (args) => state.git(args),
		readDirectory: (target) => state.read(target),
		statPath: (target) => state.stat(target),
		stopped: () => state.stopped,
		stop: () => {
			state.stopped = true;
			state.stopCalls++;
		},
		drain: () => state.drain(),
		drained: () => state.drained(),
		write: (bytes, ack) => {
			writes.push(bytes);
			state.write(bytes, ack);
		},
	};
	return { base, roots, host, state, writes };
}

class Pipe implements InventoryPipe {
	readonly listeners: ((chunk: Buffer) => void)[] = [];
	readonly errors: ((error: unknown) => void)[] = [];
	onData(listener: (chunk: Buffer) => void): void {
		this.listeners.push(listener);
	}
	onError(listener: (error: unknown) => void): void {
		this.errors.push(listener);
	}
	data(bytes: Buffer): void {
		for (const listener of this.listeners) listener(bytes);
	}
	error(): void {
		for (const listener of this.errors) listener(new Error("DYTEST pipe failure"));
	}
}
class Process implements OwnedProcess {
	readonly stdout = new Pipe();
	readonly stderr = new Pipe();
	readonly errors: ((error: unknown) => void)[] = [];
	readonly closes: ((code: number | null) => void)[] = [];
	kills = 0;
	failKill = false;
	errorOnKill = false;
	onError(listener: (error: unknown) => void): void {
		this.errors.push(listener);
	}
	onClose(listener: (code: number | null) => void): void {
		this.closes.push(listener);
	}
	kill(): void {
		this.kills++;
		if (this.errorOnKill) this.error();
		if (this.failKill) throw new Error("DYTEST kill failure");
	}
	error(): void {
		for (const listener of this.errors) listener(new Error("DYTEST child failure"));
	}
	close(code: number | null): void {
		for (const listener of this.closes) listener(code);
	}
}

describe("plain Node worktree inventory", () => {
	it("covers every invented root and descendant with sixteen roots and four reads per root without following links", async () => {
		const f = virtual(),
			release = Promise.withResolvers<void>();
		const admitted = new Set<string>(),
			completed = new Set<string>(),
			seen = new Set<string>();
		const activeByRoot = new Map<string, number>(),
			peakByRoot = new Map<string, number>();
		let activeReads = 0,
			peakReads = 0,
			activeRoots = 0,
			peakRoots = 0;
		f.state.read = async (target) => {
			seen.add(target);
			if (f.roots.includes(target)) {
				admitted.add(target);
				activeRoots++;
				peakRoots = Math.max(peakRoots, activeRoots);
				return [
					...Array.from({ length: 5 }, (_, i) => entry(`child${i}`, true)),
					entry("cycle", true, true),
				];
			}
			const parent = path.dirname(target);
			if (!f.roots.includes(parent) || !/^child[0-4]$/.test(path.basename(target)))
				throw new Error("Unexpected synthetic directory");
			activeReads++;
			peakReads = Math.max(peakReads, activeReads);
			const active = (activeByRoot.get(parent) ?? 0) + 1;
			activeByRoot.set(parent, active);
			peakByRoot.set(parent, Math.max(peakByRoot.get(parent) ?? 0, active));
			try {
				await release.promise;
				return [];
			} finally {
				activeReads--;
				activeByRoot.set(parent, (activeByRoot.get(parent) ?? 0) - 1);
			}
		};
		f.state.stat = async (target) => {
			if (!f.roots.includes(target)) throw new Error("Unexpected synthetic metadata");
			completed.add(target);
			activeRoots--;
			return directory();
		};
		const result = inventoryWorktrees(f.base, f.host);
		void result.catch(() => {});
		try {
			await turn();
			expect(admitted.size).toBe(16);
			expect(activeReads).toBe(64);
			expect([...peakByRoot.values()]).toEqual(Array(16).fill(4));
		} finally {
			release.resolve();
			await result.catch(() => {});
		}
		await expect(result).resolves.toBeUndefined();
		expect(admitted.size).toBe(18);
		expect(completed.size).toBe(18);
		expect(seen.size).toBe(108);
		expect(peakReads).toBe(64);
		expect(peakRoots).toBe(16);
		expect(activeReads).toBe(0);
		expect(activeRoots).toBe(0);
		expect(f.writes).toEqual([]);
	});

	it("latches one root refusal, admits no queued roots and drains every already-admitted read", async () => {
		const f = virtual(),
			holds = f.roots.slice(0, 16).map(() => Promise.withResolvers<void>());
		const admitted: number[] = [];
		let active = 0,
			settled = false;
		f.state.read = async (target) => {
			const index = f.roots.indexOf(target);
			if (index < 0) throw new Error("Unexpected synthetic directory");
			admitted.push(index);
			active++;
			try {
				await holds[index]?.promise;
				return [];
			} finally {
				active--;
			}
		};
		const result = inventoryWorktrees(f.base, f.host).finally(() => {
			settled = true;
		});
		void result.catch(() => {});
		try {
			await turn();
			expect(admitted).toEqual(Array.from({ length: 16 }, (_, i) => i));
			holds[0]?.reject(new Error("DYTEST root failure"));
			await turn();
			expect(settled).toBe(false);
			expect(active).toBe(15);
			expect(admitted).toHaveLength(16);
		} finally {
			for (const hold of holds) hold.resolve();
			await result.catch(() => {});
		}
		await expect(result).rejects.toThrow("file-name inventory failed");
		expect(active).toBe(0);
		expect(admitted).toHaveLength(16);
		expect(f.writes).toEqual([]);
	});

	it("a matching basename remains a refusal without exposing names or writing completion", async () => {
		const f = virtual(1);
		f.state.read = async () => [entry(".env.live")];
		await expect(runWorktreeInventory(f.base, f.host)).rejects.toThrow(
			"file-name inventory failed",
		);
		expect(f.state.stopped).toBe(true);
		expect(f.writes).toEqual([]);
	});
	it.each(["nonzero", "empty-zero"] as const)(
		"refuses %s common-directory evidence without reading roots",
		async (kind) => {
			const f = virtual();
			let reads = 0;
			f.state.read = async () => {
				reads++;
				return [];
			};
			f.state.git = async () => ({ code: kind === "nonzero" ? 1 : 0, stdout: "" });
			await expect(runWorktreeInventory(f.base, f.host)).rejects.toThrow(
				"file-name inventory failed",
			);
			expect(reads).toBe(0);
			expect(f.writes).toEqual([]);
		},
	);

	it("completion waits for drain and then for acknowledgement of the exact sentinel", async () => {
		const f = virtual(),
			drain = Promise.withResolvers<void>();
		let ack: ((error?: Error | null) => void) | undefined,
			settled = false;
		f.state.drain = () => drain.promise;
		f.state.write = (_bytes, callback) => {
			ack = callback;
		};
		const result = completeInventory(f.host).finally(() => {
			settled = true;
		});
		void result.catch(() => {});
		try {
			await turn();
			expect(f.writes).toEqual([]);
			expect(settled).toBe(false);
			drain.resolve();
			await turn();
			expect(f.writes).toEqual([sentinel]);
			expect(settled).toBe(false);
			if (!ack) throw new Error("Missing synthetic acknowledgement");
			ack();
			await expect(result).resolves.toBeUndefined();
		} finally {
			drain.resolve();
			ack?.();
			await result.catch(() => {});
		}
	});
	it.each(["stopped", "undrained"] as const)("does not write completion while %s", async (kind) => {
		const f = virtual();
		if (kind === "stopped") f.state.stopped = true;
		else f.state.drained = () => false;
		await expect(completeInventory(f.host)).rejects.toThrow("file-name inventory failed");
		expect(f.writes).toEqual([]);
	});
	it.each(["stop", "active"] as const)(
		"rechecks %s after the write acknowledgement",
		async (change) => {
			const f = virtual();
			let ack: ((error?: Error | null) => void) | undefined;
			f.state.write = (_bytes, callback) => {
				ack = callback;
			};
			const result = completeInventory(f.host);
			void result.catch(() => {});
			await turn();
			if (change === "stop") f.state.stopped = true;
			else f.state.drained = () => false;
			if (!ack) throw new Error("Missing synthetic acknowledgement");
			ack();
			await expect(result).rejects.toThrow("file-name inventory failed");
		},
	);
	it("a failed acknowledgement never produces completion", async () => {
		const f = virtual();
		f.state.write = (_bytes, ack) => ack(new Error("DYTEST write failure"));
		await expect(completeInventory(f.host)).rejects.toThrow("file-name inventory failed");
	});

	it("Git result and drain wait for actual owned close", async () => {
		const child = new Process();
		const io: InventoryIo = {
			readDirectory: async () => [],
			statPath: async () => directory(),
			spawnGit: () => child,
			write: (_bytes, ack) => ack(),
		};
		const host = createInventoryHost(path.resolve("dytest-owned"), io);
		let settled = false,
			drained = false;
		const result = host
			.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
			.finally(() => {
				settled = true;
			});
		void result.catch(() => {});
		const drain = host.drain().then(() => {
			drained = true;
		});
		child.stdout.data(Buffer.from("DYTEST\n"));
		await turn();
		expect(settled).toBe(false);
		expect(drained).toBe(false);
		expect(host.drained()).toBe(false);
		child.close(0);
		expect(await result).toEqual({ code: 0, stdout: "DYTEST\n" });
		await drain;
		expect(host.drained()).toBe(true);
	});
	it("STOP kills once across a synchronous kill error event and later errors while retaining close ownership", async () => {
		const child = new Process();
		child.errorOnKill = true;
		const writes: string[] = [];
		const io: InventoryIo = {
			readDirectory: async () => [],
			statPath: async () => directory(),
			spawnGit: () => child,
			write: (bytes, ack) => {
				writes.push(bytes);
				ack();
			},
		};
		const host = createInventoryHost(path.resolve("dytest-owned"), io);
		let closedResult = false,
			completed = false;
		const result = host.git(["worktree", "list", "--porcelain", "-z"]).then(
			(value) => {
				closedResult = true;
				return value.code === 0;
			},
			() => {
				closedResult = true;
				return false;
			},
		);
		const completion = completeInventory(host).finally(() => {
			completed = true;
		});
		void completion.catch(() => {});
		try {
			expect(() => host.stop()).not.toThrow();
			expect(child.kills).toBe(1);
			child.error();
			expect(child.kills).toBe(1);
			await turn();
			expect(closedResult).toBe(false);
			expect(completed).toBe(false);
			expect(host.drained()).toBe(false);
			expect(writes).toEqual([]);
		} finally {
			child.close(0);
			await result;
			await completion.catch(() => {});
		}
		expect(await result).toBe(false);
		await expect(completion).rejects.toThrow("file-name inventory failed");
		expect(host.drained()).toBe(true);
		expect(writes).toEqual([]);
	});
	it.each(["stdout-cap", "stderr-cap", "pipe-error"] as const)(
		"keeps %s fatal until Git close and drain",
		async (kind) => {
			const child = new Process();
			const io: InventoryIo = {
				readDirectory: async () => [],
				statPath: async () => directory(),
				spawnGit: () => child,
				write: (_bytes, ack) => ack(),
			};
			const host = createInventoryHost(path.resolve("dytest-owned"), io);
			let settled = false,
				drained = false;
			const outcome = host.git(["worktree", "list", "--porcelain", "-z"]).then(
				(result) => {
					settled = true;
					return result.code === 0;
				},
				() => {
					settled = true;
					return false;
				},
			);
			if (kind === "pipe-error") child.stdout.error();
			else
				child[kind === "stdout-cap" ? "stdout" : "stderr"].data(Buffer.alloc(4 * 1024 * 1024 + 1));
			const drain = host.drain().then(() => {
				drained = true;
			});
			await turn();
			expect(child.kills).toBeGreaterThan(0);
			expect(settled).toBe(false);
			expect(drained).toBe(false);
			child.close(0);
			expect(await outcome).toBe(false);
			await drain;
			expect(host.drained()).toBe(true);
		},
	);
	it("STOP retains pending FS and owned Git until each drains even when kill throws", async () => {
		const child = new Process(),
			read = Promise.withResolvers<Awaited<ReturnType<ReadDirectory>>>(),
			stat = Promise.withResolvers<Awaited<ReturnType<StatPath>>>();
		child.failKill = true;
		let reads = 0,
			spawns = 0,
			drained = false;
		const io: InventoryIo = {
			readDirectory: () => {
				reads++;
				return read.promise;
			},
			statPath: () => stat.promise,
			spawnGit: () => {
				spawns++;
				return child;
			},
			write: (_bytes, ack) => ack(),
		};
		const host = createInventoryHost(path.resolve("dytest-owned"), io);
		const reading = host.readDirectory("DYTEST"),
			statting = host.statPath("DYTEST"),
			git = host.git(["worktree", "list", "--porcelain", "-z"]);
		void git.catch(() => {});
		expect(() => host.stop()).not.toThrow();
		const drain = host.drain().then(() => {
			drained = true;
		});
		read.resolve([]);
		stat.resolve(directory());
		await Promise.allSettled([reading, statting]);
		await turn();
		expect(drained).toBe(false);
		expect(host.drained()).toBe(false);
		await expect(host.readDirectory("DYTEST")).rejects.toThrow("file-name inventory failed");
		await expect(host.git(["worktree", "list", "--porcelain", "-z"])).rejects.toThrow(
			"file-name inventory failed",
		);
		expect(reads).toBe(1);
		expect(spawns).toBe(1);
		child.close(0);
		await Promise.allSettled([git]);
		await drain;
		expect(host.drained()).toBe(true);
	});
});
