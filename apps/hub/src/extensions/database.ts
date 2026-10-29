import { lstatSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import type { ModuleDatabase, ModuleTables } from "@draftyak/extensions";
import Database from "better-sqlite3-multiple-ciphers";
import { Kysely } from "kysely";
import { type MigrationProvider, Migrator } from "kysely/migration";
import type { MasterKey } from "../kernel/master-key.ts";
import { migrationTables, TransactionalSqliteDialect } from "../store/migrator.ts";
import { assertSettings, openEncrypted, type SqliteDatabase } from "../store/open.ts";
import type { VerifiedMigration } from "./artifacts.ts";
import { ExtensionError, refuse } from "./errors.ts";
import { inertRecord, isPlainFunction, isThenable, ownData } from "./values.ts";

export const MAX_PAGE_ROWS = 100;
export const MAX_MUTATED_ROWS = 100;
export const MAX_COLUMNS = 64;
export const MAX_TABLES = 64;
export const MAX_CELL_BYTES: number = 64 * 1024;
export const MAX_ROW_BYTES: number = 256 * 1024;
export const MAX_RESULT_BYTES: number = 1024 * 1024;
const NAMESPACE = "ext";
const COLUMN = /^[a-z][a-z0-9_]{0,62}$/;
const SUFFIX = /^[a-z0-9][a-z0-9_]{0,62}$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const closeDatabase = Database.prototype.close;
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

export const moduleDatabaseFile = (dataDirectory: string, id: string): string =>
	path.join(dataDirectory, `ext-${id}.db`);

// A failed native close keeps the actual connection until a later attempt proves it closed.
const retained = new Set<SqliteDatabase>();
const isClosed = (db: SqliteDatabase): boolean => {
	try {
		return db.open === false;
	} catch {
		return false;
	}
};
export function closeConnection(db: SqliteDatabase): boolean {
	try {
		if (!isClosed(db)) closeDatabase.call(db);
	} catch {
		/* Native close may fail before or after effect. The original object's state decides. */
	}
	if (isClosed(db)) {
		retained.delete(db);
		return true;
	}
	retained.add(db);
	return false;
}
export function retryRetainedConnections(): boolean {
	for (const db of [...retained]) closeConnection(db);
	return retained.size === 0;
}

interface TableShape {
	readonly readable: readonly string[];
	readonly writable: ReadonlySet<string>;
}

/** Only module-prefixed ordinary tables, their indexes and triggers; nothing temporary or virtual. */
function moduleSchema(db: SqliteDatabase, id: string): ReadonlyMap<string, TableShape> {
	const prefix = `ext_${id}_`;
	const own = (name: string): boolean =>
		name.startsWith(prefix) &&
		SUFFIX.exec(name.slice(prefix.length))?.[0] === name.slice(prefix.length);
	const { table: applied, lock } = migrationTables(NAMESPACE);
	if (db.prepare("SELECT 1 FROM temp.sqlite_schema LIMIT 1").get() !== undefined)
		refuse("database");
	const shapes = new Map<string, TableShape>();
	for (const entry of db.pragma("main.table_list") as { name: string; type: string }[]) {
		if (entry.name.startsWith("sqlite_") || entry.name === applied || entry.name === lock) continue;
		if (entry.type !== "table" || !own(entry.name) || shapes.size >= MAX_TABLES) refuse("database");
		const columns = db.pragma(`main.table_xinfo("${entry.name}")`) as {
			name: string;
			hidden: number;
		}[];
		if (columns.length > MAX_COLUMNS) refuse("database");
		const readable: string[] = [],
			writable = new Set<string>();
		for (const column of columns) {
			if (COLUMN.exec(column.name)?.[0] !== column.name || column.hidden === 1) refuse("database");
			readable.push(column.name);
			if (column.hidden === 0) writable.add(column.name);
		}
		shapes.set(entry.name, Object.freeze({ readable: Object.freeze(readable), writable }));
	}
	const objects = db
		.prepare(
			"SELECT type, name, tbl_name AS owner FROM main.sqlite_schema WHERE type IN ('index','trigger')",
		)
		.all() as { type: string; name: string; owner: string }[];
	for (const object of objects) {
		if (object.type === "index" && object.name.startsWith("sqlite_autoindex_")) continue;
		if (!own(object.name) || !shapes.has(object.owner)) refuse("database");
	}
	return shapes;
}

async function migrateModule(
	db: SqliteDatabase,
	id: string,
	migrations: readonly VerifiedMigration[],
): Promise<void> {
	if (db.inTransaction) refuse("database");
	assertSettings(db);
	// SQLite can end the transaction itself on errors such as SQLITE_FULL; a fresh one lets the
	// migrator's own rollback succeed while this run still fails.
	const stillInTransaction = (): void => {
		if (db.inTransaction) return;
		db.exec("BEGIN");
		refuse("database");
	};
	const run = (sql: string): void => {
		if (!db.inTransaction) refuse("database");
		try {
			db.exec(sql);
		} catch (error) {
			stillInTransaction();
			throw error;
		}
		stillInTransaction();
		if ((db.pragma("foreign_key_check") as unknown[]).length > 0) refuse("database");
		moduleSchema(db, id);
	};
	const provider: MigrationProvider = {
		getMigrations: async () =>
			Object.fromEntries(
				migrations.map(({ name, sql }) => [
					name.slice(0, -".sql".length),
					{ up: async () => run(sql) },
				]),
			),
	};
	const { table, lock } = migrationTables(NAMESPACE);
	const migrator = new Migrator({
		db: new Kysely<unknown>({ dialect: new TransactionalSqliteDialect({ database: db }) }),
		provider,
		migrationTableName: table,
		migrationLockTableName: lock,
	});
	db.pragma("foreign_keys = OFF");
	let failed: unknown;
	try {
		failed = (await migrator.migrateToLatest()).error;
	} finally {
		db.pragma("foreign_keys = ON");
	}
	if (failed !== undefined) refuse("database");
	assertSettings(db);
}

function cell(value: unknown): { readonly value: unknown; readonly bytes: number } {
	if (value === null) return { value, bytes: 0 };
	switch (typeof value) {
		case "string": {
			const bytes = value.length > MAX_CELL_BYTES ? Infinity : Buffer.byteLength(value, "utf8");
			if (!value.isWellFormed() || bytes > MAX_CELL_BYTES) refuse("database");
			return { value, bytes };
		}
		case "number":
			if (!Number.isFinite(value)) refuse("database");
			return { value, bytes: 8 };
		case "bigint":
			if (value < INT64_MIN || value > INT64_MAX) refuse("database");
			return { value, bytes: 8 };
		case "object": {
			if (!types.isUint8Array(value) || types.isProxy(value)) refuse("database");
			const length = byteLength?.call(value);
			if (typeof length !== "number" || length > MAX_CELL_BYTES) refuse("database");
			const copy = Buffer.alloc(length);
			copy.set(value);
			return { value: copy, bytes: length };
		}
		default:
			return refuse("database");
	}
}

interface Columns {
	readonly names: readonly string[];
	readonly values: readonly unknown[];
}

function columns(row: unknown, allowed: (name: string) => boolean): Columns {
	const names: string[] = [],
		values: unknown[] = [];
	let total = 0;
	for (const [name, raw] of ownData(row, MAX_COLUMNS, "database")) {
		if (!allowed(name)) refuse("database");
		const { value, bytes } = cell(raw);
		total += bytes;
		names.push(name);
		values.push(value);
	}
	if (names.length === 0 || total > MAX_ROW_BYTES) refuse("database");
	return { names, values };
}

const quoted = (name: string): string => `"${name}"`;
const matching = (filter: Columns): string =>
	filter.names.map((name) => `${quoted(name)} IS ?`).join(" AND ");
/** A stored row's bytes, measured in SQL so no stored value enters JavaScript to be measured. */
const rowBytes = (readable: readonly string[]): string =>
	readable.map((name) => `coalesce(octet_length(${quoted(name)}),0)`).join("+");

function copied(value: unknown): unknown {
	if (typeof value === "bigint")
		return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
			? Number(value)
			: value;
	return Buffer.isBuffer(value) ? new Uint8Array(value) : value;
}

export interface ModuleDatabaseOwner {
	readonly database: ModuleDatabase;
	/** Refuses later facade calls and proves the native close; false keeps it for a retry. */
	close(): boolean;
}

function facade(db: SqliteDatabase, shapes: ReadonlyMap<string, TableShape>): ModuleDatabaseOwner {
	let open = true,
		busy = false;
	const shape = (table: unknown): TableShape => {
		const found = typeof table === "string" ? shapes.get(table) : undefined;
		return found ?? refuse("database");
	};
	const guarded =
		<Args extends unknown[], Result>(usable: () => boolean, operation: (...args: Args) => Result) =>
		(...args: Args): Result => {
			if (!open || !usable()) refuse("database");
			try {
				return operation(...args);
			} catch (error) {
				throw error instanceof ExtensionError ? error : new ExtensionError("database");
			}
		};
	// Inserts and updates measure the rows the statement itself writes, as select() does. Rows a
	// module's own triggers or foreign-key actions change are not measured here; select() refuses
	// any over the bound.
	const bounded = db.transaction((sql: string, bindings: readonly unknown[]): number => {
		const statement = db.prepare(sql).pluck();
		let changes = 0;
		for (const bytes of statement.iterate(...bindings) as Iterable<number>) {
			if (++changes > MAX_MUTATED_ROWS) refuse("database");
			if (bytes > MAX_ROW_BYTES) refuse("database");
		}
		return changes;
	});
	const select = (table: unknown, query: unknown): readonly Readonly<Record<string, unknown>>[] => {
		const { readable } = shape(table);
		const options = inertRecord(query, ["limit"], ["equals"], "database");
		const limit = options.limit;
		if (
			typeof limit !== "number" ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > MAX_PAGE_ROWS
		)
			refuse("database");
		const filter =
			options.equals === undefined
				? { names: [], values: [] }
				: columns(options.equals, (name) => readable.includes(name));
		const where = filter.names.length > 0 ? ` WHERE ${matching(filter)}` : "";
		const from = `FROM main.${quoted(table as string)}${where} LIMIT ?`;
		// Measure before any stored value enters JavaScript.
		const measured = db
			.prepare(
				`SELECT coalesce(max(n),0) AS row, coalesce(sum(n),0) AS total FROM (SELECT ${rowBytes(readable)} AS n ${from})`,
			)
			.get(...filter.values, limit) as { row: number; total: number };
		if (measured.row > MAX_ROW_BYTES || measured.total > MAX_RESULT_BYTES) refuse("database");
		const statement = db.prepare(`SELECT ${readable.map(quoted).join(",")} ${from}`);
		statement.safeIntegers(true);
		const rows = statement.all(...filter.values, limit) as Record<string, unknown>[];
		return Object.freeze(
			rows.map((row) => {
				const copy = Object.create(null) as Record<string, unknown>;
				for (const name of readable) copy[name] = copied(row[name]);
				return Object.freeze(copy);
			}),
		);
	};
	const insert = (table: unknown, row: unknown): number => {
		const { readable, writable } = shape(table);
		const values = columns(row, (name) => writable.has(name));
		return bounded(
			`INSERT INTO main.${quoted(table as string)} (${values.names.map(quoted).join(",")}) VALUES (${values.names.map(() => "?").join(",")}) RETURNING ${rowBytes(readable)}`,
			values.values,
		);
	};
	const update = (table: unknown, values: unknown, equals: unknown): number => {
		const { readable, writable } = shape(table);
		const set = columns(values, (name) => writable.has(name));
		const filter = columns(equals, (name) => readable.includes(name));
		return bounded(
			`UPDATE main.${quoted(table as string)} SET ${set.names.map((name) => `${quoted(name)} = ?`).join(",")} WHERE ${matching(filter)} RETURNING ${rowBytes(readable)}`,
			[...set.values, ...filter.values],
		);
	};
	const remove = (table: unknown, equals: unknown): number => {
		const { readable } = shape(table);
		const filter = columns(equals, (name) => readable.includes(name));
		return bounded(
			`DELETE FROM main.${quoted(table as string)} WHERE ${matching(filter)} RETURNING 0`,
			filter.values,
		);
	};
	const tables = (usable: () => boolean): ModuleTables<string> =>
		Object.freeze(
			Object.assign(Object.create(null) as object, {
				select: guarded(usable, select),
				insert: guarded(usable, insert),
				update: guarded(usable, update),
				delete: guarded(usable, remove),
			}),
		) as ModuleTables<string>;
	const transaction = (work: unknown): unknown => {
		if (!open || busy || db.inTransaction) refuse("database");
		if (!isPlainFunction(work) || types.isAsyncFunction(work)) refuse("database");
		let live = true,
			failure: { readonly error: unknown } | undefined;
		const scoped = tables(() => live && busy);
		busy = true;
		try {
			return db
				.transaction(() => {
					let result: unknown;
					try {
						result = work(scoped);
					} catch (error) {
						failure = { error };
						throw error;
					}
					if (isThenable(result)) refuse("database");
					return result;
				})
				.immediate();
		} catch (error) {
			if (failure) throw failure.error;
			throw error instanceof ExtensionError ? error : new ExtensionError("database");
		} finally {
			live = false;
			busy = false;
		}
	};
	const database = Object.freeze(
		Object.assign(Object.create(null) as object, {
			...tables(() => !busy),
			transaction,
		}),
	) as ModuleDatabase;
	return Object.freeze({
		database,
		close: () => {
			open = false;
			return closeConnection(db);
		},
	});
}

export interface ModuleDatabaseOptions {
	readonly dataDirectory: string;
	readonly nativeBinding: string;
	readonly masterKey: MasterKey;
	readonly id: string;
	readonly migrations: readonly VerifiedMigration[];
}

/** The module's own SQLite3MC file, keyed by HKDF(MK, "draftyak/v1/ext/<id>"). */
export async function openModuleDatabase(
	options: ModuleDatabaseOptions,
): Promise<ModuleDatabaseOwner> {
	const { dataDirectory, nativeBinding, masterKey, id, migrations } = options;
	const filename = moduleDatabaseFile(dataDirectory, id);
	let create = false;
	try {
		lstatSync(filename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse("database");
		create = true;
	}
	let db: SqliteDatabase;
	try {
		db = openEncrypted({ filename, nativeBinding, create }, masterKey, `ext/${id}`);
	} catch {
		refuse("database");
	}
	try {
		await migrateModule(db, id, migrations);
		return facade(db, moduleSchema(db, id));
	} catch (error) {
		closeConnection(db);
		throw error instanceof ExtensionError ? error : new ExtensionError("database");
	}
}
