import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { ContentError } from "../src/limits.ts";

const named = JSON.parse(
	readFileSync(new URL("./fixtures/html/named-colors.json", import.meta.url), "utf8"),
) as {
	colors: Record<string, string>;
};
const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/html/${name}.html`, import.meta.url), "utf8");

describe("reviewed static email CSS", () => {
	it.each([
		[
			"Outlook",
			"outlook",
			"Hi Jordan,\n\nThe revised estimate is ready.\n\nReview the estimate [link 1: files.example]\n\nThanks,\nCasey",
		],
		[
			"newsletter",
			"newsletter",
			"The weekly edit\n\nFresh ideas for your weekend.\n\nShop the sale now.\nBrowse the collection [link 1: shop.example]",
		],
		[
			"Gmail",
			"gmail",
			"Your reservation is confirmed.\n\nMeet at the north entrance at 18:30.\nView directions [link 1: venue.example]",
		],
	])("keeps exact visible %s fixture text", (_label, name, expected) => {
		const result = cleanHtml(fixture(name), { quotedHistoryChars: 0 });
		expect(result.text).toBe(expected);
		expect(JSON.stringify(result)).not.toMatch(/CANARY_PREHEADER|private|family\.css|hero\.jpg/);
	});

	it.each([
		{
			id: "link",
			selector: "a:link",
			input: "<a href='https://a.example'>CANARY</a><a>Keep</a>",
			expected: "Keep",
		},
		{
			id: "first-child",
			selector: "p:first-child",
			input: "<p>CANARY</p><p>Keep</p>",
			expected: "Keep",
		},
		{
			id: "last-child",
			selector: "p:last-child",
			input: "<p>Keep</p><p>CANARY</p>",
			expected: "Keep",
		},
		{
			id: "only-child",
			selector: "p:only-child",
			input: "<div><p>CANARY</p></div><p>Keep</p>",
			expected: "Keep",
		},
		{
			id: "first-of-type",
			selector: "p:first-of-type",
			input: "<b>Keep</b><p>CANARY</p>",
			expected: "Keep",
		},
		{
			id: "last-of-type",
			selector: "p:last-of-type",
			input: "<p>Keep</p><p>CANARY</p><b>After</b>",
			expected: "Keep\nAfter",
		},
		{
			id: "only-of-type",
			selector: "p:only-of-type",
			input: "<b>Keep</b><p>CANARY</p><b>After</b>",
			expected: "KeepAfter",
		},
		{
			id: "nth-child",
			selector: "p:nth-child(2n)",
			input: "<p>Keep</p><p>CANARY</p>",
			expected: "Keep",
		},
		{
			id: "nth-last-child",
			selector: "p:nth-last-child(1)",
			input: "<p>Keep</p><p>CANARY</p>",
			expected: "Keep",
		},
		{
			id: "nth-of-type",
			selector: "p:nth-of-type(2)",
			input: "<b>Before</b><p>Keep</p><p>CANARY</p>",
			expected: "Before\nKeep",
		},
		{
			id: "nth-last-of-type",
			selector: "p:nth-last-of-type(1)",
			input: "<p>Keep</p><p>CANARY</p><b>After</b>",
			expected: "Keep\nAfter",
		},
		{
			id: "adjacent-sibling",
			selector: "u + p",
			input: "<u>Keep</u><p>CANARY</p><p>After</p>",
			expected: "Keep\nAfter",
		},
		{
			id: "general-sibling",
			selector: "u ~ p",
			input: "<u>Keep</u><b>After</b><p>CANARY</p>",
			expected: "KeepAfter",
		},
		{
			id: "unsupported-pseudo-superset",
			selector: ".x:future-state(yes)",
			input: "<p class=x>CANARY</p><p>Keep</p>",
			expected: "Keep",
		},
		{
			id: "unsupported-nested-pseudo-superset",
			selector: ".x:not(:future-state)",
			input: "<p class=x>CANARY</p><p>Keep</p>",
			expected: "Keep",
		},
	])("models $id within the selector bounds", ({ selector, input, expected }) => {
		const result = cleanHtml(`<style>${selector}{display:none}</style><section>${input}</section>`);
		expect(result.text).toBe(expected);
		expect(result.text).not.toContain("CANARY");
		expect(result.removals.hidden).toBeGreaterThanOrEqual(6);
	});

	it.each(["hover", "focus", "focus-within", "focus-visible", "active", "visited"])(
		"skips dynamic :%s without broadening it to an unconditional rule",
		(state) => {
			expect(
				cleanHtml(
					`<style>a:${state}{color:white;display:none}</style><a href='https://a.example'>Visible</a>`,
				).text,
			).toBe("Visible [link 1: a.example]");
		},
	);
	it("still applies static members of a selector list containing dynamic members", () => {
		expect(
			cleanHtml("<style>p:hover,.x{display:none}</style><p>Keep</p><p class=x>CANARY</p>").text,
		).toBe("Keep");
	});
	it("skips imports and malformed declarations while retaining usable siblings", () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
			throw new Error("Unexpected fetch");
		});
		try {
			const result = cleanHtml(
				"<style>@import url(https://font.example/private);p{broken; color:windowtext}.x{opacity:0}</style><p>Keep</p><b class=x>CANARY</b>",
			);
			expect(result.text).toBe("Keep");
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
		}
	});
	it("retains a body after an unparseable rule instead of rejecting the message", () => {
		expect(cleanHtml("<style>??? {color:red} p{color:darkblue}</style><p>Keep</p>").text).toBe(
			"Keep",
		);
	});
	it.each([
		"display:none;display:potato",
		"font-size:0;font-size:banana",
		"font:0/0 a;font:14px",
		"color:white;color:potato",
		"color:black;background:black;background:potato",
		"opacity:0;opacity:banana",
		"transform:scale(0);transform:potato",
		"width:0;width:banana",
	])("discards grammar-invalid overriding declarations in %s", (style) => {
		const result = cleanHtml(`<span style='${style}'>CANARY</span>Keep`);
		expect(result.text).toBe("Keep");
		expect(result.removals.hidden).toBe(6);
	});
	it.each([
		"display:none;display:block",
		"font-size:0;font-size:14px",
		"font:0/0 a;font:14px serif",
		"color:white;color:black",
	])("keeps a valid visible overriding declaration in %s", (style) => {
		expect(cleanHtml(`<span style='${style}'>Visible</span>`).text).toBe("Visible");
	});
	it.each(["display:none;display:var(--missing)", "font-size:0;font-size:var(--missing)"])(
		"does not revive an earlier winner after computed-invalid %s",
		(style) => {
			expect(cleanHtml(`<span style='${style}'>Visible</span>`).text).toBe("Visible");
		},
	);
	it("does not count 300 ordinary inline table-cell styles toward the stylesheet cap", () => {
		const style =
			"padding:12px 16px;border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;line-height:20px;color:#252525;background-color:#ffffff;text-align:left;";
		expect(Buffer.byteLength(style.repeat(300))).toBeGreaterThan(32_768);
		const result = cleanHtml(
			`<table>${Array.from({ length: 300 }, (_, index) => `<tr><td style='${style}'>Cell ${index}</td></tr>`).join("")}</table>`,
		);
		expect(result.text.match(/Cell \d+/g)).toEqual(
			Array.from({ length: 300 }, (_, index) => `Cell ${index}`),
		);
	});
	it("keeps the stylesheet byte ceiling and its exact accepted neighbor", () => {
		expect(cleanHtml(`<style>${" ".repeat(32_768)}</style>Keep`).text).toBe("Keep");
		expect(() => cleanHtml(`<style>${" ".repeat(32_769)}</style>Keep`)).toThrow(ContentError);
	});
	it("bounds aggregate scenario work in addition to each CSS and DOM limit", () => {
		const conditions = Array.from(
			{ length: 127 },
			(_, index) => `@media (min-width:${index + 1}px){.only{color:red}}`,
		).join("");
		const rule = `.x{--padding:${"a".repeat(100)}}`;
		const body = `<b class=only>Only</b>${"<span class=x>Text</span>".repeat(200)}`;
		expect(() => cleanHtml(`<style>${rule}${conditions}</style>${body}`)).toThrow(ContentError);
	});
	it("bounds actual sibling-matcher work for structural selectors", () => {
		const body = "<span>Text</span>".repeat(2_100);
		expect(() =>
			cleanHtml(`<style>span:nth-last-child(1){color:red}</style><div>${body}</div>`),
		).toThrow(ContentError);
	});
});

describe("text-node colors and separate media branches", () => {
	it.each([
		"<td bgcolor='#000000'><font color='#ffffff'>Shop the sale now</font></td>",
		"<div style='background:#000'><span style='color:#fff'>Your code is 4417</span></div>",
		"<div style='background:#000;color:#fff'><div style='background:#fff;color:#000'>White card</div></div>",
		"<div style='color:transparent'><span style='color:black'>Visible child</span></div>",
		"<div style='color:white;background:white'><span style='color:hsl(0 0% 0%)'>Visible child</span></div>",
	])("retains contrasting child text in %s", (input) => {
		expect(cleanHtml(input).text).toMatch(
			/Shop the sale now|Your code is 4417|White card|Visible child/,
		);
		expect(cleanHtml(input).removals.hidden).toBe(0);
	});
	it("drops direct same-color text but permits a contrasting child and its link", () => {
		const result = cleanHtml(
			"<div style='background:black'>CANARY<span style='color:white'><a href='https://safe.example'>Visible</a></span></div>",
		);
		expect(result.text).toBe("Visible [link 1: safe.example]");
		expect(result.removals.hidden).toBe(6);
	});
	it("does not emit a marker or hostname from a same-color invisible anchor", () => {
		const result = cleanHtml(
			"<a style='color:white' href='https://hidden.example/private'>CANARY</a>Keep",
		);
		expect(result.text).toBe("Keep");
		expect(result.links).toEqual([]);
	});
	it.each(["rgba(255,255,255,.5)", "rgb(255 255 255 / 50%)", "#ffffff80", "#fff8"])(
		"keeps white text over a partially transparent %s background on black",
		(background) => {
			const result = cleanHtml(
				`<div style='background:black'><span style='background:${background};color:white'>Visible</span></div>`,
			);
			expect(result.text).toBe("Visible");
			expect(result.removals.hidden).toBe(0);
		},
	);
	it.each([
		{ id: "rgba transparent", background: "rgba(255,255,255,0)", expected: "Visible" },
		{ id: "rgba opaque", background: "rgba(255,255,255,1)", expected: "" },
		{ id: "percentage transparent", background: "rgb(255 255 255 / 0%)", expected: "Visible" },
		{ id: "percentage opaque", background: "rgb(255 255 255 / 100%)", expected: "" },
		{ id: "hex transparent", background: "#ffffff00", expected: "Visible" },
		{ id: "hex opaque", background: "#ffffffff", expected: "" },
		{ id: "short hex transparent", background: "#fff0", expected: "Visible" },
		{ id: "short hex opaque", background: "#ffff", expected: "" },
	])("preserves exact $id background behavior", ({ background, expected }) => {
		expect(
			cleanHtml(
				`<div style='background:black'><span style='background:${background};color:white'>Visible</span></div>`,
			).text,
		).toBe(expected);
	});
	it.each(["rgba(255,255,255,.5)", "rgb(255 255 255 / 50%)", "#ffffff80", "#fff8"])(
		"retains contrast for direct and inherited partial-alpha %s currentcolor",
		(foreground) => {
			for (const input of [
				`<div style='background:black'><span style='color:${foreground};background:currentcolor'>Visible</span></div>`,
				`<div style='background:black;color:${foreground}'><span style='background:currentcolor'>Visible</span></div>`,
			]) {
				const result = cleanHtml(input);
				expect(result.text).toBe("Visible");
				expect(result.removals.hidden).toBe(0);
			}
		},
	);
	it.each(["rgba(255,255,255,1)", "rgb(255 255 255 / 100%)", "#ffffffff", "#ffff"])(
		"still removes direct and inherited opaque %s currentcolor equality",
		(foreground) => {
			for (const input of [
				`<div style='background:black'><span style='color:${foreground};background:currentcolor'>CANARY</span></div>Keep`,
				`<div style='background:black;color:${foreground}'><span style='background:currentcolor'>CANARY</span></div>Keep`,
			])
				expect(cleanHtml(input).text).toBe("Keep");
		},
	);
	it("keeps a transparent currentcolor background on the actual underlying white", () => {
		expect(
			cleanHtml(
				"<span style='color:transparent;background:currentcolor;-webkit-text-fill-color:white'>CANARY</span>Keep",
			).text,
		).toBe("Keep");
	});
	it("resolves currentcolor independently of the text fill override", () => {
		expect(
			cleanHtml(
				"<span style='color:black;-webkit-text-fill-color:white;background:currentcolor'>Visible</span>",
			).text,
		).toBe("Visible");
	});
	it("inherits an explicit text fill independently of child color", () => {
		expect(
			cleanHtml(
				"<div style='-webkit-text-fill-color:white'><span style='color:black;background:currentcolor'>Visible</span></div>",
			).text,
		).toBe("Visible");
	});
	it("lets an inherited default currentcolor fill follow the child color", () => {
		expect(
			cleanHtml(
				"<div style='color:white'><span style='color:black;background:black'>CANARY</span></div>Keep",
			).text,
		).toBe("Keep");
	});
	it("keeps a dark-mode recoloring that is visible in the base condition", () => {
		expect(
			cleanHtml(
				"<style>@media (prefers-color-scheme:dark){.t{color:#fff}}</style><p class=t>Visible</p>",
			).text,
		).toBe("Visible");
	});
	it("includes unconditional backgrounds in each conditional evaluation", () => {
		expect(
			cleanHtml(
				"<style>.t{color:black;background:black}@media (prefers-color-scheme:dark){.t{color:white}}</style><p class=t>Visible</p>",
			).text,
		).toBe("Visible");
	});
	it("combines repeated normalized conditions before deciding visibility", () => {
		const result = cleanHtml(
			"<style>.t{color:black;background:black}@media (prefers-color-scheme:dark){.t{color:white}}</style><style>@media (prefers-color-scheme: dark){.t{background:white}}</style><p class=t>CANARY</p>",
		);
		expect(result.text).toBe("");
	});
	it("does not pool unrelated conditional foreground and background rules", () => {
		expect(
			cleanHtml(
				"<style>.t{color:black;background:black}@media (prefers-color-scheme:dark){.t{color:white}}@media (max-width:600px){.t{background:white}}</style><p class=t>Visible</p>",
			).text,
		).toBe("Visible");
	});
	it("includes enclosing conditions in a nested media branch", () => {
		expect(
			cleanHtml(
				"<style>.t{color:white;background:white}@media (prefers-color-scheme:dark){.t{color:black;background:black}@media (max-width:600px){.t{background:white}}}</style><p class=t>Visible</p>",
			).text,
		).toBe("Visible");
	});
	it("models screen and all as unconditional while ignoring print-only styles", () => {
		expect(
			cleanHtml(
				"<style>@media screen{.x{font:0/0 a}}@media all{.y{display:none}}@media print{.z{display:none}}</style><b class=x>CANARY</b><b class=y>CANARY</b><b class=z>Keep</b>",
			).text,
		).toBe("Keep");
	});
	it.each([
		{ id: "ID specificity", css: "#x{color:black}.t{color:white}", attributes: "id=x class=t" },
		{ id: "inline specificity", css: ".t{color:white}", attributes: "class=t style='color:black'" },
		{ id: "source order", css: ".t{color:white}.t{color:black}", attributes: "class=t" },
		{ id: "unknown winning color", css: ".t{color:white;color:windowtext}", attributes: "class=t" },
		{
			id: "stylesheet over presentational attribute",
			css: ".t{color:black}",
			attributes: "class=t color=white",
		},
	])("compares the winning $id value instead of pooling alternatives", ({ css, attributes }) => {
		expect(cleanHtml(`<style>${css}</style><font ${attributes}>Keep</font>`).text).toBe("Keep");
	});
	it("honors important color over inline and ID declarations", () => {
		expect(
			cleanHtml(
				"<style>#x{color:black}.t{color:white!important}</style><p id=x class=t style='color:black'>CANARY</p>",
			).text,
		).toBe("");
	});
	it.each(
		"ActiveBorder ActiveCaption AppWorkspace Background ButtonHighlight ButtonShadow CaptionText InactiveBorder InactiveCaption InactiveCaptionText InfoBackground InfoText Menu MenuText Scrollbar ThreeDDarkShadow ThreeDFace ThreeDHighlight ThreeDLightShadow ThreeDShadow Window WindowFrame WindowText".split(
			" ",
		),
	)("keeps the required legacy system color %s as an unknown cascade winner", (system) => {
		expect(cleanHtml(`<span style='color:white;color:${system}'>Visible</span>`).text).toBe(
			"Visible",
		);
		expect(
			cleanHtml(`<span style='color:black;background:black;background:${system}'>Visible</span>`)
				.text,
		).toBe("Visible");
		expect(
			cleanHtml(
				`<span style='-webkit-text-fill-color:white;-webkit-text-fill-color:${system}'>Visible</span>`,
			).text,
		).toBe("Visible");
	});
	it.each([
		"color:white;color:WindowText potato",
		"color:black;background:black;background:WindowText potato",
		"-webkit-text-fill-color:white;-webkit-text-fill-color:WindowText potato",
	])("still rejects invalid system-color combinations in %s before cascading", (style) => {
		expect(cleanHtml(`<span style='${style}'>CANARY</span>Keep`).text).toBe("Keep");
	});
	it.each(Object.entries(named.colors))("resolves normative named color %s", (name, hex) => {
		const opposite = (0xffffff ^ Number.parseInt(hex, 16)).toString(16).padStart(6, "0");
		expect(cleanHtml(`<span style='color:${name};background:#${hex}'>CANARY</span>`).text).toBe("");
		expect(
			cleanHtml(`<font color='${name}' style='background:#${opposite}'>Visible</font>`).text,
		).toBe("Visible");
	});
	it.each([
		"color:windowtext",
		"color:darkgreen",
		"color:hsl(0 0% 100%);background:white",
		"background:url(hero.jpg) center / cover no-repeat",
		"color:white;background:url(hero.jpg) center / cover no-repeat",
		"width:calc(100% - 40px)",
		"opacity:var(--unresolved)",
		"height:env(safe-area-inset-top)",
		"transform:rotate(0deg)",
		"transform:translateX(10px)",
		"transform:scale(1)",
		"transform:scale3d(1,1,0)",
		"--a:var(--b);--b:var(--a);font-size:var(--a)",
		"--X:0;font-size:var(--x)",
		"width:1px - 1px",
		"width:calc(1px-1px)",
		"width:calc(1px) - (1px)",
		`--large:${"x".repeat(5_000)};font-size:var(--large)`,
		"color:rgb(255x,255x,255x)",
		"color:rgba(255,255,255,2px)",
		"color:rgb(255,255 255)",
	])("does not classify unknown or non-hiding %s as hidden", (style) => {
		const result = cleanHtml(`<span style='${style}'>Visible</span>`);
		expect(result.text).toBe("Visible");
		expect(result.removals.hidden).toBe(0);
	});
	it.each([
		"font-size:calc(1px - 1px)",
		"opacity:calc(1 - 1)",
		"height:calc(0px * 2)",
		"--size:0;font-size:var(--size)",
		"font-size:var(--missing,0)",
		"transform:scale(0)",
		"transform:scaleX(0)",
		"transform:scale3d(0,1,1)",
	])("removes text when bounded %s resolves to zero", (style) => {
		expect(cleanHtml(`<span style='${style}'>CANARY</span>Keep`).text).toBe("Keep");
	});
	it("resolves an inherited custom variable without leaking it to a sibling", () => {
		expect(
			cleanHtml(
				"<div style='--size:0'><b style='font-size:var(--size)'>CANARY</b></div><b style='font-size:var(--size)'>Keep</b>",
			).text,
		).toBe("Keep");
	});
});
