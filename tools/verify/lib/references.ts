import { reservedWord } from "../../../reserved-tests.ts";
import {
	fileKind,
	isObject,
	type Json,
	type JsonObject,
	parseJson,
	pointersOf,
} from "../reserved-tripwire.ts";
import { includeLiterals, modDecls } from "./rust-source.ts";
import { type Checkout, fold, type Kind } from "./safe-fs.ts";

// The inputs that listed files name: Rust modules and includes, Cargo's paths, relative and
// absolute module specifiers, the package.json a # specifier resolves through, and the paths
// package.json specs, scripts, entry points and imports maps (subpath patterns among them), tsconfig
// fields, Biome configs and HTML attributes give. A named file (a candidate) is only kind-checked,
// never read: one that exists must be a regular, listed file of the checkout, in real folders. A
// missing one is fine, as no tool can read it, except one whose path names a reserved word, which is
// refused either way. A path or glob that leaves the checkout (absolute elsewhere, climbing above the
// root on its way, even if it comes back in, or from a drive's own working folder) is refused as
// "outside", whether or not anything is there. Bare specifiers and names, which resolve to installed
// dependencies, aren't followed, and nothing below node_modules or .git is. A value that redirects a
// tool in a form these checks don't follow (a subpath pattern of another shape, a tsconfig paths
// pattern, moduleSuffixes, typesVersions, a glob import, a path with a name Windows trims, a Biome
// config from a package, a file: URL specifier, a toolchain path, a .cargo config key but paths and
// [patch]) is refused as "unsupported".

export type RefusedKind = Kind | "unlisted" | "reserved" | "unparsable" | "unsupported" | "outside";

export interface Refusal {
	// Below the repository root, with / separators.
	readonly rel: string;
	readonly kind: RefusedKind;
}

export type ReferenceCheck = "refs-rust" | "refs-cargo" | "refs-modules" | "refs-config";

export interface ReferenceInput {
	readonly checkout: Checkout;
	// Whether a path is listed: in the index, or untracked and not ignored.
	readonly listed: (rel: string) => boolean;
	// Whether a path is in the index.
	readonly tracked: (rel: string) => boolean;
	// The ordinary listed files that are regular files: the only files read here.
	readonly files: readonly string[];
	// A listed file's text, read through the checkout once; null where it can't be read.
	readonly text: (rel: string) => string | null;
	// The allowed reserved roots, each ending in "/": no walk here enters one.
	readonly allowedRoots: readonly string[];
}

const UNFOLLOWED = new Set(["node_modules", ".git"]);
const WINDOWS_DRIVE = /^[A-Za-z]:\//;
// Characters no path on every platform may hold, a glob's and a computed part's markers included.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters mark a value that isn't a path.
const NOT_A_PATH = /[\u0000-\u001f*?"<>|]|\$\{\}|\{[^{}]*,[^{}]*\}/;

// What resolveFrom gives for a value that leaves the checkout.
export const OUTSIDE: unique symbol = Symbol("outside");

// Whether a value, with / separators, is an absolute path: from a drive or from a slash.
export const absolutePath = (text: string): boolean =>
	WINDOWS_DRIVE.test(text) || text.startsWith("/");

// An absolute path's part below the checkout's root ("" for the root itself), or OUTSIDE.
export function belowRoot(checkout: Checkout, value: string): string | typeof OUTSIDE {
	const text = value.replaceAll("\\", "/");
	const root = fold(checkout.root.replaceAll("\\", "/")).replace(/\/$/, "");
	const folded = fold(text);
	if (folded !== root && !folded.startsWith(`${root}/`)) return OUTSIDE;
	return text.slice(root.length + 1);
}

// A name of dots and spaces alone, which Windows may read as no folder at all.
const BLANK_NAME = /^[. ]+$/;

// Whether a path or glob from folder `from` may leave the checkout: absolute elsewhere, or climbing
// above the root on its way. A ** and a name of dots and spaces may stand for no folder, and a part
// with a brace or an extglob that holds .. for a step up.
function leaves(checkout: Checkout, from: string, text: string): boolean {
	let parts: string[];
	if (absolutePath(text)) {
		const below = belowRoot(checkout, text);
		if (below === OUTSIDE) return true;
		parts = below.split("/");
	} else if (text.includes(":")) return false;
	else parts = [...from.split("/"), ...text.split("/")];
	let depth = 0;
	for (const part of parts) {
		if (part === ".." || (part.includes("..") && /[{}()|!@+]/.test(part))) depth--;
		else if (part !== "" && part !== "**" && !BLANK_NAME.test(part)) depth++;
		if (depth < 0) return true;
	}
	return false;
}

// The path a value names from folder `from` (below the root, "" for the root), with . and ..
// resolved, below the root with / separators; OUTSIDE for a path or glob that leaves the checkout;
// null for any other value that isn't a path, and for one below node_modules or .git.
export function resolveFrom(
	checkout: Checkout,
	from: string,
	value: string,
): string | typeof OUTSIDE | null {
	const text = value.replaceAll("\\", "/");
	if (text === "") return null;
	if (NOT_A_PATH.test(text)) return leaves(checkout, from, text) ? OUTSIDE : null;
	let parts: string[];
	if (absolutePath(text)) {
		const below = belowRoot(checkout, text);
		if (below === OUTSIDE) return OUTSIDE;
		parts = below.split("/");
	} else if (text.includes(":")) return null;
	else parts = [...from.split("/"), ...text.split("/")];
	const resolved: string[] = [];
	// The least depth a platform could give, and whether a name ends in a dot or a space, which
	// Windows trims: such a value isn't followed.
	let depth = 0;
	let trimmed = false;
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			resolved.pop();
			if (--depth < 0) return OUTSIDE;
			continue;
		}
		resolved.push(part);
		if (!BLANK_NAME.test(part)) depth++;
		if (/[. ]$/.test(part)) trimmed = true;
	}
	if (trimmed || resolved.some((part) => UNFOLLOWED.has(fold(part)))) return null;
	return resolved.join("/");
}

// A path from a drive's own working folder (C:x), which may lie anywhere.
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;
export const driveRelative = (value: string): boolean =>
	DRIVE_RELATIVE.test(value.replaceAll("\\", "/"));

// Why a value resolveFrom gave null for is still a path a tool would open, for the callers that
// refuse it rather than skip it: "outside" for one from a drive's own working folder, and
// "unsupported" for one with a name ending in a dot or a space, which Windows trims, so that it
// opens another file than the one named. null for any other value: a glob, a URL, a computed part,
// or a path below node_modules or .git.
export function unfollowedPath(
	checkout: Checkout,
	from: string,
	value: string,
): "outside" | "unsupported" | null {
	const text = value.replaceAll("\\", "/");
	if (DRIVE_RELATIVE.test(text)) return "outside";
	if (text === "" || NOT_A_PATH.test(text)) return null;
	let parts: string[];
	if (absolutePath(text)) {
		const below = belowRoot(checkout, text);
		if (below === OUTSIDE) return null;
		parts = below.split("/");
	} else if (text.includes(":")) return null;
	else parts = [...from.split("/"), ...text.split("/")];
	const trimmed = (part: string): boolean => part !== "." && part !== ".." && /[. ]$/.test(part);
	return parts.some(trimmed) ? "unsupported" : null;
}

// The candidates one check names, each checked once, and what it refused.
export class Candidates {
	readonly #checkout: Checkout;
	readonly #listed: (rel: string) => boolean;
	readonly #seen = new Set<string>();
	readonly refused: Refusal[] = [];

	constructor(checkout: Checkout, listed: (rel: string) => boolean) {
		this.#checkout = checkout;
		this.#listed = listed;
	}

	kindOf(rel: string): Kind {
		return this.#checkout.kindOf(rel);
	}

	// A file a reference names: fine when missing, or a regular, listed file.
	file(rel: string): void {
		if (!this.#first(`f:${rel}`) || this.#reserved(rel)) return;
		const kind = this.#checkout.kindOf(rel);
		if (kind === "missing" || (kind === "file" && this.#listed(rel))) return;
		this.refuse(rel, kind === "file" ? "unlisted" : kind);
	}

	// A folder a reference names: fine when missing; otherwise a real folder whose manifests, where
	// present, are regular, listed files. A file in its place is checked as one.
	folder(rel: string, manifests: readonly string[]): void {
		if (!this.#first(`d:${rel}`) || this.#reserved(rel)) return;
		const kind = this.#checkout.kindOf(rel);
		if (kind === "missing") return;
		if (kind === "file" || kind === "hardlink") this.file(rel);
		else if (kind !== "dir") this.refuse(rel, kind);
		else for (const name of manifests) this.file(rel === "" ? name : `${rel}/${name}`);
	}

	#first(key: string): boolean {
		if (this.#seen.has(key)) return false;
		this.#seen.add(key);
		return true;
	}

	#reserved(rel: string): boolean {
		if (!reservedWord.test(rel)) return false;
		this.refuse(rel, "reserved");
		return true;
	}

	refuse(rel: string, kind: RefusedKind): void {
		if (!this.refused.some((item) => item.rel === rel)) this.refused.push({ rel, kind });
	}
}

const dirOf = (file: string): string => {
	const cut = file.lastIndexOf("/");
	return cut < 0 ? "" : file.slice(0, cut);
};
const baseOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
const join = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

// What one check names, from the listed files it reads.
export function references(check: ReferenceCheck, input: ReferenceInput): Candidates {
	const candidates = new Candidates(input.checkout, input.listed);
	const read = (kinds: readonly string[], each: (file: string, text: string) => void): void => {
		for (const file of input.files) {
			if (!kinds.includes(fileKind(file) ?? "")) continue;
			const text = input.text(file);
			if (text !== null) each(file, text);
		}
	};
	const follow = {
		"refs-rust": [["rust"], rustRefs],
		"refs-cargo": [["cargo"], cargoRefs],
		"refs-modules": [["module", "config"], moduleRefs],
		"refs-config": [["manifest", "tsconfig", "html"], configRefs],
	} as const;
	const [kinds, refs] = follow[check];
	read(kinds, (file, text) => refs(input, candidates, file, text));
	if (check === "refs-config") {
		const seen = new Set<string>();
		for (const file of input.files) {
			if (BIOME_CONFIGS.has(baseOf(file).toLowerCase())) biomeRefs(input, candidates, file, seen);
		}
	}
	return candidates;
}

// --- Rust ---

// The files a non-inline mod declaration can load, per the Rust Reference: a mod-rs file (mod.rs, a
// crate root such as lib.rs, main.rs, build.rs or a test, or a file reached through #[path]) looks in
// its own folder, any other in a folder named for its module, through the inline modules around
// the declaration and their #[path] values. A file is read both ways unless it is a mod.rs, as only
// a crate's manifest says which files are crate roots.
function rustRefs(input: ReferenceInput, candidates: Candidates, file: string, text: string): void {
	const dir = dirOf(file);
	const name = baseOf(file);
	const stem = name.replace(/\.rs$/i, "");
	const bases = fold(name) === "mod.rs" ? [dir] : [dir, join(dir, stem)];
	const named = (from: string, value: string): void => {
		const rel = resolveFrom(input.checkout, from, value);
		if (rel === OUTSIDE) candidates.refuse(file, "outside");
		else if (rel !== null) candidates.file(rel);
		else {
			const why = unfollowedPath(input.checkout, from, value);
			if (why !== null) candidates.refuse(file, why);
		}
	};
	for (const decl of modDecls(text)) {
		if (decl.inline) continue;
		// A #[path] outside every inline module is relative to the file's own folder.
		let folders = decl.paths.length > 0 && decl.parents.length === 0 ? [dir] : bases;
		for (const parent of decl.parents) {
			const steps = parent.paths.length > 0 ? parent.paths : [parent.name];
			folders = folders.flatMap((folder) => steps.map((step) => join(folder, step)));
		}
		const leaves = decl.paths.length > 0 ? decl.paths : [`${decl.name}.rs`, `${decl.name}/mod.rs`];
		for (const folder of folders) for (const leaf of leaves) named(folder, leaf);
		// A module named with a reserved word is refused whether or not its file exists.
		if (decl.paths.length > 0 && reservedWord.test(decl.name)) named(dir, `${decl.name}.rs`);
	}
	for (const value of includeLiterals(text)) named(dir, value);
}

// --- TOML, for Cargo's files ---

export type Toml = string | number | boolean | Toml[] | TomlTable;
export interface TomlTable {
	[key: string]: Toml;
}

class Unparsable extends Error {}

const tableOf = (): TomlTable => Object.create(null) as TomlTable;
const isTable = (value: Toml | undefined): value is TomlTable =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// A table's own table at `key`, or null.
export function tableAt(table: TomlTable | null, key: string): TomlTable | null {
	const value = table?.[key];
	return isTable(value) ? value : null;
}

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const DATE_TIME =
	/\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?/y;
const NUMBER =
	/[+-]?(?:inf|nan)|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*|[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/y;
const TOML_ESCAPES: Readonly<Record<string, string>> = {
	b: "\b",
	t: "\t",
	n: "\n",
	f: "\f",
	r: "\r",
	e: "\u001b",
	'"': '"',
	"\\": "\\",
};

// TOML as Cargo reads it: every value kind, dotted and quoted keys, tables and arrays of tables,
// and inline tables and arrays across lines with a trailing comma. Dates read as their text. null
// where it doesn't parse, so nothing it names goes unchecked.
export function parseToml(source: string): TomlTable | null {
	const text = source.startsWith("﻿") ? source.slice(1) : source;
	let at = 0;
	const fail = (): never => {
		throw new Unparsable();
	};
	const space = (): void => {
		while (text[at] === " " || text[at] === "\t") at++;
	};
	const comment = (): void => {
		if (text[at] === "#") while (at < text.length && text[at] !== "\n") at++;
	};
	const newline = (): boolean => {
		if (text[at] === "\n") at++;
		else if (text[at] === "\r" && text[at + 1] === "\n") at += 2;
		else return false;
		return true;
	};
	const blank = (): void => {
		for (;;) {
			space();
			comment();
			if (!newline()) return;
		}
	};
	const lineEnd = (): void => {
		space();
		comment();
		if (at < text.length && !newline()) fail();
	};
	const hex = (length: number): string => {
		const digits = text.slice(at, at + length);
		if (!new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(digits)) fail();
		at += length;
		const point = Number.parseInt(digits, 16);
		return point <= 0x10ffff ? String.fromCodePoint(point) : fail();
	};
	const escapeAt = (): string => {
		const c = text[at + 1] ?? "";
		at += 2;
		if (c === "u") return hex(4);
		if (c === "U") return hex(8);
		if (c === "x") return hex(2);
		return TOML_ESCAPES[c] ?? fail();
	};
	const basic = (): string => {
		let value = "";
		at++;
		for (;;) {
			const c = text[at];
			if (c === undefined || c === "\n" || c === "\r") fail();
			if (c === '"') break;
			if (c === "\\") value += escapeAt();
			else {
				value += c;
				at++;
			}
		}
		at++;
		return value;
	};
	const literal = (): string => {
		const end = text.indexOf("'", at + 1);
		const value = end < 0 ? fail() : text.slice(at + 1, end);
		if (/[\r\n]/.test(value)) fail();
		at = end + 1;
		return value;
	};
	// """…""" or '''…''', which may end with up to two more quotes.
	const multiline = (quote: string): string => {
		at += 3;
		newline();
		let value = "";
		for (;;) {
			if (at >= text.length) fail();
			if (text.startsWith(quote.repeat(3), at)) {
				let extra = 0;
				while (extra < 2 && text[at + 3 + extra] === quote) extra++;
				value += quote.repeat(extra);
				at += 3 + extra;
				return value;
			}
			const c = text[at] ?? "";
			if (quote === '"' && c === "\\") {
				let after = at + 1;
				while (text[after] === " " || text[after] === "\t") after++;
				if (text[after] === "\n" || (text[after] === "\r" && text[after + 1] === "\n")) {
					at = after;
					while (/[ \t\r\n]/.test(text[at] ?? "")) at++;
				} else value += escapeAt();
			} else {
				value += c;
				at++;
			}
		}
	};
	const simpleKey = (): string => {
		if (text[at] === '"') return basic();
		if (text[at] === "'") return literal();
		BARE_KEY.lastIndex = at;
		const bare = BARE_KEY.exec(text)?.[0] ?? fail();
		at += bare.length;
		return bare;
	};
	const key = (): string[] => {
		const keys = [simpleKey()];
		for (;;) {
			space();
			if (text[at] !== ".") return keys;
			at++;
			space();
			keys.push(simpleKey());
		}
	};
	const ended = (): void => {
		if (!/^(?:[ \t\r\n,\]}#]|$)/.test(text.slice(at, at + 1))) fail();
	};
	const value = (depth: number): Toml => {
		if (depth > 128) fail();
		const c = text[at];
		if (c === '"') return text.startsWith('"""', at) ? multiline('"') : basic();
		if (c === "'") return text.startsWith("'''", at) ? multiline("'") : literal();
		if (c === "[") {
			at++;
			const items: Toml[] = [];
			blank();
			while (text[at] !== "]") {
				items.push(value(depth + 1));
				blank();
				if (text[at] === ",") {
					at++;
					blank();
				} else if (text[at] !== "]") fail();
			}
			at++;
			return items;
		}
		if (c === "{") {
			at++;
			const inline = tableOf();
			blank();
			while (text[at] !== "}") {
				const keys = key();
				space();
				if (text[at] !== "=") fail();
				at++;
				space();
				assign(inline, keys, value(depth + 1));
				blank();
				if (text[at] === ",") {
					at++;
					blank();
				} else if (text[at] !== "}") fail();
			}
			at++;
			return inline;
		}
		for (const word of ["true", "false"]) {
			if (text.startsWith(word, at)) {
				at += word.length;
				ended();
				return word === "true";
			}
		}
		for (const pattern of [DATE_TIME, NUMBER]) {
			pattern.lastIndex = at;
			const match = pattern.exec(text)?.[0];
			if (match === undefined || match === "") continue;
			at += match.length;
			ended();
			if (pattern === DATE_TIME) return match;
			const number = match.replace(/^\+/, "").replaceAll("_", "");
			if (number.endsWith("inf")) return number.startsWith("-") ? -Infinity : Infinity;
			return number.endsWith("nan") ? Number.NaN : Number(number);
		}
		return fail();
	};
	// Each key but the last names a table, made where missing; an array of tables gives its last.
	const descend = (table: TomlTable, name: string): TomlTable => {
		const found = table[name];
		if (found === undefined) {
			const made = tableOf();
			table[name] = made;
			return made;
		}
		if (Array.isArray(found)) {
			const last = found.at(-1);
			return isTable(last) ? last : fail();
		}
		return isTable(found) ? found : fail();
	};
	const assign = (table: TomlTable, keys: readonly string[], item: Toml): void => {
		let target = table;
		for (const name of keys.slice(0, -1)) target = descend(target, name);
		const last = keys.at(-1) ?? fail();
		if (last in target) fail();
		target[last] = item;
	};
	try {
		const root = tableOf();
		let current = root;
		for (;;) {
			blank();
			if (at >= text.length) return root;
			if (text[at] === "[") {
				const array = text[at + 1] === "[";
				at += array ? 2 : 1;
				space();
				const keys = key();
				space();
				if (!text.startsWith(array ? "]]" : "]", at)) fail();
				at += array ? 2 : 1;
				lineEnd();
				let parent = root;
				for (const name of keys.slice(0, -1)) parent = descend(parent, name);
				const last = keys.at(-1) ?? fail();
				if (array) {
					const list = parent[last] ?? [];
					if (!Array.isArray(list)) fail();
					const made = tableOf();
					(list as Toml[]).push(made);
					parent[last] = list;
					current = made;
				} else current = descend(parent, last);
			} else {
				const keys = key();
				space();
				if (text[at] !== "=") fail();
				at++;
				space();
				assign(current, keys, value(0));
				lineEnd();
			}
		}
	} catch (error) {
		if (error instanceof Unparsable) return null;
		throw error;
	}
}

// --- Cargo ---

const DEPENDENCY_TABLES = [
	"dependencies",
	"dev-dependencies",
	"dev_dependencies",
	"build-dependencies",
	"build_dependencies",
];
const TARGET_TABLES = ["bin", "test", "bench", "example"];

// The forms of rustup's toolchain file that name a toolchain and nothing else: the [toolchain]
// table's channel, components, targets and profile, each a plain name or a list of them. Its path
// key runs the tools in that folder, and a channel spelled as a path does the same; rustup would
// follow any other key or form, so those are refused before Cargo runs.
const TOOLCHAIN_FILES = new Set(["rust-toolchain", "rust-toolchain.toml"]);
const TOOLCHAIN_KEYS = new Set(["channel", "components", "targets", "profile"]);
const TOOLCHAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function toolchainRefs(candidates: Candidates, file: string, text: string): void {
	// trim() drops a byte order mark too.
	const lines = text.trim().split(/\r?\n/);
	// A rust-toolchain file of one line is the toolchain's name, as rustup reads it.
	if (fold(baseOf(file)) === "rust-toolchain" && lines.length === 1) {
		if (!TOOLCHAIN_NAME.test(lines[0] ?? "")) candidates.refuse(file, "unsupported");
		return;
	}
	const toml = parseToml(text);
	if (toml === null) {
		candidates.refuse(file, "unparsable");
		return;
	}
	const named = (value: Toml | undefined): boolean =>
		typeof value === "string"
			? TOOLCHAIN_NAME.test(value)
			: Array.isArray(value) &&
				value.every((item) => typeof item === "string" && TOOLCHAIN_NAME.test(item));
	const section = tableAt(toml, "toolchain");
	const plain =
		Object.keys(toml).every((key) => key === "toolchain" && section !== null) &&
		Object.entries(section ?? {}).every(([key, value]) => TOOLCHAIN_KEYS.has(key) && named(value));
	if (!plain) candidates.refuse(file, "unsupported");
}

// A Cargo manifest's and a .cargo config's paths (TOML read with parseToml), and a toolchain file's
// forms (toolchainRefs):
// - a manifest's [package] build (a path; false turns the implicit build.rs off, which the scan
//   honours) and workspace, its targets' path keys, [workspace] members and exclude (glob members
//   are the scan's), and every path dependency: each dependency table, target.*'s, [workspace]'s,
//   [patch.*] and [replace];
// - a config's paths and [patch.*] path entries, at the folder holding .cargo. Any other key of a
//   config ([source] replacement, build.rustc and its wrappers, target linkers and runners, [env],
//   rustflags, includes and the rest) can point Cargo at sources, programs or settings this check
//   doesn't follow, so a config holding one is refused.
function cargoRefs(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	text: string,
): void {
	const dir = dirOf(file);
	if (TOOLCHAIN_FILES.has(fold(baseOf(file)))) {
		toolchainRefs(candidates, file, text);
		return;
	}
	const manifest = fold(baseOf(file)) === "cargo.toml";
	const config = !manifest && fold(baseOf(dir)) === ".cargo";
	if (!manifest && !config) return;
	const toml = parseToml(text);
	if (toml === null) {
		candidates.refuse(file, "unparsable");
		return;
	}
	const at = config ? dirOf(dir) : dir;
	// A path below the checkout, or null; one that leaves it, or that unfollowedPath names, refuses
	// this file.
	const named = (value: Toml | undefined): string | null => {
		if (typeof value !== "string") return null;
		const rel = resolveFrom(input.checkout, at, value);
		if (rel === OUTSIDE) {
			candidates.refuse(file, "outside");
			return null;
		}
		const why = rel === null ? unfollowedPath(input.checkout, at, value) : null;
		if (why !== null) candidates.refuse(file, why);
		return rel;
	};
	const crate = (value: Toml | undefined): void => {
		const rel = named(value);
		if (rel !== null) candidates.folder(rel, ["Cargo.toml"]);
	};
	const dependencies = (table: TomlTable | null): void => {
		for (const spec of Object.values(table ?? {})) if (isTable(spec)) crate(spec.path);
	};
	const patches = (table: TomlTable | null): void => {
		for (const registry of Object.values(table ?? {}))
			if (isTable(registry)) dependencies(registry);
	};
	if (config) {
		const paths = toml.paths;
		for (const value of Array.isArray(paths) ? paths : []) crate(value);
		patches(tableAt(toml, "patch"));
		if (Object.keys(toml).some((key) => key !== "paths" && key !== "patch")) {
			candidates.refuse(file, "unsupported");
		}
		return;
	}
	const pkg = tableAt(toml, "package") ?? tableAt(toml, "project");
	const build = named(pkg?.build);
	if (build !== null) candidates.file(build);
	crate(pkg?.workspace);
	const lib = named(tableAt(toml, "lib")?.path);
	if (lib !== null) candidates.file(lib);
	for (const kind of TARGET_TABLES) {
		const targets = toml[kind];
		for (const target of Array.isArray(targets) ? targets : []) {
			const rel = isTable(target) ? named(target.path) : null;
			if (rel !== null) candidates.file(rel);
		}
	}
	const workspace = tableAt(toml, "workspace");
	for (const key of ["members", "exclude"]) {
		const list = workspace?.[key];
		for (const value of Array.isArray(list) ? list : []) {
			if (typeof value !== "string" || /[*?[]/.test(value)) continue;
			const rel = named(value);
			if (rel !== null) candidates.folder(rel, key === "members" ? ["Cargo.toml"] : []);
		}
	}
	dependencies(tableAt(workspace, "dependencies"));
	for (const name of DEPENDENCY_TABLES) dependencies(tableAt(toml, name));
	for (const target of Object.values(tableAt(toml, "target") ?? {})) {
		if (!isTable(target)) continue;
		for (const name of DEPENDENCY_TABLES) dependencies(tableAt(target, name));
	}
	patches(tableAt(toml, "patch"));
	dependencies(tableAt(toml, "replace"));
}

// --- module literals ---

const REMAPPED: Readonly<Record<string, readonly string[]>> = {
	".js": [".ts", ".tsx", ".d.ts"],
	".jsx": [".tsx", ".d.ts"],
	".mjs": [".mts", ".d.mts"],
	".cjs": [".cts", ".d.cts"],
};
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const KNOWN = /\.(?:[cm]?[jt]sx?|json|node)$/i;
const ENTRY_FIELDS = new Set(["main", "module", "exports", "types", "typings"]);

const relativeLiteral = (value: string): boolean =>
	value === "." || value === ".." || value.startsWith("./") || value.startsWith("../");

// Every string in a JSON value, keys aside.
function stringsOf(value: Json): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringsOf);
	if (isObject(value)) return value.object.flatMap(([, inner]) => stringsOf(inner));
	return [];
}

// What a module specifier at `rel` can load: the file as written, its .js-to-.ts twins, the file
// with each usual extension when it has none, and for a folder its package.json, the entry points
// that names, and its index files.
function moduleTarget(input: ReferenceInput, candidates: Candidates, rel: string, depth = 0): void {
	if (candidates.kindOf(rel) === "dir") {
		const manifest = rel === "" ? "package.json" : `${rel}/package.json`;
		candidates.file(manifest);
		const text = depth < 2 && input.listed(manifest) ? input.text(manifest) : null;
		const json = text === null ? undefined : parseJson(text);
		for (const [field, value] of isObject(json) ? json.object : []) {
			if (!ENTRY_FIELDS.has(field)) continue;
			for (const entry of stringsOf(value)) {
				const target = resolveFrom(input.checkout, rel, entry);
				if (target === OUTSIDE) candidates.refuse(manifest, "outside");
				else if (target !== null && target !== rel) {
					moduleTarget(input, candidates, target, depth + 1);
				}
			}
		}
		for (const extension of EXTENSIONS)
			candidates.file(rel === "" ? `index${extension}` : `${rel}/index${extension}`);
		return;
	}
	candidates.file(rel);
	const extension = /\.[^./]*$/.exec(rel)?.[0].toLowerCase() ?? "";
	for (const twin of REMAPPED[extension] ?? [])
		candidates.file(`${rel.slice(0, -extension.length)}${twin}`);
	if (!KNOWN.test(rel)) for (const added of EXTENSIONS) candidates.file(`${rel}${added}`);
}

// The package.json a # specifier in a module of folder `dir` resolves through: the nearest one from
// that folder up, as Node, Vite and tsc find a package's imports map. The one found must be a
// regular, listed file, whose imports map refs-config follows.
function packageScope(candidates: Candidates, dir: string): void {
	for (let at = dir; ; at = dirOf(at)) {
		const manifest = join(at, "package.json");
		if (candidates.kindOf(manifest) !== "missing") {
			candidates.file(manifest);
			return;
		}
		if (at === "") return;
	}
}

// A specifier that is an absolute path, which Node and tsc load from the file system's root and Vite
// from its project's (followed only as a path below the checkout's root), and a file: URL, which
// can name any file.
const ABSOLUTE_SPECIFIER = /^(?:[A-Za-z]:)?[\\/]/;
const FILE_URL = /^file:/i;

// A module's relative and absolute specifiers that load, resolve or reference a module
// (lib/imports.ts's kinds but glob and other), the package scope of its # specifiers, and every
// string of a Vitest or Vite config: its relative ones as modules, the rest as files a config names.
// One that leaves the checkout refuses the file that names it, and so does a file: URL specifier.
// An import.meta.glob pattern, which Vite matches against the folders it names, is refused: as
// "outside" when it leaves the checkout from the module's folder, and otherwise as "unsupported".
function moduleRefs(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	text: string,
): void {
	const config = fileKind(file) === "config";
	const pointers = pointersOf(file, text);
	if (!Array.isArray(pointers)) return;
	let scoped = false;
	for (const { value, anchor, field } of pointers) {
		if (field === "module:glob") {
			const pattern = value.replace(/^!+/, "");
			const out = relativeLiteral(pattern) && leaves(input.checkout, dirOf(file), pattern);
			candidates.refuse(file, out ? "outside" : "unsupported");
			continue;
		}
		if (!scoped && value.startsWith("#") && field !== "module:other") {
			packageScope(candidates, dirOf(file));
			scoped = true;
		}
		const relative = relativeLiteral(value);
		let rel: string | typeof OUTSIDE | null;
		let from = "";
		let named = value;
		if (config || (relative && field !== "module:other")) {
			if (anchor === null) continue;
			from = anchor;
			rel = resolveFrom(input.checkout, anchor, value);
		} else if (field === "module:other") continue;
		else if (FILE_URL.test(value)) {
			candidates.refuse(file, "unsupported");
			continue;
		} else if (ABSOLUTE_SPECIFIER.test(value)) {
			named = value.replace(/[?#].*$/s, "");
			rel = resolveFrom(input.checkout, "", named);
		} else continue;
		if (rel === OUTSIDE) candidates.refuse(file, "outside");
		else if (rel === null) {
			// A config's strings are free text: only a module's paths are refused here.
			const why = config ? null : unfollowedPath(input.checkout, from, named);
			if (why !== null) candidates.refuse(file, why);
		} else if (relative || !config) moduleTarget(input, candidates, rel);
		else if (candidates.kindOf(rel) !== "dir") candidates.file(rel);
	}
}

// --- package.json, tsconfig, Biome and HTML ---

const MANIFESTS = ["package.json", "package.yaml", "package.json5"];

// An imports target that names an installed dependency or a node: built-in, which aren't followed:
// a bare package name, scoped or not, with a subpath of plain parts.
const BARE_TARGET =
	/^(?:node:[\w/-]+|(?:@[\w~-][\w.~-]*\/)?[\w~-][\w.~-]*(?:\/(?!\.\.?(?:\/|$))[\w.~@-]+)*)$/;

// One target of a package.json imports map, at the manifest's folder: a ./ path is a module the
// package's # specifiers load, followed as one; a bare name or a built-in isn't followed. A *
// pattern is subpathPatterns'. Anything else (a ../ or absolute path, an encoded or URL form) is a
// redirection this check doesn't follow, and the manifest is refused.
function importsTarget(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	value: string,
): void {
	if (value.startsWith("./") && !/[*%]/.test(value)) {
		const rel = resolveFrom(input.checkout, dirOf(file), value);
		if (rel === OUTSIDE) {
			candidates.refuse(file, "outside");
			return;
		}
		if (rel !== null) {
			moduleTarget(input, candidates, rel);
			return;
		}
	} else if (BARE_TARGET.test(value)) return;
	candidates.refuse(file, "unsupported");
}

// Each target of an exports or imports value with its subpath key: every string at any condition
// depth and in fallback arrays. An exports value without "." keys is the "." subpath's. A null
// target excludes, and is left out.
function subpathTargets(field: string, value: Json): (readonly [string, string])[] {
	const found: (readonly [string, string])[] = [];
	const leaves = (key: string, target: Json): void => {
		if (typeof target === "string") found.push([key, target]);
		else if (Array.isArray(target)) for (const item of target) leaves(key, item);
		else if (isObject(target)) for (const [, inner] of target.object) leaves(key, inner);
	};
	const keyed =
		isObject(value) && (field === "imports" || value.object.some(([key]) => key.startsWith(".")));
	if (!keyed) leaves(field === "exports" ? "." : "", value);
	else if (isObject(value)) {
		for (const [key, target] of value.object) {
			leaves(field === "exports" && !key.startsWith(".") ? "." : key, target);
		}
	}
	return found;
}

const starsIn = (text: string): number => text.split("*").length - 1;

// A folder or file name a pattern's fixed parts may give: no empty, . or .. step, no node_modules
// or .git, which no walk enters, and no name Windows trims.
const plainPart = (part: string): boolean =>
	part !== "" &&
	part !== "." &&
	part !== ".." &&
	!/[. ]$/.test(part) &&
	!UNFOLLOWED.has(part.toLowerCase());

// The endings a pattern's match may have, in lower case: its suffix, the suffix's .js-to-.ts twins,
// and, with no usual extension, the suffix with each one added, as moduleTarget tries them.
function endingsOf(suffix: string): string[] {
	const extension = /\.[^./]*$/.exec(suffix)?.[0].toLowerCase() ?? "";
	const twins = (REMAPPED[extension] ?? []).map(
		(twin) => `${suffix.slice(0, -extension.length)}${twin}`,
	);
	const added = KNOWN.test(suffix) ? [] : EXTENSIONS.map((more) => `${suffix}${more}`);
	return [suffix, ...twins, ...added].map((ending) => ending.toLowerCase());
}

// One subpath pattern's target, from its package's folder: a fixed prefix and suffix around one *,
// which may stand for any path. The target must start with ./ and its fixed parts hold plain names:
// a prefix that leaves the package is refused as outside, and a part naming a reserved word, or a
// walk that could reach an allowed root, as reserved. The prefix's folder is then walked, names and
// kinds only, as scan-tsc walks an include root: every entry a match could be must be a regular file
// in the index (a pattern makes any file it matches loadable by name, so an untracked one, ignored
// or not, is refused as unlisted), and no entry a match could lie below may be a link, a junction or
// another kind the walk doesn't enter. A walk that meets node_modules or .git there is unsupported.
function patternTarget(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	target: string,
): void {
	const text = target.replaceAll("\\", "/");
	const star = text.indexOf("*");
	const prefix = text.slice(2, star);
	const suffix = text.slice(star + 1);
	const forms = !NOT_A_PATH.test(prefix) && !NOT_A_PATH.test(suffix) && !/[%#]/.test(text);
	if (!text.startsWith("./") || !forms) {
		candidates.refuse(file, "unsupported");
		return;
	}
	if (reservedWord.test(prefix) || reservedWord.test(suffix)) {
		candidates.refuse(file, "reserved");
		return;
	}
	const folders = prefix.split("/");
	const head = folders.pop() ?? "";
	const [tail = "", ...names] = suffix.split("/");
	let depth = 0;
	for (const part of folders) {
		depth += part === ".." ? -1 : 1;
		if (depth < 0) {
			candidates.refuse(file, "outside");
			return;
		}
	}
	const plain =
		folders.every(plainPart) &&
		names.every(plainPart) &&
		head !== "." &&
		head !== ".." &&
		!/[. ]$/.test(tail);
	if (!plain) {
		candidates.refuse(file, "unsupported");
		return;
	}
	const pkg = dirOf(file);
	const base = [pkg, ...folders].filter((part) => part !== "").join("/");
	const within = fold(base === "" ? "" : `${base}/`);
	const allowed = (rel: string): boolean =>
		input.allowedRoots.some((root) => fold(`${rel}/`).startsWith(fold(root)));
	if (input.allowedRoots.some((root) => fold(root).startsWith(within)) || allowed(base)) {
		candidates.refuse(file, "reserved");
		return;
	}
	const lead = prefix.toLowerCase();
	const endings = endingsOf(suffix);
	const inPackage = (rel: string): string =>
		(pkg === "" ? rel : rel.slice(pkg.length + 1)).toLowerCase();
	const kind = input.checkout.walk(base, (rel, found) => {
		const name = inPackage(rel);
		const match =
			name.startsWith(lead) &&
			endings.some((end) => name.length >= lead.length + end.length && name.endsWith(end));
		// As a folder, it could hold a match.
		const holds = `${name}/`.startsWith(lead);
		if (!match && !holds) return false;
		if (reservedWord.test(rel) || allowed(rel)) {
			candidates.refuse(rel, "reserved");
			return false;
		}
		if (UNFOLLOWED.has(baseOf(rel).toLowerCase())) {
			candidates.refuse(file, "unsupported");
			return false;
		}
		if (found === "dir") {
			if (match) candidates.refuse(rel, "dir");
			return holds;
		}
		if (found === "file") {
			if (match && !input.tracked(rel)) candidates.refuse(rel, "unlisted");
		} else if (match || (holds && found !== "hardlink" && found !== "special")) {
			candidates.refuse(rel, found);
		}
		return false;
	});
	if (kind === "link" || kind === "redirect" || kind === "unreadable")
		candidates.refuse(base, kind);
}

// A package.json's exports and imports subpath patterns: a key holding one * whose targets each
// hold one too, followed by patternTarget. A target or key holding one alone, or more than one, is
// refused as unsupported.
function subpathPatterns(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	json: JsonObject,
): void {
	for (const [field, value] of json.object) {
		if (field !== "exports" && field !== "imports") continue;
		const done = new Set<string>();
		for (const [key, target] of subpathTargets(field, value)) {
			const [keyed, targeted] = [starsIn(key), starsIn(target)];
			if (keyed === 0 && targeted === 0) continue;
			if (keyed !== 1 || targeted !== 1) candidates.refuse(file, "unsupported");
			else if (!done.has(target)) {
				done.add(target);
				patternTarget(input, candidates, file, target);
			}
		}
	}
}

// Every name Biome takes a config from, in the root or a nested folder.
const BIOME_CONFIGS = new Set(["biome.json", "biome.jsonc", ".biome.json", ".biome.jsonc"]);

// A Biome config's extends and plugins, top level and in overrides: each ./ or ../ path is a file
// Biome reads, kind-checked as a reference, and a config it extends is followed the same way; extends
// may also name the root config, "//". Anything else (a package's config, an absolute path, a value
// that isn't a string) is a redirection this check doesn't follow, and the config is refused, as is
// one it can't parse.
function biomeRefs(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	seen: Set<string>,
	depth = 0,
): void {
	if (seen.has(file) || depth > 16) return;
	seen.add(file);
	const text = input.listed(file) ? input.text(file) : null;
	if (text === null) return;
	const json = parseJson(text);
	if (!isObject(json)) {
		candidates.refuse(file, "unparsable");
		return;
	}
	const valuesOf = (holder: JsonObject, key: string): Json[] =>
		holder.object.filter(([name]) => name === key).map(([, value]) => value);
	const itemsOf = (value: Json): (string | null)[] =>
		typeof value === "string"
			? [value]
			: Array.isArray(value)
				? value.map((item: Json) => (typeof item === "string" ? item : null))
				: [null];
	const named = (value: string | null, extended: boolean): void => {
		if (extended && value === "//") return;
		const rel =
			value !== null && /^\.\.?\//.test(value) && !value.includes("%")
				? resolveFrom(input.checkout, dirOf(file), value)
				: null;
		if (rel === null || rel === OUTSIDE) {
			candidates.refuse(file, rel === OUTSIDE ? "outside" : "unsupported");
			return;
		}
		candidates.file(rel);
		if (extended) biomeRefs(input, candidates, rel, seen, depth + 1);
	};
	const plugins = (holder: JsonObject): void => {
		for (const value of valuesOf(holder, "plugins"))
			for (const item of itemsOf(value)) named(item, false);
	};
	for (const value of valuesOf(json, "extends"))
		for (const item of itemsOf(value)) named(item, true);
	plugins(json);
	for (const overrides of valuesOf(json, "overrides")) {
		for (const item of Array.isArray(overrides) ? overrides : []) if (isObject(item)) plugins(item);
	}
}

// A dependency spec pnpm reads as a path that leaves the checkout: from the home folder, or from a
// drive's own working folder.
const HOME_OR_DRIVE_SPEC = /^(?:~[\\/]|[A-Za-z]:(?![\\/]))/;

// A package's own entry points, which a package that imports it by name loads, and its bins, which
// pnpm runs.
const ENTRY_POINTERS = new Set(
	["main", "module", "types", "typings", "bin", "browser", "exports"].map(
		(key) => `manifest:${key}`,
	),
);

// A script token that reads as a path (it starts with a dot or holds a separator), from its
// package's folder: a command may run or read it, so it is checked as a module Node could load from
// there. One that leaves the checkout refuses the manifest, /dev/null too, which on Windows names a
// file on the current drive, and so does one from a drive's own working folder. Tokens are free
// text, so a name Windows trims is refused only in a token that starts with ./ or ../.
function scriptToken(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	anchor: string,
	value: string,
): void {
	const rel = resolveFrom(input.checkout, anchor, value);
	if (rel === OUTSIDE) candidates.refuse(file, "outside");
	else if (rel !== null) moduleTarget(input, candidates, rel);
	else {
		const why = unfollowedPath(input.checkout, anchor, value);
		const relative = relativeLiteral(value.replaceAll("\\", "/"));
		if (why === "outside" || (why === "unsupported" && relative)) candidates.refuse(file, why);
	}
}

// The pointers whose * patterns subpathPatterns follows.
const PATTERNED = new Set(["manifest:exports", "manifest:imports"]);

// Each pointer of a package.json, tsconfig or HTML file but tsconfig include, which scan-tsc
// follows, with the absolute paths dependency specs and tsconfig extends give, each script token
// that reads as a path, and a package.json's subpath patterns. One that leaves the checkout refuses
// the file that names it.
function configRefs(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	text: string,
): void {
	const pointers = pointersOf(file, text);
	if (pointers === "unparsable") {
		candidates.refuse(file, "unparsable");
		return;
	}
	const kind = fileKind(file);
	const json = kind === "manifest" || kind === "tsconfig" ? parseJson(text) : undefined;
	// A config tsc reads through extends or references. These checks read a config's own fields only
	// when its name is a tsconfig's, so a listed file of another name refuses the one that names it.
	const config = (target: string): void => {
		candidates.file(target);
		const read = fileKind(target) === "tsconfig";
		if (!read && candidates.kindOf(target) === "file" && input.listed(target)) {
			candidates.refuse(file, "unsupported");
		}
	};
	for (const { value, anchor, field } of pointers ?? []) {
		if (field === "tsconfig:include" || (PATTERNED.has(field) && value.includes("*"))) continue;
		if (field === "manifest:scripts") {
			if (anchor !== null) scriptToken(input, candidates, file, anchor, value);
			continue;
		}
		const spec = field === "manifest:dependency";
		let rel: string | typeof OUTSIDE | null;
		if (anchor !== null) {
			if (field === "manifest:imports") {
				importsTarget(input, candidates, file, value);
				continue;
			}
			rel = resolveFrom(input.checkout, anchor, value);
		} else if (spec && HOME_OR_DRIVE_SPEC.test(value)) rel = OUTSIDE;
		else if (field === "tsconfig:extends" && DRIVE_RELATIVE.test(value)) rel = OUTSIDE;
		else if ((spec || field === "tsconfig:extends") && ABSOLUTE_SPECIFIER.test(value)) {
			rel = resolveFrom(input.checkout, "", value);
		} else continue;
		if (rel === OUTSIDE) {
			candidates.refuse(file, "outside");
			continue;
		}
		// TypeScript no longer reads baseUrl, and a tool that still does would read paths from there. A
		// paths pattern's target takes whatever its * matches in a specifier, which no check here sees.
		if (field === "tsconfig:baseUrl" || (field === "tsconfig:paths" && value.includes("*"))) {
			candidates.refuse(file, "unsupported");
			continue;
		}
		if (rel === null) {
			// A * in main, bin or another entry field but exports names no one module.
			const pattern = ENTRY_POINTERS.has(field) && value.includes("*");
			const why = pattern ? "unsupported" : unfollowedPath(input.checkout, anchor ?? "", value);
			if (why !== null) candidates.refuse(file, why);
			continue;
		}
		const kindOf = (): Kind => candidates.kindOf(rel);
		// A dependency spec here is a path: one anchored at its package starts with a dot.
		if (field === "manifest:local" || field === "manifest:dependency") {
			candidates.folder(rel, MANIFESTS);
		} else if (field === "tsconfig:extends") {
			if (kindOf() === "dir") config(join(rel, "tsconfig.json"));
			else config(rel);
			if (!/\.json$/i.test(rel)) config(`${rel}.json`);
		} else if (field === "tsconfig:references") {
			if (kindOf() === "dir") config(join(rel, "tsconfig.json"));
			else config(rel);
		} else if (field === "tsconfig:files") candidates.file(rel);
		else if (field === "tsconfig:paths") moduleTarget(input, candidates, rel);
		else if (field === "tsconfig:types") {
			// tsc resolves a relative types entry from the folder of each project that extends this
			// config, which this check doesn't follow; an absolute one is a module path.
			if (relativeLiteral(value.replaceAll("\\", "/"))) candidates.refuse(file, "unsupported");
			else moduleTarget(input, candidates, rel);
		} else if (field === "tsconfig:typeRoots" || field === "tsconfig:rootDirs") {
			// tsc reads type packages from a typeRoots folder, and resolves a module's relative imports
			// through every rootDirs folder; these checks follow neither, so a folder there is refused.
			if (kindOf() === "dir") candidates.refuse(file, "unsupported");
			else candidates.folder(rel, []);
		} else if (ENTRY_POINTERS.has(field)) moduleTarget(input, candidates, rel);
		else if (field === "html" && kindOf() !== "dir") candidates.file(rel);
	}
	if (!isObject(json)) return;
	if (kind === "manifest") subpathPatterns(input, candidates, file, json);
	if (redirectsTypes(kind === "manifest", json)) candidates.refuse(file, "unsupported");
}

// Whether a package.json sets typesVersions, from which tsc reads types by its own version, or a
// tsconfig sets compilerOptions.moduleSuffixes, which tsc tries before a module's own name: files
// these checks never name, so either is refused, whatever its value.
function redirectsTypes(manifest: boolean, json: JsonObject): boolean {
	return json.object.some(([key, value]) =>
		manifest
			? key === "typesVersions"
			: key === "compilerOptions" &&
				isObject(value) &&
				value.object.some(([option]) => option === "moduleSuffixes"),
	);
}
