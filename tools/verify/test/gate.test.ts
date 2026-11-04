import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reservedWord } from "../../../reserved-tests.ts";
import { gateCli, startCheckLines, USAGE } from "../gate.ts";
import { HELPERS, START_CHECK, startLines } from "../lib/bootstrap.ts";
import {
	GATE_CHECKS,
	GATE_ROOT_ENV,
	type GateCheck,
	type GateOptions,
	type GateResult,
	gateWith,
	runGate,
	scriptCommands,
} from "../lib/gate.ts";
import { checkInstallInputs, INSTALL_STOP_LINE } from "../lib/hooks.ts";
import { runtimeSpecifiers } from "../lib/imports.ts";
import { packageDirs } from "../lib/listing.ts";
import { Checkout, type FsOps, nodeFs } from "../lib/safe-fs.ts";
import { capture } from "../lib/spawn.ts";
import { approvedWorkspace } from "../lib/workspace-policy.ts";
import { STOP_LINE } from "../reserved-tripwire.ts";
import {
	canLink,
	copyOwn,
	gitEnvOf,
	ownRepo,
	ownWorkspace,
	readerSpy,
	realGit,
	scrub,
	spawnSpy,
	type TempRepo,
	tempRepo,
	word,
} from "./temp-repo.ts";

// The input gate on synthetic checkouts. Reserved words are built at run time and every compared
// path is scrubbed, so a failure prints neither a word nor a fixture path.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

const w = word();
const symlinks = canLink("file") && canLink("dir");
const NO_SYMLINKS =
	"file and folder symlinks need Developer Mode or elevation on this Windows host";
// The fixture's allowed root and document, which nothing may read.
const root = `spikes/zz-${w}/`;
const doc = `docs/notes/${w}.md`;
const BASE: Readonly<Record<string, string>> = {
	"pnpm-workspace.yaml": ownWorkspace,
	"package.json": '{ "name": "fixture", "private": true, "type": "module" }\n',
	"packages/a/package.json": '{ "name": "a" }\n',
	"packages/a/tsconfig.json": '{ "include": ["**/*.ts"] }\n',
	"packages/a/vitest.config.ts": "export default {};\n",
	"packages/a/src/index.ts": 'import { b } from "./b.ts";\n\nexport const a = b;\n',
	"packages/a/src/b.ts": "export const b = 1;\n",
	"packages/a/test/a.test.ts": 'import { a } from "../src/index.ts";\n\nvoid a;\n',
	"crates/r/Cargo.toml": '[package]\nname = "r"\nversion = "0.0.0"\n',
	"crates/r/src/lib.rs": "mod m;\n",
	"crates/r/src/m.rs": "pub fn m() {}\n",
	"tools/verify/steps/ok.ts": "export const step = {};\n",
	"spikes/s1/README.md": "s1\n",
	"docs/notes.md": "notes\n",
};
const HELD: Readonly<Record<string, string>> = {
	[`${root}package.json`]: '{ "name": "held" }\n',
	[`${root}src/index.ts`]: "export {};\n",
	[doc]: "doc\n",
};

interface Fixture {
	readonly files?: Readonly<Record<string, string>>;
	// Written after the commit, after their ignore patterns.
	readonly ignored?: Readonly<Record<string, string>>;
	readonly untracked?: Readonly<Record<string, string>>;
	readonly held?: boolean;
	// The gate's own files, copied from this repository.
	readonly entry?: boolean;
}

function fixture(tree: Fixture = {}): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	if (tree.entry === true) copyOwn(repo, ENTRY);
	const held = tree.held === false || tree.entry === true ? {} : HELD;
	for (const [file, text] of Object.entries({ ...BASE, ...held, ...tree.files })) {
		repo.write(file, text);
	}
	repo.commit();
	const ignored = Object.keys(tree.ignored ?? {});
	if (ignored.length > 0) repo.ignore(...ignored);
	for (const [file, text] of Object.entries({ ...tree.ignored, ...tree.untracked })) {
		repo.write(file, text);
	}
	return repo;
}

const inHeld = (rel: string): boolean =>
	reservedWord.test(rel) || rel.toLowerCase().startsWith(root.toLowerCase());

interface Run {
	readonly result: GateResult;
	readonly opens: readonly string[];
	readonly readdirs: readonly string[];
	readonly refused: readonly string[];
	readonly calls: readonly { command: string; args: readonly string[] }[];
}

// The gate with a reader spy that refuses (and records) every open of a held path or of `forbidden`,
// and a spawn spy that answers git's listing calls with the repository's real git.
async function gate(
	repo: TempRepo,
	options: {
		checks?: readonly GateCheck[];
		names?: boolean;
		forbidden?: (rel: string) => boolean;
		fs?: FsOps;
	} = {},
): Promise<Run> {
	const forbidden = (rel: string): boolean => inHeld(rel) || (options.forbidden?.(rel) ?? false);
	const spy = readerSpy(repo.dir, forbidden, options.fs);
	const children = spawnSpy(realGit(repo));
	const gateOptions: GateOptions = {
		root: repo.dir,
		names: options.names ?? false,
		env: gitEnvOf(repo),
		fs: spy.fs,
		git: children.git,
		allowedRoots: [root],
		allowedDocs: [doc],
	};
	const result = await (options.checks === undefined
		? runGate(gateOptions)
		: gateWith(options.checks, gateOptions));
	const { opens, readdirs, refused } = spy;
	return { result, opens, readdirs, refused, calls: children.calls };
}

// The lines a run printed, scrubbed.
const shown = (run: Run): string[] => run.result.lines.map(scrub);
// The count lines without their counts.
const uncounted = (lines: readonly string[]): string[] =>
	lines
		.filter((line) => line !== STOP_LINE)
		.map((line) => line.replace(/^(reserved \w+: )\d+ /, "$1"));
// No path and no reserved word: what every count-only line must be.
const neutral = (lines: readonly string[]): boolean =>
	lines.every((line) => !/[\\/]/.test(line) && !reservedWord.test(line));
// Only git's own listing calls started: nothing was built, tested or run.
const onlyListing = (run: Run): boolean =>
	run.calls.length === 3 &&
	run.calls.every(
		({ command, args }) =>
			command === "git" &&
			args[0] === "-c" &&
			args[1] === "core.fsmonitor=false" &&
			(args[2] === "rev-parse" || args[2] === "ls-files"),
	);

// Each check's count line without its count.
const LINE: Readonly<Record<string, string>> = {
	kinds:
		"reserved tripwire: listed path(s) aren't a regular file in real folders of this checkout (a link, junction, redirect, hard link, folder, special file, or one that couldn't be checked); none of them was read",
	G1: "reserved tripwire: path(s) name a reserved word outside the allowed reserved roots, or spell it in upper case",
	G6: "reserved tripwire: ordinary file(s) point at a reserved path or into an allowed reserved root",
	G10a: "reserved tripwire: file(s) or folder(s) couldn't be read; nothing about them was checked",
	"refs-rust":
		"reserved tripwire: file(s) that Rust mod, #[path] or include! declarations name aren't regular, listed files of this checkout, lie outside it or name a reserved word; none of them was read",
	"refs-cargo":
		"reserved tripwire: file(s) or folder(s) that Cargo manifests or .cargo configs name aren't regular, listed files in real folders of this checkout or lie outside it, or a manifest, .cargo config or toolchain file couldn't be parsed or sets a key or form this check doesn't follow; none of them was read",
	"refs-modules":
		"reserved tripwire: file(s) or folder(s) that relative or absolute module specifiers or runner configs name, or the package.json a # specifier resolves through, aren't regular, listed files in real folders of this checkout or lie outside it, or a module names one in a form this check doesn't follow; none of them was read",
	"refs-config":
		"reserved tripwire: file(s) or folder(s) that package.json specs, scripts, entry points and imports maps (a subpath pattern's matches among them, which must be in the index), tsconfig fields, Biome configs' extends and plugins or HTML src and href values name aren't regular, listed files in real folders of this checkout or lie outside it, or a config names one in a form this check doesn't follow; none of them was read",
	"scan-pnpm":
		"reserved tripwire: workspace package folder(s) or manifest(s) that pnpm and turbo read aren't regular, listed files in real folders; none of them was read",
	"scan-tsc":
		"reserved tripwire: file(s) or folder(s) tsc would pick up from a project's include folders aren't regular, listed files in real folders, or a project's include leaves this checkout; none of them was read",
	"scan-vitest":
		"reserved tripwire: file(s) or folder(s) Vitest would pick up from a package folder aren't regular, listed files in real folders; none of them was read",
	"scan-cargo":
		"reserved tripwire: file(s) or folder(s) Cargo or rustup would pick up from a crate's folders aren't regular, listed files in real folders, or a workspace's glob member leaves this checkout; none of them was read",
	"scan-verify":
		"reserved tripwire: step or profile file(s) verify would load aren't regular, listed files in real folders; none of them was read",
	"scan-prefetch":
		"reserved tripwire: spike folder(s) or prefetch script(s) pnpm m0:prefetch would run aren't regular, listed files in real folders; none of them was read",
	npmrc:
		"reserved tripwire: .npmrc path(s) in the root or a package folder; pnpm takes settings from them, node-options among them, before anything it starts; none of them was read",
	"command-shadows":
		"reserved tripwire: entry(ies) in the root or a package folder are named for a command started there (node, pnpm, npm, git or a script's first word) with an extension cmd.exe runs, which it would run from that folder in place of the tool on PATH; none of them was read",
	"workspace-file":
		"reserved tripwire: workspace file(s) aren't a listed regular file in the approved form; pnpm takes settings from it, nodeOptions and scriptShell among them, before anything it starts",
};

// A refusal with exactly `lines` (counts left out), the stop line once and last, nothing named,
// nothing held opened, and no child but git's listing.
function refusedWith(run: Run, lines: readonly string[]): void {
	expect(run.result.ok).toBe(false);
	expect(uncounted(shown(run))).toEqual(lines);
	expect(shown(run).filter((item) => item === STOP_LINE).length).toBe(1);
	expect(run.result.lines.at(-1)).toBe(STOP_LINE);
	expect(neutral(run.result.lines)).toBe(true);
	expect(run.refused).toEqual([]);
	expect(onlyListing(run)).toBe(true);
}

const passed = (run: Run): void => {
	expect(shown(run)).toEqual([expect.stringMatching(/^reserved check: /)]);
	expect(run.result.ok).toBe(true);
};

const at = (repo: TempRepo, rel: string): string => path.join(repo.dir, ...rel.split("/"));

describe("a passing checkout", () => {
	it("passes with one check line, reading no held file and starting nothing but git's listing", async () => {
		const run = await gate(fixture());
		passed(run);
		expect(run.result.lines[0]).toMatch(
			/^reserved check: \d+ path\(s\), 0 untracked file\(s\), \d+ folder\(s\), 1 Cargo file\(s\), 2 Rust source\(s\) and \d+ module\(s\) and config\(s\) checked, with their folders, references and scanned folders; no problem found in them$/,
		);
		expect(run.opens.some(inHeld)).toBe(false);
		expect(run.refused).toEqual([]);
		expect(onlyListing(run)).toBe(true);
		expect(run.result.tracked.length).toBe(Object.keys({ ...BASE, ...HELD }).length);
		expect(run.result.listing?.untracked).toEqual([]);
	});

	it("counts a tracked file that is missing from the tree, and never opens it", async () => {
		const repo = fixture();
		rmSync(at(repo, "packages/a/src/b.ts"));
		const run = await gate(repo);
		passed(run);
		expect(run.opens.includes("packages/a/src/b.ts")).toBe(false);
	});
});

describe("refusals before any read or child start", () => {
	it("refuses an untracked helper holding a literal path into the allowed root", async () => {
		const helper = `import "../../../${root}src/index.ts";\n`;
		const run = await gate(fixture({ untracked: { "packages/a/src/helper.ts": helper } }));
		refusedWith(run, [LINE.G6 ?? "", LINE["refs-modules"] ?? ""]);
		expect(run.opens.some(inHeld)).toBe(false);
	});

	// Each case's fixture refused by its check alone, counts only and naming none, and with --names
	// naming its first file as unsupported.
	async function refusedAsUnsupported(
		cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[],
	): Promise<void> {
		for (const [label, files, check] of cases) {
			const repo = fixture({ files });
			const run = await gate(repo);
			expect([label, uncounted(shown(run))]).toEqual([label, [LINE[check]]]);
			refusedWith(run, [LINE[check] ?? ""]);
			// --names says which file, and why.
			const named = shown(await gate(repo, { names: true }))[0] ?? "";
			const file = Object.keys(files)[0] ?? "";
			expect([label, named.endsWith(`: ${file} (unsupported)`)]).toEqual([label, true]);
		}
	}

	it("refuses a redirection it doesn't follow, in an imports map, a glob import, a Biome config, a toolchain file or a .cargo config, naming none", async () => {
		await refusedAsUnsupported([
			[
				"an imports pattern with two stars",
				{ "packages/a/package.json": '{ "name": "a", "imports": { "#x/*": "./gen/*/*.js" } }\n' },
				"refs-config",
			],
			[
				"a glob import inside the checkout",
				{ "packages/a/src/glob.ts": 'export const m = import.meta.glob("./*.ts");\n' },
				"refs-modules",
			],
			[
				"a Biome config extending a package's",
				{ "biome.json": '{ "extends": ["@scope/config/biome"] }\n' },
				"refs-config",
			],
			[
				"a nested dot-named Biome config extending a package's",
				{ "tools/x/.biome.json": '{ "root": false, "extends": ["@scope/config/biome"] }\n' },
				"refs-config",
			],
			["a toolchain path", { "rust-toolchain.toml": '[toolchain]\npath = "./tc"\n' }, "refs-cargo"],
			[
				"a .cargo config wrapper",
				{ "crates/r/.cargo/config.toml": '[build]\nrustc-wrapper = "./wrap.sh"\n' },
				"refs-cargo",
			],
		]);
	});

	it("refuses a tsconfig or package.json value that redirects tsc in a form these checks don't follow, naming none: baseUrl, a typeRoots folder, moduleSuffixes, typesVersions and an extends whose name isn't a tsconfig's", async () => {
		await refusedAsUnsupported([
			[
				"a tsconfig baseUrl",
				{
					"packages/a/tsconfig.json":
						'{ "include": ["**/*.ts"], "compilerOptions": { "baseUrl": "." } }\n',
				},
				"refs-config",
			],
			[
				"a tsconfig typeRoots folder",
				{
					"packages/a/tsconfig.json":
						'{ "include": ["**/*.ts"], "compilerOptions": { "typeRoots": ["./src"] } }\n',
				},
				"refs-config",
			],
			[
				"a tsconfig moduleSuffixes",
				{
					"packages/a/tsconfig.json":
						'{ "include": ["**/*.ts"], "compilerOptions": { "moduleSuffixes": [".native", ""] } }\n',
				},
				"refs-config",
			],
			[
				"a package.json typesVersions",
				{
					"packages/a/package.json":
						'{ "name": "a", "typesVersions": { "*": { "*": ["./types/*"] } } }\n',
				},
				"refs-config",
			],
			[
				"a tsconfig extending a config whose name isn't a tsconfig's",
				{
					"packages/a/tsconfig.json": '{ "extends": "./base.json", "include": ["**/*.ts"] }\n',
					"packages/a/base.json": "{}\n",
				},
				"refs-config",
			],
		]);
	});

	it("refuses a nested dot-named Biome config's plugin in the allowed root, never opening it", async () => {
		const files = {
			"tools/x/.biome.json": `{ "root": false, "plugins": ["../../${root}rule.grit"] }\n`,
			[`${root}rule.grit`]: "",
		};
		const repo = fixture({ files });
		const run = await gate(repo);
		refusedWith(run, [LINE["refs-config"] ?? ""]);
		expect(run.opens.some(inHeld)).toBe(false);
		const named = shown(await gate(repo, { names: true }))[0] ?? "";
		expect(named.endsWith(`: ${scrub(root)}rule.grit (reserved)`)).toBe(true);
	});

	it("refuses a reference that leaves the checkout to a target that exists there, naming only the file that makes it and opening nothing outside", async () => {
		const climb = "../../../../outside";
		const cases: readonly (readonly [string, Readonly<Record<string, string>>, string])[] = [
			[
				"an import beside the checkout",
				{ "packages/a/src/helper.ts": `import "${climb}/helper.ts";\n` },
				"refs-modules",
			],
			[
				"a runner config's include glob",
				{
					"packages/a/vitest.config.ts": `export default { test: { include: ["${climb.slice(3)}/**/*.test.ts"] } };\n`,
				},
				"refs-modules",
			],
			[
				"a link: spec",
				{
					"packages/a/package.json": `{ "name": "a", "dependencies": { "x": "link:${climb.slice(3)}/pkg" } }\n`,
				},
				"refs-config",
			],
			[
				"a Biome config's plugin",
				{ "biome.json": '{ "plugins": ["../outside/rules.grit"] }\n' },
				"refs-config",
			],
			[
				"a tsconfig include",
				{ "packages/a/tsconfig.json": `{ "include": ["**/*.ts", "${climb.slice(3)}/**/*.ts"] }\n` },
				"scan-tsc",
			],
			[
				"a Cargo path dependency",
				{
					"crates/r/Cargo.toml": `[package]\nname = "r"\nversion = "0.0.0"\n\n[dependencies]\nc = { path = "${climb.slice(3)}/c" }\n`,
				},
				"refs-cargo",
			],
			[
				"a test script running a helper beside the checkout",
				{
					"packages/a/package.json": `{ "name": "a", "scripts": { "test": "node ${climb.slice(3)}/helper.ts" } }\n`,
				},
				"refs-config",
			],
			[
				"a test script running a helper from the home folder",
				{
					"packages/a/package.json": '{ "name": "a", "scripts": { "test": "node ~/helper.ts" } }\n',
				},
				"refs-config",
			],
			[
				"an eager glob import",
				{
					"packages/a/src/glob.ts": `export const m = import.meta.glob("${climb}/*.ts", { eager: true });\n`,
				},
				"refs-modules",
			],
			[
				"tsconfig paths, read from the config's folder and not from baseUrl",
				{
					"packages/a/tsconfig.json": `{ "include": ["**/*.ts"], "compilerOptions": { "paths": { "#x/*": ["${climb.slice(3)}/*"] }, "baseUrl": "sub" } }\n`,
				},
				"refs-config",
			],
			[
				"a tsconfig types entry",
				{
					"packages/a/tsconfig.json": `{ "include": ["**/*.ts"], "compilerOptions": { "types": ["${climb.slice(3)}/helper.ts"] } }\n`,
				},
				"refs-config",
			],
			[
				"a #[path] module",
				{ "crates/r/src/lib.rs": `mod m;\n#[path = "${climb}/m.rs"]\nmod n;\n` },
				"refs-rust",
			],
		];
		const beside = (rel: string): boolean => path.isAbsolute(rel);
		for (const [label, files, check] of cases) {
			const repo = fixture({ files });
			for (const [name, text] of [
				["helper.ts", "export {};\n"],
				["rules.grit", ""],
				["x.test.ts", ""],
				["x.ts", ""],
				["m.rs", ""],
				["pkg/package.json", '{ "name": "pkg" }\n'],
				["c/Cargo.toml", '[package]\nname = "c"\n'],
			] as const) {
				mkdirSync(path.dirname(path.join(repo.outside, name)), { recursive: true });
				writeFileSync(path.join(repo.outside, name), text);
			}
			const run = await gate(repo, { forbidden: beside });
			expect([label, uncounted(shown(run))]).toEqual([label, [LINE[check]]]);
			refusedWith(run, [LINE[check] ?? ""]);
			expect([label, run.opens.filter(beside), run.readdirs.filter(beside)]).toEqual([
				label,
				[],
				[],
			]);
			// --names says which file made the reference, and why.
			const named = shown(await gate(repo, { names: true, forbidden: beside }))[0] ?? "";
			const file = Object.keys(files)[0] ?? "";
			expect([label, named.endsWith(`: ${file} (outside)`)]).toEqual([label, true]);
		}
	});

	it("refuses a test script running an ignored helper in the checkout, without reading it", async () => {
		const repo = fixture({
			files: {
				"packages/a/package.json": '{ "name": "a", "scripts": { "test": "node ./gen/x.mjs" } }\n',
			},
			ignored: { "packages/a/gen/x.mjs": "export {};\n" },
		});
		const run = await gate(repo, { forbidden: (rel) => rel === "packages/a/gen/x.mjs" });
		refusedWith(run, [LINE["refs-config"] ?? ""]);
		expect(run.opens.includes("packages/a/gen/x.mjs")).toBe(false);
		const named = shown(await gate(repo, { names: true }))[0] ?? "";
		expect(named.endsWith(": packages/a/gen/x.mjs (unlisted)")).toBe(true);
	});

	it("follows an exports subpath pattern, and refuses an ignored or untracked match without reading it, naming only the match", async () => {
		const files = {
			"packages/a/package.json": '{ "name": "a", "exports": { "./*": "./gen/*.js" } }\n',
			"packages/a/gen/x.js": "export {};\n",
		};
		passed(await gate(fixture({ files })));
		for (const [tree, rel] of [
			[{ files, ignored: { "packages/a/gen/y.js": "export {};\n" } }, "packages/a/gen/y.js"],
			[{ files, untracked: { "packages/a/gen/z.js": "export {};\n" } }, "packages/a/gen/z.js"],
		] as const) {
			const repo = fixture(tree);
			const run = await gate(repo, { forbidden: (open) => open === "packages/a/gen/y.js" });
			refusedWith(run, [LINE["refs-config"] ?? ""]);
			expect(run.opens.includes("packages/a/gen/y.js")).toBe(false);
			const named = shown(await gate(repo, { names: true }))[0] ?? "";
			expect([rel, named.endsWith(`: ${rel} (unlisted)`)]).toEqual([rel, true]);
		}
	});

	it("passes a runner config that probes /proc/self/fd, and refuses one that names a path below it", async () => {
		const probe = (value: string): string =>
			`import { accessSync, constants } from "node:fs";\n\nexport default { test: {} };\ntry {\n\taccessSync(${JSON.stringify(value)}, constants.R_OK);\n} catch {}\n`;
		passed(
			await gate(fixture({ files: { "packages/a/vitest.config.ts": probe("/proc/self/fd") } })),
		);
		const repo = fixture({ files: { "packages/a/vitest.config.ts": probe("/proc/self/fd/0") } });
		refusedWith(await gate(repo), [LINE["refs-modules"] ?? ""]);
		const named = shown(await gate(repo, { names: true }))[0] ?? "";
		expect(named.endsWith(": packages/a/vitest.config.ts (outside)")).toBe(true);
	});

	it("refuses a tsconfig paths pattern reaching an ignored file outside the include roots, without reading it", async () => {
		const repo = fixture({
			files: {
				"packages/a/tsconfig.json":
					'{ "include": ["src/**/*.ts", "test/**/*.ts"], "compilerOptions": { "paths": { "#gen/*": ["./gen/*"] } } }\n',
				"packages/a/src/gen-user.ts": 'import "#gen/x";\n',
			},
			ignored: { "packages/a/gen/x.ts": "export {};\n" },
		});
		const run = await gate(repo, { forbidden: (rel) => rel === "packages/a/gen/x.ts" });
		refusedWith(run, [LINE["refs-config"] ?? ""]);
		expect(run.opens.includes("packages/a/gen/x.ts")).toBe(false);
		const named = shown(await gate(repo, { names: true }))[0] ?? "";
		expect(named.endsWith(": packages/a/tsconfig.json (unsupported)")).toBe(true);
	});

	it("refuses an exports or imports folder mapping reaching an ignored file outside the include roots, without reading it", async () => {
		const include = '{ "include": ["src/**/*.ts", "test/**/*.ts"] }\n';
		for (const [label, manifest, user] of [
			[
				"an exports folder mapping",
				'{ "name": "a", "exports": { "./gen/": "./gen/" } }\n',
				'import "a/gen/x.js";\n',
			],
			[
				"an imports folder mapping",
				'{ "name": "a", "imports": { "#gen/": "./gen/" } }\n',
				'import "#gen/x.js";\n',
			],
		] as const) {
			const repo = fixture({
				files: {
					"packages/a/package.json": manifest,
					"packages/a/tsconfig.json": include,
					"packages/a/src/gen-user.ts": user,
				},
				ignored: { "packages/a/gen/x.ts": "export {};\n" },
			});
			const run = await gate(repo, { forbidden: (rel) => rel === "packages/a/gen/x.ts" });
			expect([label, uncounted(shown(run))]).toEqual([label, [LINE["refs-config"]]]);
			refusedWith(run, [LINE["refs-config"] ?? ""]);
			expect([label, run.opens.includes("packages/a/gen/x.ts")]).toEqual([label, false]);
			const named = shown(await gate(repo, { names: true }))[0] ?? "";
			expect([label, named.endsWith(": packages/a/package.json (unsupported)")]).toEqual([
				label,
				true,
			]);
		}
	});

	it("refuses a package whose entry point is an ignored module in the checkout, without reading it", async () => {
		const repo = fixture({
			files: { "packages/a/package.json": '{ "name": "a", "exports": { ".": "./gen/x.js" } }\n' },
			ignored: { "packages/a/gen/x.js": "export {};\n" },
		});
		const run = await gate(repo, { forbidden: (rel) => rel === "packages/a/gen/x.js" });
		refusedWith(run, [LINE["refs-config"] ?? ""]);
		expect(run.opens.includes("packages/a/gen/x.js")).toBe(false);
		const named = shown(await gate(repo, { names: true }))[0] ?? "";
		expect(named.endsWith(": packages/a/gen/x.js (unlisted)")).toBe(true);
	});

	it("refuses a path from a drive's own working folder and one with a name Windows trims, naming only the file that holds it", async () => {
		const cases: readonly (readonly [string, Readonly<Record<string, string>>, string, string])[] =
			[
				[
					"a Cargo path from a drive's own working folder",
					{
						"crates/r/Cargo.toml":
							'[package]\nname = "r"\nversion = "0.0.0"\n\n[dependencies]\nc = { path = "C:c" }\n',
					},
					"refs-cargo",
					"outside",
				],
				[
					"a module path with a name Windows trims",
					{ "packages/a/src/trim.ts": 'import "./gen./x.ts";\n' },
					"refs-modules",
					"unsupported",
				],
			];
		for (const [label, files, check, kind] of cases) {
			const repo = fixture({ files });
			refusedWith(await gate(repo), [LINE[check] ?? ""]);
			const named = shown(await gate(repo, { names: true }))[0] ?? "";
			const file = Object.keys(files)[0] ?? "";
			expect([label, named.endsWith(`: ${file} (${kind})`)]).toEqual([label, true]);
		}
	});

	it("refuses a tsconfig include from a drive's own working folder, naming only the tsconfig", async () => {
		const files = {
			"packages/a/tsconfig.json": '{ "include": ["**/*.ts", "C:x/**/*.ts"] }\n',
		};
		const repo = fixture({ files });
		refusedWith(await gate(repo), [LINE["scan-tsc"] ?? ""]);
		const named = shown(await gate(repo, { names: true }))[0] ?? "";
		expect(named.endsWith(": packages/a/tsconfig.json (outside)")).toBe(true);
	});

	it("refuses an ignored Rust module a bare mod declaration reaches, without reading it", async () => {
		const repo = fixture({
			files: { "crates/r/src/lib.rs": "mod m;\nmod x;\n" },
			ignored: { "crates/r/src/x.rs": `pub const X: &str = "${w}";\n` },
		});
		const run = await gate(repo, { forbidden: (rel) => rel === "crates/r/src/x.rs" });
		refusedWith(run, [LINE["refs-rust"] ?? ""]);
		expect(run.opens.includes("crates/r/src/x.rs")).toBe(false);
	});

	it("refuses an index entry replaced by a junction, without reading through it", async () => {
		const repo = fixture();
		rmSync(at(repo, "packages/a/src/b.ts"));
		writeFileSync(path.join(repo.outside, "b.ts"), "export const b = 2;\n");
		repo.link("packages/a/src/b.ts", repo.outside, "junction");
		const run = await gate(repo);
		refusedWith(run, [
			LINE.kinds ?? "",
			LINE["refs-modules"] ?? "",
			LINE["scan-tsc"] ?? "",
			LINE["scan-vitest"] ?? "",
		]);
		expect(run.opens.includes("packages/a/src/b.ts")).toBe(false);
		expect(run.readdirs.includes("packages/a/src/b.ts")).toBe(false);
	});

	it("refuses an index entry replaced by a file symlink, without reading through it", async (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture();
		rmSync(at(repo, "packages/a/src/b.ts"));
		writeFileSync(path.join(repo.outside, "b.ts"), "export const b = 2;\n");
		repo.link("packages/a/src/b.ts", path.join(repo.outside, "b.ts"), "file");
		const run = await gate(repo);
		refusedWith(run, [
			LINE.kinds ?? "",
			LINE["refs-modules"] ?? "",
			LINE["scan-tsc"] ?? "",
			LINE["scan-vitest"] ?? "",
		]);
		expect(run.opens.includes("packages/a/src/b.ts")).toBe(false);
	});

	it("refuses every path below an ancestor junction, and lists nothing through it", async () => {
		const repo = fixture();
		rmSync(at(repo, "packages/a/src"), { recursive: true });
		for (const name of ["index.ts", "b.ts"]) {
			writeFileSync(path.join(repo.outside, name), BASE[`packages/a/src/${name}`] ?? "");
		}
		repo.link("packages/a/src", repo.outside, "junction");
		const run = await gate(repo);
		refusedWith(run, [
			LINE.kinds ?? "",
			LINE["refs-modules"] ?? "",
			LINE["scan-tsc"] ?? "",
			LINE["scan-vitest"] ?? "",
		]);
		expect(run.readdirs.some((rel) => rel.startsWith("packages/a/src"))).toBe(false);
		expect(run.opens.some((rel) => rel.startsWith("packages/a/src"))).toBe(false);
	});

	it("refuses an ancestor folder symlink too", async (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture();
		rmSync(at(repo, "crates/r/src"), { recursive: true });
		writeFileSync(path.join(repo.outside, "lib.rs"), "mod m;\n");
		writeFileSync(path.join(repo.outside, "m.rs"), "pub fn m() {}\n");
		repo.link("crates/r/src", repo.outside, "dir");
		const run = await gate(repo);
		refusedWith(run, [LINE.kinds ?? "", LINE["scan-cargo"] ?? ""]);
		expect(run.opens.some((rel) => rel.startsWith("crates/r/src"))).toBe(false);
	});

	it("refuses a listed file it can't open", async () => {
		const run = await gate(fixture(), { forbidden: (rel) => rel === "packages/a/src/b.ts" });
		expect(run.result.ok).toBe(false);
		expect(uncounted(shown(run))).toEqual([LINE.G10a]);
		expect(run.refused).toEqual(["packages/a/src/b.ts"]);
	});

	it("refuses a listed file whose kind can't be checked, and never opens it", async () => {
		const repo = fixture();
		const failing: FsOps = {
			...nodeFs,
			lstat: (file) => {
				if (file.endsWith(`${path.sep}notes.md`)) {
					throw Object.assign(new Error("injected"), { code: "EACCES" });
				}
				return nodeFs.lstat(file);
			},
		};
		const run = await gate(repo, { fs: failing });
		refusedWith(run, [LINE.kinds ?? ""]);
		expect(run.opens.includes("docs/notes.md")).toBe(false);
	});

	it("refuses a tracked path that is now a folder", async () => {
		const repo = fixture();
		rmSync(at(repo, "docs/notes.md"));
		repo.write("docs/notes.md/inner.txt", "x\n");
		refusedWith(await gate(repo), [LINE.kinds ?? ""]);
	});

	it("refuses an .npmrc of any kind in the root, a package folder or the allowed root, never reading it", async () => {
		const npmrc = (rel: string): boolean => rel.endsWith(".npmrc") || rel.includes(".npmrc/");
		for (const tree of [
			{ files: { ".npmrc": "node-options=--require ./x.cjs\n" } },
			{ untracked: { "packages/a/.npmrc": "x\n" } },
			{ ignored: { [`${root}.npmrc`]: "x\n" } },
			{ ignored: { ".npmrc/x": "x\n" } },
		] as const) {
			const run = await gate(fixture(tree), { forbidden: npmrc });
			refusedWith(run, [LINE.npmrc ?? ""]);
			expect(run.opens.some(npmrc)).toBe(false);
		}
		const repo = fixture({ files: { ".npmrc": "x\n" }, ignored: { "packages/a/.npmrc": "x\n" } });
		const named = await gate(repo, { names: true });
		expect(shown(named)).toEqual([
			`reserved tripwire: 2 ${(LINE.npmrc ?? "").replace("reserved tripwire: ", "")}: .npmrc (file), packages/a/.npmrc (file)`,
			STOP_LINE,
		]);
	});

	it("refuses an entry in the root or a package folder named for a command started there with an extension cmd.exe runs, tracked or not and in any case, never reading it", async () => {
		const scripts =
			'{ "name": "a", "scripts": { "test": "FORCE_COLOR=0 vitest run && tsc -b" } }\n';
		const shadow = (rel: string): boolean => /\.(?:cmd|exe)$/i.test(rel);
		const cases: readonly (readonly [string, Fixture, string])[] = [
			[
				"a tracked vitest.cmd",
				{ files: { "packages/a/package.json": scripts, "packages/a/vitest.cmd": "@echo off\n" } },
				"packages/a/vitest.cmd (file)",
			],
			[
				"an untracked vitest.cmd",
				{
					files: { "packages/a/package.json": scripts },
					untracked: { "packages/a/vitest.cmd": "@echo off\n" },
				},
				"packages/a/vitest.cmd (file)",
			],
			[
				"an ignored tsc.exe",
				{ files: { "packages/a/package.json": scripts }, ignored: { "packages/a/tsc.exe": "" } },
				"packages/a/tsc.exe (file)",
			],
			["node.js at the root", { files: { "node.js": "" } }, "node.js (file)"],
			[
				"NPX.CMD in mixed case",
				{ files: { "packages/a/NpX.CmD": "" } },
				"packages/a/NpX.CmD (file)",
			],
			["a git.bat folder", { files: { "git.bat/x.txt": "" } }, "git.bat (dir)"],
		];
		for (const [label, tree, named] of cases) {
			const repo = fixture(tree);
			const run = await gate(repo, { forbidden: shadow });
			expect([label, uncounted(shown(run))]).toEqual([label, [LINE["command-shadows"]]]);
			refusedWith(run, [LINE["command-shadows"] ?? ""]);
			expect([label, run.opens.filter(shadow)]).toEqual([label, []]);
			const line = shown(await gate(repo, { names: true, forbidden: shadow }))[0] ?? "";
			expect([label, line.endsWith(`: ${named}`)]).toEqual([label, true]);
		}
	});

	it("passes vitest.config.js beside a script that starts vitest, and a command's name below a package folder or without an extension cmd.exe runs", async () => {
		const files = {
			"packages/a/package.json": '{ "name": "a", "scripts": { "test": "vitest run" } }\n',
			"packages/a/vitest.config.js": "export default {};\n",
			"packages/a/vitest.ps1": "",
			"packages/a/vitest": "",
			"packages/a/src/node.cmd": "",
			"docs/pnpm.cmd": "",
		};
		passed(await gate(fixture({ files })));
	});

	it("stops on a listing problem with the listing's line and the stop line only", async () => {
		const repo = fixture();
		const spy = readerSpy(repo.dir);
		const result = await runGate({
			root: repo.dir,
			env: gitEnvOf(repo),
			fs: spy.fs,
			git: async () => ({ code: 128, stdout: "" }),
		});
		expect(result).toEqual({
			ok: false,
			lines: ["reserved tripwire: git exited 128; nothing was checked", STOP_LINE],
			listing: null,
			tracked: [],
		});
		expect([...spy.opens, ...spy.readdirs]).toEqual([]);
	});
});

describe("scriptCommands", () => {
	it("gives each command's first word, split at &&, ||, ;, | and & and past NAME=value assignments, and leaves paths out", () => {
		const scripts = {
			a: "vitest run && tsc -b || echo x; biome ci . | tee out & turbo run",
			b: 'FORCE_COLOR=0 CI=1 "tsx" ./x.ts',
			c: "(cd sub && cargo test)",
			d: "./node_modules/.bin/thing x && ..\\bin\\other y",
			e: "Node --version\npnpm -r test",
		};
		const text = JSON.stringify({ name: "x", scripts, other: { f: "never this" } });
		expect(scriptCommands(text).toSorted()).toEqual(
			[
				"biome",
				"cargo",
				"cd",
				"echo",
				"node",
				"pnpm",
				"tee",
				"tsc",
				"tsx",
				"turbo",
				"vitest",
			].toSorted(),
		);
		expect(scriptCommands("{ nope")).toEqual([]);
	});
});

// The workspace file pnpm takes settings from for everything it starts. Each kind of setting outside
// the approved form, as an edit of it.
const edited = (edit: (text: string) => string): string => {
	const text = edit(ownWorkspace);
	if (text === ownWorkspace) throw new Error("the edit left the approved workspace file as it was");
	return text;
};
const UNAPPROVED: readonly (readonly [string, string])[] = [
	[
		"a setting that preloads code into every Node process pnpm starts",
		edited((text) => `${text}nodeOptions: --require ./preload.cjs\n`),
	],
	[
		"a setting that picks the shell pnpm runs scripts with",
		edited((text) => `${text}scriptShell: ./shell.cmd\n`),
	],
	[
		"a setting that runs scripts pnpm would otherwise skip",
		edited((text) => `${text}enablePrePostScripts: true\n`),
	],
	[
		"a setting that names a pnpmfile for pnpm to load",
		edited((text) => `${text}pnpmfile: ./hooks.cjs\n`),
	],
	[
		"an approved setting with another value",
		edited((text) => text.replace("verifyDepsBeforeRun: error", "verifyDepsBeforeRun: install")),
	],
	[
		"dependency builds allowed",
		edited((text) => text.replace("allowBuilds: {}", "allowBuilds: { esbuild: true }")),
	],
	[
		"another package folder glob",
		edited((text) => text.replace("  - tools/*\n", "  - tools/*\n  - vendor/*\n")),
	],
	["an approved setting left out", edited((text) => text.replace("minimumReleaseAge: 1440\n", ""))],
	[
		"an approved setting spelled another way",
		edited((text) => text.replace("engineStrict: true", '"engineStrict": true')),
	],
];

// The pre-install check's lines for the workspace file's rule alone, on the gate's own listing.
function installLines(repo: TempRepo, listing: GateResult["listing"]): readonly string[] {
	if (listing === null) throw new Error("the gate's listing failed");
	const checkout = new Checkout(repo.dir, undefined, { allowedRoots: [root] });
	return checkInstallInputs(
		{ checkout, listing, rules: ["workspace-file"] },
		{ packageDirs, approvedWorkspace },
	).lines;
}

const INSTALL_WORKSPACE =
	"pre-install check: the workspace file isn't a listed regular file in the approved form";

describe("the workspace file", () => {
	it("passes in the approved form, at the gate and in the pre-install check", async () => {
		const repo = fixture({ held: false });
		const run = await gate(repo);
		passed(run);
		expect(installLines(repo, run.result.listing)).toEqual([
			expect.stringMatching(/^pre-install check: \d+ manifest\(s\) and the workspace file checked/),
		]);
	});

	it.each(UNAPPROVED)("refuses %s, as the pre-install check does", async (_label, text) => {
		const repo = fixture({ held: false, files: { "pnpm-workspace.yaml": text } });
		const run = await gate(repo);
		refusedWith(run, [LINE["workspace-file"] ?? ""]);
		expect(installLines(repo, run.result.listing)).toEqual([INSTALL_WORKSPACE, INSTALL_STOP_LINE]);
		const named = await gate(repo, { names: true });
		expect(shown(named)[0]).toBe(`${shown(run)[0]}: pnpm-workspace.yaml (unapproved)`);
	});

	it("refuses a workspace file that is missing, unlisted or not a regular file, and opens none of them", async () => {
		const workspace = (rel: string): boolean =>
			rel === "pnpm-workspace.yaml" || rel.startsWith("pnpm-workspace.yaml/");
		const CASES: readonly (readonly [string, (repo: TempRepo) => void])[] = [
			["missing", (repo) => rmSync(at(repo, "pnpm-workspace.yaml"))],
			[
				"unlisted",
				(repo) => {
					repo.git("rm", "-q", "--cached", "--", "pnpm-workspace.yaml");
					repo.ignore("/pnpm-workspace.yaml");
				},
			],
			[
				"dir",
				(repo) => {
					rmSync(at(repo, "pnpm-workspace.yaml"));
					repo.ignore("/pnpm-workspace.yaml/");
					repo.write("pnpm-workspace.yaml/x", "x\n");
				},
			],
			[
				"hardlink",
				(repo) => {
					rmSync(at(repo, "pnpm-workspace.yaml"));
					repo.hardlink("pnpm-workspace.yaml", "docs/notes.md");
				},
			],
		];
		for (const [kind, build] of CASES) {
			const repo = fixture({ held: false });
			build(repo);
			const run = await gate(repo, { forbidden: workspace });
			expect([kind, run.result.ok]).toEqual([kind, false]);
			expect([kind, uncounted(shown(run))]).toEqual([
				kind,
				expect.arrayContaining([LINE["workspace-file"]]),
			]);
			expect(shown(run).filter((line) => line === STOP_LINE).length).toBe(1);
			expect(neutral(run.result.lines)).toBe(true);
			expect([kind, run.opens.some(workspace), onlyListing(run)]).toEqual([kind, false, true]);
			expect(installLines(repo, run.result.listing)).toEqual([
				INSTALL_WORKSPACE,
				INSTALL_STOP_LINE,
			]);
			const named = await gate(repo, { names: true, forbidden: workspace });
			expect(shown(named)).toContain(
				`reserved tripwire: 1 ${(LINE["workspace-file"] ?? "").replace("reserved tripwire: ", "")}: pnpm-workspace.yaml (${kind})`,
			);
		}
	});
});

// Each check's own fixture, which only that check refuses.
type Build = Fixture | ((repo: TempRepo) => void);
const ONLY: readonly (readonly [GateCheck, string, Build])[] = [
	[
		"kinds",
		"a hard-linked document outside every scanned folder",
		(repo) => {
			rmSync(at(repo, "docs/notes.md"));
			repo.hardlink("docs/notes.md", "spikes/s1/README.md");
		},
	],
	[
		"tree-rules",
		"a reserved-named document outside the allowed set",
		{ files: { [`docs/x-${w}.md`]: "x\n" } },
	],
	[
		"refs-rust",
		"an ignored Rust module a bare mod declaration reaches",
		{ files: { "crates/r/src/lib.rs": "mod m;\nmod x;\n" }, ignored: { "crates/r/src/x.rs": "" } },
	],
	[
		"refs-cargo",
		"a path dependency on an ignored crate",
		{
			files: {
				"crates/r/Cargo.toml": '[package]\nname = "r"\n\n[dependencies]\nd = { path = "../d" }\n',
			},
			ignored: { "crates/d/Cargo.toml": '[package]\nname = "d"\n' },
		},
	],
	[
		"refs-modules",
		"a .js import of an ignored .ts module outside every tsc project",
		{
			files: { "scripts/run.ts": 'import "./lib/helper.js";\n' },
			ignored: { "scripts/lib/helper.ts": "export {};\n" },
		},
	],
	[
		"refs-config",
		"a file: dependency on an ignored folder",
		{
			files: {
				"packages/a/package.json":
					'{ "name": "a", "devDependencies": { "x": "file:../../vendor/x" } }\n',
			},
			ignored: { "vendor/x/package.json": '{ "name": "x" }\n' },
		},
	],
	[
		"scan-pnpm",
		"an ignored package folder",
		{ ignored: { "packages/ghost/package.json": "{}\n" } },
	],
	[
		"scan-tsc",
		"an ignored module under a tsc project's include",
		{ ignored: { "packages/a/src/stray.ts": "" } },
	],
	[
		"scan-vitest",
		"an ignored test file in a dot folder, which tsc never enters",
		{ ignored: { "packages/a/.hidden/x.test.ts": "" } },
	],
	["scan-cargo", "an ignored integration test", { ignored: { "crates/r/tests/x.rs": "" } }],
	["scan-verify", "an ignored step", { ignored: { "tools/verify/steps/x.ts": "" } }],
	["scan-prefetch", "an ignored prefetch script", { ignored: { "spikes/s1/prefetch.ts": "" } }],
	["npmrc", "an ignored .npmrc in a package folder", { ignored: { "packages/a/.npmrc": "x\n" } }],
	[
		"command-shadows",
		"a tracked pnpm.cmd in a package folder",
		{ files: { "packages/a/pnpm.cmd": "@echo off\n" } },
	],
	[
		"workspace-file",
		"a workspace file with a setting the approved form leaves out",
		{ files: { "pnpm-workspace.yaml": `${ownWorkspace}nodeOptions: --require ./preload.cjs\n` } },
	],
];

function built(build: Build): TempRepo {
	if (typeof build !== "function") return fixture(build);
	const repo = fixture();
	build(repo);
	return repo;
}

describe("mutations: each check removed lets its own fixture through", () => {
	it("runs every check, in order", () => {
		expect(GATE_CHECKS).toEqual([
			"kinds",
			"tree-rules",
			"refs-rust",
			"refs-cargo",
			"refs-modules",
			"refs-config",
			"scan-pnpm",
			"scan-tsc",
			"scan-vitest",
			"scan-cargo",
			"scan-verify",
			"scan-prefetch",
			"npmrc",
			"command-shadows",
			"workspace-file",
		]);
		expect(ONLY.map(([check]) => check)).toEqual(GATE_CHECKS);
		expect(GATE_ROOT_ENV).toBe("DRAFTYAK_GATE_ROOT");
	});

	it.each(ONLY)("%s: %s", async (check, _label, build) => {
		const repo = built(build);
		const full = await gate(repo);
		refusedWith(full, [(check === "tree-rules" ? LINE.G1 : LINE[check]) ?? ""]);
		passed(await gate(repo, { checks: GATE_CHECKS.filter((item) => item !== check) }));
	});
});

describe("the gate's own lines", () => {
	it("prints counts, then names each refused path and its kind only when asked", async () => {
		const repo = fixture({ ignored: { "packages/a/src/stray.ts": "", "crates/r/tests/x.rs": "" } });
		const run = await gate(repo);
		expect(shown(run)).toEqual([
			"reserved tripwire: 1 file(s) or folder(s) tsc would pick up from a project's include folders aren't regular, listed files in real folders, or a project's include leaves this checkout; none of them was read",
			"reserved tripwire: 1 file(s) or folder(s) Cargo or rustup would pick up from a crate's folders aren't regular, listed files in real folders, or a workspace's glob member leaves this checkout; none of them was read",
			STOP_LINE,
		]);
		const named = await gate(repo, { names: true });
		expect(shown(named)).toEqual([
			`${shown(run)[0]}: packages/a/src/stray.ts (unlisted)`,
			`${shown(run)[1]}: crates/r/tests/x.rs (unlisted)`,
			STOP_LINE,
		]);
	});
});

describe("the repository's own tree", () => {
	it("passes the gate, with no reserved or allowed-root file opened", async () => {
		const spy = readerSpy(ownRepo, (rel) => reservedWord.test(rel));
		const result = await runGate({ root: ownRepo, fs: spy.fs });
		// Counts only: no path or reserved word reaches a failure message.
		expect(result.lines.map((line) => line.replace(/\d+/g, "<n>"))).toEqual([
			"reserved check: <n> path(s), <n> untracked file(s), <n> folder(s), <n> Cargo file(s), <n> Rust source(s) and <n> module(s) and config(s) checked, with their folders, references and scanned folders; no problem found in them",
		]);
		expect([result.ok, spy.refused.length]).toEqual([true, 0]);
	});
});

// --- the command, in a temp checkout without node_modules ---

const ENTRY = ["tools/verify/gate.ts", "tools/verify/lib/bootstrap.ts", ...HELPERS.gate];

async function command(repo: TempRepo, args: readonly string[] = [], cwd = repo.dir) {
	const result = await capture(
		{ command: process.execPath, args: [at(repo, "tools/verify/gate.ts"), ...args] },
		{ cwd, env: gitEnvOf(repo) },
	);
	const lines = result.stdout.split(/\r?\n/).filter(Boolean).map(scrub);
	return { code: result.code, lines, stderr: result.stderr };
}

const START_LINES = [
	"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
	STOP_LINE,
];
// The inline start check's lines for an entry Node started with a preload or an option file.
const PRELOADED = [
	"reserved tripwire: Node loaded code or options before this entry's first line (--require, --import, --loader, a startup snapshot or a config file, on its command line or in NODE_OPTIONS); nothing was checked",
	STOP_LINE,
];

describe("the gate's helpers", () => {
	it("holds the gate's whole runtime import graph, which imports only node: built-ins beyond it", () => {
		const seen = new Set<string>();
		const bare = new Set<string>();
		const visit = (rel: string): void => {
			if (seen.has(rel)) return;
			seen.add(rel);
			const text = readFileSync(path.join(ownRepo, rel), "utf8");
			for (const { value } of runtimeSpecifiers(text)) {
				if (value.startsWith("."))
					visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), value)));
				else bare.add(value);
			}
		};
		visit("tools/verify/lib/gate.ts");
		seen.delete("tools/verify/lib/bootstrap.ts");
		expect([...seen].toSorted()).toEqual([...HELPERS.gate].toSorted());
		expect([...bare].every((name) => name.startsWith("node:"))).toBe(true);
		const entry = readFileSync(path.join(ownRepo, "tools", "verify", "gate.ts"), "utf8");
		const statics = runtimeSpecifiers(entry).filter(
			({ kind }) => kind === "static" || kind === "bare",
		);
		expect(statics.map(({ value }) => value)).toEqual(["node:path"]);
	});
});

describe("the inline start check, START_CHECK", () => {
	const copy = (file: string): string | null => {
		const text = readFileSync(path.join(ownRepo, file), "utf8").replaceAll("\r\n", "\n");
		const match = /\n\/\/ start check\n([\s\S]*?)\n\/\/ end start check\n/.exec(text);
		return match?.[1] ?? null;
	};

	it("is copied byte for byte into this entry, non-empty, with startLines' lines spelled out", () => {
		expect(START_CHECK.length).toBeGreaterThan(0);
		expect(copy("tools/verify/gate.ts")).toBe(START_CHECK);
		expect(START_CHECK).toContain(JSON.stringify(STOP_LINE));
		expect(START_CHECK).toContain(JSON.stringify(startLines([{ rel: "x", kind: "link" }])[0]));
		expect(START_CHECK.startsWith("function startCheckLines(\n\troot: string,\n\tnode: {")).toBe(
			true,
		);
	});

	// The in-process cases pass no Node options of their own.
	const plain = { execArgv: [], options: undefined };

	it("passes this checkout and a fixture, and refuses bootstrap.ts's folder as a junction", () => {
		expect(startCheckLines(ownRepo, plain)).toEqual([]);
		const repo = fixture({ entry: true });
		expect(startCheckLines(repo.dir, plain)).toEqual([]);
		rmSync(at(repo, "tools/verify/lib"), { recursive: true });
		repo.link("tools/verify/lib", repo.outside, "junction");
		expect(startCheckLines(repo.dir, plain)).toEqual(START_LINES);
		expect(startCheckLines(path.join(repo.outside, "none"), plain)).toEqual(START_LINES);
	});

	it("refuses a hard-linked bootstrap.ts", () => {
		const repo = fixture({ entry: true });
		repo.hardlink("tools/verify/lib/copy.ts", "tools/verify/lib/bootstrap.ts");
		expect(startCheckLines(repo.dir, plain)).toEqual(START_LINES);
	});

	// Each option Node applies before an entry's first line that loads code or more options, as the
	// entry's own execArgv holds it or as NODE_OPTIONS spells it, split the way Node splits it.
	const backslash = String.fromCharCode(92);
	const LOADING: readonly (readonly [readonly string[], string | undefined])[] = [
		[["--require", "./x.cjs"], undefined],
		[["-r", "./x.cjs"], undefined],
		[["--require=./x.cjs"], undefined],
		[["--import", "./x.mjs"], undefined],
		[["--import=data:text/javascript,0"], undefined],
		[["--loader", "./l.mjs"], undefined],
		[["--experimental-loader=./l.mjs"], undefined],
		[["--experimental_loader", "./l.mjs"], undefined],
		[["--snapshot-blob", "s.blob"], undefined],
		[["--config-file=node.config.json"], undefined],
		[["--experimental-config-file=node.config.json"], undefined],
		[["--experimental-default-config-file"], undefined],
		[[], "--require ./x.cjs"],
		[[], "--max-old-space-size=4096 --import=./x.mjs"],
		[[], '"--require" ./x.cjs'],
		[[], '--title="a b" -r ./x.cjs'],
		[[], `"--re${backslash}quire" ./x.cjs`],
		[[], "--experimental-default-config-file"],
	];
	const OTHER: readonly (readonly [readonly string[], string | undefined])[] = [
		[["--max-old-space-size=4096", "--conditions", "development", "--no-warnings"], undefined],
		[[], '--max-old-space-size=4096 --title="--require x"'],
		[[], "--enable-source-maps"],
		[[], ""],
	];

	it("refuses an entry Node started with code or options it loads first, before any kind check", () => {
		const repo = fixture({ entry: true });
		for (const [execArgv, options] of LOADING) {
			const node = { execArgv, options };
			expect([node, startCheckLines(repo.dir, node)]).toEqual([node, PRELOADED]);
			// The same line where the kind check would fail too: the options come first.
			expect(startCheckLines(path.join(repo.outside, "none"), node)).toEqual(PRELOADED);
		}
		for (const [execArgv, options] of OTHER) {
			const node = { execArgv, options };
			expect([node, startCheckLines(repo.dir, node)]).toEqual([node, []]);
		}
		expect(neutral(PRELOADED)).toBe(true);
	});
});

describe("node tools/verify/gate.ts", () => {
	it("passes a clean checkout with one check line, without node_modules", async () => {
		const repo = fixture({ entry: true });
		expect(existsSync(at(repo, "node_modules"))).toBe(false);
		const run = await command(repo);
		expect([run.code, run.lines.length, run.stderr]).toEqual([0, 1, ""]);
		expect(run.lines[0]).toMatch(/^reserved check: /);
	});

	it("refuses a finding with count lines and the stop line once, and names paths with --names", async () => {
		const repo = fixture({ entry: true, ignored: { "packages/a/src/stray.ts": "" } });
		const plain = await command(repo);
		expect([plain.code, uncounted(plain.lines)]).toEqual([1, [LINE["scan-tsc"]]]);
		expect(plain.lines.at(-1)).toBe(STOP_LINE);
		expect(neutral(plain.lines)).toBe(true);
		const named = await command(repo, ["--names"]);
		expect(named.code).toBe(1);
		expect(named.lines[0]).toBe(`${plain.lines[0]}: packages/a/src/stray.ts (unlisted)`);
	});

	it("never runs a helper folder replaced by a junction: the inline start check stops it", async () => {
		const repo = fixture({ entry: true });
		const marker = path.join(repo.outside, "loaded");
		const lib = path.join(repo.outside, "lib");
		mkdirSync(lib);
		for (const rel of ENTRY.filter((file) => file.startsWith("tools/verify/lib/"))) {
			writeFileSync(
				path.join(lib, path.posix.basename(rel)),
				readFileSync(path.join(ownRepo, rel)),
			);
		}
		const loads = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`;
		writeFileSync(path.join(lib, "bootstrap.ts"), loads);
		writeFileSync(path.join(lib, "gate.ts"), loads);
		rmSync(at(repo, "tools/verify/lib"), { recursive: true });
		repo.link("tools/verify/lib", lib, "junction");
		const run = await command(repo);
		expect([run.code, run.lines]).toEqual([1, START_LINES]);
		expect(existsSync(marker)).toBe(false);
	});

	it("never runs a helper file replaced by a symlink: checkStart stops it", async (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture({ entry: true });
		const marker = path.join(repo.outside, "loaded");
		const planted = path.join(repo.outside, "gate.ts");
		writeFileSync(
			planted,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
		);
		rmSync(at(repo, "tools/verify/lib/gate.ts"));
		repo.link("tools/verify/lib/gate.ts", planted, "file");
		const run = await command(repo);
		expect([run.code, run.lines]).toEqual([1, START_LINES]);
		expect(existsSync(marker)).toBe(false);
		const named = await command(repo, ["--names"]);
		expect(named.lines[0]).toBe(`${START_LINES[0]}: tools/verify/lib/gate.ts (link)`);
	});

	it("refuses an unlisted helper", async () => {
		const repo = fixture({ entry: true });
		repo.git("rm", "-q", "--cached", "--", "tools/verify/lib/discovery.ts");
		repo.ignore("tools/verify/lib/discovery.ts");
		const run = await command(repo, ["--names"]);
		expect([run.code, run.lines]).toEqual([
			1,
			[`${START_LINES[0]}: tools/verify/lib/discovery.ts (unlisted)`, STOP_LINE],
		]);
	});

	it("checks a second checkout with --root and its own helpers, and refuses a --root that isn't a toplevel", async () => {
		const repo = fixture({ entry: true });
		const other = fixture({ held: false });
		const clean = await command(repo, ["--root", other.dir]);
		expect([clean.code, clean.lines.length]).toEqual([0, 1]);
		expect(clean.lines[0]).toMatch(/^reserved check: /);
		other.ignore("packages/a/src/stray.ts");
		other.write("packages/a/src/stray.ts", "");
		const planted = await command(repo, ["--root", other.dir]);
		expect([planted.code, uncounted(planted.lines)]).toEqual([1, [LINE["scan-tsc"]]]);
		const below = await command(repo, ["--root", "packages"], other.dir);
		expect(below).toEqual({
			code: 1,
			lines: [
				"reserved tripwire: git listed another checkout than this one; nothing was checked",
				STOP_LINE,
			],
			stderr: "",
		});
		const none = await command(repo, ["--root", other.outside]);
		expect(none.code).toBe(1);
		expect(none.lines.at(-1)).toBe(STOP_LINE);
		expect(none.lines[0]).toMatch(
			/^reserved tripwire: (?:git exited \d+|git listed another checkout than this one); nothing was checked$/,
		);
	});

	it.each([
		[["--bogus"]],
		[["--root"]],
		[["--root", ""]],
		[["--names", "--names"]],
		[["--help", "--names"]],
	])("exits 2 with the usage line for %j", async (args) => {
		const repo = fixture({ entry: true });
		expect(await command(repo, args)).toEqual({ code: 2, lines: [USAGE], stderr: "" });
	});

	it("prints the usage line for --help and exits 0, loading no gate", async () => {
		const lines: string[] = [];
		const code = await gateCli(["--help"], {
			root: ownRepo,
			print: (line) => lines.push(line),
			gate: () => Promise.reject(new Error("not run")),
		});
		expect([code, lines]).toEqual([0, [USAGE]]);
	});
});

describe("gateCli in process", () => {
	it("passes --names and --root to the gate and exits by its result", async () => {
		const calls: GateOptions[] = [];
		const lines: string[] = [];
		const answer: GateResult = { ok: false, lines: ["x", STOP_LINE], listing: null, tracked: [] };
		const code = await gateCli(["--names", "--root", "elsewhere"], {
			root: ownRepo,
			print: (line) => lines.push(line),
			gate: async (options) => {
				calls.push(options);
				return answer;
			},
		});
		expect([code, lines]).toEqual([1, ["x", STOP_LINE]]);
		expect(calls).toEqual([{ root: path.resolve("elsewhere"), names: true }]);
	});

	it("mutation: with names forced on, the counts-only assertion sees a path", async () => {
		const repo = fixture({ ignored: { "packages/a/src/stray.ts": "" } });
		const lines: string[] = [];
		const forced = (options: GateOptions) =>
			runGate({
				...options,
				names: true,
				env: gitEnvOf(repo),
				allowedRoots: [root],
				allowedDocs: [doc],
			});
		const code = await gateCli([], {
			root: repo.dir,
			print: (line) => lines.push(line),
			gate: forced,
		});
		expect(code).toBe(1);
		expect(neutral(lines)).toBe(false);
		expect(neutral(lines.map((line) => line.replace(/: .*$/, "")))).toBe(true);
	});
});
