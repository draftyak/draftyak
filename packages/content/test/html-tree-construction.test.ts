import { defaultTreeAdapter } from "parse5";
import { afterEach, expect, it, vi } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { cases } from "./html-tree-construction-cases.ts";

afterEach(() => vi.restoreAllMocks());

it.each(cases)("uses the browser tree for $label", ({ body, hidden }) => {
	const result = cleanHtml(body);
	expect(result.text).toBe(hidden ? "" : "CANARY [link 1: hidden.example]");
	expect(result.links).toHaveLength(hidden ? 0 : 1);
});

it("bounds all parser allocations including comments", () => {
	expect(cleanHtml("<!---->".repeat(19_997)).text).toBe("");
	expect(() => cleanHtml("<!---->".repeat(19_998))).toThrowError("structure limit");
});

it("refuses node overflow before allocating the excess element", () => {
	const create = vi.spyOn(defaultTreeAdapter, "createElement");
	expect(() => cleanHtml("<br>".repeat(20_010))).toThrowError("structure limit");
	expect(create.mock.calls.length).toBeLessThanOrEqual(20_000);
});

it("refuses excessive depth before inserting the over-depth child", () => {
	const append = defaultTreeAdapter.appendChild;
	let maximum = 0;
	vi.spyOn(defaultTreeAdapter, "appendChild").mockImplementation((parent, child) => {
		let depth = 1;
		let current = parent;
		while ("parentNode" in current && current.parentNode) {
			depth++;
			current = current.parentNode;
		}
		maximum = Math.max(maximum, depth);
		append(parent, child);
	});
	expect(() => cleanHtml(`${"<div>".repeat(126)}CANARY${"</div>".repeat(126)}`)).toThrowError(
		"structure limit",
	);
	expect(maximum).toBeLessThanOrEqual(128);
});

it("bounds reconstructed tree depth before rendering", () => {
	expect(cleanHtml(`${"<div>".repeat(125)}Visible${"</div>".repeat(125)}`).text).toBe("Visible");
	expect(() => cleanHtml(`${"<div>".repeat(126)}CANARY${"</div>".repeat(126)}`)).toThrowError(
		"structure limit",
	);
});

it("bounds attributes created by late body tokens", () => {
	const attributes = Array.from({ length: 128 }, (_, i) => `data-x${i}="x"`).join(" ");
	expect(cleanHtml(`<body ${attributes}>Visible<body data-x0="ignored">`).text).toBe("Visible");
	expect(() => cleanHtml(`<body ${attributes}>CANARY<body data-overflow="x">`)).toThrowError(
		"structure limit",
	);
	expect(() => cleanHtml(`<div ${attributes} data-overflow="x">CANARY</div>`)).toThrowError(
		"structure limit",
	);
});

it("refuses excess attributes before element creation and late adoption", () => {
	const create = vi.spyOn(defaultTreeAdapter, "createElement");
	const adopt = vi.spyOn(defaultTreeAdapter, "adoptAttributes");
	const attributes = Array.from({ length: 128 }, (_, i) => `data-x${i}="x"`).join(" ");
	expect(() => cleanHtml(`<div ${attributes} data-overflow="x">CANARY</div>`)).toThrowError(
		"structure limit",
	);
	expect(create.mock.calls.every((call) => call[2].length <= 128)).toBe(true);
	expect(() => cleanHtml(`<body ${attributes}>CANARY<body data-overflow="x">`)).toThrowError(
		"structure limit",
	);
	expect(adopt).not.toHaveBeenCalled();
});

it("bounds inert template content while parsing", () => {
	expect(cleanHtml("<template><p>CANARY</p></template>Visible").text).toBe("Visible");
	expect(() =>
		cleanHtml(`${"<template>".repeat(65)}CANARY${"</template>".repeat(65)}`),
	).toThrowError("structure limit");
});
