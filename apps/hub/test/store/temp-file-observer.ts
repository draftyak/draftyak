import {
	type BigIntStats,
	closeSync,
	Dir,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";

export const MAX_DESCRIPTOR_ENTRIES = 256;
export const MAX_SCAN_FILES = 32;
export const MAX_FILE_BYTES: number = 16 * 1024 * 1024;
export const MAX_SCAN_BYTES: number = 64 * 1024 * 1024;
export const SCAN_CHUNK_BYTES: number = 64 * 1024;

export interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}
export interface ScanNeedle {
	readonly label: string;
	readonly value: Buffer;
}
export interface TempFileScan {
	readonly files: number;
	readonly bytes: number;
	readonly hits: string[];
}

const refuse = (): never => {
	throw new Error("Temporary-file observation refused");
};
const readDirectory = Dir.prototype.readSync;
const closeDirectory = Dir.prototype.closeSync;

/** Selected platforms must execute their native assertion, even if discovery is unavailable. */
export function tempFileScanSupported(platform: string): boolean {
	return platform === "win32" || platform === "linux" || platform === "darwin";
}

export function descriptorNumber(name: string): number {
	if (/^(?:0|[1-9][0-9]{0,9})$/.exec(name)?.[0] !== name) return refuse();
	const value = Number(name);
	if (!Number.isSafeInteger(value) || value > 2 ** 31 - 1) return refuse();
	return value;
}

function identity(info: FileIdentity): string {
	if (info.dev < 0n || info.ino <= 0n) return refuse();
	return `${info.dev}:${info.ino}`;
}

/** Exclude only the fixture's actual database, WAL and SHM identities, not pathname prefixes. */
export function databaseFileIdentities(filename: string): readonly FileIdentity[] {
	return ["", "-wal", "-shm"].flatMap((suffix) => {
		try {
			const info = lstatSync(`${filename}${suffix}`, { bigint: true });
			if (!info.isFile() || info.isSymbolicLink()) return refuse();
			identity(info);
			return [{ dev: info.dev, ino: info.ino }];
		} catch (error) {
			if (suffix !== "" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
			return refuse();
		}
	});
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.mode === after.mode &&
		before.nlink === after.nlink &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	);
}

function scanner(needles: readonly ScanNeedle[]) {
	if (
		needles.length === 0 ||
		needles.length > 8 ||
		needles.some(
			(needle) =>
				!Buffer.isBuffer(needle.value) || needle.value.length === 0 || needle.value.length > 128,
		)
	)
		return refuse();
	const overlap = Math.max(...needles.map((needle) => needle.value.length)) - 1;
	const hits = new Set<string>();
	let files = 0;
	let bytes = 0;
	return {
		read(fd: number, before: BigIntStats): void {
			identity(before);
			if (!before.isFile() || before.size < 0n || before.size > BigInt(MAX_FILE_BYTES)) refuse();
			if (++files > MAX_SCAN_FILES) refuse();
			const size = Number(before.size);
			if (bytes + size > MAX_SCAN_BYTES) refuse();
			const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
			let position = 0;
			let tail: Buffer = Buffer.alloc(0);
			while (position < size) {
				// Explicit positions preserve SQLite's shared open-file-description offset.
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
				if (count <= 0) refuse();
				position += count;
				const window = Buffer.concat([tail, buffer.subarray(0, count)]);
				for (const needle of needles) if (window.includes(needle.value)) hits.add(needle.label);
				tail = window.subarray(Math.max(0, window.length - overlap));
			}
			if (readSync(fd, buffer, 0, 1, size) !== 0) refuse();
			if (!unchanged(before, fstatSync(fd, { bigint: true }))) refuse();
			bytes += position;
		},
		result(): TempFileScan {
			return { files, bytes, hits: [...hits].sort() };
		},
	};
}

/** Borrow descriptors in this isolated process; never reopen, close or seek them. */
export function scanRegularDescriptors(
	descriptors: Iterable<number>,
	excluded: readonly FileIdentity[],
	needles: readonly ScanNeedle[],
): TempFileScan {
	if (excluded.length > 3) return refuse();
	const excludedIds = new Set(excluded.map(identity));
	const observed = new Set<string>();
	const seen = new Set<number>();
	const scan = scanner(needles);
	let entries = 0;
	for (const fd of descriptors) {
		if (
			++entries > MAX_DESCRIPTOR_ENTRIES ||
			!Number.isSafeInteger(fd) ||
			fd < 0 ||
			fd > 2 ** 31 - 1 ||
			seen.has(fd)
		)
			return refuse();
		seen.add(fd);
		const info = fstatSync(fd, { bigint: true });
		if (!info.isFile()) continue;
		const key = identity(info);
		if (excludedIds.has(key)) continue;
		// Multiple handles to one live temporary file count and scan that identity once.
		if (observed.has(key)) continue;
		observed.add(key);
		scan.read(fd, info);
	}
	return scan.result();
}

export function scanDescriptorDirectory(
	directory: string,
	excluded: readonly FileIdentity[],
	needles: readonly ScanNeedle[],
): TempFileScan {
	const reader = opendirSync(directory);
	try {
		function* descriptors(): Generator<number> {
			for (let entry = readDirectory.call(reader); entry; entry = readDirectory.call(reader))
				yield descriptorNumber(entry.name);
		}
		// Keep the directory descriptor live until every listed descriptor is classified/read.
		return scanRegularDescriptors(descriptors(), excluded, needles);
	} finally {
		closeDirectory.call(reader);
	}
}

/** Windows paths and Linux's existing live /proc targets retain bounded, owned reads. */
export function scanNamedFiles(
	names: readonly string[],
	needles: readonly ScanNeedle[],
): TempFileScan {
	if (names.length > MAX_SCAN_FILES) return refuse();
	const scan = scanner(needles);
	for (const name of names) {
		const before = statSync(name, { bigint: true });
		const fd = openSync(name, "r");
		try {
			const opened = fstatSync(fd, { bigint: true });
			if (!unchanged(before, opened)) return refuse();
			scan.read(fd, opened);
			if (!unchanged(opened, statSync(name, { bigint: true }))) return refuse();
		} finally {
			closeSync(fd);
		}
	}
	return scan.result();
}
