import { beforeAll, expect, it } from "vitest";
import type { ParsedMail } from "../src/mail.ts";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";

const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const firstId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const secondId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const canary = "DYTEST-CANARY";
const evidence = { provider: "gmail", ownerAddresses: ["Owner@example.test"] } as const;
const kelvin = String.fromCodePoint(0x212a);

function mail(body: string, html: boolean): Buffer {
	return Buffer.from(
		[
			"From: Sender@example.test",
			"To: Owner@example.test",
			"Subject: Synthetic CSS readings",
			"Authentication-Results: mx.google.com; dmarc=fail header.from=example.test",
			"MIME-Version: 1.0",
			`Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
			"Content-Transfer-Encoding: 8bit",
			"",
			body,
		].join("\r\n"),
	);
}

let previous: ParsedMail;
beforeAll(async () => {
	previous = await parseMailInWorker(mail("Earlier synthetic message.", false), evidence);
	expect(previous.body.text).toBe("Earlier synthetic message.");
	expect(previous.direction).toBe("inbound");
});

const attribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const hiddenLink = `<a class="c" href="https://hidden.example/DYTEST-private?discard=1">${canary}</a>`;
const visibleLink = '<a href="https://visible.example/DYTEST-private?discard=1">Visible</a>';

async function thread(source: string): Promise<{ parsed: ParsedMail; prompt: string }> {
	const parsed = await parseMailInWorker(mail(source, true), evidence);
	const prepared = buildDraftRequest({
		model: "synthetic-model",
		conversationId,
		messages: [
			{
				id: firstId,
				conversationId,
				body: previous.body,
				direction: previous.direction,
				dmarc: previous.auth.dmarc,
			},
			{
				id: secondId,
				conversationId,
				body: parsed.body,
				direction: parsed.direction,
				dmarc: parsed.auth.dmarc,
			},
		],
	});
	expect(parsed.direction).toBe("inbound");
	expect(prepared.includedMessages).toBe(2);
	expect(prepared.omittedMessages).toBe(0);
	expect(prepared.request.prompt).not.toMatch(/https?:|DYTEST-private|discard=1/);
	return { parsed, prompt: prepared.request.prompt };
}

async function assertAdmission(source: string, hidden: boolean, stylesheet: number): Promise<void> {
	const { parsed, prompt } = await thread(source);
	const expected = hidden
		? "Visible [link 1: visible.example]"
		: `${canary} [link 1: hidden.example] Visible [link 2: visible.example]`;
	expect(parsed.bodyRefusal).toBeUndefined();
	expect(parsed.body.text).toBe(expected);
	expect(parsed.body.links).toEqual(
		hidden
			? [{ index: 1, host: "visible.example" }]
			: [
					{ index: 1, host: "hidden.example" },
					{ index: 2, host: "visible.example" },
				],
	);
	expect(parsed.body.removals.hidden).toBe(stylesheet + (hidden ? canary.length : 0));
	expect(JSON.parse(prompt.split("\n")[2] ?? "null")).toEqual([
		{ id: firstId, direction: "inbound", dmarc: "fail", text: "Earlier synthetic message." },
		{ id: secondId, direction: "inbound", dmarc: "fail", text: expected },
	]);
	expect(prompt.includes(canary)).toBe(!hidden);
	expect(prompt.includes("hidden.example")).toBe(!hidden);
	expect(prompt).toContain("visible.example");
}

async function assertRefusal(source: string): Promise<void> {
	const { parsed, prompt } = await thread(source);
	expect(parsed.bodyRefusal).toBe("STRUCTURE_LIMIT");
	expect(parsed.body.text).toBe("");
	expect(parsed.body.links).toEqual([]);
	expect(JSON.parse(prompt.split("\n")[2] ?? "null")).toEqual([
		{ id: firstId, direction: "inbound", dmarc: "fail", text: "Earlier synthetic message." },
		{ id: secondId, direction: "inbound", dmarc: "fail", text: "" },
	]);
	expect(prompt).not.toContain(canary);
	expect(prompt).not.toMatch(/hidden\.example|visible\.example/);
}

interface Case {
	readonly label: string;
	readonly parent: string;
	readonly child: string;
	readonly hidden: boolean;
}

const source = ({ parent, child }: Case, stylesheet: boolean): string => {
	const target = stylesheet
		? hiddenLink
		: hiddenLink.replace('class="c"', `style="${attribute(child)}"`);
	return `${stylesheet ? `<style>.c{${child}}</style>` : ""}<span style="${attribute(parent)}">${target}</span> ${visibleLink}`;
};

const values: readonly Case[] = [
	{
		label: "unused self-referencing fallback after a hidden value",
		parent: "",
		child: "--known:hidden;--gate:var(--known,var(--gate));visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "unused self-referencing fallback after a none display",
		parent: "",
		child: "--known:none;--gate:var(--known,var(--gate));display:var(--gate,inline)",
		hidden: true,
	},
	{
		label: "unused self-referencing fallback after a zero size",
		parent: "font-size:16px",
		child: "--known:0px;--gate:var(--known,var(--gate));font-size:var(--gate,16px)",
		hidden: true,
	},
	{
		label: "unused self-referencing fallback after a visible value",
		parent: "",
		child: "--base:visible;--gate:var(--base,var(--gate));visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "real two-property cycle under a hidden parent",
		parent: "visibility:hidden",
		child: "--a:var(--b);--b:var(--a);visibility:var(--a,visible)",
		hidden: false,
	},
	{
		label: "invalid reference before a hidden fallback",
		parent: "",
		child: "--gate:var(foo);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "unnamed environment value over a hidden display",
		parent: "",
		child: "display:none;display:env()",
		hidden: true,
	},
	{
		label: "unnamed attribute over a hidden display",
		parent: "",
		child: "display:none;display:attr()",
		hidden: true,
	},
	{
		label: "numeric environment name over a hidden custom property",
		parent: "",
		child: "--gate:hidden;--gate:env(1);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "invalid reference over a hidden display",
		parent: "",
		child: "display:none;display:var(foo)",
		hidden: true,
	},
	{
		label: "unknown environment name over a hidden display",
		parent: "",
		child: "display:none;display:env(x)",
		hidden: false,
	},
	{
		label: "empty reference before a visible fallback under a hidden parent",
		parent: "visibility:hidden",
		child: "--gate:var();visibility:var(--gate,visible)",
		hidden: false,
	},
	{
		label: "missing reference under a white fill",
		parent: "-webkit-text-fill-color:#fff",
		child: "-webkit-text-fill-color:var(--missing)",
		hidden: true,
	},
	{
		label: "unknown keyword under a white fill",
		parent: "-webkit-text-fill-color:#fff",
		child: "--f:notacolor;-webkit-text-fill-color:var(--f)",
		hidden: true,
	},
	{
		label: "missing reference under a transparent fill",
		parent: "-webkit-text-fill-color:transparent",
		child: "-webkit-text-fill-color:var(--missing)",
		hidden: true,
	},
	{
		label: "substituted black under a white fill",
		parent: "-webkit-text-fill-color:#fff",
		child: "--f:#000;-webkit-text-fill-color:var(--f)",
		hidden: false,
	},
	{
		label: "escaped Kelvin sign in a substituted colour",
		parent: "color:#fff",
		child: String.raw`--c:blac\212A ;color:var(--c)`,
		hidden: true,
	},
	{
		label: "Kelvin sign in a fill property name",
		parent: "-webkit-text-fill-color:#fff",
		child: `-web${kelvin}it-text-fill-color:#000`,
		hidden: true,
	},
	{
		label: "escaped Kelvin sign in a background property name",
		parent: "",
		child: String.raw`color:#fff;bac\212A ground-color:#000`,
		hidden: true,
	},
	{
		label: "uppercase substituted colour",
		parent: "color:#fff",
		child: "--c:BLACK;color:var(--c)",
		hidden: false,
	},
];

it.each(values)("reads the $label in a style attribute through the parsing thread", (value) =>
	assertAdmission(source(value, false), value.hidden, 0),
);

it.each(values)("reads the $label in a style rule through the parsing thread", (value) =>
	assertAdmission(source(value, true), value.hidden, `.c{${value.child}}`.length),
);

const selectors: readonly { label: string; css: string; wrapper?: string; hidden: boolean }[] = [
	{
		label: "escaped Kelvin sign in a link pseudo-class",
		css: String.raw`a.c{display:none} a.c:lin\212A {display:inline}`,
		hidden: true,
	},
	{
		label: "unknown pseudo-class",
		css: "a.c{display:none} a.c:xyz{display:inline}",
		hidden: true,
	},
	{
		label: "unknown pseudo-class with a colour",
		css: "a.c{color:#fff} a.c:xyz{color:#000}",
		hidden: true,
	},
	{
		label: "pseudo-element reveal",
		css: "a.c{display:none} a.c::before{display:inline}",
		hidden: true,
	},
	{
		label: "unknown pseudo-class in a selector list",
		css: "a.c{display:none} span .c, a.c:xyz{display:inline}",
		hidden: true,
	},
	{
		label: "escaped Kelvin sign in a type selector",
		css: String.raw`a.c{color:#fff} \212A bd a.c{color:#000}`,
		wrapper: "kbd",
		hidden: true,
	},
	{
		label: "link pseudo-class reveal",
		css: "a.c{display:none} a.c:link{display:inline}",
		hidden: false,
	},
	{
		label: "hidden pseudo-element box",
		css: "a.c::before{display:none}",
		hidden: false,
	},
	{
		label: "type selector colour",
		css: "a.c{color:#fff} kbd a.c{color:#000}",
		wrapper: "kbd",
		hidden: false,
	},
];

it.each(selectors)(
	"reads the $label through the parsing thread",
	({ css, wrapper = "span", hidden }) =>
		assertAdmission(
			`<style>${css}</style><${wrapper}>${hiddenLink}</${wrapper}> ${visibleLink}`,
			hidden,
			css.length,
		),
);

const families = (count: number): string =>
	Array.from({ length: count }, (_, index) => `f${index}`).join(",");
const layers = (count: number): string => `${"none,".repeat(count)}#000`;
const nested = (value: string, levels: number): string =>
	`${"calc(".repeat(levels)}${value}${")".repeat(levels)}`;
const chain = (seed: string, steps: readonly number[]): string =>
	`--a0:${seed};${steps.map((levels, index) => `--a${index + 1}:${nested(`var(--a${index})`, levels)}`).join(";")};font-size:var(--a${steps.length})`;

const refusals: readonly Case[] = [
	{ label: "font with 258 families", parent: "", child: `font:0 ${families(258)}`, hidden: true },
	{
		label: "substituted font with 258 families",
		parent: "",
		child: `--f:0 ${families(258)};font:var(--f)`,
		hidden: true,
	},
	{
		label: "nonzero font with 259 families after a zero size",
		parent: "font-size:16px",
		child: `font-size:0;font:16px ${families(259)}`,
		hidden: false,
	},
	{
		label: "substituted background with 31 layers",
		parent: "",
		child: `color:#000;--b:${layers(31)};background:var(--b)`,
		hidden: true,
	},
	{
		label: "substituted calculation 33 levels deep under a zero size",
		parent: "font-size:0",
		child: `--a0:16px;--a1:${nested("var(--a0)", 30)};font-size:${nested("var(--a1)", 3)}`,
		hidden: true,
	},
	{
		label: "chain 102 levels deep under a zero size",
		parent: "font-size:0",
		child: chain("16px", [25, 25, 25, 25, 2]),
		hidden: true,
	},
	{
		label: "chain 102 levels deep under a 16px size",
		parent: "font-size:16px",
		child: chain("0px", [25, 25, 25, 25, 2]),
		hidden: false,
	},
];

it.each(refusals)("refuses the body with a $label through the parsing thread", async (value) => {
	await assertRefusal(source(value, false));
	await assertRefusal(source(value, true));
});

const accepted: readonly Case[] = [
	{ label: "font with 257 families", parent: "", child: `font:0 ${families(257)}`, hidden: true },
	{
		label: "nonzero font with 258 families after a zero size",
		parent: "font-size:16px",
		child: `font-size:0;font:16px ${families(258)}`,
		hidden: false,
	},
	{
		label: "background with 30 layers",
		parent: "",
		child: `color:#000;background:${layers(30)}`,
		hidden: true,
	},
	{
		label: "substituted calculation 32 levels deep",
		parent: "font-size:16px",
		child: `--a0:0px;--a1:${nested("var(--a0)", 30)};font-size:${nested("var(--a1)", 2)}`,
		hidden: true,
	},
	{
		label: "substituted calculation 32 levels deep under a zero size",
		parent: "font-size:0",
		child: `--a0:16px;--a1:${nested("var(--a0)", 30)};font-size:${nested("var(--a1)", 2)}`,
		hidden: false,
	},
];

it.each(accepted)("reads a $label within the limit through the parsing thread", async (value) => {
	await assertAdmission(source(value, false), value.hidden, 0);
	await assertAdmission(source(value, true), value.hidden, `.c{${value.child}}`.length);
});
