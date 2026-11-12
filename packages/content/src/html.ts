import { type Options, selectAll } from "css-select";
import {
	type CssNode,
	generate,
	ident,
	type LexerMatchResult,
	lexer,
	parse,
	tokenize,
	tokenTypes,
	walk,
} from "css-tree";
import {
	type AnyNode,
	type ChildNode,
	Document,
	Element,
	isTag,
	isText,
	type ParentNode,
	Text,
} from "domhandler";
import {
	type DefaultTreeAdapterMap,
	type DefaultTreeAdapterTypes,
	defaultTreeAdapter,
	parse as parseHtml,
	type TreeAdapter,
} from "parse5";
import {
	finishHygiene,
	type HygieneOptions,
	type HygieneResult,
	hygieneLimits,
	instructionLike,
	linkMarker,
	sourceText,
} from "./hygiene.ts";
import { boundedText, ContentError } from "./limits.ts";

const NONCONTENT = new Set(
	"script style head title template iframe frame frameset object embed applet svg math noscript canvas audio video source track link meta base input select textarea button option".split(
		" ",
	),
);
const BLOCKS = new Set(
	"address article aside blockquote br dd div dl dt fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul".split(
		" ",
	),
);
const PROPERTIES = new Set(
	"display visibility content-visibility opacity font font-size width height max-width max-height line-height mso-hide color background background-color -webkit-text-fill-color transform clip clip-path left right top bottom text-indent".split(
		" ",
	),
);
// CSS Color 4 Appendix A requires browser support for these legacy system
// colors. Their actual pixels depend on the client, so they stay unknown.
const LEGACY_SYSTEM_COLORS = new Set(
	"activeborder activecaption appworkspace background buttonhighlight buttonshadow captiontext inactiveborder inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface threedhighlight threedlightshadow threedshadow window windowframe windowtext".split(
		" ",
	),
);
type Declaration = {
	property: string;
	value: string;
	important: boolean;
	specificity: number;
	order: number;
	layer: readonly number[];
	inline: boolean;
	hint: boolean;
	userAgent?: boolean;
	// Uncertain matches or parse readings this declaration needs; it applies
	// only in the readings where every one of them holds.
	uncertain: readonly number[];
};
type Colors = {
	foreground: string | undefined;
	background: string | undefined;
	current: string | undefined;
	opaqueCurrent: string | undefined;
	fill: string | undefined;
};
type StyleBranch = {
	conditions: string[];
	values: Map<Element, Declaration[]>;
	layers: { path: readonly number[]; order: number }[];
};
// Undefined is the guaranteed-invalid initial value; null is outside the
// bounded model and must not incorrectly select a known fallback.
type VariableValue = string | undefined | null;
type Variables = { own: Map<string, VariableValue>; parent?: Variables };
type Appearance = {
	hidden: boolean;
	visibilityHidden: boolean;
	fontZero: boolean;
	colors: Colors;
	variables: Variables;
};
const MAX_RENDER_WORK = 2_000_000;
const MAX_MATCH_WORK = 2_000_000;
const MAX_NESTING = 32;
const MAX_UNCERTAIN = 8;
const MAX_READINGS = 64;
const NONRENDERED_TEXT =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Match the final hygiene pass's removed controls.
	/[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

// CSS names and keywords ignore ASCII case only; other letters keep theirs.
function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// The pinned matcher stops after 15,000 iterations and reports a mismatch,
// which proves nothing about the value.
function matches(result: LexerMatchResult): boolean {
	if (result.iterations >= 15_000) throw new ContentError("STRUCTURE_LIMIT");
	return Boolean(result.matched);
}

function boundedDom(input: string): {
	root: Document;
	elements: Element[];
	inertTextUnits: number;
} {
	type Node = DefaultTreeAdapterTypes.Node;
	type Parent = DefaultTreeAdapterTypes.ParentNode;
	type Child = DefaultTreeAdapterTypes.ChildNode;
	let nodes = 0;
	let work = 0;
	const templateParents = new WeakMap<Node, Node>();
	function count(): void {
		if (++nodes > 20_000) throw new ContentError("STRUCTURE_LIMIT");
	}
	function spend(): void {
		if (++work > 2_000_000) throw new ContentError("STRUCTURE_LIMIT");
	}
	function children(node: Node): readonly Child[] {
		return "childNodes" in node ? node.childNodes : [];
	}
	function checkPlacement(parent: Parent, child: Node): void {
		let depth = 0;
		let ancestor: Node | null = parent;
		while (ancestor && ancestor.nodeName !== "#document") {
			spend();
			if (++depth > 128) throw new ContentError("STRUCTURE_LIMIT");
			ancestor =
				templateParents.get(ancestor) ?? ("parentNode" in ancestor ? ancestor.parentNode : null);
		}
		// Formatting reconstruction and the adoption-agency algorithm can move
		// existing subtrees. Check their new depth before each tree mutation.
		const pending = [{ node: child, depth: depth + 1 }];
		while (pending.length) {
			const entry = pending.pop();
			if (!entry) break;
			spend();
			if (entry.depth > 128) throw new ContentError("STRUCTURE_LIMIT");
			for (const node of children(entry.node)) pending.push({ node, depth: entry.depth + 1 });
			if (defaultTreeAdapter.isElementNode(entry.node) && entry.node.tagName === "template") {
				const content = (entry.node as DefaultTreeAdapterTypes.Template).content;
				if (content) pending.push({ node: content, depth: entry.depth + 1 });
			}
		}
	}
	const adapter: TreeAdapter<DefaultTreeAdapterMap> = {
		...defaultTreeAdapter,
		createElement(name, namespace, attributes) {
			count();
			if (attributes.length > 128) throw new ContentError("STRUCTURE_LIMIT");
			return defaultTreeAdapter.createElement(name, namespace, attributes);
		},
		createCommentNode(data) {
			count();
			return defaultTreeAdapter.createCommentNode(data);
		},
		createTextNode(value) {
			count();
			return defaultTreeAdapter.createTextNode(value);
		},
		createDocumentFragment() {
			count();
			return defaultTreeAdapter.createDocumentFragment();
		},
		appendChild(parent, child) {
			checkPlacement(parent, child);
			defaultTreeAdapter.appendChild(parent, child);
		},
		insertBefore(parent, child, reference) {
			checkPlacement(parent, child);
			defaultTreeAdapter.insertBefore(parent, child, reference);
		},
		insertText(parent, text) {
			const previous = parent.childNodes.at(-1);
			if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
			else adapter.appendChild(parent, adapter.createTextNode(text));
		},
		insertTextBefore(parent, text, reference) {
			const previous = parent.childNodes[parent.childNodes.indexOf(reference) - 1];
			if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
			else adapter.insertBefore(parent, adapter.createTextNode(text), reference);
		},
		adoptAttributes(element, attributes) {
			// Late html/body tokens add attributes to their original elements.
			const names = new Set(element.attrs.map((attribute) => attribute.name));
			for (const attribute of attributes) {
				names.add(attribute.name);
				if (names.size > 128) throw new ContentError("STRUCTURE_LIMIT");
			}
			defaultTreeAdapter.adoptAttributes(element, attributes);
		},
		setTemplateContent(template, content) {
			templateParents.set(content, template);
			checkPlacement(template, content);
			defaultTreeAdapter.setTemplateContent(template, content);
		},
		setDocumentType(document, name, publicId, systemId) {
			if (!document.childNodes.some((node) => defaultTreeAdapter.isDocumentTypeNode(node))) count();
			defaultTreeAdapter.setDocumentType(document, name, publicId, systemId);
		},
	};
	const parsed = parseHtml(input, { treeAdapter: adapter });
	const root = new Document([]);
	const elements: Element[] = [];
	let converted = 0;
	let inertTextUnits = 0;
	function measureInert(source: Node, depth: number): void {
		if (++converted > 20_000 || depth > 128) throw new ContentError("STRUCTURE_LIMIT");
		if (defaultTreeAdapter.isTextNode(source)) inertTextUnits += source.value.length;
		for (const child of children(source)) measureInert(child, depth + 1);
		if (defaultTreeAdapter.isElementNode(source) && source.tagName === "template") {
			const content = (source as DefaultTreeAdapterTypes.Template).content;
			if (content) measureInert(content, depth + 1);
		}
	}
	function convert(source: Node, parent: ParentNode, depth: number): void {
		if (++converted > 20_000 || depth > 128) throw new ContentError("STRUCTURE_LIMIT");
		let node: ChildNode;
		if (defaultTreeAdapter.isTextNode(source)) node = new Text(source.value);
		else if (defaultTreeAdapter.isElementNode(source)) {
			if (source.attrs.length > 128) throw new ContentError("STRUCTURE_LIMIT");
			const element = new Element(
				source.tagName,
				Object.fromEntries(source.attrs.map((a) => [a.name, a.value])),
			);
			elements.push(element);
			node = element;
			for (const child of source.childNodes) convert(child, element, depth + 1);
			// A template's fragment is not part of the rendered document or its
			// selector tree. Account for withheld text without activating its CSS.
			if (source.tagName === "template") {
				const content = (source as DefaultTreeAdapterTypes.Template).content;
				if (content) measureInert(content, depth + 1);
			}
		} else return;
		node.parent = parent;
		node.prev = parent.children.at(-1) ?? null;
		if (node.prev) node.prev.next = node;
		parent.children.push(node);
	}
	for (const child of parsed.childNodes) convert(child, root, 1);
	return { root, elements, inertTextUnits };
}

function cssAst(source: string, context: "stylesheet" | "declarationList"): CssNode | undefined {
	// Bound nesting before invoking a parser whose grammar includes recursive structures.
	const structural = source.replace(
		/\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
		"",
	);
	let depth = 0;
	for (const char of structural) {
		if ("{([".includes(char) && ++depth > 32) throw new ContentError("STRUCTURE_LIMIT");
		if ("})]".includes(char)) depth = Math.max(0, depth - 1);
	}
	try {
		return parse(source, {
			context,
			positions: true,
			// css-tree recovers individual malformed rules/declarations as Raw nodes.
			// Those nodes are ignored below; their siblings remain usable.
			onParseError() {},
		});
	} catch {
		return undefined;
	}
}

const OPENERS = new Map([
	[tokenTypes.Function, ")"],
	[tokenTypes.LeftParenthesis, ")"],
	[tokenTypes.LeftSquareBracket, "]"],
	[tokenTypes.LeftCurlyBracket, "}"],
]);
const CLOSERS = new Map([
	[tokenTypes.RightParenthesis, ")"],
	[tokenTypes.RightSquareBracket, "]"],
	[tokenTypes.RightCurlyBracket, "}"],
]);

function escapedEnd(text: string): boolean {
	return (text.match(/\\*$/)?.[0].length ?? 0) % 2 === 1;
}

// A value cut off by the end of a style attribute or element keeps its open
// tokens in the source slice. CSS closes them at the end of input: first the
// last comment, string or URL, then each open function and block, innermost
// first.
function closedValue(value: string): string {
	const open: string[] = [];
	let last: { type: number; raw: string } | undefined;
	tokenize(value, (type, start, end) => {
		last = { type, raw: value.slice(start, end) };
		const closer = OPENERS.get(type);
		if (closer) open.push(closer);
		else if (CLOSERS.has(type) && CLOSERS.get(type) === open.at(-1)) open.pop();
	});
	let output = value;
	if (last?.type === tokenTypes.Comment && !(last.raw.length >= 4 && last.raw.endsWith("*/")))
		output += "*/";
	else if (last?.type === tokenTypes.String) {
		const quote = last.raw[0] ?? "";
		const body = last.raw.slice(1);
		// An escape at the end of input adds nothing to the string.
		if (escapedEnd(body)) output = `${output.slice(0, -1)}${quote}`;
		else if (!body.endsWith(quote) || escapedEnd(body.slice(0, -1))) output += quote;
	} else if (last?.type === tokenTypes.Url || last?.type === tokenTypes.BadUrl) {
		// Outside a string, an escape at the end of input is U+FFFD.
		if (escapedEnd(last.raw)) output += "\uFFFD)";
		else if (!last.raw.endsWith(")") || escapedEnd(last.raw.slice(0, -1))) output += ")";
	} else if (last?.type === tokenTypes.Delim && last.raw === "\\") output += "\uFFFD";
	return output + open.reverse().join("");
}

// A custom property, or a value that uses var(), may hold any tokens except a
// bad string, a bad URL or a closing bracket without its opener.
function wellFormed(value: string): boolean {
	const open: string[] = [];
	for (const { type } of valueTokens(value)) {
		if (type === tokenTypes.BadString || type === tokenTypes.BadUrl) return false;
		const closer = OPENERS.get(type);
		if (closer) open.push(closer);
		else if (CLOSERS.has(type) && CLOSERS.get(type) !== open.pop()) return false;
	}
	return true;
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/i;
const UNIT_CACHE = new Map<string, boolean>();

// CSS compares a dimension's whole decoded unit with the unit names; the type
// matcher alone would skip whitespace around it.
function knownUnit(unit: string): boolean {
	if (!/^[a-z]+$/i.test(unit)) return false;
	const name = unit.toLowerCase();
	let known = UNIT_CACHE.get(name);
	if (known === undefined) {
		try {
			known = matches(lexer.matchType("attr-unit", name));
		} catch (error) {
			if (error instanceof ContentError) throw error;
			known = false;
		}
		if (UNIT_CACHE.size < 256) UNIT_CACHE.set(name, known);
	}
	return known;
}

// The pinned grammar also accepts IE hacks such as 16px\9 or 1\0, whose
// decoded units are unknown to CSS.
function unknownUnit(value: string): boolean {
	let unknown = false;
	tokenize(value, (type, start, end) => {
		if (type !== tokenTypes.Dimension || unknown) return;
		const raw = value.slice(start, end);
		const number = raw.match(NUMBER)?.[0] ?? "";
		unknown = !knownUnit(ident.decode(raw.slice(number.length)));
	});
	return unknown;
}

function decodedToken(type: number, raw: string): string {
	if (type === tokenTypes.Dimension) {
		// The tokenizer fixes a Dimension's number before its unit, so an escaped
		// digit, exponent or point belongs to the unit. Decode only the unit; an
		// unknown unit keeps its raw text for the grammar check to reject.
		const number = raw.match(NUMBER)?.[0] ?? "";
		const unit = raw.slice(number.length);
		const decoded = ident.decode(unit);
		return number && decoded !== unit && knownUnit(decoded) ? `${number}${decoded}/**/` : raw;
	}
	const decoded = ident.decode(raw);
	let same = false;
	tokenize(decoded, (decodedType, decodedStart, decodedEnd) => {
		same = decodedType === type && decodedStart === 0 && decodedEnd === decoded.length;
	});
	// Escapes cannot turn an identifier into a number/dimension or supply
	// a delimiter. Preserve the original token boundary after decoding too:
	// an escape terminator is not a separate whitespace token.
	return same && decoded !== raw ? `${decoded}/**/` : raw;
}

function lexicalValue(value: string): string {
	const parts: { type: number; text: string }[] = [];
	tokenize(value, (type, start, end) => {
		const raw = value.slice(start, end);
		parts.push({
			type,
			text:
				type === tokenTypes.Comment
					? "/**/"
					: type === tokenTypes.WhiteSpace
						? " "
						: type === tokenTypes.Ident ||
								type === tokenTypes.Function ||
								type === tokenTypes.Dimension ||
								type === tokenTypes.Hash
							? decodedToken(type, raw)
							: raw,
		});
	});
	// A declared value excludes leading and trailing whitespace, and comments
	// are not tokens. An empty or comment-only custom property stays empty.
	const blank = (index: number): boolean =>
		parts[index]?.type === tokenTypes.WhiteSpace || parts[index]?.type === tokenTypes.Comment;
	let first = 0;
	let last = parts.length;
	while (first < last && blank(first)) first++;
	while (last > first && blank(last - 1)) last--;
	return parts
		.slice(first, last)
		.map((part) => part.text)
		.join("");
}

function comparisonValue(value: string): string {
	let output = "";
	tokenize(value, (type, start, end) => {
		output += type === tokenTypes.Comment ? " " : value.slice(start, end);
	});
	return output.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}

// The pinned grammar omits deprecated system colors, and it drops IE hacks
// such as \9 from keywords. An identifier that keeps an escape after decoding
// is never a keyword, so a plain identifier stands in for it. Substitute only
// for grammar checking; keep the original value in the cascade.
function grammarValue(property: string, value: string): string {
	let checked = "";
	let cursor = 0;
	for (const token of valueTokens(value)) {
		if (token.type !== tokenTypes.Ident || !token.raw.includes("\\")) continue;
		checked += `${value.slice(cursor, token.start)}/**/x-escaped/**/`;
		cursor = token.end;
	}
	checked += value.slice(cursor);
	return /^(?:color|background(?:-color)?|-webkit-text-fill-color)$/.test(property)
		? checked.replace(/[-a-z][\w-]*/gi, (word) =>
				LEGACY_SYSTEM_COLORS.has(word.toLowerCase()) ? "#000000" : word,
			)
		: checked;
}

function declarations(
	ast: CssNode | undefined,
	nextOrder: () => number,
	rawValues: ReadonlyMap<CssNode, string>,
): Declaration[] {
	const result: Declaration[] = [];
	if (ast?.type !== "Block" && ast?.type !== "DeclarationList") return result;
	for (const node of ast.children) {
		if (node.type !== "Declaration") continue;
		const name = ident.decode(node.property);
		const property = name.startsWith("--") ? name : asciiLower(name);
		if (
			(!PROPERTIES.has(property) && !property.startsWith("--")) ||
			(node.value.type === "Raw" && !property.startsWith("--"))
		)
			continue;
		const raw = rawValues.get(node.value);
		// Only !important is a flag; the pinned parser also takes any other
		// "!" and identifier, which CSS keeps in the value and then rejects.
		if (
			raw === undefined ||
			(typeof node.important === "string" &&
				ident.decode(node.important).replace(/[A-Z]/g, (letter) => letter.toLowerCase()) !==
					"important")
		)
			continue;
		const value = lexicalValue(closedValue(raw));
		let disputed = false;
		// A grammar-invalid value never participates in the CSS cascade. Custom
		// properties and deferred substitutions remain unknown until computed use;
		// they must not revive an earlier declaration when substitution fails.
		if (property.startsWith("--") || deferred(value)) {
			const syntax = wellFormed(value) ? substitutionSyntax(value) : "dropped";
			if (syntax === "dropped") continue;
			disputed = syntax === "disputed";
		} else if (lexer.getProperty(property)) {
			if (unknownUnit(value)) continue;
			try {
				const checked = grammarValue(property, value);
				if (
					!matches(lexer.matchProperty(property, checked)) ||
					!validCalculations(property, checked)
				)
					continue;
			} catch (error) {
				if (error instanceof ContentError) throw error;
				/* Keep unmodelled values conservative. */
			}
		}
		const order = nextOrder();
		result.push({
			property,
			value,
			important: Boolean(node.important),
			specificity: 0,
			order,
			layer: [],
			inline: false,
			hint: false,
			// One engine drops a disputed declaration as it parses; the other keeps
			// it and finds it invalid when computing it.
			uncertain: disputed ? [order] : [],
		});
	}
	return result;
}

const DYNAMIC = new Set("hover focus focus-within focus-visible active visited".split(" "));
const STRUCTURAL = new Set(
	"root empty first-child last-child only-child first-of-type last-of-type only-of-type nth-child nth-last-child nth-of-type nth-last-of-type".split(
		" ",
	),
);

// Pseudo-elements whose boxes never hold the element's own text at rest, as
// ::first-line and ::first-letter do. CSS 2 also wrote :before and :after.
const BOXES = new Set(
	"before after marker placeholder file-selector-button backdrop selection target-text spelling-error grammar-error highlight search-text cue cue-region part slotted view-transition view-transition-group view-transition-image-pair view-transition-old view-transition-new column scroll-marker scroll-marker-group scroll-button picker picker-icon checkmark".split(
		" ",
	),
);
// Boxes both engines parse. Another one may make its whole rule invalid.
const COMMON_BOXES = new Set(
	"before after marker placeholder file-selector-button backdrop selection".split(" "),
);
const KNOWN_PSEUDO_CLASSES = new Set([
	...DYNAMIC,
	...STRUCTURAL,
	..."link any-link before after first-line first-letter".split(" "),
]);

// Selectors 4: an argument list counts its most specific selector, and
// :where() counts nothing.
function specificity(node: CssNode): number {
	if (node.type === "SelectorList") {
		let most = 0;
		for (const child of node.children) most = Math.max(most, specificity(child));
		return most;
	}
	if (node.type !== "Selector") return 0;
	let total = 0;
	for (const part of node.children) {
		if (part.type === "IdSelector") total += 1_000_000;
		else if (part.type === "ClassSelector" || part.type === "AttributeSelector") total += 1_000;
		else if (part.type === "TypeSelector") total += /(?:^|\|)\*$/.test(part.name) ? 0 : 1;
		else if (part.type === "PseudoElementSelector") total++;
		else if (part.type === "PseudoClassSelector") {
			const name = asciiLower(ident.decode(part.name));
			const argument = part.children?.first;
			if (name === "where") continue;
			if (["is", "not", "has"].includes(name)) total += argument ? specificity(argument) : 0;
			else if (["before", "after", "first-line", "first-letter"].includes(name)) total++;
			else
				total +=
					1_000 +
					(argument?.type === "Nth" && argument.selector ? specificity(argument.selector) : 0);
		}
	}
	return total;
}

// The pinned parser and matcher lowercase all of Unicode, while CSS and HTML
// fold only ASCII, so they may match a name the engines never match.
const foldsApart = (name: string): boolean => name.toLowerCase() !== asciiLower(name);

// The query for a selector's resting matches, or none when it never styles an
// element's own text at rest. A selector the model cannot match exactly, or
// one an engine may reject, matches an uncertain superset.
function staticSelector(selector: CssNode): {
	query: string | undefined;
	specificity: number;
	uncertain: boolean;
} {
	const original = generate(selector);
	if (original.length > 128) throw new ContentError("STRUCTURE_LIMIT");
	let combinators = 0;
	let skipped = false;
	let doubtful = false;
	let unsupportedCombinator = false;
	walk(selector, (part) => {
		if (part.type === "Combinator") {
			if (++combinators > 8) throw new ContentError("STRUCTURE_LIMIT");
			unsupportedCombinator ||= ![" ", ">", "+", "~"].includes(part.name);
		}
		doubtful ||=
			(part.type === "TypeSelector" && part.name.includes("|")) ||
			(part.type === "AttributeSelector" && part.name.name.includes("|"));
		if (part.type !== "PseudoClassSelector" && part.type !== "PseudoElementSelector") return;
		const name = asciiLower(ident.decode(part.name));
		if (part.type === "PseudoClassSelector") {
			// Dynamic states are not the resting rendering.
			skipped ||= DYNAMIC.has(name) || name === "before" || name === "after";
			doubtful ||= !KNOWN_PSEUDO_CLASSES.has(name);
		} else if (BOXES.has(name) || name.startsWith("-")) {
			skipped = true;
			doubtful ||= !COMMON_BOXES.has(name) && !name.startsWith("-webkit-");
		} else doubtful ||= name !== "first-line" && name !== "first-letter";
	});
	if (selector.type !== "Selector") return { query: undefined, specificity: 0, uncertain: true };
	const weight = specificity(selector);
	if (skipped)
		return { query: undefined, specificity: weight, uncertain: doubtful || unsupportedCombinator };
	if (unsupportedCombinator) return { query: "*", specificity: weight, uncertain: true };
	const parts: string[] = [];
	let compound = "";
	let uncertain = false;
	for (const part of selector.children) {
		if (part.type === "Combinator") {
			parts.push(compound || "*", part.name);
			compound = "";
		} else if (part.type === "IdSelector" || part.type === "ClassSelector") {
			compound += generate(part);
		} else if (part.type === "AttributeSelector") {
			const value =
				part.value?.type === "String"
					? part.value.value
					: part.value?.type === "Identifier"
						? ident.decode(part.value.name)
						: "";
			uncertain ||= foldsApart(ident.decode(part.name.name)) || foldsApart(value);
			if (part.name.name.includes("|")) uncertain = true;
			else compound += generate(part);
		} else if (part.type === "TypeSelector") {
			uncertain ||= part.name.includes("|") || foldsApart(ident.decode(part.name));
			compound += part.name.includes("|") ? "*" : generate(part);
		} else if (part.type === "PseudoClassSelector") {
			const name = asciiLower(ident.decode(part.name));
			if (name === "link" || name === "any-link") compound += ":is(a[href])";
			else if (
				STRUCTURAL.has(name) &&
				(!part.children ||
					[...part.children].every((child) => child.type === "Nth" && !child.selector))
			)
				compound += generate(part);
			// An unsupported whole pseudo is removed, including its arguments.
			// In particular, never run :has or turn a nested negation into a narrower selector.
			else uncertain = true;
		} else uncertain = true;
	}
	parts.push(compound || "*");
	return { query: parts.join(""), specificity: weight, uncertain };
}

function mediaConditions(prelude: CssNode | null): (string | undefined)[] {
	if (prelude?.type !== "AtrulePrelude") return [];
	const list = prelude.children.first;
	if (list?.type !== "MediaQueryList") return [];
	const result: (string | undefined)[] = [];
	for (const query of list.children) {
		if (query.type !== "MediaQuery") continue;
		const type = query.mediaType?.toLowerCase();
		const not = query.modifier?.toLowerCase() === "not";
		if (
			(type && !["all", "screen"].includes(type) && !not) ||
			(not && ["screen", "all"].includes(type ?? "") && !query.condition)
		)
			continue;
		if (not && type && !["all", "screen"].includes(type)) return [undefined];
		if (
			!query.condition &&
			((!not && (!type || type === "all" || type === "screen")) || (not && type === "print"))
		)
			return [undefined];
		result.push(`media:${ident.decode(generate(query)).toLowerCase().replace(/\s+/g, " ")}`);
	}
	return result;
}

function styles(root: Document, elements: Element[]): StyleBranch[] {
	const rawValues = new Map<CssNode, string>();
	const result = new Map<string, StyleBranch>();
	result.set("[]", { conditions: [], values: new Map(), layers: [] });
	let bytes = 0;
	let selectors = 0;
	let assignments = 0;
	let order = 0;
	let astNodes = 0;
	let matchWork = 0;
	function matchStep(amount = 1): void {
		matchWork += amount;
		if (matchWork > MAX_MATCH_WORK) throw new ContentError("STRUCTURE_LIMIT");
	}
	function text(node: AnyNode): string {
		matchStep();
		if (isText(node)) {
			matchStep(node.data.length);
			return node.data;
		}
		return "children" in node ? node.children.map(text).join("") : "";
	}
	// The pinned matcher still evaluates the selector. Its public adapter counts
	// actual DOM operations, including sibling walks in structural pseudo-classes.
	const adapter: NonNullable<Options<AnyNode, Element>["adapter"]> = {
		isTag(node): node is Element {
			matchStep();
			return isTag(node);
		},
		getAttributeValue(node, name) {
			matchStep();
			return node.attribs[name];
		},
		getChildren(node) {
			matchStep();
			return "children" in node ? node.children : [];
		},
		getName(node) {
			matchStep();
			return node.name;
		},
		getParent(node) {
			matchStep();
			return node.parent;
		},
		getSiblings(node) {
			matchStep();
			return node.parent?.children ?? [node];
		},
		prevElementSibling(node) {
			for (let previous = node.prev; previous; previous = previous.prev) {
				matchStep();
				if (isTag(previous)) return previous;
			}
			return null;
		},
		getText: text,
		hasAttrib(node, name) {
			matchStep();
			return Object.hasOwn(node.attribs, name);
		},
		removeSubsets(nodes) {
			const unique = new Set(nodes);
			return [...unique].filter((node) => {
				for (let parent = node.parent; parent; parent = parent.parent) {
					matchStep();
					if (unique.has(parent)) return false;
				}
				return true;
			});
		},
	};
	function css(source: string, context: "stylesheet" | "declarationList"): CssNode | undefined {
		if (context === "stylesheet") {
			bytes += Buffer.byteLength(source);
			if (bytes > 32_768) throw new ContentError("STRUCTURE_LIMIT");
		}
		const ast = cssAst(source, context);
		if (ast)
			walk(ast, (node) => {
				if (++astNodes > 100_000) throw new ContentError("STRUCTURE_LIMIT");
				// Nested selectors and scope need their own selector/condition model.
				// Refuse the body rather than discard rules that can hide its text.
				if (
					node.type === "Atrule" &&
					ident.decode(node.name).replace(/[A-Z]/g, (letter) => letter.toLowerCase()) === "scope"
				)
					throw new ContentError("STRUCTURE_LIMIT");
				if (node.type === "Rule")
					for (const child of node.block.children) {
						if (child.type === "Rule" || child.type === "Atrule")
							throw new ContentError("STRUCTURE_LIMIT");
						// The pinned parser recovers some valid nested selectors as Raw.
						// Only block children count: a custom-property value may hold braces.
						if (child.type === "Raw")
							tokenize(child.value, (type) => {
								if (type === tokenTypes.LeftCurlyBracket) throw new ContentError("STRUCTURE_LIMIT");
							});
					}
				if (node.type === "Declaration" && node.value.loc)
					rawValues.set(
						node.value,
						source.slice(node.value.loc.start.offset, node.value.loc.end.offset),
					);
			});
		return ast;
	}
	function branchFor(conditions: string[]): StyleBranch {
		const normalized = [...new Set(conditions)].sort();
		const key = JSON.stringify(normalized);
		let branch = result.get(key);
		if (!branch) {
			if (result.size > 128) throw new ContentError("STRUCTURE_LIMIT");
			branch = { conditions: normalized, values: new Map(), layers: [] };
			result.set(key, branch);
		}
		return branch;
	}
	function assign(target: Element, values: Declaration[], conditions: string[]): void {
		assignments += values.length;
		if (assignments > 50_000) throw new ContentError("STRUCTURE_LIMIT");
		const branch = branchFor(conditions);
		branch.values.set(target, [...(branch.values.get(target) ?? []), ...values]);
	}
	type LayerScope = { path: readonly number[]; names: Map<string, LayerScope> };
	const outerLayer: LayerScope = { path: [], names: new Map() };
	let layerOrder = 0;
	function childLayer(parent: LayerScope, name?: string): LayerScope {
		matchStep(parent.path.length + 1);
		if (parent.path.length >= 32) throw new ContentError("STRUCTURE_LIMIT");
		const previous = name === undefined ? undefined : parent.names.get(name);
		if (previous) return previous;
		const child: LayerScope = { path: [...parent.path, ++layerOrder], names: new Map() };
		if (name !== undefined) parent.names.set(name, child);
		return child;
	}
	function namedLayer(parent: LayerScope, name: string): LayerScope {
		// Split the grammar's dotted name without splitting an escaped identifier dot.
		for (const part of name.match(/(?:\\(?:[0-9a-f]{1,6}\s?|[\s\S])|[^.])+/gi) ?? [])
			parent = childLayer(parent, ident.decode(part));
		return parent;
	}
	function declareLayer(layer: LayerScope, conditions: string[]): LayerScope {
		branchFor(conditions).layers.push({ path: layer.path, order: ++order });
		return layer;
	}
	function rules(
		ast: CssNode | undefined,
		conditions: string[] = [],
		layer: LayerScope = outerLayer,
	): void {
		if (ast?.type !== "StyleSheet" && ast?.type !== "Block") return;
		for (const node of ast.children) {
			if (node.type === "Atrule") {
				const name = ident.decode(node.name).toLowerCase();
				if (name === "media") {
					for (const condition of mediaConditions(node.prelude))
						rules(
							node.block ?? undefined,
							condition ? [...conditions, condition] : conditions,
							layer,
						);
				} else if (name === "layer") {
					const layers: LayerScope[] = [];
					if (node.prelude?.type === "AtrulePrelude")
						for (const list of node.prelude.children)
							if (list.type === "LayerList")
								for (const item of list.children)
									if (item.type === "Layer")
										layers.push(declareLayer(namedLayer(layer, item.name), conditions));
					if (node.block && (!node.prelude || layers.length === 1))
						rules(node.block, conditions, layers[0] ?? declareLayer(childLayer(layer), conditions));
				} else if ((name === "supports" || name === "container") && node.prelude)
					rules(
						node.block ?? undefined,
						[...conditions, `${name}:${generate(node.prelude)}`],
						layer,
					);
				// Imports, font faces and keyframes never contribute static text styling or fetches.
				continue;
			}
			if (node.type !== "Rule" || node.prelude.type !== "SelectorList") continue;
			const values = declarations(node.block, () => ++order, rawValues).map((value) => ({
				...value,
				layer: layer.path,
			}));
			if (!values.length) continue;
			const matched = [...node.prelude.children].map((selector) => {
				if (++selectors > 128) throw new ContentError("STRUCTURE_LIMIT");
				const query = staticSelector(selector);
				if (query.query === undefined) return { ...query, targets: [] as Element[] };
				try {
					return {
						...query,
						targets: selectAll<AnyNode, Element>(query.query, root.children, { adapter }),
					};
				} catch (error) {
					if (error instanceof ContentError) throw error;
					// An unmodelled selector falls back to an uncertain universal superset.
					return { ...query, uncertain: true, targets: elements };
				}
			});
			// Both engines drop a whole rule when one of its selectors is invalid.
			const rule = matched.some((query) => query.uncertain) ? ++order : undefined;
			for (const query of matched) {
				const group = query.uncertain ? ++order : rule;
				const ranked = values.map((value) => ({
					...value,
					specificity: query.specificity,
					uncertain: group === undefined ? value.uncertain : [...value.uncertain, group],
				}));
				for (const target of query.targets) assign(target, ranked, conditions);
			}
		}
	}
	for (const element of elements) {
		if (element.name === "style")
			rules(
				css(
					element.children
						.filter(isText)
						.map((node) => node.data)
						.join(""),
					"stylesheet",
				),
			);
	}
	for (const element of elements) {
		const inline = element.attribs.style;
		if (inline)
			assign(
				element,
				declarations(css(inline, "declarationList"), () => ++order, rawValues).map((value) => ({
					...value,
					specificity: 1_000_000_000,
					inline: true,
				})),
				[],
			);
	}
	return [...result.values()];
}

// Opaque named-color values from CSS Color 4, section 6.1.
// https://www.w3.org/TR/2026/CRD-css-color-4-20261009/#named-colors
const NAMED: Readonly<Record<string, string>> = {
	aliceblue: "f0f8ff",
	antiquewhite: "faebd7",
	aqua: "00ffff",
	aquamarine: "7fffd4",
	azure: "f0ffff",
	beige: "f5f5dc",
	bisque: "ffe4c4",
	black: "000000",
	blanchedalmond: "ffebcd",
	blue: "0000ff",
	blueviolet: "8a2be2",
	brown: "a52a2a",
	burlywood: "deb887",
	cadetblue: "5f9ea0",
	chartreuse: "7fff00",
	chocolate: "d2691e",
	coral: "ff7f50",
	cornflowerblue: "6495ed",
	cornsilk: "fff8dc",
	crimson: "dc143c",
	cyan: "00ffff",
	darkblue: "00008b",
	darkcyan: "008b8b",
	darkgoldenrod: "b8860b",
	darkgray: "a9a9a9",
	darkgreen: "006400",
	darkgrey: "a9a9a9",
	darkkhaki: "bdb76b",
	darkmagenta: "8b008b",
	darkolivegreen: "556b2f",
	darkorange: "ff8c00",
	darkorchid: "9932cc",
	darkred: "8b0000",
	darksalmon: "e9967a",
	darkseagreen: "8fbc8f",
	darkslateblue: "483d8b",
	darkslategray: "2f4f4f",
	darkslategrey: "2f4f4f",
	darkturquoise: "00ced1",
	darkviolet: "9400d3",
	deeppink: "ff1493",
	deepskyblue: "00bfff",
	dimgray: "696969",
	dimgrey: "696969",
	dodgerblue: "1e90ff",
	firebrick: "b22222",
	floralwhite: "fffaf0",
	forestgreen: "228b22",
	fuchsia: "ff00ff",
	gainsboro: "dcdcdc",
	ghostwhite: "f8f8ff",
	gold: "ffd700",
	goldenrod: "daa520",
	gray: "808080",
	green: "008000",
	greenyellow: "adff2f",
	grey: "808080",
	honeydew: "f0fff0",
	hotpink: "ff69b4",
	indianred: "cd5c5c",
	indigo: "4b0082",
	ivory: "fffff0",
	khaki: "f0e68c",
	lavender: "e6e6fa",
	lavenderblush: "fff0f5",
	lawngreen: "7cfc00",
	lemonchiffon: "fffacd",
	lightblue: "add8e6",
	lightcoral: "f08080",
	lightcyan: "e0ffff",
	lightgoldenrodyellow: "fafad2",
	lightgray: "d3d3d3",
	lightgreen: "90ee90",
	lightgrey: "d3d3d3",
	lightpink: "ffb6c1",
	lightsalmon: "ffa07a",
	lightseagreen: "20b2aa",
	lightskyblue: "87cefa",
	lightslategray: "778899",
	lightslategrey: "778899",
	lightsteelblue: "b0c4de",
	lightyellow: "ffffe0",
	lime: "00ff00",
	limegreen: "32cd32",
	linen: "faf0e6",
	magenta: "ff00ff",
	maroon: "800000",
	mediumaquamarine: "66cdaa",
	mediumblue: "0000cd",
	mediumorchid: "ba55d3",
	mediumpurple: "9370db",
	mediumseagreen: "3cb371",
	mediumslateblue: "7b68ee",
	mediumspringgreen: "00fa9a",
	mediumturquoise: "48d1cc",
	mediumvioletred: "c71585",
	midnightblue: "191970",
	mintcream: "f5fffa",
	mistyrose: "ffe4e1",
	moccasin: "ffe4b5",
	navajowhite: "ffdead",
	navy: "000080",
	oldlace: "fdf5e6",
	olive: "808000",
	olivedrab: "6b8e23",
	orange: "ffa500",
	orangered: "ff4500",
	orchid: "da70d6",
	palegoldenrod: "eee8aa",
	palegreen: "98fb98",
	paleturquoise: "afeeee",
	palevioletred: "db7093",
	papayawhip: "ffefd5",
	peachpuff: "ffdab9",
	peru: "cd853f",
	pink: "ffc0cb",
	plum: "dda0dd",
	powderblue: "b0e0e6",
	purple: "800080",
	rebeccapurple: "663399",
	red: "ff0000",
	rosybrown: "bc8f8f",
	royalblue: "4169e1",
	saddlebrown: "8b4513",
	salmon: "fa8072",
	sandybrown: "f4a460",
	seagreen: "2e8b57",
	seashell: "fff5ee",
	sienna: "a0522d",
	silver: "c0c0c0",
	skyblue: "87ceeb",
	slateblue: "6a5acd",
	slategray: "708090",
	slategrey: "708090",
	snow: "fffafa",
	springgreen: "00ff7f",
	steelblue: "4682b4",
	tan: "d2b48c",
	teal: "008080",
	thistle: "d8bfd8",
	tomato: "ff6347",
	turquoise: "40e0d0",
	violet: "ee82ee",
	wheat: "f5deb3",
	white: "ffffff",
	whitesmoke: "f5f5f5",
	yellow: "ffff00",
	yellowgreen: "9acd32",
};

function color(value: string, opaqueOnly = false): string | undefined {
	if (value === "transparent") return "transparent";
	if (Object.hasOwn(NAMED, value)) return NAMED[value];
	if (/^#[\da-f]{3,8}$/.test(value)) {
		let hex = value.slice(1);
		if (hex.length === 3 || hex.length === 4) hex = [...hex].map((digit) => digit + digit).join("");
		if (hex.length === 8) {
			const alpha = Number.parseInt(hex.slice(6), 16);
			if (alpha === 0) return "transparent";
			return opaqueOnly && alpha !== 255 ? undefined : hex.slice(0, 6);
		}
		if (hex.length === 6) return hex;
	}
	const rgb = value.match(/^rgba?\(([^)]+)\)$/);
	if (rgb) {
		try {
			if (!matches(lexer.matchType("color", value))) return undefined;
		} catch (error) {
			if (error instanceof ContentError) throw error;
			return undefined;
		}
		const values = (rgb[1] ?? "").split(/[\s,/]+/).filter(Boolean);
		if (
			!values.every(
				(part) =>
					/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/.test(part) &&
					Number.isFinite(Number.parseFloat(part)),
			)
		)
			return undefined;
		if (values.length === 4) {
			const raw = values[3] ?? "";
			const alpha = Number.parseFloat(raw) / (raw.endsWith("%") ? 100 : 1);
			if (alpha <= 0) return "transparent";
			if (opaqueOnly && alpha < 1) return undefined;
		}
		if (values.length === 3 || values.length === 4) {
			const numbers = values
				.slice(0, 3)
				.map((part) => Math.round(Number.parseFloat(part) * (part.endsWith("%") ? 2.55 : 1)));
			if (numbers.every((number) => Number.isFinite(number) && number >= 0 && number <= 255))
				return numbers.map((number) => number.toString(16).padStart(2, "0")).join("");
		}
	}
	return undefined;
}

// HTML's rules for parsing a legacy colour value, which never tokenize CSS:
// https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-a-legacy-colour-value
function legacyColor(value: string): string | undefined {
	if (!value) return undefined;
	let input = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	const keyword = input.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	if (keyword === "transparent") return undefined;
	if (Object.hasOwn(NAMED, keyword)) return NAMED[keyword];
	if (/^#[\da-f]{3}$/i.test(input))
		return [...input.slice(1).toLowerCase()].map((digit) => digit + digit).join("");
	input = input.replace(/[\u{10000}-\u{10ffff}]/gu, "00").slice(0, 128);
	if (input.startsWith("#")) input = input.slice(1);
	input = input.replace(/[^\da-f]/gi, "0");
	while (input.length === 0 || input.length % 3) input += "0";
	let length = input.length / 3;
	let components = [0, 1, 2].map((index) => input.slice(index * length, (index + 1) * length));
	if (length > 8) {
		components = components.map((component) => component.slice(length - 8));
		length = 8;
	}
	while (length > 2 && components.every((component) => component.startsWith("0"))) {
		components = components.map((component) => component.slice(1));
		length--;
	}
	return components
		.map((component) => component.slice(0, 2).padStart(2, "0").toLowerCase())
		.join("");
}

function compareLayers(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		// Unlayered declarations form the implicit last layer, also inside nested layers.
		const difference = (a[index] ?? Infinity) - (b[index] ?? Infinity);
		if (difference && !Number.isNaN(difference)) return difference;
	}
	return 0;
}

function precedence(a: Declaration, b: Declaration): number {
	return (
		Number(!a.userAgent) - Number(!b.userAgent) ||
		Number(!a.hint) - Number(!b.hint) ||
		Number(a.important) - Number(b.important) ||
		Number(a.inline) - Number(b.inline) ||
		compareLayers(a.layer, b.layer) * (a.important ? -1 : 1) ||
		a.specificity - b.specificity ||
		a.order - b.order
	);
}

function winning(
	values: Declaration[],
	variables: Variables | undefined,
	spend: (count: number) => void,
): Map<string, Declaration> {
	const groups = new Map<string, Declaration[]>();
	for (const declaration of values) {
		spend(1);
		const key =
			declaration.property === "background"
				? "background-color"
				: declaration.property === "font"
					? "font-size"
					: declaration.property;
		const group = groups.get(key) ?? [];
		group.push(declaration);
		groups.set(key, group);
	}
	const result = new Map<string, Declaration>();
	for (const [key, group] of groups) {
		const declaration = cascaded(
			group,
			(value) => (variables ? resolved(value, variables, spend) : value),
			spend,
		);
		if (declaration) result.set(key, declaration);
	}
	return result;
}

function defaulting(value: string | undefined): string | undefined {
	const keyword = value === undefined ? undefined : comparisonValue(value).toLowerCase();
	return keyword && /^(?:inherit|initial|unset|revert|revert-layer)$/.test(keyword)
		? keyword
		: undefined;
}

function cascaded(
	group: Declaration[],
	resolve: (value: string) => string | undefined,
	spend: (count: number) => void,
): Declaration | undefined {
	let candidates = group.sort((a, b) => {
		spend(1);
		return precedence(b, a);
	});
	while (candidates.length) {
		const declaration = candidates[0];
		if (!declaration) break;
		const value = defaulting(resolve(declaration.value));
		// Revert discards the author origin, not just this declaration.
		if (value === "revert") {
			candidates = candidates.filter((candidate) => candidate.userAgent);
			continue;
		}
		if (value === "revert-layer") {
			candidates = candidates.filter((candidate) => {
				spend(1);
				return (candidate.userAgent && !declaration.userAgent) ||
					(candidate.hint && !declaration.hint)
					? true
					: declaration.inline && declaration.important
						? !candidate.inline
						: !candidate.inline && compareLayers(candidate.layer, declaration.layer) < 0;
			});
			continue;
		}
		return declaration;
	}
	return undefined;
}

function variable(variables: Variables, name: string): VariableValue {
	for (let layer: Variables | undefined = variables; layer; layer = layer.parent) {
		if (layer.own.has(name)) return layer.own.get(name);
	}
	return undefined;
}

type Token = { type: number; raw: string; start: number; end: number };

function valueTokens(value: string): Token[] {
	const tokens: Token[] = [];
	tokenize(value, (type, start, end) => {
		tokens.push({ type, raw: value.slice(start, end), start, end });
	});
	return tokens;
}

// CSS names a function by its whole decoded identifier, ignoring ASCII case.
// A string or URL is one opaque token, and -var( or x-env( is another function.
function functionName(token: Token | undefined): string | undefined {
	return token?.type === tokenTypes.Function
		? ident.decode(token.raw.slice(0, -1)).replace(/[A-Z]/g, (letter) => letter.toLowerCase())
		: undefined;
}

const SUBSTITUTIONS = new Set(["var", "env", "attr"]);

function deferred(value: string): boolean {
	return valueTokens(value).some((token) => SUBSTITUTIONS.has(functionName(token) ?? ""));
}

// A custom property name is the decoded identifier, compared case-sensitively.
function customName(token: Token | undefined): string | undefined {
	const name = token?.type === tokenTypes.Ident ? ident.decode(token.raw) : "";
	return name.length > 2 && name.startsWith("--") ? name : undefined;
}

function significant(token: Token | undefined): boolean {
	return (
		token !== undefined && token.type !== tokenTypes.WhiteSpace && token.type !== tokenTypes.Comment
	);
}

// The var() at tokens[index]: the indexes of its first top-level comma and its
// matching parenthesis, and its name when no other token precedes the fallback.
function reference(
	tokens: readonly Token[],
	index: number,
): { name: string | undefined; comma: number; close: number } {
	const open = [")"];
	const named: Token[] = [];
	let comma = -1;
	for (let position = index + 1; position < tokens.length; position++) {
		const token = tokens[position];
		if (!token) break;
		const closer = OPENERS.get(token.type);
		if (closer) open.push(closer);
		else if (CLOSERS.get(token.type) === open.at(-1)) {
			open.pop();
			if (!open.length) {
				const name = named.length === 1 ? customName(named[0]) : undefined;
				return { name, comma, close: position };
			}
		}
		if (comma >= 0) continue;
		if (open.length === 1 && token.type === tokenTypes.Comma) comma = position;
		else if (significant(token)) named.push(token);
	}
	return { name: undefined, comma, close: -1 };
}

// The significant top-level tokens from tokens[from] up to tokens[to]; a nested
// block counts as its opening token.
function topLevel(tokens: readonly Token[], from: number, to: number): Token[] {
	const head: Token[] = [];
	let depth = 0;
	for (let position = from; position < to; position++) {
		const token = tokens[position];
		if (!token) break;
		if (!depth && significant(token)) head.push(token);
		if (OPENERS.has(token.type)) depth++;
		else if (CLOSERS.has(token.type)) depth--;
	}
	return head;
}

type SubstitutionSyntax = "valid" | "disputed" | "dropped";

// What each var(), env() and attr() names before its fallback. Both engines
// drop a declaration with an empty reference or an env() that names nothing as
// they parse it. One engine drops a declaration with another invalid reference
// and the other keeps it as invalid at computed-value time.
function substitutionSyntax(value: string): SubstitutionSyntax {
	const tokens = valueTokens(value);
	let syntax: SubstitutionSyntax = "valid";
	for (let index = 0; index < tokens.length; index++) {
		const name = functionName(tokens[index]);
		if (name === undefined || !SUBSTITUTIONS.has(name)) continue;
		const { comma, close } = reference(tokens, index);
		const head = topLevel(tokens, index + 1, comma >= 0 ? comma : close);
		const [first, ...rest] = head;
		let verdict: SubstitutionSyntax;
		if (!first) verdict = "dropped";
		else if (name === "var")
			verdict = head.length === 1 && customName(first) ? "valid" : "disputed";
		else if (name === "env")
			verdict =
				first.type !== tokenTypes.Ident
					? "dropped"
					: rest.every((token) => token.type === tokenTypes.Number && /^\d+$/.test(token.raw))
						? "valid"
						: "dropped";
		else verdict = attributeReference(head) ? "valid" : "disputed";
		if (verdict === "dropped") return verdict;
		if (verdict === "disputed") syntax = verdict;
	}
	return syntax;
}

// attr( [ <ident>? '|' ]? <ident> <attr-type>? , ... )
function attributeReference(head: readonly Token[]): boolean {
	let at = 0;
	const delim = (token: Token | undefined, raw: string): boolean =>
		token?.type === tokenTypes.Delim && token.raw === raw;
	if (delim(head[at + 1], "|") && (head[at]?.type === tokenTypes.Ident || delim(head[at], "*")))
		at += 2;
	else if (delim(head[at], "|")) at++;
	if (head[at]?.type !== tokenTypes.Ident) return false;
	at++;
	const type = head[at];
	if (
		type &&
		(type.type === tokenTypes.Ident ||
			delim(type, "%") ||
			(type.type === tokenTypes.Function && functionName(type) === "type"))
	)
		at++;
	return at === head.length;
}

// Substitution can nest a value more deeply than any source text.
function boundedNesting(value: string, spend: (count: number) => void): void {
	if ((value.match(/[([{]/g)?.length ?? 0) <= MAX_NESTING) return;
	spend(value.length);
	let depth = 0;
	tokenize(value, (type) => {
		if (OPENERS.has(type) && ++depth > MAX_NESTING) throw new ContentError("STRUCTURE_LIMIT");
		if (CLOSERS.has(type)) depth = Math.max(0, depth - 1);
	});
}

function substituted(
	value: string,
	lookup: (name: string) => VariableValue,
	spend: (count: number) => void,
	depth = 0,
): VariableValue {
	if (depth >= 8) return null;
	spend(value.length);
	const tokens = valueTokens(value);
	// The length bound applies to substitution; a value without var() is unchanged.
	const bounded = tokens.some((token) => functionName(token) === "var");
	if (bounded && value.length > 4_096) return null;
	let output = "";
	let cursor = 0;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		const name = functionName(token);
		if (name === "env") return null;
		if (!token || name !== "var") continue;
		const { name: property, comma, close } = reference(tokens, index);
		const separator = tokens[comma];
		const end = tokens[close];
		if (!end) return null;
		// A reference without a custom property name is invalid at computed-value time.
		if (property === undefined) return undefined;
		let replacement = lookup(property);
		if (replacement === undefined && separator) {
			// A fallback, like a declared value, excludes whitespace and comments
			// at either end.
			let [first, last] = [comma + 1, close];
			while (first < last && !significant(tokens[first])) first++;
			while (last > first && !significant(tokens[last - 1])) last--;
			const fallback = first < last ? value.slice(tokens[first]?.start, tokens[last - 1]?.end) : "";
			replacement = substituted(fallback, lookup, spend, depth + 1);
		}
		if (replacement === undefined || replacement === null) return replacement;
		// Substitution inserts tokens, never joins an identifier to a following
		// parenthesis to manufacture a function (or to another token).
		output += `${value.slice(cursor, token.start)}/**/${replacement}/**/`;
		if (output.length > 4_096) return null;
		cursor = end.end;
		index = close;
	}
	output += value.slice(cursor);
	if (!bounded) return output;
	if (output.length > 4_096) return null;
	boundedNesting(output, spend);
	return output;
}

function computedVariables(
	values: Declaration[],
	parent: Variables,
	spend: (count: number) => void,
): Variables {
	const groups = new Map<string, Declaration[]>();
	const own = new Map<string, VariableValue>();
	for (const declaration of values) {
		spend(1);
		if (!declaration.property.startsWith("--")) continue;
		const group = groups.get(declaration.property) ?? [];
		group.push(declaration);
		groups.set(declaration.property, group);
	}
	if (!groups.size) return parent;
	const active: string[] = [];
	function compute(name: string): VariableValue {
		spend(1);
		if (own.has(name)) return own.get(name);
		const group = groups.get(name);
		if (!group) return variable(parent, name);
		const cycle = active.indexOf(name);
		if (cycle >= 0) {
			for (const member of active.slice(cycle)) own.set(member, undefined);
			return undefined;
		}
		if (active.length >= 8) {
			own.set(name, null);
			return null;
		}
		active.push(name);
		let result: VariableValue;
		const declaration = cascaded(
			group,
			(value) => {
				if (value.length > 4_096) {
					result = null;
					return undefined;
				}
				spend(value.length);
				// Only the references substitution follows can form a cycle;
				// inherited values have already resolved theirs.
				result = substituted(value, compute, spend);
				return typeof result === "string" ? result : undefined;
			},
			spend,
		);
		if (!own.has(name)) {
			const keyword = defaulting(typeof result === "string" ? result : undefined);
			own.set(
				name,
				!declaration || keyword === "inherit" || keyword === "unset"
					? variable(parent, name)
					: keyword === "initial"
						? undefined
						: result,
			);
		}
		active.pop();
		return own.get(name);
	}
	for (const name of groups.keys()) compute(name);
	return { own, parent };
}

function resolved(
	value: string,
	variables: Variables,
	spend: (count: number) => void,
): string | undefined {
	const result = substituted(value, (name) => variable(variables, name), spend);
	return typeof result === "string" ? asciiLower(result) : undefined;
}

// A substituted value the grammar or a calculation check rejects is invalid at
// computed-value time, so it computes as unset: a background is transparent
// over the inherited backdrop, and a text colour inherits.
function substitutedInvalid(declaration: Declaration, value: string): boolean {
	if (!deferred(declaration.value) || deferred(value)) return false;
	const checked = grammarValue(declaration.property, value);
	try {
		return (
			unknownUnit(value) ||
			!matches(lexer.matchProperty(declaration.property, checked)) ||
			!validCalculations(declaration.property, checked)
		);
	} catch (error) {
		if (error instanceof ContentError) throw error;
		return false;
	}
}

const MATH_FUNCTIONS = new Set(
	"calc -webkit-calc min max clamp round mod rem sin cos tan asin acos atan atan2 pow sqrt hypot log exp abs sign".split(
		" ",
	),
);

function substitutes(value: string): boolean {
	let found = false;
	tokenize(value, (type, start, end) => {
		found ||=
			type === tokenTypes.Function &&
			ident.decode(value.slice(start, end)).toLowerCase() === "var(";
	});
	return found;
}

function computedInheritedValue(
	declaration: Declaration,
	variables: Variables,
	spend: (count: number) => void,
): string | undefined {
	const value = resolved(declaration.value, variables, spend);
	if (value === undefined || unknownUnit(value)) return undefined;
	// An inherited property invalid after substitution computes as unset;
	// it neither resets its inherited value nor revives an earlier declaration.
	// Declared calculations were checked when parsed; substitution can form new ones.
	try {
		const checked = grammarValue(declaration.property, value);
		if (
			!matches(lexer.matchProperty(declaration.property, checked)) ||
			(substitutes(declaration.value) && !validCalculations(declaration.property, checked))
		)
			return undefined;
	} catch (error) {
		if (error instanceof ContentError) throw error;
		return undefined;
	}
	return value;
}

// CSS Values 4 math functions, read from component tokens: their syntax, their
// type and the range of values they can compute. Constant arithmetic only: no
// layout, viewport, environment or browser evaluation.
type Scalar = { number: number; unit: string };
type BaseType = "length" | "angle" | "time" | "frequency" | "resolution" | "percent";
type CalcType = { powers: ReadonlyMap<BaseType, number>; hint: BaseType | undefined };
type Quantity = { kind: "value"; number: number; unit: string };
type Calc =
	| Quantity
	| { kind: "call"; name: string; items: readonly (Calc | undefined)[]; strategy: string };
// The hull of the values a calculation can take, in the canonical unit of its
// type. An exact NaN has no other value; NaN computes as zero at the top level.
type Amount = { lo: number; hi: number; exact: boolean };
type Solved = { type: CalcType; amount: Amount; term: Scalar | undefined };
type Context = {
	numbers: boolean;
	lengths: boolean;
	// Outside a calculation, negative values are valid only in signed properties.
	signed: boolean;
	percent: Amount;
	font: Amount;
};

// The pinned grammar's length units; current Chromium and WebKit accept each.
const LENGTH_UNITS = new Set(
	"cm mm q in pt pc px em rem ex rex cap rcap ch rch ic ric lh rlh vw svw lvw dvw vh svh lvh dvh vi svi lvi dvi vb svb lvb dvb vmin svmin lvmin dvmin vmax svmax lvmax dvmax cqw cqh cqi cqb cqmin cqmax".split(
		" ",
	),
);
// In font-size, these units and percentages resolve against the parent's size.
const PARENT_FONT_UNITS = new Set("em ex cap ch ic".split(" "));
const FIXED_UNITS = new Map<string, readonly [BaseType, number]>([
	["px", ["length", 1]],
	["cm", ["length", 96 / 2.54]],
	["mm", ["length", 96 / 25.4]],
	["q", ["length", 96 / 101.6]],
	["in", ["length", 96]],
	["pt", ["length", 4 / 3]],
	["pc", ["length", 16]],
	["deg", ["angle", 1]],
	["grad", ["angle", 0.9]],
	["rad", ["angle", 180 / Math.PI]],
	["turn", ["angle", 360]],
	["s", ["time", 1000]],
	["ms", ["time", 1]],
	["hz", ["frequency", 1]],
	["khz", ["frequency", 1000]],
	["dppx", ["resolution", 1]],
	["x", ["resolution", 1]],
	["dpi", ["resolution", 1 / 96]],
	["dpcm", ["resolution", 2.54 / 96]],
]);
const CONSTANTS = new Map([
	["e", Math.E],
	["pi", Math.PI],
	["infinity", Infinity],
	["-infinity", -Infinity],
	["nan", Number.NaN],
]);
// Functions a calculation may contain that this model does not evaluate.
const OPAQUE_FUNCTIONS = new Set(
	"var env attr if inherit progress media-progress container-progress random anchor anchor-size calc-size".split(
		" ",
	),
);
const ARITY = new Map<string, readonly [number, number]>([
	["min", [1, Infinity]],
	["max", [1, Infinity]],
	["hypot", [1, Infinity]],
	["clamp", [3, 3]],
	["round", [1, 2]],
	["mod", [2, 2]],
	["rem", [2, 2]],
	["atan2", [2, 2]],
	["pow", [2, 2]],
	["log", [1, 2]],
]);
const ROUNDING = new Set("nearest up down to-zero".split(" "));
const SAMPLES: Readonly<Record<BaseType, string>> = {
	length: "1px",
	angle: "1deg",
	time: "1s",
	frequency: "1hz",
	resolution: "1dppx",
	percent: "1%",
};
const OPAQUE: Quantity = { kind: "value", number: Number.NaN, unit: "" };
const NUMBER_TYPE: CalcType = { powers: new Map(), hint: undefined };

const exactly = (value: number): Amount => ({ lo: value, hi: value, exact: true });
// A size this model does not know, such as a viewport or root font size.
const UNKNOWN: Amount = { lo: 0, hi: Infinity, exact: false };
const LENGTH: Context = {
	numbers: false,
	lengths: true,
	signed: false,
	percent: UNKNOWN,
	font: UNKNOWN,
};
const FONT_OF_ZERO: Context = { ...LENGTH, percent: exactly(0), font: exactly(0) };
const LINE_HEIGHT: Context = { ...LENGTH, numbers: true };
const OFFSET: Context = { ...LENGTH, signed: true };
// Opacity and scale factors: a number, or a percentage of one.
const FRACTION: Context = {
	numbers: true,
	lengths: false,
	signed: true,
	percent: exactly(0.01),
	font: UNKNOWN,
};

function between(lo: number, hi: number): Amount {
	return Number.isNaN(lo) || Number.isNaN(hi)
		? { lo: -Infinity, hi: Infinity, exact: false }
		: { lo, hi, exact: false };
}

const isNaNAmount = (amount: Amount): boolean => amount.exact && Number.isNaN(amount.lo);

function plus(a: Amount, b: Amount): Amount {
	if (a.exact && b.exact) return exactly(a.lo + b.lo);
	return isNaNAmount(a) || isNaNAmount(b) ? exactly(Number.NaN) : between(a.lo + b.lo, a.hi + b.hi);
}

function negated(a: Amount): Amount {
	return a.exact ? exactly(-a.lo) : between(-a.hi, -a.lo);
}

function times(a: Amount, b: Amount): Amount {
	if (a.exact && b.exact) return exactly(a.lo * b.lo);
	if (isNaNAmount(a) || isNaNAmount(b)) return exactly(Number.NaN);
	// A zero factor gives zero for every finite size.
	const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi].map((product) =>
		Number.isNaN(product) ? 0 : product,
	);
	return between(Math.min(...products), Math.max(...products));
}

function reciprocal(a: Amount): Amount {
	if (a.exact) return exactly(1 / a.lo);
	return a.lo > 0 || a.hi < 0 ? between(1 / a.hi, 1 / a.lo) : between(-Infinity, Infinity);
}

// min() and max() return NaN when any argument is NaN.
function extreme(amounts: readonly Amount[], pick: (a: number, b: number) => number): Amount {
	const lo = amounts.map((amount) => amount.lo).reduce((a, b) => pick(a, b));
	if (amounts.every((amount) => amount.exact)) return exactly(lo);
	if (amounts.some(isNaNAmount)) return exactly(Number.NaN);
	return between(
		lo,
		amounts.map((amount) => amount.hi).reduce((a, b) => pick(a, b)),
	);
}

function rounded(strategy: string, value: number, step: number): number {
	if (step === 0 || Number.isNaN(value) || Number.isNaN(step)) return Number.NaN;
	if (!Number.isFinite(value)) return Number.isFinite(step) ? value : Number.NaN;
	if (!Number.isFinite(step)) {
		if (strategy === "up" && value > 0) return Infinity;
		if (strategy === "down" && value < 0) return -Infinity;
		return value < 0 ? -0 : 0;
	}
	const size = Math.abs(step);
	const lower = Math.floor(value / size) * size;
	const upper = Math.ceil(value / size) * size;
	if (strategy === "up") return upper;
	if (strategy === "down") return lower;
	if (strategy === "to-zero") return Math.abs(lower) < Math.abs(upper) ? lower : upper;
	return value - lower < upper - value ? lower : upper;
}

function remainder(name: string, value: number, step: number): number {
	if (!Number.isFinite(value) || step === 0 || Number.isNaN(step)) return Number.NaN;
	if (!Number.isFinite(step)) return name === "mod" && value < 0 !== step < 0 ? Number.NaN : value;
	const result = value % step;
	return name === "mod" && result !== 0 && result < 0 !== step < 0 ? result + step : result;
}

function single(base: BaseType): CalcType {
	return { powers: new Map([[base, 1]]), hint: undefined };
}

function samePowers(a: CalcType, b: CalcType): boolean {
	return (
		a.powers.size === b.powers.size &&
		[...a.powers].every(([base, power]) => b.powers.get(base) === power)
	);
}

// A percentage resolved against another type joins that type.
function hinted(type: CalcType, hint: BaseType): CalcType {
	const powers = new Map(type.powers);
	const power = (powers.get(hint) ?? 0) + (powers.get("percent") ?? 0);
	powers.delete("percent");
	if (power) powers.set(hint, power);
	else powers.delete(hint);
	return { powers, hint };
}

// CSS Typed OM: add two types.
function added(a: CalcType, b: CalcType): CalcType | undefined {
	if (a.hint && b.hint && a.hint !== b.hint) return undefined;
	const left = b.hint && !a.hint ? hinted(a, b.hint) : a;
	const right = a.hint && !b.hint ? hinted(b, a.hint) : b;
	if (samePowers(left, right)) return { powers: left.powers, hint: left.hint ?? right.hint };
	const bases = new Set([...left.powers.keys(), ...right.powers.keys()]);
	if (!bases.has("percent") || bases.size < 2) return undefined;
	for (const hint of ["length", "angle", "time", "frequency", "resolution"] as const) {
		const [x, y] = [hinted(left, hint), hinted(right, hint)];
		if (samePowers(x, y)) return x;
	}
	return undefined;
}

// CSS Typed OM: multiply two types.
function multiplied(a: CalcType, b: CalcType): CalcType | undefined {
	if (a.hint && b.hint && a.hint !== b.hint) return undefined;
	const left = b.hint && !a.hint ? hinted(a, b.hint) : a;
	const right = a.hint && !b.hint ? hinted(b, a.hint) : b;
	const powers = new Map(left.powers);
	for (const [base, power] of right.powers) {
		const total = (powers.get(base) ?? 0) + power;
		if (total) powers.set(base, total);
		else powers.delete(base);
	}
	return { powers, hint: left.hint ?? right.hint };
}

// Comments are not component values: CSS never emits them as tokens.
function componentTokens(value: string): { tokens: Token[]; close: Map<number, number> } {
	const tokens = valueTokens(value).filter((token) => token.type !== tokenTypes.Comment);
	const close = new Map<number, number>();
	const open: number[] = [];
	for (const [index, { type }] of tokens.entries()) {
		const opener = open.at(-1);
		const closer = CLOSERS.get(type);
		if (OPENERS.has(type)) open.push(index);
		else if (closer && opener !== undefined && closer === OPENERS.get(tokens[opener]?.type ?? -1)) {
			close.set(opener, index);
			open.pop();
		}
	}
	return { tokens, close };
}

function quantity(token: Token): Quantity | undefined {
	if (token.type === tokenTypes.Number)
		return { kind: "value", number: Number(token.raw), unit: "" };
	if (token.type === tokenTypes.Percentage)
		return { kind: "value", number: Number(token.raw.slice(0, -1)), unit: "%" };
	if (token.type !== tokenTypes.Dimension) return undefined;
	const number = token.raw.match(NUMBER)?.[0] ?? "";
	const unit = asciiLower(ident.decode(token.raw.slice(number.length)));
	return number && (LENGTH_UNITS.has(unit) || FIXED_UNITS.has(unit))
		? { kind: "value", number: Number(number), unit }
		: undefined;
}

// Parses the math function at tokens[at]. Invalid syntax gives undefined; a
// function or keyword outside this model makes the calculation opaque. Inside
// another function, an identifier may be one of that function's keywords.
function calculation(
	tokens: readonly Token[],
	close: ReadonlyMap<number, number>,
	at: number,
	keywords: boolean,
): Calc | "opaque" | undefined {
	let opaque = false;
	const blank = (index: number): boolean => tokens[index]?.type === tokenTypes.WhiteSpace;
	const next = (index: number): number => (close.get(index) ?? index) + 1;
	function trim(start: number, finish: number): [number, number] {
		let [from, to] = [start, finish];
		while (from < to && blank(from)) from++;
		while (to > from && blank(to - 1)) to--;
		return [from, to];
	}
	function keyword(start: number, finish: number): string | undefined {
		const [from, to] = trim(start, finish);
		const token = tokens[from];
		return to - from === 1 && token?.type === tokenTypes.Ident
			? ident.decode(token.raw).toLowerCase()
			: undefined;
	}
	// Operands separated by top-level delimiters, as in a sum or a product.
	function chain(
		start: number,
		finish: number,
		operators: readonly [string, string],
		operand: (from: number, to: number) => Calc | undefined,
		spaced: boolean,
	): Calc | undefined {
		const [from, to] = trim(start, finish);
		const items: Calc[] = [];
		let first = from;
		let inverse = false;
		const take = (end: number): boolean => {
			const item = operand(first, end);
			const name = operators[0] === "+" ? "negate" : "invert";
			if (item) items.push(inverse ? { kind: "call", name, items: [item], strategy: "" } : item);
			return item !== undefined;
		};
		for (let index = from; index < to; index = next(index)) {
			const token = tokens[index];
			if (token?.type !== tokenTypes.Delim || !operators.includes(token.raw)) continue;
			// CSS requires whitespace on both sides of + and -.
			if ((spaced && (!blank(index - 1) || !blank(index + 1))) || !take(index)) return undefined;
			inverse = token.raw === operators[1];
			first = index + 1;
		}
		if (!take(to)) return undefined;
		const name = operators[0] === "+" ? "sum" : "product";
		return items.length === 1 ? items[0] : { kind: "call", name, items, strategy: "" };
	}
	const sum = (from: number, to: number): Calc | undefined =>
		chain(from, to, ["+", "-"], product, true);
	const product = (from: number, to: number): Calc | undefined =>
		chain(from, to, ["*", "/"], value, false);
	function value(start: number, finish: number): Calc | undefined {
		const [from, to] = trim(start, finish);
		const token = tokens[from];
		if (!token || from >= to || next(from) !== to) return undefined;
		if (OPENERS.has(token.type) && !close.has(from)) return undefined;
		if (token.type === tokenTypes.LeftParenthesis) return sum(from + 1, to - 1);
		if (token.type === tokenTypes.Function) return call(from);
		if (token.type !== tokenTypes.Ident) return quantity(token);
		const constant = CONSTANTS.get(ident.decode(token.raw).toLowerCase());
		if (constant !== undefined) return { kind: "value", number: constant, unit: "" };
		opaque ||= keywords;
		return keywords ? OPAQUE : undefined;
	}
	function call(at: number): Calc | undefined {
		const end = close.get(at);
		const name = functionName(tokens[at]);
		if (end === undefined || name === undefined) return undefined;
		if (name === "calc" || name === "-webkit-calc") return sum(at + 1, end);
		if (name === "sibling-index" || name === "sibling-count") {
			const [from, to] = trim(at + 1, end);
			return from === to ? { kind: "call", name, items: [], strategy: "" } : undefined;
		}
		if (OPAQUE_FUNCTIONS.has(name)) {
			opaque = true;
			return OPAQUE;
		}
		if (!MATH_FUNCTIONS.has(name)) return undefined;
		const ranges: [number, number][] = [];
		let start = at + 1;
		for (let index = start; index < end; index = next(index))
			if (tokens[index]?.type === tokenTypes.Comma) {
				ranges.push([start, index]);
				start = index + 1;
			}
		ranges.push([start, end]);
		const first = ranges[0] && keyword(...ranges[0]);
		const strategy = name === "round" && first && ROUNDING.has(first) ? first : "";
		if (strategy) ranges.shift();
		const [least, most] = ARITY.get(name) ?? [1, 1];
		if (ranges.length < least || ranges.length > most) return undefined;
		const items: (Calc | undefined)[] = [];
		for (const [index, [from, to]] of ranges.entries()) {
			// clamp() accepts none for either bound.
			const none = name === "clamp" && index !== 1 && keyword(from, to) === "none";
			const item = none ? undefined : sum(from, to);
			if (!none && !item) return undefined;
			items.push(item);
		}
		return { kind: "call", name, items, strategy };
	}
	const result = call(at);
	return result && opaque ? "opaque" : result;
}

function unitSize(unit: string, context: Context): Amount {
	const fixed = FIXED_UNITS.get(unit)?.[1];
	if (fixed !== undefined) return exactly(fixed);
	if (!unit) return exactly(1);
	if (unit === "%") return context.percent;
	return PARENT_FONT_UNITS.has(unit) ? context.font : UNKNOWN;
}

function solve(node: Calc, context: Context): Solved | undefined {
	if (node.kind === "value") {
		const { number, unit } = node;
		const base = unit === "%" ? "percent" : (FIXED_UNITS.get(unit)?.[0] ?? (unit && "length"));
		return {
			type: base ? single(base) : NUMBER_TYPE,
			amount: times(exactly(number), unitSize(unit, context)),
			term: { number, unit },
		};
	}
	const solved: (Solved | undefined)[] = [];
	for (const item of node.items) {
		const result = item && solve(item, context);
		if (item && !result) return undefined;
		solved.push(result);
	}
	// Each is a positive integer.
	if (node.name === "sibling-index" || node.name === "sibling-count")
		return { type: NUMBER_TYPE, amount: between(1, Infinity), term: undefined };
	const items = solved.filter((item) => item !== undefined);
	const [a, b] = items;
	if (!a) return undefined;
	const types = items.map((item) => item.type);
	const amounts = items.map((item) => item.amount);
	const numbers = types.every((type) => type.powers.size === 0);
	const angle = samePowers(a.type, single("angle"));
	const consistent = types
		.slice(1)
		.reduce<CalcType | undefined>((type, next) => type && added(type, next), a.type);
	let type: CalcType | undefined = consistent;
	if (node.name === "product")
		type = types
			.slice(1)
			.reduce<CalcType | undefined>((left, right) => left && multiplied(left, right), a.type);
	else if (node.name === "invert")
		type = {
			powers: new Map([...a.type.powers].map(([base, power]) => [base, -power])),
			hint: a.type.hint,
		};
	else if (node.name === "sign") type = NUMBER_TYPE;
	else if (/^(?:sin|cos|tan)$/.test(node.name)) type = numbers || angle ? NUMBER_TYPE : undefined;
	else if (/^a(?:sin|cos|tan)$/.test(node.name)) type = numbers ? single("angle") : undefined;
	else if (node.name === "atan2") type = consistent && single("angle");
	else if (/^(?:pow|sqrt|exp|log)$/.test(node.name)) type = numbers ? NUMBER_TYPE : undefined;
	else if (node.name === "round" && !b) type = numbers ? NUMBER_TYPE : undefined;
	if (!type) return undefined;
	let amount: Amount;
	const [low, middle, high] = solved.map((item) => item?.amount);
	if (node.name === "sum") amount = amounts.reduce(plus);
	else if (node.name === "negate") amount = negated(a.amount);
	else if (node.name === "product") amount = amounts.reduce(times);
	else if (node.name === "invert") amount = reciprocal(a.amount);
	else if (node.name === "min" || node.name === "max")
		amount = extreme(amounts, node.name === "min" ? Math.min : Math.max);
	else if (node.name === "clamp") {
		amount = middle ?? a.amount;
		if (high) amount = extreme([amount, high], Math.min);
		if (low) amount = extreme([low, amount], Math.max);
	} else if (node.name === "abs")
		amount = a.amount.exact
			? exactly(Math.abs(a.amount.lo))
			: a.amount.lo >= 0
				? a.amount
				: a.amount.hi <= 0
					? negated(a.amount)
					: between(0, Math.max(-a.amount.lo, a.amount.hi));
	else if (node.name === "sign")
		amount = a.amount.exact
			? exactly(Math.sign(a.amount.lo))
			: between(Math.sign(a.amount.lo), Math.sign(a.amount.hi));
	else if (!amounts.every((item) => item.exact)) amount = between(-Infinity, Infinity);
	else {
		const [x = Number.NaN, y = Number.NaN] = amounts.map(({ lo }) => lo);
		const radians = angle ? (x * Math.PI) / 180 : x;
		const degrees = 180 / Math.PI;
		const results: Readonly<Record<string, () => number>> = {
			round: () => rounded(node.strategy || "nearest", x, b ? y : 1),
			mod: () => remainder("mod", x, y),
			rem: () => remainder("rem", x, y),
			hypot: () => amounts.reduce((total, { lo }) => Math.hypot(total, lo), 0),
			sin: () => Math.sin(radians),
			cos: () => Math.cos(radians),
			tan: () => Math.tan(radians),
			asin: () => Math.asin(x) * degrees,
			acos: () => Math.acos(x) * degrees,
			atan: () => Math.atan(x) * degrees,
			atan2: () => Math.atan2(x, y) * degrees,
			pow: () => x ** y,
			sqrt: () => Math.sqrt(x),
			exp: () => Math.exp(x),
			log: () => Math.log(x) / (b ? Math.log(y) : 1),
		};
		amount = exactly(results[node.name]?.() ?? Number.NaN);
	}
	// A single-unit result keeps its unit for the offset and transform rules.
	const unit = items[0]?.term?.unit;
	const uniform = unit !== undefined && items.every((item) => item.term?.unit === unit);
	const scaled = items.filter((item) => item.term?.unit);
	let term: Scalar | undefined;
	if (/^(?:sum|negate|min|max|clamp|abs)$/.test(node.name) && uniform) {
		// A unit's size is never negative, so these follow the unit's coefficients.
		const coefficients: (Calc | undefined)[] = solved.map(
			(item) => item?.term && { kind: "value", number: item.term.number, unit: "" },
		);
		const exact = unit ? solve({ ...node, items: coefficients }, context)?.amount : amount;
		term = exact?.exact ? { number: exact.lo, unit } : undefined;
	} else if (node.name === "product" && items.every((item) => item.term) && scaled.length <= 1)
		term = {
			number: items.reduce((total, item) => total * (item.term?.number ?? Number.NaN), 1),
			unit: scaled[0]?.term?.unit ?? "",
		};
	else if (node.name === "invert" && a.term?.unit === "")
		term = { number: 1 / a.term.number, unit: "" };
	// An exact coefficient also cancels a unit of unknown size, as in 1em - 1em.
	if (term) amount = times(exactly(term.number), unitSize(term.unit, context));
	return { type, amount, term };
}

// The pinned grammar accepts any balanced math function wherever a number,
// dimension or percentage may appear. Check each calculation's syntax and type,
// then match the value again with a sample of that type in its place.
function validCalculations(property: string, value: string): boolean {
	const { tokens, close } = componentTokens(value);
	const samples: { start: number; end: number; choices: string[] }[] = [];
	function walk(from: number, to: number, nested: boolean): boolean {
		for (let index = from; index < to; index = (close.get(index) ?? index) + 1) {
			const token = tokens[index];
			const name = functionName(token);
			// Neither engine supports this alias, which the pinned grammar accepts.
			if (!token || name === "-moz-calc") return false;
			const end = close.get(index);
			if (name && MATH_FUNCTIONS.has(name)) {
				const node = calculation(tokens, close, index, nested);
				if (node === "opaque") continue;
				const type = node && solve(node, LENGTH)?.type;
				const [base, ...others] = type ? [...type.powers] : [];
				if (!type || others.length || (base && base[1] !== 1)) return false;
				const sample = base ? SAMPLES[base[0]] : "1";
				const choices = type.hint && base && base[0] !== "percent" ? [sample, "1%"] : [sample];
				samples.push({ start: token.start, end: tokens[end ?? index]?.end ?? token.end, choices });
			} else if (end !== undefined && !walk(index + 1, end, nested || name !== undefined))
				return false;
		}
		return true;
	}
	if (!walk(0, tokens.length, false)) return false;
	if (!samples.length) return true;
	const variant = (choice: (choices: string[]) => string | undefined): string => {
		let output = "";
		let cursor = 0;
		for (const { start, end, choices } of samples) {
			output += `${value.slice(cursor, start)}/**/${choice(choices)}/**/`;
			cursor = end;
		}
		return output + value.slice(cursor);
	};
	return [variant((choices) => choices[0]), variant((choices) => choices.at(-1))].every((sample) =>
		matches(lexer.matchProperty(property, sample)),
	);
}

// A single number, percentage or dimension, or a math function, in a property
// that accepts the given types.
function measure(value: string, context: Context): Solved | undefined {
	const { tokens, close } = componentTokens(value);
	let [from, to] = [0, tokens.length];
	while (from < to && tokens[from]?.type === tokenTypes.WhiteSpace) from++;
	while (to > from && tokens[to - 1]?.type === tokenTypes.WhiteSpace) to--;
	const token = tokens[from];
	if (!token) return undefined;
	let solved: Solved | undefined;
	if (to - from === 1 && token.type !== tokenTypes.Function) {
		const literal = quantity(token);
		if (!literal || (literal.number < 0 && !context.signed)) return undefined;
		// A literal zero is also a length.
		if (literal.number === 0 && !literal.unit && !context.numbers)
			return { type: single("length"), amount: exactly(0), term: { number: 0, unit: "" } };
		solved = solve(literal, context);
	} else if (close.get(from) === to - 1 && MATH_FUNCTIONS.has(functionName(token) ?? "")) {
		const node = calculation(tokens, close, from, false);
		solved = node && node !== "opaque" ? solve(node, context) : undefined;
	}
	const [base, ...others] = solved ? [...solved.type.powers] : [];
	if (!solved || others.length) return undefined;
	if (!base) return context.numbers ? solved : undefined;
	return base[1] === 1 && (base[0] === "percent" || (context.lengths && base[0] === "length"))
		? solved
		: undefined;
}

// Range checking clamps a calculation to the property's range, and a NaN
// computes as zero, so any value that cannot be positive computes as zero.
function nonPositive(value: string, context: Context): boolean {
	const amount = measure(value, context)?.amount;
	return amount !== undefined && (amount.exact ? !(amount.lo > 0) : amount.hi <= 0);
}

function fontSize(value: string): string | undefined {
	const keyword = comparisonValue(value);
	if (/^(?:inherit|initial|unset)$/.test(keyword)) return keyword;
	try {
		const ast = parse(value, { context: "value", positions: true });
		if (ast.type !== "Value") return undefined;
		const match = lexer.matchProperty("font", ast);
		if (!matches(match)) return undefined;
		// The grammar distinguishes size from an oblique angle, weight, line
		// height or family name, including when the size itself is calc().
		for (const node of ast.children)
			if (match.isProperty(node, "font-size") && node.loc)
				return value.slice(node.loc.start.offset, node.loc.end.offset);
	} catch (error) {
		if (error instanceof ContentError) throw error;
		/* An unmodelled shorthand cannot prove that its text is hidden. */
	}
	return undefined;
}

function zeroScale(value: string): boolean {
	const match = value.match(/^scale(x|y|3d)?\(([^()]*)\)$/);
	if (!match) return false;
	const parts = (match[2] ?? "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.map((part) => measure(part, FRACTION)?.term);
	const required = match[1] === "3d" ? 3 : match[1] ? 1 : undefined;
	if (
		(required && parts.length !== required) ||
		(!required && ![1, 2].includes(parts.length)) ||
		parts.some((part) => !part || (part.unit && part.unit !== "%"))
	)
		return false;
	return parts.slice(0, match[1] === "3d" ? 2 : parts.length).some((part) => part?.number === 0);
}

function appearance(
	values: Declaration[],
	inherited: Appearance,
	spend: (count: number) => void,
): Appearance {
	const variables = computedVariables(values, inherited.variables, spend);
	const chosen = winning(values, variables, spend);
	let hidden = false;
	let visibilityHidden = inherited.visibilityHidden;
	const visibility = chosen.get("visibility");
	if (visibility) {
		const original = computedInheritedValue(visibility, variables, spend);
		const value = original === undefined ? undefined : comparisonValue(original);
		if (value !== undefined && !/^(?:inherit|unset)$/.test(value))
			visibilityHidden = /^(?:hidden|collapse)$/.test(value);
	}
	let fontZero = inherited.fontZero;
	const font = chosen.get("font-size");
	if (font) {
		const value = computedInheritedValue(font, variables, spend);
		if (value !== undefined) {
			const size = font.property === "font" ? fontSize(value) : value;
			const compared = size === undefined ? undefined : comparisonValue(size);
			if (size !== undefined && compared !== undefined && !/^(?:inherit|unset)$/.test(compared))
				fontZero =
					(inherited.fontZero && /^(?:larger|smaller)$/.test(compared)) ||
					nonPositive(size, inherited.fontZero ? FONT_OF_ZERO : LENGTH);
			else if (size === undefined) fontZero = false;
		}
	}
	let current = inherited.colors.current;
	let opaqueCurrent = inherited.colors.opaqueCurrent;
	let fill = inherited.colors.fill;
	let background = inherited.colors.background;
	for (const { property, value: original } of chosen.values()) {
		const raw = resolved(original, variables, spend);
		if (raw === undefined) continue;
		const value = comparisonValue(raw);
		const offset = /^(left|right|top|bottom|text-indent)$/.test(property)
			? measure(raw, OFFSET)?.term
			: undefined;
		if (
			(property === "display" && value === "none") ||
			(property === "content-visibility" && value === "hidden") ||
			(property === "mso-hide" && value === "all") ||
			(property === "opacity" && nonPositive(raw, FRACTION)) ||
			(/^(?:max-)?(?:width|height)$/.test(property) && nonPositive(raw, LENGTH)) ||
			(property === "line-height" && nonPositive(raw, LINE_HEIGHT)) ||
			(property === "transform" && zeroScale(value)) ||
			(offset && /^(?:px|em|rem|vw|vh|%)$/.test(offset.unit) && offset.number <= -100) ||
			(property === "clip-path" && value !== "none" && !/\b(?:calc|var|env)\(/.test(value)) ||
			(property === "clip" && value !== "auto" && !/\b(?:calc|var|env)\(/.test(value))
		)
			hidden = true;
	}
	const textColor = chosen.get("color");
	if (textColor) {
		const result = substituted(textColor.value, (name) => variable(variables, name), spend);
		const raw = typeof result === "string" ? asciiLower(result) : undefined;
		const value = raw === undefined ? undefined : comparisonValue(raw);
		if (value === "initial") current = opaqueCurrent = "000000";
		else if (
			(value && /^(?:inherit|unset|currentcolor)$/.test(value)) ||
			// An inherited property that substitution makes invalid computes as unset.
			result === undefined ||
			(raw !== undefined && substitutedInvalid(textColor, raw))
		) {
			current = inherited.colors.current;
			opaqueCurrent = inherited.colors.opaqueCurrent;
		} else {
			current = value ? color(value) : undefined;
			opaqueCurrent = value ? color(value, true) : undefined;
		}
	}
	const textFill = chosen.get("-webkit-text-fill-color");
	if (textFill) {
		const result = substituted(textFill.value, (name) => variable(variables, name), spend);
		const raw = typeof result === "string" ? asciiLower(result) : undefined;
		const value = raw === undefined ? undefined : comparisonValue(raw);
		if (value === "initial") fill = "currentcolor";
		else if (
			(value && /^(?:inherit|unset)$/.test(value)) ||
			// The fill is inherited too, so an invalid substitution leaves it unset.
			result === undefined ||
			(raw !== undefined && substitutedInvalid(textFill, raw))
		)
			fill = inherited.colors.fill;
		else fill = value;
	}
	const foreground = fill === "currentcolor" ? current : fill ? color(fill) : undefined;
	const backgroundColor = chosen.get("background-color");
	if (backgroundColor) {
		const raw = resolved(backgroundColor.value, variables, spend);
		const value =
			raw === undefined || substitutedInvalid(backgroundColor, raw)
				? undefined
				: comparisonValue(raw);
		if (value && /(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient)\(/.test(value))
			background = undefined; // An image's pixels cannot prove equality with the text colour.
		else if (value === "currentcolor") {
			// currentcolor follows color, independently of text-fill overrides.
			// A partial-alpha source does not describe the composited backdrop.
			if (opaqueCurrent !== "transparent") background = opaqueCurrent;
		} else if (value) {
			// Partial-alpha backgrounds depend on pixels below this element. Their
			// source RGB alone cannot prove equality with the foreground.
			const parsed =
				color(value, true) ??
				color(value.match(/(?:#[\da-f]+|rgba?\([^)]*\)|[a-z]+)$/)?.[0] ?? "", true);
			if (parsed && parsed !== "transparent") background = parsed;
			else if (parsed !== "transparent" && !/^(?:inherit|initial|unset|none)$/.test(value))
				background = undefined;
		}
	}
	return {
		hidden,
		visibilityHidden,
		fontZero,
		colors: { foreground, background, current, opaqueCurrent, fill },
		variables,
	};
}

export function cleanHtml(input: string, options: HygieneOptions = {}): HygieneResult {
	boundedText(input);
	hygieneLimits(options);
	const { root, elements, inertTextUnits } = boundedDom(input);
	const branches = styles(root, elements);
	const bodyLink = elements.find((element) => element.name === "body")?.attribs.link;
	let renderWork = 0;
	function spend(amount: number): void {
		renderWork += amount;
		if (renderWork > MAX_RENDER_WORK) throw new ContentError("STRUCTURE_LIMIT");
	}
	// Each scenario includes the base and enclosing conditions, never unrelated
	// conditional blocks. Repeated blocks with the same condition share one branch.
	const scenarios = branches.map((branch) => {
		const active = branches.filter((candidate) =>
			candidate.conditions.every((condition) => branch.conditions.includes(condition)),
		);
		const layers = new Map<number, number>();
		const declarations = active
			.flatMap((candidate) => candidate.layers)
			.sort((a, b) => {
				spend(1);
				return a.order - b.order;
			});
		for (const declaration of declarations)
			for (const identity of declaration.path) {
				spend(1);
				if (!layers.has(identity)) layers.set(identity, layers.size + 1);
			}
		return { active, layers };
	});
	const output: string[] = [];
	const links: { index: number; host: string }[] = [];
	let hidden = inertTextUnits;
	let suspectedInstructions = instructionLike(input);
	let lineStart = true;
	function textHidden(state: Appearance): boolean {
		return (
			state.hidden ||
			state.visibilityHidden ||
			state.fontZero ||
			state.colors.foreground === "transparent" ||
			(state.colors.background !== undefined && state.colors.foreground === state.colors.background)
		);
	}
	function emit(value: string, quoted: boolean): void {
		for (const part of value.split(/(\n)/)) {
			if (!part) continue;
			if (part !== "\n" && lineStart && quoted) output.push("> ");
			output.push(part);
			lineStart = part === "\n";
		}
	}
	const variableIds = new WeakMap<Variables, number>();
	let variableCount = 0;
	function readingKey(state: Appearance): string {
		let id = variableIds.get(state.variables);
		if (id === undefined) {
			id = ++variableCount;
			variableIds.set(state.variables, id);
		}
		const { foreground, background, current, opaqueCurrent, fill } = state.colors;
		return JSON.stringify([
			state.hidden,
			state.visibilityHidden,
			state.fontZero,
			foreground,
			background,
			current,
			opaqueCurrent,
			fill,
			id,
		]);
	}
	// Every reading of an element's uncertain matches and declarations, under
	// every reading of its parent. A scenario hides text that any reading hides.
	function readings(
		values: Declaration[],
		parents: readonly Appearance[],
		intrinsicallyHidden: boolean,
	): Appearance[] {
		const groups = [...new Set(values.flatMap((value) => value.uncertain))];
		if (groups.length > MAX_UNCERTAIN) throw new ContentError("STRUCTURE_LIMIT");
		const result = new Map<string, Appearance>();
		for (const parent of parents)
			for (let mask = 0; mask < 2 ** groups.length; mask++) {
				const holds = new Set(groups.filter((_, bit) => (mask & (2 ** bit)) !== 0));
				const state = appearance(
					groups.length
						? values.filter((value) => value.uncertain.every((group) => holds.has(group)))
						: values,
					parent,
					spend,
				);
				state.hidden ||= parent.hidden || intrinsicallyHidden;
				if (parents.length === 1 && !groups.length) return [state];
				spend(values.length + 1);
				result.set(readingKey(state), state);
			}
		if (result.size > MAX_READINGS) throw new ContentError("STRUCTURE_LIMIT");
		return [...result.values()];
	}
	function render(node: ChildNode, inherited: Appearance[][], quoted: boolean): boolean {
		spend(inherited.reduce((total, scenario) => total + scenario.length, 0));
		if (isText(node)) {
			suspectedInstructions ||= instructionLike(node.data);
			if (inherited.every((scenario) => scenario.some(textHidden))) {
				hidden += node.data.length;
				return false;
			}
			const text = sourceText(node.data);
			emit(text, quoted);
			return text.replace(NONRENDERED_TEXT, "").trim().length > 0;
		}
		if (!isTag(node)) return false;
		const attributes = node.attribs;
		const presentational: Declaration[] = [];
		function presentation(property: string, value: string, userAgent = false): void {
			presentational.push({
				property,
				value,
				important: false,
				specificity: 0,
				order: -1,
				layer: [],
				inline: false,
				hint: true,
				userAgent,
				uncertain: [],
			});
		}
		function attribute(property: string, value: string): void {
			const parsed = legacyColor(value);
			if (parsed !== undefined) presentation(property, `#${parsed}`);
		}
		// Element defaults belong below every author declaration and hint. In
		// particular a link does not inherit a white parent's color by default.
		if (node.name === "a" && Object.hasOwn(attributes, "href")) {
			presentation("color", "#0000ee", true);
			if (bodyLink) attribute("color", bodyLink);
		}
		if (node.name === "mark") {
			presentation("color", "#000000", true);
			presentation("background-color", "#ffff00", true);
		}
		if (node.name === "font" && attributes.color) attribute("color", attributes.color);
		if (
			attributes.bgcolor &&
			["body", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "col", "colgroup"].includes(
				node.name,
			)
		)
			attribute("background-color", attributes.bgcolor);
		if (node.name === "body" && attributes.text) attribute("color", attributes.text);
		const intrinsicallyHidden =
			NONCONTENT.has(node.name) ||
			Object.hasOwn(attributes, "hidden") ||
			attributes["aria-hidden"]?.trim().toLowerCase() === "true" ||
			(node.name === "dialog" && !Object.hasOwn(attributes, "open"));
		const states = scenarios.map((scenario, index) => {
			const values = [
				...presentational,
				...scenario.active
					.flatMap((branch) => branch.values.get(node) ?? [])
					.map((value) =>
						value.layer.length
							? {
									...value,
									layer: value.layer.map((identity) => {
										spend(1);
										const rank = scenario.layers.get(identity);
										if (rank === undefined) throw new ContentError("INVALID_INPUT");
										return rank;
									}),
								}
							: value,
					),
			];
			spend(values.reduce((total, value) => total + value.value.length + 1, 0));
			const parents = inherited[index];
			if (!parents) throw new ContentError("INVALID_INPUT");
			return readings(values, parents, intrinsicallyHidden);
		});
		const isHidden = states.every((scenario) => scenario.some((state) => state.hidden));
		const quote =
			quoted ||
			node.name === "blockquote" ||
			/(?:^|\s)(?:gmail_quote|yahoo_quoted|protonmail_quote|moz-cite-prefix)(?:\s|$)/i.test(
				attributes.class ?? "",
			);
		if (!isHidden && BLOCKS.has(node.name) && node.name !== "br") emit("\n", quote);
		let visibleChild = false;
		for (const child of node.children) {
			const closedDetails =
				node.name === "details" &&
				!Object.hasOwn(attributes, "open") &&
				(!isTag(child) || child.name !== "summary");
			const childStates = closedDetails
				? states.map((scenario) => scenario.map((state) => ({ ...state, hidden: true })))
				: states;
			visibleChild = render(child, childStates, quote) || visibleChild;
		}
		if (!isHidden && node.name === "a" && attributes.href && visibleChild)
			emit(` ${linkMarker(attributes.href, links)}`, quote);
		if (!isHidden && BLOCKS.has(node.name)) emit("\n", quote);
		return visibleChild;
	}
	const initial = scenarios.map((): Appearance[] => [
		{
			hidden: false,
			visibilityHidden: false,
			fontZero: false,
			colors: {
				foreground: "000000",
				background: "ffffff",
				current: "000000",
				opaqueCurrent: "000000",
				fill: "currentcolor",
			},
			variables: { own: new Map() },
		},
	]);
	for (const child of root.children) render(child, initial, false);
	return finishHygiene(output.join(""), options, { hidden, links, suspectedInstructions });
}
