import { types } from "node:util";
import { type ExtensionErrorCode, refuse } from "./errors.ts";

export const IDENTIFIER: RegExp = /^[a-z][a-z0-9-]{0,63}$/;

export const isIdentifier = (value: unknown): value is string =>
	typeof value === "string" && IDENTIFIER.exec(value)?.[0] === value;

/** Own enumerable string-keyed data properties of a plain or null-prototype object; no hooks run. */
export function ownData(
	value: unknown,
	maximum: number,
	code: ExtensionErrorCode,
): [string, unknown][] {
	if (value === null || typeof value !== "object" || types.isProxy(value)) refuse(code);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) refuse(code);
	const keys = Reflect.ownKeys(value);
	if (keys.length > maximum) refuse(code);
	return keys.map((key) => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			typeof key !== "string" ||
			!descriptor ||
			!("value" in descriptor) ||
			!descriptor.enumerable
		)
			refuse(code);
		return [key, descriptor.value];
	});
}

export function inertRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
	code: ExtensionErrorCode,
): Record<string, unknown> {
	const result = Object.create(null) as Record<string, unknown>;
	for (const [key, item] of ownData(value, required.length + optional.length, code)) {
		if (!required.includes(key) && !optional.includes(key)) refuse(code);
		result[key] = item;
	}
	for (const key of required) if (!Object.hasOwn(result, key)) refuse(code);
	return result;
}

/** A dense ordinary array copied element by element without invoking accessors. */
export function denseArray(value: unknown, maximum: number, code: ExtensionErrorCode): unknown[] {
	if (
		!Array.isArray(value) ||
		types.isProxy(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		refuse(code);
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		length > maximum ||
		Reflect.ownKeys(value).length !== length + 1
	)
		refuse(code);
	const items: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse(code);
		items.push(descriptor.value);
	}
	return items;
}

/** A data property found on the object or its own prototypes; accessors and proxies refuse. */
export function dataMember(target: object, key: string, code: ExtensionErrorCode): unknown {
	let current: object | null = target;
	for (let depth = 0; current !== null && current !== Object.prototype; depth++) {
		if (depth >= 8 || types.isProxy(current)) refuse(code);
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor) {
			if (!("value" in descriptor)) refuse(code);
			return descriptor.value;
		}
		current = Object.getPrototypeOf(current);
	}
	return undefined;
}

export const isPlainFunction = (value: unknown): value is (...args: unknown[]) => unknown =>
	typeof value === "function" && !types.isProxy(value);

const promiseThen = Promise.prototype.then;

/** Observes native rejections without reading a caller's own then property. */
export function isThenable(value: unknown): boolean {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
	if (types.isProxy(value)) return true;
	if (types.isPromise(value)) {
		promiseThen.call(value, undefined, () => undefined);
		return true;
	}
	let current: object | null = value;
	for (let depth = 0; current !== null; depth++) {
		if (depth >= 16 || types.isProxy(current) || Object.hasOwn(current, "then")) return true;
		current = Object.getPrototypeOf(current);
	}
	return false;
}

/** An independent deeply frozen copy; typed arrays stay copies owned by the receiver. */
export function frozenCopy<T>(value: T): T {
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object" || ArrayBuffer.isView(item)) return;
		for (const key of Reflect.ownKeys(item)) freeze((item as Record<PropertyKey, unknown>)[key]);
		Object.freeze(item);
	};
	const copy = structuredClone(value);
	freeze(copy);
	return copy;
}
