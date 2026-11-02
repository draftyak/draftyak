import { createHash } from "node:crypto";
import { type BigIntStats, lstatSync, opendirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isProxy } from "node:util/types";
import { assertPortableFileTree } from "@draftyak/bounded-files";
import {
	artifactPath,
	BUNDLE_FILE_POLICY,
	type FileRecord,
	fileRecords,
	readBoundedRegularFile,
} from "../../release-guard/src/file-records.ts";
import { secrets } from "../../vendor-guard/rules/secrets.ts";
import { lineHits, type PatternRule } from "../../vendor-guard/src/rules.ts";

export type { FileRecord } from "../../release-guard/src/file-records.ts";

export interface Inventory {
	readonly schemaVersion: 1;
	readonly files: readonly FileRecord[];
	readonly emptyDirectories?: readonly string[];
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

export function relativeFile(value: unknown): string {
	return artifactPath(value, BUNDLE_FILE_POLICY.maximumPathLength);
}

export function records(value: unknown): readonly FileRecord[] {
	return fileRecords(value, BUNDLE_FILE_POLICY);
}

export function noDotComponents(file: string): void {
	if (/^[A-Za-z]:(?![\\/])/.test(file)) throw new Error("drive-relative paths are refused");
	// Normalization must not erase a private directory or hide traversal before lookup.
	if (file.split(/[\\/]/).some((part) => part === "." || part === ".."))
		throw new Error("raw dot path components are refused");
}

function inputPath(file: string): string {
	noDotComponents(file);
	const absolute = path.resolve(file);
	if (file.startsWith("\\\\") || file.startsWith("//") || absolute.startsWith("\\\\")) {
		throw new Error("network shares and device paths are not bundle inputs");
	}
	if (
		absolute
			.slice(path.parse(absolute).root.length)
			.split(path.sep)
			.some((part) => /^\.env/i.test(part))
	)
		throw new Error("environment files are never bundle inputs");
	return absolute;
}

export function noLinks(file: string): void {
	const absolute = inputPath(file);
	const parsed = path.parse(absolute);
	let cursor = parsed.root;
	for (const part of absolute.slice(cursor.length).split(path.sep)) {
		cursor = path.join(cursor, part);
		if (lstatSync(cursor).isSymbolicLink()) throw new Error("input or output path contains a link");
	}
}

const MAX_FILE_BYTES = 512 * 1024 * 1024;
// Apply the bundle's private-path policy, then use the shared snapshot and cleanup contract.
export function regularBytes(file: string, maximum = MAX_FILE_BYTES): Buffer {
	if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_FILE_BYTES)
		throw new Error("invalid file byte limit");
	return readBoundedRegularFile(inputPath(file), { maximum, minimum: 0 });
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

const MAX_TREE_ENTRIES = 20_000;

/** Empty leaf directories are explicit reviewed inputs, never inferred from missing files. */
export function emptyDirectoryRecords(value: unknown = []): readonly string[] {
	if (
		value === null ||
		typeof value !== "object" ||
		isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		throw new Error("expected an inert empty-directory list");
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > MAX_TREE_ENTRIES ||
		Reflect.ownKeys(value).length !== length + 1
	)
		throw new Error("invalid empty-directory list");
	const directories: string[] = [];
	for (let index = 0; index < length; index++) {
		const item = Object.getOwnPropertyDescriptor(value, String(index));
		if (!item || !("value" in item) || !item.enumerable)
			throw new Error("expected inert empty-directory entries");
		directories.push(relativeFile(item.value));
	}
	assertPortableFileTree(directories);
	return directories.sort();
}

function sameDirectory(before: BigIntStats, after: BigIntStats): boolean {
	return (
		after.isDirectory() &&
		!after.isSymbolicLink() &&
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.mode === after.mode &&
		before.nlink === after.nlink &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	);
}

export function treeFiles(root: string, emptyDirectories: readonly string[] = []): string[] {
	const expectedEmpty = new Set(emptyDirectoryRecords(emptyDirectories));
	const foundEmpty = new Set<string>();
	noLinks(root);
	if (!lstatSync(root).isDirectory()) throw new Error("payload root is not a directory");
	const files: string[] = [];
	let count = 0;
	const walk = (relative: string): void => {
		const directory = path.join(root, relative);
		const before = lstatSync(directory, { bigint: true });
		if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("payload link refused");
		if (realpathSync.native(directory) !== path.resolve(directory))
			throw new Error("payload directory alias refused");
		const opened = opendirSync(directory);
		let entries = 0;
		let failed = false;
		let failure: unknown;
		try {
			if (!sameDirectory(before, lstatSync(directory, { bigint: true })))
				throw new Error("payload directory changed");
			for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
				if (++count > MAX_TREE_ENTRIES) throw new Error("payload tree entry limit exceeded");
				entries++;
				const file = relativeFile(relative ? `${relative}/${entry.name}` : entry.name);
				const stat = lstatSync(path.join(root, file));
				if (stat.isSymbolicLink()) throw new Error("payload link refused");
				if (stat.isDirectory()) walk(file);
				else if (stat.isFile() && stat.nlink === 1) files.push(file);
				else throw new Error("payload special file or hard-link alias refused");
			}
			if (
				!sameDirectory(before, lstatSync(directory, { bigint: true })) ||
				realpathSync.native(directory) !== path.resolve(directory)
			)
				throw new Error("payload directory changed");
		} catch (error) {
			failed = true;
			failure = error;
		} finally {
			try {
				opened.closeSync();
			} catch {
				failed = true;
				failure = new Error("payload directory cleanup refused");
			}
		}
		if (failed) throw failure;
		if (entries === 0) {
			if (!expectedEmpty.has(relative))
				throw new Error("empty payload directories are not inventoried");
			foundEmpty.add(relative);
		} else if (expectedEmpty.has(relative))
			throw new Error("declared empty directory is not empty");
	};
	walk("");
	if (foundEmpty.size !== expectedEmpty.size)
		throw new Error("inventoried empty directory is missing");
	return files.sort();
}

export function exactTree(
	root: string,
	files: readonly FileRecord[],
	emptyDirectories: readonly string[] = [],
): void {
	const directories = emptyDirectoryRecords(emptyDirectories);
	assertPortableFileTree([...files.map((file) => file.path), ...directories]);
	const actual = treeFiles(root, directories);
	const expected = files.map((file) => file.path).sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error("payload inventory has missing or unexpected files");
	}
}

export function inventoryOf(root: string, emptyDirectories: readonly string[] = []): Inventory {
	const directories = emptyDirectoryRecords(emptyDirectories);
	const files = treeFiles(root, directories);
	assertPortableFileTree([...files, ...directories]);
	return {
		schemaVersion: 1,
		files: files.map((file) => {
			const bytes = regularBytes(path.join(root, file));
			return { path: file, sha256: digest(bytes), bytes: bytes.length };
		}),
		...(directories.length ? { emptyDirectories: directories } : {}),
	};
}
