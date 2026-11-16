import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { DraftCreation } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

type Entry = "owner" | "model";
interface AuditRow {
	at: number;
	action: string;
	refs: string;
}
const fixtures: RevisionFixture[] = [];
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
function rows(f: RevisionFixture): AuditRow[] {
	return f.store.read((db) =>
		db.all<AuditRow>("SELECT at,action,refs FROM main.audit_events ORDER BY seq"),
	);
}
function append(f: RevisionFixture, input: DraftCreation, rev: number, entry: Entry, body: string) {
	// Attribution is fixture data; it does not represent a caller approval or a model grant.
	const author = { kind: "ai" as const, id: newId(1_800_000_000_000) };
	return f.store.write((tx) =>
		entry === "owner"
			? f.revisions.appendInTransaction(tx, {
					...input,
					expectedRev: rev,
					content: { ...input.content, body },
				})
			: f.revisions.appendModelBodyInTransaction(tx, {
					...f.bind(input),
					expectedRev: rev,
					author,
					body,
					flags: input.flags,
				}),
	);
}

describe("native revision writes across wall-clock corrections", () => {
	it("retains the stored timestamp when release preparation omits an operation floor", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.create(input),
			snapshot = f.snapshot(one);
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot)),
			locked = f.revisions.current(bound);
		f.time.now -= 5_000;
		const prepared = f.store.write((tx) =>
			f.revisions.prepareLockInTransaction(tx, bound, 1, locked.lockId, null),
		);
		expect(prepared.at).toBe(locked.draft.updatedAt);
		const unchanged = f.revisions.current(bound);
		expect(unchanged.lockId).toBe(locked.lockId);
		expect(unchanged.draft.updatedAt).toBe(locked.draft.updatedAt);
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)).snapshot).toEqual(
			snapshot,
		);
		expect(() => f.store.read((db) => f.audit.verify(db))).not.toThrow();
	});
	it.each([-1, Number.NaN, 0.5, Number.POSITIVE_INFINITY])(
		"refuses invalid lock timestamp floor %s before changing rows or audit",
		async (floor) => {
			const f = await fixture(),
				input = f.make(),
				one = f.create(input),
				before = rows(f);
			expect(() =>
				f.store.write((tx) =>
					f.revisions.prepareLockInTransaction(tx, f.bind(input), 1, null, newId(), floor),
				),
			).toThrow("Draft revision unavailable");
			expect(f.revisions.current(f.bind(input))).toEqual(one);
			expect(rows(f)).toEqual(before);
		},
	);
	for (const channel of ["email", "chat"] as const) {
		for (const entry of ["owner", "model"] as const) {
			for (const correction of ["backward step", "future then corrected"] as const) {
				it(`${channel} ${entry} edit survives a ${correction} and encrypted reopen`, async () => {
					const f = await fixture(),
						input = f.make(channel),
						bound = f.bind(input),
						normal = f.time.now;
					let before = f.create(input);
					if (correction === "future then corrected") {
						f.time.now = Date.UTC(2099, 0, 1);
						before = append(f, input, 1, "owner", "future edit");
					}
					const history = f.revisions.history(bound);
					f.time.now = correction === "backward step" ? normal - 5_000 : normal;
					const edited = append(f, input, before.draft.rev, entry, "corrected edit");
					expect(edited.draft.rev).toBe(before.draft.rev + 1);
					expect(edited.draft.createdAt).toBe(before.draft.createdAt);
					expect(edited.draft.updatedAt).toBe(before.draft.updatedAt);
					expect(edited.revision.createdAt).toBe(before.draft.updatedAt);
					expect(edited.revision.content).toEqual({
						...before.revision.content,
						body: "corrected edit",
					});
					expect(f.revisions.history(bound).slice(0, -1)).toEqual(history);
					expect(f.revisions.current(bound)).toEqual(edited);
					const skew = rows(f).filter((row) => row.action === "draft.clock_skew");
					expect(skew).toHaveLength(1);
					expect(skew[0]?.at).toBe(f.time.now);
					expect(JSON.parse(skew[0]?.refs ?? "null")).toEqual({
						clockSkewDraft: input.draftId,
					});
					expect(() => f.store.read((db) => f.audit.verify(db))).not.toThrow();
					const reopened = f.reopen();
					expect(reopened.revisions.current(bound)).toEqual(edited);
					expect(reopened.revisions.history(bound).slice(0, -1)).toEqual(history);
					f.time.now = before.draft.updatedAt + 1;
					const advanced = reopened.store.write((tx) =>
						reopened.revisions.appendInTransaction(tx, {
							...input,
							expectedRev: edited.draft.rev,
							content: { ...edited.revision.content, body: "clock caught up" },
						}),
					);
					expect(advanced.draft.updatedAt).toBe(f.time.now);
					expect(advanced.revision.createdAt).toBe(f.time.now);
					expect(
						reopened.store
							.read((db) => db.all<AuditRow>("SELECT at,action,refs FROM main.audit_events"))
							.filter((row) => row.action === "draft.clock_skew"),
					).toHaveLength(1);
				});
			}
		}
	}
	it.each(["owner", "model"] as const)(
		"equal timestamps allow a %s edit without reporting skew",
		async (entry) => {
			const f = await fixture(),
				input = f.make(),
				one = f.create(input),
				two = append(f, input, 1, entry, "same millisecond");
			expect(two.draft.updatedAt).toBe(one.draft.updatedAt);
			expect(two.revision.createdAt).toBe(one.revision.createdAt);
			expect(rows(f).some((row) => row.action === "draft.clock_skew")).toBe(false);
		},
	);
	for (const entry of ["owner", "model"] as const) {
		it.each([-1, Number.NaN, 0.5, Number.POSITIVE_INFINITY])(
			`${entry} edit still refuses an invalid wall-clock value %s without writes`,
			async (invalid) => {
				const f = await fixture(),
					input = f.make(),
					one = f.create(input),
					before = rows(f);
				f.time.now = invalid;
				expect(() => append(f, input, 1, entry, "refused")).toThrow("Draft revision unavailable");
				expect(f.revisions.current(f.bind(input))).toEqual(one);
				expect(rows(f)).toEqual(before);
				f.time.now = one.draft.updatedAt;
				expect(f.reopen().revisions.current(f.bind(input))).toEqual(one);
			},
		);
		it(`${entry} stale CAS refuses before a backward-clock audit event`, async () => {
			const f = await fixture(),
				input = f.make(),
				one = f.create(input),
				before = rows(f);
			f.time.now -= 5_000;
			expect(() => append(f, input, 2, entry, "stale")).toThrow("Draft revision unavailable");
			expect(f.revisions.current(f.bind(input))).toEqual(one);
			expect(rows(f)).toEqual(before);
		});
		it(`${entry} backward-clock edit and skew audit roll back on a deferred COMMIT failure`, async () => {
			const f = await fixture(),
				input = f.make(),
				one = f.create(input),
				before = rows(f);
			f.time.now -= 5_000;
			let editCompleted = false;
			expect(() =>
				f.store.write((tx) => {
					const two =
						entry === "owner"
							? f.revisions.appendInTransaction(tx, {
									...input,
									expectedRev: 1,
									content: { ...input.content, body: "rolled back" },
								})
							: f.revisions.appendModelBodyInTransaction(tx, {
									...f.bind(input),
									expectedRev: 1,
									author: { kind: "ai", id: newId(1_800_000_000_000) },
									body: "rolled back",
									flags: input.flags,
								});
					expect(two.draft.rev).toBe(2);
					expect(two.draft.updatedAt).toBe(one.draft.updatedAt);
					editCompleted = true;
					tx.run("INSERT INTO revision_child(id) VALUES(987654)");
				}),
			).toThrow();
			expect(editCompleted).toBe(true);
			expect(f.revisions.current(f.bind(input))).toEqual(one);
			expect(f.revisions.history(f.bind(input))).toEqual([one.revision]);
			expect(rows(f)).toEqual(before);
			f.time.now = one.draft.updatedAt;
			expect(f.reopen().revisions.current(f.bind(input))).toEqual(one);
		});
	}
});
