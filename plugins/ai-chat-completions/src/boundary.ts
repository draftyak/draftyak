export type CompatibleErrorCode =
	| "INVALID_CONFIG"
	| "INVALID_INPUT"
	| "INVALID_RESPONSE"
	| "ABORTED";

export class CompatibleError extends Error {
	readonly code: CompatibleErrorCode;
	constructor(code: CompatibleErrorCode) {
		super(code);
		this.name = "CompatibleError";
		this.code = code;
	}
}

export function fail(code: CompatibleErrorCode = "INVALID_INPUT"): never {
	throw new CompatibleError(code);
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
