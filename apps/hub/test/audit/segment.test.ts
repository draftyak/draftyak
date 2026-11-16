import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_VERIFY_BATCH_SIZE, AuditChain } from "../../src/audit/chain.ts";
import { auditHeadTag } from "../../src/audit/head.ts";
import { newId } from "../../src/kernel/ids.ts";
import { readStamp } from "../../src/store/read-stamp.ts";
import type { SqlReader, SqlValue } from "../../src/store/store.ts";
import { fixture, nativeBinding } from "../store/helpers.ts";
import { type AuditHead, type AuditRow as Row, rolledBackAppend } from "./segment-fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let key: Buffer;
let audit: AuditChain;
beforeEach(async () => {
	f = await fixture();
	key = f.key.derive("audit");
	audit = new AuditChain(key);
});
afterEach(() => {
	vi.restoreAllMocks();
	f.store.close();
	audit.destroy();
	key.fill(0);
	f.key.destroy();
	rmSync(f.dir, { recursive: true, force: true });
});
const event = () => ({
	id: newId(),
	at: 1_800_000_000_000,
	action: "hub.seed",
	actor: { kind: "hub" as const, id: null },
	refs: { device: newId() },
});
function seed(count: number): void {
	f.store.write((tx) => {
		for (let index = 0; index < count; index++) audit.append(tx, event());
	});
}
function raw<T>(work: (db: Database.Database) => T): T {
	const dbKey = f.key.derive("db"),
		db = new Database(f.filename, { nativeBinding });
	try {
		db.pragma("cipher='chacha20'");
		db.key(dbKey);
		return work(db);
	} finally {
		dbKey.fill(0);
		db.close();
	}
}
const unlock = (): void => {
	raw((db) =>
		db.exec("DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete"),
	);
};
const change = (sql: string, bindings: readonly SqlValue[] = []): void => {
	raw((db) => db.prepare(sql).run(...bindings));
};
const sign = ({ mac: _, ...row }: Row): string =>
	createHmac("sha256", key).update("draftyak/audit/v1\n").update(canonicalize(row)).digest("hex");
/** A keyed writer's rewrite: stores the edited rows and tags the last one as the head. */
function resign(edit: (rows: Row[]) => Row[]): void {
	unlock();
	raw((db) => {
		const rows = edit(db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as Row[]);
		db.exec("DELETE FROM audit_events");
		const insert = db.prepare(
			"INSERT INTO audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) VALUES(?,?,?,?,?,?,?,?,?)",
		);
		for (const row of rows)
			insert.run(
				row.seq,
				row.id,
				row.at,
				row.action,
				row.actor_kind,
				row.actor_id,
				row.refs,
				row.previous,
				row.mac,
			);
		const last = rows.at(-1) as Row;
		db.prepare("UPDATE audit_meta SET audit_seq=?,audit_head=?,audit_tag=? WHERE singleton=1").run(
			last.seq,
			last.mac,
			auditHeadTag(key, last.seq, last.mac),
		);
	});
}
/** Re-signs every row from `from` on, each linked to the chain row before it. */
const relink = (rows: Row[], from: number): Row[] => {
	let previous = "";
	for (const row of rows) {
		if (row.seq >= from) {
			row.previous = previous;
			row.mac = sign(row);
		}
		if (row.seq > 0) previous = row.mac;
	}
	return rows;
};
const segment = (from: number): void => f.store.read((db) => audit.verifySegment(db, from));
const full = (): void => f.store.read((db) => audit.verify(db));

describe("audit segment verification", () => {
	it("authenticates rows from a start through the tagged head and refuses impossible starts", () => {
		expect(() => segment(1)).toThrow("Audit chain verification failed");
		seed(10);
		for (const from of [1, 5, 10]) segment(from);
		for (const from of [0, -1, 11, 1.5, Number.NaN])
			expect(() => segment(from)).toThrow("Audit chain verification failed");
		audit.destroy();
		expect(() => segment(1)).toThrow("Audit is locked");
	});
	it.each(["fresh call", "same-scope reuse"] as const)(
		"binds the walked rows to a different tag-valid head on a %s",
		(scope) => {
			seed(9);
			const alternate = rolledBackAppend(f.store, audit, event());
			seed(1);
			f.store.write((tx) => {
				const committed = tx.get<AuditHead>(
					"SELECT audit_seq,audit_head,audit_tag FROM audit_meta WHERE singleton=1",
				);
				if (!committed) throw new Error("missing committed head");
				expect(alternate.head.audit_seq).toBe(committed.audit_seq);
				expect(alternate.head.audit_head).not.toBe(committed.audit_head);
				expect(alternate.head.audit_tag).toBe(
					auditHeadTag(key, alternate.head.audit_seq, alternate.head.audit_head),
				);
				if (scope === "same-scope reuse") audit.verifySegment(tx, 3);
				tx.run("UPDATE audit_meta SET audit_seq=?,audit_head=?,audit_tag=? WHERE singleton=1", [
					alternate.head.audit_seq,
					alternate.head.audit_head,
					alternate.head.audit_tag,
				]);
				expect(() => audit.verifySegment(tx, 4)).toThrow("Audit head verification failed");
				tx.run("UPDATE audit_meta SET audit_seq=?,audit_head=?,audit_tag=? WHERE singleton=1", [
					committed.audit_seq,
					committed.audit_head,
					committed.audit_tag,
				]);
			});
			full();
		},
	);
	it("refuses an authentic rolled-back last row under the committed head", () => {
		seed(9);
		const alternate = rolledBackAppend(f.store, audit, event());
		seed(1);
		const committed = f.store.read((db) =>
			db.get<Row>("SELECT * FROM audit_events WHERE seq=?", [alternate.row.seq]),
		);
		if (!committed) throw new Error("missing committed last row");
		expect(alternate.row.previous).toBe(committed.previous);
		expect(alternate.row.mac).not.toBe(committed.mac);
		expect(sign(alternate.row)).toBe(alternate.row.mac);
		unlock();
		change(
			"UPDATE audit_events SET id=?,at=?,action=?,actor_kind=?,actor_id=?,refs=?,previous=?,mac=? WHERE seq=?",
			[
				alternate.row.id,
				alternate.row.at,
				alternate.row.action,
				alternate.row.actor_kind,
				alternate.row.actor_id,
				alternate.row.refs,
				alternate.row.previous,
				alternate.row.mac,
				alternate.row.seq,
			],
		);
		expect(() => segment(3)).toThrow("Audit head verification failed");
	});
	it.each([0, -1, 11, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"refuses start %s before reading audit rows even after successful same-scope verification",
		(from) => {
			seed(10);
			const reads = vi.spyOn(Database.prototype, "prepare");
			f.store.read((db) => {
				audit.verifySegment(db, 1);
				reads.mockClear();
				expect(() => audit.verifySegment(db, from)).toThrow("Audit chain verification failed");
				expect(reads.mock.calls.filter(([sql]) => sql.includes("FROM main.audit_events"))).toEqual(
					[],
				);
			});
		},
	);
	it("detects a rewritten row inside the segment and leaves earlier rows to a full verify", () => {
		seed(10);
		unlock();
		change("UPDATE audit_events SET at=at+1 WHERE seq=6");
		for (const from of [1, 3, 6]) expect(() => segment(from)).toThrow("verification failed");
		segment(7);
		expect(full).toThrow("verification failed");
	});
	it("checks the total count against the head, including rows outside the segment", () => {
		seed(10);
		unlock();
		change("DELETE FROM audit_events WHERE seq=2");
		expect(() => segment(5)).toThrow("Audit head verification failed");
		change(
			"INSERT INTO audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) SELECT 2,?,at,action,actor_kind,actor_id,refs,previous,mac FROM audit_events WHERE seq=3",
			[newId()],
		);
		segment(5);
		change(
			"INSERT INTO audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) SELECT 11,?,at,action,actor_kind,actor_id,refs,previous,mac FROM audit_events WHERE seq=10",
			[newId()],
		);
		expect(() => segment(5)).toThrow("Audit head verification failed");
	});
	it("refuses a keyed rewrite that skips a sequence number even when every MAC and link agrees", () => {
		seed(10);
		resign((rows) => {
			const kept = rows.filter((row) => row.seq !== 5);
			kept.unshift({ ...(rows[0] as Row), seq: 0, id: newId() });
			return relink(kept, 6);
		});
		expect(() => segment(3)).toThrow("Audit chain verification failed");
		segment(6);
	});
	it("refuses a keyed rewrite whose previous link is wrong even when its own MAC agrees", () => {
		seed(10);
		resign((rows) => {
			const broken = rows.find((row) => row.seq === 5) as Row;
			broken.previous = "ab".repeat(32);
			broken.mac = sign(broken);
			return relink(rows, 6);
		});
		expect(() => segment(3)).toThrow("Audit chain verification failed");
		segment(5);
		expect(() =>
			f.store.read((db) => {
				audit.verifySegment(db, 5);
				audit.verifySegment(db, 3);
			}),
		).toThrow("Audit chain verification failed");
	});
	it("reuses authenticated rows within one live scope and extends them down and to new appends", () => {
		seed(10);
		f.store.read((db) => {
			audit.verifySegment(db, 8);
			audit.verifySegment(db, 3);
			audit.verifySegment(db, 9);
			audit.verifySegment(db, 1);
		});
		f.store.write((tx) => {
			audit.verifySegment(tx, 5);
			audit.append(tx, event());
			audit.append(tx, event());
			audit.verifySegment(tx, 12);
			audit.verifySegment(tx, 2);
		});
		full();
	});
	it("reads only newly appended rows on same-scope reuse of the real store handle", () => {
		const seeded = AUDIT_VERIFY_BATCH_SIZE * 2 + 10;
		seed(seeded);
		const reads: { after: unknown; through: unknown; rows: number }[] = [],
			prepare = Database.prototype.prepare;
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = (prepare<unknown[]>).call(this, sql);
			if (sql.includes("FROM main.audit_events WHERE main.audit_events.seq>?")) {
				const all = statement.all;
				statement.all = (...bindings: unknown[]) => {
					const rows = all.apply(statement, bindings);
					reads.push({ after: bindings[0], through: bindings[1], rows: rows.length });
					return rows;
				};
			}
			return statement;
		});
		f.store.write((tx) => {
			expect(readStamp(tx)).toBeDefined();
			audit.verifySegment(tx, 3);
			expect(reads.reduce((sum, read) => sum + read.rows, 0)).toBe(seeded - 3);
			reads.length = 0;
			audit.append(tx, event());
			audit.append(tx, event());
			audit.verifySegment(tx, 3);
			expect(reads).toEqual([{ after: seeded, through: seeded + 2, rows: 2 }]);
			reads.length = 0;
			audit.verifySegment(tx, seeded + 2);
			expect(reads).toEqual([]);
		});
	});
	it("never reuses rows across scopes, after another connection commits, or for other readers", () => {
		seed(10);
		segment(3);
		unlock();
		change("UPDATE audit_events SET at=at+1 WHERE seq=6");
		expect(() => segment(3)).toThrow("Audit chain verification failed");
		change("UPDATE audit_events SET at=at-1 WHERE seq=6");
		segment(3);
		expect(() =>
			f.store.read((db) => {
				audit.verifySegment(db, 3);
				change("UPDATE audit_events SET at=at+1 WHERE seq=6");
				audit.verifySegment(db, 4);
			}),
		).toThrow("Audit chain verification failed");
		change("UPDATE audit_events SET at=at-1 WHERE seq=6");
		let reads = 0;
		f.store.read((db) => {
			const reader: SqlReader = {
				get: (sql, bindings) => db.get(sql, bindings),
				all: <T>(sql: string, bindings?: readonly SqlValue[]): T[] => {
					reads++;
					return db.all<T>(sql, bindings);
				},
			};
			audit.verifySegment(reader, 3);
			const first = reads;
			audit.verifySegment(reader, 3);
			expect(first).toBeGreaterThan(0);
			expect(reads).toBe(first * 2);
		});
	});
	it("authenticates rows appended inside the live scope before reusing earlier ones", () => {
		seed(10);
		const forged = "cd".repeat(32);
		expect(() =>
			f.store.write((tx) => {
				audit.verifySegment(tx, 3);
				const head = tx.get<{ audit_head: string }>(
					"SELECT audit_head FROM audit_meta WHERE singleton=1",
				);
				tx.run(
					"INSERT INTO audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) VALUES(11,?,1,'hub.seed','hub',NULL,'{}',?,?)",
					[newId(), head?.audit_head ?? "", forged],
				);
				tx.run("UPDATE audit_meta SET audit_seq=11,audit_head=?,audit_tag=? WHERE singleton=1", [
					forged,
					auditHeadTag(key, 11, forged),
				]);
				audit.verifySegment(tx, 4);
			}),
		).toThrow("Audit chain verification failed");
		full();
	});
});
