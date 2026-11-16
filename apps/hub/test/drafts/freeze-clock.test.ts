import { rmSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import { contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, expect, it } from "vitest";
import type { FrozenRevisionProof } from "../../src/drafts/freeze.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
async function fixture() {
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

function stored(f: RevisionFixture) {
	return f.store.read((db) => ({
		drafts: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		events: db.all("SELECT * FROM audit_events ORDER BY seq"),
		audit: db.all("SELECT * FROM audit_meta"),
	}));
}
function lock(f: RevisionFixture, outbox: string) {
	return f.store.read((db) => {
		const row = db.get<{ payload: string }>(
			"SELECT payload FROM native_draft_locks WHERE outbox_id=?",
			[outbox],
		);
		if (!row) throw new Error("Expected the stored lock");
		return JSON.parse(row.payload) as {
			createdAt: number;
			updatedAt: number;
			status: "active" | "consumed" | "released";
		};
	});
}
function clockAudit(f: RevisionFixture, draft: string) {
	const rows = f.store.read((db) => {
		f.audit.verify(db);
		return db.all<{ action: string; refs: string }>(
			"SELECT action,refs FROM audit_events WHERE action='draft.clock_skew' ORDER BY seq",
		);
	});
	expect(rows.length).toBeGreaterThan(0);
	for (const row of rows) {
		expect(row.refs).toBe(canonicalize({ clockSkewDraft: draft }));
		expect(row.action).toBe("draft.clock_skew");
	}
	expect(canonicalize(rows)).not.toContain(f.canary);
}

it.each(["email", "chat"] as const)(
	"freezes a %s revision after a five-second rollback using its stored timestamp floor",
	async (channel) => {
		const f = await fixture();
		const input = f.make(channel),
			bound = f.bind(input),
			current = f.create(input);
		const snapshot = f.snapshot(current),
			floor = current.draft.updatedAt;
		f.time.now -= 5_000;
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		expect(lock(f, snapshot.outbox)).toMatchObject({
			createdAt: floor,
			updatedAt: floor,
			status: "active",
		});
		expect(f.revisions.current(bound).draft.updatedAt).toBe(floor);
		const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
		expect(facts.snapshot).toEqual(snapshot);
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
		expect(facts.revisionContentHash).toBe(current.revision.contentSha256);
		expect(facts.flagsHash).toBe(current.flagsHash);
		expect(lock(f, snapshot.outbox)).toMatchObject({
			createdAt: floor,
			updatedAt: floor,
			status: "consumed",
		});
		clockAudit(f, bound.draftId);
	},
);

it("uses the later persisted revision after a forward jump followed by a backward jump", async () => {
	const f = await fixture(),
		input = f.make(),
		bound = f.bind(input);
	f.create(input);
	f.time.now += 60_000;
	const current = f.store.write((tx) =>
		f.revisions.appendInTransaction(tx, {
			...input,
			expectedRev: 1,
			content: { ...input.content, body: "Later owner revision" },
		}),
	);
	const floor = current.revision.createdAt,
		snapshot = f.snapshot(current);
	f.time.now -= 120_000;
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, snapshot));
	const facts = f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
	expect(facts.rev).toBe(2);
	expect(facts.snapshotHash).toBe(contentHash(snapshot));
	expect(lock(f, snapshot.outbox)).toMatchObject({ createdAt: floor, updatedAt: floor });
	expect(f.revisions.current(bound).revision).toEqual(current.revision);
	clockAudit(f, bound.draftId);
});

it("clamps release without retaining cancellation locks or blocking the next owner revision", async () => {
	const f = await fixture(),
		input = f.make(),
		bound = f.bind(input),
		current = f.create(input);
	f.time.now += 20_000;
	const snapshot = f.snapshot(current);
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
	const floor = lock(f, snapshot.outbox).updatedAt;
	f.time.now -= 25_000;
	f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
	expect(lock(f, snapshot.outbox)).toMatchObject({
		createdAt: floor,
		updatedAt: floor,
		status: "released",
	});
	expect(f.revisions.current(bound).lockId).toBeNull();
	expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
		"Draft revision unavailable",
	);
	const next = f.store.write((tx) =>
		f.revisions.appendInTransaction(tx, {
			...input,
			expectedRev: 1,
			content: { ...input.content, body: "Changed after cancellation" },
		}),
	);
	expect(next.revision.rev).toBe(2);
	expect(next.revision.createdAt).toBe(floor);
	const replacement = f.snapshot(next);
	const fresh = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 2, replacement));
	expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).outboxId).toBe(
		replacement.outbox,
	);
	clockAudit(f, bound.draftId);
});

it.each(["consume", "release"] as const)(
	"rolls back a backward-clock %s and its signed audit writes with the actual transaction",
	async (operation) => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const before = stored(f);
		f.time.now -= 5_000;
		expect(() =>
			f.store.write((tx) => {
				if (operation === "consume") f.freeze.consumeInTransaction(tx, proof);
				else f.freeze.releaseInTransaction(tx, bound, snapshot.outbox);
				throw new Error("DYTEST-rollback-after-freeze-write");
			}),
		).toThrow("DYTEST-rollback-after-freeze-write");
		expect(stored(f)).toEqual(before);
		if (operation === "consume")
			expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
				"Draft revision unavailable",
			);
		const fresh =
			operation === "release"
				? proof
				: f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox));
		expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshotHash).toBe(
			contentHash(snapshot),
		);
		expect(lock(f, snapshot.outbox).status).toBe("consumed");
		clockAudit(f, bound.draftId);
	},
);

it.each(["consume", "release"] as const)(
	"reopens an encrypted active lock and can %s it after the clock moves back",
	async (operation) => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		const current = f.create(input),
			snapshot = f.snapshot(current);
		const oldProof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const floor = current.draft.updatedAt;
		f.time.now -= 5_000;
		const reopened = f.reopen();
		expect(() =>
			reopened.store.write((tx) => reopened.freeze.consumeInTransaction(tx, oldProof)),
		).toThrow("Draft revision unavailable");
		const fresh = reopened.store.write((tx) =>
			reopened.freeze.proofInTransaction(tx, bound, snapshot.outbox),
		);
		if (operation === "consume") {
			const facts = reopened.store.write((tx) => reopened.freeze.consumeInTransaction(tx, fresh));
			expect(facts.snapshot).toEqual(snapshot);
			expect(reopened.revisions.current(bound).lockId).not.toBeNull();
		} else {
			reopened.store.write((tx) =>
				reopened.freeze.releaseInTransaction(tx, bound, snapshot.outbox),
			);
			expect(reopened.revisions.current(bound).lockId).toBeNull();
			expect(() =>
				reopened.store.write((tx) => reopened.freeze.consumeInTransaction(tx, fresh)),
			).toThrow("Draft revision unavailable");
		}
		const payload = reopened.store.read((db) =>
			JSON.parse(
				db.get<{ payload: string }>("SELECT payload FROM native_draft_locks WHERE outbox_id=?", [
					snapshot.outbox,
				])?.payload ?? "null",
			),
		);
		expect(payload).toMatchObject({
			createdAt: floor,
			updatedAt: floor,
			status: operation === "consume" ? "consumed" : "released",
		});
		reopened.store.read((db) => f.audit.verify(db));
	},
);

it("does not grant a forged, cross-store or retired transaction proof under clock rollback", async () => {
	const f = await fixture(),
		other = await fixture(),
		input = f.make(),
		bound = f.bind(input);
	const snapshot = f.snapshot(f.create(input));
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
	f.time.now -= 5_000;
	other.time.now -= 5_000;
	const before = stored(f),
		foreign = stored(other);
	expect(() =>
		f.store.write((tx) => f.freeze.consumeInTransaction(tx, {} as FrozenRevisionProof)),
	).toThrow("Draft revision unavailable");
	expect(() => other.store.write((tx) => other.freeze.consumeInTransaction(tx, proof))).toThrow(
		"Draft revision unavailable",
	);
	let retired: SqlTransaction | undefined;
	f.store.write((tx) => {
		retired = tx;
	});
	expect(() =>
		f.freeze.proofInTransaction(retired as SqlTransaction, bound, snapshot.outbox),
	).toThrow("Draft revision unavailable");
	expect(stored(f)).toEqual(before);
	expect(stored(other)).toEqual(foreign);
	const fresh = f.store.write((tx) => f.freeze.proofInTransaction(tx, bound, snapshot.outbox));
	expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, fresh)).snapshotHash).toBe(
		contentHash(snapshot),
	);
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
	"still refuses an invalid clock %s without committing audit or state",
	async (now) => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		const snapshot = f.snapshot(f.create(input));
		const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		const before = stored(f);
		f.time.now = now;
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof))).toThrow(
			"Draft revision unavailable",
		);
		expect(() =>
			f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox)),
		).toThrow("Draft revision unavailable");
		expect(stored(f)).toEqual(before);
	},
);

it.each(["advance", "rollback"])(
	"keeps active lock timestamps joined to the stored header across an inner clock %s",
	async (change) => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			current = f.create(input),
			snapshot = f.snapshot(current),
			base = f.time.now,
			future = base + 20_000;
		const samples = change === "advance" ? [base, future] : [future, base];
		f.clock.wallMs = () => samples.shift() ?? (change === "advance" ? future : base);
		f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
		expect(f.revisions.current(bound).draft.updatedAt).toBe(future);
		expect(lock(f, snapshot.outbox)).toMatchObject({
			createdAt: future,
			updatedAt: future,
			status: "active",
		});
		f.clock.wallMs = () => f.time.now;
		const reopened = f.reopen();
		const proof = reopened.store.write((tx) =>
			reopened.freeze.proofInTransaction(tx, bound, snapshot.outbox),
		);
		expect(
			reopened.store.write((tx) => reopened.freeze.consumeInTransaction(tx, proof)).snapshotHash,
		).toBe(contentHash(snapshot));
		reopened.store.read((db) => f.audit.verify(db));
	},
);

it("records the first observed skew even if the clock recovers before the inner lock read", async () => {
	const f = await fixture(),
		input = f.make(),
		bound = f.bind(input),
		current = f.create(input);
	const snapshot = f.snapshot(current),
		samples = [f.time.now - 5_000];
	f.clock.wallMs = () => samples.shift() ?? f.time.now;
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
	clockAudit(f, bound.draftId);
	expect(lock(f, snapshot.outbox).createdAt).toBe(current.draft.updatedAt);
	expect(f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof)).snapshot).toEqual(
		snapshot,
	);
});

it("carries a release sample forward when the inner header clock has already corrected", async () => {
	const f = await fixture(),
		input = f.make(),
		bound = f.bind(input);
	const snapshot = f.snapshot(f.create(input));
	f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
	const future = f.time.now + 60_000,
		samples = [future];
	f.clock.wallMs = () => samples.shift() ?? f.time.now;
	f.store.write((tx) => f.freeze.releaseInTransaction(tx, bound, snapshot.outbox));
	expect(lock(f, snapshot.outbox)).toMatchObject({ updatedAt: future, status: "released" });
	expect(f.revisions.current(bound)).toMatchObject({ draft: { updatedAt: future }, lockId: null });
	clockAudit(f, bound.draftId);
	const reopened = f.reopen();
	const next = reopened.store.write((tx) =>
		reopened.revisions.appendInTransaction(tx, {
			...input,
			expectedRev: 1,
			content: { ...input.content, body: "Edit after sampled future release" },
		}),
	);
	expect(next.revision.createdAt).toBeGreaterThanOrEqual(future);
	expect(next.draft.updatedAt).toBeGreaterThanOrEqual(future);
	const replacement = f.snapshot(next);
	const proof = reopened.store.write((tx) =>
		reopened.freeze.freezeInTransaction(tx, bound, 2, replacement),
	);
	expect(
		reopened.store.write((tx) => reopened.freeze.consumeInTransaction(tx, proof)).snapshotHash,
	).toBe(contentHash(replacement));
	reopened.store.read((db) => f.audit.verify(db));
});
