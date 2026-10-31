import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type DialectAdapter, Kysely, SqliteAdapter, SqliteDialect } from "kysely";
import {
	type Migration,
	type MigrationProvider,
	type MigrationResult,
	type MigrationResultSet,
	Migrator,
} from "kysely/migration";
import { assertSettings, type SqliteDatabase } from "./open.ts";

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
	...["PRAGMA", "ATTACH", "DETACH", "VACUUM", "EXPLAIN"],
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
	/[ \t\n\f\r\ufeff]+|\/\*[\s\S]*?(?:\*\/|$)|--[^\n]*|'[^']*'?|"[^"]*"?|`[^`]*`?|\[[^\]]*\]?|[\w$\u0080-\ufefe\uff00-\uffff][\w$\u0080-\ufefe\uff00-\uffff]*|[\s\S]/gy;
const SPACE = /^(?:[ \t\n\f\r\ufeff]|\/\*|--)/;

// Reserve pragma-prefixed tokens, including string literals; callers bind ordinary values.
export function namesPragmaFunction(sql: string): boolean {
	for (const [token] of sql.matchAll(TOKEN)) {
		const name = ['"', "'", "`", "["].includes(token[0] ?? "") ? token.slice(1) : token;
		if (/^pragma_/i.test(name)) return true;
	}
	return false;
}

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

export interface MigrationFile {
	/** The file name without `.sql`, as the migrator records it. */
	readonly name: string;
	readonly sql: string;
}
export type MigrationPlan = readonly MigrationFile[];
const captured = new WeakSet<MigrationPlan>();

// Every NNNN_<name>.sql in one folder, read once: the migrator runs these exact strings and the
// schema check replays them. Another file in the folder, or a file with a refused statement,
// refuses the whole plan.
export function captureMigrationPlan(dir: string): MigrationPlan {
	const files: MigrationFile[] = [];
	const numbers = new Set<string>();
	for (const name of readdirSync(dir).toSorted()) {
		const entry = lstatSync(path.join(dir, name));
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new MigrationFileError("Migration entries must be regular files without symlinks");
		}
		const number = MIGRATION_FILE.exec(name)?.[1];
		if (number === undefined) {
			throw new MigrationFileError(`${name}: migration files are named NNNN_<name>.sql`);
		}
		if (numbers.has(number)) throw new MigrationFileError(`${name}: ${number} is used twice`);
		numbers.add(number);
		const sql = readFileSync(path.join(dir, name), "utf8");
		const refused = [...new Set(statementStarts(sql))].filter((w) => REFUSED_STATEMENTS.has(w));
		if (refused.length > 0) {
			throw new MigrationFileError(`${name}: a migration can't run ${refused.join(", ")}`);
		}
		files.push(Object.freeze({ name: name.slice(0, -".sql".length), sql }));
	}
	const plan = Object.freeze(files);
	captured.add(plan);
	return plan;
}

// Each file runs whole with exec(): FTS5 triggers hold BEGIN…END, which Kysely's one-statement
// queries and any split on ";" would break.
class PlanMigrationProvider implements MigrationProvider {
	readonly #plan: MigrationPlan;
	readonly #db: SqliteDatabase;
	readonly #afterFile: ((name: string) => void) | undefined;

	constructor(plan: MigrationPlan, db: SqliteDatabase, afterFile?: (name: string) => void) {
		this.#plan = plan;
		this.#db = db;
		this.#afterFile = afterFile;
	}

	async getMigrations(): Promise<Record<string, Migration>> {
		const migrations: Record<string, Migration> = {};
		for (const { name, sql } of this.#plan)
			migrations[name] = { up: async () => this.#run(`${name}.sql`, sql) };
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
			this.#afterFile?.(name);
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

export class SqlDirMigrationProvider implements MigrationProvider {
	readonly #dir: string;
	readonly #db: SqliteDatabase;
	readonly #afterFile: ((name: string) => void) | undefined;

	constructor(dir: string, db: SqliteDatabase, afterFile?: (name: string) => void) {
		this.#dir = dir;
		this.#db = db;
		this.#afterFile = afterFile;
	}

	async getMigrations(): Promise<Record<string, Migration>> {
		const plan = captureMigrationPlan(this.#dir);
		return new PlanMigrationProvider(plan, this.#db, this.#afterFile).getMigrations();
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
// returns their names. A folder is read when the migrator asks for it; a captured plan runs as
// captured. Kysely keeps the caller's connection open: destroying the Kysely instance would close it.
export async function migrate(
	db: SqliteDatabase,
	namespace: string,
	source: string | MigrationPlan,
	beforePending?: () => void,
	afterFile?: (name: string) => void,
): Promise<string[]> {
	if (!NAMESPACE.test(namespace)) throw new TypeError(`not a migration namespace: ${namespace}`);
	if (typeof source !== "string" && !captured.has(source))
		throw new TypeError("not a captured migration plan");
	if (db.inTransaction) throw new MigrationFileError("migrations run outside other transactions");
	assertSettings(db);
	const { table, lock } = migrationTables(namespace);
	let provider: MigrationProvider =
		typeof source === "string"
			? new SqlDirMigrationProvider(source, db, afterFile)
			: new PlanMigrationProvider(source, db, afterFile);
	if (beforePending) {
		// Discover pending work using reads only, before Kysely can create its metadata tables.
		// Reuse this exact plan: later directory changes cannot introduce SQL after the preflight.
		const planned = await provider.getMigrations();
		const exists = db
			.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?")
			.get(table);
		const applied = new Set(
			exists
				? (db.prepare(`SELECT name FROM main."${table}"`).all() as { name: string }[]).map(
						(row) => row.name,
					)
				: [],
		);
		const hasSchema = db
			.prepare("SELECT 1 FROM main.sqlite_schema WHERE name NOT GLOB 'sqlite_*' LIMIT 1")
			.get();
		if (hasSchema && Object.keys(planned).some((name) => !applied.has(name))) beforePending();
		provider = { getMigrations: async () => planned };
	}
	const migrator = new Migrator({
		db: new Kysely<unknown>({ dialect: new TransactionalSqliteDialect({ database: db }) }),
		provider,
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
