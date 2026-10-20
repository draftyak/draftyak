import { type Options, selectAll } from "css-select";
import { type CssNode, generate, ident, lexer, parse, tokenize, tokenTypes, walk } from "css-tree";
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
import { Parser } from "htmlparser2";
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

function boundedDom(input: string): { root: Document; elements: Element[] } {
	const root = new Document([]);
	const stack: ParentNode[] = [root];
	const elements: Element[] = [];
	let nodes = 0;
	function append(node: ChildNode): void {
		if (++nodes > 20_000) throw new ContentError("STRUCTURE_LIMIT");
		const parent = stack.at(-1);
		if (!parent) throw new ContentError("INVALID_INPUT");
		node.parent = parent;
		node.prev = parent.children.at(-1) ?? null;
		if (node.prev) node.prev.next = node;
		parent.children.push(node);
	}
	new Parser(
		{
			onopentag(name, attribs) {
				if (stack.length > 128 || Object.keys(attribs).length > 128)
					throw new ContentError("STRUCTURE_LIMIT");
				const element = new Element(name, attribs);
				append(element);
				elements.push(element);
				stack.push(element);
			},
			onclosetag() {
				stack.pop();
			},
			ontext(data) {
				append(new Text(data));
			},
			oncomment() {
				if (++nodes > 20_000) throw new ContentError("STRUCTURE_LIMIT");
			},
		},
		{ decodeEntities: true, lowerCaseAttributeNames: true, lowerCaseTags: true },
	).end(input);
	return { root, elements };
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

function lexicalValue(value: string): string {
	let output = "";
	tokenize(value, (type, start, end) => {
		const raw = value.slice(start, end);
		if (type === tokenTypes.Comment) output += "/**/";
		else if (type === tokenTypes.WhiteSpace) output += " ";
		else if (
			type === tokenTypes.Ident ||
			type === tokenTypes.Function ||
			type === tokenTypes.Dimension ||
			type === tokenTypes.Hash
		) {
			const decoded = ident.decode(raw);
			let same = false;
			tokenize(decoded, (decodedType, decodedStart, decodedEnd) => {
				same = decodedType === type && decodedStart === 0 && decodedEnd === decoded.length;
			});
			// Escapes cannot turn an identifier into a number/dimension or supply
			// a delimiter. Preserve the original token boundary after decoding too:
			// an escape terminator is not a separate whitespace token.
			output += same && decoded !== raw ? `${decoded}/**/` : raw;
		} else output += raw;
	});
	return output;
}

function comparisonValue(value: string): string {
	let output = "";
	tokenize(value, (type, start, end) => {
		output += type === tokenTypes.Comment ? " " : value.slice(start, end);
	});
	return output.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
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
		const property = name.startsWith("--") ? name : name.toLowerCase();
		if (
			(!PROPERTIES.has(property) && !property.startsWith("--")) ||
			(node.value.type === "Raw" && !property.startsWith("--"))
		)
			continue;
		const raw = rawValues.get(node.value);
		if (raw === undefined) continue;
		const value = lexicalValue(raw);
		// A grammar-invalid value never participates in the CSS cascade. Custom
		// properties and deferred substitutions remain unknown until computed use;
		// they must not revive an earlier declaration when substitution fails.
		if (
			!property.startsWith("--") &&
			!/\b(?:var|env|attr)\(/i.test(value) &&
			lexer.getProperty(property)
		) {
			try {
				// The pinned grammar omits deprecated system colors. Substitute only
				// for grammar checking; keep the original unknown color in the cascade.
				const grammarValue = /^(?:color|background(?:-color)?|-webkit-text-fill-color)$/.test(
					property,
				)
					? value.replace(/[-a-z][\w-]*/gi, (word) =>
							LEGACY_SYSTEM_COLORS.has(word.toLowerCase()) ? "#000000" : word,
						)
					: value;
				if (!lexer.matchProperty(property, grammarValue).matched) continue;
			} catch {
				/* Keep unmodelled values conservative. */
			}
		}
		result.push({
			property,
			value,
			important: Boolean(node.important),
			specificity: 0,
			order: nextOrder(),
			layer: [],
			inline: false,
			hint: false,
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

function staticSelector(selector: CssNode): { query: string; specificity: number } | undefined {
	const original = generate(selector);
	if (original.length > 128) throw new ContentError("STRUCTURE_LIMIT");
	let combinators = 0;
	let dynamic = false;
	let unsupportedCombinator = false;
	walk(selector, (part) => {
		if (part.type === "Combinator") {
			if (++combinators > 8) throw new ContentError("STRUCTURE_LIMIT");
			unsupportedCombinator ||= ![" ", ">", "+", "~"].includes(part.name);
		}
		if (part.type === "PseudoClassSelector" && DYNAMIC.has(ident.decode(part.name).toLowerCase()))
			dynamic = true;
	});
	if (dynamic || selector.type !== "Selector") return undefined;
	if (unsupportedCombinator) return { query: "*", specificity: 0 };
	const parts: string[] = [];
	let compound = "";
	let specificity = 0;
	for (const part of selector.children) {
		if (part.type === "Combinator") {
			parts.push(compound || "*", part.name);
			compound = "";
		} else if (part.type === "IdSelector") {
			compound += generate(part);
			specificity += 1_000_000;
		} else if (part.type === "ClassSelector" || part.type === "AttributeSelector") {
			if (part.type === "AttributeSelector" && part.name.name.includes("|")) continue;
			compound += generate(part);
			specificity += 1_000;
		} else if (part.type === "TypeSelector") {
			compound += part.name.includes("|") ? "*" : generate(part);
			if (part.name !== "*") specificity++;
		} else if (part.type === "PseudoClassSelector") {
			const name = ident.decode(part.name).toLowerCase();
			if (name === "link" || name === "any-link") {
				compound += ":is(a[href])";
				specificity += 1_000;
			} else if (
				STRUCTURAL.has(name) &&
				(!part.children ||
					[...part.children].every((child) => child.type === "Nth" && !child.selector))
			) {
				compound += generate(part);
				specificity += 1_000;
			}
			// An unsupported whole pseudo is removed, including its arguments.
			// In particular, never run :has or turn a nested negation into a narrower selector.
		}
	}
	parts.push(compound || "*");
	return { query: parts.join(""), specificity };
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
			for (const selector of node.prelude.children) {
				if (++selectors > 128) throw new ContentError("STRUCTURE_LIMIT");
				const query = staticSelector(selector);
				if (!query) continue;
				let targets: Element[];
				try {
					targets = selectAll<AnyNode, Element>(query.query, root.children, { adapter });
				} catch (error) {
					if (error instanceof ContentError) throw error;
					// An unmodelled selector falls back to the universal superset.
					targets = elements;
				}
				const ranked = values.map((value) => ({ ...value, specificity: query.specificity }));
				for (const target of targets) assign(target, ranked, conditions);
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
			if (!lexer.matchType("color", value).matched) return undefined;
		} catch {
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
		if (value === "revert") break;
		if (value === "revert-layer") {
			candidates = candidates.filter((candidate) => {
				spend(1);
				return candidate.hint && !declaration.hint
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

function substituted(
	value: string,
	lookup: (name: string) => VariableValue,
	spend: (count: number) => void,
	depth = 0,
): VariableValue {
	if (value.length > 4_096 || depth >= 8) return null;
	spend(value.length);
	const functions = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\bvar\(/gi;
	let output = "";
	let cursor = 0;
	for (let match = functions.exec(value); match; match = functions.exec(value)) {
		if (!/^var\(/i.test(match[0])) continue;
		const start = functions.lastIndex;
		let end = start;
		let nesting = 1;
		let comma = -1;
		let quote = "";
		for (; end < value.length; end++) {
			const char = value[end];
			if (char === "\\") end++;
			else if (quote) {
				if (char === quote) quote = "";
			} else if (char === '"' || char === "'") quote = char;
			else if (char === "(") nesting++;
			else if (char === ")" && --nesting === 0) break;
			else if (char === "," && nesting === 1 && comma < 0) comma = end;
		}
		if (nesting !== 0) return null;
		const name = comparisonValue(value.slice(start, comma < 0 ? end : comma));
		if (!/^--[\w-]+$/.test(name)) return null;
		let replacement = lookup(name);
		if (replacement === undefined && comma >= 0)
			replacement = substituted(value.slice(comma + 1, end), lookup, spend, depth + 1);
		if (replacement === undefined || replacement === null) return replacement;
		// Substitution inserts tokens, never joins an identifier to a following
		// parenthesis to manufacture a function (or to another token).
		output += `${value.slice(cursor, match.index)}/**/${replacement}/**/`;
		if (output.length > 4_096) return null;
		cursor = end + 1;
		functions.lastIndex = cursor;
	}
	output += value.slice(cursor);
	return output.length > 4_096 || /\b(?:var|env)\(/i.test(output) ? null : output;
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
				// Unused fallback edges still form cycles; inherited values have
				// already resolved their references before descendant overrides.
				const references =
					/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\bvar\((?:\s|\/\*\*\/)*(--[\w-]+)/gi;
				for (const match of value.matchAll(references)) if (match[1]) compute(match[1]);
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
	return typeof result === "string" ? result.toLowerCase() : undefined;
}

function computedInheritedValue(
	declaration: Declaration,
	variables: Variables,
	spend: (count: number) => void,
): string | undefined {
	const value = resolved(declaration.value, variables, spend);
	if (value === undefined) return undefined;
	// An inherited property invalid after substitution computes as unset;
	// it neither resets its inherited value nor revives an earlier declaration.
	try {
		return lexer.matchProperty(declaration.property, value).matched ? value : undefined;
	} catch {
		return undefined;
	}
}

type Scalar = { number: number; unit: string };
function scalar(value: string, fontParentZero?: boolean): Scalar | undefined {
	// Constant arithmetic only: no layout, viewport, environment or browser evaluation.
	function component(number: number, unit: string): Scalar {
		// Only font-size evaluation can resolve these parent-relative lengths.
		if (
			fontParentZero !== undefined &&
			LENGTH_UNITS.has(unit) &&
			(number === 0 || (fontParentZero && PARENT_FONT_UNITS.has(unit)))
		)
			return { number: 0, unit: "px" };
		return { number, unit };
	}
	const lexical: { type: number; raw: string }[] = [];
	tokenize(value, (type, start, end) => {
		if (type !== tokenTypes.Comment) lexical.push({ type, raw: value.slice(start, end) });
	});
	function numeric(type: number, raw: string): Scalar | undefined {
		if (type === tokenTypes.Number) {
			const number = Number(raw);
			return Number.isFinite(number) ? component(number, "") : undefined;
		}
		if (type !== tokenTypes.Dimension && type !== tokenTypes.Percentage) return undefined;
		const match = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([\s\S]+)$/);
		if (!match) return undefined;
		const number = Number(match[1]);
		const unit = ident.decode(match[2] ?? "").toLowerCase();
		// An escaped percent sign is an identifier unit on a Dimension token,
		// not a Percentage token. Only modeled native length units can resolve.
		if (type === tokenTypes.Dimension && (unit === "%" || !LENGTH_UNITS.has(unit)))
			return undefined;
		return Number.isFinite(number) ? component(number, unit) : undefined;
	}
	const significant = lexical.filter((token) => token.type !== tokenTypes.WhiteSpace);
	if (significant.length === 1) {
		const token = significant[0];
		return token && numeric(token.type, token.raw);
	}
	const first = significant[0];
	if (first?.type !== tokenTypes.Function || first.raw !== "calc(") return undefined;
	const tokens: (Scalar | string)[] = [];
	const sumWhitespace: boolean[] = [];
	let depth = 0;
	for (let position = 0; position < lexical.length; position++) {
		const token = lexical[position];
		if (!token || token.type === tokenTypes.WhiteSpace) continue;
		if (tokens.length >= 64) return undefined;
		sumWhitespace.push(
			lexical[position - 1]?.type === tokenTypes.WhiteSpace &&
				lexical[position + 1]?.type === tokenTypes.WhiteSpace,
		);
		const number = numeric(token.type, token.raw);
		if (number) tokens.push(number);
		else if (
			token.type === tokenTypes.LeftParenthesis ||
			(token.type === tokenTypes.Function && token.raw === "calc(")
		) {
			tokens.push("(");
			depth++;
		} else if (token.type === tokenTypes.RightParenthesis) {
			tokens.push(")");
			if (--depth < 0) return undefined;
		} else if (token.type === tokenTypes.Delim && /^[+*/-]$/.test(token.raw))
			tokens.push(token.raw);
		else return undefined;
		if (depth === 0 && position < lexical.length - 1)
			if (lexical.slice(position + 1).some((next) => next.type !== tokenTypes.WhiteSpace))
				return undefined;
	}
	if (depth !== 0) return undefined;
	let index = 0;
	function atom(): Scalar | undefined {
		const token = tokens[index++];
		if (token === "(") {
			const next = expression();
			return tokens[index++] === ")" ? next : undefined;
		}
		return typeof token === "object" ? token : undefined;
	}
	function product(): Scalar | undefined {
		let left = atom();
		while (left && (tokens[index] === "*" || tokens[index] === "/")) {
			const op = tokens[index++],
				right = atom();
			if (
				!right ||
				(op === "/" && (right.unit || right.number === 0)) ||
				(op === "*" && left.unit && right.unit)
			)
				return undefined;
			left = {
				number: op === "*" ? left.number * right.number : left.number / right.number,
				unit: left.unit || right.unit,
			};
		}
		return left;
	}
	function expression(): Scalar | undefined {
		let left = product();
		while (left && (tokens[index] === "+" || tokens[index] === "-")) {
			if (!sumWhitespace[index]) return undefined;
			const op = tokens[index++],
				right = product();
			if (!right || left.unit !== right.unit) return undefined;
			left = {
				number: op === "+" ? left.number + right.number : left.number - right.number,
				unit: left.unit,
			};
		}
		return left;
	}
	const result = expression();
	return result && index === tokens.length && Number.isFinite(result.number) ? result : undefined;
}

const LENGTH_UNITS = new Set(
	"px em rem ex ch cap ic lh rlh vw vh vi vb vmin vmax svw svh svi svb svmin svmax lvw lvh lvi lvb lvmin lvmax dvw dvh dvi dvb dvmin dvmax cm mm q in pt pc %".split(
		" ",
	),
);
const PARENT_FONT_UNITS = new Set("em ex ch cap ic %".split(" "));

function fontSize(value: string): string | undefined {
	const keyword = comparisonValue(value);
	if (/^(?:inherit|initial|unset)$/.test(keyword)) return keyword;
	try {
		const ast = parse(value, { context: "value", positions: true });
		if (ast.type !== "Value") return undefined;
		const match = lexer.matchProperty("font", ast);
		if (!match.matched) return undefined;
		// The grammar distinguishes size from an oblique angle, weight, line
		// height or family name, including when the size itself is calc().
		for (const node of ast.children)
			if (match.isProperty(node, "font-size") && node.loc)
				return value.slice(node.loc.start.offset, node.loc.end.offset);
	} catch {
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
		.map((part) => scalar(part));
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
			if (size !== undefined && compared !== undefined && !/^(?:inherit|unset)$/.test(compared)) {
				const number = scalar(size, inherited.fontZero);
				fontZero = Boolean(
					(number &&
						(!number.unit || LENGTH_UNITS.has(number.unit)) &&
						(number.number === 0 ||
							(number.number < 0 &&
								LENGTH_UNITS.has(number.unit) &&
								compared.startsWith("calc(")) ||
							(number.number > 0 && inherited.fontZero && PARENT_FONT_UNITS.has(number.unit)))) ||
						(inherited.fontZero && /^(?:larger|smaller)$/.test(compared)),
				);
			} else if (size === undefined) fontZero = false;
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
		const number = scalar(raw);
		if (
			(property === "display" && value === "none") ||
			(property === "content-visibility" && value === "hidden") ||
			(property === "mso-hide" && value === "all") ||
			(property === "opacity" && number?.number === 0 && (!number.unit || number.unit === "%")) ||
			(/^(?:(?:max-)?width|(?:max-)?height|line-height)$/.test(property) &&
				number?.number === 0 &&
				(!number.unit || LENGTH_UNITS.has(number.unit))) ||
			(property === "transform" && zeroScale(value)) ||
			(/^(left|right|top|bottom|text-indent)$/.test(property) &&
				number &&
				/^(?:px|em|rem|vw|vh|%)$/.test(number.unit) &&
				number.number <= -100) ||
			(property === "clip-path" && value !== "none" && !/\b(?:calc|var|env)\(/.test(value)) ||
			(property === "clip" && value !== "auto" && !/\b(?:calc|var|env)\(/.test(value))
		)
			hidden = true;
	}
	const textColor = chosen.get("color");
	if (textColor) {
		const raw = resolved(textColor.value, variables, spend);
		const value = raw === undefined ? undefined : comparisonValue(raw);
		if (value === "initial") current = opaqueCurrent = "000000";
		else if (value && /^(?:inherit|unset|currentcolor)$/.test(value)) {
			current = inherited.colors.current;
			opaqueCurrent = inherited.colors.opaqueCurrent;
		} else {
			current = value ? color(value) : undefined;
			opaqueCurrent = value ? color(value, true) : undefined;
		}
	}
	const textFill = chosen.get("-webkit-text-fill-color");
	if (textFill) {
		const raw = resolved(textFill.value, variables, spend);
		const value = raw === undefined ? undefined : comparisonValue(raw);
		if (value === "initial") fill = "currentcolor";
		else if (value && /^(?:inherit|unset)$/.test(value)) fill = inherited.colors.fill;
		else fill = value;
	}
	const foreground = fill === "currentcolor" ? current : fill ? color(fill) : undefined;
	const backgroundColor = chosen.get("background-color");
	if (backgroundColor) {
		const raw = resolved(backgroundColor.value, variables, spend);
		const value = raw === undefined ? undefined : comparisonValue(raw);
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
	const { root, elements } = boundedDom(input);
	const branches = styles(root, elements);
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
	let hidden = 0;
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
	function render(node: ChildNode, inherited: Appearance[], quoted: boolean): boolean {
		spend(inherited.length);
		if (isText(node)) {
			suspectedInstructions ||= instructionLike(node.data);
			if (inherited.every(textHidden)) {
				hidden += node.data.length;
				return false;
			}
			const text = sourceText(node.data);
			emit(text, quoted);
			return text.length > 0;
		}
		if (!isTag(node)) return false;
		const attributes = node.attribs;
		const presentational: Declaration[] = [];
		function attribute(property: string, value: string): void {
			presentational.push({
				property,
				value: value.trim(),
				important: false,
				specificity: 0,
				order: -1,
				layer: [],
				inline: false,
				hint: true,
			});
		}
		if (attributes.color) attribute("color", attributes.color);
		if (attributes.bgcolor) attribute("background-color", attributes.bgcolor);
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
			const parent = inherited[index];
			if (!parent) throw new ContentError("INVALID_INPUT");
			const result = appearance(values, parent, spend);
			result.hidden ||= parent.hidden || intrinsicallyHidden;
			return result;
		});
		const isHidden = states.every((state) => state.hidden);
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
				? states.map((state) => ({ ...state, hidden: true }))
				: states;
			visibleChild = render(child, childStates, quote) || visibleChild;
		}
		if (
			!isHidden &&
			node.name === "a" &&
			attributes.href &&
			(visibleChild || states.some((state) => !textHidden(state)))
		)
			emit(` ${linkMarker(attributes.href, links)}`, quote);
		if (!isHidden && BLOCKS.has(node.name)) emit("\n", quote);
		return visibleChild;
	}
	const initial = scenarios.map(
		(): Appearance => ({
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
		}),
	);
	for (const child of root.children) render(child, initial, false);
	return finishHygiene(output.join(""), options, { hidden, links, suspectedInstructions });
}
