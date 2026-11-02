import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { ContentError } from "../src/limits.ts";
import { flatStyles, nestedRuleHtml, nestedStyles } from "./html-nested-rules-fixtures.ts";

it.each(nestedStyles)("refuses unsupported %s without disclosing body text", (_label, css) => {
	expect(() => cleanHtml(nestedRuleHtml(css))).toThrowError(new ContentError("STRUCTURE_LIMIT"));
});

it.each(flatStyles)("preserves supported %s", (_label, css, hidden) => {
	const result = cleanHtml(nestedRuleHtml(css));
	expect(result.text).toBe(hidden ? "" : "DYTEST-CANARY [link 1: hidden.example]");
	expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
});
