import { lstatSync, mkdirSync, realpathSync, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isKnownSyncedPath } from "@draftyak/bounded-files";
import { StartupRefusal, type StartupRefusalCode } from "../lifecycle/preflight.ts";
import { holdDataLock, loadBinding } from "./data-lock.ts";

export { isKnownSyncedPath };

export interface DataFolderOptions {
	/** Absolute path of the pinned SQLite binding (`.node`). */
	readonly nativeBinding: string;
}

export interface DataFolder {
	/** The canonical data folder. */
	readonly path: string;
	/** `<path>/run`, owner-only on POSIX; it holds the single-hub lock. */
	readonly runPath: string;
	/**
	 * Refuses with `DATA_DIR_LOCK_IO` unless `run/hub.lock` is still the locked file. Windows refuses
	 * to remove or rename it while held; Linux and macOS allow both, and only this check notices.
	 */
	assertHeld(): void;
	/** Drops the single-hub lock; idempotent. */
	release(): void;
}

function refuse(code: StartupRefusalCode): never {
	throw new StartupRefusal(code);
}

/** POSIX: owned by the effective user and never group- or other-writable; `run/` exactly 0700. */
export function ownerOnly(
	stat: { readonly uid: number; readonly mode: number },
	euid: number | undefined,
	run: boolean,
): boolean {
	const mode = stat.mode & 0o777;
	return stat.uid === euid && (run ? mode === 0o700 : (mode & 0o022) === 0);
}

// An account named like a sync client (Box) can't rename its home folder, so that one name is not
// classified when the data folder is inside it; the folders above and below it still are.
function synced(canonical: string): boolean {
	if (!isKnownSyncedPath(canonical)) return false;
	let home: string;
	try {
		home = realpathSync.native(os.userInfo().homedir);
	} catch {
		return true;
	}
	const below = path.relative(home, canonical);
	if (
		home === path.dirname(home) ||
		below === "" ||
		below === ".." ||
		below.startsWith(`..${path.sep}`) ||
		path.isAbsolute(below)
	)
		return true;
	return isKnownSyncedPath(path.dirname(home)) || isKnownSyncedPath(below);
}

// Win32: a drive-letter spelling, never a share, and no component ending in a dot or space: Node
// keeps that ending, but SQLite's Win32 path normalization can drop it and open another folder.
// Checked before resolving, so a share spelling is never opened; the canonical one must equal it.
const win32Spelling = (spelling: string): boolean =>
	/^[A-Za-z]:\\/.test(spelling) && !/[. ](?:\\|$)/.test(spelling);

/**
 * Admits one canonical, unsynced data folder and holds its single-hub lock. A synced folder is
 * refused before anything is written. Windows ACLs are not checked here.
 */
export function admitDataFolder(folder: string, options: DataFolderOptions): DataFolder {
	const posix = process.platform !== "win32",
		euid = process.geteuid?.();
	let canonical: string, isSynced: boolean, stat: Stats;
	try {
		if (!posix && !win32Spelling(folder)) refuse("DATA_DIR_INVALID");
		canonical = realpathSync.native(folder);
		isSynced = synced(canonical);
		stat = lstatSync(canonical);
	} catch {
		refuse("DATA_DIR_INVALID");
	}
	if (isSynced) refuse("DATA_DIR_SYNCED");
	if (canonical !== folder || !stat.isDirectory()) refuse("DATA_DIR_INVALID");
	if (posix && !ownerOnly(stat, euid, false)) refuse("DATA_DIR_OWNERSHIP");
	// Before run/ exists, so a binding refusal leaves nothing behind.
	let nativeBinding: string;
	try {
		nativeBinding = loadBinding((options as DataFolderOptions | undefined)?.nativeBinding);
	} catch {
		refuse("DATA_DIR_LOCK_IO");
	}
	const runPath = path.join(folder, "run");
	let run: Stats;
	try {
		try {
			mkdirSync(runPath, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		run = lstatSync(runPath);
	} catch {
		refuse("DATA_DIR_OWNERSHIP");
	}
	if (!run.isDirectory() || (posix && !ownerOnly(run, euid, true))) refuse("DATA_DIR_OWNERSHIP");
	const lock = holdDataLock(runPath, nativeBinding);
	return Object.freeze({
		path: folder,
		runPath,
		assertHeld: () => lock.assertHeld(),
		release: () => lock.release(),
	});
}
