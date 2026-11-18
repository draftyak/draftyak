import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareAndSwapGmailPollJournal,
	createGmailPollJournal,
	GmailPollJournalError,
	type GmailPollJournalKey,
	type GmailPollJournalSql,
	type GmailPollJournalSqlValue,
	readGmailPollJournal,
} from "../../src/channels/gmail/poll-journal.ts";

const migration = readFileSync(
	new URL(
		"../../src/channels/gmail/poll-journal-migrations/0001_poll_journal.sql",
		import.meta.url,
	),
	"utf8",
);
const key: GmailPollJournalKey = Object.freeze({
	accountId: "account-A",
	generation: 3,
	pluginInstanceId: "plugin-A",
	ownerEpoch: 7,
	mode: "full",
});
const invalidMessage = "Invalid Gmail poll journal input";
const fixtures = new Set<DatabaseSync>();

interface Fixture {
	readonly db: DatabaseSync;
	readonly sql: GmailPollJournalSql;
	readonly queries: string[];
}

function port(db: DatabaseSync, queries: string[]): GmailPollJournalSql {
	return Object.freeze({
		get(text: string, parameters: readonly GmailPollJournalSqlValue[] = []): unknown {
			queries.push(text);
			return db.prepare(text).get(...parameters);
		},
		run(
			text: string,
			parameters: readonly GmailPollJournalSqlValue[] = [],
		): Readonly<{ changes: number }> {
			queries.push(text);
			const result = db.prepare(text).run(...parameters);
			const changes = Number(result.changes);
			if (!Number.isSafeInteger(changes) || changes < 0) {
				throw new Error("SQL changes out of range");
			}
			return Object.freeze({ changes });
		},
	});
}

/** Genuine ordinary SQLite DATA, without a native store, scope or account grant. */
function fixture(): Fixture {
	const db = new DatabaseSync(":memory:", {
		allowExtension: false,
		enableForeignKeyConstraints: true,
		enableDoubleQuotedStringLiterals: false,
	});
	fixtures.add(db);
	db.exec("PRAGMA temp_store = MEMORY");
	expect(db.prepare("PRAGMA temp_store").get()).toMatchObject({ temp_store: 2 });
	expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
	db.exec(migration);
	const queries: string[] = [];
	return { db, queries, sql: port(db, queries) };
}

function rows(db: DatabaseSync): unknown[] {
	return db
		.prepare(`SELECT * FROM gmail_poll_journal
 ORDER BY account_id, generation, plugin_instance_id, owner_epoch, mode`)
		.all();
}

function expectJournalError(action: () => unknown, code: GmailPollJournalError["code"]): void {
	try {
		action();
		throw new Error("Expected journal refusal");
	} catch (caught) {
		expect(caught).toBeInstanceOf(GmailPollJournalError);
		if (!(caught instanceof GmailPollJournalError)) throw caught;
		expect(caught.code).toBe(code);
		expect(caught.message).toBe("Gmail poll journal operation failed");
		expect(Object.hasOwn(caught, "cause")).toBe(false);
		expect(Object.isFrozen(caught)).toBe(true);
	}
}

afterEach(() => {
	for (const db of fixtures) {
		db.close();
		expect(db.isOpen).toBe(false);
		fixtures.delete(db);
	}
});

describe("Gmail polling SQL journal DATA", () => {
	it("targets main when an identical TEMP journal shadows it", () => {
		const { sql, db } = fixture();
		const columns =
			"(account_id, generation, plugin_instance_id, owner_epoch, mode, format_version, revision, payload)";
		const values = [
			key.accountId,
			key.generation,
			key.pluginInstanceId,
			key.ownerEpoch,
			key.mode,
			1,
			0,
		];
		db.prepare(
			`INSERT INTO main.gmail_poll_journal ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(...values, "main-before");
		const shadow = migration.replace(
			/^CREATE TABLE (?:main\.)?gmail_poll_journal\b/,
			"CREATE TEMP TABLE gmail_poll_journal",
		);
		expect(shadow).not.toBe(migration);
		db.exec(shadow);
		db.prepare(
			`INSERT INTO temp.gmail_poll_journal ${columns} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(...values, "temp-before");
		const tempBefore = db
			.prepare("SELECT * FROM temp.gmail_poll_journal ORDER BY account_id")
			.all();

		expect(readGmailPollJournal(sql, key)).toMatchObject({ revision: 0, payload: "main-before" });
		const newKey = { ...key, accountId: "main-new" };
		expect(createGmailPollJournal(sql, newKey, "new-main-row")).toEqual({
			kind: "written",
			revision: 0,
		});
		expect(
			db
				.prepare("SELECT revision, payload FROM main.gmail_poll_journal WHERE account_id = ?")
				.get(newKey.accountId),
		).toMatchObject({ revision: 0, payload: "new-main-row" });
		expect(
			db
				.prepare("SELECT * FROM temp.gmail_poll_journal WHERE account_id = ?")
				.get(newKey.accountId),
		).toBeUndefined();

		expect(compareAndSwapGmailPollJournal(sql, key, 0, "main-after")).toEqual({
			kind: "written",
			revision: 1,
		});
		expect(
			db
				.prepare("SELECT revision, payload FROM main.gmail_poll_journal WHERE account_id = ?")
				.get(key.accountId),
		).toMatchObject({ revision: 1, payload: "main-after" });
		expect(db.prepare("SELECT * FROM temp.gmail_poll_journal ORDER BY account_id").all()).toEqual(
			tempBefore,
		);
	});

	it("creates revision zero and preserves opaque payload bytes without claiming a polling decode", () => {
		const { sql } = fixture();
		const payload = "not a polling snapshot: \0\uFEFF\u{1F680}";
		const result = createGmailPollJournal(sql, key, payload);
		expect(result).toEqual({ kind: "written", revision: 0 });
		expect(Object.isFrozen(result)).toBe(true);
		const read = readGmailPollJournal(sql, key);
		expect(read).toEqual({ formatVersion: 1, key, revision: 0, payload });
		expect(Object.isFrozen(read)).toBe(true);
		expect(Object.isFrozen(read?.key)).toBe(true);
		expect(read?.key).not.toBe(key);
	});

	it("never replaces an existing row on duplicate create", () => {
		const { sql, db } = fixture();
		createGmailPollJournal(sql, key, '{"deadline":200000,"state":"original"}');
		const before = rows(db);
		const conflict = createGmailPollJournal(sql, key, '{"deadline":999999,"state":"replacement"}');
		expect(conflict).toEqual({ kind: "conflict" });
		expect(Object.isFrozen(conflict)).toBe(true);
		expect(rows(db)).toEqual(before);
	});

	it("allows exactly one competing CAS and preserves every field after stale proposals in either order", () => {
		for (const [first, second] of [
			["A", "B"],
			["B", "A"],
		]) {
			const { sql, db } = fixture();
			createGmailPollJournal(sql, key, "initial");
			for (let revision = 0; revision < 4; revision++) {
				expect(
					compareAndSwapGmailPollJournal(sql, key, revision, `revision-${revision + 1}`),
				).toEqual({
					kind: "written",
					revision: revision + 1,
				});
			}
			expect(compareAndSwapGmailPollJournal(sql, key, 4, `winner-${first}`)).toEqual({
				kind: "written",
				revision: 5,
			});
			const before = rows(db);
			expect(compareAndSwapGmailPollJournal(sql, key, 4, `loser-${second}`)).toEqual({
				kind: "conflict",
			});
			expect(compareAndSwapGmailPollJournal(sql, key, 0, "older-state")).toEqual({
				kind: "conflict",
			});
			expect(rows(db)).toEqual(before);
			expect(readGmailPollJournal(sql, key)).toMatchObject({
				revision: 5,
				payload: `winner-${first}`,
			});
		}
	});

	it("separates every account key field and never updates a neighboring row", () => {
		const { sql, db } = fixture();
		const keys: GmailPollJournalKey[] = [
			key,
			{ ...key, accountId: "account-B" },
			{ ...key, generation: 4 },
			{ ...key, pluginInstanceId: "plugin-B" },
			{ ...key, ownerEpoch: 8 },
			{ ...key, mode: "read_only" },
		];
		for (const [ordinal, value] of keys.entries()) {
			expect(createGmailPollJournal(sql, value, `state-${ordinal}`)).toEqual({
				kind: "written",
				revision: 0,
			});
		}
		expect(compareAndSwapGmailPollJournal(sql, key, 0, "changed-only-A")).toEqual({
			kind: "written",
			revision: 1,
		});
		for (const [ordinal, value] of keys.entries()) {
			expect(readGmailPollJournal(sql, value)).toEqual({
				formatVersion: 1,
				key: value,
				revision: ordinal === 0 ? 1 : 0,
				payload: ordinal === 0 ? "changed-only-A" : `state-${ordinal}`,
			});
		}
		expect(rows(db)).toHaveLength(6);
	});

	it("binds key and payload strings as literal SQL DATA without normalization", () => {
		const { sql, db } = fixture();
		const literal: GmailPollJournalKey = {
			...key,
			accountId: "x' OR 1=1 --",
			pluginInstanceId: " Plugin-A ",
		};
		const payload = "'); DROP TABLE gmail_poll_journal; --";
		createGmailPollJournal(sql, literal, payload);
		createGmailPollJournal(sql, { ...literal, pluginInstanceId: "plugin-a" }, "other");
		expect(readGmailPollJournal(sql, literal)).toEqual({
			formatVersion: 1,
			key: literal,
			revision: 0,
			payload,
		});
		expect(rows(db)).toHaveLength(2);
	});

	it("returns absence/conflict without inventing or installing a missing row", () => {
		const { sql, db } = fixture();
		expect(readGmailPollJournal(sql, key)).toBeUndefined();
		expect(compareAndSwapGmailPollJournal(sql, key, 0, "unused")).toEqual({ kind: "conflict" });
		expect(rows(db)).toEqual([]);
	});

	it("re-reads stored state through a fresh caller port without resetting its revision or payload", () => {
		const { sql, db } = fixture();
		createGmailPollJournal(sql, key, "initial");
		compareAndSwapGmailPollJournal(sql, key, 0, '{"nextDueMs":250000,"revision":1}');
		const before = rows(db);
		const fresh = port(db, []);
		expect(readGmailPollJournal(fresh, key)).toEqual({
			formatVersion: 1,
			key,
			revision: 1,
			payload: '{"nextDueMs":250000,"revision":1}',
		});
		expect(createGmailPollJournal(fresh, key, "do-not-reset")).toEqual({ kind: "conflict" });
		expect(rows(db)).toEqual(before);
	});

	it("leaves commit and rollback to the real outer ordinary SQL transaction", () => {
		const { sql, db, queries } = fixture();
		createGmailPollJournal(sql, key, "before");
		const before = rows(db);
		const marker = new Error("deliberate outer rollback");
		db.exec("BEGIN IMMEDIATE");
		try {
			createGmailPollJournal(sql, { ...key, accountId: "new-account" }, "new");
			compareAndSwapGmailPollJournal(sql, key, 0, "temporary");
			throw marker;
		} catch (caught) {
			db.exec("ROLLBACK");
			expect(caught).toBe(marker);
		}
		expect(rows(db)).toEqual(before);
		expect(queries.every((query) => /^(SELECT|INSERT|UPDATE)\b/.test(query))).toBe(true);
	});

	it("checks revision overflow before SQL and supports the maximum exact stored revision", () => {
		const { sql, db, queries } = fixture();
		createGmailPollJournal(sql, key, "before");
		db.prepare("UPDATE gmail_poll_journal SET revision = ?").run(Number.MAX_SAFE_INTEGER - 1);
		expect(
			compareAndSwapGmailPollJournal(sql, key, Number.MAX_SAFE_INTEGER - 1, "maximum"),
		).toEqual({
			kind: "written",
			revision: Number.MAX_SAFE_INTEGER,
		});
		const before = rows(db);
		const calls = queries.length;
		for (const revision of [
			Number.MAX_SAFE_INTEGER,
			Number.MAX_SAFE_INTEGER + 1,
			-1,
			0.5,
			NaN,
			Infinity,
			"1",
		]) {
			expect(() =>
				compareAndSwapGmailPollJournal(sql, key, revision as number, "invalid"),
			).toThrowError(new TypeError(invalidMessage));
		}
		expect(queries).toHaveLength(calls);
		expect(rows(db)).toEqual(before);
	});

	it("bounds exact well-formed UTF-8 key and payload strings before SQL", () => {
		const { sql, queries, db } = fixture();
		const boundary: GmailPollJournalKey = { ...key, accountId: "\u{1F680}".repeat(64) };
		createGmailPollJournal(sql, boundary, "x".repeat(16_384));
		expect(readGmailPollJournal(sql, boundary)?.payload).toHaveLength(16_384);
		const before = rows(db);
		const calls = queries.length;
		for (const accountId of ["", "x".repeat(257), "\u{1F680}".repeat(65), "x\0y", "\ud800"]) {
			expect(() => createGmailPollJournal(sql, { ...key, accountId }, "payload")).toThrowError(
				new TypeError(invalidMessage),
			);
		}
		for (const payload of ["", "x".repeat(16_385), "\u{1F680}".repeat(4097), "\ud800", null, 1]) {
			expect(() => createGmailPollJournal(sql, key, payload as string)).toThrowError(
				new TypeError(invalidMessage),
			);
		}
		expect(queries).toHaveLength(calls);
		expect(rows(db)).toEqual(before);
	});

	it("rejects malformed key DATA without coercion or writes", () => {
		const { sql, db, queries } = fixture();
		for (const value of [
			null,
			[],
			{},
			{ ...key, generation: "3" },
			{ ...key, generation: -1 },
			{ ...key, generation: Number.MAX_SAFE_INTEGER + 1 },
			{ ...key, ownerEpoch: 0.5 },
			{ ...key, ownerEpoch: NaN },
			{ ...key, mode: "readonly" },
			{ ...key, extra: true },
		]) {
			expect(() =>
				createGmailPollJournal(sql, value as GmailPollJournalKey, "payload"),
			).toThrowError(new TypeError(invalidMessage));
		}
		expect(queries).toEqual([]);
		expect(rows(db)).toEqual([]);
	});

	it("enforces STRICT schema bounds and uniqueness without disabling constraints", () => {
		const { sql, db } = fixture();
		createGmailPollJournal(sql, key, "valid");
		const before = rows(db);
		for (const [column, value] of [
			["format_version", 2],
			["revision", -1],
			["revision", 0.5],
			["revision", Number.MAX_SAFE_INTEGER + 1],
			["generation", -1],
			["owner_epoch", -1],
			["mode", "other"],
			["payload", ""],
			["payload", "x".repeat(16_385)],
			["payload", new Uint8Array([1])],
			["account_id", "x\0y"],
		] as const) {
			// Column names are a fixed test-owned list, never runtime journal input.
			expect(() => db.prepare(`UPDATE gmail_poll_journal SET ${column} = ?`).run(value)).toThrow();
			expect(rows(db)).toEqual(before);
		}
		expect(() =>
			db.exec("INSERT INTO gmail_poll_journal SELECT * FROM gmail_poll_journal"),
		).toThrow();
		expect(rows(db)).toEqual(before);
	});

	it("refuses corrupt SQL DATA observations before CAS instead of repairing or resetting a row", () => {
		const { sql, db } = fixture();
		createGmailPollJournal(sql, key, "unchanged");
		const before = rows(db);
		for (const patch of [
			{ formatVersion: 2 },
			{ revision: -1 },
			{ revision: "0" },
			{ revision: Number.MAX_SAFE_INTEGER + 1 },
			{ payload: null },
			{ payload: "" },
			{ payload: "x".repeat(16_385) },
			{ accountId: "wrong-account" },
			{ extra: true },
		]) {
			let writes = 0;
			const observed: GmailPollJournalSql = {
				get(query, values) {
					return { ...(sql.get(query, values) as object), ...patch };
				},
				run(query, values) {
					writes++;
					return sql.run(query, values);
				},
			};
			expectJournalError(
				() => compareAndSwapGmailPollJournal(observed, key, 0, "must-not-repair"),
				"invalid-row",
			);
			expect(writes).toBe(0);
			expect(rows(db)).toEqual(before);
		}
	});

	it("sanitizes driver exceptions and leaves outer rollback available", () => {
		const { sql, db } = fixture();
		createGmailPollJournal(sql, key, "before");
		const before = rows(db);
		const driverError = new Error("private-driver-value-and-binding");
		for (const failAt of ["get", "run"] as const) {
			const faulty: GmailPollJournalSql = {
				get(query, values) {
					if (failAt === "get") throw driverError;
					return sql.get(query, values);
				},
				run(query, values) {
					if (failAt === "run") throw driverError;
					return sql.run(query, values);
				},
			};
			db.exec("BEGIN IMMEDIATE");
			try {
				createGmailPollJournal(sql, { ...key, accountId: "temporary-account" }, "temporary");
				expectJournalError(
					() => compareAndSwapGmailPollJournal(faulty, key, 0, "new"),
					"sql-failure",
				);
			} finally {
				db.exec("ROLLBACK");
			}
			expect(rows(db)).toEqual(before);
		}
	});

	it("rejects non-0-or-1 SQL changes and an insert refusal without a conflicting row", () => {
		const { sql, db } = fixture();
		createGmailPollJournal(sql, key, "before");
		const before = rows(db);
		for (const changes of [2, -1, 0.5, NaN, Infinity, "1", 1n, null]) {
			const faulty: GmailPollJournalSql = {
				get: sql.get,
				run: () => ({ changes }) as { changes: number },
			};
			expectJournalError(
				() => compareAndSwapGmailPollJournal(faulty, key, 0, "new"),
				"invalid-result",
			);
			expect(rows(db)).toEqual(before);
		}
		const refused: GmailPollJournalSql = { get: sql.get, run: () => ({ changes: 0 }) };
		expectJournalError(
			() => createGmailPollJournal(refused, { ...key, accountId: "missing" }, "new"),
			"invalid-result",
		);
		expect(rows(db)).toEqual(before);
	});
});
