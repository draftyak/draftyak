import { createHash } from "node:crypto";
import { isSharedArrayBuffer, isUint8Array } from "node:util/types";

export type GitObjectType = "commit" | "tree" | "blob";
export interface RawGitObject {
	readonly id: string;
	readonly type: GitObjectType;
	readonly bytes: Uint8Array;
}
export interface DatabaseObjectInventory {
	readonly id: string;
	readonly type: GitObjectType;
	readonly bytes: number;
	readonly objectSha256: string;
	readonly contentSha256: string;
}
export interface DatabaseTreeEntry {
	readonly path: string;
	readonly mode: "40000" | "100644" | "100755";
	readonly id: string;
	readonly type: "tree" | "blob";
	readonly bytes: number;
	readonly contentSha256: string;
}
export interface DatabaseObjectTree {
	readonly version: 1;
	readonly commitId: string;
	readonly treeId: string;
	readonly objectCount: number;
	readonly entryCount: number;
	readonly totalObjectBytes: number;
	readonly objects: readonly DatabaseObjectInventory[];
	readonly entries: readonly DatabaseTreeEntry[];
	readonly digest: string;
}
export const DATABASE_OBJECT_LIMITS: Readonly<{
	objects: number;
	entries: number;
	totalBytes: number;
	blobBytes: number;
	commitBytes: number;
	treeBytes: number;
	depth: number;
	pathBytes: number;
	componentBytes: number;
}> = Object.freeze({
	objects: 10_000,
	entries: 10_000,
	totalBytes: 64 * 1024 * 1024,
	blobBytes: 8 * 1024 * 1024,
	commitBytes: 64 * 1024,
	treeBytes: 1024 * 1024,
	depth: 64,
	pathBytes: 4096,
	componentBytes: 255,
});

export class DatabaseObjectError extends Error {
	readonly code = "INVALID_INPUT";

	constructor() {
		super("invalid database object tree");
		this.name = "DatabaseObjectError";
	}
}
function refuse(): never {
	throw new DatabaseObjectError();
}
const domain = "draftyak/native-dependency-policy/database-object-tree/v1\0";
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const compare = (left: string, right: string): number =>
	Buffer.compare(Buffer.from(left), Buffer.from(right));
const objectId = (value: unknown): string => {
	if (typeof value !== "string" || !/^[0-9a-f]{40}(?![\s\S])/.test(value)) return refuse();
	return value;
};

interface Snapshot extends DatabaseObjectInventory {
	readonly raw: Buffer;
}
interface TreeChild {
	readonly name: string;
	readonly mode: DatabaseTreeEntry["mode"];
	readonly id: string;
	readonly type: DatabaseTreeEntry["type"];
}
function inputArray(input: readonly RawGitObject[]): unknown[] {
	if (!Array.isArray(input) || Object.getOwnPropertySymbols(input).length) return refuse();
	const length: unknown = Object.getOwnPropertyDescriptor(input, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length > DATABASE_OBJECT_LIMITS.objects
	)
		return refuse();
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Object.keys(descriptors).length !== length + 1) return refuse();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = descriptors[String(index)];
		if (!descriptor || !Object.hasOwn(descriptor, "value")) return refuse();
		result.push(descriptor.value);
	}
	return result;
}
function inputRecord(input: unknown): Record<string, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return refuse();
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return refuse();
	if (Object.getOwnPropertySymbols(input).length) return refuse();
	const descriptors = Object.getOwnPropertyDescriptors(input);
	const keys = Object.keys(descriptors);
	if (keys.length !== 3 || keys.some((key) => !["id", "type", "bytes"].includes(key)))
		return refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = descriptors[key];
		if (!descriptor || !Object.hasOwn(descriptor, "value")) return refuse();
		result[key] = descriptor.value;
	}
	return result;
}
function snapshots(input: readonly RawGitObject[]): {
	objects: Map<string, Snapshot>;
	total: number;
} {
	const rows = inputArray(input);
	const objects = new Map<string, Snapshot>();
	let total = 0;
	for (const row of rows) {
		const value = inputRecord(row);
		const id = objectId(value.id);
		const type = value.type;
		if (type !== "commit" && type !== "tree" && type !== "blob") return refuse();
		const limit = DATABASE_OBJECT_LIMITS[`${type}Bytes`];
		if (!isUint8Array(value.bytes)) return refuse();
		if (isSharedArrayBuffer(backingBuffer?.call(value.bytes))) return refuse();
		const length: unknown = byteLength?.call(value.bytes);
		if (typeof length !== "number" || length > limit) return refuse();
		total += length;
		if (total > DATABASE_OBJECT_LIMITS.totalBytes || objects.has(id)) return refuse();
		const raw = Buffer.alloc(length);
		Uint8Array.prototype.set.call(raw, value.bytes);
		const header = Buffer.from(`${type} ${length}\0`, "ascii");
		if (createHash("sha1").update(header).update(raw).digest("hex") !== id) return refuse();
		objects.set(id, {
			id,
			type,
			bytes: length,
			objectSha256: createHash("sha256").update(header).update(raw).digest("hex"),
			contentSha256: createHash("sha256").update(raw).digest("hex"),
			raw,
		});
	}
	return { objects, total };
}
function rootTree(commit: Snapshot): string {
	const first = /^tree ([0-9a-f]{40})\n(?![\s\S])/.exec(
		commit.raw.subarray(0, 46).toString("utf8"),
	);
	if (!first?.[1]) return refuse();
	const separator = commit.raw.indexOf(Buffer.from("\n\n"));
	if (separator < 45) return refuse();
	// Only the technical tree header is interpreted; the message stays opaque.
	let offset = 46;
	while (offset <= separator) {
		const end = commit.raw.indexOf(10, offset);
		if (end < 0 || end > separator) break;
		if (commit.raw.subarray(offset, offset + 5).equals(Buffer.from("tree "))) return refuse();
		offset = end + 1;
	}
	return first[1];
}
function component(bytes: Buffer): string {
	if (bytes.length === 0 || bytes.length > DATABASE_OBJECT_LIMITS.componentBytes) return refuse();
	const name = bytes.toString("utf8");
	if (
		!/^[A-Za-z0-9._-]+(?![\s\S])/.test(name) ||
		name === "." ||
		name === ".." ||
		name.toLowerCase() === ".git" ||
		name.endsWith(".") ||
		/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
	)
		return refuse();
	return name;
}

/** Verifies one commit's raw content closure, without source or physical-session authority. */
export function verifyDatabaseObjectTree(
	expectedCommitId: string,
	input: readonly RawGitObject[],
): DatabaseObjectTree {
	try {
		const commitId = objectId(expectedCommitId);
		const { objects, total } = snapshots(input);
		const commit = objects.get(commitId);
		if (commit?.type !== "commit") return refuse();
		const treeId = rootTree(commit);
		const visited = new Set([commitId]);
		const active = new Set<string>();
		const parsed = new Map<string, readonly TreeChild[]>();
		const entries: DatabaseTreeEntry[] = [];
		let parsedEntries = 0;
		function readTree(tree: Snapshot): readonly TreeChild[] {
			const cached = parsed.get(tree.id);
			if (cached) return cached;
			const children: TreeChild[] = [];
			const names = new Set<string>();
			let offset = 0;
			let previous: Buffer | undefined;
			while (offset < tree.raw.length) {
				if (++parsedEntries > DATABASE_OBJECT_LIMITS.entries) return refuse();
				const space = tree.raw.indexOf(32, offset);
				if (space < 0 || space - offset > 6) return refuse();
				const mode = tree.raw.subarray(offset, space).toString("utf8");
				if (mode !== "40000" && mode !== "100644" && mode !== "100755") return refuse();
				const nul = tree.raw.indexOf(0, space + 1);
				if (nul < 0 || tree.raw.length - (nul + 1) < 20) return refuse();
				const name = component(tree.raw.subarray(space + 1, nul));
				const type = mode === "40000" ? "tree" : "blob";
				const key = Buffer.from(name + (type === "tree" ? "/" : "\0"), "ascii");
				if (names.has(name.toLowerCase()) || (previous && Buffer.compare(previous, key) >= 0))
					return refuse();
				names.add(name.toLowerCase());
				previous = key;
				const id = tree.raw.subarray(nul + 1, nul + 21).toString("hex");
				children.push({ name, mode, id, type });
				offset = nul + 21;
			}
			parsed.set(tree.id, children);
			return children;
		}
		function walk(id: string, prefix: string, depth: number): void {
			const tree = objects.get(id);
			if (tree?.type !== "tree" || active.has(id)) refuse();
			visited.add(id);
			active.add(id);
			for (const child of readTree(tree)) {
				const name = prefix ? `${prefix}/${child.name}` : child.name;
				if (
					depth + 1 > DATABASE_OBJECT_LIMITS.depth ||
					name.length > DATABASE_OBJECT_LIMITS.pathBytes ||
					entries.length >= DATABASE_OBJECT_LIMITS.entries
				)
					refuse();
				const object = objects.get(child.id);
				if (object?.type !== child.type) refuse();
				visited.add(child.id);
				entries.push(
					Object.freeze({
						path: name,
						mode: child.mode,
						id: child.id,
						type: child.type,
						bytes: object.bytes,
						contentSha256: object.contentSha256,
					}),
				);
				if (child.type === "tree") walk(child.id, name, depth + 1);
			}
			active.delete(id);
		}
		walk(treeId, "", 0);
		if (visited.size !== objects.size) return refuse();
		entries.sort((left, right) => compare(left.path, right.path));
		const inventory: readonly DatabaseObjectInventory[] = Object.freeze(
			[...objects.values()]
				.sort((left, right) => compare(left.id, right.id))
				.map(({ raw: _, ...row }) => Object.freeze(row)),
		);
		const result = {
			version: 1 as const,
			commitId,
			treeId,
			objectCount: inventory.length,
			entryCount: entries.length,
			totalObjectBytes: total,
			objects: inventory,
			entries: Object.freeze(entries),
		};
		const payload = [
			1,
			commitId,
			treeId,
			total,
			inventory.map((row) => [row.id, row.type, row.bytes, row.objectSha256, row.contentSha256]),
			entries.map((row) => [row.path, row.mode, row.id, row.type, row.bytes, row.contentSha256]),
		];
		return Object.freeze({
			...result,
			digest: createHash("sha256").update(domain).update(JSON.stringify(payload)).digest("hex"),
		});
	} catch {
		return refuse();
	}
}
