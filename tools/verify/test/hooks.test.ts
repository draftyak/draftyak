import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	ALLOWED_ROOT_SCRIPTS,
	checkInstallInputs,
	hookKey,
	INSTALL_HOOKS,
	INSTALL_RULES,
	type InstallDeps,
	type InstallRule,
	ordinaryHookKey,
	workspaceProblem,
} from "../lib/hooks.ts";
import { runtimeSpecifiers } from "../lib/imports.ts";
import type { Listing } from "../lib/listing.ts";
import { Checkout } from "../lib/safe-fs.ts";
import { approvedWorkspace } from "../lib/workspace-policy.ts";
import { readerSpy, type TempRepo, tempRepo } from "./temp-repo.ts";

// The hook rules and the pre-install check's inputs, on synthetic checkouts: a root and three
// package folders, one of them an allowed root given to the Checkout. The listing comes from the
// temp repository's own git, as the real listing would; the package folders are given.
const verify = path.resolve(import.meta.dirname, "..");
const WORKSPACE = readFileSync(path.resolve(verify, "..", "..", "pnpm-workspace.yaml"), "utf8");

const manifest = (scripts: Record<string, string>, more: Record<string, unknown> = {}): string =>
	`${JSON.stringify({ private: true, ...more, scripts }, null, 2)}\n`;

// The allowed root's script names, exactly as the contract has them.
const CONTRACT = { typecheck: "x", test: "x", "test:heavy": "x", "test:live": "x" };

const BASE: Readonly<Record<string, string>> = {
	"package.json": manifest({ build: "x", test: "x", preview: "x" }),
	"pnpm-workspace.yaml": WORKSPACE,
	"spikes/alpha/package.json": manifest({ test: "x", typecheck: "x", postcss: "x", prettier: "x" }),
	"spikes/held/package.json": manifest(CONTRACT),
	"tools/beta/package.json": manifest({}),
};
const DIRS = ["spikes/alpha", "spikes/held", "tools/beta"];
const ALLOWED = ["spikes/held/"];

interface Change {
	// Files written over the base checkout before its commit.
	readonly files?: Readonly<Record<string, string>>;
	// Patterns git ignores, so their files aren't listed.
	readonly ignore?: readonly string[];
	readonly refused?: ReturnType<InstallDeps["packageDirs"]>["refused"];
}

const repos: TempRepo[] = [];
afterAll(() => {
	for (const repo of repos) repo.remove();
});

const records = (text: string): string[] => text.split("\0").filter(Boolean);

function listingOf(repo: TempRepo): Listing {
	const entries = records(repo.git("ls-files", "-s", "-z")).map((record) => {
		const [meta = "", file = ""] = record.split("\t");
		return { mode: meta.split(" ")[0] ?? "", path: file };
	});
	const untracked = records(repo.git("ls-files", "-o", "--exclude-standard", "-z"));
	return { root: repo.dir, entries, untracked };
}

function setUp(change: Change = {}) {
	const repo = tempRepo();
	repos.push(repo);
	for (const [file, text] of Object.entries({ ...BASE, ...change.files })) repo.write(file, text);
	if (change.ignore !== undefined) repo.ignore(...change.ignore);
	repo.commit();
	const deps: InstallDeps = {
		packageDirs: () => ({ dirs: DIRS, refused: change.refused ?? [] }),
		approvedWorkspace,
	};
	const checkout = new Checkout(repo.dir, undefined, { allowedRoots: ALLOWED });
	return { repo, checkout, listing: listingOf(repo), deps };
}

const PASSED =
	"pre-install check: 4 manifest(s) and the workspace file checked; no install hook found";
const STOPPED =
	"pre-install check: stopped before anything was installed; don't run the install, send this log's path to the reserved files' maintainer";

// One fixture per rule that only that rule refuses, with the count line it prints.
const FIXTURES: Readonly<Record<InstallRule, readonly [Change, string]>> = {
	"workspace-file": [
		{ files: { "pnpm-workspace.yaml": `${WORKSPACE}enablePrePostScripts: true\n` } },
		"pre-install check: the workspace file isn't a listed regular file in the approved form",
	],
	"no-npmrc": [
		{ files: { ".npmrc": "ignore-scripts=false\n" } },
		"pre-install check: 1 .npmrc path(s) in the root or a package folder; pnpm reads its settings from them",
	],
	"no-pnpmfile": [
		{ files: { ".pnpmfile.cjs": "module.exports = {};\n" } },
		"pre-install check: 1 .pnpmfile.cjs or .pnpmfile.mjs path(s) in the root; pnpm runs them during an install",
	],
	"no-binding-gyp": [
		{ files: { "spikes/alpha/binding.gyp": "{}\n" } },
		"pre-install check: 1 binding.gyp path(s) in the root or a package folder; an install builds them",
	],
	manifests: [
		{ refused: [{ rel: "spikes/gamma", kind: "unlisted" }] },
		"pre-install check: 1 manifest(s) or package folder(s) aren't listed regular files whose script names can be read",
	],
	"no-pnpm-field": [
		{ files: { "package.json": manifest({ test: "x" }, { pnpm: { onlyBuiltDependencies: [] } }) } },
		"pre-install check: the root manifest has a pnpm field, whose settings can change what an install runs",
	],
	"ordinary-hooks": [
		{ files: { "spikes/alpha/package.json": manifest({ test: "x", postinstall: "x" }) } },
		"pre-install check: 1 install hook script(s) in 1 manifest(s)",
	],
	"allowed-root-scripts": [
		{
			files: {
				"spikes/held/package.json": manifest({
					typecheck: "x",
					test: "x",
					"test:heavy": "x",
					"test:device": "x",
				}),
			},
		},
		"pre-install check: 2 script name(s) in 1 allowed root manifest(s) are install hooks, missing from its contract or not on it",
	],
};

describe("the hook names", () => {
	it("keeps the install hook list and hookKey as the proof's wiring rule had them", () => {
		expect(INSTALL_HOOKS).toEqual([
			...["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"],
			"dependencies",
		]);
		const refused = [...INSTALL_HOOKS, "pretest", "posttest", "preview", "postcss", "prettier"];
		for (const key of [...refused, "pnpm:devPreinstall", "pnpm:x"]) {
			expect([key, hookKey(key)]).toEqual([key, true]);
		}
		for (const key of ["test", "test:heavy", "typecheck", "build", "lint", "Prepare", "xprepare"]) {
			expect([key, hookKey(key)]).toEqual([key, false]);
		}
	});

	it("refuses only install and prepare hooks and pnpm: hooks in ordinary manifests", () => {
		for (const key of ["preview", "postcss", "prettier", "pretest", "posttest", "test", "build"]) {
			expect([key, ordinaryHookKey(key)]).toEqual([key, false]);
		}
		const refused = ["preinstall", "install", "postinstall", "prepare", "pnpm:devPreinstall"];
		for (const key of [...refused, ...INSTALL_HOOKS]) {
			expect([key, ordinaryHookKey(key)]).toEqual([key, true]);
		}
	});

	it("holds the allowed root to exactly the kit's own script names, none of them a hook", () => {
		expect(ALLOWED_ROOT_SCRIPTS).toEqual(["typecheck", "test", "test:heavy", "test:live"]);
		expect(ALLOWED_ROOT_SCRIPTS.some(hookKey)).toBe(false);
		expect(new Set(ALLOWED_ROOT_SCRIPTS).size).toBe(ALLOWED_ROOT_SCRIPTS.length);
		expect(Object.keys(CONTRACT)).toEqual(ALLOWED_ROOT_SCRIPTS);
	});

	it("loads nothing at runtime, so the proof's and the pre-install check's start sets hold", () => {
		const text = readFileSync(path.join(verify, "lib", "hooks.ts"), "utf8");
		expect(runtimeSpecifiers(text)).toEqual([]);
	});
});

describe("the pre-install inputs", () => {
	it("pins the rules whole, in the order their lines print", () => {
		expect(INSTALL_RULES).toEqual([
			...["workspace-file", "no-npmrc", "no-pnpmfile", "no-binding-gyp", "manifests"],
			...["no-pnpm-field", "ordinary-hooks", "allowed-root-scripts"],
		]);
	});

	it("passes an inert checkout with one count line, names or not", () => {
		const { checkout, listing, deps } = setUp();
		for (const names of [false, true]) {
			expect(checkInstallInputs({ checkout, listing, names }, deps)).toEqual({
				ok: true,
				lines: [PASSED],
			});
		}
	});

	it.each(INSTALL_RULES)(
		"refuses the %s fixture, and lets it through without that rule",
		(rule) => {
			const [change, line] = FIXTURES[rule];
			const { checkout, listing, deps } = setUp(change);
			expect(checkInstallInputs({ checkout, listing }, deps)).toEqual({
				ok: false,
				lines: [line, STOPPED],
			});
			const others = INSTALL_RULES.filter((other) => other !== rule);
			expect(checkInstallInputs({ checkout, listing, rules: others }, deps)).toEqual({
				ok: true,
				lines: [PASSED],
			});
		},
	);

	it("counts an untracked manifest that git doesn't ignore as listed", () => {
		const { repo, checkout, deps } = setUp();
		repo.write("spikes/delta/package.json", manifest({ test: "x" }));
		const listing = listingOf(repo);
		expect(listing.untracked).toEqual(["spikes/delta/package.json"]);
		const dirs = [...DIRS, "spikes/delta"];
		const result = checkInstallInputs(
			{ checkout, listing },
			{ ...deps, packageDirs: () => ({ dirs, refused: [] }) },
		);
		expect(result.lines).toEqual([
			"pre-install check: 5 manifest(s) and the workspace file checked; no install hook found",
		]);
	});

	it("refuses an ignored manifest or workspace file without opening it", () => {
		const ignored = ["package.json", "pnpm-workspace.yaml"];
		const { repo, listing, deps } = setUp({ ignore: ignored.map((file) => `/${file}`) });
		expect(listing.entries.map((entry) => entry.path)).not.toContain("package.json");
		const spy = readerSpy(repo.dir, (rel) => ignored.includes(rel));
		const checkout = new Checkout(repo.dir, spy.fs, { allowedRoots: ALLOWED });
		const result = checkInstallInputs({ checkout, listing, names: true }, deps);
		expect([spy.refused, spy.opens.filter((rel) => ignored.includes(rel))]).toEqual([[], []]);
		expect(result.lines).toEqual([
			"pre-install check: the workspace file isn't a listed regular file in the approved form: pnpm-workspace.yaml",
			"pre-install check: 1 manifest(s) or package folder(s) aren't listed regular files whose script names can be read: package.json",
			STOPPED,
		]);
	});

	it("says why the workspace file fails the rule the gate shares, opening only a listed regular file", () => {
		const answer = (change: Change, edit: (repo: TempRepo) => void = () => {}) => {
			const { repo } = setUp(change);
			edit(repo);
			const spy = readerSpy(repo.dir);
			const checkout = new Checkout(repo.dir, spy.fs, { allowedRoots: ALLOWED });
			const problem = workspaceProblem(checkout, listingOf(repo), approvedWorkspace);
			return [problem, spy.opens.includes("pnpm-workspace.yaml")];
		};
		const extra = { "pnpm-workspace.yaml": `${WORKSPACE}scriptShell: ./shell.cmd\n` };
		const gone = (repo: TempRepo): void => rmSync(path.join(repo.dir, "pnpm-workspace.yaml"));
		expect(answer({})).toEqual([null, true]);
		expect(answer({ files: extra })).toEqual(["unapproved", true]);
		expect(answer({ ignore: ["/pnpm-workspace.yaml"] })).toEqual(["unlisted", false]);
		expect(answer({}, gone)).toEqual(["missing", false]);
		const folder = (repo: TempRepo): void => {
			gone(repo);
			mkdirSync(path.join(repo.dir, "pnpm-workspace.yaml"));
		};
		expect(answer({}, folder)).toEqual(["dir", false]);
	});

	it("refuses .npmrc, binding.gyp and pnpmfile paths of any kind, in the root and each package folder", () => {
		const { checkout, listing, deps } = setUp({
			files: {
				".npmrc/x": "x",
				"spikes/alpha/.npmrc": "x",
				"spikes/held/.npmrc": "x",
				".pnpmfile.mjs": "export default {};\n",
				"binding.gyp": "{}\n",
				"tools/beta/binding.gyp/x": "x",
			},
		});
		expect(checkInstallInputs({ checkout, listing, names: true }, deps).lines).toEqual([
			"pre-install check: 3 .npmrc path(s) in the root or a package folder; pnpm reads its settings from them: .npmrc, spikes/alpha/.npmrc, spikes/held/.npmrc",
			"pre-install check: 1 .pnpmfile.cjs or .pnpmfile.mjs path(s) in the root; pnpm runs them during an install: .pnpmfile.mjs",
			"pre-install check: 2 binding.gyp path(s) in the root or a package folder; an install builds them: binding.gyp, tools/beta/binding.gyp",
			STOPPED,
		]);
	});

	it("refuses a manifest that isn't a JSON object or holds scripts that aren't one", () => {
		const { checkout, listing, deps } = setUp({
			files: {
				"spikes/alpha/package.json": "{",
				"tools/beta/package.json": '{"scripts":["postinstall"]}',
				"spikes/held/package.json": "[]",
			},
		});
		expect(checkInstallInputs({ checkout, listing, names: true }, deps).lines).toEqual([
			"pre-install check: 3 manifest(s) or package folder(s) aren't listed regular files whose script names can be read: spikes/alpha/package.json, spikes/held/package.json, tools/beta/package.json",
			STOPPED,
		]);
	});

	it("refuses a package folder that is a junction even when the folder list keeps it", () => {
		const { repo, checkout, deps } = setUp();
		repo.link("spikes/joined", "spikes/alpha", "junction");
		const listing = listingOf(repo);
		const dirs = [...DIRS, "spikes/joined"];
		const result = checkInstallInputs(
			{ checkout, listing, names: true },
			{ ...deps, packageDirs: () => ({ dirs, refused: [] }) },
		);
		// Nothing below a link is followed, so nothing there counts as missing either.
		expect(result.lines).toEqual([
			"pre-install check: 1 .npmrc path(s) in the root or a package folder; pnpm reads its settings from them: spikes/joined/.npmrc",
			"pre-install check: 1 binding.gyp path(s) in the root or a package folder; an install builds them: spikes/joined/binding.gyp",
			"pre-install check: 1 manifest(s) or package folder(s) aren't listed regular files whose script names can be read: spikes/joined/package.json",
			STOPPED,
		]);
	});

	it("refuses when the package folders can't be found, and checks the rest", () => {
		const { checkout, listing, deps } = setUp({ files: { ".npmrc": "x" } });
		const failing: InstallDeps = {
			...deps,
			packageDirs: () => {
				throw new Error("pnpm-workspace.yaml has no readable packages: list");
			},
		};
		expect(checkInstallInputs({ checkout, listing, names: true }, failing).lines).toEqual([
			"pre-install check: 1 .npmrc path(s) in the root or a package folder; pnpm reads its settings from them: .npmrc",
			"pre-install check: 1 manifest(s) or package folder(s) aren't listed regular files whose script names can be read: the package folders of pnpm-workspace.yaml",
			STOPPED,
		]);
	});

	it("names ordinary hook scripts with --names, and only the allowed root's manifest, never its script names", () => {
		const { checkout, listing, deps } = setUp({
			files: {
				"package.json": manifest({ test: "x", prepare: "x" }),
				"spikes/alpha/package.json": manifest({ postinstall: "x", "pnpm:devPreinstall": "x" }),
				"spikes/held/package.json": manifest({ test: "x", "held-only": "x", postinstall: "x" }),
			},
		});
		const counted = checkInstallInputs({ checkout, listing }, deps).lines;
		// Two names off the contract (held-only and postinstall), three of it missing.
		expect(counted).toEqual([
			"pre-install check: 3 install hook script(s) in 2 manifest(s)",
			"pre-install check: 5 script name(s) in 1 allowed root manifest(s) are install hooks, missing from its contract or not on it",
			STOPPED,
		]);
		const named = checkInstallInputs({ checkout, listing, names: true }, deps).lines;
		expect(named).toEqual([
			"pre-install check: 3 install hook script(s) in 2 manifest(s): package.json (prepare), spikes/alpha/package.json (postinstall, pnpm:devPreinstall)",
			"pre-install check: 5 script name(s) in 1 allowed root manifest(s) are install hooks, missing from its contract or not on it: spikes/held/package.json",
			STOPPED,
		]);
		expect(named.some((line) => line.includes("held-only"))).toBe(false);
	});

	// The allowed root's names against the contract as sets: what differs is counted, the same count
	// of other names never passes, and no line names a script, with --names or without.
	it("compares the allowed root's script names with its contract as sets, whatever their count", () => {
		const { typecheck, test, "test:heavy": heavy, "test:live": live } = CONTRACT;
		const cases: readonly (readonly [string, string, number])[] = [
			["the contract", manifest(CONTRACT), 0],
			[
				"the contract in another order",
				manifest({ "test:live": live, "test:heavy": heavy, test, typecheck }),
				0,
			],
			["one name missing", manifest({ typecheck, test, "test:heavy": heavy }), 1],
			[
				"a rename to another kit script",
				manifest({ typecheck, test, "test:heavy": heavy, "test:device": "x" }),
				2,
			],
			[
				"a rename to any other name",
				manifest({ typecheck, test, "test:heavy": heavy, lint: "x" }),
				2,
			],
			[
				"a hook in place of a name",
				manifest({ typecheck, test, "test:heavy": heavy, postinstall: "x" }),
				2,
			],
			["one name more", manifest({ ...CONTRACT, "test:device": "x" }), 1],
			["a hook more", manifest({ ...CONTRACT, prepare: "x" }), 1],
			["no scripts", manifest({}), 4],
			["no scripts field", '{ "private": true }\n', 4],
			[
				"a name spelled in another case",
				manifest({ typecheck, test, "test:heavy": heavy, "Test:live": "x" }),
				2,
			],
		];
		for (const [label, text, differ] of cases) {
			const { checkout, listing, deps } = setUp({ files: { "spikes/held/package.json": text } });
			for (const names of [false, true]) {
				const { ok, lines } = checkInstallInputs({ checkout, listing, names }, deps);
				const line = `pre-install check: ${differ} script name(s) in 1 allowed root manifest(s) are install hooks, missing from its contract or not on it`;
				const expected =
					differ === 0 ? [PASSED] : [names ? `${line}: spikes/held/package.json` : line, STOPPED];
				expect([label, ok, lines]).toEqual([label, differ === 0, expected]);
			}
		}
	});
});
