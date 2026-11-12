import { KeyObject, verify } from "node:crypto";
import { isArrayBuffer, isKeyObject, isProxy, isUint8Array } from "node:util/types";
import {
	assertPortableFileTree,
	checkedFileRecord,
	portableRelativePath,
} from "@draftyak/bounded-files";
import { canonicalize, parseStrict } from "@draftyak/protocol/jcs";
import { Sha256Hex } from "@draftyak/protocol/scalars";
import type { PackageLock } from "../../artifacts/index.ts";
import { snapshotPackageLock } from "../../artifacts/pin.ts";
import { BUNDLED_PLUGIN_IDS, type BundledPluginId, record } from "./policy.ts";

export interface NativeReleaseV2File {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

/** Signed descriptor DATA; the expected surface is not proof of a runtime observation. */
export interface NativeReleaseV2Bundle {
	readonly id: BundledPluginId;
	readonly package: PackageLock;
	readonly archive: string;
	readonly expectedSurfaceDigest: string;
}

/**
 * Content authenticated relative to a supplied public key only. This snapshot grants no
 * native application trust, session, installation, review, generation or execution authority.
 */
export interface NativeReleaseV2 {
	readonly v: 2;
	readonly application: "draftyak";
	readonly version: string;
	readonly platform: "win32" | "darwin" | "linux";
	readonly arch: "x64" | "arm64";
	readonly executable: string;
	readonly entry: string;
	readonly bundles: readonly NativeReleaseV2Bundle[];
	readonly candidates: readonly NativeReleaseV2Bundle[];
	readonly files: readonly NativeReleaseV2File[];
}

const MANIFEST_LIMIT = 1024 * 1024;
const FILE_LIMIT = 256 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const DOMAIN = Buffer.from("DraftYak native application release v2\0");
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
	throw new Error("Native application release v2 refused.");
}

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
	const name = portableRelativePath(raw, {
		maximumLength: 200,
		maximumComponents: 16,
		maximumComponentLength: 200,
	});
	if (METADATA_NAMES.has(name.toLowerCase())) refuse();
	return name;
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

function descriptor(
	raw: unknown,
	names: ReadonlySet<string>,
	archives: Set<string>,
	executable: string,
	entry: string,
): NativeReleaseV2Bundle {
	const bundle = record(raw, ["id", "package", "archive", "expectedSurfaceDigest"]);
	if (!BUNDLED_PLUGIN_IDS.some((candidate) => candidate === bundle.id)) refuse();
	const id = bundle.id as BundledPluginId;
	const pin = snapshotPackageLock(bundle.package);
	if (pin.name !== `@draftyak/${id}`) refuse();
	const archive = releasePath(bundle.archive);
	if (!names.has(archive) || archives.has(archive) || archive === executable || archive === entry)
		refuse();
	const expectedSurfaceDigest = Sha256Hex.parse(bundle.expectedSurfaceDigest);
	archives.add(archive);
	return Object.freeze({ id, package: pin, archive, expectedSurfaceDigest });
}

function content(raw: unknown): NativeReleaseV2 {
	const data = record(raw, [
		"v",
		"application",
		"version",
		"platform",
		"arch",
		"executable",
		"entry",
		"bundles",
		"candidates",
		"files",
	]);
	if (
		data.v !== 2 ||
		data.application !== "draftyak" ||
		(data.platform !== "win32" && data.platform !== "darwin" && data.platform !== "linux") ||
		(data.arch !== "x64" && data.arch !== "arm64") ||
		!Array.isArray(data.files) ||
		data.files.length > 4096 ||
		!Array.isArray(data.bundles) ||
		data.bundles.length !== BUNDLED_PLUGIN_IDS.length ||
		!Array.isArray(data.candidates) ||
		data.candidates.length > BUNDLED_PLUGIN_IDS.length
	)
		refuse();
	const appVersion = version(data.version);
	let total = 0;
	const files = data.files.map((rawFile): NativeReleaseV2File => {
		const file = checkedFileRecord(rawFile, {
			byteField: "bytes",
			minimum: 0,
			maximum: FILE_LIMIT,
		});
		const name = releasePath(file.path);
		total += file.byteLength;
		if (total > TOTAL_LIMIT) refuse();
		return Object.freeze({ path: name, bytes: file.byteLength, sha256: file.sha256 });
	});
	assertPortableFileTree([...METADATA_NAMES, ...files.map((file) => file.path)]);
	const names = new Set(files.map((file) => file.path));
	const executable = releasePath(data.executable);
	const entry = releasePath(data.entry);
	if (executable === entry || !names.has(executable) || !names.has(entry)) refuse();
	const selected = new Map<BundledPluginId, NativeReleaseV2Bundle>();
	const archives = new Set<string>();
	const bundles = data.bundles.map((rawBundle): NativeReleaseV2Bundle => {
		const bundle = descriptor(rawBundle, names, archives, executable, entry);
		if (selected.has(bundle.id)) refuse();
		selected.set(bundle.id, bundle);
		return bundle;
	});
	const candidateIds = new Set<BundledPluginId>();
	const candidates = data.candidates.map((rawCandidate): NativeReleaseV2Bundle => {
		const candidate = descriptor(rawCandidate, names, archives, executable, entry);
		if (
			candidateIds.has(candidate.id) ||
			selected.get(candidate.id)?.package.version === candidate.package.version
		)
			refuse();
		candidateIds.add(candidate.id);
		return candidate;
	});
	return Object.freeze({
		v: 2,
		application: "draftyak",
		version: appVersion,
		platform: data.platform,
		arch: data.arch,
		executable,
		entry,
		bundles: Object.freeze(bundles),
		candidates: Object.freeze(candidates),
		files: Object.freeze(files),
	});
}

/**
 * Verify exact canonical v2 bytes using only the supplied public Ed25519 key.
 * This does not select a trusted origin, inspect files or issue native authority.
 */
export function verifyNativeReleaseV2(
	manifestBytes: Uint8Array,
	signature: Uint8Array,
	publicKey: KeyObject,
): NativeReleaseV2 {
	try {
		const manifest = snapshot(manifestBytes, 1, MANIFEST_LIMIT);
		const signed = snapshot(signature, 64, 64);
		if (isProxy(publicKey) || !isKeyObject(publicKey) || keyType?.call(publicKey) !== "public")
			refuse();
		const verificationKey = keyFrom(
			toCryptoKey.call(publicKey, { name: "Ed25519" }, true, ["verify"]),
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
