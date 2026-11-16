import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

type Case = readonly [label: string, parent: string, child: string, hidden: boolean];

const endOfInput: readonly Case[] = [
	["open var() fallback", "font-size:16px", "display:var(--x,none", true],
	["open calculation", "font-size:16px", "font-size:calc(0px", true],
	["open opacity calculation", "font-size:16px", "opacity:calc(0", true],
	["open var() reference", "font-size:16px", "--v:hidden;visibility:var(--v", true],
	[
		"open var() after an earlier size",
		"font-size:16px",
		"font-size:16px;--z:0px;font-size:var(--z",
		true,
	],
	["open nested parenthesis", "font-size:16px", "font-size:calc((0px", true],
	["open comment after a fallback", "font-size:16px", "display:var(--x,none/* x", true],
	["open fallback over hidden display", "", "display:none;display:var(--x,inline", false],
	["open calculation over a zero parent", "font-size:0", "font-size:calc(1px", false],
	["open opacity over zero opacity", "", "opacity:0;opacity:calc(1", false],
	[
		"open var() over hidden visibility",
		"visibility:hidden",
		"--v:visible;visibility:var(--v",
		false,
	],
	[
		"open var() over a zero size",
		"font-size:16px",
		"font-size:0;--z:16px;font-size:var(--z",
		false,
	],
	["open nested parenthesis over a zero parent", "font-size:0", "font-size:calc((1px", false],
];

const escapedUnits: readonly Case[] = [
	[
		"escaped digit that joins the unit",
		"font-size:16px",
		String.raw`font-size:0;font-size:1\30 px`,
		true,
	],
	["escaped exponent that joins the unit", "font-size:0", String.raw`font-size:1\65 3px`, true],
	["escaped point that joins the unit", "font-size:0", String.raw`font-size:1\2e 5px`, true],
	["escaped letter of a zero pixel unit", "font-size:16px", String.raw`font-size:0p\78`, true],
	[
		"unknown escaped unit under a visible parent",
		"font-size:16px",
		String.raw`font-size:1\30 px`,
		false,
	],
	["escaped letter of a one pixel unit", "font-size:0", String.raw`font-size:1p\78`, false],
	[
		"escaped space after a pixel unit",
		"font-size:16px",
		String.raw`font-size:0;font-size:1p\78\20`,
		true,
	],
	["escaped tab after a pixel unit", "font-size:0", String.raw`font-size:1p\78\9`, true],
	["escape terminator after a pixel unit", "font-size:0", String.raw`font-size:1p\78 `, false],
	[
		"digit hack after a pixel unit",
		"font-size:16px",
		String.raw`font-size:0;font-size:16px\9`,
		true,
	],
	[
		"zero hack after a pixel unit",
		"font-size:16px",
		String.raw`font-size:0;font-size:16px\0`,
		true,
	],
	["digit hack after an opacity", "font-size:16px", String.raw`opacity:0;opacity:1\9`, true],
	[
		"digit hack through a custom property",
		"font-size:0",
		String.raw`--s:16px\9;font-size:var(--s)`,
		true,
	],
	[
		"escaped tab through a custom property",
		"font-size:0",
		String.raw`--s:1p\78\9;font-size:var(--s)`,
		true,
	],
	[
		"digit hack through a custom property over a zero size",
		"font-size:16px",
		String.raw`--s:16px\9;font-size:0;font-size:var(--s)`,
		false,
	],
];

// An escaped control character is part of the identifier, so a keyword hack
// such as inline\9 names no keyword and the declaration is dropped.
const keywordHacks: readonly Case[] = [
	[
		"digit hack after a display keyword",
		"font-size:16px",
		String.raw`display:none;display:inline\9`,
		true,
	],
	[
		"digit hack after a visibility keyword",
		"font-size:16px",
		String.raw`visibility:hidden;visibility:visible\9`,
		true,
	],
	[
		"digit hack after a size keyword",
		"font-size:16px",
		String.raw`font-size:0;font-size:medium\9`,
		true,
	],
	["digit hack after a colour keyword", "", String.raw`color:#fff;color:black\9`, true],
	[
		"digit hack and terminator after a display keyword",
		"font-size:16px",
		String.raw`display:none;display:inline\9 `,
		true,
	],
	[
		"digit hack in a font shorthand",
		"font-size:16px",
		String.raw`font-size:0;font:medium\9 serif`,
		true,
	],
	[
		"digit hack through a custom visibility",
		"visibility:hidden",
		String.raw`--v:visible\9;visibility:var(--v)`,
		true,
	],
	[
		"digit hack through a custom size",
		"font-size:0",
		String.raw`--s:medium\9;font-size:var(--s)`,
		true,
	],
	[
		"escaped keyword over hidden display",
		"font-size:16px",
		String.raw`display:none;display:\69 nline`,
		false,
	],
	["escaped tab in a family name", "font-size:0", String.raw`font:16px Foo\9`, false],
	["escaped space in a family name", "font-size:0", String.raw`font:16px Foo\ Bar`, false],
	["escaped tab in a family list", "font-size:0", String.raw`font:16px "x", Foo\9, serif`, false],
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

it.each([...endOfInput, ...escapedUnits, ...keywordHacks])(
	"resolves the %s in a style attribute",
	(_label, parent, child, hidden) => {
		const result = cleanHtml(
			`<span style='${parent}'><a style='${child}' href='https://hidden.example/private'>CANARY</a></span>Visible`,
		);
		expectAdmission(result, hidden, 0);
	},
);

it.each([...endOfInput, ...escapedUnits, ...keywordHacks])(
	"resolves the %s at the end of a style element",
	(_label, parent, child, hidden) => {
		const css = `.c{${child}`;
		const result = cleanHtml(
			`<style>${css}</style><span style='${parent}'><a class=c href='https://hidden.example/private'>CANARY</a></span>Visible`,
		);
		expectAdmission(result, hidden, css.length);
	},
);
