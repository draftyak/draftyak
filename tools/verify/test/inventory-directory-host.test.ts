import path from "node:path";
import { describe, expect, it } from "vitest";
import type { InventoryDirectory, InventoryDirectoryEntry } from "../lib/inventory-directory.ts";
import { namedWorktreeFiles } from "../lib/workspace-policy.ts";
import { completeInventory, createInventoryHost } from "../lib/worktree-inventory.ts";

const turn = async (): Promise<void> => {
	await new Promise<void>((resolve) => setImmediate(resolve));
};
const unexpected = (): never => {
	throw new Error("unexpected raw pathname/Git operation");
};

function fixture(openDirectory: (root: string) => Promise<InventoryDirectory>) {
	const writes: string[] = [];
	const host = createInventoryHost(path.resolve("DYTEST-bound-host"), {
		readDirectory: unexpected,
		statPath: unexpected,
		openDirectory,
		spawnGit: unexpected,
		write: (bytes, ack) => {
			writes.push(bytes);
			ack();
		},
	});
	return { host, writes };
}

describe("opened inventory directory custody", () => {
	it("a close rejection cannot become successful missing-root recovery", async () => {
		const root = path.resolve("DYTEST-close-absence", "root");
		let missing = false,
			refreshes = 0;
		const open = async (target: string): Promise<InventoryDirectory> => {
			if (target === root && missing)
				throw Object.assign(new Error("DYTEST absent"), { code: "ENOENT" });
			return {
				read: async () => [],
				stat: async () => "directory",
				current: async () => true,
				stop: () => {},
				close: async () => {
					if (target === root) {
						missing = true;
						throw new Error("DYTEST original close failure");
					}
				},
			};
		};
		await expect(
			namedWorktreeFiles(
				".gate-sentinel",
				root,
				async () => {
					refreshes += 1;
					return [{ directory: path.resolve("DYTEST-other-root"), prunable: false }];
				},
				false,
				undefined,
				undefined,
				() => 1,
				open,
			),
		).rejects.toThrow("file-name inventory failed");
		expect(refreshes).toBe(0);
	});

	it("CLOSE fences each new scope operation synchronously before the held close", async () => {
		const closing = Promise.withResolvers<void>();
		let admitted = 0,
			closes = 0;
		const { host } = fixture(async () => ({
			read: async () => {
				admitted += 1;
				return [];
			},
			stat: async () => {
				admitted += 1;
				return "directory";
			},
			current: async () => {
				admitted += 1;
				return true;
			},
			stop: () => {},
			close: () => {
				closes += 1;
				return closing.promise;
			},
		}));
		const directory = await host.openDirectory?.(path.resolve("DYTEST-bound-host"));
		if (directory === undefined) throw new Error("missing physical directory port");
		const close = directory.close();
		// Capture outcomes without awaiting so all three admissions precede any close microtask.
		const operations = Promise.allSettled([
			directory.read([]),
			directory.stat([]),
			directory.current(),
		]);
		try {
			const outcomes = await operations;
			expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected", "rejected"]);
			expect(admitted).toBe(0);
			expect(directory.close()).toBe(close);
			expect(host.drained()).toBe(false);
		} finally {
			closing.resolve();
			await close;
		}
		expect(closes).toBe(1);
		expect(host.drained()).toBe(true);
	});

	it("STOP during acquisition retains the acquired original through its actual close", async () => {
		const opening = Promise.withResolvers<InventoryDirectory>();
		const closing = Promise.withResolvers<void>();
		let opens = 0,
			stops = 0,
			closes = 0,
			acquisitionSettled = false,
			drained = false;
		const { host, writes } = fixture(() => {
			opens += 1;
			return opening.promise;
		});
		const acquired = host.openDirectory?.(path.resolve("DYTEST-bound-host"));
		if (acquired === undefined) throw new Error("missing physical directory port");
		const outcome = acquired
			.then(
				() => false,
				() => true,
			)
			.finally(() => {
				acquisitionSettled = true;
			});
		host.stop();
		const drain = host.drain().then(() => {
			drained = true;
		});
		opening.resolve({
			read: unexpected,
			stat: unexpected,
			current: unexpected,
			stop: () => {
				stops += 1;
			},
			close: () => {
				closes += 1;
				return closing.promise;
			},
		});
		await turn();
		expect({ acquisitionSettled, drained, stops, closes }).toEqual({
			acquisitionSettled: false,
			drained: false,
			stops: 1,
			closes: 1,
		});
		expect(host.drained()).toBe(false);
		await expect(host.openDirectory?.(path.resolve("DYTEST-bound-host"))).rejects.toThrow(
			"file-name inventory failed",
		);
		expect(opens).toBe(1);
		expect(writes).toEqual([]);
		closing.resolve();
		expect(await outcome).toBe(true);
		await drain;
		expect(host.drained()).toBe(true);
	});

	it("STOP fences new reads while drain joins the old read and original root close", async () => {
		const reading = Promise.withResolvers<readonly InventoryDirectoryEntry[]>();
		const closing = Promise.withResolvers<void>();
		let reads = 0,
			closes = 0,
			drained = false;
		const { host, writes } = fixture(async () => ({
			read: () => {
				reads += 1;
				return reading.promise;
			},
			stat: unexpected,
			current: unexpected,
			stop: () => {},
			close: () => {
				closes += 1;
				return closing.promise;
			},
		}));
		const directory = await host.openDirectory?.(path.resolve("DYTEST-bound-host"));
		if (directory === undefined) throw new Error("missing physical directory port");
		const read = directory.read([]).then(
			() => false,
			() => true,
		);
		host.stop();
		const drain = host.drain().then(() => {
			drained = true;
		});
		await expect(directory.read([])).rejects.toThrow("file-name inventory failed");
		expect(reads).toBe(1);
		await turn();
		expect(closes).toBe(0);
		reading.resolve([{ name: "DYTEST-name", kind: "other" }]);
		expect(await read).toBe(true);
		await turn();
		expect(closes).toBe(1);
		expect(drained).toBe(false);
		expect(host.drained()).toBe(false);
		expect(writes).toEqual([]);
		closing.resolve();
		await drain;
		expect(host.drained()).toBe(true);
	});

	it("an original close failure prevents drain and the success sentinel", async () => {
		let closes = 0;
		const { host, writes } = fixture(async () => ({
			read: async () => [],
			stat: async () => "directory",
			current: async () => true,
			stop: () => {},
			close: async () => {
				closes += 1;
				throw new Error("DYTEST close failure");
			},
		}));
		await host.openDirectory?.(path.resolve("DYTEST-bound-host"));
		await expect(completeInventory(host)).rejects.toThrow("file-name inventory failed");
		await expect(host.drain()).rejects.toThrow("file-name inventory failed");
		expect(host.drained()).toBe(false);
		expect(closes).toBe(1);
		expect(writes).toEqual([]);
	});
});
