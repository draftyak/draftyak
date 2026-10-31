import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

it.each([
	["CSS comment as legacy digits", "#ffffff", "/**/#ffffff", false],
	["legacy digits equal to the cell colour", "#000fff", "/**/#ffffff", true],
	["six-digit colour equal to the cell", "#ffffff", "#ffffff", true],
	["three-digit colour equal to the cell", "#ffffff", "#FFF", true],
	["digits without a number sign", "#ffffff", "ffffff", true],
	["single-digit components", "#0a0b0c", "abc", true],
	["single-digit components unlike the cell", "#ffffff", "fff", false],
	["ASCII case-insensitive keyword", "#ffffff", "WHITE", true],
	["functional notation as legacy digits", "#ffffff", "rgb(255,255,255)", false],
	["transparent as no colour", "#ffffff", "transparent", false],
])("parses %s in presentational colour attributes", (_label, background, foreground, hidden) => {
	const result = cleanHtml(
		`<table><tr><td bgcolor='${background}'><font color='${foreground}'>CANARY</font></td></tr></table>Visible`,
	);
	expect(result.text).toBe(hidden ? "Visible" : "CANARY\n\nVisible");
	expect(result.removals.hidden).toBe(hidden ? 6 : 0);
});
