import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";
import { MasterKey } from "../kernel/master-key.ts";
import {
	DATABASE_FILE_SUFFIXES,
	flushDirectory,
	flushFile,
	removeDatabaseFiles,
	reserveExclusiveFile,
} from "./durable-file.ts";
import { assertSettings, openEncrypted, type SqliteDatabase } from "./open.ts";

export type RotationMethod = "vacuum-into" | "attach-copy";
export type RotationPurpose = "db" | `ext/${string}`;
export type RotationErrorCode = "path" | "source" | "target" | "key" | "copy" | "verify" | "flush";

export interface RotationFiles {
	readonly source: string;
	readonly target: string;
	readonly nativeBinding: string;
	readonly from: MasterKey;
	readonly to: MasterKey;
	readonly purpose: RotationPurpose;
}
export interface RotationOptions extends Omit<RotationFiles, "purpose"> {
	readonly purpose?: RotationPurpose;
	readonly method?: RotationMethod;
}
interface Rotation extends RotationFiles {
	readonly method: RotationMethod;
}

/** Carries a fixed code only: never a path, key or SQLite message. */
export class RotationError extends Error {
	override name = "RotationError";
	readonly code: RotationErrorCode;
	constructor(code: RotationErrorCode) {
		super(`Database rotation failed: ${code}`);
		this.code = code;
	}
}

const derive = MasterKey.prototype.derive;
const MODULE_PURPOSE = /^ext\/[a-z][a-z0-9-]{0,63}$/;
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function assertPaths(source: string, target: string): void {
	if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error();
	const canonical = (filename: string): string => {
		const resolved = path.resolve(filename);
		return process.platform === "win32" || process.platform === "darwin"
			? resolved.toLowerCase()
			: resolved;
	};
	if (
		(process.platform === "win32" &&
			[source, target].some((filename) => /[. ]$/.test(path.basename(filename)))) ||
		DATABASE_FILE_SUFFIXES.some((suffix) => canonical(`${source}${suffix}`) === canonical(target))
	)
		throw new Error();
}

function assertSource(source: string): void {
	const info = lstatSync(source, { bigint: true });
	// ATTACH would create a missing source and copy an empty one.
	if (!info.isFile() || info.nlink !== 1n || info.size === 0n) throw new Error();
}

function capture(options: RotationOptions): Rotation {
	let rotation: Rotation;
	try {
		if (types.isProxy(options)) throw new Error();
		const { source, target, nativeBinding, from, to } = options;
		const { purpose = "db", method = "vacuum-into" } = options;
		rotation = { source, target, nativeBinding, from, to, purpose, method };
		assertPaths(source, target);
		if (
			!path.isAbsolute(nativeBinding) ||
			path.extname(nativeBinding) !== ".node" ||
			(method !== "vacuum-into" && method !== "attach-copy")
		)
			throw new Error();
	} catch {
		throw new RotationError("path");
	}
	const { purpose } = rotation;
	if (purpose !== "db" && (typeof purpose !== "string" || !MODULE_PURPOSE.test(purpose)))
		throw new RotationError("key");
	return rotation;
}

function missing(filename: string): boolean {
	try {
		lstatSync(filename);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function requestFullSync(db: SqliteDatabase): void {
	db.pragma("fullfsync = ON");
	db.pragma("checkpoint_fullfsync = ON");
	db.pragma("synchronous = FULL");
	if (
		db.pragma("fullfsync", { simple: true }) !== 1 ||
		db.pragma("checkpoint_fullfsync", { simple: true }) !== 1
	)
		throw new RotationError("copy");
}

// Persistent opening-time configuration is only applied to this call's reserved copy files.
function openCopyFile(rotation: Rotation, filename: string, key: Buffer): SqliteDatabase {
	const db = new Database(filename, { nativeBinding: rotation.nativeBinding, fileMustExist: true });
	try {
		db.pragma("cipher = 'chacha20'");
		db.key(key);
		requestFullSync(db);
		db.pragma("temp_store = MEMORY");
		db.pragma("auto_vacuum = INCREMENTAL");
		db.pragma("journal_mode = WAL");
		db.pragma("busy_timeout = 5000");
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

// Certify the connection before ATTACH can open a crash-left WAL. The main database is memory-only.
function openSourceGuard(rotation: Rotation, sourceKey: Buffer): SqliteDatabase {
	const db = new Database(":memory:", { nativeBinding: rotation.nativeBinding });
	try {
		requestFullSync(db);
		db.pragma("temp_store = MEMORY");
		db.pragma("busy_timeout = 5000");
		db.prepare("ATTACH ? AS source KEY ?").run(rotation.source, sourceKey);
		db.pragma("source.synchronous = FULL");
		if (db.pragma("source.synchronous", { simple: true }) !== 2) throw new RotationError("copy");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/** VACUUM INTO's output takes the main database's key: from an unkeyed holder it is plaintext. */
export function vacuumSourceInto(
	db: SqliteDatabase,
	source: string,
	sourceKey: Buffer,
	target: string,
): void {
	try {
		assertPaths(source, target);
		assertSource(source);
		if (db.prepare("SELECT sqlite3mc_codec_data('cipher_salt', 'main')").pluck().get() === null)
			throw new Error();
		requestFullSync(db);
		db.prepare("ATTACH ? AS source KEY ?").run(source, sourceKey);
		db.prepare("VACUUM source INTO ?").run(target);
	} catch {
		throw new RotationError("copy");
	}
}

// The holder stays empty; its key and fresh salt pass to the VACUUM INTO output.
function vacuumInto(rotation: Rotation, sourceKey: Buffer, targetKey: Buffer): void {
	const holder = `${rotation.target}.${randomBytes(6).toString("hex")}.keyholder`;
	reserveExclusiveFile(holder);
	let db: SqliteDatabase | undefined;
	try {
		db = openCopyFile(rotation, holder, targetKey);
		vacuumSourceInto(db, rotation.source, sourceKey, rotation.target);
	} finally {
		try {
			db?.close();
		} finally {
			removeDatabaseFiles(holder);
		}
	}
}

interface SchemaObject {
	readonly type: string;
	readonly name: string;
	readonly sql: string;
}

// FTS5 settings, secure-delete among them, are replayed before the index is filled again.
function copyFts5(
	db: SqliteDatabase,
	{ name, sql }: SchemaObject,
	kinds: ReadonlyMap<string, string>,
): void {
	const table = quote(name);
	db.exec(sql);
	const settings = db
		.prepare(`SELECT k, v FROM source.${quote(`${name}_config`)} WHERE k <> 'version'`)
		.safeIntegers()
		.all() as { k: string; v: unknown }[];
	const set = db.prepare(`INSERT INTO main.${table} (${table}, rank) VALUES (?, ?)`);
	for (const { k, v } of settings) set.run(k, v);
	if (kinds.get(`${name}_content`) === "shadow") {
		const columns = (db.pragma(`main.table_info(${table})`) as { name: string }[])
			.map((column) => quote(column.name))
			.join(", ");
		db.exec(
			`INSERT INTO main.${table} (rowid, ${columns}) SELECT rowid, ${columns} FROM source.${table}`,
		);
	} else db.prepare(`INSERT INTO main.${table} (${table}) VALUES ('rebuild')`).run();
}

// Tables and rows, then FTS5 tables, then indexes, views and triggers, so no trigger fires.
// Any other virtual table fails: it has no FTS5 configuration table to replay.
function attachCopy(db: SqliteDatabase, source: string, sourceKey: Buffer): void {
	db.prepare("ATTACH ? AS source KEY ?").run(source, sourceKey);
	const objects = (
		db
			.prepare(
				"SELECT type, name, sql FROM source.sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid",
			)
			.all() as SchemaObject[]
	).filter(({ name }) => !name.startsWith("sqlite_"));
	const list = db.pragma("source.table_list") as { name: string; type: string }[];
	const kinds = new Map(list.map(({ name, type }) => [name, type]));
	const of = (type: string, kind?: string): SchemaObject[] =>
		objects.filter(
			(object) => object.type === type && (kind === undefined || kinds.get(object.name) === kind),
		);
	const versions = ["user_version", "application_id"].map(
		(name) => `main.${name} = ${Number(db.pragma(`source.${name}`, { simple: true }))}`,
	);
	// A child table may come before its parent. The caller closes this connection.
	db.pragma("foreign_keys = OFF");
	db.transaction(() => {
		for (const { name, sql } of of("table", "table")) {
			db.exec(sql);
			const columns = (
				db.pragma(`source.table_xinfo(${quote(name)})`) as { name: string; hidden: number }[]
			)
				.filter(({ hidden }) => hidden === 0)
				.map((column) => quote(column.name))
				.join(", ");
			db.exec(
				`INSERT INTO main.${quote(name)} (${columns}) SELECT ${columns} FROM source.${quote(name)}`,
			);
		}
		if (kinds.has("sqlite_sequence"))
			db.exec(
				"DELETE FROM main.sqlite_sequence; INSERT INTO main.sqlite_sequence SELECT * FROM source.sqlite_sequence",
			);
		for (const table of of("table", "virtual")) copyFts5(db, table, kinds);
		for (const { sql } of [...of("index"), ...of("view"), ...of("trigger")]) db.exec(sql);
		for (const version of versions) db.pragma(version);
	})();
	if ((db.pragma("main.foreign_key_check") as unknown[]).length > 0)
		throw new RotationError("copy");
}

const schemaRows = (db: SqliteDatabase, schema: string): unknown[] =>
	db
		.prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema ORDER BY type, name`)
		.all();

// Count virtual content too, but not shadow tables that attach-copy rebuilds.
function rowCounts(db: SqliteDatabase, schema: string): Record<string, unknown> {
	const tables = (db.pragma(`${schema}.table_list`) as { name: string; type: string }[]).filter(
		({ name, type }) => (type === "table" || type === "virtual") && !name.startsWith("sqlite_"),
	);
	return Object.fromEntries(
		tables.map(({ name }) => [
			name,
			db
				.prepare(`SELECT count(*) FROM ${schema}.${quote(name)}`)
				.pluck()
				.get(),
		]),
	);
}

function headerValues(db: SqliteDatabase, schema: string): unknown {
	const sequence = db
		.prepare(`SELECT 1 FROM ${schema}.sqlite_schema WHERE name = 'sqlite_sequence'`)
		.get();
	return {
		userVersion: db.pragma(`${schema}.user_version`, { simple: true }),
		applicationId: db.pragma(`${schema}.application_id`, { simple: true }),
		sequence: sequence
			? db
					.prepare(`SELECT name, seq FROM ${schema}.sqlite_sequence ORDER BY name`)
					.safeIntegers()
					.all()
			: [],
	};
}

function verifyFts5(db: SqliteDatabase): void {
	const tables = db.pragma("main.table_list") as { name: string; type: string }[];
	const kinds = new Map(tables.map(({ name, type }) => [name, type]));
	for (const { name, type } of tables) {
		if (type !== "virtual" || kinds.get(`${name}_config`) !== "shadow") continue;
		const table = quote(name);
		db.prepare(`INSERT INTO main.${table} (${table}, rank) VALUES ('integrity-check', 1)`).run();
	}
}

// SQLite3MC keeps the cipher salt where the plaintext header would be.
function cipherSalt(filename: string): Buffer {
	const salt = Buffer.alloc(16);
	const descriptor = openSync(filename, "r");
	try {
		readSync(descriptor, salt, 0, salt.length, 0);
	} finally {
		closeSync(descriptor);
	}
	return salt;
}

function verifyFile(files: RotationFiles): void {
	const { source, target, nativeBinding, from, to, purpose } = files;
	let db: SqliteDatabase | undefined, sourceKey: Buffer | undefined;
	try {
		db = openEncrypted({ filename: target, nativeBinding }, to, purpose);
		if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new RotationError("verify");
		verifyFts5(db);
		sourceKey = derive.call(from, purpose);
		db.prepare("ATTACH ? AS source KEY ?").run(source, sourceKey);
		if (
			!isDeepStrictEqual(schemaRows(db, "main"), schemaRows(db, "source")) ||
			!isDeepStrictEqual(rowCounts(db, "main"), rowCounts(db, "source")) ||
			!isDeepStrictEqual(headerValues(db, "main"), headerValues(db, "source"))
		)
			throw new RotationError("verify");
		db.exec("DETACH source");
	} finally {
		sourceKey?.fill(0);
		db?.close();
	}
	if (cipherSalt(target).equals(cipherSalt(source))) throw new RotationError("verify");
	try {
		openEncrypted({ filename: target, nativeBinding }, from, purpose).close();
	} catch (error) {
		if ((error as { code?: unknown } | undefined)?.code === "SQLITE_NOTADB") return;
	}
	throw new RotationError("verify");
}

/** The new file must pass integrity/FTS checks, match the source, have a fresh salt and refuse `from`. */
export function verifyRotatedFile(files: RotationFiles): void {
	try {
		const rotation = capture(files);
		assertSource(rotation.source);
		verifyFile(rotation);
	} catch {
		throw new RotationError("verify");
	}
}

/**
 * Holds the source write lock through copying, verification and flushing a new file under `to`
 * (ADR 0002 options b and c). Closing the final source connection may checkpoint a crash-left
 * WAL under the full-sync opening policy; the source is never replaced or re-keyed.
 * On failure, only this call's reserved target, holder and sidecars are removed.
 */
export function rotateDatabaseFile(options: RotationOptions): void {
	const rotation = capture(options);
	const { source, target, from, to, purpose, method } = rotation;
	const keys: Buffer[] = [];
	let code: RotationErrorCode = "key";
	let owned: ReturnType<typeof reserveExclusiveFile> | undefined;
	try {
		const sourceKey = derive.call(from, purpose);
		keys.push(sourceKey);
		const targetKey = derive.call(to, purpose);
		keys.push(targetKey);
		if (timingSafeEqual(sourceKey, targetKey)) throw new RotationError("key");
		code = "source";
		assertSource(source);
		code = "target";
		if (!DATABASE_FILE_SUFFIXES.every((suffix) => missing(`${target}${suffix}`)))
			throw new RotationError("target");
		code = "copy";
		const guard = openSourceGuard(rotation, sourceKey);
		try {
			guard.exec("BEGIN IMMEDIATE");
			code = "target";
			// VACUUM INTO keeps an existing empty file's mode; a file it creates gets SQLite's 0644.
			owned = reserveExclusiveFile(target);
			code = "copy";
			if (method === "attach-copy") {
				const db = openCopyFile(rotation, target, targetKey);
				try {
					attachCopy(db, source, sourceKey);
				} finally {
					db.close();
				}
			} else vacuumInto(rotation, sourceKey, targetKey);
			code = "flush";
			flushFile(target);
			code = "verify";
			verifyRotatedFile(rotation);
			code = "flush";
			flushFile(target);
			flushDirectory(path.dirname(target));
		} finally {
			try {
				if (guard.inTransaction) guard.exec("ROLLBACK");
			} finally {
				guard.close();
			}
		}
	} catch {
		if (owned) {
			try {
				const current = lstatSync(target, { bigint: true });
				if (current.dev === owned.dev && current.ino === owned.ino) removeDatabaseFiles(target);
			} catch {
				/* A missing or replaced target no longer authorizes cleanup. */
			}
		}
		throw new RotationError(code);
	} finally {
		for (const key of keys) key.fill(0);
	}
}
