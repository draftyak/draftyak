import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

type Case = readonly [label: string, parent: string, child: string, hidden: boolean];

// A comment is not a token, so it never changes the name a reference uses.
const commentedNames: readonly Case[] = [
	["visibility name after a comment", "font-size:16px", "--v:hidden;visibility:var(/**/--v)", true],
	["display name after a comment", "font-size:16px", "--d:none;display:var(/**/--d)", true],
	["font size name after a comment", "font-size:16px", "--s:0;font-size:var(/**/--s)", true],
	[
		"name of an escaped reference",
		"font-size:16px",
		String.raw`--v:hidden;visibility:v\61 r(--v)`,
		true,
	],
	[
		"name between comments and spaces",
		"font-size:16px",
		"--v:hidden;visibility:var( /* x */ --v /* y */ )",
		true,
	],
	[
		"commented name before an unused fallback",
		"font-size:16px",
		"--v:hidden;visibility:var(/**/--v/**/,/**/visible)",
		true,
	],
	[
		"commented missing name before a hidden fallback",
		"font-size:16px",
		"visibility:var(/**/--missing,/**/hidden)",
		true,
	],
	[
		"commented name of an escaped uppercase reference",
		"font-size:16px",
		String.raw`--v:hidden;visibility:V\41 R(/**/--v)`,
		true,
	],
	[
		"commented visible name under a hidden parent",
		"visibility:hidden",
		"--v:visible;visibility:var(/**/--v)",
		false,
	],
	[
		"commented nonzero size under a zero parent",
		"font-size:0",
		"--s:16px;font-size:var(/**/--s)",
		false,
	],
	[
		"escaped reference to a visible value under a hidden parent",
		"visibility:hidden",
		String.raw`--v:visible;visibility:v\61 r(--v)`,
		false,
	],
	[
		"commented inline display over an earlier none",
		"font-size:16px",
		"display:none;--d:inline;display:var(/**/--d)",
		false,
	],
];

// Only a function token whose whole decoded name is var is a reference.
const otherFunctions: readonly Case[] = [
	[
		"dash-prefixed function of a missing name",
		"visibility:hidden",
		"--gate:-var(--missing);visibility:var(--gate,visible)",
		true,
	],
	[
		"dash-prefixed function of its own name",
		"visibility:hidden",
		"--gate:-var(--gate);visibility:var(--gate,visible)",
		true,
	],
	[
		"accented function of a missing name",
		"visibility:hidden",
		"--gate:évar(--missing);visibility:var(--gate,visible)",
		true,
	],
	[
		"escaped dash function of a missing name",
		"visibility:hidden",
		String.raw`--gate:\2d var(--missing);visibility:var(--gate,visible)`,
		true,
	],
	[
		"escaped dash function of its own name",
		"visibility:hidden",
		String.raw`--gate:\2d var(--gate);visibility:var(--gate,visible)`,
		true,
	],
	[
		"dash-prefixed function in a used fallback",
		"visibility:hidden",
		"--gate:var(--missing,-var(--gate));visibility:var(--gate,visible)",
		true,
	],
	[
		"missing reference with a visible fallback",
		"visibility:hidden",
		"--gate:var(--missing);visibility:var(--gate,visible)",
		false,
	],
	[
		"uppercase reference to a missing name",
		"visibility:hidden",
		"--gate:VAR(--missing);visibility:var(--gate,visible)",
		false,
	],
	[
		"escaped reference to a missing name",
		"visibility:hidden",
		String.raw`--gate:v\61 r(--missing);visibility:var(--gate,visible)`,
		false,
	],
	[
		"self reference with a visible fallback",
		"visibility:hidden",
		"--gate:var(--gate);visibility:var(--gate,visible)",
		false,
	],
	[
		"escaped uppercase self reference",
		"visibility:hidden",
		String.raw`--gate:V\41 R(--gate);visibility:var(--gate,visible)`,
		false,
	],
];

// Custom property names compare as decoded identifiers.
const decodedNames: readonly Case[] = [
	[
		"accented name that extends an ASCII name",
		"visibility:hidden",
		"--xé:1;--x:var(--xé);visibility:var(--x,visible)",
		true,
	],
	["non-ASCII name of a hidden display", "font-size:16px", "--ü:none;display:var(--ü)", true],
	["non-ASCII name of hidden visibility", "font-size:16px", "--ü:hidden;visibility:var(--ü)", true],
	[
		"name with an escaped space",
		"font-size:16px",
		String.raw`--a\ b:hidden;visibility:var(--a\ b)`,
		true,
	],
	[
		"name with a hex-escaped space",
		"font-size:16px",
		String.raw`--a\20 b:hidden;visibility:var(--a\ b)`,
		true,
	],
	[
		"name with an escaped full stop",
		"font-size:16px",
		String.raw`--a\.b:none;display:var(--a\.b)`,
		true,
	],
	[
		"name with an escaped letter",
		"font-size:16px",
		String.raw`--x:hidden;visibility:var(--\78)`,
		true,
	],
	[
		"accented name of a visible value",
		"visibility:hidden",
		"--xé:visible;visibility:var(--xé)",
		false,
	],
	[
		"escaped space name of a visible value",
		"visibility:hidden",
		String.raw`--a\ b:visible;visibility:var(--a\20 b)`,
		false,
	],
];

// A string is one token, including one left open at the end of input.
const opaqueStrings: readonly Case[] = [
	[
		"open string that names its own property",
		"visibility:hidden",
		'visibility:var(--gate,visible);--gate:"var(--gate)',
		true,
	],
	[
		"string that names its own property",
		"visibility:hidden",
		'--gate:"var(--gate)";visibility:var(--gate,visible)',
		true,
	],
	["string family after a zero size", "font-size:16px", 'font:0 "var("', true],
	["open string family after a zero size", "font-size:16px", 'font:0 "var(', true],
	[
		"substituted string family after a zero size",
		"font-size:16px",
		'--f:"var(";font:0 var(--f)',
		true,
	],
	[
		"open string family through a custom property",
		"font-size:16px",
		'font:0 var(--f);--f:"var(',
		true,
	],
	["string family after a nonzero size", "font-size:0", 'font:16px "var("', false],
	[
		"open string family through a custom property after a nonzero size",
		"font-size:0",
		'font:16px var(--f);--f:"var(',
		false,
	],
	[
		"substituted string family after a nonzero size",
		"font-size:0",
		'--f:"var(";font:16px var(--f)',
		false,
	],
	[
		"string beside a reference fallback",
		"font-size:16px",
		'display:none;display:"var(" var(--x,inline)',
		false,
	],
];

// Without a substitution function the grammar decides at parse time.
const invalidOverrides: readonly Case[] = [
	["unknown function over hidden display", "font-size:16px", "display:none;display:x-var(1)", true],
	["string over hidden display", "font-size:16px", "display:none;display:'var('", true],
	[
		"unknown function over hidden visibility",
		"font-size:16px",
		"visibility:hidden;visibility:x-var(1)",
		true,
	],
	["unknown function over a zero size", "font-size:16px", "font-size:0;font-size:x-var(1)", true],
	[
		"env-like function over hidden display",
		"font-size:16px",
		"display:none;display:x-env(1)",
		true,
	],
	["env string over hidden display", "font-size:16px", 'display:none;display:"env("', true],
	[
		"attr-like function over hidden display",
		"font-size:16px",
		"display:none;display:x-attr(1)",
		true,
	],
	["attr string over hidden display", "font-size:16px", "display:none;display:'attr('", true],
	[
		"reference fallback over hidden display",
		"font-size:16px",
		"display:none;display:var(--x,inline)",
		false,
	],
];

// A background that substitution makes invalid computes as transparent.
const substitutedBackgrounds: readonly Case[] = [
	[
		"unknown function substituted into a background",
		"",
		"color:#fff;--b:x-var(1);background-color:var(--b,red)",
		true,
	],
	[
		"string substituted into a background over a red parent",
		"background:red",
		'color:red;--b:"var(";background-color:var(--b)',
		true,
	],
	[
		"string fallback in a background shorthand",
		"",
		'color:#fff;background:var(--missing,"var(")',
		true,
	],
	["unknown environment value as a background", "", "color:#fff;background-color:env(x)", true],
	[
		"escaped environment function as a background",
		"",
		String.raw`color:#fff;background-color:e\6e v(x)`,
		true,
	],
	[
		"unknown environment value through a custom property",
		"",
		"color:#fff;--g:env(x);background-color:var(--g)",
		true,
	],
	[
		"invalid calculation substituted into a background",
		"",
		"color:#fff;--b:rgb(calc(0+0) 0 0);background-color:var(--b)",
		true,
	],
	[
		"background fallback after a missing non-ASCII name",
		"",
		"color:#fff;--b:var(--ü);background-color:var(--b,red)",
		false,
	],
	[
		"valid calculation substituted into a background",
		"",
		"color:#fff;--b:rgb(calc(255 + 0) 0 0);background-color:var(--b)",
		false,
	],
];

// A fallback, like a declared value, excludes whitespace and comments at either
// end, so they never supply the whitespace a sum needs.
const trimmedFallbacks: readonly Case[] = [
	[
		"padded plus fallback over a zero parent",
		"font-size:0",
		"font-size:calc(1em/**/var(--missing, + )/**/1px)",
		true,
	],
	[
		"padded operand fallback before minus",
		"font-size:0",
		"font-size:calc(var(--missing, 1px )- 0px)",
		true,
	],
	[
		"padded plus fallback through a custom property",
		"font-size:0",
		"--op:var(--missing, + );font-size:calc(1em/**/var(--op)/**/1px)",
		true,
	],
	[
		"padded operand fallback through a custom property",
		"font-size:0",
		"--one:var(--missing, 1px );font-size:calc(var(--one)- 0px)",
		true,
	],
	[
		"padded plus in a nested fallback",
		"font-size:0",
		"font-size:calc(1em/**/var(--a, var(--b, + ))/**/1px)",
		true,
	],
	[
		"tab-padded plus fallback",
		"font-size:0",
		"font-size:calc(1em/**/var(--missing,\t+\t)/**/1px)",
		true,
	],
	[
		"comment-padded plus fallback",
		"font-size:0",
		"font-size:calc(1em/**/var(--missing,/**/ + /**/)/**/1px)",
		true,
	],
	[
		"fallback with a leading space before plus",
		"font-size:0",
		"font-size:calc(1em/**/var(--missing, + 1px))",
		true,
	],
	["unpadded plus fallback", "font-size:0", "font-size:calc(1em/**/var(--missing,+)/**/1px)", true],
	[
		"padded negative fallback keeps its inner whitespace",
		"font-size:16px",
		"font-size:calc(var(--missing, 0px - 1px ))",
		true,
	],
	[
		"padded minus fallback under a visible parent",
		"font-size:16px",
		"font-size:calc(0px/**/var(--missing, - )/**/1px)",
		false,
	],
	[
		"padded minus fallback through a custom property",
		"font-size:16px",
		"--op:var(--missing, - );font-size:calc(0px/**/var(--op)/**/1px)",
		false,
	],
	[
		"fallback with a leading space before minus",
		"font-size:16px",
		"font-size:calc(0px/**/var(--missing, - 1px))",
		false,
	],
	[
		"padded operand fallback before a spaced minus",
		"font-size:0",
		"font-size:calc(var(--missing, 1px ) - 0px)",
		false,
	],
	[
		"padded plus fallback between spaces",
		"font-size:0",
		"font-size:calc(1em var(--missing, + ) 1px)",
		false,
	],
	[
		"padded positive fallback keeps its inner whitespace",
		"font-size:0",
		"font-size:calc(var(--missing, 1px - 0px ))",
		false,
	],
	["padded keyword fallback", "visibility:hidden", "visibility:var(--missing, visible )", false],
];

// A custom property, or a value that uses var(), is dropped when it holds a bad
// string, a bad URL or an unmatched closing bracket. A "!" before any word but
// important stays in the value, which is then invalid.
const malformedValues: readonly Case[] = [
	[
		"custom property with an unmatched parenthesis",
		"",
		"--gate:visible);visibility:var(--gate,hidden)",
		true,
	],
	[
		"custom display with an unmatched parenthesis",
		"",
		"--d:inline);display:none;display:var(--d,none)",
		true,
	],
	[
		"custom property with an unmatched bracket",
		"",
		"--gate:visible];visibility:var(--gate,hidden)",
		true,
	],
	["custom property with a bad string", "", '--gate:"x\n;visibility:var(--gate,hidden)', true],
	["custom property with a bad URL", "", "--gate:url(x y);visibility:var(--gate,hidden)", true],
	[
		"custom property with a bracket closing a parenthesis",
		"",
		"--gate:(visible]);visibility:var(--gate,hidden)",
		true,
	],
	[
		"custom property with another flag",
		"",
		"--gate:visible !ie;visibility:var(--gate,hidden)",
		true,
	],
	["display with another flag", "font-size:16px", "display:none;display:block !ie", true],
	[
		"reference fallback with a bad string",
		"font-size:16px",
		'display:none;display:var(--x,"a\n)',
		true,
	],
	[
		"self reference inside a bad URL",
		"visibility:hidden",
		"--gate:url(var(--gate));visibility:var(--gate,visible)",
		false,
	],
	[
		"custom property with a balanced block",
		"",
		"--gate:(visible);visibility:var(--gate,hidden)",
		false,
	],
	["custom property with a URL", "", "--gate:url(x);visibility:var(--gate,hidden)", false],
	[
		"custom property with an important flag",
		"",
		"--gate:visible !important;visibility:var(--gate,hidden)",
		false,
	],
	[
		"display with an uppercase important flag",
		"font-size:16px",
		"display:none;display:block !IMPORTANT",
		false,
	],
	[
		"display with an escaped important flag",
		"font-size:16px",
		String.raw`display:none;display:block !imp\6f rtant`,
		false,
	],
];

// A text colour that substitution makes invalid computes as inherited.
const substitutedColors: readonly Case[] = [
	[
		"invalid calculation substituted into a text colour",
		"color:#fff",
		"--c:rgb(calc(0+0) 0 0);color:var(--c)",
		true,
	],
	[
		"unknown keyword substituted into a text colour",
		"color:#fff",
		"--c:notacolor;color:var(--c)",
		true,
	],
	[
		"keyword hack substituted into a text colour",
		"color:#fff",
		String.raw`--c:red\9;color:var(--c)`,
		true,
	],
	[
		"unknown fallback colour after an earlier black",
		"color:#fff",
		"color:#000;color:var(--missing,notacolor)",
		true,
	],
	["missing reference as a text colour", "color:#fff", "color:#000;color:var(--missing)", true],
	["initial custom property as a text colour", "color:#fff", "--c:initial;color:var(--c)", true],
	["self reference as a text colour", "color:#fff", "--c:var(--c);color:var(--c)", true],
	["missing reference with a black fallback", "color:#fff", "color:var(--missing,#000)", false],
	[
		"valid calculation substituted into a text colour",
		"color:#fff",
		"--c:rgb(calc(0 + 0) 0 0);color:var(--c)",
		false,
	],
	["black substituted into a text colour", "color:#fff", "--c:#000;color:var(--c)", false],
	["unknown keyword under a black parent", "color:#000", "--c:notacolor;color:var(--c)", false],
];

const cases = [
	...commentedNames,
	...otherFunctions,
	...decodedNames,
	...opaqueStrings,
	...invalidOverrides,
	...substitutedBackgrounds,
	...trimmedFallbacks,
	...malformedValues,
	...substitutedColors,
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

function stylesheetTarget(parent: string, css: string): string {
	return `<style>${css}</style><span style="${attribute(parent)}"><a class=c href="https://hidden.example/private">CANARY</a></span>Visible`;
}

it.each(cases)("resolves the %s in a style attribute", (_label, parent, child, hidden) => {
	const result = cleanHtml(
		`<span style="${attribute(parent)}"><a style="${attribute(child)}" href="https://hidden.example/private">CANARY</a></span>Visible`,
	);
	expectAdmission(result, hidden, 0);
});

it.each(cases)("resolves the %s in a style rule", (_label, parent, child, hidden) => {
	const css = `.c{${child}}`;
	expectAdmission(cleanHtml(stylesheetTarget(parent, css)), hidden, css.length);
});

it.each(cases)("resolves the %s at the end of a style element", (_label, parent, child, hidden) => {
	const css = `.c{${child}`;
	expectAdmission(cleanHtml(stylesheetTarget(parent, css)), hidden, css.length);
});
