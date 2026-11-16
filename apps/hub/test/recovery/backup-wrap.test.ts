import { randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { BackupCapsuleError, RECOVERY_FILE_SIZE } from "../../src/recovery/backup-capsule.ts";
import {
	openRecoveryBytes,
	openRecoveryFile,
	RECOVERY_FILE,
	RecoveryError,
} from "../../src/recovery/recovery-code.ts";

const keys: MasterKey[] = [];
const buffers: Buffer[] = [];
const derive = MasterKey.prototype.derive;
const wrap = MasterKey.prototype.wrapRecovery;
const bytes = (size: number): Buffer => {
	const value = randomBytes(size);
	buffers.push(value);
	return value;
};
const own = (key: MasterKey): MasterKey => {
	keys.push(key);
	return key;
};
afterEach(() => {
	for (const key of keys.splice(0)) key.destroy();
	for (const value of buffers.splice(0)) value.fill(0);
});
function sameKey(first: MasterKey, second: MasterKey): void {
	for (const purpose of ["db", "audit", "backup"] as const) {
		const a = derive.call(first, purpose),
			b = derive.call(second, purpose);
		try {
			expect(a.equals(b)).toBe(true);
		} finally {
			a.fill(0);
			b.fill(0);
		}
	}
}
function refused(action: () => unknown): void {
	let error: unknown;
	try {
		action();
	} catch (caught) {
		error = caught;
	}
	expect(error instanceof BackupCapsuleError).toBe(true);
	expect(error instanceof BackupCapsuleError && error.code === "format").toBe(true);
	expect(error instanceof Error && error.message === "Recovery capsule refused").toBe(true);
	expect(error instanceof Error && !Object.hasOwn(error, "cause")).toBe(true);
}

it("wraps an ordinary opaque master key in fresh legacy capsules readable by both openers", () => {
	const master = bytes(32),
		code = bytes(20);
	const savedMaster = Buffer.from(master),
		savedCode = Buffer.from(code);
	buffers.push(savedMaster, savedCode);
	const original = own(new MasterKey(master));
	const first = original.wrapRecovery(code),
		second = original.wrapRecovery(code);
	expect(RECOVERY_FILE_SIZE).toBe(94);
	expect(first.length).toBe(94);
	const header = Buffer.concat([Buffer.from("draftyak-recovery"), Buffer.of(1)]);
	expect(first.subarray(0, 18).equals(header)).toBe(true);
	expect(first.equals(second)).toBe(false);
	expect(master.equals(savedMaster) && code.equals(savedCode)).toBe(true);
	sameKey(original, own(openRecoveryBytes(first, code)));
	const temporary = realpathSync.native(os.tmpdir());
	const folder = realpathSync.native(mkdtempSync(path.join(temporary, "draftyak-backup-wrap-")));
	const born = lstatSync(folder);
	onTestFinished(() => {
		const current = lstatSync(folder);
		if (
			path.dirname(folder) !== temporary ||
			!path.basename(folder).startsWith("draftyak-backup-wrap-") ||
			current.ino !== born.ino ||
			current.dev !== born.dev ||
			current.isSymbolicLink()
		)
			throw new Error("Unowned backup wrap fixture");
		rmSync(folder, { recursive: true, force: false });
	});
	writeFileSync(path.join(folder, RECOVERY_FILE), first, { flag: "wx", mode: 0o600 });
	sameKey(original, own(openRecoveryFile(folder, code)));
	sameKey(original, own(new MasterKey(savedMaster)));
});

it("refuses wrong recovery codes and changed capsule regions", () => {
	const key = own(new MasterKey(bytes(32))),
		code = bytes(20);
	const capsule = key.wrapRecovery(code);
	for (const at of [0, 17, 18, 34, 46, 93]) {
		const changed = Buffer.from(capsule);
		changed[at] = (changed[at] ?? 0) ^ 1;
		expect(() => openRecoveryBytes(changed, code)).toThrow(RecoveryError);
	}
	expect(() => openRecoveryBytes(capsule, bytes(20))).toThrow(RecoveryError);
	sameKey(key, own(openRecoveryBytes(capsule, code)));
});

it("refuses invalid code shapes without changing the living key", () => {
	const master = bytes(32),
		key = own(new MasterKey(master));
	const inputs: unknown[] = [
		undefined,
		null,
		"code",
		bytes(19),
		bytes(21),
		new Uint8Array(new SharedArrayBuffer(20)),
		new Proxy(bytes(20), {}),
	];
	for (const code of inputs) refused(() => key.wrapRecovery(code));
	sameKey(key, own(new MasterKey(master)));
});

it("refuses destroyed, forged and proxied receivers without evaluating traps", () => {
	const key = own(new MasterKey(bytes(32))),
		code = bytes(20);
	let traps = 0;
	const proxy = new Proxy(key, {
		get() {
			traps++;
			throw new Error("Unexpected key trap");
		},
	});
	for (const receiver of [Object.create(MasterKey.prototype), proxy, {}, null])
		refused(() => Reflect.apply(wrap, receiver, [code]));
	expect(traps).toBe(0);
	key.destroy();
	refused(() => key.wrapRecovery(code));
	expect(() => key.derive("backup")).toThrow("Hub is locked");
});

it("uses private key bytes rather than caller shadows or an overridden derive method", () => {
	const key = own(new MasterKey(bytes(32))),
		code = bytes(20);
	let reads = 0;
	const unexpected = (): never => {
		reads++;
		throw new Error("Unexpected key shadow");
	};
	Object.defineProperty(key, "bytes", { get: unexpected });
	Object.defineProperty(key, "derive", { value: unexpected });
	const capsule = Reflect.apply(wrap, key, [code]);
	sameKey(key, own(openRecoveryBytes(capsule, code)));
	expect(reads).toBe(0);
});
