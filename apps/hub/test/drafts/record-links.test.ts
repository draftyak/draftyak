import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it } from "vitest";
import type { FrozenRevisionProof } from "../../src/drafts/freeze.ts";
import { newId } from "../../src/kernel/ids.ts";
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
interface HeaderRow {
	id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}
interface LockRow extends HeaderRow {
	draft_id: string;
	outbox_id: string;
}
const refused = expect.objectContaining({ code: "DRAFT_REVISION_UNAVAILABLE" });
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture value");
	return value;
}
const rows = (f: RevisionFixture) =>
	f.store.read((db) => ({
		headers: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		events: db.all("SELECT * FROM audit_events ORDER BY seq"),
		head: db.get("SELECT * FROM audit_meta WHERE singleton=1"),
	}));
function header(f: RevisionFixture, id: string): HeaderRow {
	const row = f.store.read((db) =>
		db.get<HeaderRow>("SELECT id,payload,audit_seq,mac FROM native_drafts WHERE id=?", [id]),
	);
	if (!row) throw new Error("Missing fixture header");
	return row;
}
function lock(f: RevisionFixture, outbox: string): LockRow {
	const row = f.store.read((db) =>
		db.get<LockRow>(
			"SELECT id,draft_id,outbox_id,payload,audit_seq,mac FROM native_draft_locks WHERE outbox_id=?",
			[outbox],
		),
	);
	if (!row) throw new Error("Missing fixture lock");
	return row;
}
function checkHeader(f: RevisionFixture, id: string): string {
	const row = header(f, id),
		payload = JSON.parse(row.payload),
		linked = f.store.read((db) => ({
			tip: db.get<{ mac: string }>(
				"SELECT mac FROM native_draft_revisions WHERE draft_id=? ORDER BY rev DESC LIMIT 1",
				[id],
			),
			event: db.get<{ mac: string }>("SELECT mac FROM audit_events WHERE seq=?", [row.audit_seq]),
		}));
	expect(payload.latestRevisionMac).toBe(linked.tip?.mac);
	expect(payload.auditEventMac).toBe(linked.event?.mac);
	expect(payload.latestRevisionMac).toMatch(/^[0-9a-f]{64}$/);
	expect(payload.auditEventMac).toMatch(/^[0-9a-f]{64}$/);
	return payload.latestRevisionMac;
}
function checkLock(f: RevisionFixture, outbox: string, status: string): void {
	const row = lock(f, outbox),
		payload = JSON.parse(row.payload),
		event = f.store.read((db) =>
			db.get<{ mac: string }>("SELECT mac FROM audit_events WHERE seq=?", [row.audit_seq]),
		);
	expect(payload.status).toBe(status);
	expect(payload.auditEventMac).toBe(event?.mac);
}
function editHeader(
	f: RevisionFixture,
	id: string,
	edit: (value: Record<string, unknown>) => void,
) {
	const row = header(f, id),
		payload = JSON.parse(row.payload);
	edit(payload);
	const { mac: _, ...signed } = { ...row, payload: canonicalize(payload) };
	f.store.write((tx) =>
		tx.run("UPDATE native_drafts SET payload=?,mac=? WHERE id=?", [
			signed.payload,
			f.revisions.sign("header", signed),
			id,
		]),
	);
}

describe("native draft record links", () => {
	it("keeps revision and event links consistent across committed transitions and reopen", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		f.create(input);
		const first = checkHeader(f, input.draftId);
		f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				author: { kind: "owner", id: newId() },
				flags: [],
			}),
		);
		const tip = checkHeader(f, input.draftId);
		expect(tip).not.toBe(first);
		const snapshot = f.snapshot(f.revisions.current(bound));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, snapshot));
		checkLock(f, snapshot.outbox, "active");
		expect(checkHeader(f, input.draftId)).toBe(tip);
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
		checkLock(f, snapshot.outbox, "released");
		expect(checkHeader(f, input.draftId)).toBe(tip);
		const next = { ...snapshot, outbox: newId() },
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, next));
		f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		checkLock(f, next.outbox, "consumed");
		expect(checkHeader(f, input.draftId)).toBe(tip);
		const reopened = f.reopen();
		expect(reopened.revisions.current(bound).revision.rev).toBe(2);
		expect(reopened.revisions.history(bound)).toHaveLength(2);
	});

	it.each(["latestRevisionMac", "auditEventMac"])(
		"requires the complete %s header field",
		async (field) => {
			for (const value of [undefined, "invalid", "A".repeat(64), "0".repeat(64)]) {
				const f = await fixture(),
					input = f.make(),
					bound = f.bind(input);
				f.create(input);
				editHeader(f, input.draftId, (payload) => {
					if (value === undefined) delete payload[field];
					else payload[field] = value;
				});
				expect(() => f.revisions.current(bound)).toThrow(refused);
				expect(() => f.revisions.history(bound)).toThrow(refused);
			}
		},
	);
	it.each(["legacy", "extra"])("refuses a header with %s fields", async (kind) => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		f.create(input);
		editHeader(f, input.draftId, (payload) => {
			if (kind === "legacy") {
				delete payload.latestRevisionMac;
				delete payload.auditEventMac;
			} else payload.unrecognized = true;
		});
		expect(() => f.revisions.current(bound)).toThrow(refused);
	});
	it.each(["missing", "invalid", "uppercase", "different", "extra"])(
		"refuses a lock with %s record link data",
		async (kind) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				snapshot = f.snapshot(f.create(input));
			const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
				row = lock(f, snapshot.outbox),
				payload = JSON.parse(row.payload);
			if (kind === "missing") delete payload.auditEventMac;
			else if (kind === "extra") payload.unrecognized = true;
			else
				payload.auditEventMac =
					kind === "invalid" ? "invalid" : (kind === "uppercase" ? "A" : "0").repeat(64);
			const { mac: _, ...signed } = { ...row, payload: canonicalize(payload) };
			f.store.write((tx) =>
				tx.run("UPDATE native_draft_locks SET payload=?,mac=? WHERE id=?", [
					signed.payload,
					f.revisions.sign("freeze", signed),
					row.id,
				]),
			);
			expect(() =>
				f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
			).toThrow(refused);
			expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
				refused,
			);
			expect(() =>
				f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox)),
			).toThrow(refused);
			expect(() =>
				f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, row.id, row.id)),
			).toThrow(refused);
		},
	);
	it("refuses an active lock payload that is not in canonical form", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const row = lock(f, snapshot.outbox),
			payload = JSON.parse(row.payload),
			reordered = JSON.stringify(Object.fromEntries(Object.entries(payload).reverse()));
		expect(reordered).not.toBe(row.payload);
		expect(JSON.parse(reordered)).toEqual(payload);
		const { mac: _, ...signed } = { ...row, payload: reordered };
		f.store.write((tx) =>
			tx.run("UPDATE native_draft_locks SET payload=?,mac=? WHERE id=?", [
				reordered,
				f.revisions.sign("freeze", signed),
				row.id,
			]),
		);
		expect(() =>
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, row.id, row.id)),
		).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow(refused);
	});
	it.each(["create", "append", "freeze", "release", "consume"])(
		"rolls back all linked records when the %s scope fails",
		async (operation) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input);
			let proof: FrozenRevisionProof | undefined;
			if (operation !== "create") f.create(input);
			const snapshot = operation === "create" ? undefined : f.snapshot(f.revisions.current(bound));
			if (operation === "release" || operation === "consume")
				proof = f.store.write((tx) =>
					f.freeze.freezeInTransaction(tx, bound, 1, required(snapshot)),
				);
			const before = rows(f),
				stop = new Error("Fixture scope ended");
			expect(() =>
				f.store.write((tx) => {
					if (operation === "create") f.revisions.createInTransaction(tx, input);
					else if (operation === "append")
						f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 });
					else if (operation === "freeze")
						f.freeze.freezeInTransaction(tx, bound, 1, required(snapshot));
					else if (operation === "release")
						f.freeze.releaseInTransaction(tx, bound, required(snapshot).outbox);
					else f.freeze.consumeInTransaction(tx, required(proof));
					throw stop;
				}),
			).toThrow(stop);
			expect(rows(f)).toEqual(before);
		},
	);
});
