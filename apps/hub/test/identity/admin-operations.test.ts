import { randomBytes } from "node:crypto";
import { type OperationRequest, OperationReview } from "@draftyak/protocol/device-api";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { afterEach, expect, it } from "vitest";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import {
	applyNativeAdminOperation,
	assertNativeAdminOperations,
	assertNativeAdminScope,
	NativeAccountModeOperations,
	prepareNativeAdminOperation,
	writeNativeAdminOperations,
} from "../../src/identity/admin-operations.ts";
import type { WorkScope } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import { type Fixture, fixture, native } from "./admin-operations-fixture.ts";

const fixtures: Fixture[] = [];
async function setup(): Promise<Fixture> {
	const f = await fixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
});
const request = (id: string): OperationRequest => ({ kind: "account.mode-full", ids: [id] });
function count(f: Fixture): {
	operations: number | undefined;
	audit: number | undefined;
	events: number | undefined;
} {
	return f.native.store.read((tx) => ({
		operations: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.native_admin_operations")?.n,
		audit: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.audit_events")?.n,
		events: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.events")?.n,
	}));
}
it("opens an exact native account review without changing mode or granting approval", async () => {
	const f = await setup(),
		before = f.current(),
		review = f.operations.open(f.device.peer, request(before.account.id));
	expect(OperationReview.safeParse(review).success).toBe(true);
	expect(review).toMatchObject({
		kind: "account.mode-full",
		digest: jcsSha256(review.subject),
		subject: {
			channel: "email",
			account: before.account.id,
			alias: before.account.alias,
			createdAt: before.account.createdAt,
			address: "dytest-owner@example.invalid",
		},
	});
	expect(f.current()).toEqual(before);
	expect(f.operations.review(f.device.peer, review.id)).toEqual(review);
	const prepared = writeNativeAdminOperations(f.operations, (tx, scope) =>
		prepareNativeAdminOperation(f.operations, tx, scope, f.device.peer, review.id),
	);
	expect(prepared).toMatchObject({
		fields: { op: review.id, kind: "account.mode-full", digest: review.digest },
		dataClass: "gmail.metadata",
		operationVersion: expect.any(Number),
	});
	expect(() =>
		writeNativeAdminOperations(f.operations, (tx, scope) =>
			applyNativeAdminOperation(f.operations, tx, scope, prepared as never),
		),
	).toThrow();
	expect(f.current()).toEqual(before);
	expect(native.auditActions(f.native)).toContain("admin.account_mode.opened");
	expect(native.auditActions(f.native)).not.toContain("admin.account_mode.applied");
});
it("uses the existing native chat subject and bounded integer remaining lifetime", async () => {
	const f = await setup(),
		chat = f.createAccount({ channel: "chat" }),
		review = f.operations.open(f.device.peer, request(chat.account.id));
	expect(review).toMatchObject({
		kind: "account.mode-full",
		subject: {
			channel: "chat",
			account: chat.account.id,
			teamId: "DYTEST-team",
			selfUserId: "DYTEST-user",
		},
		remainingMs: 120_000,
	});
	f.time.mono += 0.25;
	expect(Number.isInteger(f.operations.review(f.device.peer, review.id).remainingMs)).toBe(true);
});
it("requires actual current admin peer and rejects inert hostile or unsupported requests without writes", async () => {
	const f = await setup(),
		stranger = await native.device(f.native),
		before = count(f);
	for (const peer of [Object.freeze({}) as NativeDevicePeer, stranger.peer])
		expect(() => f.operations.open(peer, request(f.account.account.id))).toThrow();
	for (const input of [
		{ kind: "plugin.install", ids: [newId()] },
		{ kind: "data.backup", ids: [] },
		{ kind: "account.mode-full", ids: [] },
		{ kind: "account.mode-full", ids: [newId(), newId()] },
	])
		expect(() => f.operations.open(f.device.peer, input as OperationRequest)).toThrow();
	let touched = false;
	const hostile = Object.defineProperty({}, "kind", {
		get() {
			touched = true;
			throw new Error("DYTEST accessor");
		},
	});
	expect(() => f.operations.open(f.device.peer, hostile as OperationRequest)).toThrow();
	expect(touched).toBe(false);
	expect(count(f)).toEqual(before);
});
it("refuses foreign missing retired and ineligible native accounts", async () => {
	const f = await setup(),
		full = f.createAccount({ mode: "full" }),
		foreign = f.createAccount({ userId: newId() }),
		other = f.createAccount({ status: "disconnecting" }),
		retired = f.createAccount({ status: "disconnecting" });
	f.database.write((scope) =>
		f.accounts.retire(scope, retired.account.userId, retired.account.id, retired.generation),
	);
	const before = count(f);
	for (const id of [
		newId(),
		full.account.id,
		foreign.account.id,
		other.account.id,
		retired.account.id,
	])
		expect(() => f.operations.open(f.device.peer, request(id))).toThrow();
	expect(count(f)).toEqual(before);
	expect(f.current().account.mode).toBe("read_only");
});
it("binds native generation even when the existing M1 subject digest is unchanged", async () => {
	const f = await setup(),
		review = f.operations.open(f.device.peer, request(f.account.account.id)),
		current = f.current();
	f.database.write((scope) => f.accounts.replace(scope, current.account, current.generation));
	expect(() => f.operations.review(f.device.peer, review.id)).toThrow();
	const next = f.operations.open(f.device.peer, request(current.account.id));
	expect(next.digest).toBe(review.digest);
	expect(next.id).not.toBe(review.id);
});
it("requires same-store live issuer scopes and poisons a caught foreign-scope refusal", async () => {
	const f = await setup(),
		review = f.operations.open(f.device.peer, request(f.account.account.id));
	const foreign = await setup();
	expect(() => assertNativeAdminOperations(f.operations, foreign.native.store)).toThrow();
	expect(() => assertNativeAdminOperations({ ...f.operations }, f.native.store)).toThrow();
	expect(() =>
		f.native.store.write((tx) =>
			prepareNativeAdminOperation(f.operations, tx, { sql: tx }, f.device.peer, review.id),
		),
	).toThrow();
	let retired: { tx: SqlTransaction; scope: WorkScope } | undefined;
	writeNativeAdminOperations(f.operations, (tx, scope) => {
		retired = { tx, scope };
	});
	if (!retired) throw new Error("DYTEST scope missing");
	const old = retired;
	expect(() =>
		prepareNativeAdminOperation(f.operations, old.tx, old.scope, f.device.peer, review.id),
	).toThrow();
	expect(() =>
		writeNativeAdminOperations(f.operations, (tx, _scope) => {
			tx.run("UPDATE main.dytest_admin_faults SET final_op=1 WHERE singleton=1");
			try {
				assertNativeAdminScope(f.operations, tx, { sql: tx });
			} catch {
				/* A consumer catches the refusal. */
			}
		}),
	).toThrow();
	expect(
		f.native.store.read(
			(tx) =>
				tx.get<{ final_op: number }>("SELECT final_op FROM main.dytest_admin_faults")?.final_op,
		),
	).toBe(0);
});
it("does not revive persisted operation rows in a replacement issuer and uses captured originals", async () => {
	const f = await setup(),
		review = f.operations.open(f.device.peer, request(f.account.account.id)),
		other = new NativeAccountModeOperations(
			f.native.store,
			f.native.audit,
			f.native.key,
			f.native.registry,
			f.native.authorizer,
			f.native.identity,
			f.clock,
		);
	try {
		expect(() => other.review(f.device.peer, review.id)).toThrow();
		const original = NativeAccountModeOperations.prototype.prepare;
		try {
			NativeAccountModeOperations.prototype.prepare = () => {
				throw new Error("DYTEST mutable prototype");
			};
			expect(
				writeNativeAdminOperations(f.operations, (tx, scope) =>
					prepareNativeAdminOperation(f.operations, tx, scope, f.device.peer, review.id),
				).fields.op,
			).toBe(review.id);
		} finally {
			NativeAccountModeOperations.prototype.prepare = original;
		}
		f.operations.lock();
		expect(() => f.operations.review(f.device.peer, review.id)).toThrow();
	} finally {
		other.lock();
	}
});
it.each(["wall", "mono"] as const)(
	"retains the original operation %s deadline at its inclusive bound",
	async (clock) => {
		const f = await setup(),
			review = f.operations.open(f.device.peer, request(f.account.account.id));
		f.time[clock] += 120_000;
		expect(f.operations.review(f.device.peer, review.id).remainingMs).toBe(0);
		f.time[clock] += 1;
		expect(() => f.operations.review(f.device.peer, review.id)).toThrow();
	},
);
it("authenticates operation rows and refuses a foreign master key without granting authority", async () => {
	const f = await setup(),
		review = f.operations.open(f.device.peer, request(f.account.account.id));
	f.native.store.write((tx) =>
		tx.run("UPDATE main.native_admin_operations SET mac=? WHERE id=?", ["0".repeat(64), review.id]),
	);
	expect(() => f.operations.review(f.device.peer, review.id)).toThrow();
	const bytes = randomBytes(32),
		key = new MasterKey(bytes);
	bytes.fill(0);
	try {
		expect(
			() =>
				new NativeAccountModeOperations(
					f.native.store,
					f.native.audit,
					key,
					f.native.registry,
					f.native.authorizer,
					f.native.identity,
					f.clock,
				),
		).toThrow();
	} finally {
		key.destroy();
	}
	expect(f.current().account.mode).toBe("read_only");
});
