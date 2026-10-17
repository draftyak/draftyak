import { hkdfSync } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { openDatabase, type SqliteDatabase } from "./open.ts";

// §3 Storage, Open 1: PRAGMA hexkey=HKDF(MK,"draftyak/v1/db"); extension modules use their own info.
export const DB_KEY_INFO = "draftyak/v1/db";
export const CIPHER = "chacha20";
const HEX_KEY = /^[0-9a-f]{64}$/;

// HKDF-SHA256 over the master key with an empty salt: 32 bytes as lowercase hex.
export function deriveHexKey(masterKey: Uint8Array, info: string = DB_KEY_INFO): string {
	if (masterKey.byteLength < 32) throw new RangeError("the master key has at least 32 bytes");
	if (info === "") throw new RangeError("a key needs its purpose as HKDF info");
	return Buffer.from(hkdfSync("sha256", masterKey, new Uint8Array(0), info, 32)).toString("hex");
}

// The key goes into PRAGMA text, so only 64 lowercase hex digits are accepted.
export function assertHexKey(hexKey: string): void {
	if (!HEX_KEY.test(hexKey)) throw new TypeError("a database key is 64 lowercase hex digits");
}

// PRAGMA hexkey answers "ok" even for a wrong key; the first read is what fails, with SQLITE_NOTADB.
export function keyDatabase(db: SqliteDatabase, hexKey: string): void {
	assertHexKey(hexKey);
	db.pragma(`cipher = '${CIPHER}'`);
	db.pragma(`hexkey = '${hexKey}'`);
	db.prepare("SELECT count(*) FROM sqlite_master").pluck().get();
}

// Whether SQLite3MC encrypts what this connection writes to that schema; unkeyed, it writes plaintext.
export function isEncrypted(db: SqliteDatabase, schema = "main"): boolean {
	return db.prepare("SELECT sqlite3mc_codec_data('cipher_salt', ?)").pluck().get(schema) !== null;
}

export interface Settings {
	readonly cipher: string;
	readonly journalMode: string;
	readonly synchronous: number;
	readonly busyTimeout: number;
	readonly foreignKeys: number;
	readonly recursiveTriggers: number;
	readonly secureDelete: number;
	readonly trustedSchema: number;
	readonly tempStore: number;
	readonly autoVacuum: number;
}

// §3 Storage, Open 3, as SQLite reports the settings back (auto_vacuum 2 is INCREMENTAL), plus three
// this build needs: synchronous FULL (2), since its WAL default NORMAL can lose the last commits on
// power loss; temp_store MEMORY (2), since SQLite3MC writes temporary files unencrypted; and
// recursive_triggers, without which REPLACE deletes rows without firing the FTS5 delete trigger.
export const EXPECTED: Settings = {
	cipher: CIPHER,
	journalMode: "wal",
	synchronous: 2,
	busyTimeout: 5000,
	foreignKeys: 1,
	recursiveTriggers: 1,
	secureDelete: 1,
	trustedSchema: 0,
	tempStore: 2,
	autoVacuum: 2,
};

export function readSettings(db: SqliteDatabase): Settings {
	const value = (name: string): unknown => db.pragma(name, { simple: true });
	return {
		cipher: String(value("cipher")),
		journalMode: String(value("journal_mode")),
		synchronous: Number(value("synchronous")),
		busyTimeout: Number(value("busy_timeout")),
		foreignKeys: Number(value("foreign_keys")),
		recursiveTriggers: Number(value("recursive_triggers")),
		secureDelete: Number(value("secure_delete")),
		trustedSchema: Number(value("trusted_schema")),
		tempStore: Number(value("temp_store")),
		autoVacuum: Number(value("auto_vacuum")),
	};
}

export class SettingsError extends Error {
	override name = "SettingsError";
	readonly code = "ERR_DB_SETTINGS";
}

export function assertSettings(db: SqliteDatabase): void {
	const settings = readSettings(db);
	const names = Object.keys(EXPECTED) as (keyof Settings)[];
	const wrong = names.filter((name) => settings[name] !== EXPECTED[name]);
	if (wrong.length > 0) throw new SettingsError(`SQLite didn't confirm ${wrong.join(", ")}`);
}

export class DatabaseFileError extends Error {
	override name = "DatabaseFileError";
	readonly code = "ERR_DB_FILE";
}

// SQLite takes a missing or empty file for a new database, keys it with whatever key it gets, and
// deletes the -wal beside an empty one, so an existing database must hold at least one byte.
export function assertDatabaseFile(file: string): void {
	let size: number;
	try {
		size = statSync(file).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		throw new DatabaseFileError(`${path.basename(file)} doesn't exist`);
	}
	if (size === 0) throw new DatabaseFileError(`${path.basename(file)} is empty`);
}

export interface OpenOptions {
	// Create the file when it is missing or empty; otherwise either is refused.
	readonly create?: boolean;
}

// Opens an encrypted database and fails closed: a wrong key, a plaintext file or a setting SQLite
// doesn't confirm closes the connection and throws.
export function openEncrypted(
	filename: string,
	hexKey: string,
	nativeBinding: string,
	options: OpenOptions = {},
): SqliteDatabase {
	assertHexKey(hexKey);
	if (!options.create) assertDatabaseFile(filename);
	const db = openDatabase(filename, nativeBinding, { fileMustExist: !options.create });
	try {
		keyDatabase(db, hexKey);
		db.pragma("temp_store = MEMORY");
		// Takes effect only before the first table; assertSettings() catches a file created without it.
		db.pragma("auto_vacuum = INCREMENTAL");
		db.pragma("journal_mode = WAL");
		// Set after WAL: this build's default for WAL connections is NORMAL.
		db.pragma("synchronous = FULL");
		db.pragma(`busy_timeout = ${EXPECTED.busyTimeout}`);
		db.pragma("foreign_keys = ON");
		db.pragma("recursive_triggers = ON");
		db.pragma("secure_delete = ON");
		db.pragma("trusted_schema = OFF");
		assertSettings(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export class WalBusyError extends Error {
	override name = "WalBusyError";
	readonly code = "ERR_WAL_BUSY";
}

// Older -wal frames keep deleted rows, under the same key, until a checkpoint truncates the WAL, so
// a purge ends here. A reader or writer that keeps the WAL busy makes it throw: try again later.
export function truncateWal(db: SqliteDatabase): void {
	const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
	if (result?.busy !== 0) throw new WalBusyError("a reader or writer kept the WAL from truncating");
}
