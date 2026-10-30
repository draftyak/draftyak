import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Kysely, SqliteDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { EXPECTED, openEncrypted, readSettings } from "../src/db.ts";
import {
	MigrationError,
	migrate,
	migrationsDir,
	migrationTables,
	REFUSED_STATEMENTS,
	SqlDirMigrationProvider,
	statementStarts,
	TransactionalSqliteDialect,
} from "../src/migrator.ts";
import type { SqliteDatabase } from "../src/open.ts";
import {
	addConversation,
	addMessages,
	binding,
	filler,
	ftsIntegrity,
	newKey,
	search,
	tempDir,
} from "./support.ts";

const coreFile = path.join(migrationsDir, "core", "0001_init.sql");
const coreSql = readFileSync(coreFile, "utf8");

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	return undefined;
}

function withDb<T>(use: (db: SqliteDatabase, dir: string) => Promise<T>): Promise<T> {
	const dir = tempDir();
	const db = openEncrypted(path.join(dir, "draftyak.db"), newKey(), binding(), { create: true });
	return use(db, dir).finally(() => db.close());
}

// A migrations folder of its own: core's 0001 plus the given files.
function migrationFolder(dir: string, files: Readonly<Record<string, string>>): string {
	const folder = path.join(dir, "migrations", "core");
	mkdirSync(folder, { recursive: true });
	cpSync(coreFile, path.join(folder, "0001_init.sql"));
	for (const [name, text] of Object.entries(files)) writeFileSync(path.join(folder, name), text);
	return folder;
}

const schemaNames = (db: SqliteDatabase, type: string): string[] =>
	db
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.pluck()
		.all(type) as string[];

const tablesAfterCore = [
	"_migrations_core",
	"_migrations_core_lock",
	"conversations",
	"fts_messages",
	"fts_messages_config",
	"fts_messages_data",
	"fts_messages_docsize",
	"fts_messages_idx",
	"messages",
];

const applied = (db: SqliteDatabase): string[] =>
	db.prepare("SELECT name FROM _migrations_core ORDER BY name").pluck().all() as string[];

describe("migrate", () => {
	it("applies migrations/core once and records it in _migrations_core", async () => {
		await withDb(async (db) => {
			expect(await migrate(db, "core")).toEqual(["0001_init"]);
			expect(await migrate(db, "core")).toEqual([]);
			expect(migrationTables("core")).toEqual({
				table: "_migrations_core",
				lock: "_migrations_core_lock",
			});
			expect(applied(db)).toEqual(["0001_init"]);
			expect(schemaNames(db, "table")).toEqual(tablesAfterCore);
			expect(schemaNames(db, "trigger")).toEqual(["messages_ad", "messages_ai", "messages_au"]);
			await expect(migrate(db, "Core")).rejects.toThrow("not a migration namespace: Core");
		});
	});

	it("keeps each FTS trigger's BEGIN…END body whole, and the triggers work", async () => {
		await withDb(async (db) => {
			await migrate(db, "core");
			const triggers = [...coreSql.matchAll(/^CREATE TRIGGER (\w+)[\s\S]*?^END;$/gm)];
			expect(triggers.map(([, name]) => name)).toEqual([
				"messages_ai",
				"messages_ad",
				"messages_au",
			]);
			for (const [statement, name] of triggers) {
				const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").pluck().get(name);
				expect(stored).toBe(statement.slice(0, -";".length));
			}
			addConversation(db);
			addMessages(db, [{ id: "m-1", subject: "Agenda", body: "budget review" }]);
			expect(search(db, "budget")).toHaveLength(1);
		});
	});

	it("needs exec(): Kysely runs one statement per query, and a split on ';' cuts the triggers", async () => {
		await withDb(async (db) => {
			const kysely = new Kysely<unknown>({ dialect: new SqliteDialect({ database: db }) });
			const error = await rejection(sql.raw(coreSql).execute(kysely));
			expect(error).toMatchObject({
				message: "The supplied SQL string contains more than one statement",
			});
			expect(schemaNames(db, "table")).toEqual([]);
			// Run piece by piece, the tables and the FTS table are created; the first trigger is cut
			// at its first inner ";".
			const pieces = coreSql.split(";").filter((piece) => piece.trim() !== "");
			const failed = pieces.findIndex((piece) => {
				try {
					db.exec(`${piece};`);
					return false;
				} catch (cut) {
					expect(cut).toMatchObject({ message: "incomplete input" });
					return true;
				}
			});
			expect(pieces[failed]).toMatch(
				/^\s*CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN/,
			);
			expect(schemaNames(db, "trigger")).toEqual([]);
		});
	});

	it("runs only inside a transaction, which Kysely's SqliteAdapter never opens for migrations", async () => {
		await withDb(async (db, dir) => {
			const stock = new SqliteDialect({ database: db });
			expect(stock.createAdapter().supportsTransactionalDdl).toBe(false);
			expect(
				new TransactionalSqliteDialect({ database: db }).createAdapter().supportsTransactionalDdl,
			).toBe(true);
			const migrator = new Migrator({
				db: new Kysely<unknown>({ dialect: stock }),
				provider: new SqlDirMigrationProvider(migrationFolder(dir, {}), db),
				migrationTableName: "_migrations_core",
				migrationLockTableName: "_migrations_core_lock",
			});
			const { error, results } = await migrator.migrateToLatest();
			expect(error).toMatchObject({
				name: "MigrationFileError",
				message: "0001_init.sql: migrations run only inside the migrator's transaction",
			});
			expect(results).toEqual([{ migrationName: "0001_init", direction: "Up", status: "Error" }]);
			expect(schemaNames(db, "table")).toEqual(["_migrations_core", "_migrations_core_lock"]);
		});
	});

	it("rolls back a failing batch: no table or record from it remains", async () => {
		await withDb(async (db, dir) => {
			await migrate(db, "core");
			const folder = migrationFolder(dir, {
				"0002_labels.sql": "CREATE TABLE labels (id TEXT PRIMARY KEY) STRICT;",
				"0003_broken.sql": "CREATE TABLE notes (id TEXT) STRICT;\nINSERT INTO missing VALUES (1);",
			});
			const error = await rejection(migrate(db, "core", folder));
			expect(error).toBeInstanceOf(MigrationError);
			expect(error).toMatchObject({
				message: "core 0003_broken: no such table: missing",
				results: [
					{ migrationName: "0002_labels", direction: "Up", status: "NotExecuted" },
					{ migrationName: "0003_broken", direction: "Up", status: "Error" },
				],
			});
			expect(applied(db)).toEqual(["0001_init"]);
			expect(schemaNames(db, "table")).not.toContain("labels");
			expect(schemaNames(db, "table")).not.toContain("notes");
			expect(db.inTransaction).toBe(false);
		});
	});

	it.for([
		{ name: "README.txt", text: "notes" },
		{ name: "0002_Labels.sql", text: "SELECT 1;" },
		{ name: "2_labels.sql", text: "SELECT 1;" },
		{ name: "0001_again.sql", text: "SELECT 1;" },
	])(
		"refuses a stray, misnamed or reused file name instead of skipping it: $name",
		async ({ name, text }) => {
			await withDb(async (db, dir) => {
				const error = await rejection(migrate(db, "core", migrationFolder(dir, { [name]: text })));
				expect(error).toMatchObject({ name: "MigrationError", results: [] });
				expect(String((error as Error).message)).toMatch(
					/^core: .* (named NNNN_<name>\.sql|is used twice)$/,
				);
				expect(schemaNames(db, "table")).toEqual(["_migrations_core", "_migrations_core_lock"]);
			});
		},
	);

	it.for([
		{
			name: "0003_commits.sql",
			text: "CREATE TABLE early (x TEXT) STRICT;\nCOMMIT;\nCREATE TABLE late (x TEXT);",
			message: "core: 0003_commits.sql: a migration can't run COMMIT",
		},
		{
			name: "0003_wrapped.sql",
			text: "BEGIN;\nCREATE TABLE wrapped (x TEXT) STRICT;\nCOMMIT;",
			message: "core: 0003_wrapped.sql: a migration can't run BEGIN, COMMIT",
		},
		{
			name: "0003_undoes.sql",
			text: "CREATE TABLE b (x TEXT) STRICT;\nROLLBACK;\nCREATE TABLE c (x TEXT);",
			message: "core: 0003_undoes.sql: a migration can't run ROLLBACK",
		},
		{
			name: "0003_ends.sql",
			text: "CREATE TABLE d (x TEXT) STRICT; /* done */ end transaction;",
			message: "core: 0003_ends.sql: a migration can't run END",
		},
		{
			name: "0003_settings.sql",
			text: "PRAGMA secure_delete = OFF;\npragma trusted_schema = ON;",
			message: "core: 0003_settings.sql: a migration can't run PRAGMA",
		},
		{
			name: "0003_saves.sql",
			text: "SAVEPOINT s; CREATE TABLE e (x TEXT); RELEASE s;",
			message: "core: 0003_saves.sql: a migration can't run SAVEPOINT, RELEASE",
		},
		{
			name: "0003_attaches.sql",
			text: "ATTACH 'other.db' AS other; DETACH other;",
			message: "core: 0003_attaches.sql: a migration can't run ATTACH, DETACH",
		},
		{
			name: "0003_vacuums.sql",
			text: "VACUUM;",
			message: "core: 0003_vacuums.sql: a migration can't run VACUUM",
		},
	])(
		"refuses transaction control, PRAGMA, ATTACH and VACUUM before any file of the run runs: $name",
		async ({ name, text, message }) => {
			await withDb(async (db, dir) => {
				await migrate(db, "core");
				const folder = migrationFolder(dir, {
					"0002_labels.sql": "CREATE TABLE labels (id TEXT PRIMARY KEY) STRICT;",
					[name]: text,
				});
				const error = await rejection(migrate(db, "core", folder));
				expect(error).toMatchObject({ name: "MigrationError", results: [] });
				expect(schemaNames(db, "table")).toEqual(tablesAfterCore);
				expect(applied(db)).toEqual(["0001_init"]);
				expect(readSettings(db)).toEqual(EXPECTED);
				expect(String((error as Error).message)).toBe(message);
			});
		},
	);

	it("refuses exactly transaction control, PRAGMA, ATTACH, DETACH and VACUUM", () => {
		expect([...REFUSED_STATEMENTS].toSorted()).toEqual(
			["ATTACH", "BEGIN", "COMMIT", "DETACH", "END", "PRAGMA", "RELEASE", "ROLLBACK"]
				.concat(["SAVEPOINT", "VACUUM"])
				.toSorted(),
		);
	});

	it("finds statements as SQLite does: not in trigger bodies, strings, quoted names or comments", async () => {
		const sql = `-- COMMIT; and ROLLBACK; in a comment
/* PRAGMA secure_delete = OFF; */
CREATE TABLE "begin" (body TEXT NOT NULL DEFAULT 'BEGIN; COMMIT;') STRICT;
CREATE TEMP TRIGGER t AFTER INSERT ON "begin" BEGIN
  SELECT CASE WHEN new.body = '' THEN 'end' ELSE new.body END;
  INSERT INTO [end] VALUES ('a;b');
END;
explain query plan select 1; END TRANSACTION`;
		expect(statementStarts(sql)).toEqual(["CREATE", "CREATE", "EXPLAIN", "END"]);
		await withDb(async (db, dir) => {
			const folder = migrationFolder(dir, {
				"0002_notes.sql": `-- COMMIT; and ROLLBACK; in a comment
/* PRAGMA secure_delete = OFF; */
CREATE TABLE notes (body TEXT NOT NULL DEFAULT 'BEGIN; COMMIT;') STRICT;
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  UPDATE notes SET body = CASE WHEN new.body = '' THEN 'end' ELSE new.body END
  WHERE rowid = new.rowid;
END;`,
			});
			expect(await migrate(db, "core", folder)).toEqual(["0001_init", "0002_notes"]);
			db.prepare("INSERT INTO notes VALUES ('')").run();
			expect(db.prepare("SELECT body FROM notes").pluck().all()).toEqual(["end"]);
		});
	});

	it("reports SQLite's own rollback, on SQLITE_FULL here: nothing from the run is applied", async () => {
		await withDb(async (db, dir) => {
			await migrate(db, "core");
			const folder = migrationFolder(dir, {
				"0002_labels.sql": "CREATE TABLE labels (id TEXT PRIMARY KEY) STRICT;",
				"0003_big.sql":
					"CREATE TABLE big (b BLOB) STRICT;\nINSERT INTO big VALUES (zeroblob(4000000));",
			});
			const pages = db.pragma("page_count", { simple: true }) as number;
			db.pragma(`max_page_count = ${pages + 50}`);
			const error = await rejection(migrate(db, "core", folder));
			expect(error).toMatchObject({
				message:
					"core 0003_big: SQLite rolled back the migrator's transaction in 0003_big.sql: nothing from this run is applied",
				results: [
					{ migrationName: "0002_labels", direction: "Up", status: "NotExecuted" },
					{ migrationName: "0003_big", direction: "Up", status: "Error" },
				],
			});
			expect((error as Error).cause).toMatchObject({ name: "MigrationFileError" });
			expect(schemaNames(db, "table")).toEqual(tablesAfterCore);
			expect(applied(db)).toEqual(["0001_init"]);
			expect(db.inTransaction).toBe(false);
		});
	});

	it("turns foreign keys off for the run, so a table rebuild keeps the table's children", async () => {
		await withDb(async (db, dir) => {
			await migrate(db, "core");
			addConversation(db);
			addMessages(db, filler(5));
			// SQLite's documented rebuild of a parent table, here to add a CHECKed column.
			const rebuild = migrationFolder(dir, {
				"0002_rebuild.sql": `CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
) STRICT;
INSERT INTO conversations_new (id, account_id, subject)
  SELECT id, account_id, subject FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;`,
			});
			expect(await migrate(db, "core", rebuild)).toEqual(["0002_rebuild"]);
			expect(db.prepare("SELECT count(*) FROM messages").pluck().get()).toBe(5);
			expect(search(db, "fox")).toHaveLength(5);
			ftsIntegrity(db);
			expect(readSettings(db)).toEqual(EXPECTED);
			// With foreign keys off, nothing cascades: a file that leaves orphans is refused instead.
			const orphaning = migrationFolder(dir, { "0003_orphans.sql": "DELETE FROM conversations;" });
			expect(await rejection(migrate(db, "core", orphaning))).toMatchObject({
				message: "core 0003_orphans: 0003_orphans.sql leaves 5 foreign key violations in messages",
			});
			expect(db.prepare("SELECT count(*) FROM conversations").pluck().get()).toBe(1);
			expect(readSettings(db)).toEqual(EXPECTED);
		});
	});

	it("runs only on a connection with openEncrypted()'s settings and no open transaction", async () => {
		await withDb(async (db) => {
			db.pragma("secure_delete = OFF");
			expect(await rejection(migrate(db, "core"))).toMatchObject({
				name: "SettingsError",
				message: "SQLite didn't confirm secureDelete",
			});
			db.pragma("secure_delete = ON");
			db.exec("BEGIN");
			expect(await rejection(migrate(db, "core"))).toMatchObject({
				name: "MigrationFileError",
				message: "migrations run outside other transactions",
			});
			db.exec("ROLLBACK");
			expect(schemaNames(db, "table")).toEqual([]);
		});
	});
});
