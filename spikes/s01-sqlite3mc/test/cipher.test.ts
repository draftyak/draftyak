import {
	copyFileSync,
	existsSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SQLITE_HEADER } from "../src/canary.ts";
import {
	CIPHER,
	DB_KEY_INFO,
	deriveHexKey,
	EXPECTED,
	keyDatabase,
	openEncrypted,
	readSettings,
} from "../src/db.ts";
import { openDatabase } from "../src/open.ts";
import {
	addConversation,
	binding,
	listDir,
	newKey,
	newMasterKey,
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

const NOTADB = { code: "SQLITE_NOTADB", message: "file is not a database" };

// An encrypted database holding one row, closed again.
function written(dir: string, key: string): string {
	const file = path.join(dir, "draftyak.db");
	const db = openEncrypted(file, key, binding(), { create: true });
	try {
		db.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, account_id TEXT, subject TEXT)");
		addConversation(db, "conv-1", "quarterly numbers");
	} finally {
		db.close();
	}
	return file;
}

describe("the database key", () => {
	it("is HKDF-SHA256 over the master key, with its purpose as info and an empty salt", async () => {
		const masterKey = Buffer.alloc(32, 0x0b);
		const hexKey = deriveHexKey(masterKey);
		expect(DB_KEY_INFO).toBe("draftyak/v1/db");
		expect(hexKey).toBe("7591d208acdbd734a4274a32f4d157fced5ee25d2f84dccdf69a32510077786e");
		const key = await crypto.subtle.importKey("raw", masterKey, "HKDF", false, ["deriveBits"]);
		const info = new TextEncoder().encode(DB_KEY_INFO);
		const params = { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info };
		const bits = await crypto.subtle.deriveBits(params, key, 256);
		expect(Buffer.from(bits).toString("hex")).toBe(hexKey);
	});

	it("differs per purpose and per master key, and needs a 32-byte master key", () => {
		const masterKey = newMasterKey();
		const db = deriveHexKey(masterKey);
		expect(deriveHexKey(masterKey, "draftyak/v1/ext/sample")).not.toBe(db);
		expect(deriveHexKey(newMasterKey())).not.toBe(db);
		expect(() => deriveHexKey(masterKey.subarray(0, 31))).toThrow(RangeError);
		expect(() => deriveHexKey(masterKey, "")).toThrow(RangeError);
	});
});

describe("openEncrypted", () => {
	it("writes an encrypted file with §3's settings, which SQLite reports back", () => {
		const dir = tempDir();
		const key = newKey();
		const file = written(dir, key);
		const content = readFileSync(file);
		expect(content.length).toBeGreaterThanOrEqual(4096);
		expect(content.includes(SQLITE_HEADER)).toBe(false);
		// SQLite3MC leaves header bytes 16–23 readable: page size 4096, WAL (2, 2), and 32 bytes
		// reserved per page for chacha20's nonce and Poly1305 tag.
		expect([content.readUInt16BE(16), content[18], content[19], content[20]]).toEqual([
			4096, 2, 2, 32,
		]);
		const db = openEncrypted(file, key, binding());
		try {
			expect(readSettings(db)).toEqual(EXPECTED);
			expect(EXPECTED).toMatchObject({
				cipher: "chacha20",
				journalMode: "wal",
				synchronous: 2,
				recursiveTriggers: 1,
				tempStore: 2,
				autoVacuum: 2,
			});
		} finally {
			db.close();
		}
	});

	it("sets what this build leaves unsafe: NORMAL sync under WAL, files for temp data, no recursive triggers", () => {
		const dir = tempDir();
		const key = newKey();
		const file = written(dir, key);
		const keyedOnly = openDatabase(file, binding());
		try {
			keyDatabase(keyedOnly, key);
			expect(readSettings(keyedOnly)).toMatchObject({
				journalMode: "wal",
				synchronous: 1,
				recursiveTriggers: 0,
				tempStore: 0,
			});
		} finally {
			keyedOnly.close();
		}
		const db = openEncrypted(file, key, binding());
		try {
			addConversation(db, "conv-2");
			expect(readSettings(db)).toMatchObject({
				synchronous: 2,
				recursiveTriggers: 1,
				tempStore: 2,
			});
		} finally {
			db.close();
		}
	});

	it("refuses an empty file, which SQLite would key afresh after deleting the -wal beside it", () => {
		const dir = tempDir();
		const key = newKey();
		const source = path.join(dir, "source.db");
		const file = path.join(dir, "draftyak.db");
		const db = openEncrypted(source, key, binding(), { create: true });
		try {
			db.pragma("wal_autocheckpoint = 0");
			db.exec("CREATE TABLE notes (body TEXT NOT NULL) STRICT");
			db.prepare("INSERT INTO notes VALUES ('only in the wal')").run();
			copyFileSync(`${source}-wal`, `${file}-wal`);
		} finally {
			db.close();
		}
		writeFileSync(file, "");
		const wal = sha256File(`${file}-wal`);
		expect(thrown(() => openEncrypted(file, key, binding()))).toMatchObject({
			name: "DatabaseFileError",
			code: "ERR_DB_FILE",
			message: "draftyak.db is empty",
		});
		expect([statSync(file).size, sha256File(`${file}-wal`)]).toEqual([0, wal]);
		// What the check prevents: the first read finds no page and deletes the -wal.
		const unchecked = openDatabase(file, binding());
		try {
			keyDatabase(unchecked, newKey());
			expect(existsSync(`${file}-wal`)).toBe(false);
		} finally {
			unchecked.close();
		}
	});

	it("fails closed on a wrong key: PRAGMA hexkey says ok, the verify query throws SQLITE_NOTADB", () => {
		const dir = tempDir();
		const key = newKey();
		const file = written(dir, key);
		const before = sha256File(file);
		const db = openDatabase(file, binding());
		try {
			expect(db.pragma(`cipher = '${CIPHER}'`, { simple: true })).toBe(CIPHER);
			expect(db.pragma(`hexkey = '${newKey()}'`, { simple: true })).toBe("ok");
			// Preparing the query loads the schema, which is where the key is first used.
			const verify = () => db.prepare("SELECT count(*) FROM sqlite_master").pluck().get();
			expect(thrown(verify)).toMatchObject(NOTADB);
		} finally {
			db.close();
		}
		expect(thrown(() => openEncrypted(file, newKey(), binding()))).toMatchObject(NOTADB);
		// The failed open closed its connection (Windows can't rename an open file) and changed nothing.
		renameSync(file, `${file}.moved`);
		renameSync(`${file}.moved`, file);
		expect([sha256File(file), listDir(dir)]).toEqual([before, ["draftyak.db"]]);
		const reopened = openEncrypted(file, key, binding());
		try {
			const subject = reopened.prepare("SELECT subject FROM conversations").pluck().get();
			expect(subject).toBe("quarterly numbers");
		} finally {
			reopened.close();
		}
	});

	it("fails closed on a missing key, on another cipher and on a plaintext file", () => {
		const dir = tempDir();
		const key = newKey();
		const file = written(dir, key);
		const unkeyed = openDatabase(file, binding());
		try {
			const read = () => unkeyed.prepare("SELECT count(*) FROM sqlite_master").get();
			expect(thrown(read)).toMatchObject(NOTADB);
		} finally {
			unkeyed.close();
		}
		const otherCipher = openDatabase(file, binding());
		try {
			otherCipher.pragma("cipher = 'aes256cbc'");
			otherCipher.pragma(`hexkey = '${key}'`);
			const read = () => otherCipher.prepare("SELECT count(*) FROM sqlite_master").get();
			expect(thrown(read)).toMatchObject(NOTADB);
		} finally {
			otherCipher.close();
		}
		const plain = path.join(dir, "plain.db");
		const plaintext = openDatabase(plain, binding());
		try {
			plaintext.exec("CREATE TABLE t (x); INSERT INTO t VALUES ('not encrypted')");
		} finally {
			plaintext.close();
		}
		expect(thrown(() => openEncrypted(plain, key, binding()))).toMatchObject(NOTADB);
	});

	it("checks the key before SQL sees it, and creates a file only when asked", () => {
		const dir = tempDir();
		const file = path.join(dir, "draftyak.db");
		for (const bad of ["", "abc", newKey().toUpperCase(), `${newKey()}'; DROP TABLE x; --`]) {
			const open = () => openEncrypted(file, bad, binding(), { create: true });
			expect(thrown(open)).toBeInstanceOf(TypeError);
		}
		expect(thrown(() => openEncrypted(file, newKey(), binding()))).toMatchObject({
			name: "DatabaseFileError",
			code: "ERR_DB_FILE",
		});
		expect(existsSync(file)).toBe(false);
		// SQLite3MC keys only files: an in-memory database can't be encrypted.
		const memory = () => openEncrypted(":memory:", newKey(), binding(), { create: true });
		expect(thrown(memory)).toMatchObject({ code: "SQLITE_ERROR" });
	});

	it("opens with a raw key set through db.key(), the same sqlite3_key call as PRAGMA hexkey", () => {
		const dir = tempDir();
		const key = newKey();
		const file = written(dir, key);
		const db = openDatabase(file, binding());
		try {
			db.pragma(`cipher = '${CIPHER}'`);
			db.key(Buffer.from(key, "hex"));
			expect(db.prepare("SELECT count(*) FROM conversations").pluck().get()).toBe(1);
		} finally {
			db.close();
		}
	});
});
