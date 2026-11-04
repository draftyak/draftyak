import { createPublicKey, KeyObject } from "node:crypto";
import { types } from "node:util";
import { packageEntry, refuse } from "./paths.ts";

const keyType = Object.getOwnPropertyDescriptor(KeyObject.prototype, "type")?.get;
const keyEquals = KeyObject.prototype.equals;

function publicKeyDer(key: KeyObject): string {
	try {
		if (
			types.isProxy(key) ||
			!types.isKeyObject(key) ||
			!keyType ||
			Reflect.apply(keyType, key, []) !== "public" ||
			["type", "asymmetricKeyType", "export"].some((name) => Object.hasOwn(key, name))
		)
			refuse("manifest");
		const prototype = Object.getPrototypeOf(key);
		if (!prototype || types.isProxy(prototype)) refuse("manifest");
		const exporter = Object.getOwnPropertyDescriptor(prototype, "export");
		if (!exporter || !("value" in exporter) || typeof exporter.value !== "function")
			refuse("manifest");
		const der: unknown = Reflect.apply(exporter.value, key, [{ format: "der", type: "spki" }]);
		if (types.isProxy(der) || !Buffer.isBuffer(der) || der.length !== 44) refuse("manifest");
		const parsed = createPublicKey({ key: der, format: "der", type: "spki" });
		if (parsed.asymmetricKeyType !== "ed25519" || !Reflect.apply(keyEquals, key, [parsed]))
			refuse("manifest");
		const canonical = parsed.export({ format: "der", type: "spki" });
		if (!canonical.equals(der)) refuse("manifest");
		return canonical.toString("base64");
	} catch {
		return refuse("manifest");
	}
}

function layout(
	raw: unknown,
): Readonly<Record<"version" | "executable" | "entry" | "module", string>> {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse("manifest");
	const names = Reflect.ownKeys(raw);
	const expected = ["version", "executable", "entry", "module"] as const;
	if (names.length !== expected.length) refuse("manifest");
	const copy: Record<string, unknown> = Object.create(null);
	for (const name of names) {
		if (typeof name !== "string" || !expected.includes(name as (typeof expected)[number]))
			refuse("manifest");
		const slot = Object.getOwnPropertyDescriptor(raw, name);
		if (!slot?.enumerable || !("value" in slot)) refuse("manifest");
		copy[name] = slot.value;
	}
	const version = copy.version;
	if (typeof version !== "string" || version.length > 128) refuse("manifest");
	// Match the release manifest's bounded version grammar without bundle inputs.
	const match =
		/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		);
	if (
		match?.[0] !== version ||
		match[4]?.split(".").some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === "0")
	)
		refuse("manifest");
	if (copy.executable !== "node" && copy.executable !== "node.exe") refuse("manifest");
	if (copy.entry !== "hub/hub.mjs") refuse("manifest");
	const module = packageEntry(copy.module);
	if (!module.startsWith("hub/") || !module.endsWith(".mjs")) refuse("path");
	return Object.freeze({ version, executable: copy.executable, entry: copy.entry, module });
}

/** Emit fixed public release-build trust Source; no private key or signing operation is accepted. */
export function buildNativeAppTrustSource(publicKey: KeyObject, declaredLayout: unknown): string {
	const row = layout(declaredLayout);
	const trust = {
		version: row.version,
		publicKeyDer: publicKeyDer(publicKey),
		executable: row.executable,
		entry: row.entry,
		module: row.module,
	};
	return `/** Fixed release-build input. Runtime callers cannot configure an application trust root. */
export interface NativeAppReleaseTrust {
\treadonly version: string;
\treadonly publicKeyDer: string;
\treadonly executable: string;
\treadonly entry: string;
\treadonly module: string;
}

export const nativeAppReleaseTrust: Readonly<NativeAppReleaseTrust> = Object.freeze(${JSON.stringify(trust, null, "\t")});
`;
}
