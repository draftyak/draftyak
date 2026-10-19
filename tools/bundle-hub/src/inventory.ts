import { createHash } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
} from "node:fs";
import path from "node:path";
import { secrets } from "../../vendor-guard/rules/secrets.ts";
import { lineHits, type PatternRule } from "../../vendor-guard/src/rules.ts";

export interface FileRecord {
	readonly path: string;
	readonly sha256: string;
	readonly bytes: number;
}

export interface Inventory {
	readonly schemaVersion: 1;
	readonly files: readonly FileRecord[];
}

export const digest = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

export function object(
	value: unknown,
	keys: readonly string[],
	label: string,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label}: expected an object`);
	}
	if (Object.keys(value).some((key) => !keys.includes(key))) {
		throw new Error(`${label}: unexpected field`);
	}
	return value as Record<string, unknown>;
}

export function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label}: expected text`);
	return value;
}

// JSON.parse accepts duplicate keys. Refuse them (escaped spellings included) in reviewed inputs.
export function jsonValue(source: string): unknown {
	let result: unknown;
	try {
		result = JSON.parse(source);
	} catch {
		throw new Error("invalid JSON input");
	}
	const stack: { keys: Set<string>; array: boolean; key: boolean }[] = [];
	for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g)) {
		const token = match[0];
		const top = stack.at(-1);
		if (token === "{" || token === "[") {
			if (stack.length >= 64) throw new Error("JSON nesting limit exceeded");
			stack.push({ keys: new Set(), array: token === "[", key: token === "{" });
		} else if (token === "}" || token === "]") stack.pop();
		else if (top && !top.array) {
			if (token === ":") top.key = false;
			else if (token === ",") top.key = true;
			else if (token.startsWith('"') && top.key) {
				const key: string = JSON.parse(token);
				if (top.keys.has(key)) throw new Error("duplicate JSON key");
				top.keys.add(key);
			}
		}
	}
	return result;
}

// Restrict names to a portable subset; reject aliases, device files, ADS and state/secret files.
export function relativeFile(value: unknown): string {
	const file = text(value, "file path");
	if (
		file.length > 240 ||
		file
			.split("/")
			.some(
				(part) =>
					!/^[@A-Za-z0-9_.+-]+$/.test(part) ||
					part === "." ||
					part === ".." ||
					part.endsWith(".") ||
					/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) ||
					/^\.env|^\.git$|\.(?:key|p12|pfx|db|sqlite|sqlite3|log)$/i.test(part),
			)
	) {
		throw new Error("unsafe or private-state file path");
	}
	return file;
}

export function records(value: unknown): readonly FileRecord[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 20_000) {
		throw new Error("inventory: expected 1 to 20000 files");
	}
	const seen = new Set<string>();
	const files = value.map((item) => {
		const row = object(item, ["path", "sha256", "bytes"], "inventory record");
		const file = relativeFile(row.path);
		const hash = text(row.sha256, "SHA-256");
		if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("inventory: invalid SHA-256");
		if (
			!Number.isSafeInteger(row.bytes) ||
			Number(row.bytes) < 0 ||
			Number(row.bytes) > 512 << 20
		) {
			throw new Error("inventory: invalid byte count");
		}
		const key = file.toLowerCase();
		if (seen.has(key)) throw new Error("inventory: duplicate or case-aliased path");
		seen.add(key);
		return { path: file, sha256: hash, bytes: Number(row.bytes) };
	});
	for (const file of files) {
		const parts = file.path.toLowerCase().split("/");
		parts.pop();
		while (parts.length > 0) {
			if (seen.has(parts.join("/"))) throw new Error("inventory: file is also a directory");
			parts.pop();
		}
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function noLinks(file: string): void {
	const absolute = path.resolve(file);
	if (file.startsWith("\\\\") || file.startsWith("//") || absolute.startsWith("\\\\")) {
		throw new Error("network shares and device paths are not bundle inputs");
	}
	const parsed = path.parse(absolute);
	let cursor = parsed.root;
	for (const part of absolute.slice(cursor.length).split(path.sep)) {
		if (/^\.env/i.test(part)) throw new Error("environment files are never bundle inputs");
		cursor = path.join(cursor, part);
		if (lstatSync(cursor).isSymbolicLink()) throw new Error("input or output path contains a link");
	}
}

const MAX_FILE_BYTES = 512 * 1024 * 1024;
let closeUncertain = false;
function readerReady(): void {
	if (closeUncertain) throw new Error("file close is uncertain; restart the process");
}
function closeFile(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// A thrown numeric close may already have closed/reused the descriptor.
		closeUncertain = true;
		throw new Error("file close is uncertain; restart the process");
	}
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
	return (
		a.isFile() &&
		b.isFile() &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.nlink === b.nlink &&
		a.mode === b.mode &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

// One held descriptor, one bounded allocation and a one-byte growth probe.
export function regularBytes(file: string, maximum = MAX_FILE_BYTES): Buffer {
	readerReady();
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_FILE_BYTES)
		throw new Error("invalid file byte limit");
	noLinks(file);
	const before = lstatSync(file, { bigint: true });
	if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) {
		throw new Error("input must be a bounded regular file with no hard-link aliases");
	}
	readerReady();
	const fd = openSync(
		file,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
	);
	try {
		const held = fstatSync(fd, { bigint: true });
		if (!sameFile(before, held)) {
			throw new Error("input changed while opening it");
		}
		const bytes = Buffer.allocUnsafe(Number(held.size));
		let offset = 0;
		while (offset < bytes.length) {
			const wanted = Math.min(64 * 1024, bytes.length - offset);
			const count = readSync(fd, bytes, offset, wanted, offset);
			if (count < 1 || count > wanted) throw new Error("input changed while reading it");
			offset += count;
		}
		if (readSync(fd, Buffer.allocUnsafe(1), 0, 1, offset) !== 0)
			throw new Error("input changed while reading it");
		const after = fstatSync(fd, { bigint: true });
		noLinks(file);
		if (!sameFile(held, after) || !sameFile(after, lstatSync(file, { bigint: true }))) {
			throw new Error("input changed while reading it");
		}
		return bytes;
	} finally {
		closeFile(fd);
	}
}

export function checkBytes(row: FileRecord, bytes: Buffer): void {
	if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) {
		throw new Error(`inventory mismatch: ${row.path}`);
	}
	// Reuse the repository's credential detection without printing matched content.
	if (
		lineHits(
			bytes.toString("utf8"),
			secrets.filter((rule): rule is PatternRule => rule.kind !== "mark"),
		).length > 0
	) {
		throw new Error(`credential-shaped data refused: ${row.path}`);
	}
}

export function treeFiles(root: string): string[] {
	noLinks(root);
	if (!lstatSync(root).isDirectory()) throw new Error("payload root is not a directory");
	const files: string[] = [];
	const walk = (relative: string): void => {
		const directory = path.join(root, relative);
		const entries = readdirSync(directory);
		if (entries.length === 0) throw new Error("empty payload directories are not inventoried");
		for (const name of entries) {
			const file = relativeFile(relative ? `${relative}/${name}` : name);
			const stat = lstatSync(path.join(root, file));
			if (stat.isSymbolicLink()) throw new Error("payload link refused");
			if (stat.isDirectory()) walk(file);
			else if (stat.isFile() && stat.nlink === 1) files.push(file);
			else throw new Error("payload special file or hard-link alias refused");
		}
	};
	walk("");
	return files.sort();
}

export function exactTree(root: string, files: readonly FileRecord[]): void {
	const actual = treeFiles(root);
	const expected = files.map((file) => file.path).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error("payload inventory has missing or unexpected files");
	}
}

export function inventoryOf(root: string): Inventory {
	return {
		schemaVersion: 1,
		files: treeFiles(root).map((file) => {
			const bytes = regularBytes(path.join(root, file));
			return { path: file, sha256: digest(bytes), bytes: bytes.length };
		}),
	};
}
