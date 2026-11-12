import { afterEach, describe, expect, it } from "vitest";
import { AccountError } from "../../src/accounts/records.ts";
import { readStamp } from "../../src/store/read-stamp.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { type Fixture, fixture, native } from "./propose-fixture.ts";

const opened: Fixture[] = [];
afterEach(async () => {
	for (const f of opened.splice(0)) await f.close();
});
async function setup() {
	const f = await fixture();
	opened.push(f);
	return { f, proposal: f.proposal() };
}
function stamp(tx: SqlTransaction) {
	const value = readStamp(tx);
	if (!value) throw new Error("DYTEST live native transaction stamp missing");
	return value;
}

describe("native account reads inside a device-authorized transaction", () => {
	it("preserves the native stamp and genuine peer grant while reading current account metadata", async () => {
		const { f, proposal } = await setup();
		const expected = f.readAccount(proposal.binding.accountId);
		expect(expected?.account).toMatchObject({ mode: "full", status: "active" });
		f.target.write((tx) => {
			const grant = f.native.authorizer.requirePeerDevice(tx, f.device.peer, "approve");
			f.native.authorizer.assertCurrentGrant(tx, grant);
			const before = stamp(tx);
			const record = f.accounts.getInTransaction(
				tx,
				native.owner(f.native),
				proposal.binding.accountId,
			);
			const after = stamp(tx);
			let grantFailure: unknown;
			try {
				f.native.authorizer.assertCurrentGrant(tx, grant);
			} catch (error) {
				grantFailure = error;
			}
			expect(record).toEqual(expected);
			expect(after.owner).toBe(before.owner);
			expect(after.revision).toBe(before.revision);
			expect(after.dataVersion).toBe(before.dataVersion);
			expect(after.schemaVersion).toBe(before.schemaVersion);
			// A metadata lookup must not acquire write effects or retire the already-current grant.
			expect.soft(after.totalChanges - before.totalChanges).toBe(0);
			expect.soft(grantFailure).toBeUndefined();
		});
	});

	it("still invalidates a genuine grant after a real native account replacement", async () => {
		const { f, proposal } = await setup();
		f.accountDatabase.write((scope) => {
			const current = f.accounts.get(scope, native.owner(f.native), proposal.binding.accountId);
			if (!current) throw new Error("DYTEST original account missing");
			const tx = f.accountDatabase.sql(scope);
			const grant = f.native.authorizer.requirePeerDevice(tx, f.device.peer, "approve");
			f.native.authorizer.assertCurrentGrant(tx, grant);
			const before = stamp(tx);
			const changed = f.accounts.replace(
				scope,
				{ ...current.account, alias: "dytest-stamp-write" },
				current.generation,
			);
			const after = stamp(tx);
			expect(changed.generation).toBe(current.generation + 1);
			expect(after.totalChanges).toBeGreaterThan(before.totalChanges);
			let refusal: unknown;
			try {
				f.native.authorizer.assertCurrentGrant(tx, grant);
			} catch (error) {
				refusal = error;
			}
			expect(refusal).toMatchObject({ code: "UNAVAILABLE" });
		});
	});

	it("rejects the genuine store's read-only callback facade", async () => {
		const { f, proposal } = await setup();
		f.native.store.read((reader) => {
			const grant = f.native.authorizer.requirePeerDevice(reader, f.device.peer, "approve");
			const before = readStamp(reader);
			expect(() =>
				f.accounts.getInTransaction(
					reader as SqlTransaction,
					native.owner(f.native),
					proposal.binding.accountId,
				),
			).toThrow(AccountError);
			expect(readStamp(reader)).toEqual(before);
			f.native.authorizer.assertCurrentGrant(reader, grant);
		});
	});

	it("rejects an expired genuine write transaction", async () => {
		const { f, proposal } = await setup();
		let retired: SqlTransaction | undefined;
		f.target.write((tx) => {
			retired = tx;
		});
		const tx = retired;
		if (!tx) throw new Error("DYTEST original write transaction missing");
		expect(() =>
			f.accounts.getInTransaction(tx, native.owner(f.native), proposal.binding.accountId),
		).toThrow(AccountError);
	});

	it("refuses another genuine store without retiring that store's own current grant", async () => {
		const left = await setup();
		const right = await setup();
		expect(right.f.readAccount(right.proposal.binding.accountId)).toBeDefined();
		const observed = right.f.target.write((tx) => {
			const grant = right.f.native.authorizer.requirePeerDevice(tx, right.f.device.peer, "approve");
			right.f.native.authorizer.assertCurrentGrant(tx, grant);
			const before = stamp(tx);
			let record: unknown;
			let refusal: unknown;
			try {
				record = left.f.accounts.getInTransaction(
					tx,
					native.owner(right.f.native),
					right.proposal.binding.accountId,
				);
			} catch (error) {
				refusal = error;
			}
			const after = stamp(tx);
			let grantFailure: unknown;
			try {
				right.f.native.authorizer.assertCurrentGrant(tx, grant);
			} catch (error) {
				grantFailure = error;
			}
			return { record, refusal, before, after, grantFailure };
		});
		expect(observed.record).toBeUndefined();
		expect(observed.refusal).toBeInstanceOf(AccountError);
		expect(observed.after).toEqual(observed.before);
		expect(observed.grantFailure).toBeUndefined();
	});
});
