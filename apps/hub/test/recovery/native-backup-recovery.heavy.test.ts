import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { assertHubSessionAdmission, type HubSession } from "../../src/lifecycle/session.ts";
import {
	type NativeBackupRecovery,
	openNativeBackupRecovery,
} from "../../src/recovery/backup-recovery.ts";
import {
	generateRecoveryCode,
	openRecoveryFile,
	RECOVERY_FILE,
	RECOVERY_FILE_SIZE,
	writeRecoveryFile,
} from "../../src/recovery/recovery-code.ts";
import { type SessionFixture, sessionFixture } from "../lifecycle/session-helpers.ts";

interface RecoveryFixture {
	readonly files: SessionFixture;
	readonly handles: NativeBackupRecovery[];
	readonly keys: MasterKey[];
	readonly secrets: Buffer[];
	readonly legacySeed: Buffer | undefined;
	session: HubSession;
	currentKey: MasterKey;
}

const fixtures: RecoveryFixture[] = [];

async function fixture(legacy = false): Promise<RecoveryFixture> {
	const files = sessionFixture("draftyak-backup-recovery-");
	const legacySeed = legacy ? randomBytes(32) : undefined;
	const currentKey = legacySeed ? new MasterKey(legacySeed) : files.key();
	try {
		const session = await files.open({ masterKey: currentKey });
		const result: RecoveryFixture = {
			files,
			session,
			currentKey,
			legacySeed,
			handles: [],
			keys: [currentKey],
			secrets: legacySeed ? [legacySeed] : [],
		};
		fixtures.push(result);
		return result;
	} catch {
		currentKey.destroy();
		legacySeed?.fill(0);
		await files.remove();
		throw new Error("Recovery fixture unavailable");
	}
}

afterEach(async () => {
	let failures = 0;
	for (const f of fixtures.splice(0).reverse()) {
		for (const handle of f.handles.reverse()) {
			try {
				await handle.close();
			} catch {
				failures++;
			}
		}
		try {
			await f.files.remove();
		} catch {
			failures++;
		}
		for (const key of f.keys) key.destroy();
		for (const bytes of f.secrets) bytes.fill(0);
	}
	expect(failures).toBe(0);
});

function recovery(f: RecoveryFixture): NativeBackupRecovery {
	const handle = openNativeBackupRecovery(f.session);
	f.handles.push(handle);
	return handle;
}

function code(f: RecoveryFixture): Buffer {
	const value = generateRecoveryCode();
	f.secrets.push(value);
	return value;
}

function filename(f: RecoveryFixture): string {
	return path.join(f.files.folder, RECOVERY_FILE);
}

function assertRefusal(error: unknown): void {
	expect(error instanceof Error).toBe(true);
	expect(error instanceof Error && "code" in error && error.code === "RECOVERY_UNAVAILABLE").toBe(
		true,
	);
	expect(error instanceof Error && !("cause" in error)).toBe(true);
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
	assertRefusal(error);
}

function refusedNow(operation: () => unknown): void {
	let accepted = false;
	let error: unknown;
	try {
		operation();
		accepted = true;
	} catch (caught) {
		error = caught;
	}
	expect(accepted).toBe(false);
	assertRefusal(error);
}

async function reopen(f: RecoveryFixture): Promise<void> {
	await f.session.close();
	const key = f.legacySeed ? new MasterKey(f.legacySeed) : f.files.key();
	f.keys.push(key);
	f.session = await f.files.open({ masterKey: key });
	f.currentKey = key;
}

function sameStoreKey(f: RecoveryFixture, secret: Buffer): boolean {
	const recovered = openRecoveryFile(f.files.folder, secret);
	try {
		f.session.store.assertMasterKey(recovered);
		return true;
	} catch {
		return false;
	} finally {
		recovered.destroy();
	}
}

function originalSessionOpen(f: RecoveryFixture): boolean {
	try {
		assertHubSessionAdmission(f.session);
		return true;
	} catch {
		return false;
	}
}

it("enrolls a genuine session key in the existing encrypted recovery format", async () => {
	const f = await fixture();
	const handle = recovery(f);
	const secret = code(f);
	const before = Buffer.from(secret);
	f.secrets.push(before);
	expect(existsSync(filename(f))).toBe(false);
	expect((await handle.enroll(secret)) === undefined).toBe(true);
	expect(secret.equals(before)).toBe(true);
	const disk = readFileSync(filename(f));
	const capsule = await handle.readCapsule();
	expect(disk.length).toBe(94);
	expect(capsule.length).toBe(RECOVERY_FILE_SIZE);
	expect(capsule.equals(disk)).toBe(true);
	expect(sameStoreKey(f, secret)).toBe(true);
});

it("reads the enrolled capsule after a genuine same-key reopen without supplying a code", async () => {
	const f = await fixture();
	const first = recovery(f);
	await first.enroll(code(f));
	const before = await first.readCapsule();
	await reopen(f);
	const after = await recovery(f).readCapsule();
	expect(after.length).toBe(94);
	expect(after.equals(before)).toBe(true);
	expect(after.equals(readFileSync(filename(f)))).toBe(true);
});

it("returns independent owned copies without exposing a mutable enrolled capsule", async () => {
	const f = await fixture();
	const handle = recovery(f);
	await handle.enroll(code(f));
	const disk = readFileSync(filename(f));
	const first = await handle.readCapsule();
	const second = await handle.readCapsule();
	expect(first !== second).toBe(true);
	expect(first.equals(second)).toBe(true);
	first.fill(0);
	expect(second.equals(disk)).toBe(true);
	expect((await handle.readCapsule()).equals(disk)).toBe(true);
	expect(readFileSync(filename(f)).equals(disk)).toBe(true);
});

it("does not bless or overwrite a valid unbound legacy capsule", async () => {
	const f = await fixture(true);
	const secret = code(f);
	if (!f.legacySeed) throw new Error("Recovery fixture unavailable");
	writeRecoveryFile(f.files.folder, f.legacySeed, secret);
	expect(sameStoreKey(f, secret)).toBe(true);
	const before = readFileSync(filename(f));
	const handle = recovery(f);
	await refused(() => handle.readCapsule());
	await refused(() => handle.enroll(code(f)));
	expect(readFileSync(filename(f)).equals(before)).toBe(true);
	await refused(() => handle.readCapsule());
});

it("adopts a same-key legacy capsule only after the correct recovery code", async () => {
	const f = await fixture(true);
	const secret = code(f);
	const secretBefore = Buffer.from(secret);
	f.secrets.push(secretBefore);
	if (!f.legacySeed) throw new Error("Recovery fixture unavailable");
	writeRecoveryFile(f.files.folder, f.legacySeed, secret);
	const before = readFileSync(filename(f));
	const wrong = Buffer.from(secret);
	wrong[0] = (wrong[0] ?? 0) ^ 1;
	f.secrets.push(wrong);
	const handle = recovery(f);
	await refused(() => handle.adopt(wrong));
	await refused(() => handle.readCapsule());
	expect(readFileSync(filename(f)).equals(before)).toBe(true);
	expect((await handle.adopt(secret)) === undefined).toBe(true);
	expect(secret.equals(secretBefore)).toBe(true);
	expect((await handle.readCapsule()).equals(before)).toBe(true);
	await reopen(f);
	expect((await recovery(f).readCapsule()).equals(before)).toBe(true);
});

it("refuses a valid foreign-key capsule even when its recovery code is correct", async () => {
	const f = await fixture();
	const foreign = randomBytes(32);
	f.secrets.push(foreign);
	const secret = code(f);
	writeRecoveryFile(f.files.folder, foreign, secret);
	expect(sameStoreKey(f, secret)).toBe(false);
	const before = readFileSync(filename(f));
	const handle = recovery(f);
	await refused(() => handle.adopt(secret));
	await refused(() => handle.readCapsule());
	expect(readFileSync(filename(f)).equals(before)).toBe(true);
});

it("does not overwrite an enrollment when another code is supplied", async () => {
	const f = await fixture();
	const handle = recovery(f);
	const original = code(f);
	await handle.enroll(original);
	const before = await handle.readCapsule();
	await refused(() => handle.enroll(code(f)));
	expect((await handle.readCapsule()).equals(before)).toBe(true);
	expect(sameStoreKey(f, original)).toBe(true);
});

it("refuses altered enrolled bytes instead of returning an unverified capsule", async () => {
	const f = await fixture();
	const handle = recovery(f);
	await handle.enroll(code(f));
	const changed = readFileSync(filename(f));
	changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
	writeFileSync(filename(f), changed);
	await refused(() => handle.readCapsule());
});

it("refuses a missing enrolled capsule instead of recreating or blessing it", async () => {
	const f = await fixture();
	const handle = recovery(f);
	await handle.enroll(code(f));
	unlinkSync(filename(f));
	await refused(() => handle.readCapsule());
	expect(existsSync(filename(f))).toBe(false);
});

it("requires the original genuine session rather than copied or proxied public services", async () => {
	const f = await fixture();
	const subjects: unknown[] = [
		undefined,
		null,
		{},
		Object.create(null),
		{ ...f.session },
		Object.create(f.session),
		new Proxy(f.session, {}),
	];
	for (const subject of subjects) refusedNow(() => openNativeBackupRecovery(subject));
});

it("refuses reads when the original current key has been destroyed", async () => {
	const f = await fixture();
	const handle = recovery(f);
	await handle.enroll(code(f));
	f.currentKey.destroy();
	await refused(() => handle.readCapsule());
});

it("locks and closes recovery work without releasing its original session resources", async () => {
	const f = await fixture();
	const handle = recovery(f);
	await handle.enroll(code(f));
	handle.lock();
	expect(originalSessionOpen(f)).toBe(true);
	await refused(() => handle.readCapsule());
	await refused(() => handle.enroll(code(f)));
	await refused(() => handle.adopt(code(f)));
	expect((await handle.close()) === undefined).toBe(true);
	expect((await handle.close()) === undefined).toBe(true);
	expect(originalSessionOpen(f)).toBe(true);
	await refused(() => handle.readCapsule());
});

it("refuses new recovery work once its original session starts closing", async () => {
	const f = await fixture();
	const handle = recovery(f);
	await handle.enroll(code(f));
	const closing = f.session.close();
	refusedNow(() => openNativeBackupRecovery(f.session));
	await refused(() => handle.readCapsule());
	await closing;
	refusedNow(() => openNativeBackupRecovery(f.session));
	await refused(() => handle.enroll(code(f)));
	await refused(() => handle.adopt(code(f)));
});
