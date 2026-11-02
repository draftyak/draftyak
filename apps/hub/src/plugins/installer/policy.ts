import { isProxy } from "node:util/types";
import { type PluginManifestV1, validateManifest } from "@draftyak/protocol/manifest";
import type { PreparedPackage } from "../../artifacts/index.ts";

export const BUNDLED_PLUGIN_IDS = [
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] as const;
Object.freeze(BUNDLED_PLUGIN_IDS);
export type BundledPluginId = (typeof BUNDLED_PLUGIN_IDS)[number];

interface Binding {
	readonly kind: "channel" | "ai-provider";
	readonly profiles: readonly string[];
}

const BINDINGS: Readonly<Record<BundledPluginId, Binding>> = Object.freeze({
	"channel-gmail": { kind: "channel", profiles: ["gmail-v1", "gmail-readonly-v1"] },
	"channel-slack": { kind: "channel", profiles: ["slack-v1"] },
	"ai-messages-api": { kind: "ai-provider", profiles: ["messages-api-v1"] },
	"ai-responses-api": { kind: "ai-provider", profiles: ["responses-api-v1"] },
	"ai-chat-completions": { kind: "ai-provider", profiles: ["chat-completions-v1"] },
});

// Addons and shared libraries, including versioned shared objects such as addon.so.1.
const NATIVE_MEMBER = /\.(?:node|dll|so|dylib)(?:\.[0-9]+)*$/i;

export class PluginInstallError extends Error {
	constructor() {
		super("Plugin installation refused.");
		this.name = "PluginInstallError";
	}
}

export function refuse(): never {
	throw new PluginInstallError();
}

/** Own enumerable data fields only, with exactly the allowed keys; accessors and proxies stay unread. */
export function record(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		raw === null ||
		typeof raw !== "object" ||
		isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse();
	const result = Object.create(null) as Record<string, unknown>;
	for (const key of Reflect.ownKeys(raw)) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) refuse();
		const field = Object.getOwnPropertyDescriptor(raw, key);
		if (!field?.enumerable || !("value" in field)) refuse();
		result[key] = field.value;
	}
	if (required.some((key) => !Object.hasOwn(result, key))) refuse();
	return result;
}

function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}

/** A bundled package runs as shipped: no install scripts, dependencies or native members. */
function admitPackage(prepared: PreparedPackage): void {
	const metadata = prepared.metadata;
	if (
		["scripts", "gypfile", "bundledDependencies", "bundleDependencies"].some((key) =>
			Object.hasOwn(metadata, key),
		)
	)
		refuse();
	for (const key of ["dependencies", "optionalDependencies", "peerDependencies"])
		if (metadata[key] !== undefined) record(metadata[key], []);
	for (const name of prepared.files.keys())
		for (const part of name.split("/"))
			if (NATIVE_MEMBER.test(part) || /^(?:node_modules|binding\.gyp)$/i.test(part)) refuse();
}

/** Pilot policy over a schema-checked manifest; it refuses on its own whatever the schema admits. */
export function admitManifest(manifest: PluginManifestV1, id: BundledPluginId): void {
	const binding = BINDINGS[id];
	if (
		manifest.id !== id ||
		manifest.kind !== binding.kind ||
		(manifest.runtime !== undefined && manifest.runtime !== "node") ||
		manifest.isolation !== "standard" ||
		manifest.auth.kind === "url-secret" ||
		manifest.credentials.urlSecrets.length !== 0 ||
		!("profile" in manifest.egress) ||
		!binding.profiles.includes(manifest.egress.profile) ||
		(manifest.kind === "channel" && manifest.send?.render === "json-template")
	)
		refuse();
}

/** The package's admitted manifest, deep-frozen; it grants no activation or launch authority. */
export function declaration(prepared: PreparedPackage, id: BundledPluginId): PluginManifestV1 {
	admitPackage(prepared);
	const bytes = prepared.files.get("draftyak.plugin.json");
	if (!bytes) refuse();
	const checked = validateManifest(bytes);
	if (!checked.ok || checked.manifest.version !== prepared.inventory.version) refuse();
	admitManifest(checked.manifest, id);
	return frozen(checked.manifest);
}
