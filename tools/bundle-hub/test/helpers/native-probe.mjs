import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

let phase = "load";
try {
	const [stage, directory] = process.argv.slice(2);
	assert(stage && directory);
	assert(process.execArgv.includes("--disable-sigusr1"));
	assert(Number(process.versions.napi) >= 10);
	const nativeRequire = createRequire(import.meta.url);
	const Database = nativeRequire(path.join(stage, "native/lib/index.js"));
	const key = Buffer.from(
		hkdfSync("sha256", randomBytes(32), new Uint8Array(0), "draftyak/v1/db", 32),
	).toString("hex");
	const wrong = Buffer.from(
		hkdfSync("sha256", randomBytes(32), new Uint8Array(0), "draftyak/v1/db", 32),
	).toString("hex");
	const file = path.join(directory, "state.sqlite");
	const kept = `DYTEST-kept-${randomBytes(16).toString("hex")}`;
	const deleted = `DYTEST-deleted-${randomBytes(16).toString("hex")}`;
	function open(hexKey, create = false) {
		const db = new Database(file, { fileMustExist: !create });
		try {
			db.pragma("cipher = 'chacha20'");
			db.pragma(`hexkey = '${hexKey}'`);
			db.prepare("SELECT count(*) FROM sqlite_master").pluck().get();
			db.pragma("temp_store = MEMORY");
			db.pragma("auto_vacuum = INCREMENTAL");
			db.pragma("journal_mode = WAL");
			db.pragma("synchronous = FULL");
			db.pragma("busy_timeout = 5000");
			db.pragma("foreign_keys = ON");
			db.pragma("recursive_triggers = ON");
			db.pragma("secure_delete = ON");
			db.pragma("trusted_schema = OFF");
			for (const [setting, expected] of Object.entries({
				cipher: "chacha20",
				journal_mode: "wal",
				synchronous: 2,
				busy_timeout: 5000,
				foreign_keys: 1,
				recursive_triggers: 1,
				secure_delete: 1,
				trusted_schema: 0,
				temp_store: 2,
				auto_vacuum: 2,
			}))
				assert.equal(db.pragma(setting, { simple: true }), expected);
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	}
	function scan() {
		for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
			if (!existsSync(candidate)) continue;
			const bytes = readFileSync(candidate);
			for (const needle of [kept, deleted, key, Buffer.from(key, "hex"), "SQLite format 3"])
				assert.equal(bytes.includes(Buffer.from(needle)), false);
		}
	}
	phase = "keyed-open";
	const db = open(key, true);
	try {
		const selected = `${process.platform}-${process.arch}`;
		assert.deepEqual(
			Object.keys(nativeRequire.cache)
				.filter((file) => file.endsWith(".node"))
				.map((file) => path.resolve(file)),
			[path.resolve(stage, `native/prebuilds/${selected}.node`)],
		);
		phase = "schema-and-query";
		db.transaction(() =>
			db.exec(
				"CREATE TABLE item(id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT; CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search(search,rank) VALUES('secure-delete',1);",
			),
		)();
		db.prepare("INSERT INTO item(body) VALUES (?)").run(kept);
		db.prepare("INSERT INTO search(rowid,body) VALUES (1,?)").run(kept);
		db.prepare("INSERT INTO search(rowid,body) VALUES (2,?)").run(deleted);
		db.exec("DELETE FROM search WHERE rowid=2");
		assert.equal(db.prepare("SELECT body FROM item").pluck().get(), kept);
		assert.equal(
			db
				.prepare("SELECT count(*) FROM search WHERE search MATCH ?")
				.pluck()
				.get(kept.split("-").at(-1)),
			1,
		);
		assert.equal(db.prepare("SELECT json_extract('{\"value\":7}', '$.value')").pluck().get(), 7);
		assert.equal(
			db.prepare("SELECT sqlite3mc_codec_data('cipher_salt','main') IS NOT NULL").pluck().get(),
			1,
		);
		assert.equal(db.pragma("wal_checkpoint(TRUNCATE)")[0].busy, 0);
		const pages = db.serialize();
		assert(pages.includes(Buffer.from(kept.slice(-16))));
		assert.equal(pages.includes(Buffer.from(deleted.slice(-16))), false);
		phase = "plaintext-scan";
		scan();
	} finally {
		db.close();
	}
	scan();
	phase = "reopen";
	const reopened = open(key);
	try {
		assert.equal(reopened.prepare("SELECT body FROM item").pluck().get(), kept);
	} finally {
		reopened.close();
	}
	phase = "wrong-key";
	let wrongKeyRefused = false;
	try {
		open(wrong).close();
	} catch (error) {
		wrongKeyRefused = error?.code === "SQLITE_NOTADB";
	}
	assert(wrongKeyRefused);
	scan();
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			version: process.versions.node,
			napi: Number(process.versions.napi),
			keyedRoundTrip: true,
			stagedAddon: true,
			deletedAbsent: true,
			wrongKeyRefused,
			plaintextAbsent: true,
			settings: true,
			fts5: true,
			json: true,
		})}\n`,
	);
} catch {
	process.stderr.write(`staged native keyed probe failed at ${phase}\n`);
	process.exitCode = 1;
}
