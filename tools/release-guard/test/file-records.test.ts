import { describe, expect, it, vi } from "vitest";
import {
	relativeFile as bundlePath,
	records as bundleRecords,
} from "../../bundle-hub/src/inventory.ts";
import { relative as releasePath, records as releaseRecords } from "../src/integrity.ts";

const digest = "a".repeat(64);
const row = (path: string, bytes = 1) => ({ path, sha256: digest, bytes });
const consumers = [
	{ name: "bundle", path: bundlePath, records: bundleRecords },
	{ name: "release", path: releasePath, records: releaseRecords },
];

describe.each(consumers)("$name shared file policy", ({ path, records }) => {
	it.each([
		"DraftYak Setup 0.1.0.exe",
		"DraftYak.app/Contents/MacOS/DraftYak",
		"docs/R\u00e9lease notices.txt",
		"pkg/@scope/package-0.1.0.tgz",
		"native/LICENSE",
		"ordinary..name",
	])("preserves the legitimate artifact spelling %s", (file) => {
		expect(path(file)).toBe(file);
		expect(records([row(file)])).toEqual([row(file)]);
	});
	it.each([
		"../outside",
		"/absolute",
		"C:/escape",
		"\\\\host.example/share",
		"x\\y",
		"x//y",
		"x/./y",
		"x/../y",
		"x:stream",
		"NUL.txt",
		"CON .txt",
		"CONIN$",
		"CONOUT$.txt",
		"COM\u00b9.txt",
		"lpt\u00b2.bin",
		"a.",
		"a ",
		"a\u0000b",
		"a\u202eb",
		"a\ud800b",
		"a?b",
		".env.live",
		"nested/.ENV.config",
		".git/config",
		"nested/secret.KEY",
		"certificate.p12",
		"certificate.pfx",
		"state.db",
		"state.sqlite",
		"state.sqlite3",
		"logs/output.log",
	])("refuses the same unsafe or private artifact %j", (file) => {
		expect(() => path(file)).toThrow("unsafe or private-state");
		expect(() => records([row(file)])).toThrow();
	});
	it.each([
		{ names: ["same.bin", "same.bin"] },
		{ names: ["A.bin", "a.bin"] },
		{ names: ["Dir/a.bin", "dir/b.bin"] },
	])("refuses duplicate or case-alias paths $names", ({ names }) => {
		expect(() => records(names.map((name) => row(name)))).toThrow("case-aliased/colliding");
	});
	it.each([{ names: ["parent", "parent/child.bin"] }, { names: ["parent/child.bin", "parent"] }])(
		"refuses file/directory collisions in either input order $names",
		({ names }) => {
			expect(() => records(names.map((name) => row(name)))).toThrow("also a directory");
		},
	);
	it("retains distinct children under a directory with one spelling", () => {
		expect(records([row("dir/a.bin"), row("dir/b.bin")])).toEqual([
			row("dir/a.bin"),
			row("dir/b.bin"),
		]);
	});
	it.each([
		{ path: "file", sha256: digest, bytes: -1 },
		{ path: "file", sha256: digest, bytes: 0.5 },
		{ path: "file", sha256: digest, bytes: Number.MAX_SAFE_INTEGER + 1 },
		{ path: "file", sha256: digest, bytes: "1" },
		{ path: "file", sha256: digest.toUpperCase(), bytes: 1 },
		{ path: "file", sha256: digest.slice(1), bytes: 1 },
		{ path: "file", sha256: digest, bytes: 1, ignored: true },
	])("refuses invalid or additional record fields %j", (value) => {
		expect(() => records([value])).toThrow();
	});
	it("does not execute metadata getters or proxy traps", () => {
		const getter = vi.fn(() => "file");
		const value = { sha256: digest, bytes: 1 };
		Object.defineProperty(value, "path", { enumerable: true, get: getter });
		expect(() => records([value])).toThrow("inert");
		expect(getter).not.toHaveBeenCalled();
		const trap = vi.fn(() => {
			throw new Error("unexpected proxy trap");
		});
		const proxy = new Proxy(row("file"), { get: trap, ownKeys: trap, getPrototypeOf: trap });
		expect(() => records([proxy])).toThrow("inert");
		expect(trap).not.toHaveBeenCalled();
	});
	it("refuses sparse and accessor-backed lists without invoking an entry", () => {
		expect(() => records(new Array(1))).toThrow();
		const getter = vi.fn(() => row("file"));
		const entries = [row("file")];
		Object.defineProperty(entries, "0", { enumerable: true, get: getter });
		expect(() => records(entries)).toThrow("inert");
		expect(getter).not.toHaveBeenCalled();
	});
	it("refuses proxy-backed file lists without executing any traps", () => {
		const trap = vi.fn(() => {
			throw new Error("unexpected file list proxy trap");
		});
		const entries = new Proxy([row("file")], {
			get: trap,
			getOwnPropertyDescriptor: trap,
			getPrototypeOf: trap,
			ownKeys: trap,
		});
		expect(() => records(entries)).toThrow("inert");
		expect(trap).not.toHaveBeenCalled();
	});
});

describe("consumer-specific metadata limits and ordering", () => {
	it("sorts a bundle snapshot without modifying its caller and requires release order", () => {
		const source = [row("b.bin"), row("a.bin")];
		expect(bundleRecords(source)).toEqual([row("a.bin"), row("b.bin")]);
		expect(source).toEqual([row("b.bin"), row("a.bin")]);
		expect(() => releaseRecords(source)).toThrow("unsorted");
		expect(releaseRecords([row("a.bin"), row("b.bin")])).toEqual([row("a.bin"), row("b.bin")]);
	});
	it("preserves the 240 and 4096 character metadata path limits", () => {
		const name = (length: number) =>
			"a/".repeat(Math.floor((length - 1) / 2)) + (length % 2 ? "z" : "zz");
		expect(bundlePath(name(240))).toBe(name(240));
		expect(() => bundlePath(name(241))).toThrow();
		expect(releasePath(name(241))).toBe(name(241));
		expect(releasePath(name(4096))).toBe(name(4096));
		expect(() => releasePath(name(4097))).toThrow();
	});
	it("keeps bundle byte bounds distinct from safe-integer release metadata", () => {
		const limit = 512 * 1024 * 1024;
		expect(bundleRecords([row("file", 0)])).toEqual([row("file", 0)]);
		expect(bundleRecords([row("file", limit)])).toEqual([row("file", limit)]);
		expect(() => bundleRecords([row("file", limit + 1)])).toThrow("byte count");
		expect(releaseRecords([row("file", Number.MAX_SAFE_INTEGER)])).toEqual([
			row("file", Number.MAX_SAFE_INTEGER),
		]);
	});
	it("retains the bundle list cap without introducing a new release metadata cap", () => {
		const entries = Array.from({ length: 20_001 }, (_, index) =>
			row(`file-${String(index).padStart(5, "0")}`),
		);
		expect(bundleRecords(entries.slice(0, 20_000))).toHaveLength(20_000);
		expect(() => bundleRecords(entries)).toThrow("record limit");
		expect(releaseRecords(entries)).toHaveLength(20_001);
	});
});
