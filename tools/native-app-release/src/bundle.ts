import { createHash } from "node:crypto";
import { types } from "node:util";
import type { NativeAppReleaseBuilder } from "./builder.ts";
import {
	MAX_FILE_BYTES,
	MAX_MANIFEST_BYTES,
	type NativeAppReleaseDescriptor,
	type NativeAppReleaseManifest,
	releaseDescriptor,
} from "./manifest.ts";
import { refuse } from "./paths.ts";

type BundleData = null | boolean | number | string | BundleData[] | { [key: string]: BundleData };

// bundle-hub writes JSON with two-space indentation and one final newline.
function captureBundle(raw: unknown): { data: BundleData; bytes: Buffer } {
	const active = new Set<object>();
	let nodes = 0;
	let budget = 1;
	const count = (bytes: number): void => {
		budget += bytes;
		if (budget > MAX_MANIFEST_BYTES) refuse("bounds");
	};
	const text = (value: string): void => {
		if (value.length > MAX_MANIFEST_BYTES) refuse("bounds");
		count(Buffer.byteLength(JSON.stringify(value), "utf8"));
	};
	const copy = (value: unknown, depth: number): BundleData => {
		if (++nodes > 16_384 || depth > 32) refuse("bounds");
		if (value === null || typeof value === "boolean") {
			count(value === null ? 4 : value ? 4 : 5);
			return value;
		}
		if (typeof value === "string") {
			text(value);
			return value;
		}
		if (typeof value === "number" && Number.isFinite(value)) {
			count(JSON.stringify(value).length);
			return value;
		}
		if (!value || typeof value !== "object" || types.isProxy(value)) refuse("manifest");
		const array = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
			refuse("manifest");
		if (active.has(value)) refuse("manifest");
		active.add(value);
		const names = Reflect.ownKeys(value);
		if (names.length > 16_384) refuse("bounds");
		const length = array ? Object.getOwnPropertyDescriptor(value, "length")?.value : 0;
		if (array && (!Number.isSafeInteger(length) || length < 0 || length > 16_384)) refuse("bounds");
		if (array && names.length !== length + 1) refuse("manifest");
		const result: BundleData[] | { [key: string]: BundleData } = array
			? Object.setPrototypeOf([], null)
			: Object.create(null);
		let entries = 0;
		count(2);
		for (const name of names) {
			if (array && name === "length") continue;
			if (typeof name !== "string" || name === "toJSON") refuse("manifest");
			if (array && name !== String(entries)) refuse("manifest");
			const slot = Object.getOwnPropertyDescriptor(value, name);
			if (!slot?.enumerable || !("value" in slot)) refuse("manifest");
			count(1 + (depth + 1) * 2 + (entries ? 1 : 0));
			if (!array) {
				text(name);
				count(2);
			}
			Object.defineProperty(result, name, {
				value: copy(slot.value, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			});
			entries++;
		}
		if (entries) count(1 + depth * 2);
		active.delete(value);
		return result;
	};
	const data = copy(raw, 0);
	const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8");
	if (bytes.byteLength !== budget || bytes.byteLength > MAX_MANIFEST_BYTES) refuse("bounds");
	return { data, bytes };
}

function member(raw: unknown, key: string): unknown {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse("manifest");
	const slot = Object.getOwnPropertyDescriptor(raw, key);
	if (!slot?.enumerable || !("value" in slot)) refuse("manifest");
	return slot.value;
}

export interface CapturedNativeAppReleaseBundle {
	readonly descriptor: NativeAppReleaseDescriptor;
	readonly metadataBytes: number;
	readonly metadataSha256: string;
	readonly binding: string;
}

/** Capture bundle DATA before any filesystem operation. */
export function captureNativeAppReleaseBundle(
	metadata: unknown,
	bundles: unknown,
): CapturedNativeAppReleaseBundle {
	const captured = captureBundle(metadata);
	if (member(captured.data, "schemaVersion") !== 1) refuse("manifest");
	const target = member(captured.data, "target");
	const platform = member(target, "platform");
	if (platform !== "win" && platform !== "darwin" && platform !== "linux") refuse("manifest");
	const arch = member(target, "arch");
	if (arch !== "x64" && arch !== "arm64") refuse("manifest");
	const executable = member(member(captured.data, "node"), "binary");
	if (executable !== (platform === "win" ? "node.exe" : "node")) refuse("manifest");
	const entry = member(member(captured.data, "hub"), "entry");
	if (entry !== "hub/hub.mjs") refuse("manifest");
	const selected = `${platform === "win" ? "win32" : platform}-${arch}`;
	const binding = `native/prebuilds/${selected}.node`;
	const bindings = member(member(captured.data, "native"), "bindings");
	if (member(bindings, selected) !== binding || Reflect.ownKeys(bindings as object).length !== 1)
		refuse("manifest");
	const descriptor = releaseDescriptor({
		version: member(captured.data, "version"),
		platform: platform === "win" ? "win32" : platform,
		arch,
		executable,
		entry,
		bundles,
	});
	return Object.freeze({
		descriptor,
		metadataBytes: captured.bytes.byteLength,
		metadataSha256: createHash("sha256").update(captured.bytes).digest("hex"),
		binding,
	});
}

export function assertNativeAppReleaseBundle(
	manifest: NativeAppReleaseManifest,
	captured: CapturedNativeAppReleaseBundle,
): void {
	const metadataFile = manifest.files.find((file) => file.path === "bundle.json");
	if (
		!metadataFile ||
		metadataFile.bytes !== captured.metadataBytes ||
		metadataFile.sha256 !== captured.metadataSha256
	)
		refuse("manifest");
	const bindingFile = manifest.files.find((file) => file.path === captured.binding);
	if (!bindingFile || bindingFile.bytes === 0 || bindingFile.bytes > MAX_FILE_BYTES)
		refuse("manifest");
}

/** Build release DATA from bundle.json and separately supplied package/archive tuples.
 * The caller retains the builder, including responsibility for retrying close on failure.
 */
export async function buildNativeAppReleaseFromBundle(
	builder: NativeAppReleaseBuilder,
	metadata: unknown,
	bundles: unknown,
): Promise<NativeAppReleaseManifest> {
	const captured = captureNativeAppReleaseBundle(metadata, bundles);
	const manifest = await builder.build(captured.descriptor);
	assertNativeAppReleaseBundle(manifest, captured);
	return manifest;
}
