import { createHash } from "node:crypto";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	expireNativeOutboxMissed,
	NativeOutboxProposals,
	ProposalError,
} from "../../src/outbox/propose.ts";
import type { ProposalCandidate } from "./propose-fixture.ts";
import { type ExpiryFixture, expiryFixture } from "./scheduler-expiry-fixture.ts";

const originalWrite = NativeOutboxProposals.prototype.write;
const originalDestroy = NativeOutboxProposals.prototype.destroy;
const originalAppend = AuditChain.prototype.append;
const owned: {
	readonly fixture: ExpiryFixture;
	readonly migration?: { readonly directory: string; readonly file: string };
}[] = [];

afterEach(async () => {
	let failures = 0;
	for (const entry of owned.splice(0)) {
		try {
			await entry.fixture.close();
			if (entry.migration) {
				unlinkSync(entry.migration.file);
				rmdirSync(entry.migration.directory);
			}
		} catch {
			// Uncertain store closure retains its migration input; never recursively remove it.
			failures++;
		}
	}
	expect(failures).toBe(0);
});

async function setup(): Promise<ExpiryFixture> {
	const fixture = await expiryFixture();
	owned.push({ fixture });
	return fixture;
}

const AUDIT_FAULT = `CREATE TABLE dytest_expiry_fault (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
INSERT INTO dytest_expiry_fault(singleton,enabled) VALUES(1,0);
CREATE TRIGGER dytest_expiry_audit_abort BEFORE INSERT ON audit_events
WHEN NEW.action='outbox.missed' AND
  (SELECT enabled FROM dytest_expiry_fault WHERE singleton=1)=1
BEGIN
  SELECT RAISE(ABORT,'DYTEST_EXPIRY_AUDIT');
END;
CREATE TABLE dytest_expiry_cas_fault (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
) STRICT;
INSERT INTO dytest_expiry_cas_fault(singleton,enabled) VALUES(1,0);
CREATE TRIGGER dytest_expiry_cas_payload AFTER INSERT ON audit_events
WHEN NEW.action='outbox.missed' AND
  (SELECT enabled FROM dytest_expiry_cas_fault WHERE singleton=1)=1
BEGIN
  UPDATE outbox SET payload=payload || ' ' WHERE id=json_extract(NEW.refs,'$.outbox');
END;
`;

async function setupAuditFault(): Promise<ExpiryFixture> {
	const directory = mkdtempSync(path.join(os.tmpdir(), "draftyak-expiry-audit-"));
	const file = path.join(directory, "0001_expiry_fault.sql");
	writeFileSync(file, AUDIT_FAULT, { encoding: "utf8", flag: "wx", mode: 0o600 });
	// If setup cannot prove closure, retain the exact migration source for that owned store.
	const fixture = await expiryFixture({ extraMigrations: { expiryfault: directory } });
	owned.push({ fixture, migration: { directory, file } });
	return fixture;
}

function digest(value: unknown): string {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new Error("Expiry state unavailable");
	return createHash("sha256").update(encoded).digest("hex");
}

/** Hash only the genuine owned fixture's persisted state; these hashes issue no authority. */
function storedState(f: ExpiryFixture, proposal: ProposalCandidate) {
	return f.base.native.store.read((db) => ({
		outbox: digest(db.all("SELECT * FROM main.outbox WHERE id=?", [proposal.id])),
		draft: digest(
			db.all("SELECT * FROM main.native_drafts WHERE id=?", [proposal.binding.draftId]),
		),
		revisions: digest(
			db.all("SELECT * FROM main.native_draft_revisions WHERE draft_id=? ORDER BY rev", [
				proposal.binding.draftId,
			]),
		),
		freezes: digest(
			db.all("SELECT * FROM main.native_draft_locks WHERE draft_id=? ORDER BY id", [
				proposal.binding.draftId,
			]),
		),
		approvals: digest(
			db.all("SELECT * FROM main.approvals WHERE outbox_id=? ORDER BY id", [proposal.id]),
		),
		audit: digest(db.all("SELECT * FROM main.audit_events ORDER BY seq")),
		auditHead: digest(db.all("SELECT * FROM main.audit_meta ORDER BY singleton")),
		events: digest(db.all("SELECT * FROM main.events ORDER BY seq")),
		eventHead: digest(db.all("SELECT * FROM main.event_meta ORDER BY singleton")),
	}));
}

function movePastDeadline(f: ExpiryFixture, proposal: ProposalCandidate): void {
	const current = f.read(proposal.id);
	if (
		!current ||
		(current.state !== "APPROVED" && current.state !== "SCHEDULED") ||
		current.deliverBy === null
	)
		throw new Error("Expiry approved window unavailable");
	const next = current.deliverBy + 1;
	if (!Number.isSafeInteger(next) || next <= f.base.time.wall)
		throw new Error("Expiry test clock unavailable");
	f.base.time.mono += next - f.base.time.wall;
	f.base.time.wall = next;
}

function fixedRefusal(work: () => unknown): void {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(ProposalError);
	expect(failure).toMatchObject({
		code: "PROPOSAL_STALE",
		message: "Native outbox unavailable",
	});
	expect(Object.hasOwn(failure as object, "cause")).toBe(false);
}

function expectExpired(f: ExpiryFixture, proposal: ProposalCandidate): void {
	expect(f.read(proposal.id)).toMatchObject({
		state: "NEEDS_REAPPROVAL",
		stateReason: "missed",
	});
	expect(f.revisions.current(proposal.binding).lockId).toBeNull();
}

describe("native missed-window refusal and atomicity", () => {
	it("rolls back the real freeze, row MAC, audit and events when the missed audit insert fails", async () => {
		const f = await setupAuditFault();
		const proposal = await f.approve("at");
		movePastDeadline(f, proposal);
		const lock = f.revisions.current(proposal.binding).lockId;
		expect(lock).not.toBeNull();
		f.base.native.store.write((tx) => {
			expect(
				tx.run("UPDATE main.dytest_expiry_fault SET enabled=1 WHERE singleton=1").changes,
			).toBe(1);
		});
		const before = storedState(f, proposal);
		fixedRefusal(() => expireNativeOutboxMissed(f.target, proposal.id));
		expect(storedState(f, proposal)).toEqual(before);
		expect(f.read(proposal.id)?.state).toBe("SCHEDULED");
		expect(f.revisions.current(proposal.binding).lockId).toBe(lock);
		f.base.native.store.write((tx) => {
			expect(
				tx.run("UPDATE main.dytest_expiry_fault SET enabled=0 WHERE singleton=1").changes,
			).toBe(1);
		});
		expect(expireNativeOutboxMissed(f.target, proposal.id)).toBe(true);
		expectExpired(f, proposal);
	});

	it("rolls back a payload interleaving between the missed audit and full-row compare-and-set", async () => {
		const f = await setupAuditFault();
		const proposal = await f.approve("at");
		movePastDeadline(f, proposal);
		const beforeRecord = f.read(proposal.id);
		expect(beforeRecord?.state).toBe("SCHEDULED");
		const lock = f.revisions.current(proposal.binding).lockId;
		expect(lock).not.toBeNull();
		f.base.native.store.write((tx) => {
			expect(
				tx.run("UPDATE main.dytest_expiry_cas_fault SET enabled=1 WHERE singleton=1").changes,
			).toBe(1);
		});
		const before = storedState(f, proposal);
		fixedRefusal(() => expireNativeOutboxMissed(f.target, proposal.id));
		expect(storedState(f, proposal)).toEqual(before);
		expect(f.read(proposal.id)).toEqual(beforeRecord);
		expect(f.revisions.current(proposal.binding).lockId).toBe(lock);
		f.base.native.store.write((tx) => {
			expect(
				tx.run("UPDATE main.dytest_expiry_cas_fault SET enabled=0 WHERE singleton=1").changes,
			).toBe(1);
		});
		expect(expireNativeOutboxMissed(f.target, proposal.id)).toBe(true);
		expectExpired(f, proposal);
	});

	it("poisons a caught nested expiry so the outer original native write cannot commit", async () => {
		const f = await setup();
		const proposal = await f.approve();
		movePastDeadline(f, proposal);
		const before = storedState(f, proposal);
		let innerFailure: unknown;
		let outerFailure: unknown;
		try {
			originalWrite.call(f.target, (tx) => {
				originalAppend.call(f.base.native.audit, tx, {
					id: newId(f.base.time.wall),
					at: f.base.time.wall,
					action: "expiry.test_before_nested",
					actor: { kind: "hub", id: null },
					refs: { outbox: proposal.id },
				});
				try {
					expireNativeOutboxMissed(f.target, proposal.id);
				} catch (error) {
					innerFailure = error;
				}
			});
		} catch (error) {
			outerFailure = error;
		}
		expect(innerFailure).toBeInstanceOf(ProposalError);
		expect(outerFailure).toBeDefined();
		expect(storedState(f, proposal)).toEqual(before);
		expect(expireNativeOutboxMissed(f.target, proposal.id)).toBe(true);
		expectExpired(f, proposal);
	});

	it("refuses structural and proxy receivers without consulting their methods or getters", async () => {
		const f = await setup();
		const proposal = await f.approve();
		movePastDeadline(f, proposal);
		const before = storedState(f, proposal);
		let effects = 0;
		const effect = () => {
			effects++;
			throw new Error("Expiry receiver getter invoked");
		};
		const structural = Object.create(NativeOutboxProposals.prototype) as object;
		Object.defineProperties(structural, {
			write: { get: effect },
			expireMissed: { get: effect },
		});
		const proxy = new Proxy(f.target, { get: effect });
		const revoked = Proxy.revocable(f.target, { get: effect });
		revoked.revoke();
		for (const receiver of [{}, structural, proxy, revoked.proxy])
			fixedRefusal(() => expireNativeOutboxMissed(receiver, proposal.id));
		expect(effects).toBe(0);
		expect(storedState(f, proposal)).toEqual(before);
		expect(expireNativeOutboxMissed(f.target, proposal.id)).toBe(true);
	});

	it("keeps each genuine receiver within its own store for a foreign outbox identifier", async () => {
		const first = await setup();
		const second = await setup();
		const firstProposal = await first.approve();
		const secondProposal = await second.approve("at");
		movePastDeadline(first, firstProposal);
		movePastDeadline(second, secondProposal);
		const firstBefore = storedState(first, firstProposal);
		const secondBefore = storedState(second, secondProposal);
		expect(expireNativeOutboxMissed(first.target, secondProposal.id)).toBe(false);
		expect(expireNativeOutboxMissed(second.target, firstProposal.id)).toBe(false);
		expect(storedState(first, firstProposal)).toEqual(firstBefore);
		expect(storedState(second, secondProposal)).toEqual(secondBefore);
		expect(expireNativeOutboxMissed(first.target, firstProposal.id)).toBe(true);
		expect(expireNativeOutboxMissed(second.target, secondProposal.id)).toBe(true);
		expectExpired(first, firstProposal);
		expectExpired(second, secondProposal);
	});

	it("refuses a destroyed genuine receiver without touching its persisted approved state", async () => {
		const f = await setup();
		const proposal = await f.approve();
		movePastDeadline(f, proposal);
		const before = storedState(f, proposal);
		originalDestroy.call(f.target);
		fixedRefusal(() => expireNativeOutboxMissed(f.target, proposal.id));
		expect(storedState(f, proposal)).toEqual(before);
	});

	it("uses the captured expiry and write methods despite overridden instance methods", async () => {
		const f = await setup();
		const proposal = await f.approve();
		movePastDeadline(f, proposal);
		const write = Object.getOwnPropertyDescriptor(f.target, "write");
		const expire = Object.getOwnPropertyDescriptor(f.target, "expireMissed");
		let effects = 0;
		const effect = () => {
			effects++;
			throw new Error("Expiry overridden method invoked");
		};
		Object.defineProperties(f.target, {
			write: { value: effect, configurable: true },
			expireMissed: { value: effect, configurable: true },
		});
		try {
			expect(expireNativeOutboxMissed(f.target, proposal.id)).toBe(true);
			expect(effects).toBe(0);
		} finally {
			if (write) Object.defineProperty(f.target, "write", write);
			else Reflect.deleteProperty(f.target, "write");
			if (expire) Object.defineProperty(f.target, "expireMissed", expire);
			else Reflect.deleteProperty(f.target, "expireMissed");
		}
		expectExpired(f, proposal);
	});
});
