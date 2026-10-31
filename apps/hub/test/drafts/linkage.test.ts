import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
	DRAFT_USED_SQL,
	HEADER_LINK_SQL,
	LOCK_LINK_SQL,
	NativeDraftRevisions,
	OUTBOX_USED_SQL,
} from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { openEncrypted } from "../../src/store/open.ts";
import { rolledBackAppend } from "../audit/segment-fixture.ts";
import { nativeBinding } from "../store/helpers.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
async function fixture(): Promise<RevisionFixture> {
	const f = await revisionFixture();
	fixtures.push(f);
	return f;
}
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});
const refused = expect.objectContaining({ code: "DRAFT_REVISION_UNAVAILABLE" });
function append(f: RevisionFixture, action: string, refs: Record<string, string>): number {
	return f.store.write((tx) => {
		f.audit.append(tx, {
			id: newId(),
			at: f.time.now,
			action,
			actor: { kind: "hub", id: null },
			refs,
		});
		return tx.get<{ audit_seq: number }>("SELECT audit_seq FROM audit_meta WHERE singleton=1")
			?.audit_seq as number;
	});
}
const seed = (f: RevisionFixture, count: number): void => {
	for (let index = 0; index < count; index++) append(f, "hub.seed", { device: newId() });
};
/** A raw connection holding the database key rewrites one stored audit row. */
function rewrite(f: RevisionFixture, seq: number): void {
	const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
	try {
		raw.exec("DROP TRIGGER IF EXISTS audit_no_update");
		raw.prepare("UPDATE audit_events SET at=at+1 WHERE seq=?").run(seq);
	} finally {
		raw.close();
	}
}
const seqOf = (f: RevisionFixture, sql: string, id: string): number =>
	f.store.read((db) => db.get<{ audit_seq: number }>(sql, [id])?.audit_seq as number);
const headerSeq = (f: RevisionFixture, id: string): number =>
	seqOf(f, "SELECT audit_seq FROM native_drafts WHERE id=?", id);
const lockSeq = (f: RevisionFixture, outbox: string): number =>
	seqOf(f, "SELECT audit_seq FROM native_draft_locks WHERE outbox_id=?", outbox);

describe("draft audit linkage", () => {
	it("refuses current when the last audit row is replaced by an authentic rolled-back append", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		f.create(input);
		const alternate = rolledBackAppend(f.store, f.audit, {
			id: newId(),
			at: f.time.now,
			action: "hub.seed",
			actor: { kind: "hub", id: null },
			refs: { device: newId() },
		});
		const committedSeq = append(f, "hub.seed", { device: newId() });
		expect(alternate.row.seq).toBe(committedSeq);
		expect(f.revisions.current(bound).draft.rev).toBe(1);
		const committed = f.store.read((db) =>
			db.get<{ previous: string; mac: string }>(
				"SELECT previous,mac FROM audit_events WHERE seq=?",
				[committedSeq],
			),
		);
		if (!committed) throw new Error("missing committed last row");
		expect(alternate.row.previous).toBe(committed.previous);
		expect(alternate.row.mac).not.toBe(committed.mac);
		const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			raw.exec("DROP TRIGGER audit_no_update");
			raw
				.prepare(
					"UPDATE audit_events SET id=?,at=?,action=?,actor_kind=?,actor_id=?,refs=?,previous=?,mac=? WHERE seq=?",
				)
				.run(
					alternate.row.id,
					alternate.row.at,
					alternate.row.action,
					alternate.row.actor_kind,
					alternate.row.actor_id,
					alternate.row.refs,
					alternate.row.previous,
					alternate.row.mac,
					alternate.row.seq,
				);
		} finally {
			raw.close();
		}
		expect(() => f.revisions.current(bound)).toThrow(refused);
	});
	it("detects a rewritten audit row between the draft's own event and the head", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		seed(f, 3);
		f.create(input);
		const anchor = headerSeq(f, input.draftId);
		seed(f, 4);
		const snapshot = f.snapshot(f.revisions.current(bound));
		rewrite(f, anchor + 2);
		expect(() => f.revisions.current(bound)).toThrow(refused);
		expect(() => f.revisions.history(bound)).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 })),
		).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
		).toThrow(refused);
	});
	it("detects a rewrite of the draft's own audit event below the head", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			own = headerSeq(f, input.draftId);
		expect(append(f, "hub.seed", { device: newId() })).toBe(own + 1);
		rewrite(f, own);
		expect(() => f.revisions.current(bound)).toThrow(refused);
		expect(() => f.revisions.history(bound)).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 })),
		).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
		).toThrow(refused);
	});
	it("leaves rows before the draft's segment to the full verification at construction", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		seed(f, 3);
		f.create(input);
		rewrite(f, 2);
		expect(f.revisions.current(bound).draft.rev).toBe(1);
		expect(() => new NativeDraftRevisions(f.store, f.audit, f.key, f.clock)).toThrow(refused);
	});
	it("authenticates the lock's own audit event before proof, consume or release", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		expect(lockSeq(f, snapshot.outbox)).toBeLessThan(headerSeq(f, input.draftId));
		rewrite(f, lockSeq(f, snapshot.outbox));
		expect(f.revisions.current(bound).lockId).not.toBeNull();
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow(refused);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox)),
		).toThrow(refused);
	});
	it("authenticates a lock's audit event before a direct lock change sets it", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const lock = f.revisions.current(bound).lockId as string;
		f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, lock, null));
		rewrite(f, lockSeq(f, snapshot.outbox));
		expect(f.revisions.current(bound).lockId).toBeNull();
		expect(() =>
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, null, lock)),
		).toThrow(refused);
		expect(f.revisions.current(bound).lockId).toBeNull();
	});
	it("ignores another module's event naming exactly the draft, also after reopen", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		f.create(input);
		append(f, "outbox.created", { draft: input.draftId });
		expect(f.revisions.current(bound).draft.rev).toBe(1);
		const two = f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 }),
		);
		append(f, "outbox.created", { draft: input.draftId });
		const snapshot = f.snapshot(two);
		f.store.write((tx) =>
			f.freeze.consumeInTransaction(tx, f.freeze.freezeInTransaction(tx, bound, 2, snapshot)),
		);
		const next = f.reopen();
		expect(next.revisions.current(bound).draft.rev).toBe(2);
		expect(next.revisions.history(bound)).toHaveLength(2);
	});
	it("ignores another module's event naming exactly the lock", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const lock = f.revisions.current(bound).lockId as string,
			refs = { draft: input.draftId, freeze: lock, outbox: snapshot.outbox };
		append(f, "outbox.queued", refs);
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
		const next = { ...snapshot, outbox: newId() };
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, next));
		append(f, "outbox.queued", {
			draft: input.draftId,
			freeze: f.revisions.current(bound).lockId as string,
			outbox: next.outbox,
		});
		const proof = f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, next.outbox));
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)).outboxId).toBe(
			next.outbox,
		);
	});
	it("freezes an outbox that another module named before the freeze", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		append(f, "send.issued", { attempt: newId(), outbox: snapshot.outbox, ticket: newId() });
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)).outboxId).toBe(
			snapshot.outbox,
		);
	});
	it("creates a draft whose id another module named before the create", async () => {
		const f = await fixture(),
			input = f.make();
		append(f, "outbox.created", { draft: input.draftId, outbox: newId() });
		expect(f.create(input).draft.rev).toBe(1);
		expect(() => f.create(input)).toThrow(refused);
	});
	it("answers the linkage and freshness lookups without an index", async () => {
		const f = await fixture(),
			raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			raw.exec("CREATE INDEX lookup_refs ON audit_events(refs)");
			raw.exec("CREATE INDEX lookup_draft ON audit_events(json_extract(refs,'$.draft'))");
			raw.exec("CREATE INDEX lookup_outbox ON audit_events(json_extract(refs,'$.outbox'))");
			const plan = (sql: string): string =>
				(raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("{}") as { detail: string }[])
					.map((step) => step.detail)
					.join("\n");
			for (const sql of [HEADER_LINK_SQL, LOCK_LINK_SQL, DRAFT_USED_SQL, OUTBOX_USED_SQL]) {
				expect(plan(sql)).not.toMatch(/INDEX/);
				expect(plan(sql.replace(" NOT INDEXED", ""))).toMatch(/INDEX/);
			}
		} finally {
			raw.close();
		}
	});
});
