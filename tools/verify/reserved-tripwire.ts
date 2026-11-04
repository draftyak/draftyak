import path from "node:path";
import { lowerCaseReserved, reservedWord } from "../../reserved-tests.ts";
import { literals } from "./lib/imports.ts";

export { ALLOWED_DOCS, ALLOWED_ROOTS } from "./lib/allowed.ts";

// The tree rules G1 to G7, G8a, G9, G10a and G10b, each path and config anchored where its tool
// reads it. tripwire() is pure: the gate (lib/gate.ts) hands it the index, the untracked files git
// doesn't ignore and a reader for the ordinary files it has kind-checked. It never asks for a
// reserved-named file or anything in an allowed root, and never reads DRAFTYAK_RESERVED_TESTS, so
// opting in never relaxes it. Its lines name no path or reserved word unless names is set.

const posix = path.posix;

export interface IndexEntry {
	readonly mode: string;
	// Below the repository root, with / separators.
	readonly path: string;
}

// A git listing that exited non-zero: nothing is checked.
export interface GitFailure {
	readonly gitExit: number;
}

export interface TreeInput {
	// git ls-files -s.
	readonly entries: readonly IndexEntry[] | GitFailure;
	// git ls-files -o --exclude-standard.
	readonly untracked: readonly string[] | GitFailure;
	readonly text: (rel: string) => string | "unreadable" | "absent";
	readonly allowedRoots: readonly string[];
	readonly allowedDocs: readonly string[];
	// The rules to run, for the mutation tests; every rule unless set.
	readonly rules?: readonly TripwireKind[];
}

export type TripwireKind = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8a" | "G9" | "G10a";

export interface TripwireCounts {
	readonly paths: number;
	readonly untracked: number;
	readonly cargo: number;
	readonly rust: number;
	readonly modules: number;
}

export interface CheckCounts extends TripwireCounts {
	readonly folders: number;
}

export interface Problems {
	// What each rule found, sorted: paths, and lockfile lines as <file>:<line>.
	readonly found: Readonly<Record<TripwireKind, readonly string[]>>;
	readonly gitExit: number | null;
	readonly checked: TripwireCounts;
}

// Every rule, in the order their lines print.
export const TRIPWIRE_RULES: readonly TripwireKind[] = Object.freeze([
	"G1",
	"G2",
	"G3",
	"G4",
	"G5",
	"G6",
	"G7",
	"G8a",
	"G9",
	"G10a",
]);
const TRIPWIRE = "reserved tripwire:";
const COUNTED: Readonly<Record<TripwireKind, string>> = {
	G1: "path(s) name a reserved word outside the allowed reserved roots, or spell it in upper case",
	G2: "Rust or Cargo file(s) have a reserved name; no reserved Rust may land, in an allowed root or elsewhere",
	G3: 'Cargo file(s) contain "reserved"; no Cargo feature whose name contains it may be defined or enabled',
	G4: 'Rust source(s) use a cfg named "reserved"',
	G5: "ordinary Rust or Cargo file(s) name a reserved word in a string or Cargo value",
	G6: "ordinary file(s) point at a reserved path or into an allowed reserved root",
	G7: "allowed reserved root(s) or document(s) fail the integrity check",
	G8a: "tracked symlink(s) or submodule(s); none may be tracked",
	G9: "lockfile line(s) link a reserved package into an ordinary one",
	G10a: "file(s) or folder(s) couldn't be read; nothing about them was checked",
};
export const STOP_LINE: string = `${TRIPWIRE} stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.`;

// One count line per rule that found something, in rule order, then the stop line once; nothing for
// a clean tree. names appends what each rule found, for the reserved files' maintainer.
export function tripwireLines(problems: Problems, names: boolean): string[] {
	const lines: string[] = [];
	for (const kind of TRIPWIRE_RULES) {
		const found = problems.found[kind];
		if (found.length === 0) continue;
		const line = `${TRIPWIRE} ${found.length} ${COUNTED[kind]}`;
		lines.push(names ? `${line}: ${found.join(", ")}` : line);
	}
	if (problems.gitExit !== null) {
		lines.push(`${TRIPWIRE} git exited ${problems.gitExit}; nothing was checked`);
	}
	if (lines.length > 0) lines.push(STOP_LINE);
	return lines;
}

// The gate's success line; the folders come from its own walks.
export function checkLine(counts: CheckCounts): string {
	return `reserved check: ${counts.paths} path(s), ${counts.untracked} untracked file(s), ${counts.folders} folder(s), ${counts.cargo} Cargo file(s), ${counts.rust} Rust source(s) and ${counts.modules} module(s) and config(s) checked, with their folders, references and scanned folders; no problem found in them`;
}

const REGULAR = new Set(["100644", "100755"]);
const LINKS = new Set(["120000", "160000"]);
const WORKSPACE = "pnpm-workspace.yaml";
const ROOT_LOCKFILE = "pnpm-lock.yaml";

const fold = (text: string): string => text.toLowerCase();
const dirOf = (file: string): string => {
	const dir = posix.dirname(file);
	return dir === "." ? "" : dir;
};
const dotted = (file: string): boolean =>
	file.split("/").some((part) => part === "." || part === "..");

export type FileKind =
	| "cargo"
	| "cargo-lock"
	| "rust"
	| "config"
	| "manifest"
	| "tsconfig"
	| "turbo"
	| "lockfile"
	| "html"
	| "module";

const RUNNER_CONFIG = /^(?:vitest\.config|vite\.config|vitest\.workspace)\.[^/]+$/;
const TSCONFIG = /^(?:tsconfig[^/]*|jsconfig)\.json$/;
const MODULE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The rules that read a file, by its name in any case. rustup follows a toolchain file's path, so
// its text gets the Cargo text rules.
export function fileKind(file: string): FileKind | null {
	const name = fold(posix.basename(file));
	const folder = fold(posix.basename(posix.dirname(file)));
	if (name === "cargo.toml" || name === "deny.toml") return "cargo";
	if (folder === ".cargo" && (name === "config" || name === "config.toml")) return "cargo";
	if (name === "rust-toolchain" || name === "rust-toolchain.toml") return "cargo";
	if (name === "cargo.lock") return "cargo-lock";
	if (name.endsWith(".rs")) return "rust";
	if (RUNNER_CONFIG.test(name)) return "config";
	if (name === "package.json") return "manifest";
	if (TSCONFIG.test(name)) return "tsconfig";
	if (name === "turbo.json") return "turbo";
	if (name === ROOT_LOCKFILE) return "lockfile";
	if (/\.html?$/.test(name)) return "html";
	if (MODULE.test(name)) return "module";
	return null;
}

// Rule 2's file kinds, in any case: Windows checkouts read cargo.toml too.
function rustNamed(file: string): boolean {
	const parts = fold(file).split("/");
	const name = parts.at(-1) ?? "";
	return (
		name.endsWith(".rs") ||
		name === "cargo.toml" ||
		name === "cargo.lock" ||
		name.startsWith("rust-toolchain") ||
		parts.slice(0, -1).includes(".cargo")
	);
}

function byKind<T>(make: (kind: TripwireKind) => T): Record<TripwireKind, T> {
	return {
		G1: make("G1"),
		G2: make("G2"),
		G3: make("G3"),
		G4: make("G4"),
		G5: make("G5"),
		G6: make("G6"),
		G7: make("G7"),
		G8a: make("G8a"),
		G9: make("G9"),
		G10a: make("G10a"),
	};
}

export function tripwire(input: TreeInput): Problems {
	const { entries, untracked, allowedRoots, allowedDocs } = input;
	const found = byKind(() => new Set<string>());
	const checked = { paths: 0, untracked: 0, cargo: 0, rust: 0, modules: 0 };
	const result = (gitExit: number | null): Problems => ({
		found: byKind((kind) => [...found[kind]].toSorted()),
		gitExit,
		checked: { ...checked },
	});
	if ("gitExit" in entries) return result(entries.gitExit);
	if ("gitExit" in untracked) return result(untracked.gitExit);
	const enabled = new Set(input.rules ?? TRIPWIRE_RULES);
	// What G10a found, whether it runs or not: G7 leaves an unreadable workspace file to it.
	const unread = new Set<string>();
	const add = (kind: TripwireKind, item: string): void => {
		if (kind === "G10a") unread.add(item);
		if (enabled.has(kind)) found[kind].add(item);
	};

	const modes = new Map<string, string>();
	for (const entry of entries) if (!modes.has(entry.path)) modes.set(entry.path, entry.mode);
	const loose = [...new Set(untracked)].filter((file) => !modes.has(file));
	const paths = [...modes.keys(), ...loose];
	checked.paths = modes.size;
	checked.untracked = loose.length;

	// Rules 1, 2 and 8: names and modes only.
	for (const file of paths) {
		if (fold(posix.basename(file)) === "turbo.jsonc") add("G6", file);
		if (!reservedWord.test(file)) continue;
		const permitted =
			allowedRoots.some((root) => root.endsWith("/") && file.startsWith(root)) ||
			allowedDocs.includes(file);
		if (!permitted || !lowerCaseReserved(file)) add("G1", file);
		if (rustNamed(file)) add("G2", file);
	}
	for (const [file, mode] of modes) {
		if (LINKS.has(mode)) add("G8a", file);
		else if (!REGULAR.has(mode)) add("G10a", file);
	}

	// Content: only regular, ordinary files, each read at most once.
	const roots = allowedRoots.map((root) => (root.endsWith("/") ? root : `${root}/`));
	const ordinary = (file: string): boolean =>
		!reservedWord.test(file) && !roots.some((root) => fold(file).startsWith(fold(root)));
	const readable = new Set(
		paths.filter((file) => ordinary(file) && REGULAR.has(modes.get(file) ?? "100644")),
	);
	const texts = new Map<string, string | null>();
	const read = (file: string): string | null => {
		const known = texts.get(file);
		if (known !== undefined) return known;
		let text: string | null = null;
		if (readable.has(file)) {
			const got = input.text(file);
			if (got === "unreadable") add("G10a", file);
			else if (got !== "absent") {
				text = got;
				const kind = fileKind(file);
				if (kind === "cargo" || kind === "cargo-lock") checked.cargo++;
				else if (kind === "rust") checked.rust++;
				else checked.modules++;
			}
		}
		texts.set(file, text);
		return text;
	};
	const objects = new Map<string, JsonObject | null>();
	const object = (file: string): JsonObject | null => {
		const known = objects.get(file);
		if (known !== undefined) return known;
		const text = read(file);
		const json = text === null ? undefined : parseJson(text);
		const value = isObject(json) ? json : null;
		if (text !== null && value === null) add("G10a", file);
		objects.set(file, value);
		return value;
	};

	// Rule 7: the allowed set against the workspace.
	const workspace = read(WORKSPACE);
	const globs = workspace === null ? null : packageGlobs(workspace);
	if (globs === null && !unread.has(WORKSPACE)) add("G7", WORKSPACE);
	for (const root of allowedRoots) {
		if (!rootIntact(root, globs, paths, modes)) add("G7", root);
	}
	for (const doc of allowedDocs) {
		if (!/^docs\/(?:[\w.-]+\/)*[\w.-]+\.md$/.test(doc) || dotted(doc)) add("G7", doc);
	}

	// Ordinary workspace packages by name, for turbo's pkg#task references.
	const packages = new Map<string, string>();
	const packageDirs: string[] = [];
	const rootName = nameOf(readable.has("package.json") ? object("package.json") : null);
	if (rootName !== null) packages.set(rootName, "");
	for (const file of readable) {
		const dir = dirOf(file);
		if (posix.basename(file) !== "package.json" || globs === null || !inWorkspace(dir, globs)) {
			continue;
		}
		packageDirs.push(dir);
		const name = nameOf(object(file));
		if (name !== null && !packages.has(name)) packages.set(name, dir);
	}

	const reach: Reach = (value, anchor) => reaches(value, anchor, roots);
	for (const file of readable) {
		const kind = fileKind(file);
		const dir = dirOf(file);
		if (kind === "cargo" || kind === "cargo-lock") {
			const text = read(file);
			if (text === null) continue;
			if (kind === "cargo" && /reserved/i.test(text)) add("G3", file);
			if (reservedWord.test(text)) add("G5", file);
		} else if (kind === "rust") {
			const text = read(file);
			if (text === null) continue;
			const source = rustSource(text);
			if (cfgReserved(source)) add("G4", file);
			if (source.strings.some((value) => reservedWord.test(value))) add("G5", file);
		} else if (kind === "lockfile") {
			const text = read(file);
			if (text === null) continue;
			const own = file === ROOT_LOCKFILE ? roots.map((root) => root.slice(0, -1)) : [];
			for (const line of lockLines(text, own)) add("G9", `${file}:${line}`);
		} else if (kind === "module" || kind === "config" || kind === "html") {
			const text = read(file);
			if (text === null) continue;
			const points =
				kind === "module"
					? moduleReaches(text, dir, reach)
					: kind === "config"
						? configReaches(text, dir, reach)
						: htmlReaches(text, dir, reach);
			if (points) add("G6", file);
		} else if (kind === "manifest" || kind === "tsconfig" || kind === "turbo") {
			const json = object(file);
			if (json === null) continue;
			let points: boolean;
			if (kind === "manifest") points = manifestReaches(json, dir, reach);
			else if (kind === "tsconfig") points = tsconfigReaches(json, dir, reach);
			else points = turboReaches(json, { dir, packages, anchors: packageDirs, reach });
			if (points) add("G6", file);
		}
	}
	return result(null);
}

// pnpm-workspace.yaml's packages: list, read with reserved-tests.ts's workspaceGlobs grammar; null
// where that throws.
const PACKAGE_LINE = /^ {2}- ((?:\w[\w.-]*\/)*\w[\w.-]*(?:\/\*)?)$/;
function packageGlobs(text: string): string[] | null {
	if (/\r(?!\n)/.test(text)) return null;
	const lines = text
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.map((line) => line.replace(/[ \t]+$/, ""))
		.filter((line) => !/^[ \t]*(?:#|$)/.test(line));
	const start = lines.indexOf("packages:");
	if (start < 0 || lines.lastIndexOf("packages:") !== start) return null;
	const globs: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (!/^[ \t]/.test(line)) break;
		const glob = PACKAGE_LINE.exec(line)?.[1];
		if (glob === undefined) return null;
		globs.push(glob);
	}
	return globs.length === 0 ? null : globs;
}

function inWorkspace(dir: string, globs: readonly string[]): boolean {
	return globs.some((glob) =>
		glob.endsWith("/*") ? dir !== "" && dirOf(dir) === glob.slice(0, -2) : dir === glob,
	);
}

// An allowed root is a reserved-named folder that a <parent>/* glob makes a workspace package; once
// it holds anything, its own package.json is tracked.
const ROOT = /^((?:[\w.-]+\/)*[\w.-]+)\/([\w.-]+)\/$/;
function rootIntact(
	root: string,
	globs: readonly string[] | null,
	paths: readonly string[],
	modes: ReadonlyMap<string, string>,
): boolean {
	const match = ROOT.exec(root);
	if (match === null || dotted(root) || globs === null) return false;
	const [, parent = "", name = ""] = match;
	if (!reservedWord.test(name) || !globs.includes(`${parent}/*`)) return false;
	if (!paths.some((file) => file.startsWith(root))) return true;
	return REGULAR.has(modes.get(`${root}package.json`) ?? "");
}

// --- pointers (rule 6) ---

// Whether a value from an ordinary file names a reserved word or, used as a path from anchor (a
// folder below the root, "" for the root itself; null for a name that isn't a path), could reach
// into an allowed root, as a path or a glob. field says where the value came from; rule 6 doesn't
// use it, the gate's reference checks do.
type Reach = (value: string, anchor: string | null, field: string) => boolean;

// A value one of rule 6's readers takes for a pointer, with its anchor and its field: module:<kind>
// for a module's literals (lib/imports.ts's kinds), config, html, manifest:<field> (manifest:local
// for the path of a link:, file: or portal: spec) and tsconfig:<key>.
export interface Pointer {
	readonly value: string;
	readonly anchor: string | null;
	readonly field: string;
}

// Every pointer rule 6 reads in an ordinary module, Vitest or Vite config, HTML file, package.json
// or tsconfig, each once, in the order it reads them; null for any other file, and "unparsable"
// for JSON it can't parse. The gate's reference checks follow these; tripwire() never calls this.
export function pointersOf(file: string, text: string): readonly Pointer[] | "unparsable" | null {
	const kind = fileKind(file);
	const found: Pointer[] = [];
	const seen = new Set<string>();
	const collect: Reach = (value, anchor, field) => {
		const key = JSON.stringify([value, anchor, field]);
		if (!seen.has(key)) found.push({ value, anchor, field });
		seen.add(key);
		return false;
	};
	const dir = dirOf(file);
	if (kind === "module") moduleReaches(text, dir, collect);
	else if (kind === "config") configReaches(text, dir, collect);
	else if (kind === "html") htmlReaches(text, dir, collect);
	else if (kind === "manifest" || kind === "tsconfig") {
		const json = parseJson(text);
		if (!isObject(json)) return "unparsable";
		if (kind === "manifest") manifestReaches(json, dir, collect);
		else tsconfigReaches(json, dir, collect);
	} else return null;
	return found;
}

const ABSOLUTE = /^(?:[A-Za-z][A-Za-z\d+.-]*:|[\\/])/;
// biome-ignore lint/suspicious/noTemplateCurlyInString: lib/imports.ts's placeholder for a template's computed part.
const COMPUTED = "${}";
// A computed part could be anything, which a check by literals can't follow: it matches no
// folder.
const OPAQUE = "\uE001";

function reaches(value: string, anchor: string | null, roots: readonly string[]): boolean {
	if (reservedWord.test(value)) return true;
	if (anchor === null || ABSOLUTE.test(value)) return false;
	const alternatives = expandBraces(value.replaceAll(COMPUTED, OPAQUE).replaceAll("\\", "/"));
	if (alternatives === null) return roots.length > 0;
	return alternatives.some((alternative) => {
		const target = resolved(anchor, alternative);
		if (target === null) return roots.length > 0;
		return reservedWord.test(target.join("/")) || roots.some((root) => enters(target, root));
	});
}

// anchor joined with a relative path or glob, with . and .. resolved; null where .. follows **,
// which could climb anywhere.
function resolved(anchor: string, relative: string): string[] | null {
	const parts: string[] = [];
	for (const part of [...anchor.split("/"), ...relative.split("/")]) {
		if (part === "" || part === ".") continue;
		const last = parts.at(-1);
		if (part !== "..") parts.push(part);
		else if (last === "**") return null;
		else if (last === undefined || last === "..") parts.push(part);
		else parts.pop();
	}
	return parts;
}

// Whether the path or glob in parts can match the root folder or anything below it.
function enters(parts: readonly string[], root: string): boolean {
	for (const [index, folder] of root.split("/").filter(Boolean).entries()) {
		const part = parts[index];
		if (part === undefined) return false;
		if (part === "**") return true;
		if (!partMatches(part, folder)) return false;
	}
	return true;
}

// An extglob such as !(a) or @(a|b), a POSIX class such as [[:alpha:]] or a brace range such as
// {a..c}: any name, rather than parsing it.
const ANY_NAME = /[@!+*?]\(|\[:|\{[^{}]*\.\.[^{}]*\}/;

// One path segment of a glob against a folder name, in any case (Windows and macOS fold it).
function partMatches(pattern: string, name: string): boolean {
	if (ANY_NAME.test(pattern)) return true;
	if (!/[*?[]/.test(pattern)) return fold(pattern) === fold(name);
	let source = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] ?? "";
		if (c === "*") source += ".*";
		else if (c === "?") source += ".";
		else if (c === "[" && pattern.indexOf("]", i + 2) > 0) {
			const close = pattern.indexOf("]", i + 2);
			const body = pattern.slice(i + 1, close);
			const negated = body.startsWith("!") || body.startsWith("^");
			source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&")}]`;
			i = close;
		} else source += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	try {
		return new RegExp(`^${source}$`, "is").test(name);
	} catch {
		return true;
	}
}

// Brace alternatives, {a,b} and nested; null past 256 of them.
function expandBraces(text: string): string[] | null {
	let results = [text];
	for (;;) {
		const next: string[] = [];
		let expanded = false;
		for (const item of results) {
			const span = braceSpan(item);
			if (span === null) {
				next.push(item);
				continue;
			}
			expanded = true;
			for (const alternative of span.alternatives) {
				next.push(`${item.slice(0, span.start)}${alternative}${item.slice(span.end)}`);
			}
			if (next.length > 256) return null;
		}
		if (!expanded) return next;
		results = next;
	}
}

// The first {…} with a comma at its own level.
function braceSpan(
	text: string,
): { readonly start: number; readonly end: number; readonly alternatives: string[] } | null {
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let from = start + 1;
		const alternatives: string[] = [];
		for (let i = start; i < text.length; i++) {
			const c = text[i];
			if (c === "{") depth++;
			else if (c === "," && depth === 1) {
				alternatives.push(text.slice(from, i));
				from = i + 1;
			} else if (c === "}") {
				depth--;
				if (depth > 0) continue;
				alternatives.push(text.slice(from, i));
				if (alternatives.length > 1) return { start, end: i + 1, alternatives };
				break;
			}
		}
	}
	return null;
}

const relativeLiteral = (value: string): boolean =>
	value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");
const withoutQuery = (value: string): string => value.replace(/[?#].*$/s, "");

// A module: what it imports, loads or resolves, and every literal relative to its folder, whatever
// call it is in. Other strings, such as root-anchored data, aren't pointers.
function moduleReaches(text: string, dir: string, reach: Reach): boolean {
	return literals(text).some(({ value, kind }) => {
		const field = `module:${kind}`;
		if (relativeLiteral(value)) {
			return reach(value, dir, field) || reach(withoutQuery(value), dir, field);
		}
		return kind !== "other" && reach(value, null, field);
	});
}

// A Vitest or Vite config: every string, anchored at its folder.
function configReaches(text: string, dir: string, reach: Reach): boolean {
	return literals(text).some(
		({ value }) => reach(value, dir, "config") || reach(withoutQuery(value), dir, "config"),
	);
}

const ATTRIBUTE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
function htmlReaches(text: string, dir: string, reach: Reach): boolean {
	for (const match of text.matchAll(ATTRIBUTE)) {
		const value = match[1] ?? match[2] ?? match[3] ?? "";
		const local = withoutQuery(value.replace(/^\/+/, ""));
		if (reach(value, null, "html") || reach(local, dir, "html")) return true;
	}
	return false;
}

const ENTRY_FIELDS = new Set([
	"main",
	"module",
	"types",
	"typings",
	"bin",
	"browser",
	"exports",
	"imports",
]);
const DEPENDENCY_FIELDS = new Set([
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
	"peerDependenciesMeta",
	"bundleDependencies",
	"bundledDependencies",
	"overrides",
	"resolutions",
]);
const LOCAL_SPEC = /^(?:link|file|portal):(.*)$/s;

// package.json: entry points, dependency names and specs, and script tokens, at its package. A
// token reads as a path when it starts with a dot or a ~, which the shell expands to a home folder,
// or holds a separator.
function manifestReaches(json: JsonObject, dir: string, reach: Reach): boolean {
	return json.object.some(([field, value]) => {
		if (ENTRY_FIELDS.has(field)) {
			return someString(value, (text, key) => reach(text, key ? null : dir, `manifest:${field}`));
		}
		if (DEPENDENCY_FIELDS.has(field)) {
			return someString(value, (text, key) => {
				if (key) return reach(text, null, "manifest:dependency");
				const local = LOCAL_SPEC.exec(text)?.[1];
				return local === undefined
					? reach(text, text.startsWith(".") ? dir : null, "manifest:dependency")
					: reach(local, dir, "manifest:local");
			});
		}
		if (field === "scripts") {
			return someString(value, (text, key) =>
				key
					? reach(text, null, "manifest:scripts")
					: text
							.split(/[\s"'`;&|()<>,=]+/)
							.some(
								(token) =>
									token !== "" &&
									reach(token, /^[.~]|[\\/]/.test(token) ? dir : null, "manifest:scripts"),
							),
			);
		}
		return false;
	});
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: tsconfig's placeholder for its own folder.
const CONFIG_DIR = "${configDir}";
// A types entry names a package, or a path when it starts like one: relative, from a slash or
// from a drive.
const TYPES_PATH = /^(?:\.\.?(?:[\\/]|$)|[\\/]|[A-Za-z]:)/;

// tsconfig: the keys through which tsc reaches files, at its folder. tsc reads paths from there
// too, as it no longer reads baseUrl; a tool that still does would take them from baseUrl, so they
// are read from both.
function tsconfigReaches(json: JsonObject, dir: string, reach: Reach): boolean {
	const at =
		(anchor: string | null, key: string) =>
		(text: string): boolean =>
			reach(text.replaceAll(CONFIG_DIR, "."), anchor, `tsconfig:${key}`);
	for (const [key, value] of json.object) {
		const values = stringsIn(value);
		if (key === "extends") {
			if (values.some((text) => at(text.startsWith(".") ? dir : null, key)(text))) return true;
		} else if (key === "files" || key === "include" || key === "references") {
			if (values.some(at(dir, key))) return true;
		} else if (key === "compilerOptions" && isObject(value)) {
			const bases = value.object
				.filter(([option]) => option === "baseUrl")
				.flatMap(([, setting]) => stringsIn(setting))
				.map((base) => base.replaceAll(CONFIG_DIR, "."));
			const anchors = [
				dir,
				...bases.map((base) => (ABSOLUTE.test(base) ? null : posix.join(dir || ".", base))),
			];
			for (const [option, setting] of value.object) {
				if (option === "baseUrl" || option === "rootDirs" || option === "typeRoots") {
					if (stringsIn(setting).some(at(dir, option))) return true;
				} else if (option === "types") {
					const hit = stringsIn(setting).some((text) =>
						at(TYPES_PATH.test(text.replaceAll(CONFIG_DIR, ".")) ? dir : null, option)(text),
					);
					if (hit) return true;
				} else if (option === "paths") {
					const hit = someString(setting, (text, alias) =>
						alias
							? reach(text, null, "tsconfig:paths")
							: anchors.some((anchor) => at(anchor, option)(text)),
					);
					if (hit) return true;
				}
			}
		}
	}
	return false;
}

interface TurboScope {
	// The turbo.json's own folder: "" for the root's.
	readonly dir: string;
	readonly packages: ReadonlyMap<string, string>;
	// Every ordinary workspace package folder, where the root's tasks run.
	readonly anchors: readonly string[];
	readonly reach: Reach;
}

const TURBO_ROOT = "$TURBO_ROOT$/";
// Only these leave the turbo.json check: hashing inputs, env names and the schema.
const TURBO_EXEMPT = new Set([
	"$schema",
	"globalDependencies",
	"globalEnv",
	"globalPassThroughEnv",
]);
const TASK_EXEMPT = new Set(["inputs", "env", "passThroughEnv"]);

// turbo.json: every key but the exempt ones. Globs anchor at the package whose task they belong to
// ($TURBO_ROOT$ and the root's //#tasks at the root), and dependsOn and with may name only ordinary
// workspace packages, since turbo runs those tasks even in a package a filter left out.
function turboReaches(json: JsonObject, scope: TurboScope): boolean {
	const { dir, packages, anchors, reach } = scope;
	const outside = (ref: string): boolean => {
		if (reach(ref, null, "turbo")) return true;
		const hash = ref.indexOf("#");
		if (hash < 0) return false;
		const name = ref.slice(ref.startsWith("^") ? 1 : 0, hash);
		return name !== "//" && !packages.has(name);
	};
	const glob = (value: string, from: readonly string[]): boolean => {
		if (value.startsWith(TURBO_ROOT)) return reach(value.slice(TURBO_ROOT.length), "", "turbo");
		if (value.startsWith("!") || from.length === 0) return reach(value, null, "turbo");
		return from.some((anchor) => reach(value, anchor, "turbo"));
	};
	const anyReaches = (value: Json, from: readonly string[]): boolean =>
		someString(value, (text, key) => (key ? reach(text, null, "turbo") : glob(text, from)));
	const taskAnchors = (task: string): readonly string[] => {
		if (dir !== "") return [dir];
		const hash = task.indexOf("#");
		if (hash < 0) return anchors;
		const name = task.slice(0, hash);
		const at = name === "//" ? "" : packages.get(name);
		return at === undefined ? anchors : [at];
	};
	for (const [key, value] of json.object) {
		if (TURBO_EXEMPT.has(key)) continue;
		if (key === "extends") {
			if (!Array.isArray(value) || value.length !== 1 || value[0] !== "//") return true;
		} else if ((key === "tasks" || key === "pipeline") && isObject(value)) {
			for (const [task, config] of value.object) {
				if (outside(task)) return true;
				const from = taskAnchors(task);
				if (!isObject(config)) {
					if (anyReaches(config, from)) return true;
					continue;
				}
				for (const [option, setting] of config.object) {
					if (TASK_EXEMPT.has(option)) continue;
					const hit =
						option === "dependsOn" || option === "with"
							? someString(setting, (text) => outside(text))
							: reach(option, null, "turbo") || anyReaches(setting, from);
					if (hit) return true;
				}
			}
		} else if (reach(key, null, "turbo") || anyReaches(value, [dir])) return true;
	}
	return false;
}

// --- lockfile (rule 9) ---

const IMPORTER_KEY = /^ {2}(['"]?)(.+)\1:(?: \{\})?[ \t]*$/;

// The lines that name a reserved word, other than an allowed root's own importer key.
function lockLines(text: string, own: readonly string[]): number[] {
	const lines: number[] = [];
	let importers = false;
	for (const [index, raw] of text.split("\n").entries()) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (/^\S/.test(line)) importers = line.trimEnd() === "importers:";
		if (!reservedWord.test(line)) continue;
		const key = importers ? IMPORTER_KEY.exec(line)?.[2] : undefined;
		if (key === undefined || !own.includes(key)) lines.push(index + 1);
	}
	return lines;
}

// --- Rust (rules 4 and 5) ---

// A Rust source with comments dropped and each string literal (plain, raw, byte or C) replaced by
// its index between two of these, and the literals' values with escapes cooked.
const HOLE = "\uE000";
const HOLES = /\uE000(\d+)\uE000/g;

interface RustSource {
	readonly code: string;
	readonly strings: readonly string[];
}

const IDENT = /[A-Za-z0-9_]/;
const CHAR = /'(?:\\(?:u\{[0-9A-Fa-f_]{1,8}\}|x[0-9A-Fa-f]{2}|[^\n\r])|[^\\'\n\r])'/uy;

function rustSource(text: string): RustSource {
	let code = "";
	const strings: string[] = [];
	const hole = (value: string): void => {
		code += ` ${HOLE}${strings.push(value) - 1}${HOLE} `;
	};
	let i = text.startsWith("#!") && !/^#!\s*\[/.test(text) ? lineEnd(text, 0) : 0;
	while (i < text.length) {
		const c = text[i] ?? "";
		const next = text[i + 1] ?? "";
		if (c === "/" && next === "/") i = lineEnd(text, i);
		else if (c === "/" && next === "*") {
			i = commentEnd(text, i);
			code += " ";
		} else if (c === '"') {
			const literal = cooked(text, i + 1);
			hole(literal.value);
			i = literal.end;
		} else if (c === "'") {
			// A char, or else a lifetime or label.
			const end = charEnd(text, i);
			code += end < 0 ? c : " '' ";
			i = end < 0 ? i + 1 : end;
		} else if (/[A-Za-z_]/.test(c)) {
			let j = i + 1;
			while (j < text.length && IDENT.test(text[j] ?? "")) j++;
			const word = text.slice(i, j);
			const after = text[j] ?? "";
			const raw =
				["r", "br", "cr"].includes(word) && `"#`.includes(after) ? rawString(text, j) : null;
			if (raw !== null) {
				hole(raw.value);
				i = raw.end;
			} else if ((word === "b" || word === "c") && after === '"') {
				const literal = cooked(text, j + 1);
				hole(literal.value);
				i = literal.end;
			} else if (word === "b" && after === "'" && charEnd(text, j) > 0) {
				code += " '' ";
				i = charEnd(text, j);
			} else if (word === "r" && after === "#") {
				// A raw identifier, r#name: the name follows.
				i = j + 1;
			} else {
				code += word;
				i = j;
			}
		} else {
			code += c;
			i++;
		}
	}
	return { code, strings };
}

function lineEnd(text: string, from: number): number {
	const end = text.indexOf("\n", from);
	return end < 0 ? text.length : end;
}

// Where the block comment starting at text[start] ends; Rust's nest.
function commentEnd(text: string, start: number): number {
	let depth = 0;
	for (let i = start; i < text.length - 1; i++) {
		const pair = text.slice(i, i + 2);
		if (pair === "/*") {
			depth++;
			i++;
		} else if (pair === "*/") {
			depth--;
			i++;
			if (depth === 0) return i + 1;
		}
	}
	return text.length;
}

function charEnd(text: string, at: number): number {
	CHAR.lastIndex = at;
	const match = CHAR.exec(text);
	return match === null ? -1 : at + match[0].length;
}

const RUST_ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t", "0": "\0" };

// A plain, byte or C string from just after its opening quote: its value and where it ends.
function cooked(text: string, start: number): { readonly value: string; readonly end: number } {
	let value = "";
	let i = start;
	while (i < text.length) {
		const c = text[i] ?? "";
		if (c === '"') return { value, end: i + 1 };
		if (c !== "\\") {
			value += c;
			i++;
			continue;
		}
		const escaped = text[i + 1] ?? "";
		const hex = /^[0-9A-Fa-f]{2}$/.exec(text.slice(i + 2, i + 4))?.[0];
		const unicode = /^\{([0-9A-Fa-f_]{1,8})\}/.exec(text.slice(i + 2, i + 13));
		if (escaped === "\n" || escaped === "\r") {
			i += 2;
			while (/[ \t\n\r]/.test(text[i] ?? "")) i++;
		} else if (escaped === "x" && hex !== undefined) {
			value += String.fromCharCode(Number.parseInt(hex, 16));
			i += 4;
		} else if (escaped === "u" && unicode !== null) {
			const point = Number.parseInt((unicode[1] ?? "").replaceAll("_", ""), 16);
			if (point <= 0x10ffff) value += String.fromCodePoint(point);
			i += 2 + unicode[0].length;
		} else {
			value += RUST_ESCAPES[escaped] ?? escaped;
			i += 2;
		}
	}
	return { value, end: text.length };
}

// A raw string from its first # or quote after the prefix (r, br or cr); null for r#name.
function rawString(
	text: string,
	at: number,
): { readonly value: string; readonly end: number } | null {
	let hashes = 0;
	while (text[at + hashes] === "#") hashes++;
	if (text[at + hashes] !== '"') return null;
	const close = `"${"#".repeat(hashes)}`;
	const start = at + hashes + 1;
	const end = text.indexOf(close, start);
	return end < 0
		? { value: text.slice(start), end: text.length }
		: { value: text.slice(start, end), end: end + close.length };
}

const CFG = /(?<![A-Za-z0-9_])(?:cfg_attr|cfg)\s*(?:!\s*)?\(/g;
const CARGO_CFG = /rustc-(?:check-)?cfg/i;
const RESERVED_AT_WORD_START = /(?<![a-z])reserved/i;

// Rule 4: "reserved" at a word start inside #[cfg(…)], cfg!(…) or cfg_attr(…) (cfg_if!'s arms are
// #[cfg]s), across lines, or after a build script's rustc-cfg or rustc-check-cfg in its statement.
function cfgReserved({ code, strings }: RustSource): boolean {
	const filled = (part: string): string =>
		part.replace(HOLES, (_, index: string) => ` ${strings[Number(index)] ?? ""} `);
	for (const match of code.matchAll(CFG)) {
		const open = match.index + match[0].length - 1;
		if (RESERVED_AT_WORD_START.test(filled(code.slice(open + 1, closingParen(code, open))))) {
			return true;
		}
	}
	for (const [index, value] of strings.entries()) {
		const at = value.search(CARGO_CFG);
		if (at < 0) continue;
		const hole = `${HOLE}${index}${HOLE}`;
		const from = code.indexOf(hole) + hole.length;
		const end = code.indexOf(";", from);
		const rest = filled(code.slice(from, end < 0 ? code.length : end));
		if (RESERVED_AT_WORD_START.test(value.slice(at)) || RESERVED_AT_WORD_START.test(rest)) {
			return true;
		}
	}
	return false;
}

function closingParen(code: string, open: number): number {
	let depth = 0;
	for (let i = open; i < code.length; i++) {
		if (code[i] === "(") depth++;
		else if (code[i] === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return code.length;
}

// --- JSON ---

// An object keeps every entry in order, a repeated key included, so no value hides behind a later
// one with the same key.
export interface JsonObject {
	readonly object: readonly (readonly [string, Json])[];
}
export type Json = string | number | boolean | null | readonly Json[] | JsonObject;

export const isObject = (value: Json | undefined): value is JsonObject =>
	typeof value === "object" && value !== null && "object" in value;

// Calls visit on every key and string inside value; true as soon as one call is.
function someString(value: Json, visit: (text: string, key: boolean) => boolean): boolean {
	if (typeof value === "string") return visit(value, false);
	if (typeof value !== "object" || value === null) return false;
	if ("object" in value) {
		return value.object.some(([key, inner]) => visit(key, true) || someString(inner, visit));
	}
	return value.some((inner) => someString(inner, visit));
}

function stringsIn(value: Json): string[] {
	const found: string[] = [];
	someString(value, (text, key) => {
		if (!key) found.push(text);
		return false;
	});
	return found;
}

function nameOf(manifest: JsonObject | null): string | null {
	const names = (manifest?.object ?? []).filter(([key]) => key === "name").map(([, name]) => name);
	const last = names.at(-1);
	return typeof last === "string" ? last : null;
}

class Unparsable extends Error {}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_ESCAPES: Readonly<Record<string, string>> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

// JSON with comments and trailing commas, as tsconfig and turbo.json allow; undefined if it doesn't
// parse.
export function parseJson(text: string): Json | undefined {
	let at = text.startsWith("\uFEFF") ? 1 : 0;
	const space = (): void => {
		for (;;) {
			const c = text[at];
			if (c === " " || c === "\t" || c === "\n" || c === "\r") at++;
			else if (c === "/" && text[at + 1] === "/") at = lineEnd(text, at);
			else if (c === "/" && text[at + 1] === "*") {
				const end = text.indexOf("*/", at + 2);
				if (end < 0) throw new Unparsable();
				at = end + 2;
			} else return;
		}
	};
	const string = (): string => {
		let value = "";
		at++;
		for (;;) {
			const c = text[at];
			if (c === undefined) throw new Unparsable();
			if (c === '"') {
				at++;
				return value;
			}
			if (c !== "\\") {
				value += c;
				at++;
				continue;
			}
			const escaped = text[at + 1] ?? "";
			const hex = /^[0-9A-Fa-f]{4}$/.exec(text.slice(at + 2, at + 6))?.[0];
			if (escaped === "u" && hex !== undefined) {
				value += String.fromCharCode(Number.parseInt(hex, 16));
				at += 6;
			} else {
				const simple = JSON_ESCAPES[escaped];
				if (simple === undefined) throw new Unparsable();
				value += simple;
				at += 2;
			}
		}
	};
	const value = (depth: number): Json => {
		if (depth > 256) throw new Unparsable();
		space();
		const c = text[at];
		if (c === "{" || c === "[") {
			at++;
			const close = c === "{" ? "}" : "]";
			const entries: [string, Json][] = [];
			const items: Json[] = [];
			space();
			while (text[at] !== close) {
				if (c === "{") {
					if (text[at] !== '"') throw new Unparsable();
					const key = string();
					space();
					if (text[at] !== ":") throw new Unparsable();
					at++;
					entries.push([key, value(depth + 1)]);
				} else items.push(value(depth + 1));
				space();
				if (text[at] === ",") {
					at++;
					space();
				} else if (text[at] !== close) throw new Unparsable();
			}
			at++;
			return c === "{" ? { object: entries } : items;
		}
		if (c === '"') return string();
		for (const [word, literal] of [
			["true", true],
			["false", false],
			["null", null],
		] as const) {
			if (text.startsWith(word, at)) {
				at += word.length;
				return literal;
			}
		}
		NUMBER.lastIndex = at;
		const number = NUMBER.exec(text)?.[0];
		if (number === undefined) throw new Unparsable();
		at += number.length;
		return Number(number);
	};
	try {
		const parsed = value(0);
		space();
		return at === text.length ? parsed : undefined;
	} catch (error) {
		if (error instanceof Unparsable) return undefined;
		throw error;
	}
}

// Not a command: the gate runs these rules, after checking its own files.
if (import.meta.main) {
	console.error("reserved-tripwire.ts: a module, not a command; run node tools/verify/gate.ts");
	process.exitCode = 2;
}
