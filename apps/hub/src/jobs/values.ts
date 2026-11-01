import { types } from "node:util";
import { Ulid } from "@draftyak/protocol/scalars";

export class WorkError extends Error {
	readonly code: "input" | "scope" | "data" | "lease";
	constructor(code: "input" | "scope" | "data" | "lease") {
		super(`Durable work ${code} refused`);
		this.name = "WorkError";
		this.code = code;
	}
}

export function integer(
	value: unknown,
	minimum: number = 0,
	maximum: number = Number.MAX_SAFE_INTEGER,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new WorkError("input");
	return value;
}

export function id(value: unknown): string {
	if (typeof value !== "string" || value.length !== 26 || !Ulid.safeParse(value).success)
		throw new WorkError("input");
	return value;
}

/** Snapshot only inert, explicitly named fields; never invoke caller getters or Proxy traps. */
export function fields(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
	if (raw === null || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw))
		throw new WorkError("input");
	const names = Reflect.ownKeys(raw);
	const result: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		if (typeof name !== "string" || (!required.includes(name) && !optional.includes(name)))
			throw new WorkError("input");
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new WorkError("input");
		result[name] = descriptor.value;
	}
	if (required.some((name) => !Object.hasOwn(result, name))) throw new WorkError("input");
	return Object.freeze(result);
}
