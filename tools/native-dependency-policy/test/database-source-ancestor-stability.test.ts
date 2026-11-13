import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	afterStat: undefined as ((filename: string) => Promise<void>) | undefined,
	afterNames: undefined as ((directory: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (...args: Parameters<typeof actual.lstat>) => {
			const stat = await actual.lstat(...args);
			await hooks.afterStat?.(String(args[0]));
			return stat;
		},
		readdir: async (...args: Parameters<typeof actual.readdir>) => {
			const names = await actual.readdir(...args);
			await hooks.afterNames?.(String(args[0]));
			return names;
		},
	};
});

const { DatabaseSourceError, databaseSourceTestInterface } = await import(
	"../src/database-source.ts"
);
const NOW = 1_800_000_000_000;
const realGitHost =
	process.platform === "win32" || (process.platform === "linux" && process.arch === "x64");
const PREFIX = ".database-source-test-ancestor-";
const owned: string[] = [];
let base = "";

interface GitObject {
	readonly id: string;
	readonly bytes: Buffer;
	readonly loose: Buffer;
}
function object(type: "blob" | "tree" | "commit", bytes: Buffer): GitObject {
	const encoded = Buffer.concat([Buffer.from(type + " " + bytes.length + "\0"), bytes]);
	return {
		id: createHash("sha1").update(encoded).digest("hex"),
		bytes,
		loose: deflateSync(encoded),
	};
}
function tree(mode: string, name: string, child: GitObject): GitObject {
	return object(
		"tree",
		Buffer.concat([Buffer.from(mode + " " + name + "\0"), Buffer.from(child.id, "hex")]),
	);
}
async function fixture() {
	const parent = await fs.mkdtemp(path.join(base, PREFIX));
	owned.push(parent);
	const route = path.join(parent, "route");
	const root = path.join(route, "selected-db");
	const blob = object("blob", Buffer.from("DYTEST opaque advisory\n"));
	const directory = tree("100644", "RUSTSEC-2099-0001.toml", blob);
	const top = tree("40000", "advisories", directory);
	const commit = object(
		"commit",
		Buffer.from(
			[
				"tree " + top.id,
				"author DYTEST <dytest@example.invalid> 0 +0000",
				"committer DYTEST <dytest@example.invalid> 0 +0000",
				"",
				"DYTEST opaque message",
				"",
			].join("\n"),
		),
	);
	const objects = [blob, directory, top, commit];
	async function populate(target: string) {
		await fs.mkdir(path.join(target, ".git/objects"), { recursive: true });
		await fs.mkdir(path.join(target, ".git/refs/heads"), { recursive: true });
		for (const entry of objects) {
			const containing = path.join(target, ".git/objects", entry.id.slice(0, 2));
			await fs.mkdir(containing, { recursive: true });
			await fs.writeFile(path.join(containing, entry.id.slice(2)), entry.loose);
		}
		await fs.writeFile(path.join(target, ".git/HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(target, ".git/refs/heads/main"), commit.id + "\n");
		await fs.writeFile(path.join(target, ".git/config"), "DYTEST invalid Git configuration\n");
		await fs.mkdir(path.join(target, "advisories"));
		const advisory = path.join(target, "advisories/RUSTSEC-2099-0001.toml");
		await fs.writeFile(advisory, blob.bytes);
		if (process.platform !== "win32") await fs.chmod(advisory, 0o644);
	}
	await populate(root);
	await fs.writeFile(path.join(parent, "DYTEST-unrelated-one"), "DYTEST sibling\n");
	return {
		parent,
		route,
		root,
		blob,
		commit,
		populate,
		file: path.join(root, "advisories/RUSTSEC-2099-0001.toml"),
		objectFile: path.join(root, ".git/objects", blob.id.slice(0, 2), blob.id.slice(2)),
	};
}
function ancestorChurn(parent: string) {
	let changes = 0;
	let current = "DYTEST-unrelated-one";
	hooks.afterNames = async (directory) => {
		if (directory !== parent) return;
		if (++changes > 1000) throw Error("DYTEST ancestor churn bound");
		const next =
			current === "DYTEST-unrelated-one" ? "DYTEST-unrelated-two" : "DYTEST-unrelated-one";
		await moveOwned(path.join(parent, current), path.join(parent, next));
		current = next;
		const time = new Date(NOW + changes * 1000);
		await fs.utimes(parent, time, time);
	};
	return () => changes;
}
async function fullIdentity(filename: string) {
	const s = await fs.lstat(filename, { bigint: true });
	return [s.dev, s.ino, s.size, s.mode, s.nlink, s.mtimeNs, s.ctimeNs];
}
async function moveOwned(from: string, to: string): Promise<void> {
	const prefix = base + path.sep + PREFIX;
	const original = await fs.realpath(from);
	const destination = path.resolve(await fs.realpath(path.dirname(to)), path.basename(to));
	if (
		!path.isAbsolute(from) ||
		!path.isAbsolute(to) ||
		!path.resolve(from).startsWith(prefix) ||
		!path.resolve(to).startsWith(prefix) ||
		!original.startsWith(prefix) ||
		!destination.startsWith(prefix)
	)
		throw Error("DYTEST directory move containment refused");
	await fs.rename(from, to);
}
function reader(root: string, commit: string) {
	const head = vi.fn(async () => commit);
	const source = databaseSourceTestInterface.create({ databaseRoot: root, head, clock: () => NOW });
	return { source, head };
}
function mutateSelected(root: string, mutate: () => Promise<void>) {
	let applied = false;
	hooks.afterStat = async (filename) => {
		if (filename !== root || applied) return;
		applied = true;
		hooks.afterStat = undefined;
		await mutate();
	};
	return () => applied;
}
beforeEach(async () => {
	hooks.afterStat = undefined;
	hooks.afterNames = undefined;
	base = await fs.realpath(process.cwd());
});
afterEach(async () => {
	hooks.afterStat = undefined;
	hooks.afterNames = undefined;
	for (const parent of owned.splice(0)) {
		const resolved = await fs.realpath(parent).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		if (resolved === undefined) continue;
		if (!resolved.startsWith(base + path.sep + PREFIX))
			throw Error("DYTEST cleanup containment refused");
		await fs.rm(resolved, { recursive: true, force: true });
	}
});

function supportedCases() {
	it("keeps real Git and physical facts stable through sibling churn and revalidation", async () => {
		const data = await fixture();
		const beforeParent = await fs.lstat(data.parent, { bigint: true });
		const rootIdentity = await fullIdentity(data.root);
		const { source, head } = reader(data.root, data.commit.id);
		const changes = ancestorChurn(data.parent);

		const first = await source.observe();
		const firstFacts = databaseSourceTestInterface.metadata(source, first);
		expect(firstFacts).toMatchObject({
			delivery: "test-only",
			commit: data.commit.id,
			currentCommit: data.commit.id,
			observedAt: NOW,
		});
		expect(firstFacts.revision).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(firstFacts)).toBe(true);
		expect(Object.keys(first)).toEqual([]);
		expect(() => source.basis(first)).toThrow(
			expect.objectContaining({ code: "DATABASE_SOURCE_TEST_ONLY" }),
		);

		const second = await source.revalidate(first);
		const secondFacts = databaseSourceTestInterface.metadata(source, second);
		expect(second).not.toBe(first);
		expect(secondFacts.revision).toBe(firstFacts.revision);
		expect(secondFacts.commit).toBe(data.commit.id);
		expect(head).toHaveBeenCalledTimes(4);
		expect(changes()).toBeGreaterThan(1);
		hooks.afterNames = undefined;
		const afterParent = await fs.lstat(data.parent, { bigint: true });
		expect([afterParent.dev, afterParent.ino, afterParent.mode]).toEqual([
			beforeParent.dev,
			beforeParent.ino,
			beforeParent.mode,
		]);
		expect(afterParent.mtimeNs).not.toBe(beforeParent.mtimeNs);
		expect(await fullIdentity(data.root)).toEqual(rootIdentity);
		expect(await fs.readFile(data.file)).toEqual(data.blob.bytes);
		expect(await fs.readFile(data.objectFile)).toEqual(data.blob.loose);
	});

	it("refuses replacement of the selected database inode despite unchanged object bytes", async () => {
		const data = await fixture();
		const original = await fs.lstat(data.root, { bigint: true });
		const held = path.join(data.parent, "DYTEST-held-original");
		const { source } = reader(data.root, data.commit.id);
		ancestorChurn(data.parent);
		const applied = mutateSelected(data.root, async () => {
			await moveOwned(data.root, held);
			await data.populate(data.root);
		});
		await expect(source.observe()).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(applied()).toBe(true);
		hooks.afterNames = undefined;
		expect((await fs.lstat(data.root, { bigint: true })).ino).not.toBe(original.ino);
		expect(await fs.readFile(data.file)).toEqual(data.blob.bytes);
	});

	it("refuses a case-renamed selected component through its former spelling", async () => {
		const data = await fixture();
		const alias = path.join(data.route, "SELECTED-DB");
		const { source } = reader(data.root, data.commit.id);
		ancestorChurn(data.parent);
		let renamed = false;
		const applied = mutateSelected(data.root, async () => {
			await moveOwned(data.root, alias);
			const names = await fs.readdir(data.route);
			renamed = names.includes("SELECTED-DB") && !names.includes("selected-db");
		});
		try {
			await expect(source.observe()).rejects.toBeInstanceOf(DatabaseSourceError);
			expect(applied()).toBe(true);
			expect(renamed).toBe(true);
		} finally {
			hooks.afterStat = undefined;
			hooks.afterNames = undefined;
			if (applied()) await moveOwned(alias, data.root);
		}
	});

	it("refuses a selected-component directory link with an otherwise genuine object tree", async () => {
		const data = await fixture();
		const held = path.join(data.parent, "DYTEST-link-target");
		const { source } = reader(data.root, data.commit.id);
		ancestorChurn(data.parent);
		let linked = false;
		const applied = mutateSelected(data.root, async () => {
			await moveOwned(data.root, held);
			await fs.symlink(held, data.root, process.platform === "win32" ? "junction" : "dir");
			linked = true;
		});
		try {
			await expect(source.observe()).rejects.toBeInstanceOf(DatabaseSourceError);
			expect(applied()).toBe(true);
			expect(linked).toBe(true);
		} finally {
			hooks.afterStat = undefined;
			hooks.afterNames = undefined;
			if (linked) {
				if (process.platform === "win32") await fs.rmdir(data.root);
				else await fs.unlink(data.root);
			}
			if (applied()) await moveOwned(held, data.root);
		}
	});

	it("refuses a changed ancestor binding even when the selected database inode survives", async () => {
		const data = await fixture();
		const beforeParent = await fs.lstat(data.parent, { bigint: true });
		const beforeRoot = await fullIdentity(data.root);
		const heldParent = data.parent + "-held";
		const { source } = reader(data.root, data.commit.id);
		let swapped = false;
		hooks.afterNames = async (directory) => {
			if (directory !== data.parent || swapped) return;
			hooks.afterNames = undefined;
			await moveOwned(data.parent, heldParent);
			owned.push(heldParent);
			await fs.mkdir(data.parent);
			await moveOwned(path.join(heldParent, "route"), data.route);
			swapped = true;
		};
		await expect(source.observe()).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(swapped).toBe(true);
		const afterParent = await fs.lstat(data.parent, { bigint: true });
		const afterRoot = await fullIdentity(data.root);
		expect(afterParent.ino).not.toBe(beforeParent.ino);
		expect(afterRoot).toEqual(beforeRoot);
		expect(await fs.readFile(data.file)).toEqual(data.blob.bytes);
		expect(await fs.readFile(data.objectFile)).toEqual(data.blob.loose);
	});

	it("keeps the selected database root's full metadata immutable during a path check", async () => {
		const data = await fixture();
		const before = await fs.lstat(data.root, { bigint: true });
		const { source } = reader(data.root, data.commit.id);
		ancestorChurn(data.parent);
		const applied = mutateSelected(data.root, async () => {
			const time = new Date(NOW + 10_000);
			await fs.utimes(data.root, time, time);
		});
		await expect(source.observe()).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(applied()).toBe(true);
		hooks.afterNames = undefined;
		const after = await fs.lstat(data.root, { bigint: true });
		expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
		expect(after.mtimeNs).not.toBe(before.mtimeNs);
	});

	it("still refuses changed physical advisory bytes after a genuine observation", async () => {
		const data = await fixture();
		const { source } = reader(data.root, data.commit.id);
		const changes = ancestorChurn(data.parent);
		const observed = await source.observe();
		await fs.writeFile(data.file, "DYTEST changed physical advisory\n");
		await expect(source.revalidate(observed)).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(changes()).toBeGreaterThan(1);
		hooks.afterNames = undefined;
		expect(await fs.readFile(data.objectFile)).toEqual(data.blob.loose);
	});

	it("still refuses a changed loose Git object with unchanged physical advisory bytes", async () => {
		const data = await fixture();
		const { source } = reader(data.root, data.commit.id);
		const changes = ancestorChurn(data.parent);
		const observed = await source.observe();
		await fs.writeFile(
			data.objectFile,
			object("blob", Buffer.from("DYTEST changed object\n")).loose,
		);
		await expect(source.revalidate(observed)).rejects.toBeInstanceOf(DatabaseSourceError);
		expect(changes()).toBeGreaterThan(1);
		hooks.afterNames = undefined;
		expect(await fs.readFile(data.file)).toEqual(data.blob.bytes);
	});
}
if (realGitHost) {
	describe("selected database observations under unrelated ancestor churn", supportedCases);
} else {
	describe("NotRun: real-Git ancestor observations are unsupported on this host", () => {
		it("requires an explicit unavailable refusal instead of an end-to-end observation", async () => {
			const data = await fixture();
			const { source, head } = reader(data.root, data.commit.id);
			await expect(source.observe()).rejects.toEqual(
				expect.objectContaining({
					name: "DatabaseSourceError",
					code: "DATABASE_SOURCE_UNAVAILABLE",
					message: "database source refused",
				}),
			);
			expect(head).not.toHaveBeenCalled();
		});
	});
}
