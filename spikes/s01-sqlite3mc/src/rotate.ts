import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DB_FILES } from "./canary.ts";
import {
	assertDatabaseFile,
	assertHexKey,
	CIPHER,
	isEncrypted,
	keyDatabase,
	openEncrypted,
} from "./db.ts";
import { openDatabase, type SqliteDatabase } from "./open.ts";

// vacuum-into-uri is §3's VACUUM INTO with the cipher in URI parameters. vacuum-into runs VACUUM
// INTO from a connection whose main database holds the new key, since VACUUM INTO's output takes
// the main database's key. attach-copy copies schema and rows into the new file with SQL. Both
// attach the source with ATTACH … KEY.
export const METHODS = ["vacuum-into-uri", "vacuum-into", "attach-copy"] as const;
export type RotationMethod = (typeof METHODS)[number];

export interface RotationKeys {
	readonly from: string;
	readonly to: string;
}

export interface Rotation {
	readonly method: RotationMethod;
	readonly copyMs: number;
	readonly verifyMs: number;
	readonly bytes: number;
}

export class RotationError extends Error {
	override name = "RotationError";
	readonly code: string;

	constructor(message: string, code = "ERR_ROTATION") {
		super(message);
		this.code = code;
	}
}

// SQLite3MC keeps the cipher salt in the first 16 bytes; PRAGMA rekey under WAL keeps it.
export function cipherSalt(file: string): string {
	const salt = Buffer.alloc(16);
	const fd = openSync(file, "r");
	try {
		readSync(fd, salt, 0, salt.length, 0);
	} finally {
		closeSync(fd);
	}
	return salt.toString("hex");
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const elapsed = (since: number): number => Math.round((performance.now() - since) * 10) / 10;

function removeDatabase(file: string): void {
	for (const suffix of DB_FILES) {
		try {
			rmSync(`${file}${suffix}`, { force: true, maxRetries: 3 });
		} catch {
			// Best effort: a leftover must not hide the error that led here.
		}
	}
}

// ATTACH reads the schema, so a wrong source key fails here with SQLITE_NOTADB.
function attachSource(db: SqliteDatabase, source: string, key: string): void {
	db.prepare("ATTACH ? AS source KEY ?").run(source, Buffer.from(key, "hex"));
}

// This build opens connections without SQLITE_OPEN_URI and sets SQLITE_USE_URI=0, so SQLite reads
// the URI as a file name. Its error repeats that name, new key included, so only the code is kept.
function vacuumIntoUri(source: string, keys: RotationKeys, target: string, binding: string): void {
	const db = openEncrypted(source, keys.from, binding);
	try {
		const uri = `${pathToFileURL(target).href}?cipher=${CIPHER}&hexkey=${keys.to}`;
		db.prepare("VACUUM INTO ?").run(uri);
	} catch (error) {
		const { code } = error as { code?: unknown };
		throw new RotationError(
			"VACUUM INTO a URI failed",
			typeof code === "string" ? code : undefined,
		);
	} finally {
		db.close();
	}
}

// VACUUM INTO's output takes the main database's key, so from an unkeyed connection it would be a
// plaintext copy of the source.
export function vacuumSourceInto(
	db: SqliteDatabase,
	source: string,
	sourceKey: string,
	target: string,
): void {
	if (!isEncrypted(db)) {
		throw new RotationError("VACUUM INTO from an unkeyed main database would write plaintext");
	}
	attachSource(db, source, sourceKey);
	db.prepare("VACUUM source INTO ?").run(target);
}

// The key holder stays empty: only the attached source is read and only the output is written.
function vacuumInto(source: string, keys: RotationKeys, target: string, binding: string): void {
	const holder = `${target}.${randomBytes(6).toString("hex")}.keyholder`;
	const db = openDatabase(holder, binding);
	try {
		keyDatabase(db, keys.to);
		db.pragma("temp_store = MEMORY");
		vacuumSourceInto(db, source, keys.from, target);
	} finally {
		db.close();
		removeDatabase(holder);
	}
}

interface SchemaObject {
	readonly type: string;
	readonly name: string;
	readonly sql: string | null;
}

// An FTS5 table gets its configuration (secure-delete among it) before its index is rebuilt from
// the external content table, or refilled from its own content.
function copyFts5(
	db: SqliteDatabase,
	vtab: SchemaObject,
	kinds: ReadonlyMap<string, string>,
): void {
	if (!/\busing\s+fts5\b/i.test(vtab.sql ?? "")) {
		throw new RotationError(`${vtab.name}: attach-copy copies only FTS5 virtual tables`);
	}
	const table = quote(vtab.name);
	db.exec(vtab.sql ?? "");
	// FTS5 takes integer settings only as INTEGER; better-sqlite3 binds plain numbers as REAL.
	const config = db
		.prepare(`SELECT k, v FROM source.${quote(`${vtab.name}_config`)} WHERE k <> 'version'`)
		.safeIntegers()
		.all() as { k: string; v: unknown }[];
	const set = db.prepare(`INSERT INTO main.${table} (${table}, rank) VALUES (?, ?)`);
	for (const { k, v } of config) set.run(k, v);
	if (kinds.get(`${vtab.name}_content`) === "shadow") {
		const columns = (db.pragma(`main.table_info(${table})`) as { name: string }[])
			.map(({ name }) => quote(name))
			.join(", ");
		db.exec(
			`INSERT INTO main.${table} (rowid, ${columns}) SELECT rowid, ${columns} FROM source.${table}`,
		);
	} else {
		db.prepare(`INSERT INTO main.${table} (${table}) VALUES ('rebuild')`).run();
	}
}

// Tables and rows first, then FTS5 indexes, then indexes, views and triggers, so the copy fires no
// trigger. Foreign keys are checked once at the end.
function copySchemaAndRows(db: SqliteDatabase): void {
	const objects = db
		.prepare("SELECT type, name, sql FROM source.sqlite_schema ORDER BY rowid")
		.all() as SchemaObject[];
	const list = db.pragma("source.table_list") as { name: string; type: string }[];
	const kinds = new Map(list.map(({ name, type }) => [name, type]));
	const of = (type: string, kind?: string): SchemaObject[] =>
		objects.filter(
			(object) =>
				object.type === type &&
				object.sql !== null &&
				!object.name.startsWith("sqlite_") &&
				(kind === undefined || kinds.get(object.name) === kind),
		);
	const versions = ["user_version", "application_id"].map(
		(name) => [name, Number(db.pragma(`source.${name}`, { simple: true }))] as const,
	);
	db.pragma("foreign_keys = OFF");
	try {
		db.transaction(() => {
			for (const table of of("table", "table")) {
				db.exec(table.sql ?? "");
				db.exec(`INSERT INTO main.${quote(table.name)} SELECT * FROM source.${quote(table.name)}`);
			}
			if (kinds.has("sqlite_sequence")) {
				db.exec("DELETE FROM main.sqlite_sequence");
				db.exec("INSERT INTO main.sqlite_sequence SELECT * FROM source.sqlite_sequence");
			}
			for (const vtab of of("table", "virtual")) copyFts5(db, vtab, kinds);
			for (const object of [...of("index"), ...of("view"), ...of("trigger")]) {
				db.exec(object.sql ?? "");
			}
			for (const [name, value] of versions) db.pragma(`main.${name} = ${value}`);
		})();
	} finally {
		db.pragma("foreign_keys = ON");
	}
	if ((db.pragma("main.foreign_key_check") as unknown[]).length > 0) {
		throw new RotationError("the copy breaks a foreign key");
	}
}

function attachCopy(source: string, keys: RotationKeys, target: string, binding: string): void {
	const db = openEncrypted(target, keys.to, binding, { create: true });
	try {
		attachSource(db, source, keys.from);
		copySchemaAndRows(db);
		db.exec("DETACH source");
		db.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
}

const copy: Readonly<Record<RotationMethod, typeof attachCopy>> = {
	"vacuum-into-uri": vacuumIntoUri,
	"vacuum-into": vacuumInto,
	"attach-copy": attachCopy,
};

const schemaOf = (db: SqliteDatabase, schema: string): unknown[] =>
	db
		.prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema ORDER BY type, name`)
		.all();

// Rows per ordinary table. FTS5's shadow tables are left out: attach-copy rebuilds their content.
function rowCounts(db: SqliteDatabase, schema: string): Record<string, unknown> {
	const tables = (db.pragma(`${schema}.table_list`) as { name: string; type: string }[]).filter(
		({ name, type }) => type === "table" && !name.startsWith("sqlite_"),
	);
	const count = (table: string): unknown =>
		db
			.prepare(`SELECT count(*) FROM ${schema}.${quote(table)}`)
			.pluck()
			.get();
	return Object.fromEntries(tables.map(({ name }) => [name, count(name)]));
}

// The new file passes integrity_check under the new key, holds the source's schema and as many
// rows per table, fails closed under the old key and carries a salt of its own.
export function verifyRotated(
	source: string,
	keys: RotationKeys,
	target: string,
	binding: string,
): void {
	if (cipherSalt(target) === cipherSalt(source)) {
		throw new RotationError("the rotated file reuses the source's cipher salt");
	}
	const db = openEncrypted(target, keys.to, binding);
	try {
		const result = db.pragma("integrity_check", { simple: true });
		if (result !== "ok") throw new RotationError(`integrity_check: ${String(result)}`);
		attachSource(db, source, keys.from);
		if (!isDeepStrictEqual(schemaOf(db, "main"), schemaOf(db, "source"))) {
			throw new RotationError("the rotated file's schema differs from the source's");
		}
		if (!isDeepStrictEqual(rowCounts(db, "main"), rowCounts(db, "source"))) {
			throw new RotationError("the rotated file's row counts differ from the source's");
		}
	} finally {
		db.close();
	}
	try {
		openEncrypted(target, keys.from, binding).close();
	} catch (error) {
		if ((error as { code?: unknown }).code === "SQLITE_NOTADB") return;
		throw error;
	}
	throw new RotationError("the rotated file still opens with the old key");
}

// §3 Key rotation: a new file under the new key, next to a source left untouched. A failed
// rotation removes what it wrote. ATTACH would create a missing source, so it must exist first.
export function rotate(
	method: RotationMethod,
	source: string,
	target: string,
	keys: RotationKeys,
	nativeBinding: string,
): Rotation {
	assertHexKey(keys.from);
	assertHexKey(keys.to);
	if (keys.from === keys.to) throw new RotationError("a rotation needs a new key");
	if (path.resolve(source) === path.resolve(target)) {
		throw new RotationError("a rotation writes a new file");
	}
	assertDatabaseFile(source);
	if (DB_FILES.some((suffix) => existsSync(`${target}${suffix}`))) {
		throw new RotationError(`${target} already exists`);
	}
	const copied = performance.now();
	try {
		copy[method](source, keys, target, nativeBinding);
		const copyMs = elapsed(copied);
		const verified = performance.now();
		verifyRotated(source, keys, target, nativeBinding);
		return { method, copyMs, verifyMs: elapsed(verified), bytes: statSync(target).size };
	} catch (error) {
		removeDatabase(target);
		throw error;
	}
}
