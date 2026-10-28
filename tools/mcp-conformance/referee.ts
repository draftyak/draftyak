import { isProxy } from "node:util/types";
import { CONFORMANCE_VERSION } from "./policy.ts";

/** Technical metadata only; never trust a caller-selected executable or invoke metadata hooks. */
export function assertPinnedReferee(metadata: unknown): void {
	const refused = (): Error => new Error("Conformance CLI pin differs");
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || isProxy(metadata))
		throw refused();
	const fields = Object.getOwnPropertyDescriptors(metadata);
	const data = (key: string): unknown => {
		const descriptor = fields[key];
		if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw refused();
		return descriptor.value;
	};
	const name = data("name"),
		version = data("version"),
		bin = data("bin");
	if (
		name !== "@modelcontextprotocol/conformance" ||
		version !== CONFORMANCE_VERSION ||
		!bin ||
		typeof bin !== "object" ||
		Array.isArray(bin) ||
		isProxy(bin)
	)
		throw refused();
	const entry = Object.getOwnPropertyDescriptor(bin, "conformance");
	if (
		Reflect.ownKeys(bin).length !== 1 ||
		!entry?.enumerable ||
		!Object.hasOwn(entry, "value") ||
		entry.value !== "dist/index.js"
	)
		throw refused();
}
