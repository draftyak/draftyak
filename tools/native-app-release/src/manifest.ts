import { types } from "node:util";
import { assertPortableFileTree } from "@draftyak/bounded-files";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { MANIFEST_FILE, packageEntry, refuse, releasePath, SIGNATURE_FILE } from "./paths.ts";

export type { NativeAppReleaseCode } from "./paths.ts";
export { NativeAppReleaseError } from "./paths.ts";

export const MAX_MANIFEST_BYTES: number = 1024 * 1024;
export const MAX_FILE_BYTES: number = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES: number = 512 * 1024 * 1024;
export const MAX_FILES = 4096;
export const NATIVE_APP_BUNDLE_IDS: readonly [
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] = Object.freeze([
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] as const);
export type NativeAppBundleId = (typeof NATIVE_APP_BUNDLE_IDS)[number];
export interface NativeAppReleasePackage {
	readonly name: string;
	readonly version: string;
	readonly integrity: string;
	readonly entry: string;
}
export interface NativeAppReleaseBundle {
	readonly id: NativeAppBundleId;
	readonly package: NativeAppReleasePackage;
	readonly archive: string;
}
export interface NativeAppReleaseFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}
export interface NativeAppReleaseDescriptor {
	readonly version: string;
	readonly platform: "win32" | "darwin" | "linux";
	readonly arch: "x64" | "arm64";
	readonly executable: string;
	readonly entry: string;
	readonly bundles: readonly NativeAppReleaseBundle[];
}
export interface NativeAppReleaseManifest extends NativeAppReleaseDescriptor {
	readonly v: 1;
	readonly application: "draftyak";
	readonly files: readonly NativeAppReleaseFile[];
}

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refuse("manifest");
	const names = Reflect.ownKeys(raw);
	if (names.length !== keys.length) refuse("manifest");
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of names) {
		if (typeof key !== "string" || !keys.includes(key)) refuse("manifest");
		const slot = Object.getOwnPropertyDescriptor(raw, key);
		if (!slot?.enumerable || !("value" in slot)) refuse("manifest");
		copy[key] = slot.value;
	}
	return copy;
}

function list(raw: unknown, maximum: number): readonly unknown[] {
	if (
		!raw ||
		types.isProxy(raw) ||
		!Array.isArray(raw) ||
		Object.getPrototypeOf(raw) !== Array.prototype
	)
		refuse("manifest");
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > maximum ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		refuse("bounds");
	const copy: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const slot = Object.getOwnPropertyDescriptor(raw, String(i));
		if (!slot?.enumerable || !("value" in slot)) refuse("manifest");
		copy.push(slot.value);
	}
	return copy;
}

function version(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 128) refuse("manifest");
	const match =
		/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			raw,
		);
	if (
		match?.[0] !== raw ||
		match[4]?.split(".").some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === "0")
	)
		refuse("manifest");
	return raw;
}

/** The exact SHA-512 SRI spelling supported by the merged package-lock reader. */
export function integrityDigest(raw: unknown): Buffer {
	if (typeof raw !== "string") refuse("manifest");
	const text = /^sha512-([A-Za-z0-9+/]{86}==)(?![\s\S])/.exec(raw)?.[1];
	if (text === undefined) refuse("manifest");
	const digest = Buffer.from(text, "base64");
	if (digest.length !== 64 || digest.toString("base64") !== text) refuse("manifest");
	return digest;
}

const descriptorKeys = ["version", "platform", "arch", "executable", "entry", "bundles"];

/** Snapshot explicit DATA inputs; none of these fields supplies installation permission. */
export function releaseDescriptor(raw: unknown): NativeAppReleaseDescriptor {
	const row = record(raw, descriptorKeys);
	if (row.platform !== "win32" && row.platform !== "darwin" && row.platform !== "linux")
		refuse("manifest");
	if (row.arch !== "x64" && row.arch !== "arm64") refuse("manifest");
	const bundles = list(row.bundles, 5).map((input) => {
		const bundle = record(input, ["id", "package", "archive"]);
		const id = NATIVE_APP_BUNDLE_IDS.find((id) => id === bundle.id);
		if (id === undefined) refuse("manifest");
		const lock = record(bundle.package, ["name", "version", "integrity", "entry"]);
		const name = `@draftyak/${id}`;
		if (lock.name !== name || typeof lock.integrity !== "string") refuse("manifest");
		integrityDigest(lock.integrity);
		return Object.freeze({
			id,
			package: Object.freeze({
				name,
				version: version(lock.version),
				integrity: lock.integrity,
				entry: packageEntry(lock.entry),
			}),
			archive: releasePath(bundle.archive),
		});
	});
	if (bundles.length !== 5 || new Set(bundles.map((row) => row.id)).size !== 5) refuse("manifest");
	const executable = releasePath(row.executable),
		entry = releasePath(row.entry);
	try {
		assertPortableFileTree([
			executable,
			entry,
			...bundles.map((row) => row.archive),
			MANIFEST_FILE,
			SIGNATURE_FILE,
		]);
	} catch {
		refuse("path");
	}
	return Object.freeze({
		version: version(row.version),
		platform: row.platform,
		arch: row.arch,
		executable,
		entry,
		bundles: Object.freeze(bundles),
	});
}

function manifestValue(raw: unknown): NativeAppReleaseManifest {
	const row = record(raw, ["v", "application", ...descriptorKeys, "files"]);
	if (row.v !== 1 || row.application !== "draftyak") refuse("manifest");
	const descriptor = releaseDescriptor(
		Object.fromEntries(descriptorKeys.map((key) => [key, row[key]])),
	);
	let total = 0;
	const files = list(row.files, MAX_FILES).map((raw) => {
		const file = record(raw, ["path", "bytes", "sha256"]);
		if (
			typeof file.bytes !== "number" ||
			!Number.isSafeInteger(file.bytes) ||
			file.bytes < 0 ||
			file.bytes > MAX_FILE_BYTES ||
			typeof file.sha256 !== "string" ||
			/^[0-9a-f]{64}$/.exec(file.sha256)?.[0] !== file.sha256
		)
			refuse("manifest");
		total += file.bytes;
		if (total > MAX_TOTAL_BYTES) refuse("bounds");
		return Object.freeze({ path: releasePath(file.path), bytes: file.bytes, sha256: file.sha256 });
	});
	for (let i = 1; i < files.length; i++)
		if ((files[i - 1]?.path ?? "") >= (files[i]?.path ?? "")) refuse("manifest");
	try {
		assertPortableFileTree([...files.map((row) => row.path), MANIFEST_FILE, SIGNATURE_FILE]);
	} catch {
		refuse("path");
	}
	const names = new Set(files.map((row) => row.path));
	if (
		![
			descriptor.executable,
			descriptor.entry,
			...descriptor.bundles.map((row) => row.archive),
		].every((name) => names.has(name))
	)
		refuse("manifest");
	return Object.freeze({
		v: 1,
		application: "draftyak",
		...descriptor,
		files: Object.freeze(files),
	});
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const buffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;

export function parseNativeAppRelease(input: Uint8Array): NativeAppReleaseManifest {
	try {
		if (types.isProxy(input) || !types.isUint8Array(input) || !byteLength || !byteOffset || !buffer)
			refuse("manifest");
		const length = Reflect.apply(byteLength, input, []);
		const backing = Reflect.apply(buffer, input, []);
		if (length < 1 || length > MAX_MANIFEST_BYTES || types.isSharedArrayBuffer(backing))
			refuse("bounds");
		const bytes = new Uint8Array(length);
		bytes.set(new Uint8Array(backing, Reflect.apply(byteOffset, input, []), length));
		const result = manifestValue(parseStrict(bytes));
		const expected = nativeAppReleaseBytes(result);
		if (expected.length !== length || !expected.every((byte, i) => byte === bytes[i]))
			refuse("manifest");
		return result;
	} catch {
		return refuse("manifest");
	}
}

export function nativeAppReleaseBytes(input: unknown): Uint8Array {
	try {
		const bytes = new TextEncoder().encode(canonicalize(manifestValue(input)));
		if (bytes.length > MAX_MANIFEST_BYTES) refuse("bounds");
		return bytes;
	} catch {
		return refuse("manifest");
	}
}

export function nativeAppReleaseSigningBytes(input: unknown): Uint8Array {
	const body = nativeAppReleaseBytes(input);
	const prefix = new TextEncoder().encode("DraftYak native application release v1\0");
	const result = new Uint8Array(prefix.length + body.length);
	result.set(prefix);
	result.set(body, prefix.length);
	return result;
}
