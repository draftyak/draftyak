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
import { buildTempFileDirectory, type TempFileDirectory } from "./temp-file-directory.ts";

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

export type TempFileRefusalCategory =
	| "bounds"
	| "descriptor"
	| "discovery"
	| "identity"
	| "metadata"
	| "read"
	| "unexpected-regular-file"
	| "unknown";
export type TempFileScanStage = "operation" | "baseline" | "active";
export type TempFileDiscoveryOperation = "open" | "read" | "name" | "close";
const DISCOVERY_READ_CODES = [
	"EACCES",
	"EAGAIN",
	"EBADF",
	"EBUSY",
	"EFAULT",
	"EINTR",
	"EINVAL",
	"EIO",
	"EISDIR",
	"ELOOP",
	"EMFILE",
	"ENAMETOOLONG",
	"ENFILE",
	"ENOENT",
	"ENOMEM",
	"ENOSYS",
	"ENOTDIR",
	"ENOTSUP",
	"EPERM",
	"ESTALE",
	"ERR_DIR_CLOSED",
	"ERR_DIR_CONCURRENT_OPERATION",
] as const;
type DiscoveryReadCode = (typeof DISCOVERY_READ_CODES)[number] | "other";
interface Refusal {
	readonly category: TempFileRefusalCategory;
	readonly discovery?: TempFileDiscoveryOperation;
	readonly discoveryReadCode?: DiscoveryReadCode;
	readonly discoveryReadAttempt?: number;
}
const failures = new WeakMap<object, Refusal>();
const refuse = (
	category: Exclude<TempFileRefusalCategory, "unknown">,
	discovery?: TempFileDiscoveryOperation,
	read?: { readonly code: DiscoveryReadCode; readonly attempt: number },
): never => {
	const error = new Error("Temporary-file observation refused");
	failures.set(error, {
		category,
		...(discovery === undefined ? {} : { discovery }),
		...(read === undefined
			? {}
			: { discoveryReadCode: read.code, discoveryReadAttempt: read.attempt }),
	});
	throw error;
};
function discoveryReadCode(error: unknown): DiscoveryReadCode {
	try {
		const descriptor =
			error !== null && (typeof error === "object" || typeof error === "function")
				? Object.getOwnPropertyDescriptor(error, "code")
				: undefined;
		let value: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
		if (value === "DYFD_READ") {
			const syscall = Object.getOwnPropertyDescriptor(error, "syscallCode");
			value = syscall && "value" in syscall ? syscall.value : undefined;
		}
		if ((DISCOVERY_READ_CODES as readonly unknown[]).includes(value))
			return value as DiscoveryReadCode;
	} catch {
		// A hostile property descriptor still yields a fixed fatal diagnostic.
	}
	return "other";
}
function classified(error: unknown): Refusal {
	const known =
		error !== null && (typeof error === "object" || typeof error === "function")
			? failures.get(error)
			: undefined;
	return known ?? { category: "unknown" };
}
function observe<T>(
	category: Exclude<TempFileRefusalCategory, "unknown">,
	operation: () => T,
	discovery?: TempFileDiscoveryOperation,
): T {
	try {
		return operation();
	} catch (error) {
		if (classified(error).category !== "unknown") throw error;
		return refuse(category, discovery);
	}
}
/** Only fixed labels and bounded enumeration counts reach the child's refusal diagnostic. */
export function tempFileDiagnostic(
	error: unknown,
	stage: unknown,
): Refusal & { stage: TempFileScanStage } {
	return {
		stage: stage === "baseline" || stage === "active" ? stage : "operation",
		...classified(error),
	};
}
const PROBE_PHASES = [
	"input",
	"open",
	"abort-control",
	"memory-setting",
	"memory-sort",
	"memory-statement",
	"memory-table",
	"file-setting",
	"file-sort",
	"file-statement",
	"file-table",
	"file-positives",
	"cleanup",
] as const;
interface TempFileOperations {
	readonly sort: TempFileScan;
	readonly statement: TempFileScan;
	readonly table: TempFileScan;
}
/** Shared with the child stderr boundary; unfinished observations stay absent. */
export function tempFileFailureReport(
	phase: unknown,
	diagnostic: ReturnType<typeof tempFileDiagnostic> | undefined,
	memory?: TempFileOperations,
	file?: TempFileOperations,
): string {
	return JSON.stringify({
		phase: (PROBE_PHASES as readonly unknown[]).includes(phase) ? phase : "input",
		refused: true,
		...diagnostic,
		memory,
		file,
	});
}
export function requireEmptyTempFileScan(scan: TempFileScan): void {
	if (scan.files !== 0 || scan.bytes !== 0 || scan.hits.length !== 0)
		refuse("unexpected-regular-file");
}
const readDirectory = Dir.prototype.readSync;
const closeDirectory = Dir.prototype.closeSync;

/** The selected Darwin fixture builds its visible names-only addon before the first baseline. */
export function prepareTempFileDirectory(root: string): TempFileDirectory {
	return observe("discovery", () => buildTempFileDirectory(root), "open");
}

/** Selected platforms must execute their native assertion, even if discovery is unavailable. */
export function tempFileScanSupported(platform: string): boolean {
	return platform === "win32" || platform === "linux" || platform === "darwin";
}

export function descriptorNumber(name: string): number {
	if (/^(?:0|[1-9][0-9]{0,9})$/.exec(name)?.[0] !== name) return refuse("discovery", "name");
	const value = Number(name);
	if (!Number.isSafeInteger(value) || value > 2 ** 31 - 1) return refuse("discovery", "name");
	return value;
}

function identity(info: FileIdentity): string {
	if (info.dev < 0n || info.ino <= 0n) return refuse("identity");
	return `${info.dev}:${info.ino}`;
}

/** Exclude only the fixture's actual database, WAL and SHM identities, not pathname prefixes. */
export function databaseFileIdentities(filename: string): readonly FileIdentity[] {
	return ["", "-wal", "-shm"].flatMap((suffix) => {
		try {
			const info = lstatSync(`${filename}${suffix}`, { bigint: true });
			if (!info.isFile() || info.isSymbolicLink()) return refuse("identity");
			identity(info);
			return [{ dev: info.dev, ino: info.ino }];
		} catch (error) {
			if (suffix !== "" && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
			return refuse("identity");
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
		return refuse("bounds");
	const overlap = Math.max(...needles.map((needle) => needle.value.length)) - 1;
	const hits = new Set<string>();
	let files = 0;
	let bytes = 0;
	return {
		read(fd: number, before: BigIntStats): void {
			identity(before);
			if (!before.isFile()) refuse("metadata");
			if (before.size < 0n || before.size > BigInt(MAX_FILE_BYTES)) refuse("bounds");
			if (++files > MAX_SCAN_FILES) refuse("bounds");
			const size = Number(before.size);
			if (bytes + size > MAX_SCAN_BYTES) refuse("bounds");
			const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
			let position = 0;
			let tail: Buffer = Buffer.alloc(0);
			while (position < size) {
				// Explicit positions preserve SQLite's shared open-file-description offset.
				const count = observe("read", () =>
					readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position),
				);
				if (count <= 0) refuse("read");
				position += count;
				const window = Buffer.concat([tail, buffer.subarray(0, count)]);
				for (const needle of needles) if (window.includes(needle.value)) hits.add(needle.label);
				tail = window.subarray(Math.max(0, window.length - overlap));
			}
			if (observe("read", () => readSync(fd, buffer, 0, 1, size)) !== 0) refuse("read");
			if (
				!unchanged(
					before,
					observe("descriptor", () => fstatSync(fd, { bigint: true })),
				)
			)
				refuse("metadata");
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
	if (excluded.length > 3) return refuse("bounds");
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
			return refuse("bounds");
		seen.add(fd);
		const info = observe("descriptor", () => fstatSync(fd, { bigint: true }));
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
	raw?: TempFileDirectory,
): TempFileScan {
	return observe("discovery", () => {
		if ((directory === "/dev/fd") !== (raw !== undefined)) return refuse("discovery", "open");
		const useNative = raw !== undefined;
		const reader = observe(
			"discovery",
			() => {
				if (useNative && raw) {
					const handle = raw.open();
					return { read: () => raw.read(handle), close: () => raw.close(handle) };
				}
				const handle = opendirSync(directory);
				return {
					read: () => readDirectory.call(handle),
					close: () => closeDirectory.call(handle),
				};
			},
			"open",
		);
		let outcome: { passed: true; scan: TempFileScan } | { passed: false; error: unknown };
		try {
			function* descriptors(): Generator<number> {
				let readAttempt = 0;
				const next = () => {
					if (++readAttempt > MAX_DESCRIPTOR_ENTRIES + 1) return refuse("bounds");
					try {
						return reader.read();
					} catch (error) {
						if (classified(error).category !== "unknown") throw error;
						return refuse("discovery", "read", {
							code: discoveryReadCode(error),
							attempt: readAttempt,
						});
					}
				};
				for (let entry = next(); entry; entry = next()) yield descriptorNumber(entry.name);
			}
			// Keep the directory descriptor live until every listed descriptor is classified/read.
			outcome = { passed: true, scan: scanRegularDescriptors(descriptors(), excluded, needles) };
		} catch (error) {
			outcome = { passed: false, error };
		}
		try {
			observe("discovery", () => reader.close(), "close");
		} catch (error) {
			// Cleanup failure remains fatal after success; it must not replace the primary refusal.
			if (outcome.passed) outcome = { passed: false, error };
		}
		if (!outcome.passed) throw outcome.error;
		return outcome.scan;
	});
}

/** Windows paths and Linux's existing live /proc targets retain bounded, owned reads. */
export function scanNamedFiles(
	names: readonly string[],
	needles: readonly ScanNeedle[],
): TempFileScan {
	if (names.length > MAX_SCAN_FILES) return refuse("bounds");
	const scan = scanner(needles);
	for (const name of names) {
		const before = observe("metadata", () => statSync(name, { bigint: true }));
		const fd = observe("descriptor", () => openSync(name, "r"));
		try {
			const opened = observe("descriptor", () => fstatSync(fd, { bigint: true }));
			if (!unchanged(before, opened)) return refuse("metadata");
			scan.read(fd, opened);
			if (
				!unchanged(
					opened,
					observe("metadata", () => statSync(name, { bigint: true })),
				)
			)
				return refuse("metadata");
		} finally {
			observe("descriptor", () => closeSync(fd));
		}
	}
	return scan.result();
}
