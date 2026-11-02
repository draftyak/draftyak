import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import {
	artifactPath,
	type FileRecord,
	fileRecords,
	RELEASE_FILE_POLICY,
	readBoundedRegularFile,
} from "./file-records.ts";

export type { FileRecord } from "./file-records.ts";

export function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("expected an object");
	}
	return value as Record<string, unknown>;
}

export function fields(value: Record<string, unknown>, names: readonly string[]): void {
	for (const key of Object.keys(value)) {
		if (!names.includes(key)) throw new Error(`unsupported field: ${key}`);
	}
}

export function text(value: unknown): string {
	if (typeof value !== "string" || !value) throw new Error("expected a nonempty string");
	return value;
}

export function relative(value: unknown): string {
	return artifactPath(value, RELEASE_FILE_POLICY.maximumPathLength);
}

// Validate strings before lstat/readdir/open: even a failed UNC lookup can contact a server.
export function localPath(value: string): string {
	// Inspect raw components before resolve can erase an unsafe directory or traversal.
	if (value.split(/[\\/]/).some((part) => part === "." || part === ".."))
		throw new Error("raw dot path components are refused");
	if (
		/^[\\/]{2}/.test(value) ||
		/^\/(?:dev|proc|sys)(?:\/|$)/.test(value) ||
		(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) ||
		(/^[A-Za-z]:/.test(value) && process.platform !== "win32")
	)
		throw new Error("only local filesystem paths are allowed");
	const absolute = path.resolve(value);
	if (/^[\\/]{2}/.test(absolute) || /^\/(?:dev|proc|sys)(?:\/|$)/.test(absolute)) {
		throw new Error("network and device paths are refused");
	}
	const withoutDrive = absolute.replace(/^[A-Za-z]:/, "");
	if (withoutDrive.includes(":") || /[<>"|?*]/.test(withoutDrive)) {
		throw new Error("device or alternate-stream path refused");
	}
	for (const part of withoutDrive.split(/[\\/]/).filter(Boolean)) {
		if (
			/^\.env/i.test(part) ||
			/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(
				part.split(".")[0]?.trimEnd() ?? "",
			) ||
			[...part].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
		) {
			throw new Error("environment or device path refused");
		}
	}
	return absolute;
}

export function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function records(value: unknown): FileRecord[] {
	return fileRecords(value, RELEASE_FILE_POLICY);
}

// lstat every ancestor before reading a directory or file; reject parent junctions.
export function directory(root: string): string {
	const base = localPath(root);
	const ancestors: string[] = [];
	let current = base;
	while (true) {
		ancestors.push(current);
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const ancestor of ancestors.reverse()) {
		const stat = lstatSync(ancestor);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`root ancestor is a link or not a directory: ${ancestor}`);
		}
	}
	return base;
}

export function resolveFile(root: string, file: string): string {
	relative(file);
	const base = directory(root);
	const parts = file.split("/");
	let current = base;
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) throw new Error(`link refused: ${file}`);
		if (index < parts.length - 1 && !stat.isDirectory()) {
			throw new Error(`parent is not a directory: ${file}`);
		}
		if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1)) {
			throw new Error(`not a single-link regular file: ${file}`);
		}
	}
	return current;
}

export function read(root: string, file: string): Buffer {
	const resolved = resolveFile(root, file);
	if (lstatSync(resolved).size > 256 * 1024 * 1024)
		throw new Error(`file exceeds 256 MiB: ${file}`);
	return readBoundedRegularFile(resolved, { maximum: 256 * 1024 * 1024, minimum: 0 });
}

export function json(root: string, file: string): unknown {
	return JSON.parse(read(root, file).toString("utf8"));
}

export function inventory(root: string): FileRecord[] {
	const walk = (folder: string, prefix: string): FileRecord[] => {
		const result: FileRecord[] = [];
		for (const name of readdirSync(folder).sort()) {
			const file = relative(`${prefix}${name}`);
			const stat = lstatSync(path.join(folder, name));
			if (stat.isSymbolicLink()) throw new Error(`link refused: ${file}`);
			if (stat.isDirectory()) result.push(...walk(path.join(folder, name), `${file}/`));
			else {
				const bytes = read(root, file);
				result.push({ path: file, sha256: hash(bytes), bytes: bytes.length });
			}
		}
		return result;
	};
	const actual = walk(directory(root), "").sort((a, b) => (a.path < b.path ? -1 : 1));
	if (actual.length === 0) throw new Error("empty artifact tree");
	records(actual);
	return actual;
}

export function compare(expected: readonly FileRecord[], actual: readonly FileRecord[]): void {
	const a = new Map(actual.map((row) => [row.path, row]));
	for (const row of expected) {
		const found = a.get(row.path);
		if (!found) throw new Error(`missing file: ${row.path}`);
		if (found.sha256 !== row.sha256 || found.bytes !== row.bytes) {
			throw new Error(`integrity mismatch: ${row.path}`);
		}
		a.delete(row.path);
	}
	if (a.size) throw new Error(`extra file: ${a.keys().next().value}`);
}
