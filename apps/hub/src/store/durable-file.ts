import fs from "node:fs";

export const DATABASE_FILE_SUFFIXES: readonly string[] = Object.freeze([
	"",
	"-wal",
	"-shm",
	"-journal",
]);

const removeRegularFile = (filename: string): void => {
	try {
		if (fs.lstatSync(filename).isFile()) fs.unlinkSync(filename);
	} catch {
		/* Best effort: the caller reports its own failure. */
	}
};

/** Creates an empty owner-only file that no other name or writer shares, or removes it and throws. */
export function reserveExclusiveFile(filename: string): Readonly<{ dev: bigint; ino: bigint }> {
	const descriptor = fs.openSync(filename, "wx", 0o600);
	let reserved = false;
	try {
		const info = fs.fstatSync(descriptor, { bigint: true });
		reserved =
			info.nlink === 1n &&
			info.size === 0n &&
			(process.platform === "win32" || (info.mode & 0o777n) === 0o600n);
		if (!reserved) throw new Error("File reservation unavailable");
		return Object.freeze({ dev: info.dev, ino: info.ino });
	} finally {
		fs.closeSync(descriptor);
		if (!reserved) removeRegularFile(filename);
	}
}

// Node's fsync uses F_FULLFSYNC on macOS. Windows flushes only through a writable handle.
export function flushFile(filename: string): void {
	const descriptor = fs.openSync(filename, "r+");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Makes a created or removed name durable; Windows can't flush a directory handle. */
export function flushDirectory(directory: string): void {
	if (process.platform === "win32") return;
	const descriptor = fs.openSync(directory, "r");
	try {
		fs.fsyncSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

/** Removes a database file and its sidecars where they are regular files. Never throws. */
export function removeDatabaseFiles(filename: string): void {
	for (const suffix of DATABASE_FILE_SUFFIXES) removeRegularFile(`${filename}${suffix}`);
}
