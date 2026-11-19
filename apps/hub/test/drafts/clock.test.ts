import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
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
const YEAR = 365 * 24 * 3600 * 1000;
const lockTimes = (f: RevisionFixture, outbox: string): [number, number] => {
	const row = f.store.read((db) =>
		db.get<{ payload: string }>("SELECT payload FROM native_draft_locks WHERE outbox_id=?", [
			outbox,
		]),
	);
	const payload = JSON.parse(row?.payload ?? "{}") as { createdAt: number; updatedAt: number };
	return [payload.createdAt, payload.updatedAt];
};

describe("stored draft and lock times under wall-clock regressions", () => {
	it.each(["advance", "rollback"] as const)(
		"keeps released lock/header times joined across an inner %s before a later edit",
		async (change) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				snapshot = f.snapshot(f.create(input)),
				base = f.time.now;
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
			const at = base + 2000,
				editAt = at + 1000,
				nativeAfter = change === "advance" ? at : base + 1000,
				samples = change === "advance" ? [base + 1000, at] : [at, base + 1000];
			f.clock.wallMs = () => samples.shift() ?? nativeAfter;
			const next = f.store.write((tx) => {
				f.freeze.releaseInTransaction(tx, bound, snapshot.outbox);
				const released = tx.get<{ payload: string }>(
					"SELECT payload FROM native_draft_locks WHERE outbox_id=?",
					[snapshot.outbox],
				);
				expect(JSON.parse(released?.payload ?? "null")).toMatchObject({
					createdAt: base,
					updatedAt: at,
					status: "released",
				});
				expect(f.revisions.currentInTransaction(tx, bound)).toMatchObject({
					draft: { updatedAt: at },
					lockId: null,
				});
				expect(
					tx
						.all<{ at: number }>(
							"SELECT at FROM audit_events WHERE action IN ('draft.freeze_released','draft.unlocked') ORDER BY seq",
						)
						.map((row) => row.at),
				).toEqual([nativeAfter, nativeAfter]);
				expect(
					tx
						.all<{ at: number; refs: string }>(
							"SELECT at,refs FROM audit_events WHERE action='draft.clock_skew' ORDER BY seq",
						)
						.map((row) => ({ at: row.at, refs: JSON.parse(row.refs) })),
				).toEqual(
					change === "advance"
						? []
						: [{ at: nativeAfter, refs: { clockSkewDraft: bound.draftId } }],
				);
				f.clock.wallMs = () => editAt;
				return f.revisions.appendInTransaction(tx, {
					...input,
					expectedRev: 1,
					content: { ...input.content, body: "edited after release" },
				});
			});
			expect(next).toMatchObject({
				draft: { rev: 2, updatedAt: editAt },
				revision: { createdAt: editAt },
				lockId: null,
			});
			expect(lockTimes(f, snapshot.outbox)).toEqual([base, at]);
			f.store.read((db) => f.audit.verify(db));
			f.clock.wallMs = () => f.time.now;
			expect(f.reopen().revisions.current(bound)).toEqual(next);
		},
	);
	it.each(["backward step", "corrected forward jump"] as const)(
		"keeps edit, freeze, release, unlock and consume available after a %s",
		async (kind) => {
			const f = await fixture(),
				input = f.make(),
				bound = f.bind(input),
				real = f.time.now;
			if (kind === "corrected forward jump") f.time.now = real + YEAR;
			const stored = f.create(input).draft.updatedAt;
			f.time.now = kind === "backward step" ? real - 300_000 : real;
			const header: number[] = [stored],
				locks: number[] = [];
			const step = (): void => {
				header.push(f.revisions.current(bound).draft.updatedAt);
			};
			const two = f.store.write((tx) =>
				f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 }),
			);
			expect(two.revision.createdAt).toBe(stored);
			step();
			const first = f.snapshot(two);
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, first));
			locks.push(...lockTimes(f, first.outbox));
			step();
			f.time.now -= 60_000;
			f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, first.outbox));
			locks.push(...lockTimes(f, first.outbox));
			step();
			const second = { ...first, outbox: newId() };
			f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, second));
			const lock = f.revisions.current(bound).lockId as string;
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 2, lock, null));
			step();
			const three = f.store.write((tx) =>
				f.revisions.appendInTransaction(tx, { ...input, expectedRev: 2 }),
			);
			step();
			const last = f.snapshot(three),
				proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 3, last));
			expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)).rev).toBe(3);
			locks.push(...lockTimes(f, last.outbox));
			step();
			expect(header).toEqual(header.map(() => stored));
			expect(locks).toEqual(locks.map(() => stored));
			expect(f.revisions.history(bound).map((revision) => revision.createdAt)).toEqual([
				stored,
				stored,
				stored,
			]);
			const consumed = f.revisions.current(bound).lockId as string;
			f.time.now = stored + 1000;
			f.store.write((tx) => f.revisions.setLockInTransaction(tx, bound, 3, consumed, null));
			expect(f.revisions.current(bound).draft.updatedAt).toBe(stored + 1000);
			const next = f.reopen();
			expect(next.revisions.current(bound).draft.rev).toBe(3);
			expect(next.revisions.history(bound)).toHaveLength(3);
		},
	);
	it("lets a composed cancel and edit commit with another write while the clock reads behind", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.create(input));
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const before = f.revisions.current(bound).draft.updatedAt;
		f.time.now -= 60_000;
		f.store.write((tx) => {
			tx.run("INSERT INTO revision_parent(id) VALUES(1)");
			f.freeze.releaseInTransaction(tx, bound, snapshot.outbox);
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "superseding edit" },
			});
		});
		expect(f.store.read((db) => db.all("SELECT id FROM revision_parent"))).toEqual([{ id: 1 }]);
		const current = f.revisions.current(bound);
		expect(current.lockId).toBeNull();
		expect(current.draft.rev).toBe(2);
		expect(current.draft.updatedAt).toBe(before);
		expect(lockTimes(f, snapshot.outbox)).toEqual([before, before]);
	});
});
