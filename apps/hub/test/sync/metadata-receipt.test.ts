import type { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import { describe, expect, it } from "vitest";

type SqlDatabase = InstanceType<typeof Database>;
type SqlValue = string | number | Buffer | null;
const id = (value: number): string => String(value).padStart(26, "0");
const USER = id(1);
const ACCOUNT = id(2);
const SOURCE = id(3);
const OTHER_SOURCE = id(4);
const FIRST = id(10);
const SECOND = id(11);
const MESSAGE = id(20);
const LEGACY = id(21);
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

function migration(db: SqlDatabase, name: string): void {
	const sql = readFileSync(new URL(`../../src/sync/migrations/${name}`, import.meta.url), "utf8");
	db.pragma("foreign_keys = OFF");
	try {
		db.transaction(() => db.exec(sql))();
		expect(db.pragma("foreign_key_check")).toEqual([]);
	} finally {
		db.pragma("foreign_keys = ON");
	}
}

function conversation(db: SqlDatabase, key: string, provider = `thread-${key}`): void {
	db.prepare(
		"INSERT INTO content_conversations(id,user_id,account_id,generation,provider_id) VALUES(?,?,?,1,?)",
	).run(key, USER, ACCOUNT, provider);
}

function legacyMessage(db: SqlDatabase, key: string, thread: string, labels: string[]): void {
	db.prepare(
		`INSERT INTO content_messages
		(id,user_id,account_id,generation,provider_id,conversation_id,internal_date,label_json,size_bytes)
		VALUES(?,?,?,1,?,?,123,?,7)`,
	).run(key, USER, ACCOUNT, `provider-${key}`, thread, JSON.stringify(labels));
}

function insertReceipt(db: SqlDatabase, key: string, receivedAt: SqlValue, source: SqlValue): void {
	db.prepare(
		`INSERT INTO content_messages
		(id,user_id,account_id,generation,provider_id,conversation_id,internal_date,label_json,
		size_bytes,received_at,ingress_source_id) VALUES(?,?,?,1,?,?,123,'[]',7,?,?)`,
	).run(key, USER, ACCOUNT, `provider-${key}`, FIRST, receivedAt, source);
}

function parsedSeed(db: SqlDatabase): void {
	// SQL-valid derived DATA, not an assertion of NativeParsedStore admission.
	const json = JSON.stringify({
		body: {
			text: "needle retained body",
			removals: { hidden: 0, invisible: 0, quoted: 0, truncated: 0, uris: 0 },
			links: [],
			suspectedInstructions: false,
		},
	});
	db.prepare(
		`INSERT INTO content_parsed_messages
		(message_id,account_id,generation,user_id,plugin_instance_id,mode,provider_id,thread_id,
		account_digest,metadata_digest,source_cursor,source_revision,raw_ref,raw_sha256,
		raw_bytes,parsed_json,parsed_digest,association)
		VALUES(?,?,1,?,?,'full',?,?,?,?,'cursor-a',1,?,?,3,?,?,'unverified')`,
	).run(
		MESSAGE,
		ACCOUNT,
		USER,
		SOURCE,
		`provider-${MESSAGE}`,
		`thread-${FIRST}`,
		sha("account"),
		sha("metadata"),
		id(30),
		sha("raw"),
		json,
		sha(json),
	);
}

function through0005(): SqlDatabase {
	const db = new Database(":memory:");
	try {
		db.pragma("recursive_triggers = ON");
		db.pragma("trusted_schema = OFF");
		db.pragma("temp_store = MEMORY");
		db.pragma("secure_delete = ON");
		migration(db, "0001_content.sql");
		migration(db, "0002_parsed.sql");
		conversation(db, FIRST);
		conversation(db, SECOND);
		legacyMessage(db, MESSAGE, FIRST, ["UNREAD"]);
		legacyMessage(db, LEGACY, SECOND, ["INBOX"]);
		parsedSeed(db);
		migration(db, "0003_sync.sql");
		migration(db, "0004_sync_anchors.sql");
		migration(db, "0005_parsed_search.sql");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function with0006(work: (db: SqlDatabase) => void): void {
	const db = through0005();
	try {
		migration(db, "0006_metadata_receipt.sql");
		work(db);
	} finally {
		db.close();
	}
}

function originalData(db: SqlDatabase): unknown {
	return {
		conversations: db
			.prepare(
				"SELECT id,user_id,account_id,generation,provider_id FROM content_conversations ORDER BY id",
			)
			.all(),
		messages: db
			.prepare(
				`SELECT id,user_id,account_id,generation,provider_id,conversation_id,internal_date,
				label_json,size_bytes,state,direction FROM content_messages ORDER BY id`,
			)
			.all(),
		parsed: db.prepare("SELECT * FROM content_parsed_messages ORDER BY message_id").all(),
		indexRows: ftsRows(db),
		hits: hits(db),
	};
}

function hits(db: SqlDatabase): unknown[] {
	return db
		.prepare(
			`SELECT message_id FROM content_parsed_messages WHERE seq IN
			(SELECT rowid FROM content_parsed_fts WHERE content_parsed_fts MATCH 'needle')
			ORDER BY message_id`,
		)
		.all();
}

function ftsRows(db: SqlDatabase): unknown[] {
	return db
		.prepare("SELECT rowid FROM content_parsed_fts WHERE content_parsed_fts MATCH 'needle'")
		.all();
}

function receipt(db: SqlDatabase, key: string): unknown {
	return db
		.prepare("SELECT received_at,ingress_source_id FROM content_messages WHERE id=?")
		.get(key);
}

describe("native metadata receipt SQL", () => {
	it("upgrades real content SQL with unknown legacy receipts and unchanged parsed FTS hits", () => {
		const db = through0005();
		try {
			const before = originalData(db);
			expect(hits(db)).toEqual([{ message_id: MESSAGE }]);
			migration(db, "0006_metadata_receipt.sql");
			expect(originalData(db)).toEqual(before);
			expect(receipt(db, MESSAGE)).toEqual({ received_at: null, ingress_source_id: null });
			expect(receipt(db, LEGACY)).toEqual({ received_at: null, ingress_source_id: null });
		} finally {
			db.close();
		}
	});

	it("accepts paired unknown receipts and safe integer boundaries", () => {
		with0006((db) => {
			insertReceipt(db, id(40), null, null);
			insertReceipt(db, id(41), 0, SOURCE);
			insertReceipt(db, id(42), Number.MAX_SAFE_INTEGER, SOURCE);
			expect(receipt(db, id(40))).toEqual({ received_at: null, ingress_source_id: null });
			expect(receipt(db, id(41))).toEqual({ received_at: 0, ingress_source_id: SOURCE });
			expect(receipt(db, id(42))).toEqual({
				received_at: Number.MAX_SAFE_INTEGER,
				ingress_source_id: SOURCE,
			});
		});
	});

	it("refuses incomplete, malformed, and unsafe stored receipt pairs", () => {
		with0006((db) => {
			const invalid: readonly (readonly [SqlValue, SqlValue])[] = [
				[0, null],
				[null, SOURCE],
				[-1, SOURCE],
				[1.5, SOURCE],
				[Number.MAX_SAFE_INTEGER + 1, SOURCE],
				[Number.NaN, SOURCE],
				[0, "80000000000000000000000000"],
				[0, "0000000000000000000000000a"],
				[0, "short"],
			];
			for (const [receivedAt, source] of invalid) {
				expect(() => insertReceipt(db, id(50), receivedAt, source)).toThrow();
				expect(receipt(db, id(50))).toBeUndefined();
			}
		});
	});

	it("never rewrites or clears known receipts or fabricates a legacy receipt", () => {
		with0006((db) => {
			insertReceipt(db, id(60), 200, SOURCE);
			const rewrite = db.prepare(
				"UPDATE content_messages SET received_at=?,ingress_source_id=? WHERE id=?",
			);
			for (const [time, source] of [
				[201, SOURCE],
				[200, OTHER_SOURCE],
				[null, null],
			]) {
				expect(() => rewrite.run(time, source, id(60))).toThrow(
					"CONTENT_MESSAGE_INGRESS_IMMUTABLE",
				);
			}
			expect(() => rewrite.run(200, SOURCE, LEGACY)).toThrow("CONTENT_MESSAGE_INGRESS_IMMUTABLE");
			expect(() => rewrite.run(200, SOURCE, id(60))).not.toThrow();
			expect(receipt(db, id(60))).toEqual({ received_at: 200, ingress_source_id: SOURCE });
			expect(receipt(db, LEGACY)).toEqual({ received_at: null, ingress_source_id: null });
		});
	});

	it("retains message IDs and first receipts across labels, upserts, moves, and retries", () => {
		with0006((db) => {
			const third = id(12);
			conversation(db, third);
			insertReceipt(db, id(70), 300, SOURCE);
			// Exercise ordinary SQL upsert semantics, not NativeMetadataStore admission.
			const upsert = db.prepare(
				`INSERT INTO content_messages
				(id,user_id,account_id,generation,provider_id,conversation_id,internal_date,
				label_json,size_bytes,received_at,ingress_source_id)
				VALUES(?,?,?,1,?,?,456,?,9,999,?)
				ON CONFLICT(account_id,generation,provider_id) DO UPDATE SET
				conversation_id=excluded.conversation_id,internal_date=excluded.internal_date,
				label_json=excluded.label_json,size_bytes=excluded.size_bytes`,
			);
			for (const [destination, labels] of [
				[FIRST, ["UNREAD", "INBOX"]],
				[SECOND, []],
				[third, ["INBOX"]],
				[third, ["INBOX"]],
			] as const) {
				upsert.run(
					id(71),
					USER,
					ACCOUNT,
					`provider-${id(70)}`,
					destination,
					JSON.stringify(labels),
					OTHER_SOURCE,
				);
				expect(receipt(db, id(70))).toEqual({ received_at: 300, ingress_source_id: SOURCE });
			}
			expect(
				db
					.prepare("SELECT id,conversation_id,label_json FROM content_messages WHERE id=?")
					.get(id(70)),
			).toEqual({
				id: id(70),
				conversation_id: third,
				label_json: '["INBOX"]',
			});
		});
	});

	it("preserves Parsed FTS cascades and account-range cleanup", () => {
		with0006((db) => {
			expect(hits(db)).toEqual([{ message_id: MESSAGE }]);
			expect(() => db.prepare("DELETE FROM content_conversations WHERE id=?").run(FIRST)).toThrow();
			db.prepare("DELETE FROM content_messages WHERE id=?").run(MESSAGE);
			expect(
				db.prepare("SELECT * FROM content_parsed_messages WHERE message_id=?").get(MESSAGE),
			).toBeUndefined();
			expect(hits(db)).toEqual([]);
			expect(ftsRows(db)).toEqual([]);
			db.prepare("DELETE FROM content_conversations WHERE id=?").run(FIRST);
			// SQL deletion ordering only; this is not the native purge producer.
			db.prepare("DELETE FROM content_messages WHERE account_id=?").run(ACCOUNT);
			db.prepare("DELETE FROM content_conversations WHERE account_id=?").run(ACCOUNT);
			expect(
				db.prepare("SELECT id FROM content_conversations WHERE account_id=?").all(ACCOUNT),
			).toEqual([]);
			expect(db.pragma("foreign_key_check")).toEqual([]);
		});
	});
});
