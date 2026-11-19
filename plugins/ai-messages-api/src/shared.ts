import { isProxy } from "node:util/types";

export type MessagesErrorCode = "INVALID_INPUT" | "INVALID_RESPONSE";

export class MessagesError extends Error {
	readonly code: MessagesErrorCode;

	constructor(code: MessagesErrorCode) {
		super(code);
		this.name = "MessagesError";
		this.code = code;
	}
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const isModel = (value: unknown): value is string =>
	typeof value === "string" && /^claude-[a-z0-9.-]{1,64}$/.test(value);

export function boundedText(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length <= maximum * 2 &&
		value.isWellFormed() &&
		[...value].length <= maximum
	);
}

// Snapshot before validation so only the validated values reach reconstruction.
export function snapshotRequestData<T>(source: T): T {
	let nodes = 16_384;
	let units = 2_300_000; // The allowed prompt/system maxima plus the fixed schema.
	function refuse(): never {
		throw new MessagesError("INVALID_INPUT");
	}
	const text = (value: string): string => {
		units -= value.length;
		if (units < 0) refuse();
		return value;
	};
	const copy = (value: unknown, depth: number): unknown => {
		if (--nodes < 0 || depth > 64 || isProxy(value)) refuse();
		if (typeof value === "string") return text(value);
		if (value === null || value === undefined || typeof value === "boolean") return value;
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "object") return refuse();
		const prototype = Object.getPrototypeOf(value);
		if (prototype === Headers.prototype) {
			const headers: Record<string, string> = {};
			for (const [name, content] of Headers.prototype.entries.call(value)) {
				if (--nodes < 0 || name === "__proto__") refuse();
				headers[text(name)] = text(content);
			}
			return headers;
		}
		const array = Array.isArray(value);
		if (
			prototype !== (array ? Array.prototype : Object.prototype) &&
			!(prototype === null && !array)
		)
			refuse();
		const keys = Reflect.ownKeys(value);
		if (keys.length > nodes) refuse();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (array) {
			const length = descriptors.length?.value;
			if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) refuse();
			return Array.from({ length }, (_, index) => {
				const descriptor = descriptors[String(index)];
				if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
				return copy(descriptor.value, depth + 1);
			});
		}
		const record: Record<string, unknown> = {};
		for (const key of keys) {
			if (typeof key !== "string" || key === "__proto__") refuse();
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
			record[text(key)] = copy(descriptor.value, depth + 1);
		}
		return record;
	};
	return copy(source, 0) as T;
}
