import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type DialectAdapter, Kysely, SqliteAdapter, SqliteDialect } from "kysely";
import {
	type Migration,
	type MigrationProvider,
	type MigrationResult,
	type MigrationResultSet,
	Migrator,
} from "kysely/migration";
import { assertSettings } from "./db.ts";
import type { SqliteDatabase } from "./open.ts";
import { spikeDir } from "./prebuilds.ts";

export const migrationsDir: string = path.join(spikeDir, "migrations");
export const MIGRATION_FILE: RegExp = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const NAMESPACE = /^[a-z][a-z0-9]*$/;

// SQLite runs DDL inside transactions, but Kysely 0.29.6's SqliteAdapter says it can't, so its
// Migrator would run each statement of a migration in autocommit mode. With this adapter the
// pending files and their _migrations_<ns> rows commit together or not at all.
class TransactionalSqliteAdapter extends SqliteAdapter {
	override get supportsTransactionalDdl(): boolean {
		return true;
	}
}

export class TransactionalSqliteDialect extends SqliteDialect {
	override createAdapter(): DialectAdapter {
		return new TransactionalSqliteAdapter();
	}
}

export class MigrationFileError extends Error {
	override name = "MigrationFileError";
}

// Transaction control would end or nest the migrator's transaction; settings, attached files and
// VACUUM belong to the store's open, not to a migration.
export const REFUSED_STATEMENTS: ReadonlySet<string> = new Set([
	...["BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"],
	...["PRAGMA", "ATTACH", "DETACH", "VACUUM"],
]);

// sqlite3_complete()'s state machine. Rows are states, columns tokens: ";", space or comment,
// other, EXPLAIN, CREATE, TEMP, TRIGGER, END. CREATE TRIGGER runs to ";END;".
const TRANSITIONS: readonly (readonly number[])[] = [
	[1, 0, 2, 3, 4, 2, 2, 2],
	[1, 1, 2, 3, 4, 2, 2, 2],
	[1, 2, 2, 2, 2, 2, 2, 2],
	[1, 3, 3, 2, 4, 2, 2, 2],
	[1, 4, 2, 2, 2, 4, 5, 2],
	[6, 5, 5, 5, 5, 5, 5, 5],
	[6, 6, 5, 5, 5, 5, 5, 7],
	[1, 7, 5, 5, 5, 5, 5, 5],
];
const KEYWORDS: ReadonlyMap<string, number> = new Map([
	["EXPLAIN", 3],
	["CREATE", 4],
	["TEMP", 5],
	["TEMPORARY", 5],
	["TRIGGER", 6],
	["END", 7],
]);
const TOKEN =
	/[ \t\n\f\r]+|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*|'[^']*'?|"[^"]*"?|`[^`]*`?|\[[^\]]*\]?|[\w$\u0080-\uffff]+|[\s\S]/gy;
const SPACE = /^(?:[ \t\n\f\r]|\/\*|--)/;

// The first word of each top-level statement, upper-cased: strings, quoted names, comments and
// trigger bodies are skipped the way SQLite's own sqlite3_complete() skips them.
export function statementStarts(sql: string): string[] {
	const starts: string[] = [];
	let state = 0;
	for (const [token] of sql.matchAll(TOKEN)) {
		const word = token.toUpperCase();
		const kind = token === ";" ? 0 : SPACE.test(token) ? 1 : (KEYWORDS.get(word) ?? 2);
		if (state <= 1 && kind > 1) starts.push(word);
		state = TRANSITIONS[state]?.[kind] ?? 2;
	}
	return starts;
}

// Every NNNN_<name>.sql in one folder, each run whole with exec(): FTS5 triggers hold BEGIN…END,
// which Kysely's one-statement queries and any split on ";" would break. Another file in the
// folder, or a file with a refused statement, fails the run before any file runs.
export class SqlDirMigrationProvider implements MigrationProvider {
	readonly #dir: string;
	readonly #db: SqliteDatabase;

	constructor(dir: string, db: SqliteDatabase) {
		this.#dir = dir;
		this.#db = db;
	}

	async getMigrations(): Promise<Record<string, Migration>> {
		const migrations: Record<string, Migration> = {};
		const numbers = new Set<string>();
		for (const name of readdirSync(this.#dir).toSorted()) {
			const number = MIGRATION_FILE.exec(name)?.[1];
			if (number === undefined) {
				throw new MigrationFileError(`${name}: migration files are named NNNN_<name>.sql`);
			}
			if (numbers.has(number)) throw new MigrationFileError(`${name}: ${number} is used twice`);
			numbers.add(number);
			const sql = readFileSync(path.join(this.#dir, name), "utf8");
			const refused = [...new Set(statementStarts(sql))].filter((w) => REFUSED_STATEMENTS.has(w));
			if (refused.length > 0) {
				throw new MigrationFileError(`${name}: a migration can't run ${refused.join(", ")}`);
			}
			migrations[name.slice(0, -".sql".length)] = { up: async () => this.#run(name, sql) };
		}
		return migrations;
	}

	#run(name: string, sql: string): void {
		if (!this.#db.inTransaction) {
			throw new MigrationFileError(
				`${name}: migrations run only inside the migrator's transaction`,
			);
		}
		try {
			this.#db.exec(sql);
		} catch (error) {
			this.#assertStillInTransaction(name);
			throw error;
		}
		this.#assertStillInTransaction(name);
		// migrate() turns foreign keys off for the run, so each file must leave them consistent.
		const broken = this.#db.pragma("foreign_key_check") as { table: string }[];
		if (broken.length > 0) {
			const tables = [...new Set(broken.map(({ table }) => table))].join(", ");
			throw new MigrationFileError(
				`${name} leaves ${broken.length} foreign key violations in ${tables}`,
			);
		}
	}

	// With transaction control refused, only SQLite itself ends the transaction early: it rolls back
	// on errors such as SQLITE_FULL or SQLITE_IOERR. A fresh transaction lets the migrator's own
	// rollback succeed, so the error names this file.
	#assertStillInTransaction(name: string): void {
		if (this.#db.inTransaction) return;
		this.#db.exec("BEGIN");
		throw new MigrationFileError(
			`SQLite rolled back the migrator's transaction in ${name}: nothing from this run is applied`,
		);
	}
}

export class MigrationError extends Error {
	override name = "MigrationError";
	readonly results: readonly MigrationResult[];

	constructor(message: string, results: readonly MigrationResult[], cause: unknown) {
		super(message, { cause });
		this.results = results;
	}
}

export const migrationTables = (namespace: string): { table: string; lock: string } => ({
	table: `_migrations_${namespace}`,
	lock: `_migrations_${namespace}_lock`,
});

// Runs a namespace's pending migrations (§3 Migrations) on a connection from openEncrypted() and
// returns their names. Kysely keeps the caller's connection open: destroying the Kysely instance
// would close it.
export async function migrate(
	db: SqliteDatabase,
	namespace: string,
	dir: string = path.join(migrationsDir, namespace),
): Promise<string[]> {
	if (!NAMESPACE.test(namespace)) throw new TypeError(`not a migration namespace: ${namespace}`);
	if (db.inTransaction) throw new MigrationFileError("migrations run outside other transactions");
	assertSettings(db);
	const { table, lock } = migrationTables(namespace);
	const migrator = new Migrator({
		db: new Kysely<unknown>({ dialect: new TransactionalSqliteDialect({ database: db }) }),
		provider: new SqlDirMigrationProvider(dir, db),
		migrationTableName: table,
		migrationLockTableName: lock,
	});
	// SQLite ignores PRAGMA foreign_keys inside a transaction, so it's off for the whole run: the
	// DROP TABLE in a table rebuild would otherwise cascade into the table's children.
	db.pragma("foreign_keys = OFF");
	let outcome: MigrationResultSet;
	try {
		outcome = await migrator.migrateToLatest();
	} finally {
		db.pragma("foreign_keys = ON");
	}
	const { error, results = [] } = outcome;
	if (error !== undefined) {
		const failed = results.find((result) => result.status === "Error")?.migrationName;
		const detail = error instanceof Error ? error.message : String(error);
		// One transaction: a failed run applies none of its files, those before the failure included.
		const unapplied = results.map((result) =>
			result.status === "Success" ? { ...result, status: "NotExecuted" as const } : result,
		);
		throw new MigrationError(
			`${namespace}${failed ? ` ${failed}` : ""}: ${detail}`,
			unapplied,
			error,
		);
	}
	assertSettings(db);
	return results.map((result) => result.migrationName);
}
