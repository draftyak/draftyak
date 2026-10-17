import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { deriveHexKey, openEncrypted } from "../src/db.ts";
import { migrate } from "../src/migrator.ts";
import type { SqliteDatabase } from "../src/open.ts";
import { copyPrebuild, hostTarget } from "../src/prebuilds.ts";

let copied: string | undefined;

// The host's prebuild, copied once into bundle/prebuilds/ as M0.9 does.
export function binding(): string {
	copied ??= copyPrebuild(hostTarget()).file;
	return copied;
}

// A folder for one test, removed when it ends: every connection in it must be closed by then.
export function tempDir(prefix = "s01-"): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}

export const newMasterKey = (): Buffer => randomBytes(32);
export const newKey = (): string => deriveHexKey(newMasterKey());

export const sha256File = (file: string): string =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

export const listDir = (dir: string): string[] => readdirSync(dir).toSorted();

// A new encrypted database with the core migrations applied.
export async function coreDatabase(file: string, key: string): Promise<SqliteDatabase> {
	const db = openEncrypted(file, key, binding(), { create: true });
	try {
		await migrate(db, "core");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export interface Message {
	readonly id: string;
	readonly subject: string;
	readonly body: string;
	readonly sender?: string;
	readonly conversationId?: string;
}

export function addConversation(db: SqliteDatabase, id = "conv-1", subject = ""): void {
	db.prepare("INSERT INTO conversations (id, account_id, subject) VALUES (?, 'gmail-1', ?)").run(
		id,
		subject,
	);
}

export function addMessages(db: SqliteDatabase, messages: readonly Message[]): void {
	const insert = db.prepare(
		`INSERT INTO messages (id, conversation_id, sender, subject, body, sent_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	db.transaction(() => {
		for (const [index, message] of messages.entries()) {
			insert.run(
				message.id,
				message.conversationId ?? "conv-1",
				message.sender ?? "sender@example.com",
				message.subject,
				message.body,
				1_760_000_000 + index,
			);
		}
	})();
}

export const filler = (count: number, from = 0): Message[] =>
	Array.from({ length: count }, (_, index) => ({
		id: `msg-${from + index}`,
		subject: `weekly update ${from + index}`,
		body: `the quick brown fox jumps over the lazy dog, item ${from + index}`,
	}));

export function search(db: SqliteDatabase, query: string): number[] {
	return db
		.prepare("SELECT rowid FROM fts_messages WHERE fts_messages MATCH ? ORDER BY rowid")
		.pluck()
		.all(query) as number[];
}

// FTS5's own check of the index against the external content table.
export function ftsIntegrity(db: SqliteDatabase): void {
	db.prepare("INSERT INTO fts_messages (fts_messages, rank) VALUES ('integrity-check', 1)").run();
}

export const rows = (db: SqliteDatabase, sql: string): unknown[] => db.prepare(sql).all();
