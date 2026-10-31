import { reservedWord } from "../../../reserved-tests.ts";
import { fileKind, isObject, type Json, parseJson, pointersOf } from "../reserved-tripwire.ts";
import { includeLiterals, modDecls } from "./rust-source.ts";
import { type Checkout, fold, type Kind } from "./safe-fs.ts";

// The inputs that listed files name: Rust modules and includes, Cargo's paths, relative module
// literals, and the paths package.json specs, tsconfig fields and HTML attributes give. A named file
// (a candidate) is only kind-checked, never read: one that exists must be a regular, listed file of
// the checkout, in real folders. A missing one is fine, as no tool can read it, except one whose
// path names a reserved word, which is refused either way. Bare specifiers and names, which resolve
// to installed dependencies, aren't followed, and nothing below node_modules or .git is.

export type RefusedKind = Kind | "unlisted" | "reserved" | "unparsable";

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
	// The ordinary listed files that are regular files: the only files read here.
	readonly files: readonly string[];
	// A listed file's text, read through the checkout once; null where it can't be read.
	readonly text: (rel: string) => string | null;
}

const UNFOLLOWED = new Set(["node_modules", ".git"]);
const WINDOWS_DRIVE = /^[A-Za-z]:\//;
// Characters no path on every platform may hold, a glob's and a computed part's markers included.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters mark a value that isn't a path.
const NOT_A_PATH = /[\u0000-\u001f*?"<>|]|\$\{\}|\{[^{}]*,[^{}]*\}/;

// The path a value names from folder `from` (below the root, "" for the root), with . and ..
// resolved, below the root with / separators; null for a value that isn't a path, one outside the
// checkout, and one below node_modules or .git.
export function resolveFrom(checkout: Checkout, from: string, value: string): string | null {
	const text = value.replaceAll("\\", "/");
	if (text === "" || NOT_A_PATH.test(text)) return null;
	let parts: string[];
	if (WINDOWS_DRIVE.test(text) || text.startsWith("/")) {
		const root = fold(checkout.root.replaceAll("\\", "/")).replace(/\/$/, "");
		const folded = fold(text);
		if (folded !== root && !folded.startsWith(`${root}/`)) return null;
		parts = text.slice(root.length).split("/");
	} else {
		if (text.includes(":")) return null;
		parts = [...from.split("/"), ...text.split("/")];
	}
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (resolved.pop() === undefined) return null;
		} else if (/[. ]$/.test(part) || UNFOLLOWED.has(fold(part))) {
			return null;
		} else resolved.push(part);
	}
	return resolved.join("/");
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
		if (rel !== null) candidates.file(rel);
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

// A Cargo manifest's and a .cargo config's paths (TOML read with parseToml):
// - a manifest's [package] build (a path; false turns the implicit build.rs off, which the scan
//   honours) and workspace, its targets' path keys, [workspace] members and exclude (glob members
//   are the scan's), and every path dependency: each dependency table, target.*'s, [workspace]'s,
//   [patch.*] and [replace];
// - a config's paths and [patch.*] path entries, at the folder holding .cargo. Its other keys aren't
//   followed.
function cargoRefs(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	text: string,
): void {
	const dir = dirOf(file);
	const manifest = fold(baseOf(file)) === "cargo.toml";
	const config = !manifest && fold(baseOf(dir)) === ".cargo";
	if (!manifest && !config) return;
	const toml = parseToml(text);
	if (toml === null) {
		candidates.refuse(file, "unparsable");
		return;
	}
	const at = config ? dirOf(dir) : dir;
	const named = (value: Toml | undefined): string | null =>
		typeof value === "string" ? resolveFrom(input.checkout, at, value) : null;
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
				if (target !== null && target !== rel) moduleTarget(input, candidates, target, depth + 1);
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

// A module's relative literals that load, resolve or reference a module (lib/imports.ts's kinds but
// other), and every string of a Vitest or Vite config: its relative ones as modules, the rest as
// files a config names.
function moduleRefs(
	input: ReferenceInput,
	candidates: Candidates,
	file: string,
	text: string,
): void {
	const config = fileKind(file) === "config";
	const pointers = pointersOf(file, text);
	if (!Array.isArray(pointers)) return;
	for (const { value, anchor, field } of pointers) {
		if (anchor === null) continue;
		const relative = relativeLiteral(value);
		if (!config && (field === "module:other" || !relative)) continue;
		const rel = resolveFrom(input.checkout, anchor, value);
		if (rel === null) continue;
		if (relative) moduleTarget(input, candidates, rel);
		else if (candidates.kindOf(rel) !== "dir") candidates.file(rel);
	}
}

// --- package.json, tsconfig and HTML ---

const MANIFESTS = ["package.json", "package.yaml", "package.json5"];

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
	for (const { value, anchor, field } of pointers ?? []) {
		if (anchor === null) continue;
		const rel = resolveFrom(input.checkout, anchor, value);
		if (rel === null) continue;
		const kind = (): Kind => candidates.kindOf(rel);
		if (field === "manifest:local" || (field === "manifest:dependency" && value.startsWith("."))) {
			candidates.folder(rel, MANIFESTS);
		} else if (field === "tsconfig:extends") {
			if (kind() === "dir") candidates.file(`${rel}/tsconfig.json`);
			else candidates.file(rel);
			if (!/\.json$/i.test(rel)) candidates.file(`${rel}.json`);
		} else if (field === "tsconfig:references") {
			if (kind() === "dir") candidates.file(rel === "" ? "tsconfig.json" : `${rel}/tsconfig.json`);
			else candidates.file(rel);
		} else if (field === "tsconfig:files") candidates.file(rel);
		else if (field === "tsconfig:paths") moduleTarget(input, candidates, rel);
		else if (
			field === "tsconfig:typeRoots" ||
			field === "tsconfig:baseUrl" ||
			field === "tsconfig:rootDirs"
		) {
			candidates.folder(rel, []);
		} else if (field === "html" && kind() !== "dir") candidates.file(rel);
	}
}
