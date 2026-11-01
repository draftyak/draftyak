import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { PackageLock } from "../../src/artifacts/index.ts";

export interface TarEntry {
	name: string;
	body?: string | Uint8Array;
	type?: string;
	linkname?: string;
	prefix?: string;
	size?: number;
}

function text(header: Buffer, at: number, width: number, value: string): void {
	const bytes = Buffer.from(value, "ascii");
	if (bytes.length > width) throw new Error("fixture field is too long");
	bytes.copy(header, at);
}

function octal(header: Buffer, at: number, width: number, value: number): void {
	const digits = value.toString(8);
	if (!Number.isSafeInteger(value) || value < 0 || digits.length >= width) {
		throw new Error("fixture number is out of range");
	}
	text(header, at, width, `${digits.padStart(width - 1, "0")}\0`);
}

export function writeTarChecksum(header: Uint8Array): void {
	if (header.byteLength !== 512) throw new Error("fixture header must be 512 bytes");
	header.fill(32, 148, 156);
	let sum = 0;
	for (const byte of header) sum += byte;
	header.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `, "ascii"), 148);
}

/** Test-only USTAR encoder. Malformed headers are explicit mutations by each test. */
export function makeTar(
	entries: readonly TarEntry[],
	options: { zeroBlocks?: number; trailing?: Uint8Array } = {},
): Buffer {
	const chunks: Buffer[] = [];
	for (const entry of entries) {
		const body =
			typeof entry.body === "string" ? Buffer.from(entry.body) : Buffer.from(entry.body ?? []);
		const header = Buffer.alloc(512);
		text(header, 0, 100, entry.name);
		octal(header, 100, 8, entry.type === "5" ? 0o755 : 0o644);
		octal(header, 108, 8, 0);
		octal(header, 116, 8, 0);
		octal(header, 124, 12, entry.size ?? body.length);
		octal(header, 136, 12, 0);
		text(header, 156, 1, entry.type ?? "0");
		text(header, 157, 100, entry.linkname ?? "");
		text(header, 257, 6, "ustar\0");
		text(header, 263, 2, "00");
		text(header, 345, 155, entry.prefix ?? "");
		writeTarChecksum(header);
		chunks.push(header, body);
		if (body.length % 512 !== 0) chunks.push(Buffer.alloc(512 - (body.length % 512)));
	}
	chunks.push(Buffer.alloc(512 * (options.zeroBlocks ?? 2)));
	if (options.trailing !== undefined) chunks.push(Buffer.from(options.trailing));
	return Buffer.concat(chunks);
}

export function packageEntries(
	metadata: unknown = { name: "fixture-artifact", version: "1.2.3", type: "module" },
	extras: readonly TarEntry[] = [],
): TarEntry[] {
	return [
		{ name: "package/package.json", body: JSON.stringify(metadata) },
		{ name: "package/index.mjs", body: "export const fixture = 'DYTEST';\n" },
		...extras,
	];
}

export function makePinnedPackage(
	entries: readonly TarEntry[] = packageEntries(),
	lockOverrides: Partial<PackageLock> = {},
): { archive: Buffer; lock: PackageLock } {
	const archive = gzipSync(makeTar(entries));
	return {
		archive,
		lock: {
			name: "fixture-artifact",
			version: "1.2.3",
			integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
			entry: "index.mjs",
			...lockOverrides,
		},
	};
}
