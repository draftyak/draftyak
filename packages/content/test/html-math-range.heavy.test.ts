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
			"Subject: Synthetic calculation range",
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
	const css = stylesheet ? `.c{${child}}` : "";
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

const invalidCalculations: readonly Case[] = [
	{
		label: "comment before plus over a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(1em/**/+ 1px)",
		hidden: true,
	},
	{
		label: "comment before minus over a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(0px/**/- 1px)",
		hidden: true,
	},
	{
		label: "number over a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(0 - 1)",
		hidden: true,
	},
	{
		label: "invalid shorthand over a zero parent",
		parent: "font-size:0",
		child: "font:calc(0px/**/- 1px)/1 serif",
		hidden: true,
	},
	{
		label: "substituted invalid sum over a zero parent",
		parent: "font-size:0",
		child: "--s:calc(1em/**/+ 1px);font-size:var(--s)",
		hidden: true,
	},
	{
		label: "adjacent operands after a zero size",
		parent: "font-size:16px",
		child: "font-size:0;font-size:calc(1px+2px)",
		hidden: true,
	},
	{
		label: "number after a zero size",
		parent: "font-size:16px",
		child: "font-size:0;font-size:calc(1)",
		hidden: true,
	},
	{
		label: "comment before plus after a zero opacity",
		parent: "font-size:16px",
		child: "opacity:0;opacity:calc(1/**/+ 1)",
		hidden: true,
	},
	{
		label: "valid sum after a zero size",
		parent: "font-size:16px",
		child: "font-size:0;font-size:calc(1px + 2px)",
		hidden: false,
	},
	{
		label: "substituted invalid sum after a zero size",
		parent: "font-size:16px",
		child: "font-size:0;--s:calc(1px+2px);font-size:var(--s)",
		hidden: false,
	},
];

const terms = (count: number, term: string, operator: string): string =>
	Array.from({ length: count }, () => term).join(` ${operator} `);

const ranges: readonly Case[] = [
	{ label: "min()", parent: "font-size:16px", child: "font-size:min(0px, 1px)", hidden: true },
	{ label: "max()", parent: "font-size:16px", child: "font-size:max(-1px, -2px)", hidden: true },
	{
		label: "clamp()",
		parent: "font-size:16px",
		child: "font-size:clamp(0px, 0px, 0px)",
		hidden: true,
	},
	{
		label: "min() inside calc()",
		parent: "font-size:16px",
		child: "font-size:calc(min(0px, 1px))",
		hidden: true,
	},
	{
		label: "-webkit-calc()",
		parent: "font-size:16px",
		child: "font-size:-webkit-calc(0px)",
		hidden: true,
	},
	{
		label: "-webkit-calc() of non-positive mixed units",
		parent: "font-size:16px",
		child: "font-size:-webkit-calc(-1px - 1em)",
		hidden: true,
	},
	{
		label: "-webkit-calc() of a viewport difference over a zero parent",
		parent: "font-size:0",
		child: "font-size:-webkit-calc(0px - 1vw)",
		hidden: true,
	},
	{
		label: "positive -webkit-calc() over a zero parent",
		parent: "font-size:0",
		child: "font-size:-webkit-calc(16px)",
		hidden: false,
	},
	{
		label: "-webkit-calc() sum over a zero parent",
		parent: "font-size:0",
		child: "font-size:-webkit-calc(1em + 1px)",
		hidden: false,
	},
	{
		label: "-webkit-calc() opacity after a zero opacity",
		parent: "",
		child: "opacity:0;opacity:-webkit-calc(1)",
		hidden: false,
	},
	{
		label: "non-positive terms in mixed units",
		parent: "font-size:16px",
		child: "font-size:calc(-1px - 1em)",
		hidden: true,
	},
	{ label: "NaN", parent: "font-size:16px", child: "font-size:calc(0px / 0)", hidden: true },
	{
		label: "negative infinity",
		parent: "font-size:16px",
		child: "font-size:calc(-infinity * 1px)",
		hidden: true,
	},
	{ label: "zero container unit", parent: "font-size:16px", child: "font-size:0cqw", hidden: true },
	{
		label: "shorthand min()",
		parent: "font-size:16px",
		child: "font:min(-1px, 1px)/1 serif",
		hidden: true,
	},
	{
		label: "substituted min()",
		parent: "font-size:16px",
		child: "--s:min(-1px, 1px);font-size:var(--s)",
		hidden: true,
	},
	{
		label: "min() over a zero parent",
		parent: "font-size:0",
		child: "font-size:min(1em, 5px)",
		hidden: true,
	},
	{ label: "negative opacity", parent: "", child: "opacity:-1", hidden: true },
	{ label: "negative percentage opacity", parent: "", child: "opacity:-50%", hidden: true },
	{ label: "negative calculated opacity", parent: "", child: "opacity:calc(0 - 1)", hidden: true },
	{ label: "min() opacity", parent: "", child: "opacity:min(0, 1)", hidden: true },
	{
		label: "long negative sum",
		parent: "font-size:16px",
		child: `font-size:calc(${terms(1_000, "1px", "-")})`,
		hidden: true,
	},
	{
		label: "long positive sum over a zero parent",
		parent: "font-size:0",
		child: `font-size:calc(${terms(1_000, "1em", "+")} + 1px)`,
		hidden: false,
	},
	{
		label: "positive min()",
		parent: "font-size:16px",
		child: "font-size:min(1px, 2px)",
		hidden: false,
	},
	{
		label: "max() over a zero parent",
		parent: "font-size:0",
		child: "font-size:max(1em, 5px)",
		hidden: false,
	},
	{ label: "positive min() opacity", parent: "", child: "opacity:min(1, 0.5)", hidden: false },
];

it.each([...invalidCalculations, ...ranges])(
	"resolves the $label through the parsing thread",
	(value) => assertThread(value, false),
);

it.each([...invalidCalculations, ...ranges])(
	"resolves the $label from a style sheet through the parsing thread",
	(value) => assertThread(value, true),
);
