import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

type Case = readonly [label: string, parent: string, child: string, hidden: boolean];

// The pinned grammar accepts any balanced math function. CSS drops a declaration
// whose calculation is invalid or of the wrong type, so it neither replaces an
// inherited or earlier value nor counts as visible.
const invalid: readonly Case[] = [
	["a comment before plus over a zero parent", "font-size:0", "font-size:calc(1em/**/+ 1px)", true],
	[
		"a comment before minus over a zero parent",
		"font-size:0",
		"font-size:calc(0px/**/- 1px)",
		true,
	],
	["a number over a zero parent", "font-size:0", "font-size:calc(0 - 1)", true],
	["a shorthand over a zero parent", "font-size:0", "font:calc(0px/**/- 1px)/1 serif", true],
	[
		"a substituted sum over a zero parent",
		"font-size:0",
		"--s:calc(1em/**/+ 1px);font-size:var(--s)",
		true,
	],
	[
		"adjacent operands after a zero size",
		"font-size:16px",
		"font-size:0;font-size:calc(1px+2px)",
		true,
	],
	["a number after a zero size", "font-size:16px", "font-size:0;font-size:calc(1)", true],
	[
		"a comment before plus after a zero opacity",
		"font-size:16px",
		"opacity:0;opacity:calc(1/**/+ 1)",
		true,
	],
	["the unsupported -moz-calc()", "font-size:16px", "font-size:0;font-size:-moz-calc(16px)", true],
	["a squared length", "font-size:16px", "font-size:0;font-size:calc(1px * 1px)", true],
	["a length rounded without a step", "font-size:16px", "font-size:0;font-size:round(16px)", true],
	["an absolute number", "font-size:16px", "font-size:0;font-size:abs(1)", true],
	["the sine of a length", "font-size:16px", "font-size:0;font-size:calc(sin(1px) * 16px)", true],
	["an angle", "font-size:16px", "font-size:0;font-size:asin(1)", true],
	["an unknown function", "font-size:16px", "font-size:0;font-size:calc(foo(16px))", true],
	["an identifier", "font-size:16px", "font-size:0;font-size:calc(16px + x)", true],
	["an empty argument", "font-size:16px", "font-size:0;font-size:min(16px,)", true],
	["a missing clamp() argument", "font-size:16px", "font-size:0;font-size:clamp(1px, 16px)", true],
	["a unary minus", "font-size:16px", "font-size:0;font-size:calc(-(16px))", true],
	["a comma inside calc()", "font-size:16px", "font-size:0;font-size:calc(16px, 1px)", true],
	["a number plus a percentage", "font-size:16px", "opacity:0;opacity:calc(0.5 + 10%)", true],
	["a length opacity", "font-size:16px", "opacity:0;opacity:calc(1px - 1px)", true],
	["a mixed min() opacity", "font-size:16px", "opacity:0;opacity:min(1, 50%)", true],
	[
		"a sibling index with an argument",
		"font-size:16px",
		"font-size:0;font-size:calc(sibling-index(1) * 16px)",
		true,
	],
	[
		"a valid sum after a zero size",
		"font-size:16px",
		"font-size:0;font-size:calc(1px + 2px)",
		false,
	],
	[
		"a valid min() after a zero size",
		"font-size:16px",
		"font-size:0;font-size:min(1px, 2px)",
		false,
	],
	[
		"an opacity above one after a zero opacity",
		"font-size:16px",
		"opacity:0;opacity:calc(1 + 1)",
		false,
	],
	[
		"typed arithmetic after a zero size",
		"font-size:16px",
		"font-size:0;font-size:calc(16px * 1px / 1px)",
		false,
	],
	[
		"an angle ratio after a zero size",
		"font-size:16px",
		"font-size:0;font-size:calc(atan2(1px, 1px) / 1deg * 1px)",
		false,
	],
	[
		"an unbounded clamp() after a zero size",
		"font-size:16px",
		"font-size:0;font-size:clamp(none, 16px, none)",
		false,
	],
	[
		"a rounded number after a zero size",
		"font-size:16px",
		"font-size:0;font-size:calc(round(1.4) * 16px)",
		false,
	],
	[
		"a sibling index after a zero size",
		"font-size:16px",
		"font-size:0;font-size:calc(sibling-index() * 16px)",
		false,
	],
	["infinity after a zero size", "font-size:16px", "font-size:0;font-size:calc(16px / 0)", false],
];

// The other invalid controls use only a 16px parent, where a dropped
// declaration and a visible one look the same.
const declared = [
	"font-size:calc(0px/**/- 1px)",
	"font-size:calc(0px/**/-/**/1px)",
	String.raw`font-size:calc(\30 px - 1px)`,
	String.raw`font-size:calc(0p\78 - 1px)`,
	"font-size:calc(0px/**/+1px)",
	"font-size:calc(- 1px)",
	"font-size:calc(0 - 1)",
	"font:calc(0px/**/- 1px)/1 serif",
];
const substituted = [
	"--op:-;font-size:calc(0px/**/var(--op)/**/1px)",
	"--op: - ;font-size:calc(0px/**/var(--op)/**/1px)",
	String.raw`--size:calc(0\% - 1px);font-size:var(--size)`,
	String.raw`--size:calc(-1\%);font-size:var(--size)`,
	"--size:calc(1px+2px);font-size:var(--size)",
	"--size:calc(1);font-size:var(--size)",
];
const controls: readonly Case[] = [
	...declared.flatMap((child): Case[] => [
		[`${child} over a zero parent`, "font-size:0", child, true],
		[`${child} after a zero size`, "font-size:16px", `font-size:0;${child}`, true],
	]),
	// Invalid after substitution, an inherited property is unset, so it inherits.
	...substituted.flatMap((child): Case[] => [
		[`${child} over a zero parent`, "font-size:0", child, true],
		[`${child} after a zero size`, "font-size:16px", `font-size:0;${child}`, false],
		[`${child} after a size over a zero parent`, "font-size:0", `font-size:16px;${child}`, true],
	]),
];

// Valid math computes and then clamps to the property's range: a font size is
// never negative, an opacity is from 0 to 1, and NaN computes as 0.
const ranges: readonly Case[] = [
	["min()", "font-size:16px", "font-size:min(0px, 1px)", true],
	["max()", "font-size:16px", "font-size:max(-1px, -2px)", true],
	["clamp()", "font-size:16px", "font-size:clamp(0px, 0px, 0px)", true],
	["min() inside calc()", "font-size:16px", "font-size:calc(min(0px, 1px))", true],
	["-webkit-calc()", "font-size:16px", "font-size:-webkit-calc(0px)", true],
	[
		"-webkit-calc() of non-positive mixed units",
		"font-size:16px",
		"font-size:-webkit-calc(-1px - 1em)",
		true,
	],
	[
		"-webkit-calc() of a viewport difference over a zero parent",
		"font-size:0",
		"font-size:-webkit-calc(0px - 1vw)",
		true,
	],
	["non-positive terms in mixed units", "font-size:16px", "font-size:calc(-1px - 1em)", true],
	["NaN", "font-size:16px", "font-size:calc(0px / 0)", true],
	["negative infinity", "font-size:16px", "font-size:calc(-infinity * 1px)", true],
	["a zero container unit", "font-size:16px", "font-size:0cqw", true],
	["a shorthand min()", "font-size:16px", "font:min(-1px, 1px)/1 serif", true],
	["a substituted min()", "font-size:16px", "--s:min(-1px, 1px);font-size:var(--s)", true],
	["min() over a zero parent", "font-size:0", "font-size:min(1em, 5px)", true],
	["a negative opacity", "", "opacity:-1", true],
	["a negative percentage opacity", "", "opacity:-50%", true],
	["a negative calculated opacity", "", "opacity:calc(0 - 1)", true],
	["a min() opacity", "", "opacity:min(0, 1)", true],
	["a substituted min() opacity", "", "--o:min(0, 1);opacity:var(--o)", true],
	["a NaN opacity", "", "opacity:calc(NaN)", true],
	["round()", "font-size:16px", "font-size:round(0.4px, 1px)", true],
	["mod()", "font-size:16px", "font-size:mod(4px, 2px)", true],
	["rem()", "font-size:16px", "font-size:rem(-1px, 4px)", true],
	["mod() with a negative step", "font-size:16px", "font-size:mod(5px, -2px)", true],
	["sign()", "font-size:16px", "font-size:calc(sign(-1px) * 1px)", true],
	["sin()", "font-size:16px", "font-size:calc(sin(0) * 16px)", true],
	["pow()", "font-size:16px", "font-size:calc(pow(0, 2) * 1px)", true],
	["hypot()", "font-size:16px", "font-size:hypot(0px)", true],
	["log()", "font-size:16px", "font-size:calc(log(1) * 16px)", true],
	["exp()", "font-size:16px", "font-size:calc(exp(-infinity) * 16px)", true],
	["an unbounded clamp()", "font-size:16px", "font-size:clamp(none, 0px, none)", true],
	["a clamp() minimum", "font-size:16px", "font-size:clamp(-1px, 5px, 0px)", true],
	["a rounded number", "font-size:16px", "font-size:calc(round(0.4) * 16px)", true],
	["NaN in capitals", "font-size:16px", "font-size:calc(1px * NAN)", true],
	["infinity in capitals", "font-size:16px", "font-size:calc(-INFINITY * 1px)", true],
	["pi", "font-size:16px", "font-size:calc(pi * 1px - 4px)", true],
	["a cancelled unit", "font-size:16px", "font-size:calc(1em - 1em)", true],
	["a sibling index times zero", "font-size:16px", "font-size:calc(sibling-index() * 0px)", true],
	["an escaped function name", "font-size:16px", String.raw`font-size:m\69n(0px, 1px)`, true],
	["a function name in capitals", "font-size:16px", "font-size:MIN(0px, 1px)", true],
	[
		"a positive -webkit-calc() over a zero parent",
		"font-size:0",
		"font-size:-webkit-calc(16px)",
		false,
	],
	[
		"a -webkit-calc() sum over a zero parent",
		"font-size:0",
		"font-size:-webkit-calc(1em + 1px)",
		false,
	],
	["a -webkit-calc() opacity after a zero opacity", "", "opacity:0;opacity:-webkit-calc(1)", false],
	["a positive min()", "font-size:16px", "font-size:min(1px, 2px)", false],
	["a positive max()", "font-size:16px", "font-size:max(-1px, 1px)", false],
	["a positive clamp()", "font-size:16px", "font-size:clamp(0px, 1px, 2px)", false],
	[
		"a clamp() minimum above its maximum",
		"font-size:16px",
		"font-size:clamp(1px, -5px, 0px)",
		false,
	],
	["a positive mixed difference", "font-size:16px", "font-size:calc(1em - 1px)", false],
	["a positive container unit", "font-size:16px", "font-size:1cqw", false],
	["max() over a zero parent", "font-size:0", "font-size:max(1em, 5px)", false],
	["a positive min() opacity", "", "opacity:min(1, 0.5)", false],
	["a positive max() opacity", "", "opacity:max(-1, 0.5)", false],
	["a positive opacity difference", "", "opacity:calc(1 - 0.5)", false],
	["an infinite opacity", "", "opacity:calc(infinity)", false],
	["round() up", "font-size:16px", "font-size:round(up, 0.4px, 1px)", false],
	["a positive mod()", "font-size:16px", "font-size:mod(-1px, 4px)", false],
	["abs()", "font-size:16px", "font-size:abs(-1px)", false],
	["cos()", "font-size:16px", "font-size:calc(cos(0) * 16px)", false],
	["a positive hypot()", "font-size:16px", "font-size:hypot(3px, 4px)", false],
	["exp() of zero", "font-size:16px", "font-size:calc(exp(0) * 16px)", false],
	["e", "font-size:16px", "font-size:calc(e * 1px - 2px)", false],
	["a viewport difference", "font-size:16px", "font-size:calc(1vw - 1px)", false],
	["a fluid clamp()", "font-size:16px", "font-size:clamp(1rem, 2.5vw, 2rem)", false],
	["nested fluid limits", "font-size:16px", "font-size:max(12px, min(4vw, 22px))", false],
];

// Every length unit of the pinned grammar.
const lengths: readonly Case[] = (
	"cm mm q in pt pc px em rem ex rex cap rcap ch rch ic ric lh rlh vw svw lvw dvw vh svh lvh dvh vi svi lvi dvi vb svb lvb dvb vmin svmin lvmin dvmin vmax svmax lvmax dvmax cqw cqh cqi cqb cqmin cqmax".split(
		" ",
	) as readonly string[]
).flatMap((unit): Case[] => [
	[`zero ${unit}`, "font-size:16px", `font-size:0${unit}`, true],
	[`one ${unit} after a zero size`, "font-size:16px", `font-size:0;font-size:1${unit}`, false],
]);

// A long value without var() computes like a short one; only substitution is bounded.
const terms = (count: number, term: string, operator: string): string =>
	Array.from({ length: count }, () => term).join(` ${operator} `);
const long: readonly Case[] = [
	["a long negative sum", "font-size:16px", `font-size:calc(${terms(1_000, "1px", "-")})`, true],
	["a long negative min()", "font-size:16px", `font-size:min(${terms(1_000, "-1px", ",")})`, true],
	["a long negative opacity", "", `opacity:calc(${terms(2_000, "1", "-")})`, true],
	[
		"a long positive sum over a zero parent",
		"font-size:0",
		`font-size:calc(${terms(1_000, "1em", "+")} + 1px)`,
		false,
	],
];

const endOfInput: readonly Case[] = [
	["an open string", "font-size:16px", 'font-size:0;font-size:calc(16px"', true],
	["an open URL", "font-size:16px", "font-size:0;font-size:calc(16px url(x", true],
];

function expectAdmission(
	result: ReturnType<typeof cleanHtml>,
	hidden: boolean,
	stylesheet: number,
): void {
	expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
	expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
	expect(result.removals.hidden).toBe(stylesheet + (hidden ? 6 : 0));
}

it.each([...invalid, ...controls, ...ranges, ...lengths, ...long, ...endOfInput])(
	"resolves %s in a style attribute",
	(_label, parent, child, hidden) => {
		const result = cleanHtml(
			`<span style='${parent}'><a style='${child}' href='https://hidden.example/private'>CANARY</a></span>Visible`,
		);
		expectAdmission(result, hidden, 0);
	},
);

it.each([...invalid, ...controls, ...ranges, ...long])(
	"resolves %s in a style sheet",
	(_label, parent, child, hidden) => {
		const css = `.c{${child}}`;
		const result = cleanHtml(
			`<style>${css}</style><span style='${parent}'><a class=c href='https://hidden.example/private'>CANARY</a></span>Visible`,
		);
		expectAdmission(result, hidden, css.length);
	},
);

it.each(endOfInput)(
	"resolves %s at the end of a style element",
	(_label, parent, child, hidden) => {
		const css = `.c{${child}`;
		const result = cleanHtml(
			`<style>${css}</style><span style='${parent}'><a class=c href='https://hidden.example/private'>CANARY</a></span>Visible`,
		);
		expectAdmission(result, hidden, css.length);
	},
);
