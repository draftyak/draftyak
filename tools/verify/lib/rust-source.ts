// A reading of Rust source: the string literals, cfg names, module declarations, #[path] values
// and include! literals the tree rules check. Comments, nested block comments included, never
// count; a char literal never opens a string; r#name reads as name. It never fails: text rustc
// would refuse is read as far as it goes.

type TokenKind = "ident" | "string" | "char" | "number" | "lifetime" | "punct" | "open" | "close";

interface Token {
	readonly kind: TokenKind;
	// An identifier's name (without r#), a literal's decoded value, or the character itself.
	readonly text: string;
	// Written r#name: never a keyword.
	readonly raw: boolean;
}

const token = (kind: TokenKind, text: string, raw = false): Token => ({ kind, text, raw });

const IDENT_START = /^[\p{XID_Start}_]$/u;
const IDENT_CONTINUE = /^\p{XID_Continue}$/u;
const SPACE = /^\s$/u;
const HEX = /^[0-9a-fA-F]$/;
const NUMBER_PART = /^[0-9A-Za-z_]$/;
const ESCAPES: Readonly<Record<string, string>> = {
	n: "\n",
	r: "\r",
	t: "\t",
	"\\": "\\",
	"0": "\0",
	"'": "'",
	'"': '"',
};

function codePoint(text: string, at: number): string {
	const code = text.codePointAt(at);
	return code === undefined ? "" : String.fromCodePoint(code);
}

const startsIdent = (char: string): boolean => char !== "" && IDENT_START.test(char);
const continuesIdent = (char: string): boolean => char !== "" && IDENT_CONTINUE.test(char);

function identEnd(text: string, from: number): number {
	let at = from;
	while (continuesIdent(codePoint(text, at))) at += codePoint(text, at).length;
	return at;
}

function lineEnd(text: string, from: number): number {
	const end = text.indexOf("\n", from);
	return end < 0 ? text.length : end;
}

// Past a block comment, which nests in Rust.
function commentEnd(text: string, from: number): number {
	let depth = 0;
	let at = from;
	while (at < text.length) {
		if (text.startsWith("/*", at)) {
			depth += 1;
			at += 2;
		} else if (text.startsWith("*/", at)) {
			depth -= 1;
			at += 2;
			if (depth === 0) return at;
		} else at += 1;
	}
	return text.length;
}

// The next token's start: past whitespace, line comments and block comments.
function skipTrivia(text: string, from: number): number {
	let at = from;
	while (at < text.length) {
		if (SPACE.test(text.charAt(at))) at += 1;
		else if (text.startsWith("//", at)) at = lineEnd(text, at);
		else if (text.startsWith("/*", at)) at = commentEnd(text, at);
		else break;
	}
	return at;
}

interface Scanned {
	readonly value: string;
	readonly end: number;
}

// A quoted literal's value with its escapes decoded, from just after the opening quote. It ends
// at `limit` when no closing quote comes first.
function escaped(text: string, from: number, quote: string, limit: number = text.length): Scanned {
	let value = "";
	let at = from;
	while (at < limit) {
		const char = text.charAt(at);
		if (char === quote) return { value, end: at + 1 };
		if (char !== "\\") {
			value += char;
			at += 1;
			continue;
		}
		const next = text.charAt(at + 1);
		const simple = ESCAPES[next];
		if (simple !== undefined) {
			value += simple;
			at += 2;
		} else if (next === "x" && HEX.test(text.charAt(at + 2)) && HEX.test(text.charAt(at + 3))) {
			value += String.fromCharCode(Number.parseInt(text.slice(at + 2, at + 4), 16));
			at += 4;
		} else if (next === "u" && text.charAt(at + 2) === "{") {
			const close = text.indexOf("}", at + 3);
			const digits = close < 0 ? "" : text.slice(at + 3, close).replaceAll("_", "");
			const code = /^[0-9a-fA-F]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : -1;
			const scalar = code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
			if (scalar) value += String.fromCodePoint(code);
			at = close < 0 ? at + 2 : close + 1;
		} else if (next === "\n" || next === "\r") {
			// A line continuation: the line break and the whitespace after it are dropped.
			at += 1;
			while (at < limit && " \t\n\r".includes(text.charAt(at))) at += 1;
		} else {
			value += next;
			at += 2;
		}
	}
	return { value, end: limit };
}

// A raw literal (r"…", r#"…"#, br"…", cr"…") from the first # or quote after its prefix; null when
// what follows isn't one.
function rawString(text: string, from: number): Scanned | null {
	let at = from;
	while (text.charAt(at) === "#") at += 1;
	if (text.charAt(at) !== '"') return null;
	const closer = `"${"#".repeat(at - from)}`;
	const end = text.indexOf(closer, at + 1);
	return end < 0
		? { value: text.slice(at + 1), end: text.length }
		: { value: text.slice(at + 1, end), end: end + closer.length };
}

// After a quote: a char literal ('a', '\'', '\u{41}'), else a lifetime or label ('a, 'static).
function afterQuote(text: string, at: number, tokens: Token[]): number {
	if (text.charAt(at + 1) === "\\") {
		const limit = Math.min(text.length, at + 16);
		const char = escaped(text, at + 1, "'", limit);
		if (text.charAt(char.end - 1) === "'" && char.end <= limit) {
			tokens.push(token("char", char.value));
			return char.end;
		}
	}
	const char = codePoint(text, at + 1);
	if (char !== "" && char !== "\\" && text.charAt(at + 1 + char.length) === "'") {
		tokens.push(token("char", char));
		return at + 2 + char.length;
	}
	if (startsIdent(char)) {
		const raw = text.startsWith("r#", at + 1) && startsIdent(codePoint(text, at + 3));
		const end = identEnd(text, raw ? at + 3 : at + 1);
		tokens.push(token("lifetime", text.slice(raw ? at + 3 : at + 1, end), raw));
		return end;
	}
	tokens.push(token("punct", "'"));
	return at + 1;
}

const RAW_PREFIXES = new Set(["r", "br", "cr"]);
const QUOTED_PREFIXES = new Set(["b", "c"]);

// An identifier, r#identifier, or a literal its letters prefix: r"…", b"…", br"…", c"…", b'…'.
function identifier(text: string, at: number, tokens: Token[]): number {
	const end = identEnd(text, at);
	const name = text.slice(at, end);
	const next = text.charAt(end);
	if (name === "r" && next === "#" && startsIdent(codePoint(text, end + 1))) {
		const rawEnd = identEnd(text, end + 1);
		tokens.push(token("ident", text.slice(end + 1, rawEnd), true));
		return rawEnd;
	}
	if (RAW_PREFIXES.has(name) && (next === '"' || next === "#")) {
		const raw = rawString(text, end);
		if (raw !== null) {
			tokens.push(token("string", raw.value));
			return raw.end;
		}
	}
	if (QUOTED_PREFIXES.has(name) && next === '"') {
		const quoted = escaped(text, end + 1, '"');
		tokens.push(token("string", quoted.value));
		return quoted.end;
	}
	if (name === "b" && next === "'") return afterQuote(text, end, tokens);
	tokens.push(token("ident", name));
	return end;
}

function numberEnd(text: string, from: number): number {
	let at = from;
	while (NUMBER_PART.test(text.charAt(at))) at += 1;
	if (text.charAt(at) === "." && /^[0-9]$/.test(text.charAt(at + 1))) {
		at += 1;
		while (NUMBER_PART.test(text.charAt(at))) at += 1;
	}
	return at;
}

function delimiter(char: string): TokenKind {
	if (char === "(" || char === "[" || char === "{") return "open";
	if (char === ")" || char === "]" || char === "}") return "close";
	return "punct";
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	// A first line starting #! is a shebang unless its next token is [ (an inner attribute).
	if (text.startsWith("#!", at) && text.charAt(skipTrivia(text, at + 2)) !== "[") {
		at = lineEnd(text, at);
	}
	for (;;) {
		at = skipTrivia(text, at);
		if (at >= text.length) return tokens;
		const char = codePoint(text, at);
		if (char === '"') {
			const quoted = escaped(text, at + 1, '"');
			tokens.push(token("string", quoted.value));
			at = quoted.end;
		} else if (char === "'") {
			at = afterQuote(text, at, tokens);
		} else if (char >= "0" && char <= "9") {
			const end = numberEnd(text, at);
			tokens.push(token("number", text.slice(at, end)));
			at = end;
		} else if (startsIdent(char)) {
			at = identifier(text, at, tokens);
		} else {
			tokens.push(token(delimiter(char), char));
			at += char.length;
		}
	}
}

interface Tree {
	readonly tokens: readonly Token[];
	// For an open token, its closing token's index (tokens.length when it never closes).
	readonly close: readonly number[];
	// For every token, the innermost open token around it (-1 at the top level).
	readonly parent: readonly number[];
}

function parse(text: string): Tree {
	const tokens = tokenize(text);
	const close = tokens.map(() => tokens.length);
	const parent = tokens.map(() => -1);
	const open: number[] = [];
	tokens.forEach((item, at) => {
		parent[at] = open.at(-1) ?? -1;
		if (item.kind === "open") open.push(at);
		else if (item.kind === "close") {
			const start = open.pop();
			if (start !== undefined) close[start] = at;
			parent[at] = open.at(-1) ?? -1;
		}
	});
	return { tokens, close, parent };
}

const isPunct = (item: Token | undefined, char: string): boolean =>
	item?.kind === "punct" && item.text === char;
const isOpen = (item: Token | undefined, char: string): boolean =>
	item?.kind === "open" && item.text === char;
const isName = (item: Token | undefined, name: string): boolean =>
	item?.kind === "ident" && item.text === name;
const isKeyword = (item: Token | undefined, name: string): boolean =>
	isName(item, name) && item?.raw === false;
const closeOf = (tree: Tree, open: number): number => tree.close[open] ?? tree.tokens.length;

// name!(…), name![…] or name!{…} at `at`, whatever path leads to it: the group's open token, or -1.
function macroGroup(tree: Tree, at: number, names: ReadonlySet<string>): number {
	const item = tree.tokens[at];
	if (item?.kind !== "ident" || !names.has(item.text) || !isPunct(tree.tokens[at + 1], "!")) {
		return -1;
	}
	return tree.tokens[at + 2]?.kind === "open" ? at + 2 : -1;
}

interface Joined {
	readonly text: string;
	// false when a piece isn't a literal (env!, a constant), whose text isn't known here.
	readonly complete: boolean;
	readonly pieces: number;
}

const CONCAT = new Set(["concat"]);

// What concat!(…) makes of its literal pieces, nested concat! included.
function concatText(tree: Tree, open: number, depth: number): Joined {
	let text = "";
	let complete = true;
	let pieces = 0;
	const end = closeOf(tree, open);
	for (let at = open + 1; at < end; at++) {
		const item = tree.tokens[at];
		if (item === undefined || isPunct(item, ",")) continue;
		const nested = depth < 16 ? macroGroup(tree, at, CONCAT) : -1;
		if (nested >= 0) {
			const inner = concatText(tree, nested, depth + 1);
			text += inner.text;
			pieces += inner.pieces;
			complete &&= inner.complete;
			at = closeOf(tree, nested);
		} else if (
			item.kind === "string" ||
			item.kind === "char" ||
			item.kind === "number" ||
			isKeyword(item, "true") ||
			isKeyword(item, "false")
		) {
			text += item.text;
			pieces += 1;
		} else if (isPunct(item, "-") && tree.tokens[at + 1]?.kind === "number") {
			text += "-";
		} else {
			complete = false;
			if (item.kind === "open") at = closeOf(tree, at);
		}
	}
	return { text, complete, pieces };
}

// The value after the `=` at `at`: a string literal or concat! of literals, else null.
function valueAfter(tree: Tree, at: number): string | null {
	if (!isPunct(tree.tokens[at], "=")) return null;
	const value = tree.tokens[at + 1];
	if (value?.kind === "string") return value.text;
	const group = macroGroup(tree, at + 1, CONCAT);
	if (group < 0) return null;
	const joined = concatText(tree, group, 0);
	return joined.complete ? joined.text : null;
}

interface Attribute {
	readonly inner: boolean;
	// The [ and ] tokens.
	readonly open: number;
	readonly close: number;
	// The last segment of its path (cfg, path, cfg_attr…), and the token after the path.
	readonly name: string;
	readonly after: number;
}

// The attribute #[…] or #![…] starting at `at`, or null.
function attributeAt(tree: Tree, at: number): Attribute | null {
	if (!isPunct(tree.tokens[at], "#")) return null;
	const inner = isPunct(tree.tokens[at + 1], "!");
	const open = at + (inner ? 2 : 1);
	if (!isOpen(tree.tokens[open], "[")) return null;
	const pathSeparator = (from: number): boolean =>
		isPunct(tree.tokens[from], ":") && isPunct(tree.tokens[from + 1], ":");
	let after = pathSeparator(open + 1) ? open + 3 : open + 1;
	let name = "";
	for (let item = tree.tokens[after]; item?.kind === "ident"; item = tree.tokens[after]) {
		name = item.text;
		after += 1;
		if (!pathSeparator(after)) break;
		after += 2;
	}
	return { inner, open, close: closeOf(tree, open), name, after };
}

// The files an attribute points a module at: #[path = "x"], and path = "x" inside #[cfg_attr(…)].
function attributePaths(tree: Tree, attribute: Attribute): string[] {
	if (attribute.name === "path") {
		const value = valueAfter(tree, attribute.after);
		return value === null ? [] : [value];
	}
	if (attribute.name !== "cfg_attr") return [];
	const paths: string[] = [];
	for (let at = attribute.after; at < attribute.close; at++) {
		if (!isName(tree.tokens[at], "path")) continue;
		const value = valueAfter(tree, at + 1);
		if (value !== null) paths.push(value);
	}
	return paths;
}

// Every string literal's value, escapes decoded: plain, raw, byte, raw byte and C strings. A
// concat! of literals also adds the text it makes.
export function stringLiterals(text: string): string[] {
	const tree = parse(text);
	const values: string[] = [];
	tree.tokens.forEach((item, at) => {
		const group = macroGroup(tree, at, CONCAT);
		if (group >= 0) {
			const joined = concatText(tree, group, 0);
			if (joined.pieces > 1) values.push(joined.text);
		} else if (item.kind === "string") values.push(item.text);
	});
	return values;
}

// "reserved" where a word starts: after anything but a letter or digit, or after a lower-case
// letter or digit when it's capitalised (fooReserved). "preserved" never matches.
const RESERVED_AT_START =
	/(?:^|[^\p{L}\p{N}])[Rr][Ee][Ss][Ee][Rr][Vv][Ee][Dd]|[\p{Ll}\p{N}]R[Ee][Ss][Ee][Rr][Vv][Ee][Dd]/u;
const CFG = new Set(["cfg"]);
const CFG_SELECT = new Set(["cfg_match", "cfg_select"]);
const BUILD_CFG = /rustc-(?:check-)?cfg/i;

// The cfg names and values that start a word with "reserved", as features or custom cfgs: in
// #[cfg(…)], #![cfg(…)], cfg!(…), cfg_attr's predicate and the cfg or cfg_attr among its
// attributes, the predicates of cfg_select! and cfg_match!, cfg_if!'s #[cfg(…)], and the
// rustc-cfg and rustc-check-cfg lines a build script prints (with that print's other strings).
export function cfgNamesReserved(text: string): string[] {
	const tree = parse(text);
	const found: string[] = [];
	const names = (from: number, to: number): void => {
		for (let at = from; at < to; at++) {
			const item = tree.tokens[at];
			const named = item?.kind === "ident" || item?.kind === "string";
			if (named && RESERVED_AT_START.test(item.text)) found.push(item.text);
		}
	};
	const cfgAttr = (open: number): void => {
		const end = closeOf(tree, open);
		let at = open + 1;
		while (at < end && !isPunct(tree.tokens[at], ",")) {
			at = tree.tokens[at]?.kind === "open" ? closeOf(tree, at) + 1 : at + 1;
		}
		names(open + 1, at);
		for (; at < end; at++) {
			if (!isOpen(tree.tokens[at + 1], "(")) continue;
			if (isName(tree.tokens[at], "cfg")) names(at + 2, closeOf(tree, at + 1));
			else if (isName(tree.tokens[at], "cfg_attr")) cfgAttr(at + 1);
			else continue;
			at = closeOf(tree, at + 1);
		}
	};
	const arms = (open: number): void => {
		const end = closeOf(tree, open);
		for (let at = open + 1; at < end; at++) {
			if (isOpen(tree.tokens[at], "{")) at = closeOf(tree, at);
			else names(at, at + 1);
		}
	};
	const printed = (at: number, value: string): void => {
		const key = BUILD_CFG.exec(value);
		if (key === null) return;
		if (RESERVED_AT_START.test(value.slice(key.index + key[0].length))) found.push(value);
		const group = tree.parent[at] ?? -1;
		if (group < 0) return;
		for (let other = group + 1; other < closeOf(tree, group); other++) {
			const item = tree.tokens[other];
			if (other !== at && item?.kind === "string" && RESERVED_AT_START.test(item.text)) {
				found.push(item.text);
			}
		}
	};
	tree.tokens.forEach((item, at) => {
		const attribute = attributeAt(tree, at);
		if (attribute !== null && isOpen(tree.tokens[attribute.after], "(")) {
			if (attribute.name === "cfg") names(attribute.after + 1, closeOf(tree, attribute.after));
			else if (attribute.name === "cfg_attr") cfgAttr(attribute.after);
		}
		const cfg = macroGroup(tree, at, CFG);
		if (cfg >= 0) names(cfg + 1, closeOf(tree, cfg));
		const select = macroGroup(tree, at, CFG_SELECT);
		if (select >= 0) arms(select);
		if (item.kind === "string") printed(at, item.text);
	});
	return found;
}

export interface ModParent {
	readonly name: string;
	readonly paths: readonly string[];
}

export interface ModDecl {
	// The module's name, without r#.
	readonly name: string;
	// mod name { … }, rather than mod name; (whose file the compiler loads).
	readonly inline: boolean;
	// Its #[path] values, those inside cfg_attr included.
	readonly paths: readonly string[];
	// The inline modules around it, outermost first.
	readonly parents: readonly ModParent[];
}

// Every mod declaration, inline or not, anywhere in the file (function bodies and macro bodies
// included), with the #[path] values on it and the inline modules around it.
export function modDecls(text: string): ModDecl[] {
	const tree = parse(text);
	const decls: ModDecl[] = [];
	const enclosing: { readonly parent: ModParent; readonly close: number }[] = [];
	let paths: string[] = [];
	for (let at = 0; at < tree.tokens.length; at++) {
		while ((enclosing.at(-1)?.close ?? Number.POSITIVE_INFINITY) <= at) enclosing.pop();
		const item = tree.tokens[at];
		const attribute = attributeAt(tree, at);
		if (attribute !== null) {
			if (!attribute.inner) paths.push(...attributePaths(tree, attribute));
			at = attribute.close;
			continue;
		}
		if (isKeyword(item, "pub")) {
			if (isOpen(tree.tokens[at + 1], "(")) at = closeOf(tree, at + 1);
			continue;
		}
		const name = tree.tokens[at + 1];
		if (isKeyword(item, "mod") && name?.kind === "ident") {
			const inline = isOpen(tree.tokens[at + 2], "{");
			if (inline || isPunct(tree.tokens[at + 2], ";")) {
				decls.push({
					name: name.text,
					inline,
					paths,
					parents: enclosing.map(({ parent }) => parent),
				});
				if (inline)
					enclosing.push({ parent: { name: name.text, paths }, close: closeOf(tree, at + 2) });
			}
			at += inline ? 2 : 1;
		}
		paths = [];
	}
	return decls;
}

// Every #[path] value in the file, those inside cfg_attr included.
export function pathAttrs(text: string): string[] {
	const tree = parse(text);
	return tree.tokens.flatMap((_, at) => {
		const attribute = attributeAt(tree, at);
		return attribute === null ? [] : attributePaths(tree, attribute);
	});
}

const INCLUDES = new Set(["include", "include_str", "include_bytes"]);

// The paths include!, include_str! and include_bytes! read: their argument when it's a literal or
// concat! of literals. An argument built from env! (an OUT_DIR file) isn't known here.
export function includeLiterals(text: string): string[] {
	const tree = parse(text);
	const values: string[] = [];
	tree.tokens.forEach((_, at) => {
		const open = macroGroup(tree, at, INCLUDES);
		if (open < 0) return;
		const close = closeOf(tree, open);
		const last = isPunct(tree.tokens[close - 1], ",") ? close - 1 : close;
		const first = tree.tokens[open + 1];
		if (last === open + 2 && first?.kind === "string") {
			values.push(first.text);
			return;
		}
		const group = macroGroup(tree, open + 1, CONCAT);
		if (group < 0 || closeOf(tree, group) !== last - 1) return;
		const joined = concatText(tree, group, 0);
		if (joined.complete) values.push(joined.text);
	});
	return values;
}
