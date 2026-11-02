import { createDecipheriv, type DecipherGCM, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { readBoundedRegularFile } from "@draftyak/bounded-files";
import { MasterKey } from "../kernel/master-key.ts";
import { flushDirectory, flushFile, reserveExclusiveFile } from "../store/durable-file.ts";
import {
	captureRecoveryCapsule,
	RECOVERY_CAPSULE_V1,
	RECOVERY_FILE_SIZE,
	sealRecoveryCapsule,
} from "./backup-capsule.ts";

export { RECOVERY_FILE_SIZE } from "./backup-capsule.ts";

export type RecoveryErrorCode = "code" | "write" | "open";

/** Carries a fixed code only: never a path, code or key byte. */
export class RecoveryError extends Error {
	override name = "RecoveryError";
	readonly code: RecoveryErrorCode;
	constructor(code: RecoveryErrorCode) {
		super(`Recovery refused: ${code}`);
		this.code = code;
	}
}

type Reservation = ReturnType<typeof reserveExclusiveFile>;

export const RECOVERY_FILE = "mk.recovery";
const { codeBytes: CODE_BYTES, keyBytes: KEY_BYTES } = RECOVERY_CAPSULE_V1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_TEXT = /^(?:[A-Za-z2-7]{4}-){7}[A-Za-z2-7]{4}$|^[A-Za-z2-7]{32}$/;
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
const backingBuffer = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"buffer",
)?.get;
const copyBytes = Uint8Array.prototype.set;

function exactBytes(input: unknown, length: number, code: RecoveryErrorCode): Uint8Array {
	if (!types.isUint8Array(input) || byteLength?.call(input) !== length)
		throw new RecoveryError(code);
	return input;
}

function captureCode(input: unknown): Buffer {
	let captured: Buffer | undefined;
	try {
		const value = exactBytes(input, CODE_BYTES, "code");
		if (!backingBuffer || types.isSharedArrayBuffer(backingBuffer.call(value))) throw new Error();
		captured = Buffer.alloc(CODE_BYTES);
		copyBytes.call(captured, value);
		return captured;
	} catch {
		captured?.fill(0);
		throw new RecoveryError("code");
	}
}

// As the bounded reader requires: the folder names its own real path.
function canonicalFolder(folder: string): string {
	if (fs.realpathSync.native(folder) !== folder) throw new Error();
	return folder;
}

/** 160 bits from the system's secure random source. The caller shows them once and erases them. */
export function generateRecoveryCode(): Buffer {
	return randomBytes(CODE_BYTES);
}

/** The display form: 32 upper-case RFC 4648 base32 symbols in eight hyphenated groups of four. */
export function formatRecoveryCode(code: Uint8Array): string {
	const bytes = exactBytes(code, CODE_BYTES, "code");
	let text = "";
	for (let bit = 0; bit < CODE_BYTES * 8; bit += 5) {
		const pair = ((bytes[bit >> 3] ?? 0) << 8) | (bytes[(bit >> 3) + 1] ?? 0);
		if (bit > 0 && bit % 20 === 0) text += "-";
		text += ALPHABET.charAt((pair >> (11 - (bit & 7))) & 31);
	}
	return text;
}

/** Accepts the display form or its 32 symbols alone, in either case, and nothing else. */
export function parseRecoveryCode(text: string): Buffer {
	if (typeof text !== "string" || !CODE_TEXT.test(text)) throw new RecoveryError("code");
	const code = Buffer.alloc(CODE_BYTES);
	let value = 0;
	let bits = 0;
	let at = 0;
	for (const symbol of text.replaceAll("-", "").toUpperCase()) {
		value = ((value << 5) | ALPHABET.indexOf(symbol)) & 0xfff;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			code[at++] = (value >> bits) & 0xff;
		}
	}
	return code;
}

const sameFile = (a: Reservation, b: Reservation): boolean => a.dev === b.dev && a.ino === b.ino;

// An exclusive create on Windows follows a dangling link at the name, so no entry may exist.
function missing(filename: string): boolean {
	try {
		fs.lstatSync(filename);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

// Only the reservation itself, still empty, unshared and named without a link, takes the bytes.
function fill(filename: string, reserved: Reservation, file: Buffer): void {
	const descriptor = fs.openSync(filename, "r+");
	try {
		const info = fs.fstatSync(descriptor, { bigint: true });
		if (
			!sameFile(info, reserved) ||
			!sameFile(fs.lstatSync(filename, { bigint: true }), reserved) ||
			info.nlink !== 1n ||
			info.size !== 0n ||
			fs.writeSync(descriptor, file, 0, file.length, 0) !== file.length
		)
			throw new Error();
	} finally {
		fs.closeSync(descriptor);
	}
}

function release(filename: string, reserved: Reservation): void {
	try {
		if (sameFile(fs.lstatSync(filename, { bigint: true }), reserved)) fs.unlinkSync(filename);
	} catch {
		/* A missing or replaced file no longer authorizes removal. */
	}
}

/**
 * Creates `mk.recovery` once in the data folder, owner-only and flushed with its name. The caller
 * owns and erases both inputs. A failed call removes the file it created.
 */
export function writeRecoveryFile(folder: string, masterKey: Uint8Array, code: Uint8Array): void {
	const secret = exactBytes(code, CODE_BYTES, "code");
	let filename = "";
	let reserved: Reservation | undefined;
	try {
		const directory = canonicalFolder(folder);
		filename = path.join(directory, RECOVERY_FILE);
		const file = sealRecoveryCapsule(exactBytes(masterKey, KEY_BYTES, "write"), secret);
		if (!missing(filename)) throw new Error();
		reserved = reserveExclusiveFile(filename);
		fill(filename, reserved, file);
		flushFile(filename);
		flushDirectory(directory);
	} catch {
		if (reserved) release(filename, reserved);
		throw new RecoveryError("write");
	}
}

/**
 * The caller owns the returned key. A wrong code, a changed byte and a missing or unsafe file all
 * give the same refusal.
 */
export function openRecoveryFile(folder: string, code: Uint8Array): MasterKey {
	const secret = captureCode(code);
	try {
		const file = readBoundedRegularFile(path.join(canonicalFolder(folder), RECOVERY_FILE), {
			maximum: RECOVERY_FILE_SIZE,
			expectedSize: RECOVERY_FILE_SIZE,
		});
		return openRecoveryBytes(file, secret);
	} catch {
		throw new RecoveryError("open");
	} finally {
		secret.fill(0);
	}
}

/** Authenticates these exact captured bytes and returns only an opaque recovered key. */
export function openRecoveryBytes(capsule: unknown, code: unknown): MasterKey {
	const secret = captureCode(code);
	let file: Buffer | undefined;
	let key: Buffer | undefined;
	let plain: Buffer | undefined;
	let tail: Buffer | undefined;
	let decipher: DecipherGCM | undefined;
	let recovered: MasterKey | undefined;
	let failed = false;
	let cleanupFailed = false;
	try {
		file = captureRecoveryCapsule(capsule);
		const { saltAt, nonceAt, sealedAt, tagAt, tagBytes, wrappingInfo } = RECOVERY_CAPSULE_V1;
		key = Buffer.from(
			hkdfSync("sha256", secret, file.subarray(saltAt, nonceAt), wrappingInfo, KEY_BYTES),
		);
		decipher = createDecipheriv("aes-256-gcm", key, file.subarray(nonceAt, sealedAt), {
			authTagLength: tagBytes,
		});
		decipher.setAAD(file.subarray(0, saltAt));
		decipher.setAuthTag(file.subarray(tagAt, RECOVERY_FILE_SIZE));
		plain = decipher.update(file.subarray(sealedAt, tagAt));
		tail = decipher.final();
		if (plain.length !== KEY_BYTES || tail.length !== 0) throw new Error();
		recovered = new MasterKey(plain);
	} catch {
		failed = true;
	} finally {
		try {
			decipher?.destroy();
		} catch {
			cleanupFailed = true;
		} finally {
			secret.fill(0);
			file?.fill(0);
			key?.fill(0);
			plain?.fill(0);
			tail?.fill(0);
		}
	}
	if (failed || cleanupFailed || !recovered) {
		recovered?.destroy();
		throw new RecoveryError("open");
	}
	return recovered;
}
