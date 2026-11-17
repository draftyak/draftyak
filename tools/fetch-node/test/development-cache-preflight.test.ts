import { type BigIntStats, readFileSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNodeDevelopment, VerificationError } from "../fetch-node.mjs";

const observed = vi.hoisted(() => ({
	armed: false,
	mutations: [] as { operation: string; target: string }[],
}));

// Observe attempted mutations, including a lock opened and subsequently removed.
// Every wrapper still invokes the original filesystem operation.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const record = (operation: string, target: unknown): void => {
		if (observed.armed) observed.mutations.push({ operation, target: String(target) });
	};
	return {
		...actual,
		open(...args: Parameters<typeof actual.open>) {
			const flags = args[1];
			const writing =
				typeof flags === "number"
					? (flags &
							(actual.constants.O_WRONLY |
								actual.constants.O_RDWR |
								actual.constants.O_CREAT |
								actual.constants.O_TRUNC |
								actual.constants.O_APPEND)) !==
						0
					: /[wax+]/.test(flags ?? "r");
			if (writing) record("open", args[0]);
			return actual.open(...args);
		},
		mkdir(...args: Parameters<typeof actual.mkdir>) {
			record("mkdir", args[0]);
			return actual.mkdir(...args);
		},
		mkdtemp(...args: Parameters<typeof actual.mkdtemp>) {
			record("mkdtemp", args[0]);
			return actual.mkdtemp(...args);
		},
		chmod(...args: Parameters<typeof actual.chmod>) {
			record("chmod", args[0]);
			return actual.chmod(...args);
		},
		link(...args: Parameters<typeof actual.link>) {
			record("link", args[1]);
			return actual.link(...args);
		},
		rename(...args: Parameters<typeof actual.rename>) {
			record("rename", args[1]);
			return actual.rename(...args);
		},
		writeFile(...args: Parameters<typeof actual.writeFile>) {
			record("writeFile", args[0]);
			return actual.writeFile(...args);
		},
		unlink(...args: Parameters<typeof actual.unlink>) {
			record("unlink", args[0]);
			return actual.unlink(...args);
		},
		rmdir(...args: Parameters<typeof actual.rmdir>) {
			record("rmdir", args[0]);
			return actual.rmdir(...args);
		},
		rm(...args: Parameters<typeof actual.rm>) {
			record("rm", args[0]);
			return actual.rm(...args);
		},
	};
});

const pins: unknown = JSON.parse(
	readFileSync(new URL("../versions.json", import.meta.url), "utf8"),
);
if (
	!pins ||
	typeof pins !== "object" ||
	!("minimum" in pins) ||
	typeof pins.minimum !== "string" ||
	!/^\d+\.\d+\.\d+$/.test(pins.minimum)
)
	throw new Error("Public Node minimum pin is unavailable");
const version = pins.minimum;
const prefix = "draftyak-development-preflight-";
const sentinelBytes = Buffer.from("Owned outside-cache marker; never development input.\n");

type Kind = "directory" | "file" | "alias";
interface Entry {
	readonly file: string;
	readonly kind: Kind;
	identity?: BigIntStats;
}
interface OwnedTree {
	readonly root: string;
	readonly parent: string;
	readonly parentIdentity: BigIntStats;
	readonly entries: Entry[];
	rootIdentity?: BigIntStats;
}
interface Fixture {
	readonly tree: OwnedTree;
	readonly cache: string;
	readonly outside: string;
	readonly sentinel: string;
}
interface SnapshotRow {
	readonly name: string;
	readonly kind: Kind;
	readonly dev: bigint;
	readonly ino: bigint;
	readonly mode: bigint;
	readonly size: bigint | undefined;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	readonly bytes: string | undefined;
}
const trees = new Set<OwnedTree>();
const bodies = new Set<Promise<void>>();
const acquisitions = new Set<Promise<Fixture>>();
const operations = new Set<Promise<unknown>>();
let teardown: Promise<void> | undefined;
let closing = true;
let cleanupDebt = false;

function admitted(): void {
	if (closing || cleanupDebt)
		throw new Error("Preflight fixture is closing or retains cleanup debt");
}
function ownBody(run: () => Promise<void>): Promise<void> {
	admitted();
	const original = Promise.resolve().then(() => {
		admitted();
		return run();
	});
	bodies.add(original);
	return original;
}
function spelling(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}
function inside(root: string, file: string): void {
	const relative = path.relative(root, file);
	if (
		!path.isAbsolute(root) ||
		!path.isAbsolute(file) ||
		!relative ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	)
		throw new Error("Preflight fixture path is outside its owned root");
}
async function ordinaryDirectory(file: string): Promise<BigIntStats> {
	const identity = await lstat(file, { bigint: true });
	if (
		!identity.isDirectory() ||
		identity.isSymbolicLink() ||
		identity.ino === 0n ||
		spelling(await realpath(file)) !== spelling(file) ||
		!sameIdentity(identity, await lstat(file, { bigint: true }))
	)
		throw new Error("Preflight fixture directory identity is unavailable");
	return identity;
}
async function parentChain(tree: OwnedTree, file: string): Promise<void> {
	inside(tree.root, file);
	if (
		!tree.rootIdentity ||
		!sameIdentity(tree.rootIdentity, await ordinaryDirectory(tree.root)) ||
		!sameIdentity(tree.parentIdentity, await ordinaryDirectory(tree.parent))
	)
		throw new Error("Preflight fixture root identity changed");
	for (let parent = path.dirname(file); parent !== tree.root; parent = path.dirname(parent)) {
		const owned = tree.entries.find((entry) => entry.file === parent && entry.kind === "directory");
		if (!owned?.identity || !sameIdentity(owned.identity, await ordinaryDirectory(parent)))
			throw new Error("Preflight fixture parent identity changed");
	}
}
async function directory(tree: OwnedTree, file: string): Promise<void> {
	admitted();
	await parentChain(tree, file);
	admitted();
	const entry: Entry = { file, kind: "directory" };
	tree.entries.push(entry);
	await mkdir(file, { mode: 0o700 });
	entry.identity = await ordinaryDirectory(file);
}
async function createFixture(): Promise<Fixture> {
	const parent = await realpath(tmpdir());
	const parentIdentity = await ordinaryDirectory(parent);
	admitted();
	const root = await mkdtemp(path.join(parent, prefix));
	const tree: OwnedTree = { root, parent, parentIdentity, entries: [] };
	trees.add(tree);
	tree.rootIdentity = await ordinaryDirectory(root);
	const cache = path.join(root, "cache");
	const outside = path.join(root, "outside-cache");
	await directory(tree, cache);
	await directory(tree, outside);
	const sentinel = path.join(outside, "sentinel.txt");
	await parentChain(tree, sentinel);
	admitted();
	const entry: Entry = { file: sentinel, kind: "file" };
	tree.entries.push(entry);
	await writeFile(sentinel, sentinelBytes, { flag: "wx", mode: 0o600 });
	entry.identity = await lstat(sentinel, { bigint: true });
	if (!entry.identity.isFile() || entry.identity.isSymbolicLink() || entry.identity.ino === 0n)
		throw new Error("Preflight fixture sentinel identity is unavailable");
	return { tree, cache, outside, sentinel };
}
function fixture(): Promise<Fixture> {
	admitted();
	const original = createFixture();
	acquisitions.add(original);
	return original.then((value) => {
		acquisitions.delete(original);
		admitted();
		return value;
	});
}

// Bounded and non-following: an alias is recorded, never traversed.
async function snapshot(tree: OwnedTree): Promise<SnapshotRow[]> {
	if (!tree.rootIdentity || !sameIdentity(tree.rootIdentity, await ordinaryDirectory(tree.root)))
		throw new Error("Preflight snapshot root changed");
	const rows: SnapshotRow[] = [];
	const visit = async (file: string): Promise<void> => {
		inside(tree.root, file);
		if (rows.length >= 32) throw new Error("Preflight snapshot exceeds its owned fixture bound");
		const stat = await lstat(file, { bigint: true });
		const kind = stat.isSymbolicLink() ? "alias" : stat.isDirectory() ? "directory" : "file";
		if (kind === "file" && (!stat.isFile() || stat.size > 4096n))
			throw new Error("Unexpected preflight snapshot entry");
		const bytes = kind === "file" ? (await readFile(file)).toString("hex") : undefined;
		rows.push({
			name: path.relative(tree.root, file),
			kind,
			dev: stat.dev,
			ino: stat.ino,
			mode: stat.mode,
			size: kind === "file" ? stat.size : undefined,
			mtimeNs: stat.mtimeNs,
			ctimeNs: stat.ctimeNs,
			bytes,
		});
		if (kind === "directory") {
			await ordinaryDirectory(file);
			for (const child of (await readdir(file)).sort()) await visit(path.join(file, child));
		}
	};
	for (const child of (await readdir(tree.root)).sort()) await visit(path.join(tree.root, child));
	return rows;
}
async function removeTree(tree: OwnedTree): Promise<void> {
	if (path.dirname(tree.root) !== tree.parent || !path.basename(tree.root).startsWith(prefix))
		throw new Error("Preflight cleanup root boundary changed");
	for (const entry of [...tree.entries].reverse()) {
		await parentChain(tree, entry.file);
		const current = await lstat(entry.file, { bigint: true });
		if (
			!entry.identity ||
			!sameIdentity(entry.identity, current) ||
			(entry.kind === "alias" ? !current.isSymbolicLink() : current.isSymbolicLink()) ||
			(entry.kind === "directory" && !current.isDirectory()) ||
			(entry.kind === "file" && !current.isFile())
		)
			throw new Error("Preflight cleanup entry identity changed");
		if (entry.kind === "directory") await rmdir(entry.file);
		else await unlink(entry.file);
		tree.entries.splice(tree.entries.indexOf(entry), 1);
	}
	if (!tree.rootIdentity || !sameIdentity(tree.rootIdentity, await ordinaryDirectory(tree.root)))
		throw new Error("Preflight cleanup root identity changed");
	await rmdir(tree.root);
	trees.delete(tree);
}

function closeFixtures(): Promise<void> {
	closing = true;
	if (teardown) return teardown;
	const original = Promise.resolve().then(async () => {
		const originals = [...bodies];
		await Promise.allSettled(originals);
		// Rejected assertions are terminal body outcomes, not unresolved resource custody.
		for (const body of originals) bodies.delete(body);
		observed.armed = false;
		const settled = await Promise.allSettled([...acquisitions, ...operations]);
		let failure: unknown;
		if (settled.some((outcome) => outcome.status === "rejected")) {
			cleanupDebt = true;
			failure = new Error("Preflight acquisition retains a rejected original promise");
		}
		for (const tree of [...trees]) {
			try {
				await removeTree(tree);
			} catch (error) {
				cleanupDebt = true;
				failure ??= error;
			}
		}
		if (failure) throw failure;
	});
	teardown = original;
	void original.then(
		() => {
			if (teardown === original) teardown = undefined;
		},
		() => {
			cleanupDebt = true;
		},
	);
	return original;
}

beforeEach(() => {
	if (cleanupDebt || teardown || bodies.size || trees.size || acquisitions.size || operations.size)
		throw new Error("An earlier preflight fixture retains unresolved ownership");
	closing = false;
	observed.armed = false;
	observed.mutations.length = 0;
});
afterEach(() => closeFixtures());

describe("Node development cache alias preflight", () => {
	it.each(["base", "version", "output", "include"] as const)(
		"refuses an existing %s alias before any mutation or download",
		(component) =>
			ownBody(async () => {
				const f = await fixture();
				const directories = ["node-development", version, "win-x64", "include"];
				const target = ["base", "version", "output", "include"].indexOf(component);
				let alias = f.cache;
				for (let index = 0; index <= target; index++) {
					const segment = directories[index];
					if (!segment) throw new Error("Preflight alias component is unavailable");
					alias = path.join(alias, segment);
					if (index < target) await directory(f.tree, alias);
				}
				await parentChain(f.tree, alias);
				admitted();
				const entry: Entry = { file: alias, kind: "alias" };
				f.tree.entries.push(entry);
				await symlink(f.outside, alias, process.platform === "win32" ? "junction" : "dir");
				entry.identity = await lstat(alias, { bigint: true });
				expect(entry.identity.isSymbolicLink()).toBe(true);
				expect(spelling(await realpath(alias))).toBe(spelling(f.outside));
				await expect(
					lstat(path.join(f.cache, "node-development", version, "SHASUMS256.txt")),
				).rejects.toMatchObject({ code: "ENOENT" });
				admitted();
				const before = await snapshot(f.tree);
				admitted();
				const download = vi.fn(async (_url: string): Promise<Uint8Array> => {
					throw new Error("SOFTWARE_ONLY");
				});
				observed.mutations.length = 0;
				observed.armed = true;
				const original = fetchNodeDevelopment(
					{ version, platform: "win", arch: "x64", offline: false },
					{ cacheDir: f.cache, download },
				);
				operations.add(original);
				let error: unknown;
				try {
					await original;
				} catch (reason) {
					error = reason;
				} finally {
					operations.delete(original);
					observed.armed = false;
				}
				admitted();
				const after = await snapshot(f.tree);
				admitted();
				const sentinel = await readFile(f.sentinel);
				admitted();
				const outside = (row: SnapshotRow): boolean =>
					row.name === "outside-cache" || row.name.startsWith(`outside-cache${path.sep}`);
				// Capture both full snapshots and compare the outside target before the causal assertion.
				expect(after.filter(outside)).toEqual(before.filter(outside));
				expect(sentinel).toEqual(sentinelBytes);
				expect(download).not.toHaveBeenCalled();
				expect(error).toBeInstanceOf(VerificationError);
				if (!(error instanceof VerificationError)) throw new Error("Expected component refusal");
				expect(error.message).toBe(
					"Node development cache component is not ordinary and canonical",
				);
				expect(observed.mutations).toEqual([]);
				expect(after).toEqual(before);
			}),
	);
});
