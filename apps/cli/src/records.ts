import { types } from "node:util";
import { CliRefusal } from "./refusal.ts";

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || types.isProxy(value)) throw new CliRefusal();
	const own = Reflect.ownKeys(value);
	if (
		own.length !== keys.length ||
		own.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		throw new CliRefusal();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !("value" in property)) throw new CliRefusal();
		result[key] = property.value;
	}
	return result;
}
