import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

type Case = { label: string; child: string; hidden: boolean; parent?: string };
const size = (value: string): string => `--size:${value};font-size:var(--size)`;
const font = (value: string): string => `--size:${value};font:var(--size)/1 serif`;
const cases: Case[] = [
	{
		label: "rejects an escaped percent dimension inside a sum",
		child: size(String.raw`calc(0\% - 1px)`),
		hidden: false,
	},
	{
		label: "rejects a negative escaped percent dimension",
		child: size(String.raw`calc(-1\%)`),
		hidden: false,
	},
	{
		label: "keeps a genuine percent sum",
		child: size("calc(0% - 1px)"),
		hidden: true,
	},
	{
		label: "keeps a genuine negative percent",
		child: size("calc(-1%)"),
		hidden: true,
	},
	{
		label: "direct declaration keeps a missing whitespace invalid",
		child: "font-size:calc(0px/**/- 1px)",
		hidden: false,
	},
	{
		label: "direct shorthand keeps a missing whitespace invalid",
		child: "font:calc(0px/**/- 1px)/1 serif",
		hidden: false,
	},
	{
		label: "direct declaration keeps actual whitespace valid",
		child: "font-size:calc(0px/**/ - 1px)",
		hidden: true,
	},
	{
		label: "direct shorthand keeps actual whitespace valid",
		child: "font:calc(0px/**/ - 1px)/1 serif",
		hidden: true,
	},
	{
		label: "direct substitution does not supply pre-minus whitespace",
		child: "--zero:0px;font-size:calc(var(--zero)- 1px)",
		hidden: false,
	},
	{
		label: "direct substitution retains actual pre-minus whitespace",
		child: "--zero:0px;font-size:calc(var(--zero) - 1px)",
		hidden: true,
	},
	{
		label: "direct substitution does not supply post-minus whitespace",
		child: "--one:1px;font-size:calc(0px -/**/var(--one))",
		hidden: false,
	},
	{
		label: "direct substitution retains actual post-minus whitespace",
		child: "--one:1px;font-size:calc(0px - var(--one))",
		hidden: true,
	},
	{
		label: "comment does not supply pre-minus whitespace",
		child: size("calc(0px/**/- 1px)"),
		hidden: false,
	},
	{
		label: "comment does not supply post-minus whitespace",
		child: size("calc(0px -/**/1px)"),
		hidden: false,
	},
	{
		label: "two comments do not supply either side",
		child: size("calc(0px/**/-/**/1px)"),
		hidden: false,
	},
	{
		label: "comment contents are not arithmetic whitespace",
		child: size("calc(0px/* x */- 1px)"),
		hidden: false,
	},
	{
		label: "comment newline is not arithmetic whitespace",
		child: size("calc(0px/*\n*/- 1px)"),
		hidden: false,
	},
	{
		label: "comment does not supply pre-plus whitespace",
		child: size("calc(0px/**/+ 0px)"),
		hidden: false,
	},
	{
		label: "comment does not supply post-plus whitespace",
		child: size("calc(0px +/**/0px)"),
		hidden: false,
	},
	{
		label: "invalid zero subtraction does not prove zero",
		child: size("calc(0px/**/- 0px)"),
		hidden: false,
	},
	{
		label: "shorthand retains invalid subtraction boundary",
		child: font("calc(0px/**/- 1px)"),
		hidden: false,
	},
	{
		label: "shorthand retains invalid zero boundary",
		child: font("calc(0px/**/- 0px)"),
		hidden: false,
	},
	{
		label: "literal missing whitespace stays invalid",
		child: size("calc(0px- 1px)"),
		hidden: false,
	},
	{
		label: "escaped initial digit remains an identifier",
		child: size(String.raw`calc(\30 px - 1px)`),
		hidden: false,
	},
	{
		label: "shorthand cannot reinterpret escaped identifier as size",
		child: font(String.raw`calc(\30 px - 1px)`),
		hidden: false,
	},
	{
		label: "hex escape inside dimension preserves actual whitespace",
		child: size(String.raw`calc(0p\78  - 1px)`),
		hidden: true,
	},
	{
		label: "simple escape inside dimension remains a size",
		child: size(String.raw`calc(0p\x - 1px)`),
		hidden: true,
	},
	{
		label: "escaped function name remains a calculation",
		child: size(String.raw`c\61 lc(0px - 1px)`),
		hidden: true,
	},
	{ label: "comment cannot make a dimension", child: size("0/**/px"), hidden: false },
	{
		label: "comment cannot make a calculation function",
		child: size("calc/**/(0px - 1px)"),
		hidden: false,
	},
	{
		label: "comment cannot join calculation identifiers",
		child: size("ca/**/lc(0px - 1px)"),
		hidden: false,
	},
	{
		label: "empty font custom value does not select zero fallback",
		child: "--size:/*var(--size)*/;font-size:var(--size,0)",
		hidden: false,
	},
	{
		label: "quoted comment and reference remain string data",
		child: '--gate:"/*var(--gate)*/";visibility:var(--gate,hidden)',
		hidden: false,
	},
	{
		label: "escaped slash cannot open a comment",
		child: String.raw`--gate:\2f **/hidden;visibility:var(--gate,hidden)`,
		hidden: false,
	},
	{
		label: "escaped star cannot open a comment",
		child: String.raw`--gate:/\2a */hidden;visibility:var(--gate,hidden)`,
		hidden: false,
	},
	{
		label: "comment separates an escaped identifier",
		child: String.raw`--gate:h\69 /**/dden;visibility:var(--gate,hidden)`,
		hidden: false,
	},
	{
		label: "real whitespace after the first comment permits subtraction",
		child: size("calc(0px/**/ - 1px)"),
		hidden: true,
	},
	{
		label: "real whitespace before the first comment permits subtraction",
		child: size("calc(0px /**/- 1px)"),
		hidden: true,
	},
	{
		label: "real whitespace after the second comment permits subtraction",
		child: size("calc(0px -/**/ 1px)"),
		hidden: true,
	},
	{
		label: "real whitespace on both sides permits subtraction",
		child: size("calc(0px /**/ - /**/ 1px)"),
		hidden: true,
	},
	{
		label: "repeated comments preserve real whitespace",
		child: size("calc(0px/**//**/ - 1px)"),
		hidden: true,
	},
	{
		label: "zero-parent em arithmetic still clamps",
		child: size("calc(1em/**/ - 1px)"),
		parent: "font-size:0",
		hidden: true,
	},
	{
		label: "shorthand real whitespace still clamps",
		child: font("calc(0px/**/ - 1px)"),
		hidden: true,
	},
	{
		label: "multiplication does not need sum whitespace",
		child: size("calc(2px/**/*/**/0)"),
		hidden: true,
	},
	{
		label: "positive arithmetic remains visible",
		child: size("calc(0px/**/ + 1px)"),
		hidden: false,
	},
	{
		label: "comment contents do not create a reference",
		child: String.raw`--gate:/*" ) var(--gate) */h\69 dden;visibility:var(--gate,visible)`,
		hidden: true,
	},
];

const attribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const canary = "DYTEST-CANARY";
it.each(cases)("preserves $label in text and anchor admission", ({ child, hidden, parent }) => {
	const result = cleanHtml(
		`<span style="${attribute(parent ?? "font-size:16px")}"><a style="${attribute(child)}" href="https://hidden.example/private">${canary}</a></span>Tail`,
	);
	expect(result.text).toBe(hidden ? "Tail" : `${canary} [link 1: hidden.example]Tail`);
	expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
	expect(result.removals.hidden).toBe(hidden ? canary.length : 0);
});
