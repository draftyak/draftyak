import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../../src/store/store.ts";
import { fixture, migrations, nativeBinding } from "./helpers.ts";

describe("encrypted production store", () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	beforeEach(async () => {
		f = await fixture();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		f.store.close();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	});
	it("accepts only the issuing Store's live native write authority", () => {
		let retired: SqlTransaction | undefined;
		let hooks = 0;
		const fake = new Proxy(Object.create(null), {
			get() {
				hooks++;
				throw new Error("DYTEST-HOOK");
			},
		});
		expect(() => assertStoreTransaction(f.store, fake)).toThrow("Database transaction unavailable");
		expect(() => assertStoreTransaction(undefined as unknown as HubStore, fake)).toThrow(
			"Database transaction unavailable",
		);
		f.store.read((reader) => {
			expect(() => assertStoreTransaction(f.store, reader as SqlTransaction)).toThrow(
				"Database transaction unavailable",
			);
		});
		f.store.write((tx) => {
			assertStoreTransaction(f.store, tx);
			retired = tx;
			expect(() => assertStoreTransaction(f.store, { ...tx })).toThrow(
				"Database transaction unavailable",
			);
			expect(() => assertStoreTransaction(f.store, new Proxy(tx, {}))).toThrow(
				"Database transaction unavailable",
			);
		});
		if (!retired) throw new Error("Missing native test transaction");
		const ended = retired;
		expect(() => assertStoreTransaction(f.store, ended)).toThrow(
			"Database transaction unavailable",
		);
		expect(hooks).toBe(0);
	});
	it("revokes write authority after caught SQLite transaction-wide rollback but preserves an aborted statement", () => {
		f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES('existing',1)"));
		let refusal: unknown;
		try {
			f.store.write((tx) => {
				try {
					tx.run("INSERT OR ROLLBACK INTO test_rows VALUES('existing',2)");
				} catch {
					/* Native constraint intentionally aborts the transaction. */
				}
				try {
					assertStoreTransaction(f.store, tx);
				} catch (error) {
					refusal = error;
				}
			});
		} catch {
			/* The native transaction wrapper may also refuse its final commit. */
		}
		expect(refusal).toMatchObject({ message: "Database transaction unavailable" });
		f.store.write((tx) => {
			expect(() => tx.run("INSERT OR ABORT INTO test_rows VALUES('existing',2)")).toThrow();
			assertStoreTransaction(f.store, tx);
			tx.run("INSERT INTO test_rows VALUES('after-abort',3)");
		});
		expect(f.store.read((db) => db.get("SELECT id FROM test_rows WHERE id='after-abort'"))).toEqual(
			{ id: "after-abort" },
		);
	});
	it("persists encrypted pages, verifies the key and refuses overwrite", () => {
		const canary = "DYTEST-PRIVATE-CONTENT-8cf169c0";
		f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES(?,?)", [canary, 1]));
		f.store.checkpoint();
		f.store.close();
		const bytes = readFileSync(f.filename);
		expect(bytes.subarray(0, 16).toString()).not.toBe("SQLite format 3\0");
		expect(bytes.includes(Buffer.from(canary))).toBe(false);
		const wrong = new MasterKey(randomBytes(32));
		expect(() => new HubStore({ filename: f.filename, nativeBinding, masterKey: wrong })).toThrow();
		expect(readFileSync(f.filename)).toEqual(bytes);
		expect(
			() => new HubStore({ filename: f.filename, nativeBinding, masterKey: f.key, create: true }),
		).toThrow("already exists");
		wrong.destroy();
		const reopened = new HubStore({ filename: f.filename, nativeBinding, masterKey: f.key });
		expect(reopened.read((db) => db.get<{ id: string }>("SELECT id FROM test_rows"))?.id).toBe(
			canary,
		);
		reopened.close();
	});
	it("does not turn plaintext, missing or empty databases into a new hub", () => {
		const filename = path.join(f.dir, "other.db");
		expect(() => new HubStore({ filename, nativeBinding, masterKey: f.key })).toThrow();
		writeFileSync(filename, "");
		expect(() => new HubStore({ filename, nativeBinding, masterKey: f.key })).toThrow(
			"Database was never initialized; remove this unused empty database before creating it again",
		);
		const plain = new Database(filename, { nativeBinding });
		plain.exec("CREATE TABLE plain(x)");
		plain.close();
		expect(() => new HubStore({ filename, nativeBinding, masterKey: f.key })).toThrow();
	});
	it("rolls back changes and invalidates every transaction handle", () => {
		let saved: SqlTransaction | undefined;
		expect(() =>
			f.store.write((tx) => {
				saved = tx;
				tx.run("INSERT INTO test_rows VALUES('u',1)");
				throw new Error("fail");
			}),
		).toThrow("fail");
		expect(f.store.read((db) => db.all("SELECT * FROM test_rows"))).toEqual([]);
		expect(() => saved?.run("INSERT INTO test_rows VALUES('late',1)")).toThrow(
			"callback has ended",
		);
	});
	it("refuses async callbacks before invoking and rolls back returned thenables", () => {
		let invoked = false;
		expect(() =>
			f.store.write(async (tx) => {
				invoked = true;
				tx.run("INSERT INTO test_rows VALUES('u',1)");
			}),
		).toThrow("synchronous");
		expect(invoked).toBe(false);
		expect(() =>
			f.store.write((tx) => {
				tx.run("INSERT INTO test_rows VALUES('u',1)");
				// biome-ignore lint/suspicious/noThenProperty: exercise rejection of an accidental thenable.
				return { then() {} };
			}),
		).toThrow("synchronous");
		expect(f.store.read((db) => db.all("SELECT * FROM test_rows"))).toEqual([]);
	});
	it("read handles cannot mutate and expire after their callback", () => {
		let saved: SqlReader | undefined;
		expect(() =>
			f.store.read((db) => db.get("INSERT INTO test_rows VALUES('u',1) RETURNING id")),
		).toThrow("cannot change");
		f.store.read((db) => {
			saved = db;
		});
		expect(() => saved?.all("SELECT * FROM test_rows")).toThrow("callback has ended");
	});
	it.each([
		"COMMIT",
		"/* comment */ ROLLBACK",
		"-- comment\nATTACH 'other.db' AS other",
		"PRAGMA foreign_keys=OFF",
		"\ufeffPRAGMA temp_store=FILE",
		"/* prefix */\ufeffEXPLAIN PRAGMA trusted_schema=ON",
		";\ufeffDROP TRIGGER main.audit_no_delete",
		"EXPLAIN PRAGMA temp_store=FILE",
		"EXPLAIN QUERY PLAN PRAGMA foreign_keys=OFF",
		"EXPLAIN PRAGMA hexrekey='0000000000000000000000000000000000000000000000000000000000000000'",
		"CREATE TEMP TABLE forbidden(x)",
		"DROP TRIGGER main.audit_no_delete",
		"ALTER TABLE test_rows ADD COLUMN hidden TEXT",
		"ANALYZE",
		"REINDEX",
		"SELECT * FROM pragma_optimize(0x10002)",
		"SELECT * FROM main.pragma_optimize(0x10002)",
		'SELECT * FROM "main"."pragma_optimize"(0x10002)',
		"SELECT * FROM [main].[pragma_optimize](0x10002)",
		"SELECT * FROM `pragma_optimize`(0x10002)",
		"SELECT * FROM 'pragma_optimize'(0x10002)",
		"SELECT * FROM test_rows, 'pragma_optimize' WHERE arg = 65538",
		"SELECT * FROM ('pragma_optimize') WHERE arg = 65538",
		"SELECT * FROM main./* comment */[PrAgMa_OpTiMiZe](0x10002)",
	])("refuses transaction and connection control: %s", (sql) => {
		for (const method of ["get", "all", "run"] as const) {
			expect(() => f.store.write((tx) => tx[method](sql))).toThrow("reserved");
		}
		for (const method of ["get", "all"] as const) {
			expect(() => f.store.read((db) => db[method](sql))).toThrow("reserved");
		}
	});
	it("keeps ordinary pragma-named text readable and restores read-only mode after errors", () => {
		expect(f.store.read((db) => db.get("SELECT ? AS label", ["pragma_optimize"]))).toEqual({
			label: "pragma_optimize",
		});
		expect(() =>
			f.store.read(() => {
				throw new Error("callback fault");
			}),
		).toThrow("callback fault");
		expect(
			f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES('after-read',1)")).changes,
		).toBe(1);
	});
	it("refuses unregistered migration namespaces before opening a caller-chosen folder", async () => {
		await expect(f.store.migrate("unregistered")).rejects.toThrow("not registered");
		expect(f.store.read((db) => db.get("SELECT COUNT(*) AS n FROM main.audit_events"))).toEqual({
			n: 0,
		});
	});
	it("enforces native SQLite query-only mode throughout a read callback", () => {
		const prepare = Database.prototype.prepare;
		let native: Database.Database | undefined;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			native = this;
			return prepare.call(this, sql);
		});
		f.store.read((db) => {
			db.get("SELECT 1");
			expect(native?.pragma("query_only", { simple: true })).toBe(1);
			expect(() =>
				native?.prepare("INSERT INTO test_rows VALUES('native-read',1)").run(),
			).toThrowError(expect.objectContaining({ code: "SQLITE_READONLY" }));
		});
		expect(native?.pragma("query_only", { simple: true })).toBe(0);
		expect(f.store.read((db) => db.all("SELECT * FROM test_rows"))).toEqual([]);
	});
	it("copies the kernel migration map at construction instead of following later folder changes", async () => {
		const folders = { audit: path.join(migrations, "audit") };
		const store = new HubStore({
			filename: f.filename,
			nativeBinding,
			masterKey: f.key,
			migrations: folders,
		});
		try {
			const dir = path.join(f.dir, "sql");
			writeFileSync(path.join(dir, "0002_unregistered.sql"), "DROP TRIGGER audit_no_delete;");
			folders.audit = dir;
			await expect(store.migrate("audit")).resolves.toEqual([]);
			expect(
				store.read((db) => db.get("SELECT name FROM sqlite_schema WHERE name='audit_no_delete'")),
			).toEqual({ name: "audit_no_delete" });
		} finally {
			store.close();
		}
	});
	it("runs migration files atomically, including complete trigger bodies", async () => {
		const dir = path.join(f.dir, "sql");
		writeFileSync(
			path.join(dir, "0001_rows.sql"),
			"CREATE TABLE demo(x); CREATE TABLE log(x); CREATE TRIGGER t AFTER INSERT ON demo BEGIN INSERT INTO log VALUES(new.x); END;",
		);
		writeFileSync(path.join(dir, "0002_broken.sql"), "INSERT INTO missing VALUES(1);");
		await expect(f.store.migrate("demo")).rejects.toThrow();
		expect(
			f.store.read((db) => db.get("SELECT name FROM sqlite_master WHERE name='demo'")),
		).toBeUndefined();
		writeFileSync(path.join(dir, "0002_broken.sql"), "INSERT INTO demo VALUES(42);");
		await f.store.migrate("demo");
		expect(f.store.read((db) => db.get<{ x: number }>("SELECT x FROM log"))?.x).toBe(42);
		expect(await f.store.migrate("demo")).toEqual([]);
	});
	it("rejects a newer schema and migration transaction escapes", async () => {
		const dir = path.join(f.dir, "sql");
		writeFileSync(path.join(dir, "0001_escape.sql"), "/* comment */ COMMIT;");
		await expect(f.store.migrate("unsafe")).rejects.toThrow("can't run COMMIT");
		f.store.write((tx) =>
			tx.run(
				"INSERT INTO _migrations_fixture(name,timestamp) VALUES('9999_future','2026-10-17T00:00:00.000Z')",
			),
		);
		await expect(f.store.migrate("fixture")).rejects.toThrow();
	});
});
