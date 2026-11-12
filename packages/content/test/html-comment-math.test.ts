import { expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";

const cases = [
	["direct comment before minus", "font-size:calc(0px/**/- 1px)", false],
	["direct comments around minus", "font-size:calc(0px/**/-/**/1px)", false],
	["direct actual whitespace before minus", "font-size:calc(0px/**/ - 1px)", true],
	["direct actual whitespace around comments", "font-size:calc(0px /**/-/**/ 1px)", true],
	["direct escaped numeric identifier", String.raw`font-size:calc(\30 px - 1px)`, false],
	["unit escape terminator is not whitespace", String.raw`font-size:calc(0p\78 - 1px)`, false],
	["actual whitespace after unit escape", String.raw`font-size:calc(0p\78  - 1px)`, true],
	["simple unit escape", String.raw`font-size:calc(0p\x - 1px)`, true],
	["signed token cannot become sum", "font-size:calc(0px/**/+1px)", false],
	["separate unary delimiter is not a signed dimension", "font-size:calc(- 1px)", false],
	[
		"substitution does not create sum whitespace",
		"--op:-;font-size:calc(0px/**/var(--op)/**/1px)",
		false,
	],
	[
		"trimmed custom property supplies no sum whitespace",
		"--op: - ;font-size:calc(0px/**/var(--op)/**/1px)",
		false,
	],
	["substituted signed negative dimension", "--size:calc(-1px);font-size:var(--size)", true],
	["substituted negative literal remains invalid", "--size:-1px;font-size:var(--size)", false],
	[
		"dimension unit is not a percentage",
		String.raw`--size:calc(0\% - 1px);font-size:var(--size)`,
		false,
	],
	[
		"negative dimension unit is not a percentage",
		String.raw`--size:calc(-1\%);font-size:var(--size)`,
		false,
	],
	["native percentage calculation", "--size:calc(0% - 1px);font-size:var(--size)", true],
	["native negative percentage", "--size:calc(-1%);font-size:var(--size)", true],
] as const;

it.each(cases)("preserves %s in inline declarations", (_label, style, hidden) => {
	const result = cleanHtml(
		`<span style="font-size:16px"><a style="${style}" href="https://hidden.example/private">CANARY</a></span>Visible`,
	);
	expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
	expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
	expect(result.removals.hidden).toBe(hidden ? 6 : 0);
});

it.each(cases.slice(0, 8))("preserves %s in stylesheet declarations", (_label, style, hidden) => {
	const css = `.parent{font-size:16px}.child{${style}}`;
	const result = cleanHtml(
		`<style>${css}</style><span class=parent><a class=child href="https://hidden.example/private">CANARY</a></span>Visible`,
	);
	expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
	expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
	expect(result.removals.hidden).toBe(css.length + (hidden ? 6 : 0));
});

const declaredValues = [
	[
		"trimmed plus between comments",
		"font-size:0",
		"--op: + ;font-size:calc(1em/**/var(--op)/**/1px)",
		true,
	],
	[
		"trimmed operand before minus",
		"font-size:0",
		"--one: 1px ;font-size:calc(var(--one)- 0px)",
		true,
	],
	[
		"actual whitespace around a trimmed plus",
		"font-size:0",
		"--op: + ;font-size:calc(1em var(--op) 1px)",
		false,
	],
	[
		"actual whitespace after a trimmed operand",
		"font-size:0",
		"--one: 1px ;font-size:calc(var(--one) - 0px)",
		false,
	],
	[
		"trimmed minus under a visible parent",
		"font-size:16px",
		"--op: - ;font-size:calc(0px/**/var(--op)/**/1px)",
		false,
	],
	[
		"whitespace-only empty value",
		"visibility:hidden",
		"--gate: ;visibility:var(--gate,visible)",
		true,
	],
	[
		"whitespace and comment empty value",
		"visibility:hidden",
		"--gate: /**/ ;visibility:var(--gate,visible)",
		true,
	],
	[
		"whitespace-only value avoids hidden fallback",
		"",
		"--gate: ;visibility:var(--gate,hidden)",
		false,
	],
	[
		"comment and whitespace value avoids hidden fallback",
		"",
		"--gate:/**/ /**/;visibility:var(--gate,hidden)",
		false,
	],
] as const;

it.each(declaredValues)(
	"resolves the %s of a declared custom property",
	(_label, parent, style, hidden) => {
		const result = cleanHtml(
			`<span style="${parent}"><a style="${style}" href="https://hidden.example/private">CANARY</a></span>Visible`,
		);
		expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
		expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
		expect(result.removals.hidden).toBe(hidden ? 6 : 0);
	},
);

it.each(declaredValues)(
	"resolves the %s of a custom property declared in a stylesheet",
	(_label, parent, style, hidden) => {
		const css = `.parent{${parent}}.child{${style}}`;
		const result = cleanHtml(
			`<style>${css}</style><span class=parent><a class=child href="https://hidden.example/private">CANARY</a></span>Visible`,
		);
		expect(result.text).toBe(hidden ? "Visible" : "CANARY [link 1: hidden.example]Visible");
		expect(result.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
		expect(result.removals.hidden).toBe(css.length + (hidden ? 6 : 0));
	},
);
