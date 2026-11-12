import { types } from "node:util";
import type { ExtensionContract, ToolContract } from "@draftyak/protocol/extension";
import { extensionDeclaration } from "@draftyak/protocol/extension";
import { jsonCopy } from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type PluginManifestV1, validateManifest } from "@draftyak/protocol/manifest";
import type * as z from "zod";
import type { PluginContext } from "./context.ts";
import { PluginError } from "./errors.ts";
import type { PluginEntry, PluginRequestContext, PluginTool } from "./serve.ts";

export type Handler<C extends ToolContract, Context = PluginContext> = (
	args: z.output<C["input"]>,
	context: Context,
) => z.output<C["output"]> | Promise<z.output<C["output"]>>;

/** Capture only ordinary own data slots; configuration never invokes accessors or proxies. */
export function fields(value: unknown, max = 32): Record<string, PropertyDescriptor> {
	if (
		!value ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new TypeError("Definition refused");
	const keys = Reflect.ownKeys(value);
	if (keys.length > max || keys.some((key) => typeof key !== "string"))
		throw new TypeError("Definition refused");
	const slots = Object.getOwnPropertyDescriptors(value);
	if (Object.values(slots).some((slot) => !slot.enumerable || !("value" in slot)))
		throw new TypeError("Definition refused");
	return slots;
}

/** Bounded detached JSON, without executing object behavior during copying or serialization. */
export function dataCopy(value: unknown, maxBytes = 1_048_576): unknown {
	let nodes = 0;
	let bytes = 0;
	function count(text: string): void {
		bytes += Buffer.byteLength(text);
		if (bytes > maxBytes) throw new TypeError("Plugin JSON refused");
	}
	const active = new Set<object>();
	function copy(input: unknown, depth: number): unknown {
		if (++nodes > 65_536 || depth > 32) throw new TypeError("Plugin JSON refused");
		if (input === null || typeof input === "boolean") return input;
		if (typeof input === "number" && Number.isFinite(input)) return input;
		if (typeof input === "string" && input.isWellFormed() && input.length <= maxBytes) {
			count(input);
			return input;
		}
		if (!input || typeof input !== "object" || types.isProxy(input) || active.has(input))
			throw new TypeError("Plugin JSON refused");
		active.add(input);
		try {
			if (Array.isArray(input)) {
				const slots = Object.getOwnPropertyDescriptors(input);
				if (Reflect.ownKeys(input).length !== input.length + 1 || input.length > 65_536)
					throw new TypeError("Plugin JSON refused");
				return Array.from({ length: input.length }, (_, index) => {
					const slot = slots[String(index)];
					if (!slot?.enumerable || !("value" in slot)) throw new TypeError("Plugin JSON refused");
					return copy(slot.value, depth + 1);
				});
			}
			const result: Record<string, unknown> = Object.create(null);
			for (const [key, slot] of Object.entries(fields(input, 65_536))) {
				count(key);
				result[key] = copy(slot.value, depth + 1);
			}
			return result;
		} finally {
			active.delete(input);
		}
	}
	const result = copy(value, 0);
	if (Buffer.byteLength(canonicalize(result)) > maxBytes)
		throw new TypeError("Plugin JSON refused");
	return jsonCopy(result);
}
export function freezeJson<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}
export function capture(
	options: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	const slots = fields(options);
	for (const name of required)
		if (!Object.hasOwn(slots, name)) throw new TypeError("Required handler missing");
	const result: Record<string, unknown> = Object.create(null);
	for (const [name, slot] of Object.entries(slots)) {
		if (![...required, ...optional].includes(name))
			throw new TypeError("Unknown definition member");
		if (optional.includes(name) && slot.value === undefined) continue;
		if (
			name !== "manifest" &&
			name !== "lookup" &&
			(typeof slot.value !== "function" || types.isProxy(slot.value))
		)
			throw new TypeError("Handler refused");
		result[name] = slot.value;
	}
	return result;
}
export function manifest<K extends PluginManifestV1["kind"]>(
	value: unknown,
	kind: K,
): Extract<PluginManifestV1, { kind: K }> {
	const checked = validateManifest(value);
	if (!checked.ok || checked.manifest.kind !== kind) throw new TypeError("Manifest kind refused");
	return freezeJson(checked.manifest) as Extract<PluginManifestV1, { kind: K }>;
}
export function entry(
	manifest: PluginManifestV1,
	contract: ExtensionContract,
	tools: readonly PluginTool[],
): PluginEntry {
	return Object.freeze({
		name: manifest.id,
		plugin: manifest.id,
		version: manifest.version,
		extensions: freezeJson({ [contract.id]: extensionDeclaration(contract) }),
		tools: Object.freeze(tools),
	});
}
export function checkedTool(
	name: string,
	contract: ToolContract,
	invoke: PluginTool["handler"],
): PluginTool {
	return Object.freeze({
		name,
		description: contract.description,
		inputSchema: contract.input,
		outputSchema: contract.output,
		async handler(
			args: unknown,
			context: PluginContext,
			metadata: Readonly<Record<string, unknown>>,
			request?: PluginRequestContext,
		): Promise<unknown> {
			const parsed = contract.input.safeParse(dataCopy(args));
			if (!parsed.success) throw new PluginError("INVALID_INPUT");
			const value = dataCopy(await invoke(parsed.data, context, metadata, request));
			const result = contract.output.safeParse(value);
			if (!result.success) throw new PluginError("TRANSIENT");
			return result.data;
		},
	});
}
