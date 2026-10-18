import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	truncateSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	canaryTail,
	leaks,
	type Needle,
	needles,
	newCanary,
	openTempFiles,
	SQLITE_HEADER,
	scanDatabase,
	scanFile,
} from "../src/canary.ts";
import { deriveHexKey, openEncrypted, readSettings, truncateWal } from "../src/db.ts";
import { migrationsDir } from "../src/migrator.ts";
import { openDatabase, type SqliteDatabase } from "../src/open.ts";
import {
	addConversation,
	addMessages,
	binding,
	coreDatabase,
	filler,
	ftsIntegrity,
	listDir,
	type Message,
	newMasterKey,
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

type Field = "subject" | "body" | "sender" | "conversation";
type Canaries = Readonly<Record<Field, string>>;

const newCanaries = (): Canaries => ({
	subject: newCanary(),
	body: newCanary(),
	sender: newCanary(),
	conversation: newCanary(),
});

const tails = (canaries: Partial<Canaries>): Needle[] =>
	needles(
		Object.fromEntries(
			Object.entries(canaries).map(([field, value]) => [field, canaryTail(value)]),
		),
	);

// The message carrying the canaries; the body's in capitals.
const canaryMessage = (canaries: Canaries): Message => ({
	id: "canary",
	subject: `Re: ${canaries.subject}`,
	body: `Totally ordinary words, then ${canaries.body.toUpperCase()} in capitals.`,
	sender: `${canaries.sender}@example.com`,
});

// One message carrying the canaries, among ordinary ones.
function addCanaryMessage(db: SqliteDatabase, canaries: Canaries): void {
	addConversation(db, "conv-1", canaries.conversation);
	addMessages(db, [...filler(20), canaryMessage(canaries), ...filler(20, 20)]);
}

// The canaries a deleted canary message leaves behind; its conversation stays.
const deletedTails = ({ subject, body, sender }: Canaries): Needle[] =>
	tails({ subject, body, sender });

const found = (scan: { found: readonly string[] } | undefined | null): string[] =>
	[...(scan?.found ?? [])].toSorted();

const inImage = (image: Uint8Array, look: readonly Needle[]): string[] =>
	[
		...new Set(look.filter(({ bytes }) => Buffer.from(image).includes(bytes)).map((n) => n.label)),
	].toSorted();

describe("the scanner", () => {
	it("finds the header and every canary in a plaintext database and its WAL", () => {
		const file = path.join(tempDir(), "plain.db");
		const canaries = newCanaries();
		const db = openDatabase(file, binding());
		try {
			db.pragma("journal_mode = WAL");
			db.pragma("wal_autocheckpoint = 0");
			db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, account_id TEXT, subject TEXT);
				CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT, conversation_id TEXT,
					sender TEXT, subject TEXT, body TEXT, sent_at INTEGER)`);
			addCanaryMessage(db, canaries);
			const scans = scanDatabase(file, tails(canaries));
			expect(scans.map(({ suffix }) => suffix)).toEqual(["", "-wal", "-shm"]);
			const wal = scans.find(({ suffix }) => suffix === "-wal");
			expect(wal?.header).toBe(true);
			expect(found(wal)).toEqual(["body", "conversation", "sender", "subject"]);
		} finally {
			db.close();
		}
		expect(scanFile(file, tails(canaries))).toMatchObject({ header: true });
		expect(scanFile(`${file}-missing`, [])).toBeNull();
	});
});

describe("an encrypted database", () => {
	it("leaves no header, canary or key bytes in the db, -wal and -shm, open or closed", async () => {
		const dir = tempDir();
		const file = path.join(dir, "draftyak.db");
		const masterKey = newMasterKey();
		const key = deriveHexKey(masterKey);
		const canaries = newCanaries();
		const look = [
			...tails(canaries),
			...needles({ masterKey, key: Buffer.from(key, "hex"), keyHex: key }),
		];
		const db = await coreDatabase(file, key);
		try {
			db.pragma("wal_autocheckpoint = 0");
			addCanaryMessage(db, canaries);
			// While open, the canaries sit in WAL frames and the FTS5 index; -shm holds the WAL index.
			const sizes = ["", "-wal", "-shm"].map((suffix) => statSync(`${file}${suffix}`).size);
			expect(sizes.every((size) => size > 0)).toBe(true);
			expect(scanDatabase(file, look).map(({ suffix }) => suffix)).toEqual(["", "-wal", "-shm"]);
			expect(leaks(scanDatabase(file, look))).toEqual([]);
			db.pragma("wal_checkpoint(TRUNCATE)");
			expect(leaks(scanDatabase(file, look))).toEqual([]);
			db.prepare("UPDATE messages SET body = body || ' edited' WHERE id = 'canary'").run();
			expect(leaks(scanDatabase(file, look))).toEqual([]);
			ftsIntegrity(db);
		} finally {
			db.close();
		}
		expect(listDir(dir)).toEqual(["draftyak.db"]);
		expect(leaks(scanDatabase(file, look))).toEqual([]);
	});

	// db.serialize() returns the decrypted pages: what a stolen key would reveal, free pages included.
	it("scrubs a deleted row from the decrypted pages only with secure_delete and FTS5 secure-delete", async () => {
		const run = async (secureDelete: boolean, ftsSecureDelete: boolean): Promise<string[]> => {
			const file = path.join(tempDir(), "draftyak.db");
			const canaries = newCanaries();
			const db = await coreDatabase(file, deriveHexKey(newMasterKey()));
			try {
				if (!secureDelete) db.pragma("secure_delete = OFF");
				if (!ftsSecureDelete) {
					db.exec("INSERT INTO fts_messages (fts_messages, rank) VALUES ('secure-delete', 0)");
				}
				addCanaryMessage(db, canaries);
				db.prepare("DELETE FROM messages WHERE id = 'canary'").run();
				truncateWal(db);
				ftsIntegrity(db);
				const image = db.serialize();
				expect(image.subarray(0, 16).equals(SQLITE_HEADER)).toBe(true);
				return inImage(image, deletedTails(canaries));
			} finally {
				db.close();
			}
		};
		expect(await run(true, true)).toEqual([]);
		expect(await run(false, true)).toEqual(["body", "sender", "subject"]);
		// Without FTS5's secure-delete, the delete marker in the index holds the deleted tokens.
		expect(await run(true, false)).toEqual(["body", "subject"]);
	});

	it("refuses an online backup, which better-sqlite3 would write to an unkeyed file", async () => {
		const dir = tempDir();
		const file = path.join(dir, "draftyak.db");
		const canaries = newCanaries();
		const db = await coreDatabase(file, deriveHexKey(newMasterKey()));
		try {
			addCanaryMessage(db, canaries);
			await expect(db.backup(path.join(dir, "backup.db"))).rejects.toMatchObject({
				code: "SQLITE_ERROR",
				message: "backup is not supported with incompatible source and target databases",
			});
		} finally {
			db.close();
		}
		const backup = scanFile(path.join(dir, "backup.db"), tails(canaries));
		expect(backup === null || (backup.bytes === 0 && leaks([backup]).length === 0)).toBe(true);
	});

	// Frames stay in the -wal, under the same key, after the pages they hold are deleted.
	it("keeps a deleted row in older -wal frames, through ordinary checkpoints, until truncateWal()", async () => {
		const dir = tempDir();
		const file = path.join(dir, "draftyak.db");
		const key = deriveHexKey(newMasterKey());
		const canaries = newCanaries();
		const db = await coreDatabase(file, key);
		try {
			db.pragma("wal_autocheckpoint = 0");
			truncateWal(db);
			addCanaryMessage(db, canaries);
			const insertEnd = statSync(`${file}-wal`).size;
			db.prepare("DELETE FROM messages WHERE id = 'canary'").run();
			// A copy of the files, its -wal cut where the insert's commit ends, opens under the key.
			const stolen = path.join(dir, "stolen.db");
			copyFileSync(file, stolen);
			copyFileSync(`${file}-wal`, `${stolen}-wal`);
			truncateSync(`${stolen}-wal`, insertEnd);
			const copy = openEncrypted(stolen, key, binding());
			try {
				const body = copy.prepare("SELECT body FROM messages WHERE id = 'canary'").pluck().get();
				expect(body).toContain(canaries.body.toUpperCase());
			} finally {
				copy.close();
			}
			const walBytes = statSync(`${file}-wal`).size;
			db.pragma("wal_checkpoint(PASSIVE)");
			expect(statSync(`${file}-wal`).size).toBe(walBytes);
			truncateWal(db);
			expect(statSync(`${file}-wal`).size).toBe(0);
			expect(inImage(db.serialize(), deletedTails(canaries))).toEqual([]);
			// A reader on an older snapshot keeps the WAL: truncateWal() throws instead of returning.
			const reader = openEncrypted(file, key, binding());
			try {
				addMessages(db, filler(1, 100));
				reader.exec("BEGIN");
				reader.prepare("SELECT count(*) FROM messages").get();
				db.pragma("busy_timeout = 0");
				expect(thrown(() => truncateWal(db))).toMatchObject({ code: "ERR_WAL_BUSY" });
				reader.exec("COMMIT");
				truncateWal(db);
			} finally {
				reader.close();
			}
		} finally {
			db.close();
		}
	});

	// The same in plaintext, where the bytes show: a checkpoint lets the next write restart the WAL
	// from its first frame, and the frames after what it writes stay.
	it("finds a deleted row's bytes in a plaintext control's -wal after checkpoints, until truncateWal()", () => {
		const file = path.join(tempDir(), "plain.db");
		const canaries = newCanaries();
		const look = deletedTails(canaries);
		const db = openDatabase(file, binding());
		try {
			for (const setting of [
				"journal_mode = WAL",
				"wal_autocheckpoint = 0",
				"secure_delete = ON",
			]) {
				db.pragma(setting);
			}
			const core = readFileSync(path.join(migrationsDir, "core", "0001_init.sql"), "utf8");
			db.transaction(() => db.exec(core))();
			addConversation(db, "conv-1", canaries.conversation);
			addMessages(db, filler(2_000));
			addMessages(db, [canaryMessage(canaries)]);
			db.pragma("wal_checkpoint(PASSIVE)");
			db.prepare("DELETE FROM messages WHERE id = 'canary'").run();
			db.pragma("wal_checkpoint(PASSIVE)");
			expect(found(scanFile(file, look))).toEqual([]);
			expect(found(scanFile(`${file}-wal`, look))).toEqual(["body", "sender", "subject"]);
			truncateWal(db);
			expect(statSync(`${file}-wal`).size).toBe(0);
		} finally {
			db.close();
		}
	});
});

describe("temporary files", () => {
	// SQLite3MC opens them with no file name, so with no codec: a sort that spills, a statement
	// journal, the TEMP database. Each is scanned while open: Windows and Linux are where it can be.
	it("hold plaintext on disk, which temp_store=MEMORY avoids", {
		tags: ["requires:temp-file-scan"],
	}, async () => {
		const dir = tempDir();
		mkdirSync(path.join(dir, "tmp"));
		const tmp = realpathSync(path.join(dir, "tmp"));
		const canaries = newCanaries();
		const look = tails(canaries);
		const db = await coreDatabase(path.join(dir, "draftyak.db"), deriveHexKey(newMasterKey()));
		try {
			db.pragma(`temp_store_directory = '${tmp.replaceAll("'", "''")}'`);
			// A sort spills once it outgrows the cache, though never below 1 MiB.
			db.pragma("cache_size = -256");
			const text = "the quick brown fox jumps over the lazy dog ".repeat(8);
			const bulk = (from: number, count: number): Message[] =>
				Array.from({ length: count }, (_, index) => ({
					id: `bulk-${from + index}`,
					subject: `weekly update ${from + index}`,
					body: `${text}${from + index}`,
				}));
			addConversation(db, "conv-1", canaries.conversation);
			addMessages(db, [...bulk(0, 100), canaryMessage(canaries), ...bulk(100, 5_900)]);
			const spilled = (): string[] => {
				const scans = (openTempFiles(tmp) ?? []).flatMap((file) => scanFile(file, look) ?? []);
				const hits = scans.flatMap((scan) => [...scan.found, ...(scan.header ? ["header"] : [])]);
				return [...new Set(hits)].toSorted();
			};
			const sorting = (): string[] => {
				const sorted = db.prepare("SELECT body FROM messages ORDER BY body").iterate();
				try {
					sorted.next();
					return spilled();
				} finally {
					sorted.return?.();
				}
			};
			const purging = (): string[] => {
				db.exec("BEGIN");
				try {
					const oldest = "SELECT seq FROM messages ORDER BY seq LIMIT 500";
					db.prepare(`DELETE FROM messages WHERE seq IN (${oldest})`).run();
					return spilled();
				} finally {
					db.exec("ROLLBACK");
				}
			};
			const copying = (): string[] => {
				db.exec("CREATE TEMP TABLE copied AS SELECT subject, body, sender FROM messages");
				try {
					return spilled();
				} finally {
					db.exec("DROP TABLE temp.copied");
				}
			};
			expect(readSettings(db).tempStore).toBe(2);
			expect([sorting(), purging(), copying(), openTempFiles(tmp)]).toEqual([[], [], [], []]);
			// The control: on disk, every one of them holds the canaries in plaintext.
			db.pragma("temp_store = FILE");
			db.pragma("temp.cache_size = 2");
			const plaintext = ["body", "header", "sender", "subject"];
			expect([sorting(), purging(), copying()]).toEqual([["body"], plaintext, plaintext]);
		} finally {
			db.pragma("temp_store_directory = ''");
			db.close();
		}
	});
});
