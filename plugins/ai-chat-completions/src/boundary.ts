import type { PluginErrorCode } from "@draftyak/protocol/errors";

export type CompatibleErrorCode =
	| "INVALID_CONFIG"
	| "INVALID_INPUT"
	| "INVALID_RESPONSE"
	| "ABORTED"
	| Extract<
			PluginErrorCode,
			"AUTH_REVOKED" | "PERMISSION_DENIED" | "RATE_LIMITED" | "QUOTA_EXCEEDED" | "TRANSIENT"
	  >;

export class CompatibleError extends Error {
	readonly code: CompatibleErrorCode;
	readonly retryAfterMs?: number;
	constructor(code: CompatibleErrorCode, retryAfterMs?: number) {
		super(code);
		this.name = "CompatibleError";
		this.code = code;
		if (retryAfterMs !== undefined && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0)
			this.retryAfterMs = retryAfterMs;
	}
}

export function fail(code: CompatibleErrorCode = "INVALID_INPUT"): never {
	throw new CompatibleError(code);
}

const errorCodes: readonly CompatibleErrorCode[] = [
	"INVALID_CONFIG",
	"INVALID_INPUT",
	"INVALID_RESPONSE",
	"ABORTED",
	"AUTH_REVOKED",
	"PERMISSION_DENIED",
	"RATE_LIMITED",
	"QUOTA_EXCEEDED",
	"TRANSIENT",
];

/** Copy only validated own data fields from a native local error; never inspect its message. */
export function transportError(error: unknown): CompatibleError {
	try {
		if (
			!error ||
			types.isProxy(error) ||
			!types.isNativeError(error) ||
			Object.getPrototypeOf(error) !== CompatibleError.prototype
		)
			return new CompatibleError("TRANSIENT");
		const code = Object.getOwnPropertyDescriptor(error, "code");
		const retry = Object.getOwnPropertyDescriptor(error, "retryAfterMs");
		if (!code || !("value" in code) || !errorCodes.includes(code.value))
			return new CompatibleError("TRANSIENT");
		if (
			retry &&
			(!("value" in retry) ||
				(retry.value !== undefined &&
					(typeof retry.value !== "number" ||
						!Number.isSafeInteger(retry.value) ||
						retry.value < 0)))
		)
			return new CompatibleError("TRANSIENT");
		return new CompatibleError(code.value, retry?.value);
	} catch {
		return new CompatibleError("TRANSIENT");
	}
}

export function data(value: unknown): Record<string, unknown> {
	try {
		if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) fail();
		const prototype: unknown = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) fail();
		const out: Record<string, unknown> = Object.create(null);
		const names = Reflect.ownKeys(value);
		if (names.length > 64) fail();
		for (const name of names) {
			if (typeof name !== "string") fail();
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
			out[name] = descriptor.value;
		}
		return out;
	} catch {
		return fail();
	}
}

/** Small native control lists only; never read an inherited index or array hook. */
export function array(value: unknown, maximum: number, minimum = 0): readonly unknown[] {
	if (
		!value ||
		types.isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		fail();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < minimum ||
		length > maximum
	)
		fail();
	const fields = Reflect.ownKeys(value);
	if (
		fields.length !== length + 1 ||
		fields.some(
			(key) =>
				typeof key !== "string" ||
				(key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)),
		)
	)
		fail();
	const copy: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
		Object.defineProperty(copy, index, { enumerable: true, value: descriptor.value });
	}
	return Object.freeze(copy);
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get as (
	this: Uint8Array,
) => number;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get as (
	this: Uint8Array,
) => ArrayBufferLike;
/** Bound/copy the actual view's slots, never a user-supplied length, buffer or iterator. */
export function bytes(value: unknown, maximum: number): Uint8Array {
	if (
		!value ||
		types.isProxy(value) ||
		!types.isUint8Array(value) ||
		![Uint8Array.prototype, Buffer.prototype].includes(Object.getPrototypeOf(value))
	)
		fail();
	const length = byteLength.call(value);
	if (length > maximum || types.isSharedArrayBuffer(backingBuffer.call(value))) fail();
	const copy = new Uint8Array(length);
	Uint8Array.prototype.set.call(copy, value);
	return copy;
}

export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((name) => !allowed.includes(name))) fail();
}

export function string(value: unknown, max: number): string {
	if (typeof value !== "string" || value.length > max || !value.isWellFormed()) fail();
	return value;
}

import { types } from "node:util";
