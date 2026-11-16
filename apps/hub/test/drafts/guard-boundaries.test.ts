import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { DraftRevision } from "@draftyak/protocol/entities/draft";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { corruptRevisionStorage, signFixtureDraftRow } from "./revision-corruption.ts";
import { revisionFixture } from "./revision-fixture.ts";

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

function rows(f: Awaited<ReturnType<typeof revisionFixture>>) {
	return f.store.read((db) => ({
		headers: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all<{
			draft_id: string;
			rev: number;
			payload: string;
			previous: string;
			mac: string;
		}>("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		audit: db.all("SELECT * FROM audit_events ORDER BY seq"),
		meta: db.all("SELECT * FROM audit_meta"),
	}));
}

describe("independent native revision guard boundaries", () => {
	it("refuses a foreign master key before exposing a service over the live store", async () => {
		const f = await fixture();
		const input = f.make();
		const original = f.create(input);
		const before = rows(f);
		const wrong = new MasterKey(randomBytes(32));
		try {
			expect(() => {
				const opened = new NativeDraftRevisions(f.store, f.audit, wrong, f.clock);
				f.services.push(opened);
			}).toThrow("Draft revision unavailable");
			expect(rows(f)).toEqual(before);
			expect(f.revisions.current(f.bind(input))).toEqual(original);
		} finally {
			wrong.destroy();
		}
	});

	it("refuses reuse of a draft identifier already recorded by this module", async () => {
		const f = await fixture();
		const input = f.make();
		f.store.write((tx) =>
			f.audit.append(tx, {
				id: newId(f.time.now),
				at: f.time.now,
				action: "draft.created",
				actor: { kind: "hub", id: null },
				refs: { draft: input.draftId },
			}),
		);
		const before = rows(f);
		expect(() => f.create(input)).toThrow("Draft revision unavailable");
		expect(rows(f)).toEqual(before);
		const fresh = f.make();
		expect(f.create(fresh).draft.id).toBe(fresh.draftId);
	});

	it("reaches the stored channel guard with an otherwise valid conversation binding", async () => {
		const f = await fixture();
		const input = { ...f.make("email"), conversationId: newId() };
		const original = f.create(input);
		const wrong = { ...f.bind(input), channel: "chat" as const };
		const before = rows(f);
		expect(() => f.revisions.current(wrong)).toThrow("Draft revision unavailable");
		expect(() => f.revisions.history(wrong)).toThrow("Draft revision unavailable");
		expect(rows(f)).toEqual(before);
		expect(f.revisions.current(f.bind(input))).toEqual(original);
	});

	it.each(["revision", "lock"] as const)(
		"refuses a stale %s compare-and-swap before changing header, lock or audit",
		async (field) => {
			const f = await fixture();
			const input = f.make();
			const bound = f.bind(input);
			const snapshot = f.snapshot(f.create(input));
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
			const original = f.revisions.current(bound);
			const lock = original.lockId;
			if (!lock) throw new Error("Fixture must hold a real freeze lock");
			const before = rows(f);
			expect(() =>
				f.store.write((tx) =>
					f.revisions.prepareLockInTransaction(
						tx,
						bound,
						field === "revision" ? 2 : 1,
						field === "lock" ? newId() : lock,
						null,
					),
				),
			).toThrow("Draft revision unavailable");
			expect(rows(f)).toEqual(before);
			expect(f.revisions.current(bound)).toEqual(original);
			expect(
				f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox)),
			).toBeDefined();
		},
	);

	it("binds a changed schedule while holding every other snapshot byte fixed", async () => {
		const f = await fixture();
		const input = f.make();
		const bound = f.bind(input);
		const original = f.create(input);
		const one = f.snapshot(original);
		const before = rows(f);
		let firstHash: string | undefined;
		const rollback = new Error("Discard the first fixture transaction");
		expect(() =>
			f.store.write((tx) => {
				const proof = f.freeze.freezeInTransaction(tx, bound, 1, one);
				firstHash = f.freeze.consumeInTransaction(tx, proof).snapshotHash;
				throw rollback;
			}),
		).toThrow(rollback);
		expect(firstHash).toBe(contentHash(one));
		expect(rows(f)).toEqual(before);
		expect(f.revisions.current(bound)).toEqual(original);
		const two: CurrentSendSnapshotV1 = {
			...one,
			schedule: {
				kind: "at",
				notBefore: f.time.now + 1000,
				zone: "UTC",
				localWallTime: "2027-01-15T08:00+00:00",
				latenessSec: 900,
				holdIfNewInbound: true,
			},
		};
		expect(two.outbox).toBe(one.outbox);
		const { schedule: firstSchedule, ...firstRest } = one;
		const { schedule: secondSchedule, ...secondRest } = two;
		expect(firstRest).toEqual(secondRest);
		expect(firstSchedule).not.toEqual(secondSchedule);
		const facts = f.store.write((tx) => {
			const proof = f.freeze.freezeInTransaction(tx, bound, 1, two);
			return f.freeze.consumeInTransaction(tx, proof);
		});
		expect(facts.snapshotHash).toBe(contentHash(two));
		expect(facts.snapshotHash).not.toBe(firstHash);
		expect(facts.snapshot.schedule).toEqual(two.schedule);
	});

	it("refuses a signed earlier-row replacement at the next revision's previous link", async () => {
		const f = await fixture();
		const input = f.make();
		const bound = f.bind(input);
		const first = f.create(input);
		const second = f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "second revision" },
			}),
		);
		expect(f.revisions.current(bound)).toEqual(second);
		expect(f.revisions.history(bound)).toEqual([first.revision, second.revision]);
		const before = rows(f);
		expect(before.revisions).toHaveLength(2);
		expect(before.revisions[1]?.previous).toBe(before.revisions[0]?.mac);
		corruptRevisionStorage(f, (database) => {
			const stored = database
				.prepare("SELECT * FROM native_draft_revisions WHERE draft_id=? AND rev=1")
				.get(input.draftId) as
				| { draft_id: string; rev: number; payload: string; previous: string; mac: string }
				| undefined;
			if (!stored) throw new Error("Fixture must have an earlier revision");
			expect(stored.previous).toBe("");
			const original = DraftRevision.parse(JSON.parse(stored.payload));
			expect(original).toEqual(first.revision);
			const replacement = DraftRevision.parse({
				...original,
				author: { ...original.author, id: newId(f.time.now) },
			});
			expect(replacement.author.id).not.toBe(original.author.id);
			expect({ ...replacement, author: original.author }).toEqual(original);
			const { mac: oldMac, ...signed } = stored;
			const payload = canonicalize(replacement);
			const mac = signFixtureDraftRow(f, "revision", { binding: bound, ...signed, payload });
			expect(mac).not.toBe(oldMac);
			expect(
				database
					.prepare("UPDATE native_draft_revisions SET payload=?,mac=? WHERE draft_id=? AND rev=1")
					.run(payload, mac, input.draftId).changes,
			).toBe(1);
		});
		const damaged = rows(f);
		expect(damaged.headers).toEqual(before.headers);
		expect(damaged.revisions.slice(1)).toEqual(before.revisions.slice(1));
		expect(() => f.revisions.current(bound)).toThrow("Draft revision unavailable");
		expect(() => f.revisions.history(bound)).toThrow("Draft revision unavailable");
		expect(f.store.read((db) => db.all("SELECT id FROM revision_parent"))).toEqual([]);
		expect(() =>
			f.store.write((tx) => {
				tx.run("INSERT INTO revision_parent(id) VALUES(987654)");
				f.revisions.appendInTransaction(tx, { ...input, expectedRev: 2 });
			}),
		).toThrow("Draft revision unavailable");
		expect(rows(f)).toEqual(damaged);
		expect(f.store.read((db) => db.all("SELECT id FROM revision_parent"))).toEqual([]);
	});

	it("refuses an authentic second row with the wrong previous-revision link", async () => {
		const f = await fixture();
		const input = f.make();
		const bound = f.bind(input);
		f.create(input);
		f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "second revision" },
			}),
		);
		corruptRevisionStorage(f, (database) => {
			const stored = database
				.prepare(
					"SELECT draft_id,rev,payload,previous FROM native_draft_revisions WHERE draft_id=? AND rev=2",
				)
				.get(input.draftId) as
				| {
						draft_id: string;
						rev: number;
						payload: string;
						previous: string;
				  }
				| undefined;
			if (!stored) throw new Error("Fixture must have a second revision");
			const previous = "0".repeat(64);
			expect(stored.previous).not.toBe(previous);
			const signed = { ...stored, previous };
			const mac = signFixtureDraftRow(f, "revision", { binding: bound, ...signed });
			database
				.prepare("UPDATE native_draft_revisions SET previous=?,mac=? WHERE draft_id=? AND rev=2")
				.run(previous, mac, input.draftId);
		});
		expect(() => f.revisions.current(bound)).toThrow("Draft revision unavailable");
		expect(() => f.revisions.history(bound)).toThrow("Draft revision unavailable");
		expect(() =>
			f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 2 })),
		).toThrow("Draft revision unavailable");
		expect(
			canonicalize(f.store.read((db) => db.all("SELECT * FROM native_draft_revisions"))),
		).toContain("second revision");
	});
});
