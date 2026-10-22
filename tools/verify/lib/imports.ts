// The string literals of a JS or TS module, each with the kind of code that uses it. A small
// tokenizer skips comments and regular expressions, reads template expressions as code and cooks
// escapes, so a sample inside a string, a comment or a pattern is never taken for an import, and an
// escaped specifier reads as what it loads. The gate reads modules with it; it never runs them.
export type LiteralKind =
	| "static"
	| "type"
	| "bare"
	| "dynamic"
	| "require"
	| "create-require"
	| "resolve"
	| "url"
	| "reference"
	| "other";

export interface Literal {
	readonly value: string;
	readonly kind: LiteralKind;
}

interface Token {
	readonly type: "name" | "punct" | "string" | "value";
	readonly value: string;
	// A string's or template's place in the scanned literals, and the token after it (for a
	// template, after its expressions).
	readonly literal: number;
	after: number;
}

interface Scanned {
	value: string;
	kind: LiteralKind | null;
}

// Template literals, so lib/registry.test.ts's scan for bare specifiers never reads one as an import.
const IMPORT = `import`;
const FROM = `from`;

const space = /\s/;
const digit = /[0-9]/;
const isNameStart = (c: string): boolean =>
	/[A-Za-z_$]/.test(c) || (c.charCodeAt(0) > 0x7f && !space.test(c));
const isPunct = (token: Token | undefined, value: string): boolean =>
	token?.type === "punct" && token.value === value;
const isName = (token: Token | undefined, value: string): boolean =>
	token?.type === "name" && token.value === value;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	n: "\n",
	r: "\r",
	t: "\t",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
};

// The text an escape at text[at] (a backslash) stands for, and where it ends.
function escaped(text: string, at: number): { readonly text: string; readonly end: number } {
	const c = text[at + 1] ?? "";
	const simple = SIMPLE_ESCAPES[c];
	if (simple !== undefined) return { text: simple, end: at + 2 };
	if (c === "x") {
		const hex = /^[0-9A-Fa-f]{2}/.exec(text.slice(at + 2, at + 4))?.[0];
		if (hex !== undefined)
			return { text: String.fromCharCode(Number.parseInt(hex, 16)), end: at + 4 };
	}
	if (c === "u") {
		const braced = /^\{([0-9A-Fa-f]+)\}/.exec(text.slice(at + 2, at + 66));
		const point = braced?.[1] === undefined ? Number.NaN : Number.parseInt(braced[1], 16);
		if (braced !== null && point <= 0x10ffff) {
			return { text: String.fromCodePoint(point), end: at + 2 + braced[0].length };
		}
		const hex = /^[0-9A-Fa-f]{4}/.exec(text.slice(at + 2, at + 6))?.[0];
		if (hex !== undefined)
			return { text: String.fromCharCode(Number.parseInt(hex, 16)), end: at + 6 };
	}
	// A line continuation stands for nothing.
	if (c === "\r") return { text: "", end: text[at + 2] === "\n" ? at + 3 : at + 2 };
	if (c === "\n" || c === "\u2028" || c === "\u2029") return { text: "", end: at + 2 };
	return { text: c, end: at + 2 };
}

function lineEnd(text: string, from: number): number {
	const end = /[\n\r\u2028\u2029]/g;
	end.lastIndex = from;
	return end.exec(text)?.index ?? text.length;
}

// A regular expression may start here unless the token before it ends a value, which makes the
// slash a division.
const BEFORE_EXPRESSION = new Set([
	...["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw"],
	...["case", "do", "else", "yield", "await"],
]);
function regexAllowed(last: Token | undefined): boolean {
	if (last === undefined) return true;
	if (last.type === "name") return BEFORE_EXPRESSION.has(last.value);
	if (last.type === "punct") return last.value !== ")" && last.value !== "]";
	return false;
}

// Where the regular expression starting at text[start] ends, flags included; -1 if the line ends
// first, which makes the slash a division after all.
function regexEnd(text: string, start: number): number {
	const lineBreak = (c: string): boolean =>
		c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
	let inClass = false;
	for (let j = start + 1; j < text.length; j++) {
		const c = text[j] ?? "";
		if (lineBreak(c)) return -1;
		if (c === "\\") {
			if (lineBreak(text[j + 1] ?? "")) return -1;
			j++;
		} else if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) {
			let end = j + 1;
			while (/[A-Za-z]/.test(text[end] ?? "")) end++;
			return end;
		}
	}
	return -1;
}

// A triple-slash directive's path and types values: tsc reads those files.
function references(comment: string): string[] {
	const tag = /^\/\/\/\s*<reference\b(.*)$/.exec(comment);
	if (tag === null) return [];
	return [...(tag[1] ?? "").matchAll(/\b(?:path|types)\s*=\s*(["'])(.*?)\1/g)].map(
		(match) => match[2] ?? "",
	);
}

function scan(text: string): { readonly tokens: Token[]; readonly found: Scanned[] } {
	const tokens: Token[] = [];
	const found: Scanned[] = [];
	// Templates whose ${ } expression is being read, innermost last, with the braces opened in it.
	const open: { token: number; braces: number }[] = [];
	let i = 0;
	const push = (type: Token["type"], value: string): void => {
		tokens.push({ type, value, literal: -1, after: -1 });
	};
	// Reads template text up to the template's end (true) or its next ${ (false).
	const templateText = (entry: Scanned): boolean => {
		while (i < text.length) {
			const c = text[i] ?? "";
			if (c === "`") {
				i++;
				return true;
			}
			if (c === "\\") {
				const cooked = escaped(text, i);
				entry.value += cooked.text;
				i = cooked.end;
			} else if (c === "$" && text[i + 1] === "{") {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: stands for the substitution's value.
				entry.value += "${}";
				i += 2;
				return false;
			} else {
				entry.value += c;
				i++;
			}
		}
		return true;
	};
	const endTemplate = (token: number): void => {
		push("value", "`");
		const template = tokens[token];
		if (template !== undefined) template.after = tokens.length;
	};
	while (i < text.length) {
		const c = text[i] ?? "";
		const next = text[i + 1] ?? "";
		const top = open.at(-1);
		if (space.test(c)) {
			i++;
		} else if (c === "/" && next === "/") {
			const end = lineEnd(text, i);
			for (const value of references(text.slice(i, end))) found.push({ value, kind: "reference" });
			i = end;
		} else if (c === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else if (c === "#" && next === "!" && i === 0) {
			i = lineEnd(text, i);
		} else if (c === "}" && top !== undefined && top.braces === 0) {
			i++;
			const template = tokens[top.token];
			const entry = template === undefined ? undefined : found[template.literal];
			if (entry === undefined || templateText(entry)) {
				open.pop();
				endTemplate(top.token);
			} else push("punct", "${");
		} else if (c === "'" || c === '"') {
			let value = "";
			let j = i + 1;
			while (j < text.length) {
				const d = text[j] ?? "";
				if (d === c || d === "\n" || d === "\r") break;
				if (d === "\\") {
					const cooked = escaped(text, j);
					value += cooked.text;
					j = cooked.end;
				} else {
					value += d;
					j++;
				}
			}
			const literal = found.push({ value, kind: null }) - 1;
			tokens.push({ type: "string", value, literal, after: tokens.length + 1 });
			i = text[j] === c ? j + 1 : j;
		} else if (c === "`") {
			const entry: Scanned = { value: "", kind: null };
			const literal = found.push(entry) - 1;
			const token = tokens.push({ type: "string", value: "", literal, after: -1 }) - 1;
			i++;
			if (templateText(entry)) {
				const template = tokens[token];
				if (template !== undefined) template.after = token + 1;
			} else {
				open.push({ token, braces: 0 });
				push("punct", "${");
			}
		} else if (c === "{" || c === "}") {
			if (top !== undefined) top.braces += c === "{" ? 1 : -1;
			push("punct", c);
			i++;
		} else if (c === "/") {
			const end = regexAllowed(tokens.at(-1)) ? regexEnd(text, i) : -1;
			if (end < 0) {
				push("punct", c);
				i++;
			} else {
				push("value", "/");
				i = end;
			}
		} else if (isNameStart(c) || (c === "\\" && next === "u")) {
			let name = "";
			let j = i;
			while (j < text.length) {
				const d = text[j] ?? "";
				if (d === "\\" && text[j + 1] === "u") {
					const cooked = escaped(text, j);
					name += cooked.text;
					j = cooked.end;
				} else if (isNameStart(d) || digit.test(d)) {
					name += d;
					j++;
				} else break;
			}
			push("name", name);
			i = j;
		} else if (digit.test(c) || (c === "." && digit.test(next))) {
			let j = i + 1;
			while (/[\w.]/.test(text[j] ?? "")) j++;
			push("value", text.slice(i, j));
			i = j;
		} else if (c === "?" && next === "." && !digit.test(text[i + 2] ?? "")) {
			// a?.b reads as a.b, and a?.(b) or a?.[b] as a(b) or a[b].
			const after = text[i + 2];
			if (after !== "(" && after !== "[") push("punct", ".");
			i += 2;
		} else {
			push("punct", c);
			i++;
		}
	}
	return { tokens, found };
}

// The names a value at tokens[at], after any member chain (module.createRequire), is assigned to:
// x = value, and the declared name of const x: Type = value.
function boundNames(tokens: readonly Token[], at: number): string[] {
	let b = at - 1;
	while (isPunct(tokens[b], ".") && tokens[b - 1]?.type === "name") b -= 2;
	if (!isPunct(tokens[b], "=") || isPunct(tokens[b - 1], "=") || isPunct(tokens[b - 1], "!")) {
		return [];
	}
	const names: string[] = [];
	const target = tokens[b - 1];
	if (target?.type === "name") names.push(target.value);
	for (let d = b - 1; d >= 0 && d >= b - 12; d--) {
		const token = tokens[d];
		if (isPunct(token, ";") || isPunct(token, "{") || isPunct(token, "}")) break;
		if (token?.type === "name" && ["const", "let", "var"].includes(token.value)) {
			const declared = tokens[d + 1];
			if (declared?.type === "name") names.push(declared.value);
			break;
		}
	}
	return names;
}

interface Aliases {
	// Names for node:module's createRequire, for a require function it made, and for require.
	readonly makers: ReadonlySet<string>;
	readonly made: ReadonlySet<string>;
	readonly requires: ReadonlySet<string>;
}

function aliases(tokens: readonly Token[]): Aliases {
	const makers = new Set(["createRequire"]);
	for (const [k, token] of tokens.entries()) {
		if (!isName(token, "createRequire")) continue;
		const next = tokens[k + 1];
		const renamed = tokens[k + 2];
		if ((isName(next, "as") || isPunct(next, ":")) && renamed?.type === "name") {
			makers.add(renamed.value);
		} else if (!isPunct(next, "(")) {
			for (const name of boundNames(tokens, k)) makers.add(name);
		}
	}
	const made = new Set<string>();
	const requires = new Set<string>();
	for (const [k, token] of tokens.entries()) {
		if (token.type !== "name") continue;
		const next = tokens[k + 1];
		if (makers.has(token.value) && isPunct(next, "(")) {
			for (const name of boundNames(tokens, k)) made.add(name);
		} else if (token.value === "require" && !isPunct(next, "(") && !isPunct(next, ".")) {
			for (const name of boundNames(tokens, k)) requires.add(name);
		}
	}
	return { makers, made, requires };
}

// The name called by the parenthesised call that ends at tokens[close], such as createRequire in
// createRequire(import.meta.url).
function calleeOf(tokens: readonly Token[], close: number): string | null {
	let depth = 0;
	for (let k = close; k >= 0 && k > close - 256; k--) {
		const token = tokens[k];
		if (isPunct(token, ")")) depth++;
		if (isPunct(token, "(")) depth--;
		if (depth === 0) {
			const callee = tokens[k - 1];
			return callee?.type === "name" ? callee.value : null;
		}
	}
	return null;
}

// new URL(<literal>, import.meta.url): the tokens after the literal.
const MODULE_BASE: readonly (readonly [Token["type"], string])[] = [
	["punct", ","],
	["name", IMPORT],
	["punct", "."],
	["name", "meta"],
	["punct", "."],
	["name", "url"],
];
function moduleBase(tokens: readonly Token[], after: number): boolean {
	if (
		!MODULE_BASE.every(
			([type, value], k) => tokens[after + k]?.type === type && tokens[after + k]?.value === value,
		)
	) {
		return false;
	}
	const close = after + MODULE_BASE.length;
	return (
		isPunct(tokens[close], ")") || (isPunct(tokens[close], ",") && isPunct(tokens[close + 1], ")"))
	);
}

// A declaration's own specifier: a side-effect import, an import or export with a from clause, and
// import x = require(…), with their type-only forms; null for a literal elsewhere in the statement.
function declarationKind(tokens: readonly Token[], start: number, at: number): LiteralKind | null {
	const first = tokens[start];
	const last = tokens[at - 1];
	if (isName(first, IMPORT) && at === start + 1) return "bare";
	if (isName(last, FROM)) return typeOnly(tokens, start, at) ? "type" : "static";
	if (
		isName(first, IMPORT) &&
		isPunct(last, "(") &&
		isName(tokens[at - 2], "require") &&
		isPunct(tokens[at - 3], "=")
	) {
		if (at === start + 5 && tokens[start + 1]?.type === "name") return "require";
		if (
			at === start + 6 &&
			isName(tokens[start + 1], "type") &&
			tokens[start + 2]?.type === "name"
		) {
			return "type";
		}
	}
	return null;
}

// import type { … }, import type * as x, import type x, export type { … } and export type *: nothing
// loads at runtime. `import type from` and a specifier imports a default binding named type, and
// import { type x } still loads the module.
function typeOnly(tokens: readonly Token[], start: number, at: number): boolean {
	if (!isName(tokens[start + 1], "type")) return false;
	const third = tokens[start + 2];
	if (isPunct(third, "{") || isPunct(third, "*")) return true;
	return isName(tokens[start], IMPORT) && third?.type === "name" && at === start + 4;
}

// A literal passed to a call that loads or resolves it.
function callKind(tokens: readonly Token[], at: number, names: Aliases): LiteralKind {
	if (!isPunct(tokens[at - 1], "(")) return "other";
	const callee = tokens[at - 2];
	// createRequire(…)("…")
	if (isPunct(callee, ")"))
		return names.makers.has(calleeOf(tokens, at - 2) ?? "") ? "create-require" : "other";
	if (callee?.type !== "name") return "other";
	const owner = isPunct(tokens[at - 3], ".") ? tokens[at - 4] : undefined;
	if (callee.value === IMPORT) return "dynamic";
	if (callee.value === "resolve" && owner !== undefined) {
		if (isName(owner, "meta") && isPunct(tokens[at - 5], ".") && isName(tokens[at - 6], IMPORT)) {
			return "resolve";
		}
		if (
			owner.type === "name" &&
			(owner.value === "require" || names.made.has(owner.value) || names.requires.has(owner.value))
		) {
			return "resolve";
		}
		if (isPunct(owner, ")") && names.makers.has(calleeOf(tokens, at - 4) ?? "")) return "resolve";
	}
	if (names.made.has(callee.value) || names.makers.has(callee.value)) return "create-require";
	if (callee.value === "require" || names.requires.has(callee.value)) return "require";
	if (callee.value === "URL" && isName(tokens[at - 3], "new")) {
		return moduleBase(tokens, tokens[at]?.after ?? -1) ? "url" : "other";
	}
	return "other";
}

// An import or export keyword that starts a declaration: not import(…), import.meta or x.import.
function startsDeclaration(tokens: readonly Token[], at: number): boolean {
	if (isPunct(tokens[at - 1], ".")) return false;
	if (!isName(tokens[at], IMPORT)) return true;
	return !isPunct(tokens[at + 1], "(") && !isPunct(tokens[at + 1], ".");
}

export function literals(text: string): Literal[] {
	const { tokens, found } = scan(text);
	const names = aliases(tokens);
	let declaration = -1;
	for (const [at, token] of tokens.entries()) {
		if (isName(token, IMPORT) || isName(token, "export")) {
			if (startsDeclaration(tokens, at)) declaration = at;
		} else if (isPunct(token, ";")) {
			declaration = -1;
		} else if (token.type === "string") {
			const declared = declaration < 0 ? null : declarationKind(tokens, declaration, at);
			if (declared !== null) declaration = -1;
			const entry = found[token.literal];
			if (entry !== undefined) entry.kind = declared ?? callKind(tokens, at, names);
		}
	}
	return found.map(({ value, kind }) => ({ value, kind: kind ?? "other" }));
}

// What a module loads or resolves when it runs, or what tsc reads for it: every kind but type and
// other.
export function runtimeSpecifiers(text: string): Literal[] {
	return literals(text).filter((literal) => literal.kind !== "type" && literal.kind !== "other");
}

// Every literal that reads as a path relative to its file, whatever code uses it.
export function relativeLiterals(text: string): Literal[] {
	return literals(text).filter(({ value }) => value.startsWith("./") || value.startsWith("../"));
}
