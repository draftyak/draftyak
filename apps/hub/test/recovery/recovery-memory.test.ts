import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	generateRecoveryCode,
	openRecoveryFile,
	RECOVERY_FILE,
	RecoveryError,
	writeRecoveryFile,
} from "../../src/recovery/recovery-code.ts";

// The real native outputs, as the module received them, plus a copy taken at that moment.
const observed = vi.hoisted(() => ({
	random: [] as Buffer[],
	derived: [] as ArrayBuffer[],
	unwrapped: [] as { live: Buffer; copy: Buffer }[],
}));
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	const random = ((size: number) => {
		const bytes = actual.randomBytes(size);
		observed.random.push(bytes);
		return bytes;
	}) as typeof actual.randomBytes;
	const hkdfSync: typeof actual.hkdfSync = (...args) => {
		const key = actual.hkdfSync(...args);
		observed.derived.push(key);
		return key;
	};
	const createDecipheriv = ((...args: Parameters<typeof actual.createDecipheriv>) => {
		const decipher = actual.createDecipheriv(...args);
		for (const name of ["update", "final"] as const) {
			const method = decipher[name].bind(decipher) as (...input: unknown[]) => unknown;
			Object.defineProperty(decipher, name, {
				value: (...input: unknown[]) => {
					const output = method(...input);
					if (Buffer.isBuffer(output))
						observed.unwrapped.push({ live: output, copy: Buffer.from(output) });
					return output;
				},
			});
		}
		return decipher;
	}) as typeof actual.createDecipheriv;
	return { ...actual, randomBytes: random, hkdfSync, createDecipheriv };
});

const forget = (): void => {
	observed.random.length = 0;
	observed.derived.length = 0;
	observed.unwrapped.length = 0;
};
afterEach(forget);

const temporaryRoot = realpathSync.native(os.tmpdir());
function folder(): string {
	const dir = realpathSync.native(mkdtempSync(path.join(temporaryRoot, "draftyak-recovery-")));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
	return dir;
}
const erased = (bytes: ArrayBuffer | Uint8Array): boolean =>
	(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).every((byte) => byte === 0);

function expectErasedKey(): void {
	expect(observed.derived).toHaveLength(1);
	expect(observed.derived.every(erased)).toBe(true);
}

it("draws each code from the secure random source and leaves it with the caller", () => {
	forget();
	const code = generateRecoveryCode();
	expect(observed.random).toEqual([code]);
	expect(observed.random[0]).toBe(code);
	expect(erased(code)).toBe(false);
});

it("erases the wrapping key after writing, and leaves the caller's bytes as they were", () => {
	const dir = folder();
	const master = Buffer.alloc(32, 0x5a);
	const code = Buffer.alloc(20, 0xa5);
	forget();
	writeRecoveryFile(dir, master, code);
	expectErasedKey();
	expect(master).toEqual(Buffer.alloc(32, 0x5a));
	expect(code).toEqual(Buffer.alloc(20, 0xa5));
});

it("erases the wrapping key when the file can't be written", () => {
	const dir = folder();
	writeFileSync(path.join(dir, RECOVERY_FILE), "kept");
	const master = randomBytes(32);
	const code = generateRecoveryCode();
	forget();
	expect(() => writeRecoveryFile(dir, master, code)).toThrow(RecoveryError);
	expectErasedKey();
});

it("erases the wrapping key and the unwrapped master key after opening", () => {
	const dir = folder();
	const master = randomBytes(32);
	const code = generateRecoveryCode();
	writeRecoveryFile(dir, master, code);
	forget();
	const opened = openRecoveryFile(dir, code);
	expectErasedKey();
	expect(Buffer.concat(observed.unwrapped.map(({ copy }) => copy))).toEqual(master);
	expect(observed.unwrapped.every(({ live }) => erased(live))).toBe(true);
	const expected = new MasterKey(master);
	const [actual, wanted] = [opened.derive("db"), expected.derive("db")];
	expect(actual).toEqual(wanted);
	for (const key of [actual, wanted]) key.fill(0);
	opened.destroy();
	expected.destroy();
});

it.for(["a changed tag", "a wrong code"])("erases them when %s refuses the file", (reason) => {
	const dir = folder();
	const file = path.join(dir, RECOVERY_FILE);
	const master = randomBytes(32);
	const code = generateRecoveryCode();
	writeRecoveryFile(dir, master, code);
	const bytes = readFileSync(file);
	bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
	if (reason === "a changed tag") writeFileSync(file, bytes);
	const used = reason === "a wrong code" ? generateRecoveryCode() : code;
	forget();
	expect(() => openRecoveryFile(dir, used)).toThrow(RecoveryError);
	expectErasedKey();
	expect(observed.unwrapped.length).toBeGreaterThan(0);
	// With the right code, the master key itself was unwrapped before the tag check failed.
	if (reason === "a changed tag")
		expect(Buffer.concat(observed.unwrapped.map(({ copy }) => copy))).toEqual(master);
	expect(observed.unwrapped.every(({ live }) => erased(live))).toBe(true);
});
