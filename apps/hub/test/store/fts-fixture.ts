import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import { migrate } from "../../src/store/migrator.ts";
import { openEncrypted, type SqliteDatabase } from "../../src/store/open.ts";
import { nativeBinding } from "./helpers.ts";

// ADR 0002's FTS5 schema (spikes/s01-sqlite3mc/migrations/core/0001_init.sql), as a fixture namespace.
export const FTS_NAMESPACE = "fts";
const FTS_SQL = `CREATE TABLE conversations (
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
END;
`;

/** A new file under the hub opener's settings with the FTS5 namespace applied; the caller closes it. */
export async function ftsDatabase(filename: string, key: MasterKey): Promise<SqliteDatabase> {
	const db = openEncrypted({ filename, nativeBinding, create: true }, key);
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-fts-"));
	try {
		writeFileSync(path.join(dir, "0001_init.sql"), FTS_SQL);
		await migrate(db, FTS_NAMESPACE, dir);
		return db;
	} catch (error) {
		db.close();
		throw error;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface Message {
	readonly id: string;
	readonly subject: string;
	readonly body: string;
	readonly sender?: string;
}

export function addConversation(db: SqliteDatabase, id: string, subject: string): void {
	db.prepare("INSERT INTO conversations (id, account_id, subject) VALUES (?, 'gmail-1', ?)").run(
		id,
		subject,
	);
}

export function addMessages(db: SqliteDatabase, messages: readonly Message[]): void {
	const insert = db.prepare(
		"INSERT INTO messages (id, conversation_id, sender, subject, body, sent_at) VALUES (?, 'conv-1', ?, ?, ?, ?)",
	);
	db.transaction(() => {
		for (const [index, message] of messages.entries())
			insert.run(
				message.id,
				message.sender ?? "sender@example.com",
				message.subject,
				message.body,
				1_760_000_000 + index,
			);
	})();
}

export const filler = (count: number, from = 0): Message[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `msg-${from + index}`,
		subject: `weekly update ${from + index}`,
		body: `the quick brown fox jumps over the lazy dog, item ${from + index}`,
	}));

export const search = (db: SqliteDatabase, query: string): number[] =>
	db
		.prepare("SELECT rowid FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rowid")
		.pluck()
		.all(query) as number[];

export function ftsIntegrity(db: SqliteDatabase): void {
	db.prepare("INSERT INTO fts_messages (fts_messages, rank) VALUES ('integrity-check', 1)").run();
}

export const SQLITE_HEADER: Buffer = Buffer.from("SQLite format 3\0", "latin1");

// A lowercase token FTS5's unicode61 tokenizer keeps whole.
export const newCanary = (): string => `dycanary${randomBytes(8).toString("hex")}`;

// FTS5 stores a term after the prefix it shares with the previous term: look for the random tail.
export const canaryTail = (canary: string): string => canary.slice(-12);

export interface Needle {
	readonly label: string;
	readonly bytes: Uint8Array;
}

/** Strings as UTF-8 in their written, lower and upper case; bytes as given. */
export function needles(values: Readonly<Record<string, string | Uint8Array>>): Needle[] {
	return Object.entries(values).flatMap(([label, value]) => {
		if (typeof value !== "string") return [{ label, bytes: value }];
		const forms = new Set([value, value.toLowerCase(), value.toUpperCase()]);
		return [...forms].map((form) => ({ label, bytes: Buffer.from(form, "utf8") }));
	});
}

/** The labels whose bytes appear in an image, sorted. */
export function inImage(image: Uint8Array, look: readonly Needle[]): string[] {
	const bytes = Buffer.from(image.buffer, image.byteOffset, image.byteLength);
	return [
		...new Set(look.filter((needle) => bytes.includes(needle.bytes)).map((n) => n.label)),
	].toSorted();
}

export interface FileScan {
	readonly suffix: string;
	readonly header: boolean;
	readonly found: readonly string[];
}

/** The database file and each sidecar that exists, scanned for the plaintext header and needles. */
export function scanDatabase(filename: string, look: readonly Needle[]): FileScan[] {
	return ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
		let content: Buffer;
		try {
			content = readFileSync(`${filename}${suffix}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return [{ suffix, header: content.includes(SQLITE_HEADER), found: inImage(content, look) }];
	});
}

export const leaks = (scans: readonly FileScan[]): FileScan[] =>
	scans.filter((scan) => scan.header || scan.found.length > 0);
