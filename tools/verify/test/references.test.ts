import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reservedWord } from "../../../reserved-tests.ts";
import { listCheckout, listedSet } from "../lib/listing.ts";
import {
	OUTSIDE,
	parseToml,
	type ReferenceCheck,
	references,
	resolveFrom,
} from "../lib/references.ts";
import { Checkout, fold } from "../lib/safe-fs.ts";
import { gitEnvOf, ownRepo, readerSpy, scrub, type TempRepo, tempRepo, word } from "./temp-repo.ts";

// The references listed files make, on synthetic repositories. A candidate is only kind-checked:
// the reader spy refuses every open of an ignored file or of one outside the repository, and no
// test may see one. Compared paths are scrubbed.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

const w = word();

interface Tree {
	readonly files?: Readonly<Record<string, string>>;
	readonly ignored?: Readonly<Record<string, string>>;
	// Written after the commit and not ignored: listed, but not in the index.
	readonly untracked?: Readonly<Record<string, string>>;
	// Files in the folder beside the repository, which "../outside/" from its root reaches.
	readonly outside?: Readonly<Record<string, string>>;
	// Junctions to the folder beside the repository, made after the commit.
	readonly junctions?: readonly string[];
}

// The allowed root the reference checks get, which no walk may enter.
const allowedRoot = `spikes/zz-${w}/`;

// In file texts, <IN> stands for the repository's absolute path and <OUT> for the folder beside
// it, with / separators.
function placed(repo: TempRepo, text: string): string {
	const forward = (dir: string): string => dir.split(path.sep).join("/");
	return text.replaceAll("<IN>", forward(repo.dir)).replaceAll("<OUT>", forward(repo.outside));
}

function fixture(tree: Tree): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	for (const [file, text] of Object.entries(tree.files ?? {})) repo.write(file, placed(repo, text));
	repo.commit();
	const ignored = Object.keys(tree.ignored ?? {});
	if (ignored.length > 0) repo.ignore(...ignored);
	for (const [file, text] of Object.entries({ ...tree.ignored, ...tree.untracked })) {
		repo.write(file, text);
	}
	for (const [file, text] of Object.entries(tree.outside ?? {})) {
		const at = path.join(repo.outside, ...file.split("/"));
		mkdirSync(path.dirname(at), { recursive: true });
		writeFileSync(at, text);
	}
	for (const file of tree.junctions ?? []) repo.link(file, repo.outside, "junction");
	return repo;
}

// What one check refuses, as "path: kind", with every ignored file's open refused, and every open
// outside the repository.
async function refused(tree: Tree, check: ReferenceCheck): Promise<string[]> {
	const repo = fixture(tree);
	const { listing } = await listCheckout(repo.dir, { env: gitEnvOf(repo) });
	if (listing === null) throw new Error("no listing");
	const ignored = new Set(Object.keys(tree.ignored ?? {}));
	const spy = readerSpy(
		repo.dir,
		(rel) => ignored.has(rel) || reservedWord.test(rel) || path.isAbsolute(rel),
	);
	const checkout = new Checkout(repo.dir, spy.fs);
	const listed = listedSet(listing);
	const isListed = (rel: string): boolean => listed.has(fold(rel));
	const indexed = new Set(listing.entries.map((entry) => fold(entry.path)));
	const tracked = (rel: string): boolean => indexed.has(fold(rel));
	const files = [...listing.entries.map((entry) => entry.path), ...listing.untracked].filter(
		(rel) => checkout.kindOf(rel) === "file" && !reservedWord.test(rel),
	);
	const text = (rel: string): string | null => {
		const got = isListed(rel) ? checkout.readText(rel) : "unreadable";
		return got === "unreadable" ? null : got;
	};
	const allowedRoots = [allowedRoot];
	const found = references(check, {
		checkout,
		listed: isListed,
		tracked,
		files,
		text,
		allowedRoots,
	});
	expect(spy.refused).toEqual([]);
	expect(spy.readdirs.filter((dir) => path.isAbsolute(dir))).toEqual([]);
	return found.refused.map(({ rel, kind }) => scrub(`${rel}: ${kind}`));
}

// Targets beside the repository for the references that leave it: each exists, so a refusal never
// rests on a missing file.
const BESIDE: Readonly<Record<string, string>> = {
	"helper.ts": "export {};\n",
	"helper.js": "",
	"m.rs": "",
	"t.txt": "",
	"base.json": "{}\n",
	"rules.grit": "",
	"x/a.ts": "",
	"x/a.test.ts": "",
	"c/Cargo.toml": '[package]\nname = "c"\n',
	"pkg/package.json": '{ "name": "pkg" }\n',
	"tsconfig.json": "{}\n",
};

describe("refs-rust", () => {
	const crate = (lib: string, more: Readonly<Record<string, string>> = {}) => ({
		"r/Cargo.toml": '[package]\nname = "r"\n',
		"r/src/lib.rs": lib,
		...more,
	});

	it("follows mod declarations the Rust Reference way, and finds nothing missing to refuse", async () => {
		const files = crate("mod a;\nmod b;\nmod missing;\n", {
			"r/src/a.rs": "mod c;\n",
			"r/src/a/c.rs": "",
			"r/src/b/mod.rs": "mod d;\n",
			"r/src/b/d.rs": "",
			"r/tests/it.rs": "mod common;\n",
			"r/tests/common/mod.rs": "",
		});
		expect(await refused({ files }, "refs-rust")).toEqual([]);
	});

	it("refuses an ignored module a bare mod reaches, from a crate root and from a module file", async () => {
		const files = crate("mod a;\nmod x;\n", { "r/src/a.rs": "mod y;\n" });
		const ignored = { "r/src/x.rs": "", "r/src/a/y/mod.rs": "" };
		expect(await refused({ files, ignored }, "refs-rust")).toEqual([
			"r/src/a/y/mod.rs: unlisted",
			"r/src/x.rs: unlisted",
		]);
	});

	it("refuses an ignored #[path] target, on an outer and an inline module and inside cfg_attr", async () => {
		const lib = [
			'#[path = "gen/out.rs"]\nmod out;',
			'#[cfg_attr(unix, path = "gen/unix.rs")]\nmod sys;',
			'#[path = "inner_files"]\nmod inner {\n    #[path = "deep.rs"]\n    mod deep;\n}',
			"mod plain {\n    mod nested;\n}",
		].join("\n");
		const ignored = {
			"r/src/gen/out.rs": "",
			"r/src/gen/unix.rs": "",
			"r/src/inner_files/deep.rs": "",
			"r/src/plain/nested.rs": "",
		};
		expect(await refused({ files: crate(lib), ignored }, "refs-rust")).toEqual([
			"r/src/gen/out.rs: unlisted",
			"r/src/gen/unix.rs: unlisted",
			"r/src/inner_files/deep.rs: unlisted",
			"r/src/plain/nested.rs: unlisted",
		]);
	});

	it("refuses an include_str! literal into an ignored file, and an include! of one", async () => {
		const lib =
			'const T: &str = include_str!("../data/t.txt");\ninclude!(concat!("../gen/", "g.rs"));\n';
		const ignored = { "r/data/t.txt": "", "r/gen/g.rs": "" };
		expect(await refused({ files: crate(lib), ignored }, "refs-rust")).toEqual([
			"r/data/t.txt: unlisted",
			"r/gen/g.rs: unlisted",
		]);
	});

	it("refuses a reserved-named module whether or not its file exists", async () => {
		const lib = `mod x_${w};\n`;
		expect(await refused({ files: crate(lib) }, "refs-rust")).toEqual([
			"r/src/x_<reserved>.rs: reserved",
			"r/src/x_<reserved>/mod.rs: reserved",
			"r/src/lib/x_<reserved>.rs: reserved",
			"r/src/lib/x_<reserved>/mod.rs: reserved",
		]);
	});

	it("refuses a #[path] or include! target outside the checkout, absolute or climbing above the root, naming the file that declares it", async () => {
		const files = {
			"r/Cargo.toml": '[package]\nname = "r"\n',
			"r/src/lib.rs": '#[path = "../../../outside/m.rs"]\nmod m;\nmod plain;\n',
			"s/src/lib.rs": 'const T: &str = include_str!("<OUT>/t.txt");\n',
			"t/src/lib.rs": 'include!(concat!("../../../", "repo/t/src/g.rs"));\n',
			"u/src/lib.rs": '#[path = "../gen/out.rs"]\nmod out;\n',
		};
		expect(await refused({ files, outside: BESIDE }, "refs-rust")).toEqual([
			"r/src/lib.rs: outside",
			"s/src/lib.rs: outside",
			"t/src/lib.rs: outside",
		]);
	});

	it("refuses a #[path] or include! value with a name Windows trims, and one from a drive's own working folder", async () => {
		const files = {
			"r/Cargo.toml": '[package]\nname = "r"\n',
			"r/src/lib.rs": '#[path = "gen./out.rs"]\nmod out;\n',
			"s/src/lib.rs": 'const T: &str = include_str!("C:t.txt");\n',
			"t/src/lib.rs": 'const T: &str = include_str!("data /t.txt");\n',
			"u/src/lib.rs": '#[path = "gen/out.rs"]\nmod out;\n',
		};
		expect(await refused({ files }, "refs-rust")).toEqual([
			"r/src/lib.rs: unsupported",
			"s/src/lib.rs: outside",
			"t/src/lib.rs: unsupported",
		]);
	});

	it("refuses a module file replaced by a junction", async () => {
		const repo = fixture({ files: crate("mod a;\n") });
		repo.link("r/src/a.rs", repo.outside, "junction");
		const { listing } = await listCheckout(repo.dir, { env: gitEnvOf(repo) });
		const checkout = new Checkout(repo.dir);
		const listed = listedSet(listing ?? { root: "", entries: [], untracked: [] });
		const input = {
			checkout,
			listed: (rel: string) => listed.has(fold(rel)),
			tracked: (rel: string) => listed.has(fold(rel)),
			files: ["r/src/lib.rs"],
			text: () => "mod a;\n",
			allowedRoots: [],
		};
		expect(references("refs-rust", input).refused).toEqual([{ rel: "r/src/a.rs", kind: "link" }]);
	});
});

describe("refs-cargo", () => {
	it("refuses path dependencies, [patch] and target paths that exist but aren't listed", async () => {
		const manifest = [
			'[package]\nname = "r"',
			'[lib]\npath = "gen/lib.rs"',
			'[[bin]]\nname = "b"\npath = "gen/bin.rs"\nbuild = "not-a-reference.rs"',
			'[dependencies]\nd = { path = "../d" }',
			"[dev-dependencies.e]\npath = '../e'",
			"[target.'cfg(unix)'.build-dependencies]\nf = { path = \"../f\" }",
			'[patch.crates-io]\ng = { path = "../g" }',
			'[replace]\n"h:1.0.0" = { path = "../h" }',
		].join("\n\n");
		const ignored = {
			"r/gen/lib.rs": "",
			"r/gen/bin.rs": "",
			"r/not-a-reference.rs": "",
			"d/Cargo.toml": "",
			"e/Cargo.toml": "",
			"f/Cargo.toml": "",
			"g/Cargo.toml": "",
			"h/Cargo.toml": "",
		};
		expect(await refused({ files: { "r/Cargo.toml": manifest }, ignored }, "refs-cargo")).toEqual([
			"r/gen/lib.rs: unlisted",
			"r/gen/bin.rs: unlisted",
			"d/Cargo.toml: unlisted",
			"e/Cargo.toml: unlisted",
			"f/Cargo.toml: unlisted",
			"g/Cargo.toml: unlisted",
			"h/Cargo.toml: unlisted",
		]);
	});

	it("refuses [package] build and workspace paths into ignored files and folders, and leaves build = false alone", async () => {
		const files = {
			"r/Cargo.toml": '[package]\nname = "r"\nbuild = "tools/b.rs"\nworkspace = "../ws"\n',
			"q/Cargo.toml": '[package]\nname = "q"\nbuild = false\n',
		};
		const ignored = { "r/tools/b.rs": "", "ws/Cargo.toml": "[workspace]\n", "q/build.rs": "" };
		expect(await refused({ files, ignored }, "refs-cargo")).toEqual([
			"r/tools/b.rs: unlisted",
			"ws/Cargo.toml: unlisted",
		]);
	});

	it("refuses [workspace] members, exclude and [workspace.dependencies] entries into ignored folders", async () => {
		const manifest =
			'[workspace]\nmembers = ["m", "globbed/*"]\nexclude = ["x"]\n\n[workspace.dependencies]\nwd = { path = "wd" }\n';
		const repo = {
			files: { "Cargo.toml": manifest },
			ignored: { "m/Cargo.toml": "", "wd/Cargo.toml": "" },
		};
		expect(await refused(repo, "refs-cargo")).toEqual([
			"m/Cargo.toml: unlisted",
			"wd/Cargo.toml: unlisted",
		]);
	});

	it("refuses .cargo config paths and [patch] paths, at the folder holding .cargo", async () => {
		const config = 'paths = ["vendored/p"]\n\n[patch.crates-io]\nq = { path = "vendored/q" }\n';
		const tree = {
			files: { "w/.cargo/config.toml": config },
			ignored: { "w/vendored/p/Cargo.toml": "", "w/vendored/q/Cargo.toml": "" },
		};
		expect(await refused(tree, "refs-cargo")).toEqual([
			"w/vendored/p/Cargo.toml: unlisted",
			"w/vendored/q/Cargo.toml: unlisted",
		]);
	});

	it("leaves listed and missing paths alone, and refuses a manifest it can't parse", async () => {
		const files = {
			"r/Cargo.toml":
				'[package]\nname = "r"\n\n[dependencies]\nd = { path = "../d" }\nn = { path = "../none" }\nv = "1"\n',
			"d/Cargo.toml": '[package]\nname = "d"\n',
			"bad/Cargo.toml": "[package\nname = 1\n",
		};
		expect(await refused({ files }, "refs-cargo")).toEqual(["bad/Cargo.toml: unparsable"]);
	});

	it("refuses a Cargo path outside the checkout, absolute or climbing above the root, naming the file that holds it", async () => {
		const files = {
			"r/Cargo.toml": '[package]\nname = "r"\nbuild = "../../outside/m.rs"\n',
			"s/Cargo.toml": '[package]\nname = "s"\nworkspace = "../../outside"\n',
			"t/Cargo.toml": '[package]\nname = "t"\n\n[lib]\npath = "<OUT>/m.rs"\n',
			"u/Cargo.toml": '[package]\nname = "u"\n\n[dependencies]\nc = { path = "../../outside/c" }\n',
			"v/Cargo.toml": '[package]\nname = "v"\n\n[[bin]]\nname = "b"\npath = "../../outside/m.rs"\n',
			"w/.cargo/config.toml": 'paths = ["../../outside/c"]\n',
			"x/Cargo.toml": '[workspace]\nmembers = ["../../outside/c"]\n',
			"y/Cargo.toml":
				'[package]\nname = "y"\n\n[patch.crates-io]\nc = { path = "../../repo/y/c" }\n',
			"z/Cargo.toml": '[package]\nname = "z"\n\n[dependencies]\nd = { path = "../d" }\n',
		};
		expect(await refused({ files, outside: BESIDE }, "refs-cargo")).toEqual([
			"r/Cargo.toml: outside",
			"s/Cargo.toml: outside",
			"t/Cargo.toml: outside",
			"u/Cargo.toml: outside",
			"v/Cargo.toml: outside",
			"w/.cargo/config.toml: outside",
			"x/Cargo.toml: outside",
			"y/Cargo.toml: outside",
		]);
	});

	it("refuses a Cargo path with a name Windows trims, and one from a drive's own working folder", async () => {
		const files = {
			"r/Cargo.toml": '[package]\nname = "r"\n\n[lib]\npath = "src./lib.rs"\n',
			"s/Cargo.toml": '[package]\nname = "s"\n\n[dependencies]\nc = { path = "C:c" }\n',
			"t/Cargo.toml": '[package]\nname = "t"\n\n[dependencies]\nc = { path = "../c " }\n',
		};
		expect(await refused({ files }, "refs-cargo")).toEqual([
			"r/Cargo.toml: unsupported",
			"s/Cargo.toml: outside",
			"t/Cargo.toml: unsupported",
		]);
	});

	it("refuses a .cargo config key other than paths and [patch], which could point Cargo at other sources or programs", async () => {
		const files = {
			"a/.cargo/config.toml":
				'[source.crates-io]\nreplace-with = "vendored"\n\n[source.vendored]\ndirectory = "vendor"\n',
			"b/.cargo/config.toml": '[build]\nrustc-wrapper = "./wrap.sh"\n',
			"c/.cargo/config": '[target.x86_64-unknown-linux-gnu]\nlinker = "./ld"\nrunner = "./run"\n',
			"d/.cargo/config.toml": '[env]\nRUSTC_BOOTSTRAP = "1"\n',
			"e/.cargo/config.toml": 'include = ["more.toml"]\n',
			"f/.cargo/config.toml": 'paths = ["p"]\n\n[patch.crates-io]\nq = { path = "q" }\n',
		};
		expect(await refused({ files }, "refs-cargo")).toEqual([
			"a/.cargo/config.toml: unsupported",
			"b/.cargo/config.toml: unsupported",
			"c/.cargo/config: unsupported",
			"d/.cargo/config.toml: unsupported",
			"e/.cargo/config.toml: unsupported",
		]);
	});

	it("refuses a toolchain file that gives rustup a path or a form it doesn't check, and leaves a named toolchain alone", async () => {
		const files = {
			"rust-toolchain.toml":
				'[toolchain]\nchannel = "1.95.0"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n',
			"a/rust-toolchain.toml": '[toolchain]\npath = "./tc"\n',
			"b/rust-toolchain.toml": '[toolchain]\nchannel = "../tc"\n',
			"c/rust-toolchain": "./tc\n",
			"d/rust-toolchain": "stable-x86_64-unknown-linux-gnu\n",
			"e/rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n\n[other]\nx = 1\n',
			"f/rust-toolchain.toml": '[toolchain]\ntargets = ["../custom.json"]\n',
			"g/rust-toolchain.toml": "[toolchain\n",
			"h/rust-toolchain": '[toolchain]\nchannel = "nightly-2026-10-01"\n',
		};
		expect(await refused({ files }, "refs-cargo")).toEqual([
			"a/rust-toolchain.toml: unsupported",
			"b/rust-toolchain.toml: unsupported",
			"c/rust-toolchain: unsupported",
			"e/rust-toolchain.toml: unsupported",
			"f/rust-toolchain.toml: unsupported",
			"g/rust-toolchain.toml: unparsable",
		]);
	});
});

describe("refs-modules", () => {
	it("refuses a relative literal into an ignored file, through the .js-to-.ts remap and folder index files", async () => {
		const files = {
			"p/src/a.ts": [
				'import "./gen.js";',
				'export * from "./lib";',
				'const c = await import("../conf/c.mjs");',
				'const u = new URL("./data.json", import.meta.url);',
				'const other = "./not-loaded.ts";',
			].join("\n"),
		};
		const ignored = {
			"p/src/gen.ts": "",
			"p/src/lib/index.ts": "",
			"p/conf/c.mts": "",
			"p/src/data.json": "",
			"p/src/not-loaded.ts": "",
		};
		expect(await refused({ files, ignored }, "refs-modules")).toEqual([
			"p/src/gen.ts: unlisted",
			"p/src/lib/index.ts: unlisted",
			"p/conf/c.mts: unlisted",
			"p/src/data.json: unlisted",
		]);
	});

	it("follows a folder's package.json entry points", async () => {
		const files = {
			"p/a.ts": 'import "./dep";\n',
			"p/dep/package.json": '{ "main": "built/main.js", "exports": { ".": "./built/e.js" } }\n',
		};
		const ignored = { "p/dep/built/main.js": "", "p/dep/built/e.ts": "" };
		expect(await refused({ files, ignored }, "refs-modules")).toEqual([
			"p/dep/built/main.js: unlisted",
			"p/dep/built/e.ts: unlisted",
		]);
	});

	it("leaves bare specifiers, missing files and listed files alone", async () => {
		const files = {
			"p/a.ts":
				'import "vitest";\nimport "node:fs";\nimport "./b.ts";\nimport "./none.js";\nimport "../none.ts";\n',
			"p/b.ts": "",
		};
		const ignored = { "node_modules/vitest/index.js": "" };
		expect(await refused({ files, ignored }, "refs-modules")).toEqual([]);
	});

	it("refuses a specifier or runner config path that leaves the checkout, absolute or climbing above the root, even back into it", async () => {
		const files = {
			"p/a.ts": 'import "../../outside/helper.ts";\n',
			"p/b.ts": 'export * from "../../repo/p/c.ts";\n',
			"p/c.ts": 'const m = await import("<OUT>/helper.ts");\n',
			"p/d.ts": 'const u = new URL("../../outside/t.txt", import.meta.url);\n',
			"p/e.ts": 'import type { X } from "<OUT>/helper.ts?raw";\n',
			"p/f.ts": 'const r = require("../../outside/helper.js");\n',
			"p/g.ts": 'import "./dep";\n',
			"p/dep/package.json": '{ "main": "../../../outside/helper.js" }\n',
			"q/vitest.config.ts":
				'export default { test: { setupFiles: ["../../outside/helper.ts"] } };\n',
			"r/vitest.config.ts":
				'export default { test: { include: ["../../outside/x/**/*.test.ts"] } };\n',
			"s/vite.config.ts": 'export default { root: "<OUT>" };\n',
		};
		expect(await refused({ files, outside: BESIDE }, "refs-modules")).toEqual([
			"p/a.ts: outside",
			"p/b.ts: outside",
			"p/c.ts: outside",
			"p/d.ts: outside",
			"p/e.ts: outside",
			"p/f.ts: outside",
			"p/dep/package.json: outside",
			"q/vitest.config.ts: outside",
			"r/vitest.config.ts: outside",
			"s/vite.config.ts: outside",
		]);
	});

	it("follows an absolute specifier below the root as a module, refuses a file: URL one, and leaves other literals alone", async () => {
		const files = {
			"p/a.ts": 'import "<IN>/p/gen.js";\n',
			"p/b.ts": 'import "file:///elsewhere/x.js";\n',
			"p/c.ts": 'const other = "../../outside/helper.ts";\nconst text = "<OUT>/helper.ts";\n',
		};
		const ignored = { "p/gen.ts": "" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-modules")).toEqual([
			"p/gen.ts: unlisted",
			"p/b.ts: unsupported",
		]);
	});

	it("refuses a glob import, as outside when a pattern or a negated one leaves the checkout, opening and listing nothing", async () => {
		const files = {
			"p/a.ts": 'export const m = import.meta.glob("../../outside/x/*.ts", { eager: true });\n',
			"p/b.ts": 'const m = import.meta.glob(["./gen/*.ts", "!./gen/skip.ts"]);\n',
			"p/c.ts": 'const m = import.meta.glob<Record<string, unknown>>("/src/**/*.ts");\n',
			"p/d.ts": 'const m = import.meta.glob(["!../../outside/x/*.ts"]);\n',
			"p/e.ts": 'const pattern = "./gen/*.ts";\nconst m = other.glob("./gen/*.ts");\n',
		};
		const ignored = { "p/gen/x.ts": "" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-modules")).toEqual([
			"p/a.ts: outside",
			"p/b.ts: unsupported",
			"p/c.ts: unsupported",
			"p/d.ts: outside",
		]);
	});

	it("refuses a module path with a name Windows trims, relative or absolute, and leaves a config's free text alone", async () => {
		const files = {
			"p/a.ts": 'import "./helpers./h.js";\n',
			"p/b.ts": 'import "<IN>/p/gen./x.js";\n',
			"p/c.ts": 'const m = await import("./x.ts?raw");\nimport "./ok.ts";\n',
			"p/vitest.config.ts": 'export default { test: { setupFiles: ["./setup./x.ts"] } };\n',
		};
		expect(await refused({ files }, "refs-modules")).toEqual([
			"p/a.ts: unsupported",
			"p/b.ts: unsupported",
		]);
	});

	it("reads every path a Vitest config names, as files, and its relative ones as modules", async () => {
		const files = {
			"p/vitest.config.ts":
				'export default { test: { setupFiles: ["test/setup.ts", "./test/more"] } };\n',
		};
		const ignored = { "p/test/setup.ts": "", "p/test/more.ts": "" };
		expect(await refused({ files, ignored }, "refs-modules")).toEqual([
			"p/test/setup.ts: unlisted",
			"p/test/more.ts: unlisted",
		]);
	});

	it("refuses a reserved-named target even when it is missing", async () => {
		const files = { "p/a.ts": `import "./x-${w}.ts";\n` };
		expect(await refused({ files }, "refs-modules")).toEqual(["p/x-<reserved>.ts: reserved"]);
	});

	it("checks the package.json a # specifier resolves through, the nearest one up, and refuses an ignored one", async () => {
		const files = {
			"p/package.json": '{ "name": "p" }\n',
			"p/src/deep/a.ts": 'import { x } from "#x";\nexport type { Y } from "#y";\n',
			"q/package.json": '{ "name": "q" }\n',
			"q/src/b.ts": 'const b = await import("#b");\n',
			"r/c.ts": 'const id = "#c";\n',
		};
		const ignored = { "p/src/package.json": '{ "imports": { "#x": "./gen/x.js" } }\n' };
		// Only a literal that loads or resolves a module counts: r/c.ts has none, so its folder's
		// ignored package.json is the scans' business, not this check's.
		const tree = { files, ignored: { ...ignored, "r/package.json": "{}\n" } };
		expect(await refused(tree, "refs-modules")).toEqual(["p/src/package.json: unlisted"]);
	});
});

describe("refs-config", () => {
	it("refuses a package.json file: spec, and link: and portal: specs, into ignored folders", async () => {
		const manifest = {
			name: "p",
			dependencies: { a: "file:../vendor/a", b: "link:../vendor/b", c: "portal:../vendor/c" },
			devDependencies: { d: "file:../vendor/d.tgz", e: "workspace:*", f: "^1.0.0" },
		};
		const files = { "p/package.json": JSON.stringify(manifest) };
		const ignored = {
			"vendor/a/package.json": "{}",
			"vendor/b/package.json": "{}",
			"vendor/c/package.json": "{}",
			"vendor/d.tgz": "",
		};
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"vendor/a/package.json: unlisted",
			"vendor/b/package.json: unlisted",
			"vendor/c/package.json: unlisted",
			"vendor/d.tgz: unlisted",
		]);
	});

	it("refuses tsconfig extends and references into ignored files, and leaves a package's config alone", async () => {
		const tsconfig = {
			extends: ["../base/strict", "@tsconfig/node24/tsconfig.json"],
			references: [{ path: "../q" }, { path: "../r/tsconfig.build.json" }],
			files: ["gen/env.d.ts"],
			compilerOptions: { typeRoots: ["./types"], paths: { "#x": ["./gen/x"] } },
		};
		const files = { "p/tsconfig.json": JSON.stringify(tsconfig), "q/a.ts": "" };
		const ignored = {
			"base/strict.json": "{}",
			"q/tsconfig.json": "{}",
			"r/tsconfig.build.json": "{}",
			"p/gen/env.d.ts": "",
			"p/gen/x.ts": "",
		};
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"base/strict.json: unlisted",
			"q/tsconfig.json: unlisted",
			"r/tsconfig.build.json: unlisted",
			"p/gen/env.d.ts: unlisted",
			"p/gen/x.ts: unlisted",
		]);
	});

	it("refuses an HTML src or href into an ignored file, and leaves URLs and anchors alone", async () => {
		const html =
			'<script type="module" src="./main.js"></script>\n<link href="/styles/app.css">\n<a href="https://example.com/x">x</a>\n<a href="#top">top</a>\n';
		const files = { "p/index.html": html };
		const ignored = { "p/main.js": "", "p/styles/app.css": "" };
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"p/main.js: unlisted",
			"p/styles/app.css: unlisted",
		]);
	});

	it("refuses a package.json, tsconfig, HTML or Biome path that leaves the checkout, naming the file that holds it", async () => {
		const files = {
			"a/package.json": JSON.stringify({ dependencies: { x: "link:../../outside/pkg" } }),
			"b/package.json": JSON.stringify({ dependencies: { x: "../../outside/pkg" } }),
			"c/package.json": JSON.stringify({ devDependencies: { x: "<OUT>/pkg" } }),
			"d/package.json": JSON.stringify({ dependencies: { x: "~/pkg" } }),
			"e/package.json": JSON.stringify({ main: "../../outside/helper.js" }),
			"f/package.json": JSON.stringify({ imports: { "#x": "./../../outside/helper.js" } }),
			"g/tsconfig.json": JSON.stringify({ extends: "../../outside/base.json" }),
			"h/tsconfig.json": JSON.stringify({ extends: "<OUT>/base.json" }),
			"i/tsconfig.json": JSON.stringify({ references: [{ path: "../../outside" }] }),
			"j/tsconfig.json": JSON.stringify({ files: ["../../outside/helper.ts"] }),
			"k/tsconfig.json": JSON.stringify({
				compilerOptions: { paths: { "#x/*": ["../../outside/x/*"] } },
			}),
			"l/tsconfig.json": JSON.stringify({ compilerOptions: { typeRoots: ["../../outside"] } }),
			"m/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "<OUT>" } }),
			"n/index.html": '<script type="module" src="../../outside/helper.js"></script>\n',
			"o/biome.json": JSON.stringify({ root: false, extends: ["../../outside/base.json"] }),
		};
		expect(await refused({ files, outside: BESIDE }, "refs-config")).toEqual([
			...[..."abcdef"].map((dir) => `${dir}/package.json: outside`),
			...[..."ghijklm"].map((dir) => `${dir}/tsconfig.json: outside`),
			"n/index.html: outside",
			"o/biome.json: outside",
		]);
	});

	it("follows an absolute dependency spec or tsconfig extends below the root, and leaves tsconfig include to scan-tsc", async () => {
		const files = {
			"a/package.json": JSON.stringify({ dependencies: { x: "<IN>/vendor/x" } }),
			"b/tsconfig.json": JSON.stringify({ extends: "<IN>/base/strict.json" }),
			"d/tsconfig.json": JSON.stringify({ include: ["../../outside/x/**/*.ts"] }),
		};
		const ignored = { "vendor/x/package.json": "{}", "base/strict.json": "{}" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-config")).toEqual([
			"vendor/x/package.json: unlisted",
			"base/strict.json: unlisted",
		]);
	});

	it("refuses a typeRoots or rootDirs folder that exists, and an extends or references target whose name isn't a tsconfig's", async () => {
		const options = (compilerOptions: Readonly<Record<string, unknown>>): string =>
			JSON.stringify({ compilerOptions });
		const files = {
			"a/tsconfig.json": options({ typeRoots: ["./types", "./node_modules/@types", "./none"] }),
			"a/types/x/index.d.ts": "",
			"b/tsconfig.json": options({ rootDirs: ["src", "generated"] }),
			"b/src/a.ts": "",
			"c/tsconfig.json": JSON.stringify({ extends: "./base.json" }),
			"c/base.json": "{}",
			"d/tsconfig.json": JSON.stringify({ extends: ["./tsconfig.base.json", "@scope/tsconfig"] }),
			"d/tsconfig.base.json": "{}",
			"e/tsconfig.json": JSON.stringify({ extends: "../c/base" }),
			"f/tsconfig.json": JSON.stringify({
				references: [{ path: "./build.json" }, { path: "../d" }],
			}),
			"f/build.json": "{}",
		};
		expect(await refused({ files }, "refs-config")).toEqual([
			"a/tsconfig.json: unsupported",
			"b/tsconfig.json: unsupported",
			"c/tsconfig.json: unsupported",
			"e/tsconfig.json: unsupported",
			"f/tsconfig.json: unsupported",
		]);
	});

	it("reads tsconfig paths from the config's own folder whatever baseUrl says, and refuses a baseUrl", async () => {
		const options = (compilerOptions: Readonly<Record<string, unknown>>): string =>
			JSON.stringify({ compilerOptions });
		const files = {
			"a/tsconfig.json": options({ baseUrl: "sub", paths: { "#x": ["./gen/x"] } }),
			"b/tsconfig.json": options({
				paths: { "#y/*": ["../../outside/x/*"] },
				baseUrl: "<IN>/b/sub",
			}),
			"c/tsconfig.json": options({ paths: { "#z": ["./gen/z"] } }),
		};
		const ignored = { "a/gen/x.ts": "", "c/gen/z.ts": "" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-config")).toEqual([
			"a/tsconfig.json: unsupported",
			"a/gen/x.ts: unlisted",
			"b/tsconfig.json: outside",
			"c/gen/z.ts: unlisted",
		]);
	});

	it("follows an absolute tsconfig types entry as a module path, refuses a relative one and one that leaves the checkout, and leaves package names alone", async () => {
		const types = (entries: readonly string[]): string =>
			JSON.stringify({ compilerOptions: { types: entries } });
		const files = {
			"a/tsconfig.json": types(["node", "vitest/globals", "<IN>/types/x"]),
			"b/tsconfig.json": types(["./types/y"]),
			"c/tsconfig.json": types(["../../outside/helper.ts"]),
			"d/tsconfig.json": types(["<OUT>/helper.ts"]),
			"e/tsconfig.json": types([".\\types\\z"]),
		};
		const ignored = { "types/x.d.ts": "" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-config")).toEqual([
			"types/x.d.ts: unlisted",
			"b/tsconfig.json: unsupported",
			"c/tsconfig.json: outside",
			"d/tsconfig.json: outside",
			"e/tsconfig.json: unsupported",
		]);
	});

	it("follows each script token that reads as a path as a module from its package, and refuses one that leaves the checkout", async () => {
		const scripts = (map: Readonly<Record<string, string>>): string =>
			JSON.stringify({ name: "p", scripts: map });
		const files = {
			"a/package.json": scripts({
				test: "node ./gen/x.mjs",
				lint: "tsx scripts/check",
				start: "node ./lib",
			}),
			"b/package.json": scripts({ test: "node ../../outside/helper.js" }),
			"c/package.json": scripts({ test: "node <OUT>/helper.js" }),
			"d/package.json": scripts({ test: "vitest run > /dev/null" }),
			"e/package.json": scripts({ test: "cd ../.. && node repo/e/x.js" }),
			"f/package.json": scripts({
				test: "vitest run --dir=./src",
				build: "tsc -p ./tsconfig.json && node ./none.js",
				other: "pnpm --filter @scope/x test && node ../f/listed.js",
			}),
			"f/listed.js": "",
		};
		const ignored = { "a/gen/x.mjs": "", "a/scripts/check.ts": "", "a/lib/index.js": "" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-config")).toEqual([
			"a/gen/x.mjs: unlisted",
			"a/scripts/check.ts: unlisted",
			"a/lib/index.js: unlisted",
			"b/package.json: outside",
			"c/package.json: outside",
			"d/package.json: outside",
			"e/package.json: outside",
		]);
	});

	it("refuses a config path with a name Windows trims and one from a drive's own working folder, and leaves a script's free text alone", async () => {
		const files = {
			"a/tsconfig.json": JSON.stringify({ files: ["./gen./x.ts"] }),
			"b/tsconfig.json": JSON.stringify({ extends: "C:base.json" }),
			"c/tsconfig.json": JSON.stringify({ compilerOptions: { types: ["C:types"] } }),
			"d/package.json": JSON.stringify({ name: "d", main: "C:main.js" }),
			"e/index.html": '<script type="module" src="./src./main.js"></script>\n',
			"f/package.json": JSON.stringify({ name: "f", scripts: { test: "node ./gen./x.mjs" } }),
			"g/package.json": JSON.stringify({ name: "g", scripts: { test: "node C:x/y.js" } }),
			"h/package.json": JSON.stringify({
				name: "h",
				scripts: { test: "turbo run test --filter=!./tools/x" },
			}),
		};
		expect(await refused({ files }, "refs-config")).toEqual([
			"a/tsconfig.json: unsupported",
			"b/tsconfig.json: outside",
			"c/tsconfig.json: outside",
			"d/package.json: outside",
			"e/index.html: unsupported",
			"f/package.json: unsupported",
			"g/package.json: outside",
		]);
	});

	it("follows a package's own entry points as modules, as a package that imports it by name loads them", async () => {
		const files = {
			"a/package.json": JSON.stringify({
				name: "a",
				main: "built/main.js",
				exports: { ".": { import: "./built/e.js" }, "./sub": "./sub/index.js" },
				bin: { tool: "./bin/tool.mjs" },
				types: "types/index.d.ts",
			}),
			"b/package.json": JSON.stringify({ name: "b", exports: { ".": "./index.ts" } }),
			"b/index.ts": "",
		};
		const ignored = {
			"a/built/main.js": "",
			"a/built/e.ts": "",
			"a/sub/index.js": "",
			"a/bin/tool.mjs": "",
			"a/types/index.d.ts": "",
		};
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"a/built/main.js: unlisted",
			"a/built/e.ts: unlisted",
			"a/sub/index.js: unlisted",
			"a/bin/tool.mjs: unlisted",
			"a/types/index.d.ts: unlisted",
		]);
	});

	it("follows an exports subpath pattern, under a condition object too, and an imports #gen/* pattern, when every match is a regular file in the index", async () => {
		const files = {
			"a/package.json": JSON.stringify({
				name: "a",
				exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
			}),
			"a/src/index.ts": "",
			"a/src/x.ts": "",
			"a/src/deep/y.ts": "",
			"a/src/notes.md": "",
			"b/package.json": JSON.stringify({
				name: "b",
				exports: {
					"./*": { types: "./src/*.ts", default: ["./src/*.ts"] },
					"./internal/*": null,
				},
			}),
			"b/src/x.ts": "",
			"c/package.json": JSON.stringify({ name: "c", imports: { "#gen/*": "./gen/*.ts" } }),
			"c/gen/x.ts": "",
		};
		// Ignored files no match can be: another ending, or outside every pattern's prefix.
		const ignored = {
			"a/src/out.log": "",
			"a/dist/x.ts": "",
			"b/internal/x.ts": "",
			"c/src/x.ts": "",
		};
		expect(await refused({ files, ignored }, "refs-config")).toEqual([]);
	});

	it("refuses a pattern match that is ignored, untracked or a junction, a prefix that leaves the package and a target with two stars, reading none of them", async () => {
		const exports = (target: string): string =>
			JSON.stringify({ name: "p", exports: { "./*": target } });
		const files = {
			"a/package.json": exports("./src/*.ts"),
			"a/src/ok.ts": "",
			"b/package.json": exports("./../shared/*.ts"),
			"c/package.json": exports("./src/*/*.ts"),
			"shared/x.ts": "",
		};
		const ignored = { "a/src/gen/ignored.ts": "" };
		const untracked = { "a/src/new.ts": "" };
		const tree = { files, ignored, untracked, outside: BESIDE, junctions: ["a/src/lib"] };
		expect(await refused(tree, "refs-config")).toEqual([
			"a/src/lib: link",
			"a/src/new.ts: unlisted",
			"a/src/gen/ignored.ts: unlisted",
			"b/package.json: outside",
			"c/package.json: unsupported",
		]);
	});

	it("refuses a pattern of another shape: a star in its key or target alone, a target that doesn't start with ./, one through node_modules, naming a reserved word or reaching the allowed root", async () => {
		const exports = (name: string, map: Readonly<Record<string, string>>): string =>
			JSON.stringify({ name, exports: map });
		const files = {
			"a/package.json": exports("a", { "./*": "./index.js" }),
			"b/package.json": exports("b", { "./x": "./src/*.js" }),
			"c/package.json": exports("c", { "./*": "src/*.js" }),
			"d/package.json": JSON.stringify({ name: "d", imports: { "#dep/*": "dep/*" } }),
			"e/package.json": exports("e", { "./*": "./node_modules/x/*.js" }),
			"f/package.json": exports("f", { "./*": `./gen/${w}-*.js` }),
			"g/package.json": exports("g", { "./*": "./src/*.js" }),
			"spikes/package.json": exports("s", { "./*": "./*/index.ts" }),
		};
		const ignored = { "g/src/node_modules/x/index.js": "" };
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"a/package.json: unsupported",
			"b/package.json: unsupported",
			"c/package.json: unsupported",
			"d/package.json: unsupported",
			"e/package.json: unsupported",
			"f/package.json: reserved",
			"g/package.json: unsupported",
			"spikes/package.json: reserved",
		]);
	});

	it("refuses a package.json or tsconfig it can't parse", async () => {
		const files = { "p/package.json": "{ nope", "p/tsconfig.json": "[" };
		expect(await refused({ files }, "refs-config")).toEqual([
			"p/package.json: unparsable",
			"p/tsconfig.json: unparsable",
		]);
	});

	it("follows an imports map's ./ targets as modules, and leaves bare names and built-ins alone", async () => {
		const imports = {
			"#a": "./src/a.js",
			"#b": { node: "./src/b.ts", default: ["./src/b-web.ts"] },
			"#dep": "some-dependency",
			"#sub": "@scope/dependency/sub/path.js",
			"#fs": "node:fs",
		};
		const files = { "p/package.json": JSON.stringify({ name: "p", imports }) };
		const ignored = { "p/src/a.ts": "", "p/src/b.ts": "" };
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"p/src/a.ts: unlisted",
			"p/src/b.ts: unlisted",
		]);
	});

	it("refuses an imports map whose target is a pattern or a path form it doesn't follow, reading none of them", async () => {
		const targets = [
			"./src/*.js",
			"../shared/x.js",
			"/abs/x.js",
			"file:./x.js",
			"./%2e%2e/x.js",
			"some-dependency/../x.js",
		];
		const files = Object.fromEntries(
			targets.map((target, index) => [
				`p${index}/package.json`,
				JSON.stringify({ name: `p${index}`, imports: { "#x": target } }),
			]),
		);
		expect(await refused({ files }, "refs-config")).toEqual(
			targets.map((_, index) => `p${index}/package.json: unsupported`),
		);
	});

	it("follows a Biome config's extends and plugins, through each config it extends", async () => {
		const files = {
			"biome.json": JSON.stringify({
				extends: ["./configs/base.json"],
				plugins: ["./rules/a.grit"],
			}),
			"configs/base.json": JSON.stringify({
				extends: "./more.jsonc",
				overrides: [{ includes: ["x/**"], plugins: ["../rules/b.grit"] }],
			}),
			"sub/biome.jsonc": '// nested\n{ "root": false, "extends": "//" }\n',
			"rules/c.grit": "",
			"tools/biome.json": JSON.stringify({ plugins: ["../rules/c.grit", "./none.grit"] }),
		};
		const ignored = { "configs/more.jsonc": "{}", "rules/a.grit": "", "rules/b.grit": "" };
		expect(await refused({ files, ignored }, "refs-config")).toEqual([
			"configs/more.jsonc: unlisted",
			"rules/b.grit: unlisted",
			"rules/a.grit: unlisted",
		]);
	});

	it("follows a dot-named Biome config's extends and plugins the same way, and refuses what it can't follow", async () => {
		const files = {
			"a/.biome.json": JSON.stringify({
				root: false,
				extends: ["../configs/base.json"],
				plugins: ["./rules/a.grit"],
			}),
			"b/.biome.jsonc":
				'// nested\n{ "root": false, "overrides": [{ "plugins": ["../rules/b.grit"] }] }\n',
			"c/.biome.json": JSON.stringify({ root: false, extends: ["@scope/config/biome"] }),
			"d/.biome.jsonc": JSON.stringify({ root: false, plugins: ["/abs/x.grit"] }),
			"e/.biome.json": JSON.stringify({ root: false, plugins: [`../spikes/zz-${w}/rule.grit`] }),
			"f/.BIOME.JSON": JSON.stringify({ root: false, plugins: ["../../outside/rules.grit"] }),
			"g/.biome.json": "{ nope",
		};
		const ignored = { "configs/base.json": "{}", "a/rules/a.grit": "", "rules/b.grit": "" };
		expect(await refused({ files, ignored, outside: BESIDE }, "refs-config")).toEqual([
			"configs/base.json: unlisted",
			"a/rules/a.grit: unlisted",
			"rules/b.grit: unlisted",
			"c/.biome.json: unsupported",
			"d/.biome.jsonc: unsupported",
			"spikes/zz-<reserved>/rule.grit: reserved",
			"f/.BIOME.JSON: outside",
			"g/.biome.json: unparsable",
		]);
	});

	it("refuses a Biome config that extends a package's config, names a plugin it can't follow or can't be parsed", async () => {
		const files = {
			"a/biome.json": JSON.stringify({ extends: ["@scope/config/biome"] }),
			"b/biome.json": JSON.stringify({ plugins: ["/abs/x.grit"] }),
			"c/biome.jsonc": "{ nope",
			"d/biome.json": JSON.stringify({ extends: 5 }),
			"e/biome.json": JSON.stringify({ overrides: [{ plugins: [{ path: "./x.grit" }] }] }),
			"f/biome.json": JSON.stringify({ extends: ["base.json"] }),
		};
		expect(await refused({ files }, "refs-config")).toEqual([
			"a/biome.json: unsupported",
			"b/biome.json: unsupported",
			"c/biome.jsonc: unparsable",
			"d/biome.json: unsupported",
			"e/biome.json: unsupported",
			"f/biome.json: unsupported",
		]);
	});
});

describe("resolveFrom", () => {
	const checkout = new Checkout(ownRepo);

	it("resolves a path below the root, and gives null for what isn't one", () => {
		expect(resolveFrom(checkout, "a/b", "../c/./d.ts")).toBe("a/c/d.ts");
		expect(resolveFrom(checkout, "a", "..\\x.ts")).toBe("x.ts");
		expect(resolveFrom(checkout, "", ".")).toBe("");
		expect(resolveFrom(checkout, "a", "node_modules/../b.ts")).toBe("a/b.ts");
		for (const value of [
			"a/node_modules/x",
			".git/config",
			"*.ts",
			"a/**/*.ts",
			"a?b",
			"x:y",
			"https://example.com/../../x",
			"x.",
			"a./../x",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: lib/imports.ts's placeholder for a computed part.
			"${}/x",
			"{a,b}.ts",
			"",
		]) {
			expect([value, resolveFrom(checkout, "", value)]).toEqual([value, null]);
		}
		const inside = path.join(ownRepo, "tools", "x.ts");
		expect(resolveFrom(checkout, "spikes", inside)).toBe("tools/x.ts");
	});

	it("gives OUTSIDE for a path or glob that leaves the checkout on its way, even back into it", () => {
		const back = `../${path.basename(ownRepo)}/x.ts`;
		for (const [from, value] of [
			["", "../x"],
			["a", "../../x"],
			["", back],
			["", "node_modules/../../x"],
			["", ".../../x"],
			["", "../*.ts"],
			["a", "**/../../x"],
			["", "{..,a}/x"],
			["a/b", "../../../x/**/*.ts"],
			["", `${ownRepo}${path.sep}${back}`],
			["spikes", path.join(path.dirname(ownRepo), "elsewhere", "x.ts")],
			["", "/elsewhere/**/*.ts"],
		] as const) {
			expect([from, value, resolveFrom(checkout, from, value)]).toEqual([from, value, OUTSIDE]);
		}
	});
});

describe("parseToml", () => {
	it("reads every value kind Cargo files use", () => {
		const text = [
			"# comment",
			'title = "a\\tb\\u00e9" # trailing',
			"literal = 'C:\\path'",
			'multi = """\nline one \\\n   joined"""',
			"raw = '''\nkept\\n'''",
			"int = +1_000",
			"hex = 0xdead_beef",
			"float = -3.5e2",
			"inf = inf",
			"yes = true",
			"date = 1979-05-27T07:32:00Z",
			"day = 1979-05-27",
			"arr = [ 1, [2, 3], 'x', ]",
			'inline = { a = 1, b.c = "d", list = [\n  "e",\n  "f",\n] }',
			"dotted.key = 1",
			'"quoted key" = 2',
			"",
			"[table.sub]",
			"x = 1",
			"[[array]]",
			"y = 1",
			"[[array]]",
			"y = 2",
			"[target.'cfg(unix)'.dependencies]",
			'z = { path = "../z" }',
		].join("\n");
		expect(parseToml(text)).toEqual({
			title: "a\tb\u00e9",
			literal: "C:\\path",
			multi: "line one joined",
			raw: "kept\\n",
			int: 1000,
			hex: 0xdeadbeef,
			float: -350,
			inf: Number.POSITIVE_INFINITY,
			yes: true,
			date: "1979-05-27T07:32:00Z",
			day: "1979-05-27",
			arr: [1, [2, 3], "x"],
			inline: { a: 1, b: { c: "d" }, list: ["e", "f"] },
			dotted: { key: 1 },
			"quoted key": 2,
			table: { sub: { x: 1 } },
			array: [{ y: 1 }, { y: 2 }],
			target: { "cfg(unix)": { dependencies: { z: { path: "../z" } } } },
		});
	});

	it.each([
		["a duplicate key", "a = 1\na = 2\n"],
		["an unclosed table", "[a\nb = 1\n"],
		["a value with no key", "= 1\n"],
		["text after a value", "a = 1 2\n"],
		["an unclosed string", 'a = "x\n'],
		["a bad escape", 'a = "\\q"\n'],
		["a bare word value", "a = yes\n"],
		["a key redefined as a table", "a = 1\n[a]\n"],
	])("refuses %s", (_label, text) => {
		expect(parseToml(text)).toBe(null);
	});

	it("parses every ordinary Cargo manifest and the toolchain file of this repository", () => {
		const files = ["rust-toolchain.toml", ...cargoManifests()];
		expect(files.length).toBeGreaterThan(5);
		for (const file of files) {
			expect(parseToml(readFileSync(path.join(ownRepo, file), "utf8")), file).not.toBe(null);
		}
	});
});

// The repository's ordinary Cargo manifests, by name only.
function cargoManifests(): string[] {
	const found: string[] = [];
	const checkout = new Checkout(ownRepo);
	for (const dir of ["spikes/s05-desktop", "spikes/s10-mobile", "spikes/sched-clock"]) {
		checkout.walk(dir, (rel, kind) => {
			if (fold(path.posix.basename(rel)) === "target") return false;
			if (kind === "file" && path.posix.basename(rel) === "Cargo.toml" && !reservedWord.test(rel)) {
				found.push(rel);
			}
			return true;
		});
	}
	return found;
}
