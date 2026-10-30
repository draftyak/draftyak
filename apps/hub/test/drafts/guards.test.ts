import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { openEncrypted } from "../../src/store/open.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
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
interface LockPayload {
	status: string;
	snapshot: { schedule: unknown; body: { footer: string } };
}
function lockRow(f: RevisionFixture, outbox: string) {
	const row = f.store.read((db) =>
		db.get<{ id: string; payload: string; audit_seq: number; mac: string }>(
			"SELECT id,payload,audit_seq,mac FROM native_draft_locks WHERE outbox_id=?",
			[outbox],
		),
	);
	if (!row) throw new Error("missing lock");
	return row;
}
function editLock(f: RevisionFixture, id: string, edit: (payload: LockPayload) => void): void {
	f.store.write((tx) => {
		const row = tx.get<{ payload: string }>("SELECT payload FROM native_draft_locks WHERE id=?", [
			id,
		]);
		if (!row) throw new Error("missing lock");
		const payload = JSON.parse(row.payload) as LockPayload;
		edit(payload);
		tx.run("UPDATE native_draft_locks SET payload=? WHERE id=?", [canonicalize(payload), id]);
	});
}
const activeLocks = (f: RevisionFixture, draftId: string): number =>
	f.store
		.read((db) =>
			db.all<{ payload: string }>("SELECT payload FROM native_draft_locks WHERE draft_id=?", [
				draftId,
			]),
		)
		.filter((row) => (JSON.parse(row.payload) as LockPayload).status === "active").length;
const statusOf = (f: RevisionFixture, id: string): string | undefined => {
	const row = f.store.read((db) =>
		db.get<{ payload: string }>("SELECT payload FROM native_draft_locks WHERE id=?", [id]),
	);
	return row && (JSON.parse(row.payload) as LockPayload).status;
};
const consumptions = (f: RevisionFixture): number =>
	f.store.read((db) => db.all("SELECT 1 FROM audit_events WHERE action='draft.freeze_consumed'"))
		.length;
const auditSeq = (tx: SqlTransaction): number =>
	tx.get<{ audit_seq: number }>("SELECT audit_seq FROM audit_meta WHERE singleton=1")
		?.audit_seq as number;
const auditHead = (tx: SqlTransaction): string =>
	tx.get<{ audit_head: string }>("SELECT audit_head FROM audit_meta WHERE singleton=1")
		?.audit_head as string;

describe("native draft guards each refuse on their own", () => {
	it("refuses a keyless header edit that clears the lock while its lock row stays active", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		f.store.write((tx) => {
			const row = tx.get<{ payload: string }>("SELECT payload FROM native_drafts WHERE id=?", [
				input.draftId,
			]);
			if (!row) throw new Error("missing header");
			tx.run("UPDATE native_drafts SET payload=? WHERE id=?", [
				canonicalize({ ...JSON.parse(row.payload), lockId: null }),
				input.draftId,
			]);
		});
		expect(() => f.revisions.current(bound)).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 })),
		).toThrow(refused);
		expect(() =>
			f.store.write((tx) =>
				f.freeze.freezeInTransaction(tx, bound, 1, { ...one, outbox: newId() }),
			),
		).toThrow(refused);
		expect(activeLocks(f, input.draftId)).toBe(1);
	});
	it.each(["schedule", "footer"] as const)(
		"refuses a keyless edit of the frozen %s",
		async (field) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				one = f.snapshot(f.create(input));
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
			editLock(f, lockRow(f, one.outbox).id, (payload) => {
				if (field === "schedule")
					payload.snapshot.schedule = {
						kind: "at",
						notBefore: f.time.now + 1000,
						zone: "UTC",
						localWallTime: "2027-01-15T08:00+00:00",
						latenessSec: 86400,
						holdIfNewInbound: false,
					};
				else payload.snapshot.body.footer = "Changed footer";
			});
			expect(() =>
				f.store.write((tx) =>
					f.freeze.consumeInTransaction(tx, f.freeze.proofInTransaction(tx, bound, one.outbox)),
				),
			).toThrow(refused);
			expect(consumptions(f)).toBe(0);
		},
	);
	it("refuses a consumed lock flipped back to active under its current audit position", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		editLock(f, lockRow(f, one.outbox).id, (payload) => {
			payload.status = "active";
		});
		expect(() =>
			f.store.write((tx) =>
				f.freeze.consumeInTransaction(tx, f.freeze.proofInTransaction(tx, bound, one.outbox)),
			),
		).toThrow(refused);
		expect(consumptions(f)).toBe(1);
	});
	it("refuses every read and transaction entry after a keyed rollback hides a later revision", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		f.create(input);
		const old = f.store.read((db) =>
			db.get<{ payload: string; audit_seq: number; mac: string }>(
				"SELECT payload,audit_seq,mac FROM native_drafts WHERE id=?",
				[input.draftId],
			),
		);
		f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "revision two" },
			}),
		);
		const seq = f.store.read(
			(db) =>
				db.get<{ audit_seq: number }>("SELECT audit_seq FROM native_drafts WHERE id=?", [
					input.draftId,
				])?.audit_seq,
		);
		if (!old || !seq) throw new Error("missing rows");
		const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			raw.exec("DROP TRIGGER audit_no_update");
			raw
				.prepare("DELETE FROM native_draft_revisions WHERE draft_id=? AND rev=2")
				.run(input.draftId);
			raw
				.prepare("UPDATE native_drafts SET payload=?,audit_seq=?,mac=? WHERE id=?")
				.run(old.payload, old.audit_seq, old.mac, input.draftId);
			raw
				.prepare("UPDATE audit_events SET refs=? WHERE seq=?")
				.run(canonicalize({ draft: newId() }), seq);
		} finally {
			raw.close();
		}
		expect(() => f.revisions.current(bound)).toThrow(refused);
		expect(() => f.revisions.history(bound)).toThrow(refused);
		expect(() => f.store.write((tx) => f.revisions.currentInTransaction(tx, bound))).toThrow(
			refused,
		);
		expect(() => f.revisions.read((db) => db.get("SELECT 1 AS one"))).toThrow(
			"Audit chain verification failed",
		);
		expect(() => f.revisions.write((tx) => tx.get("SELECT 1 AS one"))).toThrow(
			"Audit chain verification failed",
		);
	});
	it("keeps an old released-outbox proof and release away from the next outbox's live lock", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input)),
			oldProof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, one.outbox));
		const two: CurrentSendSnapshotV1 = { ...one, outbox: newId() },
			newProof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, two));
		expect(() =>
			f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, one.outbox)),
		).toThrow(refused);
		expect(() => f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, one.outbox))).toThrow(
			refused,
		);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, oldProof))).toThrow(
			refused,
		);
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, newProof)).outboxId).toBe(
			two.outbox,
		);
	});
	it("spends a proof even when its consuming transaction rolls back", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		expect(() =>
			f.store.write((tx) => {
				f.freeze.consumeInTransaction(tx, proof);
				throw new Error("later step failed");
			}),
		).toThrow("later step failed");
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(refused);
		f.store.write((tx) =>
			f.freeze.consumeInTransaction(tx, f.freeze.proofInTransaction(tx, bound, one.outbox)),
		);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(refused);
		expect(consumptions(f)).toBe(1);
	});
	it.each(["cc", "bcc"] as const)(
		"refuses a snapshot adding %s recipients beyond the revision",
		async (field) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				snapshot = f.snapshot(f.create(input));
			if (snapshot.kind !== "email") throw new Error("email fixture");
			const bad = { ...snapshot, email: { ...snapshot.email, [field]: ["hidden@example.test"] } };
			expect(() =>
				f.store.write((tx) =>
					f.freeze.consumeInTransaction(tx, f.freeze.freezeInTransaction(tx, bound, 1, bad)),
				),
			).toThrow(refused);
			expect(f.revisions.current(bound).lockId).toBeNull();
		},
	);
	it.each(["conversation", "source draft"] as const)(
		"refuses an email snapshot naming another %s",
		async (field) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				snapshot = f.snapshot(f.create(input));
			const bad =
				field === "conversation"
					? { ...snapshot, conversation: newId() }
					: { ...snapshot, source: { ...snapshot.source, draft: newId() } };
			expect(() => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, bad))).toThrow(
				refused,
			);
			expect(f.revisions.current(bound).lockId).toBeNull();
		},
	);
	it.each(["another conversation", "a broadcast reply", "attachments"] as const)(
		"refuses a chat snapshot with %s beyond the revision",
		async (field) => {
			const f = await fixture(),
				input = f.make("chat"),
				bound = f.bind(input),
				snapshot = f.snapshot(f.create(input));
			if (snapshot.kind !== "chat") throw new Error("chat fixture");
			const bad: CurrentSendSnapshotV1 =
				field === "another conversation"
					? { ...snapshot, conversation: newId() }
					: field === "a broadcast reply"
						? { ...snapshot, chat: { ...snapshot.chat, broadcast: true } }
						: {
								...snapshot,
								attachments: [
									{
										filename: "example.txt",
										contentType: "text/plain",
										size: 3,
										sha256: "a".repeat(64),
									},
								],
							};
			expect(() => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, bad))).toThrow(
				refused,
			);
			expect(f.revisions.current(bound).lockId).toBeNull();
		},
	);
	it("model body append refuses every other author kind", async () => {
		const f = await fixture(),
			input = f.make();
		f.create(input);
		for (const kind of ["owner", "agent", "plugin"] as const)
			expect(() =>
				f.store.write((tx) =>
					f.revisions.appendModelBodyInTransaction(tx, {
						...f.bind(input),
						expectedRev: 1,
						author: { kind, id: newId() },
						body: "changed",
						flags: [],
					}),
				),
			).toThrow(refused);
		expect(f.revisions.current(f.bind(input)).draft.rev).toBe(1);
	});
	it("consumes only the proof's own lock even if another lock row shares its outbox", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			first = lockRow(f, snapshot.outbox);
		const raw = openEncrypted({ filename: f.filename, nativeBinding }, f.key);
		try {
			raw.exec(
				[
					"CREATE TABLE lock_copy(id TEXT PRIMARY KEY NOT NULL, draft_id TEXT NOT NULL REFERENCES native_drafts(id), outbox_id TEXT NOT NULL, payload TEXT NOT NULL, audit_seq INTEGER NOT NULL, mac TEXT NOT NULL) STRICT",
					"INSERT INTO lock_copy SELECT * FROM native_draft_locks",
					"DROP TABLE native_draft_locks",
					"ALTER TABLE lock_copy RENAME TO native_draft_locks",
				].join(";"),
			);
		} finally {
			raw.close();
		}
		// Written as a keyed writer would: an authentic second lock row for the same outbox.
		const key = f.key.derive("drafts"),
			sign = (domain: string, value: unknown): string =>
				createHmac("sha256", key)
					.update(`draftyak/draft-${domain}/v1\n`)
					.update(canonicalize(value))
					.digest("hex"),
			second = newId(),
			event = (action: string, refs: Record<string, string>) => ({
				id: newId(),
				at: f.time.now,
				action,
				actor: { kind: "hub" as const, id: null },
				refs,
			});
		try {
			f.store.write((tx) => {
				f.audit.append(
					tx,
					event("draft.freeze_active", {
						draft: input.draftId,
						freeze: second,
						outbox: snapshot.outbox,
					}),
				);
				const lock = {
					id: second,
					draft_id: input.draftId,
					outbox_id: snapshot.outbox,
					payload: canonicalize({ ...JSON.parse(first.payload), auditEventMac: auditHead(tx) }),
					audit_seq: auditSeq(tx),
				};
				tx.run(
					"INSERT INTO native_draft_locks(id,draft_id,outbox_id,payload,audit_seq,mac) VALUES(?,?,?,?,?,?)",
					[...Object.values(lock), sign("freeze", lock)],
				);
				f.audit.append(tx, event("draft.locked", { draft: input.draftId }));
				const stored = tx.get<{ payload: string }>("SELECT payload FROM native_drafts WHERE id=?", [
						input.draftId,
					]),
					header = {
						id: input.draftId,
						payload: canonicalize({
							...JSON.parse(stored?.payload ?? "{}"),
							lockId: second,
							auditEventMac: auditHead(tx),
						}),
						audit_seq: auditSeq(tx),
					};
				tx.run("UPDATE native_drafts SET payload=?,audit_seq=?,mac=? WHERE id=?", [
					header.payload,
					header.audit_seq,
					sign("header", header),
					input.draftId,
				]);
			});
		} finally {
			key.fill(0);
		}
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(refused);
		expect(consumptions(f)).toBe(0);
		const facts = f.store.write((tx) =>
			f.freeze.consumeInTransaction(tx, f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		);
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
		expect([statusOf(f, first.id), statusOf(f, second)]).toEqual(["active", "consumed"]);
	});
	it("lets setLockInTransaction set only an active lock row of the same draft", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			other = f.make(),
			otherSnapshot = f.snapshot(f.create(other));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, f.bind(other), 1, otherSnapshot));
		const set = (expectedLock: string | null, lockId: string) => () =>
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, expectedLock, lockId));
		expect(set(null, newId())).toThrow(refused);
		expect(set(null, lockRow(f, otherSnapshot.outbox).id)).toThrow(refused);
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const active = lockRow(f, snapshot.outbox),
			own = active.id;
		f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, own, null));
		expect(set(null, own)().lockId).toBe(own);
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
		expect(set(null, own)).toThrow(refused);
		f.store.write((tx) =>
			tx.run("UPDATE native_draft_locks SET payload=?,audit_seq=?,mac=? WHERE id=?", [
				active.payload,
				active.audit_seq,
				active.mac,
				own,
			]),
		);
		expect(set(null, own)).toThrow(refused);
		const next = { ...snapshot, outbox: newId() },
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, next));
		f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		const consumed = lockRow(f, next.outbox).id;
		expect(set(consumed, consumed)).toThrow(refused);
		expect(f.revisions.current(bound).lockId).toBe(consumed);
	});
	it("refuses a consuming facade on another store object for the same file", async () => {
		const f = await fixture(),
			other = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		expect(() => other.store.write((tx) => other.freeze.consumeInTransaction(tx, proof))).toThrow(
			refused,
		);
		const facade = new HubStore(f.options);
		f.stores.push(facade);
		const facadeRevisions = new NativeDraftRevisions(facade, f.audit, f.key, f.clock);
		f.services.push(facadeRevisions);
		const facadeFreeze = new NativeDraftFreeze(facadeRevisions),
			second = f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, one.outbox));
		expect(() => facade.write((tx) => facadeFreeze.consumeInTransaction(tx, second))).toThrow(
			refused,
		);
		expect(consumptions(f)).toBe(0);
	});
	it("refuses a released outbox id again, also after its lock row is deleted", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, one.outbox));
		expect(() => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one))).toThrow(
			refused,
		);
		f.store.write((tx) => tx.run("DELETE FROM native_draft_locks WHERE outbox_id=?", [one.outbox]));
		expect(() => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one))).toThrow(
			refused,
		);
		expect(f.revisions.current(bound).lockId).toBeNull();
	});
	it("refuses a direct lock change whose expected lock is stale, even for the draft's own lock", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		const own = lockRow(f, one.outbox).id;
		expect(() =>
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, null, own)),
		).toThrow(refused);
		expect(() =>
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 1, newId(), null)),
		).toThrow(refused);
		expect(() =>
			f.store.write((tx) =>
				f.freeze.freezeInTransaction(tx, bound, 1, { ...one, outbox: newId() }),
			),
		).toThrow(refused);
		expect(f.revisions.current(bound).lockId).toBe(own);
	});
});
