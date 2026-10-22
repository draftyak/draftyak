import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// A test file whose path below the repository root names a reserved word runs only when
// DRAFTYAK_RESERVED_TESTS is exactly 1: the maintainer's runs, CI's opt-in steps and the
// branch sync. Vitest's configs, the spike kit and tools/verify all read it here. It imports
// only node: built-ins, so it loads before pnpm install.
export const RESERVED_TESTS = "DRAFTYAK_RESERVED_TESTS";

const words: readonly string[] = ["siwc", "dynamic-agent"];
// "-" stands for either separator: dynamic-agent and dynamic_agent.
export const reservedWord: RegExp = new RegExp(
	words.map((word) => word.replaceAll("-", "[-_]")).join("|"),
	"i",
);

// Vitest matches globs case-sensitively against paths below its root or --dir. A class per letter
// covers every case and keeps the words themselves out of Vitest's "exclude:" diagnostics.
const anyCase = (word: string): string =>
	[...word].map((c) => (c === "-" ? "[-_]" : `[${c.toLowerCase()}${c.toUpperCase()}]`)).join("");
export const reservedGlobs: readonly string[] = Object.freeze(
	words.flatMap((word) => [`**/*${anyCase(word)}*/**`, `**/*${anyCase(word)}*`]),
);

// Biome's globs match case-sensitively and take no character class, so biome.json leaves out each
// lower-case spelling (!**/*<spelling>*); every tracked reserved path spells the words that way.
export const reservedSpellings: readonly string[] = Object.freeze(
	words.flatMap((word) => (word.includes("-") ? [word, word.replaceAll("-", "_")] : [word])),
);
export const biomeNegations: readonly string[] = Object.freeze(
	reservedSpellings.map((word) => `!**/*${word}*`),
);
export function lowerCaseReserved(file: string): boolean {
	const rest = reservedSpellings.reduce((text, word) => text.replaceAll(word, ""), file);
	return !reservedWord.test(rest);
}

const shown = (value: string): string =>
	value.length <= 16 && !reservedWord.test(value)
		? JSON.stringify(value)
		: `a ${value.length}-character value`;

// The value a child process gets: Windows names are case-insensitive, and a plain copy of
// process.env keeps the case a name was stored in.
function flagValue(env: NodeJS.ProcessEnv): string | undefined {
	const direct = env[RESERVED_TESTS];
	if (direct !== undefined || process.platform !== "win32") return direct;
	const entry = Object.entries(env).find(
		([key, value]) => key.toUpperCase() === RESERVED_TESTS && value !== undefined,
	);
	return entry?.[1];
}

// Unset is off and exactly "1" is on. Any other value (empty, 0, true, " 1") is refused: no accidental
// value turns reserved tests on, and a typo isn't silently off either.
export function reservedTestsOn(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = flagValue(env);
	if (value === undefined) return false;
	if (value === "1") return true;
	throw new Error(`${RESERVED_TESTS} must be unset (off) or exactly 1 (on), not ${shown(value)}`);
}

// Env entries that leave the flag out of a child process, in whatever case Windows stored it.
export function withoutReservedTests(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const keys = [RESERVED_TESTS, ...Object.keys(env)].filter(
		(key) => key.toUpperCase() === RESERVED_TESTS,
	);
	return Object.fromEntries(keys.map((key) => [key, undefined]));
}

const SEARCH_SETTING = "NoDefaultCurrentDirectoryInExePath";

// A child's env. On Windows, cmd.exe looks for a bare command name (git, node, pnpm) in the working
// folder before PATH unless this setting is present; any other spelling of it is dropped, so the
// child sees exactly this one. Other platforms never look there, so their env is returned as is.
export function windowsChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	if (process.platform !== "win32") return env;
	const kept = Object.entries(env).filter(
		([key]) => key.toUpperCase() !== SEARCH_SETTING.toUpperCase(),
	);
	return { ...Object.fromEntries(kept), [SEARCH_SETTING]: "1" };
}

const repoRoot: string = import.meta.dirname;

function below(file: string, root: string): string | null {
	const rel = path.relative(root, file);
	if (path.isAbsolute(rel)) return null;
	const slashed = rel.split(path.sep).join("/");
	return slashed === ".." || slashed.startsWith("../") ? null : slashed;
}

// The path below the repository root with / separators: "" for the root, null outside it.
export function repoPath(file: string, root: string = repoRoot): string | null {
	const direct = below(path.resolve(file), root);
	if (direct !== null) return direct;
	try {
		return below(realpathSync.native(file), realpathSync.native(root));
	} catch {
		return null;
	}
}

// Only the part below the repository root counts, so a checkout whose own folder name holds a word
// still runs its ordinary tests. A path outside the repository counts whole.
export function reservedPath(file: string, root: string = repoRoot): boolean {
	const rel = repoPath(file, root);
	return reservedWord.test(rel ?? path.resolve(file).split(path.sep).join("/"));
}

// Printed instead of a test run whose folder is reserved. It names no path or reserved word and
// carries no failure marker.
export const OFF_NOTICE: string =
	"tests below this folder are reserved and off by default; DRAFTYAK_RESERVED_TESTS=1 runs them";

export type TestTier = "unit" | "heavy" | "live" | "device";

// Each tier's test files, as Vitest's include globs (vitest.shared.ts re-exports them).
export const tierFiles: Readonly<Record<TestTier, string>> = {
	unit: "**/*.test.ts",
	heavy: "**/*.heavy.test.ts",
	live: "**/*.live.test.ts",
	device: "**/*.device.test.ts",
};

// A test file's tier, read from the tier globs: heavy, live and device before unit, whose glob
// matches theirs too. null for any other file. Paths use / separators.
export function testTier(
	file: string,
	files: Readonly<Record<TestTier, string>> = tierFiles,
): TestTier | null {
	for (const tier of ["heavy", "live", "device", "unit"] as const) {
		if (path.posix.matchesGlob(file, files[tier])) return tier;
	}
	return null;
}

const NO_PACKAGES = "pnpm-workspace.yaml has no readable packages: list";
// One packages: entry as the approved workspace file spells them (lib/workspace-policy.ts): a folder
// below the root, or a folder and /* for the package folders in it.
const PACKAGE_LINE = /^ {2}- ((?:\w[\w.-]*\/)*\w[\w.-]*(?:\/\*)?)$/;

// pnpm-workspace.yaml's packages: entries, such as "spikes/*". Comments, blank lines and trailing
// spaces aside, the list is every indented line after the one top-level "packages:" line. A missing
// file, a missing or empty list, or any line in it that isn't "  - <glob>" throws, so no caller
// reads a file it can't parse as a workspace without packages.
export function workspaceGlobs(root: string): string[] {
	let text: string;
	try {
		text = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
	} catch {
		throw new Error(NO_PACKAGES);
	}
	return workspaceGlobsOf(text);
}

// workspaceGlobs' parse of the file's text, for a caller that read it itself.
export function workspaceGlobsOf(text: string): string[] {
	if (/\r(?!\n)/.test(text)) throw new Error(NO_PACKAGES);
	const lines = text
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t]+$/, ""))
		.filter((line) => !/^[ \t]*(?:#|$)/.test(line));
	const start = lines.indexOf("packages:");
	if (start < 0 || lines.lastIndexOf("packages:") !== start) throw new Error(NO_PACKAGES);
	const globs: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!/^[ \t]/.test(line)) break;
		const glob = PACKAGE_LINE.exec(line)?.[1];
		if (glob === undefined) throw new Error(NO_PACKAGES);
		globs.push(glob);
	}
	if (globs.length === 0) throw new Error(NO_PACKAGES);
	return globs;
}

// The folders that hold workspace packages without being one ("spikes" for "spikes/*").
export function workspaceParents(root: string): string[] {
	return workspaceGlobs(root)
		.filter((glob) => glob.endsWith("/*"))
		.map((glob) => glob.slice(0, -2));
}

// Every workspace package folder below the root, as pnpm-workspace.yaml lists them.
export function workspacePackageDirs(root: string): string[] {
	const dirs: string[] = [];
	for (const glob of workspaceGlobs(root)) {
		const parent = glob.endsWith("/*") ? glob.slice(0, -2) : null;
		const candidates =
			parent === null
				? [glob]
				: existsSync(path.join(root, parent))
					? readdirSync(path.join(root, parent), { withFileTypes: true })
							.filter((entry) => entry.isDirectory())
							.map((entry) => `${parent}/${entry.name}`)
					: [];
		for (const dir of candidates) {
			if (existsSync(path.join(root, dir, "package.json"))) dirs.push(dir);
		}
	}
	return dirs.toSorted();
}

// Packages whose own folder is reserved: every file of theirs is the maintainer's.
export function reservedPackageDirs(root: string): string[] {
	return workspacePackageDirs(root).filter((dir) => reservedWord.test(dir));
}

export const TURBO_USAGE =
	"usage: node tools/verify/turbo.ts run <task>... [turbo options] [-- <task arguments>]";

// turbo's arguments for `turbo run`: unless the flag is on, every reserved package is left out
// (--filter=!./<dir>, before any `--`), so a default run never starts its tasks and nothing of
// theirs reaches a log. Anything but `run` is refused (turbo runs `turbo <task>` and `turbo watch`
// too, without these filters), and so is a refused flag value, before turbo starts.
export function reservedTurboArgs(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	root: string,
): string[] {
	if (args[0] !== "run") throw new Error(`only turbo run goes through here\n${TURBO_USAGE}`);
	if (reservedTestsOn(env)) return [...args];
	const filters = reservedPackageDirs(root).map((dir) => `--filter=!./${dir}`);
	const cut = args.indexOf("--");
	return cut < 0 ? [...args, ...filters] : [...args.slice(0, cut), ...filters, ...args.slice(cut)];
}

// `node reserved-tests.ts --reserved <path>`: exit 0 when the path below the repository root names a
// reserved word, 1 when not, and 2 for any other arguments. Workflows ask it, so their own text never
// spells a word.
if (import.meta.main) {
	const args = process.argv.slice(2);
	const file = args[1];
	if (args.length !== 2 || args[0] !== "--reserved" || !file) {
		console.error("usage: node reserved-tests.ts --reserved <path>");
		process.exitCode = 2;
	} else process.exitCode = reservedPath(file) ? 0 : 1;
}
