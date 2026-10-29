import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statfsSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { HubStore, type SqlTransaction, type SqlValue } from "../../src/store/store.ts";
import { nativeBinding } from "./helpers.ts";

// ADR 0002's FTS5 fixture: external content kept in step by triggers, with FTS5 secure-delete on.
const SCHEMA = `CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sent_at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_conversation ON messages (conversation_id, sent_at);
CREATE VIRTUAL TABLE fts_messages USING fts5 (
  subject,
  body,
  content = 'messages',
  content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO fts_messages (fts_messages, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO fts_messages (rowid, subject, body) VALUES (new.seq, new.subject, new.body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO fts_messages (fts_messages, rowid, subject, body)
  VALUES ('delete', old.seq, old.subject, old.body);
END;
CREATE TRIGGER messages_au AFTER UPDATE OF seq, subject, body ON messages BEGIN
  INSERT INTO fts_messages (fts_messages, rowid, subject, body)
  VALUES ('delete', old.seq, old.subject, old.body);
  INSERT INTO fts_messages (rowid, subject, body) VALUES (new.seq, new.subject, new.body);
END;`;
const INSERT_MESSAGE =
	"INSERT INTO messages (id, conversation_id, sender, subject, body, sent_at) VALUES (?, 'conv-1', ?, ?, ?, ?)";
const DELETE_CANARY = "DELETE FROM messages WHERE id = 'canary'";

type Canaries = Readonly<Record<"subject" | "body" | "sender" | "conversation", string>>;
type Run = (sql: string, values?: readonly SqlValue[]) => void;
type Checkpoint = { busy: number; log: number; checkpointed: number };

const canary = (): string => `dycanary${randomBytes(8).toString("hex")}`;
const newCanaries = (): Canaries => ({
	subject: canary(),
	body: canary(),
	sender: canary(),
	conversation: canary(),
});
// A deleted message takes these with it; its conversation stays.
const deleted = ({ subject, body, sender }: Canaries) => ({ subject, body, sender });

// FTS5 stores a term as the bytes after the prefix it shares with the term before it, so each
// canary is looked for by its random 12-character tail, in either case.
function found(bytes: Buffer, canaries: Readonly<Record<string, string>>): string[] {
	return Object.entries(canaries)
		.filter(([, value]) => {
			const tail = value.slice(-12);
			return bytes.includes(tail) || bytes.includes(tail.toUpperCase());
		})
		.map(([field]) => field)
		.toSorted();
}

const nativeRun =
	(db: SqliteDatabase): Run =>
	(sql, values = []) => {
		db.prepare(sql).run(...values);
	};
const storeRun =
	(tx: SqlTransaction): Run =>
	(sql, values = []) => {
		tx.run(sql, values);
	};

function addConversation(run: Run, canaries: Canaries): void {
	run("INSERT INTO conversations (id, account_id, subject) VALUES ('conv-1', 'gmail-1', ?)", [
		canaries.conversation,
	]);
}

function addFiller(run: Run, from: number, count: number): void {
	for (let n = from; n < from + count; n++)
		run(INSERT_MESSAGE, [
			`msg-${n}`,
			"sender@example.com",
			`weekly update ${n}`,
			`the quick brown fox jumps over the lazy dog, item ${n}`,
			1_760_000_000 + n,
		]);
}

function addCanary(run: Run, canaries: Canaries): void {
	run(INSERT_MESSAGE, [
		"canary",
		`${canaries.sender}@example.com`,
		`Re: ${canaries.subject}`,
		`Totally ordinary words, then ${canaries.body.toUpperCase()} in capitals.`,
		1_760_000_000,
	]);
}

// One message carrying the canaries, among ordinary ones.
function addCanaryMessage(run: Run, canaries: Canaries): void {
	addConversation(run, canaries);
	addFiller(run, 0, 20);
	addCanary(run, canaries);
	addFiller(run, 20, 20);
}

interface Content {
	readonly dir: string;
	readonly filename: string;
	readonly store: HubStore;
	// Another connection through the hub's opener; the fixture closes it if it is still open.
	connect(filename?: string): SqliteDatabase;
}

async function withContent<T>(test: (content: Content) => T): Promise<T> {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-deleted-"));
	const migrations = path.join(dir, "content");
	const filename = path.join(dir, "draftyak.db");
	const key = new MasterKey(randomBytes(32));
	const connections: SqliteDatabase[] = [];
	let store: HubStore | undefined;
	try {
		mkdirSync(migrations);
		writeFileSync(path.join(migrations, "0001_messages.sql"), SCHEMA);
		store = new HubStore({
			filename,
			nativeBinding,
			masterKey: key,
			create: true,
			migrations: { content: migrations },
		});
		await store.migrate("content");
		const connect = (target = filename): SqliteDatabase => {
			const db = openEncrypted({ filename: target, nativeBinding }, key);
			connections.push(db);
			return db;
		};
		return test({ dir, filename, store, connect });
	} finally {
		try {
			for (const db of connections) if (db.open) db.close();
			store?.close();
		} finally {
			key.destroy();
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

// serialize() returns the decrypted pages, free ones included: what the key would reveal.
function pages({ connect }: Content): Buffer {
	const db = connect();
	try {
		const image = db.serialize();
		expect(image.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
		return image;
	} finally {
		db.close();
	}
}

function deletedFromPages(variant: "production" | "secure_delete=OFF" | "FTS5 secure-delete=0") {
	return withContent((content) => {
		const { filename, store } = content;
		const canaries = newCanaries();
		if (variant === "secure_delete=OFF") {
			const writer = content.connect();
			writer.pragma("secure_delete = OFF");
			writer.transaction(() => addCanaryMessage(nativeRun(writer), canaries))();
			nativeRun(writer)(DELETE_CANARY);
		} else {
			store.write((tx) => {
				if (variant === "FTS5 secure-delete=0")
					tx.run("INSERT INTO fts_messages (fts_messages, rank) VALUES ('secure-delete', 0)");
				addCanaryMessage(storeRun(tx), canaries);
			});
			store.write((tx) => tx.run(DELETE_CANARY));
		}
		store.write((tx) =>
			tx.run("INSERT INTO fts_messages (fts_messages, rank) VALUES ('integrity-check', 1)"),
		);
		store.checkpoint();
		expect(statSync(`${filename}-wal`).size).toBe(0);
		const image = pages(content);
		expect(found(image, { conversation: canaries.conversation })).toEqual(["conversation"]);
		return found(image, deleted(canaries));
	});
}

it("scrubs a deleted message from the decrypted pages only with both secure-delete settings", async () => {
	expect(await deletedFromPages("production")).toEqual([]);
	expect(await deletedFromPages("secure_delete=OFF")).toEqual(["body", "sender", "subject"]);
	// Without FTS5's secure-delete, the index keeps the deleted tokens.
	expect(await deletedFromPages("FTS5 secure-delete=0")).toEqual(["body", "subject"]);
});

it("keeps a deleted row in older -wal frames through a PASSIVE checkpoint until HubStore.checkpoint()", async () => {
	await withContent((content) => {
		const { dir, filename, store, connect } = content;
		const wal = `${filename}-wal`;
		const canaries = newCanaries();
		store.checkpoint();
		expect(statSync(wal).size).toBe(0);
		store.write((tx) => addCanaryMessage(storeRun(tx), canaries));
		const insertEnd = statSync(wal).size;
		store.write((tx) => tx.run(DELETE_CANARY));
		expect(statSync(wal).size).toBeGreaterThan(insertEnd);
		// A copy of the files, its -wal cut where the insert's commit ends, opens with the row back.
		const stolen = path.join(dir, "stolen.db");
		copyFileSync(filename, stolen);
		copyFileSync(wal, `${stolen}-wal`);
		truncateSync(`${stolen}-wal`, insertEnd);
		const copy = connect(stolen);
		expect(copy.prepare("SELECT body FROM messages WHERE id = 'canary'").pluck().get()).toContain(
			canaries.body.toUpperCase(),
		);
		copy.close();
		// Opening rewrites page 1 (auto_vacuum), so the -wal is read after the open.
		const other = connect();
		const frames = readFileSync(wal);
		const [passive] = other.pragma("wal_checkpoint(PASSIVE)") as Checkpoint[];
		other.close();
		expect(passive?.log).toBeGreaterThan(0);
		expect(passive).toEqual({ busy: 0, log: passive?.log, checkpointed: passive?.log });
		expect(readFileSync(wal).equals(frames)).toBe(true);
		store.checkpoint();
		expect(statSync(wal).size).toBe(0);
		expect(found(pages(content), deleted(canaries))).toEqual([]);
	});
});

it("refuses to truncate the -wal while a reader holds an older snapshot, then truncates once it ends", async () => {
	await withContent((content) => {
		const { filename, store, connect } = content;
		const canaries = newCanaries();
		store.write((tx) => addCanaryMessage(storeRun(tx), canaries));
		const reader = connect();
		reader.exec("BEGIN");
		const body = reader.prepare("SELECT body FROM messages WHERE id = 'canary'").pluck();
		expect(body.get()).toContain(canaries.body.toUpperCase());
		store.write((tx) => tx.run(DELETE_CANARY));
		const started = performance.now();
		expect(() => store.checkpoint()).toThrow("Database checkpoint is busy");
		// SQLite retries for the whole 5000 ms busy_timeout before it reports the reader.
		expect(performance.now() - started).toBeGreaterThanOrEqual(4_500);
		expect(body.get()).toContain(canaries.body.toUpperCase());
		expect(statSync(`${filename}-wal`).size).toBeGreaterThan(0);
		reader.exec("COMMIT");
		store.checkpoint();
		expect(statSync(`${filename}-wal`).size).toBe(0);
		expect(found(pages(content), deleted(canaries))).toEqual([]);
	});
});

// In plaintext the bytes show: a checkpoint lets the next write restart the -wal from its first
// frame, and the frames after what that write covers stay.
it("finds a deleted row in a plaintext control's -wal after PASSIVE checkpoints until TRUNCATE", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-deleted-"));
	const file = path.join(dir, "plain.db");
	const canaries = newCanaries();
	try {
		const db = new Database(file, { nativeBinding });
		try {
			for (const setting of ["journal_mode = WAL", "wal_autocheckpoint = 0", "secure_delete = ON"])
				db.pragma(setting);
			const run = nativeRun(db);
			db.transaction(() => db.exec(SCHEMA))();
			addConversation(run, canaries);
			db.transaction(() => addFiller(run, 0, 2_000))();
			addCanary(run, canaries);
			db.pragma("wal_checkpoint(PASSIVE)");
			run(DELETE_CANARY);
			db.pragma("wal_checkpoint(PASSIVE)");
			expect(found(readFileSync(file), deleted(canaries))).toEqual([]);
			expect(found(readFileSync(`${file}-wal`), deleted(canaries))).toEqual([
				"body",
				"sender",
				"subject",
			]);
			db.pragma("wal_checkpoint(TRUNCATE)");
			expect(statSync(`${file}-wal`).size).toBe(0);
			expect(found(readFileSync(file), canaries)).toEqual(["conversation"]);
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The 022 umask lets a looser requested mode show; a 077 one would narrow 0644 to 0600.
async function expectOwnerOnlyFiles(check?: (dir: string) => void): Promise<void> {
	const umask = process.umask(0o022);
	try {
		await withContent(({ dir, filename }) => {
			check?.(dir);
			for (const suffix of ["", "-wal", "-shm"])
				expect(statSync(`${filename}${suffix}`).mode & 0o777, suffix).toBe(0o600);
		});
	} finally {
		process.umask(umask);
	}
}

it("creates the database, -wal and -shm at exactly 0600 on ext4", {
	tags: ["requires:ext4"],
}, async () => {
	await expectOwnerOnlyFiles((dir) => expect(statfsSync(dir).type).toBe(0xef53));
});

it("creates the database, -wal and -shm at exactly 0600 on macOS", {
	tags: ["requires:macos"],
}, async () => {
	await expectOwnerOnlyFiles();
});
