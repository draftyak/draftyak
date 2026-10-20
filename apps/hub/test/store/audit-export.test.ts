import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuditEvent } from "@draftyak/protocol/entities/audit";
import { canonicalize } from "@draftyak/protocol/jcs";
import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	AUDIT_EXPORT_MAX_BYTES,
	AUDIT_EXPORT_MAX_EVENTS,
	AUDIT_VERIFY_BATCH_SIZE,
	AuditChain,
	type AuditExportPage,
} from "../../src/audit/chain.ts";
import type { SqlReader, SqlValue } from "../../src/store/store.ts";
import { fixture, nativeBinding } from "./helpers.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let audit: AuditChain;
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const refused = "Audit export unavailable";
beforeEach(async () => {
	f = await fixture();
	const key = f.key.derive("audit");
	try {
		audit = new AuditChain(key);
	} finally {
		key.fill(0);
	}
});
afterEach(() => {
	f.store.close();
	audit.destroy();
	f.key.destroy();
	rmSync(f.dir, { recursive: true, force: true });
});

function seed(count: number, wide = false): void {
	f.store.write((tx) => {
		for (let index = 1; index <= count; index++)
			audit.append(tx, {
				id: String(index).padStart(26, "0"),
				at: index,
				action: wide ? "a".repeat(64) : "hub.init",
				actor: wide
					? { kind: "browser", id: ID }
					: index % 2
						? { kind: "device", id: ID }
						: { kind: "hub", id: null },
				refs: wide
					? Object.fromEntries(
							Array.from({ length: 32 }, (_, i) => [`ref${i}`.padEnd(32, "x"), ID]),
						)
					: { device: ID },
			});
	});
}

function change(sql: string, bindings: readonly SqlValue[] = []): void {
	const key = f.key.derive("db");
	const attacker = new Database(f.filename, { nativeBinding });
	try {
		attacker.pragma("cipher='chacha20'");
		attacker.key(key);
		attacker.exec("DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete");
		attacker.prepare(sql).run(...bindings);
	} finally {
		key.fill(0);
		attacker.close();
	}
}

const page = (afterSeq = 0, limit = 100): AuditExportPage =>
	f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq, limit }));
const lines = (result: AuditExportPage): Record<string, unknown>[] =>
	result.jsonl
		? result.jsonl
				.trimEnd()
				.split("\n")
				.map((line) => JSON.parse(line))
		: [];

it("exports immutable deterministic allowlisted JSONL only after real HMAC verification", () => {
	seed(3);
	const first = page(0, 2);
	expect(first).toEqual(page(0, 2));
	expect(first.count).toBe(2);
	expect(first.nextAfterSeq).toBe(2);
	expect(first.head.seq).toBe(3);
	expect(first.head.mac).toMatch(/^[0-9a-f]{64}$/);
	expect(Object.isFrozen(first)).toBe(true);
	expect(Object.isFrozen(first.head)).toBe(true);
	expect(first.jsonl.endsWith("\n")).toBe(true);
	const key = f.key.derive("audit");
	try {
		for (const row of lines(first)) {
			expect(Object.keys(row).sort()).toEqual([
				"action",
				"actor",
				"at",
				"id",
				"mac",
				"previous",
				"refs",
				"seq",
			]);
			expect(
				AuditEvent.safeParse(
					Object.fromEntries(
						Object.entries(row).filter(([key]) => !["seq", "previous", "mac"].includes(key)),
					),
				).success,
			).toBe(true);
			const { mac, ...body } = row;
			// Storage MAC authenticates canonical refs text and separate actor kind/id columns.
			body.refs = canonicalize(body.refs);
			const actor = body.actor as { kind: string; id: string | null };
			body.actor_kind = actor.kind;
			body.actor_id = actor.id;
			delete body.actor;
			const expected = createHmac("sha256", key)
				.update("draftyak/audit/v1\n")
				.update(canonicalize(body))
				.digest("hex");
			expect(mac).toBe(expected);
		}
	} finally {
		key.fill(0);
	}
	expect(lines(page(2, 2)).map((row) => row.seq)).toEqual([3]);
	expect(page(2, 2).nextAfterSeq).toBeNull();
	expect(page(3)).toMatchObject({ jsonl: "", count: 0, nextAfterSeq: null });
});

it("supports an empty chain and default page position without inventing an event", () => {
	const result = f.store.read((db) => audit.exportVerifiedJsonl(db));
	expect(result).toEqual({ jsonl: "", count: 0, nextAfterSeq: null, head: { seq: 0, mac: "" } });
	expect(
		f.store.read((db) => audit.exportVerifiedJsonl(db, { afterSeq: undefined, limit: undefined })),
	).toEqual(result);
	f.store.read((db) => audit.verify(db));
});

it("refuses final newlines and sparse IDs before append can mint an unverifiable record", () => {
	const input = {
		id: ID,
		at: 1,
		action: "hub.init",
		actor: { kind: "hub", id: null },
		refs: { device: ID },
	};
	for (const bad of [
		{ ...input, action: "hub.init\n" },
		{ ...input, action: `${"a".repeat(63)}\n` },
		{ ...input, actor: { kind: "device", id: `${ID}\n` } },
		{ ...input, refs: { device: `${ID}\n` } },
		{ ...input, refs: new Array<string>(1) },
	])
		expect(() => f.store.write((tx) => audit.append(tx, bad as never))).toThrow("metadata");
	expect(
		f.store.read((db) => db.get<{ events: number }>("SELECT COUNT(*) AS events FROM audit_events"))
			?.events,
	).toBe(0);
	expect(page().count).toBe(0);
});

it("uses bounded keyset batches and selects only audit metadata, including beyond the requested page", () => {
	seed(AUDIT_VERIFY_BATCH_SIZE * 2 + 3);
	const queries: { sql: string; bindings: readonly SqlValue[]; returned?: number }[] = [];
	const result = f.store.write((db) => {
		const observed: SqlReader = {
			get<T>(sql: string, bindings: readonly SqlValue[] = []): T | undefined {
				queries.push({ sql, bindings });
				return db.get<T>(sql, bindings);
			},
			all<T>(sql: string, bindings: readonly SqlValue[] = []): T[] {
				const rows = db.all<T>(sql, bindings);
				queries.push({ sql, bindings, returned: rows.length });
				return rows;
			},
		};
		audit.verify(observed);
		return audit.exportVerifiedJsonl(observed, { limit: 1 });
	});
	expect(result.count).toBe(1);
	expect(result.head.seq).toBe(AUDIT_VERIFY_BATCH_SIZE * 2 + 3);
	const batches = queries.filter((query) => query.returned !== undefined);
	expect(batches).toHaveLength(6);
	expect(
		batches.every(
			(query) =>
				query.bindings.at(-1) === AUDIT_VERIFY_BATCH_SIZE &&
				(query.returned ?? 0) <= AUDIT_VERIFY_BATCH_SIZE,
		),
	).toBe(true);
	expect(batches.map((query) => query.bindings[0])).toEqual([0, 128, 256, 0, 128, 256]);
	for (const { sql } of queries) {
		expect(sql).not.toMatch(
			/\b(?:messages|message_bodies|credentials|secrets|master_key|blobs)\b/i,
		);
		expect(sql).not.toMatch(/SELECT\s+\*/i);
		expect(sql).toMatch(/\bFROM main\.(?:audit_events|audit_meta)\b/);
	}
});

it("bounds a maximum-width page to 1000 events and 2 MiB while retaining an actual continuation", () => {
	seed(AUDIT_EXPORT_MAX_EVENTS + 1, true);
	const result = page(0, AUDIT_EXPORT_MAX_EVENTS);
	expect(result.count).toBeGreaterThan(0);
	expect(result.count).toBeLessThan(AUDIT_EXPORT_MAX_EVENTS);
	expect(result.nextAfterSeq).toBe(result.count);
	expect(Buffer.byteLength(result.jsonl)).toBeLessThanOrEqual(AUDIT_EXPORT_MAX_BYTES);
	expect(lines(result).every((row) => Object.keys(row.refs as object).length === 32)).toBe(true);
	const next = page(result.nextAfterSeq ?? 0, AUDIT_EXPORT_MAX_EVENTS);
	expect(next.count).toBe(AUDIT_EXPORT_MAX_EVENTS + 1 - result.count);
	expect(next.nextAfterSeq).toBeNull();
	expect([...lines(result), ...lines(next)].map((row) => row.seq)).toEqual(
		Array.from({ length: AUDIT_EXPORT_MAX_EVENTS + 1 }, (_, i) => i + 1),
	);
});

it("refuses late tampering outside the selected output page and shares verification with verify", () => {
	seed(AUDIT_VERIFY_BATCH_SIZE + 3);
	change("UPDATE audit_events SET at=999 WHERE seq=?", [AUDIT_VERIFY_BATCH_SIZE + 3]);
	expect(() => page(0, 1)).toThrow(refused);
	expect(() => f.store.read((db) => audit.verify(db))).toThrow("verification");
});

it.each([
	"gap",
	"truncation",
	"extra-zero",
	"extra-negative",
	"extra-tail",
	"replace-zero",
	"replace-tail",
])("refuses missing and out-of-range audit records: %s", (kind) => {
	seed(3);
	if (kind === "gap") change("DELETE FROM audit_events WHERE seq=2");
	else if (kind === "truncation") change("DELETE FROM audit_events");
	else {
		const seq = kind.includes("zero") ? 0 : kind.includes("negative") ? -1 : 4;
		change(
			"INSERT INTO audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) SELECT ?,'01ARZ3NDEKTSV4RRFFQ69G5FAW',at,action,actor_kind,actor_id,refs,previous,mac FROM audit_events WHERE seq=1",
			[seq],
		);
		if (kind === "replace-zero") change("DELETE FROM audit_events WHERE seq=1");
		if (kind === "replace-tail") change("DELETE FROM audit_events WHERE seq=3");
	}
	expect(() => page()).toThrow(refused);
	expect(() => f.store.read((db) => audit.verify(db))).toThrow("verification");
});

it.each(["id", "action", "actor_kind", "actor_id", "refs", "previous", "mac"])(
	"guards oversized %s inside SQL before JavaScript materialization",
	(column) => {
		seed(1);
		change(`UPDATE audit_events SET ${column}=? WHERE seq=1`, ["PRIVATE_CANARY".repeat(100_000)]);
		const nativeRows: unknown[] = [];
		expect(() =>
			f.store.read((db) =>
				audit.exportVerifiedJsonl({
					get: db.get.bind(db),
					all<T>(sql: string, bindings: readonly SqlValue[] = []): T[] {
						const rows = db.all<T>(sql, bindings);
						nativeRows.push(...rows);
						return rows;
					},
				}),
			),
		).toThrow(refused);
		expect(nativeRows).toHaveLength(1);
		expect(JSON.stringify(nativeRows).length).toBeLessThan(2000);
		expect(JSON.stringify(nativeRows)).not.toContain("PRIVATE_CANARY");
	},
);

it.each(["[PRIVATE_CANARY]", '{"private":"PRIVATE_CANARY"}', "[null]", '["private body"]'])(
	"normalizes malformed or non-ID JSON without reflecting it: case %#",
	(refs) => {
		seed(1);
		change("UPDATE audit_events SET refs=? WHERE seq=1", [refs]);
		try {
			page();
			expect.fail("expected refusal");
		} catch (error) {
			expect((error as Error).message).toBe(refused);
			expect("cause" in (error as Error)).toBe(false);
		}
		expect(() => f.store.read((db) => audit.verify(db))).toThrow("verification");
	},
);

it("rejects the wrong and destroyed HMAC key, including a destroyed empty chain", () => {
	const wrong = new AuditChain(randomBytes(32));
	try {
		seed(1);
		expect(() => f.store.read((db) => wrong.exportVerifiedJsonl(db))).toThrow(refused);
	} finally {
		wrong.destroy();
	}
	audit.destroy();
	expect(() => page()).toThrow(refused);
	change("DELETE FROM audit_events");
	change("UPDATE audit_meta SET audit_seq=0,audit_head='' WHERE singleton=1");
	expect(() => page()).toThrow(refused);
	expect(() => f.store.read((db) => audit.verify(db))).toThrow("locked");
});

it("rejects a changed committed head after reading a valid pinned chain", () => {
	seed(2);
	let changed = false;
	expect(() =>
		f.store.read((db) =>
			audit.exportVerifiedJsonl(
				{
					get: db.get.bind(db),
					all<T>(sql: string, bindings: readonly SqlValue[] = []): T[] {
						const rows = db.all<T>(sql, bindings);
						if (!changed) {
							changed = true;
							change("UPDATE audit_meta SET audit_head=? WHERE singleton=1", ["f".repeat(64)]);
						}
						return rows;
					},
				},
				{ limit: 1 },
			),
		),
	).toThrow(refused);
	expect(changed).toBe(true);
});

it.each(["insert", "delete"])(
	"rejects direct %s that changes count without changing the head during verification",
	(action) => {
		seed(2);
		let changed = false;
		expect(() =>
			f.store.read((db) =>
				audit.exportVerifiedJsonl(
					{
						get: db.get.bind(db),
						all<T>(sql: string, bindings: readonly SqlValue[] = []): T[] {
							const rows = db.all<T>(sql, bindings);
							if (!changed) {
								changed = true;
								if (action === "insert")
									change(
										"INSERT INTO audit_events(seq,id,at,action,actor_kind,actor_id,refs,previous,mac) SELECT 3,'01ARZ3NDEKTSV4RRFFQ69G5FAW',at,action,actor_kind,actor_id,refs,previous,mac FROM audit_events WHERE seq=1",
									);
								else change("DELETE FROM audit_events WHERE seq=1");
							}
							return rows;
						},
					},
					{ limit: 1 },
				),
			),
		).toThrow(refused);
	},
);

it("guards poisoned head and unsafe integer fields before export", () => {
	seed(1);
	change("UPDATE audit_events SET at=? WHERE seq=1", [9007199254740992n]);
	expect(() => page()).toThrow(refused);
	change("UPDATE audit_meta SET audit_head=? WHERE singleton=1", [
		"PRIVATE_CANARY".repeat(100_000),
	]);
	expect(() => page()).toThrow(refused);
	change("UPDATE audit_meta SET audit_seq=? WHERE singleton=1", [9007199254740992n]);
	expect(() => page()).toThrow(refused);
});

it("rejects invalid option bounds, unknown fields and accessor/proxy data without invoking callers", () => {
	for (const options of [
		null,
		[],
		{ afterSeq: -1 },
		{ afterSeq: 1.5 },
		{ afterSeq: 9007199254740992 },
		{ limit: 0 },
		{ limit: 1001 },
		{ limit: Number.NaN },
		{ limit: "1" },
		{ extra: "PRIVATE_CANARY" },
	])
		expect(() => f.store.read((db) => audit.exportVerifiedJsonl(db, options as never))).toThrow(
			refused,
		);
	let calls = 0;
	const accessor = {};
	Object.defineProperty(accessor, "limit", {
		get() {
			calls++;
			throw new Error("PRIVATE_CANARY");
		},
	});
	for (const options of [
		accessor,
		new Proxy(
			{},
			{
				ownKeys() {
					calls++;
					throw new Error("PRIVATE_CANARY");
				},
			},
		),
	])
		expect(() => f.store.read((db) => audit.exportVerifiedJsonl(db, options))).toThrow(refused);
	expect(calls).toBe(0);
	expect(() => page(1)).toThrow(refused);
});

it("normalizes native reader failures without reflecting SQL, credentials or paths", () => {
	const failed = (): never => {
		throw new Error("PRIVATE_CANARY /private/path credential-secret");
	};
	expect(() => audit.exportVerifiedJsonl({ get: failed, all: failed })).toThrow(refused);
	expect(() => audit.verify({ get: failed, all: failed })).toThrow("verification");
});

async function emptyShadows(): Promise<void> {
	const dir = path.join(f.dir, "shadows");
	mkdirSync(dir);
	writeFileSync(
		path.join(dir, "0001_shadows.sql"),
		"CREATE TEMP TABLE audit_events AS SELECT * FROM main.audit_events WHERE 0; CREATE TEMP TABLE audit_meta AS SELECT * FROM main.audit_meta; UPDATE temp.audit_meta SET audit_seq=0,audit_head='';",
	);
	await f.store.migrate("shadows");
}

it.each(["", "x".repeat(64), "PRIVATE_HEAD_CANARY".repeat(4096)])(
	"refuses an invalid or oversized durable append head before changing the chain %#",
	(head) => {
		seed(1);
		change("UPDATE main.audit_meta SET audit_head=? WHERE singleton=1", [head]);
		expect(() =>
			f.store.write((tx) =>
				audit.append(tx, {
					id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
					at: 2,
					action: "hub.next",
					actor: { kind: "device", id: ID },
					refs: { device: ID },
				}),
			),
		).toThrow("Audit head verification failed");
		expect(f.store.read((db) => db.get("SELECT COUNT(*) n FROM main.audit_events"))).toEqual({
			n: 1,
		});
		expect(f.store.read((db) => db.get("SELECT audit_seq FROM main.audit_meta"))).toEqual({
			audit_seq: 1,
		});
	},
);

it("verifies and exports the actual durable chain despite empty TEMP shadows", async () => {
	seed(2);
	await emptyShadows();
	f.store.write((tx) => audit.verify(tx));
	expect(lines(page()).map((row) => row.seq)).toEqual([1, 2]);
	expect(page().head.seq).toBe(2);
});

it("appends only to the durable chain and leaves TEMP shadows untouched", async () => {
	seed(1);
	await emptyShadows();
	f.store.write((tx) =>
		audit.append(tx, {
			id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
			at: 2,
			action: "hub.next",
			actor: { kind: "device", id: ID },
			refs: { device: ID },
		}),
	);
	f.store.write((tx) => audit.verify(tx));
	expect(f.store.read((db) => db.all("SELECT seq FROM main.audit_events ORDER BY seq"))).toEqual([
		{ seq: 1 },
		{ seq: 2 },
	]);
	expect(f.store.read((db) => db.all("SELECT seq FROM temp.audit_events"))).toEqual([]);
	expect(f.store.read((db) => db.get("SELECT audit_seq,audit_head FROM temp.audit_meta"))).toEqual({
		audit_seq: 0,
		audit_head: "",
	});
});

it("never lets empty TEMP shadows conceal durable corruption or a wrong HMAC key", async () => {
	seed(1);
	await emptyShadows();
	const wrong = new AuditChain(randomBytes(32));
	try {
		expect(() => f.store.write((tx) => wrong.verify(tx))).toThrow("verification");
		expect(() => f.store.write((tx) => wrong.exportVerifiedJsonl(tx))).toThrow(refused);
	} finally {
		wrong.destroy();
	}
	change("UPDATE main.audit_events SET at=42 WHERE seq=1");
	expect(() => f.store.write((tx) => audit.verify(tx))).toThrow("verification");
	expect(() => page()).toThrow(refused);
});
