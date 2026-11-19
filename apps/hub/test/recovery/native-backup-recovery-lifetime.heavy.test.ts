import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admitDataFolder, type DataFolder } from "../../src/kernel/data-directory.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import { StartupRefusal } from "../../src/lifecycle/preflight.ts";
import {
	type NativeBackupRecovery,
	openNativeBackupRecovery,
} from "../../src/recovery/backup-recovery.ts";
import { generateRecoveryCode, RECOVERY_FILE } from "../../src/recovery/recovery-code.ts";
import {
	expectErased,
	expectUsable,
	nativeBinding,
	refusal,
	type SessionFixture,
	sessionFixture,
} from "../lifecycle/session-helpers.ts";

interface ObservedHandle {
	readonly handle: FileHandle;
	readonly close: () => Promise<void>;
	readonly stat: () => ReturnType<FileHandle["stat"]>;
}
const actualOpen = fs.open;
let files: SessionFixture[];
let handles: ObservedHandle[];
let pending: Promise<unknown>[];
let releases: (() => void)[];
let secrets: Buffer[];

beforeEach(() => {
	files = [];
	handles = [];
	pending = [];
	releases = [];
	secrets = [];
});
afterEach(async () => {
	for (const release of releases) release();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	await Promise.allSettled(pending);
	const closed = await Promise.allSettled(files.map((fixture) => fixture.remove()));
	for (const secret of secrets) secret.fill(0);
	expect(closed.every((result) => result.status === "fulfilled")).toBe(true);
});

async function fixture() {
	const file = sessionFixture("draftyak-recovery-lifetime-");
	files.push(file);
	const key = file.key();
	const session = await file.open({ masterKey: key });
	const recovery = openNativeBackupRecovery(session);
	return { file, key, session, recovery, filename: path.join(file.folder, RECOVERY_FILE) };
}

function code(): Buffer {
	const value = generateRecoveryCode();
	secrets.push(value);
	return value;
}

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.push(release);
	return { promise, release };
}

function track<T>(promise: Promise<T>): Promise<T> {
	pending.push(promise);
	void promise.catch(() => undefined);
	return promise;
}

function observe(configure: (observed: ObservedHandle) => void): void {
	vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await actualOpen(...args);
		if (typeof args[0] === "string" && path.basename(args[0]) === RECOVERY_FILE) {
			const observed = { handle, close: handle.close.bind(handle), stat: () => handle.stat() };
			handles.push(observed);
			configure(observed);
		}
		return handle;
	});
	syncBuiltinESMExports();
}

function lastHandle(): ObservedHandle {
	const handle = handles.at(-1);
	if (!handle) throw new Error("Recovery lifetime did not observe a file handle");
	return handle;
}

async function recoveryRefusal(operation: Promise<unknown>): Promise<void> {
	const error = await operation.then(
		() => null,
		(reason: unknown) => reason,
	);
	expect(error instanceof Error && "code" in error && error.code === "RECOVERY_UNAVAILABLE").toBe(
		true,
	);
	expect(error instanceof Error && !("cause" in error)).toBe(true);
}

function admissionHeld(folder: string): void {
	let admitted: DataFolder | undefined, error: unknown;
	try {
		admitted = admitDataFolder(folder, { nativeBinding });
	} catch (reason) {
		error = reason;
	} finally {
		admitted?.release();
	}
	expect(error instanceof StartupRefusal && error.code === "DATA_DIR_LOCKED").toBe(true);
}

function admissionReleased(folder: string): void {
	const admitted = admitDataFolder(folder, { nativeBinding });
	try {
		expect(() => admitted.assertHeld()).not.toThrow();
	} finally {
		admitted.release();
	}
}

async function successorBlocked(file: SessionFixture): Promise<void> {
	const offered = file.key();
	expect((await refusal(file.open({ masterKey: offered }))).code === "SESSION_ACTIVE").toBe(true);
	expectErased(offered);
}

function pauseHandle(stage: "write" | "sync" | "close") {
	const entered = gate(),
		resume = gate();
	observe((original) => {
		if (stage === "write") {
			const write = original.handle.write;
			vi.spyOn(original.handle, "write").mockImplementationOnce((async (...args: unknown[]) => {
				entered.release();
				await resume.promise;
				return Reflect.apply(write, original.handle, args);
			}) as FileHandle["write"]);
		} else {
			const operation =
				stage === "sync" ? original.handle.sync.bind(original.handle) : original.close;
			vi.spyOn(original.handle, stage).mockImplementationOnce(async () => {
				entered.release();
				await resume.promise;
				return operation();
			});
		}
	});
	return { entered: entered.promise, release: resume.release };
}

it.each(["write", "sync", "close"] as const)(
	"original Session close joins genuine enrollment's pending file %s and final cleanup",
	async (stage) => {
		const f = await fixture(),
			pause = pauseHandle(stage);
		const enrolling = track(f.recovery.enroll(code()));
		await Promise.race([pause.entered, enrolling]);
		const original = lastHandle();
		expect((await original.stat()).isFile()).toBe(true);
		const closing = track(f.session.close());
		let closed = false;
		void closing.then(
			() => {
				closed = true;
			},
			() => {
				closed = true;
			},
		);
		let factoryError: unknown;
		try {
			openNativeBackupRecovery(f.session);
		} catch (error) {
			factoryError = error;
		}
		expect(
			factoryError instanceof Error &&
				"code" in factoryError &&
				factoryError.code === "RECOVERY_UNAVAILABLE",
		).toBe(true);
		await recoveryRefusal(f.recovery.readCapsule());
		expect(closed).toBe(false);
		expectUsable(f.key);
		expect(
			f.session.store.read((db) => db.get<{ alive: number }>("SELECT 1 AS alive"))?.alive === 1,
		).toBe(true);
		admissionHeld(f.file.folder);
		await successorBlocked(f.file);
		expect(closed).toBe(false);
		expectUsable(f.key);
		expect((await original.stat()).isFile()).toBe(true);
		pause.release();
		await recoveryRefusal(enrolling);
		await closing;
		expectErased(f.key);
		expect(existsSync(f.filename)).toBe(false);
		await expect(original.stat()).rejects.toMatchObject({ code: "EBADF" });
		expect(() => f.session.store.read((db) => db.get("SELECT 1"))).toThrow("unavailable");
		admissionReleased(f.file.folder);
	},
);

it("retains actual cleanup after failed close and retires it before a successor can adopt a capsule", async () => {
	const f = await fixture();
	let blocked = true;
	releases.push(() => {
		blocked = false;
	});
	observe((original) => {
		vi.spyOn(original.handle, "close").mockImplementation(async () => {
			if (blocked) throw new Error("DYTEST recovery physical close fault");
			await original.close();
		});
	});
	await recoveryRefusal(track(f.recovery.enroll(code())));
	const original = lastHandle();
	expect((await original.stat()).size === 94).toBe(true);
	expect(
		f.session.store.read((db) => {
			f.session.audit.verify(db);
			return true;
		}),
	).toBe(true);
	expect((await refusal(track(f.session.close()))).code === "CLOSE_INCOMPLETE").toBe(true);
	expectErased(f.key);
	expect((await original.stat()).size === 94).toBe(true);
	expect(
		f.session.store.read((db) => db.get<{ alive: number }>("SELECT 1 AS alive"))?.alive === 1,
	).toBe(true);
	let auditLocked = false;
	try {
		f.session.store.read((db) => f.session.audit.verify(db));
	} catch (error) {
		auditLocked =
			error instanceof Error && error.message === "Audit is locked" && !("cause" in error);
	}
	expect(auditLocked).toBe(true);
	admissionHeld(f.file.folder);
	await successorBlocked(f.file);
	blocked = false;
	// Cleanup completes with the original key already erased, before any successor key exists.
	await f.session.close();
	expectErased(f.key);
	await expect(original.stat()).rejects.toMatchObject({ code: "EBADF" });
	expect(existsSync(f.filename)).toBe(false);
	expect(() => f.session.store.read((db) => db.get("SELECT 1"))).toThrow("unavailable");
	admissionReleased(f.file.folder);
	const nextKey: MasterKey = f.file.key();
	const nextSession = await f.file.open({ masterKey: nextKey });
	const next: NativeBackupRecovery = openNativeBackupRecovery(nextSession),
		secret = code();
	const capsule = nextKey.wrapRecovery(secret);
	secrets.push(capsule);
	writeFileSync(f.filename, capsule, { flag: "wx", mode: 0o600 });
	await next.adopt(secret);
	const before = await next.readCapsule();
	secrets.push(before);
	await f.recovery.close();
	await f.session.close();
	expect((await next.readCapsule()).equals(before)).toBe(true);
	expect(readFileSync(f.filename).equals(before)).toBe(true);
});
