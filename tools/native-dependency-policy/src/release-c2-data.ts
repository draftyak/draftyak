import { types } from "node:util";

export const C2_REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
export type C2Name = "glib" | "proc-macro-error" | "zvariant" | "zbus_names" | "zvariant_derive";
export const C2_CRATES: readonly (readonly [C2Name, string])[] = Object.freeze([
	Object.freeze(["glib", "gl/ib/glib"] as const),
	Object.freeze(["proc-macro-error", "pr/oc/proc-macro-error"] as const),
	Object.freeze(["zvariant", "zv/ar/zvariant"] as const),
	Object.freeze(["zbus_names", "zb/us/zbus_names"] as const),
	Object.freeze(["zvariant_derive", "zv/ar/zvariant_derive"] as const),
] as const);
export type C2Code = "C2_INVALID" | "C2_UNAVAILABLE" | "SOURCE_CHANGED" | "C2_EXPIRED";
export class C2Error extends Error {
	readonly code: C2Code;
	constructor(code: C2Code = "C2_INVALID") {
		super("release source refused");
		this.name = "C2Error";
		this.code = code;
	}
}
export function refuse(code: C2Code = "C2_INVALID"): never {
	throw new C2Error(code);
}
export type Data = Record<string, unknown>;

/** Snapshot before inspection, without invoking getters, traps or custom iterators. */
export function copyData(input: unknown): unknown {
	let nodes = 0,
		bytes = 0;
	const ancestors = new WeakSet<object>();
	function string(value: string): string {
		const length = Buffer.byteLength(value);
		bytes += length;
		if (length > 65_536 || bytes > 32 * 1024 * 1024) refuse();
		for (let i = 0; i < value.length; i++) {
			const code = value.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const low = value.charCodeAt(++i);
				if (!(low >= 0xdc00 && low <= 0xdfff)) refuse();
			} else if (code >= 0xdc00 && code <= 0xdfff) refuse();
		}
		return value;
	}
	function copy(value: unknown, depth: number): unknown {
		if (++nodes > 1_000_000) refuse();
		if (typeof value === "string") return string(value);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isSafeInteger(value)) return value;
		if (
			value === null ||
			typeof value !== "object" ||
			types.isProxy(value) ||
			ancestors.has(value) ||
			depth >= 64
		)
			refuse();
		ancestors.add(value);
		const array = Array.isArray(value);
		const proto = Object.getPrototypeOf(value);
		if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) refuse();
		const keys = Reflect.ownKeys(value);
		if (keys.some((key) => typeof key !== "string")) refuse();
		if (array) {
			const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
			if (
				typeof length !== "number" ||
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > 100_000 ||
				keys.length !== length + 1
			)
				refuse();
			const result: unknown[] = [];
			for (let i = 0; i < length; i++) {
				const d = Object.getOwnPropertyDescriptor(value, String(i));
				if (!d || !("value" in d) || !d.enumerable) refuse();
				result.push(copy(d.value, depth + 1));
			}
			ancestors.delete(value);
			return Object.freeze(result);
		}
		if (keys.length > 100_000) refuse();
		const result: Data = Object.create(null);
		for (const key of keys as string[]) {
			if (++nodes > 1_000_000) refuse();
			string(key);
			const d = Object.getOwnPropertyDescriptor(value, key);
			if (!d || !("value" in d) || !d.enumerable) refuse();
			result[key] = copy(d.value, depth + 1);
		}
		ancestors.delete(value);
		return Object.freeze(result);
	}
	return copy(input, 0);
}
export function record(value: unknown): Data {
	if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
	return value as Data;
}
export function object(value: unknown, keys: readonly string[]): Data {
	const result = record(value),
		actual = Object.keys(result);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) refuse();
	return result;
}
export function list(value: unknown, max: number = 100_000): unknown[] {
	if (!Array.isArray(value) || value.length > max) refuse();
	return value;
}
export function text(value: unknown): string {
	if (typeof value !== "string") refuse();
	return value;
}
export function checked(value: unknown, pattern: RegExp): string {
	const s = text(value);
	const match = pattern.exec(s);
	if (!match || match[0] !== s) refuse();
	return s;
}
export function integer(
	value: unknown,
	min: number = 0,
	max: number = Number.MAX_SAFE_INTEGER,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max ||
		Object.is(value, -0)
	)
		refuse();
	return value;
}
export function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") refuse();
	return value;
}
export const digest = (value: unknown): string => checked(value, /^[a-f0-9]{64}$/);
export const compare = (a: string, b: string): number =>
	Buffer.compare(Buffer.from(a), Buffer.from(b));
export function unique<T>(rows: T[], key: (value: T) => string): T[] {
	const items = rows.map((value) => ({ value, key: key(value) }));
	if (new Set(items.map((item) => item.key)).size !== rows.length) refuse();
	return items.sort((a, b) => compare(a.key, b.key)).map((item) => item.value);
}
export function name(value: unknown): string {
	return checked(value, /^[A-Za-z0-9][A-Za-z0-9_-]*$/);
}
export function version(value: unknown): string {
	const s = text(value);
	if (
		s.length > 128 ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/.test(
			s,
		)
	)
		refuse();
	return s;
}
export function requirement(value: unknown): string {
	const s = text(value);
	const p =
		"(?:[<>=~^]=? *)?(?:\\*|[0-9]+(?:\\.(?:[0-9]+|[xX*])){0,2}(?:-[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)*)?)";
	if (!new RegExp(`^${p}(?: *, *${p})*$(?![\\s\\S])`).test(s)) refuse();
	return s;
}
export function strings(value: unknown): readonly string[] {
	return Object.freeze(unique(list(value).map(featureText), (x) => x));
}
function featureText(value: unknown): string {
	const s = text(value);
	if (s.length === 0) refuse();
	for (const character of s) {
		const cp = character.codePointAt(0);
		if (cp === undefined || cp < 32 || cp === 127) refuse();
	}
	return s;
}
export type FeatureMap = Readonly<Record<string, readonly string[]>>;
export function features(value: unknown): FeatureMap {
	const row = record(value),
		result: Record<string, readonly string[]> = Object.create(null);
	for (const key of Object.keys(row).sort(compare)) {
		featureText(key);
		result[key] = strings(row[key]);
	}
	return Object.freeze(result);
}
