import { createHash, randomBytes } from "node:crypto";
import fs, {
	chmodSync,
	copyFileSync,
	existsSync,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AuditEvent } from "@draftyak/protocol/entities/audit";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { moduleDatabaseFile, openModuleDatabase } from "../../src/extensions/database.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	DATABASE_FILE_SUFFIXES,
	flushDirectory,
	flushFile,
	removeDatabaseFiles,
	reserveExclusiveFile,
} from "../../src/store/durable-file.ts";
import { assertSettings, openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import {
	RotationError,
	type RotationErrorCode,
	type RotationFiles,
	type RotationMethod,
	type RotationOptions,
	rotateDatabaseFile,
	vacuumSourceInto,
	verifyRotatedFile,
} from "../../src/store/rotation.ts";
import { HubStore } from "../../src/store/store.ts";
import {
	addConversation,
	addMessages,
	canaryTail,
	filler,
	ftsDatabase,
	ftsIntegrity,
	inImage,
	leaks,
	needles,
	newCanary,
	scanDatabase,
	search,
} from "./fts-fixture.ts";
import { fixture, nativeBinding } from "./helpers.ts";

const METHODS: readonly RotationMethod[] = ["vacuum-into", "attach-copy"];
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

function tempDir(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-rotation-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}
const listDir = (dir: string): string[] => readdirSync(dir).toSorted();
const sha256 = (file: string): string =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const salt = (file: string): Buffer => readFileSync(file).subarray(0, 16);
const identity = (info: { dev: bigint; ino: bigint }): string => `${info.dev}:${info.ino}`;
const rows = (db: SqliteDatabase, sql: string): unknown[] => db.prepare(sql).all();
const thrown = (action: () => unknown): unknown => {
	try {
		action();
	} catch (error) {
		return error;
	}
	return undefined;
};

// A refusal carries its fixed code and nothing else: no path, key or SQLite message.
function refused(action: () => unknown, code: RotationErrorCode): void {
	const error = thrown(action);
	expect(error).toBeInstanceOf(RotationError);
	expect(error).toMatchObject({ code, message: `Database rotation failed: ${code}` });
	expect(Object.keys(error as object)).toEqual(["name", "code"]);
	expect((error as Error).cause).toBeUndefined();
}

interface Source {
	readonly dir: string;
	readonly file: string;
	readonly target: string;
	readonly from: MasterKey;
	readonly to: MasterKey;
	readonly fromBytes: Buffer;
	readonly toBytes: Buffer;
	readonly canary: string;
	readonly writer: SqliteDatabase;
}

// Objects attach-copy rebuilds besides the FTS5 namespace: a child table before its parent, a
// sequence, a generated column, a view and an FTS5 table that keeps its own content.
const EXTRAS = `
CREATE TABLE tags (id INTEGER PRIMARY KEY, label_id INTEGER NOT NULL REFERENCES labels (id)) STRICT;
CREATE TABLE labels (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
INSERT INTO labels VALUES (1, 'urgent');
INSERT INTO tags VALUES (1, 1);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  size INTEGER GENERATED ALWAYS AS (length(body)) VIRTUAL
) STRICT;
INSERT INTO notes (body) VALUES ('first note'), ('second note'), ('third note');
DELETE FROM notes WHERE id = 3;
CREATE VIEW recent_notes AS SELECT id, body FROM notes WHERE id > 1;
CREATE VIRTUAL TABLE fts_notes USING fts5 (body);
INSERT INTO fts_notes (rowid, body) VALUES (10, 'contentful row'), (20, 'another contentful row');
`;

// A migrated source whose last row is still only in its WAL, with the writer open.
async function withSource(use: (source: Source) => void | Promise<void>): Promise<void> {
	const dir = tempDir();
	const file = path.join(dir, "draftyak.db");
	const fromBytes = randomBytes(32),
		toBytes = randomBytes(32);
	const from = new MasterKey(fromBytes),
		to = new MasterKey(toBytes);
	const canary = newCanary();
	const writer = await ftsDatabase(file, from);
	try {
		addConversation(writer, "conv-1", "planning");
		addMessages(writer, filler(200));
		writer.prepare("DELETE FROM messages WHERE id IN ('msg-3', 'msg-4')").run();
		writer.exec(EXTRAS);
		writer.pragma("user_version = 7");
		writer.pragma("application_id = 1146704971");
		writer.pragma("wal_checkpoint(TRUNCATE)");
		writer.pragma("wal_autocheckpoint = 0");
		addMessages(writer, [{ id: "late", subject: "late arrival", body: `holds ${canary}` }]);
		const target = path.join(dir, "rotated.db");
		await use({ dir, file, target, from, to, fromBytes, toBytes, canary, writer });
	} finally {
		writer.close();
		from.destroy();
		to.destroy();
	}
}

const snapshot = (db: SqliteDatabase) => ({
	conversations: rows(db, "SELECT * FROM conversations ORDER BY id"),
	messages: rows(db, "SELECT * FROM messages ORDER BY seq"),
	tags: rows(db, "SELECT tags.id, name FROM tags JOIN labels ON labels.id = label_id"),
	notes: rows(db, "SELECT * FROM notes ORDER BY id"),
	view: rows(db, "SELECT * FROM recent_notes ORDER BY id"),
	sequence: rows(db, "SELECT * FROM sqlite_sequence"),
	migrations: rows(db, "SELECT name FROM _migrations_fts ORDER BY name"),
	schema: rows(db, "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name"),
	// A rebuilt index stays at FTS5 format 4 until its first secure delete.
	ftsConfig: rows(db, "SELECT k, v FROM fts_messages_config WHERE k <> 'version' ORDER BY k"),
	searches: ["fox", "late", "arrival"].map((term) => search(db, term)),
	notesSearch: rows(db, "SELECT rowid, body FROM fts_notes WHERE fts_notes MATCH 'contentful'"),
	versions: ["user_version", "application_id"].map((name) => db.pragma(name, { simple: true })),
});

// A keyed holder without the store's settings: full sync is off and ATTACH may create a file.
function directHolder(filename: string, key: MasterKey): SqliteDatabase {
	const db = new Database(filename, { nativeBinding });
	const bytes = key.derive("db");
	try {
		db.pragma("cipher = 'chacha20'");
		db.key(bytes);
		return db;
	} catch (error) {
		db.close();
		throw error;
	} finally {
		bytes.fill(0);
	}
}

describe("rotateDatabaseFile", () => {
	it("can't use VACUUM INTO with URI cipher parameters: this build reads the URI as a file name", async () => {
		await withSource(({ dir, target, to, writer }) => {
			const before = listDir(dir);
			const key = to.derive("db");
			try {
				const uri = `${pathToFileURL(target).href}?cipher=chacha20&hexkey=${key.toString("hex")}`;
				expect(thrown(() => writer.prepare("VACUUM INTO ?").run(uri))).toMatchObject({
					code: "SQLITE_CANTOPEN",
				});
			} finally {
				key.fill(0);
			}
			expect(listDir(dir)).toEqual(before);
		});
	});

	it.for(METHODS)(
		"%s refuses unavailable full-sync before reading a crash-left source",
		async (method) => {
			for (const disabled of ["fullfsync", "checkpoint_fullfsync"]) {
				await withSource(({ dir, file, target, from, to }) => {
					const crash = path.join(dir, "unavailable.db");
					copyFileSync(file, crash);
					copyFileSync(`${file}-wal`, `${crash}-wal`);
					const before = [sha256(crash), sha256(`${crash}-wal`)];
					const pragma = Database.prototype.pragma;
					const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
						this: SqliteDatabase,
						sql: string,
						options?: Database.PragmaOptions,
					) {
						if (this.name === ":memory:" && sql === `${disabled} = ON`) return [];
						return pragma.call(this, sql, options);
					});
					refused(
						() => rotateDatabaseFile({ source: crash, target, nativeBinding, from, to, method }),
						"copy",
					);
					expect([sha256(crash), sha256(`${crash}-wal`)]).toEqual(before);
					expect(existsSync(`${crash}-shm`)).toBe(false);
					expect(existsSync(target)).toBe(false);
					spy.mockRestore();
				});
			}
		},
	);

	it.for(METHODS)(
		"%s writes a new file that opens only under the new key and holds the same data",
		async (method) => {
			await withSource(({ dir, file, target, from, to, fromBytes, toBytes, canary, writer }) => {
				const expected = snapshot(writer);
				const sourceHash = sha256(file);
				rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
				expect(sha256(file)).toBe(sourceHash);
				expect(listDir(dir)).toEqual([
					"draftyak.db",
					"draftyak.db-shm",
					"draftyak.db-wal",
					"rotated.db",
				]);
				expect(salt(target).equals(salt(file))).toBe(false);
				expect(
					thrown(() => openEncrypted({ filename: target, nativeBinding }, from)),
				).toMatchObject({ code: "SQLITE_NOTADB" });
				const [fromKey, toKey] = [from.derive("db"), to.derive("db")];
				const look = needles({
					canary: canaryTail(canary),
					fromBytes,
					toBytes,
					fromKey,
					toKey,
					fromHex: fromKey.toString("hex"),
					toHex: toKey.toString("hex"),
				});
				expect(leaks(scanDatabase(target, look))).toEqual([]);
				const rotated = openEncrypted({ filename: target, nativeBinding }, to);
				try {
					expect(() => assertSettings(rotated)).not.toThrow();
					expect(snapshot(rotated)).toEqual(expected);
					ftsIntegrity(rotated);
					addMessages(rotated, [{ id: "after", subject: "post rotation", body: "new words" }]);
					expect(search(rotated, "rotation")).toHaveLength(1);
					rotated.prepare("DELETE FROM messages WHERE id = 'late'").run();
					expect(search(rotated, "late")).toEqual([]);
					ftsIntegrity(rotated);
					expect(
						rotated.prepare("INSERT INTO notes (body) VALUES ('next') RETURNING id").get(),
					).toEqual({ id: 4 });
				} finally {
					rotated.close();
				}
				expect(search(writer, "late")).toHaveLength(1);
			});
		},
	);

	it.for(METHODS)("%s fails closed and leaves the directory unchanged", async (method) => {
		await withSource(({ dir, file, target, from, to, fromBytes }) => {
			const before = listDir(dir);
			const attempt = (changes: Record<string, unknown>, code: RotationErrorCode): void => {
				const options = { source: file, target, nativeBinding, from, to, method, ...changes };
				refused(() => rotateDatabaseFile(options as RotationOptions), code);
				expect(listDir(dir)).toEqual(before);
			};
			const [wrong, same] = [new MasterKey(randomBytes(32)), new MasterKey(fromBytes)];
			try {
				attempt({ from: wrong }, "copy");
				attempt({ to: from }, "key");
				attempt({ to: same }, "key");
			} finally {
				wrong.destroy();
				same.destroy();
			}
			attempt({ source: path.join(dir, "missing.db") }, "source");
			// ATTACH would create a missing source, copy an empty one, and open a second name's own WAL.
			const other = path.join(dir, "other.db");
			for (const make of [
				() => writeFileSync(other, ""),
				() => mkdirSync(other),
				() => linkSync(file, other),
			]) {
				make();
				const [made, size] = [listDir(dir), statSync(other).size];
				refused(
					() => rotateDatabaseFile({ source: other, target, nativeBinding, from, to, method }),
					"source",
				);
				expect([listDir(dir), statSync(other).size]).toEqual([made, size]);
				rmSync(other, { recursive: true });
			}
			for (const suffix of ["", "-wal", "-shm", "-journal"]) {
				writeFileSync(`${target}${suffix}`, "kept");
				refused(
					() => rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method }),
					"target",
				);
				expect(readFileSync(`${target}${suffix}`, "utf8")).toBe("kept");
				rmSync(`${target}${suffix}`);
			}
			attempt({ target: file }, "path");
			for (const purpose of ["backup", "secrets", { toString: () => "ext/alpha" }])
				attempt({ purpose }, "key");
		});
	});

	it("refuses a target whose file or sidecar check fails with an error other than ENOENT", async () => {
		await withSource(({ dir, file, target, from, to }) => {
			const before = listDir(dir);
			const lstat = fs.lstatSync;
			let unreadable = "";
			vi.spyOn(fs, "lstatSync").mockImplementation((filename, options) => {
				if (String(filename) === unreadable)
					throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				return lstat(filename, options);
			});
			// The store modules import lstatSync by name.
			syncBuiltinESMExports();
			for (const method of METHODS)
				for (const suffix of ["", "-wal", "-shm", "-journal"]) {
					unreadable = `${target}${suffix}`;
					refused(
						() => rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method }),
						"target",
					);
					expect(listDir(dir)).toEqual(before);
				}
		});
	});

	it.for(METHODS)("%s refuses source sidecar aliases before opening a file", async (method) => {
		await withSource(({ dir, file, from, to }) => {
			const before = listDir(dir);
			for (const suffix of ["-wal", "-shm", "-journal"]) {
				const target = `${file}${suffix}`;
				const aliases =
					process.platform === "win32" || process.platform === "darwin"
						? [target, target.toUpperCase()]
						: [target];
				for (const alias of aliases)
					refused(
						() =>
							rotateDatabaseFile({ source: file, target: alias, nativeBinding, from, to, method }),
						"path",
					);
			}
			expect(listDir(dir)).toEqual(before);
		});
	});

	it.runIf(process.platform === "win32")(
		"refuses Windows trailing-dot and trailing-space aliases of either filename",
		async () => {
			await withSource(({ dir, file, target, from, to }) => {
				const before = listDir(dir);
				const hash = sha256(file);
				for (const method of METHODS) {
					for (const suffix of [".", " "]) {
						for (const paths of [
							{ source: `${file}${suffix}`, target },
							{ source: file, target: `${target}${suffix}` },
						])
							refused(
								() => rotateDatabaseFile({ ...paths, nativeBinding, from, to, method }),
								"path",
							);
					}
					refused(
						() =>
							rotateDatabaseFile({
								source: file,
								target: file.toUpperCase(),
								nativeBinding,
								from,
								to,
								method,
							}),
						"path",
					);
				}
				expect(listDir(dir)).toEqual(before);
				expect(sha256(file)).toBe(hash);
			});
		},
	);

	it.for(METHODS)("%s never removes the winner of an exclusive-create race", async (method) => {
		await withSource(({ dir, file, target, from, to }) => {
			const before = listDir(dir);
			const open = fs.openSync;
			let raced = false;
			vi.spyOn(fs, "openSync").mockImplementation((filename, flags, mode) => {
				if (filename === target && flags === "wx") {
					raced = true;
					writeFileSync(target, "other creator");
					writeFileSync(`${target}-wal`, "other sidecar");
				}
				return open(filename, flags, mode);
			});
			refused(
				() => rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method }),
				"target",
			);
			expect(raced).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("other creator");
			expect(readFileSync(`${target}-wal`, "utf8")).toBe("other sidecar");
			expect(listDir(dir)).toEqual([...before, "rotated.db", "rotated.db-wal"].toSorted());
		});
	});

	it.for(METHODS)("%s never removes a replacement target on failure", async (method) => {
		await withSource(({ file, target, from, to }) => {
			vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
				fs.unlinkSync(target);
				writeFileSync(target, "replacement");
				writeFileSync(`${target}-wal`, "replacement sidecar");
				throw new Error("flush failed");
			});
			refused(
				() => rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method }),
				"flush",
			);
			expect(readFileSync(target, "utf8")).toBe("replacement");
			expect(readFileSync(`${target}-wal`, "utf8")).toBe("replacement sidecar");
		});
	});

	it("refuses a symlinked source", { tags: ["requires:symlink-privilege"] }, async () => {
		await withSource(({ dir, file, target, from, to }) => {
			const link = path.join(dir, "link.db");
			symlinkSync(file, link, "file");
			const before = listDir(dir);
			for (const method of METHODS) {
				const options = { source: link, target, nativeBinding, from, to, method };
				refused(() => rotateDatabaseFile(options), "source");
				expect(listDir(dir)).toEqual(before);
			}
		});
	});

	it("refuses unusable options and keys before it touches a file", async () => {
		await withSource(({ dir, file, target, from, to }) => {
			const base = { source: file, target, nativeBinding, from, to };
			const before = listDir(dir);
			const destroyed = new MasterKey(randomBytes(32));
			destroyed.destroy();
			const cases: [unknown, RotationErrorCode][] = [
				[undefined, "path"],
				[new Proxy(base, {}), "path"],
				[{ ...base, source: "draftyak.db" }, "path"],
				[{ ...base, target: "rotation-relative.db" }, "path"],
				[{ ...base, nativeBinding: path.relative(process.cwd(), nativeBinding) }, "path"],
				[{ ...base, nativeBinding: nativeBinding.slice(0, -".node".length) }, "path"],
				[{ ...base, method: "vacuum-into-uri" }, "path"],
				[{ ...base, from: new Proxy(from, {}) }, "key"],
				[{ ...base, to: { derive: () => randomBytes(32) } }, "key"],
				[{ ...base, to: destroyed }, "key"],
			];
			for (const [options, code] of cases)
				refused(() => rotateDatabaseFile(options as RotationOptions), code);
			expect(listDir(dir)).toEqual(before);
			expect(existsSync(path.resolve("rotation-relative.db"))).toBe(false);
		});
	});

	it("reads each option once and derives keys only through MasterKey's own method", async () => {
		await withSource(({ file, target, from, to }) => {
			const reads: string[] = [];
			const values = {
				source: file,
				target,
				nativeBinding,
				from,
				to,
				purpose: "db",
				method: "attach-copy",
			};
			const options = Object.defineProperties(
				{},
				Object.fromEntries(
					Object.entries(values).map(([name, value]) => [
						name,
						{
							enumerable: true,
							get: () => {
								reads.push(name);
								return value;
							},
						},
					]),
				),
			);
			const sourceKey = from.derive("db");
			Object.defineProperty(to, "derive", { value: () => Buffer.from(sourceKey) });
			try {
				rotateDatabaseFile(options as RotationOptions);
			} finally {
				sourceKey.fill(0);
			}
			expect(reads.toSorted()).toEqual(Object.keys(values).toSorted());
			openEncrypted({ filename: target, nativeBinding }, to).close();
		});
	});

	it("gives the new file exactly mode 0600", { tags: ["requires:posix"] }, async () => {
		for (const method of METHODS)
			await withSource(({ file, target, from, to }) => {
				rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
				expect(statSync(target).mode & 0o777).toBe(0o600);
			});
	});

	it.for(METHODS)(
		"%s flushes the new file after the copy and after verification, then its directory",
		async (method) => {
			await withSource(({ dir, file, target, from, to }) => {
				const events: string[] = [];
				const fsync = fs.fsyncSync;
				vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
					const flushed = identity(fstatSync(descriptor, { bigint: true }));
					if (flushed === identity(lstatSync(target, { bigint: true }))) events.push("target");
					else if (flushed === identity(lstatSync(dir, { bigint: true }))) events.push("directory");
					else events.push("other");
					fsync(descriptor);
				});
				const pragma = Database.prototype.pragma;
				vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
					this: SqliteDatabase,
					source: string,
					options?: Database.PragmaOptions,
				) {
					if (source === "integrity_check") events.push("verify");
					return pragma.call(this, source, options);
				});
				rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
				const directory = process.platform === "win32" ? [] : ["directory"];
				expect(events).toEqual(["target", "verify", "target", ...directory]);
			});
		},
	);

	it.for(METHODS)("%s leaves no file behind when a step after the copy fails", async (method) => {
		await withSource(({ dir, file, target, from, to }) => {
			const before = listDir(dir);
			const options = { source: file, target, nativeBinding, from, to, method };
			const fsync = fs.fsyncSync;
			const spy = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
				throw new Error("flush failed");
			});
			refused(() => rotateDatabaseFile(options), "flush");
			expect(listDir(dir)).toEqual(before);
			spy.mockImplementation(fsync);
			const pragma = Database.prototype.pragma;
			const verification = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
				this: SqliteDatabase,
				sql: string,
				options?: Database.PragmaOptions,
			) {
				if (sql === "integrity_check") return "not ok";
				return pragma.call(this, sql, options);
			});
			refused(() => rotateDatabaseFile(options), "verify");
			expect(listDir(dir)).toEqual(before);
			verification.mockRestore();
			rotateDatabaseFile(options);
			expect(listDir(dir)).toEqual([...before, "rotated.db"].toSorted());
		});
	});

	it.for(METHODS)(
		"%s blocks a same-count racing UPDATE from before the copy through the final flush",
		async (method) => {
			await withSource(({ file, target, from, to, writer }) => {
				writer.pragma("busy_timeout = 0");
				const oldBody = writer.prepare("SELECT body FROM messages WHERE id = 'late'").pluck().get();
				const update = writer.prepare("UPDATE messages SET body = 'revoked' WHERE id = 'late'");
				const races: string[] = [];
				const race = (step: string): void => {
					const error = thrown(() => update.run()) as { code?: unknown } | undefined;
					races.push(`${step} ${error?.code}`);
				};
				// The copy attaches the source before reading it, and verification attaches it next.
				const prepare = Database.prototype.prepare;
				vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
					this: SqliteDatabase,
					sql: string,
				) {
					if (sql === "ATTACH ? AS source KEY ?" && this.name !== ":memory:") race("attach");
					return prepare.call(this, sql);
				});
				const fsync = fs.fsyncSync;
				vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
					if (
						identity(fstatSync(descriptor, { bigint: true })) ===
						identity(lstatSync(target, { bigint: true }))
					)
						race("flush");
					fsync(descriptor);
				});
				rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
				expect(races).toEqual(
					["attach", "flush", "attach", "flush"].map((step) => `${step} SQLITE_BUSY`),
				);
				const rotated = openEncrypted({ filename: target, nativeBinding }, to);
				try {
					expect(rotated.prepare("SELECT body FROM messages WHERE id = 'late'").pluck().get()).toBe(
						oldBody,
					);
				} finally {
					rotated.close();
				}
				expect(update.run().changes).toBe(1);
			});
		},
	);

	it.for(METHODS)(
		"%s checkpoints a crash-left WAL only through a full-sync final connection",
		async (method) => {
			await withSource(({ dir, file, from, to, writer }) => {
				const crash = path.join(dir, "crash.db");
				const target = path.join(dir, "recovered-rotation.db");
				const expected = snapshot(writer);
				copyFileSync(file, crash);
				copyFileSync(`${file}-wal`, `${crash}-wal`);
				expect(statSync(`${crash}-wal`).size).toBeGreaterThan(0);
				const before = sha256(crash);
				const closes: unknown[] = [];
				const close = Database.prototype.close;
				vi.spyOn(Database.prototype, "close").mockImplementation(function (this: SqliteDatabase) {
					if (this.name === ":memory:")
						closes.push({
							fullfsync: this.pragma("fullfsync", { simple: true }),
							checkpointFullfsync: this.pragma("checkpoint_fullfsync", { simple: true }),
							sourceSynchronous: this.pragma("source.synchronous", { simple: true }),
							inTransaction: this.inTransaction,
						});
					return close.call(this);
				});
				rotateDatabaseFile({ source: crash, target, nativeBinding, from, to, method });
				expect(closes).toEqual([
					{ fullfsync: 1, checkpointFullfsync: 1, sourceSynchronous: 2, inTransaction: false },
				]);
				expect(sha256(crash)).not.toBe(before);
				expect(existsSync(`${crash}-wal`)).toBe(false);
				const recovered = openEncrypted({ filename: crash, nativeBinding }, from);
				const rotated = openEncrypted({ filename: target, nativeBinding }, to);
				try {
					expect(snapshot(recovered)).toEqual(expected);
					expect(snapshot(rotated)).toEqual(expected);
				} finally {
					recovered.close();
					rotated.close();
				}
			});
		},
	);

	it.for(METHODS)("%s erases every derived key after success and failure", async (method) => {
		await withSource(({ dir, file, target, from, to, writer }) => {
			const keyed: Buffer[] = [],
				attached: Buffer[] = [];
			const key = Database.prototype.key;
			vi.spyOn(Database.prototype, "key").mockImplementation(function (
				this: SqliteDatabase,
				bytes: Buffer,
			) {
				keyed.push(bytes);
				return key.call(this, bytes);
			});
			const statement = Object.getPrototypeOf(writer.prepare("SELECT 1")) as {
				run(...values: unknown[]): unknown;
			};
			const run = statement.run;
			vi.spyOn(statement, "run").mockImplementation(function (this: unknown, ...values: unknown[]) {
				for (const value of values) if (Buffer.isBuffer(value)) attached.push(value);
				return run.apply(this, values);
			});
			rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
			const wrong = new MasterKey(randomBytes(32));
			const second = path.join(dir, "second.db");
			refused(
				() =>
					rotateDatabaseFile({
						source: file,
						target: second,
						nativeBinding,
						from: wrong,
						to,
						method,
					}),
				"copy",
			);
			wrong.destroy();
			expect([keyed.length, attached.length]).toEqual([3, 4]);
			for (const bytes of [...keyed, ...attached])
				expect(bytes.every((byte) => byte === 0)).toBe(true);
		});
	});

	it("runs VACUUM INTO from a keyed full-sync holder that keeps temporary data in memory", async () => {
		await withSource(({ file, target, from, to }) => {
			const states: unknown[] = [];
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: SqliteDatabase,
				sql: string,
			) {
				if (sql === "ATTACH ? AS source KEY ?" && this.name.endsWith(".keyholder"))
					states.push({
						tempStore: this.pragma("temp_store", { simple: true }),
						fullfsync: this.pragma("fullfsync", { simple: true }),
						checkpointFullfsync: this.pragma("checkpoint_fullfsync", { simple: true }),
						synchronous: this.pragma("synchronous", { simple: true }),
						keyed: prepare
							.call(this, "SELECT sqlite3mc_codec_data('cipher_salt', 'main') IS NOT NULL")
							.pluck()
							.get(),
					});
				return prepare.call(this, sql);
			});
			rotateDatabaseFile({ source: file, target, nativeBinding, from, to });
			expect(states).toEqual([
				{ tempStore: 2, fullfsync: 1, checkpointFullfsync: 1, synchronous: 2, keyed: 1 },
			]);
		});
	});

	it.for(METHODS)(
		"%s refuses unavailable full-sync settings before copy configuration or ATTACH",
		async (method) => {
			for (const disabled of ["fullfsync", "checkpoint_fullfsync"]) {
				await withSource(({ dir, file, target, from, to }) => {
					const before = listDir(dir);
					const writes: string[] = [];
					const attaches: string[] = [];
					const pragma = Database.prototype.pragma;
					vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
						this: SqliteDatabase,
						sql: string,
						options?: Database.PragmaOptions,
					) {
						const copy = this.name === target || this.name.endsWith(".keyholder");
						if (copy && sql === disabled && options?.simple) return 0;
						if (copy && sql === "journal_mode = WAL") writes.push(sql);
						return pragma.call(this, sql, options);
					});
					const prepare = Database.prototype.prepare;
					vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
						this: SqliteDatabase,
						sql: string,
					) {
						if (sql === "ATTACH ? AS source KEY ?" && this.name !== ":memory:") attaches.push(sql);
						return prepare.call(this, sql);
					});
					refused(
						() => rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method }),
						"copy",
					);
					expect(writes).toEqual([]);
					expect(attaches).toEqual([]);
					expect(listDir(dir)).toEqual(before);
					vi.restoreAllMocks();
				});
			}
		},
	);

	it.for(METHODS)(
		"%s refuses unconfirmed opening settings on a copy connection before ATTACH",
		async (method) => {
			await withSource(({ dir, file, target, from, to }) => {
				const before = listDir(dir);
				let unconfirmed: readonly [string, unknown] = ["", undefined];
				let attaches = 0;
				const pragma = Database.prototype.pragma;
				vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
					this: SqliteDatabase,
					sql: string,
					options?: Database.PragmaOptions,
				) {
					const copy = this.name === target || this.name.endsWith(".keyholder");
					if (copy && sql === unconfirmed[0] && options?.simple) return unconfirmed[1];
					return pragma.call(this, sql, options);
				});
				const prepare = Database.prototype.prepare;
				vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
					this: SqliteDatabase,
					sql: string,
				) {
					if (sql === "ATTACH ? AS source KEY ?" && this.name !== ":memory:") attaches++;
					return prepare.call(this, sql);
				});
				const options = { source: file, target, nativeBinding, from, to, method };
				for (const setting of [
					["journal_mode", "delete"],
					["synchronous", 1],
					["temp_store", 0],
					["trusted_schema", 1],
				] as const) {
					unconfirmed = setting;
					refused(() => rotateDatabaseFile(options), "copy");
					expect([attaches, listDir(dir)]).toEqual([0, before]);
				}
				unconfirmed = ["", undefined];
				rotateDatabaseFile(options);
				expect(attaches).toBe(2);
			});
		},
	);

	it.for(METHODS)(
		"%s confirms full-sync settings on every connection before ATTACH and keeps them until close",
		async (method) => {
			await withSource(({ file, target, from, to }) => {
				const states: unknown[] = [];
				const record = (db: SqliteDatabase, step: string): void => {
					const names = ["fullfsync", "checkpoint_fullfsync", "synchronous"];
					states.push([step, ...names.map((name) => db.pragma(name, { simple: true }))]);
				};
				const prepare = Database.prototype.prepare;
				vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
					this: SqliteDatabase,
					sql: string,
				) {
					if (sql === "ATTACH ? AS source KEY ?") record(this, "attach");
					return prepare.call(this, sql);
				});
				// Unrequested, a copy file's synchronous drops to the WAL default once it is written.
				const close = Database.prototype.close;
				vi.spyOn(Database.prototype, "close").mockImplementation(function (this: SqliteDatabase) {
					record(this, "close");
					return close.call(this);
				});
				rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
				vi.restoreAllMocks();
				expect(states).toEqual([
					["attach", 1, 1, 2],
					["attach", 1, 1, 2],
					["close", 1, 1, 2],
					["attach", 1, 1, 2],
					["close", 1, 1, 2],
					["close", 1, 1, 2],
				]);
			});
		},
	);

	it.for(METHODS)("%s refuses an unconfirmed source synchronous setting", async (method) => {
		await withSource(({ dir, file, target, from, to }) => {
			const before = listDir(dir);
			const pragma = Database.prototype.pragma;
			vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
				this: SqliteDatabase,
				sql: string,
				options?: Database.PragmaOptions,
			) {
				if (this.name === ":memory:" && sql === "source.synchronous" && options?.simple) return 1;
				return pragma.call(this, sql, options);
			});
			refused(
				() => rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method }),
				"copy",
			);
			expect(listDir(dir)).toEqual(before);
		});
	});

	it("vacuumSourceInto refuses an unkeyed holder, whose copy would be plaintext", async () => {
		await withSource(({ dir, file, from, canary }) => {
			const [kept, plain] = [path.join(dir, "kept.db"), path.join(dir, "plain.db")];
			const key = from.derive("db");
			const unkeyed = new Database(path.join(dir, "unkeyed.holder"), { nativeBinding });
			try {
				refused(() => vacuumSourceInto(unkeyed, file, key, kept), "copy");
				expect(existsSync(kept)).toBe(false);
				// What the check prevents: the same copy, run directly, is the source in plaintext.
				unkeyed.prepare("ATTACH ? AS source KEY ?").run(file, key);
				unkeyed.prepare("VACUUM source INTO ?").run(plain);
			} finally {
				unkeyed.close();
				key.fill(0);
			}
			expect(scanDatabase(plain, needles({ canary: canaryTail(canary) }))).toEqual([
				{ suffix: "", header: true, found: ["canary"] },
			]);
		});
	});

	it("vacuumSourceInto requests and confirms full sync on a direct holder before ATTACH", async () => {
		await withSource(({ dir, file, target, from, to }) => {
			const settings = (db: SqliteDatabase): unknown[] =>
				["fullfsync", "checkpoint_fullfsync"].map((name) => db.pragma(name, { simple: true }));
			const attached: unknown[] = [];
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: SqliteDatabase,
				sql: string,
			) {
				if (sql === "ATTACH ? AS source KEY ?") attached.push(settings(this));
				return prepare.call(this, sql);
			});
			let unavailable = "";
			const pragma = Database.prototype.pragma;
			vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
				this: SqliteDatabase,
				sql: string,
				options?: Database.PragmaOptions,
			) {
				if (sql === unavailable && options?.simple) return 0;
				return pragma.call(this, sql, options);
			});
			const key = from.derive("db");
			const copy = (name: string, check?: (holder: SqliteDatabase) => void): void => {
				const holder = directHolder(path.join(dir, name), to);
				try {
					check?.(holder);
					vacuumSourceInto(holder, file, key, target);
				} finally {
					holder.close();
				}
			};
			try {
				for (const name of ["fullfsync", "checkpoint_fullfsync"]) {
					unavailable = name;
					refused(() => copy(`${name}.holder`), "copy");
				}
				unavailable = "";
				expect([attached, existsSync(target)]).toEqual([[], false]);
				copy("direct.holder", (holder) => expect(settings(holder)).toEqual([0, 0]));
			} finally {
				key.fill(0);
			}
			expect(attached).toEqual([[1, 1]]);
			openEncrypted({ filename: target, nativeBinding }, to).close();
		});
	});

	it("vacuumSourceInto maps direct invalid input and native failures to copy", async () => {
		await withSource(({ dir, file, target, from, to }) => {
			const [missing, empty, linked] = ["missing.db", "empty.db", "linked.db"].map((name) =>
				path.join(dir, name),
			) as [string, string, string];
			writeFileSync(empty, "");
			const key = from.derive("db");
			let holders = 0;
			const copy = (source: string, sourceKey: unknown, destination: string) => () => {
				const holder = directHolder(path.join(dir, `${holders++}.holder`), to);
				try {
					vacuumSourceInto(holder, source, sourceKey as Buffer, destination);
				} finally {
					holder.close();
				}
			};
			try {
				// Each holder could ATTACH a missing or empty source, or the source's second name.
				for (const action of [
					copy(missing, key, target),
					copy(empty, key, target),
					copy(file, randomBytes(32), target),
					copy(file, key.subarray(0, 16), target),
					copy(file, key.toString("hex"), target),
					copy(file, key, "relative.db"),
					copy(file, key, `${file}-journal`),
					copy(file, key, path.join(dir, "missing-directory", "target.db")),
				])
					refused(action, "copy");
				linkSync(file, linked);
				refused(copy(linked, key, target), "copy");
				rmSync(linked);
			} finally {
				key.fill(0);
			}
			expect([existsSync(target), existsSync(missing), statSync(empty).size]).toEqual([
				false,
				false,
				0,
			]);
		});
	});

	it("attach-copy refuses another virtual table and rows that break a foreign key", async () => {
		const changes = [
			"CREATE VIRTUAL TABLE shapes USING rtree (id, min_x, max_x); INSERT INTO shapes VALUES (1, 0, 1);",
			"PRAGMA foreign_keys = OFF; INSERT INTO messages (id, conversation_id, sender, sent_at) VALUES ('orphan', 'missing', 'x', 1); PRAGMA foreign_keys = ON;",
		];
		for (const change of changes)
			await withSource(({ dir, file, target, from, to, writer }) => {
				writer.exec(change);
				const before = listDir(dir);
				const options = { source: file, target, nativeBinding, from, to };
				refused(() => rotateDatabaseFile({ ...options, method: "attach-copy" }), "copy");
				expect(listDir(dir)).toEqual(before);
				rotateDatabaseFile({ ...options, method: "vacuum-into" });
			});
	});

	it.for(METHODS)("%s rotates a closed hub store file and a module file", async (method) => {
		const f = await fixture();
		const to = new MasterKey(randomBytes(32));
		const [currentKey, nextKey] = [f.key.derive("audit"), to.derive("audit")];
		const [current, next] = [new AuditChain(currentKey), new AuditChain(nextKey)];
		currentKey.fill(0);
		nextKey.fill(0);
		const event: AuditEvent = {
			id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			at: 1,
			action: "hub.init",
			actor: { kind: "hub", id: null },
			refs: {},
		};
		const contents = (store: HubStore) =>
			store.read((db) => ({
				rows: db.all("SELECT * FROM test_rows ORDER BY id"),
				audit: db.all("SELECT * FROM audit_events ORDER BY seq"),
				head: db.all("SELECT * FROM audit_meta"),
			}));
		try {
			f.store.write((tx) => {
				tx.run("INSERT INTO test_rows VALUES (?, ?)", ["DYTEST-ROTATED-ROW", 7]);
				current.append(tx, event);
			});
			const expected = contents(f.store);
			f.store.close();
			const sourceHash = sha256(f.filename);
			const rotated = path.join(f.dir, "rotated.db");
			rotateDatabaseFile({
				source: f.filename,
				target: rotated,
				nativeBinding,
				from: f.key,
				to,
				method,
			});
			expect(sha256(f.filename)).toBe(sourceHash);
			const store = new HubStore({ filename: rotated, nativeBinding, masterKey: to });
			try {
				expect(contents(store)).toEqual(expected);
				// The chain is copied as written: re-keying it is master-key rotation's work.
				store.read((db) => current.verify(db));
				expect(() => store.read((db) => next.verify(db))).toThrow("verification");
			} finally {
				store.close();
			}

			const [moduleDir, rotatedDir] = [tempDir(), tempDir()];
			const migrations = [
				{
					name: "0001_rows.sql",
					sql: "CREATE TABLE ext_alpha_rows(id TEXT PRIMARY KEY, body TEXT, n INTEGER, total INTEGER GENERATED ALWAYS AS (n * 2) VIRTUAL) STRICT;",
				},
			];
			const open = (dataDirectory: string, masterKey: MasterKey) =>
				openModuleDatabase({ dataDirectory, nativeBinding, masterKey, id: "alpha", migrations });
			const original = await open(moduleDir, f.key);
			original.database.insert("ext_alpha_rows", { id: "a", body: "DYTEST-MODULE-ROW", n: 21 });
			expect(original.close()).toBe(true);
			rotateDatabaseFile({
				source: moduleDatabaseFile(moduleDir, "alpha"),
				target: moduleDatabaseFile(rotatedDir, "alpha"),
				nativeBinding,
				from: f.key,
				to,
				purpose: "ext/alpha",
				method,
			});
			const reopened = await open(rotatedDir, to);
			try {
				const selected = reopened.database.select("ext_alpha_rows", { limit: 10 });
				expect(selected.map((row) => ({ ...row }))).toEqual([
					{ id: "a", body: "DYTEST-MODULE-ROW", n: 21, total: 42 },
				]);
			} finally {
				reopened.close();
			}
			await expect(open(rotatedDir, f.key)).rejects.toThrow();
		} finally {
			f.store.close();
			current.destroy();
			next.destroy();
			f.key.destroy();
			to.destroy();
			rmSync(f.dir, { recursive: true, force: true });
		}
	});

	it.for(METHODS)(
		"%s leaves a deleted row behind, though older WAL frames of the source still hold it",
		async (method) => {
			const dir = tempDir();
			const [file, stolen, target] = ["draftyak.db", "stolen.db", "rotated.db"].map((name) =>
				path.join(dir, name),
			) as [string, string, string];
			const from = new MasterKey(randomBytes(32)),
				to = new MasterKey(randomBytes(32));
			const canaries = { subject: newCanary(), body: newCanary(), sender: newCanary() };
			const look = needles({
				subject: canaryTail(canaries.subject),
				body: canaryTail(canaries.body),
				sender: canaryTail(canaries.sender),
			});
			const db = await ftsDatabase(file, from);
			try {
				db.pragma("wal_autocheckpoint = 0");
				addConversation(db, "conv-1", "planning");
				db.pragma("wal_checkpoint(TRUNCATE)");
				addMessages(db, [
					...filler(20),
					{
						id: "canary",
						subject: `Re: ${canaries.subject}`,
						body: `Ordinary words, then ${canaries.body.toUpperCase()} in capitals.`,
						sender: `${canaries.sender}@example.com`,
					},
					...filler(20, 20),
				]);
				const insertEnd = statSync(`${file}-wal`).size;
				db.prepare("DELETE FROM messages WHERE id = 'canary'").run();
				copyFileSync(file, stolen);
				copyFileSync(`${file}-wal`, `${stolen}-wal`);
				truncateSync(`${stolen}-wal`, insertEnd);
				const copy = openEncrypted({ filename: stolen, nativeBinding }, from);
				try {
					expect(
						copy.prepare("SELECT count(*) FROM messages WHERE id = 'canary'").pluck().get(),
					).toBe(1);
					expect(inImage(copy.serialize(), look)).toEqual(["body", "sender", "subject"]);
				} finally {
					copy.close();
				}
				rotateDatabaseFile({ source: file, target, nativeBinding, from, to, method });
				const rotated = openEncrypted({ filename: target, nativeBinding }, to);
				try {
					expect(rotated.prepare("SELECT count(*) FROM messages").pluck().get()).toBe(40);
					expect(inImage(rotated.serialize(), look)).toEqual([]);
				} finally {
					rotated.close();
				}
			} finally {
				db.close();
				from.destroy();
				to.destroy();
			}
		},
	);
});

describe("verifyRotatedFile", () => {
	// Two indexes on one table trade b-trees: schema text and row counts stay the same.
	function swapIndexes(file: string, key: MasterKey): void {
		const db = new Database(file, { nativeBinding, fileMustExist: true });
		const bytes = key.derive("db");
		try {
			db.pragma("cipher = 'chacha20'");
			db.key(bytes);
			db.unsafeMode(true);
			const roots = db
				.prepare(
					"SELECT name, rootpage FROM sqlite_schema WHERE tbl_name = 'messages' AND type = 'index' ORDER BY name",
				)
				.all() as { name: string; rootpage: number }[];
			const [first, second] = roots;
			if (!first || !second) throw new Error("Two indexes are required");
			db.pragma("writable_schema = ON");
			const update = db.prepare("UPDATE sqlite_schema SET rootpage = ? WHERE name = ?");
			update.run(second.rootpage, first.name);
			update.run(first.rootpage, second.name);
			db.pragma("writable_schema = OFF");
		} finally {
			db.close();
			bytes.fill(0);
		}
	}

	it("refuses a file that fails an integrity check or differs from the source in schema, row counts, header values or sqlite_sequence", async () => {
		await withSource(({ dir, file, from, to }) => {
			const files = (target: string) =>
				({ source: file, target, nativeBinding, from, to, purpose: "db" }) as const;
			const rotated = (name: string, change?: (target: string) => void): string => {
				const target = path.join(dir, name);
				rotateDatabaseFile(files(target));
				change?.(target);
				return target;
			};
			const edit = (sql: string) => (target: string) => {
				const db = openEncrypted({ filename: target, nativeBinding }, to);
				try {
					db.exec(sql);
				} finally {
					db.close();
				}
			};
			expect(() => verifyRotatedFile(files(rotated("same.db")))).not.toThrow();
			for (const target of [
				rotated("corrupt.db", (file) => swapIndexes(file, to)),
				rotated("fewer.db", edit("DELETE FROM notes WHERE id = 1")),
				rotated("indexed.db", edit("CREATE INDEX messages_sender ON messages (sender)")),
				rotated("extra.db", edit("CREATE TABLE extra (x TEXT) STRICT")),
				rotated(
					"fts-empty.db",
					edit("INSERT INTO fts_messages (fts_messages) VALUES ('delete-all')"),
				),
				rotated("fts-content.db", edit("DELETE FROM fts_notes WHERE rowid = 10")),
				rotated("user-version.db", edit("PRAGMA user_version = 99")),
				rotated("application-id.db", edit("PRAGMA application_id = 99")),
				rotated("sequence-empty.db", edit("DELETE FROM sqlite_sequence")),
				rotated("sequence-changed.db", edit("UPDATE sqlite_sequence SET seq = 99")),
			])
				refused(() => verifyRotatedFile(files(target)), "verify");
		});
	});

	it("maps direct invalid input, file failures and wrong target keys to verify", async () => {
		await withSource(({ dir, file, target, from, to, writer }) => {
			const files = { source: file, target, nativeBinding, from, to, purpose: "db" } as const;
			rotateDatabaseFile(files);
			for (const input of [
				undefined,
				new Proxy(files, {}),
				{ ...files, source: path.join(dir, "missing.db") },
				{ ...files, source: target, target: file },
				{ ...files, target: path.join(dir, "missing-target.db") },
				{ ...files, target: "relative.db" },
				{ ...files, target: `${file}-journal` },
				{ ...files, nativeBinding: "missing.node" },
				{ ...files, purpose: "invalid" },
				{ ...files, to: from },
			])
				refused(() => verifyRotatedFile(input as RotationFiles), "verify");
			expect(existsSync(path.join(dir, "missing.db"))).toBe(false);
			expect(existsSync(path.join(dir, "missing-target.db"))).toBe(false);
			// After a checkpoint, a second name shows every row: only the source check refuses it.
			writer.pragma("wal_checkpoint(TRUNCATE)");
			const linked = path.join(dir, "linked.db");
			linkSync(file, linked);
			refused(() => verifyRotatedFile({ ...files, source: linked }), "verify");
			rmSync(linked);
			expect(() => verifyRotatedFile(files)).not.toThrow();
		});
	});

	it("refuses a file that keeps the source's salt or opens under the old key", async () => {
		await withSource(({ dir, file, from, to, writer }) => {
			// Why rotation writes a new file: PRAGMA rekey in place under WAL keeps the cipher salt.
			writer.pragma("wal_checkpoint(TRUNCATE)");
			const rekeyed = path.join(dir, "rekeyed.db");
			copyFileSync(file, rekeyed);
			const db = openEncrypted({ filename: rekeyed, nativeBinding }, from);
			const key = to.derive("db");
			try {
				db.rekey(key);
				db.pragma("wal_checkpoint(TRUNCATE)");
			} finally {
				db.close();
				key.fill(0);
			}
			expect(salt(rekeyed)).toEqual(salt(file));
			expect(thrown(() => openEncrypted({ filename: rekeyed, nativeBinding }, from))).toMatchObject(
				{
					code: "SQLITE_NOTADB",
				},
			);
			openEncrypted({ filename: rekeyed, nativeBinding }, to).close();
			const files = { source: file, nativeBinding, from, to, purpose: "db" } as const;
			refused(() => verifyRotatedFile({ ...files, target: rekeyed }), "verify");

			const [forth, back] = [path.join(dir, "forth.db"), path.join(dir, "back.db")];
			rotateDatabaseFile({ ...files, target: forth });
			const returned = { ...files, source: forth, target: back, from: to, to: from };
			rotateDatabaseFile(returned);
			expect(() => verifyRotatedFile(returned)).not.toThrow();
			// Checked as the source's rotation from `from` to `from`, back still opens under the old key.
			refused(() => verifyRotatedFile({ ...files, target: back, to: from }), "verify");
		});
	});

	it("accepts only SQLITE_NOTADB as proof that the old key fails", async () => {
		await withSource(({ file, target, from, to }) => {
			const files = { source: file, target, nativeBinding, from, to, purpose: "db" } as const;
			rotateDatabaseFile(files);
			const oldKey = from.derive("db");
			const key = Database.prototype.key;
			vi.spyOn(Database.prototype, "key").mockImplementation(function (
				this: SqliteDatabase,
				bytes: Buffer,
			) {
				if (bytes.equals(oldKey)) throw new Error("Database is busy");
				return key.call(this, bytes);
			});
			try {
				refused(() => verifyRotatedFile(files), "verify");
			} finally {
				oldKey.fill(0);
			}
			vi.restoreAllMocks();
			expect(() => verifyRotatedFile(files)).not.toThrow();
		});
	});
});

describe("durable files", () => {
	it("keeps the database suffix list immutable", () => {
		expect(Object.isFrozen(DATABASE_FILE_SUFFIXES)).toBe(true);
		expect(Reflect.set(DATABASE_FILE_SUFFIXES, "length", 0)).toBe(false);
		expect(DATABASE_FILE_SUFFIXES).toEqual(["", "-wal", "-shm", "-journal"]);
	});

	it("reserves an empty file under a new name only", () => {
		const dir = tempDir();
		const file = path.join(dir, "reserved.db");
		reserveExclusiveFile(file);
		expect(statSync(file).size).toBe(0);
		writeFileSync(file, "kept");
		expect(() => reserveExclusiveFile(file)).toThrow();
		expect(readFileSync(file, "utf8")).toBe("kept");
	});

	it("removes a reservation that gained another name or bytes before its check", () => {
		const dir = tempDir();
		const open = fs.openSync;
		const races = [
			(file: string) => linkSync(file, `${file}.link`),
			(_file: string, descriptor: number) => writeSync(descriptor, "x"),
		];
		for (const [index, race] of races.entries()) {
			const file = path.join(dir, `${index}.db`);
			let descriptor = -1;
			vi.spyOn(fs, "openSync").mockImplementationOnce((name, flags, mode) => {
				descriptor = open(name, flags, mode);
				race(file, descriptor);
				return descriptor;
			});
			const close = vi.spyOn(fs, "closeSync");
			expect(() => reserveExclusiveFile(file)).toThrow("File reservation unavailable");
			expect(close).toHaveBeenCalledWith(descriptor);
			vi.restoreAllMocks();
		}
		expect(listDir(dir)).toEqual(["0.db.link"]);
	});

	it("reserves exactly mode 0600 and removes a reservation whose mode changed", {
		tags: ["requires:posix"],
	}, () => {
		const dir = tempDir();
		const [kept, changed] = [path.join(dir, "kept.db"), path.join(dir, "changed.db")];
		reserveExclusiveFile(kept);
		expect(statSync(kept).mode & 0o777).toBe(0o600);
		const open = fs.openSync;
		vi.spyOn(fs, "openSync").mockImplementationOnce((name, flags, mode) => {
			const descriptor = open(name, flags, mode);
			chmodSync(changed, 0o640);
			return descriptor;
		});
		expect(() => reserveExclusiveFile(changed)).toThrow("File reservation unavailable");
		expect(listDir(dir)).toEqual(["kept.db"]);
	});

	it("flushes a file through its own descriptor and closes it when the flush fails", () => {
		const dir = tempDir();
		const file = path.join(dir, "flushed.db");
		writeFileSync(file, "data");
		const flushed: string[] = [];
		const fsync = fs.fsyncSync;
		const spy = vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
			flushed.push(identity(fstatSync(descriptor, { bigint: true })));
			fsync(descriptor);
		});
		flushFile(file);
		expect(flushed).toEqual([identity(lstatSync(file, { bigint: true }))]);
		const close = vi.spyOn(fs, "closeSync");
		spy.mockImplementationOnce(() => {
			throw new Error("flush failed");
		});
		expect(() => flushFile(file)).toThrow("flush failed");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("flushes a directory on POSIX and leaves it to the file system on Windows", () => {
		const dir = tempDir();
		const flushed: string[] = [];
		const fsync = fs.fsyncSync;
		vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
			flushed.push(identity(fstatSync(descriptor, { bigint: true })));
			fsync(descriptor);
		});
		flushDirectory(dir);
		const expected = identity(lstatSync(dir, { bigint: true }));
		expect(flushed).toEqual(process.platform === "win32" ? [] : [expected]);
	});

	it("removes a database file and its regular sidecars, past a failed removal and never through a link", () => {
		const dir = tempDir();
		const file = path.join(dir, "draftyak.db");
		const elsewhere = path.join(dir, "elsewhere");
		mkdirSync(elsewhere);
		for (const suffix of ["", "-wal", "-shm"]) writeFileSync(`${file}${suffix}`, "x");
		symlinkSync(elsewhere, `${file}-journal`, "junction");
		vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
			throw new Error("busy");
		});
		removeDatabaseFiles(file);
		expect(listDir(dir)).toEqual(["draftyak.db", "draftyak.db-journal", "elsewhere"]);
		removeDatabaseFiles(file);
		expect(listDir(dir)).toEqual(["draftyak.db-journal", "elsewhere"]);
	});
});
