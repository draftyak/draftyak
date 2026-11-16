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
			"Subject: Synthetic variable references",
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

const attribute = (value: string): string =>
	value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

async function assertThread({ parent, child, hidden }: Case, stylesheet: boolean): Promise<void> {
	const css = stylesheet ? `.c{${child}` : "";
	const target = stylesheet ? 'class="c"' : `style="${attribute(child)}"`;
	const source = `${stylesheet ? `<style>${css}</style>` : ""}<span style="${attribute(parent)}"><a ${target} href="https://hidden.example/DYTEST-private?discard=1">${canary}</a></span> <a href="https://visible.example/DYTEST-private?discard=1">Visible</a>`;
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

const commentedNames: readonly Case[] = [
	{
		label: "visibility name after a comment",
		parent: "font-size:16px",
		child: "--v:hidden;visibility:var(/**/--v)",
		hidden: true,
	},
	{
		label: "display name after a comment",
		parent: "font-size:16px",
		child: "--d:none;display:var(/**/--d)",
		hidden: true,
	},
	{
		label: "font size name after a comment",
		parent: "font-size:16px",
		child: "--s:0;font-size:var(/**/--s)",
		hidden: true,
	},
	{
		label: "name of an escaped reference",
		parent: "font-size:16px",
		child: String.raw`--v:hidden;visibility:v\61 r(--v)`,
		hidden: true,
	},
	{
		label: "commented visible name under a hidden parent",
		parent: "visibility:hidden",
		child: "--v:visible;visibility:var(/**/--v)",
		hidden: false,
	},
	{
		label: "commented nonzero size under a zero parent",
		parent: "font-size:0",
		child: "--s:16px;font-size:var(/**/--s)",
		hidden: false,
	},
];

const variableTokens: readonly Case[] = [
	{
		label: "dash-prefixed function of a missing name",
		parent: "visibility:hidden",
		child: "--gate:-var(--missing);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "dash-prefixed function of its own name",
		parent: "visibility:hidden",
		child: "--gate:-var(--gate);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "accented function of a missing name",
		parent: "visibility:hidden",
		child: "--gate:évar(--missing);visibility:var(--gate,visible)",
		hidden: true,
	},
	{
		label: "escaped dash function of a missing name",
		parent: "visibility:hidden",
		child: String.raw`--gate:\2d var(--missing);visibility:var(--gate,visible)`,
		hidden: true,
	},
	{
		label: "accented name that extends an ASCII name",
		parent: "visibility:hidden",
		child: "--xé:1;--x:var(--xé);visibility:var(--x,visible)",
		hidden: true,
	},
	{
		label: "non-ASCII name of a hidden display",
		parent: "font-size:16px",
		child: "--ü:none;display:var(--ü)",
		hidden: true,
	},
	{
		label: "open string that names its own property",
		parent: "visibility:hidden",
		child: 'visibility:var(--gate,visible);--gate:"var(--gate)',
		hidden: true,
	},
	{
		label: "open string family through a custom property",
		parent: "font-size:16px",
		child: 'font:0 var(--f);--f:"var(',
		hidden: true,
	},
	{
		label: "unknown function over hidden display",
		parent: "font-size:16px",
		child: "display:none;display:x-var(1)",
		hidden: true,
	},
	{
		label: "string over hidden display",
		parent: "font-size:16px",
		child: "display:none;display:'var('",
		hidden: true,
	},
	{
		label: "unknown function over hidden visibility",
		parent: "font-size:16px",
		child: "visibility:hidden;visibility:x-var(1)",
		hidden: true,
	},
	{
		label: "unknown function over a zero size",
		parent: "font-size:16px",
		child: "font-size:0;font-size:x-var(1)",
		hidden: true,
	},
	{
		label: "substituted string family after a zero size",
		parent: "font-size:16px",
		child: '--f:"var(";font:0 var(--f)',
		hidden: true,
	},
	{
		label: "unknown function substituted into a background",
		parent: "",
		child: "color:#fff;--b:x-var(1);background-color:var(--b,red)",
		hidden: true,
	},
	{
		label: "invalid calculation substituted into a background",
		parent: "",
		child: "color:#fff;--b:rgb(calc(0+0) 0 0);background-color:var(--b)",
		hidden: true,
	},
	{
		label: "missing reference with a visible fallback",
		parent: "visibility:hidden",
		child: "--gate:var(--missing);visibility:var(--gate,visible)",
		hidden: false,
	},
	{
		label: "escaped reference to a missing name",
		parent: "visibility:hidden",
		child: String.raw`--gate:v\61 r(--missing);visibility:var(--gate,visible)`,
		hidden: false,
	},
	{
		label: "accented name of a visible value",
		parent: "visibility:hidden",
		child: "--xé:visible;visibility:var(--xé)",
		hidden: false,
	},
	{
		label: "string family after a nonzero size",
		parent: "font-size:0",
		child: 'font:16px "var("',
		hidden: false,
	},
];

const trimmedFallbacks: readonly Case[] = [
	{
		label: "padded plus fallback over a zero parent",
		parent: "font-size:0",
		child: "font-size:calc(1em/**/var(--missing, + )/**/1px)",
		hidden: true,
	},
	{
		label: "padded operand fallback before minus",
		parent: "font-size:0",
		child: "font-size:calc(var(--missing, 1px )- 0px)",
		hidden: true,
	},
	{
		label: "padded plus fallback through a custom property",
		parent: "font-size:0",
		child: "--op:var(--missing, + );font-size:calc(1em/**/var(--op)/**/1px)",
		hidden: true,
	},
	{
		label: "padded operand fallback through a custom property",
		parent: "font-size:0",
		child: "--one:var(--missing, 1px );font-size:calc(var(--one)- 0px)",
		hidden: true,
	},
	{
		label: "padded plus in a nested fallback",
		parent: "font-size:0",
		child: "font-size:calc(1em/**/var(--a, var(--b, + ))/**/1px)",
		hidden: true,
	},
	{
		label: "tab-padded plus fallback",
		parent: "font-size:0",
		child: "font-size:calc(1em/**/var(--missing,\t+\t)/**/1px)",
		hidden: true,
	},
	{
		label: "comment-padded plus fallback",
		parent: "font-size:0",
		child: "font-size:calc(1em/**/var(--missing,/**/ + /**/)/**/1px)",
		hidden: true,
	},
	{
		label: "fallback with a leading space before plus",
		parent: "font-size:0",
		child: "font-size:calc(1em/**/var(--missing, + 1px))",
		hidden: true,
	},
	{
		label: "padded minus fallback under a visible parent",
		parent: "font-size:16px",
		child: "font-size:calc(0px/**/var(--missing, - )/**/1px)",
		hidden: false,
	},
	{
		label: "padded minus fallback through a custom property",
		parent: "font-size:16px",
		child: "--op:var(--missing, - );font-size:calc(0px/**/var(--op)/**/1px)",
		hidden: false,
	},
	{
		label: "padded operand fallback before a spaced minus",
		parent: "font-size:0",
		child: "font-size:calc(var(--missing, 1px ) - 0px)",
		hidden: false,
	},
];

const malformedValues: readonly Case[] = [
	{
		label: "custom property with an unmatched parenthesis",
		parent: "",
		child: "--gate:visible);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "custom display with an unmatched parenthesis",
		parent: "",
		child: "--d:inline);display:none;display:var(--d,none)",
		hidden: true,
	},
	{
		label: "custom property with a bad string",
		parent: "",
		child: '--gate:"x\n;visibility:var(--gate,hidden)',
		hidden: true,
	},
	{
		label: "custom property with a bad URL",
		parent: "",
		child: "--gate:url(x y);visibility:var(--gate,hidden)",
		hidden: true,
	},
	{
		label: "display with another flag",
		parent: "font-size:16px",
		child: "display:none;display:block !ie",
		hidden: true,
	},
	{
		label: "self reference inside a bad URL",
		parent: "visibility:hidden",
		child: "--gate:url(var(--gate));visibility:var(--gate,visible)",
		hidden: false,
	},
	{
		label: "custom property with a balanced block",
		parent: "",
		child: "--gate:(visible);visibility:var(--gate,hidden)",
		hidden: false,
	},
	{
		label: "display with an uppercase important flag",
		parent: "font-size:16px",
		child: "display:none;display:block !IMPORTANT",
		hidden: false,
	},
];

const substitutedColors: readonly Case[] = [
	{
		label: "invalid calculation substituted into a text colour",
		parent: "color:#fff",
		child: "--c:rgb(calc(0+0) 0 0);color:var(--c)",
		hidden: true,
	},
	{
		label: "unknown keyword substituted into a text colour",
		parent: "color:#fff",
		child: "--c:notacolor;color:var(--c)",
		hidden: true,
	},
	{
		label: "missing reference as a text colour",
		parent: "color:#fff",
		child: "color:#000;color:var(--missing)",
		hidden: true,
	},
	{
		label: "valid calculation substituted into a text colour",
		parent: "color:#fff",
		child: "--c:rgb(calc(0 + 0) 0 0);color:var(--c)",
		hidden: false,
	},
];

const threadCases = [
	...commentedNames,
	...variableTokens,
	...trimmedFallbacks,
	...malformedValues,
	...substitutedColors,
];

it.each(threadCases)(
	"resolves the $label in a style attribute through the parsing thread",
	(value) => assertThread(value, false),
);

it.each(threadCases)(
	"resolves the $label at the end of a style element through the parsing thread",
	(value) => assertThread(value, true),
);
