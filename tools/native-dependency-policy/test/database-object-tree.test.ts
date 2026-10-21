import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	DatabaseObjectError,
	type GitObjectType,
	DATABASE_OBJECT_LIMITS as limits,
	type RawGitObject,
	verifyDatabaseObjectTree,
} from "../src/database-object-tree.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function object(type: GitObjectType, input: Uint8Array | string): RawGitObject {
	const bytes = Buffer.from(input);
	return {
		type,
		bytes,
		id: createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex"),
	};
}
function entry(mode: string, name: string, id: string): Buffer {
	return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(id, "hex")]);
}
function root(tree: RawGitObject, message = "opaque synthetic message"): RawGitObject {
	return object("commit", `tree ${tree.id}\n\n${message}`);
}
function fixture(raw: Uint8Array | string = "synthetic opaque bytes") {
	const blob = object("blob", raw);
	const tree = object("tree", entry("100644", "file", blob.id));
	const commit = root(tree);
	return { blob, tree, commit, objects: [commit, tree, blob] };
}
function named(name: string, mode = "100644") {
	const blob = object("blob", "synthetic payload");
	const tree = object("tree", entry(mode, name, blob.id));
	const commit = root(tree);
	return { blob, tree, commit, objects: [commit, tree, blob] };
}
function refuses(commit: string, objects: readonly RawGitObject[]): void {
	expect(() => verifyDatabaseObjectTree(commit, objects)).toThrow(DatabaseObjectError);
	try {
		verifyDatabaseObjectTree(commit, objects);
	} catch (error) {
		expect(error).toMatchObject({
			name: "DatabaseObjectError",
			code: "INVALID_INPUT",
			message: "invalid database object tree",
		});
	}
}

describe("raw Git content-tree consistency", () => {
	it("binds a binary blob and all object hashes independently of input ordering", () => {
		const f = fixture(Buffer.from([0, 255, 1, 128]));
		const result = verifyDatabaseObjectTree(f.commit.id, f.objects);
		expect(result.version).toBe(1);
		expect(result.commitId).toBe(f.commit.id);
		expect(result.treeId).toBe(f.tree.id);
		expect(result.objectCount).toBe(3);
		expect(result.entryCount).toBe(1);
		expect(result.totalObjectBytes).toBe(f.objects.reduce((sum, row) => sum + row.bytes.length, 0));
		expect(result.entries).toEqual([
			{
				path: "file",
				mode: "100644",
				id: f.blob.id,
				type: "blob",
				bytes: f.blob.bytes.length,
				contentSha256: sha(f.blob.bytes),
			},
		]);
		const expectedObjects = [...f.objects]
			.sort((a, b) => a.id.localeCompare(b.id))
			.map((row) => ({
				id: row.id,
				type: row.type,
				bytes: row.bytes.length,
				objectSha256: createHash("sha256")
					.update(`${row.type} ${row.bytes.length}\0`)
					.update(row.bytes)
					.digest("hex"),
				contentSha256: sha(row.bytes),
			}));
		expect(result.objects).toEqual(expectedObjects);
		const tuple = [
			1,
			f.commit.id,
			f.tree.id,
			result.totalObjectBytes,
			expectedObjects.map((row) => [
				row.id,
				row.type,
				row.bytes,
				row.objectSha256,
				row.contentSha256,
			]),
			[["file", "100644", f.blob.id, "blob", 4, sha(f.blob.bytes)]],
		];
		expect(result.digest).toBe(
			createHash("sha256")
				.update("draftyak/native-dependency-policy/database-object-tree/v1\0")
				.update(JSON.stringify(tuple))
				.digest("hex"),
		);
		expect(verifyDatabaseObjectTree(f.commit.id, [...f.objects].reverse())).toEqual(result);
	});
	it("accepts an empty root tree with no phantom path", () => {
		const tree = object("tree", "");
		const commit = root(tree);
		const result = verifyDatabaseObjectTree(commit.id, [tree, commit]);
		expect(result.entries).toEqual([]);
		expect(result.objectCount).toBe(2);
	});
	it("binds every expanded directory/file path while deduplicating reused objects", () => {
		const blob = object("blob", "same synthetic bytes");
		const child = object("tree", entry("100755", "run", blob.id));
		const tree = object(
			"tree",
			Buffer.concat([
				entry("40000", "a", child.id),
				entry("40000", "b", child.id),
				entry("100644", "plain", blob.id),
			]),
		);
		const commit = root(tree);
		const result = verifyDatabaseObjectTree(commit.id, [blob, child, tree, commit]);
		expect(result.objectCount).toBe(4);
		expect(result.entries.map((row) => [row.path, row.mode])).toEqual([
			["a", "40000"],
			["a/run", "100755"],
			["b", "40000"],
			["b/run", "100755"],
			["plain", "100644"],
		]);
	});
	it("uses Git directory ordering rather than plain component ordering", () => {
		const blob = object("blob", "bytes");
		const empty = object("tree", "");
		const tree = object(
			"tree",
			Buffer.concat([entry("100644", "foo.bar", blob.id), entry("40000", "foo", empty.id)]),
		);
		const commit = root(tree);
		expect(
			verifyDatabaseObjectTree(commit.id, [commit, tree, empty, blob]).entries.map(
				(row) => row.path,
			),
		).toEqual(["foo", "foo.bar"]);
		const reversed = object(
			"tree",
			Buffer.concat([entry("40000", "foo", empty.id), entry("100644", "foo.bar", blob.id)]),
		);
		const invalid = root(reversed);
		refuses(invalid.id, [invalid, reversed, empty, blob]);
	});
	it("changes its digest for valid changed content, filename and executable mode", () => {
		const f = fixture("first");
		const original = verifyDatabaseObjectTree(f.commit.id, f.objects);
		const changed = fixture("other");
		expect(verifyDatabaseObjectTree(changed.commit.id, changed.objects).digest).not.toBe(
			original.digest,
		);
		for (const [name, mode] of [
			["other", "100644"],
			["file", "100755"],
		]) {
			const tree = object("tree", entry(mode ?? "", name ?? "", f.blob.id));
			const commit = root(tree);
			expect(verifyDatabaseObjectTree(commit.id, [commit, tree, f.blob]).digest).not.toBe(
				original.digest,
			);
		}
	});
	it("refuses changed blob bytes with unchanged supplied identities and closure", () => {
		const f = fixture("before");
		refuses(f.commit.id, [f.commit, f.tree, { ...f.blob, bytes: Buffer.from("after!") }]);
	});
	it("refuses an unused hash-valid object independently of complete valid closure", () => {
		const f = fixture();
		refuses(f.commit.id, [...f.objects, object("blob", "unused synthetic bytes")]);
	});
	it("refuses missing objects, foreign roots, wrong types and duplicate supplied IDs", () => {
		const f = fixture();
		refuses("f".repeat(40), f.objects);
		refuses(f.blob.id, f.objects);
		refuses(f.commit.id, [f.commit, f.tree]);
		refuses(f.commit.id, [f.commit, f.blob]);
		refuses(f.commit.id, [...f.objects, f.blob]);
		const wrong = object("tree", entry("40000", "wrong", f.blob.id));
		const commit = root(wrong);
		refuses(commit.id, [commit, wrong, f.blob]);
	});
	it("verifies object type and tree/commit bytes as part of Git identity", () => {
		const f = fixture();
		refuses(f.commit.id, [
			f.commit,
			{ ...f.tree, bytes: Buffer.concat([Buffer.from("0"), f.tree.bytes]) },
			f.blob,
		]);
		refuses(f.commit.id, [
			{ ...f.commit, bytes: Buffer.concat([f.commit.bytes, Buffer.from("changed")]) },
			f.tree,
			f.blob,
		]);
		refuses(f.commit.id, [f.commit, f.tree, { ...f.blob, type: "tree" }]);
	});
	it("only binds the root content tree rather than requiring parent-history objects", () => {
		const f = fixture();
		const parent = root(object("tree", ""), "unrelated synthetic history");
		const commit = object("commit", `tree ${f.tree.id}\nparent ${parent.id}\n\nopaque`);
		expect(verifyDatabaseObjectTree(commit.id, [commit, f.tree, f.blob]).entryCount).toBe(1);
		refuses(commit.id, [commit, f.tree, f.blob, parent]);
	});
	it("does not expose opaque header, message or binary blob content", () => {
		const f = fixture("synthetic-private-blob");
		const commit = object(
			"commit",
			Buffer.concat([
				Buffer.from(`tree ${f.tree.id}\nsynthetic-header synthetic-private-header\n\n`),
				Buffer.from([255, 0, 128]),
				Buffer.from("synthetic-private-message"),
			]),
		);
		const result = verifyDatabaseObjectTree(commit.id, [commit, f.tree, f.blob]);
		for (const text of [
			"synthetic-private-blob",
			"synthetic-private-header",
			"synthetic-private-message",
		])
			expect(JSON.stringify(result).includes(text)).toBe(false);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.objects)).toBe(true);
		expect(Object.isFrozen(result.entries)).toBe(true);
		for (const row of [...result.objects, ...result.entries])
			expect(Object.isFrozen(row)).toBe(true);
		f.blob.bytes.fill(0);
		expect(JSON.stringify(result)).not.toContain('"raw"');
	});
});

describe("portable paths and binary tree grammar", () => {
	it("refuses .git with all other objects and tree grammar valid", () => {
		const f = named(".git");
		refuses(f.commit.id, f.objects);
	});
	it.each([
		".",
		"..",
		".GIT",
		"x.",
		"x ",
		"a/b",
		"a\\b",
		"a:b",
		"a\nb",
		"a\r",
		"a\t",
		"a\u2028",
		"a\u2029",
		"é",
		"CON",
		"con.txt",
		"AUX.data",
		"PRN",
		"NUL",
		"COM1",
		"com9.txt",
		"LPT0",
		"lpt9.log",
		"CONIN$",
	])("refuses unsupported component %j", (name) => {
		const f = named(name);
		refuses(f.commit.id, f.objects);
	});
	it("accepts conservative portable punctuation without normalization", () => {
		const f = named("A-z_0.1-hidden");
		expect(verifyDatabaseObjectTree(f.commit.id, f.objects).entries[0]?.path).toBe(
			"A-z_0.1-hidden",
		);
	});
	it.each(["040000", "100664", "120000", "160000", "0", "1006444"])(
		"refuses unsupported mode %s",
		(mode) => {
			const f = named("file", mode);
			refuses(f.commit.id, f.objects);
		},
	);
	it("refuses duplicate names, ASCII case collisions and unsorted entries", () => {
		const blob = object("blob", "bytes");
		for (const names of [
			["a", "a"],
			["A", "a"],
			["z", "a"],
		]) {
			const tree = object(
				"tree",
				Buffer.concat(names.map((name) => entry("100644", name, blob.id))),
			);
			const commit = root(tree);
			refuses(commit.id, [commit, tree, blob]);
		}
	});
	it("refuses malformed/truncated tree entries and dangling object IDs", () => {
		const f = fixture();
		const valid = entry("100644", "file", f.blob.id);
		for (const bytes of [
			Buffer.from("100644"),
			Buffer.from("100644 file"),
			valid.subarray(0, valid.length - 1),
			Buffer.concat([valid, Buffer.from([1])]),
			entry("100644", "", f.blob.id),
			entry("100644", "file", "0".repeat(40)),
		]) {
			const tree = object("tree", bytes);
			const commit = root(tree);
			refuses(commit.id, [commit, tree, f.blob]);
		}
	});
	it("refuses missing, malformed or duplicated technical root tree headers", () => {
		const f = fixture();
		for (const content of [
			`tree ${f.tree.id}`,
			`tree ${f.tree.id.toUpperCase()}\n\n`,
			` tree ${f.tree.id}\n\n`,
			`tree ${f.tree.id}\r\n\r\n`,
			`tree ${f.tree.id}\ntree ${f.tree.id}\n\n`,
			`tree ${f.tree.id}\nheaders without separator`,
		]) {
			const commit = object("commit", content);
			refuses(commit.id, [commit, f.tree, f.blob]);
		}
	});
});

describe("bounded snapshots and closed data shape", () => {
	it("copies only a byte view's exact extent using intrinsic accessors", () => {
		const f = fixture(Buffer.from([3, 4, 5]));
		const backing = Buffer.from([255, 3, 4, 5, 255]);
		const bytes = backing.subarray(1, 4);
		Object.defineProperty(bytes, "byteLength", {
			get: () => {
				throw new Error("not read");
			},
		});
		Object.defineProperty(bytes, "buffer", {
			get: () => {
				throw new Error("not read");
			},
		});
		const result = verifyDatabaseObjectTree(f.commit.id, [f.commit, f.tree, { ...f.blob, bytes }]);
		expect(result.entries[0]?.bytes).toBe(3);
		expect(result.entries[0]?.contentSha256).toBe(sha(f.blob.bytes));
		backing.fill(0);
		expect(result.entries[0]?.contentSha256).toBe(sha(f.blob.bytes));
	});
	it("refuses shared, detached, proxy and non-byte views", () => {
		const f = fixture();
		const shared = new Uint8Array(new SharedArrayBuffer(f.blob.bytes.length));
		shared.set(f.blob.bytes);
		const detached = new Uint8Array(new ArrayBuffer(1));
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		for (const bytes of [
			shared,
			detached,
			new Proxy(f.blob.bytes, {}),
			new Uint16Array(2),
			new DataView(new ArrayBuffer(4)),
			[1, 2],
			null,
		])
			refuses(f.commit.id, [f.commit, f.tree, { ...f.blob, bytes } as RawGitObject]);
	});
	it("refuses a non-byte view even when its four zero bytes match the supplied blob ID", () => {
		const f = fixture(Buffer.alloc(4));
		const bytes = new Uint16Array(2);
		expect(bytes.byteLength).toBe(4);
		expect(Buffer.from(bytes.buffer)).toEqual(f.blob.bytes);
		expect(verifyDatabaseObjectTree(f.commit.id, f.objects).entries[0]?.bytes).toBe(4);
		refuses(f.commit.id, [f.commit, f.tree, { ...f.blob, bytes } as unknown as RawGitObject]);
	});
	it("refuses unknown DTO members, sparse arrays and accessors without invoking them", () => {
		const f = fixture();
		let calls = 0;
		const accessor = {
			id: f.blob.id,
			type: "blob",
			get bytes() {
				calls++;
				return f.blob.bytes;
			},
		};
		const arrayAccessor = [...f.objects];
		Object.defineProperty(arrayAccessor, "0", {
			get: () => {
				calls++;
				return f.commit;
			},
		});
		const sparse = new Array<RawGitObject>(3);
		sparse[0] = f.commit;
		const symbol = { ...f.blob, [Symbol("synthetic")]: 1 };
		const extraArray = Object.assign([...f.objects], { extra: 1 });
		for (const objects of [
			[f.commit, f.tree, accessor],
			[f.commit, f.tree, { ...f.blob, extra: 1 }],
			[f.commit, f.tree, symbol],
			arrayAccessor,
			sparse,
			extraArray,
			[],
			null,
		])
			refuses(f.commit.id, objects as readonly RawGitObject[]);
		expect(calls).toBe(0);
	});
	it("refuses noncanonical IDs and unknown types without echoing input", () => {
		const f = fixture();
		for (const id of [
			"A".repeat(40),
			"0".repeat(39),
			`${f.commit.id}\n`,
			"synthetic-private-input",
		])
			refuses(id, f.objects);
		for (const row of [
			{ ...f.blob, id: "synthetic-private-input" },
			{ ...f.blob, type: "tag" },
			{ ...f.blob, bytes: "synthetic-private-input" },
		])
			refuses(f.commit.id, [f.commit, f.tree, row as RawGitObject]);
	});
});

function nested(components: readonly string[]) {
	const blob = object("blob", "leaf");
	const objects: RawGitObject[] = [blob];
	let current = blob;
	for (let index = components.length - 1; index >= 0; index--) {
		current = object(
			"tree",
			entry(
				index === components.length - 1 ? "100644" : "40000",
				components[index] ?? "",
				current.id,
			),
		);
		objects.push(current);
	}
	const commit = root(current);
	return { commit, objects: [commit, ...objects] };
}
describe("fixed resource bounds", () => {
	it("accepts exact blob and commit byte caps and refuses cap plus one", () => {
		const f = fixture(Buffer.alloc(limits.blobBytes));
		expect(verifyDatabaseObjectTree(f.commit.id, f.objects).entries[0]?.bytes).toBe(
			limits.blobBytes,
		);
		const tooLarge = fixture(Buffer.alloc(limits.blobBytes + 1));
		refuses(tooLarge.commit.id, tooLarge.objects);
		const prefix = `tree ${f.tree.id}\n\n`;
		const commit = object(
			"commit",
			prefix + "x".repeat(limits.commitBytes - Buffer.byteLength(prefix)),
		);
		expect(
			verifyDatabaseObjectTree(commit.id, [commit, f.tree, f.blob]).objects.find(
				(row) => row.type === "commit",
			)?.bytes,
		).toBe(limits.commitBytes);
		const largeCommit = object("commit", Buffer.concat([commit.bytes, Buffer.from("x")]));
		refuses(largeCommit.id, [largeCommit, f.tree, f.blob]);
	});
	it("accepts an exact 1MiB valid tree and refuses an additional raw byte", () => {
		const blob = object("blob", "shared");
		const tree = object(
			"tree",
			Buffer.concat(
				Array.from({ length: 4096 }, (_, index) =>
					entry("100644", `${String(index).padStart(4, "0")}${"a".repeat(224)}`, blob.id),
				),
			),
		);
		expect(tree.bytes.length).toBe(limits.treeBytes);
		const commit = root(tree);
		expect(verifyDatabaseObjectTree(commit.id, [commit, tree, blob]).entryCount).toBe(4096);
		const larger = object("tree", Buffer.concat([tree.bytes, Buffer.from([0])]));
		const invalid = root(larger);
		refuses(invalid.id, [invalid, larger, blob]);
	});
	it("refuses a valid 4097-entry tree whose 1MiB plus 29 bytes exceed only the tree byte cap", () => {
		const blob = object("blob", "shared");
		// The first 4096 entries are 256 bytes each; the final sorted z entry is 29 bytes.
		const tree = object(
			"tree",
			Buffer.concat([
				...Array.from({ length: 4096 }, (_, index) =>
					entry("100644", `${String(index).padStart(4, "0")}${"a".repeat(224)}`, blob.id),
				),
				entry("100644", "z", blob.id),
			]),
		);
		expect(tree.bytes.length).toBe(1024 * 1024 + 29);
		const commit = root(tree);
		refuses(commit.id, [commit, tree, blob]);
	});
	it("accepts depth64 and component255 but refuses each cap plus one", () => {
		for (const components of [
			Array.from({ length: limits.depth }, () => "a"),
			["x".repeat(limits.componentBytes)],
		]) {
			const f = nested(components);
			expect(verifyDatabaseObjectTree(f.commit.id, f.objects).entryCount).toBe(components.length);
		}
		for (const components of [
			Array.from({ length: limits.depth + 1 }, () => "a"),
			["x".repeat(limits.componentBytes + 1)],
		]) {
			const f = nested(components);
			refuses(f.commit.id, f.objects);
		}
	});
	it("accepts path4096 and refuses path4097 without normalization", () => {
		const exact = [...Array.from({ length: 15 }, () => "x".repeat(255)), "y".repeat(254), "z"];
		expect(exact.join("/").length).toBe(limits.pathBytes);
		const f = nested(exact);
		expect(verifyDatabaseObjectTree(f.commit.id, f.objects).entries.at(-1)?.path.length).toBe(
			limits.pathBytes,
		);
		const larger = nested([...Array.from({ length: 16 }, () => "x".repeat(255)), "z"]);
		refuses(larger.commit.id, larger.objects);
	});
	it("bounds supplied object count independently from expanded entry count", () => {
		const blobs = Array.from({ length: limits.objects - 2 }, (_, index) => {
			const bytes = Buffer.alloc(4);
			bytes.writeUInt32BE(index);
			return object("blob", bytes);
		});
		const tree = object(
			"tree",
			Buffer.concat(
				blobs.map((blob, index) => entry("100644", `f${String(index).padStart(5, "0")}`, blob.id)),
			),
		);
		const commit = root(tree);
		expect(verifyDatabaseObjectTree(commit.id, [commit, tree, ...blobs]).objectCount).toBe(
			limits.objects,
		);
		refuses(commit.id, [commit, tree, ...blobs, object("blob", "extra")]);
		const blob = object("blob", "reused");
		for (const count of [limits.entries, limits.entries + 1]) {
			const repeated = object(
				"tree",
				Buffer.concat(
					Array.from({ length: count }, (_, index) =>
						entry("100644", `f${String(index).padStart(5, "0")}`, blob.id),
					),
				),
			);
			const parent = root(repeated);
			if (count === limits.entries)
				expect(verifyDatabaseObjectTree(parent.id, [parent, repeated, blob]).entryCount).toBe(
					count,
				);
			else refuses(parent.id, [parent, repeated, blob]);
		}
	});
	it("refuses a complete 10001-object closure with 9999 referenced distinct four-byte blobs", () => {
		const blobs = Array.from({ length: 9999 }, (_, index) => {
			const bytes = Buffer.alloc(4);
			bytes.writeUInt32BE(index);
			return object("blob", bytes);
		});
		expect(new Set(blobs.map((blob) => blob.id)).size).toBe(9999);
		const tree = object(
			"tree",
			Buffer.concat(
				blobs.map((blob, index) => entry("100644", `f${String(index).padStart(5, "0")}`, blob.id)),
			),
		);
		expect(tree.bytes.length).toBe(339_966);
		const commit = root(tree);
		const objects = [commit, tree, ...blobs];
		expect(objects).toHaveLength(10_001);
		refuses(commit.id, objects);
	});
	it("bounds reused-tree expansion even when unique tree entries remain small", () => {
		let current = object("tree", "");
		const objects = [current];
		for (let index = 0; index < 14; index++) {
			current = object(
				"tree",
				Buffer.concat([entry("40000", "a", current.id), entry("40000", "b", current.id)]),
			);
			objects.push(current);
		}
		const commit = root(current);
		refuses(commit.id, [commit, ...objects]);
	});
	it("accepts exact 64MiB aggregate raw bytes and refuses the next byte", () => {
		const make = (extra: number) => {
			const names = Array.from({ length: 8 }, (_, index) => `file${index}`);
			const overhead =
				object("commit", `tree ${"0".repeat(40)}\n\nopaque`).bytes.length +
				names.reduce((sum, name) => sum + entry("100644", name, "0".repeat(40)).length, 0);
			const blobs = names.map((_, index) =>
				object(
					"blob",
					Buffer.alloc(limits.blobBytes - (index === 7 ? overhead - extra : 0), index),
				),
			);
			const tree = object(
				"tree",
				Buffer.concat(names.map((name, index) => entry("100644", name, blobs[index]?.id ?? ""))),
			);
			const commit = root(tree, "opaque");
			return { commit, objects: [commit, tree, ...blobs] };
		};
		const f = make(0);
		expect(verifyDatabaseObjectTree(f.commit.id, f.objects).totalObjectBytes).toBe(
			limits.totalBytes,
		);
		const larger = make(1);
		refuses(larger.commit.id, larger.objects);
	});
});
