import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	namedFiles,
	namedWorktreeFiles,
	type ReadDirectory,
	type StatPath,
} from "../lib/workspace-policy.ts";
import { type InventoryHost, inventoryWorktrees } from "../lib/worktree-inventory.ts";

type Entries = Awaited<ReturnType<ReadDirectory>>;

const kind = (directory = true, link = false) => ({
	isDirectory: () => directory,
	isSymbolicLink: () => link,
});
const entry = (name: string, directory = true, link = false) => ({
	name,
	...kind(directory, link),
});
const fsError = (code: string): Error =>
	Object.assign(new Error("synthetic filesystem failure"), { code });
const fixtureRoot = (name: string): string => path.resolve("inventory-capacity-synthetic", name);
const inside = (root: string, target: string): boolean => {
	const relative = path.relative(root, target);
	return (
		relative !== "" &&
		relative !== ".." &&
		!relative.startsWith(".." + path.sep) &&
		!path.isAbsolute(relative)
	);
};
const observe = <T>(work: Promise<T>) =>
	work.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);

// These ports own only synthetic promises. They create no processes or close receipts.
class SyntheticFs {
	readonly listings = new Map<string, Entries>();
	readonly directoryCalls: string[] = [];
	readonly held = new Set<string>();
	private readonly pending = new Map<string, () => void>();
	private readonly operations = new Set<Promise<unknown>>();
	private releaseFuture = false;
	active = 0;
	peak = 0;
	wideRoot: string | undefined;
	wideReads = 0;
	widePeak = 0;

	private track<T>(work: () => Promise<T>): Promise<T> {
		this.active += 1;
		this.peak = Math.max(this.peak, this.active);
		const result = (async () => {
			try {
				return await work();
			} finally {
				this.active -= 1;
			}
		})();
		this.operations.add(result);
		void result.then(
			() => this.operations.delete(result),
			() => this.operations.delete(result),
		);
		return result;
	}

	readonly readDirectory: ReadDirectory = (directory) =>
		this.track(async () => {
			this.directoryCalls.push(directory);
			const wide = this.wideRoot !== undefined && inside(this.wideRoot, directory);
			if (wide) {
				this.wideReads += 1;
				this.widePeak = Math.max(this.widePeak, this.wideReads);
			}
			try {
				if (this.held.has(directory) && !this.releaseFuture) {
					const gate = Promise.withResolvers<void>();
					this.pending.set(directory, () => gate.resolve());
					await gate.promise;
				}
				const found = this.listings.get(directory);
				if (found === undefined) throw fsError("ENOENT");
				return found;
			} finally {
				this.pending.delete(directory);
				if (wide) this.wideReads -= 1;
			}
		});

	readonly statPath: StatPath = (target) =>
		this.track(async () => {
			if (!this.listings.has(target)) throw fsError("ENOENT");
			return kind();
		});

	pendingPaths(): string[] {
		return [...this.pending.keys()];
	}

	release(target: string): void {
		const resolve = this.pending.get(target);
		if (resolve === undefined) throw new Error("synthetic read was not admitted");
		this.pending.delete(target);
		resolve();
	}

	releaseAll(): void {
		this.releaseFuture = true;
		for (const resolve of this.pending.values()) resolve();
		this.pending.clear();
	}

	async drain(): Promise<void> {
		while (this.operations.size > 0) await Promise.allSettled([...this.operations]);
	}
}

function hostFor(fs: SyntheticFs, main: string, roots: readonly string[]): InventoryHost {
	let stopped = false;
	return {
		git: async (args) => {
			if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
				return { code: 0, stdout: path.join(main, ".git") + "\n" };
			}
			if (args.join(" ") === "worktree list --porcelain -z") {
				return {
					code: 0,
					stdout: [main, ...roots].map((root) => "worktree " + root + "\0\0").join(""),
				};
			}
			throw new Error("unexpected synthetic Git request");
		},
		readDirectory: fs.readDirectory,
		statPath: fs.statPath,
		stopped: () => stopped,
		stop: () => {
			stopped = true;
		},
		drain: () => fs.drain(),
		drained: () => fs.active === 0,
		write: () => {
			throw new Error("inventoryWorktrees must not write a completion sentinel");
		},
	};
}

function wideFixture(match: boolean) {
	const fs = new SyntheticFs();
	const main = fixtureRoot("main");
	const empty = Array.from({ length: 15 }, (_, index) => fixtureRoot("empty-" + index));
	const wide = fixtureRoot("wide");
	const names = [
		"node_modules",
		".ignored",
		"nested.git",
		"郵便📨",
		...Array.from({ length: 92 }, (_, index) => "branch-" + index),
	];
	fs.wideRoot = wide;
	for (const root of empty) {
		fs.listings.set(root, []);
		fs.held.add(root);
	}
	fs.listings.set(
		wide,
		names.map((name) => entry(name)),
	);
	for (const name of names) {
		const child = path.join(wide, name);
		fs.listings.set(child, []);
		fs.held.add(child);
	}
	const unicode = path.join(wide, "郵便📨");
	const deep = path.join(unicode, "deep");
	fs.listings.set(unicode, [entry("deep")]);
	fs.listings.set(deep, match ? [entry(".env.live", false)] : []);
	const expected = [...empty, wide, ...names.map((name) => path.join(wide, name)), deep].sort();
	return { fs, main, empty, wide, expected };
}

describe("inventory directory read capacity", () => {
	it.each([false, true])(
		"reuses idle root capacity without losing late match=%s",
		async (match) => {
			const { fs, main, empty, wide, expected } = wideFixture(match);
			const completion = observe(inventoryWorktrees(main, hostFor(fs, main, [...empty, wide])));
			try {
				await setImmediate();
				expect(fs.pendingPaths().filter((target) => inside(wide, target))).toHaveLength(4);
				expect(fs.widePeak).toBe(4);
				expect(fs.peak).toBeLessThanOrEqual(64);
				for (const root of empty) fs.release(root);
				await setImmediate();
				expect(fs.active).toBe(4);
				const tailRead = fs.pendingPaths().find((target) => inside(wide, target));
				if (tailRead === undefined) throw new Error("wide tail was not admitted");
				fs.release(tailRead);
				await setImmediate();
				expect(fs.wideReads).toBe(64);
				expect(fs.widePeak).toBe(64);
				expect(fs.peak).toBeLessThanOrEqual(64);
				fs.releaseAll();
				const result = await completion;
				expect(result.ok).toBe(!match);
				if (!result.ok) expect(result.error).toEqual(new Error("file-name inventory failed"));
				expect(fs.directoryCalls.toSorted()).toEqual(expected);
				expect(new Set(fs.directoryCalls).size).toBe(expected.length);
				expect(fs.directoryCalls).not.toContain(main);
				expect(fs.active).toBe(0);
				expect(fs.peak).toBeLessThanOrEqual(64);
			} finally {
				fs.releaseAll();
				await completion;
			}
		},
	);

	const failures: readonly (readonly [string, () => number])[] = [
		["zero", () => 0],
		["above64", () => 65],
		["fractional", () => 1.5],
		["nonfinite", () => Number.NaN],
		[
			"throwing",
			() => {
				throw new Error("synthetic quota failure");
			},
		],
	];
	it.each(failures)("drains admitted reads after a %s capacity refusal", async (_name, failure) => {
		const fs = new SyntheticFs();
		const root = fixtureRoot("refusal");
		const children = Array.from({ length: 12 }, (_, index) => "child-" + index);
		fs.listings.set(
			root,
			children.map((name) => entry(name)),
		);
		for (const child of children) {
			const target = path.join(root, child);
			fs.listings.set(target, []);
			fs.held.add(target);
		}
		let capacity = (): number => 4;
		let settled = false;
		const completion = observe(
			namedFiles(".env.live", root, false, fs.readDirectory, fs.statPath, () => capacity()),
		);
		void completion.then(() => {
			settled = true;
		});
		try {
			await setImmediate();
			expect(fs.pendingPaths()).toHaveLength(4);
			const admitted = fs.directoryCalls.length;
			capacity = failure;
			const first = fs.pendingPaths()[0];
			if (first === undefined) throw new Error("no admitted read to release");
			fs.release(first);
			await setImmediate();
			expect(fs.directoryCalls).toHaveLength(admitted);
			expect(fs.active).toBe(3);
			expect(settled).toBe(false);
			fs.releaseAll();
			const result = await completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toEqual(new Error("file-name inventory failed"));
			expect(fs.active).toBe(0);
			expect(fs.directoryCalls).toHaveLength(admitted);
		} finally {
			fs.releaseAll();
			await completion;
		}
	});

	it.each([false, true])(
		"keeps default4 and exact name/link coverage insensitive=%s",
		async (insensitive) => {
			const fs = new SyntheticFs();
			const root = fixtureRoot("coverage");
			const branches = Array.from({ length: 8 }, (_, index) => "branch-" + index);
			fs.listings.set(root, [
				...branches.map((name) => entry(name)),
				entry("郵便📨"),
				entry("link-out", true, true),
				entry(".env.live", true, true),
				entry(".ENV.LIVE", false),
			]);
			for (const branch of branches) {
				const target = path.join(root, branch);
				fs.listings.set(target, []);
				fs.held.add(target);
			}
			fs.listings.set(path.join(root, "郵便📨"), [entry("deep")]);
			fs.listings.set(path.join(root, "郵便📨", "deep"), [entry(".env.live", false)]);
			const completion = observe(
				namedFiles(".env.live", root, insensitive, fs.readDirectory, fs.statPath),
			);
			try {
				await setImmediate();
				expect(fs.active).toBe(4);
				fs.releaseAll();
				const result = await completion;
				const expected = [
					".env.live",
					"郵便📨/deep/.env.live",
					...(insensitive ? [".ENV.LIVE"] : []),
				].sort();
				expect(result).toEqual({ ok: true, value: expected });
				expect(fs.peak).toBe(4);
				expect(fs.directoryCalls).not.toContain(path.join(root, "link-out"));
				expect(fs.directoryCalls).not.toContain(path.join(root, ".env.live"));
				expect(fs.directoryCalls.toSorted()).toEqual(
					[
						root,
						...branches.map((name) => path.join(root, name)),
						path.join(root, "郵便📨"),
						path.join(root, "郵便📨", "deep"),
					].sort(),
				);
			} finally {
				fs.releaseAll();
				await completion;
			}
		},
	);

	it("refuses a root replaced by a directory link", async () => {
		const root = fixtureRoot("replaced-root");
		await expect(
			namedWorktreeFiles(
				".env.live",
				root,
				async () => [{ directory: root, prunable: false }],
				false,
				async () => [],
				async () => kind(true, true),
				() => 64,
			),
		).rejects.toThrow("file-name inventory failed");
	});

	it("skips a vanished child only after a fresh parent listing proves absence", async () => {
		const root = fixtureRoot("vanished");
		const gone = path.join(root, "gone");
		let parentReads = 0;
		let childReads = 0;
		const readDirectory: ReadDirectory = async (directory) => {
			if (directory === root) return ++parentReads === 1 ? [entry("gone")] : [];
			if (directory === gone) {
				childReads += 1;
				throw fsError("ENOENT");
			}
			throw new Error("unexpected synthetic directory");
		};
		const statPath: StatPath = async (target) => {
			if (target === gone) throw fsError("ENOENT");
			return kind();
		};
		await expect(
			namedFiles(".env.live", root, false, readDirectory, statPath, () => 64),
		).resolves.toEqual([]);
		expect(parentReads).toBe(2);
		expect(childReads).toBe(1);
	});

	it("refuses a still-present unreadable child after the existing bounded retry", async () => {
		const root = fixtureRoot("unreadable");
		const blocked = path.join(root, "blocked");
		let childReads = 0;
		const readDirectory: ReadDirectory = async (directory) => {
			if (directory === root) return [entry("blocked")];
			if (directory === blocked) {
				childReads += 1;
				throw fsError("EACCES");
			}
			throw new Error("unexpected synthetic directory");
		};
		await expect(
			namedFiles(
				".env.live",
				root,
				false,
				readDirectory,
				async () => kind(),
				() => 64,
			),
		).rejects.toThrow("file-name inventory failed");
		expect(childReads).toBe(2);
	});

	it.each(["lossy\uFFFD", "unpaired\uD800"])("refuses malformed entry %#", async (name) => {
		await expect(
			namedFiles(
				".env.live",
				fixtureRoot("malformed"),
				false,
				async () => [entry(name)],
				async () => kind(),
				() => 64,
			),
		).rejects.toThrow("file-name inventory failed");
	});
});
