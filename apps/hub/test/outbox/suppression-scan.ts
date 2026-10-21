import { isUtf8 } from "node:buffer";
import fs, { type BigIntStats } from "node:fs";
import path from "node:path";

export const OUTBOX_SCAN_LIMITS: Readonly<{
	fileBytes: number;
	totalBytes: number;
	files: number;
	entries: number;
	depth: number;
}> = Object.freeze({
	// Biome skips a file of files.maxSize (1 MiB) bytes or more, so the scan stops one byte short.
	fileBytes: 1_048_575,
	totalBytes: 8_388_608,
	files: 512,
	entries: 2_048,
	depth: 16,
});

export interface OutboxSourceInventory {
	readonly rootPresent: boolean;
	readonly files: readonly string[];
	readonly bytes: number;
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const forbidden = Buffer.from("biome-ignore");
// Entries Biome would skip or reconfigure below the outbox: names the root .gitignore matches
// (VCS ignores outrank files.includes), nested Biome configuration and ignore files.
export const SKIPPED_NAME: RegExp =
	/^(?:node_modules|\.turbo|\.vitest|\.cache|dist|target|\.gradle|build|gen|binaries|local\.properties|biome\.jsonc?|\.gitignore|\.ignore)$|^\.env|\.(?:log|apk|aab|jks|keystore|tsbuildinfo)$/i;

function refuse(): never {
	throw new Error("Outbox suppression scan refused");
}

function same(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function safeName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 255 &&
		name !== "." &&
		name !== ".." &&
		name.isWellFormed() &&
		name.normalize("NFC") === name &&
		![...name].some((character) => character.charCodeAt(0) < 32 || character === "\x7f") &&
		!/[/\\:<>"|?*]/.test(name) &&
		!/[. ]$/.test(name) &&
		!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
	);
}

// Non-JavaScript/TypeScript regular files count toward traversal bounds but are not read.
// The inventory is a static slip guard, not scheduler or filesystem authority.
export function assertOutboxSuppressions(
	directory: string,
	options: { readonly allowMissingRoot?: boolean } = {},
): OutboxSourceInventory {
	try {
		if (
			typeof directory !== "string" ||
			directory.length > 4_096 ||
			!directory.isWellFormed() ||
			directory.includes("\0") ||
			!path.isAbsolute(directory) ||
			path.resolve(directory) !== directory ||
			path.basename(directory) !== "outbox" ||
			(process.platform === "win32" &&
				(!/^[a-z]:\\/i.test(directory) || directory.includes("/"))) ||
			(options.allowMissingRoot !== undefined && typeof options.allowMissingRoot !== "boolean")
		)
			refuse();
		const parent = path.dirname(directory);
		const parentBefore = fs.lstatSync(parent, { bigint: true });
		if (
			!parentBefore.isDirectory() ||
			parentBefore.isSymbolicLink() ||
			fs.realpathSync.native(parent) !== parent
		)
			refuse();
		let root: BigIntStats;
		try {
			root = fs.lstatSync(directory, { bigint: true });
		} catch (error) {
			if (
				!options.allowMissingRoot ||
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT" ||
				!same(parentBefore, fs.lstatSync(parent, { bigint: true }))
			)
				refuse();
			// Only this already-validated top-level installation absence is allowed.
			try {
				fs.lstatSync(directory);
			} catch (confirmation) {
				if (
					confirmation instanceof Error &&
					"code" in confirmation &&
					confirmation.code === "ENOENT" &&
					same(parentBefore, fs.lstatSync(parent, { bigint: true })) &&
					fs.realpathSync.native(parent) === parent
				)
					return Object.freeze({ rootPresent: false, files: Object.freeze([]), bytes: 0 });
			}
			refuse();
		}
		if (
			!root.isDirectory() ||
			root.isSymbolicLink() ||
			fs.realpathSync.native(directory) !== directory
		)
			refuse();
		const files: string[] = [];
		let bytes = 0;
		let entries = 0;
		const readSource = (filename: string, before: BigIntStats): void => {
			if (
				before.nlink !== 1n ||
				before.ino === 0n ||
				before.size < 0n ||
				before.size > BigInt(OUTBOX_SCAN_LIMITS.fileBytes) ||
				bytes + Number(before.size) > OUTBOX_SCAN_LIMITS.totalBytes ||
				files.length >= OUTBOX_SCAN_LIMITS.files
			)
				refuse();
			const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
			try {
				const opened = fs.fstatSync(fd, { bigint: true });
				if (!opened.isFile() || !same(before, opened)) refuse();
				const content = Buffer.alloc(Number(before.size) + 1);
				let used = 0;
				while (used < content.length) {
					const count = fs.readSync(fd, content, used, content.length - used, used);
					if (count === 0) break;
					used += count;
				}
				if (
					used !== Number(before.size) ||
					!isUtf8(content.subarray(0, used)) ||
					content.subarray(0, used).includes(0) ||
					content.subarray(0, used).includes(forbidden) ||
					!same(before, fs.fstatSync(fd, { bigint: true })) ||
					!same(before, fs.lstatSync(filename, { bigint: true }))
				)
					refuse();
				bytes += used;
				files.push(path.relative(directory, filename).split(path.sep).join("/"));
			} finally {
				fs.closeSync(fd);
			}
		};
		const visit = (current: string, depth: number): void => {
			if (depth > OUTBOX_SCAN_LIMITS.depth || current.length > 4_096) refuse();
			const before = fs.lstatSync(current, { bigint: true });
			if (!before.isDirectory() || before.isSymbolicLink()) refuse();
			const dir = fs.opendirSync(current);
			const names: string[] = [];
			const folded = new Set<string>();
			try {
				for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
					if (
						++entries > OUTBOX_SCAN_LIMITS.entries ||
						!safeName(entry.name) ||
						SKIPPED_NAME.test(entry.name)
					)
						refuse();
					const key = entry.name.toLowerCase();
					if (folded.has(key)) refuse();
					folded.add(key);
					names.push(entry.name);
				}
			} finally {
				dir.closeSync();
			}
			for (const name of names.sort()) {
				const filename = path.join(current, name);
				if (filename.length > 4_096) refuse();
				const info = fs.lstatSync(filename, { bigint: true });
				if (info.isSymbolicLink()) refuse();
				if (info.isDirectory()) visit(filename, depth + 1);
				else if (info.isFile()) {
					if (sourceExtension.test(name)) readSource(filename, info);
				} else refuse();
			}
			if (!same(before, fs.lstatSync(current, { bigint: true }))) refuse();
		};
		visit(directory, 0);
		if (!same(root, fs.lstatSync(directory, { bigint: true }))) refuse();
		return Object.freeze({ rootPresent: true, files: Object.freeze(files.sort()), bytes });
	} catch {
		refuse();
	}
}
