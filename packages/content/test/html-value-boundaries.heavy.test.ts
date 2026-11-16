import { beforeAll, expect, it } from "vitest";
import type { ParsedMail } from "../src/mail.ts";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";

const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const firstId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const secondId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const canary = "DYTEST-CANARY";
const evidence = { provider: "gmail", ownerAddresses: ["Owner@example.test"] } as const;

function mail(body: string, html: boolean): Buffer {
	return Buffer.from(
		[
			"From: Sender@example.test",
			"To: Owner@example.test",
			"Subject: Synthetic declaration boundaries",
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

interface Case {
	readonly label: string;
	readonly parent: string;
	readonly child: string;
	readonly hidden: boolean;
}

async function assertThread({ parent, child, hidden }: Case, stylesheet: boolean): Promise<void> {
	const css = stylesheet ? `.c{${child}` : "";
	const target = stylesheet ? "class='c'" : `style='${child}'`;
	const source = `${stylesheet ? `<style>${css}</style>` : ""}<span style='${parent}'><a ${target} href='https://hidden.example/DYTEST-private?discard=1'>${canary}</a></span> <a href='https://visible.example/DYTEST-private?discard=1'>Visible</a>`;
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
	expect(parsed.body.removals.hidden).toBe(css.length + (hidden ? canary.length : 0));
	expect(parsed.direction).toBe("inbound");
	expect(JSON.parse(prepared.request.prompt.split("\n")[2] ?? "null")).toEqual([
		{ id: firstId, direction: "inbound", dmarc: "fail", text: "Earlier synthetic message." },
		{ id: secondId, direction: "inbound", dmarc: "fail", text: expected },
	]);
	expect(prepared.request.prompt.includes(canary)).toBe(!hidden);
	expect(prepared.request.prompt.includes("hidden.example")).toBe(!hidden);
	expect(prepared.request.prompt).toContain("visible.example");
	expect(prepared.request.prompt).not.toMatch(/https?:|DYTEST-private|discard=1/);
	expect(prepared.includedMessages).toBe(2);
	expect(prepared.omittedMessages).toBe(0);
}

const endOfInput: readonly Case[] = [
	{
		label: "open var() fallback",
		parent: "font-size:16px",
		child: "display:var(--x,none",
		hidden: true,
	},
	{
		label: "open calculation",
		parent: "font-size:16px",
		child: "font-size:calc(0px",
		hidden: true,
	},
	{
		label: "open opacity calculation",
		parent: "font-size:16px",
		child: "opacity:calc(0",
		hidden: true,
	},
	{
		label: "open var() reference",
		parent: "font-size:16px",
		child: "--v:hidden;visibility:var(--v",
		hidden: true,
	},
	{
		label: "open var() after an earlier size",
		parent: "font-size:16px",
		child: "font-size:16px;--z:0px;font-size:var(--z",
		hidden: true,
	},
	{
		label: "open nested parenthesis",
		parent: "font-size:16px",
		child: "font-size:calc((0px",
		hidden: true,
	},
	{
		label: "open comment after a fallback",
		parent: "font-size:16px",
		child: "display:var(--x,none/* x",
		hidden: true,
	},
	{
		label: "open fallback over hidden display",
		parent: "",
		child: "display:none;display:var(--x,inline",
		hidden: false,
	},
	{
		label: "open calculation over a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(1px",
		hidden: false,
	},
	{
		label: "open opacity over zero opacity",
		parent: "",
		child: "opacity:0;opacity:calc(1",
		hidden: false,
	},
	{
		label: "open var() over hidden visibility",
		parent: "visibility:hidden",
		child: "--v:visible;visibility:var(--v",
		hidden: false,
	},
	{
		label: "open var() over a zero size",
		parent: "font-size:16px",
		child: "font-size:0;--z:16px;font-size:var(--z",
		hidden: false,
	},
	{
		label: "open nested parenthesis over a zero parent",
		parent: "font-size:0",
		child: "font-size:calc((1px",
		hidden: false,
	},
];

it.each(endOfInput)("closes the $label at the end of a style attribute", (value) =>
	assertThread(value, false),
);

it.each(endOfInput)("closes the $label at the end of a style element", (value) =>
	assertThread(value, true),
);

const declaredValues: readonly Case[] = [
	{
		label: "trimmed plus between comments",
		parent: "font-size:0",
		child: "--op: + ;font-size:calc(1em/**/var(--op)/**/1px)",
		hidden: true,
	},
	{
		label: "trimmed operand before minus",
		parent: "font-size:0",
		child: "--one: 1px ;font-size:calc(var(--one)- 0px)",
		hidden: true,
	},
	{
		label: "trimmed minus under a visible parent",
		parent: "font-size:16px",
		child: "--op: - ;font-size:calc(0px/**/var(--op)/**/1px)",
		hidden: false,
	},
	{
		label: "actual whitespace around a trimmed plus",
		parent: "font-size:0",
		child: "--op: + ;font-size:calc(1em var(--op) 1px)",
		hidden: false,
	},
	{
		label: "escaped digit that joins the unit",
		parent: "font-size:16px",
		child: String.raw`font-size:0;font-size:1\30 px`,
		hidden: true,
	},
	{
		label: "escaped exponent that joins the unit",
		parent: "font-size:0",
		child: String.raw`font-size:1\65 3px`,
		hidden: true,
	},
	{
		label: "escaped point that joins the unit",
		parent: "font-size:0",
		child: String.raw`font-size:1\2e 5px`,
		hidden: true,
	},
	{
		label: "escaped letter of a zero pixel unit",
		parent: "font-size:16px",
		child: String.raw`font-size:0p\78`,
		hidden: true,
	},
	{
		label: "unknown escaped unit under a visible parent",
		parent: "font-size:16px",
		child: String.raw`font-size:1\30 px`,
		hidden: false,
	},
	{
		label: "escaped space after a pixel unit",
		parent: "font-size:16px",
		child: String.raw`font-size:0;font-size:1p\78\20`,
		hidden: true,
	},
	{
		label: "digit hack after a pixel unit",
		parent: "font-size:16px",
		child: String.raw`font-size:0;font-size:16px\9`,
		hidden: true,
	},
	{
		label: "digit hack through a custom property",
		parent: "font-size:0",
		child: String.raw`--s:16px\9;font-size:var(--s)`,
		hidden: true,
	},
];

it.each(declaredValues)("resolves the $label through the parsing thread", (value) =>
	assertThread(value, false),
);

const keywordHacks: readonly Case[] = [
	{
		label: "digit hack after a display keyword",
		parent: "font-size:16px",
		child: String.raw`display:none;display:inline\9`,
		hidden: true,
	},
	{
		label: "digit hack after a visibility keyword",
		parent: "font-size:16px",
		child: String.raw`visibility:hidden;visibility:visible\9`,
		hidden: true,
	},
	{
		label: "digit hack after a size keyword",
		parent: "font-size:16px",
		child: String.raw`font-size:0;font-size:medium\9`,
		hidden: true,
	},
	{
		label: "digit hack through a custom visibility",
		parent: "visibility:hidden",
		child: String.raw`--v:visible\9;visibility:var(--v)`,
		hidden: true,
	},
	{
		label: "escaped keyword over hidden display",
		parent: "font-size:16px",
		child: String.raw`display:none;display:\69 nline`,
		hidden: false,
	},
	{
		label: "escaped tab in a family name",
		parent: "font-size:0",
		child: String.raw`font:16px Foo\9`,
		hidden: false,
	},
];

it.each(keywordHacks)(
	"resolves the $label in a style attribute through the parsing thread",
	(value) => assertThread(value, false),
);

it.each(keywordHacks)(
	"resolves the $label at the end of a style element through the parsing thread",
	(value) => assertThread(value, true),
);
