import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

// The start check every gated entry runs before it loads any helper. Each entry inlines START_CHECK
// and applies it to this file and its folders; checkStart then checks the entry as started and its
// HELPERS set. This file imports only node: built-ins.

// The source of `function startCheckLines(root, node): string[]`, copied verbatim into each entry
// between "// start check" and "// end start check". It refuses first an entry that Node started
// with code or options it loads before the entry's first line (node: the entry's execArgv and
// NODE_OPTIONS), then checks this file and its folders. It reaches node:fs and node:path through
// process.getBuiltinModule, so the copy needs none of its entry's imports.
export const START_CHECK: string = `function startCheckLines(
	root: string,
	node: { readonly execArgv: readonly string[]; readonly options: string | undefined },
): string[] {
	const nodeFs = process.getBuiltinModule("node:fs");
	const nodePath = process.getBuiltinModule("node:path");
	const fold = (file: string): string => {
		const slashed = file.split(nodePath.sep).join("/");
		if (process.platform === "win32") return slashed.toLowerCase();
		return process.platform === "darwin" ? slashed.normalize("NFC").toLowerCase() : slashed;
	};
	const stop =
		"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.";
	// Node runs these before an entry's first line: a module to preload, a loader, a startup
	// snapshot, or a config file that may name them. No check after that code can tell what it
	// reached, so the entry stops. NODE_OPTIONS splits as Node splits it: at spaces outside double
	// quotes, which it drops, and a backslash inside quotes takes the next character as it is. One
	// string, so no scan for import specifiers reads an option's name as one.
	const preloads = [
		"--require -r --import --loader --experimental-loader --snapshot-blob --config-file",
		"--experimental-config-file --experimental-default-config-file",
	]
		.join(" ")
		.split(" ");
	const words: string[] = [];
	const options = node.options ?? "";
	let quoted = false;
	let fresh = true;
	for (let index = 0; index < options.length; index++) {
		let char = options.charAt(index);
		if (char === String.fromCharCode(92) && quoted) char = options.charAt(++index);
		else if (char === " " && !quoted) {
			fresh = true;
			continue;
		} else if (char === '"') {
			quoted = !quoted;
			continue;
		}
		if (fresh) words.push(char);
		else words[words.length - 1] += char;
		fresh = false;
	}
	const loads = (arg: string): boolean =>
		preloads.includes((arg.split("=")[0] ?? "").replaceAll("_", "-"));
	if ([...node.execArgv, ...words].some(loads)) {
		return [
			"reserved tripwire: Node loaded code or options before this entry's first line (--require, --import, --loader, a startup snapshot or a config file, on its command line or in NODE_OPTIONS); nothing was checked",
			stop,
		];
	}
	const stopped = [
		"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
		stop,
	];
	// From the root's real path down: a link or 8.3 alias above the root changes nothing below it.
	let folder: string;
	try {
		folder = nodeFs.realpathSync.native(root);
	} catch {
		return stopped;
	}
	for (const [index, name] of ["tools", "verify", "lib", "bootstrap.ts"].entries()) {
		const at = nodePath.join(folder, name);
		let plain = false;
		try {
			const entry = nodeFs
				.readdirSync(folder, { withFileTypes: true })
				.find((item) => fold(item.name) === fold(name));
			const stat = nodeFs.lstatSync(at, { bigint: true });
			const kind = index === 3 ? stat.isFile() && stat.nlink === 1n : stat.isDirectory();
			plain =
				entry !== undefined &&
				!entry.isSymbolicLink() &&
				!stat.isSymbolicLink() &&
				kind &&
				fold(nodeFs.realpathSync.native(at)) === fold(at);
		} catch {
			plain = false;
		}
		if (!plain) return stopped;
		folder = at;
	}
	return [];
}`;

export type StartKind =
	| "file"
	| "dir"
	| "link"
	| "redirect"
	| "hardlink"
	| "special"
	| "missing"
	| "unreadable"
	| "unlisted";

export interface StartProblem {
	// Below the repository root, with / separators.
	readonly rel: string;
	readonly kind: StartKind;
}

// The calls checkStart makes: a structural subset of safe-fs.ts's FsOps.
export interface StartOps {
	lstat(file: string): {
		isFile(): boolean;
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
		nlink: bigint;
	};
	realpath(file: string): string;
	readdir(dir: string): readonly { name: string; isSymbolicLink(): boolean }[];
}

// checkStart's rules, each of which a mutation test removes on its own: the folder listing's link
// flag (and the name being in that listing at all), lstat's kind, realpath.native's answer, a file's
// link count, and git listing each helper.
export type StartRule = "listing-flag" | "lstat" | "realpath" | "nlink" | "git-listed";
export const START_RULES: readonly StartRule[] = Object.freeze([
	"listing-flag",
	"lstat",
	"realpath",
	"nlink",
	"git-listed",
]);

// The variables that make git act on another repository, index or working tree, or reinterpret a
// pathspec: spikes/kit/repo.ts's list, plus the two that move repository discovery.
export const GIT_REPO_VARS: readonly string[] = Object.freeze([
	...["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"],
	...["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_PREFIX", "GIT_NAMESPACE"],
	...["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_GRAFT_FILE"],
	...["GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE"],
	...["GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"],
	...["GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"],
]);

const RESERVED_TESTS = "DRAFTYAK_RESERVED_TESTS";
const OPTIONAL_LOCKS = "GIT_OPTIONAL_LOCKS";
const SEARCH_SETTING = "NoDefaultCurrentDirectoryInExePath";

// The environment for a git child: no DRAFTYAK_RESERVED_TESTS and no GIT_REPO_VARS name, in any
// case; GIT_OPTIONAL_LOCKS=0, and NoDefaultCurrentDirectoryInExePath=1 on Windows. The same as
// reserved-tests.ts's withoutReservedTests and windowsChildEnv, which this file can't import.
export function gitChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const windows = process.platform === "win32";
	const dropped = new Set(
		[RESERVED_TESTS, OPTIONAL_LOCKS, ...GIT_REPO_VARS, ...(windows ? [SEARCH_SETTING] : [])].map(
			(name) => name.toUpperCase(),
		),
	);
	const kept = Object.entries(env).filter(
		([name, value]) => value !== undefined && !dropped.has(name.toUpperCase()),
	);
	return {
		...Object.fromEntries(kept),
		[OPTIONAL_LOCKS]: "0",
		...(windows ? { [SEARCH_SETTING]: "1" } : {}),
	};
}

// The repository root, `depth` folders above an entry's own folder, as a real path (as given where
// it can't be resolved; the checks then fail).
export function realRoot(entryDir: string, depth: number): string {
	const up = path.resolve(entryDir, ...Array.from({ length: depth }, () => ".."));
	try {
		return realpathSync.native(up);
	} catch {
		return up;
	}
}

const nodeOps: StartOps = {
	lstat: (file) => lstatSync(file, { bigint: true }),
	realpath: (file) => realpathSync.native(file),
	readdir: (dir) => readdirSync(dir, { withFileTypes: true }),
};

// A path as the platform compares paths (safe-fs.ts's fold, which this file can't import).
function fold(file: string): string {
	const slashed = file.split(path.sep).join("/");
	if (process.platform === "win32") return slashed.toLowerCase();
	return process.platform === "darwin" ? slashed.normalize("NFC").toLowerCase() : slashed;
}

const missing = (error: unknown): boolean => {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
	return code === "ENOENT" || code === "ENOTDIR";
};

const below = (rel: string): boolean =>
	rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
const slashed = (rel: string): string => rel.split(path.sep).join("/");

// This file, which every entry's inline copy has checked before loading it; checkStart has git list
// it with the helpers.
const BOOTSTRAP = "tools/verify/lib/bootstrap.ts";

// Checks the entry as started (process.argv[1]) and each helper, with every folder from the root
// down, before any of them is loaded; nothing is read. A path whose folder failed is reported once,
// at the folder. The entry may sit below a link above the root (a junction to the checkout), as
// Checkout allows; below the root, every folder and file must be real.
export function checkStart(
	root: string,
	startedAs: string,
	helpers: readonly string[],
	options: {
		ops?: StartOps;
		listed?: (root: string, rels: readonly string[]) => readonly string[];
		env?: NodeJS.ProcessEnv;
		rules?: readonly StartRule[];
	} = {},
): readonly StartProblem[] {
	const ops = options.ops ?? nodeOps;
	const rules = new Set(options.rules ?? START_RULES);
	const problems = new Map<string, StartKind>();
	const listings = new Map<string, ReadonlyMap<string, boolean> | null>();
	const seen = new Map<string, StartKind | null>();

	const listing = (dir: string): ReadonlyMap<string, boolean> | null => {
		const known = listings.get(dir);
		if (known !== undefined) return known;
		let names: Map<string, boolean> | null = new Map();
		try {
			for (const entry of ops.readdir(dir)) {
				const name = fold(entry.name);
				names.set(name, names.get(name) === true || entry.isSymbolicLink());
			}
		} catch {
			names = null;
		}
		listings.set(dir, names);
		return names;
	};

	// One path whose folders passed: null when it is a real folder (or, last, a regular file).
	const classify = (segments: readonly string[], file: boolean): StartKind | null => {
		const full = path.join(root, ...segments);
		const names = listing(path.join(root, ...segments.slice(0, -1)));
		if (names === null) return "unreadable";
		const flagged = names.get(fold(segments.at(-1) ?? ""));
		if (rules.has("listing-flag") && flagged === true) return "link";
		let stat: ReturnType<StartOps["lstat"]>;
		try {
			stat = ops.lstat(full);
		} catch (error) {
			return missing(error) ? "missing" : "unreadable";
		}
		if (rules.has("lstat")) {
			if (stat.isSymbolicLink()) return "link";
			if (!stat.isFile() && !stat.isDirectory()) return "special";
			if (file && stat.isDirectory()) return "dir";
			if (!file && stat.isFile()) return "file";
		}
		if (rules.has("realpath")) {
			try {
				if (fold(ops.realpath(full)) !== fold(full)) return "redirect";
			} catch {
				return "unreadable";
			}
		}
		// Found by name but not in its folder's listing, as an 8.3 alias is.
		if (rules.has("listing-flag") && flagged === undefined) return "unreadable";
		if (file && rules.has("nlink") && stat.nlink !== 1n) return "hardlink";
		return null;
	};

	const check = (rel: string): void => {
		const segments = rel.split("/");
		for (let end = 1; end <= segments.length; end++) {
			const key = segments.slice(0, end).join("/");
			let kind = seen.get(key);
			if (kind === undefined) {
				kind = classify(segments.slice(0, end), end === segments.length);
				seen.set(key, kind);
			}
			if (kind !== null) {
				problems.set(key, kind);
				return;
			}
		}
	};

	// The entry below the root: lexically, or below the folder above it that resolves to the root.
	const entryRel = (): string | null => {
		const given = path.resolve(startedAs);
		const direct = path.relative(root, given);
		if (below(direct)) return slashed(direct);
		for (let dir = path.dirname(given); ; dir = path.dirname(dir)) {
			try {
				if (fold(ops.realpath(dir)) === fold(root)) {
					const rel = path.relative(dir, given);
					return below(rel) ? slashed(rel) : null;
				}
			} catch {}
			if (path.dirname(dir) === dir) return null;
		}
	};

	const entry = entryRel();
	if (entry === null)
		problems.set(slashed(path.relative(root, path.resolve(startedAs))), "redirect");
	else check(entry);
	for (const helper of helpers) check(helper);

	if (problems.size === 0 && rules.has("git-listed")) {
		// git matches the entry as its real path spells it, in whatever case it was started.
		let started = entry;
		try {
			if (entry !== null)
				started = slashed(path.relative(root, ops.realpath(path.join(root, entry))));
		} catch {}
		const wanted = [...new Set([BOOTSTRAP, ...(started === null ? [] : [started]), ...helpers])];
		const list = options.listed ?? gitListed(options.env ?? process.env);
		const listed = new Set(list(root, wanted).map(fold));
		for (const rel of wanted) if (!listed.has(fold(rel))) problems.set(rel, "unlisted");
	}
	return [...problems].map(([rel, kind]) => ({ rel, kind }));
}

const REGULAR = new Set(["100644", "100755"]);

// The rels git lists: in the index at stage 0 with a regular file's mode, or untracked and not
// ignored. A failing git lists nothing. Its error output is never printed.
function gitListed(env: NodeJS.ProcessEnv): (root: string, rels: readonly string[]) => string[] {
	return (root, rels) => {
		const run = (args: readonly string[]) =>
			spawnSync(
				"git",
				["--literal-pathspecs", "-c", "core.fsmonitor=false", ...args, "-z", "--", ...rels],
				{
					cwd: root,
					env: gitChildEnv(env),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
					maxBuffer: 64 * 1024 * 1024,
				},
			);
		const index = run(["ls-files", "-s"]);
		const others = run(["ls-files", "-o", "--exclude-standard"]);
		if (index.error || others.error || index.status !== 0 || others.status !== 0) return [];
		const listed: string[] = [];
		for (const record of index.stdout.split("\0")) {
			const tab = record.indexOf("\t");
			if (tab < 0) continue;
			const [mode = "", , stage = ""] = record.slice(0, tab).split(" ");
			if (stage === "0" && REGULAR.has(mode)) listed.push(record.slice(tab + 1));
		}
		for (const file of others.stdout.split("\0")) {
			if (file !== "" && !file.endsWith("/")) listed.push(file);
		}
		return listed;
	};
}

// reserved-tripwire.ts's STOP_LINE. This file keeps its own copy because it loads before the
// tripwire is checked.
export const START_STOP_LINE: string =
	"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.";

// The launcher marker: turbo.ts, verify.ts and reserved-proof.ts set it for their children, to the
// listing's root, only after a passing gate, and the kit trusts it when it names its own real root.
// lib/gate.ts re-exports it.
export const GATE_ROOT_ENV = "DRAFTYAK_GATE_ROOT";

// What an entry prints, before START_STOP_LINE, when its input gate throws instead of answering.
export const GATE_FAILED = "reserved tripwire: the input gate couldn't finish; nothing was checked";

// Nothing for no problem; otherwise one count line, then START_STOP_LINE. names adds each problem's
// path and kind to the count line, for the reserved files' maintainer.
export function startLines(problems: readonly StartProblem[], names = false): string[] {
	if (problems.length === 0) return [];
	const line = `reserved tripwire: ${problems.length} start file(s) or folder(s) failed their kind check; nothing was loaded`;
	const listed = problems.map(({ rel, kind }) => `${rel} (${kind})`).join(", ");
	return [names ? `${line}: ${listed}` : line, START_STOP_LINE];
}

const GATE = [
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
const SPAWN = ["tools/verify/lib/spawn.ts", "tools/verify/lib/tools.ts"];

// The helper files each entry checks with checkStart before it loads any of them, below the
// repository root.
export const HELPERS: Readonly<
	Record<
		| "gate"
		| "preinstall"
		| "proof"
		| "turbo"
		| "verify"
		| "prefetch"
		| "kitOff"
		| "kitGate"
		| "kitRun",
		readonly string[]
	>
> = Object.freeze({
	gate: Object.freeze([...GATE]),
	preinstall: Object.freeze([
		"tools/verify/lib/hooks.ts",
		"tools/verify/lib/listing.ts",
		"tools/verify/lib/safe-fs.ts",
		"tools/verify/lib/workspace-policy.ts",
		"tools/verify/lib/allowed.ts",
		"reserved-tests.ts",
	]),
	proof: Object.freeze([...GATE, "tools/verify/lib/proof.ts", ...SPAWN]),
	turbo: Object.freeze([...GATE, ...SPAWN]),
	verify: Object.freeze([
		...GATE,
		"tools/verify/lib/registry.ts",
		"tools/verify/lib/context.ts",
		...SPAWN,
	]),
	prefetch: Object.freeze([...GATE, "tools/verify/prefetch.ts", ...SPAWN]),
	kitOff: Object.freeze(["spikes/kit/off.ts", "reserved-tests.ts"]),
	// Checked before the kit starts the gate as a process of its own.
	kitGate: Object.freeze(["tools/verify/gate.ts"]),
	// Checked before runner.ts loads, under a gated launcher too.
	kitRun: Object.freeze(["spikes/kit/runner.ts", "spikes/kit/repo.ts", "spikes/kit/exec.ts"]),
});
