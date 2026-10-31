import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { windowsChildEnv, withoutReservedTests } from "../../../reserved-tests.ts";
import {
	checkStart,
	GIT_REPO_VARS,
	gitChildEnv,
	HELPERS,
	realRoot,
	START_RULES,
	START_STOP_LINE,
	type StartOps,
	type StartProblem,
	type StartRule,
	startLines,
} from "../lib/bootstrap.ts";
import { nodeFs } from "../lib/safe-fs.ts";
import { STOP_LINE } from "../reserved-tripwire.ts";
import {
	canLink,
	gitEnvOf,
	ownRepo,
	scrub,
	shortAlias,
	type TempRepo,
	tempRepo,
} from "./temp-repo.ts";

// The start check on synthetic checkouts: the helpers are empty files, since the check never reads
// one. Compared paths are scrubbed.
const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

const windows = process.platform === "win32";
const symlinks = canLink("file") && canLink("dir");
const NO_SYMLINKS =
	"file and folder symlinks need Developer Mode or elevation on this Windows host";
const ENTRY = "tools/verify/gate.ts";
const HELPER = "tools/verify/lib/listing.ts";

function fixture(): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	for (const rel of [ENTRY, "tools/verify/lib/bootstrap.ts", ...HELPERS.gate]) {
		repo.write(rel, `// ${rel}\n`);
	}
	repo.commit();
	return repo;
}

const at = (repo: TempRepo, rel: string): string => path.join(repo.dir, ...rel.split("/"));

function check(
	repo: TempRepo,
	options: { startedAs?: string; ops?: StartOps; rules?: readonly StartRule[] } = {},
): StartProblem[] {
	const problems = checkStart(repo.dir, options.startedAs ?? at(repo, ENTRY), HELPERS.gate, {
		env: gitEnvOf(repo),
		...(options.ops === undefined ? {} : { ops: options.ops }),
		...(options.rules === undefined ? {} : { rules: options.rules }),
	});
	return problems.map(({ rel, kind }) => ({ rel: scrub(rel), kind }));
}

const without = (rule: StartRule): StartRule[] => START_RULES.filter((item) => item !== rule);
const same = (a: string, b: string): boolean =>
	nodeFs.realpath(a).toLowerCase() === b.toLowerCase();

describe("checkStart", () => {
	// Two rules each catch a junction (the listing flag, realpath) and an 8.3 alias (realpath, the
	// listing), so these cases pass with one removed: the mutation cases below remove one at a time.
	it("passes an inert checkout of real folders and listed, regular helpers", () => {
		expect(check(fixture())).toEqual([]);
	});

	it("refuses a helper replaced by a junction", () => {
		const repo = fixture();
		rmSync(at(repo, HELPER));
		repo.link(HELPER, repo.outside, "junction");
		expect(check(repo)).toEqual([{ rel: HELPER, kind: "link" }]);
	});

	it("refuses a helper replaced by a file symlink", (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture();
		rmSync(at(repo, HELPER));
		writeFileSync(path.join(repo.outside, "listing.ts"), "");
		repo.link(HELPER, path.join(repo.outside, "listing.ts"), "file");
		expect(check(repo)).toEqual([{ rel: HELPER, kind: "link" }]);
	});

	it("refuses a helper folder replaced by a junction once, at the folder", () => {
		const repo = fixture();
		rmSync(at(repo, "tools/verify/lib"), { recursive: true });
		repo.link("tools/verify/lib", repo.outside, "junction");
		expect(check(repo)).toEqual([{ rel: "tools/verify/lib", kind: "link" }]);
	});

	it("refuses a helper folder replaced by a folder symlink", (ctx) => {
		ctx.skip(!symlinks, NO_SYMLINKS);
		const repo = fixture();
		rmSync(at(repo, "tools/verify/lib"), { recursive: true });
		repo.link("tools/verify/lib", repo.outside, "dir");
		expect(check(repo)).toEqual([{ rel: "tools/verify/lib", kind: "link" }]);
	});

	it("refuses an entry started through a junction inside the checkout", () => {
		const repo = fixture();
		repo.link("tools/via", at(repo, "tools/verify"), "junction");
		const startedAs = path.join(repo.dir, "tools", "via", "gate.ts");
		expect(check(repo, { startedAs })).toEqual([{ rel: "tools/via", kind: "link" }]);
	});

	it("accepts an entry started through a junction above the checkout, as Checkout does", () => {
		const repo = fixture();
		const via = path.join(path.dirname(repo.dir), "via");
		symlinkSync(repo.dir, via, "junction");
		expect(check(repo, { startedAs: path.join(via, "tools", "verify", "gate.ts") })).toEqual([]);
		expect(same(realRoot(path.join(via, "tools", "verify"), 2), repo.dir)).toBe(true);
	});

	it("refuses an entry started through a real 8.3 alias of a folder inside the checkout", (ctx) => {
		ctx.skip(!windows, "8.3 aliases exist only on Windows");
		const repo = fixture();
		repo.write("tools/longfoldername/gate.ts", "");
		repo.commit();
		const alias = shortAlias(at(repo, "tools/longfoldername"));
		// The temp folder's volume must make short names: a null here fails the test, never skips it.
		expect(alias).not.toBe(null);
		const startedAs = path.join(alias ?? "", "gate.ts");
		const problems = check(repo, { startedAs });
		expect(problems.length).toBe(1);
		expect(problems[0]?.rel.toLowerCase().startsWith("tools/")).toBe(true);
		expect(problems[0]?.rel.includes("~")).toBe(true);
		expect(["redirect", "unreadable"]).toContain(problems[0]?.kind);
	});

	it("accepts an entry started in another case where the platform ignores case", (ctx) => {
		ctx.skip(!windows, "only Windows checkouts here ignore case");
		const repo = fixture();
		expect(check(repo, { startedAs: at(repo, ENTRY).toUpperCase() })).toEqual([]);
	});

	it("refuses an entry that lies outside the checkout", () => {
		const repo = fixture();
		const elsewhere = path.join(repo.outside, "gate.ts");
		writeFileSync(elsewhere, "");
		expect(check(repo, { startedAs: elsewhere })).toEqual([
			{ rel: "../outside/gate.ts", kind: "redirect" },
		]);
	});

	it("refuses an unlisted helper, a missing one, a hard-linked one and a folder in a file's place", () => {
		const repo = fixture();
		repo.git("rm", "-q", "--cached", "--", HELPER);
		repo.ignore(HELPER);
		expect(check(repo)).toEqual([{ rel: HELPER, kind: "unlisted" }]);
		const missing = fixture();
		rmSync(at(missing, HELPER));
		expect(check(missing)).toEqual([{ rel: HELPER, kind: "missing" }]);
		const linked = fixture();
		linked.hardlink("tools/verify/lib/copy.ts", HELPER);
		expect(check(linked)).toEqual([{ rel: HELPER, kind: "hardlink" }]);
		const folder = fixture();
		rmSync(at(folder, HELPER));
		folder.write(`${HELPER}/inner.ts`, "");
		expect(check(folder)).toEqual([{ rel: HELPER, kind: "dir" }]);
	});

	it("runs git without the repository variables or the flag, and lists nothing when git fails", () => {
		const repo = fixture();
		const env = { ...gitEnvOf(repo), GIT_INDEX_FILE: path.join(repo.outside, "index") };
		expect(checkStart(repo.dir, at(repo, ENTRY), HELPERS.gate, { env })).toEqual([]);
		const asked: (readonly string[])[] = [];
		const problems = checkStart(repo.dir, at(repo, ENTRY), [HELPER], {
			listed: (_root, rels) => {
				asked.push(rels);
				return [];
			},
		});
		expect(asked).toEqual([["tools/verify/lib/bootstrap.ts", ENTRY, HELPER]]);
		expect(problems.map(({ kind }) => kind)).toEqual(["unlisted", "unlisted", "unlisted"]);
	});
});

// Each rule's own fixture: what only that rule refuses.
describe("mutations: each checkStart rule removed lets its fixture through", () => {
	const helper = (repo: TempRepo): string => at(repo, HELPER);
	const cases: readonly (readonly [StartRule, (repo: TempRepo) => StartOps | undefined])[] = [
		[
			"listing-flag",
			// A reparse point that lstat calls a regular file, as Windows lists some.
			() => ({
				...nodeFs,
				readdir: (dir) =>
					nodeFs
						.readdir(dir)
						.map((entry) =>
							entry.name === "listing.ts"
								? { name: entry.name, isSymbolicLink: () => true }
								: entry,
						),
			}),
		],
		[
			"lstat",
			(repo) => ({
				...nodeFs,
				lstat: (file) => {
					const stat = nodeFs.lstat(file);
					if (file !== helper(repo)) return stat;
					return {
						nlink: stat.nlink,
						isFile: () => true,
						isDirectory: () => false,
						isSymbolicLink: () => true,
					};
				},
			}),
		],
		[
			"realpath",
			(repo) => ({
				...nodeFs,
				realpath: (file) =>
					file === helper(repo) ? path.join(repo.outside, "listing.ts") : nodeFs.realpath(file),
			}),
		],
		[
			"nlink",
			(repo) => {
				repo.hardlink("tools/verify/lib/copy.ts", HELPER);
				return undefined;
			},
		],
		[
			"git-listed",
			(repo) => {
				repo.git("rm", "-q", "--cached", "--", HELPER);
				repo.ignore(HELPER);
				return undefined;
			},
		],
	];

	it("covers every rule", () => {
		expect(START_RULES).toEqual(["listing-flag", "lstat", "realpath", "nlink", "git-listed"]);
		expect(cases.map(([rule]) => rule)).toEqual(START_RULES);
	});

	it.each(cases)("%s", (rule, plant) => {
		const repo = fixture();
		const ops = plant(repo);
		const options = ops === undefined ? {} : { ops };
		expect(check(repo, options).length).toBe(1);
		expect(check(repo, { ...options, rules: without(rule) })).toEqual([]);
	});
});

describe("the start check's lines", () => {
	it("prints nothing for no problem, else one count line and the stop line", () => {
		expect(startLines([])).toEqual([]);
		const problems: StartProblem[] = [
			{ rel: "tools/verify/lib/gate.ts", kind: "link" },
			{ rel: "tools/verify/lib/listing.ts", kind: "unlisted" },
		];
		expect(startLines(problems)).toEqual([
			"reserved tripwire: 2 start file(s) or folder(s) failed their kind check; nothing was loaded",
			"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.",
		]);
		expect(startLines(problems, true)[0]).toBe(
			"reserved tripwire: 2 start file(s) or folder(s) failed their kind check; nothing was loaded: tools/verify/lib/gate.ts (link), tools/verify/lib/listing.ts (unlisted)",
		);
	});

	it("keeps its stop line equal to the tripwire's", () => {
		expect(START_STOP_LINE).toBe(STOP_LINE);
	});
});

describe("gitChildEnv", () => {
	it("equals withoutReservedTests plus windowsChildEnv, without the repository variables", () => {
		const env: NodeJS.ProcessEnv = {
			PATH: "/bin",
			DRAFTYAK_RESERVED_TESTS: "1",
			draftyak_reserved_tests: "1",
			GIT_DIR: "/elsewhere/.git",
			git_work_tree: "/elsewhere",
			GIT_INDEX_FILE: "/elsewhere/index",
			GIT_CEILING_DIRECTORIES: "/",
			GIT_OPTIONAL_LOCKS: "1",
			GIT_CONFIG_GLOBAL: "/home/x/.gitconfig",
			nodefaultcurrentdirectoryinexepath: "0",
		};
		const repoVars = new Set(GIT_REPO_VARS.map((name) => name.toUpperCase()));
		const kept = Object.fromEntries(
			Object.entries(env).filter(
				([name]) =>
					!repoVars.has(name.toUpperCase()) && name.toUpperCase() !== "GIT_OPTIONAL_LOCKS",
			),
		);
		const expected = Object.fromEntries(
			Object.entries({
				...windowsChildEnv(kept),
				...withoutReservedTests(env),
				GIT_OPTIONAL_LOCKS: "0",
			}).filter(([, value]) => value !== undefined),
		);
		expect(gitChildEnv(env)).toEqual(expected);
		expect(Object.keys(gitChildEnv(env)).some((name) => /reserved_tests/i.test(name))).toBe(false);
		expect(gitChildEnv(env).GIT_CONFIG_GLOBAL).toBe("/home/x/.gitconfig");
	});

	it("clears every variable spikes/kit/repo.ts clears, and the two that move discovery", () => {
		const kit = readFileSync(path.join(ownRepo, "spikes", "kit", "repo.ts"), "utf8");
		const block = /const REPO_VARS = new Set\(\[([\s\S]*?)\]\);/.exec(kit)?.[1] ?? "";
		const names = [...block.matchAll(/"(GIT_[A-Z_]+)"/g)].map((match) => match[1]);
		expect(names.length).toBeGreaterThan(10);
		expect([...GIT_REPO_VARS]).toEqual([
			...names,
			"GIT_CEILING_DIRECTORIES",
			"GIT_DISCOVERY_ACROSS_FILESYSTEM",
		]);
	});
});

describe("realRoot", () => {
	it("is the real folder depth folders above an entry's, or that path where none is real", () => {
		expect(same(realRoot(path.join(ownRepo, "tools", "verify"), 2), ownRepo)).toBe(true);
		const repo = fixture();
		const none = path.join(repo.outside, "none", "x", "y");
		expect(realRoot(none, 1)).toBe(path.join(repo.outside, "none", "x"));
	});
});

describe("HELPERS", () => {
	it("pins each entry's helper set", () => {
		const gate = [
			"tools/verify/lib/gate.ts",
			"tools/verify/lib/listing.ts",
			"tools/verify/lib/references.ts",
			"tools/verify/lib/discovery.ts",
			"tools/verify/lib/hooks.ts",
			"tools/verify/lib/workspace-policy.ts",
			"tools/verify/reserved-tripwire.ts",
			"tools/verify/lib/safe-fs.ts",
			"tools/verify/lib/rust-source.ts",
			"tools/verify/lib/imports.ts",
			"tools/verify/lib/allowed.ts",
			"reserved-tests.ts",
		];
		const spawn = ["tools/verify/lib/spawn.ts", "tools/verify/lib/tools.ts"];
		expect(HELPERS).toEqual({
			gate,
			preinstall: [
				"tools/verify/lib/hooks.ts",
				"tools/verify/lib/listing.ts",
				"tools/verify/lib/safe-fs.ts",
				"tools/verify/lib/workspace-policy.ts",
				"tools/verify/lib/allowed.ts",
				"reserved-tests.ts",
			],
			proof: [...gate, "tools/verify/lib/proof.ts", ...spawn],
			turbo: [...gate, ...spawn],
			verify: [...gate, "tools/verify/lib/registry.ts", "tools/verify/lib/context.ts", ...spawn],
			prefetch: [...gate, "tools/verify/prefetch.ts", ...spawn],
			kitOff: ["spikes/kit/off.ts", "reserved-tests.ts"],
			kitGate: ["tools/verify/gate.ts"],
			kitRun: ["spikes/kit/runner.ts", "spikes/kit/repo.ts", "spikes/kit/exec.ts"],
		});
	});
});
