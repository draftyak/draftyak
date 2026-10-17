// Rule types and the matchers that apply them. Every literal pattern lives in ../rules/, where the
// scan applies only the secret and attribution rules, so no other file holds a forbidden string.

// vendor: code-shaped references (paths, variables, endpoints, packages, commands); in *.md they
// pass only through allow.json, and data-only paths skip them. secret and attribution: every file
// and commit message. evidence: JSON under spikes/**/evidence/. mark: identifiers.
export type Kind = "vendor" | "secret" | "attribution" | "evidence" | "mark";

// A rule's positive (bad) or negative (good) case: tests write it into a temp dir at runtime.
export interface Sample {
	readonly path: string;
	readonly text: string;
}

interface RuleBase {
	readonly id: string;
	readonly reason: string;
	readonly bad: readonly Sample[];
	readonly good: readonly Sample[];
}

export interface PatternRule extends RuleBase {
	readonly kind: Exclude<Kind, "mark">;
	// Without the g or y flag, and linear in the line's length. A rule matches where any does.
	readonly patterns: readonly RegExp[];
	// Whether a match counts; for evidence, given the JSON key the string sits under.
	readonly accept?: (match: string, key: string | undefined) => boolean;
}

export interface MarkRule extends RuleBase {
	readonly kind: "mark";
	// Lower-case words no package, bin, crate, Python, Tauri or Android identifier may contain.
	readonly marks: readonly string[];
}

export type Rule = PatternRule | MarkRule;

export interface Hit {
	readonly rule: Rule;
	// 0 for the file's path.
	readonly line: number;
	readonly column: number;
	// The whole line, for allow.json hashes; findings never print it.
	readonly text: string;
}

export const inCode = (text: string): Sample => ({ path: "src/sample.ts", text });

// Joins pieces at runtime, so the repository never holds a whole token shape.
export const glue = (...parts: readonly string[]): string => parts.join("");

// Lines as pr-meta (M0.3) splits them: a lone CR ends one too.
export const lines = (text: string): string[] => text.split(/\r\n|\r|\n/);

// `command [flags] arg` with up to 8 flags, each with an optional value, before arg: in a shell
// line, in spawn or list arguments, or in chained .arg()/.args() calls. A flag starts with a dash
// and a value never does, so every path through it is linear.
export function spawned(command: string, arg: string): RegExp {
	const q = "[\"'`]?";
	const sep = "(?:\\s+|\\s*,\\s*(?:\\[\\s*)?|\\s*\\)\\s*\\.args?\\(\\s*(?:&?\\[\\s*|vec!\\[\\s*)?)";
	const bare = "[^\\s\"'`,;()\\[\\]{}]";
	const flag = `${q}--?[a-z][\\w-]{0,40}(?:=${bare}{0,200})?${q}`;
	const value = `(?:"(?!-)[^"]{0,200}"|'(?!-)[^']{0,200}'|(?![-"'\`])${bare}{1,200})`;
	return new RegExp(
		`(?<![\\w.-])${command}(?:\\.exe|\\.cmd)?${q}(?:${sep}${flag}(?:${sep}${value})?){0,8}?${sep}${q}(?:${arg})(?![\\w-])`,
		"i",
	);
}

const globals = new WeakMap<RegExp, RegExp>();

function allMatches(pattern: RegExp, text: string): IterableIterator<RegExpExecArray> {
	let global = globals.get(pattern);
	if (global === undefined) {
		global = new RegExp(pattern.source, `${pattern.flags}g`);
		globals.set(pattern, global);
	}
	return text.matchAll(global);
}

// The 0-based index of the rule's first counted match in `text`.
export function find(rule: PatternRule, text: string, key?: string): number | undefined {
	for (const pattern of rule.patterns) {
		if (rule.accept === undefined) {
			const match = pattern.exec(text);
			if (match !== null) return match.index;
			continue;
		}
		for (const match of allMatches(pattern, text)) {
			if (rule.accept(match[0], key)) return match.index;
		}
	}
	return undefined;
}

// At most one hit per rule and line.
export function lineHits(text: string, rules: readonly PatternRule[]): Hit[] {
	const hits: Hit[] = [];
	for (const [index, line] of lines(text).entries()) {
		for (const rule of rules) {
			const at = find(rule, line);
			if (at !== undefined) hits.push({ rule, line: index + 1, column: at + 1, text: line });
		}
	}
	return hits;
}

export interface JsonString {
	readonly value: string;
	readonly line: number;
	readonly column: number;
	readonly isKey: boolean;
	// The key a value sits under (array items inherit their array's); undefined for keys.
	readonly key: string | undefined;
	// The keys of the enclosing containers below the top level, outermost first.
	readonly parents: readonly string[];
}

interface Frame {
	readonly array: boolean;
	readonly key: string | undefined;
	pending: string | undefined;
	expectKey: boolean;
}

// Every string of a JSON text, keys included, with its position. Throws on invalid JSON.
export function jsonStrings(text: string): JsonString[] {
	JSON.parse(text);
	const found: JsonString[] = [];
	const stack: Frame[] = [];
	let line = 1;
	let lineStart = 0;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const top = stack.at(-1);
		if (char === "\n" || (char === "\r" && text[i + 1] !== "\n")) {
			line++;
			lineStart = i + 1;
		} else if (char === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
			const value: string = JSON.parse(text.slice(i, end + 1));
			const isKey = top !== undefined && !top.array && top.expectKey;
			const key = isKey || top === undefined ? undefined : top.array ? top.key : top.pending;
			const parents = stack.slice(1).map((frame) => frame.key ?? "");
			found.push({ value, line, column: i - lineStart + 1, isKey, key, parents });
			if (isKey) top.pending = value;
			i = end;
		} else if (char === "{" || char === "[") {
			const key = top === undefined ? undefined : top.array ? top.key : top.pending;
			stack.push({ array: char === "[", key, pending: undefined, expectKey: char === "{" });
		} else if (char === "}" || char === "]") {
			stack.pop();
		} else if (char === ":" && top !== undefined) {
			top.expectKey = false;
		} else if (char === "," && top !== undefined && !top.array) {
			top.expectKey = true;
		}
	}
	return found;
}

// Evidence rules on every JSON string, keys included; `subject` drops what is exempt.
export function evidenceHits(
	text: string,
	rules: readonly PatternRule[],
	subject: (value: string) => string | undefined,
): Hit[] {
	const hits: Hit[] = [];
	for (const string of jsonStrings(text)) {
		const checked = subject(string.value);
		if (checked === undefined) continue;
		for (const rule of rules) {
			if (find(rule, checked, string.key) !== undefined) {
				hits.push({ rule, line: string.line, column: string.column, text: "" });
			}
		}
	}
	return hits;
}

interface Identifier {
	readonly value: string;
	readonly line: number;
	readonly column: number;
}

// Patterns with the d flag; group 1 is the identifier.
function lineValues(text: string, pattern: RegExp): Identifier[] {
	const found: Identifier[] = [];
	for (const [index, line] of lines(text).entries()) {
		const match = pattern.exec(line);
		const start = match?.indices?.[1]?.[0];
		if (match?.[1] && start !== undefined) {
			found.push({ value: match[1], line: index + 1, column: start + 1 });
		}
	}
	return found;
}

const tomlHeader = /^\s*\[\[?([^\]]+)\]\]?/;
const tomlInline = /^\s*["']?([\w.-]+)["']?\s*=\s*\{/;
const tomlPair = /(?:^|[{,])\s*["']?([\w.-]+)["']?\s*=\s*["']([^"']*)["']/dg;

// Table name -> the key whose value is an identifier, or "*" when every key is one (scripts). An
// inline table, such as scripts = { … }, counts as the table it names.
function tomlValues(text: string, tables: Readonly<Record<string, string>>): Identifier[] {
	const found: Identifier[] = [];
	let table = "";
	for (const [index, line] of lines(text).entries()) {
		const header = tomlHeader.exec(line);
		if (header) {
			table = (header[1] ?? "").replace(/[\s"']/g, "");
			continue;
		}
		const inline = tomlInline.exec(line);
		const wanted = tables[inline ? `${table}.${inline[1]}` : table];
		if (wanted === undefined) continue;
		const from = inline ? inline[0].length - 1 : 0;
		for (const pair of line.slice(from).matchAll(tomlPair)) {
			if (!inline && pair.index !== 0) break;
			const group = wanted === "*" ? 1 : pair[1] === wanted ? 2 : undefined;
			const start = group === undefined ? undefined : pair.indices?.[group]?.[0];
			if (group !== undefined && start !== undefined) {
				found.push({ value: pair[group] ?? "", line: index + 1, column: from + start + 1 });
			}
			if (!inline) break;
		}
	}
	return found;
}

const tauriIds = /["']?\b(?:identifier|productName|mainBinaryName)["']?\s*[:=]\s*["']([^"']+)["']/d;
const gradleIds =
	/\b(?:applicationId|applicationIdSuffix|namespace)\b\s*(?:=\s*)?(?:\(\s*)?["']([^"']+)["']/d;
const gradleRoot = /\brootProject\.name\s*=\s*["']([^"']+)["']/d;
const manifestPackage = /\bpackage\s*=\s*["']([^"']+)["']/d;

// Package, bin, crate, Python project and script, Tauri and Android identifiers in a manifest.
export function identifiers(file: string, text: string): Identifier[] {
	const name = file.slice(file.lastIndexOf("/") + 1);
	if (name === "package.json") {
		let strings: JsonString[];
		try {
			strings = jsonStrings(text);
		} catch {
			return [];
		}
		return strings.filter(
			(s) =>
				(s.parents.length === 0 && s.key === "name") ||
				(s.isKey && s.parents.length === 1 && s.parents[0] === "bin"),
		);
	}
	if (/^tauri(?:\.[\w-]+)?\.conf\.json5?$|^tauri\.toml$/i.test(name)) {
		return lineValues(text, tauriIds);
	}
	if (name === "Cargo.toml") return tomlValues(text, { package: "name", lib: "name", bin: "name" });
	if (name === "pyproject.toml") {
		return tomlValues(text, {
			project: "name",
			"project.scripts": "*",
			"project.gui-scripts": "*",
			"tool.poetry": "name",
			"tool.poetry.scripts": "*",
		});
	}
	if (/^build\.gradle(?:\.kts)?$/.test(name)) return lineValues(text, gradleIds);
	if (/^settings\.gradle(?:\.kts)?$/.test(name)) return lineValues(text, gradleRoot);
	if (name === "AndroidManifest.xml") return lineValues(text, manifestPackage);
	return [];
}

export function markHits(rule: MarkRule, file: string, text: string): Hit[] {
	return identifiers(file, text)
		.filter(({ value }) => rule.marks.some((mark) => value.toLowerCase().includes(mark)))
		.map(({ line, column }) => ({ rule, line, column, text: "" }));
}
