import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { HubStore } from "../../src/store/store.ts";
import { revisionFixture } from "./revision-fixture.ts";

type Fixture = Awaited<ReturnType<typeof revisionFixture>>;
const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
	const value = await revisionFixture();
	fixtures.push(value);
	return value;
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

function stored(f: Fixture) {
	return f.store.read((db) => ({
		headers: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		audit: db.all("SELECT * FROM audit_events ORDER BY seq"),
		meta: db.all("SELECT * FROM audit_meta"),
	}));
}

function withoutField(snapshot: CurrentSendSnapshotV1, path: readonly string[]) {
	const result = JSON.parse(canonicalize(snapshot));
	let parent = result;
	for (const key of path.slice(0, -1)) parent = parent[key];
	const field = path.at(-1);
	if (field === undefined) throw new Error("snapshot field required");
	delete parent[field];
	return result;
}

describe("native freeze integrity boundaries", () => {
	it.each([
		["conversation", "email", ["conversation"]],
		["source draft", "email", ["source", "draft"]],
		["cc", "email", ["email", "cc"]],
		["bcc", "email", ["email", "bcc"]],
		["broadcast", "chat", ["chat", "broadcast"]],
		["chat attachments", "chat", ["attachments"]],
	] as const)(
		"refuses a schema-valid %s mismatch before writing a lock",
		async (field, channel, path) => {
			const f = await fixture(),
				input = f.make(channel),
				bound = f.bind(input),
				current = f.create(input),
				snapshot = f.snapshot(current);
			let changed: CurrentSendSnapshotV1;
			switch (field) {
				case "conversation":
					changed = { ...snapshot, conversation: newId() };
					break;
				case "source draft":
					changed = { ...snapshot, source: { ...snapshot.source, draft: newId() } };
					break;
				case "cc":
				case "bcc":
					if (snapshot.kind !== "email") throw new Error("email fixture required");
					changed = {
						...snapshot,
						email: { ...snapshot.email, [field]: ["another@example.test"] },
					};
					break;
				case "broadcast":
					if (snapshot.kind !== "chat") throw new Error("chat fixture required");
					changed = {
						...snapshot,
						chat: { ...snapshot.chat, broadcast: !snapshot.chat.broadcast },
					};
					break;
				case "chat attachments":
					changed = {
						...snapshot,
						attachments: [
							{
								filename: "synthetic.txt",
								contentType: "text/plain",
								size: 0,
								sha256: "0".repeat(64),
							},
						],
					};
					break;
			}
			// The wire schema admits each variant; the stored revision must reject it.
			expect(CurrentSendSnapshotV1.parse(changed)).toEqual(changed);
			expect(withoutField(changed, path)).toEqual(withoutField(snapshot, path));
			expect(contentHash(changed)).not.toBe(contentHash(snapshot));
			const before = stored(f);
			expect(() =>
				f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, changed)),
			).toThrow("Draft revision unavailable");
			expect(stored(f)).toEqual(before);
			expect(f.revisions.current(bound)).toEqual(current);
			const facts = f.store.write((tx) => {
				const proof = f.freeze.freezeInTransaction(tx, bound, 1, snapshot);
				return f.freeze.consumeInTransaction(tx, proof);
			});
			expect(facts.snapshot).toEqual(snapshot);
			expect(facts.snapshotHash).toBe(contentHash(snapshot));
		},
	);

	it("does not let a released proof consume a replacement lock at the same revision", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			oldProof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			oldLock = f.revisions.current(bound).lockId;
		f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
		const replacement = { ...snapshot, outbox: newId() },
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, replacement)),
			current = f.revisions.current(bound),
			before = stored(f);
		expect(current.draft.rev).toBe(1);
		expect(current.lockId).not.toBeNull();
		expect(current.lockId).not.toBe(oldLock);
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, oldProof))).toThrow(
			"Draft revision unavailable",
		);
		expect(stored(f)).toEqual(before);
		expect(f.revisions.current(bound)).toEqual(current);
		const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		expect(facts.outboxId).toBe(replacement.outbox);
		expect(facts.rev).toBe(1);
		expect(facts.snapshotHash).toBe(contentHash(replacement));
	});

	it("accepts a proof through another revision service sharing the exact HubStore", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			service = new NativeDraftRevisions(f.store, f.audit, f.key, f.clock),
			freeze = new NativeDraftFreeze(service);
		f.services.push(service);
		const facts = f.store.write((tx) => freeze.consumeInTransaction(tx, proof));
		expect(facts.outboxId).toBe(snapshot.outbox);
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
		expect(() =>
			f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
		).toThrow("Draft revision unavailable");
	});

	it("rejects a proof on a second HubStore opening the same encrypted database", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			otherStore = new HubStore(f.options),
			otherService = new NativeDraftRevisions(otherStore, f.audit, f.key, f.clock),
			otherFreeze = new NativeDraftFreeze(otherService);
		f.stores.push(otherStore);
		f.services.push(otherService);
		// Matching file, key, audit chain, and persisted lock do not identify a store facade.
		expect(otherService.current(bound)).toEqual(f.revisions.current(bound));
		const before = stored(f);
		expect(() => otherStore.write((tx) => otherFreeze.consumeInTransaction(tx, proof))).toThrow(
			"Draft revision unavailable",
		);
		expect(stored(f)).toEqual(before);
		// The rejected handle is one-use, while its original persisted lock remains usable.
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
			"Draft revision unavailable",
		);
		const facts = f.store.write((tx) => {
			const fresh = f.freeze.proofInTransaction(tx, bound, snapshot.outbox);
			return f.freeze.consumeInTransaction(tx, fresh);
		});
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
	});

	it("authenticates a changed header even when its audit sequence is still current", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			current = f.create(input),
			row = f.store.read((db) =>
				db.get<{ payload: string; audit_seq: number; mac: string }>(
					"SELECT payload,audit_seq,mac FROM native_drafts WHERE id=?",
					[input.draftId],
				),
			);
		if (!row) throw new Error("header fixture missing");
		const payload = JSON.parse(row.payload);
		payload.draft.updatedAt++;
		f.store.write((tx) =>
			tx.run("UPDATE native_drafts SET payload=? WHERE id=?", [
				canonicalize(payload),
				input.draftId,
			]),
		);
		const latest = f.store.read((db) =>
			db.get<{ seq: number }>(
				"SELECT seq FROM audit_events WHERE refs=? ORDER BY seq DESC LIMIT 1",
				[canonicalize({ draft: input.draftId })],
			),
		);
		expect(latest?.seq).toBe(row.audit_seq);
		const damaged = stored(f);
		try {
			expect(() => f.revisions.current(bound)).toThrow("Draft revision unavailable");
			expect(() => f.revisions.history(bound)).toThrow("Draft revision unavailable");
			expect(stored(f)).toEqual(damaged);
		} finally {
			f.store.write((tx) =>
				tx.run("UPDATE native_drafts SET payload=? WHERE id=?", [row.payload, input.draftId]),
			);
		}
		expect(f.revisions.current(bound)).toEqual(current);
		expect(f.revisions.history(bound)).toEqual([current.revision]);
	});

	it("authenticates a changed active lock even when its audit sequence is still current", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input)),
			proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			row = f.store.read((db) =>
				db.get<{ id: string; payload: string; audit_seq: number; mac: string }>(
					"SELECT id,payload,audit_seq,mac FROM native_draft_locks WHERE outbox_id=?",
					[snapshot.outbox],
				),
			);
		if (!row) throw new Error("lock fixture missing");
		const payload = JSON.parse(row.payload);
		payload.createdAt--;
		f.store.write((tx) =>
			tx.run("UPDATE native_draft_locks SET payload=? WHERE id=?", [canonicalize(payload), row.id]),
		);
		const latest = f.store.read((db) =>
			db.get<{ seq: number }>(
				"SELECT seq FROM audit_events WHERE refs=? ORDER BY seq DESC LIMIT 1",
				[canonicalize({ draft: input.draftId, freeze: row.id, outbox: snapshot.outbox })],
			),
		);
		expect(latest?.seq).toBe(row.audit_seq);
		const damaged = stored(f);
		try {
			expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
				"Draft revision unavailable",
			);
			expect(() =>
				f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
			).toThrow("Draft revision unavailable");
			expect(stored(f)).toEqual(damaged);
		} finally {
			f.store.write((tx) =>
				tx.run("UPDATE native_draft_locks SET payload=? WHERE id=?", [row.payload, row.id]),
			);
		}
		const facts = f.store.write((tx) => {
			const fresh = f.freeze.proofInTransaction(tx, bound, snapshot.outbox);
			return f.freeze.consumeInTransaction(tx, fresh);
		});
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
	});
});
