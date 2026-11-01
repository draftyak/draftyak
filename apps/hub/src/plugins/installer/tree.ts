import { randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay, setImmediate as turn } from "node:timers/promises";
import { refuse } from "./policy.ts";

const WINDOWS = process.platform === "win32";
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
// On Windows any open handle under a folder, such as a scanner's, blocks renaming that folder.
const RENAME_RETRY_MS = [10, 20, 40, 80, 160, 320, 640, 1280];

/**
 * One install's staging folder, with every directory (parents first) and file it created, each with
 * its last recorded state: from creation, then once written or sealed.
 */
export interface Tree {
	readonly root: string;
	readonly rootStat: BigIntStats;
	readonly top: string;
	readonly directories: Map<string, BigIntStats>;
	readonly files: Map<string, BigIntStats>;
}

type Stamp = Pick<BigIntStats, "dev" | "ino" | "nlink" | "mode" | "size" | "mtimeNs" | "ctimeNs">;

function identity(before: Stamp, after: Stamp): boolean {
	return before.ino !== 0n && before.ino === after.ino && before.dev === after.dev;
}

/**
 * The same entry, with the same links, mode (file type included), size, and modification and
 * change times.
 */
export function unchanged(before: Stamp, after: Stamp): boolean {
	return (
		identity(before, after) &&
		before.nlink === after.nlink &&
		before.mode === after.mode &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	);
}

/** A real directory under its canonical name, and the one recorded earlier when given. */
function directory(name: string, expected?: BigIntStats): BigIntStats {
	const stat = lstatSync(name, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		realpathSync.native(name) !== name ||
		(expected !== undefined && !identity(expected, stat))
	)
		refuse();
	return stat;
}

function recorded(map: ReadonlyMap<string, BigIntStats>, name: string): BigIntStats {
	return map.get(name) ?? refuse();
}

/** POSIX: the root's owner is the effective user; an ancestor's may be root, or shared if sticky. */
export function trusted(
	stat: { readonly uid: bigint; readonly mode: bigint },
	euid: number,
	root: boolean,
): boolean {
	const owner = stat.uid === BigInt(euid) || (!root && stat.uid === 0n);
	const shared = (stat.mode & 0o022n) !== 0n && (root || (stat.mode & 0o1000n) === 0n);
	return owner && !shared;
}

/** The canonical plugin root as recorded; on POSIX it and each ancestor must also be trusted. */
export function rootDirectory(root: string, expected?: BigIntStats): BigIntStats {
	const euid = process.geteuid?.();
	if (euid !== undefined) {
		let current = path.parse(root).root;
		for (const part of ["", ...root.slice(current.length).split(path.sep).filter(Boolean)]) {
			current = path.join(current, part);
			const stat = lstatSync(current, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink() || !trusted(stat, euid, current === root))
				refuse();
		}
	}
	return directory(root, expected);
}

function absent(name: string): void {
	if (lstatSync(name, { bigint: true, throwIfNoEntry: false }) !== undefined) refuse();
}

function withDirectory(name: string, expected: BigIntStats, use: (fd: number) => void): void {
	const fd = openSync(name, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW);
	try {
		const stat = fstatSync(fd, { bigint: true });
		if (!stat.isDirectory() || !identity(expected, stat)) refuse();
		use(fd);
	} finally {
		closeSync(fd);
	}
}

/** A new staging folder under a random name; the final name is never used before verification. */
export function stage(root: string, rootStat: BigIntStats, destination: string): Tree {
	rootDirectory(root, rootStat);
	absent(destination);
	const top = path.join(root, `.staging-${randomBytes(16).toString("hex")}`);
	mkdirSync(top, { mode: 0o700 });
	return { root, rootStat, top, directories: new Map([[top, directory(top)]]), files: new Map() };
}

/** Snapshot an existing sealed tree's native entries; no entry is created, changed or removed. */
export function existingTree(
	root: string,
	rootStat: BigIntStats,
	top: string,
	files: readonly string[],
): Tree {
	rootDirectory(root, rootStat);
	const directories = new Map<string, BigIntStats>();
	const entries = new Map<string, BigIntStats>();
	const keepDirectory = (name: string): void => {
		if (directories.has(name)) return;
		const stat = directory(name);
		if (!WINDOWS && (stat.mode & 0o222n) !== 0n) refuse();
		directories.set(name, stat);
	};
	keepDirectory(top);
	for (const relative of files) {
		const parts = relative.split("/");
		let parent = top;
		for (const part of parts.slice(0, -1)) {
			parent = path.join(parent, part);
			keepDirectory(parent);
		}
		const filename = path.join(top, relative);
		const stat = lstatSync(filename, { bigint: true });
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.ino === 0n ||
			stat.nlink !== 1n ||
			(stat.mode & 0o222n) !== 0n
		)
			refuse();
		entries.set(filename, stat);
	}
	return { root, rootStat, top, directories, files: entries };
}

/** The private root and every captured sealed entry must still be the same after verification. */
export function recheckExisting(tree: Tree): void {
	rootDirectory(tree.root, tree.rootStat);
	recheck(tree);
}

function write(tree: Tree, filename: string, bytes: Buffer): void {
	const fd = openSync(
		filename,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
		0o600,
	);
	try {
		const birth = fstatSync(fd, { bigint: true });
		if (!birth.isFile() || birth.nlink !== 1n || birth.ino === 0n) refuse();
		tree.files.set(filename, birth);
		writeFileSync(fd, bytes);
		fchmodSync(fd, 0o400);
		fsyncSync(fd);
		const stat = fstatSync(fd, { bigint: true });
		const named = lstatSync(filename, { bigint: true });
		if (
			!stat.isFile() ||
			stat.nlink !== 1n ||
			!identity(birth, stat) ||
			!identity(stat, named) ||
			named.isSymbolicLink() ||
			stat.size !== BigInt(bytes.length) ||
			(stat.mode & 0o222n) !== 0n
		)
			refuse();
		tree.files.set(filename, stat);
	} finally {
		closeSync(fd);
	}
}

/**
 * Creates each file exclusively and read-only, yielding to the event loop before each one; `active`
 * throws once the installer is closing. A parent's identity and canonical name cover its ancestors.
 */
export async function materialize(
	tree: Tree,
	files: ReadonlyMap<string, Buffer>,
	active: () => void,
): Promise<void> {
	for (const [relative, bytes] of files) {
		await turn();
		active();
		const parts = relative.split("/");
		let parent = tree.top;
		for (const part of parts.slice(0, -1)) {
			const child = path.join(parent, part);
			if (!tree.directories.has(child)) {
				directory(parent, recorded(tree.directories, parent));
				mkdirSync(child, { mode: 0o700 });
				tree.directories.set(child, directory(child));
			}
			parent = child;
		}
		directory(parent, recorded(tree.directories, parent));
		write(tree, path.join(parent, parts.at(-1) ?? refuse()), bytes);
	}
}

/**
 * Records each directory's final state, deepest first, yielding to the event loop before each one.
 * POSIX makes it read-only and flushes it first; Windows directories stay writable.
 */
export async function seal(tree: Tree): Promise<void> {
	for (const [name, birth] of [...tree.directories].reverse()) {
		await turn();
		if (!WINDOWS)
			withDirectory(name, birth, (fd) => {
				fchmodSync(fd, 0o500);
				fsyncSync(fd);
			});
		tree.directories.set(name, directory(name, birth));
	}
}

/**
 * After verification: each name still denotes the entry created here, unchanged since it was
 * written or sealed. Recorded files are read-only single links, and POSIX folders read-only.
 */
function recheck(tree: Tree): void {
	for (const [name, last] of tree.directories) if (!unchanged(last, directory(name))) refuse();
	for (const [name, last] of tree.files)
		if (!unchanged(last, lstatSync(name, { bigint: true }))) refuse();
}

/**
 * Renames the verified tree to its final name, never over an existing one, rechecking the whole
 * tree before each attempt; POSIX flushes the root.
 */
export async function place(tree: Tree, destination: string, active: () => void): Promise<void> {
	const top = recorded(tree.directories, tree.top);
	for (let attempt = 0; ; attempt++) {
		active();
		rootDirectory(tree.root, tree.rootStat);
		recheck(tree);
		absent(destination);
		try {
			renameSync(tree.top, destination);
			break;
		} catch (error) {
			const wait = RENAME_RETRY_MS[attempt];
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (!WINDOWS || wait === undefined || !["EPERM", "EACCES", "EBUSY"].includes(code))
				throw error;
			await delay(wait);
		}
	}
	directory(destination, top);
	if (!WINDOWS) withDirectory(tree.root, tree.rootStat, fsyncSync);
}

/**
 * Removes only names that still denote the exact single-link file or directory created here,
 * yielding to the event loop before each one.
 */
export async function discard(tree: Tree): Promise<void> {
	directory(tree.root, tree.rootStat);
	if (!WINDOWS)
		for (const [name, birth] of tree.directories) {
			await turn();
			withDirectory(name, birth, (fd) => fchmodSync(fd, 0o700));
		}
	for (const [name, birth] of tree.files) {
		await turn();
		const parent = path.dirname(name);
		directory(parent, recorded(tree.directories, parent));
		if (WINDOWS) {
			// Windows refuses to remove a read-only file, so clear it through a handle on that file.
			const fd = openSync(name, constants.O_RDONLY);
			try {
				const stat = fstatSync(fd, { bigint: true });
				if (!stat.isFile() || stat.nlink !== 1n || !identity(birth, stat)) refuse();
				fchmodSync(fd, 0o600);
			} finally {
				closeSync(fd);
			}
		} else {
			const stat = lstatSync(name, { bigint: true });
			if (!stat.isFile() || stat.nlink !== 1n || !identity(birth, stat)) refuse();
		}
		unlinkSync(name);
	}
	for (const [name, birth] of [...tree.directories].reverse()) {
		await turn();
		directory(name, birth);
		rmdirSync(name);
	}
}
