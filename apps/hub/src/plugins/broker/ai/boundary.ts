import { isProxy } from "node:util/types";
import { canonicalize } from "@draftyak/protocol/jcs";
import { refuse } from "./types.ts";

export const MAX_AI_REQUEST_BYTES = 8_388_608;

export function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || isProxy(value)) refuse();
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) refuse();
	return value as Record<string, unknown>;
}

export function fields(
	value: unknown,
	allowed: readonly string[],
	required: readonly string[] = allowed,
): Record<string, unknown> {
	const source = record(value);
	const own = Reflect.ownKeys(source);
	if (own.some((key) => typeof key !== "string" || !allowed.includes(key))) refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const name of own) {
		const descriptor = Object.getOwnPropertyDescriptor(source, name);
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
		result[name as string] = descriptor.value;
	}
	if (required.some((name) => !Object.hasOwn(result, name))) refuse();
	return result;
}

export function vector(value: unknown, maximum: number): unknown[] {
	if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		refuse();
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		!Number.isSafeInteger(length) ||
		length > maximum ||
		Reflect.ownKeys(value).length !== length + 1
	)
		refuse();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) refuse();
		result.push(descriptor.value);
	}
	return result;
}

export function text(value: unknown, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || !value.isWellFormed()) refuse();
	return value;
}

function copyByteRange(value: unknown, minimum: number, maximum: number): Uint8Array {
	if (
		isProxy(value) ||
		!(value instanceof Uint8Array) ||
		(Object.getPrototypeOf(value) !== Uint8Array.prototype &&
			Object.getPrototypeOf(value) !== Buffer.prototype)
	)
		refuse();
	const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
	const buffer = Object.getOwnPropertyDescriptor(prototype, "buffer")?.get?.call(
		value,
	) as ArrayBufferLike;
	const offset = Object.getOwnPropertyDescriptor(prototype, "byteOffset")?.get?.call(
		value,
	) as number;
	const length = Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get?.call(
		value,
	) as number;
	if (buffer instanceof SharedArrayBuffer || length < minimum || length > maximum) refuse();
	const output = new Uint8Array(length);
	// Read native typed-array slots, never a caller's iterator, constructor or accessor.
	Uint8Array.prototype.set.call(output, new Uint8Array(buffer, offset, length));
	return output;
}

export function copyBytes(value: unknown): Uint8Array {
	return copyByteRange(value, 1, MAX_AI_REQUEST_BYTES);
}

export function copyEmptyBytes(value: unknown): Uint8Array {
	return copyByteRange(value, 0, 0);
}

export function copyBoundedBytes(value: unknown, maximum: number): Uint8Array {
	return copyByteRange(value, 0, maximum);
}

export function exactBody(actual: unknown, expected: unknown): void {
	if (canonicalize(actual) !== canonicalize(expected)) refuse();
}
