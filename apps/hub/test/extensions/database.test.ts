import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModuleDatabase, ModuleTables } from "@draftyak/extensions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_CELL_BYTES,
	MAX_COLUMNS,
	MAX_PAGE_ROWS,
	MAX_RESULT_BYTES,
	MAX_ROW_BYTES,
	MAX_TABLES,
} from "../../src/extensions/database.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import {
	type Fixture,
	fixture,
	nativeBinding,
	refused,
	refusedNow,
	registry,
	resetTrace,
	trace,
} from "./helpers.ts";

let f: Fixture;
const direct: SqliteDatabase[] = [];
beforeEach(() => {
	resetTrace();
	f = fixture();
});
afterEach(() => {
	for (const db of direct.splice(0)) db.close();
	f.remove();
});

const table = (id: string): string =>
	`CREATE TABLE ext_${id}_rows(id TEXT PRIMARY KEY, body TEXT, data BLOB, n INTEGER, total INTEGER GENERATED ALWAYS AS (n * 2) VIRTUAL) STRICT;`;
const open = (file: string, purpose: "db" | `ext/${string}`): SqliteDatabase => {
	const db = openEncrypted({ filename: path.join(f.dir, file), nativeBinding }, f.key, purpose);
	direct.push(db);
	return db;
};
const names = (db: SqliteDatabase): string[] =>
	(
		db
			.prepare("SELECT name FROM main.sqlite_schema WHERE name GLOB 'ext_*' ORDER BY name")
			.all() as {
			name: string;
		}[]
	).map(({ name }) => name);
async function started(...ids: string[]): Promise<ModuleDatabase> {
	f.config(ids.map((id) => f.module(id, "", { migrations: { "0001_rows.sql": table(id) } })));
	await f.start();
	return registry(ids[0] ?? "alpha").db();
}
const rows = (db: ModuleDatabase, limit = MAX_PAGE_ROWS) =>
	db.select("ext_alpha_rows", { limit }).map((row) => ({ ...row }));

describe("module files", () => {
	it("gives each module its own encrypted file, keyed for that module only", async () => {
		const core = openEncrypted(
			{ filename: path.join(f.dir, "draftyak.db"), nativeBinding, create: true },
			f.key,
			"db",
		);
		core.exec(
			"CREATE TABLE core_rows(id TEXT); INSERT INTO core_rows VALUES ('DYTEST-CORE-CANARY');",
		);
		core.close();
		const alpha = await started("alpha", "beta");
		alpha.insert("ext_alpha_rows", { id: "a", body: "DYTEST-ALPHA-CANARY" });
		registry("beta").db().insert("ext_beta_rows", { id: "b", body: "DYTEST-BETA-CANARY" });
		for (const host of f.hosts.splice(0)) host.close();
		for (const name of readdirSync(f.dir).filter((name) => name.startsWith("ext-"))) {
			const bytes = readFileSync(path.join(f.dir, name));
			expect(bytes.subarray(0, 16).toString("latin1")).not.toBe("SQLite format 3\0");
			for (const canary of ["DYTEST-ALPHA-CANARY", "DYTEST-BETA-CANARY", "DYTEST-CORE-CANARY"])
				expect(bytes.includes(Buffer.from(canary))).toBe(false);
		}
		expect(() => open("ext-alpha.db", "ext/beta")).toThrow();
		expect(() => open("ext-alpha.db", "db")).toThrow();
		expect(() => open("draftyak.db", "ext/alpha")).toThrow();
		const own = open("ext-alpha.db", "ext/alpha");
		expect(names(own)).toEqual(["ext_alpha_rows"]);
		expect(own.prepare("SELECT body FROM ext_alpha_rows").all()).toEqual([
			{ body: "DYTEST-ALPHA-CANARY" },
		]);
		expect(names(open("ext-beta.db", "ext/beta"))).toEqual(["ext_beta_rows"]);
	});

	it("refuses a module file keyed for another module or for core, and an uninitialized file", async () => {
		await started("alpha");
		for (const host of f.hosts.splice(0)) host.close();
		resetTrace();
		copyFileSync(path.join(f.dir, "ext-alpha.db"), path.join(f.dir, "ext-beta.db"));
		f.config([f.module("beta")]);
		await refused("database", f.start());
		openEncrypted(
			{ filename: path.join(f.dir, "ext-gamma.db"), nativeBinding, create: true },
			f.key,
			"db",
		).close();
		f.config([f.module("gamma")]);
		await refused("database", f.start());
		writeFileSync(path.join(f.dir, "ext-delta.db"), "");
		f.config([f.module("delta")]);
		await refused("database", f.start());
		expect(trace()).toEqual([]);
	});

	it("keeps a module inside its own tables", async () => {
		const alpha = await started("alpha", "beta");
		for (const name of [
			"ext_beta_rows",
			"_migrations_ext",
			"sqlite_schema",
			"ext_alpha_missing",
			'ext_alpha_rows"; DROP TABLE ext_alpha_rows; --',
			"EXT_ALPHA_ROWS",
		])
			refusedNow("database", () => alpha.select(name as never, { limit: 1 }));
		refusedNow("database", () => alpha.insert("ext_alpha_rows", { id: "a", rowid: 7 }));
		refusedNow("database", () => alpha.insert("ext_alpha_rows", { 'id") VALUES (1); --': "a" }));
		refusedNow("database", () =>
			alpha.select("ext_alpha_rows", { limit: 1, equals: { missing: "a" } }),
		);
		refusedNow("database", () => alpha.insert("ext_alpha_rows", { id: "a", total: 1 }));
		alpha.insert("ext_alpha_rows", { id: "a", n: 21 });
		expect(rows(alpha)).toEqual([{ id: "a", body: null, data: null, n: 21, total: 42 }]);
		expect(registry("beta").db().select("ext_beta_rows", { limit: 1 })).toEqual([]);
	});
});

describe("pinned migrations", () => {
	const schema = (): string[] => names(open("ext-alpha.db", "ext/alpha"));
	const applied = (): number =>
		(
			open("ext-alpha.db", "ext/alpha")
				.prepare("SELECT count(*) AS n FROM _migrations_ext")
				.get() as { n: number }
		).n;

	it.each([
		[
			"a table outside the module namespace",
			"CREATE TABLE ext_alpha_rows(id TEXT); CREATE TABLE other_rows(id TEXT);",
		],
		["another module's table", "CREATE TABLE ext_beta_rows(id TEXT);"],
		["a table named only by the prefix", "CREATE TABLE ext_alpha_(id TEXT);"],
		[
			"a view",
			"CREATE TABLE ext_alpha_rows(id TEXT); CREATE VIEW ext_alpha_ids AS SELECT id FROM ext_alpha_rows;",
		],
		["a virtual table", "CREATE VIRTUAL TABLE ext_alpha_search USING fts5(body);"],
		["a temporary table", "CREATE TEMP TABLE ext_alpha_scratch(id TEXT);"],
		[
			"an index with a foreign name",
			"CREATE TABLE ext_alpha_rows(id TEXT); CREATE INDEX rows_by_id ON ext_alpha_rows(id);",
		],
		["an index on migration metadata", "CREATE INDEX ext_alpha_names ON _migrations_ext(name);"],
		[
			"a trigger on migration metadata",
			"CREATE TABLE ext_alpha_rows(id TEXT); CREATE TRIGGER ext_alpha_t AFTER INSERT ON _migrations_ext BEGIN DELETE FROM ext_alpha_rows; END;",
		],
		["a column outside the grammar", 'CREATE TABLE ext_alpha_rows("Id" TEXT);'],
		[
			"a foreign key violation",
			"CREATE TABLE ext_alpha_parent(id TEXT PRIMARY KEY); CREATE TABLE ext_alpha_child(parent TEXT REFERENCES ext_alpha_parent(id)); INSERT INTO ext_alpha_child VALUES ('missing');",
		],
		[
			"failing SQL",
			"CREATE TABLE ext_alpha_rows(id TEXT); INSERT INTO ext_alpha_missing VALUES (1);",
		],
	])("refuses %s and applies nothing", async (_, sql) => {
		f.config([
			f.module("alpha", "", {
				migrations: {
					"0001_rows.sql": "CREATE TABLE ext_alpha_first(id TEXT);",
					"0002_more.sql": sql,
				},
			}),
		]);
		await refused("database", f.start());
		expect(trace()).toEqual([]);
		expect(schema()).toEqual([]);
		expect(applied()).toBe(0);
	});

	it("accepts the table and column bounds and refuses one more of either", async () => {
		const tables = (id: string, count: number): string =>
			Array.from(
				{ length: count },
				(_, index) => `CREATE TABLE ext_${id}_t${index}(id TEXT);`,
			).join("\n");
		const wide = (id: string, count: number): string =>
			`CREATE TABLE ext_${id}_wide(${Array.from({ length: count }, (_, index) => `c${index} TEXT`).join(", ")});`;
		const start = (id: string, sql: string) => {
			f.config([f.module(id, "", { migrations: { "0001_bound.sql": sql } })]);
			return f.start();
		};
		(await start("alpha", tables("alpha", MAX_TABLES))).close();
		(await start("beta", wide("beta", MAX_COLUMNS))).close();
		await refused("database", start("gamma", tables("gamma", MAX_TABLES + 1)));
		await refused("database", start("delta", wide("delta", MAX_COLUMNS + 1)));
		expect(names(open("ext-gamma.db", "ext/gamma"))).toEqual([]);
		expect(names(open("ext-delta.db", "ext/delta"))).toEqual([]);
	});

	it("applies new pinned migrations on a later start and refuses a schema newer than the config", async () => {
		const first = { "0001_rows.sql": table("alpha") };
		f.config([f.module("alpha", "", { migrations: first })]);
		await f.start();
		registry("alpha").db().insert("ext_alpha_rows", { id: "a", n: 1 });
		for (const host of f.hosts.splice(0)) host.close();
		const second = {
			...first,
			"0002_flag.sql": "ALTER TABLE ext_alpha_rows ADD COLUMN flag INTEGER;",
		};
		f.config([f.module("alpha", "", { migrations: second })]);
		await f.start();
		expect(rows(registry("alpha").db())).toEqual([
			{ id: "a", body: null, data: null, n: 1, total: 2, flag: null },
		]);
		for (const host of f.hosts.splice(0)) host.close();
		f.config([f.module("alpha", "", { migrations: first })]);
		await refused("database", f.start());
		expect(applied()).toBe(2);
	});

	it("keeps child rows when a later migration rebuilds their parent table", async () => {
		const first = {
			"0001_tree.sql": `CREATE TABLE ext_alpha_parent(id TEXT PRIMARY KEY, name TEXT) STRICT;
CREATE TABLE ext_alpha_child(id TEXT PRIMARY KEY, parent TEXT NOT NULL REFERENCES ext_alpha_parent(id) ON DELETE CASCADE) STRICT;
INSERT INTO ext_alpha_parent VALUES ('p', 'DYTEST-PARENT');
INSERT INTO ext_alpha_child VALUES ('c1', 'p'), ('c2', 'p');`,
		};
		f.config([f.module("alpha", "", { migrations: first })]);
		await f.start();
		for (const host of f.hosts.splice(0)) host.close();
		const second = {
			...first,
			"0002_rebuild.sql": `CREATE TABLE ext_alpha_parent_next(id TEXT PRIMARY KEY, name TEXT, note TEXT) STRICT;
INSERT INTO ext_alpha_parent_next(id, name) SELECT id, name FROM ext_alpha_parent;
DROP TABLE ext_alpha_parent;
ALTER TABLE ext_alpha_parent_next RENAME TO ext_alpha_parent;`,
		};
		f.config([f.module("alpha", "", { migrations: second })]);
		await f.start();
		const alpha = registry("alpha").db();
		const children = () => alpha.select("ext_alpha_child", { limit: 10 }).map(({ id }) => id);
		expect(children()).toEqual(["c1", "c2"]);
		expect(alpha.select("ext_alpha_parent", { limit: 10 }).map((row) => ({ ...row }))).toEqual([
			{ id: "p", name: "DYTEST-PARENT", note: null },
		]);
		refusedNow("database", () => alpha.insert("ext_alpha_child", { id: "c3", parent: "missing" }));
		expect(alpha.delete("ext_alpha_parent", { id: "p" })).toBe(1);
		expect(children()).toEqual([]);
	});
});

describe("structured access", () => {
	it("copies values in and out and freezes what it returns", async () => {
		const alpha = await started("alpha");
		const data = new Uint8Array([1, 2, 3]);
		expect(alpha.insert("ext_alpha_rows", { id: "a", data, n: 2n ** 60n })).toBe(1);
		data[0] = 9;
		const [row] = alpha.select("ext_alpha_rows", { limit: 1, equals: { id: "a" } });
		expect(row?.data).toEqual(new Uint8Array([1, 2, 3]));
		expect(row?.n).toBe(2n ** 60n);
		expect(Object.isFrozen(row)).toBe(true);
		expect(Object.getPrototypeOf(row)).toBeNull();
		(row?.data as Uint8Array)[1] = 9;
		expect(alpha.select("ext_alpha_rows", { limit: 1 })[0]?.data).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(Object.isFrozen(alpha.select("ext_alpha_rows", { limit: 1 }))).toBe(true);
	});

	it.each([
		["a boolean", { id: "a", n: true }],
		["an object value", { id: "a", body: { text: "x" } }],
		["a non-finite number", { id: "a", n: Number.NaN }],
		["an integer outside 64 bits", { id: "a", n: 2n ** 63n }],
		["a lone surrogate", { id: "a", body: "\ud800" }],
		["an oversized string", { id: "a", body: "x".repeat(MAX_CELL_BYTES + 1) }],
		["an oversized blob", { id: "a", data: new Uint8Array(MAX_CELL_BYTES + 1) }],
		["an empty row", {}],
		["an array", ["a"]],
		["a proxied row", new Proxy({ id: "a" }, {})],
		[
			"an accessor",
			Object.defineProperty({ id: "a" }, "body", { get: () => "x", enumerable: true }),
		],
		["a symbol key", { id: "a", [Symbol("x")]: "x" }],
	])("refuses %s", async (_, row) => {
		const alpha = await started("alpha");
		refusedNow("database", () => alpha.insert("ext_alpha_rows", row as never));
		expect(rows(alpha)).toEqual([]);
	});

	it("bounds a text cell by its UTF-8 bytes", async () => {
		const alpha = await started("alpha");
		const fill = "€".repeat(Math.floor(MAX_CELL_BYTES / 3));
		const exact = `${fill}${"x".repeat(MAX_CELL_BYTES - Buffer.byteLength(fill))}`;
		expect(Buffer.byteLength(exact)).toBe(MAX_CELL_BYTES);
		expect(alpha.insert("ext_alpha_rows", { id: "a", body: exact })).toBe(1);
		refusedNow("database", () =>
			alpha.insert("ext_alpha_rows", { id: "b", body: `${exact.slice(0, -1)}€` }),
		);
		expect(rows(alpha).map(({ id }) => id)).toEqual(["a"]);
	});

	it("refuses a row or a filter over the row bound", async () => {
		const columns = ["a", "b", "c", "d", "e"];
		const sql = `CREATE TABLE ext_alpha_wide(${columns.map((name) => `${name} BLOB`).join(", ")}) STRICT;`;
		f.config([f.module("alpha", "", { migrations: { "0001_wide.sql": sql } })]);
		await f.start();
		const alpha = registry("alpha").db();
		const cell = new Uint8Array(MAX_CELL_BYTES);
		const wide = Object.fromEntries(columns.map((name) => [name, cell]));
		refusedNow("database", () => alpha.insert("ext_alpha_wide", wide));
		expect(alpha.insert("ext_alpha_wide", { a: cell, b: cell, c: cell })).toBe(1);
		refusedNow("database", () => alpha.select("ext_alpha_wide", { limit: 1, equals: wide }));
		refusedNow("database", () => alpha.update("ext_alpha_wide", { a: null }, wide));
		refusedNow("database", () => alpha.delete("ext_alpha_wide", wide));
		expect(alpha.select("ext_alpha_wide", { limit: 2 })).toHaveLength(1);
	});

	it("refuses an update that would grow a stored row over the row bound", async () => {
		const columns = ["a", "b", "c", "d", "e"];
		const sql = `CREATE TABLE ext_alpha_wide(id TEXT PRIMARY KEY, ${columns.map((name) => `${name} BLOB`).join(", ")}) STRICT;`;
		f.config([f.module("alpha", "", { migrations: { "0001_wide.sql": sql } })]);
		await f.start();
		const alpha = registry("alpha").db();
		const cell = new Uint8Array(MAX_CELL_BYTES);
		const stored = () => alpha.select("ext_alpha_wide", { limit: 1, equals: { id: "w" } });
		expect(alpha.insert("ext_alpha_wide", { id: "w", a: cell, b: cell, c: cell })).toBe(1);
		const fits = new Uint8Array(MAX_ROW_BYTES - 3 * MAX_CELL_BYTES - 1);
		expect(alpha.update("ext_alpha_wide", { d: fits }, { id: "w" })).toBe(1);
		expect(stored()[0]?.d).toEqual(fits);
		// Each update's own values are within their bounds; the row it would leave is not.
		refusedNow("database", () => alpha.update("ext_alpha_wide", { e: cell }, { id: "w" }));
		refusedNow("database", () =>
			alpha.update("ext_alpha_wide", { d: new Uint8Array(fits.length + 1) }, { id: "w" }),
		);
		const [row] = stored();
		expect([row?.d, row?.e]).toEqual([fits, null]);
	});

	it("refuses an insert whose generated column takes the stored row over the row bound", async () => {
		const sql =
			"CREATE TABLE ext_alpha_echo(id TEXT PRIMARY KEY, body TEXT, echo TEXT GENERATED ALWAYS AS (body || body || body || body) STORED) STRICT;";
		f.config([f.module("alpha", "", { migrations: { "0001_echo.sql": sql } })]);
		await f.start();
		const alpha = registry("alpha").db();
		refusedNow("database", () =>
			alpha.insert("ext_alpha_echo", { id: "e", body: "x".repeat(MAX_CELL_BYTES) }),
		);
		expect(alpha.insert("ext_alpha_echo", { id: "f", body: "x".repeat(1024) })).toBe(1);
		expect(alpha.select("ext_alpha_echo", { limit: 2 }).map(({ id }) => id)).toEqual(["f"]);
	});

	it("refuses a page holding a stored row over the row bound below the result bound", async () => {
		f.config([
			f.module("alpha", "", {
				migrations: {
					"0001_rows.sql": table("alpha"),
					"0002_seed.sql": `INSERT INTO ext_alpha_rows(id, data) VALUES ('big', zeroblob(${MAX_ROW_BYTES})), ('small', x'01');`,
				},
			}),
		]);
		await f.start();
		const alpha = registry("alpha").db();
		refusedNow("database", () => alpha.select("ext_alpha_rows", { limit: 2 }));
		refusedNow("database", () =>
			alpha.select("ext_alpha_rows", { limit: 1, equals: { id: "big" } }),
		);
		expect(
			alpha.select("ext_alpha_rows", { limit: 1, equals: { id: "small" } }).map(({ id }) => id),
		).toEqual(["small"]);
	});

	it("bounds selections by page size and result bytes", async () => {
		const alpha = await started("alpha");
		for (const limit of [0, MAX_PAGE_ROWS + 1, 1.5, "10", undefined])
			refusedNow("database", () => alpha.select("ext_alpha_rows", { limit } as never));
		refusedNow("database", () =>
			alpha.select("ext_alpha_rows", { limit: 1, order: "id" } as never),
		);
		const body = "x".repeat(MAX_CELL_BYTES - 16);
		const count = Math.ceil(MAX_RESULT_BYTES / body.length) + 1;
		for (let index = 0; index < count; index++)
			alpha.insert("ext_alpha_rows", { id: `r${index}`, body });
		refusedNow("database", () => alpha.select("ext_alpha_rows", { limit: MAX_PAGE_ROWS }));
		expect(alpha.select("ext_alpha_rows", { limit: 4 })).toHaveLength(4);
	});

	it("bounds updates and deletes to a filter and a hundred rows, rolling back past that", async () => {
		const alpha = await started("alpha");
		for (let index = 0; index <= 100; index++)
			alpha.insert("ext_alpha_rows", { id: `r${index}`, n: 1 });
		refusedNow("database", () => alpha.update("ext_alpha_rows", { n: 2 }, {}));
		refusedNow("database", () => alpha.update("ext_alpha_rows", { n: 2 }, { n: 1 }));
		refusedNow("database", () => alpha.delete("ext_alpha_rows", { n: 1 }));
		expect(alpha.select("ext_alpha_rows", { limit: 100, equals: { n: 1 } })).toHaveLength(100);
		expect(alpha.select("ext_alpha_rows", { limit: 1, equals: { n: 2 } })).toEqual([]);
		expect(alpha.delete("ext_alpha_rows", { id: "r100" })).toBe(1);
		expect(alpha.update("ext_alpha_rows", { n: 2 }, { n: 1 })).toBe(100);
		expect(alpha.delete("ext_alpha_rows", { n: 2 })).toBe(100);
	});
});

describe("transactions", () => {
	it("commits synchronous work and rolls back a throw, returning the module's own error", async () => {
		const alpha = await started("alpha");
		expect(
			alpha.transaction((tables) => {
				tables.insert("ext_alpha_rows", { id: "a" });
				return tables.select("ext_alpha_rows", { limit: 5 }).length;
			}),
		).toBe(1);
		const failure = new Error("module failure");
		expect(() =>
			alpha.transaction((tables) => {
				tables.insert("ext_alpha_rows", { id: "b" });
				throw failure;
			}),
		).toThrow(failure);
		expect(rows(alpha).map(({ id }) => id)).toEqual(["a"]);
	});

	it.each([
		[
			"an async function",
			async (tables: ModuleTables<string>) => tables.insert("ext_alpha_rows", { id: "b" }),
		],
		[
			"a function returning a promise",
			(tables: ModuleTables<string>) => {
				tables.insert("ext_alpha_rows", { id: "b" });
				return Promise.resolve(1);
			},
		],
		[
			"a function returning a thenable",
			(tables: ModuleTables<string>) => {
				tables.insert("ext_alpha_rows", { id: "b" });
				// biome-ignore lint/suspicious/noThenProperty: deliberate thenable-refusal fixture.
				return { then: () => undefined };
			},
		],
		["a value that is not a function", "work"],
		["a proxied function", new Proxy(() => undefined, {})],
	])("refuses %s and keeps nothing", async (_, work) => {
		const alpha = await started("alpha");
		refusedNow("database", () => alpha.transaction(work as never));
		expect(rows(alpha)).toEqual([]);
	});

	it("refuses an accessor or proxy result without running its hooks", async () => {
		const alpha = await started("alpha");
		const hooks: string[] = [];
		// biome-ignore lint/suspicious/noThenProperty: deliberate accessor-refusal fixture.
		const accessor = Object.defineProperty({}, "then", {
			get: () => {
				hooks.push("then");
				return undefined;
			},
		});
		const proxy = new Proxy(
			{},
			{
				get: (_, key) => {
					hooks.push(String(key));
					return undefined;
				},
			},
		);
		for (const result of [accessor, proxy])
			refusedNow("database", () =>
				alpha.transaction((tables) => {
					tables.insert("ext_alpha_rows", { id: "b" });
					return result as never;
				}),
			);
		expect(hooks).toEqual([]);
		expect(rows(alpha)).toEqual([]);
	});

	it("refuses nested and re-entrant use and every escaped handle", async () => {
		const alpha = await started("alpha");
		let escaped: ModuleTables<string> | undefined;
		alpha.transaction((tables) => {
			escaped = tables;
			refusedNow("database", () => alpha.transaction(() => 1));
			refusedNow("database", () => alpha.insert("ext_alpha_rows", { id: "outside" }));
			tables.insert("ext_alpha_rows", { id: "inside" });
		});
		refusedNow("database", () => escaped?.insert("ext_alpha_rows", { id: "late" }));
		refusedNow("database", () => escaped?.select("ext_alpha_rows", { limit: 1 }));
		expect(rows(alpha).map(({ id }) => id)).toEqual(["inside"]);
		expect(Object.isFrozen(alpha)).toBe(true);
		expect(Object.getPrototypeOf(alpha)).toBeNull();
	});
});
