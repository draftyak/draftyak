import { canonicalize } from "@draftyak/protocol/jcs";
import { contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, expect, it } from "vitest";
import { newId } from "../../src/kernel/ids.ts";
import { expireNativeOutboxMissed } from "../../src/outbox/propose.ts";
import { type ExpiryFixture, expiryFixture } from "./scheduler-expiry-fixture.ts";

const fixtures: ExpiryFixture[] = [];
async function setup(): Promise<ExpiryFixture> {
	const f = await expiryFixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
});

function rows(f: ExpiryFixture, id: string) {
	return f.base.native.store.read((db) => ({
		outbox: db.get<{ state: string; payload: string; audit_seq: number; mac: string }>(
			"SELECT state,payload,audit_seq,mac FROM main.outbox WHERE id=?",
			[id],
		),
		locks: db.all("SELECT * FROM main.native_draft_locks ORDER BY id"),
		headers: db.all("SELECT * FROM main.native_drafts ORDER BY id"),
		audit: db.all("SELECT * FROM main.audit_events ORDER BY seq"),
		auditHead: db.all("SELECT * FROM main.audit_meta ORDER BY singleton"),
		events: db.all("SELECT * FROM main.events ORDER BY seq"),
		eventHead: db.all("SELECT * FROM main.event_meta WHERE singleton=1"),
	}));
}

it.each(["now", "at"] as const)(
	"expires an authenticated %s approval only after its inclusive deliverBy boundary",
	async (kind) => {
		const f = await setup(),
			p = await f.approve(kind),
			before = f.read(p.id);
		if (!before || before.deliverBy === null) throw new Error("Missing approved fixture window");
		expect(before.state).toBe(kind === "now" ? "APPROVED" : "SCHEDULED");
		expect(before.contentHash).toBe(contentHash(before.snapshot));
		expect(f.revisions.current(p.binding).lockId).toBe(before.lockId);
		const persistedBefore = rows(f, p.id);
		f.base.time.wall = before.deliverBy;
		expect(expireNativeOutboxMissed(f.target, p.id)).toBe(false);
		expect(rows(f, p.id)).toEqual(persistedBefore);
		f.base.time.wall++;
		expect(expireNativeOutboxMissed(f.target, p.id)).toBe(true);
		const after = f.read(p.id),
			persistedAfter = rows(f, p.id);
		expect(after).toEqual({
			...before,
			state: "NEEDS_REAPPROVAL",
			stateReason: "missed",
			updatedAt: f.base.time.wall,
		});
		expect(after?.snapshot).toEqual(before.snapshot);
		expect(after?.contentHash).toBe(before.contentHash);
		expect(after?.flagsHash).toBe(before.flagsHash);
		expect(after?.revisionContentHash).toBe(before.revisionContentHash);
		expect(f.revisions.current(p.binding).lockId).toBeNull();
		expect(persistedAfter.outbox?.audit_seq).toBeGreaterThan(p.record.targetVersion);
		expect(persistedAfter.outbox?.mac).not.toBe(persistedBefore.outbox?.mac);
		expect(persistedAfter.outbox?.payload).toBe(canonicalize(after));
		const notices = f.base.native.store.read((db) => ({
			audit: db.all<{ seq: number; refs: string }>(
				"SELECT seq,refs FROM main.audit_events WHERE action='outbox.missed'",
			),
			events: db.all<{ ids: string }>(
				"SELECT ids FROM main.events WHERE kind='outbox.changed' ORDER BY seq",
			),
		}));
		expect(notices.audit).toEqual([
			{ seq: persistedAfter.outbox?.audit_seq, refs: canonicalize({ outbox: p.id }) },
		]);
		expect(notices.events).toHaveLength(3);
		expect(notices.events.at(-1)?.ids).toBe(canonicalize([p.id]));
		expect(JSON.stringify(notices)).not.toContain(before.snapshot.body.text);
		f.base.native.store.read((db) => f.base.native.audit.verify(db));
	},
);

it("does not repeat a missed transition or create one for an unknown identifier", async () => {
	const f = await setup(),
		p = await f.approve(),
		approved = f.read(p.id);
	if (!approved || approved.deliverBy === null) throw new Error("Missing approved fixture window");
	f.base.time.wall = approved.deliverBy + 1;
	expect(expireNativeOutboxMissed(f.target, p.id)).toBe(true);
	const before = rows(f, p.id),
		record = f.read(p.id);
	expect(expireNativeOutboxMissed(f.target, p.id)).toBe(false);
	expect(expireNativeOutboxMissed(f.target, newId(f.base.time.wall))).toBe(false);
	expect(rows(f, p.id)).toEqual(before);
	expect(f.read(p.id)).toEqual(record);
});

it("never revives a missed item when the wall clock moves back into its old window", async () => {
	const f = await setup(),
		p = await f.approve("at"),
		approved = f.read(p.id);
	if (!approved || approved.deliverBy === null || approved.notBefore === null)
		throw new Error("Missing scheduled fixture window");
	f.base.time.wall = approved.deliverBy + 1;
	expect(expireNativeOutboxMissed(f.target, p.id)).toBe(true);
	const before = rows(f, p.id);
	f.base.time.wall = approved.notBefore;
	expect(expireNativeOutboxMissed(f.target, p.id)).toBe(false);
	expect(rows(f, p.id)).toEqual(before);
	expect(f.read(p.id)?.state).toBe("NEEDS_REAPPROVAL");
	expect(f.revisions.current(p.binding).lockId).toBeNull();
});

it("authenticates the missed row and released freeze after closing and reopening the same native store", async () => {
	const f = await setup(),
		p = await f.approve(),
		approved = f.read(p.id);
	if (!approved || approved.deliverBy === null) throw new Error("Missing approved fixture window");
	f.base.time.wall = approved.deliverBy + 1;
	expect(expireNativeOutboxMissed(f.target, p.id)).toBe(true);
	const before = rows(f, p.id),
		record = f.read(p.id);
	await f.reopen();
	expect(rows(f, p.id)).toEqual(before);
	expect(f.read(p.id)).toEqual(record);
	expect(f.revisions.current(p.binding).lockId).toBeNull();
	expect(expireNativeOutboxMissed(f.target, p.id)).toBe(false);
	expect(rows(f, p.id)).toEqual(before);
	f.base.native.store.read((db) => f.base.native.audit.verify(db));
});
