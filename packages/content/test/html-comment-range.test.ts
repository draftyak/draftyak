import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

const hidden = [
	["zero percentage parent", "font-size:0", "font-size:calc(100% - 1px)"],
	["zero em parent", "font-size:0", "font-size:calc(1em - 1px)"],
	["zero shorthand parent", "font-size:0", "font:calc(1em - 1px)/1 serif"],
	["absolute calculated range", "font-size:16px", "font-size:calc(0px - 1px)"],
	["nested calculation", "font-size:0", "font-size:calc((50% + 50%) - 1px)"],
	["calculated percentage", "font-size:0", "font-size:calc(-1%)"],
	[
		"comment-only empty value",
		"visibility:hidden",
		"--gate:/*var(--gate)*/;visibility:var(--gate,visible)",
	],
	["comment before hidden", "", "--gate:/*var(--gate)*/hidden;visibility:var(--gate,visible)"],
	[
		"commented other dependency",
		"",
		"--one:/*var(--two)*/hidden;--two:var(--one);visibility:var(--two,visible)",
	],
	[
		"commented fallback edge",
		"",
		"--one:hidden;--two:var(--one,/*var(--two)*/visible);visibility:var(--two,visible)",
	],
	[
		"comment parentheses",
		"",
		"--gate:var(--missing,/* ) , var(--gate) */hidden);visibility:var(--gate,visible)",
	],
	["real self cycle", "", "--gate:var(--gate);visibility:var(--gate,hidden)"],
	[
		"unused fallback self reference",
		"",
		"--one:hidden;--two:var(--one,var(--two));visibility:var(--two,hidden)",
	],
] as const;

const visible = [
	["positive percentage calculation", "font-size:0", "font-size:calc(100% + 1px)"],
	["positive shorthand calculation", "font-size:0", "font:calc(1em + 1px)/1 serif"],
	["invalid negative literal", "font-size:16px", "font-size:-1px"],
	["invalid negative shorthand", "font-size:16px", "font:-1px/1 serif"],
	["invalid dimensionless calculation", "font-size:16px", "font-size:calc(0 - 1)"],
	["positive root-relative calculation", "font-size:0", "font-size:calc(1rem + 0px)"],
	[
		"comment-only value avoids hidden fallback",
		"",
		"--gate:/*var(--gate)*/;visibility:var(--gate,hidden)",
	],
	[
		"comment before visible",
		"visibility:hidden",
		"--gate:/*var(--gate)*/visible;visibility:var(--gate,hidden)",
	],
	[
		"real cycle selects visible fallback",
		"visibility:hidden",
		"--gate:var(--gate);visibility:var(--gate,visible)",
	],
	["comment separates identifier tokens", "", "--gate:hid/**/den;visibility:var(--gate,hidden)"],
	[
		"comment cannot manufacture a function",
		"",
		"--gate:var/**/(--missing,hidden);visibility:var(--gate,hidden)",
	],
] as const;

function admission(cases: readonly (readonly [string, string, string])[], removed: boolean): void {
	it.each(cases)("resolves %s before text and anchor admission", (_label, parent, child) => {
		const result = cleanHtml(
			`<span style='${parent}'><a style='${child}' href='https://hidden.example/private'>CANARY</a></span>Visible`,
		);
		expect(result.text).toBe(removed ? "Visible" : "CANARY [link 1: hidden.example]Visible");
		expect(result.links).toEqual(removed ? [] : [{ index: 1, host: "hidden.example" }]);
		expect(result.removals.hidden).toBe(removed ? 6 : 0);
	});
}

admission(hidden, true);
admission(visible, false);
