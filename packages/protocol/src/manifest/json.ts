import { types } from "node:util";
import { canonicalize, JCS_MAX_DEPTH, parseStrict } from "../jcs.ts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get as (this: Uint8Array) => number;

interface Bounds {
	readonly bytes: number;
	readonly nodes: number;
	readonly depth: number;
	readonly array: number;
	readonly string: number;
	readonly reserved: boolean;
	readonly message: string;
}
function boundedJson(input: unknown, bounds: Bounds): Json {
	let nodes = 0;
	let budget = 0;
	const encoder = new TextEncoder();
	const count = (text: string): void => {
		budget += encoder.encode(text).byteLength;
		if (budget > bounds.bytes) throw new Error(bounds.message);
	};
	const active = new Set<object>();
	function copy(value: unknown, depth: number): Json {
		if (++nodes > bounds.nodes || depth > bounds.depth) throw new Error(bounds.message);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.isWellFormed() && value.length <= bounds.string) {
			count(value);
			return value;
		}
		if (
			!value ||
			typeof value !== "object" ||
			types.isProxy(value) ||
			active.has(value) ||
			Object.getOwnPropertySymbols(value).length
		)
			throw new Error(bounds.message);
		const array = Array.isArray(value);
		if (array && value.length > bounds.array) throw new Error(bounds.message);
		if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
			throw new Error(bounds.message);
		if (Object.getOwnPropertyNames(value).length > bounds.nodes - nodes)
			throw new Error(bounds.message);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.values(descriptors).some((entry) => !("value" in entry)))
			throw new Error(bounds.message);
		active.add(value);
		try {
			if (array) {
				if (value.length > bounds.array || Object.keys(descriptors).length !== value.length + 1)
					throw new Error(bounds.message);
				return Array.from({ length: value.length }, (_, index) => {
					const descriptor = descriptors[String(index)];
					if (!descriptor?.enumerable) throw new Error(bounds.message);
					return copy(descriptor.value, depth + 1);
				});
			}
			const result: { [key: string]: Json } = Object.create(null);
			for (const [key, descriptor] of Object.entries(descriptors)) {
				if (
					!descriptor.enumerable ||
					!key.isWellFormed() ||
					key.length > 256 ||
					(bounds.reserved && ["__proto__", "constructor", "prototype"].includes(key))
				)
					throw new Error(bounds.message);
				count(key);
				result[key] = copy(descriptor.value, depth + 1);
			}
			return result;
		} finally {
			active.delete(value);
		}
	}
	if (input && typeof input === "object" && types.isProxy(input)) throw new Error(bounds.message);
	if (
		(typeof input === "string" &&
			(input.length > bounds.bytes || encoder.encode(input).byteLength > bounds.bytes)) ||
		(types.isUint8Array(input) && byteLength.call(input) > bounds.bytes)
	)
		throw new Error(bounds.message);
	const raw = typeof input === "string" || types.isUint8Array(input) ? parseStrict(input) : input;
	const result = copy(raw, 0);
	if (encoder.encode(canonicalize(result)).byteLength > bounds.bytes)
		throw new Error(bounds.message);
	return result;
}

/** JSON declarations only; fixed manifest bounds never expand for discovered surfaces. */
export function manifestJson(input: unknown): Json {
	return boundedJson(input, {
		bytes: 256 * 1024,
		nodes: 8192,
		depth: 16,
		array: 1024,
		string: 32768,
		reserved: true,
		message: "Manifest JSON refused",
	});
}
export const SURFACE_MAX_BYTES: number = 1024 * 1024;
export function surfaceJson(input: unknown): Json {
	try {
		return boundedJson(input, {
			bytes: SURFACE_MAX_BYTES,
			nodes: 65536,
			depth: JCS_MAX_DEPTH,
			array: 65536,
			string: SURFACE_MAX_BYTES,
			reserved: false,
			message: "Surface JSON refused",
		});
	} catch {
		throw new Error("Surface JSON refused");
	}
}
