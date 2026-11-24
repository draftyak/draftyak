import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { elementCases, visibleTail } from "./fixtures/html-element-cases.ts";

it.each(elementCases)("models $label", ({ source, hidden }) => {
	const result = cleanHtml(source + visibleTail);
	expect(result.text).toContain("Visible");
	expect(result.text.includes("DYTEST-CANARY")).toBe(!hidden);
	expect(result.text).not.toContain("DYTEST-REMOVED");
	if (hidden) {
		expect(result.links).toEqual([]);
		expect(result.text).not.toContain("hidden.example");
	} else if (source.includes("href=")) {
		expect(result.links).toEqual([{ index: 1, host: "hidden.example" }]);
		expect(result.text).toContain("[link 1: hidden.example]");
	}
});

it.each([
	'<a href="https://hidden.example/private"></a>',
	'<a href="https://hidden.example/private"><span hidden></span></a>',
	'<a href="https://hidden.example/private"><img src="https://tracker.example/private"></a>',
	'<a href="https://hidden.example/private"> <span hidden>DYTEST-CANARY</span> </a>',
	'<a href="https://hidden.example/private">\u200b<span hidden>DYTEST-CANARY</span></a>',
	'<a href="https://hidden.example/private">\u0001<span hidden>DYTEST-CANARY</span></a>',
])("does not emit a link without supported rendered content: %s", (source) => {
	const result = cleanHtml(source + visibleTail);
	expect(result.text).toBe("Visible");
	expect(result.links).toEqual([]);
});
