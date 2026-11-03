import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { MasterKey } from "../kernel/master-key.ts";
import { captureRecoveryCapsule } from "./backup-capsule.ts";

export const RECOVERY_BINDING_SIZE = 69;
const HEADER = Buffer.from([0x44, 0x59, 0x52, 0x42, 1]);
const DOMAIN = "draftyak/recovery-capsule-binding/v1";
const DIGEST_AT = HEADER.length;
const MAC_AT = DIGEST_AT + 32;
const deriveKey = MasterKey.prototype.derive;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;

/** A fixed refusal with no capsule, key, path or underlying cause. */
export class RecoveryBindingError extends Error {
	override name = "RecoveryBindingError";
	readonly code = "binding";
	constructor() {
		super("Recovery binding refused");
	}
}

/** Captures owned DYRBv1 DATA; this does not authenticate its digest or MAC. */
export function captureRecoveryBinding(value: unknown): Buffer {
	let captured: Buffer | undefined;
	try {
		if (
			types.isProxy(value) ||
			!types.isUint8Array(value) ||
			byteLength?.call(value) !== RECOVERY_BINDING_SIZE
		)
			throw new RecoveryBindingError();
		const backing = bufferOf?.call(value);
		const offset = byteOffset?.call(value);
		if (
			!types.isArrayBuffer(backing) ||
			types.isSharedArrayBuffer(backing) ||
			!Number.isSafeInteger(offset) ||
			offset < 0
		)
			throw new RecoveryBindingError();
		captured = Buffer.from(new Uint8Array(backing, offset, RECOVERY_BINDING_SIZE));
		for (let index = 0; index < HEADER.length; index++)
			if (captured[index] !== HEADER[index]) throw new RecoveryBindingError();
		return captured;
	} catch {
		captured?.fill(0);
		throw new RecoveryBindingError();
	}
}

function keyBytes(masterKey: MasterKey): Buffer {
	if (types.isProxy(masterKey)) throw new RecoveryBindingError();
	return deriveKey.call(masterKey, "backup");
}

/**
 * Authenticates fixed-format capsule data under the supplied master key. This does not decrypt
 * the capsule or establish native session, store, device or approval authority.
 */
export function createRecoveryBinding(masterKey: MasterKey, capsule: unknown): Buffer {
	let captured: Buffer | undefined;
	let key: Buffer | undefined;
	let digest: Buffer | undefined;
	let mac: Buffer | undefined;
	let binding: Buffer | undefined;
	try {
		captured = captureRecoveryCapsule(capsule);
		key = keyBytes(masterKey);
		digest = createHash("sha256").update(captured).digest();
		binding = Buffer.alloc(RECOVERY_BINDING_SIZE);
		HEADER.copy(binding);
		digest.copy(binding, DIGEST_AT);
		mac = createHmac("sha256", key).update(DOMAIN).update(binding.subarray(0, MAC_AT)).digest();
		mac.copy(binding, MAC_AT);
		return binding;
	} catch {
		binding?.fill(0);
		throw new RecoveryBindingError();
	} finally {
		captured?.fill(0);
		key?.fill(0);
		digest?.fill(0);
		mac?.fill(0);
	}
}

/** Verifies serialized data only; malformed input and unavailable keys return false. */
export function verifyRecoveryBinding(
	masterKey: MasterKey,
	capsule: unknown,
	binding: unknown,
): boolean {
	let captured: Buffer | undefined;
	let encoded: Buffer | undefined;
	let key: Buffer | undefined;
	let digest: Buffer | undefined;
	let mac: Buffer | undefined;
	try {
		captured = captureRecoveryCapsule(capsule);
		encoded = captureRecoveryBinding(binding);
		key = keyBytes(masterKey);
		digest = createHash("sha256").update(captured).digest();
		mac = createHmac("sha256", key).update(DOMAIN).update(encoded.subarray(0, MAC_AT)).digest();
		const sameDigest = timingSafeEqual(digest, encoded.subarray(DIGEST_AT, MAC_AT));
		const sameMac = timingSafeEqual(mac, encoded.subarray(MAC_AT));
		return sameDigest && sameMac;
	} catch {
		return false;
	} finally {
		captured?.fill(0);
		encoded?.fill(0);
		key?.fill(0);
		digest?.fill(0);
		mac?.fill(0);
	}
}
