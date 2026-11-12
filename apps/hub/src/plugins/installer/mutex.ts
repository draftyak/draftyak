import { type BigIntStats, closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { refuse } from "./policy.ts";
import { rootDirectory } from "./tree.ts";

export const INSTALLER_MUTEX_FILE = ".draftyak-installer-lock";

interface Lease {
	readonly owner: object;
	readonly binding: string;
	readonly file: BigIntStats;
	database?: Database.Database;
	held: boolean;
}

// A failed contender must never open and close another descriptor for a locally held inode:
// on POSIX that can release the owning process's SQLite locks.
const leases = new Map<string, Lease>();
const closeDatabase = Database.prototype.close;

function coordinator(filename: string, expected?: BigIntStats): BigIntStats {
	const stat = lstatSync(filename, { bigint: true });
	const euid = process.geteuid?.();
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		stat.nlink !== 1n ||
		stat.size !== 0n ||
		(euid !== undefined && (stat.uid !== BigInt(euid) || (stat.mode & 0o777n) !== 0o600n)) ||
		(expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino))
	)
		refuse();
	return stat;
}

/** One factory's lifetime writer exclusion, under the existing private-root writer contract. */
export function createInstallerMutex(
	root: string,
	rootStat: BigIntStats,
	nativeBinding: unknown,
): { acquire(): void; check(): void; close(): void } {
	if (
		typeof nativeBinding !== "string" ||
		!path.isAbsolute(nativeBinding) ||
		nativeBinding.includes("\0") ||
		path.extname(nativeBinding).toLowerCase() !== ".node"
	)
		refuse();
	const filename = path.join(root, INSTALLER_MUTEX_FILE);
	const owner = Object.freeze(Object.create(null));
	let current: Lease | undefined;
	const check = (): void => {
		if (!current) return;
		rootDirectory(root, rootStat);
		coordinator(filename, current.file);
		if (leases.get(root) !== current || !current.held || !current.database?.inTransaction) refuse();
	};
	const close = (): void => {
		if (!current) return;
		const database = current.database;
		try {
			if (database?.open) closeDatabase.call(database);
		} catch {
			// Native close can throw before or after effect. Retain the actual connection until closed.
		}
		if (database?.open !== false && database !== undefined) refuse();
		if (leases.get(root) !== current || current.owner !== owner) refuse();
		leases.delete(root);
		current = undefined;
	};
	const acquire = (): void => {
		if (current) {
			check();
			return;
		}
		try {
			if (leases.has(root)) refuse();
			rootDirectory(root, rootStat);
			const binding = realpathSync.native(nativeBinding);
			if (!lstatSync(binding).isFile()) refuse();
			for (const lease of leases.values()) if (lease.binding !== binding) refuse();
			if (lstatSync(filename, { bigint: true, throwIfNoEntry: false }) === undefined) {
				let descriptor: number | undefined;
				try {
					// Creation happens only before any SQLite connection for this root is opened.
					descriptor = openSync(filename, "wx", 0o600);
				} catch (error) {
					// Another legitimate process may have created the permanent coordinator first.
					// The same strict lstat checks apply; no existing file is opened here.
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") refuse();
				}
				if (descriptor !== undefined) closeSync(descriptor);
			}
			rootDirectory(root, rootStat);
			current = { owner, binding, file: coordinator(filename), held: false };
			leases.set(root, current);
			current.database = new Database(filename, {
				nativeBinding: binding,
				fileMustExist: true,
				timeout: 0,
			});
			if (current.database.pragma("journal_mode = MEMORY", { simple: true }) !== "memory") refuse();
			// An empty database needs neither schema nor domain writes to hold the kernel lock.
			current.database.exec("BEGIN EXCLUSIVE");
			current.held = true;
			check();
		} catch {
			if (current) close();
			refuse();
		}
	};
	return Object.freeze({ acquire, check, close });
}
