import path from "node:path";
import { isProxy } from "node:util/types";
import { assertPortableFileTree } from "@draftyak/bounded-files";
import { egressDigest, manifestDigest, sendTemplateDigest } from "@draftyak/protocol/digests";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { validateManifest } from "@draftyak/protocol/manifest";
import {
	MAX_BUNDLE_BYTES,
	MAX_FILE_BYTES,
	MAX_FILES,
	portablePath,
} from "../../artifacts/archive.ts";
import type { PackageLock } from "../../artifacts/index.ts";
import { snapshotPackageLock } from "../../artifacts/pin.ts";
import { fields, integer } from "../../jobs/values.ts";
import {
	BUNDLED_PLUGIN_IDS,
	type BundledPluginId,
	type BundledPluginPin,
	type InstalledPlugin,
} from "../installer/index.ts";

export const MAX_RECORD_BYTES = 524_288;
const HASH = /^[0-9a-f]{64}$/;

export type PluginRegistryErrorCode =
	| "input"
	| "unavailable"
	| "conflict"
	| "data"
	| "install"
	| "admin";
export class PluginRegistryError extends Error {
	readonly code: PluginRegistryErrorCode;
	constructor(code: PluginRegistryErrorCode) {
		super("Plugin registry operation refused.");
		this.name = "PluginRegistryError";
		this.code = code;
	}
}
export function refuse(code: PluginRegistryErrorCode): never {
	throw new PluginRegistryError(code);
}
export function pluginId(raw: unknown): BundledPluginId {
	const found = BUNDLED_PLUGIN_IDS.find((id) => id === raw);
	return found ?? refuse("input");
}
export function pinKey(id: string, version: string): string {
	return `${id}\0${version}`;
}
function array(raw: unknown, maximum: number): readonly unknown[] {
	if (!Array.isArray(raw) || isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
		return refuse("input");
	if (raw.length > maximum || Reflect.ownKeys(raw).length !== raw.length + 1)
		return refuse("input");
	return Object.freeze(
		Array.from({ length: raw.length }, (_, index) => {
			const field = Object.getOwnPropertyDescriptor(raw, String(index));
			return field?.enumerable && "value" in field ? field.value : refuse("input");
		}),
	);
}
export function pins(raw: unknown): readonly BundledPluginPin[] {
	const seen = new Set<string>();
	const result = array(raw, 64).map((value) => {
		const row = fields(value, ["id", "package"]);
		const id = pluginId(row.id),
			lock = snapshotPackageLock(row.package);
		const key = pinKey(id, lock.version);
		if (lock.name !== `@draftyak/${id}` || seen.has(key)) return refuse("input");
		seen.add(key);
		return Object.freeze({ id, package: lock });
	});
	if (result.length === 0) return refuse("input");
	return Object.freeze(result);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) freeze(item);
		Object.freeze(value);
	}
	return value;
}

/** A bounded mechanical snapshot; it is never proof of review, discovery or activation. */
export function snapshot(
	raw: unknown,
	id: BundledPluginId,
	lock: PackageLock,
	root: string,
): InstalledPlugin {
	const row = fields(raw, ["bundle", "manifest", "digests"]);
	const bundle = fields(row.bundle, ["directory", "inventory"]);
	const inventory = fields(bundle.inventory, ["name", "version", "integrity", "entry", "files"]);
	const selected = snapshotPackageLock({
		name: inventory.name,
		version: inventory.version,
		integrity: inventory.integrity,
		entry: inventory.entry,
	});
	if (canonicalize(selected) !== canonicalize(lock)) refuse("data");
	const destination = path.join(
		root,
		`${id}-${Buffer.from(lock.integrity.slice(7), "base64").toString("hex")}`,
	);
	if (bundle.directory !== destination) refuse("data");
	let bytes = 0;
	const files = array(inventory.files, MAX_FILES).map((value) => {
		const file = fields(value, ["path", "bytes", "sha256"]);
		const name = portablePath(file.path),
			length = integer(file.bytes, 0, MAX_FILE_BYTES);
		if (typeof file.sha256 !== "string" || !HASH.test(file.sha256)) refuse("data");
		bytes += length;
		return Object.freeze({ path: name, bytes: length, sha256: file.sha256 });
	});
	if (
		files.length === 0 ||
		bytes > MAX_BUNDLE_BYTES ||
		!files.some((file) => file.path === lock.entry)
	)
		refuse("data");
	assertPortableFileTree(files.map((file) => file.path));
	const checked = validateManifest(row.manifest);
	if (!checked.ok || checked.manifest.id !== id || checked.manifest.version !== lock.version)
		refuse("data");
	const digest = fields(row.digests, ["manifest", "egress", "send"]);
	const expected = {
		manifest: manifestDigest(row.manifest),
		egress: egressDigest(checked.manifest.egress),
		send:
			checked.manifest.kind === "channel" && checked.manifest.send
				? sendTemplateDigest(checked.manifest.send)
				: null,
	};
	if (canonicalize(digest) !== canonicalize(expected)) refuse("data");
	// Keep the declared JSON unchanged: hashing it must never introduce defaults or omit members.
	return freeze({
		bundle: { directory: destination, inventory: { ...selected, files } },
		manifest: parseStrict(canonicalize(row.manifest)) as InstalledPlugin["manifest"],
		digests: expected,
	});
}
export function encode(value: InstalledPlugin): string {
	const json = canonicalize(value);
	if (Buffer.byteLength(json) > MAX_RECORD_BYTES) refuse("data");
	return json;
}
export function decode(
	json: unknown,
	id: BundledPluginId,
	lock: PackageLock,
	root: string,
): InstalledPlugin {
	if (typeof json !== "string" || Buffer.byteLength(json) > MAX_RECORD_BYTES) refuse("data");
	const value = parseStrict(json);
	if (canonicalize(value) !== json) refuse("data");
	return snapshot(value, id, lock, root);
}
