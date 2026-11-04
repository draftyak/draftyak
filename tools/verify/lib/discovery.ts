import { tierFiles } from "../../../reserved-tests.ts";
import { isObject, type Json, type JsonObject, parseJson } from "../reserved-tripwire.ts";
import {
	absolutePath,
	belowRoot,
	Candidates,
	OUTSIDE,
	parseToml,
	type Refusal,
	resolveFrom,
	type Toml,
	type TomlTable,
	tableAt,
} from "./references.ts";
import { type Checkout, fold, type Kind } from "./safe-fs.ts";

// The folders tools scan for their own inputs, checked by names and kinds only through
// Checkout.walk, which never enters node_modules, .git or a link. A link, junction or redirect a
// tool would follow there is refused, and so is a file it would pick up that isn't a regular, listed
// file. Nothing here reads a file but a listed tsconfig or Cargo manifest, for the folders and
// targets they name. The allowed reserved roots are the maintainer's, and no scan enters them.

export type ScanCheck =
	| "scan-pnpm"
	| "scan-tsc"
	| "scan-vitest"
	| "scan-cargo"
	| "scan-verify"
	| "scan-prefetch";

export interface ScanInput {
	readonly checkout: Checkout;
	readonly listed: (rel: string) => boolean;
	// The ordinary listed files that are regular files: the only files read here.
	readonly files: readonly string[];
	readonly text: (rel: string) => string | null;
	readonly allowedRoots: readonly string[];
	// lib/listing.ts's packageDirs, for pnpm's and turbo's package folders.
	readonly packages: {
		readonly dirs: readonly string[];
		readonly refused: readonly { rel: string; kind: Kind | "unlisted" }[];
	};
	readonly walks: Walks;
}

export interface ScanResult {
	readonly refused: readonly Refusal[];
	// Every folder the scan looked into.
	readonly folders: ReadonlySet<string>;
}

interface Entry {
	readonly rel: string;
	readonly kind: Kind;
}

const dirOf = (file: string): string => {
	const cut = file.lastIndexOf("/");
	return cut < 0 ? "" : file.slice(0, cut);
};
const baseOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
const join = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);
const within = (rel: string, folder: string): boolean =>
	folder === "" || rel === folder || rel.startsWith(`${folder}/`);

// Full walks below a folder, each walked once: every entry in walk order with its kind. A folder
// below one already walked comes from that walk. An allowed root is visited but never listed.
export class Walks {
	readonly #checkout: Checkout;
	readonly #roots: readonly string[];
	readonly #walked = new Map<string, { readonly kind: Kind; readonly entries: readonly Entry[] }>();

	constructor(checkout: Checkout, allowedRoots: readonly string[] = []) {
		this.#checkout = checkout;
		this.#roots = allowedRoots.map((root) => fold(root));
	}

	#held(rel: string): boolean {
		const folded = fold(`${rel}/`);
		return this.#roots.some((root) => folded.startsWith(root));
	}

	below(base: string): { readonly kind: Kind; readonly entries: readonly Entry[] } {
		const known = this.#walked.get(base);
		if (known !== undefined) return known;
		for (const [folder, walked] of this.#walked) {
			if (walked.kind !== "dir" || !within(base, folder)) continue;
			const kind = this.#checkout.kindOf(base);
			const entries =
				kind === "dir" ? walked.entries.filter(({ rel }) => within(rel, base) && rel !== base) : [];
			const found = { kind, entries };
			this.#walked.set(base, found);
			return found;
		}
		const entries: Entry[] = [];
		const kind = this.#checkout.walk(base, (rel, found) => {
			entries.push({ rel, kind: found });
			return !this.#held(rel);
		});
		const found = { kind, entries };
		this.#walked.set(base, found);
		return found;
	}

	// A folder's own entries, without walking below it.
	entries(base: string): { readonly kind: Kind; readonly entries: readonly Entry[] } {
		const entries: Entry[] = [];
		const kind = this.#checkout.walk(base, (rel, found) => {
			entries.push({ rel, kind: found });
			return false;
		});
		return { kind, entries };
	}
}

interface Picker {
	// Whether the tool would look into this folder.
	descend(rel: string): boolean;
	// Whether the tool would pick this file up.
	picks(rel: string): boolean;
}

class Scan {
	readonly candidates: Candidates;
	readonly folders = new Set<string>();
	readonly #input: ScanInput;

	constructor(input: ScanInput) {
		this.#input = input;
		this.candidates = new Candidates(input.checkout, input.listed);
	}

	allowed(rel: string): boolean {
		const folded = fold(`${rel}/`);
		return this.#input.allowedRoots.some((root) => folded.startsWith(fold(root)));
	}

	// Walks base as the tool would: what it picks up must be a regular, listed file, and nothing it
	// would follow may be a link, a redirect or a folder that can't be listed.
	pickUp(base: string, picker: Picker): void {
		if (this.allowed(base)) return;
		const { kind, entries } = this.#input.walks.below(base);
		if (kind === "missing") return;
		if (kind !== "dir") {
			this.candidates.refuse(base, kind);
			return;
		}
		this.folders.add(base);
		const pruned = new Set<string>();
		const skipped = (rel: string): boolean => {
			for (let at = dirOf(rel); at.length > base.length; at = dirOf(at)) {
				if (pruned.has(at)) return true;
			}
			return false;
		};
		for (const { rel, kind: found } of entries) {
			if (skipped(rel)) continue;
			if (found === "dir") {
				if (this.allowed(rel) || !picker.descend(rel)) pruned.add(rel);
				else this.folders.add(rel);
			} else if (found === "file" || found === "hardlink" || found === "special") {
				if (picker.picks(rel)) this.candidates.file(rel);
			} else if (!this.allowed(rel) && (picker.descend(rel) || picker.picks(rel))) {
				this.candidates.refuse(rel, found);
			}
		}
	}
}

export function scan(check: ScanCheck, input: ScanInput): ScanResult {
	const run = new Scan(input);
	if (check === "scan-pnpm") {
		for (const { rel, kind } of input.packages.refused) run.candidates.refuse(rel, kind);
		for (const dir of input.packages.dirs) run.folders.add(dir);
	} else if (check === "scan-tsc") tscScan(input, run);
	else if (check === "scan-vitest") vitestScan(input, run);
	else if (check === "scan-cargo") cargoScan(input, run);
	else if (check === "scan-verify") verifyScan(input, run);
	else prefetchScan(input, run);
	return { refused: run.candidates.refused, folders: run.folders };
}

// --- tsc ---

// TypeScript's include and exclude patterns: * and ? stay inside one name and, opening a name,
// never match a leading dot; ** spans folders that don't start with a dot and aren't a package
// folder; a last part with no dot or wildcard is a folder and everything below it. Excludes match a
// path or any folder above it, and their wildcards match anything.
const PACKAGE_FOLDERS = new Set(["node_modules", "bower_components", "jspm_packages"]);
const FOLDS_CASE = process.platform === "win32" || process.platform === "darwin";

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One name's pattern. Cargo's globs (classes) also take [...] classes, [!...] negated.
function namePattern(pattern: string, exclude: boolean, classes = false): RegExp {
	let source = "";
	const chars = [...pattern];
	for (let index = 0; index < chars.length; index++) {
		const char = chars[index] ?? "";
		const close = chars.indexOf("]", index + 2);
		if (char === "*") source += index === 0 && !exclude ? "(?:[^./][^/]*)?" : "[^/]*";
		else if (char === "?") source += index === 0 && !exclude ? "[^./]" : "[^/]";
		else if (classes && char === "[" && close > 0) {
			const body = chars.slice(index + 1, close).join("");
			const negated = body.startsWith("!");
			source += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&")}]`;
			index = close;
		} else source += escaped(char);
	}
	return new RegExp(`^${source}$`, FOLDS_CASE ? "is" : "s");
}

interface Spec {
	readonly parts: readonly string[];
	readonly names: readonly (RegExp | "**")[];
	// What a matched file may end with.
	readonly extensions: readonly string[];
}

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];

// A pattern from folder `anchor`, an absolute one from the root, resolved below the root; OUTSIDE for
// one that leaves the checkout, absolute elsewhere or climbing above the root, and null for one tsc
// refuses (.. after **).
function specOf(
	checkout: Checkout,
	anchor: string,
	pattern: string,
	extensions: readonly string[],
	exclude: boolean,
): Spec | typeof OUTSIDE | null {
	let from = anchor;
	let text = pattern.replaceAll("\\", "/");
	if (absolutePath(text)) {
		const below = belowRoot(checkout, text);
		if (below === OUTSIDE) return OUTSIDE;
		from = "";
		text = below;
	}
	const parts: string[] = [];
	for (const part of [...from.split("/"), ...text.split("/")]) {
		if (part === "" || part === ".") continue;
		if (part !== "..") parts.push(part);
		else if (parts.at(-1) === "**") return null;
		else if (parts.pop() === undefined) return OUTSIDE;
	}
	const last = parts.at(-1) ?? "";
	if (!/[.*?]/.test(last)) parts.push("**", "*");
	// tsc ignores an include ending in **; an exclude ending in it leaves that folder out whole.
	if (!exclude && parts.at(-1) === "**") return null;
	const tail = parts.at(-1) ?? "";
	const allowed = /\.json$/i.test(tail) ? [...extensions, ".json"] : extensions;
	return {
		parts,
		names: parts.map((part) => (part === "**" ? "**" : namePattern(part, exclude))),
		extensions: allowed,
	};
}

// Whether names match spec (all of it), or, as a folder, could hold a match (prefix).
function specMatches(
	spec: Spec,
	names: readonly string[],
	prefix: boolean,
	exclude: boolean,
): boolean {
	const memo = new Map<string, boolean>();
	const go = (i: number, j: number): boolean => {
		const key = `${i}:${j}`;
		const known = memo.get(key);
		if (known !== undefined) return known;
		let result: boolean;
		const pattern = spec.names[i];
		const name = names[j];
		if (pattern === undefined) result = j === names.length;
		else if (name === undefined) result = prefix;
		else if (pattern === "**") {
			const spans = exclude || (!name.startsWith(".") && !PACKAGE_FOLDERS.has(fold(name)));
			result = go(i + 1, j) || (spans && go(i, j + 1));
		} else result = pattern.test(name) && go(i + 1, j + 1);
		memo.set(key, result);
		return result;
	};
	return go(0, 0);
}

interface Project {
	readonly include: readonly Spec[];
	readonly exclude: readonly Spec[];
	// Whether an include pattern leaves the checkout.
	readonly outside: boolean;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: tsconfig's placeholder for its own folder.
const CONFIG_DIR = "${configDir}";

const lastOf = (json: JsonObject, key: string): Json | undefined =>
	json.object.filter(([name]) => name === key).at(-1)?.[1];
const stringList = (value: Json | undefined): string[] | undefined =>
	Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: undefined;

// A project's include and exclude patterns, through its relative extends: each key from the last
// config that sets it, its paths at that config's folder (${configDir} at the project's).
function projectOf(input: ScanInput, file: string): Project | null {
	const layers: { readonly dir: string; readonly json: JsonObject }[] = [];
	const seen = new Set<string>();
	const visit = (config: string, depth: number): void => {
		if (depth > 16 || seen.has(config)) return;
		seen.add(config);
		const text = input.listed(config) ? input.text(config) : null;
		const json = text === null ? undefined : parseJson(text);
		if (!isObject(json)) return;
		const dir = dirOf(config);
		const bases = lastOf(json, "extends");
		for (const base of typeof bases === "string" ? [bases] : (stringList(bases) ?? [])) {
			if (!base.startsWith(".") && !absolutePath(base.replaceAll("\\", "/"))) continue;
			const rel = resolveFrom(input.checkout, dir, base);
			if (typeof rel !== "string") continue;
			const kind = input.checkout.kindOf(rel);
			const target =
				kind === "dir"
					? join(rel, "tsconfig.json")
					: kind === "file" || /\.json$/i.test(rel)
						? rel
						: `${rel}.json`;
			visit(target, depth + 1);
		}
		layers.push({ dir, json });
	};
	visit(file, 0);
	if (layers.length === 0) return null;
	const project = dirOf(file);
	const setting = (
		key: string,
		options = false,
	): { readonly dir: string; readonly value: Json } | null => {
		for (const { dir, json } of layers.toReversed()) {
			const holder = options ? lastOf(json, "compilerOptions") : json;
			const value = isObject(holder) ? lastOf(holder, key) : undefined;
			if (value !== undefined) return { dir, value };
		}
		return null;
	};
	const at = (dir: string, value: string): [string, string] =>
		value.includes(CONFIG_DIR) ? [project, value.replaceAll(CONFIG_DIR, ".")] : [dir, value];
	const allowJs = setting("allowJs", true)?.value === true;
	const extensions = allowJs ? [...TS_EXTENSIONS, ...JS_EXTENSIONS] : TS_EXTENSIONS;
	const include = setting("include");
	const files = setting("files");
	const exclude = setting("exclude");
	const includes =
		include !== null
			? (stringList(include.value) ?? []).map((value) => at(include.dir, value))
			: files !== null
				? []
				: [[project, "**/*"] as [string, string]];
	const excludes: [string, string][] =
		exclude !== null
			? (stringList(exclude.value) ?? []).map((value) => at(exclude.dir, value))
			: ["outDir", "declarationDir"].flatMap((key) => {
					const out = setting(key, true);
					return out !== null && typeof out.value === "string" ? [at(out.dir, out.value)] : [];
				});
	// An exclude that leaves the checkout leaves nothing out of it.
	let outside = false;
	const specs = (list: readonly [string, string][], exclusive: boolean): Spec[] =>
		list.flatMap(([dir, value]) => {
			const spec = specOf(input.checkout, dir, value, extensions, exclusive);
			if (spec === OUTSIDE && !exclusive) outside = true;
			return spec === null || spec === OUTSIDE ? [] : [spec];
		});
	const included = specs(includes, false);
	return { include: included, exclude: specs(excludes, true), outside };
}

const TSCONFIG = /^tsconfig[^/]*\.json$/i;

// Each listed tsconfig.json, and each other tsconfig*.json that sets include or files, is a project
// tsc may build: what its include patterns pick up from their folders, outside its excludes. A
// project whose include leaves the checkout is refused.
function tscScan(input: ScanInput, run: Scan): void {
	for (const file of input.files) {
		const name = baseOf(file);
		if (!TSCONFIG.test(name)) continue;
		if (fold(name) !== "tsconfig.json") {
			const text = input.text(file);
			const json = text === null ? undefined : parseJson(text);
			if (!isObject(json) || !json.object.some(([key]) => key === "include" || key === "files")) {
				continue;
			}
		}
		const project = projectOf(input, file);
		if (project === null) continue;
		if (project.outside) run.candidates.refuse(file, "outside");
		const excluded = (rel: string): boolean => {
			const names = rel.split("/");
			return project.exclude.some((spec) =>
				names.some((_, end) => specMatches(spec, names.slice(0, end + 1), false, true)),
			);
		};
		const picker: Picker = {
			descend: (rel) =>
				!excluded(rel) &&
				project.include.some((spec) => specMatches(spec, rel.split("/"), true, false)),
			picks: (rel) => {
				const lower = rel.toLowerCase();
				return (
					!excluded(rel) &&
					project.include.some(
						(spec) =>
							spec.extensions.some((extension) => lower.endsWith(extension)) &&
							specMatches(spec, rel.split("/"), false, false),
					)
				);
			},
		};
		const bases = new Set<string>();
		for (const spec of project.include) {
			const base: string[] = [];
			for (const part of spec.parts.slice(0, -1)) {
				if (/[*?]/.test(part)) break;
				base.push(part);
			}
			bases.add(base.join("/"));
		}
		for (const base of bases) run.pickUp(base, picker);
	}
}

// --- Vitest ---

const RUNNER_CONFIG = /^(?:(?:vitest|vite)\.config|vitest\.workspace)\.(?:[cm]?[jt]s|json)$/;

// Vitest's tier globs as the file-name endings they match (each is **/*<ending>, matched with dot
// files included).
const TIER_ENDINGS = Object.values(tierFiles).map((glob) => glob.replace(/^\*\*\/\*/, ""));

// The configs Vitest and Vite load where they start (each package folder, the folders holding
// packages and the root), and every file a tier glob matches in a package folder: Vitest's walk
// takes dot folders and follows links.
function vitestScan(input: ScanInput, run: Scan): void {
	const starts = new Set(["", ...input.packages.dirs, ...input.packages.dirs.map(dirOf)]);
	for (const start of starts) {
		if (run.allowed(start)) continue;
		const { kind, entries } = input.walks.entries(start);
		if (kind !== "dir") continue;
		for (const { rel } of entries) if (RUNNER_CONFIG.test(baseOf(rel))) run.candidates.file(rel);
	}
	const picker: Picker = {
		descend: () => true,
		picks: (rel) => TIER_ENDINGS.some((ending) => baseOf(rel).endsWith(ending)),
	};
	for (const dir of input.packages.dirs) run.pickUp(dir, picker);
}

// --- Cargo ---

// Cargo's own scan of a crate: its build script (unless [package] build is false or names one),
// src/lib.rs, src/main.rs, the targets it finds in src/bin, tests, benches and examples (*.rs and
// */main.rs), glob members of a workspace, and the manifests above it it reads to find its
// workspace; and each folder's .cargo config and rustup toolchain file from the crate up to the
// root. target/ is never walked.
function cargoScan(input: ScanInput, run: Scan): void {
	const targets = (folder: string): void => {
		const { kind, entries } = input.walks.entries(folder);
		if (kind === "missing") return;
		if (kind !== "dir") {
			run.candidates.refuse(folder, kind);
			return;
		}
		run.folders.add(folder);
		for (const { rel, kind: found } of entries) {
			if (found === "dir") {
				run.folders.add(rel);
				run.candidates.file(`${rel}/main.rs`);
			} else if (/\.rs$/i.test(rel)) run.candidates.file(rel);
			else if (found === "link" || found === "redirect" || found === "unreadable") {
				run.candidates.refuse(rel, found);
			}
		}
	};
	for (const manifest of input.files) {
		if (fold(baseOf(manifest)) !== "cargo.toml") continue;
		const text = input.text(manifest);
		const toml = text === null ? null : parseToml(text);
		if (toml === null) continue;
		const dir = dirOf(manifest);
		const pkg = tableAt(toml, "package") ?? tableAt(toml, "project");
		if (pkg !== null) {
			if (pkg.build === undefined || pkg.build === true) run.candidates.file(join(dir, "build.rs"));
			run.candidates.file(join(dir, "src/lib.rs"));
			run.candidates.file(join(dir, "src/main.rs"));
			for (const folder of ["src/bin", "tests", "benches", "examples"]) targets(join(dir, folder));
		}
		const workspace = tableAt(toml, "workspace");
		if (workspace !== null) members(input, run, manifest, workspace);
		for (let at = dir; ; at = dirOf(at)) {
			if (at !== dir) run.candidates.file(join(at, "Cargo.toml"));
			for (const name of [
				".cargo/config",
				".cargo/config.toml",
				"rust-toolchain",
				"rust-toolchain.toml",
			]) {
				run.candidates.file(join(at, name));
			}
			if (at === "") break;
		}
	}
}

// A workspace's glob members (members without a wildcard are lib/references.ts's), outside its
// excludes: each folder they match must hold a regular, listed Cargo.toml where it holds one. A glob
// member that leaves the checkout refuses the manifest.
function members(input: ScanInput, run: Scan, manifest: string, workspace: TomlTable): void {
	const dir = dirOf(manifest);
	const list = (key: string): string[] => {
		const value: Toml | undefined = workspace[key];
		return Array.isArray(value)
			? value.filter((item): item is string => typeof item === "string")
			: [];
	};
	const excluded = new Set(
		list("exclude").flatMap((value) => {
			const rel = resolveFrom(input.checkout, dir, value);
			return typeof rel === "string" ? [fold(rel)] : [];
		}),
	);
	for (const member of list("members")) {
		if (!/[*?[]/.test(member)) continue;
		const text = member.replaceAll("\\", "/");
		const below = absolutePath(text) ? belowRoot(input.checkout, text) : null;
		if (below === OUTSIDE || resolveFrom(input.checkout, dir, member) === OUTSIDE) {
			run.candidates.refuse(manifest, "outside");
			continue;
		}
		const parts: string[] = [];
		for (const part of [...(below === null ? dir.split("/") : []), ...(below ?? text).split("/")]) {
			if (part === "" || part === ".") continue;
			if (part !== "..") parts.push(part);
			else parts.pop();
		}
		const spec: Spec = {
			parts,
			names: parts.map((part) => (part === "**" ? "**" : namePattern(part, true, true))),
			extensions: [],
		};
		const base: string[] = [];
		for (const part of parts) {
			if (/[*?[]/.test(part)) break;
			base.push(part);
		}
		const { kind, entries } = input.walks.below(base.join("/"));
		if (kind !== "dir") continue;
		for (const { rel, kind: found } of entries) {
			if (excluded.has(fold(rel)) || run.allowed(rel)) continue;
			if (!specMatches(spec, rel.split("/"), false, true)) continue;
			if (found === "dir") run.candidates.folder(rel, ["Cargo.toml"]);
			else if (found === "link" || found === "redirect" || found === "unreadable") {
				run.candidates.refuse(rel, found);
			}
		}
	}
}

// --- verify and prefetch ---

// The steps and profiles verify's registry imports: each *.ts in those folders but tests and
// declarations (lib/registry.ts's filter).
function verifyScan(input: ScanInput, run: Scan): void {
	for (const folder of ["tools/verify/steps", "tools/verify/profiles"]) {
		const { kind, entries } = input.walks.entries(folder);
		if (kind === "missing") continue;
		if (kind !== "dir") {
			run.candidates.refuse(folder, kind);
			continue;
		}
		run.folders.add(folder);
		for (const { rel } of entries) {
			const name = baseOf(rel);
			if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
				run.candidates.file(rel);
			}
		}
	}
}

// The prefetch.ts of each folder in spikes/, which pnpm m0:prefetch runs. It looks through links.
function prefetchScan(input: ScanInput, run: Scan): void {
	const { kind, entries } = input.walks.entries("spikes");
	if (kind === "missing") return;
	if (kind !== "dir") {
		run.candidates.refuse("spikes", kind);
		return;
	}
	run.folders.add("spikes");
	for (const { rel, kind: found } of entries) {
		if (run.allowed(rel)) continue;
		if (found === "dir") run.candidates.file(`${rel}/prefetch.ts`);
		else if (found === "link" || found === "redirect" || found === "unreadable") {
			run.candidates.refuse(rel, found);
		}
	}
}
