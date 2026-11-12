import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { advanceEpochForRestore } from "../../src/identity/devices.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import {
	createNativeBackupRecoveryHandle,
	type NativeBackupRecovery,
	openNativeBackupRecovery,
} from "../../src/recovery/backup-recovery.ts";
import { generateRecoveryCode, RECOVERY_FILE } from "../../src/recovery/recovery-code.ts";
import { type SessionFixture, sessionFixture } from "../lifecycle/session-helpers.ts";

interface Cleanup {
	readonly files: SessionFixture;
	readonly handles: NativeBackupRecovery[];
	readonly buffers: Buffer[];
}
interface Enrolled {
	readonly cleanup: Cleanup;
	readonly originalKey: MasterKey;
	readonly capsule: Buffer;
	readonly binding: Buffer;
	session: HubSession;
	recovery: NativeBackupRecovery;
}
const fixtures: Cleanup[] = [];

function keep(cleanup: Cleanup, bytes: Buffer): Buffer {
	cleanup.buffers.push(bytes);
	return bytes;
}
function row(session: HubSession): Buffer | undefined {
	const value = session.store.read((sql) =>
		sql.get<{ binding: Buffer }>("SELECT binding FROM native_backup_recovery WHERE singleton=1"),
	);
	if (!value) return undefined;
	expect(Buffer.isBuffer(value.binding)).toBe(true);
	return value.binding;
}
function rowCount(session: HubSession): number | undefined {
	return session.store.read(
		(sql) =>
			sql.get<{ count: number }>("SELECT count(*) AS count FROM native_backup_recovery")?.count,
	);
}
function capsuleFile(f: Enrolled): Buffer {
	return keep(f.cleanup, readFileSync(path.join(f.cleanup.files.folder, RECOVERY_FILE)));
}
function currentBinding(f: Enrolled): Buffer {
	const bytes = row(f.session);
	if (!bytes) throw new Error("Recovery fixture has no binding row");
	return keep(f.cleanup, bytes);
}

async function enrolled(): Promise<Enrolled> {
	const cleanup: Cleanup = {
		files: sessionFixture("draftyak-native-recovery-bindings-"),
		handles: [],
		buffers: [],
	};
	fixtures.push(cleanup);
	const originalKey = cleanup.files.key();
	const session = await cleanup.files.open({ masterKey: originalKey });
	const recovery = openNativeBackupRecovery(session);
	cleanup.handles.push(recovery);
	const code = generateRecoveryCode();
	try {
		await recovery.enroll(code);
	} finally {
		code.fill(0);
	}
	const capsule = keep(cleanup, await recovery.readCapsule());
	const binding = row(session);
	if (!binding) throw new Error("Native enrollment did not create its binding");
	keep(cleanup, binding);
	expect(capsule.length).toBe(94);
	expect(binding.length).toBe(69);
	expect(rowCount(session)).toBe(1);
	const f = { cleanup, originalKey, session, recovery, capsule, binding };
	expect(capsuleFile(f).equals(capsule)).toBe(true);
	return f;
}

async function reopen(f: Enrolled): Promise<void> {
	await f.session.close();
	f.session = await f.cleanup.files.open();
	f.recovery = openNativeBackupRecovery(f.session);
	f.cleanup.handles.push(f.recovery);
}
async function refused(operation: () => unknown): Promise<void> {
	let accepted = false;
	let error: unknown;
	try {
		await operation();
		accepted = true;
	} catch (caught) {
		error = caught;
	}
	expect(accepted).toBe(false);
	expect(error instanceof Error).toBe(true);
	expect(error instanceof Error && "code" in error && error.code === "RECOVERY_UNAVAILABLE").toBe(
		true,
	);
	expect(error instanceof Error && !("cause" in error)).toBe(true);
}

afterEach(async () => {
	let failures = 0;
	for (const cleanup of fixtures.splice(0).reverse()) {
		for (const handle of cleanup.handles.reverse()) {
			try {
				await handle.close();
			} catch {
				failures++;
			}
		}
		try {
			await cleanup.files.remove();
		} catch {
			failures++;
		} finally {
			for (const bytes of cleanup.buffers) bytes.fill(0);
		}
	}
	expect(failures).toBe(0);
});

it.each([
	["magic", 0],
	["version", 4],
	["capsule digest", 5],
	["MAC", 37],
] as const)("refuses a changed native binding %s without healing it", async (_, offset) => {
	const f = await enrolled();
	const damaged = keep(f.cleanup, Buffer.from(f.binding));
	damaged[offset] = (damaged[offset] ?? 0) ^ 1;
	expect(damaged.length).toBe(69);
	expect(
		damaged.reduce((count, value, index) => count + Number(value !== f.binding[index]), 0),
	).toBe(1);
	const changed = f.session.store.write((sql) =>
		sql.run("UPDATE native_backup_recovery SET binding=? WHERE singleton=1", [damaged]),
	);
	expect(changed.changes).toBe(1);
	await refused(() => f.recovery.readCapsule());
	expect(capsuleFile(f).equals(f.capsule)).toBe(true);
	expect(currentBinding(f).equals(damaged)).toBe(true);
	expect(rowCount(f.session)).toBe(1);
});

it("does not heal a missing native binding, including after a genuine same-key reopen", async () => {
	const f = await enrolled();
	const deleted = f.session.store.write((sql) =>
		sql.run("DELETE FROM native_backup_recovery WHERE singleton=1"),
	);
	expect(deleted.changes).toBe(1);
	await refused(() => f.recovery.readCapsule());
	expect(rowCount(f.session)).toBe(0);
	expect(capsuleFile(f).equals(f.capsule)).toBe(true);
	await reopen(f);
	await refused(() => f.recovery.readCapsule());
	expect(rowCount(f.session)).toBe(0);
	expect(capsuleFile(f).equals(f.capsule)).toBe(true);
});

it("preserves enrolled capsule binding across a real device epoch advance and reopen", async () => {
	const f = await enrolled();
	const before = f.session.devices.currentState().epoch;
	const after = f.session.store.write((sql) => advanceEpochForRestore(f.session.devices, sql));
	expect(after).toBe(before + 1);
	expect(f.session.devices.currentState().epoch).toBe(after);
	// The epoch transition appends its own audit event; only recovery state stays unchanged.
	expect(currentBinding(f).equals(f.binding)).toBe(true);
	expect(capsuleFile(f).equals(f.capsule)).toBe(true);
	expect(keep(f.cleanup, await f.recovery.readCapsule()).equals(f.capsule)).toBe(true);
	await reopen(f);
	expect(f.session.devices.currentState().epoch).toBe(after);
	expect(rowCount(f.session)).toBe(1);
	expect(currentBinding(f).equals(f.binding)).toBe(true);
	expect(capsuleFile(f).equals(f.capsule)).toBe(true);
	expect(keep(f.cleanup, await f.recovery.readCapsule()).equals(f.capsule)).toBe(true);
});

it("refuses a separately constructed handle over the genuine session and original key", async () => {
	const f = await enrolled();
	const foreign = createNativeBackupRecoveryHandle(
		f.session,
		f.session.store,
		f.originalKey,
		f.cleanup.files.folder,
	);
	try {
		await refused(() => foreign.get());
	} finally {
		await foreign.close();
	}
	expect(openNativeBackupRecovery(f.session) === f.recovery).toBe(true);
	expect(keep(f.cleanup, await f.recovery.readCapsule()).equals(f.capsule)).toBe(true);
	expect(currentBinding(f).equals(f.binding)).toBe(true);
	expect(capsuleFile(f).equals(f.capsule)).toBe(true);
	expect(rowCount(f.session)).toBe(1);
});
