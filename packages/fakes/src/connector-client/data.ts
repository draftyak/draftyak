import { types } from "node:util";

export const MAX_CONNECTOR_RESPONSE_BYTES: number = 64 * 1024;
export const CONNECTOR_DEADLINE_MS = 10_000;

export class ConnectorClientError extends Error {
	constructor() {
		super("Connector fixture refused");
		this.name = "ConnectorClientError";
	}
}

export function refused(): never {
	throw new ConnectorClientError();
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;

export function copyChunk(value: unknown, remaining: number): Uint8Array {
	if (
		types.isProxy(value) ||
		!types.isUint8Array(value) ||
		!byteLength ||
		!byteOffset ||
		!arrayBuffer
	)
		refused();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) refused();
	const length: number = Reflect.apply(byteLength, value, []);
	const buffer: ArrayBufferLike = Reflect.apply(arrayBuffer, value, []);
	if (types.isSharedArrayBuffer(buffer) || length > remaining) refused();
	const offset: number = Reflect.apply(byteOffset, value, []);
	const copied = new Uint8Array(length);
	copied.set(new Uint8Array(buffer, offset, length));
	return copied;
}

export function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || types.isProxy(value)) refused();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) refused();
	const names = Reflect.ownKeys(value);
	if (
		names.length !== keys.length ||
		names.some((name) => typeof name !== "string" || !keys.includes(name))
	)
		refused();
	const result = Object.create(null) as Record<string, unknown>;
	for (const name of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refused();
		result[name] = descriptor.value;
	}
	return result;
}

export function optionData(
	value: unknown,
	required: readonly string[],
	optional: readonly string[],
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || types.isProxy(value)) refused();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== null && prototype !== Object.prototype) refused();
	const names = Reflect.ownKeys(value);
	if (
		names.some((name) => typeof name !== "string" || ![...required, ...optional].includes(name)) ||
		required.some((name) => !names.includes(name))
	)
		refused();
	return data(value, names as string[]);
}

export function text(value: unknown, maximum = 2048): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		!value.isWellFormed()
	)
		refused();
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x20 || code === 0x7f) refused();
	}
	return value;
}

export function syntheticUrl(value: unknown, origin?: string): string {
	const raw = text(value);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return refused();
	}
	if (
		parsed.protocol !== "https:" ||
		!parsed.hostname.endsWith(".example") ||
		parsed.hostname.length > 253 ||
		parsed.hostname
			.split(".")
			.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
		parsed.port !== "" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		raw.includes("?") ||
		raw.includes("#") ||
		parsed.href !== raw ||
		!/^\/[A-Za-z0-9._~/-]*$/u.test(parsed.pathname) ||
		parsed.pathname.includes("//") ||
		parsed.pathname.split("/").some((part) => part === "." || part === "..") ||
		(origin !== undefined && parsed.origin !== origin)
	)
		refused();
	return raw;
}

// The input is already byte-bounded. Parse a small JSON grammar to reject duplicate
// members, oversized structures and deep unknown extensions before materializing them.
export function jsonObject(raw: string): Readonly<Record<string, unknown>> {
	let at = 0,
		nodes = 0;
	const whitespace = (): void => {
		while (/[\t\r\n ]/u.test(raw[at] ?? "x")) at += 1;
	};
	function string(): string {
		const start = at++;
		let escaped = false;
		for (; at < raw.length; at += 1) {
			const char = raw[at];
			if (char === '"' && !escaped) {
				at += 1;
				let value: unknown;
				try {
					value = JSON.parse(raw.slice(start, at));
				} catch {
					return refused();
				}
				if (typeof value !== "string" || !value.isWellFormed()) refused();
				return value;
			}
			escaped = char === "\\" && !escaped;
		}
		return refused();
	}
	function value(depth: number): unknown {
		if (++nodes > 2048 || depth > 16) refused();
		whitespace();
		const char = raw[at];
		if (char === '"') return string();
		if (char === "{" || char === "[") {
			at += 1;
			whitespace();
			const object = Object.create(null) as Record<string, unknown>;
			const array: unknown[] = [],
				keys = new Set<string>();
			const end = char === "{" ? "}" : "]";
			if (raw[at] !== end)
				for (;;) {
					if (char === "{") {
						if (raw[at] !== '"') refused();
						const key = string();
						if (keys.has(key)) refused();
						keys.add(key);
						whitespace();
						if (raw[at++] !== ":") refused();
						object[key] = value(depth + 1);
					} else array.push(value(depth + 1));
					whitespace();
					if (raw[at] === end) break;
					if (raw[at++] !== ",") refused();
					whitespace();
				}
			at += 1;
			return Object.freeze(char === "{" ? object : array);
		}
		const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
			raw.slice(at),
		)?.[0];
		if (token === undefined) refused();
		at += token.length;
		const parsed: unknown = JSON.parse(token);
		if (typeof parsed === "number" && !Number.isFinite(parsed)) refused();
		return parsed;
	}
	const parsed = value(0);
	whitespace();
	if (at !== raw.length || typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		refused();
	return parsed as Readonly<Record<string, unknown>>;
}
