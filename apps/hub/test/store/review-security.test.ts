import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuditEvent } from "@draftyak/protocol/entities/audit";
import { canonicalize } from "@draftyak/protocol/jcs";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { migrate } from "../../src/store/migrator.ts";
import { openEncrypted } from "../../src/store/open.ts";
import { HubStore } from "../../src/store/store.ts";
import { fixture, nativeBinding } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>, raw: Buffer, audit: AuditChain;
const event = (n: number, actor: AuditEvent["actor"] = { kind: "hub", id: null }): AuditEvent => ({
	id: String(n).padStart(26, "0"),
	at: n,
	action: "hub.init",
	actor,
	refs: {},
});
beforeEach(async () => {
	raw = randomBytes(32);
	f = await fixture(raw);
	const key = f.key.derive("audit");
	try {
		audit = new AuditChain(key);
	} finally {
		key.fill(0);
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	f.store.close();
	audit.destroy();
	f.key.destroy();
	raw.fill(0);
	rmSync(f.dir, { recursive: true, force: true });
});
const rawConnection = () => openEncrypted({ filename: f.filename, nativeBinding }, f.key);
const append = (n: number) => f.store.write((tx) => audit.append(tx, event(n)));

it("authenticates the head after a SQL-only truncation and rewind, including empty reset", () => {
	append(1);
	append(2);
	append(3);
	const attacker = rawConnection();
	try {
		attacker.exec(
			"DROP TRIGGER audit_no_delete; DELETE FROM audit_events WHERE seq=3; UPDATE audit_meta SET audit_seq=2,audit_head=(SELECT mac FROM audit_events WHERE seq=2)",
		);
		expect(() => f.store.read((db) => audit.verify(db))).toThrow("head verification");
		expect(() => f.store.read((db) => audit.exportVerifiedJsonl(db))).toThrow("export unavailable");
		expect(() => append(4)).toThrow("head verification");
		attacker.exec(
			"DELETE FROM audit_events; UPDATE audit_meta SET audit_seq=0,audit_head='',audit_tag=''",
		);
		expect(() => append(4)).toThrow("head verification");
	} finally {
		attacker.close();
	}
});

it.each([
	"SELECT sqlite3mc_config('hmac_check')",
	"SELECT sqlite3mc_config('hmac_check',0)",
	"SELECT sqlite3mc_config('sqlcipher','legacy',1)",
])("reserves each native configuration overload after open: %s", (sql) => {
	expect(() => f.store.read((db) => db.get(sql))).toThrow("reserved");
	expect(() => f.store.write((db) => db.all(sql))).toThrow("reserved");
	expect(() => f.store.write((db) => db.run(sql))).toThrow("reserved");
	append(1);
	f.store.read((db) => audit.verify(db));
});

it.each([
	["EXPLAIN PRAGMA temp_store=FILE", "EXPLAIN"],
	["EXPLAIN QUERY PLAN PRAGMA trusted_schema=ON", "EXPLAIN"],
	["EXPLAIN PRAGMA hexrekey='00'", "EXPLAIN"],
	["\ufeffPRAGMA temp_store=FILE", "PRAGMA"],
	["/* prefix */\ufeffEXPLAIN PRAGMA trusted_schema=ON", "EXPLAIN"],
])("refuses prepare-time configuration in migration files: %s", async (sql, keyword) => {
	writeFileSync(path.join(f.dir, "sql/0001_forbidden.sql"), sql);
	await expect(f.store.migrate("forbidden")).rejects.toThrow(`can't run ${keyword}`);
});

it("keeps both long-lived secrets out of unrelated pooled Buffer backing stores", () => {
	const secret = Buffer.alloc(32);
	for (let i = 0; i < 32; i++) secret[i] = i + 101;
	const preceding = Buffer.from("pool-control");
	const input = new Uint8Array(secret),
		key = new MasterKey(input),
		chain = new AuditChain(input);
	input.fill(0);
	try {
		const unrelated = Buffer.from("unrelated");
		expect(Buffer.from(preceding.buffer).includes(secret)).toBe(false);
		expect(Buffer.from(unrelated.buffer).includes(secret)).toBe(false);
		expect(Buffer.from(structuredClone(unrelated).buffer).includes(secret)).toBe(false);
	} finally {
		key.destroy();
		chain.destroy();
		secret.fill(0);
	}
});

it("pins the database HKDF vector and independently derives the audit purpose", () => {
	const key = new MasterKey(new Uint8Array(32).fill(0x0b));
	const db = key.derive("db"),
		auditKey = key.derive("audit");
	try {
		expect(db.toString("hex")).toBe(
			"7591d208acdbd734a4274a32f4d157fced5ee25d2f84dccdf69a32510077786e",
		);
		expect(auditKey.toString("hex")).toBe(
			"9d079e482f8c259f6724aa1e8acc99482a457375339fa729a03a9d972fe04d49",
		);
		expect(auditKey).toEqual(
			Buffer.from(
				hkdfSync(
					"sha256",
					new Uint8Array(32).fill(0x0b),
					new Uint8Array(0),
					"draftyak/v1/audit",
					32,
				),
			),
		);
	} finally {
		db.fill(0);
		auditKey.fill(0);
		key.destroy();
	}
});

it("uses native buffer keying and pins every reported open setting", () => {
	const db = rawConnection();
	try {
		const expected = {
			cipher: "chacha20",
			journal_mode: "wal",
			synchronous: 2,
			fullfsync: 1,
			checkpoint_fullfsync: 1,
			busy_timeout: 5000,
			foreign_keys: 1,
			recursive_triggers: 1,
			secure_delete: 1,
			trusted_schema: 0,
			temp_store: 2,
			auto_vacuum: 2,
		};
		for (const [name, value] of Object.entries(expected))
			expect(db.pragma(name, { simple: true })).toBe(value);
	} finally {
		db.close();
	}
	const wrong = new MasterKey(randomBytes(32));
	try {
		expect(() => openEncrypted({ filename: f.filename, nativeBinding }, wrong)).toThrowError(
			expect.objectContaining({ code: "SQLITE_NOTADB" }),
		);
	} finally {
		wrong.destroy();
	}
});

it("round-trips the shared actor union and typed refs in verified JSONL", () => {
	const actors: AuditEvent["actor"][] = [
		{ kind: "cli", id: null },
		{ kind: "hub", id: null },
		{ kind: "device", id: event(9).id },
	];
	const events = actors.map((actor, i) => ({
		...event(i + 1, actor),
		refs: { device: event(9).id },
	}));
	f.store.write((tx) =>
		events.forEach((value) => {
			audit.append(tx, value);
		}),
	);
	const rows = f.store
		.read((db) => audit.exportVerifiedJsonl(db))
		.jsonl.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	expect(
		rows.map((row) => {
			const { seq, previous, mac, ...value } = row;
			return AuditEvent.parse(value);
		}),
	).toEqual(events);
	for (const bad of [
		{ ...event(4), id: "Z".repeat(26) },
		{ ...event(4), action: "outbox.send-ticket" },
		{ ...event(4), action: "hub..init" },
	])
		expect(() => f.store.write((tx) => audit.append(tx, bad))).toThrow("metadata");
});

it("rejects a correctly MAC'd row spliced from a different chain under the same key", async () => {
	append(1);
	append(2);
	const fork = await fixture(raw),
		key = fork.key.derive("audit"),
		chain = new AuditChain(key);
	let attacker: Database.Database | undefined;
	try {
		fork.store.write((tx) => {
			chain.append(tx, event(11));
			chain.append(tx, event(12));
		});
		const row = fork.store.read((db) =>
			db.get<Record<string, string | number | null>>("SELECT * FROM audit_events WHERE seq=2"),
		);
		if (!row) throw Error("Missing native fork fixture");
		const tag = createHmac("sha256", key)
			.update("draftyak/audit-head/v1\n")
			.update(canonicalize({ seq: 2, mac: row.mac }))
			.digest("hex");
		attacker = rawConnection();
		attacker.exec("DROP TRIGGER audit_no_update");
		attacker
			.prepare(
				"UPDATE audit_events SET id=?,at=?,action=?,actor_kind=?,actor_id=?,refs=?,previous=?,mac=? WHERE seq=2",
			)
			.run(
				row.id,
				row.at,
				row.action,
				row.actor_kind,
				row.actor_id,
				row.refs,
				row.previous,
				row.mac,
			);
		attacker
			.prepare("UPDATE audit_meta SET audit_head=?,audit_tag=? WHERE singleton=1")
			.run(row.mac, tag);
		expect(() => f.store.read((db) => audit.verify(db))).toThrow("chain verification");
	} finally {
		attacker?.close();
		chain.destroy();
		key.fill(0);
		fork.store.close();
		fork.key.destroy();
		rmSync(fork.dir, { recursive: true, force: true });
	}
});

it("uses a primary-key range plan without a temporary sort", () => {
	append(1);
	let batch = "";
	f.store.read((db) =>
		audit.verify({
			get: db.get.bind(db),
			all(sql, bindings) {
				batch = sql;
				return db.all(sql, bindings);
			},
		}),
	);
	const db = rawConnection();
	try {
		const plan = db.prepare(`EXPLAIN QUERY PLAN ${batch}`).all(0, 1, 128) as { detail: string }[];
		expect(plan.map((row) => row.detail).join(" ")).not.toMatch(/TEMP B-TREE/i);
		expect(plan.map((row) => row.detail).join(" ")).toMatch(/INTEGER PRIMARY KEY/);
	} finally {
		db.close();
	}
});

it("resumes sequential export without re-verifying the prefix and invalidates on external changes", () => {
	f.store.write((tx) => {
		for (let n = 1; n <= 300; n++) audit.append(tx, event(n));
	});
	const prepare = Database.prototype.prepare;
	let batches = 0;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		if (sql.includes("ORDER BY main.audit_events.seq")) batches++;
		return prepare.call(this, sql);
	});
	let afterSeq = 0;
	for (let page = 0; page < 3; page++) {
		const result = f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq, limit: 100 }));
		expect(result.count).toBe(100);
		afterSeq = result.nextAfterSeq ?? 300;
	}
	expect(batches).toBe(5);
	const first = f.store.read((db) => audit.exportVerifiedJsonl(db, { limit: 100 }));
	expect(first.nextAfterSeq).toBe(100);
	const attacker = rawConnection();
	try {
		attacker.exec("DROP TRIGGER audit_no_update; UPDATE audit_events SET at=999 WHERE seq=1");
	} finally {
		attacker.close();
	}
	expect(() =>
		f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq: 100, limit: 100 })),
	).toThrow("export unavailable");
});

it("resumes pages across unrelated hub writes and appends without rescanning the verified prefix", () => {
	f.store.write((tx) => {
		for (let n = 1; n <= 300; n++) audit.append(tx, event(n));
	});
	const prepare = Database.prototype.prepare;
	let batches = 0;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		if (sql.includes("ORDER BY main.audit_events.seq")) batches++;
		return prepare.call(this, sql);
	});
	const exported: number[] = [];
	let afterSeq = 0;
	for (let page = 0; page < 3; page++) {
		if (page > 0)
			f.store.write((tx) => {
				tx.run("INSERT INTO test_rows VALUES(?,1)", [`page-${page}`]);
				audit.append(tx, event(300 + page));
			});
		const result = f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq, limit: 100 }));
		exported.push(
			...result.jsonl
				.trimEnd()
				.split("\n")
				.map((line) => (JSON.parse(line) as { seq: number }).seq),
		);
		afterSeq = result.nextAfterSeq ?? 300;
	}
	expect(exported).toEqual(Array.from({ length: 300 }, (_, n) => n + 1));
	expect(batches).toBe(7); // Initial three batches; only each new tail and requested page thereafter.
	const tail = f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq, limit: 100 }));
	expect(
		tail.jsonl
			.trimEnd()
			.split("\n")
			.map((line) => (JSON.parse(line) as { seq: number }).seq),
	).toEqual([301, 302]);
	expect(tail.nextAfterSeq).toBeNull();
	expect(batches).toBe(8);
});

it("refuses replacement/upsert and owns an IMMEDIATE transaction before the first write", () => {
	append(1);
	for (const sql of [
		"INSERT OR REPLACE INTO audit_events SELECT * FROM audit_events WHERE seq=1",
		"INSERT INTO audit_events SELECT * FROM audit_events WHERE seq=1 ON CONFLICT(seq) DO UPDATE SET at=excluded.at",
	])
		expect(() => f.store.write((tx) => tx.run(sql))).toThrow("append only");
	const contender = rawConnection();
	contender.pragma("busy_timeout=0");
	try {
		f.store.write(() => {
			expect(() => contender.prepare("INSERT INTO test_rows VALUES('other',1)").run()).toThrowError(
				expect.objectContaining({ code: "SQLITE_BUSY" }),
			);
		});
		expect(contender.prepare("INSERT INTO test_rows VALUES('other',1)").run().changes).toBe(1);
	} finally {
		contender.close();
	}
});

it("pins foreign-keys-off rebuilds and checks consistency after each migration file", async () => {
	const dir = path.join(f.dir, "sql");
	writeFileSync(
		path.join(dir, "0001_parent.sql"),
		"CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,pid INTEGER REFERENCES parent(id) ON DELETE CASCADE); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);",
	);
	await f.store.migrate("rebuild");
	writeFileSync(
		path.join(dir, "0002_rebuild.sql"),
		"CREATE TABLE replacement(id INTEGER PRIMARY KEY,x INTEGER); INSERT INTO replacement SELECT id,0 FROM parent; DROP TABLE parent; ALTER TABLE replacement RENAME TO parent;",
	);
	await f.store.migrate("rebuild");
	expect(f.store.read((db) => db.all("SELECT * FROM child"))).toEqual([{ id: 1, pid: 1 }]);
	writeFileSync(path.join(dir, "0003_orphan.sql"), "INSERT INTO child VALUES(2,99);");
	writeFileSync(path.join(dir, "0004_fix.sql"), "INSERT INTO parent VALUES(99,0);");
	await expect(f.store.migrate("rebuild")).rejects.toThrow("foreign key violations");
	expect(f.store.read((db) => db.all("SELECT * FROM child"))).toEqual([{ id: 1, pid: 1 }]);
});

it("reports SQLite's own full-disk rollback without committing an earlier migration", async () => {
	const filename = path.join(f.dir, "full.db"),
		dir = path.join(f.dir, "sql");
	const db = openEncrypted({ filename, nativeBinding, create: true }, f.key);
	try {
		writeFileSync(path.join(dir, "0001_init.sql"), "CREATE TABLE initial(x);");
		await migrate(db, "full", dir);
		const pages = db.pragma("page_count", { simple: true }) as number;
		db.pragma(`max_page_count=${pages + 50}`);
		writeFileSync(path.join(dir, "0002_labels.sql"), "CREATE TABLE labels(x);");
		writeFileSync(
			path.join(dir, "0003_big.sql"),
			"CREATE TABLE big(b BLOB); INSERT INTO big VALUES(zeroblob(4000000));",
		);
		await expect(migrate(db, "full", dir)).rejects.toMatchObject({
			message: expect.stringContaining("SQLite rolled back"),
			results: [
				{ migrationName: "0002_labels", direction: "Up", status: "NotExecuted" },
				{ migrationName: "0003_big", direction: "Up", status: "Error" },
			],
		});
		expect(
			db.prepare("SELECT name FROM sqlite_schema WHERE name IN('labels','big')").all(),
		).toEqual([]);
		expect(db.inTransaction).toBe(false);
	} finally {
		db.close();
	}
});

it("keeps content and key canaries out of live and checkpointed db/WAL/SHM bytes", () => {
	const canary = "DYTEST-PRIVATE-CONTENT-98ac7042";
	f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES(?,1)", [canary]));
	const subkey = f.key.derive("db");
	const scan = () => {
		for (const suffix of ["", "-wal", "-shm"]) {
			const file = f.filename + suffix;
			if (!existsSync(file)) continue;
			const bytes = readFileSync(file);
			for (const needle of [Buffer.from(canary), raw, subkey, Buffer.from(subkey.toString("hex"))])
				expect(bytes.includes(needle)).toBe(false);
		}
	};
	try {
		for (const suffix of ["", "-wal", "-shm"])
			expect(statSync(f.filename + suffix).size).toBeGreaterThan(0);
		scan();
		f.store.checkpoint();
		scan();
	} finally {
		subkey.fill(0);
	}
});

it("retries a failed first-run reservation and refuses empty files with sidecars", () => {
	const filename = path.join(f.dir, "retry.db");
	expect(
		() =>
			new HubStore({
				filename,
				nativeBinding: path.join(f.dir, "missing.node"),
				masterKey: f.key,
				create: true,
			}),
	).toThrow();
	expect(statSync(filename).size).toBe(0);
	const store = new HubStore({ filename, nativeBinding, masterKey: f.key, create: true });
	store.close();
	const empty = path.join(f.dir, "empty.db");
	writeFileSync(empty, "");
	writeFileSync(`${empty}-wal`, "");
	expect(
		() => new HubStore({ filename: empty, nativeBinding, masterKey: f.key, create: true }),
	).toThrow("sidecars");
});

it("accepts a hard-linked trusted migration file and adds no identity/PIN/recovery schema", async () => {
	const dir = path.join(f.dir, "sql"),
		file = path.join(dir, "0001_linked.sql");
	writeFileSync(file, "CREATE TABLE linked(x);");
	linkSync(file, path.join(f.dir, "alias.sql"));
	await expect(f.store.migrate("linked")).resolves.toEqual(["0001_linked"]);
	expect(
		f.store.read((db) =>
			db.all(
				"SELECT name FROM sqlite_schema WHERE name IN('users','devices','approval_pins','hub_meta')",
			),
		),
	).toEqual([]);
});

it.each([false, true])(
	"revalidates audit export after a rolled-back checkpoint with replacement %s",
	(replacement) => {
		for (let n = 1; n <= 10; n++) append(n);
		const first = f.store.read((db) => audit.exportVerifiedJsonl(db, { limit: 5 }));
		expect(first.nextAfterSeq).toBe(5);
		expect(() =>
			f.store.write((tx) => {
				audit.append(tx, event(11));
				const tentative = audit.exportVerifiedJsonl(tx, { afterSeq: 5, limit: 3 });
				expect(tentative.nextAfterSeq).toBe(8);
				expect(tentative.head.seq).toBe(11);
				throw new Error("DYTEST rollback");
			}),
		).toThrow("DYTEST rollback");
		f.store.read((db) => audit.verify(db));
		if (replacement) append(12);
		const page = f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq: 8, limit: 5 }));
		const rows = page.jsonl
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { seq: number; id: string });
		expect(rows.map((row) => row.seq)).toEqual(replacement ? [9, 10, 11] : [9, 10]);
		expect(rows.map((row) => row.id)).toEqual(
			(replacement ? [9, 10, 12] : [9, 10]).map((n) => event(n).id),
		);
		expect(page.head.seq).toBe(replacement ? 11 : 10);
		expect(page.nextAfterSeq).toBeNull();
		f.store.read((db) => audit.verify(db));
	},
);
