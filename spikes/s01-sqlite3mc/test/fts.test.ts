import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/open.ts";
import {
	addConversation,
	addMessages,
	coreDatabase,
	filler,
	ftsIntegrity,
	newKey,
	rows,
	search,
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

async function withCore(use: (db: SqliteDatabase, file: string) => void): Promise<void> {
	const file = path.join(tempDir(), "draftyak.db");
	const db = await coreDatabase(file, newKey());
	try {
		use(db, file);
	} finally {
		db.close();
	}
}

const seqOf = (db: SqliteDatabase, id: string): number =>
	db.prepare("SELECT seq FROM messages WHERE id = ?").pluck().get(id) as number;

describe("fts_messages", () => {
	it("follows inserts, updates and deletes, cascades included, through its triggers", async () => {
		await withCore((db) => {
			addConversation(db, "conv-1");
			addConversation(db, "conv-2");
			addMessages(db, [
				{ id: "a", subject: "Invoice for October", body: "please find the invoice attached" },
				{ id: "b", subject: "Lunch", body: "café on Friday?" },
				{ id: "c", subject: "Re: invoice", body: "paid", conversationId: "conv-2" },
			]);
			const [a, b, c] = ["a", "b", "c"].map((id) => seqOf(db, id));
			expect(search(db, "invoice")).toEqual([a, c]);
			// unicode61 with remove_diacritics 2 folds case and accents.
			expect(search(db, "CAFE")).toEqual([b]);
			db.prepare("UPDATE messages SET body = 'tea on Monday?' WHERE id = 'b'").run();
			expect([search(db, "cafe"), search(db, "monday")]).toEqual([[], [b]]);
			db.prepare("DELETE FROM messages WHERE id = 'a'").run();
			expect(search(db, "invoice")).toEqual([c]);
			db.prepare("DELETE FROM conversations WHERE id = 'conv-2'").run();
			expect(search(db, "invoice")).toEqual([]);
			ftsIntegrity(db);
			expect(rows(db, "SELECT rowid FROM fts_messages")).toEqual([{ rowid: b }]);
		});
	});

	it("follows REPLACE and upserts, because recursive_triggers is on", async () => {
		await withCore((db) => {
			addConversation(db);
			const columns = "(id, conversation_id, sender, subject, body, sent_at)";
			const replace = db.prepare(
				`INSERT OR REPLACE INTO messages ${columns} VALUES ('m-1', 'conv-1', 's', '', ?, 1)`,
			);
			const upsert = db.prepare(
				`INSERT INTO messages ${columns} VALUES ('m-2', 'conv-1', 's', '', ?, 2)
				 ON CONFLICT (id) DO UPDATE SET body = excluded.body`,
			);
			replace.run("alpha original words");
			replace.run("beta replacement words");
			upsert.run("gamma first words");
			upsert.run("delta second words");
			const [m1, m2] = [seqOf(db, "m-1"), seqOf(db, "m-2")];
			const terms = ["alpha", "beta", "gamma", "delta"].map((term) => search(db, term));
			expect(terms).toEqual([[], [m1], [], [m2]]);
			ftsIntegrity(db);
			// Without it, REPLACE deletes the old row without firing messages_ad: its words stay.
			db.pragma("recursive_triggers = OFF");
			replace.run("epsilon third words");
			expect([search(db, "beta"), search(db, "epsilon")]).toEqual([[m1], [seqOf(db, "m-1")]]);
			expect(thrown(() => ftsIntegrity(db))).toMatchObject({ code: "SQLITE_CORRUPT_VTAB" });
		});
	});

	it("keeps secure-delete on, so a delete removes the row's tokens instead of marking them", async () => {
		await withCore((db) => {
			const config = () => db.prepare("SELECT k, v FROM fts_messages_config ORDER BY k").all();
			expect(config()).toEqual([
				{ k: "secure-delete", v: 1 },
				{ k: "version", v: 4 },
			]);
			addConversation(db);
			addMessages(db, filler(2));
			db.prepare("DELETE FROM messages WHERE id = 'msg-0'").run();
			// The first secure delete moves the index to format 5, which SQLite before 3.42 can't read.
			expect(config()).toEqual([
				{ k: "secure-delete", v: 1 },
				{ k: "version", v: 5 },
			]);
			ftsIntegrity(db);
		});
	});

	it("runs its triggers under trusted_schema=OFF, which still refuses MATCH in views and triggers", async () => {
		await withCore((db) => {
			expect(db.pragma("trusted_schema", { simple: true })).toBe(0);
			addConversation(db);
			addMessages(db, filler(3));
			// FTS5 marks itself SQLITE_VTAB_INNOCUOUS, so triggers may write to it. Its MATCH
			// function isn't innocuous: searches stay top-level statements.
			db.exec(
				"CREATE VIEW invoices AS SELECT rowid FROM fts_messages WHERE fts_messages MATCH 'fox'",
			);
			const viaView = () => db.prepare("SELECT * FROM invoices").all();
			expect(thrown(viaView)).toMatchObject({ message: "unsafe use of MATCH()" });
			db.pragma("trusted_schema = ON");
			expect(viaView()).toHaveLength(3);
			db.pragma("trusted_schema = OFF");
			db.exec("DROP VIEW invoices");
			// FTS5's auxiliary functions are refused the same way, and work in a top-level query.
			for (const [name, call] of [
				["bm25", "bm25(fts_messages)"],
				["highlight", "highlight(fts_messages, 1, '[', ']')"],
				["snippet", "snippet(fts_messages, 1, '[', ']', '…', 4)"],
			]) {
				db.exec(`CREATE VIEW ranked AS SELECT ${call} AS x FROM fts_messages`);
				const ranked = () => db.prepare("SELECT * FROM ranked").all();
				expect(thrown(ranked)).toMatchObject({ message: `unsafe use of ${name}()` });
				db.exec("DROP VIEW ranked");
				const query = `SELECT ${call} FROM fts_messages WHERE fts_messages MATCH 'fox'`;
				expect(db.prepare(query).all()).toHaveLength(3);
			}
			// The pragma is in force: a trigger can't call a function that isn't marked innocuous.
			db.function("not_innocuous", (value: unknown) => value);
			db.exec(`CREATE TRIGGER audit_subject AFTER INSERT ON messages BEGIN
				SELECT not_innocuous(new.subject);
			END`);
			const insert = () => addMessages(db, filler(1, 10));
			expect(thrown(insert)).toMatchObject({ message: "unsafe use of not_innocuous()" });
			ftsIntegrity(db);
		});
	});

	it("gives deleted pages back with incremental_vacuum under auto_vacuum=INCREMENTAL", async () => {
		await withCore((db, file) => {
			addConversation(db);
			addMessages(db, filler(2_000));
			db.prepare("DELETE FROM messages").run();
			const pages = (name: string): number => db.pragma(name, { simple: true }) as number;
			const [before, free] = [pages("page_count"), pages("freelist_count")];
			expect(free).toBeGreaterThan(before / 2);
			db.pragma("incremental_vacuum");
			expect([pages("freelist_count"), pages("page_count")]).toEqual([0, before - free]);
			db.pragma("wal_checkpoint(TRUNCATE)");
			expect(statSync(file).size).toBe((before - free) * 4096);
			ftsIntegrity(db);
		});
	});
});
