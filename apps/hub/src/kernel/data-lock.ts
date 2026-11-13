import { type BigIntStats, lstatSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { StartupRefusal } from "../lifecycle/preflight.ts";

const LOCK_FILE = "hub.lock";

export interface DataLock {
	/** Refuses with `DATA_DIR_LOCK_IO` unless `<run>/hub.lock` is still the locked file. */
	assertHeld(): void;
	release(): void;
}

// A collected connection closes itself and would drop the lock, so held ones stay reachable.
const held = new Set<Database.Database>();

const isBindingPath = (value: unknown): value is string =>
	typeof value === "string" && path.isAbsolute(value) && path.extname(value) === ".node";

/** Refuses with `DATA_DIR_LOCK_IO` unless the binding is an absolute `.node` path that loads. */
export function loadBinding(nativeBinding: unknown): string {
	try {
		if (!isBindingPath(nativeBinding)) throw new Error("Native binding refused");
		new Database(":memory:", { nativeBinding }).close();
		return nativeBinding;
	} catch {
		throw new StartupRefusal("DATA_DIR_LOCK_IO");
	}
}

// The lock file is empty and has one name: never a link, a folder or another file under a new name.
function lockFile(file: string): BigIntStats {
	const stat = lstatSync(file, { bigint: true });
	if (!stat.isFile() || stat.nlink !== 1n || stat.size !== 0n) throw new Error("Lock file refused");
	return stat;
}

const same = (one: BigIntStats, other: BigIntStats): boolean =>
	one.dev === other.dev && one.ino === other.ino;

/**
 * Holds an exclusive lock on the content-free `<run>/hub.lock` until release; the OS drops it when
 * the process ends. Another holder, in this process or another, is refused at once.
 */
export function holdDataLock(runPath: string, nativeBinding: string): DataLock {
	let db: Database.Database | undefined, file: string, locked: BigIntStats;
	try {
		if (!isBindingPath(nativeBinding)) throw new Error("Native binding refused");
		file = path.join(runPath, LOCK_FILE);
		let before: BigIntStats | undefined;
		try {
			before = lockFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		db = new Database(file, { nativeBinding, timeout: 0 });
		// No journal file: the lock never writes a page, and nothing is left beside it.
		db.pragma("journal_mode = MEMORY");
		db.exec("BEGIN EXCLUSIVE");
		// Read-only, BEGIN EXCLUSIVE only shares a read; this write, never committed, refuses that.
		db.pragma("user_version = 0");
		// SQLite's Win32 path normalization can open another file than Node checked, so the file it
		// locked, by its own spelling, must be the one at run/hub.lock.
		const main = (db.pragma("database_list") as { name?: unknown; file?: unknown }[]).find(
			(row) => row.name === "main",
		);
		locked = lockFile(file);
		if (
			(before !== undefined && !same(before, locked)) ||
			typeof main?.file !== "string" ||
			!same(lockFile(main.file), locked)
		)
			throw new Error("Lock file refused");
	} catch (error) {
		try {
			db?.close();
		} catch {
			// The refusal stands; an unclosed connection is unreachable and closes when collected.
		}
		throw new StartupRefusal(
			(error as { code?: unknown } | null | undefined)?.code === "SQLITE_BUSY"
				? "DATA_DIR_LOCKED"
				: "DATA_DIR_LOCK_IO",
		);
	}
	const connection = db,
		lockPath = file,
		identity = locked;
	held.add(connection);
	return Object.freeze({
		assertHeld(): void {
			let current: BigIntStats | undefined;
			try {
				current = lockFile(lockPath);
			} catch {
				// Refused below.
			}
			if (!connection.open || current === undefined || !same(current, identity))
				throw new StartupRefusal("DATA_DIR_LOCK_IO");
		},
		release(): void {
			held.delete(connection);
			connection.close();
		},
	});
}
