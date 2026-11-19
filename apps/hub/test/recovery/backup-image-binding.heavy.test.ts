import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { BackupArtifactError } from "../../src/recovery/backup-artifact.ts";
import { createRecoveryBinding } from "../../src/recovery/backup-bindings.ts";
import { captureBackupImageBinding } from "../../src/recovery/backup-image-binding.ts";
import { HubStore, type SqlReader, type SqlValue } from "../../src/store/store.ts";
import { nativeBinding } from "../store/helpers.ts";

const temporaryRoot = realpathSync.native(os.tmpdir());
const roots: { folder: string; dev: number; ino: number; key: MasterKey; store?: HubStore }[] = [];
const buffers: Buffer[] = [];
const migration = path.resolve(import.meta.dirname, "../../src/recovery/backup-migrations");

afterEach(() => {
	const failures: unknown[] = [];
	for (const root of roots.splice(0).reverse()) {
		try {
			root.store?.close();
			const current = lstatSync(root.folder);
			if (
				path.dirname(root.folder) !== temporaryRoot ||
				!path.basename(root.folder).startsWith("draftyak-image-binding-") ||
				current.dev !== root.dev ||
				current.ino !== root.ino ||
				current.isSymbolicLink()
			)
				throw new Error("DYTEST unowned binding fixture");
			rmSync(root.folder, { recursive: true, force: false });
		} catch (error) {
			failures.push(error);
		} finally {
			root.key.destroy();
		}
	}
	for (const buffer of buffers.splice(0)) buffer.fill(0);
	if (failures.length) throw new Error("DYTEST binding fixture cleanup incomplete");
});

function keep(value: Buffer): Buffer {
	buffers.push(value);
	return value;
}

async function fixture(mode: "canonical" | "permissive" | "missing" = "canonical") {
	const folder = realpathSync.native(
		mkdtempSync(path.join(temporaryRoot, "draftyak-image-binding-")),
	);
	const { dev, ino } = lstatSync(folder);
	const seed = randomBytes(32);
	let key: MasterKey;
	try {
		key = new MasterKey(seed);
	} finally {
		seed.fill(0);
	}
	const root: (typeof roots)[number] = { folder, dev, ino, key };
	roots.push(root);
	const folders: Record<string, string> = {};
	if (mode === "canonical") folders.backup = migration;
	if (mode === "permissive") {
		const directory = path.join(folder, "fixture-sql");
		mkdirSync(directory, { mode: 0o700 });
		writeFileSync(
			path.join(directory, "0001_malformed.sql"),
			"CREATE TABLE native_backup_recovery(singleton ANY,binding ANY) STRICT;",
		);
		folders.fixture = directory;
	}
	const store = new HubStore({
		filename: path.join(folder, "fixture.db"),
		nativeBinding,
		masterKey: key,
		create: true,
		migrations: folders,
	});
	root.store = store;
	if (mode !== "missing") await store.migrate(mode === "canonical" ? "backup" : "fixture");
	return { store, key };
}

function binding(key: MasterKey): Buffer {
	const code = randomBytes(20);
	try {
		return keep(createRecoveryBinding(key, keep(key.wrapRecovery(code))));
	} finally {
		code.fill(0);
	}
}

function required(value: Buffer | null): Buffer {
	if (value === null) throw new Error("DYTEST expected captured binding");
	return keep(value);
}

function replace(store: HubStore, singleton: SqlValue, value: SqlValue): void {
	store.write((sql) => {
		sql.run("DELETE FROM native_backup_recovery");
		sql.run("INSERT INTO native_backup_recovery(singleton,binding) VALUES(?,?)", [
			singleton,
			value,
		]);
	});
}

function observe(sql: SqlReader, rows: unknown[][]): SqlReader {
	return {
		get: <T>(query: string, values: readonly SqlValue[] = []) => sql.get<T>(query, values),
		all<T>(query: string, values: readonly SqlValue[] = []): T[] {
			const actual = sql.all<T>(query, values);
			rows.push(actual);
			return actual;
		},
	};
}

function refused(action: () => unknown): void {
	let error: unknown;
	try {
		action();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(BackupArtifactError);
	expect(error).toMatchObject({
		name: "BackupArtifactError",
		code: "BACKUP_ARTIFACT_UNAVAILABLE",
		message: "Backup artifact unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

it("returns null for an empty canonical recovery table", async () => {
	const { store } = await fixture();
	expect(store.read(captureBackupImageBinding)).toBeNull();
	expect(
		store.read((sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM native_backup_recovery"))
			?.n,
	).toBe(0);
});

it("captures genuine binding DATA from the caller's current native transaction", async () => {
	const { store, key } = await fixture();
	const first = binding(key),
		second = binding(key);
	replace(store, 1, first);
	const captured = required(
		store.write((sql) => {
			const snapshot = captureBackupImageBinding(sql);
			sql.run("UPDATE native_backup_recovery SET binding=? WHERE singleton=1", [second]);
			return snapshot;
		}),
	);
	expect(captured.equals(first)).toBe(true);
	expect(required(store.read(captureBackupImageBinding)).equals(second)).toBe(true);
	store.close();
	expect(captured.equals(first)).toBe(true);
});

it("captures uncommitted binding DATA before a real transaction rollback", async () => {
	const { store, key } = await fixture();
	const original = binding(key),
		pending = binding(key);
	replace(store, 1, original);
	let captured: Buffer | undefined;
	const rollback = new Error("DYTEST rollback binding transaction");
	expect(() =>
		store.write((sql) => {
			sql.run("UPDATE native_backup_recovery SET binding=? WHERE singleton=1", [pending]);
			captured = required(captureBackupImageBinding(sql));
			throw rollback;
		}),
	).toThrow(rollback);
	expect(captured?.equals(pending)).toBe(true);
	expect(required(store.read(captureBackupImageBinding)).equals(original)).toBe(true);
});

it("owns a copy independent of actual SQLite result bytes and later caller mutation", async () => {
	const { store, key } = await fixture();
	const value = binding(key);
	replace(store, 1, value);
	const rows: unknown[][] = [];
	const captured = required(store.read((sql) => captureBackupImageBinding(observe(sql, rows))));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toHaveLength(1);
	const native = (rows[0]?.[0] as { binding?: unknown } | undefined)?.binding;
	expect(Buffer.isBuffer(native)).toBe(true);
	if (!Buffer.isBuffer(native)) throw new Error("DYTEST native BLOB missing");
	native.fill(0);
	expect(captured.equals(value)).toBe(true);
	captured.fill(1);
	expect(required(store.read(captureBackupImageBinding)).equals(value)).toBe(true);
});

it("does not authenticate the binding MAC or derive authority from its grammar", async () => {
	const { store, key } = await fixture();
	const value = binding(key);
	value[68] = (value[68] ?? 0) ^ 1;
	replace(store, 1, value);
	expect(required(store.read(captureBackupImageBinding)).equals(value)).toBe(true);
});

it("refuses wrong singleton values and types without filtering extra rows", async () => {
	const { store, key } = await fixture("permissive");
	const value = binding(key);
	for (const singleton of [null, 0, -1, 2, 1.5, "1", keep(Buffer.of(1))]) {
		replace(store, singleton, value);
		refused(() => store.read(captureBackupImageBinding));
	}
});

it("refuses non-BLOB and wrong-size bindings without materializing rejected payloads", async () => {
	const { store } = await fixture("permissive");
	for (const value of [
		null,
		69,
		1.5,
		"x".repeat(69),
		...[0, 68, 70, 1_048_576].map((length) => keep(Buffer.alloc(length, 0x5a))),
	]) {
		replace(store, 1, value);
		const rows: unknown[][] = [];
		refused(() => store.read((sql) => captureBackupImageBinding(observe(sql, rows))));
		expect(rows).toEqual([[{ binding: null }]]);
	}
});

it("refuses each malformed binding header byte in the real canonical BLOB row", async () => {
	const { store, key } = await fixture();
	const value = binding(key);
	for (let offset = 0; offset < 5; offset++) {
		const changed = keep(Buffer.from(value));
		changed[offset] = (changed[offset] ?? 0) ^ 0x80;
		replace(store, 1, changed);
		refused(() => store.read(captureBackupImageBinding));
		expect(
			store
				.read((sql) => sql.get<{ binding: Buffer }>("SELECT binding FROM native_backup_recovery"))
				?.binding.equals(changed),
		).toBe(true);
	}
});

it.each([1, 2])("bounds duplicate and unexpected singleton rows to two: %i", async (extra) => {
	const { store, key } = await fixture("permissive");
	const value = binding(key);
	store.write((sql) => {
		for (let i = 0; i < 9; i++)
			sql.run("INSERT INTO native_backup_recovery(singleton,binding) VALUES(?,?)", [
				i === 0 ? 1 : extra,
				value,
			]);
	});
	const rows: unknown[][] = [];
	refused(() => store.read((sql) => captureBackupImageBinding(observe(sql, rows))));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toHaveLength(2);
	expect(
		store.read((sql) => sql.get<{ n: number }>("SELECT count(*) AS n FROM native_backup_recovery"))
			?.n,
	).toBe(9);
});

it("maps missing-table and expired-reader query failures to the same fixed refusal", async () => {
	const { store } = await fixture("missing");
	refused(() => store.read(captureBackupImageBinding));
	let expired: SqlReader | undefined;
	store.read((sql) => {
		expired = sql;
	});
	if (!expired) throw new Error("DYTEST reader missing");
	const reader = expired;
	refused(() => captureBackupImageBinding(reader));
});
