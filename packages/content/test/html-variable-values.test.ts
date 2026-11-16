import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

const canary = "DYTEST-VARIABLE-CANARY";
const link = `<a href="https://canary.example/private-path">${canary}</a>`;
const tail = "Visible after";
const span = (style: string, child: string = link): string =>
	`<span style="${style}">${child}</span>`;
const layered = (base: string, fallback: string): string =>
	`<style>@layer base,top;@layer base{.target{--gate:${base}}}@layer top{.target{--gate:var(--missing,revert-layer)}}.target{visibility:var(--gate,${fallback})}</style><span class="target">${link}</span>`;
// Stylesheet text is removed too; isolate those fixture bytes from the linked canary.
const stylesheetUnits = (html: string): number =>
	html.match(/<style>([\s\S]*)<\/style>/)?.[1]?.length ?? 0;

// CSS Variables 1 sections 2.2, 2.3 and 3: initial, empty and cyclic values differ;
// inherited custom properties have already substituted their parent's references.
const hidden = [
	[
		"generated initial uses the visibility fallback",
		span("--gate:var(--missing,initial);visibility:var(--gate,hidden)"),
	],
	[
		"generated initial masks an inherited variable",
		span("--gate:visible", span("--gate:var(--missing,initial);visibility:var(--gate,hidden)")),
	],
	[
		"generated inherit retains the parent variable",
		span("--gate:hidden", span("--gate:var(--missing,inherit);visibility:var(--gate,visible)")),
	],
	[
		"generated unset retains the parent variable",
		span("--gate:hidden", span("--gate:var(--missing,unset);visibility:var(--gate,visible)")),
	],
	[
		"generated revert does not revive an earlier author value",
		span("--gate:visible;--gate:var(--missing,revert);visibility:var(--gate,hidden)"),
	],
	[
		"generated revert inherits the parent's hidden variable",
		span(
			"--gate:hidden",
			span("--gate:visible;--gate:var(--missing,revert);visibility:var(--gate,visible)"),
		),
	],
	["generated revert-layer selects a hidden lower layer", layered("hidden", "visible")],
	[
		"initial value uses the visibility fallback",
		span("--gate:initial;visibility:var(--gate,hidden)"),
	],
	[
		"initial masks an inherited visible variable",
		span("--gate:visible", span("--gate:initial;visibility:var(--gate,hidden)")),
	],
	[
		"initial without fallback inherits hidden visibility",
		span("visibility:hidden", span("--gate:initial;visibility:var(--gate)")),
	],
	["initial value uses a zero font fallback", span("--size:initial;font-size:var(--size,0)")],
	[
		"parent hidden value is computed before a child override",
		span("--base:hidden;--gate:var(--base)", span("--base:visible;visibility:var(--gate)")),
	],
	[
		"parent missing reference stays invalid after a child defines it",
		span("--gate:var(--missing)", span("--missing:visible;visibility:var(--gate,hidden)")),
	],
	[
		"self-cycle uses the consumer fallback",
		span("--gate:var(--gate);visibility:var(--gate,hidden)"),
	],
	[
		"two-property cycle uses the consumer fallback",
		span("--one:var(--two);--two:var(--one);visibility:var(--one,hidden)"),
	],
	[
		"custom property names preserve case",
		span("--Gate:hidden;--gate:visible;visibility:var(--Gate)"),
	],
	[
		"a differently cased name does not define the requested variable",
		span("--Gate:visible;visibility:var(--gate,hidden)"),
	],
	[
		"valid empty value does not select a visible fallback",
		span("visibility:hidden", span("--gate:;visibility:var(--gate,visible)")),
	],
	[
		"empty fallback inherits hidden visibility",
		span("visibility:hidden", span("visibility:var(--missing,)")),
	],
	[
		"parent-child references are not a same-element cycle",
		span("--one:hidden", span("--two:var(--one)", span("--one:var(--two);visibility:var(--one)"))),
	],
	[
		"inherit keeps the parent variable",
		span("--gate:hidden", span("--gate:inherit;visibility:var(--gate)")),
	],
	[
		"unset keeps the parent variable",
		span("--gate:hidden", span("--gate:unset;visibility:var(--gate)")),
	],
	["missing variable uses a simple hidden fallback", span("visibility:var(--missing,hidden)")],
] as const;

it.each(hidden)("removes text and link when %s", (_label, html) => {
	const result = cleanHtml(`${html}<p>${tail}</p>`);
	expect(result.text).toBe(tail);
	expect(result.links).toEqual([]);
	expect(result.removals.hidden).toBe(canary.length + stylesheetUnits(html));
});

const visible = [
	[
		"generated inherit can recover visibility from the parent variable",
		span(
			"visibility:hidden;--gate:visible",
			span("--gate:var(--missing,inherit);visibility:var(--gate,hidden)"),
		),
	],
	[
		"generated unset can recover visibility from the parent variable",
		span(
			"visibility:hidden;--gate:visible",
			span("--gate:var(--missing,unset);visibility:var(--gate,hidden)"),
		),
	],
	[
		"generated revert ignores the earlier hidden author value",
		span(
			"--gate:visible",
			span("--gate:hidden;--gate:var(--missing,revert);visibility:var(--gate,hidden)"),
		),
	],
	["generated revert-layer selects a visible lower layer", layered("visible", "hidden")],
	[
		"initial variable selects a visible fallback",
		span("visibility:hidden", span("--gate:initial;visibility:var(--gate,visible)")),
	],
	[
		"initial font variable selects a nonzero fallback",
		span("font-size:0", span("--size:initial;font-size:var(--size,16px)")),
	],
	[
		"valid empty variable does not select a hidden fallback",
		span("--gate:;visibility:var(--gate,hidden)"),
	],
	[
		"missing variable with empty fallback inherits visible state",
		span("visibility:var(--missing,)"),
	],
	[
		"parent visible value is computed before a child override",
		span("--base:visible;--gate:var(--base)", span("--base:hidden;visibility:var(--gate)")),
	],
	[
		"parent-child references can recover inherited hidden visibility",
		span(
			"visibility:hidden;--one:visible",
			span("--two:var(--one)", span("--one:var(--two);visibility:var(--one)")),
		),
	],
	[
		"case-sensitive variable can select a visible value",
		span("--Gate:visible;--gate:hidden;visibility:var(--Gate)"),
	],
	[
		"ordinary substituted visibility keywords remain case-insensitive",
		span("--gate:VISIBLE;visibility:var(--gate)"),
	],
	[
		"unset custom variable inherits a visible parent value",
		span("--gate:visible", span("--gate:unset;visibility:var(--gate,hidden)")),
	],
] as const;

it.each(visible)("retains text and link when %s", (_label, html) => {
	const result = cleanHtml(`${html}<p>${tail}</p>`);
	expect(result.text).toContain(canary);
	expect(result.text).toContain("[link 1: canary.example]");
	expect(result.text).toContain(tail);
	expect(result.text).not.toContain("private-path");
	expect(result.links).toEqual([{ index: 1, host: "canary.example" }]);
	expect(result.removals.hidden).toBe(stylesheetUnits(html));
});
