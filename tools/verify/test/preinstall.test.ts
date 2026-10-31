import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HELPERS, START_STOP_LINE } from "../lib/bootstrap.ts";
import { INSTALL_STOP_LINE } from "../lib/hooks.ts";
import { runtimeSpecifiers } from "../lib/imports.ts";
import {
	type Listing,
	type ListingProblem,
	listCheckout,
	listingLines,
	packageDirs,
} from "../lib/listing.ts";
import { Checkout } from "../lib/safe-fs.ts";
import { capture } from "../lib/spawn.ts";
import { type PreinstallDeps, preinstallMain } from "../preinstall.ts";
import { copyOwn, gitEnvOf, readerSpy, scrub, type TempRepo, tempRepo, word } from "./temp-repo.ts";

// The pre-install check in-process, with the listing and the package folders faked and a real
// Checkout on a synthetic temp repository. Its allowed root is reserved-named, as the real one is;
// the word is built here, and compared lines are scrubbed.
const verify = path.resolve(import.meta.dirname, "..");
const WORKSPACE = readFileSync(path.resolve(verify, "..", "..", "pnpm-workspace.yaml"), "utf8");
const HELD = `spikes/s90-${word()}`;
const HELD_MANIFEST = `${HELD}/package.json`;
const DIRS = [HELD, "spikes/alpha", "tools/beta"];

const manifest = (scripts: Record<string, string>, more: Record<string, unknown> = {}): string =>
	`${JSON.stringify({ private: true, ...more, scripts }, null, 2)}\n`;

const BASE: Readonly<Record<string, string>> = {
	"package.json": manifest({ build: "x", test: "x", preview: "x" }),
	"pnpm-workspace.yaml": WORKSPACE,
	"spikes/alpha/package.json": manifest({ test: "x", typecheck: "x", postcss: "x" }),
	[HELD_MANIFEST]: manifest({ test: "x", typecheck: "x", "test:heavy": "x", "test:live": "x" }),
	"tools/beta/package.json": manifest({ prettier: "x" }),
};

interface Change {
	readonly files?: Readonly<Record<string, string>>;
	readonly ignore?: readonly string[];
	readonly refused?: ReturnType<PreinstallDeps["packageDirs"]>["refused"];
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

function checkout(change: Change = {}) {
	const repo = tempRepo();
	repos.push(repo);
	for (const [file, text] of Object.entries({ ...BASE, ...change.files })) repo.write(file, text);
	if (change.ignore !== undefined) repo.ignore(...change.ignore);
	repo.commit();
	return repo;
}

// The check's deps for `repo`: every call recorded, every printed line kept.
function deps(
	repo: TempRepo,
	change: Change = {},
	listed?: Awaited<ReturnType<PreinstallDeps["listCheckout"]>>,
) {
	const lines: string[] = [];
	const calls: string[] = [];
	const value: PreinstallDeps = {
		print: (line) => lines.push(...line.split("\n")),
		async listCheckout(root) {
			calls.push(`listCheckout ${root === repo.dir ? "<repo>" : root}`);
			return listed ?? { listing: listingOf(repo), problems: [] };
		},
		packageDirs() {
			calls.push("packageDirs");
			return { dirs: DIRS, refused: change.refused ?? [] };
		},
		checkout(root) {
			calls.push(`checkout ${root === repo.dir ? "<repo>" : root}`);
			return new Checkout(root, undefined, { allowedRoots: [`${HELD}/`] });
		},
	};
	return { value, lines, calls };
}

async function run(argv: readonly string[], change: Change = {}) {
	const repo = checkout(change);
	const { value, lines, calls } = deps(repo, change);
	const code = await preinstallMain(argv, repo.dir, value);
	return { code, lines, calls, repo };
}

const PASSED =
	"pre-install check: 4 manifest(s) and the workspace file checked; no install hook found";
const hooks = (count: number, files: number): string =>
	`pre-install check: ${count} install hook script(s) in ${files} manifest(s)`;
const allowed = (count: number): string =>
	`pre-install check: ${count} script name(s) in 1 allowed root manifest(s) are install hooks or not on the allowed list`;
const MANIFESTS =
	"pre-install check: 1 manifest(s) or package folder(s) aren't listed regular files whose script names can be read";
const npmrc = (count: number): string =>
	`pre-install check: ${count} .npmrc path(s) in the root or a package folder; pnpm reads its settings from them`;
const PNPMFILE =
	"pre-install check: 1 .pnpmfile.cjs or .pnpmfile.mjs path(s) in the root; pnpm runs them during an install";
const GYP =
	"pre-install check: 1 binding.gyp path(s) in the root or a package folder; an install builds them";
const WORKSPACE_LINE =
	"pre-install check: the workspace file isn't a listed regular file in the approved form";
const PNPM_FIELD =
	"pre-install check: the root manifest has a pnpm field, whose settings can change what an install runs";

// Counts only: no path separator, no fixture name and no reserved word in any line.
const countsOnly = (lines: readonly string[]): boolean =>
	lines.every((line) => !/[/\\]|alpha|beta|ignored|joined/.test(line) && scrub(line) === line);

describe("the pre-install check", () => {
	it("passes an inert checkout with one count line, --names or not", async () => {
		for (const argv of [[], ["--names"]]) {
			const { code, lines, calls } = await run(argv);
			expect([code, lines]).toEqual([0, [PASSED]]);
			expect(calls).toEqual(["listCheckout <repo>", "checkout <repo>", "packageDirs"]);
		}
	});

	it.each([
		[
			"a postinstall in an ordinary package",
			{ files: { "spikes/alpha/package.json": manifest({ postinstall: "x" }) } },
			hooks(1, 1),
		],
		[
			"a postinstall in the root manifest",
			{ files: { "package.json": manifest({ postinstall: "x" }) } },
			hooks(1, 1),
		],
		[
			"a postinstall in the allowed root's manifest",
			{ files: { [HELD_MANIFEST]: manifest({ test: "x", postinstall: "x" }) } },
			allowed(1),
		],
		[
			"an unknown script name in the allowed root's manifest",
			{ files: { [HELD_MANIFEST]: manifest({ test: "x", lint: "x" }) } },
			allowed(1),
		],
		[
			"a pnpm key in the root manifest",
			{ files: { "package.json": manifest({ test: "x" }, { pnpm: {} }) } },
			PNPM_FIELD,
		],
		[
			"an ignored package folder holding a package.json",
			{
				files: { "spikes/ignored/package.json": manifest({ postinstall: "x" }) },
				ignore: ["/spikes/ignored/"],
				refused: [{ rel: "spikes/ignored", kind: "unlisted" }],
			},
			MANIFESTS,
		],
		["a junction package folder", { refused: [{ rel: "spikes/joined", kind: "link" }] }, MANIFESTS],
		[".npmrc in the root", { files: { ".npmrc": "ignore-scripts=false\n" } }, npmrc(1)],
		[".npmrc in a package folder", { files: { "tools/beta/.npmrc": "x\n" } }, npmrc(1)],
		[".npmrc in the allowed root", { files: { [`${HELD}/.npmrc`]: "x\n" } }, npmrc(1)],
		[".pnpmfile.cjs", { files: { ".pnpmfile.cjs": "module.exports = {};\n" } }, PNPMFILE],
		[".pnpmfile.mjs", { files: { ".pnpmfile.mjs": "export default {};\n" } }, PNPMFILE],
		["binding.gyp in a package folder", { files: { "spikes/alpha/binding.gyp": "{}\n" } }, GYP],
		[
			"an unapproved workspace file",
			{ files: { "pnpm-workspace.yaml": `${WORKSPACE}enablePrePostScripts: true\n` } },
			WORKSPACE_LINE,
		],
	] as const)("refuses %s, with a count line and the stop line", async (_, change, line) => {
		const { code, lines } = await run([], change as Change);
		expect([code, lines.map(scrub)]).toEqual([1, [line, INSTALL_STOP_LINE]]);
		expect(countsOnly(lines)).toBe(true);
	});

	it("stops on a listing problem with its lines and the stop line once, checking nothing", async () => {
		const repo = checkout();
		const cases: (readonly ListingProblem[])[] = [
			[{ kind: "git", code: 128 }],
			[{ kind: "toplevel" }],
			[
				{ kind: "unmerged", paths: ["spikes/alpha/package.json"] },
				{ kind: "nested", paths: ["tools/beta/"] },
			],
		];
		for (const problems of cases) {
			for (const listing of [null, listingOf(repo)]) {
				const { value, lines, calls } = deps(repo, {}, { listing, problems });
				expect(await preinstallMain([], repo.dir, value)).toBe(1);
				expect(lines).toEqual([...listingLines(problems), START_STOP_LINE]);
				expect(lines.every((line) => line.startsWith("reserved tripwire: "))).toBe(true);
				expect(countsOnly(lines)).toBe(true);
				expect(calls).toEqual(["listCheckout <repo>"]);
			}
		}
		const named = deps(repo, {}, { listing: null, problems: cases[2] ?? [] });
		expect(await preinstallMain(["--names"], repo.dir, named.value)).toBe(1);
		expect(named.lines).toEqual([...listingLines(cases[2] ?? [], true), START_STOP_LINE]);
	});

	it("stops when the checkout can't be listed at all", async () => {
		const repo = checkout();
		const { value, lines, calls } = deps(repo);
		const failing: PreinstallDeps = {
			...value,
			listCheckout: async () => {
				throw new Error(`git: ${repo.dir}`);
			},
		};
		expect(await preinstallMain([], repo.dir, failing)).toBe(1);
		expect(lines).toEqual([
			"pre-install check: the checkout couldn't be listed; nothing was checked",
			INSTALL_STOP_LINE,
		]);
		expect(calls).toEqual([]);
	});

	it("prints counts only; --names adds paths and hook names, never the allowed root's script names", async () => {
		const change: Change = {
			files: {
				"package.json": manifest({ test: "x", prepare: "x" }, { pnpm: {} }),
				"spikes/alpha/package.json": manifest({ postinstall: "x" }),
				[HELD_MANIFEST]: manifest({ test: "x", "held-only": "x", preinstall: "x" }),
				".npmrc": "x\n",
				"spikes/alpha/binding.gyp": "{}\n",
			},
			refused: [{ rel: "spikes/joined", kind: "link" }],
		};
		const counted = await run([], change);
		expect([counted.code, counted.lines.map(scrub)]).toEqual([
			1,
			[npmrc(1), GYP, MANIFESTS, PNPM_FIELD, hooks(2, 2), allowed(2), INSTALL_STOP_LINE],
		]);
		expect(countsOnly(counted.lines)).toBe(true);
		const named = await run(["--names"], change);
		expect([named.code, named.lines.map(scrub)]).toEqual([
			1,
			[
				`${npmrc(1)}: .npmrc`,
				`${GYP}: spikes/alpha/binding.gyp`,
				`${MANIFESTS}: spikes/joined`,
				`${PNPM_FIELD}: package.json`,
				`${hooks(2, 2)}: package.json (prepare), spikes/alpha/package.json (postinstall)`,
				`${allowed(2)}: ${scrub(HELD_MANIFEST)}`,
				INSTALL_STOP_LINE,
			],
		]);
		// The allowed root's script names, a hook among them, appear in no line.
		expect(named.lines.some((line) => /held-only|preinstall/.test(line))).toBe(false);
	});

	it("reads the allowed root's manifest only through openAllowedManifest, and no unlisted file", async () => {
		const reads: string[] = [];
		class Watched extends Checkout {
			override readText(rel: string): string | "unreadable" {
				const text = super.readText(rel);
				reads.push(`readText ${scrub(rel)}${text === "unreadable" ? " unreadable" : ""}`);
				return text;
			}
			override openAllowedManifest(rel: string): string | "unreadable" {
				const text = super.openAllowedManifest(rel);
				reads.push(
					`openAllowedManifest ${scrub(rel)}${text === "unreadable" ? " unreadable" : ""}`,
				);
				return text;
			}
		}
		const repo = checkout({
			files: { "tools/beta/package.json": manifest({ postinstall: "x" }) },
			ignore: ["/tools/beta/package.json"],
		});
		const spy = readerSpy(repo.dir, (rel) => rel === "tools/beta/package.json");
		const { value, lines } = deps(repo);
		const watched: PreinstallDeps = {
			...value,
			checkout: (root) => new Watched(root, spy.fs, { allowedRoots: [`${HELD}/`] }),
		};
		expect(await preinstallMain([], repo.dir, watched)).toBe(1);
		expect(lines).toEqual([MANIFESTS, INSTALL_STOP_LINE]);
		const held = scrub(HELD_MANIFEST);
		expect(reads).toEqual([
			"readText pnpm-workspace.yaml",
			"readText package.json",
			"readText spikes/alpha/package.json",
			`readText ${held} unreadable`,
			`openAllowedManifest ${held}`,
		]);
		// One open of the allowed root's manifest, the one openAllowedManifest made, and none of the
		// unlisted manifest.
		expect(spy.opens.filter((rel) => rel === held)).toEqual([held]);
		expect(spy.refused).toEqual([]);
	});

	it("checks the folder --root names, resolved from the working folder", async () => {
		const repo = checkout();
		const other = checkout({ files: { ".npmrc": "x\n" } });
		const { value, lines, calls } = deps(other);
		expect(await preinstallMain(["--root", other.dir], repo.dir, value)).toBe(1);
		expect(lines).toEqual([npmrc(1), INSTALL_STOP_LINE]);
		expect(calls).toEqual(["listCheckout <repo>", "checkout <repo>", "packageDirs"]);
		const relative = deps(repo, {}, { listing: null, problems: [{ kind: "toplevel" }] });
		expect(await preinstallMain(["--root", "elsewhere"], repo.dir, relative.value)).toBe(1);
		expect(relative.calls).toEqual([`listCheckout ${path.resolve("elsewhere")}`]);
	});

	it("prints its usage for --help, and exits 2 on a bad argument before anything is listed", async () => {
		const usage = "usage: node tools/verify/preinstall.ts [--names] [--root <dir>] [--help]";
		const repo = checkout();
		for (const [argv, code] of [
			[["--help"], 0],
			[["--bogus"], 2],
			[["stray"], 2],
			[["--root"], 2],
			[["--root", ""], 2],
			[["--", "--names", "x"], 2],
		] as const) {
			const { value, lines, calls } = deps(repo);
			expect([argv, await preinstallMain(argv, repo.dir, value)]).toEqual([argv, code]);
			expect([argv, lines.at(-1), calls]).toEqual([argv, usage, []]);
		}
		const passed = deps(repo);
		expect(await preinstallMain(["--", "--names"], repo.dir, passed.value)).toBe(0);
	});

	it("never runs pnpm or reads the opt-in flag: it starts no process and names neither", () => {
		for (const file of ["preinstall.ts", "lib/hooks.ts"]) {
			const text = readFileSync(path.join(verify, file), "utf8");
			const loads = runtimeSpecifiers(text).map((literal) => literal.value);
			expect([file, loads.filter((value) => value.includes("child_process"))]).toEqual([file, []]);
			expect([file, /RESERVED_TESTS|reservedTestsOn/.test(text)]).toEqual([file, false]);
		}
	});
});

// --- the check with its real modules, and as a command in temp checkouts without node_modules ---

const ENTRY = [
	"tools/verify/preinstall.ts",
	"tools/verify/lib/bootstrap.ts",
	...HELPERS.preinstall,
];
const TREE: Readonly<Record<string, string>> = {
	"package.json": manifest({ build: "x", test: "x" }, { type: "module" }),
	"pnpm-workspace.yaml": WORKSPACE,
	"spikes/alpha/package.json": manifest({ test: "x", postcss: "x" }),
	"tools/beta/package.json": manifest({ prettier: "x" }),
};
const CLI_PASSED =
	"pre-install check: 3 manifest(s) and the workspace file checked; no install hook found";
const START_LINES = [
	"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
	START_STOP_LINE,
];

// A checkout holding TREE and `files`, and with `entry` the check's own files, committed.
function synthetic(files: Readonly<Record<string, string>> = {}, entry = true): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	if (entry) copyOwn(repo, ENTRY);
	for (const [file, text] of Object.entries({ ...TREE, ...files })) repo.write(file, text);
	repo.commit();
	return repo;
}

async function command(repo: TempRepo, args: readonly string[] = [], cwd = repo.dir) {
	const script = path.join(repo.dir, "tools", "verify", "preinstall.ts");
	const result = await capture(
		{ command: process.execPath, args: [script, ...args] },
		{ cwd, env: gitEnvOf(repo) },
	);
	const lines = result.stdout.split(/\r?\n/).filter(Boolean).map(scrub);
	return { code: result.code, lines, stderr: result.stderr };
}

describe("the pre-install check with its real listing and package folders", () => {
	const real = (repo: TempRepo): PreinstallDeps & { lines: string[] } => {
		const lines: string[] = [];
		return {
			lines,
			print: (line) => lines.push(line),
			listCheckout: (root) => listCheckout(root, { env: gitEnvOf(repo) }),
			packageDirs,
			checkout: (root) => new Checkout(root),
		};
	};

	it("passes a synthetic checkout and refuses a hook in one of its packages", async () => {
		const clean = synthetic({}, false);
		const passing = real(clean);
		expect(await preinstallMain([], clean.dir, passing)).toBe(0);
		expect(passing.lines).toEqual([CLI_PASSED]);
		const hooked = synthetic({ "tools/beta/package.json": manifest({ postinstall: "x" }) }, false);
		const refusing = real(hooked);
		expect(await preinstallMain([], hooked.dir, refusing)).toBe(1);
		expect(refusing.lines).toEqual([hooks(1, 1), INSTALL_STOP_LINE]);
	});

	it("refuses an ignored package folder that pnpm would still read", async () => {
		const repo = synthetic({}, false);
		repo.ignore("/spikes/gamma/");
		repo.write("spikes/gamma/package.json", manifest({ postinstall: "x" }));
		const deps = real(repo);
		expect(await preinstallMain([], repo.dir, deps)).toBe(1);
		expect(deps.lines).toEqual([MANIFESTS, INSTALL_STOP_LINE]);
	});
});

describe("node tools/verify/preinstall.ts", () => {
	it("passes a clean checkout with one count line, without node_modules", async () => {
		const repo = synthetic();
		expect(existsSync(path.join(repo.dir, "node_modules"))).toBe(false);
		expect(await command(repo)).toEqual({ code: 0, lines: [CLI_PASSED], stderr: "" });
	});

	it("refuses a finding with its count line and the stop line, and names paths only with --names", async () => {
		const repo = synthetic({ "spikes/alpha/package.json": manifest({ postinstall: "x" }) });
		const plain = await command(repo);
		expect(plain).toEqual({ code: 1, lines: [hooks(1, 1), INSTALL_STOP_LINE], stderr: "" });
		expect(countsOnly(plain.lines)).toBe(true);
		const named = await command(repo, ["--names"]);
		expect(named.code).toBe(1);
		expect(named.lines[0]).toBe(`${hooks(1, 1)}: spikes/alpha/package.json (postinstall)`);
	});

	it("stops at its start check: a helper folder replaced by a junction, and an unlisted helper", async () => {
		const linked = synthetic();
		const copy = path.join(linked.outside, "lib");
		mkdirSync(copy);
		for (const rel of ENTRY.filter((file) => file.startsWith("tools/verify/lib/"))) {
			const text = readFileSync(path.join(linked.dir, rel));
			writeFileSync(path.join(copy, path.posix.basename(rel)), text);
		}
		rmSync(path.join(linked.dir, "tools", "verify", "lib"), { recursive: true });
		linked.link("tools/verify/lib", copy, "junction");
		expect(await command(linked)).toEqual({ code: 1, lines: START_LINES, stderr: "" });

		const unlisted = synthetic();
		unlisted.git("rm", "-q", "--cached", "--", "tools/verify/lib/hooks.ts");
		unlisted.ignore("tools/verify/lib/hooks.ts");
		expect(await command(unlisted)).toEqual({ code: 1, lines: START_LINES, stderr: "" });
	});

	it("checks a second checkout with --root and its own helpers, and refuses a --root that isn't a toplevel", async () => {
		const repo = synthetic();
		const other = synthetic({}, false);
		expect(await command(repo, ["--root", other.dir])).toEqual({
			code: 0,
			lines: [CLI_PASSED],
			stderr: "",
		});
		other.write(".npmrc", "x\n");
		other.commit();
		expect(await command(repo, ["--root", other.dir])).toEqual({
			code: 1,
			lines: [npmrc(1), INSTALL_STOP_LINE],
			stderr: "",
		});
		expect(await command(repo, ["--root", "spikes"], other.dir)).toEqual({
			code: 1,
			lines: [
				"reserved tripwire: git listed another checkout than this one; nothing was checked",
				START_STOP_LINE,
			],
			stderr: "",
		});
		const none = await command(repo, ["--root", other.outside]);
		expect(none.code).toBe(1);
		expect(none.lines.at(-1)).toBe(START_STOP_LINE);
	});
});
