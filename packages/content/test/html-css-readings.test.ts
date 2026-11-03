import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanHtml } from "../src/html.ts";

type Case = readonly [label: string, parent: string, child: string, hidden: boolean];

const kelvin = String.fromCodePoint(0x212a);

// Cycles form only along the references substitution follows; an unused
// fallback is never substituted.
const followedCycles: readonly Case[] = [
	[
		"unused self-referencing fallback after a hidden value",
		"",
		"--known:hidden;--gate:var(--known,var(--gate));visibility:var(--gate,visible)",
		true,
	],
	[
		"unused self-referencing fallback after a none display",
		"",
		"--known:none;--gate:var(--known,var(--gate));display:var(--gate,inline)",
		true,
	],
	[
		"unused self-referencing fallback after a zero size",
		"font-size:16px",
		"--known:0px;--gate:var(--known,var(--gate));font-size:var(--gate,16px)",
		true,
	],
	[
		"unused self-referencing fallback after a zero opacity",
		"",
		"--known:0;--gate:var(--known,var(--gate));opacity:var(--gate,1)",
		true,
	],
	[
		"unused fallback back to a dependent property",
		"",
		"--z:hidden;--a:var(--z,var(--b));--b:var(--a);visibility:var(--a,visible)",
		true,
	],
	[
		"unused fallback through a second property",
		"",
		"--known:hidden;--gate:var(--known,var(--other));--other:var(--gate);visibility:var(--gate,visible)",
		true,
	],
	[
		"unused nested fallback",
		"",
		"--known:hidden;--gate:var(--known,var(--x,var(--gate)));visibility:var(--gate,visible)",
		true,
	],
	[
		"unused fallback with an invalid keyword under a hidden parent",
		"visibility:hidden",
		"--c:x;--a:var(--c,var(--b));--b:var(--a);visibility:var(--a,visible)",
		true,
	],
	[
		"unused self-referencing fallback after a visible value",
		"",
		"--base:visible;--gate:var(--base,var(--gate));visibility:var(--gate,hidden)",
		false,
	],
	["real self cycle", "", "--gate:var(--gate);visibility:var(--gate,hidden)", true],
	[
		"real cycle through a used fallback",
		"",
		"--gate:var(--missing,var(--gate));visibility:var(--gate,hidden)",
		true,
	],
	[
		"real two-property cycle under a hidden parent",
		"visibility:hidden",
		"--a:var(--b);--b:var(--a);visibility:var(--a,visible)",
		false,
	],
];

// Both engines drop a declaration whose reference names nothing as they parse
// it. One engine drops one with another invalid reference, while the other
// computes it as invalid, so text either reading hides is removed.
const substitutionSyntax: readonly Case[] = [
	[
		"invalid reference before a hidden fallback",
		"",
		"--gate:var(foo);visibility:var(--gate,hidden)",
		true,
	],
	[
		"numeric reference before a hidden fallback",
		"",
		"--gate:var(1);visibility:var(--gate,hidden)",
		true,
	],
	[
		"invalid nested fallback before a hidden fallback",
		"",
		"--gate:var(--x,var(foo));visibility:var(--gate,hidden)",
		true,
	],
	["unnamed environment value over a hidden display", "", "display:none;display:env()", true],
	["numeric environment name over a hidden display", "", "display:none;display:env(1)", true],
	["unnamed attribute over a hidden display", "", "display:none;display:attr()", true],
	["unnamed environment value over a zero size", "", "font-size:0;font-size:env()", true],
	["unnamed attribute over hidden visibility", "", "visibility:hidden;visibility:attr()", true],
	["numeric environment name over a zero opacity", "", "opacity:0;opacity:env(1)", true],
	[
		"numeric environment name as a custom property",
		"",
		"--gate:env(1);visibility:var(--gate,hidden)",
		true,
	],
	[
		"unnamed attribute as a custom property",
		"",
		"--gate:attr();visibility:var(--gate,hidden)",
		true,
	],
	[
		"numeric environment name in a fallback",
		"",
		"--gate:var(--x,env(1));visibility:var(--gate,hidden)",
		true,
	],
	[
		"numeric environment name over a hidden custom property",
		"",
		"--gate:hidden;--gate:env(1);visibility:var(--gate,visible)",
		true,
	],
	[
		"unnamed attribute over a hidden custom property",
		"",
		"--gate:hidden;--gate:attr();visibility:var(--gate,visible)",
		true,
	],
	["invalid reference over a hidden display", "", "display:none;display:var(foo)", true],
	[
		"invalid reference over a hidden custom property",
		"",
		"--gate:hidden;--gate:var(foo);visibility:var(--gate,visible)",
		true,
	],
	[
		"invalid reference under an inherited visible value",
		"--gate:visible",
		"--gate:var(foo);visibility:var(--gate,hidden)",
		true,
	],
	["numeric attribute name over a hidden display", "", "display:none;display:attr(1)", true],
	["unknown environment name over a hidden display", "", "display:none;display:env(x)", false],
	["missing attribute over a hidden display", "", "display:none;display:attr(data-x)", false],
	[
		"empty reference before a visible fallback under a hidden parent",
		"visibility:hidden",
		"--gate:var();visibility:var(--gate,visible)",
		false,
	],
	[
		"missing reference before a visible fallback under a hidden parent",
		"visibility:hidden",
		"--gate:var(--missing);visibility:var(--gate,visible)",
		false,
	],
];

// The text fill is inherited, so a fill that substitution makes invalid keeps
// the parent's fill.
const inheritedFills: readonly Case[] = [
	[
		"missing reference under a white fill",
		"-webkit-text-fill-color:#fff",
		"-webkit-text-fill-color:var(--missing)",
		true,
	],
	[
		"unknown keyword under a white fill",
		"-webkit-text-fill-color:#fff",
		"--f:notacolor;-webkit-text-fill-color:var(--f)",
		true,
	],
	[
		"invalid calculation under a white fill",
		"-webkit-text-fill-color:#fff",
		"--f:rgb(calc(0+0) 0 0);-webkit-text-fill-color:var(--f)",
		true,
	],
	[
		"extra token after a substituted black under a white fill",
		"-webkit-text-fill-color:#fff",
		"--f:#000;-webkit-text-fill-color:var(--f) x",
		true,
	],
	[
		"invalid fallback under a white fill",
		"-webkit-text-fill-color:#fff",
		"-webkit-text-fill-color:var(--missing,notacolor)",
		true,
	],
	[
		"missing reference under a transparent fill",
		"-webkit-text-fill-color:transparent",
		"-webkit-text-fill-color:var(--missing)",
		true,
	],
	[
		"substituted black under a white fill",
		"-webkit-text-fill-color:#fff",
		"--f:#000;-webkit-text-fill-color:var(--f)",
		false,
	],
	[
		"black fallback under a white fill",
		"-webkit-text-fill-color:#fff",
		"-webkit-text-fill-color:var(--missing,#000)",
		false,
	],
];

// CSS ignores only ASCII case. The Kelvin sign is not a k to either engine.
const asciiNames: readonly Case[] = [
	[
		"escaped Kelvin sign in a substituted colour",
		"color:#fff",
		String.raw`--c:blac\212A ;color:var(--c)`,
		true,
	],
	["Kelvin sign in a substituted colour", "color:#fff", `--c:blac${kelvin};color:var(--c)`, true],
	[
		"escaped Kelvin sign in a substituted dark red",
		"color:#fff",
		String.raw`--c:dar\212A red;color:var(--c)`,
		true,
	],
	[
		"escaped Kelvin sign in a substituted fill",
		"-webkit-text-fill-color:#fff",
		String.raw`--f:blac\212A ;-webkit-text-fill-color:var(--f)`,
		true,
	],
	[
		"escaped Kelvin sign in a fill property name",
		"-webkit-text-fill-color:#fff",
		String.raw`-web\212A it-text-fill-color:#000`,
		true,
	],
	[
		"Kelvin sign in a fill property name",
		"-webkit-text-fill-color:#fff",
		`-web${kelvin}it-text-fill-color:#000`,
		true,
	],
	[
		"escaped Kelvin sign in a background property name",
		"",
		String.raw`color:#fff;bac\212A ground-color:#000`,
		true,
	],
	[
		"escaped Kelvin sign in a substituted background",
		"",
		String.raw`color:#000;--b:blac\212A ;background-color:var(--b)`,
		false,
	],
	["uppercase substituted colour", "color:#fff", "--c:BLACK;color:var(--c)", false],
	[
		"uppercase fill property name",
		"-webkit-text-fill-color:#fff",
		"-WEBKIT-TEXT-FILL-COLOR:#000",
		false,
	],
	["uppercase background property name", "", "color:#fff;BACKGROUND-COLOR:#000", false],
	[
		"escaped Kelvin sign in a substituted frequency",
		"",
		String.raw`--o:calc(0\212A hz / 1hz);opacity:var(--o)`,
		false,
	],
];

const attribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

function expectAdmission(
	result: ReturnType<typeof cleanHtml>,
	hidden: boolean,
	stylesheet: number,
): void {
	expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
	expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
	expect(result.removals.hidden).toBe(stylesheet + (hidden ? 6 : 0));
}

const stylesheetTarget = (parent: string, css: string): string =>
	`<style>${css}</style><span style="${attribute(parent)}"><a class=c href="https://hidden.example/private">CANARY</a></span>Visible`;

const cases = [...followedCycles, ...substitutionSyntax, ...inheritedFills, ...asciiNames];

it.each(cases)("reads the %s in a style attribute", (_label, parent, child, hidden) => {
	const result = cleanHtml(
		`<span style="${attribute(parent)}"><a style="${attribute(child)}" href="https://hidden.example/private">CANARY</a></span>Visible`,
	);
	expectAdmission(result, hidden, 0);
});

it.each(cases)("reads the %s in a style rule", (_label, parent, child, hidden) => {
	const css = `.c{${child}}`;
	expectAdmission(cleanHtml(stylesheetTarget(parent, css)), hidden, css.length);
});

it.each(cases)("reads the %s at the end of a style element", (_label, parent, child, hidden) => {
	const css = `.c{${child}`;
	expectAdmission(cleanHtml(stylesheetTarget(parent, css)), hidden, css.length);
});

it("reads the custom properties of the parent before an unused child fallback", () => {
	const result = cleanHtml(
		'<span style="--known:hidden;--gate:var(--known,var(--gate))"><a style="visibility:var(--gate,visible)" href="https://hidden.example/private">CANARY</a></span>Visible',
	);
	expectAdmission(result, true, 0);
});

const link = '<a class="c" href="https://hidden.example/private">CANARY</a>';

// Both engines drop a rule whose selector is invalid, and a pseudo-element
// other than the first line or letter never styles the element's own text. A
// selector the model cannot match exactly may neither reveal nor hide less.
const selectors: readonly (readonly [label: string, css: string, body: string, hidden: boolean])[] =
	[
		[
			"escaped Kelvin sign in a link pseudo-class",
			String.raw`a{display:none} a:lin\212A {display:inline}`,
			`<span>${link}</span>`,
			true,
		],
		[
			"Kelvin sign in a link pseudo-class",
			`a{display:none} a:lin${kelvin}{display:inline}`,
			`<span>${link}</span>`,
			true,
		],
		[
			"escaped Kelvin sign in an any-link pseudo-class",
			String.raw`a{visibility:hidden} a:any-lin\212A {visibility:visible}`,
			`<span>${link}</span>`,
			true,
		],
		[
			"escaped Kelvin sign in a pseudo-class of a span",
			String.raw`span{display:none} span:lin\212A {display:inline}`,
			`<span>${link}</span>`,
			true,
		],
		["unknown pseudo-class", "a{display:none} a:xyz{display:inline}", `<span>${link}</span>`, true],
		[
			"unknown pseudo-class with a colour",
			"a{color:#fff} a:xyz{color:#000}",
			`<span>${link}</span>`,
			true,
		],
		[
			"unmodelled negation",
			"a{display:none} a:not(a){display:inline}",
			`<span>${link}</span>`,
			true,
		],
		[
			"pseudo-element reveal",
			"a{display:none} a::before{display:inline}",
			`<span>${link}</span>`,
			true,
		],
		[
			"CSS 2 pseudo-element reveal",
			"a{display:none} a:before{display:inline}",
			`<span>${link}</span>`,
			true,
		],
		[
			"unknown pseudo-class in a selector list",
			"a{display:none} .c, a:xyz{display:inline}",
			`<span>${link}</span>`,
			true,
		],
		[
			"escaped Kelvin sign in a type selector",
			String.raw`a{color:#fff} \212A bd a{color:#000}`,
			`<kbd>${link}</kbd>`,
			true,
		],
		[
			"escaped Kelvin sign in an attribute name",
			String.raw`a{display:none} a[\212A ]{display:inline}`,
			'<span><a k class="c" href="https://hidden.example/private">CANARY</a></span>',
			true,
		],
		[
			"escaped Kelvin sign in a case-insensitive attribute value",
			String.raw`a{display:none} a[data-x="\212A" i]{display:inline}`,
			'<span><a data-x="k" class="c" href="https://hidden.example/private">CANARY</a></span>',
			true,
		],
		[
			"uppercase attribute name",
			"a{display:none} a[K]{display:inline}",
			'<span><a k class="c" href="https://hidden.example/private">CANARY</a></span>',
			false,
		],
		[
			"unmodelled superset hiding",
			"span:has(b){display:none}",
			`<span>${link}<b></b></span>`,
			true,
		],
		[
			"unmodelled selector with the higher specificity",
			".c{display:inline} a:has(.x){display:none}",
			'<span><a class="c" href="https://hidden.example/private">CANARY<b class="x"></b></a></span>',
			true,
		],
		[
			"link pseudo-class reveal",
			"a{display:none} a:link{display:inline}",
			`<span>${link}</span>`,
			false,
		],
		[
			"uppercase link pseudo-class reveal",
			"a{display:none} a:LINK{display:inline}",
			`<span>${link}</span>`,
			false,
		],
		["hidden pseudo-element box", "a::before{display:none}", `<span>${link}</span>`, false],
		["white pseudo-element box", "a::after{color:#fff}", `<span>${link}</span>`, false],
		["type selector colour", "a{color:#fff} kbd a{color:#000}", `<kbd>${link}</kbd>`, false],
		[
			"dynamic selector with an unknown pseudo-class in a selector list",
			"a{display:none} .c, a:hover:xyz{display:inline}",
			`<span>${link}</span>`,
			true,
		],
		[
			"selector list with a dynamic selector",
			"a{display:none} .c, a:hover{display:inline}",
			`<span>${link}</span>`,
			false,
		],
		[
			"selector list with a pseudo-element box",
			"a{display:none} .c, a::before{display:inline}",
			`<span>${link}</span>`,
			false,
		],
	];

it.each(selectors)("reads the %s", (_label, css, body, hidden) => {
	expectAdmission(cleanHtml(`<style>${css}</style>${body}Visible`), hidden, css.length);
});

describe("explicit refusals", () => {
	afterEach(() => vi.restoreAllMocks());
	const families = (count: number): string =>
		Array.from({ length: count }, (_, index) => `f${index}`).join(",");
	const layers = (count: number): string => `${"none,".repeat(count)}#000`;
	const nested = (value: string, levels: number, opener = "calc("): string =>
		`${opener.repeat(levels)}${value}${")".repeat(levels)}`;
	const chain = (seed: string, steps: readonly number[]): string =>
		`--a0:${seed};${steps.map((levels, index) => `--a${index + 1}:${nested(`var(--a${index})`, levels)}`).join(";")};font-size:var(--a${steps.length})`;
	// Each source value stays within the source nesting bound, including the
	// rule block and var() itself; substitution builds the deeper value.
	const deep = (seed: string, levels: number, opener = "calc("): string =>
		`--a0:${seed};--a1:${nested("var(--a0)", 30, opener)};font-size:${nested("var(--a1)", levels - 30)}`;
	const refusals: readonly (readonly [label: string, parent: string, child: string])[] = [
		["a font with 258 families", "", `font:0 ${families(258)}`],
		["a substituted font with 258 families", "", `--f:0 ${families(258)};font:var(--f)`],
		[
			"a nonzero font with 259 families",
			"font-size:16px",
			`font-size:0;font:16px ${families(259)}`,
		],
		["a background with 31 layers", "", `color:#000;background:${layers(31)}`],
		[
			"a substituted background with 31 layers",
			"",
			`color:#000;--b:${layers(31)};background:var(--b)`,
		],
		["a substituted calculation 33 levels deep", "font-size:0", deep("16px", 33)],
		["substituted parentheses 33 levels deep", "font-size:0", deep("16px", 33, "(")],
		[
			"a chain 102 levels deep under a zero size",
			"font-size:0",
			chain("16px", [25, 25, 25, 25, 2]),
		],
		["a chain 104 levels deep under a 16px size", "font-size:16px", chain("0px", [26, 26, 26, 26])],
	];
	const accepted: Case[] = [
		["a font with 257 families", "", `font:0 ${families(257)}`, true],
		[
			"a nonzero font with 258 families",
			"font-size:16px",
			`font-size:0;font:16px ${families(258)}`,
			false,
		],
		["a background with 30 layers", "", `color:#000;background:${layers(30)}`, true],
		["a substituted calculation 32 levels deep", "font-size:16px", deep("0px", 32), true],
		[
			"a substituted calculation 32 levels deep under a zero size",
			"font-size:0",
			deep("16px", 32),
			false,
		],
	];

	it.each(refusals)("refuses %s in a style attribute and a style rule", (_label, parent, child) => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const css = `.c{${child}}`;
		for (const html of [
			`<span style="${attribute(parent)}"><a style="${attribute(child)}" href="https://hidden.example/private">CANARY</a></span>Visible`,
			stylesheetTarget(parent, css),
		])
			expect(() => cleanHtml(html)).toThrowError(
				expect.objectContaining({ code: "STRUCTURE_LIMIT" }),
			);
	});

	it("refuses substitutions nested 33 levels across elements", () => {
		const spans = [30, 3].map(
			(levels, index) => `<span style="--a${index + 1}:${nested(`var(--a${index})`, levels)}">`,
		);
		expect(() =>
			cleanHtml(
				`<span style="font-size:0;--a0:16px">${spans.join("")}<a style="font-size:var(--a2)" href="https://hidden.example/private">CANARY</a></span></span></span>Visible`,
			),
		).toThrowError(expect.objectContaining({ code: "STRUCTURE_LIMIT" }));
	});

	const uncertain = (declarations: readonly string[]): string =>
		`<style>${declarations.map((declaration, index) => `a:x${index}{${declaration}}`).join("")}</style><span>${link}</span>Visible`;
	const colours = Array.from({ length: 9 }, (_, index) => `color:#00000${index}`);
	const independent = [
		"color:#000001",
		"color:#000002",
		"background-color:#000003",
		"-webkit-text-fill-color:#000004",
		"visibility:hidden",
		"font-size:0",
		"display:none",
	];

	const stylesheetLength = (html: string): number => html.indexOf("</style>") - "<style>".length;

	it("refuses an element with more than eight uncertain rules", () => {
		expect(() => cleanHtml(uncertain(colours))).toThrowError(
			expect.objectContaining({ code: "STRUCTURE_LIMIT" }),
		);
		const html = uncertain(colours.slice(0, 8));
		expectAdmission(cleanHtml(html), false, stylesheetLength(html));
	});

	it("refuses an element with more than 64 distinct readings", () => {
		expect(() => cleanHtml(uncertain(independent))).toThrowError(
			expect.objectContaining({ code: "STRUCTURE_LIMIT" }),
		);
		const html = uncertain(independent.slice(1));
		expectAdmission(cleanHtml(html), true, stylesheetLength(html));
	});

	it.each(accepted)("reads %s below the limit", (_label, parent, child, hidden) => {
		const css = `.c{${child}}`;
		expectAdmission(
			cleanHtml(
				`<span style="${attribute(parent)}"><a style="${attribute(child)}" href="https://hidden.example/private">CANARY</a></span>Visible`,
			),
			hidden,
			0,
		);
		expectAdmission(cleanHtml(stylesheetTarget(parent, css)), hidden, css.length);
	});
});
