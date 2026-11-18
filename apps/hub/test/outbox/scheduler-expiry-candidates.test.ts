import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { NativeOutboxProposals, ProposalError } from "../../src/outbox/propose.ts";
import { readExpiryCandidatePage } from "../../src/outbox/scheduler-expiry-candidates.ts";
import { SchedulerError } from "../../src/outbox/scheduler-ports.ts";
import { type ExpiryFixture, expiryFixture } from "./scheduler-expiry-fixture.ts";

const fixtures: ExpiryFixture[] = [];
async function setup(): Promise<ExpiryFixture> {
	const f = await expiryFixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	const closed = await Promise.allSettled(fixtures.splice(0).map((f) => f.close()));
	expect(closed.every((entry) => entry.status === "fulfilled")).toBe(true);
});

function fixedRefusal(work: () => unknown, code: "INVALID_INPUT" | "SCHEDULER_STORE"): void {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(SchedulerError);
	expect(failure).toMatchObject({ code, message: code });
	expect(Object.hasOwn(failure as object, "cause")).toBe(false);
}

it("selects genuine approved and scheduled identifiers as frozen data with an exclusive cursor", async () => {
	const f = await setup();
	const immediate = await f.approve();
	const scheduled = await f.approve("at");
	const pending = f.base.proposal();
	const expected = [immediate.id, scheduled.id].sort();
	const [first, last] = expected;
	if (!first || !last) throw new Error("Expiry candidate identifiers unavailable");
	expect(f.read(immediate.id)?.state).toBe("APPROVED");
	expect(f.read(scheduled.id)?.state).toBe("SCHEDULED");
	expect(f.read(pending.id)?.state).toBe("PENDING_APPROVAL");
	const page = readExpiryCandidatePage(f.target);
	expect(page).toEqual({ ids: expected, nextCursor: null });
	expect(Object.isFrozen(page)).toBe(true);
	expect(Object.isFrozen(page.ids)).toBe(true);
	expect(readExpiryCandidatePage(f.target, first)).toEqual({
		ids: expected.slice(1),
		nextCursor: null,
	});
	expect(readExpiryCandidatePage(f.target, last)).toEqual({ ids: [], nextCursor: null });
	// A fresh pass always reselects the current store; the reader retains no high-watermark.
	expect(readExpiryCandidatePage(f.target, null)).toEqual(page);
	expect(f.read(immediate.id)?.state).toBe("APPROVED");
	expect(f.read(scheduled.id)?.state).toBe("SCHEDULED");
});

it("pages 101 corrupt storage candidates without granting native approval authority or changing data", async () => {
	const f = await setup();
	const expected = Array.from({ length: 101 }, () => f.base.proposal().id).sort();
	const first = expected[0],
		hundredth = expected[99],
		last = expected[100];
	if (!first || !hundredth || !last) throw new Error("Expiry candidate boundary unavailable");
	expect(new Set(expected).size).toBe(101);
	expect(f.read(first)?.state).toBe("PENDING_APPROVAL");
	// Deliberately corrupt only plaintext selection DATA in this owned test store. The
	// original pending payloads and MACs remain untouched: these are not signed approvals.
	f.base.native.store.write((tx) => {
		expect(
			tx.run("UPDATE main.outbox SET state='APPROVED' WHERE state='PENDING_APPROVAL'").changes,
		).toBe(101);
	});
	const persistedDigest = (): string =>
		f.base.native.store.read((db) =>
			createHash("sha256")
				.update(
					JSON.stringify({
						rows: db.all("SELECT * FROM main.outbox ORDER BY id COLLATE BINARY"),
						audit: db.all("SELECT * FROM main.audit_events ORDER BY seq"),
						head: db.all("SELECT * FROM main.audit_meta ORDER BY singleton"),
					}),
				)
				.digest("hex"),
		);
	const before = persistedDigest();
	const page = readExpiryCandidatePage(f.target);
	expect(page).toEqual({ ids: expected.slice(0, 100), nextCursor: hundredth });
	expect(Object.isFrozen(page)).toBe(true);
	expect(Object.isFrozen(page.ids)).toBe(true);
	expect(readExpiryCandidatePage(f.target, hundredth)).toEqual({
		ids: [last],
		nextCursor: null,
	});
	expect(readExpiryCandidatePage(f.target, last)).toEqual({ ids: [], nextCursor: null });
	expect(readExpiryCandidatePage(f.target, null)).toEqual(page);
	expect(persistedDigest()).toBe(before);
	// Selecting an identifier cannot replace the original native payload/MAC check.
	expect(() => f.target.write((tx) => f.target.get(tx, first))).toThrow(ProposalError);
	expect(persistedDigest()).toBe(before);
});

it("rejects invalid or effectful cursor values without coercion", async () => {
	const f = await setup();
	let effects = 0;
	const effect = () => {
		effects++;
		throw new Error("Expiry cursor effect invoked");
	};
	const object = Object.create(null) as object;
	Object.defineProperty(object, "toString", { get: effect });
	const proxy = new Proxy(object, { get: effect, getPrototypeOf: effect });
	for (const cursor of ["", "invalid", "0".repeat(25), `${"0".repeat(26)}\n`, 1, object, proxy])
		fixedRefusal(() => readExpiryCandidatePage(f.target, cursor as never), "INVALID_INPUT");
	expect(effects).toBe(0);
	expect(readExpiryCandidatePage(f.target)).toEqual({ ids: [], nextCursor: null });
});

it("rejects structural and proxy targets without accepting a supplied reader", async () => {
	const f = await setup();
	let effects = 0;
	const effect = () => {
		effects++;
		throw new Error("Expiry candidate receiver effect invoked");
	};
	const structural = Object.create(NativeOutboxProposals.prototype) as object;
	Object.defineProperty(structural, "write", { get: effect });
	const proxy = new Proxy(f.target, { get: effect, getPrototypeOf: effect });
	const revoked = Proxy.revocable(f.target, { get: effect });
	revoked.revoke();
	for (const target of [{ write: effect }, structural, proxy, revoked.proxy])
		fixedRefusal(() => readExpiryCandidatePage(target), "SCHEDULER_STORE");
	expect(effects).toBe(0);
	expect(readExpiryCandidatePage(f.target)).toEqual({ ids: [], nextCursor: null });
});

it("uses each genuine target's own store and refuses a destroyed target", async () => {
	const first = await setup();
	const second = await setup();
	const firstProposal = await first.approve();
	const secondProposal = await second.approve();
	expect(readExpiryCandidatePage(first.target)).toEqual({
		ids: [firstProposal.id],
		nextCursor: null,
	});
	expect(readExpiryCandidatePage(second.target)).toEqual({
		ids: [secondProposal.id],
		nextCursor: null,
	});
	first.target.destroy();
	fixedRefusal(() => readExpiryCandidatePage(first.target), "SCHEDULER_STORE");
	expect(readExpiryCandidatePage(second.target)).toEqual({
		ids: [secondProposal.id],
		nextCursor: null,
	});
});

it("uses the captured original write instead of an overridden instance method", async () => {
	const f = await setup();
	const proposal = await f.approve();
	let effects = 0;
	Object.defineProperty(f.target, "write", {
		configurable: true,
		value: () => {
			effects++;
			throw new Error("Expiry candidate write override invoked");
		},
	});
	try {
		expect(readExpiryCandidatePage(f.target)).toEqual({ ids: [proposal.id], nextCursor: null });
		expect(effects).toBe(0);
	} finally {
		Reflect.deleteProperty(f.target, "write");
	}
});
