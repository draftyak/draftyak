import { types } from "node:util";
import { captureRecoveryBinding } from "./backup-bindings.ts";
import { captureRecoveryCapsule } from "./backup-capsule.ts";

export const BACKUP_ARTIFACT_HEADER_SIZE: number = 208;
const MAGIC = Buffer.from([0x44, 0x59, 0x42, 0x41, 1]);
const LENGTH_AT = 5;
const DIGEST_AT = 13;
const CAPSULE_AT = 45;
const BINDING_AT = 139;
const MAX_LENGTH = BigInt(Number.MAX_SAFE_INTEGER);
const SHA256 = /^[0-9a-f]{64}$/;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;

export interface BackupArtifactHeader {
	readonly capsule: Buffer;
	readonly binding: Buffer;
	readonly byteLength: number;
	readonly sha256: string;
}

/** Fixed DATA refusal, with no key, path, input bytes or underlying cause. */
export class BackupArtifactError extends Error {
	readonly code = "BACKUP_ARTIFACT_UNAVAILABLE";
	constructor() {
		super("Backup artifact unavailable");
		this.name = "BackupArtifactError";
	}
}

function captureHeader(value: unknown): Buffer {
	if (
		types.isProxy(value) ||
		!types.isUint8Array(value) ||
		byteLength?.call(value) !== BACKUP_ARTIFACT_HEADER_SIZE
	)
		throw new BackupArtifactError();
	const backing = backingBuffer?.call(value);
	const offset = byteOffset?.call(value);
	if (
		!types.isArrayBuffer(backing) ||
		types.isSharedArrayBuffer(backing) ||
		!Number.isSafeInteger(offset) ||
		offset < 0
	)
		throw new BackupArtifactError();
	return Buffer.from(new Uint8Array(backing, offset, BACKUP_ARTIFACT_HEADER_SIZE));
}

/** Encodes DATA framing only; it grants no native read, export, key or restore authority. */
export function encodeBackupArtifactHeader(
	capsule: unknown,
	binding: unknown,
	byteLength: unknown,
	sha256: unknown,
): Buffer {
	let capturedCapsule: Buffer | undefined;
	let capturedBinding: Buffer | undefined;
	let digest: Buffer | undefined;
	let encoded: Buffer | undefined;
	try {
		capturedCapsule = captureRecoveryCapsule(capsule);
		capturedBinding = captureRecoveryBinding(binding);
		if (
			typeof byteLength !== "number" ||
			!Number.isSafeInteger(byteLength) ||
			byteLength <= 0 ||
			typeof sha256 !== "string" ||
			sha256.length !== 64 ||
			!SHA256.test(sha256)
		)
			throw new BackupArtifactError();
		digest = Buffer.from(sha256, "hex");
		encoded = Buffer.alloc(BACKUP_ARTIFACT_HEADER_SIZE);
		MAGIC.copy(encoded);
		encoded.writeBigUInt64BE(BigInt(byteLength), LENGTH_AT);
		digest.copy(encoded, DIGEST_AT);
		capturedCapsule.copy(encoded, CAPSULE_AT);
		capturedBinding.copy(encoded, BINDING_AT);
		return encoded;
	} catch {
		encoded?.fill(0);
		throw new BackupArtifactError();
	} finally {
		capturedCapsule?.fill(0);
		capturedBinding?.fill(0);
		digest?.fill(0);
	}
}

/** Decodes an owned snapshot. Its digest and binding remain unauthenticated DATA. */
export function decodeBackupArtifactHeader(value: unknown): BackupArtifactHeader {
	let encoded: Buffer | undefined;
	let capsule: Buffer | undefined;
	let binding: Buffer | undefined;
	let complete = false;
	try {
		encoded = captureHeader(value);
		for (let index = 0; index < MAGIC.length; index++)
			if (encoded[index] !== MAGIC[index]) throw new BackupArtifactError();
		const length = encoded.readBigUInt64BE(LENGTH_AT);
		if (length === 0n || length > MAX_LENGTH) throw new BackupArtifactError();
		capsule = captureRecoveryCapsule(encoded.subarray(CAPSULE_AT, BINDING_AT));
		binding = captureRecoveryBinding(encoded.subarray(BINDING_AT));
		const result = Object.freeze({
			capsule,
			binding,
			byteLength: Number(length),
			sha256: encoded.subarray(DIGEST_AT, CAPSULE_AT).toString("hex"),
		});
		complete = true;
		return result;
	} catch {
		throw new BackupArtifactError();
	} finally {
		encoded?.fill(0);
		if (!complete) {
			capsule?.fill(0);
			binding?.fill(0);
		}
	}
}
