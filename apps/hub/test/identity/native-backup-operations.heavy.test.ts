import { createHash } from "node:crypto";
import type { OperationRequest } from "@draftyak/protocol/device-api";
import { Ulid } from "@draftyak/protocol/scalars";
import { afterEach, expect, it } from "vitest";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import { NativeAdminError } from "../../src/identity/admin-errors.ts";
import {
	assertNativeBackupExecutionCurrent,
	assertNativeBackupExecutionSigner,
	consumeNativeBackupLease,
	NativeBackupOperations,
	retireNativeBackupExecution,
	takeNativeBackupLease,
} from "../../src/identity/backup-operations.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import { closeSessionTransport, sessionTransport } from "../lifecycle/session-helpers.ts";
import { connectFakeDevice } from "../support/fake-device/harness.ts";
import {
	type NativeBackupFixture,
	nativeBackupFixture,
	originalKeyErased,
	originalKeyLength,
} from "./native-backup-fixture.ts";

const fixtures: NativeBackupFixture[] = [];
async function fixture(): Promise<NativeBackupFixture> {
	const f = await nativeBackupFixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	const closed = await Promise.allSettled(fixtures.splice(0).map((f) => f.close()));
	if (closed.some((result) => result.status === "rejected"))
		throw new Error("DYTEST backup operations cleanup incomplete");
});

function refused(work: () => unknown, code?: string): void {
	let error: unknown;
	try {
		work();
	} catch (reason) {
		error = reason;
	}
	expect(error instanceof NativeAdminError).toBe(true);
	if (code && error instanceof NativeAdminError) expect(error.code).toBe(code);
}
function refusedConstructor(session: unknown, key: MasterKey, f: NativeBackupFixture): void {
	let created: NativeBackupOperations | undefined, error: unknown;
	try {
		created = new NativeBackupOperations(session, key, f.clock);
	} catch (reason) {
		error = reason;
	}
	try {
		expect(created === undefined).toBe(true);
		expect(error instanceof NativeAdminError).toBe(true);
	} finally {
		created?.lock();
	}
}
async function authorized(f: NativeBackupFixture) {
	const issued = f.issue();
	const accepted = await f.accept(issued.envelope);
	expect(accepted.kind).toBe("admin.v1");
	expect(accepted.id === issued.review.id).toBe(true);
	return issued;
}

it("opens only the exact backup subject and reviews it without changing the existing account", async () => {
	const f = await fixture(),
		before = f.evidence();
	const review = f.open();
	expect(Ulid.safeParse(review.id).success).toBe(true);
	expect(review.subject).toEqual({ scope: "backup" });
	expect(review.digest === createHash("sha256").update('{"scope":"backup"}').digest("hex")).toBe(
		true,
	);
	expect(review.expiresAt - f.clock.wallMs()).toBe(120_000);
	expect(review.remainingMs).toBe(120_000);
	const again = f.operations.review(f.owner.device.peer, review.id);
	expect(again.id === review.id && again.digest === review.digest).toBe(true);
	expect(again.subject).toEqual({ scope: "backup" });
	const after = f.evidence();
	expect(after).toEqual({
		...before,
		opened: before.opened + 1,
		pendingOperations: before.pendingOperations + 1,
	});
	expect(f.operation(review.id).state).toBe("pending");
	refused(() => takeNativeBackupLease(f.operations, f.owner.device.peer, review.id), "STALE");
});

it("refuses structural, foreign-key and closed Sessions and peers without native admin authority", async () => {
	const f = await fixture(),
		other = await fixture(),
		before = f.evidence();
	let traps = 0;
	refusedConstructor(Object.create(null), f.key, f);
	refusedConstructor(
		new Proxy(f.session, {
			get: () => {
				traps++;
				throw new Error("DYTEST trap");
			},
		}),
		f.key,
		f,
	);
	refusedConstructor(f.session, other.key, f);
	expect(traps).toBe(0);
	expect(originalKeyLength(other.key)).toBe(32);
	const unpaired = await f.connect();
	for (const peer of [
		Object.create(null) as NativeDevicePeer,
		unpaired.device.peer,
		other.owner.device.peer,
	])
		refused(() => f.operations.open(peer, { kind: "data.backup", ids: [] }));
	expect(f.evidence()).toEqual(before);
	await f.session.close();
	expect(originalKeyErased(f.key)).toBe(true);
	refusedConstructor(f.session, f.key, f);
	refused(() => f.operations.open(f.owner.device.peer, { kind: "data.backup", ids: [] }));
});

it("rejects non-backup, nonempty-id and extra-field requests before creating operation state", async () => {
	const f = await fixture(),
		before = f.evidence();
	expect(Ulid.safeParse(f.owner.device.id).success).toBe(true);
	for (const request of [
		{ kind: "account.mode-full", ids: [f.owner.device.id] },
		{ kind: "data.backup", ids: [f.owner.device.id] },
		{ kind: "data.backup", ids: [], subject: { scope: "backup" } },
		{ kind: "data.backup", ids: null },
	])
		refused(
			() => f.operations.open(f.owner.device.peer, request as OperationRequest),
			"INVALID_REQUEST",
		);
	expect(f.evidence()).toEqual(before);
});

it("uses both original 120-second clocks and refuses persisted operations after a genuine reopen", async () => {
	const f = await fixture(),
		first = f.open();
	f.advance(120_000);
	expect(f.operations.review(f.owner.device.peer, first.id).remainingMs).toBe(0);
	f.advance(1);
	refused(() => f.operations.review(f.owner.device.peer, first.id), "STALE");
	const monotonic = f.open();
	f.advance(0, 120_001);
	refused(() => f.operations.review(f.owner.device.peer, monotonic.id), "STALE");
	const persisted = f.open();
	await f.owner.client.close();
	await closeSessionTransport(f.native);
	await f.session.close();
	const key = f.storage.key();
	const reopened = await f.storage.open({ masterKey: key, clock: f.clock });
	const transport = await sessionTransport(reopened, key, f.storage.folder);
	let client: Awaited<ReturnType<typeof connectFakeDevice>> | undefined;
	let fresh: NativeBackupOperations | undefined;
	try {
		client = await connectFakeDevice(transport, f.owner.client);
		const peer = client.device.peer;
		const issuer = new NativeBackupOperations(reopened, key, f.clock);
		fresh = issuer;
		const current = issuer.open(peer, { kind: "data.backup", ids: [] });
		expect(Ulid.safeParse(current.id).success).toBe(true);
		refused(() => issuer.review(peer, persisted.id), "STALE");
	} finally {
		fresh?.lock();
		await client?.client.close();
		await closeSessionTransport(transport);
		await reopened.close();
	}
});

it("issues only post-commit one-use opaque execution and spends foreign-session or foreign-peer attempts", async () => {
	const f = await fixture(),
		other = await fixture();
	const issued = f.issue();
	refused(
		() => takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id),
		"STALE",
	);
	await f.accept(issued.envelope);
	refused(() => takeNativeBackupLease({ ...f.operations }, f.owner.device.peer, issued.review.id));
	refused(
		() => takeNativeBackupLease(other.operations, other.owner.device.peer, issued.review.id),
		"STALE",
	);
	const lease = takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id);
	expect(Object.isFrozen(lease)).toBe(true);
	expect(Object.keys(lease).length).toBe(0);
	refused(() => consumeNativeBackupLease({ ...lease }, f.session));
	const execution = consumeNativeBackupLease(lease, f.session);
	expect(Object.isFrozen(execution)).toBe(true);
	expect(Object.keys(execution).length).toBe(0);
	refused(() => consumeNativeBackupLease(lease, f.session));
	expect(() => assertNativeBackupExecutionCurrent(execution, f.session)).not.toThrow();
	expect(() =>
		assertNativeBackupExecutionSigner(execution, f.session, f.owner.device.peer),
	).not.toThrow();
	refused(() => assertNativeBackupExecutionCurrent({ ...execution }, f.session));
	refused(() => assertNativeBackupExecutionSigner(execution, f.session, other.owner.device.peer));
	refused(() => retireNativeBackupExecution(execution, other.session));
	expect(() => assertNativeBackupExecutionCurrent(execution, f.session)).not.toThrow();
	const cross = await authorized(f);
	const crossLease = takeNativeBackupLease(f.operations, f.owner.device.peer, cross.review.id);
	refused(() => consumeNativeBackupLease(crossLease, other.session));
	refused(() => consumeNativeBackupLease(crossLease, f.session));
	const peerBound = await authorized(f),
		reconnected = await f.connect(f.owner.client);
	refused(
		() => takeNativeBackupLease(f.operations, reconnected.device.peer, peerBound.review.id),
		"STALE",
	);
	refused(
		() => takeNativeBackupLease(f.operations, f.owner.device.peer, peerBound.review.id),
		"STALE",
	);
	const locked = await authorized(f);
	const lockedLease = takeNativeBackupLease(f.operations, f.owner.device.peer, locked.review.id);
	f.operations.lock();
	refused(() => consumeNativeBackupLease(lockedLease, f.session));
	refused(() => assertNativeBackupExecutionCurrent(execution, f.session));
	await f.session.close();
	expect(originalKeyErased(f.key)).toBe(true);
	expect(() => retireNativeBackupExecution(execution, f.session)).not.toThrow();
	expect(() => retireNativeBackupExecution(execution, f.session)).not.toThrow();
});

it("spends the lease before refusing changed native grants, epoch, operation integrity or expiry", async () => {
	for (const fault of ["grant", "epoch", "version", "expiry", "peer-close"] as const) {
		const f = await fixture(),
			issued = await authorized(f);
		const deviceId = f.owner.device.id;
		if (!deviceId) throw new Error("DYTEST native owner device is missing");
		const lease = takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id);
		// These are committed native state faults, never caller-supplied authorization facts.
		if (fault === "grant")
			f.session.store.write((tx) =>
				tx.run("UPDATE main.devices SET revoked_at=? WHERE id=?", [f.clock.wallMs(), deviceId]),
			);
		else if (fault === "epoch")
			f.session.store.write((tx) =>
				tx.run("UPDATE main.device_authority SET epoch=epoch+1,bootstrap_done=0 WHERE singleton=1"),
			);
		else if (fault === "version")
			f.session.store.write((tx) =>
				tx.run("UPDATE main.native_backup_operations SET audit_seq=audit_seq+1 WHERE id=?", [
					issued.review.id,
				]),
			);
		else if (fault === "expiry") f.advance(120_001);
		else await f.native.tls.close();
		refused(() => consumeNativeBackupLease(lease, f.session));
		refused(() => consumeNativeBackupLease(lease, f.session));
	}
});

it("poisons a caught in-transaction lease attempt and rolls back later writes without publishing authorization", async () => {
	const f = await fixture(),
		issued = await authorized(f),
		before = f.operation(issued.review.id);
	let innerRefused = false;
	refused(() =>
		f.operations.write((tx) => {
			try {
				takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id);
			} catch (error) {
				innerRefused = error instanceof NativeAdminError;
			}
			tx.run("UPDATE main.native_backup_operations SET audit_seq=audit_seq+1 WHERE id=?", [
				issued.review.id,
			]);
		}),
	);
	expect(innerRefused).toBe(true);
	expect(f.operation(issued.review.id).version).toBe(before.version);
	refused(
		() => takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id),
		"STALE",
	);
	expect(f.evidence().accountMode).toBe("read_only");
});
