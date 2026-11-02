import { createHash } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";
import {
	assertPortableFileTree,
	checkedFileRecord,
	readBoundedRegularFile,
} from "@draftyak/bounded-files";
import {
	ArtifactError,
	MAX_BUNDLE_BYTES,
	MAX_FILE_BYTES,
	MAX_FILES,
	portablePath,
} from "./archive.ts";
import type { FileDigest, InstalledBundle } from "./index.ts";
import { snapshotPackageLock } from "./pin.ts";

type DirectoryIdentity = { readonly name: string; readonly stat: BigIntStats };

function refuse(): never {
	throw new ArtifactError();
}

function inertRecord(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) refuse();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) refuse();
	const names = Reflect.ownKeys(raw);
	if (names.length !== keys.length) refuse();
	const result = Object.create(null) as Record<string, unknown>;
	for (const name of names) {
		if (typeof name !== "string" || !keys.includes(name)) refuse();
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
		result[name] = descriptor.value;
	}
	for (const key of keys) if (!Object.hasOwn(result, key)) refuse();
	return result;
}

function nativeName(raw: unknown): string {
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length === 0 ||
		raw.length > 4096 ||
		raw.includes("\0") ||
		/^[/\\]{2}/.test(raw) ||
		!path.isAbsolute(raw)
	)
		refuse();
	const root = path.parse(raw).root;
	if (process.platform === "win32" && (!/^[A-Za-z]:\\$/.test(root) || raw.includes("/"))) refuse();
	const tail = raw.slice(root.length);
	for (const component of tail === "" ? [] : tail.split(path.sep)) {
		if (
			component.length === 0 ||
			component === "." ||
			component === ".." ||
			(process.platform === "win32" &&
				(/[. ]$/.test(component) ||
					/[\p{Cc}<>:"|?*]/u.test(component) ||
					/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(component)))
		)
			refuse();
	}
	// Resolution is only a final spelling check, after refusing raw dot/device components.
	if (path.resolve(raw) !== raw) refuse();
	return raw;
}

function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
	return before.dev === after.dev && before.ino === after.ino && before.ino !== 0n;
}

async function directoryIdentity(name: string): Promise<DirectoryIdentity> {
	const stat = await lstat(name, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		(await realpath(name)) !== name
	)
		refuse();
	return { name, stat };
}

async function directoryChain(name: string): Promise<readonly DirectoryIdentity[]> {
	const root = path.parse(name).root;
	const result = [await directoryIdentity(root)];
	let current = root;
	for (const part of name.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		result.push(await directoryIdentity(current));
	}
	return result;
}

async function recheck(chain: readonly DirectoryIdentity[]): Promise<void> {
	for (const previous of chain) {
		const next = await directoryIdentity(previous.name);
		if (!sameIdentity(previous.stat, next.stat)) refuse();
	}
}

/** Existing canonical native directory only; this grants no load or filesystem policy authority. */
export async function canonicalDirectory(raw: unknown): Promise<string> {
	try {
		const name = nativeName(raw);
		const chain = await directoryChain(name);
		await recheck(chain);
		return name;
	} catch {
		throw new ArtifactError();
	}
}

function fileRecord(raw: unknown): FileDigest {
	const value = checkedFileRecord(raw, { byteField: "bytes", minimum: 0, maximum: MAX_FILE_BYTES });
	return Object.freeze({
		path: portablePath(value.path),
		bytes: value.byteLength,
		sha256: value.sha256,
	});
}

/** Hash only the exact native snapshot returned by the common bounded reader. */
export async function verifyBundleFile(target: string, wanted: FileDigest): Promise<void> {
	try {
		const expected = fileRecord(wanted);
		const name = nativeName(target);
		const bytes = readBoundedRegularFile(name, {
			maximum: MAX_FILE_BYTES,
			minimum: 0,
			expectedSize: expected.bytes,
		});
		if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) refuse();
	} catch {
		throw new ArtifactError();
	}
}

function snapshotBundle(raw: unknown): InstalledBundle {
	const bundle = inertRecord(raw, ["directory", "inventory"]);
	const directory = nativeName(bundle.directory);
	const inventory = inertRecord(bundle.inventory, [
		"name",
		"version",
		"integrity",
		"entry",
		"files",
	]);
	const lock = snapshotPackageLock({
		name: inventory.name,
		version: inventory.version,
		integrity: inventory.integrity,
		entry: inventory.entry,
	});
	const input = inventory.files;
	if (
		input === null ||
		typeof input !== "object" ||
		isProxy(input) ||
		!Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Array.prototype
	)
		refuse();
	const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > MAX_FILES ||
		Reflect.ownKeys(input).length !== length + 1
	)
		refuse();
	const files: FileDigest[] = [];
	let total = 0;
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refuse();
		const file = fileRecord(descriptor.value);
		total += file.bytes;
		if (total > MAX_BUNDLE_BYTES) refuse();
		files.push(file);
	}
	assertPortableFileTree(files.map((file) => file.path));
	if (!files.some((file) => file.path === lock.entry)) refuse();
	return Object.freeze({
		directory,
		inventory: Object.freeze({ ...lock, files: Object.freeze(files) }),
	});
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
	return (
		sameIdentity(before, after) &&
		before.nlink === after.nlink &&
		before.mode === after.mode &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs
	);
}

/** Listings open by path, so the directory must still match its snapshot while one is open. */
async function list(
	snapshot: DirectoryIdentity,
	visit: (item: Dirent) => Promise<void>,
): Promise<void> {
	const handle = await opendir(snapshot.name, { bufferSize: 1 });
	try {
		for (;;) {
			const item = await handle.read();
			if (item === null) break;
			await visit(item);
		}
		const current = await directoryIdentity(snapshot.name);
		if (!unchanged(snapshot.stat, current.stat)) refuse();
	} finally {
		await handle.close();
	}
}

/** Verify an exact native tree at this boundary; the consumer rechecks under its actual authority. */
export async function verifyBundle(bundle: InstalledBundle): Promise<string> {
	try {
		const retained = snapshotBundle(bundle);
		const root = retained.directory;
		const ancestors = await directoryChain(root);
		const expected = new Map(retained.inventory.files.map((file) => [file.path, file]));
		const directories = new Set<string>();
		for (const name of expected.keys()) {
			const parts = name.split("/");
			for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join("/"));
		}
		// Per directory: each listed name, with a verified file's stat from before it was read.
		const listings: { snapshot: DirectoryIdentity; names: Map<string, BigIntStats | null> }[] = [];
		const walk = async (directory: string, prefix: string): Promise<void> => {
			const snapshot = await directoryIdentity(directory);
			const names = new Map<string, BigIntStats | null>();
			listings.push({ snapshot, names });
			await list(snapshot, async (item) => {
				const name = prefix ? `${prefix}/${item.name}` : item.name;
				const wanted = expected.get(name);
				if (!wanted && !directories.has(name)) refuse();
				const target = path.join(directory, item.name);
				if (directories.has(name)) {
					if (!item.isDirectory() || item.isSymbolicLink()) refuse();
					directories.delete(name);
					names.set(item.name, null);
					await walk(target, name);
				} else {
					if (!item.isFile() || item.isSymbolicLink() || !wanted) refuse();
					const stat = await lstat(target, { bigint: true });
					await verifyBundleFile(target, wanted);
					names.set(item.name, stat);
					expected.delete(name);
				}
			});
		};
		await walk(root, "");
		if (expected.size !== 0 || directories.size !== 0) refuse();
		// Directory times are coarse: list each directory again and require exactly the same names.
		for (const { snapshot, names } of listings) {
			const remaining = new Map(names);
			await list(snapshot, async (item) => {
				const stat = remaining.get(item.name);
				if (stat === undefined) refuse();
				remaining.delete(item.name);
				const target = path.join(snapshot.name, item.name);
				if (stat && !unchanged(stat, await lstat(target, { bigint: true }))) refuse();
			});
			if (remaining.size !== 0) refuse();
		}
		await recheck(ancestors);
		return path.join(root, retained.inventory.entry);
	} catch {
		throw new ArtifactError();
	}
}
