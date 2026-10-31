import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	Checkout,
	type FsOps,
	fold,
	type Kind,
	nodeFs,
	type Stat,
	TEXT_LIMIT,
} from "../lib/safe-fs.ts";
import {
	canLink,
	readerSpy,
	scrub,
	shortAlias,
	type TempRepo,
	type TempRepoOptions,
	tempRepo,
	word,
} from "./temp-repo.ts";

// The checked filesystem layer on fixture repositories. Reserved words are built at run time, and
// every compared path is scrubbed of them, so a failure prints neither a word nor a fixture path.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

function fixture(
	files: Readonly<Record<string, string>> = {},
	options?: TempRepoOptions,
): TempRepo {
	const repo = tempRepo(options);
	repos.push(repo);
	for (const [file, content] of Object.entries(files)) repo.write(file, content);
	return repo;
}

const w = word();
const windows = process.platform === "win32";
const foldsCase = windows || process.platform === "darwin";
const symlinks = canLink("file") && canLink("dir");
const NO_SYMLINKS =
	"file and folder symlinks need Developer Mode or elevation on this Windows host";

const kinds = (checkout: Checkout, rels: readonly string[]): string[] =>
	rels.map((rel) => scrub(`${rel}: ${checkout.kindOf(rel)}`));
const record =
	(visits: string[]) =>
	(rel: string, kind: Kind): void => {
		visits.push(scrub(`${rel}: ${kind}`));
	};
const unreadable = (rels: readonly string[]): string[] => rels.map(() => "unreadable");

const withFs = (overrides: Partial<FsOps>, inner: FsOps = nodeFs): FsOps => ({
	...inner,
	...overrides,
});
const fail = (code: string, message = "injected failure"): never => {
	throw Object.assign(new Error(message), { code });
};
const samePath = (a: string, b: string): boolean => fold(a) === fold(b);
// `stat` with some fields or answers changed.
const changed = (stat: Stat, change: Partial<Stat>): Stat => ({
	dev: stat.dev,
	ino: stat.ino,
	nlink: stat.nlink,
	size: stat.size,
	isFile: () => stat.isFile(),
	isDirectory: () => stat.isDirectory(),
	isSymbolicLink: () => stat.isSymbolicLink(),
	...change,
});
// Listings without link flags, so only lstat can tell a link.
const unflagged = withFs({
	readdir: (dir) =>
		nodeFs.readdir(dir).map((entry) => ({ name: entry.name, isSymbolicLink: () => false })),
});
const flagging = (...names: string[]): FsOps =>
	withFs({
		readdir: (dir) =>
			nodeFs
				.readdir(dir)
				.map((entry) =>
					names.includes(entry.name) ? { name: entry.name, isSymbolicLink: () => true } : entry,
				),
	});

describe("kinds", () => {
	it("names a file, a folder, the root, and paths that are missing or below a file", () => {
		const repo = fixture({ "pkgs/a/x.ts": "export {};\n" });
		const checkout = new Checkout(repo.dir);
		const rels = [
			"",
			"pkgs",
			"pkgs/a",
			"pkgs/a/x.ts",
			"pkgs/a/y.ts",
			"pkgs/b/y.ts",
			"pkgs/a/x.ts/y",
		];
		expect(kinds(checkout, rels)).toEqual([
			": dir",
			"pkgs: dir",
			"pkgs/a: dir",
			"pkgs/a/x.ts: file",
			"pkgs/a/y.ts: missing",
			"pkgs/b/y.ts: missing",
			"pkgs/a/x.ts/y: missing",
		]);
	});

	it("reads a junction on the way, and every path below it, as a link and never lists it", () => {
		const repo = fixture({ "pkgs/a/real/x.ts": "", "pkgs/b/src/x.ts": "" });
		repo.link("pkgs/a/src", "pkgs/a/real", "junction");
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		expect(kinds(checkout, ["pkgs/a/src/x.ts", "pkgs/a/src", "pkgs/b/src/x.ts"])).toEqual([
			"pkgs/a/src/x.ts: link",
			"pkgs/a/src: link",
			"pkgs/b/src/x.ts: file",
		]);
		expect(spy.readdirs).toEqual(["", "pkgs", "pkgs/a", "pkgs/b", "pkgs/b/src"]);
		expect(spy.opens).toEqual([]);
	});

	it("stops at a junction at the top of a path, listing nothing below the root", () => {
		const repo = fixture({ "elsewhere/a/src/x.ts": "" });
		repo.link("pkgs", "elsewhere", "junction");
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		expect(kinds(checkout, ["pkgs/a/src/x.ts"])).toEqual(["pkgs/a/src/x.ts: link"]);
		expect(spy.readdirs).toEqual([""]);
		expect(kinds(checkout, ["elsewhere/a/src/x.ts"])).toEqual(["elsewhere/a/src/x.ts: file"]);
	});

	it("reads both names of a hard-linked file as hard links, and a junction named like a file as a link", () => {
		const root = `pkgs/zz-${w}/`;
		const repo = fixture({ "pkgs/a/x.ts": "x", [`${root}held.ts`]: "held", "pkgs/b/y.ts": "y" });
		repo.hardlink("pkgs/a/copy.ts", `${root}held.ts`);
		repo.link("pkgs/a/j.ts", "pkgs/b", "junction");
		const rels = [
			"pkgs/a/x.ts",
			"pkgs/a/copy.ts",
			`${root}held.ts`,
			"pkgs/a/j.ts",
			"pkgs/a/j.ts/y.ts",
		];
		expect(kinds(new Checkout(repo.dir), rels)).toEqual([
			"pkgs/a/x.ts: file",
			"pkgs/a/copy.ts: hardlink",
			"pkgs/zz-<reserved>/held.ts: hardlink",
			"pkgs/a/j.ts: link",
			"pkgs/a/j.ts/y.ts: link",
		]);
	});

	it("reads file and folder symlinks as links, a dangling one too", (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/b/y.ts": "y" });
		repo.link("pkgs/a/l.ts", "pkgs/a/x.ts", "file");
		repo.link("pkgs/a/d", "pkgs/b", "dir");
		repo.link("pkgs/a/gone.ts", path.join(repo.outside, "none.ts"), "file");
		const rels = ["pkgs/a/l.ts", "pkgs/a/d", "pkgs/a/d/y.ts", "pkgs/a/gone.ts", "pkgs/a/x.ts"];
		expect(kinds(new Checkout(repo.dir), rels)).toEqual([
			"pkgs/a/l.ts: link",
			"pkgs/a/d: link",
			"pkgs/a/d/y.ts: link",
			"pkgs/a/gone.ts: link",
			"pkgs/a/x.ts: file",
		]);
	});

	it("takes a listing's reparse flag over lstat, as Windows flags reparse points lstat calls files", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/a/sub/y.ts": "y" });
		const spy = readerSpy(repo.dir, undefined, flagging("x.ts", "sub"));
		const checkout = new Checkout(repo.dir, spy.fs);
		expect(kinds(checkout, ["pkgs/a/x.ts", "pkgs/a/sub", "pkgs/a/sub/y.ts"])).toEqual([
			"pkgs/a/x.ts: link",
			"pkgs/a/sub: link",
			"pkgs/a/sub/y.ts: link",
		]);
		expect(checkout.readText("pkgs/a/x.ts")).toBe("unreadable");
		expect(spy.opens).toEqual([]);
		expect(spy.readdirs).toEqual(["", "pkgs", "pkgs/a"]);
		expect(kinds(new Checkout(repo.dir), ["pkgs/a/x.ts", "pkgs/a/sub/y.ts"])).toEqual([
			"pkgs/a/x.ts: file",
			"pkgs/a/sub/y.ts: file",
		]);
	});

	it("tells a junction from lstat when the listing carries no flag", () => {
		const repo = fixture({ "pkgs/a/real/x.ts": "x", "pkgs/a/x.ts": "x" });
		repo.link("pkgs/a/j", "pkgs/a/real", "junction");
		const spy = readerSpy(repo.dir, undefined, unflagged);
		expect(
			kinds(new Checkout(repo.dir, spy.fs), ["pkgs/a/j", "pkgs/a/j/x.ts", "pkgs/a/x.ts"]),
		).toEqual(["pkgs/a/j: link", "pkgs/a/j/x.ts: link", "pkgs/a/x.ts: file"]);
		expect(spy.readdirs).toEqual(["", "pkgs", "pkgs/a"]);
	});

	it("tells a file symlink from lstat when the listing carries no flag", (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture({ "pkgs/a/x.ts": "x" });
		repo.link("pkgs/a/l.ts", "pkgs/a/x.ts", "file");
		expect(kinds(new Checkout(repo.dir, unflagged), ["pkgs/a/l.ts", "pkgs/a/x.ts"])).toEqual([
			"pkgs/a/l.ts: link",
			"pkgs/a/x.ts: file",
		]);
	});

	it("reads a folder whose real path isn't its path as a redirect, and everything below it", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/b/x.ts": "x" });
		const folder = path.join(repo.dir, "pkgs", "a");
		const redirected = withFs({
			realpath: (file) =>
				samePath(file, folder) ? path.join(repo.dir, "pkgs", "elsewhere") : nodeFs.realpath(file),
		});
		const checkout = new Checkout(repo.dir, redirected);
		expect(kinds(checkout, ["pkgs/a/x.ts", "pkgs/a", "pkgs/b/x.ts"])).toEqual([
			"pkgs/a/x.ts: redirect",
			"pkgs/a: redirect",
			"pkgs/b/x.ts: file",
		]);
		expect(checkout.readText("pkgs/a/x.ts")).toBe("unreadable");
	});

	it("reads a file whose real path isn't its path as a redirect", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/a/y.ts": "y" });
		const file = path.join(repo.dir, "pkgs", "a", "x.ts");
		const redirected = withFs({
			realpath: (p) =>
				samePath(p, file) ? path.join(repo.dir, "pkgs", "a", "y.ts") : nodeFs.realpath(p),
		});
		expect(kinds(new Checkout(repo.dir, redirected), ["pkgs/a/x.ts", "pkgs/a/y.ts"])).toEqual([
			"pkgs/a/x.ts: redirect",
			"pkgs/a/y.ts: file",
		]);
	});

	it("reads a short (8.3) name, which no listing holds, as a redirect", () => {
		const repo = fixture({ "pkgs/longfoldername/x.ts": "x" });
		const alias = path.join(repo.dir, "pkgs", "LONGFO~1");
		const long = path.join(repo.dir, "pkgs", "longfoldername");
		const resolve = (file: string): string =>
			fold(file).startsWith(fold(alias)) ? `${long}${file.slice(alias.length)}` : file;
		const shortNames = withFs({
			lstat: (file) => nodeFs.lstat(resolve(file)),
			realpath: (file) => nodeFs.realpath(resolve(file)),
		});
		const rels = ["pkgs/LONGFO~1/x.ts", "pkgs/LONGFO~1", "pkgs/longfoldername/x.ts"];
		expect(kinds(new Checkout(repo.dir, shortNames), rels)).toEqual([
			"pkgs/LONGFO~1/x.ts: redirect",
			"pkgs/LONGFO~1: redirect",
			"pkgs/longfoldername/x.ts: file",
		]);
	});

	it("reads a real 8.3 alias of a folder in the checkout as a redirect, and opens nothing through it", (ctx) => {
		ctx.skip(!windows, "8.3 aliases exist only on Windows");
		const repo = fixture({ "pkgs/longfoldername/x.ts": "x" });
		const alias = shortAlias(path.join(repo.dir, "pkgs", "longfoldername"));
		// The temp folder's volume must make short names: a null here fails the test, never skips it.
		expect(alias).not.toBe(null);
		const short = path.basename(alias ?? "");
		expect(short.includes("~")).toBe(true);
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(
			alias === null ? repo.dir : path.dirname(path.dirname(alias)),
			spy.fs,
		);
		expect(samePath(checkout.root, repo.dir)).toBe(true);
		const rels = [`pkgs/${short}/x.ts`, `pkgs/${short}`, "pkgs/longfoldername/x.ts"];
		expect(rels.map((rel) => checkout.kindOf(rel))).toEqual(["redirect", "redirect", "file"]);
		expect(checkout.readText(`pkgs/${short}/x.ts`)).toBe("unreadable");
		expect(checkout.walk(`pkgs/${short}`, () => true)).toBe("redirect");
		expect(spy.opens).toEqual([]);
	});

	it("finds a path spelled in another case only where the platform ignores case", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x" });
		const checkout = new Checkout(repo.dir);
		expect(checkout.kindOf("PKGS/A/X.TS")).toBe(foldsCase ? "file" : "missing");
		expect(checkout.readText("PKGS/A/X.TS")).toBe(foldsCase ? "x" : "unreadable");
	});

	it("reads anything but a file, a folder or a link as special, with nothing below it", () => {
		const repo = fixture({ "pkgs/a/fifo": "", "pkgs/a/x.ts": "x" });
		const fifo = path.join(repo.dir, "pkgs", "a", "fifo");
		const special = withFs({
			lstat: (file) => {
				const stat = nodeFs.lstat(file);
				return samePath(file, fifo) ? changed(stat, { isFile: () => false }) : stat;
			},
		});
		const checkout = new Checkout(repo.dir, special);
		expect(kinds(checkout, ["pkgs/a/fifo", "pkgs/a/fifo/x", "pkgs/a/x.ts"])).toEqual([
			"pkgs/a/fifo: special",
			"pkgs/a/fifo/x: missing",
			"pkgs/a/x.ts: file",
		]);
		expect(checkout.readText("pkgs/a/fifo")).toBe("unreadable");
	});

	it("reads a failing lstat, realpath or listing as unreadable, never as missing", () => {
		const files = {
			"pkgs/a/x.ts": "x",
			"pkgs/b/x.ts": "x",
			"pkgs/c/x.ts": "x",
			"pkgs/d/x.ts": "x",
		};
		const repo = fixture(files);
		const at = (...parts: string[]): string => path.join(repo.dir, ...parts);
		const failing = withFs({
			lstat: (file) =>
				samePath(file, at("pkgs", "a", "x.ts")) ? fail("EACCES") : nodeFs.lstat(file),
			realpath: (file) =>
				samePath(file, at("pkgs", "b", "x.ts")) ? fail("EPERM") : nodeFs.realpath(file),
			readdir: (dir) => (samePath(dir, at("pkgs", "c")) ? fail("EACCES") : nodeFs.readdir(dir)),
		});
		const rels = ["pkgs/a/x.ts", "pkgs/b/x.ts", "pkgs/c/x.ts", "pkgs/c/none.ts", "pkgs/d/x.ts"];
		expect(kinds(new Checkout(repo.dir, failing), [...rels, "pkgs/d/none.ts"])).toEqual([
			"pkgs/a/x.ts: unreadable",
			"pkgs/b/x.ts: unreadable",
			"pkgs/c/x.ts: unreadable",
			"pkgs/c/none.ts: unreadable",
			"pkgs/d/x.ts: file",
			"pkgs/d/none.ts: missing",
		]);
	});

	it("reads chmod 000 files and folders as unreadable", (ctx) => {
		const root = process.getuid?.() === 0;
		ctx.skip(windows || root, "chmod 000 denies reads only on POSIX, and not to root");
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/b/y.ts": "y" });
		const folder = path.join(repo.dir, "pkgs", "a");
		const file = path.join(repo.dir, "pkgs", "b", "y.ts");
		chmodSync(folder, 0o000);
		chmodSync(file, 0o000);
		try {
			const checkout = new Checkout(repo.dir);
			expect(kinds(checkout, ["pkgs/a/x.ts", "pkgs/a/none.ts", "pkgs/b/y.ts"])).toEqual([
				"pkgs/a/x.ts: unreadable",
				"pkgs/a/none.ts: unreadable",
				"pkgs/b/y.ts: file",
			]);
			expect(checkout.readText("pkgs/b/y.ts")).toBe("unreadable");
			expect(checkout.walk("pkgs/a", () => true)).toBe("unreadable");
		} finally {
			chmodSync(folder, 0o755);
			chmodSync(file, 0o644);
		}
	});

	it("answers unreadable, without a call, for anything but a plain path below the root", () => {
		const repo = fixture({ "a/b.ts": "b" });
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		const odd = [
			"../a/b.ts",
			"a/../a/b.ts",
			"./a/b.ts",
			"a/./b.ts",
			"a//b.ts",
			"/a/b.ts",
			"a/b.ts/",
		];
		const windowsOdd = [
			"a\\b.ts",
			"a/b.ts:stream",
			"a/b.ts.",
			"a/b.ts ",
			"a/con",
			"a/NUL.txt",
			"a/b?.ts",
		];
		const rels = [...odd, "a/b\0.ts", ...(windows ? windowsOdd : [])];
		expect(rels.map((rel) => checkout.kindOf(rel))).toEqual(unreadable(rels));
		expect(rels.map((rel) => checkout.readText(rel))).toEqual(unreadable(rels));
		expect([...spy.opens, ...spy.readdirs]).toEqual([]);
		expect(checkout.readText("a/b.ts")).toBe("b");
	});

	it("measures from the checkout's real folder, so a link above the root is fine", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x" });
		const via = path.join(path.dirname(repo.dir), "via");
		symlinkSync(repo.dir, via, "junction");
		const checkout = new Checkout(via);
		expect(samePath(checkout.root, repo.dir)).toBe(true);
		expect([checkout.kindOf("pkgs/a/x.ts"), checkout.readText("pkgs/a/x.ts")]).toEqual([
			"file",
			"x",
		]);
	});

	it("answers unreadable for everything when the root isn't a folder or can't be resolved", () => {
		const repo = fixture({ "x.ts": "x" });
		const unresolvable = undefined as unknown as string;
		for (const root of [path.join(repo.dir, "none"), path.join(repo.dir, "x.ts"), unresolvable]) {
			const checkout = new Checkout(root);
			const answers = [
				checkout.kindOf(""),
				checkout.kindOf("x.ts"),
				checkout.readText("x.ts"),
				checkout.walk("", () => true),
				checkout.realpathOf("x.ts"),
				checkout.kindOutside(repo.outside),
			];
			expect(answers).toEqual(answers.map(() => "unreadable"));
		}
	});
});

describe("checked reads", () => {
	it("reads a regular file of the checkout, dropping a BOM from the text but not from the bytes", () => {
		const bom = String.fromCharCode(0xfeff);
		const repo = fixture({
			"pkgs/a/x.ts": "export const a = 1;\n",
			"pkgs/a/b.json": `${bom}{"a":1}`,
		});
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		expect(checkout.readText("pkgs/a/x.ts")).toBe("export const a = 1;\n");
		expect(checkout.readText("pkgs/a/b.json")).toBe('{"a":1}');
		const bytes = checkout.readBytes("pkgs/a/b.json");
		expect(bytes === "unreadable" ? bytes : [...bytes.slice(0, 4)]).toEqual([
			0xef, 0xbb, 0xbf, 0x7b,
		]);
		expect(spy.opens).toEqual(["pkgs/a/x.ts", "pkgs/a/b.json", "pkgs/a/b.json"]);
	});

	it("never opens a reserved-named path or one in an allowed root, in any case", () => {
		const root = "pkgs/zz-held/";
		const repo = fixture({
			[`pkgs/a/x-${w}.ts`]: "x",
			[`pkgs/a/${word("_")}/y.ts`]: "y",
			[`pkgs/a/${word("-")}.ts`]: "z",
			[`${root}src/a.ts`]: "a",
			[`${root}package.json`]: "{}",
			"pkgs/a/plain.ts": "plain",
		});
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs, { allowedRoots: [root] });
		const held = [
			`pkgs/a/x-${w}.ts`,
			`pkgs/a/X-${w.toUpperCase()}.ts`,
			`pkgs/a/${word("_")}/y.ts`,
			`pkgs/a/${word("-")}.ts`,
			`${root}src/a.ts`,
			`${root}package.json`,
			"PKGS/ZZ-HELD/src/a.ts",
		];
		expect(held.map((rel) => checkout.readText(rel))).toEqual(unreadable(held));
		expect(held.map((rel) => checkout.readBytes(rel))).toEqual(unreadable(held));
		expect(spy.opens).toEqual([]);
		expect(kinds(checkout, [`pkgs/a/x-${w}.ts`, `${root}src/a.ts`])).toEqual([
			"pkgs/a/x-<reserved>.ts: file",
			"pkgs/zz-held/src/a.ts: file",
		]);
		expect(checkout.readText("pkgs/a/plain.ts")).toBe("plain");
		expect(spy.opens).toEqual(["pkgs/a/plain.ts"]);
	});

	it("reads ordinary files of a checkout whose own folder name holds a reserved word", () => {
		const repo = fixture(
			{ "pkgs/a/x.ts": "x", [`pkgs/a/${w}.ts`]: "y" },
			{ name: `checkout-${w}` },
		);
		const checkout = new Checkout(repo.dir);
		expect([checkout.readText("pkgs/a/x.ts"), checkout.readText(`pkgs/a/${w}.ts`)]).toEqual([
			"x",
			"unreadable",
		]);
	});

	it("never opens node_modules or .git contents", () => {
		const repo = fixture({
			"node_modules/m/index.js": "m",
			"pkgs/a/node_modules/m/index.js": "m",
			"pkgs/a/x.ts": "x",
		});
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		const held = [
			"node_modules/m/index.js",
			"pkgs/a/node_modules/m/index.js",
			".git/HEAD",
			".git/config",
			...(foldsCase ? ["Node_Modules/m/index.js", ".GIT/HEAD"] : []),
		];
		expect(held.map((rel) => checkout.readText(rel))).toEqual(unreadable(held));
		expect(spy.opens).toEqual([]);
		expect(checkout.readText("pkgs/a/x.ts")).toBe("x");
	});

	it("opens nothing but a regular file with one link, reached through real folders", () => {
		const repo = fixture({ "pkgs/a/plain.ts": "p", "pkgs/a/orig.ts": "o", "pkgs/b/y.ts": "y" });
		repo.hardlink("pkgs/a/copy.ts", "pkgs/a/orig.ts");
		repo.link("pkgs/a/j", "pkgs/b", "junction");
		const folder = path.join(repo.dir, "pkgs", "b");
		const redirected = withFs({
			realpath: (file) =>
				samePath(file, folder) ? path.join(repo.dir, "pkgs", "c") : nodeFs.realpath(file),
		});
		const spy = readerSpy(repo.dir, undefined, redirected);
		const checkout = new Checkout(repo.dir, spy.fs);
		const refused = [
			"pkgs/a/copy.ts",
			"pkgs/a/orig.ts",
			"pkgs/a/j/y.ts",
			"pkgs/a/j",
			"pkgs/b/y.ts",
			"pkgs/a/none.ts",
			"pkgs/a",
			"",
		];
		expect(refused.map((rel) => checkout.readText(rel))).toEqual(unreadable(refused));
		expect(spy.opens).toEqual([]);
		expect(checkout.readText("pkgs/a/plain.ts")).toBe("p");
		expect(spy.opens).toEqual(["pkgs/a/plain.ts"]);
	});

	it("opens no file symlink", (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture({ "pkgs/a/plain.ts": "p" });
		repo.link("pkgs/a/l.ts", "pkgs/a/plain.ts", "file");
		const spy = readerSpy(repo.dir);
		expect(new Checkout(repo.dir, spy.fs).readText("pkgs/a/l.ts")).toBe("unreadable");
		expect(spy.opens).toEqual([]);
	});

	it("refuses a descriptor that isn't the file the kind check saw", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/a/other.ts": "other" });
		const other = path.join(repo.dir, "pkgs", "a", "other.ts");
		const swapped = withFs({ open: (_file, flags) => nodeFs.open(other, flags) });
		const fstat = (change: (stat: Stat) => Partial<Stat>): FsOps =>
			withFs({
				fstat: (fd) => {
					const stat = nodeFs.fstat(fd);
					return changed(stat, change(stat));
				},
			});
		const variants = [
			swapped,
			fstat((stat) => ({ ino: stat.ino + 1n })),
			fstat((stat) => ({ dev: stat.dev + 1n })),
			fstat(() => ({ nlink: 2n })),
			fstat(() => ({ isFile: () => false })),
		];
		const answers = variants.map((fs) => new Checkout(repo.dir, fs).readText("pkgs/a/x.ts"));
		expect(answers).toEqual(variants.map(() => "unreadable"));
		expect(new Checkout(repo.dir).readText("pkgs/a/x.ts")).toBe("x");
	});

	it("refuses a NUL byte, more than 8 MiB, and a file that grows past that while it's read", () => {
		const repo = fixture({
			"a/zero.ts": "a\0b",
			"a/max.txt": "x".repeat(TEXT_LIMIT),
			"a/over.txt": "x".repeat(TEXT_LIMIT + 1),
			"a/small.txt": "small",
		});
		const checkout = new Checkout(repo.dir);
		expect(TEXT_LIMIT).toBe(8 * 1024 * 1024);
		const answers = ["a/zero.ts", "a/over.txt", "a/max.txt"].map((rel) => checkout.readText(rel));
		expect(answers.map((text) => (text === "unreadable" ? text : text.length))).toEqual([
			"unreadable",
			"unreadable",
			TEXT_LIMIT,
		]);
		const stale = new Checkout(
			repo.dir,
			withFs({ fstat: (fd) => changed(nodeFs.fstat(fd), { size: 5n }) }),
		);
		expect([stale.readText("a/over.txt"), stale.readText("a/small.txt")]).toEqual([
			"unreadable",
			"small",
		]);
	});

	it("reads a failing open, fstat or read as unreadable, never as empty text", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/a/empty.ts": "" });
		const variants = [
			withFs({ open: () => fail("EACCES") }),
			withFs({ fstat: () => fail("EBADF") }),
			withFs({ read: () => fail("EIO") }),
			withFs({ read: () => -1 }),
			withFs({ read: (_fd, _buffer, _offset, length) => length + 1 }),
		];
		const answers = variants.map((fs) => new Checkout(repo.dir, fs).readText("pkgs/a/x.ts"));
		expect(answers).toEqual(variants.map(() => "unreadable"));
		const checkout = new Checkout(repo.dir);
		expect([checkout.readText("pkgs/a/x.ts"), checkout.readText("pkgs/a/empty.ts")]).toEqual([
			"x",
			"",
		]);
	});

	it("lets no error object or message out", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x", "pkgs/m/package.json": "{}" });
		const marker = `injected-${w}`;
		const raise = (): never => fail("EACCES", marker);
		const throwing: FsOps = {
			lstat: raise,
			realpath: raise,
			readdir: raise,
			open: raise,
			fstat: raise,
			read: raise,
			close: raise,
		};
		const variants = [
			throwing,
			withFs({ open: raise }),
			withFs({ fstat: raise }),
			withFs({ read: raise }),
			withFs({ close: raise }),
		];
		const answers = variants.flatMap((fs) => {
			const checkout = new Checkout(repo.dir, fs, { allowedRoots: ["pkgs/m/"] });
			return [
				checkout.kindOf("pkgs/a/x.ts"),
				checkout.readText("pkgs/a/x.ts"),
				checkout.openAllowedManifest("pkgs/m/package.json"),
				checkout.walk("pkgs", () => true),
				checkout.realpathOf("pkgs/a/x.ts"),
				checkout.kindOutside(repo.outside),
			];
		});
		expect(scrub(JSON.stringify(answers)).includes("injected")).toBe(false);
		// A close that fails after a full read loses nothing.
		expect(answers.slice(-5, -3)).toEqual(["x", "{}"]);
	});
});

describe("walks", () => {
	it("visits names and kinds below a folder, never listing a link, node_modules or .git", () => {
		const repo = fixture({
			"pkgs/a/x.ts": "",
			"pkgs/a/sub/y.ts": "",
			"pkgs/a/node_modules/m/index.js": "",
			"pkgs/a/.git/HEAD": "",
			"pkgs/a/orig.ts": "",
			"pkgs/b/z.ts": "",
		});
		repo.link("pkgs/a/j", "pkgs/b", "junction");
		repo.hardlink("pkgs/a/h.ts", "pkgs/a/orig.ts");
		const spy = readerSpy(repo.dir);
		const visits: string[] = [];
		expect(new Checkout(repo.dir, spy.fs).walk("pkgs/a", record(visits))).toBe("dir");
		expect(visits).toEqual([
			"pkgs/a/.git: dir",
			"pkgs/a/h.ts: hardlink",
			"pkgs/a/j: link",
			"pkgs/a/node_modules: dir",
			"pkgs/a/orig.ts: hardlink",
			"pkgs/a/sub: dir",
			"pkgs/a/x.ts: file",
			"pkgs/a/sub/y.ts: file",
		]);
		expect(spy.readdirs).toEqual(["", "pkgs", "pkgs/a", "pkgs/a/sub"]);
		expect(spy.opens).toEqual([]);
	});

	it("never lists a start in node_modules or .git", () => {
		const repo = fixture({ "pkgs/a/node_modules/m/index.js": "", "pkgs/a/x.ts": "" });
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		const visits: string[] = [];
		const starts = [
			"pkgs/a/node_modules",
			"pkgs/a/node_modules/m",
			".git",
			...(foldsCase ? ["pkgs/a/Node_Modules", ".GIT"] : []),
		];
		expect(starts.map((rel) => checkout.walk(rel, record(visits)))).toEqual(unreadable(starts));
		expect([...visits, ...spy.readdirs, ...spy.opens]).toEqual([]);
		expect(checkout.walk("pkgs/a", record(visits))).toBe("dir");
		expect(visits).toEqual(["pkgs/a/node_modules: dir", "pkgs/a/x.ts: file"]);
		expect(spy.readdirs).toEqual(["", "pkgs", "pkgs/a"]);
	});

	it("never lists a folder the visitor returns false for", () => {
		const repo = fixture({ "pkgs/a/sub/y.ts": "", "pkgs/a/other/z.ts": "" });
		const spy = readerSpy(repo.dir);
		const visits: string[] = [];
		const visit = (rel: string, kind: Kind): boolean => {
			record(visits)(rel, kind);
			return rel !== "pkgs/a/sub";
		};
		expect(new Checkout(repo.dir, spy.fs).walk("pkgs/a", visit)).toBe("dir");
		expect(visits).toEqual(["pkgs/a/other: dir", "pkgs/a/sub: dir", "pkgs/a/other/z.ts: file"]);
		expect(spy.readdirs).toEqual(["", "pkgs", "pkgs/a", "pkgs/a/other"]);
	});

	it("visits a folder it can't list a second time, as unreadable, and walks the rest", () => {
		const repo = fixture({ "pkgs/a/sub/y.ts": "", "pkgs/a/x.ts": "" });
		const sub = path.join(repo.dir, "pkgs", "a", "sub");
		const denied = withFs({
			readdir: (dir) => (samePath(dir, sub) ? fail("EACCES") : nodeFs.readdir(dir)),
		});
		const visits: string[] = [];
		expect(new Checkout(repo.dir, denied).walk("pkgs/a", record(visits))).toBe("dir");
		expect(visits).toEqual(["pkgs/a/sub: dir", "pkgs/a/sub: unreadable", "pkgs/a/x.ts: file"]);
	});

	it("visits a flagged entry, or one lstat calls a link, as a link and never lists it", () => {
		const repo = fixture({ "pkgs/a/sub/y.ts": "", "pkgs/a/real/z.ts": "" });
		repo.link("pkgs/a/j", "pkgs/a/real", "junction");
		const flagged = readerSpy(repo.dir, undefined, flagging("sub"));
		const flaggedVisits: string[] = [];
		new Checkout(repo.dir, flagged.fs).walk("pkgs/a", record(flaggedVisits));
		expect(flaggedVisits).toEqual([
			"pkgs/a/j: link",
			"pkgs/a/real: dir",
			"pkgs/a/sub: link",
			"pkgs/a/real/z.ts: file",
		]);
		expect(flagged.readdirs).toEqual(["", "pkgs", "pkgs/a", "pkgs/a/real"]);
		const plain = readerSpy(repo.dir, undefined, unflagged);
		const plainVisits: string[] = [];
		new Checkout(repo.dir, plain.fs).walk("pkgs/a", record(plainVisits));
		expect(plainVisits).toEqual([
			"pkgs/a/j: link",
			"pkgs/a/real: dir",
			"pkgs/a/sub: dir",
			"pkgs/a/real/z.ts: file",
			"pkgs/a/sub/y.ts: file",
		]);
		expect(plain.readdirs).toEqual(["", "pkgs", "pkgs/a", "pkgs/a/real", "pkgs/a/sub"]);
	});

	it("returns the start's kind, visiting nothing, when it isn't a folder it can list", () => {
		const repo = fixture({ "pkgs/a/x.ts": "", "pkgs/b/y.ts": "" });
		repo.link("pkgs/j", "pkgs/b", "junction");
		const b = path.join(repo.dir, "pkgs", "b");
		const denied = withFs({
			readdir: (dir) => (samePath(dir, b) ? fail("EACCES") : nodeFs.readdir(dir)),
		});
		const checkout = new Checkout(repo.dir, denied);
		const visits: string[] = [];
		const starts = ["pkgs/none", "pkgs/a/x.ts", "pkgs/j", "pkgs/b", "../x"];
		expect(starts.map((rel) => checkout.walk(rel, record(visits)))).toEqual([
			"missing",
			"file",
			"link",
			"unreadable",
			"unreadable",
		]);
		expect(visits).toEqual([]);
	});
});

describe("the allowed root's manifest", () => {
	const root = `pkgs/zz-${w}/`;

	it("opens an allowed root's own package.json and nothing else there", () => {
		const repo = fixture({
			[`${root}package.json`]: '{"scripts":{"test":"x"}}',
			[`${root}src/a.ts`]: "a",
			[`${root}sub/package.json`]: "{}",
			"pkgs/other/package.json": "{}",
		});
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs, { allowedRoots: [root] });
		const others = [
			`${root}src/a.ts`,
			`${root}sub/package.json`,
			`${root}PACKAGE.JSON`,
			`${root.toUpperCase()}package.json`,
			`${root}./package.json`,
			`${root}../other/package.json`,
			"pkgs/other/package.json",
			"package.json",
			root,
		];
		expect(others.map((rel) => checkout.openAllowedManifest(rel))).toEqual(unreadable(others));
		expect(spy.opens).toEqual([]);
		expect(checkout.openAllowedManifest(`${root}package.json`)).toBe('{"scripts":{"test":"x"}}');
		expect(checkout.readText(`${root}package.json`)).toBe("unreadable");
		expect(spy.opens).toEqual(["pkgs/zz-<reserved>/package.json"]);
	});

	it("opens it only as a regular file with one link, below real folders", () => {
		const linked = fixture({ [`${root}package.json`]: "{}" });
		linked.hardlink("pkgs/b/copy.json", `${root}package.json`);
		const reached = fixture({ "pkgs/real/package.json": "{}" });
		reached.link(root.slice(0, -1), "pkgs/real", "junction");
		const answers = [linked, reached].map((repo) => {
			const spy = readerSpy(repo.dir);
			const checkout = new Checkout(repo.dir, spy.fs, { allowedRoots: [root] });
			return [checkout.openAllowedManifest(`${root}package.json`), ...spy.opens];
		});
		expect(answers).toEqual([["unreadable"], ["unreadable"]]);
	});
});

describe("real paths and paths outside the checkout", () => {
	it("follows links to where they lead, inside or outside the checkout, from metadata alone", () => {
		const repo = fixture({ "pkgs/b/x.ts": "x" });
		writeFileSync(path.join(repo.outside, "o.txt"), "o");
		repo.link("pkgs/a/in", "pkgs/b", "junction");
		repo.link("pkgs/a/out", repo.outside, "junction");
		const spy = readerSpy(repo.dir);
		const checkout = new Checkout(repo.dir, spy.fs);
		expect(checkout.realpathOf("pkgs/a/in")).toEqual({
			abs: path.join(repo.dir, "pkgs", "b"),
			rel: "pkgs/b",
		});
		expect(checkout.realpathOf("pkgs/a/in/x.ts")).toEqual({
			abs: path.join(repo.dir, "pkgs", "b", "x.ts"),
			rel: "pkgs/b/x.ts",
		});
		expect(checkout.realpathOf("pkgs/a/out")).toEqual({ abs: repo.outside, rel: null });
		expect(checkout.realpathOf("")).toEqual({ abs: repo.dir, rel: "" });
		expect([checkout.realpathOf("pkgs/a/none"), checkout.realpathOf("../x")]).toEqual([
			"missing",
			"unreadable",
		]);
		expect([...spy.opens, ...spy.readdirs]).toEqual([]);
	});

	it("names what lies outside the checkout from lstat, and nothing inside it", () => {
		const repo = fixture({ "pkgs/a/x.ts": "x" });
		writeFileSync(path.join(repo.outside, "o.txt"), "o");
		mkdirSync(path.join(repo.outside, "node_modules"));
		const checkout = new Checkout(repo.dir);
		const paths = [
			path.join(repo.outside, "o.txt"),
			path.join(repo.outside, "node_modules"),
			path.join(repo.outside, "none"),
			path.join(repo.dir, "pkgs"),
			repo.dir,
			"relative/x",
		];
		expect(paths.map((abs) => checkout.kindOutside(abs))).toEqual([
			"file",
			"dir",
			"missing",
			"unreadable",
			"unreadable",
			"unreadable",
		]);
	});
});

describe("fold", () => {
	it("compares paths as each platform does", () => {
		const decomposed = `e${String.fromCharCode(0x301)}`;
		const composed = String.fromCharCode(0xe9);
		expect(fold("C:\\Dev\\Repo/A.ts", "win32")).toBe("c:/dev/repo/a.ts");
		expect(fold(`/Users/A/${decomposed}.ts`, "darwin")).toBe(`/users/a/${composed}.ts`);
		expect(fold("/home/A\\b.ts", "linux")).toBe("/home/A\\b.ts");
		expect(fold("X/Y")).toBe(foldsCase ? "x/y" : "X/Y");
	});
});

describe("fixture repositories", () => {
	it("builds the reserved words at run time and scrubs them", () => {
		expect([word().length, word("-").length, word("_").length]).toEqual([4, 13, 13]);
		const spike = ["s0", "7"].join("");
		const text = `a/${w}/${word("-").toUpperCase()}/${word("_")}/${spike}-x`;
		expect(scrub(text)).toBe("a/<reserved>/<reserved>/<reserved>/<reserved>x");
	});

	it("makes file and folder symlinks wherever CI runs, so no symlink case skips there", () => {
		const ci = process.env.CI === "true";
		expect(ci && !(canLink("file") && canLink("dir"))).toBe(false);
		expect(canLink("junction")).toBe(true);
	});

	it("makes index symlinks, gitlinks, skip-worktree entries and ignores, with git's config isolated", () => {
		const repo = fixture({ "a.ts": "a", "b.ts": "b", "ignored/x.ts": "x" });
		repo.ignore("ignored/");
		const head = repo.commit();
		repo.indexLink("l", "a.ts");
		repo.gitlink("sub", head);
		repo.skipWorktree("b.ts");
		const entries = repo
			.git("ls-files", "-s")
			.split("\n")
			.map((line) => `${line.split(" ")[0]} ${line.split("\t")[1]}`);
		expect(entries).toEqual(["100644 a.ts", "100644 b.ts", "120000 l", "160000 sub"]);
		expect(repo.git("ls-files", "-v", "--", "b.ts")).toBe("S b.ts");
		expect(repo.git("check-ignore", "ignored/x.ts")).toBe("ignored/x.ts");
		const scopes = repo
			.git("config", "--list", "--show-scope")
			.split("\n")
			.map((line) => line.split("\t")[0]);
		expect([...new Set(scopes)].toSorted()).toEqual(["global", "local"]);
		expect(repo.git("config", "--global", "maintenance.auto")).toBe("false");
		expect(canLink("junction")).toBe(true);
	});
});
