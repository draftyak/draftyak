import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	ArtifactError,
	MAX_ARCHIVE_BYTES,
	MAX_BUNDLE_BYTES,
	MAX_FILE_BYTES,
	MAX_FILES,
	portablePath,
	unpackTarball,
} from "../../src/artifacts/archive.ts";
import { makeTar, type TarEntry, writeTarChecksum } from "./fixtures.ts";

const unpack = (entries: readonly TarEntry[]): ReadonlyMap<string, Buffer> =>
	unpackTarball(gzipSync(makeTar(entries)));

describe("neutral artifact archive", () => {
	it("returns exact owned regular-file bytes and accepts explicit and implicit directories", () => {
		const files = unpack([
			{ name: "package/", type: "5" },
			{ name: "package/lib/", type: "5" },
			{ name: "package/lib/main.mjs", body: "DYTEST" },
			{ name: "package/implicit/empty", body: "" },
		]);
		expect([...files.keys()]).toEqual(["lib/main.mjs", "implicit/empty"]);
		expect(files.get("lib/main.mjs")).toEqual(Buffer.from("DYTEST"));
		expect(files.get("implicit/empty")).toEqual(Buffer.alloc(0));
	});

	it("uses the artifact200/16/200 portable limits and preserves allowed spelling", () => {
		expect(portablePath("A".repeat(200))).toBe("A".repeat(200));
		expect(portablePath(Array(16).fill("a").join("/"))).toBe(Array(16).fill("a").join("/"));
		const nested = `${"a".repeat(99)}/${"b".repeat(100)}`;
		expect(portablePath(nested)).toBe(nested);
		expect(portablePath("@scope/a+b-c_1.mjs")).toBe("@scope/a+b-c_1.mjs");
		for (const name of [
			"A".repeat(201),
			`${"a".repeat(100)}/${"b".repeat(100)}`,
			Array(17).fill("a").join("/"),
			"a\n",
			"a\r",
			"a/../b",
			"a//b",
			"a\\b",
			"CON.txt",
			"a/COM0/file",
			"a/fi le",
			"a/x\uFEFF",
			"a:stream",
			"a/\uD800",
			"a/last.",
			".npmrc",
			"a/.hidden",
		])
			expect(() => portablePath(name)).toThrow(ArtifactError);
	});

	it("leaves native and dependency-tree selection to the real consumers", () => {
		const files = unpack([
			{ name: "package/Addon.node", body: "DYTEST data, not loaded" },
			{ name: "package/NODE_MODULES/child.js", body: "DYTEST" },
		]);
		expect([...files.keys()]).toEqual(["Addon.node", "NODE_MODULES/child.js"]);
	});

	it("checks the checksum even when the rest of the header is structurally valid", () => {
		const tar = makeTar([{ name: "package/a", body: "DYTEST" }]);
		tar[100] = tar[100] === 48 ? 49 : 48;
		expect(() => unpackTarball(gzipSync(tar))).toThrow(ArtifactError);
	});

	it.each([
		["non-octal size", 124, 56],
		["base256 size", 124, 128],
		["non-octal mode", 100, 56],
		["non-octal mode digit", 106, 56],
		["non-octal owner id", 108, 56],
		["non-octal group id", 116, 56],
		["non-octal modification time", 136, 56],
		["non-ASCII header", 265, 128],
		["control byte in owner name", 265, 1],
		["control byte in group name", 297, 1],
		["unsupported magic", 257, 88],
		["unsupported version", 263, 49],
		["nonzero device major number", 329, 49],
		["nonzero device minor number", 337, 49],
		["unused header payload", 500, 1],
	] as const)("refuses %s independently of checksum", (_label, at, value) => {
		const tar = makeTar([{ name: "package/a", body: "DYTEST" }]);
		tar[at] = value;
		writeTarChecksum(tar.subarray(0, 512));
		expect(() => unpackTarball(gzipSync(tar))).toThrow(ArtifactError);
	});

	it("does not discard nonzero bytes after a text field terminator", () => {
		const tar = makeTar([{ name: "package/a", body: "DYTEST" }]);
		tar[20] = 65;
		writeTarChecksum(tar.subarray(0, 512));
		expect(() => unpackTarball(gzipSync(tar))).toThrow(ArtifactError);
	});

	it.each(["1", "2", "3", "4", "6", "x", "g", "L", "K", "S"])(
		"refuses TAR type%s without relying on a nonempty link target",
		(type) => expect(() => unpack([{ name: "package/a", type }])).toThrow(ArtifactError),
	);

	it("refuses link metadata on a nominal regular file", () => {
		expect(() => unpack([{ name: "package/a", linkname: "DYTEST-target" }])).toThrow(ArtifactError);
	});

	it.each([
		"outside/a",
		"Package/a",
		"package",
		"package/a/",
		"package//a",
		"package/../a",
		"package/.npmignore",
	])("refuses invalid root or member spelling %s", (name) =>
		expect(() => unpack([{ name }])).toThrow(ArtifactError),
	);

	it("joins a valid USTAR prefix without normalizing its path", () => {
		expect(
			unpack([{ name: "a.mjs", prefix: "package/lib", body: "DYTEST" }]).get("lib/a.mjs"),
		).toEqual(Buffer.from("DYTEST"));
		expect(() => unpack([{ name: "a", prefix: "package/.." }])).toThrow(ArtifactError);
	});

	it("accepts USTAR00 or an empty V7 marker, but rejects mixed marker versions and V7 prefixes", () => {
		const original = makeTar([{ name: "package/a", body: "DYTEST" }]);
		const v7 = Buffer.from(original);
		v7.fill(0, 257, 265);
		writeTarChecksum(v7.subarray(0, 512));
		expect(unpackTarball(gzipSync(v7)).get("a")).toEqual(Buffer.from("DYTEST"));
		const prefixed = makeTar([{ name: "a", prefix: "package", body: "DYTEST" }]);
		expect(unpackTarball(gzipSync(prefixed)).get("a")).toEqual(Buffer.from("DYTEST"));
		prefixed.fill(0, 257, 265);
		writeTarChecksum(prefixed.subarray(0, 512));
		expect(() => unpackTarball(gzipSync(prefixed))).toThrow(ArtifactError);
		for (const [magic, version] of [
			["ustar\0", "\0\0"],
			["\0\0\0\0\0\0", "00"],
		] as const) {
			const tar = Buffer.from(original);
			Buffer.from(magic, "ascii").copy(tar, 257);
			Buffer.from(version, "ascii").copy(tar, 263);
			writeTarChecksum(tar.subarray(0, 512));
			expect(() => unpackTarball(gzipSync(tar))).toThrow(ArtifactError);
		}
	});

	it("refuses a later path spelled differently from an explicit directory entry", () => {
		expect(
			unpack([{ name: "package/Dir/", type: "5" }, { name: "package/Dir/b" }]).has("Dir/b"),
		).toBe(true);
		expect(() => unpack([{ name: "package/Dir/", type: "5" }, { name: "package/dir/b" }])).toThrow(
			ArtifactError,
		);
	});

	it("refuses directory payloads and accepts zero-size directory roles", () => {
		expect(() =>
			unpack([{ name: "package/a/", type: "5", body: "x" }, { name: "package/a/file" }]),
		).toThrow(ArtifactError);
		expect(
			unpack([{ name: "package/a/", type: "5" }, { name: "package/a/file" }]).has("a/file"),
		).toBe(true);
	});

	it("refuses an archive without regular files", () => {
		expect(() => unpack([])).toThrow(ArtifactError);
		expect(() =>
			unpack([
				{ name: "package/", type: "5" },
				{ name: "package/a/", type: "5" },
			]),
		).toThrow(ArtifactError);
		expect(unpack([{ name: "package/", type: "5" }, { name: "package/a" }]).has("a")).toBe(true);
	});

	it.each([
		["duplicate file", [{ name: "package/a" }, { name: "package/a" }]],
		["case collision", [{ name: "package/A" }, { name: "package/a" }]],
		["prefix spelling", [{ name: "package/Dir/a" }, { name: "package/dir/b" }]],
		["directory under a file", [{ name: "package/a" }, { name: "package/a/b", type: "5" }]],
		["file replacing a directory", [{ name: "package/a/b", type: "5" }, { name: "package/a" }]],
		[
			"duplicate root",
			[{ name: "package/", type: "5" }, { name: "package/", type: "5" }, { name: "package/a" }],
		],
		[
			"duplicate directory",
			[
				{ name: "package/d/", type: "5" },
				{ name: "package/d/", type: "5" },
				{ name: "package/d/a" },
			],
		],
	] as const)("refuses %s before materialization", (_label, entries) => {
		expect(() => unpack(entries)).toThrow(ArtifactError);
	});

	it("requires two complete zero blocks and no later nonzero or misaligned bytes", () => {
		const entries = [{ name: "package/a", body: "DYTEST" }];
		for (const zeroBlocks of [0, 1])
			expect(() => unpackTarball(gzipSync(makeTar(entries, { zeroBlocks })))).toThrow(
				ArtifactError,
			);
		expect(() => unpackTarball(gzipSync(makeTar(entries, { trailing: Buffer.from([1]) })))).toThrow(
			ArtifactError,
		);
		expect(() => unpackTarball(gzipSync(makeTar(entries, { trailing: Buffer.alloc(1) })))).toThrow(
			ArtifactError,
		);
		expect(() =>
			unpackTarball(gzipSync(makeTar(entries, { trailing: Buffer.alloc(512, 1) }))),
		).toThrow(ArtifactError);
		expect(unpackTarball(gzipSync(makeTar(entries, { zeroBlocks: 4 }))).get("a")).toEqual(
			Buffer.from("DYTEST"),
		);
	});

	it("refuses truncated member bytes and hidden data in member padding", () => {
		const tar = makeTar([{ name: "package/a", body: "x" }]);
		expect(() => unpackTarball(gzipSync(tar.subarray(0, 512)))).toThrow(ArtifactError);
		tar[513] = 1;
		expect(() => unpackTarball(gzipSync(tar))).toThrow(ArtifactError);
	});

	it("counts directories as headers at the exact1024 boundary", () => {
		expect(MAX_FILES).toBe(1024);
		const entries: TarEntry[] = Array.from({ length: 1023 }, (_, n) => ({
			name: `package/d${n}`,
			type: "5",
		}));
		entries.push({ name: "package/file" });
		expect(unpack(entries).size).toBe(1);
		entries.unshift({ name: "package/extra", type: "5" });
		expect(() => unpack(entries)).toThrow(ArtifactError);
	});

	it("accepts16MiB file bytes and refuses one more byte", () => {
		expect(MAX_FILE_BYTES).toBe(16 * 1024 * 1024);
		expect(
			unpack([{ name: "package/a", body: Buffer.alloc(16 * 1024 * 1024) }]).get("a")?.length,
		).toBe(16 * 1024 * 1024);
		expect(() => unpack([{ name: "package/a", body: Buffer.alloc(16 * 1024 * 1024 + 1) }])).toThrow(
			ArtifactError,
		);
	});

	it("accepts64MiB total file bytes and refuses one extra byte", () => {
		expect(MAX_BUNDLE_BYTES).toBe(64 * 1024 * 1024);
		const data = Buffer.alloc(16 * 1024 * 1024);
		const entries = Array.from({ length: 4 }, (_, n) => ({ name: `package/f${n}`, body: data }));
		expect(unpack(entries).size).toBe(4);
		expect(() =>
			unpack([...entries, { name: "package/overflow", body: Buffer.from([1]) }]),
		).toThrow(ArtifactError);
	});

	it("admits 1,024 members holding exactly 64 MiB with maximal padding", () => {
		const large = Buffer.alloc(16 * 1024 * 1024 - 511);
		const entries: TarEntry[] = Array.from({ length: 1024 }, (_, n) => ({
			name: `package/f${n}`,
			body: n < 4 ? large : Buffer.alloc(n < 6 ? 513 : 1),
		}));
		const tar = makeTar(entries);
		expect(tar.length).toBe(64 * 1024 * 1024 + 1024 * 1023 + 1024);
		const files = unpackTarball(gzipSync(tar));
		expect(files.size).toBe(1024);
		expect([...files.values()].reduce((sum, bytes) => sum + bytes.length, 0)).toBe(
			64 * 1024 * 1024,
		);
	}, 60_000);

	it("bounds decompressed TAR including its fixed header/padding overhead", () => {
		const base = makeTar([{ name: "package/a", body: "DYTEST" }]);
		const exactLimit = 64 * 1024 * 1024 + 1024 * 1023 + 1024;
		const exact = Buffer.concat([base, Buffer.alloc(exactLimit - base.length)]);
		expect(unpackTarball(gzipSync(exact)).get("a")).toEqual(Buffer.from("DYTEST"));
		expect(() => unpackTarball(gzipSync(Buffer.concat([exact, Buffer.alloc(512)])))).toThrow(
			ArtifactError,
		);
	});

	it("admits exactly32MiB compressed input and refuses one more byte", () => {
		expect(MAX_ARCHIVE_BYTES).toBe(32 * 1024 * 1024);
		const small = gzipSync(makeTar([{ name: "package/a", body: "DYTEST" }]));
		const withComment = (size: number): Buffer => {
			const header = Buffer.from(small.subarray(0, 10));
			header[3] = (header[3] ?? 0) | 16;
			return Buffer.concat([
				header,
				Buffer.alloc(size - small.length - 1, 65),
				Buffer.from([0]),
				small.subarray(10),
			]);
		};
		expect(unpackTarball(withComment(32 * 1024 * 1024)).get("a")).toEqual(Buffer.from("DYTEST"));
		expect(() => unpackTarball(withComment(32 * 1024 * 1024 + 1))).toThrow(ArtifactError);
	});
});
