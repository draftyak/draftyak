import { type CipherGCM, createCipheriv, hkdfSync, randomBytes } from "node:crypto";
import { types } from "node:util";

// The legacy v1 header is fixed; the remaining bytes are opaque ciphertext data.
const HEADER = Buffer.concat([Buffer.from("draftyak-recovery"), Buffer.of(1)]);
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const SALT_AT = HEADER.length;
const NONCE_AT = SALT_AT + SALT_BYTES;
const SEALED_AT = NONCE_AT + NONCE_BYTES;
const TAG_AT = SEALED_AT + KEY_BYTES;
export const RECOVERY_FILE_SIZE: number = TAG_AT + TAG_BYTES;
export const RECOVERY_CAPSULE_V1: Readonly<{
	codeBytes: number;
	keyBytes: number;
	saltAt: number;
	nonceAt: number;
	sealedAt: number;
	tagAt: number;
	tagBytes: number;
	wrappingInfo: string;
}> = Object.freeze({
	codeBytes: 20,
	keyBytes: KEY_BYTES,
	saltAt: SALT_AT,
	nonceAt: NONCE_AT,
	sealedAt: SEALED_AT,
	tagAt: TAG_AT,
	tagBytes: TAG_BYTES,
	wrappingInfo: "draftyak/v1/recovery",
});
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const copyBytes = Uint8Array.prototype.set;

/** Carries no capsule bytes, recovery code, path or underlying error. */
export class BackupCapsuleError extends Error {
	override name = "BackupCapsuleError";
	readonly code = "format";
	constructor() {
		super("Recovery capsule refused");
	}
}

function captureBytes(value: unknown, length: number): Buffer {
	if (
		!types.isUint8Array(value) ||
		!byteLength ||
		!backingBuffer ||
		byteLength.call(value) !== length ||
		types.isSharedArrayBuffer(backingBuffer.call(value))
	)
		throw new BackupCapsuleError();
	const captured = Buffer.alloc(length);
	try {
		copyBytes.call(captured, value);
		return captured;
	} catch {
		captured.fill(0);
		throw new BackupCapsuleError();
	}
}

/**
 * Captures an owned legacy encrypted capsule. Shape validation does not prove
 * that its ciphertext is authentic or wraps any particular master key.
 */
export function captureRecoveryCapsule(value: unknown): Buffer {
	let captured: Buffer | undefined;
	try {
		// Intrinsics ignore caller accessors/iterators; validate only this snapshot.
		captured = captureBytes(value, RECOVERY_FILE_SIZE);
		for (let i = 0; i < HEADER.length; i++) {
			if (captured[i] !== HEADER[i]) throw new BackupCapsuleError();
		}
		return captured;
	} catch {
		captured?.fill(0);
		throw new BackupCapsuleError();
	}
}

/** Returns only the legacy encrypted capsule; all owned secret copies are erased. */
export function sealRecoveryCapsule(masterBytes: unknown, code: unknown): Buffer {
	const temporary: Buffer[] = [];
	let cipher: CipherGCM | undefined;
	let result: Buffer | undefined;
	let failed = false;
	let cleanupFailed = false;
	try {
		const master = captureBytes(masterBytes, KEY_BYTES);
		temporary.push(master);
		const secret = captureBytes(code, RECOVERY_CAPSULE_V1.codeBytes);
		temporary.push(secret);
		const salt = randomBytes(SALT_BYTES);
		temporary.push(salt);
		const nonce = randomBytes(NONCE_BYTES);
		temporary.push(nonce);
		const key = Buffer.from(
			hkdfSync("sha256", secret, salt, RECOVERY_CAPSULE_V1.wrappingInfo, KEY_BYTES),
		);
		temporary.push(key);
		cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
		cipher.setAAD(HEADER);
		const sealed = cipher.update(master);
		temporary.push(sealed);
		const tail = cipher.final();
		temporary.push(tail);
		const tag = cipher.getAuthTag();
		temporary.push(tag);
		result = Buffer.concat([HEADER, salt, nonce, sealed, tail, tag]);
	} catch {
		failed = true;
	} finally {
		try {
			cipher?.destroy();
		} catch {
			cleanupFailed = true;
		} finally {
			for (const bytes of temporary) bytes.fill(0);
		}
	}
	if (failed || cleanupFailed || !result) {
		result?.fill(0);
		throw new BackupCapsuleError();
	}
	return result;
}
