import { createHash } from "node:crypto";
import { types } from "node:util";

export const MAX_TEXT_CONTENT_BYTES = 1_048_576;
export type TextField = "name" | "title" | "body" | "description";
export type TextBinding =
	| Readonly<{ state: "missing" }>
	| Readonly<{ state: "null" }>
	| Readonly<{ state: "string"; bytes: number; sha256: string }>;

export class TextContentBindingError extends Error {
	readonly code = "TEXT_CONTENT_INVALID";
	constructor() {
		super("text content binding refused");
		this.name = "TextContentBindingError";
	}
}

function refuse(): never {
	throw new TextContentBindingError();
}

/** Projects one own field without returning its content or evaluating accessors. */
export function projectOwnTextField(record: unknown, field: TextField): TextBinding {
	if (
		!["name", "title", "body", "description"].includes(field) ||
		typeof record !== "object" ||
		record === null ||
		types.isProxy(record) ||
		Array.isArray(record)
	)
		return refuse();
	if (![null, Object.prototype].includes(Object.getPrototypeOf(record))) return refuse();
	const descriptor = Object.getOwnPropertyDescriptor(record, field);
	if (descriptor === undefined) return Object.freeze({ state: "missing" });
	if (!Object.hasOwn(descriptor, "value")) return refuse();
	if (descriptor.value === null) return Object.freeze({ state: "null" });
	if (typeof descriptor.value !== "string") return refuse();
	const text = descriptor.value;
	if (text.length > MAX_TEXT_CONTENT_BYTES || !text.isWellFormed()) return refuse();
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_TEXT_CONTENT_BYTES) return refuse();
	return Object.freeze({
		state: "string",
		bytes,
		sha256: createHash("sha256").update(text, "utf8").digest("hex"),
	});
}
