import { createHash } from "node:crypto";
import { isArrayBuffer, isProxy, isUint8Array } from "node:util/types";
import {
	assertPortableFileTree,
	checkedFileRecord,
	portableRelativePath,
} from "@draftyak/bounded-files";
import { parseStrict } from "@draftyak/protocol/jcs";

export interface NativeSqliteResourceExpectation {
	readonly version: string;
	readonly platform: "win32" | "darwin" | "linux";
	readonly arch: "x64" | "arm64";
	readonly native: Readonly<{ name: string; version: string; integrity: string }>;
}

export interface NativeSqliteResourceFileData {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface NativeSqliteResourceSelectionData extends NativeSqliteResourceFileData {
	readonly target: string;
}

const bundleLimit = 1024 * 1024;
const fileLimit = 256 * 1024 * 1024;
const totalLimit = 512 * 1024 * 1024;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const backing = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const setBytes = Uint8Array.prototype.set;
const eraseBytes = Uint8Array.prototype.fill;
// The producer inventories eight prebuilds, but its target object selects only these six.
const selectedTargets = new Set([
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
]);

function refuse(): never {
	throw new Error("SQLite resource DATA refused.");
}

function plain(
	raw: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) refuse();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(raw)) {
		if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) refuse();
		const slot = Object.getOwnPropertyDescriptor(raw, key);
		if (!slot?.enumerable || !("value" in slot)) refuse();
		result[key] = slot.value;
	}
	if (required.some((key) => !Object.hasOwn(result, key))) refuse();
	return result;
}

function text(raw: unknown, maximum: number): string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > maximum) refuse();
	return raw;
}

function snapshot(raw: unknown): Buffer {
	if (isProxy(raw) || !isUint8Array(raw)) refuse();
	const length = byteLength?.call(raw) as number;
	const offset = byteOffset?.call(raw) as number;
	const buffer = backing?.call(raw) as ArrayBuffer;
	if (
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > bundleLimit ||
		!isArrayBuffer(buffer) ||
		resizable?.call(buffer)
	)
		refuse();
	const result = Buffer.alloc(length);
	setBytes.call(result, new Uint8Array(buffer, offset, length));
	return result;
}

function records(raw: unknown): Map<string, NativeSqliteResourceFileData> {
	if (isProxy(raw) || !Array.isArray(raw)) refuse();
	const lengthSlot = Object.getOwnPropertyDescriptor(raw, "length");
	const length = lengthSlot && "value" in lengthSlot ? lengthSlot.value : undefined;
	if (!Number.isSafeInteger(length) || length < 1 || length > 4096) refuse();
	const files = new Map<string, NativeSqliteResourceFileData>();
	let total = 0;
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!slot?.enumerable || !("value" in slot)) refuse();
		const own = plain(slot.value, ["path", "bytes", "sha256"]);
		const file = checkedFileRecord(own, { byteField: "bytes", minimum: 0, maximum: fileLimit });
		const name = portableRelativePath(file.path, {
			maximumLength: 200,
			maximumComponents: 16,
			maximumComponentLength: 200,
		});
		if (files.has(name)) refuse();
		total += file.byteLength;
		if (total > totalLimit) refuse();
		files.set(name, Object.freeze({ path: name, bytes: file.byteLength, sha256: file.sha256 }));
	}
	assertPortableFileTree([...files.keys()]);
	return files;
}

/** DATA consistency only. The caller must independently authenticate the release and owned files. */
export function selectNativeSqliteResourceData(
	bundleBytes: Uint8Array,
	expected: NativeSqliteResourceExpectation,
	releaseFiles: readonly NativeSqliteResourceFileData[],
): Readonly<NativeSqliteResourceSelectionData> | undefined {
	let bytes: Buffer | undefined;
	try {
		bytes = snapshot(bundleBytes);
		const wanted = plain(expected, ["version", "platform", "arch", "native"]);
		const identity = plain(wanted.native, ["name", "version", "integrity"]);
		const version = text(wanted.version, 128);
		const name = text(identity.name, 200);
		const nativeVersion = text(identity.version, 128);
		const integrity = text(identity.integrity, 256);
		if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) refuse();
		if (
			!["win32", "darwin", "linux"].includes(wanted.platform as string) ||
			!["x64", "arm64"].includes(wanted.arch as string)
		)
			refuse();
		const bundle = plain(
			parseStrict(bytes),
			["schemaVersion", "version", "target", "node", "hub", "native"],
			["profile", "cli"],
		);
		if (bundle.schemaVersion !== 1 || bundle.version !== version) refuse();
		const target = plain(bundle.target, ["platform", "arch"]);
		if (
			!["win", "darwin", "linux"].includes(target.platform as string) ||
			!["x64", "arm64"].includes(target.arch as string)
		)
			refuse();
		const platform = target.platform === "win" ? "win32" : target.platform;
		if (platform !== wanted.platform || target.arch !== wanted.arch) refuse();
		const selected = `${platform}-${target.arch}`;
		if (!selectedTargets.has(selected)) refuse();
		const native = plain(bundle.native, ["name", "version", "integrity", "main", "bindings"]);
		if (
			native.name !== name ||
			native.version !== nativeVersion ||
			native.integrity !== integrity ||
			native.main !== "native/lib/index.js"
		)
			refuse();
		const bindings = plain(native.bindings, [selected]);
		const selectedPath = `native/prebuilds/${selected}.node`;
		if (bindings[selected] !== selectedPath) refuse();
		const files = records(releaseFiles);
		const descriptor = files.get("bundle.json");
		const binding = files.get(selectedPath);
		if (
			!descriptor ||
			descriptor.bytes !== bytes.length ||
			descriptor.sha256 !== createHash("sha256").update(bytes).digest("hex") ||
			!binding ||
			binding.bytes === 0
		)
			refuse();
		return Object.freeze({
			target: selected,
			path: binding.path,
			bytes: binding.bytes,
			sha256: binding.sha256,
		});
	} catch {
		return undefined;
	} finally {
		if (bytes) eraseBytes.call(bytes, 0);
	}
}
