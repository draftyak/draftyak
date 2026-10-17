import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

// The 16 bytes every plaintext SQLite database starts with; SQLite3MC keeps its salt there instead.
export const SQLITE_HEADER: Buffer = Buffer.from("SQLite format 3\0", "latin1");
// The database file, then what WAL mode and a rollback journal leave beside it. Statement journals
// and other temporary files go to the temp folder instead (openTempFiles).
export const DB_FILES: readonly string[] = ["", "-wal", "-shm", "-journal"];

// A unique lowercase ASCII token, kept whole by FTS5's unicode61 tokenizer.
export function newCanary(): string {
	return `dycanary${randomBytes(8).toString("hex")}`;
}

// FTS5 stores a term as the bytes after the prefix it shares with the term before it, so a canary
// is looked for by its random last 12 characters.
export const canaryTail = (canary: string): string => canary.slice(-12);

export interface Needle {
	readonly label: string;
	readonly bytes: Uint8Array;
}

// Strings are looked for as UTF-8, as SQLite stores them, as written and in either case: FTS5
// indexes them in lower case.
export function needles(values: Readonly<Record<string, string | Uint8Array>>): Needle[] {
	return Object.entries(values).flatMap(([label, value]) => {
		if (typeof value !== "string") return [{ label, bytes: value }];
		const forms = [...new Set([value, value.toLowerCase(), value.toUpperCase()])];
		return forms.map((form) => ({ label, bytes: Buffer.from(form, "utf8") }));
	});
}

export interface FileScan {
	readonly suffix: string;
	readonly bytes: number;
	readonly header: boolean;
	readonly found: readonly string[];
}

// Whether a file holds the plaintext header or any needle, anywhere in it; null when it's missing.
export function scanFile(file: string, look: readonly Needle[], suffix = ""): FileScan | null {
	let content: Buffer;
	try {
		content = readFileSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	const found = look.filter(({ bytes }) => content.includes(bytes)).map(({ label }) => label);
	return {
		suffix,
		bytes: content.length,
		header: content.includes(SQLITE_HEADER),
		found: [...new Set(found)],
	};
}

// The database file and every side file that exists.
export function scanDatabase(dbFile: string, look: readonly Needle[]): FileScan[] {
	return DB_FILES.flatMap((suffix) => scanFile(`${dbFile}${suffix}`, look, suffix) ?? []);
}

// Files that hold the header or a needle; empty when the database leaks nothing.
export function leaks(scans: readonly FileScan[]): FileScan[] {
	return scans.filter((scan) => scan.header || scan.found.length > 0);
}

// The temporary files SQLite has open in dir (see PRAGMA temp_store_directory), as paths that
// read them: Windows lists them until they close; Linux unlinks them at once, so they're reached
// through /proc/self/fd. Null elsewhere.
export function openTempFiles(dir: string): string[] | null {
	if (process.platform === "win32") return readdirSync(dir).map((name) => path.join(dir, name));
	if (process.platform !== "linux") return null;
	return readdirSync("/proc/self/fd").flatMap((fd) => {
		const link = `/proc/self/fd/${fd}`;
		try {
			return readlinkSync(link).startsWith(`${dir}/`) ? [link] : [];
		} catch {
			return [];
		}
	});
}
