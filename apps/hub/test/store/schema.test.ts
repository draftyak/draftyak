import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { DEVICE_MIGRATIONS } from "../../src/identity/devices.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES } from "../../src/kernel/namespaces.ts";
import { openNativeStorage } from "../../src/native-storage.ts";
import { captureMigrationPlan, migrate } from "../../src/store/migrator.ts";
import { openEncrypted, releaseFailedOpen, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore } from "../../src/store/store.ts";
import {
	configureModule,
	expectErased,
	sessionFixture,
	refusal as sessionRefusal,
} from "../lifecycle/session-helpers.ts";
import { migrations as delivered, nativeBinding } from "./helpers.ts";

const REFUSED = "Database schema is not recognized";
const CLEANUP = "Database initialization cleanup unavailable";
const require = createRequire(import.meta.url);
const addon = require(nativeBinding) as { Database: { prototype: { close(): unknown } } };
const nativeClose = addon.Database.prototype.close;

const ITEMS =
	"CREATE TABLE items(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, size INTEGER NOT NULL) STRICT;\nCREATE INDEX items_kind ON items(kind);\n";
const LABELS = "CREATE TABLE labels(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE) STRICT;\n";
const SEARCH = `CREATE TABLE messages (
  seq INTEGER PRIMARY KEY,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE VIRTUAL TABLE messages_fts USING fts5 (
  subject, body, content = 'messages', content_rowid = 'seq', tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO messages_fts (messages_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, subject, body) VALUES (new.seq, new.subject, new.body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, subject, body) VALUES ('delete', old.seq, old.subject, old.body);
END;
CREATE VIRTUAL TABLE notes USING fts5 (body);
CREATE TABLE counters (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE) STRICT;
`;

let dir: string, filename: string, key: MasterKey;
const stores: HubStore[] = [];
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-schema-"));
	filename = path.join(dir, "draftyak.db");
	const bytes = randomBytes(32);
	key = new MasterKey(bytes);
	bytes.fill(0);
});
afterEach(() => {
	vi.restoreAllMocks();
	closeAll();
	key.destroy();
	rmSync(dir, { recursive: true, force: true });
});

function closeAll(): void {
	for (const store of stores.splice(0)) store.close();
}
/** A trusted migration folder holding exactly these files. */
function folder(name: string, files: Readonly<Record<string, string>>): string {
	const target = path.join(dir, name);
	mkdirSync(target, { recursive: true });
	for (const [file, sql] of Object.entries(files)) writeFileSync(path.join(target, file), sql);
	return target;
}
function open(migrations: Readonly<Record<string, string>> = {}, create = false): HubStore {
	const store = new HubStore({ filename, nativeBinding, masterKey: key, create, migrations });
	stores.push(store);
	return store;
}
async function created(migrations: Readonly<Record<string, string>>): Promise<void> {
	const store = open(migrations, true);
	for (const namespace of Object.keys(migrations)) await store.migrate(namespace);
	closeAll();
}
/** Another holder of the database key, working on the closed file directly. */
function raw<T>(work: (db: SqliteDatabase) => T, unsafe = false): T {
	const db = openEncrypted({ filename, nativeBinding }, key);
	try {
		if (unsafe) db.unsafeMode(true);
		return work(db);
	} finally {
		db.close();
	}
}
const edit = (sql: string, unsafe = false): void =>
	raw((db) => {
		db.exec(sql);
	}, unsafe);
const snapshot = (): unknown =>
	raw((db) => ({
		objects: db.prepare("SELECT type, name, tbl_name, sql FROM main.sqlite_schema").all(),
		applied: db.prepare("SELECT name FROM main._migrations_audit").pluck().all(),
	}));
const names = (like: string): unknown[] =>
	raw((db) =>
		db.prepare("SELECT name FROM main.sqlite_schema WHERE name GLOB ?").pluck().all(like),
	);
const refusal = (work: () => unknown): Error => {
	try {
		work();
	} catch (error) {
		return error as Error;
	}
	throw new Error("Expected a refusal");
};

describe("accepted schema", () => {
	it("reopens an applied prefix, upgrades it and reopens the result", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const store = open({ app }, true);
		await expect(store.migrate("app")).resolves.toEqual(["0001_items"]);
		store.write((tx) => tx.run("INSERT INTO items(kind, size) VALUES ('a', 1)"));
		closeAll();
		writeFileSync(path.join(app, "0002_labels.sql"), LABELS);
		const older = open({ app });
		expect(older.read((db) => db.get("SELECT count(*) AS n FROM items"))).toEqual({ n: 1 });
		await expect(older.migrate("app")).resolves.toEqual(["0002_labels"]);
		older.write((tx) => tx.run("INSERT INTO labels(label) VALUES ('x')"));
		closeAll();
		const current = open({ app });
		await expect(current.migrate("app")).resolves.toEqual([]);
		expect(current.read((db) => db.get("SELECT count(*) AS n FROM labels"))).toEqual({ n: 1 });
	});

	it("reopens the bookkeeping a failed first migration leaves without new genesis authority", async () => {
		const audit = folder("audit", {
			"0001_chain.sql": readFileSync(path.join(delivered, "audit/0001_chain.sql"), "utf8"),
			"0002_failure.sql": "INSERT INTO missing_table VALUES(1);",
		});
		await expect(open({ audit }, true).migrate("audit")).rejects.toThrow("missing_table");
		closeAll();
		unlinkSync(path.join(audit, "0002_failure.sql"));
		const reopened = open({ audit });
		await expect(reopened.migrate("audit")).rejects.toThrow(
			"Audit storage is missing or incomplete",
		);
		expect(names("audit_*")).toEqual([]);
	});

	it("reopens a ledger table that a crash left without its lock table", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		open({ app }, true);
		closeAll();
		edit(
			'CREATE TABLE "_migrations_app" ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null)',
		);
		await expect(open({ app }).migrate("app")).resolves.toEqual(["0001_items"]);
	});

	it("reopens exact FTS5, trigger, implicit index and AUTOINCREMENT objects", async () => {
		const search = folder("search", { "0001_search.sql": SEARCH });
		const store = open({ search }, true);
		await store.migrate("search");
		store.write((tx) => {
			tx.run("INSERT INTO messages(subject, body) VALUES ('weekly', 'quick brown fox')");
			tx.run("INSERT INTO notes(body) VALUES ('lazy dog')");
			tx.run("INSERT INTO counters(label) VALUES ('first')");
		});
		closeAll();
		const reopened = open({ search });
		expect(
			reopened.read((db) =>
				db.all("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'fox'"),
			),
		).toEqual([{ rowid: 1 }]);
		expect(reopened.read((db) => db.get("SELECT seq FROM sqlite_sequence"))).toEqual({ seq: 1 });
	});

	it("accepts an unchanged schema without vouching for changed rows", async () => {
		const auditKey = key.derive("audit");
		const audit = new AuditChain(auditKey);
		auditKey.fill(0);
		try {
			const store = open({ audit: path.join(delivered, "audit") }, true);
			await store.migrate("audit");
			store.write((tx) =>
				audit.append(tx, {
					id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
					at: 1,
					action: "hub.init",
					actor: { kind: "hub", id: null },
					refs: {},
				}),
			);
			closeAll();
			raw((db) => {
				const trigger = db
					.prepare("SELECT sql FROM main.sqlite_schema WHERE name = 'audit_no_update'")
					.pluck()
					.get() as string;
				db.exec(`DROP TRIGGER audit_no_update; UPDATE audit_events SET at = 2; ${trigger};`);
			});
			const reopened = open({ audit: path.join(delivered, "audit") });
			expect(() => reopened.read((db) => audit.verify(db))).toThrow("verification failed");
		} finally {
			audit.destroy();
		}
	});
});

describe("refused schema", () => {
	it.each([
		["an extra index", "CREATE INDEX items_size ON items(size);"],
		[
			"an approved index name over other columns",
			"DROP INDEX items_kind; CREATE INDEX items_kind ON items(size);",
		],
		["a missing index", "DROP INDEX items_kind;"],
		["an altered table", "ALTER TABLE items ADD COLUMN note TEXT;"],
		["an extra trigger", "CREATE TRIGGER items_extra AFTER INSERT ON items BEGIN SELECT 1; END;"],
		["an extra view", "CREATE VIEW items_view AS SELECT id FROM items;"],
		["planner statistics", "INSERT INTO items(kind, size) VALUES ('a', 1); ANALYZE;"],
	])("refuses %s before returning a store", async (_, sql) => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		await created({ app });
		edit(sql);
		const error = refusal(() => open({ app }));
		expect(error.message).toBe(REFUSED);
		expect(error.cause).toBeUndefined();
	});

	it.each([
		[
			"a shadow-named table the external-content index lacks",
			"CREATE TABLE messages_fts_content(id INTEGER PRIMARY KEY, c0, c1);",
		],
		["another FTS5 index", "CREATE VIRTUAL TABLE messages_more USING fts5(body);"],
	])("refuses %s beside valid FTS5 objects", async (_, sql) => {
		const search = folder("search", { "0001_search.sql": SEARCH });
		await created({ search });
		edit(sql, true);
		expect(() => open({ search })).toThrow(REFUSED);
	});

	it("refuses an index whose entries disagree with its approved definition", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const store = open({ app }, true);
		await store.migrate("app");
		store.write((tx) => {
			for (let n = 0; n < 8; n++)
				tx.run("INSERT INTO items(kind, size) VALUES (?, ?)", [`k${n % 2}`, n]);
		});
		closeAll();
		const stored = (): unknown =>
			raw((db) =>
				db.prepare("SELECT sql FROM main.sqlite_schema WHERE name = 'items_kind'").pluck().get(),
			);
		const approved = stored();
		raw((db) => {
			db.exec("DROP INDEX items_kind; CREATE INDEX items_kind ON items(kind) WHERE size > 3;");
			db.exec("PRAGMA writable_schema = ON");
			db.prepare("UPDATE main.sqlite_schema SET sql = ? WHERE name = 'items_kind'").run(approved);
			db.exec("PRAGMA writable_schema = OFF");
		}, true);
		expect(stored()).toBe(approved);
		expect(() => open({ app })).toThrow(REFUSED);
	});

	it("refuses one extra index on native storage before any migration or read", async () => {
		const options = { filename, nativeBinding, masterKey: key };
		(await openNativeStorage({ ...options, create: true })).close();
		edit("CREATE INDEX jobs_extra ON jobs(kind);");
		const before = snapshot();
		const migrations = vi.spyOn(HubStore.prototype, "migrate");
		const reads = vi.spyOn(HubStore.prototype, "read");
		await expect(openNativeStorage(options)).rejects.toThrow(REFUSED);
		expect(migrations).not.toHaveBeenCalled();
		expect(reads).not.toHaveBeenCalled();
		expect(snapshot()).toEqual(before);
		vi.restoreAllMocks();
		edit("DROP INDEX jobs_extra;");
		(await openNativeStorage(options)).close();
	});
});

describe("migration ledger", () => {
	it("refuses an unknown applied name that leaves the same catalog", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		await created({ app });
		edit("UPDATE _migrations_app SET name = '0001_foreign';");
		expect(() => open({ app })).toThrow(REFUSED);
	});

	it.each([
		[
			"an unknown applied name",
			"INSERT INTO _migrations_app VALUES ('0002_unknown', '2026-10-30T00:00:00.000Z');",
		],
		[
			"an applied name after a gap",
			"INSERT INTO _migrations_app VALUES ('0003_later', '2026-10-30T00:00:00.000Z');",
		],
		["a missing applied name", "DELETE FROM _migrations_app;"],
		["a changed ledger table", "ALTER TABLE _migrations_app ADD COLUMN note TEXT;"],
		[
			"a trigger on the ledger",
			"CREATE TRIGGER app_ledger AFTER INSERT ON _migrations_app BEGIN SELECT 1; END;",
		],
	])("refuses %s", async (_, sql) => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		await created({ app });
		writeFileSync(path.join(app, "0002_labels.sql"), LABELS);
		writeFileSync(path.join(app, "0003_later.sql"), "CREATE TABLE later(x);");
		edit(sql);
		expect(() => open({ app })).toThrow(REFUSED);
	});

	it("refuses applied files the trusted folder no longer holds", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS, "0002_labels.sql": LABELS });
		await created({ app });
		unlinkSync(path.join(app, "0002_labels.sql"));
		expect(() => open({ app })).toThrow(REFUSED);
	});

	it("refuses a captured plan whose applied file now says something else", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		await created({ app });
		writeFileSync(path.join(app, "0001_items.sql"), `${ITEMS}CREATE TABLE added(x);\n`);
		expect(() => open({ app })).toThrow(REFUSED);
	});

	it("refuses a missing trusted folder with a fixed message", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		await created({ app });
		rmSync(app, { recursive: true });
		const error = refusal(() => open({ app }));
		expect(error.message).toBe(REFUSED);
		expect(String(error)).not.toContain(dir);
	});

	it.each([
		["applied files", { "0001_extra.sql": "CREATE TABLE extra(x);" }],
		["only bookkeeping", {}],
	])("needs the trusted folder of a namespace with %s", async (_, files) => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const extra = folder("extra", files);
		await created({ app, extra });
		expect(() => open({ app })).toThrow(REFUSED);
		expect(open({ app, extra }).read((db) => db.get("SELECT count(*) AS n FROM items"))).toEqual({
			n: 0,
		});
	});

	it("runs the SQL captured when migrate() is called, not later folder bytes", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const store = open({ app }, true);
		const pending = store.migrate("app");
		writeFileSync(path.join(app, "0001_items.sql"), "CREATE TABLE replaced(x);");
		await expect(pending).resolves.toEqual(["0001_items"]);
		expect(
			store.read((db) =>
				db.all("SELECT name FROM main.sqlite_schema WHERE name IN ('items', 'replaced')"),
			),
		).toEqual([{ name: "items" }]);
	});

	it("runs only plans the migrator captured", async () => {
		const db = openEncrypted({ filename, nativeBinding, create: true }, key);
		try {
			const lookalike = Object.freeze([
				Object.freeze({ name: "0001_items", sql: "CREATE TABLE fake(x)" }),
			]);
			await expect(migrate(db, "app", lookalike)).rejects.toThrow("not a captured migration plan");
			expect(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema").get()).toEqual({ n: 0 });
			const plan = captureMigrationPlan(folder("app", { "0001_items.sql": ITEMS }));
			await expect(migrate(db, "app", plan)).resolves.toEqual(["0001_items"]);
		} finally {
			db.close();
		}
	});
});

describe("compositions", () => {
	it("reopens native storage through its own, the session's and an empty registration", async () => {
		const options = { filename, nativeBinding, masterKey: key };
		(await openNativeStorage({ ...options, create: true })).close();
		(await openNativeStorage(options)).close();
		open({ ...HUB_NAMESPACES });
		closeAll();
		await expect(open().migrate("jobs")).rejects.toThrow("not registered");
	});

	it("reopens the device authority schema without registering it again", async () => {
		await created({
			audit: HUB_NAMESPACES.audit,
			core: HUB_NAMESPACES.core,
			devices: DEVICE_MIGRATIONS,
		});
		expect(open().read((db) => db.get("SELECT epoch FROM main.device_authority"))).toEqual({
			epoch: 0,
		});
	});

	it("refuses a session over an altered schema before migrating or loading modules", async () => {
		const f = sessionFixture("draftyak-schema-session-");
		const traces = globalThis as unknown as Record<symbol, string[] | undefined>;
		traces[Symbol.for("draftyak.test.extensions")] ??= [];
		const trace = traces[Symbol.for("draftyak.test.extensions")] as string[];
		const holder = (sql: string): void => {
			const db = openEncrypted({ filename: f.database, nativeBinding }, f.key());
			try {
				db.exec(sql);
			} finally {
				db.close();
			}
		};
		try {
			const options = { filename: f.database, nativeBinding, masterKey: f.key() };
			(await openNativeStorage({ ...options, create: true })).close();
			holder("CREATE INDEX jobs_extra ON jobs(kind);");
			configureModule(f, "schemaprobe");
			const migrations = vi.spyOn(HubStore.prototype, "migrate");
			const key = f.key();
			expect((await sessionRefusal(f.open({ masterKey: key }))).code).toBe("STORE_UNAVAILABLE");
			expectErased(key);
			expect(migrations).not.toHaveBeenCalled();
			expect(trace).not.toContain("schemaprobe:loaded");
			vi.restoreAllMocks();
			holder("DROP INDEX jobs_extra;");
			const session = await f.open();
			expect(session.extensions.modules).toEqual([{ id: "schemaprobe", version: "1.0.0" }]);
			session.store.read((db) => session.audit.verify(db));
			session.close();
		} finally {
			f.remove();
		}
	});
});

describe("migration checks", () => {
	it("refuses a migration once the open file differs from its accepted schema", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const store = open({ app }, true);
		await store.migrate("app");
		writeFileSync(path.join(app, "0002_labels.sql"), LABELS);
		edit("CREATE INDEX items_size ON items(size);");
		await expect(store.migrate("app")).rejects.toThrow(REFUSED);
		expect(() => store.read((db) => db.get("SELECT 1"))).toThrow("unavailable");
		expect(() => store.assertMasterKey(key)).toThrow("key unavailable");
		closeAll();
		expect(names("labels")).toEqual([]);
		expect(raw((db) => db.prepare("SELECT name FROM main._migrations_app").pluck().all())).toEqual([
			"0001_items",
		]);
	});

	it("refuses a migration whose folder changed an applied file", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const store = open({ app }, true);
		await store.migrate("app");
		writeFileSync(path.join(app, "0001_items.sql"), `${ITEMS}CREATE TABLE added(x);\n`);
		writeFileSync(path.join(app, "0002_labels.sql"), LABELS);
		await expect(store.migrate("app")).rejects.toThrow(REFUSED);
		closeAll();
		expect(names("labels")).toEqual([]);
	});

	it("refuses a migration result that differs from its captured plan", async () => {
		const app = folder("app", { "0001_items.sql": ITEMS });
		const store = open({ app }, true);
		const exec = Database.prototype.exec;
		vi.spyOn(Database.prototype, "exec").mockImplementation(function (
			this: Database.Database,
			sql: string,
		) {
			const result = exec.call(this, sql);
			if (sql === ITEMS && this.name === filename) exec.call(this, "CREATE TABLE unplanned(x)");
			return result;
		});
		await expect(store.migrate("app")).rejects.toThrow(REFUSED);
		vi.restoreAllMocks();
		expect(() => store.read((db) => db.get("SELECT 1"))).toThrow("unavailable");
	});
});

describe("refused connection cleanup", () => {
	async function refusedFile(): Promise<string> {
		const app = folder("app", { "0001_items.sql": ITEMS });
		await created({ app });
		edit("CREATE TABLE unplanned(x);");
		return app;
	}

	it("retains a refused connection whose close fails before effect and retries it first", async () => {
		const app = await refusedFile();
		let retained: object | undefined,
			blocked = true;
		const closes = { retained: 0, other: 0 };
		vi.spyOn(addon.Database.prototype, "close").mockImplementation(function (this: object) {
			retained ??= this;
			closes[this === retained ? "retained" : "other"]++;
			if (blocked && this === retained) throw new Error("native close before effect");
			return nativeClose.call(this);
		});
		expect(refusal(() => open({ app })).message).toBe(CLEANUP);
		expect(refusal(() => open({ app })).message).toBe(CLEANUP);
		expect(closes).toEqual({ retained: 2, other: 0 });
		blocked = false;
		edit("DROP TABLE unplanned;");
		expect(closes).toEqual({ retained: 3, other: 1 });
		await expect(open({ app }).migrate("app")).resolves.toEqual([]);
		expect(closes.retained).toBe(3);
	});

	it("proves an after-effect close without retrying it", async () => {
		const app = await refusedFile();
		let refused: object | undefined;
		let calls = 0;
		vi.spyOn(addon.Database.prototype, "close").mockImplementation(function (this: object) {
			refused ??= this;
			nativeClose.call(this);
			if (this === refused && calls++ === 0) throw new Error("native close after effect");
		});
		expect(refusal(() => open({ app })).message).toBe(REFUSED);
		vi.restoreAllMocks();
		edit("DROP TABLE unplanned;");
		expect(calls).toBe(1);
		await expect(open({ app }).migrate("app")).resolves.toEqual([]);
	});

	it("takes back only connections the opener issued", () => {
		const fake = { open: true, close: vi.fn() } as unknown as SqliteDatabase;
		expect(() => releaseFailedOpen(fake)).toThrow(CLEANUP);
		expect(fake.close).not.toHaveBeenCalled();
		openEncrypted({ filename, nativeBinding, create: true }, key).close();
	});
});
