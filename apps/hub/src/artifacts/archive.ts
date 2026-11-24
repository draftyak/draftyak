import { isArrayBuffer, isProxy, isUint8Array } from "node:util/types";
import { gunzipSync } from "node:zlib";
import { assertPortableFileTree, portableRelativePath } from "@draftyak/bounded-files";

export const MAX_ARCHIVE_BYTES: number = 32 * 1024 * 1024;
export const MAX_BUNDLE_BYTES: number = 64 * 1024 * 1024;
export const MAX_FILES = 1024;
export const MAX_FILE_BYTES: number = 16 * 1024 * 1024;
// Worst-case framing: per member a header block plus up to 511 padding bytes, and two end blocks.
const MAX_TAR_BYTES = MAX_BUNDLE_BYTES + MAX_FILES * (512 + 511) + 2 * 512;

export class ArtifactError extends Error {
	constructor() {
		super("Artifact verification refused.");
		this.name = "ArtifactError";
	}
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const backing = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const setBytes = Uint8Array.prototype.set;

/** Obtain a fixed ordinary backing view without consulting caller properties or iterators. */
function archiveView(raw: unknown): Uint8Array {
	if (isProxy(raw) || !isUint8Array(raw)) throw new ArtifactError();
	const length = byteLength?.call(raw) as number;
	const offset = byteOffset?.call(raw) as number;
	const buffer = backing?.call(raw) as ArrayBuffer;
	if (
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > MAX_ARCHIVE_BYTES ||
		!isArrayBuffer(buffer) ||
		resizable?.call(buffer)
	)
		throw new ArtifactError();
	return new Uint8Array(buffer, offset, length);
}

/** Own the exact selected bytes before consulting a pin or parsing an archive. */
export function snapshotArchive(raw: unknown): Buffer {
	try {
		const view = archiveView(raw);
		const result = Buffer.alloc(view.byteLength);
		setBytes.call(result, view);
		return result;
	} catch {
		throw new ArtifactError();
	}
}

export function portablePath(raw: unknown): string {
	try {
		const value = portableRelativePath(raw, {
			maximumLength: 200,
			maximumComponents: 16,
			maximumComponentLength: 200,
		});
		for (const component of value.split("/")) {
			if (/^[A-Za-z0-9_@+-][A-Za-z0-9_@.+-]*$/.exec(component)?.[0] !== component)
				throw new ArtifactError();
		}
		return value;
	} catch {
		throw new ArtifactError();
	}
}

function field(bytes: Buffer): string {
	const zero = bytes.indexOf(0);
	const used = zero < 0 ? bytes : bytes.subarray(0, zero);
	if (
		used.some((byte) => byte < 32 || byte > 126) ||
		(zero >= 0 && bytes.subarray(zero).some((byte) => byte !== 0))
	)
		throw new ArtifactError();
	return used.toString("ascii");
}

function octal(bytes: Buffer, empty = false): number {
	let start = 0;
	let end = bytes.length;
	while (start < end && bytes[start] === 32) start++;
	while (end > start && (bytes[end - 1] === 0 || bytes[end - 1] === 32)) end--;
	if (start === end) {
		if (empty) return 0;
		throw new ArtifactError();
	}
	const used = bytes.subarray(start, end);
	if (used.some((byte) => byte < 48 || byte > 55)) throw new ArtifactError();
	const value = Number.parseInt(used.toString("ascii"), 8);
	if (!Number.isSafeInteger(value)) throw new ArtifactError();
	return value;
}

/** Structural npm TAR decoding only; selection and materialization belong to consumers. */
export function unpackTarball(raw: Uint8Array): ReadonlyMap<string, Buffer> {
	try {
		const tar = gunzipSync(archiveView(raw), { maxOutputLength: MAX_TAR_BYTES });
		if (tar.length % 512 !== 0) throw new ArtifactError();
		const files = new Map<string, Buffer>();
		const entries = new Set<string>();
		const roles = new Map<string, { spelling: string; file: boolean }>();
		let offset = 0;
		let headers = 0;
		let total = 0;
		let ended = false;
		while (offset + 512 <= tar.length) {
			const head = tar.subarray(offset, offset + 512);
			offset += 512;
			if (head.every((byte) => byte === 0)) {
				if (offset + 512 > tar.length || tar.subarray(offset).some((byte) => byte !== 0))
					throw new ArtifactError();
				ended = true;
				break;
			}
			if (++headers > MAX_FILES || head.some((byte) => byte > 127)) throw new ArtifactError();
			const checksum = octal(head.subarray(148, 156));
			const actual = head.reduce(
				(sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
				0,
			);
			if (checksum !== actual) throw new ArtifactError();
			const magic = field(head.subarray(257, 263));
			const version = field(head.subarray(263, 265));
			if (!((magic === "ustar" && version === "00") || (magic === "" && version === "")))
				throw new ArtifactError();
			const prefix = field(head.subarray(345, 500));
			if (magic === "" && prefix !== "") throw new ArtifactError();
			const name = (prefix ? `${prefix}/` : "") + field(head.subarray(0, 100));
			const type = head[156];
			if (![0, 48, 53].includes(type ?? -1) || field(head.subarray(157, 257)) !== "")
				throw new ArtifactError();
			for (const [start, end] of [
				[100, 108],
				[108, 116],
				[116, 124],
				[136, 148],
			])
				octal(head.subarray(start, end), true);
			field(head.subarray(265, 297));
			field(head.subarray(297, 329));
			if (
				octal(head.subarray(329, 337), true) !== 0 ||
				octal(head.subarray(337, 345), true) !== 0 ||
				head.subarray(500).some((byte) => byte !== 0)
			)
				throw new ArtifactError();
			const size = octal(head.subarray(124, 136));
			const paddedEnd = offset + Math.ceil(size / 512) * 512;
			if (size > MAX_FILE_BYTES || paddedEnd > tar.length || (type === 53 && size !== 0))
				throw new ArtifactError();
			if (tar.subarray(offset + size, paddedEnd).some((byte) => byte !== 0))
				throw new ArtifactError();
			if (type !== 53 && name.endsWith("/")) throw new ArtifactError();
			const relative = type === 53 && name.endsWith("/") ? name.slice(0, -1) : name;
			if (relative !== "package" && !relative.startsWith("package/")) throw new ArtifactError();
			const local = relative === "package" ? "" : portablePath(relative.slice(8));
			const folded = local.toLowerCase();
			if (entries.has(folded) || (local === "" && type !== 53)) throw new ArtifactError();
			entries.add(folded);
			if (local !== "") {
				const parts = local.split("/");
				for (let count = 1; count <= parts.length; count++) {
					const spelling = parts.slice(0, count).join("/");
					const file = count === parts.length && type !== 53;
					const previous = roles.get(spelling.toLowerCase());
					if (previous && (previous.spelling !== spelling || previous.file || file))
						throw new ArtifactError();
					if (!previous) roles.set(spelling.toLowerCase(), { spelling, file });
				}
			}
			if (type !== 53) {
				total += size;
				if (total > MAX_BUNDLE_BYTES) throw new ArtifactError();
				// A pooled copy would share its backing store with unrelated buffers.
				const bytes = Buffer.alloc(size);
				tar.copy(bytes, 0, offset, offset + size);
				files.set(local, bytes);
			}
			offset = paddedEnd;
		}
		if (!ended || files.size === 0) throw new ArtifactError();
		assertPortableFileTree([...files.keys()]);
		return files;
	} catch {
		throw new ArtifactError();
	}
}
