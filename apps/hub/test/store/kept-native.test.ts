import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openEncrypted } from "../../src/store/open.ts";
import { fixture, nativeBinding } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => {
	try {
		f.store.close();
	} finally {
		f.key.destroy();
	}
	rmSync(f.dir, { recursive: true, force: true });
});

const reported = (db: Database.Database) => ({
	journalMode: db.pragma("journal_mode", { simple: true }),
	synchronous: db.pragma("synchronous", { simple: true }),
	fullfsync: db.pragma("fullfsync", { simple: true }),
	checkpointFullfsync: db.pragma("checkpoint_fullfsync", { simple: true }),
	recursiveTriggers: db.pragma("recursive_triggers", { simple: true }),
	tempStore: db.pragma("temp_store", { simple: true }),
});

it("overrides the native build's sync, temp_store and recursive_triggers defaults", () => {
	// ADR 0002's keyed-only control uses the same file, key and pinned binding,
	// without the production opener's connection settings.
	const keyedOnly = new Database(f.filename, { nativeBinding, fileMustExist: true });
	try {
		keyedOnly.pragma("cipher = 'chacha20'");
		const key = f.key.derive("db");
		try {
			keyedOnly.key(key);
		} finally {
			key.fill(0);
		}
		expect(keyedOnly.prepare("SELECT count(*) AS n FROM main.test_rows").get()).toEqual({
			n: 0,
		});
		expect(reported(keyedOnly)).toEqual({
			journalMode: "wal",
			synchronous: 1,
			fullfsync: 0,
			checkpointFullfsync: 0,
			recursiveTriggers: 0,
			tempStore: 0,
		});
	} finally {
		keyedOnly.close();
	}

	const opened = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	try {
		expect(opened.prepare("SELECT count(*) AS n FROM main.test_rows").get()).toEqual({ n: 0 });
		expect(reported(opened)).toEqual({
			journalMode: "wal",
			synchronous: 2,
			fullfsync: 1,
			checkpointFullfsync: 1,
			recursiveTriggers: 1,
			tempStore: 2,
		});
	} finally {
		opened.close();
	}
});

it("refuses an encrypted-to-unkeyed online backup while a real plaintext control succeeds", async () => {
	const canary = "DYTEST-UNKEYED-BACKUP-CONTROL-715cf290";
	f.store.write((tx) => tx.run("INSERT INTO test_rows VALUES(?,1)", [canary]));
	const encryptedTarget = path.join(f.dir, "refused-backup.db");
	const encrypted = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	try {
		await expect(encrypted.backup(encryptedTarget)).rejects.toMatchObject({
			code: "SQLITE_ERROR",
			message: "backup is not supported with incompatible source and target databases",
		});
		expect(encrypted.prepare("SELECT id FROM main.test_rows").get()).toEqual({ id: canary });
	} finally {
		encrypted.close();
	}
	// A refused target may be absent or an empty file; neither may hold source bytes.
	if (existsSync(encryptedTarget)) expect(readFileSync(encryptedTarget)).toHaveLength(0);

	const plainTarget = path.join(f.dir, "plain-backup.db");
	const plain = new Database(path.join(f.dir, "plain-control.db"), { nativeBinding });
	try {
		plain.exec("CREATE TABLE control(value TEXT NOT NULL) STRICT");
		plain.prepare("INSERT INTO control VALUES(?)").run(canary);
		await plain.backup(plainTarget);
	} finally {
		plain.close();
	}
	const image = readFileSync(plainTarget);
	expect(image.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
	expect(image.includes(Buffer.from(canary))).toBe(true);
	const copied = new Database(plainTarget, { nativeBinding, readonly: true, fileMustExist: true });
	try {
		expect(copied.prepare("SELECT value FROM control").get()).toEqual({ value: canary });
	} finally {
		copied.close();
	}
});
