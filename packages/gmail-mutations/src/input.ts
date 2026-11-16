import { types } from "node:util";
import { ProviderId } from "@draftyak/protocol/normalized-change";

export class GmailMutationError extends Error {
	override readonly name = "GmailMutationError";
	constructor() {
		super("Gmail mutation data refused");
	}
}

export function refuse(): never {
	throw new GmailMutationError();
}

/** Inspect own data descriptors, never caller accessors or coercion hooks. */
export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
		return refuse();
	if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse();
	const keys = Reflect.ownKeys(value);
	if (keys.length > allowed.length) return refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string" || !allowed.includes(key)) return refuse();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return refuse();
		result[key] = descriptor.value;
	}
	return result;
}

export function array<T>(value: unknown, max: number, read: (value: unknown) => T): T[] {
	if (types.isProxy(value) || !Array.isArray(value)) return refuse();
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > max) return refuse();
	if (Reflect.ownKeys(value).length !== length + 1) return refuse();
	const result: T[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return refuse();
		result.push(read(descriptor.value));
	}
	return result;
}

/** The finite path-atom subset also used by the merged Gmail wire fixture. */
export function gmailId(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 128 ||
		!ProviderId.safeParse(value).success ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	)
		return refuse();
	return value;
}

export function unique(values: readonly string[]): void {
	if (new Set(values).size !== values.length) refuse();
}
