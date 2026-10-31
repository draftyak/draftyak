import { afterEach, describe, expect, it } from "vitest";
import { reservedWord } from "../../../reserved-tests.ts";
import { type ScanCheck, scan, Walks } from "../lib/discovery.ts";
import { listCheckout, listedSet, packageDirs } from "../lib/listing.ts";
import { Checkout, fold } from "../lib/safe-fs.ts";
import { gitEnvOf, readerSpy, scrub, type TempRepo, tempRepo, word } from "./temp-repo.ts";

// The folders tools scan, on synthetic repositories: names and kinds only. The reader spy refuses
// every open of an ignored file, and no scan may try one. Compared paths are scrubbed.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

const w = word();
const root = `spikes/zz-${w}/`;

interface Tree {
	readonly files?: Readonly<Record<string, string>>;
	readonly ignored?: Readonly<Record<string, string>>;
	// After the files: links at paths below the repository, to folders below it.
	readonly junctions?: Readonly<Record<string, string>>;
}

const WORKSPACE = { "pnpm-workspace.yaml": "packages:\n  - pkgs/*\n  - spikes/*\n" };

function fixture(tree: Tree): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	for (const [file, text] of Object.entries({ ...WORKSPACE, ...tree.files }))
		repo.write(file, text);
	repo.commit();
	const ignored = Object.keys(tree.ignored ?? {});
	if (ignored.length > 0) repo.ignore(...ignored);
	for (const [file, text] of Object.entries(tree.ignored ?? {})) repo.write(file, text);
	for (const [file, target] of Object.entries(tree.junctions ?? {}))
		repo.link(file, target, "junction");
	return repo;
}

// What one scan refuses, as "path: kind", and the folders it listed.
async function scanned(
	tree: Tree,
	check: ScanCheck,
): Promise<{ refused: string[]; readdirs: string[] }> {
	const repo = fixture(tree);
	const { listing } = await listCheckout(repo.dir, { env: gitEnvOf(repo) });
	if (listing === null) throw new Error("no listing");
	const ignored = new Set(Object.keys(tree.ignored ?? {}));
	const spy = readerSpy(repo.dir, (rel) => ignored.has(rel) || reservedWord.test(rel));
	const checkout = new Checkout(repo.dir, spy.fs, { allowedRoots: [root] });
	const listed = listedSet(listing);
	const isListed = (rel: string): boolean => listed.has(fold(rel));
	const files = [...listing.entries.map((entry) => entry.path), ...listing.untracked].filter(
		(rel) => !reservedWord.test(rel) && checkout.kindOf(rel) === "file",
	);
	const text = (rel: string): string | null => {
		const got = isListed(rel) ? checkout.readText(rel) : "unreadable";
		return got === "unreadable" ? null : got;
	};
	const input = {
		checkout,
		listed: isListed,
		files,
		text,
		allowedRoots: [root],
		packages: packageDirs(checkout, listing),
		walks: new Walks(checkout, [root]),
	};
	const result = scan(check, input);
	expect(spy.refused).toEqual([]);
	return {
		refused: result.refused.map(({ rel, kind }) => scrub(`${rel}: ${kind}`)),
		readdirs: spy.readdirs,
	};
}

const refused = async (tree: Tree, check: ScanCheck): Promise<string[]> =>
	(await scanned(tree, check)).refused;

describe("scan-cargo", () => {
	const crate = {
		"c/Cargo.toml": '[package]\nname = "c"\n',
		"c/src/lib.rs": "",
		"c/tests/ok.rs": "",
	};

	it("passes a crate whose targets are all listed, and never walks target/", async () => {
		const ignored = { "c/target/debug/build/x/out/gen.rs": "", "c/target/x.rs": "" };
		const { refused: found, readdirs } = await scanned({ files: crate, ignored }, "scan-cargo");
		expect(found).toEqual([]);
		expect(readdirs.some((rel) => rel.startsWith("c/target"))).toBe(false);
	});

	it("refuses ignored auto-targets: tests, binaries, examples and benches, *.rs and */main.rs", async () => {
		const ignored = {
			"c/tests/x.rs": "",
			"c/src/bin/x.rs": "",
			"c/src/bin/y/main.rs": "",
			"c/examples/x.rs": "",
			"c/benches/x.rs": "",
			"c/tests/deep/other.rs": "",
		};
		expect(await refused({ files: crate, ignored }, "scan-cargo")).toEqual([
			"c/src/bin/x.rs: unlisted",
			"c/src/bin/y/main.rs: unlisted",
			"c/tests/x.rs: unlisted",
			"c/benches/x.rs: unlisted",
			"c/examples/x.rs: unlisted",
		]);
	});

	it("refuses an ignored build.rs, unless [package] build is false or names a script", async () => {
		const ignored = { "c/build.rs": "", "f/build.rs": "", "p/build.rs": "" };
		const files = {
			...crate,
			"f/Cargo.toml": '[package]\nname = "f"\nbuild = false\n',
			"p/Cargo.toml": '[package]\nname = "p"\nbuild = "tools/build.rs"\n',
		};
		expect(await refused({ files, ignored }, "scan-cargo")).toEqual(["c/build.rs: unlisted"]);
	});

	it("refuses an ignored .cargo config, toolchain file or parent manifest, in the crate's folder or above it", async () => {
		const files = { "w/c/Cargo.toml": '[package]\nname = "c"\n', "w/c/src/lib.rs": "" };
		const ignored = {
			"w/c/.cargo/config.toml": "",
			"w/.cargo/config": "",
			"rust-toolchain.toml": "",
			"w/c/rust-toolchain": "",
			"w/Cargo.toml": "",
		};
		expect(await refused({ files, ignored }, "scan-cargo")).toEqual([
			"w/c/.cargo/config.toml: unlisted",
			"w/c/rust-toolchain: unlisted",
			"w/Cargo.toml: unlisted",
			"w/.cargo/config: unlisted",
			"rust-toolchain.toml: unlisted",
		]);
	});

	it("refuses a junction in a target folder, and a .cargo folder that is one", async () => {
		const repo = { files: { ...crate, "elsewhere/x.rs": "" } };
		const tree = { ...repo, junctions: { "c/tests/linked": "elsewhere", "c/.cargo": "elsewhere" } };
		const found = await refused(tree, "scan-cargo");
		expect(found).toEqual([
			"c/tests/linked: link",
			"c/.cargo/config: link",
			"c/.cargo/config.toml: link",
		]);
	});

	it("refuses an ignored crate a workspace's glob members match, outside its excludes", async () => {
		const files = {
			"Cargo.toml": '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/skip"]\n',
		};
		const ignored = { "crates/a/Cargo.toml": "", "crates/skip/Cargo.toml": "" };
		expect(await refused({ files, ignored }, "scan-cargo")).toEqual([
			"crates/a/Cargo.toml: unlisted",
		]);
	});
});

describe("scan-tsc", () => {
	const project = (tsconfig: object, more: Readonly<Record<string, string>> = {}) => ({
		"pkgs/a/package.json": "{}",
		"pkgs/a/tsconfig.json": JSON.stringify(tsconfig),
		"pkgs/a/src/index.ts": "",
		...more,
	});

	it("refuses an ignored module below an include folder, and a junction there", async () => {
		const files = project({ include: ["**/*.ts"] }, { "elsewhere/x.ts": "" });
		const tree = {
			files,
			ignored: { "pkgs/a/src/gen.ts": "" },
			junctions: { "pkgs/a/linked": "elsewhere" },
		};
		expect(await refused(tree, "scan-tsc")).toEqual([
			"pkgs/a/linked: link",
			"pkgs/a/src/gen.ts: unlisted",
		]);
	});

	it("leaves out what tsc leaves out: excludes, node_modules, dot folders, other extensions and the default outDir", async () => {
		const files = project({ include: ["src"], exclude: ["src/skipped"] });
		const ignored = {
			"pkgs/a/src/skipped/x.ts": "",
			"pkgs/a/src/node_modules/x.ts": "",
			"pkgs/a/src/.hidden/x.ts": "",
			"pkgs/a/src/x.js": "",
			"pkgs/a/other/x.ts": "",
		};
		expect(await refused({ files, ignored }, "scan-tsc")).toEqual([]);
		const out = project({ compilerOptions: { outDir: "dist" } });
		expect(
			await refused(
				{ files: out, ignored: { "pkgs/a/dist/x.d.ts": "", "pkgs/a/y.ts": "" } },
				"scan-tsc",
			),
		).toEqual(["pkgs/a/y.ts: unlisted"]);
	});

	it("counts .js and .mjs files with allowJs, and only top-level ones for a top-level pattern", async () => {
		const files = project({ include: ["*.mjs", "src/**/*"], compilerOptions: { allowJs: true } });
		const ignored = {
			"pkgs/a/top.mjs": "",
			"pkgs/a/deep/x.mjs": "",
			"pkgs/a/src/x.js": "",
			"pkgs/a/src/y.cjs": "",
		};
		expect(await refused({ files, ignored }, "scan-tsc")).toEqual([
			"pkgs/a/top.mjs: unlisted",
			"pkgs/a/src/x.js: unlisted",
			"pkgs/a/src/y.cjs: unlisted",
		]);
	});

	it("takes include and exclude through extends, at the config that sets them", async () => {
		const files = {
			"base/tsconfig.base.json": JSON.stringify({
				include: ["../pkgs/a/src/**/*.ts"],
				exclude: ["../pkgs/a/src/out"],
			}),
			...project({ extends: "../../base/tsconfig.base.json" }),
		};
		const ignored = { "pkgs/a/src/x.ts": "", "pkgs/a/src/out/y.ts": "" };
		expect(await refused({ files, ignored }, "scan-tsc")).toEqual(["pkgs/a/src/x.ts: unlisted"]);
	});

	it("never lists inside an allowed root, even below a project's include folder", async () => {
		const files = {
			"spikes/tsconfig.json": JSON.stringify({ include: ["**/*.ts"] }),
			"spikes/s1/a.ts": "",
			[`${root}package.json`]: "{}",
			[`${root}src/x.ts`]: "",
		};
		const tree = { files, ignored: { [`${root}src/y.ts`]: "", "spikes/s1/b.ts": "" } };
		const { refused: found, readdirs } = await scanned(tree, "scan-tsc");
		expect(found).toEqual(["spikes/s1/b.ts: unlisted"]);
		expect(readdirs.some((rel) => rel.startsWith(scrub(root)))).toBe(false);
	});

	it("walks every non-dot folder below a default include, and leaves a base config without include alone", async () => {
		const files = {
			"tsconfig.base.json": "{}",
			"pkgs/b/tsconfig.json": "{}",
			"pkgs/b/package.json": "{}",
		};
		const ignored = { "pkgs/b/deep/er/x.ts": "", "elsewhere/x.ts": "" };
		expect(await refused({ files, ignored }, "scan-tsc")).toEqual([
			"pkgs/b/deep/er/x.ts: unlisted",
		]);
	});
});

describe("scan-vitest", () => {
	const pkg = {
		"pkgs/a/package.json": "{}",
		"pkgs/a/vitest.config.ts": "",
		"pkgs/a/test/ok.test.ts": "",
	};

	it("refuses an ignored test file a tier glob matches, in dot folders too, and an ignored config", async () => {
		const ignored = {
			"pkgs/a/test/x.test.ts": "",
			"pkgs/a/.hidden/y.heavy.test.ts": "",
			"pkgs/a/vitest.config.mts": "",
			"pkgs/a/test/helper.ts": "",
		};
		expect(await refused({ files: pkg, ignored }, "scan-vitest")).toEqual([
			"pkgs/a/vitest.config.mts: unlisted",
			"pkgs/a/.hidden/y.heavy.test.ts: unlisted",
			"pkgs/a/test/x.test.ts: unlisted",
		]);
	});

	it("refuses a junction anywhere in a package folder, and never walks the allowed root", async () => {
		const files = { ...pkg, "elsewhere/z.test.ts": "", [`${root}package.json`]: "{}" };
		const tree = {
			files,
			junctions: { "pkgs/a/test/linked": "elsewhere" },
			ignored: { [`${root}x.test.ts`]: "" },
		};
		const { refused: found, readdirs } = await scanned(tree, "scan-vitest");
		expect(found).toEqual(["pkgs/a/test/linked: link"]);
		expect(readdirs.some((rel) => rel.startsWith(scrub(root)))).toBe(false);
	});
});

describe("scan-pnpm", () => {
	it("refuses an ignored package folder below a workspace glob, and a junction package folder", async () => {
		const files = { "pkgs/a/package.json": "{}", "elsewhere/package.json": "{}" };
		const tree = {
			files,
			ignored: { "spikes/s9/package.json": "{}" },
			junctions: { "pkgs/j": "elsewhere" },
		};
		expect(await refused(tree, "scan-pnpm")).toEqual([
			"pkgs/j: link",
			"spikes/s9/package.json: unlisted",
		]);
	});
});

describe("scan-verify", () => {
	it("refuses an ignored step or profile, and leaves its tests and declarations alone", async () => {
		const files = { "tools/verify/steps/ok.ts": "", "tools/verify/profiles/ok.ts": "" };
		const ignored = {
			"tools/verify/steps/x.ts": "",
			"tools/verify/profiles/x.ts": "",
			"tools/verify/steps/x.test.ts": "",
			"tools/verify/steps/x.d.ts": "",
		};
		expect(await refused({ files, ignored }, "scan-verify")).toEqual([
			"tools/verify/steps/x.ts: unlisted",
			"tools/verify/profiles/x.ts: unlisted",
		]);
	});
});

describe("scan-prefetch", () => {
	it("refuses an ignored prefetch.ts and a junction spike folder, and leaves the allowed root alone", async () => {
		const files = {
			"spikes/s1/prefetch.ts": "",
			"spikes/s2/README.md": "",
			"elsewhere/prefetch.ts": "",
		};
		const tree = {
			files: { ...files, [`${root}package.json`]: "{}" },
			ignored: { "spikes/s2/prefetch.ts": "", [`${root}prefetch.ts`]: "" },
			junctions: { "spikes/j": "elsewhere" },
		};
		expect(await refused(tree, "scan-prefetch")).toEqual([
			"spikes/j: link",
			"spikes/s2/prefetch.ts: unlisted",
		]);
	});
});
