import { createHash } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, expect, it } from "vitest";
import { NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import { DraftRevisionError } from "../../src/drafts/revisions.ts";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	expireNativeOutboxMissed,
	ProposalError,
	resetNativeOutboxForRestore,
} from "../../src/outbox/propose.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import type { ProposalCandidate } from "./propose-fixture.ts";
import { type ExpiryFixture, expiryFixture } from "./scheduler-expiry-fixture.ts";

// resetNativeOutboxForRestore is an unadopted original-domain Source dependency.
// These tests use actual signed approvals, not accepted-approval or WorkScope lookalikes.
const owned: ExpiryFixture[] = [];
async function setup(): Promise<ExpiryFixture> {
	const f = await expiryFixture();
	owned.push(f);
	return f;
}
afterEach(async () => {
	const results = await Promise.allSettled(owned.splice(0).map((f) => f.close()));
	expect(results.every((result) => result.status === "fulfilled")).toBe(true);
});

function digest(value: unknown): string {
	const bytes = JSON.stringify(value);
	if (bytes === undefined) throw new Error("DYTEST reset state unavailable");
	return createHash("sha256").update(bytes).digest("hex");
}
function state(f: ExpiryFixture) {
	return f.base.native.store.read((db) => ({
		outbox: digest(db.all("SELECT * FROM main.outbox ORDER BY id")),
		drafts: digest(db.all("SELECT * FROM main.native_drafts ORDER BY id")),
		history: digest(db.all("SELECT * FROM main.native_draft_revisions ORDER BY draft_id,rev")),
		freezes: digest(db.all("SELECT * FROM main.native_draft_locks ORDER BY id")),
		approvals: digest(db.all("SELECT * FROM main.approvals ORDER BY id")),
		challenges: digest(db.all("SELECT * FROM main.approval_challenges ORDER BY id")),
		audit: digest(db.all("SELECT * FROM main.audit_events ORDER BY seq")),
		auditHead: digest(db.all("SELECT * FROM main.audit_meta ORDER BY singleton")),
		events: digest(db.all("SELECT * FROM main.events ORDER BY seq")),
		eventHead: digest(db.all("SELECT * FROM main.event_meta ORDER BY singleton")),
		restoredAudits:
			db.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='outbox.restored'",
			)?.n ?? -1,
		changedEvents:
			db.get<{ n: number }>("SELECT count(*) AS n FROM main.events WHERE kind='outbox.changed'")
				?.n ?? -1,
	}));
}
function reset(f: ExpiryFixture): number {
	return f.target.write((tx, scope) => resetNativeOutboxForRestore(f.target, tx, scope));
}
function refused(work: () => unknown): void {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure instanceof ProposalError).toBe(true);
	if (!(failure instanceof ProposalError)) throw new Error("DYTEST reset refusal unavailable");
	expect(failure.code === "PROPOSAL_STALE" && failure.message === "Native outbox unavailable").toBe(
		true,
	);
	expect(Object.hasOwn(failure, "cause")).toBe(false);
}
function expectRestored(
	f: ExpiryFixture,
	p: ProposalCandidate,
	before: NonNullable<ReturnType<ExpiryFixture["read"]>>,
): void {
	const after = f.read(p.id);
	expect(
		canonicalize(after) ===
			canonicalize({
				...before,
				state: "NEEDS_REAPPROVAL",
				stateReason: "restored",
				updatedAt: Math.max(f.base.time.wall, before.updatedAt),
			}),
	).toBe(true);
	expect(f.revisions.current(p.binding).lockId === null).toBe(true);
	f.base.native.store.read((db) => {
		const lock = db.get<{ payload: string }>(
			"SELECT payload FROM main.native_draft_locks WHERE outbox_id=?",
			[p.id],
		);
		expect(lock !== undefined && JSON.parse(lock.payload).status === "released").toBe(true);
		const notice = db.get<{ refs: string }>(
			"SELECT refs FROM main.audit_events WHERE action='outbox.restored' AND refs=?",
			[canonicalize({ outbox: p.id })],
		);
		expect(notice !== undefined).toBe(true);
		f.base.native.audit.verify(db);
	});
}

it.each(["now", "at"] as const)(
	"restores a genuinely signed %s approval and releases its original freeze without changing its payload identities",
	async (kind) => {
		const f = await setup();
		const p = await f.approve(kind);
		const pending = f.base.proposal();
		const pendingBefore = f.read(pending.id);
		const before = f.read(p.id);
		if (!before || before.deliverBy === null)
			throw new Error("DYTEST original approved window unavailable");
		expect(before.state === (kind === "now" ? "APPROVED" : "SCHEDULED")).toBe(true);
		expect(
			f.base.time.wall <= before.deliverBy && f.revisions.current(p.binding).lockId !== null,
		).toBe(true);
		const prior = state(f);
		expect(reset(f)).toBe(1);
		expectRestored(f, p, before);
		expect(canonicalize(f.read(pending.id)) === canonicalize(pendingBefore)).toBe(true);
		expect(f.revisions.current(pending.binding).lockId !== null).toBe(true);
		const after = state(f);
		expect(
			after.history === prior.history &&
				after.approvals === prior.approvals &&
				after.challenges === prior.challenges,
		).toBe(true);
		expect(
			after.restoredAudits === prior.restoredAudits + 1 &&
				after.changedEvents === prior.changedEvents + 1,
		).toBe(true);
		expect(reset(f)).toBe(0);
		expect(state(f)).toEqual(after);
	},
);

it("retains genuine missed reconciliation and the inclusive deadline while restoring only the remaining future approval", async () => {
	const f = await setup();
	const missed = await f.approve("now");
	const future = await f.approve("at");
	const past = f.read(missed.id);
	const futureBefore = f.read(future.id);
	if (!past || past.deliverBy === null || !futureBefore || futureBefore.deliverBy === null)
		throw new Error("DYTEST original deadline unavailable");
	expect(futureBefore.deliverBy > past.deliverBy + 1).toBe(true);
	f.base.time.mono += past.deliverBy + 1 - f.base.time.wall;
	f.base.time.wall = past.deliverBy + 1;
	expect(expireNativeOutboxMissed(f.target, missed.id)).toBe(true);
	const missedRecord = f.read(missed.id);
	expect(missedRecord?.state === "NEEDS_REAPPROVAL" && missedRecord.stateReason === "missed").toBe(
		true,
	);
	f.base.time.mono += futureBefore.deliverBy - f.base.time.wall;
	f.base.time.wall = futureBefore.deliverBy;
	expect(expireNativeOutboxMissed(f.target, future.id)).toBe(false);
	expect(reset(f)).toBe(1);
	expectRestored(f, future, futureBefore);
	expect(canonicalize(f.read(missed.id)) === canonicalize(missedRecord)).toBe(true);
	expect(f.revisions.current(missed.binding).lockId === null).toBe(true);
});

it.each(["row", "freeze"] as const)(
	"rolls back earlier original rows, freeze/header/history, audit and events after a late authenticated %s failure",
	async (kind) => {
		const f = await setup();
		const proposals = [await f.approve("now"), await f.approve("at")].sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		);
		const first = proposals[0],
			last = proposals[1];
		if (!first || !last) throw new Error("DYTEST reset ordering unavailable");
		const firstBefore = f.read(first.id);
		const firstLock = f.revisions.current(first.binding).lockId;
		f.base.native.store.write((tx) => {
			const changed =
				kind === "row"
					? tx.run("UPDATE main.outbox SET mac=? WHERE id=?", ["0".repeat(64), last.id])
					: tx.run("UPDATE main.native_draft_locks SET mac=? WHERE outbox_id=?", [
							"0".repeat(64),
							last.id,
						]);
			expect(changed.changes).toBe(1);
		});
		const before = state(f);
		refused(() => reset(f));
		expect(state(f)).toEqual(before);
		expect(canonicalize(f.read(first.id)) === canonicalize(firstBefore)).toBe(true);
		expect(f.revisions.current(first.binding).lockId === firstLock && firstLock !== null).toBe(
			true,
		);
	},
);

it("poisons a caught wrong-transaction refusal in the original target write", async () => {
	const f = await setup(),
		other = await setup();
	await f.approve();
	const before = state(f),
		foreignBefore = state(other);
	let inner: unknown;
	let outer: unknown;
	try {
		f.target.write((tx, scope) => {
			f.base.native.audit.append(tx, {
				id: newId(f.base.time.wall),
				at: f.base.time.wall,
				action: "restore.test_before_wrong_tx",
				actor: { kind: "hub", id: null },
				refs: {},
			});
			other.base.native.store.write((foreignTx) => {
				try {
					resetNativeOutboxForRestore(f.target, foreignTx, scope);
				} catch (error) {
					inner = error;
				}
			});
		});
	} catch (error) {
		outer = error;
	}
	expect(inner instanceof ProposalError && outer !== undefined).toBe(true);
	expect(state(f)).toEqual(before);
	expect(state(other)).toEqual(foreignBefore);
	expect(reset(f)).toBe(1);
});

it("refuses original foreign, different-database and expired scopes without adopting their transaction", async () => {
	const f = await setup(),
		other = await setup();
	await f.approve();
	const before = state(f),
		foreignBefore = state(other);
	other.target.write((tx, scope) =>
		refused(() => resetNativeOutboxForRestore(f.target, tx, scope)),
	);
	const database = new WorkDatabase(f.base.native.store);
	database.write((scope) =>
		refused(() => resetNativeOutboxForRestore(f.target, database.sql(scope), scope)),
	);
	const captured: { tx: SqlTransaction; scope: WorkScope } = f.target.write((tx, scope) => ({
		tx,
		scope,
	}));
	refused(() => resetNativeOutboxForRestore(f.target, captured.tx, captured.scope));
	expect(state(f)).toEqual(before);
	expect(state(other)).toEqual(foreignBefore);
	expect(reset(f)).toBe(1);
});

it.each([100, 101])(
	"restores exactly %i genuinely signed rows across the original 100-row page boundary",
	async (count) => {
		const f = await setup();
		const proposals: ProposalCandidate[] = [];
		for (let i = 0; i < count; i++) proposals.push(await f.approve("now"));
		const before = proposals.map((p) => f.read(p.id));
		const prior = state(f);
		expect(before.length === count && before.every((row) => row?.state === "APPROVED")).toBe(true);
		expect(reset(f)).toBe(count);
		for (let i = 0; i < count; i++) {
			const p = proposals[i],
				row = before[i];
			if (!p || !row) throw new Error("DYTEST original reset inventory unavailable");
			expectRestored(f, p, row);
		}
		const after = state(f);
		expect(
			after.restoredAudits === prior.restoredAudits + count &&
				after.changedEvents === prior.changedEvents + count,
		).toBe(true);
		expect(reset(f)).toBe(0);
		expect(state(f)).toEqual(after);
	},
	300_000,
);

for (const kind of ["now", "at"] as const) {
	for (const due of [false, true]) {
		it(`reconciles genuine ${due ? "past-due" : "future"} consumed ${kind} history without reactivating it`, async () => {
			const f = await setup();
			const p = await f.approve(kind);
			const approved = f.read(p.id);
			if (!approved || approved.deliverBy === null)
				throw new Error("DYTEST consumed approval window unavailable");
			const freeze = new NativeDraftFreeze(f.revisions);
			const lockId = f.revisions.current(p.binding).lockId;
			if (lockId === null) throw new Error("DYTEST original active lock unavailable");
			const retained = f.target.write((tx) => {
				const proof = freeze.proofInTransaction(tx, p.binding, p.id);
				const old = freeze.proofInTransaction(tx, p.binding, p.id);
				const facts = freeze.consumeInTransaction(tx, proof);
				expect(facts.outboxId === p.id && facts.draftId === p.binding.draftId).toBe(true);
				return old;
			});
			expect(canonicalize(f.read(p.id)) === canonicalize(approved)).toBe(true);
			expect(f.revisions.current(p.binding).lockId === lockId).toBe(true);
			const history = f.base.native.store.read((db) => {
				const row = db.get<{ payload: string }>(
					"SELECT * FROM main.native_draft_locks WHERE id=?",
					[lockId],
				);
				expect(row !== undefined && JSON.parse(row.payload).status === "consumed").toBe(true);
				return digest(row);
			});
			const pending = f.base.proposal();
			const pendingLock = f.revisions.current(pending.binding).lockId;
			if (due) {
				f.base.time.mono += approved.deliverBy + 1 - f.base.time.wall;
				f.base.time.wall = approved.deliverBy + 1;
				const beforeOrdinary = state(f);
				// Ordinary missed cancellation still refuses consumed history. Restore must use
				// its own authenticated historical member rather than call this path first.
				refused(() => expireNativeOutboxMissed(f.target, p.id));
				expect(state(f)).toEqual(beforeOrdinary);
			} else expect(expireNativeOutboxMissed(f.target, p.id)).toBe(false);
			const before = state(f);
			expect(reset(f)).toBe(1);
			const after = f.read(p.id);
			expect(
				canonicalize(after) ===
					canonicalize({
						...approved,
						state: "NEEDS_REAPPROVAL",
						stateReason: due ? "missed" : "restored",
						updatedAt: Math.max(f.base.time.wall, approved.updatedAt),
					}),
			).toBe(true);
			expect(f.revisions.current(p.binding).lockId === null).toBe(true);
			expect(
				f.revisions.current(pending.binding).lockId === pendingLock && pendingLock !== null,
			).toBe(true);
			expect(
				f.base.native.store.read((db) =>
					digest(db.get("SELECT * FROM main.native_draft_locks WHERE id=?", [lockId])),
				) === history,
			).toBe(true);
			const quiet = state(f);
			expect(
				quiet.history === before.history &&
					quiet.approvals === before.approvals &&
					quiet.challenges === before.challenges,
			).toBe(true);
			// The genuine old approval's target cannot obtain current frozen facts again.
			refused(() => f.target.write((tx) => f.target.item(tx, p.id)));
			let failure: unknown;
			try {
				f.base.native.store.write((tx) => freeze.consumeInTransaction(tx, retained));
			} catch (error) {
				failure = error;
			}
			expect(failure instanceof DraftRevisionError).toBe(true);
			if (!(failure instanceof DraftRevisionError))
				throw new Error("DYTEST old frozen proof refusal unavailable");
			expect(
				failure.code === "DRAFT_REVISION_UNAVAILABLE" &&
					failure.message === "Draft revision unavailable",
			).toBe(true);
			expect(state(f)).toEqual(quiet);
			expect(reset(f)).toBe(0);
			expect(state(f)).toEqual(quiet);
			f.base.native.store.read((db) => f.base.native.audit.verify(db));
		});
	}
}

it("preserves consumed history and a different genuine current lock on the same original draft", async () => {
	const f = await setup();
	const p = await f.approve("now");
	const freeze = new NativeDraftFreeze(f.revisions);
	const oldLock = f.revisions.current(p.binding).lockId;
	if (oldLock === null) throw new Error("DYTEST original consumed lock unavailable");
	f.target.write((tx) =>
		freeze.consumeInTransaction(tx, freeze.proofInTransaction(tx, p.binding, p.id)),
	);
	expect(reset(f)).toBe(1);
	const nextId = newId(f.base.time.wall);
	const next = f.target.propose(f.base.device.peer, {
		...p.input,
		snapshot: { ...p.input.snapshot, outbox: nextId },
	});
	expect(next.id === nextId && next.state === "PENDING_APPROVAL").toBe(true);
	const currentLock = f.revisions.current(p.binding).lockId;
	expect(currentLock !== null && currentLock !== oldLock).toBe(true);
	const before = state(f);
	f.target.write((tx) => freeze.releaseForRestoreInTransaction(tx, p.binding, p.id, oldLock));
	expect(f.revisions.current(p.binding).lockId === currentLock).toBe(true);
	expect(state(f)).toEqual(before);
	expect(reset(f)).toBe(0);
	expect(state(f)).toEqual(before);
});

function historicalState(f: ExpiryFixture, lockId: string, status: "consumed" | "released") {
	return f.base.native.store.read((db) => {
		const row = db.get<{ payload: string; audit_seq: number }>(
			"SELECT * FROM main.native_draft_locks WHERE id=?",
			[lockId],
		);
		if (!row) throw new Error("DYTEST original freeze history unavailable");
		expect(JSON.parse(row.payload).status === status).toBe(true);
		const audit = db.get("SELECT * FROM main.audit_events WHERE seq=?", [row.audit_seq]);
		expect(audit !== undefined).toBe(true);
		return { row: digest(row), audit: digest(audit) };
	});
}

for (const due of [false, true]) {
	it(`reconciles genuine ${due ? "past-due" : "future"} released history while preserving its authenticated row and null header`, async () => {
		const f = await setup();
		const p = await f.approve("now");
		const approved = f.read(p.id);
		const lockId = f.revisions.current(p.binding).lockId;
		if (!approved || approved.deliverBy === null || lockId === null)
			throw new Error("DYTEST original released approval unavailable");
		const freeze = new NativeDraftFreeze(f.revisions);
		f.target.write((tx) => freeze.releaseInTransaction(tx, p.binding, p.id));
		expect(f.revisions.current(p.binding).lockId === null).toBe(true);
		expect(canonicalize(f.read(p.id)) === canonicalize(approved)).toBe(true);
		const history = historicalState(f, lockId, "released");
		if (due) {
			f.base.time.mono += approved.deliverBy + 1 - f.base.time.wall;
			f.base.time.wall = approved.deliverBy + 1;
		}
		const before = state(f);
		expect(reset(f)).toBe(1);
		expect(
			canonicalize(f.read(p.id)) ===
				canonicalize({
					...approved,
					state: "NEEDS_REAPPROVAL",
					stateReason: due ? "missed" : "restored",
					updatedAt: Math.max(f.base.time.wall, approved.updatedAt),
				}),
		).toBe(true);
		expect(f.revisions.current(p.binding).lockId === null).toBe(true);
		expect(historicalState(f, lockId, "released")).toEqual(history);
		const after = state(f);
		expect(
			after.history === before.history &&
				after.approvals === before.approvals &&
				after.challenges === before.challenges,
		).toBe(true);
		refused(() => f.target.write((tx) => f.target.item(tx, p.id)));
		expect(reset(f)).toBe(0);
		expect(state(f)).toEqual(after);
	});
}

it("audits a genuine consumed missed item before restoring a fresh future item in the same native transaction", async () => {
	const f = await setup();
	const missed = await f.approve("now");
	const freeze = new NativeDraftFreeze(f.revisions);
	const lockId = f.revisions.current(missed.binding).lockId;
	if (lockId === null) throw new Error("DYTEST original mixed consumed lock unavailable");
	f.target.write((tx) =>
		freeze.consumeInTransaction(tx, freeze.proofInTransaction(tx, missed.binding, missed.id)),
	);
	const future = await f.approve("at");
	const past = f.read(missed.id),
		remaining = f.read(future.id);
	if (!past || past.deliverBy === null || !remaining || remaining.deliverBy === null)
		throw new Error("DYTEST original mixed windows unavailable");
	expect(remaining.deliverBy > past.deliverBy + 1).toBe(true);
	const history = historicalState(f, lockId, "consumed");
	f.base.time.mono += past.deliverBy + 1 - f.base.time.wall;
	f.base.time.wall = past.deliverBy + 1;
	const before = state(f);
	expect(reset(f)).toBe(2);
	expect(
		canonicalize(f.read(missed.id)) ===
			canonicalize({
				...past,
				state: "NEEDS_REAPPROVAL",
				stateReason: "missed",
				updatedAt: Math.max(f.base.time.wall, past.updatedAt),
			}),
	).toBe(true);
	expectRestored(f, future, remaining);
	expect(f.revisions.current(missed.binding).lockId === null).toBe(true);
	expect(historicalState(f, lockId, "consumed")).toEqual(history);
	const after = state(f);
	expect(
		after.history === before.history &&
			after.approvals === before.approvals &&
			after.challenges === before.challenges,
	).toBe(true);
	f.base.native.store.read((db) => {
		const rows = db.all<{ seq: number; action: string }>(
			"SELECT seq,action FROM main.audit_events WHERE action IN ('outbox.missed','outbox.restored') AND refs IN (?,?) ORDER BY seq",
			[canonicalize({ outbox: missed.id }), canonicalize({ outbox: future.id })],
		);
		const [first, second] = rows;
		expect(
			rows.length === 2 &&
				first?.action === "outbox.missed" &&
				second?.action === "outbox.restored" &&
				first.seq < second.seq,
		).toBe(true);
		f.base.native.audit.verify(db);
	});
	expect(reset(f)).toBe(0);
	expect(state(f)).toEqual(after);
});
