import { gunzipSync } from "node:zlib";
import { relative } from "./integrity.ts";

const MAX = 256 * 1024 * 1024;
// Include directory headers in the work budget, independently of payload bytes.
// This leaves room for a 20,000-file bundle inventory and its usual directories.
const MAX_ENTRIES = 40_000;

function string(block: Buffer, start: number, size: number): string {
	const field = block.subarray(start, start + size);
	const end = field.indexOf(0);
	const bytes = end < 0 ? field : field.subarray(0, end);
	const result = bytes.toString("utf8");
	if (!Buffer.from(result).equals(bytes)) throw new Error("non-UTF-8 tar field");
	return result;
}

function octal(block: Buffer, start: number, size: number): number {
	const field = string(block, start, size).trim();
	if (!/^[0-7]+$/.test(field)) throw new Error("invalid tar numeric field");
	const value = Number.parseInt(field, 8);
	if (!Number.isSafeInteger(value) || value > MAX) throw new Error("tar numeric limit exceeded");
	return value;
}

// Deliberately accepts only regular ustar files/directories. PAX/GNU/link/device entries fail.
export function unpack(bytes: Uint8Array): Map<string, Buffer> {
	const tar = gunzipSync(bytes, { maxOutputLength: MAX });
	if (tar.length % 512 !== 0) throw new Error("truncated tar blocks");
	const files = new Map<string, Buffer>();
	const seen = new Set<string>();
	const kinds = new Map<string, string>();
	const ancestors = new Set<string>();
	let entries = 0;
	let ended = false;
	for (let position = 0; position < tar.length; ) {
		const header = tar.subarray(position, position + 512);
		if (header.every((byte) => byte === 0)) {
			if (tar.length - position < 1024 || !tar.subarray(position).every((byte) => byte === 0)) {
				throw new Error("invalid tar end blocks");
			}
			ended = true;
			break;
		}
		if (++entries > MAX_ENTRIES) throw new Error("tar entry limit exceeded");
		const checksum = octal(header, 148, 8);
		const sum = header.reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
		if (checksum !== sum) throw new Error("tar header checksum mismatch");
		if (string(header, 257, 6) !== "ustar") throw new Error("unsupported tar format");
		const prefix = string(header, 345, 155);
		const name = string(header, 0, 100);
		const combined = prefix ? `${prefix}/${name}` : name;
		const kind = String.fromCharCode(header[156] ?? 0);
		const file = relative(
			kind === "5" && combined.endsWith("/") ? combined.slice(0, -1) : combined,
		);
		if (file !== "package" && !file.startsWith("package/"))
			throw new Error("tar entry outside package/");
		if (seen.has(file.toLowerCase())) throw new Error(`duplicate tar entry: ${file}`);
		seen.add(file.toLowerCase());
		if (kind !== "0" && kind !== "\0" && kind !== "5")
			throw new Error(`tar entry type refused: ${file}`);
		const folded = file.toLowerCase();
		const parts = folded.split("/");
		for (let count = 1; count < parts.length; count++) {
			const ancestor = parts.slice(0, count).join("/");
			const parent = kinds.get(ancestor);
			if (parent && parent !== "5") throw new Error(`tar parent is a file: ${file}`);
			ancestors.add(ancestor);
		}
		if (kind !== "5" && ancestors.has(folded)) {
			throw new Error(`tar file overlaps a directory: ${file}`);
		}
		kinds.set(folded, kind);
		if (string(header, 157, 100)) throw new Error(`tar link target refused: ${file}`);
		const size = octal(header, 124, 12);
		if (kind === "5" && size !== 0) throw new Error("tar directory has payload");
		position += 512;
		if (position + size > tar.length) throw new Error("truncated tar payload");
		if (kind !== "5") files.set(file, tar.subarray(position, position + size));
		const padded = Math.ceil(size / 512) * 512;
		if (!tar.subarray(position + size, position + padded).every((byte) => byte === 0)) {
			throw new Error("nonzero tar padding");
		}
		position += padded;
	}
	if (!ended || files.size === 0) throw new Error("missing tar files or end blocks");
	return files;
}
