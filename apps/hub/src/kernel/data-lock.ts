import { type BigIntStats, lstatSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { StartupRefusal } from "../lifecycle/preflight.ts";

const LOCK_FILE = "hub.lock";

export interface DataLock {
	/** Refuses after release begins, or unless `<run>/hub.lock` is still the locked file. */
	assertHeld(): void;
	release(): void;
}

// A collected connection closes itself and would drop the lock, so held ones stay reachable.
const held = new Set<Database.Database>();
interface OriginalLock {
	readonly connection: Database.Database;
	readonly close: Database.Database["close"];
}
// These admissions never returned a lease. A later admission retries their ORIGINAL cleanup first.
const failedAdmissions = new Set<OriginalLock>();
let pendingDrainInProgress = false;

function closeOriginal(original: OriginalLock): void {
	const { connection, close } = original;
	if (connection.open) close.call(connection);
	if (connection.open) throw new StartupRefusal("DATA_DIR_LOCK_IO");
	held.delete(connection);
}

function retryFailedAdmissions(): void {
	if (pendingDrainInProgress) throw new StartupRefusal("DATA_DIR_LOCK_IO");
	pendingDrainInProgress = true;
	let incomplete = false;
	try {
		for (const original of failedAdmissions) {
			try {
				closeOriginal(original);
				failedAdmissions.delete(original);
			} catch {
				incomplete = true;
			}
		}
	} finally {
		pendingDrainInProgress = false;
	}
	if (incomplete) throw new StartupRefusal("DATA_DIR_LOCK_IO");
}

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
	let original: OriginalLock | undefined, file: string, locked: BigIntStats;
	try {
		if (!isBindingPath(nativeBinding)) throw new Error("Native binding refused");
		// Only failed, never-returned admissions are drained; active leases stay with their owners.
		retryFailedAdmissions();
		file = path.join(runPath, LOCK_FILE);
		let before: BigIntStats | undefined;
		try {
			before = lockFile(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const db = new Database(file, { nativeBinding, timeout: 0 });
		original = { connection: db, close: db.close };
		held.add(db);
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
		if (original) {
			failedAdmissions.add(original);
			try {
				retryFailedAdmissions();
			} catch {
				// Retain every original actor until an explicit later admission finishes its cleanup.
			}
		}
		throw new StartupRefusal(
			(error as { code?: unknown } | null | undefined)?.code === "SQLITE_BUSY"
				? "DATA_DIR_LOCKED"
				: "DATA_DIR_LOCK_IO",
		);
	}
	if (!original) throw new StartupRefusal("DATA_DIR_LOCK_IO");
	const resource = original,
		connection = resource.connection,
		lockPath = file,
		identity = locked;
	let closing = false,
		released = false,
		releaseInProgress = false;
	return Object.freeze({
		assertHeld(): void {
			if (closing) throw new StartupRefusal("DATA_DIR_LOCK_IO");
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
			if (released) return;
			closing = true;
			if (releaseInProgress) throw new StartupRefusal("DATA_DIR_LOCK_IO");
			releaseInProgress = true;
			try {
				closeOriginal(resource);
				released = true;
			} catch {
				throw new StartupRefusal("DATA_DIR_LOCK_IO");
			} finally {
				releaseInProgress = false;
			}
		},
	});
}
