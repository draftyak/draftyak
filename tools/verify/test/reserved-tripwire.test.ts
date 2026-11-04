// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the samples are module text with templates.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { reservedWord, tierFiles, workspaceGlobs } from "../../../reserved-tests.ts";
import * as allowed from "../lib/allowed.ts";
import { literals } from "../lib/imports.ts";
import { capture } from "../lib/spawn.ts";
import {
	ALLOWED_DOCS,
	ALLOWED_ROOTS,
	checkLine,
	type IndexEntry,
	type Problems,
	pointersOf,
	STOP_LINE,
	TRIPWIRE_RULES,
	type TreeInput,
	type TripwireKind,
	tripwire,
	tripwireLines,
} from "../reserved-tripwire.ts";

// The tree rules on synthetic trees. The reserved words are built here, so this file never spells
// one; titles and assertion values never hold one, and compared values are scrubbed of them and of
// the reserved spike's number, so a failure prints only neutral labels.
const repo = path.resolve(import.meta.dirname, "..", "..", "..");
const word = ["si", "wc"].join("");
const parts = ["dynamic", "agent"];
const spikeNumber = ["s0", "7"].join("");
const reservedText = new RegExp(`${word}|${spikeNumber}[-_]|${parts.join("[-_]")}`, "gi");
const scrub = (text: string): string => text.replace(reservedText, "<reserved>");

// Compares as JSON; a failure prints both sides scrubbed.
function same(actual: unknown, expected: unknown): void {
	const [a, b] = [JSON.stringify(actual), JSON.stringify(expected)];
	expect(a === b ? "same" : `${scrub(a)}\n  is not\n${scrub(b)}`).toBe("same");
}

// The fixture's allowed root and document. Its workspace lists pkgs/*, which holds an ordinary
// package a and the allowed root; nothing in the root is ever read.
const root = `pkgs/zz-${word}/`;
const doc = `docs/notes/${word}.md`;
const base: Readonly<Record<string, string>> = {
	"pnpm-workspace.yaml": "packages:\n  - pkgs/*\n",
	"package.json": '{ "name": "fixture", "private": true }\n',
	"pkgs/a/package.json": '{ "name": "a" }\n',
	"pkgs/a/src/index.ts": 'import { b } from "./b.ts";\n\nexport const a = b;\n',
	"pkgs/a/src/b.ts": "export const b = 1;\n",
	[`${root}package.json`]: "",
	[`${root}src/index.ts`]: "",
	[doc]: "",
};

interface Tree {
	// Tracked regular files, with their text.
	readonly files?: Readonly<Record<string, string>>;
	// Untracked files git doesn't ignore, with their text.
	readonly untracked?: Readonly<Record<string, string>>;
	// Tracked entries with another mode, and tracked files missing from the working tree.
	readonly modes?: Readonly<Record<string, string>>;
	readonly unreadable?: readonly string[];
	readonly roots?: readonly string[];
	readonly docs?: readonly string[];
	// Base files to leave out.
	readonly without?: readonly string[];
}

interface Fixture extends TreeInput {
	readonly reads: string[];
}

const inRoot = (file: string, roots: readonly string[]): boolean =>
	roots.some((dir) => file.toLowerCase().startsWith(dir.toLowerCase()));

function fixture(tree: Tree = {}): Fixture {
	const files: Record<string, string> = Object.fromEntries(
		Object.entries({ ...base, ...tree.files }).filter(([file]) => !tree.without?.includes(file)),
	);
	const loose: Record<string, string> = { ...tree.untracked };
	const roots = tree.roots ?? [root];
	const reads: string[] = [];
	const entries: IndexEntry[] = [
		...Object.keys(files).map((file) => ({ mode: "100644", path: file })),
		...Object.entries(tree.modes ?? {}).map(([file, mode]) => ({ mode, path: file })),
	];
	return {
		entries,
		untracked: Object.keys(loose),
		allowedRoots: roots,
		allowedDocs: tree.docs ?? [doc],
		reads,
		text: (rel) => {
			reads.push(rel);
			// The reader spy: a rule that asks for a reserved or allowed-root file fails the test.
			if (reservedWord.test(rel) || inRoot(rel, roots)) throw new Error("a reserved file was read");
			if (tree.unreadable?.includes(rel)) return "unreadable";
			return files[rel] ?? loose[rel] ?? "absent";
		},
	};
}

// How much each rule found: no path, so nothing reserved, reaches a failure message.
function counts(tree: Tree = {}): Partial<Record<TripwireKind, number>> {
	return Object.fromEntries(
		Object.entries(tripwire(fixture(tree)).found)
			.filter(([, items]) => items.length > 0)
			.map(([kind, items]) => [kind, items.length]),
	);
}

describe("the fixture tree", () => {
	it("is clean, and every file read is an ordinary one, read once", () => {
		const input = fixture();
		const problems = tripwire(input);
		expect(tripwireLines(problems, false)).toEqual([]);
		expect(problems.gitExit).toBe(null);
		expect(problems.checked).toEqual({ paths: 8, untracked: 0, cargo: 0, rust: 0, modules: 5 });
		expect(input.reads.some((file) => reservedWord.test(file))).toBe(false);
		expect(new Set(input.reads).size).toBe(input.reads.length);
	});
});

describe("G1: reserved paths outside the allowed set", () => {
	it("permits the allowed root's files, the allowed documents, and words split other ways", () => {
		const files = {
			[`${root}test/a.test.ts`]: "",
			[`${root}notes/plan.md`]: "",
			[`pkgs/p/${parts.join("")}.ts`]: "",
			[`pkgs/p/${parts.join(".")}.ts`]: "",
			[`pkgs/p/${parts.join(" ")}.ts`]: "",
		};
		expect(counts({ files, untracked: { [`${root}new.ts`]: "" } })).toEqual({});
	});

	it.each([
		["a reserved file name in a package's folder", `pkgs/p/src/x-${word}.ts`],
		["a reserved folder holding a plain file", `pkgs/p/${word}/plain.ts`],
		["a reserved file name at a package's top", `pkgs/p/x-${word}.ts`],
		["shared data outside every package", `spec/vectors/${word}-l2/a.json`],
		["a document that isn't an allowed one", `docs/${word}.md`],
		["a test at the repository's top", `${word}/a.test.ts`],
		["a sibling folder that starts like the allowed root", `pkgs/zz-${word}-x/a.ts`],
		["the allowed root's folder in another case", `pkgs/ZZ-${word}/a.ts`],
		["the allowed root in upper case", `PKGS/ZZ-${word.toUpperCase()}/a.ts`],
		["the word in upper case", `pkgs/p/X-${word.toUpperCase()}.ts`],
		["the underscore spelling", `pkgs/p/${parts.join("_")}.ts`],
		["the hyphen spelling", `pkgs/p/${parts.join("-")}/a.ts`],
		["a name that extends an allowed document's", `docs/notes/${word}-x.md`],
		["an allowed document's name in another folder", `docs/other/${word}.md`],
		["the word in upper case inside the allowed root", `${root}X-${word.toUpperCase()}.ts`],
	])("counts %s", (_label, file) => {
		expect(counts({ files: { [file]: "" } })).toEqual({ G1: 1 });
	});

	it("counts an untracked file git doesn't ignore", () => {
		expect(counts({ untracked: { [`pkgs/p/src/x-${word}.ts`]: "" } })).toEqual({ G1: 1 });
	});
});

describe("G2: reserved Rust and Cargo names", () => {
	it("leaves ordinary Rust and Cargo files and the root's other files alone", () => {
		const files = {
			"pkgs/r/Cargo.toml": '[package]\nname = "r"\n',
			"pkgs/r/src/lib.rs": "pub fn r() {}\n",
			"pkgs/r/.cargo/config.toml": "[build]\njobs = 2\n",
			"rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n',
			[`${root}src/rust-notes.md`]: "",
		};
		expect(counts({ files })).toEqual({});
	});

	it.each([
		["a Cargo manifest in the allowed root", `${root}rust/Cargo.toml`],
		["a Rust source in the allowed root", `${root}src/x.rs`],
		["a lower-case manifest", `${root}rust/cargo.toml`],
		["a Cargo.lock", `${root}rust/Cargo.lock`],
		["an upper-case Rust extension", `${root}build.RS`],
		["anything in a .cargo folder", `${root}.cargo/config.toml`],
		["a toolchain file", `${root}rust-toolchain.toml`],
	])("counts %s, without reading it", (_label, file) => {
		const input = fixture({ files: { [file]: "[features]\nreserved = []\n" } });
		const { found } = tripwire(input);
		same(found.G2, [file]);
		expect(found.G1.length + found.G3.length).toBe(0);
		expect(input.reads.includes(file)).toBe(false);
	});

	it("counts reserved Rust outside the roots under both rules", () => {
		expect(counts({ files: { [`pkgs/r/src/x_${word}.rs`]: "" } })).toEqual({ G1: 1, G2: 1 });
	});
});

describe('G3: "reserved" in Cargo files', () => {
	const manifest = (text: string) => counts({ files: { "pkgs/r/Cargo.toml": text } });

	it("leaves a manifest without it alone", () => {
		expect(
			manifest('[package]\nname = "r"\n\n[features]\ndefault = []\nserde = ["dep:serde"]\n'),
		).toEqual({});
	});

	it.each([
		["a feature key", "[features]\nreserved = []\n"],
		["a feature name ending in it", "[features]\nx-reserved = []\n"],
		["a feature name holding it after an underscore", "[features]\nmaintainer_reserved = []\n"],
		["a capitalised feature", "[features]\nReserved = []\n"],
		[
			"a path dependency's inline features",
			'[dependencies]\np = { path = "../p", features = ["reserved"] }\n',
		],
		[
			"a dependency table's multi-line features",
			'[dependencies.p]\npath = "../p"\nfeatures = [\n  "serde",\n  "reserved",\n]\n',
		],
		["default features enabling it", '[features]\ndefault = ["p/reserved"]\n'],
		["a neutral feature enabling it", '[features]\nall = ["p?/reserved"]\n'],
		[
			"a workspace dependency's features",
			'[workspace.dependencies]\np = { path = "crates/p", features = ["reserved-live"] }\n',
		],
		[
			"a target dependency's features",
			`[target.'cfg(unix)'.dependencies]\np = { version = "1", features = ["reserved"] }\n`,
		],
		["a test's required-features", '[[test]]\nname = "m"\nrequired-features = ["reserved"]\n'],
		["a commented-out use", '[features]\n# all = ["p/reserved"]\n'],
	])("counts %s", (_label, text) => {
		expect(manifest(text)).toEqual({ G3: 1 });
	});

	it("reads every Cargo manifest, wherever it sits", () => {
		const text = "[features]\nreserved = []\n";
		const files = { "pkgs/s05-like/rust/Cargo.toml": text, "apps/app/src-tauri/Cargo.toml": text };
		expect(counts({ files })).toEqual({ G3: 2 });
	});

	it("reads .cargo configs and deny.toml too", () => {
		const files = {
			".cargo/config.toml": `[build]\nrustflags = ["--cfg", 'feature="reserved"']\n`,
			"pkgs/r/.cargo/config": '[alias]\nt = "test --features reserved"\n',
			"deny.toml": '[graph]\nfeatures = ["p/reserved"]\n',
		};
		expect(counts({ files })).toEqual({ G3: 3 });
	});
});

describe("G4: cfgs named reserved in ordinary Rust", () => {
	const source = (text: string, file = "pkgs/r/src/lib.rs") => counts({ files: { [file]: text } });

	it("leaves the plain word, comments, strings and other cfgs alone", () => {
		const text = [
			'#[cfg(feature = "serde")]',
			"mod m;",
			'#[cfg(not(feature = "unreserved"))]',
			"fn g() {}",
			'// #[cfg(feature = "reserved")]',
			"/* #[cfg(reserved)] /* nested */ still a comment */",
			"fn name_is_preserved() -> &'static str {",
			"    let quote = '\"';",
			'    let _ = (quote, "#[cfg(feature = \\"reserved\\")]");',
			'    "reserved characters"',
			"}",
			"fn main() {",
			'    println!("cargo::rustc-cfg=serde");',
			"}",
		].join("\n");
		expect(source(text)).toEqual({});
	});

	it.each([
		["a feature in #[cfg]", '#[cfg(feature = "reserved")]\nmod m;\n'],
		["a feature in cfg!", 'fn f() -> bool {\n    cfg!(feature = "x-reserved")\n}\n'],
		[
			"a build script's rustc-cfg line",
			'fn main() {\n    println!("cargo::rustc-cfg=feature=\\"reserved\\"");\n}\n',
		],
		["a cfg_attr", '#[cfg_attr(feature = "reserved", derive(Debug))]\nstruct S;\n'],
		[
			"a cfg_if! arm",
			'cfg_if::cfg_if! {\n    if #[cfg(feature = "reserved")] {\n        mod m;\n    } else {\n        mod n;\n    }\n}\n',
		],
		[
			"a build script's rustc-check-cfg line",
			'fn main() {\n    println!("cargo::rustc-check-cfg=cfg(reserved)");\n}\n',
		],
		["a cfg across lines", '#[cfg(all(\n    unix,\n    feature = "reserved",\n))]\nmod m;\n'],
		["a custom cfg", "#[cfg(reserved)]\nmod m;\n"],
		["an inner attribute", '#![cfg(feature = "reserved")]\n'],
		["a raw string in a cfg", '#[cfg(feature = r"maintainer_reserved")]\nmod m;\n'],
		[
			"a rustc-cfg value passed as an argument",
			'fn main() {\n    println!("cargo:rustc-cfg={}", "reserved");\n}\n',
		],
	])("counts %s", (_label, text) => {
		expect(source(text)).toEqual({ G4: 1 });
	});
});

describe("G5: reserved words in ordinary Rust strings and Cargo values", () => {
	const escaped = `${word.slice(0, 1)}\\x${word.charCodeAt(1).toString(16)}${word.slice(2)}`;

	it("leaves a reserved word in Rust comments alone", () => {
		const text = `// see zz-${word}\n/// zz-${word}\n/* zz-${word} */\nfn f() {}\n`;
		expect(counts({ files: { "pkgs/r/src/lib.rs": text } })).toEqual({});
	});

	it.each([
		[
			"an include_str! path",
			"src/lib.rs",
			`const V: &str = include_str!("../../zz-${word}/v.json");\n`,
		],
		["a raw string", "src/lib.rs", `const V: &str = r#"zz-${word}"#;\n`],
		["a byte string", "src/lib.rs", `const V: &[u8] = b"zz-${word}";\n`],
		["a raw byte string", "src/lib.rs", `const V: &[u8] = br"zz-${word}";\n`],
		["an escaped spelling", "build.rs", `const V: &str = "zz-${escaped}";\n`],
		["a Cargo path", "Cargo.toml", `[dependencies]\nx = { path = "../zz-${word}/x" }\n`],
		["a Cargo.lock", "Cargo.lock", `[[package]]\nname = "zz-${word}"\nversion = "1.0.0"\n`],
		["a .cargo config", ".cargo/config.toml", `[env]\nX = "zz-${word}"\n`],
		["a deny.toml", "deny.toml", `[bans]\nskip = ["zz-${word}"]\n`],
		[
			"a rust-toolchain.toml path",
			"rust-toolchain.toml",
			`[toolchain]\npath = "../zz-${word}/tc"\n`,
		],
		["a plain rust-toolchain file", "rust-toolchain", `../zz-${word}/tc\n`],
	])("counts %s", (_label, file, text) => {
		expect(counts({ files: { [`pkgs/r/${file}`]: text } })).toEqual({ G5: 1 });
	});

	it("reads a toolchain file with the Cargo text rules, as rustup follows its path", () => {
		const toolchain = { "rust-toolchain.toml": '[toolchain]\nchannel = "stable"\n' };
		const input = fixture({ files: toolchain });
		const problems = tripwire(input);
		expect(input.reads.includes("rust-toolchain.toml")).toBe(true);
		expect(problems.checked.cargo).toBe(1);
		expect(tripwireLines(problems, false)).toEqual([]);
		expect(counts({ files: { "rust-toolchain": "[toolchain]\nreserved = 1\n" } })).toEqual({
			G3: 1,
		});
	});
});

describe("G6: ordinary files pointing at reserved paths", () => {
	describe("in modules", () => {
		const module = (text: string) => counts({ files: { "pkgs/a/src/x.ts": text } });

		it("leaves plain strings, data, comments, regular expressions and computed parts alone", () => {
			const text = [
				'import { b } from "./b.ts";',
				'import type { T } from "../../kit/src/t.ts";',
				`const data = ["pkgs/zz-${word}/notes.md"];`,
				`const label = "pkg-${word}";`,
				`// import { x } from "../../zz-${word}/x.ts";`,
				`const pattern = /from "\\.\\.\\/zz-${word}"/;`,
				"const computed = `../${label}/x.ts`;",
				'const load = createRequire(import.meta.url);\nload("pkg-plain");',
				"export { b, computed, data, label, load, pattern };",
			].join("\n");
			expect(module(text)).toEqual({});
		});

		it("leaves globs that stay inside the package alone, whatever their syntax", () => {
			const text = [
				'import.meta.glob("./!(skip)/*.ts");',
				'import.meta.glob("./[[:alpha:]]*/*.ts");',
				'import.meta.glob("./{a..c}/*.ts");',
				'import.meta.glob("./{x,y}/**/*.ts");',
			].join("\n");
			expect(module(text)).toEqual({});
		});

		it.each([
			["a static import", `import { x } from "../../zz-${word}/x.ts";`],
			["a re-export", `export * from "../../zz-${word}/x.ts";`],
			["a side-effect import of a reserved package", `import "pkg-${word}";`],
			["a type-only import", `import type { X } from "pkg-${word}";`],
			["a dynamic import", `await import("../../zz-${word}/x.ts");`],
			["require", `require("../../zz-${word}/x.cjs");`],
			[
				"a function from createRequire",
				`import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nload("pkg-${word}");`,
			],
			["createRequire called in place", `createRequire(import.meta.url)("pkg-${word}");`],
			["require.resolve", `require.resolve("pkg-${word}");`],
			["an aliased require", `const load = require;\nload("pkg-${word}");`],
			["import.meta.resolve", `import.meta.resolve("pkg-${word}");`],
			["new URL against the module", `new URL("pkg-${word}/v.json", import.meta.url);`],
			["a triple-slash reference", `/// <reference path="../../zz-${word}/x.d.ts" />`],
			["a relative path in any call", `readFileSync("../../zz-${word}/v.json");`],
			["a relative glob reaching the root unnamed", 'import.meta.glob("../../zz-*/src/*.ts");'],
			["an extglob that could match the root's folder", 'import.meta.glob("../../!(a)/x.ts");'],
			["a POSIX class that could match it", 'import.meta.glob("../../zz-[[:alpha:]]*/x.ts");'],
			["a brace range that could match it", 'import.meta.glob("../../{y..z}z-*/x.ts");'],
		])("counts %s", (_label, text) => {
			expect(module(text)).toEqual({ G6: 1 });
		});

		it("reads untracked modules too", () => {
			const untracked = { "pkgs/a/src/new.ts": `import "../../zz-${word}/x.ts";\n` };
			expect(counts({ untracked })).toEqual({ G6: 1 });
		});
	});

	describe("in Vitest and Vite configs", () => {
		const setup = `export default { test: { setupFiles: ["test/zz-${word}-setup.ts"] } };\n`;

		it("leaves package-relative strings and globs alone, and a module's plain string", () => {
			const config = `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["${tierFiles.unit}"], setupFiles: ["./test/setup.ts"], exclude: ["**/node_modules/**"] } });\n`;
			expect(
				counts({ files: { "pkgs/a/vitest.config.ts": config, "pkgs/a/src/setup.ts": setup } }),
			).toEqual({});
		});

		it.each([
			["a setup file named for a reserved word", "pkgs/a/vitest.config.ts", setup],
			[
				"an alias into the allowed root by glob",
				"pkgs/a/vite.config.mts",
				'export default { resolve: { alias: { x: "../zz-*/src" } } };\n',
			],
			[
				"a test glob in a config at the repository's top",
				"vitest.config.ts",
				`export default { test: { include: ["${tierFiles.unit}"] } };\n`,
			],
			["a workspace list", "vitest.workspace.ts", 'export default ["pkgs/*"];\n'],
		])("counts %s", (_label, file, text) => {
			expect(counts({ files: { [file]: text } })).toEqual({ G6: 1 });
		});
	});

	describe("in package.json", () => {
		const manifest = (fields: Record<string, unknown>) =>
			counts({ files: { "pkgs/a/package.json": JSON.stringify({ name: "a", ...fields }) } });

		it("leaves package-relative entries, scripts, specs and other fields alone", () => {
			const fields = {
				description: `talks about zz-${word}`,
				main: "./src/index.ts",
				exports: { ".": "./src/index.ts", "./b": { import: "./src/b.ts" } },
				bin: { a: "./bin/a.mjs" },
				scripts: { test: "node ../kit/run.ts", lint: "biome check .", build: "tsc -b" },
				dependencies: { "@x/kit": "workspace:*", local: "link:../kit" },
			};
			expect(manifest(fields)).toEqual({});
		});

		it.each([
			["main", { main: `../zz-${word}/index.ts` }],
			["an export's target by glob", { exports: { "./x": { import: "../zz-*/x.ts" } } }],
			["an import map", { imports: { "#x": `../zz-${word}/x.ts` } }],
			["a bin", { bin: { tool: `../zz-${word}/bin.mjs` } }],
			["a script's path", { scripts: { test: `node ../zz-${word}/run.ts` } }],
			["a script's glob", { scripts: { test: "vitest run --dir ../zz-*" } }],
			["a dependency's name", { dependencies: { [`pkg-${word}`]: "1.0.0" } }],
			["a link spec", { devDependencies: { x: `link:../zz-${word}` } }],
			["a file spec by glob", { optionalDependencies: { x: "file:../zz-*" } }],
		])("counts %s", (_label, fields) => {
			expect(manifest(fields)).toEqual({ G6: 1 });
		});
	});

	describe("in tsconfig", () => {
		const tsconfig = (text: string) => counts({ files: { "pkgs/a/tsconfig.json": text } });

		it("leaves package-relative keys alone, and reads comments and trailing commas", () => {
			const text = [
				"{",
				"  // The shared settings.",
				'  "extends": "../../tsconfig.base.json",',
				'  "compilerOptions": {',
				'    "baseUrl": ".",',
				'    "paths": { "x": ["./node_modules/x/index.d.ts"] },',
				'    "types": ["node"],',
				'    "tsBuildInfoFile": "${configDir}/.cache/tsconfig.tsbuildinfo",',
				"  },",
				'  "include": ["**/*.ts"],',
				`  "exclude": ["../zz-*", "pkg-${word}"],`,
				'  /* project references */ "references": [{ "path": "../kit" }],',
				"}",
			].join("\n");
			expect(tsconfig(text)).toEqual({});
		});

		it.each([
			["a relative extends", { extends: `../zz-${word}/tsconfig.json` }],
			["a package extends", { extends: `pkg-${word}/tsconfig.json` }],
			["an include glob", { include: ["../zz-*/src"] }],
			["files", { files: [`../zz-${word}/x.ts`] }],
			["a reference", { references: [{ path: `../zz-${word}` }] }],
			["paths by glob", { compilerOptions: { paths: { "x/*": ["../zz-*/src/*"] } } }],
			[
				"paths at baseUrl",
				{ compilerOptions: { baseUrl: "..", paths: { "x/*": ["zz-*/src/*"] } } },
			],
			["rootDirs", { compilerOptions: { rootDirs: ["../zz-*"] } }],
			["typeRoots", { compilerOptions: { typeRoots: [`../zz-${word}/types`] } }],
			["types", { compilerOptions: { types: [`pkg-${word}`] } }],
			["a types path by glob", { compilerOptions: { types: ["../zz-*/types"] } }],
		])("counts %s", (_label, value) => {
			expect(tsconfig(JSON.stringify(value))).toEqual({ G6: 1 });
		});
	});

	describe("in turbo.json", () => {
		const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
		// Shaped like the repository's: hashing inputs and env names may name anything, and globs
		// stay inside the package that runs the task.
		const rootTurbo = {
			$schema: "./node_modules/turbo/schema.json",
			cacheDir: ".turbo/cache",
			globalDependencies: ["pkgs/*/package.json"],
			globalEnv: ["pkgs/*"],
			globalPassThroughEnv: ["pkgs/*"],
			tasks: {
				build: {
					dependsOn: ["^build"],
					outputs: ["dist/**", "!dist/cache/**", "**/*.tsbuildinfo"],
				},
				test: {
					dependsOn: ["a#build", "//#lint", "^build"],
					inputs: [
						"$TURBO_DEFAULT$",
						"$TURBO_ROOT$/pkgs/*/ci.json",
						"$TURBO_ROOT$/pkgs/*/**/Cargo.toml",
					],
					env: ["../*"],
					passThroughEnv: ["../*"],
					cache: false,
				},
				dev: { with: ["a#watch"], persistent: true },
				"//#lint": { outputs: [".cache/lint/**"] },
				"a#build": { outputs: ["dist/**"] },
			},
		};
		const packageTurbo = {
			$schema: "../../node_modules/turbo/schema.json",
			extends: ["//"],
			tasks: {
				test: { inputs: ["$TURBO_DEFAULT$", "$TURBO_ROOT$/pkgs/*/x"], outputs: ["coverage/**"] },
			},
		};
		const withTask = (task: string, config: unknown): string =>
			json({ ...rootTurbo, tasks: { ...rootTurbo.tasks, [task]: config } });

		it("leaves inputs, env names, the schema and package-relative globs alone", () => {
			const files = { "turbo.json": json(rootTurbo), "pkgs/a/turbo.json": json(packageTurbo) };
			expect(counts({ files })).toEqual({});
		});

		it.each([
			[
				"an output into the root from $TURBO_ROOT$",
				withTask("build", { outputs: [`$TURBO_ROOT$/pkgs/zz-${word}/**`] }),
			],
			[
				"an output glob anchored at $TURBO_ROOT$",
				withTask("build", { outputs: ["$TURBO_ROOT$/pkgs/*/x"] }),
			],
			[
				"a sibling's output glob from every package",
				withTask("build", { outputs: ["../zz-*/**"] }),
			],
			["a root task's output glob", withTask("//#build", { outputs: ["pkgs/*/dist/**"] })],
			[
				"dependsOn a package that isn't an ordinary one",
				withTask("test", { dependsOn: ["seven#build"] }),
			],
			["dependsOn a reserved package", withTask("test", { dependsOn: [`zz-${word}#build`] })],
			["with a package that isn't an ordinary one", withTask("dev", { with: ["seven#dev"] })],
			["a task of a package that isn't an ordinary one", withTask("seven#build", { cache: false })],
			["any other task key", withTask("build", { extra: ["../zz-*/y"] })],
			["any other top-level key", json({ ...rootTurbo, futureKey: "pkgs/zz-*/x" })],
			["a cacheDir into the root", json({ ...rootTurbo, cacheDir: "pkgs/zz-*/cache" })],
			["an extends at the top", json({ ...rootTurbo, extends: ["other"] })],
		])("counts %s", (_label, text) => {
			expect(counts({ files: { "turbo.json": text } })).toEqual({ G6: 1 });
		});

		it.each([
			[
				"a sibling's output glob",
				{ ...packageTurbo, tasks: { build: { outputs: ["../zz-*/**"] } } },
			],
			["an extends other than the root", { ...packageTurbo, extends: ["//", "other"] }],
		])("counts %s in a package's turbo.json", (_label, value) => {
			const files = { "turbo.json": json(rootTurbo), "pkgs/a/turbo.json": json(value) };
			expect(counts({ files })).toEqual({ G6: 1 });
		});

		it("refuses turbo.jsonc by name, without reading it", () => {
			const input = fixture({ files: { "turbo.jsonc": "{}", "pkgs/a/turbo.jsonc": "{}" } });
			expect(tripwire(input).found.G6).toEqual(["pkgs/a/turbo.jsonc", "turbo.jsonc"]);
			expect(input.reads.filter((file) => file.endsWith(".jsonc"))).toEqual([]);
		});
	});

	describe("in HTML", () => {
		const page = (text: string) => counts({ files: { "pkgs/a/index.html": text } });

		it("leaves page-relative and absolute URLs alone", () => {
			const text =
				'<!doctype html>\n<link rel="stylesheet" href="./style.css">\n<script type="module" src="/src/main.ts"></script>\n<a href="https://example.com/x">x</a>\n';
			expect(page(text)).toEqual({});
		});

		it.each([
			["a script", `<script type="module" src="../zz-${word}/main.ts"></script>`],
			["a stylesheet by glob", "<link rel='stylesheet' href='../zz-*/x.css'>"],
			["an unquoted image", `<img src=../zz-${word}/a.png>`],
		])("counts %s", (_label, text) => {
			expect(page(text)).toEqual({ G6: 1 });
		});
	});

	it("counts a file once, however many pointers it holds", () => {
		const text = `import "../../zz-${word}/a.ts";\nimport "../../zz-${word}/b.ts";\n`;
		expect(counts({ files: { "pkgs/a/src/x.ts": text } })).toEqual({ G6: 1 });
	});
});

describe("G7: the allowed set", () => {
	const rootFiles = [`${root}package.json`, `${root}src/index.ts`];

	it("lets an allowed root or document be absent", () => {
		expect(counts({ without: [...rootFiles, doc] })).toEqual({});
	});

	it.each([
		[
			"an allowed root with files but no tracked package.json",
			{ without: [`${root}package.json`] },
		],
		[
			"an allowed root whose package.json isn't tracked",
			{ without: [`${root}package.json`], untracked: { [`${root}package.json`]: "" } },
		],
		[
			"an allowed root outside the workspace globs",
			{ files: { "pnpm-workspace.yaml": "packages:\n  - other/*\n" } },
		],
		[
			"an allowed root two levels below its glob",
			{
				roots: [`pkgs/a/zz-${word}/`],
				without: rootFiles,
				files: { [`pkgs/a/zz-${word}/package.json`]: "" },
			},
		],
		["an allowed root that isn't reserved-named", { roots: ["pkgs/plain/"], without: rootFiles }],
		["an allowed document outside docs/", { docs: [`spec/${word}.md`], without: [doc] }],
		[
			"an allowed document that isn't Markdown",
			{ docs: [`docs/notes/${word}.ts`], without: [doc] },
		],
		["an allowed document that climbs out", { docs: [`docs/../${word}.md`], without: [doc] }],
	])("counts %s", (_label, tree: Tree) => {
		expect(counts(tree)).toEqual({ G7: 1 });
	});

	it("counts an allowed root without its trailing slash, whose files are then strays", () => {
		expect(counts({ roots: [root.slice(0, -1)] })).toEqual({ G1: 2, G7: 1 });
	});

	it.each([
		["no packages: list", { files: { "pnpm-workspace.yaml": "minimumReleaseAge: 1\n" } }],
		["no workspace file", { without: ["pnpm-workspace.yaml"] }],
	])("counts a workspace with %s, and the root it can't place", (_label, tree: Tree) => {
		const { found } = tripwire(fixture(tree));
		same(found.G7, [root, "pnpm-workspace.yaml"].toSorted());
	});

	describe("reads pnpm-workspace.yaml as reserved-tests.ts does", () => {
		const made: string[] = [];
		afterAll(() => {
			for (const dir of made) rmSync(dir, { recursive: true, force: true });
		});

		it.each([
			["the approved form", "packages:\n  - pkgs/*\n  - tools/*\n\nminimumReleaseAge: 1440\n"],
			[
				"CRLF lines, comments and trailing spaces",
				"\uFEFFpackages:\r\n  - pkgs/*  \r\n  # later\r\n\r\n  - solo\r\n",
			],
			["a list without pkgs/*", "packages:\n  - tools/*\n  - solo\n"],
			["no packages: key", "minimumReleaseAge: 1\n"],
			["an empty list", "packages:\n\nminimumReleaseAge: 1\n"],
			["a flow list", "packages: [pkgs/*]\n"],
			["a list at the key's own indent", "packages:\n- pkgs/*\n"],
			["a deeper indent", "packages:\n    - pkgs/*\n"],
			["a tab indent", "packages:\n\t- pkgs/*\n"],
			["a quoted glob", "packages:\n  - 'pkgs/*'\n"],
			["an entry with a comment", "packages:\n  - pkgs/* # all\n"],
			["a negated glob", "packages:\n  - pkgs/*\n  - '!pkgs/x'\n"],
			["a recursive glob", "packages:\n  - pkgs/**\n"],
			["a parent folder", "packages:\n  - ../pkgs/*\n"],
			["a second packages: key", "packages:\n  - pkgs/*\npackages:\n  - tools/*\n"],
			["a lone carriage return", "packages:\r  - pkgs/*\n"],
			["a key inside the list", "packages:\n  - pkgs/*\n  extra: 1\n"],
		])("%s", (_label, text) => {
			const dir = mkdtempSync(path.join(tmpdir(), "draftyak-tripwire-workspace-"));
			made.push(dir);
			writeFileSync(path.join(dir, "pnpm-workspace.yaml"), text);
			let helper: string;
			try {
				helper = workspaceGlobs(dir).includes("pkgs/*") ? "places the root" : "lacks pkgs/*";
			} catch {
				helper = "unreadable";
			}
			const g7 = counts({ files: { "pnpm-workspace.yaml": text } }).G7;
			const rules = g7 === undefined ? "places the root" : g7 === 1 ? "lacks pkgs/*" : "unreadable";
			expect(rules).toBe(helper);
		});
	});
});

describe("G8a: tracked links and submodules", () => {
	it("leaves executable files alone", () => {
		expect(counts({ modes: { "pkgs/a/bin/run.sh": "100755" } })).toEqual({});
	});

	it.each([
		["a symlink", "pkgs/a/src/link.ts", "120000"],
		["a submodule", "pkgs/a/vendor", "160000"],
		["a symlink inside the allowed root", `${root}src/link.ts`, "120000"],
	])("counts %s, without reading it", (_label, file, mode) => {
		const input = fixture({ modes: { [file]: mode } });
		same(tripwire(input).found.G8a, [file]);
		expect(input.reads.includes(file)).toBe(false);
	});
});

describe("G9: lockfile lines", () => {
	const lockfile = (importers: string, packages = ""): string =>
		`lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n${importers}\npackages:\n${packages}`;
	const own = `  pkgs/zz-${word}:\n    dependencies:\n      y:\n        specifier: 1.0.0\n        version: 1.0.0\n`;
	const plain =
		"  pkgs/a:\n    dependencies:\n      '@x/kit':\n        specifier: workspace:*\n        version: link:../kit\n";
	const lines = (text: string, file = "pnpm-lock.yaml") => counts({ files: { [file]: text } });

	it.each([
		["its plain form", own],
		["a quoted key", `  'pkgs/zz-${word}':\n    dependencies: {}\n`],
		["an empty importer", `  pkgs/zz-${word}: {}\n`],
	])("leaves the allowed root's own importer key alone, in %s", (_label, importer) => {
		expect(lines(lockfile(`${plain}\n${importer}`))).toEqual({});
	});

	it("counts another importer's link into the allowed root", () => {
		const linked = `  pkgs/a:\n    dependencies:\n      x:\n        specifier: link:../zz-${word}\n        version: link:../zz-${word}\n`;
		expect(lines(lockfile(`${linked}\n${own}`))).toEqual({ G9: 2 });
	});

	it("counts another importer's line that names a reserved package", () => {
		const named = `  pkgs/a:\n    dependencies:\n      pkg-${word}:\n        specifier: 1.0.0\n        version: 1.0.0\n`;
		expect(lines(lockfile(`${named}\n${own}`))).toEqual({ G9: 1 });
	});

	it("counts the root's key outside importers: and in another lockfile", () => {
		const outside = `\n  pkgs/zz-${word}:\n    resolution: {integrity: sha512-x}\n`;
		expect(lines(lockfile(plain, outside))).toEqual({ G9: 1 });
		expect(lines(lockfile(own), "pkgs/a/pnpm-lock.yaml")).toEqual({ G9: 1 });
	});

	it("names each counted line by its number", () => {
		const named = `  pkgs/a:\n    dependencies:\n      pkg-${word}:\n        specifier: 1.0.0\n`;
		const { found } = tripwire(fixture({ files: { "pnpm-lock.yaml": lockfile(named) } }));
		same(found.G9, ["pnpm-lock.yaml:9"]);
	});
});

describe("G10: failing closed", () => {
	it("passes a tracked file the working tree doesn't hold, which the gate checks itself", () => {
		expect(counts({ modes: { "pkgs/a/src/gone.ts": "100644" } })).toEqual({});
	});

	it.each([
		["a Cargo manifest", { files: { "pkgs/r/Cargo.toml": "" }, unreadable: ["pkgs/r/Cargo.toml"] }],
		["a module", { unreadable: ["pkgs/a/src/b.ts"] }],
		["a manifest that doesn't parse", { files: { "pkgs/a/package.json": '{ "name": ' } }],
		["a tsconfig that doesn't parse", { files: { "pkgs/a/tsconfig.json": "{ include: [] }" } }],
		["a turbo.json that isn't an object", { files: { "turbo.json": "[]" } }],
		["an index mode git never writes", { modes: { "pkgs/a/src/odd.ts": "100664" } }],
	])("counts %s it can't read", (_label, tree: Tree) => {
		expect(counts(tree)).toEqual({ G10a: 1 });
	});

	it("counts an unreadable workspace file, and the root it can't place", () => {
		expect(counts({ unreadable: ["pnpm-workspace.yaml"] })).toEqual({ G7: 1, G10a: 1 });
	});

	it.each([
		["the index", 128, "entries"],
		["the untracked files", 127, "untracked"],
	] as const)("checks nothing when listing %s fails", (_label, code, list) => {
		const input = fixture({ files: { [`pkgs/p/x-${word}.ts`]: "" } });
		const failed = { gitExit: code };
		const problems = tripwire(
			list === "entries" ? { ...input, entries: failed } : { ...input, untracked: failed },
		);
		expect(input.reads.length).toBe(0);
		expect(tripwireLines(problems, true)).toEqual([
			`reserved tripwire: git exited ${code}; nothing was checked`,
			STOP_LINE,
		]);
	});
});

// Each rule's own fixture, which only that rule counts.
const ONLY: readonly (readonly [TripwireKind, string, Tree])[] = [
	["G1", "a document that isn't an allowed one", { files: { [`docs/${word}.md`]: "" } }],
	["G2", "a Rust source in the allowed root", { files: { [`${root}src/x.rs`]: "" } }],
	["G3", "a Cargo feature key", { files: { "pkgs/r/Cargo.toml": "[features]\nreserved = []\n" } }],
	["G4", "a custom cfg", { files: { "pkgs/r/src/lib.rs": "#[cfg(reserved)]\nmod m;\n" } }],
	[
		"G5",
		"a raw string in ordinary Rust",
		{ files: { "pkgs/r/src/lib.rs": `const V: &str = r#"zz-${word}"#;\n` } },
	],
	[
		"G6",
		"a static import into the allowed root",
		{ files: { "pkgs/a/src/x.ts": `import { x } from "../../zz-${word}/x.ts";\n` } },
	],
	["G7", "an allowed document outside docs/", { docs: [`spec/${word}.md`], without: [doc] }],
	["G8a", "a tracked symlink", { modes: { "pkgs/a/src/link.ts": "120000" } }],
	[
		"G9",
		"another importer's line that names a reserved package",
		{
			files: {
				"pnpm-lock.yaml": `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  pkgs/a:\n    dependencies:\n      pkg-${word}:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n`,
			},
		},
	],
	["G10a", "a module it can't read", { unreadable: ["pkgs/a/src/b.ts"] }],
];

describe("mutations: each rule removed lets its own fixture through", () => {
	const ruled = (
		tree: Tree,
		rules: readonly TripwireKind[],
	): Partial<Record<TripwireKind, number>> =>
		Object.fromEntries(
			Object.entries(tripwire({ ...fixture(tree), rules }).found)
				.filter(([, items]) => items.length > 0)
				.map(([kind, items]) => [kind, items.length]),
		);

	it("runs every rule, in order, unless told otherwise", () => {
		expect(TRIPWIRE_RULES).toEqual(["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8a", "G9", "G10a"]);
		expect(ONLY.map(([kind]) => kind)).toEqual(TRIPWIRE_RULES);
		for (const [, , tree] of ONLY) expect(ruled(tree, TRIPWIRE_RULES)).toEqual(counts(tree));
	});

	it.each(ONLY)("%s: %s", (kind, _label, tree) => {
		expect(counts(tree)).toEqual({ [kind]: 1 });
		expect(
			ruled(
				tree,
				TRIPWIRE_RULES.filter((rule) => rule !== kind),
			),
		).toEqual({});
	});

	it("still leaves an unreadable workspace file to G10a, not G7, with G10a removed", () => {
		const tree: Tree = { unreadable: ["pnpm-workspace.yaml"] };
		expect(counts(tree)).toEqual({ G7: 1, G10a: 1 });
		expect(
			ruled(
				tree,
				TRIPWIRE_RULES.filter((rule) => rule !== "G10a"),
			),
		).toEqual({ G7: 1 });
	});
});

describe("tripwire lines", () => {
	it("prints one pinned line per rule in rule order, then the stop line once, naming nothing", () => {
		const x = ["x"];
		const problems: Problems = {
			found: {
				G10a: x,
				G9: ["x:1"],
				G8a: x,
				G7: x,
				G6: x,
				G5: x,
				G4: x,
				G3: x,
				G2: x,
				G1: x,
			},
			gitExit: 3,
			checked: { paths: 0, untracked: 0, cargo: 0, rust: 0, modules: 0 },
		};
		expect(tripwireLines(problems, false)).toEqual([
			"reserved tripwire: 1 path(s) name a reserved word outside the allowed reserved roots, or spell it in upper case",
			"reserved tripwire: 1 Rust or Cargo file(s) have a reserved name; no reserved Rust may land, in an allowed root or elsewhere",
			'reserved tripwire: 1 Cargo file(s) contain "reserved"; no Cargo feature whose name contains it may be defined or enabled',
			'reserved tripwire: 1 Rust source(s) use a cfg named "reserved"',
			"reserved tripwire: 1 ordinary Rust or Cargo file(s) name a reserved word in a string or Cargo value",
			"reserved tripwire: 1 ordinary file(s) point at a reserved path or into an allowed reserved root",
			"reserved tripwire: 1 allowed reserved root(s) or document(s) fail the integrity check",
			"reserved tripwire: 1 tracked symlink(s) or submodule(s); none may be tracked",
			"reserved tripwire: 1 lockfile line(s) link a reserved package into an ordinary one",
			"reserved tripwire: 1 file(s) or folder(s) couldn't be read; nothing about them was checked",
			"reserved tripwire: git exited 3; nothing was checked",
			"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.",
		]);
	});

	it("names what each rule found only when asked", () => {
		const stray = `pkgs/p/x-${word}.ts`;
		const files = {
			[stray]: "",
			"pkgs/a/src/x.ts": `import "../../zz-${word}/x.ts";\n`,
			"pkgs/r/Cargo.toml": `[features]\nreserved = ["zz-${word}"]\n`,
		};
		const problems = tripwire(fixture({ files }));
		const plain = tripwireLines(problems, false);
		expect(plain.length).toBe(5);
		expect(plain.filter((line) => reservedWord.test(line) || /[\\/]/.test(line)).length).toBe(0);
		const named = tripwireLines(problems, true);
		same(named.slice(0, 4), [
			`${plain[0]}: ${stray}`,
			`${plain[1]}: pkgs/r/Cargo.toml`,
			`${plain[2]}: pkgs/r/Cargo.toml`,
			`${plain[3]}: pkgs/a/src/x.ts`,
		]);
		expect(named.at(-1)).toBe(STOP_LINE);
	});

	it("prints the gate's success line with its own prefix and every count", () => {
		const counts = { paths: 6, untracked: 5, folders: 4, cargo: 3, rust: 2, modules: 1 };
		expect(checkLine(counts)).toBe(
			"reserved check: 6 path(s), 5 untracked file(s), 4 folder(s), 3 Cargo file(s), 2 Rust source(s) and 1 module(s) and config(s) checked, with their folders, references and scanned folders; no problem found in them",
		);
	});
});

describe("the pointers rule 6 reads, for the gate's reference checks", () => {
	it("gives each pointer with its anchor and field, and reads nothing it isn't given", () => {
		const module = 'import "./a.ts";\nconst b = import("../b.ts");\nconst c = "./c.json";\n';
		same(pointersOf("pkgs/p/src/m.ts", module), [
			{ value: "./a.ts", anchor: "pkgs/p/src", field: "module:bare" },
			{ value: "../b.ts", anchor: "pkgs/p/src", field: "module:dynamic" },
			{ value: "./c.json", anchor: "pkgs/p/src", field: "module:other" },
		]);
		same(pointersOf("pkgs/p/vitest.config.ts", 'export default { root: "x" };\n'), [
			{ value: "x", anchor: "pkgs/p", field: "config" },
		]);
		same(pointersOf("pkgs/p/index.html", '<script src="/main.ts?v=1"></script>\n'), [
			{ value: "/main.ts?v=1", anchor: null, field: "html" },
			{ value: "main.ts", anchor: "pkgs/p", field: "html" },
		]);
		const manifest = '{ "main": "m.js", "dependencies": { "x": "file:../x", "y": "1" } }';
		same(pointersOf("pkgs/p/package.json", manifest), [
			{ value: "m.js", anchor: "pkgs/p", field: "manifest:main" },
			{ value: "x", anchor: null, field: "manifest:dependency" },
			{ value: "../x", anchor: "pkgs/p", field: "manifest:local" },
			{ value: "y", anchor: null, field: "manifest:dependency" },
			{ value: "1", anchor: null, field: "manifest:dependency" },
		]);
		const tsconfig =
			'{ "extends": "../base.json", "references": [{ "path": "../q" }], "compilerOptions": { "typeRoots": ["./types"] } }';
		same(pointersOf("pkgs/p/tsconfig.json", tsconfig), [
			{ value: "../base.json", anchor: "pkgs/p", field: "tsconfig:extends" },
			{ value: "../q", anchor: "pkgs/p", field: "tsconfig:references" },
			{ value: "./types", anchor: "pkgs/p", field: "tsconfig:typeRoots" },
		]);
		expect(pointersOf("pkgs/p/tsconfig.json", "{ not json")).toBe("unparsable");
		expect(pointersOf("pkgs/p/notes.md", "./a.ts")).toBe(null);
		expect(pointersOf("turbo.json", "{}")).toBe(null);
	});
});

describe("the reserved-tripwire.ts module", () => {
	const file = path.join(repo, "tools", "verify", "reserved-tripwire.ts");

	it("re-exports the allowed set itself", () => {
		expect([
			ALLOWED_ROOTS === allowed.ALLOWED_ROOTS,
			ALLOWED_DOCS === allowed.ALLOWED_DOCS,
		]).toEqual([true, true]);
		const spike = `${spikeNumber}-${word}`;
		same(
			[...ALLOWED_ROOTS, ...ALLOWED_DOCS],
			[
				`spikes/${spike}/`,
				`docs/roadmap/m7-${word}.md`,
				`docs/adr/0009-${spike}-sign-in-with-chatgpt.md`,
			],
		);
	});

	it("loads only node: built-ins and files the gate checks before loading them", () => {
		const loaded = literals(readFileSync(file, "utf8"))
			.filter(({ kind }) => kind !== "type" && kind !== "other")
			.map(({ value }) => value);
		same(loaded, ["node:path", "../../reserved-tests.ts", "./lib/imports.ts", "./lib/allowed.ts"]);
	});

	it("runs nothing when imported", async () => {
		const load = `await import(${JSON.stringify(pathToFileURL(file).href)}); console.log("loaded");`;
		const result = await capture(
			{ command: process.execPath, args: ["--input-type=module", "--eval", load] },
			{ cwd: repo },
		);
		expect([result.code, result.stdout.trim(), result.stderr]).toEqual([0, "loaded", ""]);
	});

	it.each([[[]], [["--names"]]])(
		"refuses to run as a command (%j), pointing at the gate",
		async (args) => {
			const result = await capture(
				{ command: process.execPath, args: [file, ...args] },
				{ cwd: repo },
			);
			expect([result.code, result.stdout, result.stderr.trim()]).toEqual([
				2,
				"",
				"reserved-tripwire.ts: a module, not a command; run node tools/verify/gate.ts",
			]);
		},
	);
});

describe("the repository's own tree", () => {
	it("has nothing reserved outside the allowed set, and the rules read no reserved file", async () => {
		const git = (args: readonly string[]) =>
			capture({ command: "git", args: ["-c", "core.fsmonitor=false", ...args] }, { cwd: repo });
		const [index, others] = await Promise.all([
			git(["ls-files", "-z", "-s"]),
			git(["ls-files", "-z", "-o", "--exclude-standard"]),
		]);
		expect([index.code, others.code]).toEqual([0, 0]);
		const entries = index.stdout
			.split("\0")
			.filter(Boolean)
			.map((record): IndexEntry => {
				const tab = record.indexOf("\t");
				return { mode: record.slice(0, record.indexOf(" ")), path: record.slice(tab + 1) };
			});
		let refused = 0;
		const problems = tripwire({
			entries,
			untracked: others.stdout.split("\0").filter(Boolean),
			allowedRoots: ALLOWED_ROOTS,
			allowedDocs: ALLOWED_DOCS,
			text: (rel) => {
				if (reservedWord.test(rel) || inRoot(rel, ALLOWED_ROOTS)) {
					refused++;
					return "absent";
				}
				try {
					return readFileSync(path.join(repo, rel), "utf8");
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
				}
			},
		});
		// Counts only: the paths are the repository's own, reserved ones included.
		expect(refused).toBe(0);
		expect(tripwireLines(problems, false)).toEqual([]);
		const { paths, cargo, rust, modules } = problems.checked;
		expect([paths > 500, cargo > 0, rust > 0, modules > 300]).toEqual([true, true, true, true]);
	});
});
