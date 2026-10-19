import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
	Dir,
	lstatSync,
	mkdirSync,
	opendirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3-multiple-ciphers";
import { MasterKey } from "../../../src/kernel/master-key.ts";
import { openEncrypted } from "../../../src/store/open.ts";

interface Scan {
	readonly files: number;
	readonly bytes: number;
	readonly hits: string[];
}
interface Operations {
	readonly sort: Scan;
	readonly statement: Scan;
	readonly table: Scan;
}
const root = process.argv[2];
const nativeBinding = process.argv[3];
let phase = "input";
let database: Database.Database | undefined;
let key: MasterKey | undefined;
let memory: Operations | undefined;
let file: Operations | undefined;
let failed = false;
const readDirectory = Dir.prototype.readSync;
const closeDirectory = Dir.prototype.closeSync;
try {
	assert.equal(process.argv.length, 4);
	assert(root && nativeBinding);
	assert(process.platform === "win32" || process.platform === "linux");
	assert(path.isAbsolute(root) && path.isAbsolute(nativeBinding));
	assert.equal(realpathSync(root), root);
	assert(path.basename(root).startsWith("draftyak-temp-store-"));
	assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
	assert.deepEqual(readdirSync(root), []);
	const tmp = path.join(root, "tmp");
	mkdirSync(tmp);
	const canaries = Object.fromEntries(
		["body", "sender", "subject"].map((label) => [
			label,
			`dytemp${randomBytes(8).toString("hex")}`,
		]),
	) as Record<"body" | "sender" | "subject", string>;
	const needles = Object.entries(canaries).flatMap(([label, text]) =>
		[...new Set([text, text.toUpperCase()])].map((value) => ({
			label,
			value: Buffer.from(value),
		})),
	);
	needles.push({ label: "header", value: Buffer.from("SQLite format 3\0", "latin1") });
	const raw = randomBytes(32);
	try {
		key = new MasterKey(raw);
	} finally {
		raw.fill(0);
	}
	phase = "open";
	database = openEncrypted(
		{ filename: path.join(root, "hub.db"), nativeBinding, create: true },
		key,
	);
	const db = database;
	db.pragma(`temp_store_directory = '${tmp.replaceAll("'", "''")}'`);
	db.pragma("cache_size = -256");
	db.exec(
		"CREATE TABLE records(seq INTEGER PRIMARY KEY,subject TEXT NOT NULL,body TEXT NOT NULL,sender TEXT NOT NULL) STRICT;" +
			"CREATE TRIGGER refuse_last_delete BEFORE DELETE ON records WHEN old.seq=6001 BEGIN SELECT RAISE(ABORT,'synthetic delete refusal'); END;",
	);
	const insert = db.prepare("INSERT INTO records(seq,subject,body,sender) VALUES(?,?,?,?)");
	const text = "the quick brown fox jumps over the lazy dog ".repeat(8);
	db.transaction(() => {
		for (let seq = 1; seq <= 6001; seq++) {
			const special = seq === 101;
			insert.run(
				seq,
				special ? canaries.subject : `weekly update ${seq}`,
				special ? `${text}${canaries.body.toUpperCase()}` : `${text}${seq}`,
				special ? `${canaries.sender}@example.com` : "sender@example.com",
			);
		}
	})();
	phase = "abort-control";
	assert.throws(
		() => db.prepare("DELETE FROM records WHERE seq=6001").run(),
		/synthetic delete refusal/,
	);

	const liveFiles = (): string[] => {
		if (process.platform === "win32") {
			const names = readdirSync(tmp);
			assert(names.length <= 32);
			return names.map((name) => {
				const target = path.join(tmp, name);
				const info = lstatSync(target);
				assert(info.isFile() && !info.isSymbolicLink());
				return target;
			});
		}
		assert.equal(process.platform, "linux");
		const result: string[] = [];
		// Hold this original directory iterator so its own listed descriptor cannot
		// disappear before readlink. No unresolved descriptor is treated as empty.
		const reader = opendirSync("/proc/self/fd");
		try {
			let count = 0;
			for (let entry = readDirectory.call(reader); entry; entry = readDirectory.call(reader)) {
				assert(++count <= 256 && /^\d+$/.test(entry.name));
				const target = `/proc/self/fd/${entry.name}`;
				const linked = readlinkSync(target);
				if (linked.startsWith(`${tmp}/`)) result.push(target);
			}
		} finally {
			closeDirectory.call(reader);
		}
		assert(result.length <= 32);
		return result;
	};
	const scan = (): Scan => {
		const files = liveFiles();
		const found = new Set<string>();
		let bytes = 0;
		for (const name of files) {
			const info = statSync(name);
			assert(info.isFile() && info.size <= 16 * 1024 * 1024);
			const content = readFileSync(name);
			assert(content.length <= 16 * 1024 * 1024);
			bytes += content.length;
			assert(bytes <= 64 * 1024 * 1024);
			for (const needle of needles) if (content.includes(needle.value)) found.add(needle.label);
		}
		return { files: files.length, bytes, hits: [...found].sort() };
	};
	const sort = (): Scan => {
		assert.deepEqual(liveFiles(), []);
		const rows = db.prepare("SELECT body FROM records ORDER BY body").iterate();
		try {
			assert.equal(rows.next().done, false);
			return scan();
		} finally {
			rows.return?.();
		}
	};
	const statement = (): Scan => {
		assert.deepEqual(liveFiles(), []);
		db.exec("BEGIN IMMEDIATE");
		try {
			// Possible trigger ABORT requires rollback of this multi-row statement.
			// RETURNING only seq keeps the statement live without spooling text canaries.
			const rows = db
				.prepare(
					"DELETE FROM records WHERE seq IN (SELECT seq FROM records ORDER BY seq LIMIT 500) RETURNING seq",
				)
				.iterate();
			try {
				assert.equal(rows.next().done, false);
				return scan();
			} finally {
				rows.return?.();
			}
		} finally {
			db.exec("ROLLBACK");
		}
	};
	const table = (): Scan => {
		assert.deepEqual(liveFiles(), []);
		db.exec("CREATE TEMP TABLE copied AS SELECT subject,body,sender FROM records");
		try {
			return scan();
		} finally {
			db.exec("DROP TABLE temp.copied");
		}
	};
	phase = "memory-setting";
	assert.equal(db.pragma("temp_store", { simple: true }), 2);
	phase = "memory-sort";
	const memorySort = sort();
	phase = "memory-statement";
	const memoryStatement = statement();
	phase = "memory-table";
	memory = { sort: memorySort, statement: memoryStatement, table: table() };
	for (const observed of Object.values(memory)) {
		assert.equal(observed.files, 0);
		assert.deepEqual(observed.hits, []);
	}
	assert.deepEqual(liveFiles(), []);
	phase = "file-setting";
	db.pragma("temp_store = FILE");
	db.pragma("temp.cache_size = 2");
	assert.equal(db.pragma("temp_store", { simple: true }), 1);
	phase = "file-sort";
	const fileSort = sort();
	phase = "file-statement";
	const fileStatement = statement();
	phase = "file-table";
	file = { sort: fileSort, statement: fileStatement, table: table() };
	phase = "file-positives";
	assert.deepEqual(file.sort.hits, ["body"]);
	for (const observed of [file.statement, file.table])
		assert.deepEqual(observed.hits, ["body", "header", "sender", "subject"]);
	for (const observed of Object.values(file)) assert(observed.files > 0 && observed.bytes > 0);
	assert.equal((db.prepare("SELECT count(*) AS n FROM records").get() as { n: number }).n, 6001);
	phase = "cleanup";
} catch {
	failed = true;
} finally {
	if (database) {
		try {
			database.pragma("temp_store_directory = ''");
		} catch {
			failed = true;
		}
		try {
			database.close();
			assert.equal(database.open, false);
		} catch {
			failed = true;
		}
	}
	key?.destroy();
}
if (failed) {
	process.stderr.write(JSON.stringify({ phase, refused: true, memory, file }));
	process.exitCode = 1;
} else
	process.stdout.write(JSON.stringify({ passed: true, platform: process.platform, memory, file }));
