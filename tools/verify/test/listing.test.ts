import { spawnSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceGlobs, workspaceGlobsOf } from "../../../reserved-tests.ts";
import {
	type GitRunner,
	LISTING_CHECKS,
	type ListingCheck,
	type ListingProblem,
	listCheckout,
	listingLines,
	packageDirs,
} from "../lib/listing.ts";
import { Checkout } from "../lib/safe-fs.ts";
import { gitEnvOf, nested, scrub, type TempRepo, tempRepo, unmerged, word } from "./temp-repo.ts";

// The checkout's one git listing, on synthetic repositories. Compared paths are scrubbed.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

function fixture(files: Readonly<Record<string, string>> = {}): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	const base = {
		"pnpm-workspace.yaml": "packages:\n  - pkgs/*\n  - solo\n",
		"package.json": '{ "name": "fixture" }\n',
		"pkgs/a/package.json": '{ "name": "a" }\n',
		"pkgs/a/src/index.ts": "export {};\n",
		"run.sh": "echo\n",
	};
	for (const [file, text] of Object.entries({ ...base, ...files })) repo.write(file, text);
	repo.commit();
	repo.git("update-index", "--chmod=+x", "run.sh");
	repo.commit("modes");
	return repo;
}

const list = (repo: TempRepo, options: Parameters<typeof listCheckout>[1] = {}) =>
	listCheckout(repo.dir, { env: gitEnvOf(repo), ...options });

const without = (check: ListingCheck): ListingCheck[] =>
	LISTING_CHECKS.filter((item) => item !== check);

describe("listCheckout", () => {
	it("lists the index with its modes and the untracked files git doesn't ignore, at the real root", async () => {
		const repo = fixture();
		repo.ignore("ignored.ts");
		repo.write("ignored.ts", "");
		repo.write("new.ts", "");
		const { listing, problems } = await list(repo);
		expect(problems).toEqual([]);
		expect(listing?.root).toBe(repo.dir);
		expect(listing?.entries).toEqual([
			{ mode: "100644", path: "package.json" },
			{ mode: "100644", path: "pkgs/a/package.json" },
			{ mode: "100644", path: "pkgs/a/src/index.ts" },
			{ mode: "100644", path: "pnpm-workspace.yaml" },
			{ mode: "100755", path: "run.sh" },
		]);
		expect(listing?.untracked).toEqual(["new.ts"]);
	});

	it("lists the same files whatever GIT_INDEX_FILE, GIT_WORK_TREE or GIT_DIR say", async () => {
		const repo = fixture();
		const other = fixture({ "elsewhere.ts": "" });
		const index = path.join(repo.outside, "index");
		spawnSync("git", ["read-tree", "--empty"], {
			cwd: repo.dir,
			env: { ...gitEnvOf(repo), GIT_INDEX_FILE: index },
		});
		const clean = await list(repo);
		for (const redirect of [
			{ GIT_INDEX_FILE: index },
			{ GIT_WORK_TREE: other.dir },
			{ GIT_DIR: path.join(other.dir, ".git") },
			{ git_dir: path.join(other.dir, ".git"), GIT_CEILING_DIRECTORIES: repo.outside },
		]) {
			expect(await list(repo, { env: { ...gitEnvOf(repo), ...redirect } })).toEqual(clean);
		}
	});

	it("mutation: with the child environment passed as is, GIT_INDEX_FILE changes the listing", async () => {
		const repo = fixture();
		const index = path.join(repo.outside, "index");
		spawnSync("git", ["read-tree", "--empty"], {
			cwd: repo.dir,
			env: { ...gitEnvOf(repo), GIT_INDEX_FILE: index },
		});
		const clean = await list(repo);
		const env = { ...gitEnvOf(repo), GIT_INDEX_FILE: index };
		const redirected = await list(repo, { env, childEnv: (given) => given });
		expect(redirected).not.toEqual(clean);
		expect(redirected.listing?.entries).toEqual([]);
	});

	it("runs git without the flag or the repository variables, without fsmonitor, at the root", async () => {
		const calls: { args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
		const git: GitRunner = async (args, options) => {
			calls.push({ args, ...options });
			return { code: 0, stdout: args.includes("rev-parse") ? `${repo.dir}\n` : "" };
		};
		const repo = fixture();
		const env = {
			...gitEnvOf(repo),
			DRAFTYAK_RESERVED_TESTS: "1",
			Draftyak_Reserved_Tests: "1",
			GIT_DIR: "x",
		};
		expect((await listCheckout(repo.dir, { env, git })).problems).toEqual([]);
		expect(calls.map(({ args }) => args)).toEqual([
			["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"],
			["-c", "core.fsmonitor=false", "ls-files", "-s", "-z"],
			["-c", "core.fsmonitor=false", "ls-files", "-o", "--exclude-standard", "-z"],
		]);
		for (const call of calls) {
			expect(call.cwd).toBe(repo.dir);
			expect(
				Object.keys(call.env).filter((name) => /^(?:draftyak_reserved_tests|git_dir)$/i.test(name)),
			).toEqual([]);
			expect(call.env.GIT_OPTIONAL_LOCKS).toBe("0");
		}
	});

	// On Windows, Node's spawn looks for git in the working folder first unless this process's own
	// environment says not to, which no child's environment can. A harmless program stands in
	// git.exe's place in the root; this process runs without the setting until the listing sets it.
	it.runIf(process.platform === "win32")(
		"runs the git on PATH, not a git.exe in the root, even when this process has no search setting",
		async () => {
			const repo = fixture();
			copyFileSync(
				path.join(process.env.SystemRoot ?? "", "System32", "hostname.exe"),
				path.join(repo.dir, "git.exe"),
			);
			const setting = "NoDefaultCurrentDirectoryInExePath";
			const name = Object.keys(process.env).find(
				(key) => key.toUpperCase() === setting.toUpperCase(),
			);
			const saved = name === undefined ? undefined : process.env[name];
			delete process.env[setting];
			try {
				const { listing, problems } = await list(repo);
				expect(problems).toEqual([]);
				expect(listing?.untracked).toEqual(["git.exe"]);
				expect(process.env[setting]).toBe("1");
			} finally {
				delete process.env[setting];
				if (name !== undefined && saved !== undefined) process.env[name] = saved;
			}
		},
	);

	it.each([
		["rev-parse", 0],
		["ls-files -s", 1],
		["ls-files -o", 2],
	] as const)("checks nothing when git's %s exits non-zero", async (_label, failing) => {
		let call = 0;
		const repo = fixture();
		const git: GitRunner = async () => {
			const code = call++ === failing ? 128 : 0;
			return { code, stdout: code === 0 && call === 1 ? `${repo.dir}\n` : "" };
		};
		const result = await listCheckout(repo.dir, { git });
		expect(result).toEqual({ listing: null, problems: [{ kind: "git", code: 128 }] });
		expect(listingLines(result.problems)).toEqual([
			"reserved tripwire: git exited 128; nothing was checked",
		]);
	});

	it("refuses a root that isn't git's toplevel, a folder with no repository and a git that can't start", async () => {
		const repo = fixture();
		expect(await listCheckout(path.join(repo.dir, "pkgs"), { env: gitEnvOf(repo) })).toEqual({
			listing: null,
			problems: [{ kind: "toplevel" }],
		});
		const none = await listCheckout(repo.outside, { env: gitEnvOf(repo) });
		expect(none.listing).toBe(null);
		expect(none.problems.length).toBe(1);
		const gone = await listCheckout(path.join(repo.outside, "missing"), { env: gitEnvOf(repo) });
		expect(gone).toEqual({ listing: null, problems: [{ kind: "git", code: 127 }] });
	});

	it("refuses unmerged index entries and nested repositories, naming them only when asked", async () => {
		const repo = fixture();
		unmerged(repo, "pkgs/a/src/index.ts");
		nested(repo, "pkgs/inner");
		const { listing, problems } = await list(repo);
		expect(listing).toBe(null);
		expect(problems).toEqual([
			{ kind: "unmerged", paths: ["pkgs/a/src/index.ts"] },
			{ kind: "nested", paths: ["pkgs/inner"] },
		]);
		expect(listingLines(problems)).toEqual([
			"reserved tripwire: 1 unmerged index entry(ies); nothing was checked",
			"reserved tripwire: 1 nested repository(ies) that git doesn't list into; nothing was checked",
		]);
		expect(listingLines(problems, true)).toEqual([
			"reserved tripwire: 1 unmerged index entry(ies); nothing was checked: pkgs/a/src/index.ts",
			"reserved tripwire: 1 nested repository(ies) that git doesn't list into; nothing was checked: pkgs/inner",
		]);
	});

	it("pins the other lines", () => {
		const problems: ListingProblem[] = [{ kind: "git", code: 3 }, { kind: "toplevel" }];
		expect(listingLines(problems, true)).toEqual([
			"reserved tripwire: git exited 3; nothing was checked",
			"reserved tripwire: git listed another checkout than this one; nothing was checked",
		]);
		expect(listingLines([])).toEqual([]);
	});
});

describe("mutations: each listing check removed lets its fixture through", () => {
	it("runs every check", () => {
		expect(LISTING_CHECKS).toEqual(["toplevel", "unmerged", "nested"]);
	});

	it("toplevel", async () => {
		const repo = fixture();
		const below = path.join(repo.dir, "pkgs");
		expect((await listCheckout(below, { env: gitEnvOf(repo) })).problems).toEqual([
			{ kind: "toplevel" },
		]);
		const loose = await listCheckout(below, { env: gitEnvOf(repo), checks: without("toplevel") });
		expect(loose.problems).toEqual([]);
		expect(loose.listing).not.toBe(null);
	});

	it("unmerged", async () => {
		const repo = fixture();
		unmerged(repo, "pkgs/a/src/index.ts");
		expect((await list(repo)).problems.length).toBe(1);
		expect((await list(repo, { checks: without("unmerged") })).problems).toEqual([]);
	});

	it("nested", async () => {
		const repo = fixture();
		nested(repo, "pkgs/inner");
		expect((await list(repo)).problems.length).toBe(1);
		const loose = await list(repo, { checks: without("nested") });
		expect([loose.problems, loose.listing?.untracked]).toEqual([[], []]);
	});
});

describe("packageDirs", () => {
	async function dirs(repo: TempRepo) {
		const { listing } = await list(repo);
		if (listing === null) throw new Error("no listing");
		const found = packageDirs(new Checkout(repo.dir), listing);
		return {
			dirs: found.dirs.map(scrub),
			refused: found.refused.map(({ rel, kind }) => `${scrub(rel)}: ${kind}`),
		};
	}

	it("finds each package folder the workspace globs name, from listed manifests", async () => {
		const repo = fixture({
			"solo/package.json": "{}\n",
			"pkgs/b/package.yaml": "name: b\n",
			"pkgs/c/x.ts": "",
		});
		repo.write("pkgs/.cache/package.json", "{}\n");
		repo.write("pkgs/node_modules/package.json", "{}\n");
		expect(await dirs(repo)).toEqual({ dirs: ["pkgs/a", "pkgs/b", "solo"], refused: [] });
	});

	it("refuses a package folder that is a junction, and a manifest that is ignored", async () => {
		const repo = fixture();
		repo.link("pkgs/j", repo.outside, "junction");
		repo.ignore("pkgs/ghost/", "pkgs/a/package.yaml");
		repo.write("pkgs/ghost/package.json", "{}\n");
		repo.write("pkgs/a/package.yaml", "name: a\n");
		expect(await dirs(repo)).toEqual({
			dirs: ["pkgs/a"],
			refused: [
				"pkgs/a/package.yaml: unlisted",
				"pkgs/ghost/package.json: unlisted",
				"pkgs/j: link",
			],
		});
	});

	it("refuses a glob's folder that is a junction, reading nothing through it", async () => {
		const repo = fixture();
		repo.write("elsewhere/a/package.json", "{}\n");
		repo.commit();
		rmSync(path.join(repo.dir, "pkgs"), { recursive: true });
		repo.link("pkgs", path.join(repo.dir, "elsewhere"), "junction");
		expect((await dirs(repo)).refused).toEqual(["pkgs: link"]);
	});

	it("refuses a workspace file it can't parse, or that isn't listed, and finds nothing past it", async () => {
		const bad = fixture({ "pnpm-workspace.yaml": "packages: [pkgs/*]\n" });
		expect(await dirs(bad)).toEqual({ dirs: [], refused: ["pnpm-workspace.yaml: unreadable"] });
		const loose = fixture();
		loose.git("rm", "-q", "--cached", "--", "pnpm-workspace.yaml");
		loose.ignore("pnpm-workspace.yaml");
		expect(await dirs(loose)).toEqual({ dirs: [], refused: ["pnpm-workspace.yaml: unlisted"] });
		const none = fixture();
		rmSync(path.join(none.dir, "pnpm-workspace.yaml"));
		expect(await dirs(none)).toEqual({ dirs: [], refused: [] });
	});

	it("counts the allowed root as a package by its name only", async () => {
		const root = `pkgs/zz-${word()}`;
		const repo = fixture({ [`${root}/package.json`]: "{}\n" });
		expect((await dirs(repo)).dirs).toEqual(["pkgs/a", scrub(root)]);
	});
});

describe("workspaceGlobsOf", () => {
	it("parses what workspaceGlobs reads, and refuses what it refuses", () => {
		const repo = fixture();
		expect(workspaceGlobsOf("﻿packages:\n  - a/*\n  # note\n\n  - b \nother: 1\n")).toEqual([
			"a/*",
			"b",
		]);
		expect(workspaceGlobsOf("packages:\r\n  - a\r\n")).toEqual(["a"]);
		expect(workspaceGlobs(repo.dir)).toEqual(["pkgs/*", "solo"]);
		for (const text of [
			"",
			"packages:\n",
			"packages:\n  - a\npackages:\n  - b\n",
			"packages:\n  - 'a'\n",
			"packages:\r  - a\r",
		]) {
			expect(() => workspaceGlobsOf(text)).toThrow(
				"pnpm-workspace.yaml has no readable packages: list",
			);
		}
	});
});
