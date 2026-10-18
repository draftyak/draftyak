import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canaryTail, leaks, needles, newCanary, scanDatabase, scanFile } from "../src/canary.ts";
import { EXPECTED, isEncrypted, keyDatabase, openEncrypted, readSettings } from "../src/db.ts";
import { openDatabase, type SqliteDatabase } from "../src/open.ts";
import {
	cipherSalt,
	type RotationKeys,
	rotate,
	vacuumSourceInto,
	verifyRotated,
} from "../src/rotate.ts";
import {
	addConversation,
	addMessages,
	binding,
	coreDatabase,
	filler,
	ftsIntegrity,
	listDir,
	newKey,
	rows,
	search,
	sha256File,
	tempDir,
} from "./support.ts";

const thrown = (action: () => unknown): unknown => {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
};

interface Source {
	readonly dir: string;
	readonly file: string;
	readonly target: string;
	readonly keys: RotationKeys;
	readonly canary: string;
}

// A migrated source with rows, the last of them still only in its WAL, and an open writer.
async function source(use: (source: Source, writer: SqliteDatabase) => void): Promise<void> {
	const dir = tempDir();
	const file = path.join(dir, "draftyak.db");
	const keys = { from: newKey(), to: newKey() };
	const canary = newCanary();
	const writer = await coreDatabase(file, keys.from);
	try {
		addConversation(writer, "conv-1", "planning");
		addMessages(writer, filler(200));
		writer.prepare("DELETE FROM messages WHERE id IN ('msg-3', 'msg-4')").run();
		writer.pragma("wal_checkpoint(TRUNCATE)");
		writer.pragma("wal_autocheckpoint = 0");
		addMessages(writer, [{ id: "late", subject: "late arrival", body: `holds ${canary}` }]);
		use({ dir, file, target: path.join(dir, "rotated.db"), keys, canary }, writer);
	} finally {
		writer.close();
	}
}

const snapshot = (db: SqliteDatabase) => ({
	conversations: rows(db, "SELECT * FROM conversations ORDER BY id"),
	messages: rows(db, "SELECT * FROM messages ORDER BY seq"),
	migrations: rows(db, "SELECT name FROM _migrations_core"),
	schema: rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name"),
	// A rebuilt index stays at format 4 until its first secure delete.
	ftsConfig: rows(db, "SELECT k, v FROM fts_messages_config WHERE k <> 'version'"),
	searches: ["fox", "late", "arrival"].map((term) => search(db, term)),
});

describe("rotate", () => {
	it("can't run §3's VACUUM INTO with URI cipher parameters: this build reads the URI as a file name", async () => {
		await source(({ dir, file, target, keys }) => {
			const before = listDir(dir);
			const error = thrown(() => rotate("vacuum-into-uri", file, target, keys, binding()));
			// SQLite's own message repeats the URI, new key included, so only its code is kept.
			expect(error).toMatchObject({
				name: "RotationError",
				code: "SQLITE_CANTOPEN",
				message: "VACUUM INTO a URI failed",
			});
			expect((error as Error).cause).toBeUndefined();
			expect(listDir(dir)).toEqual(before);
		});
	});

	it.for(["vacuum-into", "attach-copy"] as const)(
		"%s writes a new file that opens only with the new key and holds the same data",
		async (method) => {
			await source(({ dir, file, target, keys, canary }, writer) => {
				const expected = snapshot(writer);
				const sourceBytes = sha256File(file);
				const rotation = rotate(method, file, target, keys, binding());
				expect(rotation).toMatchObject({ method, bytes: expect.any(Number) });
				expect(sha256File(file)).toBe(sourceBytes);
				expect(listDir(dir)).toEqual([
					"draftyak.db",
					"draftyak.db-shm",
					"draftyak.db-wal",
					"rotated.db",
				]);
				expect(cipherSalt(target)).not.toBe(cipherSalt(file));
				expect(thrown(() => openEncrypted(target, keys.from, binding()))).toMatchObject({
					code: "SQLITE_NOTADB",
				});
				const look = needles({ canary: canaryTail(canary), key: keys.to, oldKey: keys.from });
				expect(leaks(scanDatabase(target, look))).toEqual([]);
				const rotated = openEncrypted(target, keys.to, binding());
				try {
					expect(readSettings(rotated)).toEqual(EXPECTED);
					expect(snapshot(rotated)).toEqual(expected);
					ftsIntegrity(rotated);
					// The triggers came along and keep the index in step.
					addMessages(rotated, [{ id: "after", subject: "post rotation", body: "new words" }]);
					expect(search(rotated, "rotation")).toHaveLength(1);
					rotated.prepare("DELETE FROM messages WHERE id = 'late'").run();
					expect(search(rotated, "late")).toEqual([]);
					ftsIntegrity(rotated);
				} finally {
					rotated.close();
				}
				expect(search(writer, "late")).toHaveLength(1);
			});
		},
	);

	it("fails closed on a wrong source key, a missing or empty source, an existing target, the same file or the same key", async () => {
		await source(({ dir, file, target, keys }) => {
			const before = listDir(dir);
			const [missing, empty] = [path.join(dir, "missing.db"), path.join(dir, "empty.db")];
			for (const method of ["vacuum-into", "attach-copy"] as const) {
				const wrong = { from: newKey(), to: keys.to };
				expect(thrown(() => rotate(method, file, target, wrong, binding()))).toMatchObject({
					code: "SQLITE_NOTADB",
				});
				expect(listDir(dir)).toEqual(before);
				// ATTACH would create a missing source, and either method would copy an empty one.
				expect(thrown(() => rotate(method, missing, target, keys, binding()))).toMatchObject({
					code: "ERR_DB_FILE",
				});
				writeFileSync(empty, "");
				expect(thrown(() => rotate(method, empty, target, keys, binding()))).toMatchObject({
					code: "ERR_DB_FILE",
				});
				expect(statSync(empty).size).toBe(0);
				rmSync(empty);
				expect(listDir(dir)).toEqual(before);
			}
			const refused = [
				() => rotate("vacuum-into", file, file, keys, binding()),
				() => rotate("vacuum-into", file, target, { from: keys.from, to: keys.from }, binding()),
				() => rotate("attach-copy", file, target, { from: keys.from, to: "abc" }, binding()),
			];
			for (const attempt of refused) expect(thrown(attempt)).toBeInstanceOf(Error);
			rotate("vacuum-into", file, target, keys, binding());
			expect(thrown(() => rotate("attach-copy", file, target, keys, binding()))).toMatchObject({
				name: "RotationError",
				message: `${target} already exists`,
			});
			expect(existsSync(target)).toBe(true);
		});
	});

	it("refuses VACUUM INTO from an unkeyed main database, whose output would be plaintext", async () => {
		await source(({ dir, file, keys, canary }) => {
			const [refused, plain] = [path.join(dir, "refused.db"), path.join(dir, "plain.db")];
			const unkeyed = openDatabase(path.join(dir, "unkeyed.holder"), binding());
			try {
				expect(isEncrypted(unkeyed)).toBe(false);
				expect(thrown(() => vacuumSourceInto(unkeyed, file, keys.from, refused))).toMatchObject({
					name: "RotationError",
					message: "VACUUM INTO from an unkeyed main database would write plaintext",
				});
				expect(existsSync(refused)).toBe(false);
				// What the check prevents: the same copy, run directly, is the source in plaintext.
				unkeyed.prepare("ATTACH ? AS source KEY ?").run(file, Buffer.from(keys.from, "hex"));
				unkeyed.prepare("VACUUM source INTO ?").run(plain);
			} finally {
				unkeyed.close();
			}
			const scan = scanFile(plain, needles({ canary: canaryTail(canary) }));
			expect(scan).toMatchObject({ header: true, found: ["canary"] });
			const keyed = openDatabase(path.join(dir, "keyed.holder"), binding());
			try {
				keyDatabase(keyed, keys.to);
				expect(isEncrypted(keyed)).toBe(true);
			} finally {
				keyed.close();
			}
		});
	});

	it("checks a rotated file against the source: its schema and the rows in each table", async () => {
		await source(({ file, target, keys }) => {
			rotate("vacuum-into", file, target, keys, binding());
			const change = (sql: string): void => {
				const rotated = openEncrypted(target, keys.to, binding());
				try {
					rotated.exec(sql);
				} finally {
					rotated.close();
				}
			};
			change("DELETE FROM messages WHERE id = 'late'");
			expect(thrown(() => verifyRotated(file, keys, target, binding()))).toMatchObject({
				name: "RotationError",
				message: "the rotated file's row counts differ from the source's",
			});
			change("CREATE TABLE extra (x TEXT) STRICT");
			expect(thrown(() => verifyRotated(file, keys, target, binding()))).toMatchObject({
				message: "the rotated file's schema differs from the source's",
			});
		});
	});

	// Why §3 rotates into a new file: SQLite3MC 2.4.0 does rekey a WAL database in place, but keeps
	// its cipher salt.
	it("leaves the salt unchanged when PRAGMA rekey runs in place under WAL", async () => {
		await source(({ file, keys }, writer) => {
			writer.pragma("wal_checkpoint(TRUNCATE)");
			const salt = cipherSalt(file);
			expect(writer.pragma(`hexrekey = '${keys.to}'`, { simple: true })).toBe("ok");
			writer.pragma("wal_checkpoint(TRUNCATE)");
			expect(cipherSalt(file)).toBe(salt);
			expect(thrown(() => openEncrypted(file, keys.from, binding()))).toMatchObject({
				code: "SQLITE_NOTADB",
			});
			const reopened = openEncrypted(file, keys.to, binding());
			reopened.close();
		});
	});
});
