import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { type FrozenRevisionProof, NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { type DraftBinding, NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { PinService } from "../../src/identity/pin.ts";
import { newId } from "../../src/kernel/ids.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: Awaited<ReturnType<typeof revisionFixture>>[] = [];
async function fixture() {
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
const storedRows = (f: RevisionFixture) =>
	f.store.read((db) => ({
		locks: db.all(
			"SELECT id,draft_id,outbox_id,payload,audit_seq,mac FROM native_draft_locks ORDER BY id",
		),
		headers: db.all("SELECT id,payload,audit_seq,mac FROM native_drafts ORDER BY id"),
		head: db.get("SELECT audit_seq,audit_head,audit_tag FROM audit_meta WHERE singleton=1"),
	}));
const discard = (f: RevisionFixture, bound: DraftBinding): void => {
	f.store.write((tx) => {
		const row = tx.get<{ id: string; payload: string; audit_seq: number }>(
			"SELECT id,payload,audit_seq FROM native_drafts WHERE id=?",
			[bound.draftId],
		);
		if (!row) throw new Error("missing header");
		const header = JSON.parse(row.payload),
			signed = {
				...row,
				payload: canonicalize({ ...header, draft: { ...header.draft, state: "discarded" } }),
			};
		tx.run("UPDATE native_drafts SET payload=?,mac=? WHERE id=?", [
			signed.payload,
			f.revisions.sign("header", signed),
			row.id,
		]);
	});
	expect(f.revisions.current(bound).draft.state).toBe("discarded");
};
describe("native frozen revision data proofs", () => {
	it.each(["stale revision", "non-open draft", "existing lock"] as const)(
		"leaves no freeze writes when a caught %s refusal is committed",
		async (kind) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				snapshot = f.snapshot(f.create(input));
			if (kind === "non-open draft") discard(f, bound);
			if (kind === "existing lock")
				f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
			const before = storedRows(f),
				candidate = { ...snapshot, outbox: newId() };
			f.store.write((tx) => {
				expect(() =>
					f.freeze.freezeInTransaction(tx, bound, kind === "stale revision" ? 2 : 1, candidate),
				).toThrow("Draft revision unavailable");
				tx.run("INSERT INTO revision_parent(id) VALUES(1)");
			});
			expect(f.store.read((db) => db.all("SELECT id FROM revision_parent"))).toEqual([{ id: 1 }]);
			expect(storedRows(f)).toEqual(before);
		},
	);
	it("leaves no release writes when a caught non-open draft refusal is committed", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		discard(f, bound);
		f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox));
		const before = storedRows(f);
		f.store.write((tx) => {
			expect(() => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox)).toThrow(
				"Draft revision unavailable",
			);
			tx.run("INSERT INTO revision_parent(id) VALUES(1)");
		});
		expect(f.store.read((db) => db.all("SELECT id FROM revision_parent"))).toEqual([{ id: 1 }]);
		expect(storedRows(f)).toEqual(before);
	});
	it.each(["email", "chat"] as const)(
		"freezes actual %s revision hashes and keeps the lock through one-use consumption",
		async (channel) => {
			const f = await fixture(),
				input = f.make(channel),
				current = f.create(input),
				bound = f.bind(input),
				snapshot = f.snapshot(current),
				proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
			expect(() =>
				f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 })),
			).toThrow("Draft revision unavailable");
			const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
			expect(facts.snapshotHash).toBe(contentHash(snapshot));
			expect(facts.revisionContentHash).toBe(current.revision.contentSha256);
			expect(facts.flagsHash).toBe(current.flagsHash);
			expect(facts.rev).toBe(1);
			expect(facts.outboxId).toBe(snapshot.outbox);
			expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
				"Draft revision unavailable",
			);
			expect(() =>
				f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
			).toThrow("Draft revision unavailable");
			expect(f.revisions.current(bound).lockId).not.toBeNull();
			expect(() =>
				f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox)),
			).toThrow("Draft revision unavailable");
		},
	);
	it("allows at most one live outbox lock and refuses stale rev or altered source binding", async () => {
		const f = await fixture(),
			input = f.make(),
			current = f.create(input),
			bound = f.bind(input),
			snapshot = f.snapshot(current);
		for (const bad of [
			{ ...snapshot, account: newId() },
			{ ...snapshot, source: { ...snapshot.source, rev: 2 } },
			{
				...snapshot,
				source: {
					...snapshot.source,
					authors: [...snapshot.source.authors, ...snapshot.source.authors],
				},
			},
		])
			expect(() => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, bad))).toThrow(
				"Draft revision unavailable",
			);
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, snapshot)),
		).toThrow("Draft revision unavailable");
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		expect(() =>
			f.store.write((tx) =>
				f.freeze.freezeInTransaction(tx, bound, 1, { ...snapshot, outbox: newId() }),
			),
		).toThrow("Draft revision unavailable");
	});
	it.each(["body", "recipients", "subject", "attachments"])(
		"refuses snapshot %s changes beyond actual immutable revision",
		async (field) => {
			const f = await fixture(),
				input = f.make(),
				current = f.create(input),
				snapshot = f.snapshot(current);
			if (snapshot.kind !== "email") throw new Error("email fixture");
			const bad = {
				...snapshot,
				...(field === "body"
					? { body: { ...snapshot.body, text: "changed" } }
					: field === "attachments"
						? { attachments: [] }
						: {
								email: {
									...snapshot.email,
									...(field === "recipients"
										? { to: ["different@example.test"] }
										: { subject: "changed" }),
								},
							}),
			};
			expect(() =>
				f.store.write((tx) => f.freeze.freezeInTransaction(tx, f.bind(input), 1, bad)),
			).toThrow("Draft revision unavailable");
			expect(f.revisions.current(f.bind(input)).lockId).toBeNull();
		},
	);
	it("refuses snapshot chat thread changes and missing sharing facts", async () => {
		const f = await fixture(),
			input = f.make("chat"),
			snapshot = f.snapshot(f.create(input));
		if (snapshot.kind !== "chat") throw new Error("chat fixture");
		const bad = { ...snapshot, chat: { ...snapshot.chat, threadTs: "different" } };
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, f.bind(input), 1, bad)),
		).toThrow("Draft revision unavailable");
		const legacy = structuredClone(snapshot);
		delete (legacy.chat as { shared?: boolean }).shared;
		expect(() =>
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, f.bind(input), 1, legacy)),
		).toThrow("Draft revision unavailable");
	});
	it("binds schedule bytes in the snapshot hash and requires a new outbox after release", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			current = f.create(input),
			one = f.snapshot(current);
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, one.outbox));
		expect(() => f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one))).toThrow(
			"Draft revision unavailable",
		);
		const two: CurrentSendSnapshotV1 = {
				...one,
				outbox: newId(),
				schedule: {
					kind: "at",
					notBefore: f.time.now + 1000,
					zone: "UTC",
					localWallTime: "2027-01-15T08:00+00:00",
					latenessSec: 900,
					holdIfNewInbound: true,
				},
			},
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, two)),
			facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		expect(facts.snapshotHash).toBe(contentHash(two));
		expect(facts.snapshotHash).not.toBe(contentHash({ ...two, schedule: one.schedule }));
		expect(facts.snapshot.schedule).toEqual(two.schedule);
	});
	it("invalidates old data proofs on release and edit, then freezes the actual next revision", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, one));
		f.store.write((tx) => {
			f.freeze.releaseInTransaction(tx, bound, one.outbox);
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "revision two" },
			});
		});
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
			"Draft revision unavailable",
		);
		const current = f.revisions.current(bound),
			two = f.snapshot(current),
			fresh = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, two));
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).rev).toBe(2);
	});
	it("rejects forged, cross-store and retired-transaction proofs and preserves the real lock", async () => {
		const f = await fixture(),
			other = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		expect(() =>
			f.store.write((tx) => f.freeze.consumeInTransaction(tx, {} as FrozenRevisionProof)),
		).toThrow("Draft revision unavailable");
		expect(() => other.store.write((tx) => other.freeze.consumeInTransaction(tx, proof))).toThrow(
			"Draft revision unavailable",
		);
		let ended: SqlTransaction | undefined;
		f.store.write((tx) => {
			ended = tx;
		});
		expect(() =>
			f.freeze.proofInTransaction(ended as SqlTransaction, bound, snapshot.outbox),
		).toThrow("Draft revision unavailable");
		const fresh = f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox));
		expect(
			f.store.write((tx) => new NativeDraftFreeze(f.revisions).consumeInTransaction(tx, fresh))
				.outboxId,
		).toBe(snapshot.outbox);
	});
	it("rolls back the lock and audit when real scoped PIN knowledge fails in the same transaction", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			pins = new PinService(f.store, f.audit, f.clock),
			user = newId();
		f.store.write((tx) =>
			tx.run("INSERT INTO users(id,created_at) VALUES(?,?)", [user, f.time.now]),
		);
		await pins.initialize(user, "738294");
		// This scope proves transaction composition only. PIN knowledge is not a device grant.
		const proof = await pins.verify(user, "738294", "storage-fixture:freeze");
		expect(() =>
			f.store.write((tx) => {
				f.freeze.freezeInTransaction(tx, bound, 1, snapshot);
				pins.consume(tx, proof, user, "storage-fixture:wrong");
			}),
		).toThrow(expect.objectContaining({ code: "PIN_REQUIRED" }));
		expect(f.revisions.current(bound).lockId).toBeNull();
		const nextPin = await pins.verify(user, "738294", "storage-fixture:freeze");
		const facts = f.store.write((tx) => {
			const frozen = f.freeze.freezeInTransaction(tx, bound, 1, snapshot);
			pins.consume(tx, nextPin, user, "storage-fixture:freeze");
			return f.freeze.consumeInTransaction(tx, frozen);
		});
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
		pins.lock();
	});
	it("cannot consume a proof whose lock transaction failed to commit", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		let proof: FrozenRevisionProof | undefined;
		expect(() =>
			f.store.write((tx) => {
				proof = f.freeze.freezeInTransaction(tx, bound, 1, snapshot);
				tx.run("INSERT INTO revision_child(id) VALUES(99)");
			}),
		).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }));
		expect(f.revisions.current(bound).lockId).toBeNull();
		expect(() =>
			f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof as FrozenRevisionProof)),
		).toThrow("Draft revision unavailable");
	});
	it("authenticates stored frozen flags and refuses old active-lock resurrection after consumption", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			old = f.store.read((db) =>
				db.get<{ id: string; payload: string; audit_seq: number; mac: string }>(
					"SELECT id,payload,audit_seq,mac FROM native_draft_locks WHERE outbox_id=?",
					[snapshot.outbox],
				),
			);
		if (!old) throw new Error("missing lock");
		f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		f.store.write((tx) =>
			tx.run("UPDATE native_draft_locks SET payload=?,audit_seq=?,mac=? WHERE id=?", [
				old.payload,
				old.audit_seq,
				old.mac,
				old.id,
			]),
		);
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow("Draft revision unavailable");
		const payload = JSON.parse(old.payload);
		payload.flagsHash = "0".repeat(64);
		f.store.write((tx) =>
			tx.run("UPDATE native_draft_locks SET payload=? WHERE id=?", [canonicalize(payload), old.id]),
		);
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow("Draft revision unavailable");
	});
	it("allows exactly one consumption across two real proofs of the same active data lock", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		// Each proof comes from its own real connection to the same encrypted database.
		const store = new HubStore(f.options),
			revisions = new NativeDraftRevisions(store, f.audit, f.key, f.clock),
			freeze = new NativeDraftFreeze(revisions);
		f.stores.push(store);
		f.services.push(revisions);
		const first = f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
			second = store.write((tx) => freeze.proofInTransaction(tx, bound, snapshot.outbox));
		const results = await Promise.allSettled([
			Promise.resolve().then(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, first))),
			Promise.resolve().then(() => store.write((tx) => freeze.consumeInTransaction(tx, second))),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(
			f.store.read((db) =>
				db.all("SELECT 1 FROM audit_events WHERE action='draft.freeze_consumed'"),
			),
		).toHaveLength(1);
	});
});
