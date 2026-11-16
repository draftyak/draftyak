import { KeyObject, verify } from "node:crypto";
import { isArrayBuffer, isKeyObject, isProxy, isUint8Array } from "node:util/types";
import {
	assertPortableFileTree,
	checkedFileRecord,
	portableRelativePath,
} from "@draftyak/bounded-files";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import type { PackageLock } from "../artifacts/index.ts";
import { snapshotPackageLock } from "../artifacts/pin.ts";
import { BUNDLED_PLUGIN_IDS, type BundledPluginId, record } from "../plugins/installer/policy.ts";

export interface NativeAppReleaseFile {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface NativeAppReleaseBundle {
	readonly id: BundledPluginId;
	readonly package: PackageLock;
	readonly archive: string;
}

/** Authenticated release content only; it is not a session or installation grant. */
export interface NativeAppRelease {
	readonly v: 1;
	readonly application: "draftyak";
	readonly version: string;
	readonly platform: "win32" | "darwin" | "linux";
	readonly arch: "x64" | "arm64";
	readonly executable: string;
	readonly entry: string;
	readonly bundles: readonly NativeAppReleaseBundle[];
	readonly files: readonly NativeAppReleaseFile[];
}

const MANIFEST_LIMIT = 1024 * 1024;
const FILE_LIMIT = 256 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const DOMAIN = Buffer.from("DraftYak native application release v1\0");
const METADATA_NAMES = new Set(["release.manifest.json", "release.signature"]);
const versionPattern =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const backing = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const setBytes = Uint8Array.prototype.set;
const keyType = Object.getOwnPropertyDescriptor(KeyObject.prototype, "type")?.get;
const toCryptoKey = KeyObject.prototype.toCryptoKey;
const keyFrom = KeyObject.from;

function refuse(): never {
	throw new Error("Native application release refused.");
}

/** Snapshot only the selected ordinary, fixed backing bytes, without caller hooks. */
function snapshot(raw: unknown, minimum: number, maximum: number): Buffer {
	if (isProxy(raw) || !isUint8Array(raw)) refuse();
	const length = byteLength?.call(raw) as number;
	const offset = byteOffset?.call(raw) as number;
	const buffer = backing?.call(raw) as ArrayBuffer;
	if (
		!Number.isSafeInteger(length) ||
		length < minimum ||
		length > maximum ||
		!isArrayBuffer(buffer) ||
		resizable?.call(buffer)
	)
		refuse();
	const result = Buffer.alloc(length);
	setBytes.call(result, new Uint8Array(buffer, offset, length));
	return result;
}

function releasePath(raw: unknown): string {
	const path = portableRelativePath(raw, {
		maximumLength: 200,
		maximumComponents: 16,
		maximumComponentLength: 200,
	});
	if (METADATA_NAMES.has(path.toLowerCase())) refuse();
	return path;
}

function version(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 128) refuse();
	const match = versionPattern.exec(raw);
	if (
		match?.[0] !== raw ||
		match[4]?.split(".").some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === "0")
	)
		refuse();
	return raw;
}

function content(raw: unknown): NativeAppRelease {
	const data = record(raw, [
		"v",
		"application",
		"version",
		"platform",
		"arch",
		"executable",
		"entry",
		"bundles",
		"files",
	]);
	if (
		data.v !== 1 ||
		data.application !== "draftyak" ||
		(data.platform !== "win32" && data.platform !== "darwin" && data.platform !== "linux") ||
		(data.arch !== "x64" && data.arch !== "arm64") ||
		!Array.isArray(data.files) ||
		data.files.length > 4096 ||
		!Array.isArray(data.bundles) ||
		data.bundles.length !== BUNDLED_PLUGIN_IDS.length
	)
		refuse();
	const appVersion = version(data.version);
	let total = 0;
	const files = data.files.map((rawFile): NativeAppReleaseFile => {
		const file = checkedFileRecord(rawFile, {
			byteField: "bytes",
			minimum: 0,
			maximum: FILE_LIMIT,
		});
		const path = releasePath(file.path);
		total += file.byteLength;
		if (total > TOTAL_LIMIT) refuse();
		return Object.freeze({ path, bytes: file.byteLength, sha256: file.sha256 });
	});
	assertPortableFileTree([...METADATA_NAMES, ...files.map((file) => file.path)]);
	const names = new Set(files.map((file) => file.path));
	const executable = releasePath(data.executable);
	const entry = releasePath(data.entry);
	if (executable === entry || !names.has(executable) || !names.has(entry)) refuse();
	const ids = new Set<BundledPluginId>();
	const archives = new Set<string>();
	const bundles = data.bundles.map((rawBundle): NativeAppReleaseBundle => {
		const bundle = record(rawBundle, ["id", "package", "archive"]);
		const id = bundle.id;
		if (!BUNDLED_PLUGIN_IDS.some((candidate) => candidate === id)) refuse();
		const fixedId = id as BundledPluginId;
		if (ids.has(fixedId)) refuse();
		ids.add(fixedId);
		const pin = snapshotPackageLock(bundle.package);
		if (pin.name !== `@draftyak/${fixedId}`) refuse();
		const archive = releasePath(bundle.archive);
		if (!names.has(archive) || archives.has(archive) || archive === executable || archive === entry)
			refuse();
		archives.add(archive);
		return Object.freeze({ id: fixedId, package: pin, archive });
	});
	return Object.freeze({
		v: 1,
		application: "draftyak",
		version: appVersion,
		platform: data.platform,
		arch: data.arch,
		executable,
		entry,
		bundles: Object.freeze(bundles),
		files: Object.freeze(files),
	});
}

/** Verify exact canonical release bytes against a supplied public key, returning data only. */
export function verifyNativeAppRelease(
	manifestBytes: Uint8Array,
	signature: Uint8Array,
	trustedPublicKey: KeyObject,
): NativeAppRelease {
	try {
		const manifest = snapshot(manifestBytes, 1, MANIFEST_LIMIT);
		const signed = snapshot(signature, 64, 64);
		if (
			isProxy(trustedPublicKey) ||
			!isKeyObject(trustedPublicKey) ||
			keyType?.call(trustedPublicKey) !== "public"
		)
			refuse();
		// This temporary CryptoKey contains an already exportable public key.
		const verificationKey = keyFrom(
			toCryptoKey.call(trustedPublicKey, { name: "Ed25519" }, true, ["verify"]),
		);
		const parsed = parseStrict(manifest);
		if (!Buffer.from(canonicalize(parsed)).equals(manifest)) refuse();
		const release = content(parsed);
		if (!verify(null, Buffer.concat([DOMAIN, manifest]), verificationKey, signed)) refuse();
		return release;
	} catch {
		refuse();
	}
}
