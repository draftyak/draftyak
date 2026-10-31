import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
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
	it("samples the wall clock once for release and edit composed in one transaction", async () => {
		const f = await fixture(),
			wall = vi.fn(() => f.time.now),
			revisions = new NativeDraftRevisions(f.store, f.audit, f.key, {
				...f.clock,
				wallMs: wall,
			}),
			freeze = new NativeDraftFreeze(revisions);
		f.services.push(revisions);
		const input = f.make(),
			bound = f.bind(input),
			snapshot = f.snapshot(f.store.write((tx) => revisions.createInTransaction(tx, input)));
		f.store.write((tx) => freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const at = f.time.now + 1000;
		wall
			.mockClear()
			.mockImplementationOnce(() => at)
			.mockImplementation(() => {
				throw new Error("second wall-clock sample in one transaction");
			});
		f.store.write((tx) => {
			freeze.releaseInTransaction(tx, bound, snapshot.outbox);
			revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "edited after release" },
			});
		});
		expect(wall).toHaveBeenCalledTimes(1);
		const current = revisions.current(bound);
		expect(current.lockId).toBeNull();
		expect(current.draft.rev).toBe(2);
		expect(current.draft.updatedAt).toBe(at);
		expect(current.revision.createdAt).toBe(at);
		expect(lockTimes(f, snapshot.outbox)).toEqual([f.time.now, at]);
		wall.mockClear().mockReturnValue(at + 1000);
		const next = f.store.write((tx) =>
			revisions.appendInTransaction(tx, { ...input, expectedRev: 2 }),
		);
		expect(wall).toHaveBeenCalledTimes(1);
		expect(next.draft.updatedAt).toBe(at + 1000);
	});
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
