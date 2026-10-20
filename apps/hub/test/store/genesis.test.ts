import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { statementStarts } from "../../src/store/migrator.ts";
import { openEncrypted } from "../../src/store/open.ts";
import { HubStore } from "../../src/store/store.ts";
import { fixture, migrations, nativeBinding } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>, audit: AuditChain;
const stores: HubStore[] = [];
const auditDir = path.join(migrations, "audit");
const event = {
	id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
	at: 1,
	action: "hub.init",
	actor: { kind: "hub" as const, id: null },
	refs: {},
};
beforeEach(async () => {
	f = await fixture();
	const key = f.key.derive("audit");
	try {
		audit = new AuditChain(key);
	} finally {
		key.fill(0);
	}
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
	f.store.close();
	audit.destroy();
	f.key.destroy();
	rmSync(f.dir, { recursive: true, force: true });
});
const open = (filename: string, create = false, audit = auditDir): HubStore => {
	const store = new HubStore({
		filename,
		nativeBinding,
		masterKey: f.key,
		create,
		migrations: { audit },
	});
	stores.push(store);
	return store;
};
const unavailable = (store: HubStore): void => {
	expect(() => store.write((tx) => audit.append(tx, event))).toThrow();
	expect(() => store.read((db) => audit.verify(db))).toThrow();
	expect(() => store.read((db) => audit.exportVerifiedJsonl(db))).toThrow("export unavailable");
};
const reset = (filename = f.filename): void => {
	const attacker = openEncrypted({ filename, nativeBinding }, f.key);
	try {
		attacker.exec(
			"DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete; DROP TABLE audit_events; DROP TABLE audit_meta; DELETE FROM _migrations_audit",
		);
	} finally {
		attacker.close();
	}
};

it("signs fresh genesis once and allows ordinary migration/reopen of its authenticated history", async () => {
	const filename = path.join(f.dir, "fresh.db"),
		store = open(filename, true);
	await expect(store.migrate("audit")).resolves.toEqual(["0001_chain"]);
	store.read((db) => audit.verify(db));
	expect(store.read((db) => audit.exportVerifiedJsonl(db)).count).toBe(0);
	store.write((tx) => audit.append(tx, event));
	await expect(store.migrate("audit")).resolves.toEqual([]);
	store.close();
	const reopened = open(filename);
	await expect(reopened.migrate("audit")).resolves.toEqual([]);
	reopened.read((db) => audit.verify(db));
	expect(reopened.read((db) => audit.exportVerifiedJsonl(db)).count).toBe(1);
});

it("cannot sign reset-to-empty audit storage in the same open or after reopening", async () => {
	f.store.write((tx) => {
		tx.run("INSERT INTO test_rows VALUES('kept',1)");
		audit.append(tx, event);
	});
	reset();
	await expect(f.store.migrate("audit")).rejects.toThrow(
		"Audit storage is missing or incomplete. Restore a valid backup; remove and recreate the database only if it was never used.",
	);
	expect(f.store.read((db) => db.get("SELECT COUNT(*) AS n FROM test_rows"))).toEqual({ n: 1 });
	unavailable(f.store);
	f.store.close();
	const reopened = open(f.filename);
	await expect(reopened.migrate("audit")).rejects.toThrow("Audit storage is missing or incomplete");
	unavailable(reopened);
	expect(
		reopened.read((db) =>
			db.all("SELECT name FROM sqlite_schema WHERE name IN ('audit_meta','audit_events')"),
		),
	).toEqual([]);
});

it("does not infer freshness from an existing encrypted database without audit schema", async () => {
	const filename = path.join(f.dir, "existing.db"),
		created = open(filename, true);
	created.close();
	const reopened = open(filename);
	await expect(reopened.migrate("audit")).rejects.toThrow("Audit storage is missing or incomplete");
	unavailable(reopened);
});

it.each([
	"DELETE FROM audit_meta",
	"UPDATE audit_meta SET audit_tag=''",
	`UPDATE audit_meta SET audit_tag='${"0".repeat(64)}'`,
])("never repairs a missing or unauthenticated existing head: %s", async (sql) => {
	const attacker = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	try {
		attacker.exec(sql);
	} finally {
		attacker.close();
	}
	await expect(f.store.migrate("audit")).resolves.toEqual([]);
	unavailable(f.store);
});

it("rolls back a signed genesis with a later migration failure and permits the fresh open to retry", async () => {
	const dir = path.join(f.dir, "failed-audit"),
		store = open(path.join(f.dir, "retry.db"), true, dir);
	mkdirSync(dir);
	copyFileSync(path.join(auditDir, "0001_chain.sql"), path.join(dir, "0001_chain.sql"));
	writeFileSync(
		path.join(dir, "0002_failure.sql"),
		"INSERT INTO table_that_does_not_exist VALUES(1)",
	);
	await expect(store.migrate("audit")).rejects.toThrow("table_that_does_not_exist");
	expect(
		store.read((db) =>
			db.all("SELECT name FROM sqlite_schema WHERE name IN ('audit_meta','audit_events')"),
		),
	).toEqual([]);
	unavailable(store);
	unlinkSync(path.join(dir, "0002_failure.sql"));
	await expect(store.migrate("audit")).resolves.toEqual(["0001_chain"]);
	store.read((db) => audit.verify(db));
});

it("consumes genesis authority even if a post-commit setting check fails", async () => {
	const filename = path.join(f.dir, "committed.db"),
		store = open(filename, true);
	const pragma = Database.prototype.pragma;
	const failure = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
		this: Database.Database,
		source,
		options,
	) {
		if (
			source === "cipher" &&
			!this.inTransaction &&
			this.prepare("SELECT 1 FROM sqlite_schema WHERE name='audit_meta'").get()
		)
			throw new Error("post-commit setting check");
		return pragma.call(this, source, options);
	});
	await expect(store.migrate("audit")).rejects.toThrow("post-commit setting check");
	failure.mockRestore();
	store.read((db) => audit.verify(db));
	reset(filename);
	await expect(store.migrate("audit")).rejects.toThrow("Audit storage is missing or incomplete");
	unavailable(store);
});

it("does not mistake SQL-cleared storage after a post-commit fault for a rollback", async () => {
	const filename = path.join(f.dir, "erased-after-commit.db"),
		store = open(filename, true);
	const pragma = Database.prototype.pragma;
	const failure = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
		this: Database.Database,
		source,
		options,
	) {
		if (
			source === "cipher" &&
			!this.inTransaction &&
			this.prepare("SELECT 1 FROM sqlite_schema WHERE name='audit_meta'").get()
		) {
			this.exec(
				"DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete; DROP TABLE audit_events; DROP TABLE audit_meta; DELETE FROM _migrations_audit",
			);
			throw new Error("post-commit fault after SQL reset");
		}
		return pragma.call(this, source, options);
	});
	await expect(store.migrate("audit")).rejects.toThrow("post-commit fault after SQL reset");
	failure.mockRestore();
	unavailable(store);
	await expect(store.migrate("audit")).rejects.toThrow("Audit storage is missing or incomplete");
	unavailable(store);
});

it("rejects initial genesis after an earlier audit migration has already committed", async () => {
	const dir = path.join(f.dir, "prior-audit"),
		store = open(path.join(f.dir, "prior.db"), true, dir);
	mkdirSync(dir);
	writeFileSync(path.join(dir, "0000_prior.sql"), "CREATE TABLE prior_audit(x)");
	await store.migrate("audit");
	copyFileSync(path.join(auditDir, "0001_chain.sql"), path.join(dir, "0001_chain.sql"));
	await expect(store.migrate("audit")).rejects.toThrow("Audit storage is missing or incomplete");
	unavailable(store);
});

it("reads each open option once and cannot convert an existing file into fresh audit authority", async () => {
	reset();
	f.store.close();
	const reads = { filename: 0, nativeBinding: 0, masterKey: 0, create: 0 };
	const store = new HubStore({
		migrations: { audit: auditDir },
		get filename() {
			return ++reads.filename === 1 ? f.filename : path.join(f.dir, "wrong.db");
		},
		get nativeBinding() {
			++reads.nativeBinding;
			return nativeBinding;
		},
		get masterKey() {
			++reads.masterKey;
			return f.key;
		},
		get create() {
			return ++reads.create > 1;
		},
	});
	stores.push(store);
	expect(reads).toEqual({ filename: 1, nativeBinding: 1, masterKey: 1, create: 1 });
	await expect(store.migrate("audit")).rejects.toThrow("Audit storage is missing or incomplete");
	unavailable(store);
});

it("does not mint genesis for an arbitrary pre-existing empty file", async () => {
	const filename = path.join(f.dir, "unowned-empty.db");
	writeFileSync(filename, "");
	expect(() => open(filename, true)).toThrow("never initialized");
	expect(() => open(filename)).toThrow("never initialized");
	expect(readFileSync(filename).length).toBe(0);
});

it("does not reuse consumed reservation authority after an initialized file is truncated", async () => {
	f.store.close();
	writeFileSync(f.filename, "");
	for (const suffix of ["-wal", "-shm"]) rmSync(f.filename + suffix, { force: true });
	expect(() => open(f.filename, true)).toThrow("never initialized");
	expect(readFileSync(f.filename).length).toBe(0);
});

it("discards a failed reservation after its file is replaced", async () => {
	const filename = path.join(f.dir, "replaced.db");
	expect(
		() =>
			new HubStore({
				filename,
				nativeBinding: path.join(f.dir, "missing.node"),
				masterKey: f.key,
				create: true,
			}),
	).toThrow();
	// Reserve the replacement before unlinking so file identity cannot be recycled.
	const replacement = path.join(f.dir, "replacement.db");
	writeFileSync(replacement, "");
	unlinkSync(filename);
	renameSync(replacement, filename);
	expect(() => open(filename, true)).toThrow("never initialized");
	expect(readFileSync(filename).length).toBe(0);
});

it("accepts a retry of an untouched empty first-run reservation as fresh", async () => {
	const filename = path.join(f.dir, "reserved.db");
	expect(
		() =>
			new HubStore({
				filename,
				nativeBinding: path.join(f.dir, "missing.node"),
				masterKey: f.key,
				create: true,
			}),
	).toThrow();
	expect(readFileSync(filename).length).toBe(0);
	const store = open(filename, true);
	await store.migrate("audit");
	store.read((db) => audit.verify(db));
});

it.each(["failed-create", "interrupted-create"])(
	"reports recovery across two real processes after %s",
	(mode) => {
		const filename = path.join(f.dir, `${mode}.db`);
		const childEnv: NodeJS.ProcessEnv = { NODE_OPTIONS: "--max-old-space-size=256" };
		for (const name of ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"])
			if (process.env[name] !== undefined) childEnv[name] = process.env[name];
		const child = (operation: string) =>
			spawnSync(
				process.execPath,
				[
					"--disable-sigusr1",
					path.join(import.meta.dirname, "helpers/first-run-child.ts"),
					operation,
					filename,
					nativeBinding,
				],
				{
					env: childEnv,
					encoding: "utf8",
					maxBuffer: 65536,
					windowsHide: true,
					shell: false,
					timeout: 15000,
				},
			);
		const first = child(mode);
		expect(first.error).toBeUndefined();
		expect(first.status).toBe(mode === "failed-create" ? 1 : 0);
		const before = readFileSync(filename);
		expect(before.length === 0).toBe(mode === "failed-create");
		const second = child(mode === "failed-create" ? "create" : "resume");
		expect(second.error).toBeUndefined();
		expect(second.status).toBe(1);
		if (mode === "failed-create") {
			expect(second.stderr).toContain("never initialized");
			expect(second.stderr).toContain("before creating it again");
		} else {
			expect(second.stderr).toContain("Audit storage is missing or incomplete");
			expect(second.stderr).toContain("only if it was never used");
		}
		if (mode === "failed-create") expect(readFileSync(filename).length).toBe(0);
	},
);

it.each([
	"EXPLAIN\ufeffPRAGMA temp_store=FILE",
	"EXPLAIN\ufeffQUERY\ufeffPLAN\ufeffPRAGMA trusted_schema=ON",
	"/* prefix */EXPLAIN\ufeffPRAGMA hexrekey='00'",
])("treats internal SQLite BOM whitespace as a token boundary: %s", async (sql) => {
	expect(statementStarts(sql)).toEqual(["EXPLAIN"]);
	for (const access of [
		() => f.store.read((db) => db.get(sql)),
		() => f.store.write((db) => db.all(sql)),
		() => f.store.write((db) => db.run(sql)),
	])
		expect(access).toThrow("reserved");
	const dir = path.join(f.dir, "bom");
	mkdirSync(dir);
	writeFileSync(path.join(dir, "0001_forbidden.sql"), sql);
	await expect(f.store.migrate("bom")).rejects.toThrow("can't run EXPLAIN");
});
